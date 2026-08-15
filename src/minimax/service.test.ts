import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MinimaxVault } from '../types.ts';
import { invalidateMiniMaxIdentityLimits } from './service.ts';

const tokenFor = (identity: string, suffix: string) =>
    `header.${Buffer.from(JSON.stringify({ user: { id: identity } })).toString('base64url')}.${suffix}`;

const miniMaxPanelPayload = (todayStatus: number) => ({
    days: Array.from({ length: 7 }, (_, index) => ({
        day_no: index + 1,
        is_today: index === 0,
        points: 400,
        status: index === 0 ? todayStatus : 1,
    })),
    scene: 2,
});

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
                    data: miniMaxPanelPayload(2),
                });
            }
            if (pathname.endsWith('/minimax-cloud/api/v1/signin/claim')) {
                return Response.json({
                    base_resp: { status_code: 0, status_msg: 'ok' },
                    data: {
                        claim_id: 'claim-id',
                        claim_result: 1,
                        day_no: 1,
                        expire_at_ms: 1_800_086_400_000,
                        panel: miniMaxPanelPayload(3),
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

it('should cycle MiniMax accounts by label and heal past an unauthorized candidate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-cycle-test-'));
    const configPath = join(dir, 'minimax-agent-config.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const token = (id) => 'header.' + Buffer.from(JSON.stringify({ user: { id } })).toString('base64url') + '.sig';
        const tokens = { alpha: token('alpha'), beta: token('beta'), gamma: token('gamma') };
        const panel = {
            days: Array.from({ length: 7 }, (_, index) => ({
                day_no: index + 1, is_today: index === 0, points: 100, status: index === 0 ? 3 : 1,
            })),
            scene: 2,
        };
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                const accessToken = url.searchParams.get('token');
                if (url.pathname.endsWith('/v1/api/user/info')) {
                    if (accessToken === tokens.beta) return new Response('', { status: 401 });
                    const id = accessToken === tokens.gamma ? 'gamma-real' : 'alpha-real';
                    return Response.json({ data: { userInfo: { realUserID: id } } });
                }
                if (url.pathname.endsWith('/minimax-cloud/api/v1/signin/status')) {
                    return Response.json({ base_resp: { status_code: 0 }, data: panel });
                }
                return new Response('', { status: 404 });
            },
        });
        process.env.MINIMAX_AGENT_URL = 'http://127.0.0.1:' + server.port;
        process.env.MINIMAX_PLATFORM_URL = 'http://127.0.0.1:' + server.port;
        process.env.MINIMAX_UUID = '00000000-0000-4000-8000-000000000000';
        const { cycleNextMinimax, saveMinimax } = await import('./src/minimax/service.ts');
        try {
            for (const label of ['gamma', 'alpha', 'beta']) {
                await Bun.write(process.env.MINIMAX_CONFIG_PATH, JSON.stringify({ tokens: { accessToken: tokens[label] } }));
                await saveMinimax(label);
            }
            await Bun.write(process.env.MINIMAX_CONFIG_PATH, JSON.stringify({ tokens: { accessToken: tokens.alpha } }));
            let skipped = 0;
            const result = await cycleNextMinimax({ onSkip: () => { skipped += 1; } });
            const live = JSON.parse(await Bun.file(process.env.MINIMAX_CONFIG_PATH).text());
            console.log(JSON.stringify({ healed: result.healed, loadedNext: live.tokens.accessToken === tokens.gamma, skipped }));
        } finally {
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
        expect(JSON.parse(stdout)).toEqual({ healed: true, loadedNext: true, skipped: 1 });
        expect(stdout).not.toMatch(/alpha|beta|gamma/iu);
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
        let firstExtraInfo = true;
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                if (path.endsWith('/v1/api/user/info')) {
                    return Response.json({ data: { userInfo: { realUserID: new URL(request.url).searchParams.get('user_id') } } });
                }
                if (path.endsWith('/matrix/api/v1/user/get_user_extra_info')) {
                    if (firstExtraInfo) {
                        firstExtraInfo = false;
                        markStarted();
                        await gate;
                    }
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

it('should check in before loading MiniMax and preserve the live config when check-in fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-load-check-in-test-'));
    const configPath = join(dir, 'minimax-agent-config.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const token = (id, suffix) =>
            'header.' + Buffer.from(JSON.stringify({ user: { id } })).toString('base64url') + '.' + suffix;
        const identityFromRequest = (request) => {
            const accessToken = new URL(request.url).searchParams.get('token') ?? '';
            return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).user.id;
        };
        const panel = (todayStatus) => ({
            days: Array.from({ length: 7 }, (_, index) => ({
                day_no: index + 1,
                is_today: index === 0,
                points: 400,
                status: index === 0 ? todayStatus : 1,
            })),
            scene: 2,
        });
        const liveToken = token('live-user', 'live');
        let liveIdentityDuringTargetCheckIn = '';
        let liveIdentityDuringFailedCheckIn = '';
        let targetIdentityCalls = 0;
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                const requestIdentity = identityFromRequest(request);
                if (path.endsWith('/v1/api/user/info')) {
                    if (requestIdentity === 'target-user') {
                        targetIdentityCalls += 1;
                    }
                    return Response.json({ data: { userInfo: { realUserID: requestIdentity } } });
                }
                if (path.endsWith('/minimax-cloud/api/v1/signin/status')) {
                    const liveConfig = JSON.parse(await Bun.file(process.env.MINIMAX_CONFIG_PATH).text());
                    const livePayload = JSON.parse(
                        Buffer.from(liveConfig.tokens.accessToken.split('.')[1], 'base64url').toString(),
                    );
                    if (requestIdentity === 'target-user') {
                        liveIdentityDuringTargetCheckIn ||= livePayload.user.id;
                        return Response.json({ base_resp: { status_code: 0 }, data: panel(3) });
                    }
                    liveIdentityDuringFailedCheckIn = livePayload.user.id;
                    return new Response('', { status: 401 });
                }
                return new Response('', { status: 404 });
            },
        });
        process.env.MINIMAX_AGENT_URL = 'http://127.0.0.1:' + server.port;
        process.env.MINIMAX_PLATFORM_URL = 'http://127.0.0.1:' + server.port;
        process.env.MINIMAX_UUID = '00000000-0000-4000-8000-000000000000';
        const { loadMinimax, saveMinimax } = await import('./src/minimax/service.ts');
        try {
            await Bun.write(process.env.MINIMAX_CONFIG_PATH, JSON.stringify({
                tokens: { accessToken: token('target-user', 'target') },
            }));
            await saveMinimax('target');
            await Bun.write(process.env.MINIMAX_CONFIG_PATH, JSON.stringify({ tokens: { accessToken: liveToken } }));

            const outcome = await loadMinimax('target');
            const loadedAfterSuccess = JSON.parse(await Bun.file(process.env.MINIMAX_CONFIG_PATH).text());
            await loadMinimax('target');

            await Bun.write(process.env.MINIMAX_CONFIG_PATH, JSON.stringify({
                tokens: { accessToken: token('failed-user', 'failed') },
            }));
            await saveMinimax('failed');
            await Bun.write(process.env.MINIMAX_CONFIG_PATH, JSON.stringify({ tokens: { accessToken: liveToken } }));
            const failure = await loadMinimax('failed').catch((error) => String(error));
            const liveAfterFailure = JSON.parse(await Bun.file(process.env.MINIMAX_CONFIG_PATH).text());

            console.log(JSON.stringify({
                failure,
                liveIdentityDuringFailedCheckIn,
                liveIdentityDuringTargetCheckIn,
                livePreservedAfterFailure: liveAfterFailure.tokens.accessToken === liveToken,
                loadedTarget: loadedAfterSuccess.tokens.accessToken.includes('.target'),
                outcome,
                targetIdentityCalls,
            }));
        } finally {
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
        const result = JSON.parse(stdout) as {
            failure: string;
            liveIdentityDuringFailedCheckIn: string;
            liveIdentityDuringTargetCheckIn: string;
            livePreservedAfterFailure: boolean;
            loadedTarget: boolean;
            outcome: Record<string, unknown>;
            targetIdentityCalls: number;
        };
        expect(result.liveIdentityDuringTargetCheckIn).toBe('live-user');
        expect(result.loadedTarget).toBe(true);
        expect(result.outcome).toEqual({
            alreadyClaimed: true,
            claimed: false,
            dayNo: 1,
            points: 400,
            status: 'claimed',
        });
        expect(result.targetIdentityCalls).toBe(1);
        expect(result.failure).toContain('expired or rejected');
        expect(result.liveIdentityDuringFailedCheckIn).toBe('live-user');
        expect(result.livePreservedAfterFailure).toBe(true);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should check in all unique readable MiniMax accounts with bounded isolated work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-check-in-all-test-'));
    const configPath = join(dir, 'minimax-agent-config.json');
    const vaultPath = join(dir, 'vault.json');
    const script = `
        const token = (id, suffix) =>
            'header.' + Buffer.from(JSON.stringify({ user: { id } })).toString('base64url') + '.' + suffix;
        const identityFromRequest = (request) => {
            const accessToken = new URL(request.url).searchParams.get('token') ?? '';
            return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).user.id;
        };
        const panel = (todayStatus) => ({
            days: Array.from({ length: 7 }, (_, index) => ({
                day_no: index + 1,
                is_today: index === 0,
                points: 400,
                status: index === 0 ? todayStatus : 1,
            })),
            scene: 2,
        });
        const statusByIdentity = {
            claimed: 2,
            already: 3,
            upcoming: 1,
            disabled: 4,
        };
        let active = 0;
        let maximumActive = 0;
        const statusCalls = {};
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                const requestIdentity = identityFromRequest(request);
                if (path.endsWith('/v1/api/user/info')) {
                    return Response.json({ data: { userInfo: { realUserID: requestIdentity } } });
                }
                if (path.endsWith('/minimax-cloud/api/v1/signin/status')) {
                    active += 1;
                    maximumActive = Math.max(maximumActive, active);
                    statusCalls[requestIdentity] = (statusCalls[requestIdentity] ?? 0) + 1;
                    await Bun.sleep(40);
                    active -= 1;
                    if (requestIdentity === 'failed') {
                        return new Response('', { status: 503 });
                    }
                    return Response.json({
                        base_resp: { status_code: 0 },
                        data: panel(statusByIdentity[requestIdentity]),
                    });
                }
                if (path.endsWith('/minimax-cloud/api/v1/signin/claim')) {
                    return Response.json({
                        base_resp: { status_code: 0 },
                        data: {
                            claim_id: 'claim-id',
                            claim_result: 1,
                            day_no: 1,
                            expire_at_ms: 1_800_086_400_000,
                            panel: panel(3),
                            points: 400,
                        },
                    });
                }
                return new Response('', { status: 404 });
            },
        });
        process.env.MINIMAX_AGENT_URL = 'http://127.0.0.1:' + server.port;
        process.env.MINIMAX_PLATFORM_URL = 'http://127.0.0.1:' + server.port;
        process.env.MINIMAX_UUID = '00000000-0000-4000-8000-000000000000';
        const { checkInAllMinimax, saveMinimax } = await import('./src/minimax/service.ts');
        const { readVaultSection, updateVaultSection } = await import('./src/storage/vault.ts');
        try {
            for (const [label, accountIdentity, suffix] of [
                ['one', 'claimed', 'one'],
                ['one-copy', 'claimed', 'copy'],
                ['two', 'already', 'two'],
                ['three', 'upcoming', 'three'],
                ['four', 'disabled', 'four'],
                ['five', 'failed', 'five'],
            ]) {
                await Bun.write(process.env.MINIMAX_CONFIG_PATH, JSON.stringify({
                    tokens: { accessToken: token(accountIdentity, suffix) },
                }));
                await saveMinimax(label);
            }
            await updateVaultSection('minimax', (section) => {
                for (const key of Object.keys(section.data)) {
                    section.limits[key] = {
                        fetchedAt: '2026-08-13T00:00:00.000Z',
                        quota: { error: 'stale', ok: false },
                    };
                }
                return { result: undefined };
            });

            const result = await checkInAllMinimax();
            const section = await readVaultSection('minimax');
            console.log(JSON.stringify({
                maximumActive,
                remainingLimitKeys: Object.keys(section.limits).sort(),
                resolvedIdentityCount: Object.values(section.data).filter((snapshot) => snapshot.realUserId).length,
                result,
                statusCalls,
            }));
        } finally {
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
        const result = JSON.parse(stdout) as {
            maximumActive: number;
            remainingLimitKeys: string[];
            resolvedIdentityCount: number;
            result: Record<string, number>;
            statusCalls: Record<string, number>;
        };
        expect(result.result).toEqual({
            alreadyClaimed: 1,
            attempted: 5,
            claimed: 1,
            failed: 1,
            unavailable: 2,
        });
        expect(result.maximumActive).toBeGreaterThan(1);
        expect(result.maximumActive).toBeLessThanOrEqual(3);
        expect(result.statusCalls).toEqual({ already: 1, claimed: 1, disabled: 1, failed: 1, upcoming: 1 });
        expect(result.resolvedIdentityCount).toBe(6);
        expect(result.remainingLimitKeys).toEqual(['five', 'four', 'three', 'two']);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
