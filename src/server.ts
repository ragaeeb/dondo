#!/usr/bin/env bun

import { fileURLToPath } from 'node:url';
import {
    antigravityState,
    clearAntigravity,
    deleteAntigravity,
    loadAntigravity,
    saveAntigravity,
} from './antigravity/service.ts';
import { runCli } from './cli.ts';
import { clineState, deleteCline, loadCline, saveCline } from './cline/service.ts';
import { codexState, deleteCodex, loadCodex, saveCodex } from './codex/service.ts';
import { APP_VERSION, DATA_DIR, DEV_MODE, HOME_DIR, HOST, KEYCHAIN_PROVIDER, PORT, VAULT_PATH } from './config.ts';
import { errorMessage, errorStatus, isPublicError, publicError } from './errors.ts';
import { clearKiro, deleteKiro, kiroState, loadKiro, saveKiro } from './kiro/service.ts';
import {
    checkInAllMinimax,
    checkInMinimax,
    deleteMinimax,
    loadMinimax,
    minimaxState,
    saveMinimax,
} from './minimax/service.ts';
import { type ExportPlatform, type ExportWalletResult, exportPlatformWallet } from './storage/export.ts';
import { renderHtml } from './ui/html.ts';

declare const DONDO_BUNDLED_ASSETS: boolean;

type Assets = {
    appJs: string;
    css: string;
    iconPng: ReturnType<typeof Bun.file>;
    iconSvg: string;
};

type Route = {
    handler: (req: Request, dependencies: ServerDependencies) => Promise<Response>;
};

type EmptyMutation = () => Promise<unknown>;

type ExportWallet = (platform: ExportPlatform) => Promise<ExportWalletResult>;

type ExportByteIterator = Iterator<Uint8Array>;

type ExportByteIteratorFactory = (wallet: ExportWalletResult) => ExportByteIterator;

type KeyedMutation = (key: string) => Promise<unknown>;

type LimitState = (options: { refreshLimitKey?: string; refreshLimits: true }) => Promise<unknown>;

type RouteEntry = [string, Route];

type State = () => Promise<unknown>;

type ServerDependencies = {
    exportByteIterator: ExportByteIteratorFactory;
    exportWallet: ExportWallet;
};

type RateLimit = () => void;

type ServerFactoryOptions = {
    fetch: ReturnType<typeof createFetch>;
    hostname: string;
    port: number;
};

type ServerFactory = (options: ServerFactoryOptions) => ReturnType<typeof Bun.serve>;

const SECURITY_HEADERS = {
    'Content-Security-Policy':
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
};

const MAX_PORT = 65_535;
const MAX_PORT_ATTEMPTS = 20;
const EXPORT_CONFIRMATION_HEADER = 'X-Dondo-Export';
export const API_VERSION = 1;

export const API_RATE_LIMIT_MAX = 120;
export const MAX_EXPORT_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_JSON_BODY_BYTES = 16 * 1024;

const API_RATE_LIMIT_WINDOW_MS = 10_000;
const EXPORT_STREAM_CHUNK_BYTES = 64 * 1024;

const serializeExportValue = (value: unknown) => {
    try {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== 'string') {
            throw new Error('Value is not JSON serializable');
        }
        return serialized;
    } catch {
        throw publicError(500, 'Export payload could not be serialized');
    }
};

const exportFragments = (wallet: ExportWalletResult): Iterator<string> => {
    const accounts = wallet.accounts[Symbol.iterator]();
    let stage = 0;
    let firstAccount = true;
    let closed = false;
    return {
        next: () => {
            if (closed) {
                return { done: true, value: undefined };
            }
            if (stage === 0) {
                stage = 1;
                return { done: false, value: '{"accounts":[' };
            }
            if (stage === 1) {
                const account = accounts.next();
                if (!account.done) {
                    const separator = firstAccount ? '' : ',';
                    firstAccount = false;
                    return { done: false, value: `${separator}${serializeExportValue(account.value)}` };
                }
                stage = 2;
            }
            if (stage === 2) {
                stage = 3;
                return {
                    done: false,
                    value: `],"exportedAt":${serializeExportValue(wallet.exportedAt)},"platform":${serializeExportValue(wallet.platform)}}`,
                };
            }
            closed = true;
            return { done: true, value: undefined };
        },
        return: () => {
            closed = true;
            accounts.return?.();
            return { done: true, value: undefined };
        },
    };
};

const createExportByteIterator: ExportByteIteratorFactory = (wallet) => {
    const fragments = exportFragments(wallet);
    const encoder = new TextEncoder();
    let current = new Uint8Array();
    let offset = 0;
    let closed = false;
    const close = () => {
        if (closed) {
            return;
        }
        closed = true;
        current = new Uint8Array();
        fragments.return?.();
    };
    return {
        next: () => {
            if (closed) {
                return { done: true, value: undefined };
            }
            while (offset >= current.byteLength) {
                const next = fragments.next();
                if (next.done) {
                    close();
                    return { done: true, value: undefined };
                }
                current = encoder.encode(next.value);
                offset = 0;
            }
            const end = Math.min(offset + EXPORT_STREAM_CHUNK_BYTES, current.byteLength);
            const chunk = current.slice(offset, end);
            offset = end;
            return { done: false, value: chunk };
        },
        return: () => {
            close();
            return { done: true, value: undefined };
        },
    };
};

const defaultDependencies: ServerDependencies = {
    exportByteIterator: createExportByteIterator,
    exportWallet: exportPlatformWallet,
};

const displayPath = (path: string) => {
    const homePrefix = `${HOME_DIR}/`;
    return path === HOME_DIR ? '~' : path.startsWith(homePrefix) ? `~/${path.slice(homePrefix.length)}` : path;
};

export const startupDiagnostics = (port: number) => ({
    apiVersion: API_VERSION,
    dataDir: displayPath(DATA_DIR),
    keychain: KEYCHAIN_PROVIDER,
    mode: DEV_MODE,
    platform: process.platform,
    url: `http://${HOST}:${port}`,
    vault: displayPath(VAULT_PATH),
});

const bunServerFactory: ServerFactory = (options) => Bun.serve(options);

const modulePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

const buildSourceAssets = async (): Promise<Assets> => {
    const result = await Bun.build({
        entrypoints: [modulePath('./ui/client.tsx')],
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
        css: await Bun.file(modulePath('./ui/styles.css')).text(),
        iconPng: Bun.file(modulePath('../icon.png')),
        iconSvg: await Bun.file(modulePath('../icon.svg')).text(),
    };
};

const loadBundledAssets = async (): Promise<Assets> => {
    return {
        appJs: await Bun.file(modulePath('./assets/app.js')).text(),
        css: await Bun.file(modulePath('./assets/styles.css')).text(),
        iconPng: Bun.file(modulePath('./icon.png')),
        iconSvg: await Bun.file(modulePath('./icon.svg')).text(),
    };
};

const buildAssets = () => {
    return typeof DONDO_BUNDLED_ASSETS !== 'undefined' && DONDO_BUNDLED_ASSETS
        ? loadBundledAssets()
        : buildSourceAssets();
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
    return withHeaders(Response.json(value, { status }), { 'Cache-Control': 'no-store' });
};

const jsonError = (error: unknown) => {
    return json({ error: isPublicError(error) ? errorMessage(error) : 'Internal server error' }, errorStatus(error));
};

const isPortInUse = (error: unknown) => {
    const value = typeof error === 'object' && error !== null ? (error as { code?: unknown }) : undefined;
    return value?.code === 'EADDRINUSE';
};

const collectExportChunks = (wallet: ExportWalletResult, iteratorFactory: ExportByteIteratorFactory) => {
    const iterator = iteratorFactory(wallet);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const next = iterator.next();
            if (next.done) {
                return { chunks, contentLength: total };
            }
            total += next.value.byteLength;
            if (total > MAX_EXPORT_PAYLOAD_BYTES) {
                throw publicError(413, 'Export payload exceeds the 8 MiB size limit');
            }
            chunks.push(next.value.slice());
        }
    } finally {
        iterator.return?.();
    }
};

const exportStream = (chunks: readonly Uint8Array[]) => {
    let index = 0;
    return new ReadableStream<Uint8Array>({
        pull: (controller) => {
            const chunk = chunks[index];
            if (!chunk) {
                controller.close();
                return;
            }
            index += 1;
            controller.enqueue(chunk);
        },
    });
};

const exportJson = async (platform: ExportPlatform, dependencies: ServerDependencies) => {
    const filename = `dondo-${platform}-wallet-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const wallet = await dependencies.exportWallet(platform);
    const { chunks, contentLength } = collectExportChunks(wallet, dependencies.exportByteIterator);
    return withHeaders(new Response(exportStream(chunks)), {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(contentLength),
        'Content-Type': 'application/json',
    });
};

const localName = (host: string | null) => {
    const lower = host?.toLowerCase();
    const value = lower?.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower?.split(':')[0];
    return value === 'localhost' || value === '127.0.0.1';
};

const assertLocalRequest = (req: Request) => {
    const requestUrl = new URL(req.url);
    const host = req.headers.get('host') ?? requestUrl.host;
    if (!localName(host) || !localName(requestUrl.host) || host.toLowerCase() !== requestUrl.host.toLowerCase()) {
        throw publicError(403, 'Only localhost requests are allowed');
    }

    const origin = req.headers.get('origin');
    if (origin) {
        try {
            if (new URL(origin).origin !== requestUrl.origin) {
                throw publicError(403, 'Request origin must exactly match the local server origin');
            }
        } catch {
            throw publicError(403, 'Request origin must exactly match the local server origin');
        }
    }
};

const createRateLimit = (): RateLimit => {
    let hits: number[] = [];
    return () => {
        const now = Date.now();
        hits = hits.filter((hit) => hit > now - API_RATE_LIMIT_WINDOW_MS);
        if (hits.length >= API_RATE_LIMIT_MAX) {
            throw publicError(429, 'Too many local API requests; wait a moment and try again');
        }
        hits.push(now);
    };
};

const assertExportConfirmation = (req: Request) => {
    if (req.headers.get(EXPORT_CONFIRMATION_HEADER) !== '1') {
        throw publicError(403, 'Export confirmation is required');
    }
};

const assertJsonContentType = (req: Request) => {
    const mediaType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
        throw publicError(415, 'JSON requests require Content-Type: application/json');
    }
};

const readBoundedBody = async (req: Request) => {
    const contentLength = Number(req.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
        throw publicError(413, 'JSON request body exceeds the 16 KiB size limit');
    }
    if (!req.body) {
        return '';
    }

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            total += value.byteLength;
            if (total > MAX_JSON_BODY_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw publicError(413, 'JSON request body exceeds the 16 KiB size limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
        throw publicError(400, 'JSON request body must be valid UTF-8');
    }
};

const body = async (req: Request) => {
    assertJsonContentType(req);
    const text = await readBoundedBody(req);
    if (!text.trim()) {
        throw publicError(400, 'JSON body must be an object');
    }
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw publicError(400, 'JSON body must be an object');
        }
        if (Object.keys(parsed).some((key) => key !== 'key')) {
            throw publicError(400, 'JSON body has unexpected fields');
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

const stateRoute = (platform: ExportPlatform, state: State): RouteEntry => [
    `GET /api/${platform}/state`,
    { handler: async () => json(await state()) },
];

const exportRoute = (platform: ExportPlatform): RouteEntry => [
    `POST /api/${platform}/export`,
    {
        handler: async (req, dependencies) => {
            assertExportConfirmation(req);
            return exportJson(platform, dependencies);
        },
    },
];

const keyedMutationRoute = (
    platform: ExportPlatform,
    action: 'delete' | 'load' | 'save',
    mutation: KeyedMutation,
): RouteEntry => [
    `POST /api/${platform}/${action}`,
    {
        handler: async (req) => {
            await mutation(await requiredKey(req));
            return json({ ok: true });
        },
    },
];

const limitRefreshRoute = (platform: ExportPlatform, state: LimitState): RouteEntry => [
    `POST /api/${platform}/limits/refresh`,
    {
        handler: async (req) => {
            const refreshLimitKey = await optionalKey(req);
            return json(
                await state({
                    ...(refreshLimitKey === undefined ? {} : { refreshLimitKey }),
                    refreshLimits: true,
                }),
            );
        },
    },
];

const versionRoute: RouteEntry = [
    'GET /api/version',
    {
        handler: async () => json({ apiVersion: API_VERSION, appVersion: APP_VERSION }),
    },
];

const emptyMutationRoute = (platform: ExportPlatform, action: 'clear', mutation: EmptyMutation): RouteEntry => [
    `POST /api/${platform}/${action}`,
    {
        handler: async (req) => {
            if (Object.keys(await body(req)).length > 0) {
                throw publicError(400, 'JSON body must be empty');
            }
            await mutation();
            return json({ ok: true });
        },
    },
];

const routes = new Map<string, Route>([
    versionRoute,
    stateRoute('antigravity', antigravityState),
    exportRoute('antigravity'),
    limitRefreshRoute('antigravity', antigravityState),
    keyedMutationRoute('antigravity', 'save', saveAntigravity),
    keyedMutationRoute('antigravity', 'load', loadAntigravity),
    keyedMutationRoute('antigravity', 'delete', deleteAntigravity),
    emptyMutationRoute('antigravity', 'clear', clearAntigravity),
    stateRoute('cline', clineState),
    exportRoute('cline'),
    keyedMutationRoute('cline', 'save', saveCline),
    keyedMutationRoute('cline', 'load', loadCline),
    keyedMutationRoute('cline', 'delete', deleteCline),
    stateRoute('codex', codexState),
    exportRoute('codex'),
    limitRefreshRoute('codex', codexState),
    keyedMutationRoute('codex', 'save', saveCodex),
    keyedMutationRoute('codex', 'load', loadCodex),
    keyedMutationRoute('codex', 'delete', deleteCodex),
    stateRoute('kiro', kiroState),
    exportRoute('kiro'),
    limitRefreshRoute('kiro', kiroState),
    keyedMutationRoute('kiro', 'save', saveKiro),
    keyedMutationRoute('kiro', 'load', loadKiro),
    keyedMutationRoute('kiro', 'delete', deleteKiro),
    emptyMutationRoute('kiro', 'clear', clearKiro),
    stateRoute('minimax', minimaxState),
    exportRoute('minimax'),
    limitRefreshRoute('minimax', minimaxState),
    [
        'POST /api/minimax/check-in',
        {
            handler: async (req) => json(await checkInMinimax(await optionalKey(req))),
        },
    ],
    [
        'POST /api/minimax/check-in-all',
        {
            handler: async (req) => {
                if (Object.keys(await body(req)).length > 0) {
                    throw publicError(400, 'JSON body must be empty');
                }
                return json(await checkInAllMinimax());
            },
        },
    ],
    keyedMutationRoute('minimax', 'save', saveMinimax),
    [
        'POST /api/minimax/load',
        {
            handler: async (req) => json({ checkIn: await loadMinimax(await requiredKey(req)), ok: true }),
        },
    ],
    keyedMutationRoute('minimax', 'delete', deleteMinimax),
]);

const handleApi = async (url: URL, req: Request, dependencies: ServerDependencies, rateLimit: RateLimit) => {
    if (!url.pathname.startsWith('/api/')) {
        return null;
    }
    assertLocalRequest(req);
    rateLimit();
    const route = routes.get(`${req.method} ${url.pathname}`);
    if (!route) {
        const hasPath = [...routes.keys()].some((key) => key.endsWith(` ${url.pathname}`));
        return hasPath ? json({ error: 'Method not allowed' }, 405) : json({ error: 'Not found' }, 404);
    }
    return route.handler(req, dependencies);
};

const handleAsset = (url: URL, assets: Assets) => {
    if (['/', '/antigravity', '/cline', '/codex', '/kiro', '/minimax'].includes(url.pathname)) {
        return withHeaders(new Response(renderHtml()), { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' });
    }
    if (url.pathname === '/assets/app.js') {
        return withHeaders(new Response(assets.appJs), {
            'Cache-Control': 'no-store',
            'Content-Type': 'text/javascript',
        });
    }
    if (url.pathname === '/assets/styles.css') {
        return withHeaders(new Response(assets.css), { 'Cache-Control': 'no-store', 'Content-Type': 'text/css' });
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

export const createFetch = (assets: Assets, dependencyOverrides: Partial<ServerDependencies> = {}) => {
    const dependencies: ServerDependencies = {
        exportByteIterator: dependencyOverrides.exportByteIterator ?? defaultDependencies.exportByteIterator,
        exportWallet: dependencyOverrides.exportWallet ?? defaultDependencies.exportWallet,
    };
    const rateLimit = createRateLimit();
    return async (req: Request) => {
        const url = new URL(req.url);
        try {
            const asset = handleAsset(url, assets);
            if (asset) {
                return asset;
            }
            const api = await handleApi(url, req, dependencies, rateLimit);
            if (api) {
                return api;
            }
            return json({ error: 'Not found' }, 404);
        } catch (error) {
            return jsonError(error);
        }
    };
};

export const serveOnAvailablePort = (
    assets: Assets,
    preferredPort = PORT,
    serverFactory: ServerFactory = bunServerFactory,
) => {
    if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > MAX_PORT) {
        throw new Error(`Invalid preferred port: ${preferredPort}`);
    }

    const lastPort = Math.min(MAX_PORT, preferredPort + MAX_PORT_ATTEMPTS - 1);
    let lastError: unknown;
    for (let port = preferredPort; port <= lastPort; port += 1) {
        try {
            return serverFactory({
                fetch: createFetch(assets),
                hostname: HOST,
                port,
            });
        } catch (error) {
            if (!isPortInUse(error)) {
                throw error;
            }
            lastError = error;
        }
    }

    const attempts = lastPort - preferredPort + 1;
    const attemptLabel = attempts === 1 ? 'attempt' : 'attempts';
    const message = `No available port found after ${attempts} ${attemptLabel} from ${preferredPort} to ${lastPort}`;
    throw lastError instanceof Error ? new Error(`${message}: ${lastError.message}`) : new Error(message);
};

export const startServer = async () => {
    const assets = await buildAssets();
    const server = serveOnAvailablePort(assets);
    const diagnostics = startupDiagnostics(server.port ?? PORT);
    console.log(`Dondo running at ${diagnostics.url}`);
    console.log(
        `Dondo config: api=${diagnostics.apiVersion} mode=${diagnostics.mode} platform=${diagnostics.platform} keychain=${diagnostics.keychain} data=${diagnostics.dataDir} vault=${diagnostics.vault}`,
    );
    return server;
};

if (import.meta.main) {
    const exitCode = await runCli(process.argv.slice(2));
    if (exitCode === null) {
        await startServer();
    } else {
        process.exitCode = exitCode;
    }
}
