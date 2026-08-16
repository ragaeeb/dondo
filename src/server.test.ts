import { expect, it } from 'bun:test';
import { createServer } from 'node:net';
import { DEV_MODE, KEYCHAIN_PROVIDER } from './config.ts';
import { publicError } from './errors.ts';
import {
    API_RATE_LIMIT_MAX,
    createFetch,
    MAX_EXPORT_PAYLOAD_BYTES,
    MAX_JSON_BODY_BYTES,
    serveOnAvailablePort,
    startupDiagnostics,
} from './server.ts';

const assets = {
    appJs: 'console.log("ok");',
    css: 'body{}',
    iconPng: Bun.file(new URL('../icon.png', import.meta.url).pathname),
    iconSvg: '<svg />',
};
const app = createFetch(assets);

const json = async (response: Response) => (await response.json()) as { error?: string };

const occupyPort = async (port: number) =>
    new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });

const closeServer = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
};

const serverPort = (server: ReturnType<typeof createServer>) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Server does not have a TCP port');
    }
    return address.port;
};

const occupyAvailablePortBelowMax = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const blocker = await occupyPort(0);
        if (serverPort(blocker) < 65_535) {
            return blocker;
        }
        await closeServer(blocker);
    }
    throw new Error('Could not allocate a test port below 65535');
};

it('should apply security headers to the UI shell', async () => {
    const response = await app(new Request('http://127.0.0.1:3000/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("worker-src 'none'");
});

it('should serve the UI shell for direct platform routes', async () => {
    for (const platform of ['antigravity', 'codex', 'kiro', 'minimax', 'cline']) {
        const response = await app(new Request(`http://127.0.0.1:3000/${platform}`));

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/html');
        expect(await response.text()).toContain('<title>Dondo</title>');
    }
});

it('should reject non-local API origins', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/codex/state', {
            headers: { Origin: 'https://example.com' },
        }),
    );

    expect(response.status).toBe(403);
});

it('should expose a non-cacheable local API version contract', async () => {
    const response = await app(new Request('http://127.0.0.1:3000/api/version'));
    const payload = (await response.json()) as { apiVersion?: unknown; appVersion?: unknown };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(payload).toEqual({ apiVersion: 1, appVersion: expect.any(String) });
});

it('should expose only home-contracted safe startup diagnostics', () => {
    const diagnostics = startupDiagnostics(4321);
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.url).toBe('http://127.0.0.1:4321');
    expect(diagnostics.platform).toBe(process.platform);
    expect(diagnostics.mode).toBe(DEV_MODE);
    expect(diagnostics.keychain).toBe(KEYCHAIN_PROVIDER);
    expect(diagnostics.dataDir).toMatch(/^~\//u);
    expect(diagnostics.vault).toMatch(/^~\//u);
    if (process.env.HOME) {
        expect(serialized).not.toContain(process.env.HOME);
    }
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
});

it('should reject a local origin on a different port', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/codex/state', {
            headers: { Origin: 'http://127.0.0.1:3001' },
        }),
    );

    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'Request origin must exactly match the local server origin' });
});

it('should reject a mismatched local Host header', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/codex/state', {
            headers: { Host: '127.0.0.1:3001' },
        }),
    );

    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'Only localhost requests are allowed' });
});

it('should export plaintext credentials only through confirmed local POST requests', async () => {
    const exportApp = createFetch(assets, {
        exportWallet: async (platform) => ({
            accounts: [{ config: { access_token: 'access-test' }, key: 'work' }],
            exportedAt: '2026-01-01T00:00:00.000Z',
            platform,
        }),
    });
    const response = await exportApp(
        new Request('http://127.0.0.1:3000/api/antigravity/export', {
            headers: { 'X-Dondo-Export': '1' },
            method: 'POST',
        }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(await response.clone().text())));
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('content-disposition')).toMatch(
        /^attachment; filename="dondo-antigravity-wallet-[A-Za-z0-9-]+\.json"$/,
    );
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await response.json()).toEqual({
        accounts: [{ config: { access_token: 'access-test' }, key: 'work' }],
        exportedAt: '2026-01-01T00:00:00.000Z',
        platform: 'antigravity',
    });
});

it('should reject linkable GET requests to export routes', async () => {
    const response = await app(new Request('http://127.0.0.1:3000/api/codex/export'));

    expect(response.status).toBe(405);
    expect(await json(response)).toEqual({ error: 'Method not allowed' });
});

it('should require the export confirmation header', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/codex/export', {
            method: 'POST',
        }),
    );

    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'Export confirmation is required' });
});

it('should reject foreign origins before exporting credentials', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/codex/export', {
            headers: { Origin: 'https://example.com', 'X-Dondo-Export': '1' },
            method: 'POST',
        }),
    );

    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'Request origin must exactly match the local server origin' });
});

it('should preserve empty-export status without exposing credential-shaped errors', async () => {
    const exportApp = createFetch(assets, {
        exportWallet: async () => {
            throw publicError(404, 'No Codex accounts are saved to export; Bearer ya29.secret');
        },
    });
    const response = await exportApp(
        new Request('http://127.0.0.1:3000/api/codex/export', {
            headers: { 'X-Dondo-Export': '1' },
            method: 'POST',
        }),
    );
    const responseText = await response.text();

    expect(response.status).toBe(404);
    expect(responseText).toContain('No Codex accounts are saved to export');
    expect(responseText).not.toContain('ya29.secret');
});

it('should replace unexpected internal errors instead of exposing their contents', async () => {
    const exportApp = createFetch(assets, {
        exportWallet: async () => {
            throw new Error('Could not read /private/path containing Bearer ya29.secret');
        },
    });
    const response = await exportApp(
        new Request('http://127.0.0.1:3000/api/codex/export', {
            headers: { 'X-Dondo-Export': '1' },
            method: 'POST',
        }),
    );

    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ error: 'Internal server error' });
});

it('should reject unsupported API methods before reading a body', async () => {
    const response = await app(new Request('http://127.0.0.1:3000/api/antigravity/save'));

    expect(response.status).toBe(405);
    expect(await json(response)).toEqual({ error: 'Method not allowed' });
});

it('should expose MiniMax check-in-all only as an empty-body POST action', async () => {
    const getResponse = await app(new Request('http://127.0.0.1:3000/api/minimax/check-in-all'));
    expect(getResponse.status).toBe(405);

    const keyedResponse = await app(
        new Request('http://127.0.0.1:3000/api/minimax/check-in-all', {
            body: '{"key":"private-label"}',
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        }),
    );
    expect(keyedResponse.status).toBe(400);
    expect(await json(keyedResponse)).toEqual({ error: 'JSON body must be empty' });
});

it('should reject malformed JSON bodies before service calls', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/save', {
            body: '{',
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Invalid JSON body' });
});

it('should reject invalid UTF-8 request bodies', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/save', {
            body: new Uint8Array([0x7b, 0x22, 0x6b, 0x65, 0x79, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'JSON request body must be valid UTF-8' });
});

it('should require a JSON content type before parsing request bodies', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/save', {
            body: '{}',
            method: 'POST',
        }),
    );

    expect(response.status).toBe(415);
    expect(await json(response)).toEqual({ error: 'JSON requests require Content-Type: application/json' });
});

it('should reject unexpected JSON fields and require JSON for empty mutations', async () => {
    const unexpected = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/save', {
            body: JSON.stringify({ key: 'work', token: 'not-accepted' }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        }),
    );
    const clearWithoutJson = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/clear', {
            method: 'POST',
        }),
    );
    const clearWithoutBody = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/clear', {
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        }),
    );
    const clearWithFields = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/clear', {
            body: JSON.stringify({ key: 'work' }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        }),
    );

    expect(unexpected.status).toBe(400);
    expect(await json(unexpected)).toEqual({ error: 'JSON body has unexpected fields' });
    expect(clearWithoutJson.status).toBe(415);
    expect(await json(clearWithoutJson)).toEqual({ error: 'JSON requests require Content-Type: application/json' });
    expect(clearWithoutBody.status).toBe(400);
    expect(await json(clearWithoutBody)).toEqual({ error: 'JSON body must be an object' });
    expect(clearWithFields.status).toBe(400);
    expect(await json(clearWithFields)).toEqual({ error: 'JSON body must be empty' });
});

it('should reject oversized JSON bodies without echoing their contents', async () => {
    const secret = `Bearer ${'x'.repeat(MAX_JSON_BODY_BYTES)}`;
    const response = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/save', {
            body: JSON.stringify({ key: secret }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        }),
    );
    const text = await response.text();

    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain(secret);
});

it('should cancel oversized streamed JSON bodies and release their reader lock', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
            cancelled = true;
        },
        start: (controller) => {
            controller.enqueue(new Uint8Array(MAX_JSON_BODY_BYTES + 1));
        },
    });
    const request = new Request('http://127.0.0.1:3000/api/antigravity/save', {
        body: stream,
        ...({ duplex: 'half' } as { duplex: 'half' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const response = await app(request);

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
});

it('should not expose token-shaped fields in API error responses', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/load', {
            body: JSON.stringify({ key: 'Bearer ya29.secret' }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        }),
    );
    const text = await response.text();

    expect(text).not.toContain('ya29.secret');
    expect(text).not.toContain('access_token');
    expect(text).not.toContain('refresh_token');
});

it('should reject oversized export payloads with a redacted error', async () => {
    const secret = `Bearer ${'x'.repeat(MAX_EXPORT_PAYLOAD_BYTES)}`;
    const exportApp = createFetch(assets, {
        exportWallet: async () => ({
            accounts: [{ config: { access_token: secret }, key: 'oversized' }],
            exportedAt: '',
            platform: 'codex',
        }),
    });
    const response = await exportApp(
        new Request('http://127.0.0.1:3000/api/codex/export', {
            headers: { 'X-Dondo-Export': '1' },
            method: 'POST',
        }),
    );
    const text = await response.text();

    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain(secret);
    expect(text).toContain('Export payload exceeds the 8 MiB size limit');
});

it('should stream large multi-account exports in bounded chunks', async () => {
    let iteratorCalls = 0;
    let generatedAccounts = 0;
    const accounts = {
        [Symbol.iterator]: () => {
            iteratorCalls += 1;
            let index = 0;
            return {
                next: () => {
                    if (index >= 2_000) {
                        return { done: true as const, value: undefined };
                    }
                    const account = {
                        config: { access_token: `token-${index}-${'x'.repeat(256)}` },
                        key: `account-${index}`,
                    };
                    index += 1;
                    generatedAccounts += 1;
                    return { done: false as const, value: account };
                },
            };
        },
    };
    const exportApp = createFetch(assets, {
        exportWallet: async (platform) => ({
            accounts,
            exportedAt: '2026-01-01T00:00:00.000Z',
            platform,
        }),
    });
    const response = await exportApp(
        new Request('http://127.0.0.1:3000/api/codex/export', {
            headers: { 'X-Dondo-Export': '1' },
            method: 'POST',
        }),
    );
    const reader = response.body?.getReader();
    let chunks = 0;
    let bytes = 0;
    for (;;) {
        const next = await reader?.read();
        if (!next || next.done) {
            break;
        }
        chunks += 1;
        bytes += next.value.byteLength;
        expect(next.value.byteLength).toBeLessThanOrEqual(64 * 1024);
    }

    expect(chunks).toBeGreaterThan(1);
    expect(response.headers.get('content-length')).toBe(String(bytes));
    expect(iteratorCalls).toBe(1);
    expect(generatedAccounts).toBe(2_000);
});

it('should preflight the exact export ceiling before returning a body', async () => {
    const baseAccount = { config: {}, key: '' };
    const fixedBytes = Buffer.byteLength(
        JSON.stringify({
            accounts: [baseAccount],
            exportedAt: '',
            platform: 'codex',
        }),
    );
    const wallet = (bytes: number) => ({
        accounts: [{ config: {}, key: 'x'.repeat(bytes - fixedBytes) }],
        exportedAt: '',
        platform: 'codex' as const,
    });
    const allowed = createFetch(assets, { exportWallet: async () => wallet(MAX_EXPORT_PAYLOAD_BYTES) });
    const rejected = createFetch(assets, { exportWallet: async () => wallet(MAX_EXPORT_PAYLOAD_BYTES + 1) });
    const request = () =>
        new Request('http://127.0.0.1:3000/api/codex/export', {
            headers: { 'X-Dondo-Export': '1' },
            method: 'POST',
        });

    const allowedResponse = await allowed(request());
    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.headers.get('content-length')).toBe(String(MAX_EXPORT_PAYLOAD_BYTES));
    await allowedResponse.body?.cancel();

    const rejectedResponse = await rejected(request());
    expect(rejectedResponse.status).toBe(413);
    expect(rejectedResponse.headers.get('content-disposition')).toBeNull();
    expect(await rejectedResponse.text()).toContain('Export payload exceeds the 8 MiB size limit');
});

it('should clean up the export iterator when the response stream is cancelled', async () => {
    let factoryCalls = 0;
    let streamedIteratorCleanups = 0;
    const exportApp = createFetch(assets, {
        exportByteIterator: () => {
            factoryCalls += 1;
            let emitted = false;
            return {
                next: () => {
                    if (emitted) {
                        return { done: true as const, value: undefined };
                    }
                    emitted = true;
                    return { done: false as const, value: new TextEncoder().encode('{"ok":true}') };
                },
                return: () => {
                    streamedIteratorCleanups += 1;
                    return { done: true as const, value: undefined };
                },
            };
        },
        exportWallet: async () => ({ accounts: [], exportedAt: '', platform: 'codex' }),
    });
    const response = await exportApp(
        new Request('http://127.0.0.1:3000/api/codex/export', {
            headers: { 'X-Dondo-Export': '1' },
            method: 'POST',
        }),
    );

    await response.body?.cancel();
    expect(factoryCalls).toBe(1);
    expect(streamedIteratorCleanups).toBe(1);
});

it('should isolate rate-limit state between fetch instances', async () => {
    const saturated = createFetch(assets);
    const isolated = createFetch(assets);
    for (let hit = 0; hit < API_RATE_LIMIT_MAX; hit += 1) {
        expect((await saturated(new Request('http://127.0.0.1:3000/api/unknown'))).status).toBe(404);
    }

    expect((await saturated(new Request('http://127.0.0.1:3000/api/unknown'))).status).toBe(429);
    expect((await isolated(new Request('http://127.0.0.1:3000/api/unknown'))).status).toBe(404);
});

it('should bind the next available port when the preferred port is occupied', async () => {
    const blocker = await occupyAvailablePortBelowMax();
    const preferredPort = serverPort(blocker);
    let server: ReturnType<typeof Bun.serve> | undefined;

    try {
        server = serveOnAvailablePort(assets, preferredPort);

        expect(server.hostname).toBe('127.0.0.1');
        expect(server.port).toBeGreaterThan(preferredPort);
        const response = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(response.status).toBe(200);
    } finally {
        server?.stop(true);
        await closeServer(blocker);
    }
});

it('should select the first available candidate port', () => {
    const attempts: number[] = [];
    const start = 40_000;
    const server = serveOnAvailablePort(assets, start, (options) => {
        attempts.push(options.port);
        if (options.port < start + 2) {
            throw Object.assign(new Error('Address already in use'), { code: 'EADDRINUSE' });
        }
        return { hostname: options.hostname, port: options.port } as ReturnType<typeof Bun.serve>;
    });

    expect(server.port).toBe(start + 2);
    expect(attempts).toEqual([start, start + 1, start + 2]);
});

it('should stop scanning after the bounded number of occupied ports', () => {
    const attempts: number[] = [];
    const start = 40_000;

    expect(() =>
        serveOnAvailablePort(assets, start, ({ port }) => {
            attempts.push(port);
            throw Object.assign(new Error('Address already in use'), { code: 'EADDRINUSE' });
        }),
    ).toThrow('No available port found after 20 attempts from 40000 to 40019');
    expect(attempts).toEqual(Array.from({ length: 20 }, (_, index) => start + index));
});

it('should stop at the maximum TCP port', () => {
    const attempts: number[] = [];

    expect(() =>
        serveOnAvailablePort(assets, 65_535, ({ port }) => {
            attempts.push(port);
            throw Object.assign(new Error('Address already in use'), { code: 'EADDRINUSE' });
        }),
    ).toThrow('No available port found after 1 attempt from 65535 to 65535');
    expect(attempts).toEqual([65_535]);
});
