import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runClineScript = async (env: Record<string, string>) => {
    const script = `
        const { clineState, deleteCline, loadCline, saveCline } = await import('./src/cline/service.ts');
        const secretsPath = process.env.CLINE_SECRETS_PATH;
        const vaultPath = process.env.DONDO_VAULT;
        await saveCline('saved');
        await Bun.write(secretsPath, JSON.stringify({
            'cline:clineAccountId': JSON.stringify({
                idToken: 'other-id-token',
                refreshToken: 'other-refresh-token',
                userInfo: { email: 'other@example.com', id: 'other-user' },
            }),
            unrelated: 'preserved',
        }));
        const before = await clineState();
        await loadCline('saved');
        const after = await clineState();
        const loadedSecrets = JSON.parse(await Bun.file(secretsPath).text());
        const loadedAccount = JSON.parse(loadedSecrets['cline:clineAccountId']);
        const vaultText = await Bun.file(vaultPath).text();
        await deleteCline('saved');
        const afterDelete = await clineState();
        console.log(JSON.stringify({
            activeBeforeLoad: before.entries[0]?.active ?? null,
            activeAfterLoad: after.entries[0]?.active ?? null,
            deleted: afterDelete.entries.length === 0,
            loadedEmail: loadedAccount.userInfo.email,
            loadedRefreshToken: loadedAccount.refreshToken,
            preservedUnrelated: loadedSecrets.unrelated,
            secretsPath: after.secretsPath,
            vaultHasPlainToken: vaultText.includes('saved-id-token') || vaultText.includes('saved-refresh-token'),
        }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stderr: 'pipe',
        stdout: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(stderr);
    }
    return JSON.parse(stdout) as {
        activeAfterLoad: boolean;
        activeBeforeLoad: boolean;
        deleted: boolean;
        loadedEmail: string;
        loadedRefreshToken: string;
        preservedUnrelated: string;
        secretsPath: string;
        vaultHasPlainToken: boolean;
    };
};

it('should save and load Cline secrets with encrypted vault storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-cline-test-'));
    const secretsPath = join(dir, 'secrets.json');
    const vaultPath = join(dir, 'vault.json');
    try {
        await Bun.write(
            secretsPath,
            JSON.stringify({
                'cline:clineAccountId': JSON.stringify({
                    expiresAt: 1_900_000_000_000,
                    idToken: 'saved-id-token',
                    refreshToken: 'saved-refresh-token',
                    userInfo: { email: 'saved@example.com', id: 'saved-user' },
                }),
                unrelated: 'preserved',
            }),
        );

        const result = await runClineScript({
            CLINE_SECRETS_PATH: secretsPath,
            DONDO_VAULT: vaultPath,
        });

        expect(result.activeBeforeLoad).toBe(false);
        expect(result.activeAfterLoad).toBe(true);
        expect(result.deleted).toBe(true);
        expect(result.loadedEmail).toBe('saved@example.com');
        expect(result.loadedRefreshToken).toBe('saved-refresh-token');
        expect(result.preservedUnrelated).toBe('preserved');
        expect(result.secretsPath).toBe(secretsPath);
        expect(result.vaultHasPlainToken).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject a Cline secrets file without an account token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-cline-invalid-test-'));
    const secretsPath = join(dir, 'secrets.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { saveCline } = await import('./src/cline/service.ts');
        const error = await saveCline('broken').catch((value) => value);
        console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    `;
    try {
        await Bun.write(secretsPath, JSON.stringify({ unrelated: 'only' }));
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, CLINE_SECRETS_PATH: secretsPath, DONDO_VAULT: vaultPath },
            stderr: 'pipe',
            stdout: 'pipe',
        });
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if ((await proc.exited) !== 0) {
            throw new Error(stderr);
        }
        expect(JSON.parse(stdout).error).toContain('Cline account token');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
