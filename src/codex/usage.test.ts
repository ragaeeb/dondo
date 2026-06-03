import { afterEach, expect, it } from 'bun:test';
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

it('should not refresh Codex OAuth tokens while fetching usage', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        calls.push(target);
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

    expect(result.quota.ok).toBe(true);
    expect(calls.filter((call) => call.includes('/wham/usage'))).toHaveLength(1);
    expect(calls.some((call) => call.includes('/oauth/token'))).toBe(false);
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
                refresh_token: 'refresh',
            },
        }),
    );

    expect(result.quota.ok).toBe(false);
    expect(calls).toHaveLength(0);
});
