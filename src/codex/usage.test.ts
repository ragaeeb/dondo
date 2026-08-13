import { afterEach, expect, it } from 'bun:test';
import { codexAuthIdentity, parseCodexAuth } from './auth.ts';
import { fetchCodexLimits, usageToLimitResult } from './usage.ts';

const jwt = (payload: object) =>
    ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

it('should map Codex usage windows into limit cards without null entries', () => {
    const result = usageToLimitResult({
        credits: { balance: '0', has_credits: false, unlimited: false },
        plan_type: 'plus',
        rate_limit: {
            primary_window: { limit_window_seconds: 18_000, reset_at: 1_800_000_000, used_percent: 10.2 },
            secondary_window: null,
        },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
        return;
    }
    expect(result.tier).toBe('plus');
    expect(Object.keys(result.models)).toEqual(['codex-primary', 'codex-credits']);
    expect(result.models['codex-primary']).toEqual({
        displayName: '5h Limit (5h)',
        percentage: 90,
        resetTime: '2027-01-15T08:00:00.000Z',
    });
    expect(result.models['codex-credits']?.percentage).toBe(0);
});

it('should not render a zero-minute usage window suffix', () => {
    const result = usageToLimitResult({
        rate_limit: {
            primary_window: { limit_window_seconds: 0, reset_at: null, used_percent: 20 },
        },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
        return;
    }
    expect(result.models['codex-primary']?.displayName).toBe('Primary Limit');
});

it('should ignore hostile Codex usage field types', () => {
    const result = usageToLimitResult({
        credits: { balance: { secret: true }, has_credits: 'yes', unlimited: 1 },
        plan_type: { name: 'plus' },
        rate_limit: {
            primary_window: { limit_window_seconds: '18000', reset_at: {}, used_percent: 25 },
            secondary_window: { used_percent: '50' },
        },
    });

    expect(result).toEqual({
        expires: '',
        models: {
            'codex-primary': {
                displayName: 'Primary Limit',
                percentage: 75,
                resetTime: '',
            },
        },
        ok: true,
        tier: '',
    });
});

it('should reject Codex usage without validated quota fields', () => {
    expect(usageToLimitResult({})).toEqual({ error: 'Codex usage returned no quota fields', ok: false });
    expect(usageToLimitResult({ rate_limit: { primary_window: { used_percent: '25' } } })).toEqual({
        error: 'Codex usage returned no quota fields',
        ok: false,
    });
});

it('should not refresh Codex OAuth tokens while fetching usage', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        calls.push(target);
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.Authorization).toContain('Bearer ');
        return Response.json({
            plan_type: 'plus',
            rate_limit: {
                primary_window: { limit_window_seconds: 18_000, reset_at: 1_800_000_000, used_percent: 25 },
            },
        });
    }) as unknown as typeof fetch;

    const result = await fetchCodexLimits(
        JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                account_id: 'account',
                id_token: 'id-token',
                refresh_token: 'refresh',
            },
        }),
    );

    expect(result.quota.ok).toBe(true);
    expect(calls.filter((call) => call.includes('/wham/usage'))).toHaveLength(1);
    expect(calls.some((call) => call.includes('/oauth/token'))).toBe(false);
});

it('should use ChatGPT usage when a ChatGPT auth also contains a stale API key', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
        requests += 1;
        return Response.json({ rate_limit: { primary_window: { used_percent: 25 } } });
    }) as unknown as typeof fetch;

    const result = await fetchCodexLimits(
        JSON.stringify({
            auth_mode: 'chatgpt',
            OPENAI_API_KEY: 'stale-api-key',
            tokens: {
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                account_id: 'account',
                id_token: 'id-token',
                refresh_token: 'refresh',
            },
        }),
    );

    expect(result.quota.ok).toBe(true);
    expect(requests).toBe(1);
});

it('should accept current ChatGPT token data when account_id is omitted', async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.['chatgpt-account-id']).toBeUndefined();
        return Response.json({ rate_limit: { primary_window: { used_percent: 25 } } });
    }) as typeof fetch;

    const result = await fetchCodexLimits(
        JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                id_token: 'id-token',
                refresh_token: 'refresh',
            },
        }),
    );

    expect(result.quota.ok).toBe(true);
});

it('should keep Codex identity stable across token rotation when account_id is omitted', () => {
    const idToken = (expires: number, signature: string) =>
        [
            'header',
            Buffer.from(
                JSON.stringify({
                    exp: expires,
                    'https://api.openai.com/auth': { chatgpt_account_id: 'stable-account' },
                }),
            ).toString('base64url'),
            signature,
        ].join('.');
    const auth = (expires: number, suffix: string) =>
        parseCodexAuth(
            JSON.stringify({
                auth_mode: 'chatgpt',
                tokens: {
                    access_token: `access-${suffix}`,
                    id_token: idToken(expires, suffix),
                    refresh_token: `refresh-${suffix}`,
                },
            }),
        );

    expect(codexAuthIdentity(auth(100, 'old'))).toBe('stable-account');
    expect(codexAuthIdentity(auth(200, 'new'))).toBe('stable-account');
});

it('should ignore hostile non-UTF-8 Codex JWT claims', () => {
    const hostile = `header.${Buffer.from([0xc3, 0x28]).toString('base64url')}.signature`;
    const auth = parseCodexAuth(
        JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: hostile, id_token: hostile, refresh_token: 'refresh' },
        }),
    );

    expect(codexAuthIdentity(auth)).toBe(hostile);
});

it('should accept null for current optional Codex auth fields', async () => {
    globalThis.fetch = (async () =>
        Response.json({ rate_limit: { primary_window: { used_percent: 25 } } })) as unknown as typeof fetch;

    const result = await fetchCodexLimits(
        JSON.stringify({
            auth_mode: 'chatgpt',
            last_refresh: null,
            tokens: {
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                account_id: null,
                id_token: 'id-token',
                refresh_token: 'refresh',
            },
        }),
    );

    expect(result.quota.ok).toBe(true);
    await expect(
        fetchCodexLimits(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'key', tokens: null })),
    ).resolves.toMatchObject({ quota: { ok: false } });
});

it('should accept only the current apikey auth mode spelling', async () => {
    await expect(fetchCodexLimits(JSON.stringify({ auth_mode: 'api_key', OPENAI_API_KEY: 'key' }))).rejects.toThrow(
        'invalid or incomplete',
    );
    await expect(fetchCodexLimits(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'key' }))).resolves.toEqual({
        quota: { error: 'Codex usage is only available for ChatGPT login accounts', ok: false },
    });
});

it('should reject incomplete Codex auth structures before network access', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
        requests += 1;
        return Response.json({});
    }) as unknown as typeof fetch;

    await expect(fetchCodexLimits('{')).rejects.toThrow('invalid or incomplete');
    await expect(
        fetchCodexLimits(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'access' } })),
    ).rejects.toThrow('invalid or incomplete');
    await expect(
        fetchCodexLimits(
            JSON.stringify({
                auth_mode: 'chatgpt',
                OPENAI_API_KEY: 123,
                tokens: {
                    access_token: 'access',
                    account_id: 'account',
                    id_token: 'id',
                    refresh_token: 'refresh',
                },
            }),
        ),
    ).rejects.toThrow('invalid or incomplete');
    expect(requests).toBe(0);
});

it('should surface Codex usage 401 without using the refresh token', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        calls.push(target);
        return new Response('', { status: 401 });
    }) as typeof fetch;

    const result = await fetchCodexLimits(
        JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                account_id: 'account',
                id_token: 'id-token',
                refresh_token: 'refresh',
            },
        }),
    );

    expect(result.quota).toEqual({
        error: 'Saved Codex access token is expired or rejected. Use this account in Codex, then click Sync current on this saved row.',
        ok: false,
    });
    expect(calls.filter((call) => call.includes('/wham/usage'))).toHaveLength(1);
    expect(calls.some((call) => call.includes('/oauth/token'))).toBe(false);
});

it('should not call Codex usage when the saved access token is expired', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
        calls.push(String(url));
        return Response.json({});
    }) as typeof fetch;

    const result = await fetchCodexLimits(
        JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
                access_token: jwt({ exp: 1 }),
                account_id: 'account',
                id_token: 'id-token',
                refresh_token: 'refresh',
            },
        }),
    );

    expect(result.quota.ok).toBe(false);
    expect(calls).toHaveLength(0);
});
