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
        });

        expect(result.activeBeforeLoad).toBe(false);
        expect(result.activeAfterLoad).toBe(true);
        expect(result.activeAfterLiveRotation).toBe(true);
        expect(result.cleared).toBe(true);
        expect(result.clearedProfile).toBe(true);
        expect(result.deleted).toBe(true);
        expect(result.loadedProfileArn).toBe('arn:saved');
        expect(result.loadedProfileRestored).toBe(true);
        expect(result.loadedRefreshWasRotated).toBe(true);
        expect(refreshRequests).toBe(1);
        expect(result.vaultHasPlainToken).toBe(false);
        await expect(stat(authPath)).rejects.toThrow();
    } finally {
        refreshServer.stop(true);
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
