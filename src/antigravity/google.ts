import { ANTIGRAVITY_VERSION, GOOGLE_TOKEN_URL, LOAD_PROJECT_URL, QUOTA_URLS } from '../config.ts';
import { discardResponse, readBoundedResponseJson } from '../http.ts';
import type { AntigravityCredential, LimitResult, TokenPayload } from '../types.ts';
import { googleOAuthClients } from './oauth.ts';

type JsonObject = Record<string, unknown>;
type FetchLimitsResult = {
    password?: string;
    quota: LimitResult;
};
type GoogleRefreshResponse = {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
};

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 4_000;
const TOKEN_REFRESH_DEADLINE_MS = 16_000;
const MAX_OAUTH_ATTEMPTS = 8;
const EXPIRY_GRACE_MS = 60_000;
const TOKEN_PREFIX = 'go-keyring-base64:';
const TOKEN_INFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

const asObject = (value: unknown): JsonObject => {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
};

const stringValue = (value: unknown) => (typeof value === 'string' ? value : undefined);
const finiteNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const staleTokenQuota = {
    error: 'Saved Antigravity credentials are expired or rejected. Use this account in Antigravity, then click Sync current on this saved row.',
    ok: false as const,
};

const hasOnlyStringFields = (record: Record<string, unknown>, fields: readonly string[]) => {
    return fields.every((field) => record[field] === undefined || typeof record[field] === 'string');
};

const decodeCanonicalBase64Json = (encoded: string) => {
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
        return null;
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded) {
        return null;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)) as unknown;
};

const isUsableToken = (value: unknown): value is NonNullable<TokenPayload['token']> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const token = value as Record<string, unknown>;
    if (!hasOnlyStringFields(token, ['access_token', 'refresh_token', 'expiry', 'token_type'])) {
        return false;
    }
    return [token.access_token, token.refresh_token].some(
        (credential) => typeof credential === 'string' && Boolean(credential.trim()),
    );
};

export const decodeToken = (password: string): TokenPayload | null => {
    try {
        const encoded = password.startsWith(TOKEN_PREFIX) ? password.slice(TOKEN_PREFIX.length) : password;
        const value = decodeCanonicalBase64Json(encoded);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return null;
        }
        const payload = value as Record<string, unknown>;
        if (!hasOnlyStringFields(payload, ['auth_method']) || !isUsableToken(payload.token)) {
            return null;
        }
        return value as TokenPayload;
    } catch {
        return null;
    }
};

const parseRefreshResponse = (value: Record<string, unknown>): GoogleRefreshResponse | null => {
    if (typeof value.access_token !== 'string' || !value.access_token.trim()) {
        return null;
    }
    if (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || !value.refresh_token.trim())) {
        return null;
    }
    if (
        value.expires_in !== undefined &&
        (typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in))
    ) {
        return null;
    }
    return value as GoogleRefreshResponse;
};

const encodeToken = (password: string, payload: TokenPayload) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    return password.startsWith(TOKEN_PREFIX) ? `${TOKEN_PREFIX}${encoded}` : encoded;
};

const headers = (accessToken: string) => {
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    return {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': `antigravity/${ANTIGRAVITY_VERSION} darwin/${arch}`,
    };
};

const postJson = async (url: string, accessToken: string, body: unknown) => {
    const res = await fetch(url, {
        body: JSON.stringify(body),
        headers: headers(accessToken),
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        await discardResponse(res);
        throw new Error(`HTTP ${res.status}`);
    }
    return readBoundedResponseJson(res, 'Antigravity quota');
};

const refreshAccessToken = async (refreshToken: string) => {
    const clients = await googleOAuthClients();
    if (clients.length === 0) {
        throw new Error('Could not find Antigravity Google OAuth credentials to refresh limits');
    }

    let lastStatus = '';
    const deadline = Date.now() + TOKEN_REFRESH_DEADLINE_MS;
    for (const client of clients.slice(0, MAX_OAUTH_ATTEMPTS)) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            break;
        }
        let res: Response;
        try {
            res = await fetch(GOOGLE_TOKEN_URL, {
                body: new URLSearchParams({
                    client_id: client.clientId,
                    client_secret: client.clientSecret,
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                }),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                method: 'POST',
                signal: AbortSignal.timeout(Math.max(1, Math.min(TOKEN_REQUEST_TIMEOUT_MS, remainingMs))),
            });
        } catch {
            lastStatus = 'request failed';
            continue;
        }
        if (res.ok) {
            const value = await readBoundedResponseJson<Record<string, unknown>>(res, 'Antigravity token refresh');
            const refreshed = parseRefreshResponse(value);
            if (!refreshed) {
                throw new Error('Antigravity token refresh response was incomplete');
            }
            return refreshed;
        }
        lastStatus = `HTTP ${res.status}`;
        await discardResponse(res);
    }

    throw new Error(`Token refresh failed${lastStatus ? `: ${lastStatus}` : ''}`);
};

const accessTokenExpired = (token: NonNullable<TokenPayload['token']>) => {
    const expiry = token.expiry ? Date.parse(token.expiry) : Number.NaN;
    return Boolean(token.expiry && !Number.isNaN(expiry) && expiry <= Date.now() + EXPIRY_GRACE_MS);
};

const validAccessToken = async (token: NonNullable<TokenPayload['token']>, force = false) => {
    if (!force && token.access_token && !accessTokenExpired(token)) {
        return { accessToken: token.access_token };
    }
    if (!token.refresh_token) {
        return { accessToken: undefined };
    }

    const refreshed = await refreshAccessToken(token.refresh_token);
    if (!refreshed.access_token) {
        return { accessToken: undefined };
    }

    const expiresIn = finiteNumber(refreshed.expires_in);
    const nextExpiry =
        expiresIn !== undefined && expiresIn > 0 && expiresIn <= 31_536_000
            ? new Date(Date.now() + expiresIn * 1_000).toISOString()
            : token.expiry;
    const nextToken = {
        ...token,
        access_token: refreshed.access_token,
        ...(nextExpiry ? { expiry: nextExpiry } : {}),
        refresh_token: refreshed.refresh_token ?? token.refresh_token,
    };
    return { accessToken: refreshed.access_token, token: nextToken };
};

const isHttp401 = (error: unknown) => String(error).includes('HTTP 401');

const quotaWithAccessToken = async (accessToken: string, expires: string): Promise<LimitResult> => {
    const projectData = asObject(
        await postJson(LOAD_PROJECT_URL, accessToken, {
            metadata: { ideType: 'ANTIGRAVITY' },
        }),
    );
    const project = projectData.cloudaicompanionProject;
    const paidTier = asObject(projectData.paidTier);
    const currentTier = asObject(projectData.currentTier);
    const tier =
        stringValue(paidTier.name) ??
        stringValue(paidTier.id) ??
        stringValue(currentTier.name) ??
        stringValue(currentTier.id) ??
        '';
    let lastError = '';

    for (const url of QUOTA_URLS) {
        try {
            const data = asObject(await postJson(url, accessToken, project ? { project } : {}));
            const responseModels = asObject(data.models);
            const models = Object.fromEntries(
                Object.entries(responseModels)
                    .filter(([, info]) => {
                        const quotaInfo = asObject(asObject(info).quotaInfo);
                        return finiteNumber(quotaInfo.remainingFraction) !== undefined;
                    })
                    .map(([name, info]) => {
                        const model = asObject(info);
                        const quotaInfo = asObject(model.quotaInfo);
                        const remainingFraction = finiteNumber(quotaInfo.remainingFraction) ?? 0;
                        return [
                            name,
                            {
                                displayName: stringValue(model.displayName) ?? name,
                                percentage: Math.round(Math.max(0, Math.min(1, remainingFraction)) * 100),
                                resetTime: stringValue(quotaInfo.resetTime) ?? '',
                            },
                        ];
                    }),
            );
            if (Object.keys(models).length === 0) {
                return { error: 'Antigravity quota returned no quota fields', ok: false };
            }
            return {
                expires,
                models,
                ok: true,
                tier,
            };
        } catch (error) {
            lastError = String(error);
            if (!/HTTP (?:429|5\d\d|403)/.test(lastError)) {
                throw error;
            }
        }
    }

    return { error: 'Quota API is rate-limited or unavailable', ok: false };
};

const resultWithAccessToken = async (
    snap: AntigravityCredential,
    payload: TokenPayload,
    token: NonNullable<TokenPayload['token']>,
    forceRefresh = false,
): Promise<FetchLimitsResult> => {
    const { accessToken, token: refreshedToken } = await validAccessToken(token, forceRefresh);
    if (!accessToken) {
        return { quota: staleTokenQuota };
    }

    return {
        ...(refreshedToken ? { password: encodeToken(snap.password, { ...payload, token: refreshedToken }) } : {}),
        quota: await quotaWithAccessToken(accessToken, refreshedToken?.expiry ?? token.expiry ?? ''),
    };
};

export const fetchLimits = async (snap: AntigravityCredential): Promise<FetchLimitsResult> => {
    const payload = decodeToken(snap.password);
    const token = payload?.token;
    if (!payload || !token || (!token.access_token && !token.refresh_token)) {
        return { quota: { error: 'No access token in snapshot', ok: false } };
    }

    try {
        return await resultWithAccessToken(snap, payload, token);
    } catch (error) {
        if (!isHttp401(error) || !token.refresh_token) {
            throw error;
        }
    }

    try {
        return await resultWithAccessToken(snap, payload, token, true);
    } catch (error) {
        if (isHttp401(error)) {
            return { quota: staleTokenQuota };
        }
        throw error;
    }
};

export const resolveGoogleIdentity = async (snap: AntigravityCredential) => {
    const payload = decodeToken(snap.password);
    const token = payload?.token;
    if (!payload || !token) {
        throw new Error('Antigravity credential payload is invalid');
    }
    const { accessToken, token: refreshedToken } = await validAccessToken(token);
    if (!accessToken) {
        throw new Error('Antigravity credential has no usable access token');
    }
    const url = new URL(TOKEN_INFO_URL);
    url.searchParams.set('access_token', accessToken);
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
        await discardResponse(response);
        throw new Error(`Google identity lookup failed with HTTP ${response.status}`);
    }
    const value = await readBoundedResponseJson<Record<string, unknown>>(response, 'Google identity lookup');
    if (typeof value.sub !== 'string' || !value.sub.trim() || Buffer.byteLength(value.sub, 'utf8') > 256) {
        throw new Error('Google identity lookup returned an incomplete account identity');
    }
    return {
        identity: value.sub,
        ...(refreshedToken ? { password: encodeToken(snap.password, { ...payload, token: refreshedToken }) } : {}),
    };
};
