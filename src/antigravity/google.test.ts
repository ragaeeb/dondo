import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeToken, fetchLimits } from './google.ts';
import { clearGoogleOAuthClientCache, extractGoogleOAuthClient, extractGoogleOAuthClients } from './oauth.ts';

const originalFetch = globalThis.fetch;
const originalLanguageServerPath = process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH;
const testClientSecret = `${'GO'}${'CSPX'}-1234567890123456789012345678`;

afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH = originalLanguageServerPath;
    clearGoogleOAuthClientCache();
});

it('should decode go-keyring base64 token payloads', () => {
    const payload = { auth_method: 'oauth-personal', token: { access_token: 'access', refresh_token: 'refresh' } };
    const encoded = `go-keyring-base64:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;

    expect(decodeToken(encoded)).toEqual(payload);
});

it('should return null for invalid token payloads', () => {
    expect(decodeToken('not base64 json')).toBeNull();
});

it('should extract Antigravity Google OAuth credentials from binary text', () => {
    const client = extractGoogleOAuthClient(
        [
            'first-client 100000000000-first.apps.googleusercontent.com',
            `secret ${testClientSecret}`,
            'second-client 200000000000-second.apps.googleusercontent.com',
        ].join('\0'),
    );

    expect(client).toEqual({
        clientId: '200000000000-second.apps.googleusercontent.com',
        clientSecret: testClientSecret,
    });
});

it('should return discovered OAuth candidates in retry order', () => {
    const clients = extractGoogleOAuthClients(
        [
            `older-secret ${'GO'}${'CSPX'}-1111111111111111111111111111`,
            'older-client 100000000000-older.apps.googleusercontent.com',
            `newer-secret ${'GO'}${'CSPX'}-2222222222222222222222222222`,
            'newer-client 200000000000-newer.apps.googleusercontent.com',
        ].join('\0'),
    );

    expect(clients.slice(0, 2)).toEqual([
        {
            clientId: '200000000000-newer.apps.googleusercontent.com',
            clientSecret: `${'GO'}${'CSPX'}-2222222222222222222222222222`,
        },
        {
            clientId: '200000000000-newer.apps.googleusercontent.com',
            clientSecret: `${'GO'}${'CSPX'}-1111111111111111111111111111`,
        },
    ]);
});

it('should fetch Antigravity limits without refreshing usable OAuth tokens', async () => {
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
            expiry: '2999-01-01T00:00:00.000Z',
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

it('should refresh expired Antigravity access tokens and return an updated snapshot password', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-antigravity-oauth-test-'));
    process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH = join(dir, 'language_server');
    await Bun.write(
        process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH,
        [`secret ${testClientSecret}`, 'client 100000000000-test.apps.googleusercontent.com'].join('\0'),
    );
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        calls.push(target);
        if (target.includes('/token')) {
            return Response.json({ access_token: 'new-access', expires_in: 3600 });
        }
        if (target.includes('loadCodeAssist')) {
            expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer new-access');
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

    try {
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
        expect(calls.filter((call) => call.includes('/token'))).toHaveLength(1);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should force refresh Antigravity tokens after a 401 project response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-antigravity-oauth-test-'));
    process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH = join(dir, 'language_server');
    await Bun.write(
        process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH,
        [`secret ${testClientSecret}`, 'client 100000000000-test.apps.googleusercontent.com'].join('\0'),
    );
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        calls.push(target);
        if (target.includes('/token')) {
            return Response.json({ access_token: 'new-access', expires_in: 3600 });
        }
        if (target.includes('loadCodeAssist') && calls.filter((call) => call.includes('loadCodeAssist')).length === 1) {
            return new Response('', { status: 401, statusText: 'Unauthorized' });
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
            access_token: 'access',
            expiry: '2999-01-01T00:00:00.000Z',
            refresh_token: 'refresh',
        },
    };
    const password = `go-keyring-base64:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;

    try {
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
        expect(calls.filter((call) => call.includes('loadCodeAssist'))).toHaveLength(2);
        expect(calls.filter((call) => call.includes('/token'))).toHaveLength(1);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
