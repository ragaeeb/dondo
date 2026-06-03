import { afterEach, expect, it } from 'bun:test';
import { decodeToken, fetchLimits } from './google.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

it('should decode go-keyring base64 token payloads', () => {
    const payload = { auth_method: 'oauth-personal', token: { access_token: 'access', refresh_token: 'refresh' } };
    const encoded = `go-keyring-base64:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;

    expect(decodeToken(encoded)).toEqual(payload);
});

it('should return null for invalid token payloads', () => {
    expect(decodeToken('not base64 json')).toBeNull();
});

it('should fetch Antigravity limits without refreshing OAuth tokens', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        calls.push(target);
        if (target.includes('loadCodeAssist')) {
            return Response.json({
                cloudaicompanionProject: 'project',
                paidTier: { name: 'plus' },
            });
        }
        return Response.json({
            models: {
                'future-model': {
                    displayName: 'Future Model',
                    quotaInfo: { remainingFraction: 0.42, resetTime: '2027-01-15T08:00:00.000Z' },
                },
            },
        });
    }) as typeof fetch;
    const payload = {
        auth_method: 'oauth-personal',
        token: {
            access_token: 'access',
            expiry: '2000-01-01T00:00:00.000Z',
            refresh_token: 'refresh',
        },
    };
    const password = `go-keyring-base64:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;

    const result = await fetchLimits({
        account: 'antigravity',
        createdAt: '',
        kind: 'Generic Password',
        label: 'gemini',
        password,
        service: 'gemini',
        updatedAt: '',
    });

    expect(result.quota.ok).toBe(true);
    expect(calls.some((call) => call.includes('/token'))).toBe(false);
});

it('should surface Antigravity usage 401 without using the refresh token', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        calls.push(target);
        return new Response('', { status: 401, statusText: 'Unauthorized' });
    }) as typeof fetch;
    const payload = {
        auth_method: 'oauth-personal',
        token: {
            access_token: 'access',
            refresh_token: 'refresh',
        },
    };
    const password = `go-keyring-base64:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;

    await expect(
        fetchLimits({
            account: 'antigravity',
            createdAt: '',
            kind: 'Generic Password',
            label: 'gemini',
            password,
            service: 'gemini',
            updatedAt: '',
        }),
    ).rejects.toThrow('HTTP 401');

    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.includes('/token'))).toBe(false);
});
