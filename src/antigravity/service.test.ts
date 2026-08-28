import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runAntigravityScript = async (script: string, env: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-test-not-running', ...env },
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

it('should preserve Antigravity account creation time when replacing a healthy row', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const password = Buffer.from(JSON.stringify({ token: { access_token: 'access' } })).toString('base64');
        const snapshot = {
            account: 'antigravity', createdAt: 'new-created', kind: 'Generic Password', label: 'gemini',
            identity: 'google-user', password, service: 'gemini', updatedAt: 'new-updated',
        };
        const section = {
            data: { saved: { ...snapshot, createdAt: 'original-created', updatedAt: 'old-updated' } },
            limits: {},
        };
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => section,
            updateVaultSection: async (_platform, operation) => operation(section).result,
        }));
        mock.module('./src/antigravity/google.ts', () => ({
            decodeToken: () => ({ token: { access_token: 'access' } }),
            fetchLimits: async () => ({ quota: { error: 'not refreshed', ok: false } }),
            resolveGoogleIdentity: async () => ({ identity: 'google-user' }),
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => {},
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => {},
        }));
        const { saveAntigravity } = await import('./src/antigravity/service.ts');
        await saveAntigravity('saved');
        console.log(JSON.stringify({
            createdAt: section.data.saved.createdAt,
            updatedAt: section.data.saved.updatedAt,
        }));
    `;
    expect(await runAntigravityScript(script)).toEqual({ createdAt: 'original-created', updatedAt: 'new-updated' });
});

it('should reject an inert live Antigravity credential before writing the vault', async () => {
    const script = `
        const { mock } = await import('bun:test');
        let wrote = false;
        const snapshot = {
            account: 'antigravity', createdAt: '', kind: 'Generic Password', label: 'gemini',
            password: Buffer.from(JSON.stringify({ token: {} })).toString('base64'),
            service: 'gemini', updatedAt: '',
        };
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => ({ data: {}, limits: {} }),
            updateVaultSection: async () => { wrote = true; },
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => {},
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => {},
        }));
        const { saveAntigravity } = await import('./src/antigravity/service.ts');
        const error = await saveAntigravity('saved').catch((value) => String(value));
        console.log(JSON.stringify({ error, wrote }));
    `;
    expect(await runAntigravityScript(script)).toEqual({
        error: 'Error: Current Antigravity credential payload is invalid',
        wrote: false,
    });
});

it('should replace the Antigravity credential without clearing persistent application state', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const calls = [];
        const snapshot = {
            account: 'antigravity',
            createdAt: '',
            identity: 'google-user',
            kind: 'Generic Password',
            label: 'gemini',
            password: Buffer.from(JSON.stringify({ token: { access_token: 'access' } })).toString('base64'),
            service: 'gemini',
            updatedAt: '',
        };
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => ({ data: { saved: snapshot }, limits: {} }),
            updateVaultSection: async () => undefined,
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => {},
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => { calls.push('replace'); },
        }));
        const { loadAntigravity } = await import('./src/antigravity/service.ts');
        await loadAntigravity('saved');
        console.log(JSON.stringify(calls));
    `;
    expect(await runAntigravityScript(script)).toEqual(['replace']);
});

it('should not make Antigravity loading depend on a destructive local-state cleanup', async () => {
    const script = `
        const { mock } = await import('bun:test');
        let restored = false;
        const snapshot = {
            account: 'antigravity', createdAt: '', kind: 'Generic Password', label: 'gemini',
            identity: 'google-user', password: Buffer.from(JSON.stringify({ token: { access_token: 'access' } })).toString('base64'),
            service: 'gemini', updatedAt: '',
        };
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => ({ data: { saved: snapshot }, limits: {} }),
            updateVaultSection: async () => undefined,
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => {},
            clearLocalState: async () => { throw new Error('cleanup failed'); },
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => { restored = true; },
        }));
        const { loadAntigravity } = await import('./src/antigravity/service.ts');
        await loadAntigravity('saved');
        console.log(JSON.stringify({ restored }));
    `;
    expect(await runAntigravityScript(script)).toEqual({ restored: true });
});

it('should reject tampered Antigravity keychain metadata without clearing or restoring', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const calls = [];
        const snapshot = {
            account: 'unrelated-account', createdAt: '', kind: 'Generic Password', label: 'gemini',
            identity: 'google-user', password: Buffer.from(JSON.stringify({ token: { access_token: 'access' } })).toString('base64'),
            service: 'unrelated-service', updatedAt: '',
        };
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => ({ data: { saved: snapshot }, limits: {} }),
            updateVaultSection: async () => undefined,
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => {},
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => { calls.push('replace'); },
        }));
        const { loadAntigravity } = await import('./src/antigravity/service.ts');
        const error = await loadAntigravity('saved').catch((value) => String(value));
        console.log(JSON.stringify({ calls, error }));
    `;
    expect(await runAntigravityScript(script)).toEqual({ calls: [], error: 'Error: Saved account data is corrupted' });
});

it('should reject replacing a semantic-invalid saved Antigravity account', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const valid = {
            account: 'antigravity', createdAt: 'live-created', kind: 'Generic Password', label: 'gemini',
            identity: 'google-user', password: Buffer.from(JSON.stringify({ token: { access_token: 'access' } })).toString('base64'),
            service: 'gemini', updatedAt: 'live-updated',
        };
        const section = {
            data: { saved: { ...valid, password: Buffer.from(JSON.stringify({ token: {} })).toString('base64') } },
            limits: {},
        };
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => section,
            updateVaultSection: async (_platform, operation) => operation(section).result,
        }));
        mock.module('./src/antigravity/google.ts', () => ({
            decodeToken: (password) => password === valid.password ? { token: { access_token: 'access' } } : null,
            fetchLimits: async () => ({ quota: { error: 'not refreshed', ok: false } }),
            resolveGoogleIdentity: async () => ({ identity: 'google-user' }),
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => {},
            readCurrentSnapshot: async () => valid,
            replaceLiveSnapshot: async () => {},
        }));
        const { saveAntigravity } = await import('./src/antigravity/service.ts');
        const error = await saveAntigravity('saved').catch((value) => String(value));
        console.log(JSON.stringify({ error, unchanged: section.data.saved.password !== valid.password }));
    `;
    expect(await runAntigravityScript(script)).toEqual({
        error: 'Error: Saved account data is corrupted',
        unchanged: true,
    });
});

it('should reject Antigravity load and clear while the app is running', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const calls = [];
        mock.module('./src/process.ts', () => ({ isProcessRunning: async () => true }));
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => { calls.push('read-vault'); return { data: {}, limits: {} }; },
            updateVaultSection: async () => undefined,
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => { calls.push('clear-live'); },
            readCurrentSnapshot: async () => { throw new Error('not called'); },
            replaceLiveSnapshot: async () => { calls.push('replace'); },
        }));
        const { clearAntigravity, loadAntigravity } = await import('./src/antigravity/service.ts');
        const loadError = await loadAntigravity('saved').catch((value) => String(value));
        const clearError = await clearAntigravity().catch((value) => String(value));
        console.log(JSON.stringify({ calls, clearError, loadError }));
    `;
    expect(await runAntigravityScript(script, { ANTIGRAVITY_PROCESS_NAME: '-hostile-name' })).toEqual({
        calls: [],
        clearError:
            'Error: Quit Antigravity completely before clearing or loading an account. Antigravity must be closed while Dondo replaces its Keychain credential.',
        loadError:
            'Error: Quit Antigravity completely before clearing or loading an account. Antigravity must be closed while Dondo replaces its Keychain credential.',
    });
});

it('should cycle Antigravity accounts in label order and skip corrupted snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-antigravity-cycle-test-'));
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { mock } = await import('bun:test');
        const password = (id) => Buffer.from(JSON.stringify({ token: { access_token: 'access-' + id } })).toString('base64');
        const credential = (id) => ({
            account: 'antigravity', createdAt: '2026-01-01T00:00:00.000Z', kind: 'Generic Password', label: 'gemini',
            password: password(id), service: 'gemini', updatedAt: '2026-01-01T00:00:00.000Z',
        });
        let current = 'alpha';
        mock.module('./src/antigravity/google.ts', () => ({
            decodeToken: (value) => value === 'corrupt' ? null : ({ token: { access_token: 'valid' } }),
            fetchLimits: async () => ({ quota: { error: 'not refreshed', ok: false } }),
            resolveGoogleIdentity: async () => ({ identity: current }),
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => {},
            readCurrentSnapshot: async () => credential(current),
            replaceLiveSnapshot: async (snapshot) => { current = snapshot.identity; },
        }));
        const { cycleNextAntigravity, saveAntigravity } = await import('./src/antigravity/service.ts');
        const { updateVaultSection } = await import('./src/storage/vault.ts');
        for (const id of ['gamma', 'alpha', 'beta']) {
            current = id;
            await saveAntigravity(id);
        }
        await updateVaultSection('antigravity', (section) => {
            section.data.beta.password = 'corrupt';
            return { result: undefined };
        });
        current = 'alpha';
        let skipped = 0;
        const result = await cycleNextAntigravity({ onSkip: () => { skipped += 1; } });
        console.log(JSON.stringify({ current, healed: result.healed, skipped }));
    `;
    try {
        expect(await runAntigravityScript(script, { DONDO_VAULT: vaultPath })).toEqual({
            current: 'gamma',
            healed: true,
            skipped: 1,
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should serialize overlapping Antigravity live-state operations', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const password = Buffer.from(JSON.stringify({ token: { access_token: 'access' } })).toString('base64');
        const snapshot = {
            account: 'antigravity', createdAt: '', kind: 'Generic Password', label: 'gemini',
            identity: 'google-user', password, service: 'gemini', updatedAt: '',
        };
        let active = 0;
        let maximumActive = 0;
        const calls = [];
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => ({ data: { first: snapshot, second: snapshot }, limits: {} }),
            updateVaultSection: async () => undefined,
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => {},
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                calls.push('replace-start');
                await Bun.sleep(25);
                calls.push('replace-end');
                active -= 1;
            },
        }));
        const { loadAntigravity } = await import('./src/antigravity/service.ts');
        await Promise.all([loadAntigravity('first'), loadAntigravity('second')]);
        console.log(JSON.stringify({ calls, maximumActive }));
    `;
    expect(await runAntigravityScript(script)).toEqual({
        calls: ['replace-start', 'replace-end', 'replace-start', 'replace-end'],
        maximumActive: 1,
    });
});

it('should keep the active Antigravity account stable across token rotation', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const credential = (password) => ({
            account: 'antigravity', createdAt: '', kind: 'Generic Password', label: 'gemini',
            password, service: 'gemini', updatedAt: '',
        });
        const section = {
            data: {
                first: { ...credential('saved-first-token'), identity: 'google-user-one' },
                second: { ...credential('saved-second-token'), identity: 'google-user-two' },
            },
            limits: {},
        };
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => section,
            updateVaultSection: async (_platform, operation) => operation(section).result,
        }));
        mock.module('./src/antigravity/google.ts', () => ({
            decodeToken: () => ({ token: { access_token: 'valid' } }),
            fetchLimits: async () => ({ quota: { error: 'not refreshed', ok: false } }),
            resolveGoogleIdentity: async () => ({ identity: 'google-user-two' }),
        }));
        mock.module('./src/antigravity/keychain.ts', () => ({
            clearLiveAuth: async () => {},
            readCurrentSnapshot: async () => credential('rotated-live-token'),
            replaceLiveSnapshot: async () => {},
        }));
        const { antigravityState } = await import('./src/antigravity/service.ts');
        const state = await antigravityState();
        console.log(JSON.stringify(state.entries.filter((entry) => entry.active).map((entry) => entry.key)));
    `;
    expect(await runAntigravityScript(script)).toEqual(['second']);
});
