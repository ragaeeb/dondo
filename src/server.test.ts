import { expect, it } from 'bun:test';
import { createServer } from 'node:net';
import { publicError } from './errors.ts';
import { createFetch, serveOnAvailablePort } from './server.ts';

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
});

it('should serve the UI shell for direct platform routes', async () => {
    for (const platform of ['antigravity', 'codex', 'kiro', 'minimax']) {
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
    expect(await json(response)).toEqual({ error: 'Only localhost origins are allowed' });
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

it('should reject unsupported API methods before reading a body', async () => {
    const response = await app(new Request('http://127.0.0.1:3000/api/antigravity/save'));

    expect(response.status).toBe(405);
    expect(await json(response)).toEqual({ error: 'Method not allowed' });
});

it('should reject malformed JSON bodies before service calls', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/save', {
            body: '{',
            method: 'POST',
        }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Invalid JSON body' });
});

it('should not expose token-shaped fields in API error responses', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/antigravity/load', {
            body: JSON.stringify({ key: 'Bearer ya29.secret' }),
            method: 'POST',
        }),
    );
    const text = await response.text();

    expect(text).not.toContain('ya29.secret');
    expect(text).not.toContain('access_token');
    expect(text).not.toContain('refresh_token');
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
