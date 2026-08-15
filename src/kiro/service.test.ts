import { expect, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runKiroScript = async (env: Record<string, string>) => {
    const script = `
        const { clearKiro, deleteKiro, kiroState, loadKiro, saveKiro } = await import('./src/kiro/service.ts');
        const authPath = process.env.KIRO_AUTH_PATH;
        const profilePath = process.env.KIRO_PROFILE_PATH;
        const vaultPath = process.env.DONDO_VAULT;
        await Bun.write(profilePath, JSON.stringify({ id: 'dummy-profile' }));
        await saveKiro('saved');
        await clearKiro();
        const clearedProfile = !(await Bun.file(profilePath).exists());
        await Bun.write(authPath, JSON.stringify({
            accessToken: 'dummy-other-access',
            refreshToken: 'dummy-other-refresh',
            profileArn: 'arn:saved',
            authMethod: 'social',
            provider: 'Google',
            expiresAt: '2026-01-01T00:00:00.000Z',
        }));
        const before = await kiroState();
        await loadKiro('saved');
        const after = await kiroState();
        const loadedAuth = JSON.parse(await Bun.file(authPath).text());
        const loadedProfile = JSON.parse(await Bun.file(profilePath).text());
        await Bun.write(authPath, JSON.stringify({
            ...loadedAuth,
            accessToken: 'dummy-live-rotated-access',
            refreshToken: 'dummy-live-rotated-refresh',
        }));
        const afterLiveRotation = await kiroState();
        const vaultText = await Bun.file(vaultPath).text();
        await deleteKiro('saved');
        const afterDelete = await kiroState();
        await clearKiro();
        console.log(JSON.stringify({
            activeBeforeLoad: before.entries[0]?.active ?? null,
            activeAfterLoad: after.entries[0]?.active ?? null,
            activeAfterLiveRotation: afterLiveRotation.entries[0]?.active ?? null,
            cleared: !(await Bun.file(authPath).exists()),
            clearedProfile,
            deleted: afterDelete.entries.length === 0,
            quotaLeft: before.entries[0]?.quota?.ok ? before.entries[0].quota.models.credit?.percentage ?? -1 : -1,
            loadedProfileRestored: loadedProfile.id === 'dummy-profile',
            loadedProfileArn: loadedAuth.profileArn ?? '',
            loadedRefreshWasRotated: loadedAuth.refreshToken === 'dummy-refreshed',
            vaultHasPlainToken: vaultText.includes('dummy-refresh'),
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
        activeAfterLiveRotation: boolean;
        activeBeforeLoad: boolean;
        cleared: boolean;
        clearedProfile: boolean;
        deleted: boolean;
        loadedProfileArn: string;
        loadedProfileRestored: boolean;
        loadedRefreshWasRotated: boolean;
        quotaLeft: number;
        vaultHasPlainToken: boolean;
    };
};

it('should save and load Kiro auth with encrypted vault storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const vaultPath = join(dir, 'vault.json');
    let refreshRequests = 0;
    const refreshServer = Bun.serve({
        fetch: async (request) => {
            if (new URL(request.url).pathname === '/getUsageLimits') {
                return Response.json({
                    usageBreakdownList: [
                        { currentUsageWithPrecision: 1, resourceType: 'CREDIT', usageLimitWithPrecision: 50 },
                    ],
                });
            }
            const body = (await request.json()) as { refreshToken?: string };
            refreshRequests += 1;
            expect(body.refreshToken).toBe('dummy-refresh');
            return Response.json({
                accessToken: 'dummy-refreshed-access',
                expiresIn: 3600,
                profileArn: 'arn:saved',
                refreshToken: 'dummy-refreshed',
            });
        },
        port: 0,
    });
    try {
        await Bun.write(
            authPath,
            JSON.stringify({
                accessToken: 'dummy-access',
                authMethod: 'social',
                expiresAt: '2026-01-01T00:00:00.000Z',
                profileArn: 'arn:saved',
                provider: 'Google',
                refreshToken: 'dummy-refresh',
            }),
        );

        const result = await runKiroScript({
            DONDO_VAULT: vaultPath,
            KIRO_AUTH_PATH: authPath,
            KIRO_AUTH_REFRESH_URL: `http://127.0.0.1:${refreshServer.port}/refreshToken`,
            KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
            KIRO_PROFILE_PATH: join(dir, 'profile.json'),
            KIRO_USAGE_URL: `http://127.0.0.1:${refreshServer.port}/getUsageLimits`,
        });

        expect(result.activeBeforeLoad).toBe(false);
        expect(result.activeAfterLoad).toBe(true);
        expect(result.activeAfterLiveRotation).toBe(false);
        expect(result.cleared).toBe(true);
        expect(result.clearedProfile).toBe(true);
        expect(result.deleted).toBe(true);
        expect(result.loadedProfileArn).toBe('arn:saved');
        expect(result.loadedProfileRestored).toBe(true);
        expect(result.loadedRefreshWasRotated).toBe(true);
        expect(result.quotaLeft).toBe(98);
        expect(refreshRequests).toBe(1);
        expect(result.vaultHasPlainToken).toBe(false);
        await expect(stat(authPath)).rejects.toThrow();
    } finally {
        refreshServer.stop(true);
        await rm(dir, { force: true, recursive: true });
    }
});

it('should cycle Kiro accounts in label order, skip corruption, and keep diagnostics label-free', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-cycle-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const script = `
        const { cycleNextKiro, saveKiro } = await import('./src/kiro/service.ts');
        const { updateVaultSection } = await import('./src/storage/vault.ts');
        const authPath = process.env.KIRO_AUTH_PATH;
        const writeAuth = (id) => Bun.write(authPath, JSON.stringify({
            accessToken: 'access-' + id, authMethod: 'IdC', profileArn: 'arn:' + id, refreshToken: 'refresh-' + id,
        }));
        await writeAuth('gamma');
        await saveKiro('gamma');
        await writeAuth('alpha');
        await saveKiro('alpha');
        await writeAuth('beta');
        await saveKiro('beta');
        await updateVaultSection('kiro', (section) => {
            section.data.beta.auth = '{';
            return { result: undefined };
        });
        await writeAuth('alpha');
        const diagnostics = [];
        const result = await cycleNextKiro({ onSkip: () => diagnostics.push('skipped') });
        const live = JSON.parse(await Bun.file(authPath).text());
        console.log(JSON.stringify({ diagnostics, healed: result.healed, live: live.profileArn }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: join(dir, 'vault.json'),
                KIRO_AUTH_PATH: authPath,
                KIRO_PROCESS_NAME: 'dondo-kiro-cycle-test-not-running',
                KIRO_PROFILE_PATH: join(dir, 'profile.json'),
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
        expect(JSON.parse(stdout)).toEqual({ diagnostics: ['skipped'], healed: true, live: 'arn:gamma' });
        expect(stdout).not.toContain('beta');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should preserve the original live Kiro account when every saved candidate is revoked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-cycle-failure-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const server = Bun.serve({ fetch: () => new Response('', { status: 401 }), port: 0 });
    const script = `
        const { cycleNextKiro, saveKiro } = await import('./src/kiro/service.ts');
        const authPath = process.env.KIRO_AUTH_PATH;
        const writeAuth = (id) => Bun.write(authPath, JSON.stringify({
            accessToken: 'access-' + id, authMethod: 'social', profileArn: 'arn:' + id, refreshToken: 'refresh-' + id,
        }));
        await writeAuth('alpha');
        await saveKiro('alpha');
        await writeAuth('beta');
        await saveKiro('beta');
        await writeAuth('original');
        const original = await Bun.file(authPath).text();
        let skipped = 0;
        const error = await cycleNextKiro({ onSkip: () => { skipped += 1; } }).catch((value) => String(value));
        console.log(JSON.stringify({ error, preserved: await Bun.file(authPath).text() === original, skipped }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: join(dir, 'vault.json'),
                KIRO_AUTH_PATH: authPath,
                KIRO_AUTH_REFRESH_URL: `http://127.0.0.1:${server.port}`,
                KIRO_PROCESS_NAME: 'dondo-kiro-cycle-test-not-running',
                KIRO_PROFILE_PATH: join(dir, 'profile.json'),
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
        expect(JSON.parse(stdout)).toEqual({
            error: 'Error: No saved Kiro account could be loaded',
            preserved: true,
            skipped: 2,
        });
        expect(stdout).not.toMatch(/alpha|beta|refresh-/u);
    } finally {
        server.stop(true);
        await rm(dir, { force: true, recursive: true });
    }
});

it('should snapshot and restore Kiro client registration credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-idc-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const profilePath = join(dir, 'profile.json');
    const vaultPath = join(dir, 'vault.json');
    const clientIdHash = 'a'.repeat(40);
    const registrationPath = join(dir, `${clientIdHash}.json`);
    const script = `
        const { clearKiro, loadKiro, saveKiro } = await import('./src/kiro/service.ts');
        const authPath = process.env.KIRO_AUTH_PATH;
        const profilePath = process.env.KIRO_PROFILE_PATH;
        const registrationPath = process.env.KIRO_REGISTRATION_PATH;
        const vaultPath = process.env.DONDO_VAULT;
        await saveKiro('builder');
        await clearKiro();
        const cleared = !(await Bun.file(authPath).exists())
            && !(await Bun.file(profilePath).exists())
            && !(await Bun.file(registrationPath).exists());
        await loadKiro('builder');
        const registration = JSON.parse(await Bun.file(registrationPath).text());
        const vault = await Bun.file(vaultPath).text();
        console.log(JSON.stringify({
            cleared,
            restored: registration.clientSecret === 'dummy-client-secret',
            vaultHasPlainSecret: vault.includes('dummy-client-secret'),
        }));
    `;

    try {
        await Promise.all([
            Bun.write(
                authPath,
                JSON.stringify({
                    accessToken: 'dummy-idc-access',
                    authMethod: 'IdC',
                    clientIdHash,
                    expiresAt: '2026-01-01T00:00:00.000Z',
                    provider: 'BuilderId',
                    refreshToken: 'dummy-idc-refresh',
                }),
            ),
            Bun.write(profilePath, JSON.stringify({ id: 'dummy-builder-profile' })),
            Bun.write(
                registrationPath,
                JSON.stringify({
                    clientId: 'dummy-client-id',
                    clientSecret: 'dummy-client-secret',
                    expiresAt: '2027-01-01T00:00:00.000Z',
                }),
            ),
        ]);
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: vaultPath,
                KIRO_AUTH_PATH: authPath,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: profilePath,
                KIRO_REGISTRATION_PATH: registrationPath,
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
        const result = JSON.parse(stdout) as {
            cleared: boolean;
            restored: boolean;
            vaultHasPlainSecret: boolean;
        };

        expect(result.cleared).toBe(true);
        expect(result.restored).toBe(true);
        expect(result.vaultHasPlainSecret).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should not replace live Kiro auth when a saved session was revoked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-revoked-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const vaultPath = join(dir, 'vault.json');
    const refreshServer = Bun.serve({
        fetch: () => new Response('', { status: 401 }),
        port: 0,
    });
    const script = `
        const { loadKiro, saveKiro } = await import('./src/kiro/service.ts');
        const authPath = process.env.KIRO_AUTH_PATH;
        await saveKiro('revoked');
        await Bun.write(authPath, JSON.stringify({
            accessToken: 'current-access',
            authMethod: 'social',
            expiresAt: '2026-01-01T00:00:00.000Z',
            profileArn: 'arn:shared',
            provider: 'Google',
            refreshToken: 'current-refresh',
        }));
        const error = await loadKiro('revoked').catch((value) => value);
        const live = JSON.parse(await Bun.file(authPath).text());
        console.log(JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            preservedCurrent: live.refreshToken === 'current-refresh',
        }));
    `;

    try {
        await Bun.write(
            authPath,
            JSON.stringify({
                accessToken: 'revoked-access',
                authMethod: 'social',
                expiresAt: '2026-01-01T00:00:00.000Z',
                profileArn: 'arn:shared',
                provider: 'Google',
                refreshToken: 'revoked-refresh',
            }),
        );
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: vaultPath,
                KIRO_AUTH_PATH: authPath,
                KIRO_AUTH_REFRESH_URL: `http://127.0.0.1:${refreshServer.port}/refreshToken`,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: join(dir, 'profile.json'),
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
        const result = JSON.parse(stdout) as { error: string; preservedCurrent: boolean };

        expect(result.error).toContain('has been revoked');
        expect(result.error).not.toContain('revoked-refresh');
        expect(result.preservedCurrent).toBe(true);
    } finally {
        refreshServer.stop(true);
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject hostile Kiro refresh response shapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-malformed-refresh-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const vaultPath = join(dir, 'vault.json');
    const responses = [
        null,
        [],
        7,
        {
            accessToken: 'next-access',
            expiresIn: 3600,
            profileArn: { value: 'arn:poison' },
            refreshToken: 'next-refresh',
        },
    ];
    const refreshServer = Bun.serve({
        fetch: () => Response.json(responses.shift()),
        port: 0,
    });
    const script = `
        const { loadKiro, saveKiro } = await import('./src/kiro/service.ts');
        const authPath = process.env.KIRO_AUTH_PATH;
        await saveKiro('saved');
        const original = await Bun.file(authPath).text();
        const errors = [];
        for (let index = 0; index < 4; index += 1) {
            errors.push(await loadKiro('saved').catch((value) => String(value)));
        }
        console.log(JSON.stringify({ errors, unchanged: await Bun.file(authPath).text() === original }));
    `;
    try {
        await Bun.write(
            authPath,
            JSON.stringify({
                accessToken: 'access',
                authMethod: 'social',
                profileArn: 'arn:saved',
                refreshToken: 'refresh',
            }),
        );
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: vaultPath,
                KIRO_AUTH_PATH: authPath,
                KIRO_AUTH_REFRESH_URL: `http://127.0.0.1:${refreshServer.port}/refreshToken`,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: join(dir, 'profile.json'),
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
        const result = JSON.parse(stdout) as { errors: string[]; unchanged: boolean };
        expect(result.errors).toHaveLength(4);
        expect(result.errors.every((error) => error.includes('incomplete session refresh response'))).toBe(true);
        expect(result.unchanged).toBe(true);
    } finally {
        refreshServer.stop(true);
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject malformed optional Kiro auth fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-malformed-auth-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const script = `
        const { saveKiro } = await import('./src/kiro/service.ts');
        const authPath = process.env.KIRO_AUTH_PATH;
        const profilePath = process.env.KIRO_PROFILE_PATH;
        const authError = await saveKiro('broken').catch((value) => String(value));
        await Bun.write(authPath, JSON.stringify({ refreshToken: 'refresh' }));
        await Bun.write(profilePath, '[]');
        const profileError = await saveKiro('broken').catch((value) => String(value));
        console.log(JSON.stringify({ authError, profileError }));
    `;
    try {
        await Bun.write(authPath, JSON.stringify({ accessToken: 123, refreshToken: 'refresh' }));
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: join(dir, 'vault.json'),
                KIRO_AUTH_PATH: authPath,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: join(dir, 'profile.json'),
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
        const result = JSON.parse(stdout) as { authError: string; profileError: string };
        expect(result.authError).toContain('not valid Kiro auth JSON');
        expect(result.profileError).toContain('not a valid JSON object');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should expose semantic-invalid saved Kiro supporting files as deletable corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-semantic-corruption-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const profilePath = join(dir, 'profile.json');
    const script = `
        const { deleteKiro, kiroState, loadKiro, saveKiro } = await import('./src/kiro/service.ts');
        const { updateVaultSection } = await import('./src/storage/vault.ts');
        await saveKiro('saved');
        await updateVaultSection('kiro', (section) => {
            section.data.saved.profile = '[]';
            return { result: undefined };
        });
        const saveError = await saveKiro('saved').catch((error) => String(error));
        const state = await kiroState({ refreshLimits: true });
        const refreshError = await kiroState({ refreshLimitKey: 'saved' }).catch((error) => String(error));
        const loadError = await loadKiro('saved').catch((error) => String(error));
        await deleteKiro('saved');
        console.log(JSON.stringify({
            corrupted: state.entries[0]?.corrupted ?? false,
            deleted: (await kiroState()).entries.length === 0,
            loadError,
            refreshError,
            saveError,
        }));
    `;
    try {
        await Promise.all([
            Bun.write(authPath, JSON.stringify({ authMethod: 'IdC', refreshToken: 'refresh' })),
            Bun.write(profilePath, JSON.stringify({ id: 'profile' })),
        ]);
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: join(dir, 'vault.json'),
                KIRO_AUTH_PATH: authPath,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: profilePath,
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
        const result = JSON.parse(stdout) as {
            corrupted: boolean;
            deleted: boolean;
            loadError: string;
            refreshError: string;
            saveError: string;
        };
        expect(result).toEqual({
            corrupted: true,
            deleted: true,
            loadError: 'Error: Saved account data is corrupted',
            refreshError: 'Error: Saved account data is corrupted',
            saveError: 'Error: Saved account data is corrupted',
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should serialize overlapping Kiro loads without splitting supporting files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-concurrent-load-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const profilePath = join(dir, 'profile.json');
    const script = `
        const { clearKiro, loadKiro, saveKiro } = await import('./src/kiro/service.ts');
        const authPath = process.env.KIRO_AUTH_PATH;
        const profilePath = process.env.KIRO_PROFILE_PATH;
        const writeLive = async (id) => {
            await Bun.write(authPath, JSON.stringify({ authMethod: 'IdC', profileArn: 'arn:' + id, refreshToken: 'refresh-' + id }));
            await Bun.write(profilePath, JSON.stringify({ id }));
        };
        await writeLive('first');
        await saveKiro('first');
        await writeLive('second');
        await saveKiro('second');
        await clearKiro();
        await Promise.all([loadKiro('first'), loadKiro('second')]);
        const auth = JSON.parse(await Bun.file(authPath).text());
        const profile = JSON.parse(await Bun.file(profilePath).text());
        console.log(JSON.stringify({ profile: profile.id, profileArn: auth.profileArn }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: join(dir, 'vault.json'),
                KIRO_AUTH_PATH: authPath,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: profilePath,
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
        expect(JSON.parse(stdout)).toEqual({ profile: 'second', profileArn: 'arn:second' });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should report a fixed error when Kiro session rollback is incomplete', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const authPath = process.env.KIRO_AUTH_PATH;
        const profilePath = process.env.KIRO_PROFILE_PATH;
        const currentAuth = JSON.stringify({ authMethod: 'IdC', profileArn: 'arn:current', refreshToken: 'current' });
        const savedAuth = JSON.stringify({ authMethod: 'IdC', profileArn: 'arn:saved', refreshToken: 'saved' });
        const realFs = await import('node:fs/promises');
        let finished = false;
        let lateWrite = false;
        let privateWrites = 0;
        mock.module('./src/storage/file.ts', () => ({
            readBoundedLocalText: async (path) => path === authPath ? currentAuth : JSON.stringify({ id: 'current' }),
            writePrivateFile: async () => {
                privateWrites += 1;
                if (privateWrites === 3) throw new Error('token=rollback-secret');
                if (privateWrites === 4) {
                    await Bun.sleep(30);
                    if (finished) lateWrite = true;
                }
            },
        }));
        mock.module('node:fs/promises', () => ({
            ...realFs,
            chmod: async () => { throw new Error('token=commit-secret'); },
            rename: async () => {},
            rm: async () => {},
        }));
        mock.module('./src/process.ts', () => ({ isProcessRunning: async () => false }));
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => ({
                data: { saved: { auth: savedAuth, createdAt: '', profile: JSON.stringify({ id: 'saved' }), updatedAt: '' } },
                limits: {},
            }),
            updateVaultSection: async (_platform, operation) => operation({
                data: { saved: { auth: savedAuth, createdAt: '', profile: JSON.stringify({ id: 'saved' }), updatedAt: '' } },
                limits: {},
            }).result,
        }));
        const { loadKiro } = await import('./src/kiro/service.ts');
        const error = await loadKiro('saved').catch((value) => String(value));
        finished = true;
        await Bun.sleep(50);
        console.log(JSON.stringify({ error, lateWrite }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            KIRO_AUTH_PATH: join(process.cwd(), 'unused-auth.json'),
            KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
            KIRO_PROFILE_PATH: join(process.cwd(), 'unused-profile.json'),
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
    expect(JSON.parse(stdout)).toEqual({
        error: 'Error: Kiro session replacement failed and rollback was incomplete',
        lateWrite: false,
    });
});

it('should finish all Kiro staging work before rollback returns', async () => {
    const script = `
        const { mock } = await import('bun:test');
        const authPath = process.env.KIRO_AUTH_PATH;
        const profilePath = process.env.KIRO_PROFILE_PATH;
        const registrationPath = authPath.replace(/[^/]+$/, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json');
        const currentAuth = JSON.stringify({ authMethod: 'IdC', profileArn: 'arn:current', refreshToken: 'current' });
        const savedAuth = JSON.stringify({
            authMethod: 'IdC', clientIdHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            profileArn: 'arn:saved', refreshToken: 'saved',
        });
        let finished = false;
        let lateWrite = false;
        mock.module('./src/storage/file.ts', () => ({
            readBoundedLocalText: async (path) => {
                if (path === profilePath) {
                    await Bun.sleep(30);
                    return JSON.stringify({ id: 'current' });
                }
                if (path === registrationPath) throw new Error('registration read failed');
                return currentAuth;
            },
            writePrivateFile: async () => { if (finished) lateWrite = true; },
        }));
        mock.module('node:fs/promises', () => ({
            chmod: async () => {},
            rename: async () => {},
            rm: async () => {},
        }));
        mock.module('./src/process.ts', () => ({ isProcessRunning: async () => false }));
        const section = {
            data: {
                saved: {
                    auth: savedAuth, clientRegistration: JSON.stringify({ client: 'saved' }), createdAt: '',
                    profile: JSON.stringify({ id: 'saved' }), updatedAt: '',
                },
            },
            limits: {},
        };
        mock.module('./src/storage/vault.ts', () => ({
            readVaultSection: async () => section,
            updateVaultSection: async (_platform, operation) => operation(section).result,
        }));
        const { loadKiro } = await import('./src/kiro/service.ts');
        const error = await loadKiro('saved').catch((value) => String(value));
        finished = true;
        await Bun.sleep(50);
        console.log(JSON.stringify({ error, lateWrite }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            KIRO_AUTH_PATH: join(process.cwd(), 'unused-auth.json'),
            KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
            KIRO_PROFILE_PATH: join(process.cwd(), 'unused-profile.json'),
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
    expect(JSON.parse(stdout)).toEqual({ error: 'Error: registration read failed', lateWrite: false });
});

it('should preserve Kiro auth when supporting-state cleanup fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-clear-failure-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const profilePath = dir;
    const script = `
        const authPath = process.env.KIRO_AUTH_PATH;
        const { clearKiro } = await import('./src/kiro/service.ts');
        let failed = false;
        try { await clearKiro(); } catch { failed = true; }
        console.log(JSON.stringify({
            authExists: await Bun.file(authPath).exists(),
            failed,
        }));
    `;
    try {
        await Bun.write(authPath, '{}');
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                KIRO_AUTH_PATH: authPath,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: profilePath,
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
        expect(JSON.parse(stdout)).toEqual({ authExists: true, failed: true });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should read live Kiro auth after an earlier queued load completes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-state-load-race-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const server = Bun.serve({
        fetch: async (request) => {
            if (new URL(request.url).pathname === '/refreshToken') {
                await Bun.sleep(100);
                return Response.json({
                    accessToken: 'loaded-access',
                    expiresIn: 3600,
                    profileArn: 'arn:saved',
                    refreshToken: 'loaded-refresh',
                });
            }
            return Response.json({
                usageBreakdownList: [{ currentUsage: 1, resourceType: 'CREDIT', usageLimit: 10 }],
            });
        },
        port: 0,
    });
    const script = `
        const { kiroState, loadKiro, saveKiro } = await import('./src/kiro/service.ts');
        const authPath = process.env.KIRO_AUTH_PATH;
        await saveKiro('saved');
        await Bun.write(authPath, JSON.stringify({
            accessToken: 'other-access', authMethod: 'social', profileArn: 'arn:other', refreshToken: 'other-refresh',
        }));
        const load = loadKiro('saved');
        await Bun.sleep(20);
        const state = kiroState();
        const [, resolvedState] = await Promise.all([load, state]);
        const live = JSON.parse(await Bun.file(authPath).text());
        console.log(JSON.stringify({
            active: resolvedState.entries.find((entry) => entry.key === 'saved')?.active ?? false,
            liveProfileArn: live.profileArn,
        }));
    `;
    try {
        await Bun.write(
            authPath,
            JSON.stringify({
                accessToken: 'saved-access',
                authMethod: 'social',
                profileArn: 'arn:saved',
                refreshToken: 'saved-refresh',
            }),
        );
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: join(dir, 'vault.json'),
                KIRO_AUTH_PATH: authPath,
                KIRO_AUTH_REFRESH_URL: `http://127.0.0.1:${server.port}/refreshToken`,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: join(dir, 'profile.json'),
                KIRO_USAGE_URL: `http://127.0.0.1:${server.port}/getUsageLimits`,
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
        expect(JSON.parse(stdout)).toEqual({ active: true, liveProfileArn: 'arn:saved' });
    } finally {
        server.stop(true);
        await rm(dir, { force: true, recursive: true });
    }
});

it('should not treat a shared Kiro profile ARN as account identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-active-identity-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    const profilePath = join(dir, 'profile.json');
    const script = `
        const { mock } = await import('bun:test');
        mock.module('./src/kiro/usage.ts', () => ({
            fetchKiroLimits: async () => ({ expires: '', models: {}, ok: true, tier: '' }),
        }));
        const { kiroState, saveKiro } = await import('./src/kiro/service.ts');
        const auth = (refreshToken) => JSON.stringify({
            accessToken: refreshToken + '-access',
            authMethod: 'idc',
            profileArn: 'arn:shared-profile',
            refreshToken,
        });
        await Bun.write(process.env.KIRO_AUTH_PATH, auth('first-refresh'));
        await saveKiro('first');
        await Bun.write(process.env.KIRO_AUTH_PATH, auth('second-refresh'));
        await saveKiro('second');
        await Bun.write(process.env.KIRO_AUTH_PATH, auth('first-refresh'));
        const state = await kiroState();
        console.log(JSON.stringify(state.entries.filter((entry) => entry.active).map((entry) => entry.key)));
    `;
    try {
        await Bun.write(profilePath, JSON.stringify({ profile: 'shared' }));
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: join(dir, 'vault.json'),
                KIRO_AUTH_PATH: authPath,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: profilePath,
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
        expect(JSON.parse(stdout)).toEqual(['first']);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should refresh expired active Kiro usage and persist rotated credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-kiro-active-refresh-test-'));
    const authPath = join(dir, 'kiro-auth-token.json');
    let refreshRequests = 0;
    const server = Bun.serve({
        fetch: async (request) => {
            const url = new URL(request.url);
            if (url.pathname === '/refreshToken') {
                refreshRequests += 1;
                return Response.json({
                    accessToken: 'refreshed-access',
                    expiresIn: 3600,
                    profileArn: 'arn:aws:codewhisperer:us-east-1:profile/test',
                    refreshToken: 'refreshed-refresh',
                });
            }
            if (request.headers.get('authorization') === 'Bearer refreshed-access') {
                return Response.json({
                    usageBreakdownList: [{ currentUsage: 1, resourceType: 'CREDIT', usageLimit: 10 }],
                });
            }
            return new Response('', { status: 401 });
        },
        port: 0,
    });
    const script = `
        const { kiroState, saveKiro } = await import('./src/kiro/service.ts');
        const { readVaultSection } = await import('./src/storage/vault.ts');
        const before = await Bun.file(process.env.KIRO_AUTH_PATH).text();
        await saveKiro('saved');
        const state = await kiroState();
        const after = await Bun.file(process.env.KIRO_AUTH_PATH).text();
        const entry = state.entries.find((candidate) => candidate.key === 'saved');
        console.log(JSON.stringify({
            active: entry?.active ?? false,
            liveUnchanged: before === after,
            savedRefresh: JSON.parse((await readVaultSection('kiro')).data.saved.auth).refreshToken,
            quotaOk: entry?.quota?.ok ?? false,
        }));
    `;
    try {
        await Bun.write(
            authPath,
            JSON.stringify({
                accessToken: 'expired-access',
                authMethod: 'social',
                expiresAt: '2000-01-01T00:00:00.000Z',
                profileArn: 'arn:aws:codewhisperer:us-east-1:profile/test',
                refreshToken: 'saved-refresh',
            }),
        );
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_VAULT: join(dir, 'vault.json'),
                KIRO_AUTH_PATH: authPath,
                KIRO_AUTH_REFRESH_URL: `http://127.0.0.1:${server.port}/refreshToken`,
                KIRO_PROCESS_NAME: 'dondo-kiro-test-not-running',
                KIRO_PROFILE_PATH: join(dir, 'profile.json'),
                KIRO_USAGE_URL: `http://127.0.0.1:${server.port}/getUsageLimits`,
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
        expect(JSON.parse(stdout)).toEqual({
            active: true,
            liveUnchanged: true,
            quotaOk: true,
            savedRefresh: 'refreshed-refresh',
        });
        expect(refreshRequests).toBe(1);
    } finally {
        server.stop(true);
        await rm(dir, { force: true, recursive: true });
    }
});
