import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runScript = async (script: string, env: Record<string, string>) => {
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
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
    return JSON.parse(stdout) as unknown;
};

it('should not open a vault write transaction for cached Codex state', async () => {
    const script = `
        const { mock } = await import('bun:test');
        let writes = 0;
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => ({
                data: {
                    saved: {
                        auth: JSON.stringify({
                            auth_mode: 'chatgpt',
                            tokens: { access_token: 'access', id_token: 'id', refresh_token: 'refresh' },
                        }),
                        createdAt: '',
                        updatedAt: '',
                    },
                },
                limits: {
                    saved: { fetchedAt: 'cached', quota: { expires: '', models: {}, ok: true, tier: 'plus' } },
                },
            }),
            updateVaultSection: async () => { writes += 1; },
        }));
        const { codexState } = await import('./src/codex/service.ts');
        const state = await codexState();
        console.log(JSON.stringify({ cached: state.entries[0]?.limitUpdatedAt, writes }));
    `;

    expect(await runScript(script, {})).toEqual({ cached: 'cached', writes: 0 });
});

it('should reject invalid Codex auth on save and again before load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-codex-validation-test-'));
    const authPath = join(dir, 'auth.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { codexState, deleteCodex, loadCodex, saveCodex } = await import('./src/codex/service.ts');
        const { updateVaultSection } = await import('./src/storage/vault.ts');
        const authPath = process.env.CODEX_AUTH_PATH;
        const valid = JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
                access_token: 'access',
                account_id: 'account',
                id_token: 'id',
                refresh_token: 'refresh',
            },
        });
        await Bun.write(authPath, '{');
        const saveError = await saveCodex('invalid').catch((error) => String(error));
        await Bun.write(authPath, valid);
        await saveCodex('saved');
        await updateVaultSection('codex', (section) => {
            section.data.saved.auth = '{}';
            return { result: undefined };
        });
        const replacementSaveError = await saveCodex('saved').catch((error) => String(error));
        const state = await codexState({ refreshLimits: true });
        const refreshError = await codexState({ refreshLimitKey: 'saved' }).catch((error) => String(error));
        const loadError = await loadCodex('saved').catch((error) => String(error));
        await deleteCodex('saved');
        console.log(JSON.stringify({
            corrupted: state.entries[0]?.corrupted ?? false,
            deleted: (await codexState()).entries.length === 0,
            liveUnchanged: await Bun.file(authPath).text() === valid,
            loadError,
            refreshError,
            replacementSaveError,
            saveError,
        }));
    `;
    try {
        const result = (await runScript(script, { CODEX_AUTH_PATH: authPath, DONDO_VAULT: vaultPath })) as {
            corrupted: boolean;
            deleted: boolean;
            liveUnchanged: boolean;
            loadError: string;
            refreshError: string;
            replacementSaveError: string;
            saveError: string;
        };
        expect(result.saveError).toContain('not valid Codex auth JSON');
        expect(result.loadError).toContain('Saved account data is corrupted');
        expect(result.refreshError).toContain('Saved account data is corrupted');
        expect(result.replacementSaveError).toContain('Saved account data is corrupted');
        expect(result.corrupted).toBe(true);
        expect(result.deleted).toBe(true);
        expect(result.liveUnchanged).toBe(true);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should expose, block, and intentionally delete a corrupt Codex account', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-codex-corruption-test-'));
    const authPath = join(dir, 'auth.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { codexState, deleteCodex, loadCodex } = await import('./src/codex/service.ts');
        const before = await codexState();
        const loadError = await loadCodex('damaged').catch((error) => String(error));
        await deleteCodex('damaged');
        const after = await codexState();
        console.log(JSON.stringify({ before: before.entries, deleted: after.entries.length === 0, loadError }));
    `;
    try {
        await Bun.write(
            vaultPath,
            JSON.stringify({
                codex: {
                    data: { damaged: { auth: 'enc:v1:AAAA', createdAt: '', updatedAt: '' } },
                    limits: {},
                },
            }),
        );
        const result = (await runScript(script, { CODEX_AUTH_PATH: authPath, DONDO_VAULT: vaultPath })) as {
            before: Array<Record<string, unknown>>;
            deleted: boolean;
            loadError: string;
        };
        expect(result.before).toEqual([
            {
                active: false,
                corrupted: true,
                error: 'Saved account data is corrupted',
                key: 'damaged',
                limitUpdatedAt: '',
                quota: null,
                updatedAt: '',
            },
        ]);
        expect(result.loadError).toContain('Saved account data is corrupted');
        expect(result.deleted).toBe(true);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should not attach a stale Codex refresh to a replacement account', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-codex-stale-refresh-test-'));
    const authPath = join(dir, 'auth.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        let markStarted;
        let release;
        const started = new Promise((resolve) => { markStarted = resolve; });
        const gate = new Promise((resolve) => { release = resolve; });
        globalThis.fetch = async () => {
            markStarted();
            await gate;
            return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
        };
        const { codexState, saveCodex } = await import('./src/codex/service.ts');
        const jwt = (id) => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: id })).toString('base64url') + '.signature';
        const auth = (id) => JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: jwt(id), account_id: id, id_token: 'id-' + id, refresh_token: 'refresh-' + id },
        });
        await Bun.write(process.env.CODEX_AUTH_PATH, auth('old'));
        await saveCodex('saved');
        const refresh = codexState({ refreshLimits: true });
        await started;
        await Bun.write(process.env.CODEX_AUTH_PATH, auth('new'));
        await saveCodex('saved');
        release();
        const state = await refresh;
        const saved = state.entries.find((entry) => entry.key === 'saved');
        console.log(JSON.stringify({ limitUpdatedAt: saved?.limitUpdatedAt ?? '', quota: saved?.quota ?? null }));
    `;
    try {
        const result = await runScript(script, { CODEX_AUTH_PATH: authPath, DONDO_VAULT: vaultPath });
        expect(result).toEqual({ limitUpdatedAt: '', quota: null });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should sync the live Codex auth before loading another account', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-codex-load-sync-test-'));
    const authPath = join(dir, 'auth.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { loadCodex, saveCodex } = await import('./src/codex/service.ts');
        const { readVaultSection } = await import('./src/storage/vault.ts');
        const auth = (id, version) => JSON.stringify({
            auth_mode: 'chatgpt',
            last_refresh: version,
            tokens: {
                access_token: 'access-' + id + '-' + version,
                account_id: id,
                id_token: 'id-' + id + '-' + version,
                refresh_token: 'refresh-' + id + '-' + version,
            },
        });
        const active = auth('active', 'initial');
        const refreshed = auth('active', 'refreshed');
        const target = auth('target', 'target');
        await Bun.write(process.env.CODEX_AUTH_PATH, active);
        await saveCodex('active');
        await Bun.write(process.env.CODEX_AUTH_PATH, target);
        await saveCodex('target');
        await Bun.write(process.env.CODEX_AUTH_PATH, refreshed);
        await loadCodex('target');
        const section = await readVaultSection('codex');
        console.log(JSON.stringify({
            active: JSON.parse(section.data.active.auth).last_refresh,
            loadedTarget: await Bun.file(process.env.CODEX_AUTH_PATH).text() === target,
        }));
    `;
    try {
        const result = await runScript(script, { CODEX_AUTH_PATH: authPath, DONDO_VAULT: vaultPath });
        expect(result).toEqual({ active: 'refreshed', loadedTarget: true });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should cycle Codex accounts in label order and skip corrupted snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-codex-cycle-test-'));
    const authPath = join(dir, 'auth.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { cycleNextCodex, saveCodex } = await import('./src/codex/service.ts');
        const { updateVaultSection } = await import('./src/storage/vault.ts');
        const auth = (id) => JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
                access_token: 'access-' + id,
                account_id: id,
                id_token: 'id-' + id,
                refresh_token: 'refresh-' + id,
            },
        });
        for (const id of ['gamma', 'alpha', 'beta']) {
            await Bun.write(process.env.CODEX_AUTH_PATH, auth(id));
            await saveCodex(id);
        }
        await updateVaultSection('codex', (section) => {
            section.data.beta.auth = '{';
            return { result: undefined };
        });
        await Bun.write(process.env.CODEX_AUTH_PATH, auth('alpha'));
        let skipped = 0;
        const result = await cycleNextCodex({ onSkip: () => { skipped += 1; } });
        const live = JSON.parse(await Bun.file(process.env.CODEX_AUTH_PATH).text());
        console.log(JSON.stringify({ accountId: live.tokens.account_id, healed: result.healed, skipped }));
    `;
    try {
        expect(await runScript(script, { CODEX_AUTH_PATH: authPath, DONDO_VAULT: vaultPath })).toEqual({
            accountId: 'gamma',
            healed: true,
            skipped: 1,
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
