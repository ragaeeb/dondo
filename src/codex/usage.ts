import { CODEX_USAGE_URL, CODEX_USER_AGENT } from '../config.ts';
import { publicError } from '../errors.ts';
import { discardResponse, readBoundedResponseJson } from '../http.ts';
import { decodeJwtPayload } from '../jwt.ts';
import type { LimitResult } from '../types.ts';
import { type CodexAuth, parseCodexAuth } from './auth.ts';

type CodexLimitFetch = {
    quota: LimitResult;
};

const REQUEST_TIMEOUT_MS = 15_000;
const EXPIRY_GRACE_SECONDS = 60;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const accessTokenExpired = (token: string) => {
    const exp = decodeJwtPayload(token)?.exp;
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

const resetIso = (resetAt?: number | null) => {
    if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt <= 0) {
        return '';
    }
    const date = new Date(resetAt * 1_000);
    return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
};

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

const windowLimit = (fallbackLabel: string, value: unknown) => {
    if (!isRecord(value) || typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent)) {
        return null;
    }
    const seconds = value.limit_window_seconds;
    const minutes =
        typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 0;
    const suffix = windowSuffix(minutes);
    return {
        displayName: `${windowLabel(fallbackLabel, suffix)}${suffix ? ` (${suffix})` : ''}`,
        percentage: Math.max(0, Math.min(100, Math.round(100 - value.used_percent))),
        resetTime: resetIso(typeof value.reset_at === 'number' ? value.reset_at : undefined),
    };
};

export const usageToLimitResult = (payload: unknown): LimitResult => {
    const record = isRecord(payload) ? payload : {};
    const rateLimit = isRecord(record.rate_limit) ? record.rate_limit : {};
    const credits = isRecord(record.credits) ? record.credits : {};
    const balance = typeof credits.balance === 'string' && credits.balance ? credits.balance : undefined;
    const entries: [string, NonNullable<ReturnType<typeof windowLimit>>][] = [];
    const primary = windowLimit('Primary Limit', rateLimit.primary_window);
    const secondary = windowLimit('Secondary Limit', rateLimit.secondary_window);

    if (primary) {
        entries.push(['codex-primary', primary]);
    }
    if (secondary) {
        entries.push(['codex-secondary', secondary]);
    }
    if (balance) {
        entries.push([
            'codex-credits',
            {
                displayName: `Credits ${balance}`,
                percentage: credits.unlimited === true || credits.has_credits === true ? 100 : 0,
                resetTime: '',
            },
        ]);
    }

    if (entries.length === 0) {
        return { error: 'Codex usage returned no quota fields', ok: false };
    }

    return {
        expires: '',
        models: Object.fromEntries(entries),
        ok: true,
        tier: typeof record.plan_type === 'string' ? record.plan_type : '',
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
        headers: codexHeaders(accessToken, auth.tokens?.account_id ?? undefined),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        await discardResponse(res);
        if (res.status === 401) {
            return staleTokenQuota('Codex');
        }
        throw new Error(`HTTP ${res.status}`);
    }
    return usageToLimitResult(await readBoundedResponseJson<unknown>(res, 'Codex usage'));
};

export const fetchCodexLimits = async (authText: string): Promise<CodexLimitFetch> => {
    const auth = parseCodexAuth(authText);
    if (!auth) {
        throw publicError(400, 'Saved Codex auth JSON is invalid or incomplete');
    }
    if (auth.auth_mode === 'apikey') {
        return { quota: { error: 'Codex usage is only available for ChatGPT login accounts', ok: false } };
    }

    return { quota: await requestUsage(auth) };
};
