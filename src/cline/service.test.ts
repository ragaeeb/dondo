import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runClineProvidersScript = async (env: Record<string, string>) => {
    const script = `
        const { clineState, deleteCline, loadCline, saveCline } = await import('./src/cline/service.ts');
        const providersPath = process.env.CLINE_PROVIDERS_PATH;
        const vaultPath = process.env.DONDO_VAULT;
        await saveCline('saved');
        await Bun.write(providersPath, JSON.stringify({
            version: 1,
            lastUsedProvider: 'cline',
            providers: {
                cline: { settings: { provider: 'cline', auth: { accessToken: 'workos:other-access', refreshToken: 'other-refresh', accountId: 'other-user' } } },
                sapaicore: { settings: { provider: 'sapaicore', auth: { accessToken: 'other-provider-access' } } },
            },
        }));
        const before = await clineState();
        await loadCline('saved');
        const after = await clineState();
        const loadedProviders = JSON.parse(await Bun.file(providersPath).text());
        const vaultText = await Bun.file(vaultPath).text();
        await deleteCline('saved');
        const afterDelete = await clineState();
        console.log(JSON.stringify({
            activeBeforeLoad: before.entries[0]?.active ?? null,
            activeAfterLoad: after.entries[0]?.active ?? null,
            accountId: loadedProviders.providers.cline.settings.auth.accountId,
            deleted: afterDelete.entries.length === 0,
            providerKeys: Object.keys(loadedProviders.providers).sort(),
            providersPath: after.providersPath,
            vaultHasPlainToken: vaultText.includes('saved-access') || vaultText.includes('saved-refresh'),
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
        accountId: string;
        activeAfterLoad: boolean;
        activeBeforeLoad: boolean;
        deleted: boolean;
        providerKeys: string[];
        providersPath: string;
        vaultHasPlainToken: boolean;
    };
};

it('should save and load the current Cline providers file with encrypted vault storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-cline-providers-test-'));
    const providersPath = join(dir, 'providers.json');
    const vaultPath = join(dir, 'vault.json');
    try {
        await Bun.write(
            providersPath,
            JSON.stringify({
                version: 1,
                lastUsedProvider: 'cline',
                providers: {
                    cline: {
                        settings: {
                            auth: {
                                accessToken: 'workos:saved-access',
                                accountId: 'saved-user',
                                refreshToken: 'saved-refresh',
                            },
                            provider: 'cline',
                        },
                    },
                    sapaicore: { settings: { provider: 'sapaicore' } },
                },
            }),
        );

        const result = await runClineProvidersScript({
            CLINE_PROVIDERS_PATH: providersPath,
            DONDO_VAULT: vaultPath,
        });

        expect(result.activeBeforeLoad).toBe(false);
        expect(result.activeAfterLoad).toBe(true);
        expect(result.accountId).toBe('saved-user');
        expect(result.deleted).toBe(true);
        expect(result.providerKeys).toEqual(['cline', 'sapaicore']);
        expect(result.providersPath).toBe(providersPath);
        expect(result.vaultHasPlainToken).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject a Cline providers file without an account token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-cline-invalid-test-'));
    const providersPath = join(dir, 'providers.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { saveCline } = await import('./src/cline/service.ts');
        const error = await saveCline('broken').catch((value) => value);
        console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    `;
    try {
        await Bun.write(providersPath, JSON.stringify({ providers: { cline: { settings: { auth: {} } } } }));
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, CLINE_PROVIDERS_PATH: providersPath, DONDO_VAULT: vaultPath },
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
