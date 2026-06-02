import { afterEach, expect, it } from 'bun:test';
import { fetchCodexLimits, parseJwtPayload, tokenExpiredOrNearExpiry, usageToLimitResult } from './usage.ts';

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

it('should parse JWT payloads and detect near-expired tokens', () => {
    expect(parseJwtPayload(jwt({ exp: 123, sub: 'user' }))).toEqual({ exp: 123, sub: 'user' });
    expect(tokenExpiredOrNearExpiry(jwt({ exp: Math.floor(Date.now() / 1000) + 30 }))).toBe(true);
    expect(tokenExpiredOrNearExpiry(jwt({ exp: Math.floor(Date.now() / 1000) + 300 }))).toBe(false);
    expect(tokenExpiredOrNearExpiry('')).toBe(true);
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

it('should force refresh Codex tokens after a 401 usage response', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        calls.push(target);
        if (target.includes('/oauth/token')) {
            return Response.json({
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                refresh_token: 'next-refresh',
            });
        }
        if (calls.filter((call) => call.includes('/wham/usage')).length === 1) {
            return new Response('', { status: 401 });
        }
        expect((init?.headers as Record<string, string>).Authorization).toContain('Bearer ');
        return Response.json({
            plan_type: 'plus',
            rate_limit: {
                primary_window: { limit_window_seconds: 18_000, reset_at: 1_800_000_000, used_percent: 25 },
            },
        });
    }) as typeof fetch;

    const result = await fetchCodexLimits(
        JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                account_id: 'account',
                refresh_token: 'refresh',
            },
        }),
    );

    expect(result.auth).toContain('next-refresh');
    expect(result.quota.ok).toBe(true);
    expect(calls.filter((call) => call.includes('/wham/usage'))).toHaveLength(2);
    expect(calls.filter((call) => call.includes('/oauth/token'))).toHaveLength(1);
});
