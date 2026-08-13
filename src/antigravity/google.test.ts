import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeToken, fetchLimits, resolveGoogleIdentity } from './google.ts';
import {
    clearGoogleOAuthClientCache,
    extractGoogleOAuthClient,
    extractGoogleOAuthClients,
    googleOAuthClients,
    scanGoogleOAuthClients,
} from './oauth.ts';

const originalFetch = globalThis.fetch;
const originalLanguageServerPath = process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH;
const testClientSecret = `${'GO'}${'CSPX'}-1234567890123456789012345678`;

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLanguageServerPath === undefined) {
        delete process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH;
    } else {
        process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH = originalLanguageServerPath;
    }
    clearGoogleOAuthClientCache();
});

it('should decode go-keyring base64 token payloads', () => {
    const payload = { auth_method: 'oauth-personal', token: { access_token: 'access', refresh_token: 'refresh' } };
    const encoded = `go-keyring-base64:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;

    expect(decodeToken(encoded)).toEqual(payload);
});

it('should return null for invalid token payloads', () => {
    expect(decodeToken('not base64 json')).toBeNull();
    for (const value of [
        null,
        false,
        1,
        'text',
        [],
        {},
        { token: [] },
        { token: {} },
        { token: { access_token: 1 } },
    ]) {
        expect(decodeToken(Buffer.from(JSON.stringify(value)).toString('base64'))).toBeNull();
    }
    const canonical = Buffer.from(JSON.stringify({ token: { access_token: 'access' } })).toString('base64');
    expect(decodeToken(`${canonical.slice(0, -1)}A`)).toBeNull();
    expect(decodeToken(Buffer.from([0xc3, 0x28]).toString('base64'))).toBeNull();
});

it('should resolve a stable Google subject without exposing the access token', async () => {
    let receivedToken = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        receivedToken = url.searchParams.get('access_token') ?? '';
        return Response.json({ sub: 'stable-google-user' });
    }) as typeof fetch;
    const password = Buffer.from(
        JSON.stringify({ token: { access_token: 'rotated-access', expiry: '2999-01-01T00:00:00.000Z' } }),
    ).toString('base64');

    const result = await resolveGoogleIdentity({
        account: 'antigravity',
        createdAt: '',
        kind: 'Generic Password',
        label: 'gemini',
        password,
        service: 'gemini',
        updatedAt: '',
    });

    expect(result).toEqual({ identity: 'stable-google-user' });
    expect(receivedToken).toBe('rotated-access');
});

it('should reject an incomplete Google account identity', async () => {
    globalThis.fetch = (async () => Response.json({ email: 'account@example.com' })) as unknown as typeof fetch;
    const password = Buffer.from(
        JSON.stringify({ token: { access_token: 'access', expiry: '2999-01-01T00:00:00.000Z' } }),
    ).toString('base64');

    await expect(
        resolveGoogleIdentity({
            account: 'antigravity',
            createdAt: '',
            kind: 'Generic Password',
            label: 'gemini',
            password,
            service: 'gemini',
            updatedAt: '',
        }),
    ).rejects.toThrow('incomplete account identity');
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

it('should stream OAuth discovery across binary chunk boundaries', async () => {
    const clientId = '100000000000-streamed.apps.googleusercontent.com';
    const content = `prefix ${testClientSecret} middle ${clientId} suffix`;
    const chunks = [
        content.slice(0, 13),
        content.slice(13, 38),
        content.slice(38, 57),
        content.slice(57, 79),
        content.slice(79),
    ];
    const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
            for (const chunk of chunks) {
                controller.enqueue(Buffer.from(chunk, 'latin1'));
            }
            controller.close();
        },
    });

    expect(await scanGoogleOAuthClients(stream)).toContainEqual({ clientId, clientSecret: testClientSecret });
});

it('should cancel OAuth binary discovery at its scan byte ceiling', async () => {
    let cancelled = false;
    const clientId = '100000000000-beyond-cap.apps.googleusercontent.com';
    const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
            cancelled = true;
        },
        start: (controller) => {
            controller.enqueue(Buffer.from('1234'));
            controller.enqueue(Buffer.from(`${testClientSecret}\0${clientId}`));
        },
    });

    expect(await scanGoogleOAuthClients(stream, 5)).toEqual([]);
    expect(cancelled).toBe(true);
});

it('should share an in-flight OAuth binary scan across concurrent callers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-antigravity-oauth-cache-test-'));
    const path = join(dir, 'language_server');
    const originalBunFile = Bun.file;
    let streamCount = 0;
    try {
        await Bun.write(path, `${testClientSecret}\0${'100000000000-cache.apps.googleusercontent.com'}`);
        process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH = path;
        Bun.file = ((input: Parameters<typeof Bun.file>[0], options?: Parameters<typeof Bun.file>[1]) => {
            const file = options === undefined ? originalBunFile(input) : originalBunFile(input, options);
            if (String(input) !== path) {
                return file;
            }
            return new Proxy(file, {
                get: (target, property) => {
                    if (property === 'stream') {
                        return () => {
                            streamCount += 1;
                            return target.stream();
                        };
                    }
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        }) as typeof Bun.file;
        clearGoogleOAuthClientCache();

        const [first, second, third] = await Promise.all([
            googleOAuthClients(),
            googleOAuthClients(),
            googleOAuthClients(),
        ]);

        expect(first).toEqual(second);
        expect(second).toEqual(third);
        expect(streamCount).toBe(1);
    } finally {
        Bun.file = originalBunFile;
        await rm(dir, { force: true, recursive: true });
    }
});

it('should cache empty OAuth discovery until explicitly cleared', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-antigravity-oauth-empty-cache-test-'));
    const path = join(dir, 'language_server');
    const missingPath = join(dir, 'missing');
    const originalBunFile = Bun.file;
    let streamCount = 0;
    try {
        await Bun.write(path, 'no credentials');
        process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH = path;
        Bun.file = ((input: Parameters<typeof Bun.file>[0], options?: Parameters<typeof Bun.file>[1]) => {
            const selected =
                String(input) === path ? input : (missingPath as unknown as Parameters<typeof Bun.file>[0]);
            const file = options === undefined ? originalBunFile(selected) : originalBunFile(selected, options);
            if (String(input) !== path) {
                return file;
            }
            return new Proxy(file, {
                get: (target, property) => {
                    if (property === 'stream') {
                        return () => {
                            streamCount += 1;
                            return target.stream();
                        };
                    }
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        }) as typeof Bun.file;
        clearGoogleOAuthClientCache();
        expect(await googleOAuthClients()).toEqual([]);

        await Bun.write(path, `${testClientSecret}\0${'100000000000-retry.apps.googleusercontent.com'}`);
        expect(await googleOAuthClients()).toEqual([]);
        expect(streamCount).toBe(1);

        clearGoogleOAuthClientCache();
        expect(await googleOAuthClients()).toContainEqual({
            clientId: '100000000000-retry.apps.googleusercontent.com',
            clientSecret: testClientSecret,
        });
        expect(streamCount).toBe(2);
    } finally {
        Bun.file = originalBunFile;
        await rm(dir, { force: true, recursive: true });
    }
});

it('should retry OAuth discovery after a rejected scan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-antigravity-oauth-rejected-cache-test-'));
    const path = join(dir, 'language_server');
    const missingPath = join(dir, 'missing');
    const originalBunFile = Bun.file;
    let rejectScan = true;
    try {
        await Bun.write(path, `${testClientSecret}\0${'100000000000-retry.apps.googleusercontent.com'}`);
        process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH = path;
        Bun.file = ((input: Parameters<typeof Bun.file>[0], options?: Parameters<typeof Bun.file>[1]) => {
            const selected =
                String(input) === path ? input : (missingPath as unknown as Parameters<typeof Bun.file>[0]);
            const file = options === undefined ? originalBunFile(selected) : originalBunFile(selected, options);
            if (String(input) !== path || !rejectScan) {
                return file;
            }
            return new Proxy(file, {
                get: (target, property) => {
                    if (property === 'stream') {
                        return () =>
                            new ReadableStream<Uint8Array>({
                                pull: () => {
                                    throw new Error('scan failed');
                                },
                            });
                    }
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        }) as typeof Bun.file;
        clearGoogleOAuthClientCache();
        await expect(googleOAuthClients()).rejects.toThrow('scan failed');
        rejectScan = false;
        expect(await googleOAuthClients()).toHaveLength(1);
    } finally {
        Bun.file = originalBunFile;
        await rm(dir, { force: true, recursive: true });
    }
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

it('should clamp finite Antigravity quota fractions and omit non-finite values', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes('loadCodeAssist')) {
            return Response.json({ cloudaicompanionProject: 'project' });
        }
        return Response.json({
            models: {
                above: { displayName: 'Above', quotaInfo: { remainingFraction: 2 } },
                below: { displayName: 'Below', quotaInfo: { remainingFraction: -1 } },
                invalid: { displayName: 'Invalid', quotaInfo: { remainingFraction: Number.POSITIVE_INFINITY } },
            },
        });
    }) as typeof fetch;
    const payload = { token: { access_token: 'access', expiry: '2999-01-01T00:00:00.000Z' } };
    const result = await fetchLimits({
        account: 'antigravity',
        createdAt: '',
        kind: 'Generic Password',
        label: 'gemini',
        password: Buffer.from(JSON.stringify(payload)).toString('base64'),
        service: 'gemini',
        updatedAt: '',
    });

    expect(result.quota.ok).toBe(true);
    if (result.quota.ok) {
        expect(result.quota.models.above?.percentage).toBe(100);
        expect(result.quota.models.below?.percentage).toBe(0);
        expect(result.quota.models.invalid).toBeUndefined();
    }
});

it('should reject Antigravity quota responses without validated models', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
        return String(url).includes('loadCodeAssist')
            ? Response.json({ cloudaicompanionProject: 'project' })
            : Response.json({ models: { hostile: { quotaInfo: { remainingFraction: 'all' } } } });
    }) as typeof fetch;
    const password = Buffer.from(
        JSON.stringify({ token: { access_token: 'access', expiry: '2999-01-01T00:00:00.000Z' } }),
    ).toString('base64');

    const result = await fetchLimits({
        account: 'antigravity',
        createdAt: '',
        kind: 'Generic Password',
        label: 'gemini',
        password,
        service: 'gemini',
        updatedAt: '',
    });

    expect(result.quota).toEqual({ error: 'Antigravity quota returned no quota fields', ok: false });
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
            const headers = init?.headers as Record<string, string> | undefined;
            expect(headers?.Authorization).toBe('Bearer new-access');
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

it('should reject malformed Antigravity token refresh fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-antigravity-oauth-invalid-response-test-'));
    process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH = join(dir, 'language_server');
    await Bun.write(
        process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH,
        [`secret ${testClientSecret}`, 'client 100000000000-test.apps.googleusercontent.com'].join('\0'),
    );
    globalThis.fetch = (async (url: string | URL | Request) => {
        return String(url).includes('/token')
            ? Response.json({ access_token: { secret: true }, expires_in: '3600' })
            : Response.json({});
    }) as typeof fetch;
    const payload = {
        token: { access_token: 'expired', expiry: '2000-01-01T00:00:00.000Z', refresh_token: 'refresh' },
    };

    try {
        await expect(
            fetchLimits({
                account: 'antigravity',
                createdAt: '',
                kind: 'Generic Password',
                label: 'gemini',
                password: Buffer.from(JSON.stringify(payload)).toString('base64'),
                service: 'gemini',
                updatedAt: '',
            }),
        ).rejects.toThrow('response was incomplete');
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

it('should not expose hostile Antigravity upstream error messages', async () => {
    globalThis.fetch = (async () =>
        Response.json(
            { error: { message: 'token=secret-provider-value', status: 'SECRET_PROVIDER_TOKEN_VALUE' } },
            { status: 500 },
        )) as unknown as typeof fetch;
    const password = Buffer.from(
        JSON.stringify({ token: { access_token: 'access', expiry: '2999-01-01T00:00:00.000Z' } }),
    ).toString('base64');

    const error = await fetchLimits({
        account: 'antigravity',
        createdAt: '',
        kind: 'Generic Password',
        label: 'gemini',
        password,
        service: 'gemini',
        updatedAt: '',
    }).catch((value) => String(value));

    expect(error).toContain('HTTP 500');
    expect(error).not.toContain('secret-provider-value');
    expect(error).not.toContain('not-an-allowlisted-status');
});

it('should cap failed Antigravity OAuth refresh attempts and duration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-antigravity-oauth-budget-test-'));
    process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH = join(dir, 'language_server');
    const values = Array.from({ length: 10 }, (_, index) => [
        `${'GO'}${'CSPX'}-${String(index).padStart(28, '0')}`,
        `${100000000000 + index}-client-${index}.apps.googleusercontent.com`,
    ]).flat();
    await Bun.write(process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH, values.join('\0'));
    let attempts = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes('/token')) {
            attempts += 1;
            return new Response('', { status: 400 });
        }
        return Response.json({});
    }) as typeof fetch;
    const payload = {
        token: { access_token: 'expired', expiry: '2000-01-01T00:00:00.000Z', refresh_token: 'refresh' },
    };
    const startedAt = performance.now();
    try {
        await expect(
            fetchLimits({
                account: 'antigravity',
                createdAt: '',
                kind: 'Generic Password',
                label: 'gemini',
                password: Buffer.from(JSON.stringify(payload)).toString('base64'),
                service: 'gemini',
                updatedAt: '',
            }),
        ).rejects.toThrow('Token refresh failed');
        expect(attempts).toBe(8);
        expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
