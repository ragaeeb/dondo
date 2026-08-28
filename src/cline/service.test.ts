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
                version: 1,
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

it('should cycle Cline accounts in label order and skip corrupted snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-cline-cycle-test-'));
    const providersPath = join(dir, 'providers.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { cycleNextCline, saveCline } = await import('./src/cline/service.ts');
        const { updateVaultSection } = await import('./src/storage/vault.ts');
        const writeProviders = (id) => Bun.write(process.env.CLINE_PROVIDERS_PATH, JSON.stringify({
            providers: {
                cline: { settings: { provider: 'cline', auth: { accessToken: 'access-' + id, accountId: id } } },
            },
        }));
        for (const id of ['gamma', 'alpha', 'beta']) {
            await writeProviders(id);
            await saveCline(id);
        }
        await updateVaultSection('cline', (section) => {
            section.data.beta.secrets = '{}';
            return { result: undefined };
        });
        await writeProviders('alpha');
        let skipped = 0;
        const result = await cycleNextCline({ onSkip: () => { skipped += 1; } });
        const live = JSON.parse(await Bun.file(process.env.CLINE_PROVIDERS_PATH).text());
        console.log(JSON.stringify({ accountId: live.providers.cline.settings.auth.accountId, healed: result.healed, skipped }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, CLINE_PROVIDERS_PATH: providersPath, DONDO_VAULT: vaultPath },
            stderr: 'pipe',
            stdout: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        if (exitCode !== 0) {
            throw new Error(stderr);
        }
        expect(JSON.parse(stdout)).toEqual({ accountId: 'gamma', healed: true, skipped: 1 });
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

it('should reject malformed optional Cline auth fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-cline-malformed-auth-test-'));
    const providersPath = join(dir, 'providers.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { saveCline } = await import('./src/cline/service.ts');
        const error = await saveCline('broken').catch((value) => String(value));
        console.log(JSON.stringify({ error }));
    `;
    try {
        await Bun.write(
            providersPath,
            JSON.stringify({
                providers: {
                    cline: { settings: { auth: { accessToken: 'access', refreshToken: 123 }, provider: 'cline' } },
                },
            }),
        );
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, CLINE_PROVIDERS_PATH: providersPath, DONDO_VAULT: vaultPath },
            stderr: 'pipe',
            stdout: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        if (exitCode !== 0) {
            throw new Error(stderr);
        }
        expect(JSON.parse(stdout).error).toContain('Cline account token');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should expose semantic-invalid saved Cline providers as deletable corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-cline-semantic-corruption-test-'));
    const providersPath = join(dir, 'providers.json');
    const vaultPath = join(dir, 'vault.json');
    const valid = JSON.stringify({
        providers: {
            cline: { settings: { auth: { accessToken: 'access' }, provider: 'cline' } },
        },
    });
    const script = `
        const { clineState, deleteCline, loadCline, saveCline } = await import('./src/cline/service.ts');
        const { updateVaultSection } = await import('./src/storage/vault.ts');
        await saveCline('saved');
        await updateVaultSection('cline', (section) => {
            section.data.saved.secrets = '{}';
            return { result: undefined };
        });
        const saveError = await saveCline('saved').catch((error) => String(error));
        const state = await clineState();
        const loadError = await loadCline('saved').catch((error) => String(error));
        await deleteCline('saved');
        console.log(JSON.stringify({
            corrupted: state.entries[0]?.corrupted ?? false,
            deleted: (await clineState()).entries.length === 0,
            loadError,
            saveError,
        }));
    `;
    try {
        await Bun.write(providersPath, valid);
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, CLINE_PROVIDERS_PATH: providersPath, DONDO_VAULT: vaultPath },
            stderr: 'pipe',
            stdout: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        if (exitCode !== 0) {
            throw new Error(stderr);
        }
        expect(JSON.parse(stdout)).toEqual({
            corrupted: true,
            deleted: true,
            loadError: 'Error: Saved account data is corrupted',
            saveError: 'Error: Saved account data is corrupted',
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should keep saved Cline accounts usable when the live providers file is unreadable', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const valid = JSON.stringify({
            providers: { cline: { settings: { auth: { accessToken: 'saved-access' }, provider: 'cline' } } },
        });
        mock.module('./src/storage/file.ts', () => ({
            readBoundedLocalText: async () => { throw new Error('live providers unreadable'); },
            writePrivateFile: async () => {},
        }));
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => ({
                data: { saved: { createdAt: '', secrets: valid, updatedAt: 'saved-at' } },
                limits: {},
            }),
            updateVaultSection: async () => undefined,
        }));
        const { clineState } = await import('./src/cline/service.ts');
        const state = await clineState();
        console.log(JSON.stringify(state.entries));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        stderr: 'pipe',
        stdout: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(stderr);
    }
    expect(JSON.parse(stdout)).toEqual([
        { active: false, key: 'saved', limitUpdatedAt: '', quota: null, updatedAt: 'saved-at' },
    ]);
});

it('should mark a metadata-free opaque Cline token active after saving', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-cline-opaque-test-'));
    const providersPath = join(dir, 'providers.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { clineState, saveCline } = await import('./src/cline/service.ts');
        await saveCline('opaque');
        const state = await clineState();
        console.log(JSON.stringify({ active: state.entries[0]?.active ?? false }));
    `;
    try {
        await Bun.write(
            providersPath,
            JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: 'opaque-access' } } } } }),
        );
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, CLINE_PROVIDERS_PATH: providersPath, DONDO_VAULT: vaultPath },
            stderr: 'pipe',
            stdout: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        if (exitCode !== 0) {
            throw new Error(stderr);
        }
        expect(JSON.parse(stdout)).toEqual({ active: true });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should treat a hostile non-UTF-8 Cline JWT as an opaque identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-cline-hostile-jwt-test-'));
    const providersPath = join(dir, 'providers.json');
    const token = `header.${Buffer.from([0xc3, 0x28]).toString('base64url')}.signature`;
    const script = `
        const { clineState, saveCline } = await import('./src/cline/service.ts');
        await saveCline('opaque');
        console.log(JSON.stringify({ active: (await clineState()).entries[0]?.active ?? false }));
    `;
    try {
        await Bun.write(
            providersPath,
            JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: token } } } } }),
        );
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                CLINE_PROVIDERS_PATH: providersPath,
                DONDO_VAULT: join(dir, 'vault.json'),
            },
            stderr: 'pipe',
            stdout: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        if (exitCode !== 0) {
            throw new Error(stderr);
        }
        expect(JSON.parse(stdout)).toEqual({ active: true });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
