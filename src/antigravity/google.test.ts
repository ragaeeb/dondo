import { afterEach, expect, it } from 'bun:test';
import { decodeToken, fetchLimits } from './google.ts';

const originalFetch = globalThis.fetch;
const originalClientId = process.env.GOOGLE_CLIENT_ID;
const originalClientSecret = process.env.GOOGLE_CLIENT_SECRET;

afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GOOGLE_CLIENT_ID = originalClientId;
    process.env.GOOGLE_CLIENT_SECRET = originalClientSecret;
});

it('should decode go-keyring base64 token payloads', () => {
    const payload = { auth_method: 'oauth-personal', token: { access_token: 'access', refresh_token: 'refresh' } };
    const encoded = `go-keyring-base64:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;

    expect(decodeToken(encoded)).toEqual(payload);
});

it('should return null for invalid token payloads', () => {
    expect(decodeToken('not base64 json')).toBeNull();
});

it('should return an updated snapshot password after refreshing an expired token', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        if (target.includes('/token')) {
            return Response.json({ access_token: 'new-access', expires_in: 3600 });
        }
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
            access_token: 'old-access',
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
    expect(decodeToken(result.password ?? '')?.token?.access_token).toBe('new-access');
});
