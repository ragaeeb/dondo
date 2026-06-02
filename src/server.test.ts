import { expect, it } from 'bun:test';
import { createFetch } from './server.ts';

const app = createFetch({
    appJs: 'console.log("ok");',
    css: 'body{}',
    iconPng: Bun.file(new URL('../icon.png', import.meta.url).pathname),
    iconSvg: '<svg />',
});

const json = async (response: Response) => (await response.json()) as { error?: string };

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
