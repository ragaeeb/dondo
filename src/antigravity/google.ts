import { ANTIGRAVITY_VERSION, LOAD_PROJECT_URL, QUOTA_URLS } from '../config.ts';
import type { LimitResult, Snapshot, TokenPayload } from '../types.ts';

type JsonObject = Record<string, unknown>;
type FetchLimitsResult = {
    quota: LimitResult;
};

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_PREFIX = 'go-keyring-base64:';

const asObject = (value: unknown): JsonObject => {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
};

const stringValue = (value: unknown) => (typeof value === 'string' ? value : undefined);
const numberValue = (value: unknown) => (typeof value === 'number' ? value : undefined);

export const decodeToken = (password: string): TokenPayload | null => {
    try {
        const encoded = password.startsWith(TOKEN_PREFIX) ? password.slice(TOKEN_PREFIX.length) : password;
        return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
        return null;
    }
};

const headers = (accessToken: string) => {
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    return {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': `antigravity/${ANTIGRAVITY_VERSION} ${platform}/${arch}`,
    };
};

const errorStatus = async (res: Response) => {
    const text = await res.text();
    try {
        const body = asObject(JSON.parse(text));
        const error = asObject(body.error);
        return stringValue(error.status) ?? stringValue(error.message) ?? res.statusText;
    } catch {
        return res.statusText;
    }
};

const postJson = async (url: string, accessToken: string, body: unknown) => {
    const res = await fetch(url, {
        body: JSON.stringify(body),
        headers: headers(accessToken),
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        const status = await errorStatus(res);
        throw new Error(`HTTP ${res.status}${status ? `: ${status}` : ''}`);
    }
    return res.json();
};

export const fetchLimits = async (snap: Snapshot): Promise<FetchLimitsResult> => {
    const payload = decodeToken(snap.password);
    const token = payload?.token;
    if (!token?.access_token) {
        return { quota: { error: 'No access token in snapshot', ok: false } };
    }

    const projectData = asObject(
        await postJson(LOAD_PROJECT_URL, token.access_token, {
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
            const data = asObject(await postJson(url, token.access_token, project ? { project } : {}));
            const responseModels = asObject(data.models);
            const models = Object.fromEntries(
                Object.entries(responseModels)
                    .filter(([, info]) => {
                        return Boolean(asObject(info).quotaInfo);
                    })
                    .map(([name, info]) => {
                        const model = asObject(info);
                        const quotaInfo = asObject(model.quotaInfo);
                        return [
                            name,
                            {
                                displayName: stringValue(model.displayName) ?? name,
                                percentage: Math.round((numberValue(quotaInfo.remainingFraction) ?? 0) * 100),
                                resetTime: stringValue(quotaInfo.resetTime) ?? '',
                            },
                        ];
                    }),
            );
            return {
                quota: { expires: token.expiry ?? '', models, ok: true, tier },
            };
        } catch (error) {
            lastError = String(error);
            if (!/HTTP (?:429|5\d\d|403)/.test(lastError)) {
                throw error;
            }
        }
    }

    return {
        quota: {
            error: `Quota API is rate-limited or unavailable${lastError ? ` (${lastError.replace(/^Error:\s*/, '')})` : ''}`,
            ok: false,
        },
    };
};
