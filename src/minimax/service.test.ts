import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MinimaxVault } from '../types.ts';
import { invalidateMiniMaxIdentityLimits } from './service.ts';

const tokenFor = (identity: string, suffix: string) =>
    `header.${Buffer.from(JSON.stringify({ user: { id: identity } })).toString('base64url')}.${suffix}`;

it('should invalidate limits for every saved MiniMax label with the claimed identity', () => {
    const snapshot = (identity: string, suffix: string) => ({
        config: JSON.stringify({ tokens: { accessToken: tokenFor(identity, suffix) } }),
        createdAt: 'created',
        updatedAt: 'updated',
    });
    const quota = { fetchedAt: 'now', quota: { error: 'stale', ok: false as const } };
    const section: MinimaxVault = {
        data: {
            first: snapshot('shared', 'first'),
            other: snapshot('other', 'other'),
            second: snapshot('shared', 'second'),
        },
        limits: { first: quota, other: quota, second: quota },
    };

    expect(invalidateMiniMaxIdentityLimits(section, 'shared')).toBe(true);
    expect(Object.keys(section.limits)).toEqual(['other']);
});

const runMiniMaxScript = async (env: Record<string, string>) => {
    const script = `
        const { checkInMinimax, loadMinimax, minimaxState, saveMinimax } = await import('./src/minimax/service.ts');
        const configPath = process.env.MINIMAX_CONFIG_PATH;
        const vaultPath = process.env.DONDO_VAULT;
        await saveMinimax('saved');
        const savedToken = 'header.' + Buffer.from(JSON.stringify({ user: { id: 'saved-user' } })).toString('base64url') + '.saved';
        const liveToken = 'header.' + Buffer.from(JSON.stringify({ user: { id: 'saved-user' } })).toString('base64url') + '.live';
        await Bun.write(configPath, JSON.stringify({ tokens: { accessToken: liveToken } }));
        const before = await minimaxState();
        await loadMinimax('saved');
        const after = await minimaxState();
        const checkIn = await checkInMinimax();
        const loadedConfig = JSON.parse(await Bun.file(configPath).text());
        const loadedIdentity = JSON.parse(Buffer.from(loadedConfig.tokens.accessToken.split('.')[1], 'base64url').toString()).user.id;
        const vaultText = await Bun.file(vaultPath).text();
        console.log(JSON.stringify({
            activeBeforeLoad: before.entries[0]?.active ?? null,
            activeAfterLoad: after.entries[0]?.active ?? null,
            loadedIdentity,
            quotaOk: after.entries[0]?.quota?.ok ?? null,
            limitUpdatedAt: after.entries[0]?.limitUpdatedAt ?? '',
            fiveHourRemaining: after.entries[0]?.quota?.ok ? after.entries[0].quota.models['minimax-5-hour']?.percentage ?? null : null,
            weeklyRemaining: after.entries[0]?.quota?.ok ? after.entries[0].quota.models['minimax-weekly']?.percentage ?? null : null,
            creditDetail: after.entries[0]?.quota?.ok ? after.entries[0].quota.models['minimax-credits']?.detail ?? null : null,
            checkInClaimed: checkIn.claimed,
            checkInPoints: checkIn.points,
            vaultHasPlainToken: vaultText.includes(savedToken),
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
        limitUpdatedAt: string;
        loadedIdentity: string;
        quotaOk: boolean;
        fiveHourRemaining: number | null;
        weeklyRemaining: number | null;
        creditDetail: string | null;
        checkInClaimed: boolean;
        checkInPoints: number;
        vaultHasPlainToken: boolean;
    };
};

it('should save and load MiniMax configs with MiniMax Code quota limits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-test-'));
    const configPath = join(dir, 'minimax-agent-config.json');
    const vaultPath = join(dir, 'vault.json');
    const server = Bun.serve({
        fetch: (request) => {
            const pathname = new URL(request.url).pathname;
            if (pathname.endsWith('/v1/api/user/info')) {
                return Response.json({ data: { userInfo: { realUserID: 'saved-user' } } });
            }
            if (pathname.endsWith('/matrix/api/v1/user/get_user_extra_info')) {
                return Response.json({
                    base_resp: { status_code: 0, status_msg: 'success' },
                    workspaces: [{ has_token_plan: true, opcredit_balance: 0, selected: true }],
                });
            }
            if (pathname.endsWith('/matrix/api/v1/commerce/get_membership_info')) {
                return Response.json({
                    base_resp: { status_code: 0, status_msg: 'success' },
                    op_credit_summary: { total_remaining_amount: '312.106' },
                });
            }
            if (pathname.endsWith('/minimax-cloud/api/v1/signin/status')) {
                return Response.json({
                    base_resp: { status_code: 0, status_msg: 'ok' },
                    data: {
                        days: [{ day_no: 1, is_today: true, points: 400, status: 2 }],
                        scene: 2,
                    },
                });
            }
            if (pathname.endsWith('/minimax-cloud/api/v1/signin/claim')) {
                return Response.json({
                    base_resp: { status_code: 0, status_msg: 'ok' },
                    data: {
                        claim_result: 1,
                        day_no: 1,
                        panel: { days: [{ day_no: 1, is_today: true, points: 400, status: 3 }], scene: 2 },
                        points: 400,
                    },
                });
            }
            if (pathname.endsWith('/v1/api/openplatform/coding_plan/remains')) {
                return Response.json({
                    model_remains: [
                        {
                            current_interval_remaining_percent: 48.4,
                            current_weekly_remaining_percent: 75,
                            end_time: 1_800_000_000,
                            interval_boost_permille: 500,
                            weekly_boost_permille: 1_000,
                            weekly_end_time: 1_800_400_000,
                        },
                    ],
                });
            }
            return new Response('Not found', { status: 404 });
        },
        port: 0,
    });
    try {
        await Bun.write(
            configPath,
            JSON.stringify({
                tokens: {
                    accessToken:
                        'header.' +
                        Buffer.from(JSON.stringify({ user: { id: 'saved-user' } })).toString('base64url') +
                        '.saved',
                },
            }),
        );

        const result = await runMiniMaxScript({
            DONDO_VAULT: vaultPath,
            MINIMAX_AGENT_URL: `http://127.0.0.1:${server.port}`,
            MINIMAX_CONFIG_PATH: configPath,
            MINIMAX_PLATFORM_URL: `http://127.0.0.1:${server.port}`,
            MINIMAX_UUID: '00000000-0000-4000-8000-000000000000',
        });

        expect(result.activeBeforeLoad).toBe(true);
        expect(result.activeAfterLoad).toBe(true);
        expect(result.loadedIdentity).toBe('saved-user');
        expect(result.quotaOk).toBe(true);
        expect(result.limitUpdatedAt).toBeTruthy();
        expect(result.fiveHourRemaining).toBe(48);
        expect(result.weeklyRemaining).toBe(75);
        expect(result.creditDetail).toBe('Credit: 312');
        expect(result.checkInClaimed).toBe(true);
        expect(result.checkInPoints).toBe(400);
        expect(result.vaultHasPlainToken).toBe(false);
    } finally {
        server.stop(true);
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject invalid MiniMax configs on save and again before load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-validation-test-'));
    const configPath = join(dir, 'minimax-agent-config.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const { deleteMinimax, loadMinimax, minimaxState, saveMinimax } = await import('./src/minimax/service.ts');
        const { updateVaultSection } = await import('./src/storage/vault.ts');
        const configPath = process.env.MINIMAX_CONFIG_PATH;
        const valid = JSON.stringify({
            tokens: {
                accessToken: 'header.' + Buffer.from(JSON.stringify({ user: { id: 'valid-user' } })).toString('base64url') + '.sig',
            },
        });
        await Bun.write(configPath, '{');
        const saveError = await saveMinimax('invalid').catch((error) => String(error));
        await Bun.write(configPath, valid);
        await saveMinimax('saved');
        await updateVaultSection('minimax', (section) => {
            section.data.saved.config = '{';
            return { result: undefined };
        });
        const replacementSaveError = await saveMinimax('saved').catch((error) => String(error));
        const state = await minimaxState({ refreshLimits: true });
        const refreshError = await minimaxState({ refreshLimitKey: 'saved' }).catch((error) => String(error));
        const loadError = await loadMinimax('saved').catch((error) => String(error));
        await deleteMinimax('saved');
        console.log(JSON.stringify({
            corrupted: state.entries[0]?.corrupted ?? false,
            deleted: (await minimaxState()).entries.length === 0,
            liveUnchanged: await Bun.file(configPath).text() === valid,
            loadError,
            refreshError,
            replacementSaveError,
            saveError,
        }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, DONDO_VAULT: vaultPath, MINIMAX_CONFIG_PATH: configPath },
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
            liveUnchanged: boolean;
            loadError: string;
            refreshError: string;
            replacementSaveError: string;
            saveError: string;
        };
        expect(result.saveError).toContain('not valid MiniMax config JSON');
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

it('should not attach a stale MiniMax refresh to a replacement account', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-stale-refresh-test-'));
    const configPath = join(dir, 'minimax-agent-config.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        let markStarted;
        let release;
        const started = new Promise((resolve) => { markStarted = resolve; });
        const gate = new Promise((resolve) => { release = resolve; });
        let firstIdentity = true;
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                if (path.endsWith('/v1/api/user/info')) {
                    if (firstIdentity) {
                        firstIdentity = false;
                        markStarted();
                        await gate;
                    }
                    return Response.json({ data: { userInfo: { realUserID: 'old-user' } } });
                }
                if (path.endsWith('/matrix/api/v1/user/get_user_extra_info')) {
                    return Response.json({ workspaces: [{ has_token_plan: false, selected: true }] });
                }
                if (path.endsWith('/matrix/api/v1/commerce/get_membership_info')) {
                    return Response.json({ op_credit_summary: { total_remaining_amount: 10 } });
                }
                return new Response('', { status: 404 });
            },
        });
        process.env.MINIMAX_AGENT_URL = 'http://127.0.0.1:' + server.port;
        process.env.MINIMAX_PLATFORM_URL = 'http://127.0.0.1:' + server.port;
        process.env.MINIMAX_UUID = '00000000-0000-4000-8000-000000000000';
        const { minimaxState, saveMinimax } = await import('./src/minimax/service.ts');
        const token = (id, suffix) => 'header.' + Buffer.from(JSON.stringify({ user: { id } })).toString('base64url') + '.' + suffix;
        try {
            await Bun.write(process.env.MINIMAX_CONFIG_PATH, JSON.stringify({ tokens: { accessToken: token('old-user', 'old') } }));
            await saveMinimax('saved');
            const refresh = minimaxState({ refreshLimits: true });
            await started;
            await Bun.write(process.env.MINIMAX_CONFIG_PATH, JSON.stringify({ tokens: { accessToken: token('new-user', 'new') } }));
            await saveMinimax('saved');
            release();
            const state = await refresh;
            const saved = state.entries.find((entry) => entry.key === 'saved');
            console.log(JSON.stringify({ limitUpdatedAt: saved?.limitUpdatedAt ?? '', quota: saved?.quota ?? null }));
        } finally {
            release();
            server.stop(true);
        }
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, DONDO_VAULT: vaultPath, MINIMAX_CONFIG_PATH: configPath },
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
        expect(JSON.parse(stdout)).toEqual({ limitUpdatedAt: '', quota: null });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
