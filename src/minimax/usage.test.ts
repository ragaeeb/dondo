import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
const originalDateNow = Date.now;
const accessToken = `header.${Buffer.from(JSON.stringify({ user: { id: 'account-id' } })).toString('base64url')}.signature`;
const signatureSecret = 'I*7Cf%WZ#S&%1RlZJ&C2';

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

const checkInPanelPayload = (todayStatus: 1 | 2 | 3 | 4 = 3) => ({
    days: Array.from({ length: 7 }, (_, index) => ({
        day_no: index + 1,
        is_today: index === 1,
        points: (index + 1) * 100,
        status: index === 1 ? todayStatus : index < 1 ? 3 : 1,
    })),
    scene: 2,
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
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
    const signedTimes: Array<[string, string]> = [];
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
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;
        if (path.endsWith('/matrix/api/v1/commerce/get_membership_info')) {
            const headers = new Headers(init?.headers);
            signedTimes.push([url.searchParams.get('unix') ?? '', headers.get('x-timestamp') ?? '']);
        }
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
    expect(signedTimes.length).toBe(1);
    expect(signedTimes.every(([unix, header]) => unix && header && Number(unix) === Number(header) * 1_000)).toBe(true);
});

it('matches the installed MiniMax desktop status request contract and reuses a resolved identity', async () => {
    Date.now = () => 1_800_000_000_987;
    const requests: Array<{ init: RequestInit | undefined; url: URL }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({ init, url });
        return Response.json({ data: checkInPanelPayload(3) });
    }) as typeof fetch;

    await checkInMiniMax({ tokens: { accessToken } }, { realUserId: 'real-user' });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) {
        throw new Error('Expected a MiniMax status request');
    }
    expect(request.url.pathname).toBe('/minimax-cloud/api/v1/signin/status');
    expect(request.url.searchParams.get('client')).toBe('desktop');
    expect(request.url.searchParams.get('unix')).toBe('1800000000000');
    expect(request.url.searchParams.get('user_id')).toBe('real-user');
    const headers = new Headers(request.init?.headers);
    expect(headers.get('client')).toBeNull();
    expect(headers.get('x-timestamp')).toBe('1800000000');
    expect(headers.get('x-signature')).toBe(md5(`1800000000${signatureSecret}`));
    expect(request.init?.method).toBe('GET');
    expect(request.init?.body).toBeUndefined();
});

it('matches the installed MiniMax desktop claim request contract', async () => {
    Date.now = () => 1_800_000_000_987;
    const requests: Array<{ init: RequestInit | undefined; url: URL }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({ init, url });
        if (url.pathname.endsWith('/signin/status')) {
            return Response.json({ data: checkInPanelPayload(2) });
        }
        return Response.json({
            data: {
                claim_id: 'claim-id',
                claim_result: 1,
                day_no: 2,
                expire_at_ms: 1_800_086_400_000,
                panel: checkInPanelPayload(3),
                points: 200,
            },
        });
    }) as typeof fetch;

    const result = await checkInMiniMax({ tokens: { accessToken } }, { realUserId: 'real-user' });

    expect(result).toMatchObject({ claimed: true, dayNo: 2, points: 200, status: 'claimed' });
    expect(requests).toHaveLength(2);
    const claim = requests[1];
    if (!claim) {
        throw new Error('Expected a MiniMax claim request');
    }
    expect(claim.url.pathname).toBe('/minimax-cloud/api/v1/signin/claim');
    expect(claim.url.searchParams.get('client')).toBe('desktop');
    expect(claim.url.searchParams.get('unix')).toBe('1800000000000');
    expect(claim.init?.method).toBe('POST');
    expect(claim.init?.body).toBe('{}');
    const headers = new Headers(claim.init?.headers);
    expect(headers.get('client')).toBeNull();
    expect(headers.get('x-timestamp')).toBe('1800000000');
    expect(headers.get('x-signature')).toBe(md5(`1800000000${signatureSecret}{}`));
});

it('falls back once from a stale supplied MiniMax identity and reports the replacement', async () => {
    const calls = { identity: 0, status: 0 };
    const resolved: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/v1/api/user/info')) {
            calls.identity += 1;
            return Response.json({ data: { userInfo: { realUserID: 'fresh-real-user' } } });
        }
        if (url.pathname.endsWith('/signin/status')) {
            calls.status += 1;
            if (url.searchParams.get('user_id') === 'stale-real-user') {
                return new Response('', { status: 400 });
            }
            return Response.json({ data: checkInPanelPayload(3) });
        }
        return new Response('', { status: 500 });
    }) as typeof fetch;

    const result = await checkInMiniMax(
        { tokens: { accessToken } },
        {
            onRealUserIdResolved: (realUserId) => {
                resolved.push(realUserId);
            },
            realUserId: 'stale-real-user',
        },
    );

    expect(result.status).toBe('claimed');
    expect(calls).toEqual({ identity: 1, status: 2 });
    expect(resolved).toEqual(['fresh-real-user']);
});

it('refreshes a cached MiniMax identity when a successful status response rejects it', async () => {
    const calls = { identity: 0, status: 0 };
    const resolved: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/v1/api/user/info')) {
            calls.identity += 1;
            return Response.json({ data: { userInfo: { realUserID: 'fresh-real-user' } } });
        }
        if (url.pathname.endsWith('/signin/status')) {
            calls.status += 1;
            return url.searchParams.get('user_id') === 'stale-real-user'
                ? Response.json({ base_resp: { status_code: 1001, status_msg: 'stale identity' } })
                : Response.json({ data: checkInPanelPayload(3) });
        }
        return new Response('', { status: 500 });
    }) as typeof fetch;

    const result = await checkInMiniMax(
        { tokens: { accessToken } },
        {
            onRealUserIdResolved: (realUserId) => {
                resolved.push(realUserId);
            },
            realUserId: 'stale-real-user',
        },
    );

    expect(result.status).toBe('claimed');
    expect(calls).toEqual({ identity: 1, status: 2 });
    expect(resolved).toEqual(['fresh-real-user']);
});

it('rejects MiniMax status panels that do not match the installed seven-day contract', async () => {
    const valid = checkInPanelPayload(3);
    const invalidPanels = [
        { ...valid, days: valid.days.slice(0, 6) },
        { ...valid, days: valid.days.map((day, index) => (index === 6 ? { ...day, day_no: 1 } : day)) },
        { ...valid, days: valid.days.map((day, index) => (index === 6 ? { ...day, points: '700' } : day)) },
        { ...valid, days: valid.days.map((day, index) => (index === 6 ? { ...day, is_today: true } : day)) },
        { ...valid, days: valid.days.map((day, index) => (index >= 5 ? { ...day, status: 2 } : day)) },
        { ...valid, scene: 5 },
    ];

    for (const panel of invalidPanels) {
        globalThis.fetch = (async () => Response.json({ data: panel })) as unknown as typeof fetch;
        await expect(checkInMiniMax({ tokens: { accessToken } }, { realUserId: 'real-user' })).rejects.toThrow(
            'MiniMax check-in status returned no valid schedule',
        );
    }
});

it('rejects MiniMax claim payloads that do not match the installed app contract', async () => {
    const validClaim = {
        claim_id: 'claim-id',
        claim_result: 1,
        day_no: 2,
        expire_at_ms: 1_800_086_400_000,
        panel: checkInPanelPayload(3),
        points: 200,
    };
    const invalidClaims = [
        { ...validClaim, claim_id: '' },
        { ...validClaim, day_no: 8 },
        { ...validClaim, day_no: '2' },
        { ...validClaim, expire_at_ms: undefined },
        { ...validClaim, panel: undefined },
        { ...validClaim, points: Number.POSITIVE_INFINITY },
    ];

    for (const claim of invalidClaims) {
        globalThis.fetch = (async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            return Response.json({ data: path.endsWith('/signin/status') ? checkInPanelPayload(2) : claim });
        }) as typeof fetch;
        await expect(checkInMiniMax({ tokens: { accessToken } }, { realUserId: 'real-user' })).rejects.toThrow(
            'MiniMax check-in response did not include a valid claim result',
        );
    }
});

it('reuses a resolved MiniMax identity for limits and skips account identity lookup', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        expect(url.pathname.endsWith('/v1/api/user/info')).toBe(false);
        if (url.pathname.endsWith('/matrix/api/v1/user/get_user_extra_info')) {
            expect(url.searchParams.get('user_id')).toBe('real-user');
            return Response.json({ workspaces: [{ has_token_plan: false, selected: true }] });
        }
        if (url.pathname.endsWith('/matrix/api/v1/commerce/get_membership_info')) {
            return Response.json({ op_credit_summary: { total_remaining_amount: 10 } });
        }
        return new Response('', { status: 500 });
    }) as typeof fetch;

    expect(await fetchMiniMaxLimits({ tokens: { accessToken } }, { realUserId: 'real-user' })).toMatchObject({
        ok: true,
    });
    expect(calls).toHaveLength(2);
});

it('falls back once from a stale supplied MiniMax identity while fetching limits', async () => {
    const calls = { identity: 0, state: 0 };
    const resolved: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/v1/api/user/info')) {
            calls.identity += 1;
            return Response.json({ data: { userInfo: { realUserID: 'fresh-real-user' } } });
        }
        if (url.pathname.endsWith('/matrix/api/v1/user/get_user_extra_info')) {
            calls.state += 1;
            return url.searchParams.get('user_id') === 'stale-real-user'
                ? new Response('', { status: 400 })
                : Response.json({ workspaces: [{ has_token_plan: false, selected: true }] });
        }
        if (url.pathname.endsWith('/matrix/api/v1/commerce/get_membership_info')) {
            return Response.json({ op_credit_summary: { total_remaining_amount: 10 } });
        }
        return new Response('', { status: 500 });
    }) as typeof fetch;

    const result = await fetchMiniMaxLimits(
        { tokens: { accessToken } },
        {
            onRealUserIdResolved: (realUserId) => {
                resolved.push(realUserId);
            },
            realUserId: 'stale-real-user',
        },
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual({ identity: 1, state: 2 });
    expect(resolved).toEqual(['fresh-real-user']);
});

it('retries MiniMax limits after an account-state base response rejection', async () => {
    const calls = { identity: 0, state: 0 };
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/v1/api/user/info')) {
            calls.identity += 1;
            return Response.json({ data: { userInfo: { realUserID: 'fresh-real-user' } } });
        }
        if (url.pathname.endsWith('/matrix/api/v1/user/get_user_extra_info')) {
            calls.state += 1;
            return url.searchParams.get('user_id') === 'stale-real-user'
                ? Response.json({ base_resp: { status_code: 1001, status_msg: 'stale identity' } })
                : Response.json({ workspaces: [{ has_token_plan: false, selected: true }] });
        }
        if (url.pathname.endsWith('/matrix/api/v1/commerce/get_membership_info')) {
            return Response.json({ op_credit_summary: { total_remaining_amount: 10 } });
        }
        return new Response('', { status: 500 });
    }) as typeof fetch;

    const result = await fetchMiniMaxLimits({ tokens: { accessToken } }, { realUserId: 'stale-real-user' });

    expect(result.ok).toBe(true);
    expect(calls).toEqual({ identity: 1, state: 2 });
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
            return Response.json({ data: checkInPanelPayload(3) });
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
            return Response.json({ data: checkInPanelPayload(2) });
        }
        if (path.endsWith('/signin/claim')) {
            return Response.json({
                data: {
                    claim_id: 'claim-id',
                    claim_result: 2,
                    day_no: 2,
                    expire_at_ms: 1_800_086_400_000,
                    panel: checkInPanelPayload(3),
                    points: 200,
                },
            });
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
            return Response.json({ data: checkInPanelPayload(2) });
        }
        if (path.endsWith('/signin/claim')) {
            calls.claim += 1;
            return Response.json({
                data: {
                    claim_id: 'claim-id',
                    claim_result: 1,
                    day_no: 2,
                    expire_at_ms: 1_800_086_400_000,
                    panel: checkInPanelPayload(3),
                    points: 200,
                },
            });
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
