import { expect, it } from 'bun:test';

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
            clearLocalState: async () => {},
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
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-test-not-running' },
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
    expect(JSON.parse(stdout)).toEqual({ createdAt: 'original-created', updatedAt: 'new-updated' });
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
            clearLocalState: async () => {},
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => {},
        }));
        const { saveAntigravity } = await import('./src/antigravity/service.ts');
        const error = await saveAntigravity('saved').catch((value) => String(value));
        console.log(JSON.stringify({ error, wrote }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-test-not-running' },
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
        error: 'Error: Current Antigravity credential payload is invalid',
        wrote: false,
    });
});

it('should clear stale Antigravity state before restoring the replacement credential', async () => {
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
            clearLocalState: async () => { calls.push('clear'); },
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => { calls.push('replace'); },
        }));
        const { loadAntigravity } = await import('./src/antigravity/service.ts');
        await loadAntigravity('saved');
        console.log(JSON.stringify(calls));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-test-not-running' },
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
    expect(JSON.parse(stdout)).toEqual(['clear', 'replace']);
});

it('should leave the Antigravity credential untouched when stale-state cleanup fails', async () => {
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
        const error = await loadAntigravity('saved').catch((value) => String(value));
        console.log(JSON.stringify({ error, restored }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-test-not-running' },
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
    expect(JSON.parse(stdout)).toEqual({ error: 'Error: cleanup failed', restored: false });
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
            clearLocalState: async () => { calls.push('clear'); },
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => { calls.push('replace'); },
        }));
        const { loadAntigravity } = await import('./src/antigravity/service.ts');
        const error = await loadAntigravity('saved').catch((value) => String(value));
        console.log(JSON.stringify({ calls, error }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-test-not-running' },
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
    expect(JSON.parse(stdout)).toEqual({ calls: [], error: 'Error: Saved account data is corrupted' });
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
            clearLocalState: async () => {},
            readCurrentSnapshot: async () => valid,
            replaceLiveSnapshot: async () => {},
        }));
        const { saveAntigravity } = await import('./src/antigravity/service.ts');
        const error = await saveAntigravity('saved').catch((value) => String(value));
        console.log(JSON.stringify({ error, unchanged: section.data.saved.password !== valid.password }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-test-not-running' },
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
    expect(JSON.parse(stdout)).toEqual({ error: 'Error: Saved account data is corrupted', unchanged: true });
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
            clearLocalState: async () => { calls.push('clear-state'); },
            readCurrentSnapshot: async () => { throw new Error('not called'); },
            replaceLiveSnapshot: async () => { calls.push('replace'); },
        }));
        const { clearAntigravity, loadAntigravity } = await import('./src/antigravity/service.ts');
        const loadError = await loadAntigravity('saved').catch((value) => String(value));
        const clearError = await clearAntigravity().catch((value) => String(value));
        console.log(JSON.stringify({ calls, clearError, loadError }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: '-hostile-name' },
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
        calls: [],
        clearError:
            'Error: Quit Antigravity completely before clearing or loading an account. Antigravity must be closed while Dondo replaces its local login state.',
        loadError:
            'Error: Quit Antigravity completely before clearing or loading an account. Antigravity must be closed while Dondo replaces its local login state.',
    });
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
            clearLocalState: async () => {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                calls.push('clear-start');
                await Bun.sleep(25);
                calls.push('clear-end');
                active -= 1;
            },
            readCurrentSnapshot: async () => snapshot,
            replaceLiveSnapshot: async () => { calls.push('replace'); },
        }));
        const { loadAntigravity } = await import('./src/antigravity/service.ts');
        await Promise.all([loadAntigravity('first'), loadAntigravity('second')]);
        console.log(JSON.stringify({ calls, maximumActive }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-test-not-running' },
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
        calls: ['clear-start', 'clear-end', 'replace', 'clear-start', 'clear-end', 'replace'],
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
            clearLocalState: async () => {},
            readCurrentSnapshot: async () => credential('rotated-live-token'),
            replaceLiveSnapshot: async () => {},
        }));
        const { antigravityState } = await import('./src/antigravity/service.ts');
        const state = await antigravityState();
        console.log(JSON.stringify(state.entries.filter((entry) => entry.active).map((entry) => entry.key)));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-test-not-running' },
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
    expect(JSON.parse(stdout)).toEqual(['second']);
});
