import { CODEX_USAGE_URL, CODEX_USER_AGENT } from '../config.ts';
import { publicError } from '../errors.ts';
import type { LimitResult } from '../types.ts';

type CodexAuth = {
    OPENAI_API_KEY?: string | null;
    auth_mode?: string;
    tokens?: {
        access_token?: string;
        account_id?: string;
        id_token?: string;
        refresh_token?: string;
    };
    last_refresh?: string;
};

type CodexUsagePayload = {
    plan_type?: string;
    rate_limit?: {
        primary_window?: CodexWindow | null;
        secondary_window?: CodexWindow | null;
    } | null;
    credits?: {
        balance?: string | null;
        has_credits?: boolean;
        unlimited?: boolean;
    } | null;
};

type CodexWindow = {
    limit_window_seconds?: number | null;
    reset_at?: number | null;
    used_percent?: number;
};

type CodexLimitFetch = {
    quota: LimitResult;
};

const REQUEST_TIMEOUT_MS = 15_000;
const EXPIRY_GRACE_SECONDS = 60;

const parseAuth = (auth: string): CodexAuth => {
    try {
        return JSON.parse(auth) as CodexAuth;
    } catch {
        throw publicError(400, 'Saved Codex auth JSON is malformed');
    }
};

const parseJwtPayload = (token: string): Record<string, unknown> | null => {
    const part = token.split('.')[1];
    if (!part) {
        return null;
    }
    try {
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
};

const accessTokenExpired = (token: string) => {
    const exp = parseJwtPayload(token)?.exp;
    return typeof exp === 'number' && exp <= Math.floor(Date.now() / 1000) + EXPIRY_GRACE_SECONDS;
};

const staleTokenQuota = (provider: string) => ({
    error: `Saved ${provider} access token is expired or rejected. Use this account in ${provider}, then click Sync current on this saved row.`,
    ok: false as const,
});

const codexHeaders = (accessToken: string, accountId?: string) => ({
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': CODEX_USER_AGENT,
});

const resetIso = (resetAt?: number | null) => (resetAt ? new Date(resetAt * 1000).toISOString() : '');

const windowSuffix = (minutes: number) => {
    if (minutes <= 0) {
        return '';
    }
    if (minutes >= 10_080) {
        return 'weekly';
    }
    if (minutes >= 60) {
        return `${Math.round(minutes / 60)}h`;
    }
    return `${minutes}m`;
};

const windowLabel = (fallback: string, suffix: string) => {
    if (suffix === 'weekly') {
        return 'Weekly Limit';
    }
    if (suffix === '5h') {
        return '5h Limit';
    }
    return fallback;
};

const windowLimit = (fallbackLabel: string, window?: CodexWindow | null) => {
    if (!window || typeof window.used_percent !== 'number') {
        return null;
    }
    const minutes = window.limit_window_seconds ? Math.ceil(window.limit_window_seconds / 60) : 0;
    const suffix = windowSuffix(minutes);
    return {
        displayName: `${windowLabel(fallbackLabel, suffix)}${suffix ? ` (${suffix})` : ''}`,
        percentage: Math.max(0, Math.min(100, Math.round(100 - window.used_percent))),
        resetTime: resetIso(window.reset_at),
    };
};

export const usageToLimitResult = (payload: CodexUsagePayload): LimitResult => {
    const entries: [string, NonNullable<ReturnType<typeof windowLimit>>][] = [];
    const primary = windowLimit('Primary Limit', payload.rate_limit?.primary_window);
    const secondary = windowLimit('Secondary Limit', payload.rate_limit?.secondary_window);

    if (primary) {
        entries.push(['codex-primary', primary]);
    }
    if (secondary) {
        entries.push(['codex-secondary', secondary]);
    }
    if (payload.credits?.balance) {
        entries.push([
            'codex-credits',
            {
                displayName: `Credits ${payload.credits.balance}`,
                percentage: payload.credits.unlimited ? 100 : payload.credits.has_credits ? 100 : 0,
                resetTime: '',
            },
        ]);
    }

    return {
        expires: '',
        models: Object.fromEntries(entries),
        ok: true,
        tier: payload.plan_type ?? '',
    };
};

const requestUsage = async (auth: CodexAuth) => {
    const accessToken = auth.tokens?.access_token;
    if (!accessToken) {
        return { error: 'No Codex access token in snapshot', ok: false as const };
    }
    if (accessTokenExpired(accessToken)) {
        return staleTokenQuota('Codex');
    }

    const res = await fetch(CODEX_USAGE_URL, {
        headers: codexHeaders(accessToken, auth.tokens?.account_id),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        if (res.status === 401) {
            return staleTokenQuota('Codex');
        }
        throw new Error(`HTTP ${res.status}`);
    }
    return usageToLimitResult((await res.json()) as CodexUsagePayload);
};

export const fetchCodexLimits = async (authText: string): Promise<CodexLimitFetch> => {
    const auth = parseAuth(authText);
    if (auth.auth_mode === 'apikey' || auth.auth_mode === 'api_key' || auth.OPENAI_API_KEY) {
        return { quota: { error: 'Codex usage is only available for ChatGPT login accounts', ok: false } };
    }

    return { quota: await requestUsage(auth) };
};
