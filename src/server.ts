#!/usr/bin/env bun

import { antigravityState, clearAntigravity, loadAntigravity, saveAntigravity } from './antigravity/service.ts';
import { codexState, loadCodex, saveCodex } from './codex/service.ts';
import { HOST, PORT } from './config.ts';
import { errorMessage, errorStatus, publicError } from './errors.ts';
import { renderHtml } from './ui/html.ts';

type Assets = {
    appJs: string;
    css: string;
    iconPng: ReturnType<typeof Bun.file>;
    iconSvg: string;
};

type Route = {
    handler: (req: Request) => Promise<Response>;
};

const SECURITY_HEADERS = {
    'Content-Security-Policy':
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
};

const API_RATE_LIMIT = {
    hits: [] as number[],
    max: 120,
    windowMs: 10_000,
};

const buildAssets = async (): Promise<Assets> => {
    const result = await Bun.build({
        entrypoints: [new URL('./ui/client.tsx', import.meta.url).pathname],
        jsx: {
            importSource: 'preact',
            runtime: 'automatic',
        },
        target: 'browser',
    });
    if (!result.success) {
        throw new Error(result.logs.map((log) => log.message).join('\n') || 'Failed to build UI assets');
    }

    const js = result.outputs.find((output) => output.path.endsWith('.js'));
    if (!js) {
        throw new Error('UI build did not produce JavaScript');
    }

    return {
        appJs: await js.text(),
        css: await Bun.file(new URL('./ui/styles.css', import.meta.url).pathname).text(),
        iconPng: Bun.file(new URL('../icon.png', import.meta.url).pathname),
        iconSvg: await Bun.file(new URL('../icon.svg', import.meta.url).pathname).text(),
    };
};

const withHeaders = (response: Response, headers: Record<string, string>) => {
    const merged = new Headers(response.headers);
    for (const [key, value] of Object.entries({ ...SECURITY_HEADERS, ...headers })) {
        merged.set(key, value);
    }
    return new Response(response.body, {
        headers: merged,
        status: response.status,
        statusText: response.statusText,
    });
};

const json = (value: unknown, status = 200) => {
    return withHeaders(Response.json(value, { status }), {});
};

const jsonError = (error: unknown) => {
    return json({ error: errorMessage(error) }, errorStatus(error));
};

const localName = (host: string | null) => {
    const lower = host?.toLowerCase();
    const value = lower?.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower?.split(':')[0];
    return value === 'localhost' || value === '127.0.0.1' || value === '[::1]' || value === '::1';
};

const assertLocalRequest = (req: Request) => {
    const host = req.headers.get('host') ?? new URL(req.url).host;
    if (!localName(host)) {
        throw publicError(403, 'Only localhost requests are allowed');
    }

    const origin = req.headers.get('origin');
    if (origin) {
        try {
            if (!localName(new URL(origin).host)) {
                throw publicError(403, 'Only localhost origins are allowed');
            }
        } catch {
            throw publicError(403, 'Only localhost origins are allowed');
        }
    }
};

const assertRateLimit = () => {
    const now = Date.now();
    API_RATE_LIMIT.hits = API_RATE_LIMIT.hits.filter((hit) => hit > now - API_RATE_LIMIT.windowMs);
    if (API_RATE_LIMIT.hits.length >= API_RATE_LIMIT.max) {
        throw publicError(429, 'Too many local API requests; wait a moment and try again');
    }
    API_RATE_LIMIT.hits.push(now);
};

const body = async (req: Request) => {
    const text = await req.text();
    if (!text.trim()) {
        return {};
    }
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw publicError(400, 'JSON body must be an object');
        }
        return parsed as { key?: unknown };
    } catch (error) {
        if (errorStatus(error) !== 500) {
            throw error;
        }
        throw publicError(400, 'Invalid JSON body');
    }
};

const optionalKey = async (req: Request) => {
    const key = (await body(req)).key;
    if (key === undefined) {
        return undefined;
    }
    if (typeof key !== 'string') {
        throw publicError(400, 'key must be a string');
    }
    return key;
};

const requiredKey = async (req: Request) => {
    const key = await optionalKey(req);
    if (!key) {
        throw publicError(400, 'key is required');
    }
    return key;
};

const routes = new Map<string, Route>([
    ['GET /api/antigravity/state', { handler: async () => json(await antigravityState()) }],
    [
        'POST /api/antigravity/limits/refresh',
        {
            handler: async (req) =>
                json(await antigravityState({ refreshLimitKey: await optionalKey(req), refreshLimits: true })),
        },
    ],
    [
        'POST /api/antigravity/save',
        {
            handler: async (req) => {
                await saveAntigravity(await requiredKey(req));
                return json({ ok: true });
            },
        },
    ],
    [
        'POST /api/antigravity/load',
        {
            handler: async (req) => {
                await loadAntigravity(await requiredKey(req));
                return json({ ok: true });
            },
        },
    ],
    [
        'POST /api/antigravity/clear',
        {
            handler: async () => {
                await clearAntigravity();
                return json({ ok: true });
            },
        },
    ],
    ['GET /api/codex/state', { handler: async () => json(await codexState()) }],
    [
        'POST /api/codex/limits/refresh',
        {
            handler: async (req) =>
                json(await codexState({ refreshLimitKey: await optionalKey(req), refreshLimits: true })),
        },
    ],
    [
        'POST /api/codex/save',
        {
            handler: async (req) => {
                await saveCodex(await requiredKey(req));
                return json({ ok: true });
            },
        },
    ],
    [
        'POST /api/codex/load',
        {
            handler: async (req) => {
                await loadCodex(await requiredKey(req));
                return json({ ok: true });
            },
        },
    ],
]);

const handleApi = async (url: URL, req: Request) => {
    if (!url.pathname.startsWith('/api/')) {
        return null;
    }
    assertLocalRequest(req);
    assertRateLimit();
    const route = routes.get(`${req.method} ${url.pathname}`);
    if (!route) {
        const hasPath = [...routes.keys()].some((key) => key.endsWith(` ${url.pathname}`));
        return hasPath ? json({ error: 'Method not allowed' }, 405) : json({ error: 'Not found' }, 404);
    }
    return route.handler(req);
};

const handleAsset = (url: URL, assets: Assets) => {
    if (url.pathname === '/') {
        return withHeaders(new Response(renderHtml()), { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' });
    }
    if (url.pathname === '/assets/app.js') {
        return withHeaders(new Response(assets.appJs), {
            'Cache-Control': 'max-age=3600',
            'Content-Type': 'text/javascript',
        });
    }
    if (url.pathname === '/assets/styles.css') {
        return withHeaders(new Response(assets.css), { 'Cache-Control': 'max-age=3600', 'Content-Type': 'text/css' });
    }
    if (url.pathname === '/icon.svg') {
        return withHeaders(new Response(assets.iconSvg), {
            'Cache-Control': 'max-age=86400',
            'Content-Type': 'image/svg+xml',
        });
    }
    if (url.pathname === '/icon.png' || url.pathname === '/favicon.ico') {
        return withHeaders(new Response(assets.iconPng), {
            'Cache-Control': 'max-age=86400',
            'Content-Type': 'image/png',
        });
    }
    return null;
};

export const createFetch = (assets: Assets) => {
    return async (req: Request) => {
        const url = new URL(req.url);
        try {
            const asset = handleAsset(url, assets);
            if (asset) {
                return asset;
            }
            const api = await handleApi(url, req);
            if (api) {
                return api;
            }
            return json({ error: 'Not found' }, 404);
        } catch (error) {
            return jsonError(error);
        }
    };
};

export const startServer = async () => {
    const assets = await buildAssets();
    const server = Bun.serve({
        fetch: createFetch(assets),
        hostname: HOST,
        port: PORT,
    });

    console.log(`Dondo running at http://${HOST}:${server.port}`);
    return server;
};

if (import.meta.main) {
    await startServer();
}
