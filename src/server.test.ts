import { expect, it } from 'bun:test';
import { createServer } from 'node:net';
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

const getAvailablePort = async () => {
    const server = await new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => resolve(probe));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Could not allocate an available port');
    }
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    return address.port;
};

it('should apply security headers to the UI shell', async () => {
    const response = await app(new Request('http://127.0.0.1:3000/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
});

it('should reject non-local API origins', async () => {
    const response = await app(
        new Request('http://127.0.0.1:3000/api/codex/state', {
            headers: { Origin: 'https://example.com' },
        }),
    );

    expect(response.status).toBe(403);
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
    const preferredPort = await getAvailablePort();
    const blocker = await occupyPort(preferredPort);
    let server: ReturnType<typeof Bun.serve> | undefined;

    try {
        server = serveOnAvailablePort(assets, preferredPort);

        expect(server.port).toBeGreaterThan(preferredPort);
        const response = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(response.status).toBe(200);
    } finally {
        server?.stop(true);
        await new Promise<void>((resolve, reject) => {
            blocker.close((error) => (error ? reject(error) : resolve()));
        });
    }
});
