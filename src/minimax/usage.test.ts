import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    checkInMiniMax,
    fetchMiniMaxLimits,
    parseMiniMaxConfig,
    scanMiniMaxUniqueUserId,
    usageToLimitResult,
    workspaceToLimitResult,
} from './usage.ts';

const originalFetch = globalThis.fetch;
const accessToken = `header.${Buffer.from(JSON.stringify({ user: { id: 'account-id' } })).toString('base64url')}.signature`;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

it('maps MiniMax Code 5-hour and weekly quota fields', () => {
    const result = usageToLimitResult({
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

    expect(result).toEqual({
        expires: '2027-01-19T23:06:40.000Z',
        models: {
            'minimax-5-hour': {
                displayName: '5-hour quota',
                limit: 50,
                percentage: 48,
                resetTime: '2027-01-15T08:00:00.000Z',
                used: 26,
            },
            'minimax-weekly': {
                displayName: 'Weekly quota',
                limit: 100,
                percentage: 75,
                resetTime: '2027-01-19T23:06:40.000Z',
                used: 25,
            },
        },
        ok: true,
        tier: 'MiniMax Code',
    });
});

it('maps unlimited MiniMax quota windows', () => {
    const result = usageToLimitResult({
        model_remains: [
            {
                current_interval_remaining_percent: 0,
                current_interval_status: 3,
                current_weekly_remaining_percent: 0,
                current_weekly_status: 3,
            },
        ],
    });

    expect(result).toEqual({
        expires: '',
        models: {
            'minimax-5-hour': {
                detail: 'Unlimited',
                displayName: '5-hour quota',
                percentage: 100,
                resetTime: '',
            },
            'minimax-weekly': {
                detail: 'Unlimited',
                displayName: 'Weekly quota',
                percentage: 100,
                resetTime: '',
            },
        },
        ok: true,
        tier: 'MiniMax Code',
    });
});

it('treats MiniMax non-plan access as valid without inventing a numeric quota', () => {
    const result = usageToLimitResult({
        base_resp: {
            status_code: 2062,
            status_msg: 'no active token plan subscription',
        },
    });

    expect(result).toEqual({
        expires: '',
        models: {
            'minimax-free-access': {
                detail: 'MiniMax does not report a numeric allowance for non-plan access',
                displayName: 'Free / non-plan access',
                percentage: 100,
                resetTime: '',
            },
        },
        ok: true,
        tier: 'MiniMax Code · no token plan',
    });
});

it('maps the commerce credit balance as a numeric credit limit', () => {
    expect(
        workspaceToLimitResult({
            creditBalance: 0,
            hasTokenPlan: false,
        }),
    ).toEqual({
        expires: '',
        models: {
            'minimax-credits': {
                detail: 'Credit: 0',
                displayName: 'Credits',
                percentage: 100,
                resetTime: '',
            },
        },
        ok: true,
        tier: 'MiniMax Code · free access',
    });
});

it('rejects invalid or incomplete MiniMax config JSON', () => {
    expect(parseMiniMaxConfig('{')).toBeNull();
    expect(parseMiniMaxConfig('{}')).toBeNull();
    expect(parseMiniMaxConfig(JSON.stringify({ tokens: { accessToken: 'opaque' } }))).toBeNull();
    expect(parseMiniMaxConfig(JSON.stringify({ tokens: { accessToken: `${accessToken}.extra` } }))).toBeNull();
    expect(
        parseMiniMaxConfig(
            JSON.stringify({
                tokens: { accessToken: `header.${Buffer.from([0xc3, 0x28]).toString('base64url')}.sig` },
            }),
        ),
    ).toBeNull();
    for (const payload of [null, false, 1, 'text', [], { user: null }]) {
        const malformedToken = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
        expect(parseMiniMaxConfig(JSON.stringify({ tokens: { accessToken: malformedToken } }))).toBeNull();
    }
    expect(parseMiniMaxConfig(JSON.stringify({ tokens: { accessToken, refreshToken: 123 } }))).toBeNull();
    expect(parseMiniMaxConfig(JSON.stringify({ tokens: { accessToken, refreshToken: 'legacy' } }))).toBeNull();
    expect(parseMiniMaxConfig(JSON.stringify({ tokens: { accessToken } }))).not.toBeNull();
});

it('omits non-finite MiniMax quota values', () => {
    const result = usageToLimitResult({
        model_remains: [
            {
                current_interval_remaining_percent: Number.POSITIVE_INFINITY,
                current_weekly_remaining_percent: 55,
                interval_boost_permille: Number.NaN,
                weekly_boost_permille: Number.POSITIVE_INFINITY,
            },
        ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
        expect(result.models['minimax-5-hour']).toBeUndefined();
        expect(result.models['minimax-weekly']).toEqual({
            displayName: 'Weekly quota',
            percentage: 55,
            resetTime: '',
        });
    }
});

it('omits invented MiniMax usage totals when boost data is absent', () => {
    const result = usageToLimitResult({
        model_remains: [{ current_interval_remaining_percent: 40 }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
        expect(result.models['minimax-5-hour']).toEqual({
            displayName: '5-hour quota',
            percentage: 40,
            resetTime: '',
        });
    }
});

it('normalizes hostile MiniMax provider status messages', () => {
    expect(usageToLimitResult({ base_resp: { status_code: 1, status_msg: { secret: true } } })).toEqual({
        error: 'MiniMax usage request was rejected',
        ok: false,
    });
});

it('does not expose hostile MiniMax check-in status messages', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/v1/api/user/info')) {
            return Response.json({ data: { userInfo: { realUserID: 'real-user' } } });
        }
        return Response.json({
            base_resp: { status_code: 9, status_msg: 'token=secret-provider-value' },
        });
    }) as typeof fetch;

    const error = await checkInMiniMax({ tokens: { accessToken } }).catch((value) => String(value));
    expect(error).toContain('MiniMax check-in status request was rejected');
    expect(error).not.toContain('secret-provider-value');
});

it('requires a non-empty string MiniMax agent identity', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
        requests += 1;
        return Response.json({ data: { userInfo: { realUserID: { secret: true } } } });
    }) as unknown as typeof fetch;

    expect(await fetchMiniMaxLimits({ tokens: { accessToken } })).toEqual({
        error: 'Saved MiniMax access token has no readable user identity',
        ok: false,
    });
    expect(requests).toBe(1);
});

it('fetches MiniMax plan membership and usage concurrently', async () => {
    const started = new Set<string>();
    let releaseRequests = () => {};
    let markConcurrent = () => {};
    const gate = new Promise<void>((resolve) => {
        releaseRequests = resolve;
    });
    const concurrent = new Promise<void>((resolve) => {
        markConcurrent = resolve;
    });
    const waitForPeer = async (name: string, payload: unknown) => {
        started.add(name);
        if (started.size === 2) {
            markConcurrent();
        }
        await gate;
        return Response.json(payload);
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/v1/api/user/info')) {
            return Response.json({ data: { userInfo: { realUserID: 'real-user' } } });
        }
        if (path.endsWith('/matrix/api/v1/user/get_user_extra_info')) {
            return Response.json({ workspaces: [{ has_token_plan: true, selected: true }] });
        }
        if (path.endsWith('/matrix/api/v1/commerce/get_membership_info')) {
            return waitForPeer('membership', { op_credit_summary: { total_remaining_amount: 10 } });
        }
        if (path.endsWith('/v1/api/openplatform/coding_plan/remains')) {
            return waitForPeer('usage', {
                model_remains: [{ current_interval_remaining_percent: 50, interval_boost_permille: 100 }],
            });
        }
        return new Response('', { status: 404 });
    }) as typeof fetch;

    const resultPromise = fetchMiniMaxLimits({ tokens: { accessToken } });
    try {
        await Promise.race([
            concurrent,
            Bun.sleep(250).then(() => {
                throw new Error('MiniMax plan requests did not start concurrently');
            }),
        ]);
        expect([...started].sort()).toEqual(['membership', 'usage']);
    } finally {
        releaseRequests();
    }
    expect((await resultPromise).ok).toBe(true);
});

it('does not claim when MiniMax check-in status is already claimed', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        calls.push(path);
        if (path.endsWith('/v1/api/user/info')) {
            return Response.json({ data: { userInfo: { realUserID: 'real-user' } } });
        }
        if (path.endsWith('/signin/status')) {
            return Response.json({ data: { days: [{ day_no: 2, is_today: true, points: 100, status: 3 }], scene: 2 } });
        }
        return new Response('', { status: 500 });
    }) as typeof fetch;

    const result = await checkInMiniMax({ tokens: { accessToken } });

    expect(result).toMatchObject({ alreadyClaimed: true, claimed: false, status: 'claimed' });
    expect(calls.some((path) => path.endsWith('/signin/claim'))).toBe(false);
});

it('maps an idempotent MiniMax claim response as already claimed', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/v1/api/user/info')) {
            return Response.json({ data: { userInfo: { realUserID: 'real-user' } } });
        }
        if (path.endsWith('/signin/status')) {
            return Response.json({ data: { days: [{ day_no: 2, is_today: true, points: 100, status: 2 }], scene: 2 } });
        }
        if (path.endsWith('/signin/claim')) {
            return Response.json({ data: { claim_result: 2, day_no: 2, points: 100 } });
        }
        return new Response('', { status: 500 });
    }) as typeof fetch;

    expect(await checkInMiniMax({ tokens: { accessToken } })).toMatchObject({
        alreadyClaimed: true,
        claimed: false,
        status: 'claimed',
    });
});

it('deduplicates concurrent MiniMax check-ins for the same token identity', async () => {
    const calls = { claim: 0, identity: 0, status: 0 };
    globalThis.fetch = (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/v1/api/user/info')) {
            calls.identity += 1;
            return Response.json({ data: { userInfo: { realUserID: 'real-user' } } });
        }
        if (path.endsWith('/signin/status')) {
            calls.status += 1;
            return Response.json({ data: { days: [{ day_no: 2, is_today: true, points: 100, status: 2 }], scene: 2 } });
        }
        if (path.endsWith('/signin/claim')) {
            calls.claim += 1;
            return Response.json({ data: { claim_result: 1, day_no: 2, points: 100 } });
        }
        return new Response('', { status: 500 });
    }) as typeof fetch;

    const results = await Promise.all([
        checkInMiniMax({ tokens: { accessToken } }),
        checkInMiniMax({ tokens: { accessToken } }),
        checkInMiniMax({ tokens: { accessToken } }),
    ]);

    expect(results.every((result) => result.claimed)).toBe(true);
    expect(calls).toEqual({ claim: 1, identity: 1, status: 1 });
});

it('cancels a MiniMax LevelDB stream after finding the UUID across chunks', async () => {
    const uuid = '12345678-1234-4234-8234-123456789abc';
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
            cancelled = true;
        },
        start: (controller) => {
            controller.enqueue(Buffer.from('prefix UNI'));
            controller.enqueue(Buffer.from(`QUE payload ${uuid} trailing`));
        },
    });

    expect(await scanMiniMaxUniqueUserId(stream)).toBe(uuid);
    expect(cancelled).toBe(true);
});

it('cancels a MiniMax LevelDB stream at its per-file scan ceiling', async () => {
    let cancelled = false;
    const uuid = '12345678-1234-4234-8234-123456789abc';
    const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
            cancelled = true;
        },
        start: (controller) => {
            controller.enqueue(Buffer.from('1234'));
            controller.enqueue(Buffer.from(`UNIQUE ${uuid}`));
        },
    });

    expect(await scanMiniMaxUniqueUserId(stream, 5)).toBe('');
    expect(cancelled).toBe(true);
    await expect(scanMiniMaxUniqueUserId(new ReadableStream(), -1)).rejects.toThrow(
        'MiniMax LevelDB scan byte limit must be a non-negative safe integer',
    );
});

it('coalesces MiniMax UUID scans and caches empty discovery until explicitly cleared', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-uuid-test-'));
    const storagePath = join(dir, 'leveldb');
    const script = `
        const { mkdir, rm } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const storagePath = process.env.MINIMAX_LOCAL_STORAGE_PATH;
        await mkdir(storagePath, { recursive: true });
        const usage = await import('./src/minimax/usage.ts');
        const first = await usage.miniMaxUniqueUserId();
        const target = join(storagePath, '000001.ldb');
        const uuid = '12345678-1234-4234-8234-123456789abc';
        await Bun.write(target, 'prefix UNIQUE value ' + uuid + ' suffix');
        const originalFile = Bun.file;
        let streams = 0;
        Bun.file = ((input, options) => {
            const file = options === undefined ? originalFile(input) : originalFile(input, options);
            if (String(input) !== target) return file;
            return new Proxy(file, {
                get(current, property) {
                    if (property === 'stream') return () => { streams += 1; return current.stream(); };
                    const value = Reflect.get(current, property, current);
                    return typeof value === 'function' ? value.bind(current) : value;
                },
            });
        });
        const values = await Promise.all([
            usage.miniMaxUniqueUserId(),
            usage.miniMaxUniqueUserId(),
            usage.miniMaxUniqueUserId(),
        ]);
        usage.clearMiniMaxUniqueUserIdCache();
        const discovered = await Promise.all([
            usage.miniMaxUniqueUserId(),
            usage.miniMaxUniqueUserId(),
            usage.miniMaxUniqueUserId(),
        ]);
        await rm(target, { force: true });
        const cached = await usage.miniMaxUniqueUserId();
        console.log(JSON.stringify({ cached, discovered, first, streams, values }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, MINIMAX_LOCAL_STORAGE_PATH: storagePath, MINIMAX_UUID: '' },
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
            cached: '12345678-1234-4234-8234-123456789abc',
            discovered: Array(3).fill('12345678-1234-4234-8234-123456789abc'),
            first: '',
            streams: 1,
            values: Array(3).fill(''),
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('bounds MiniMax UUID discovery to the newest 64 LevelDB files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-uuid-bound-test-'));
    const storagePath = join(dir, 'leveldb');
    const script = `
        const { mkdir } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const storagePath = process.env.MINIMAX_LOCAL_STORAGE_PATH;
        await mkdir(storagePath, { recursive: true });
        for (let index = 0; index < 70; index += 1) {
            const content = index === 0
                ? 'UNIQUE 12345678-1234-4234-8234-123456789abc'
                : 'no identity';
            await Bun.write(join(storagePath, String(index).padStart(6, '0') + '.ldb'), content);
        }
        const { miniMaxUniqueUserId } = await import('./src/minimax/usage.ts');
        console.log(JSON.stringify({ value: await miniMaxUniqueUserId() }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, MINIMAX_LOCAL_STORAGE_PATH: storagePath, MINIMAX_UUID: '' },
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
        expect(JSON.parse(stdout)).toEqual({ value: '' });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('bounds total MiniMax UUID discovery I/O across LevelDB files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-uuid-total-bound-test-'));
    const storagePath = join(dir, 'leveldb');
    const script = `
        const { mkdir, truncate } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const storagePath = process.env.MINIMAX_LOCAL_STORAGE_PATH;
        await mkdir(storagePath, { recursive: true });
        const uuid = '12345678-1234-4234-8234-123456789abc';
        for (let index = 1; index <= 5; index += 1) {
            const path = join(storagePath, String(index).padStart(6, '0') + '.ldb');
            await Bun.write(path, index === 1 ? 'UNIQUE ' + uuid : '');
            await truncate(path, 16 * 1024 * 1024);
        }
        const { miniMaxUniqueUserId } = await import('./src/minimax/usage.ts');
        console.log(JSON.stringify({ value: await miniMaxUniqueUserId() }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, MINIMAX_LOCAL_STORAGE_PATH: storagePath, MINIMAX_UUID: '' },
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
        expect(JSON.parse(stdout)).toEqual({ value: '' });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('continues MiniMax UUID discovery after an unreadable newer LevelDB entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-uuid-unreadable-test-'));
    const storagePath = join(dir, 'leveldb');
    const script = `
        const { mkdir } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const storagePath = process.env.MINIMAX_LOCAL_STORAGE_PATH;
        await mkdir(storagePath, { recursive: true });
        const uuid = '12345678-1234-4234-8234-123456789abc';
        await Bun.write(join(storagePath, '000001.ldb'), 'UNIQUE ' + uuid);
        await mkdir(join(storagePath, '000002.ldb'));
        const { miniMaxUniqueUserId } = await import('./src/minimax/usage.ts');
        console.log(JSON.stringify({ value: await miniMaxUniqueUserId() }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, MINIMAX_LOCAL_STORAGE_PATH: storagePath, MINIMAX_UUID: '' },
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
        expect(JSON.parse(stdout)).toEqual({ value: '12345678-1234-4234-8234-123456789abc' });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
