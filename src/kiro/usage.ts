import { KIRO_USAGE_URL, KIRO_USER_AGENT } from '../config.ts';
import type { LimitResult, ModelLimit } from '../types.ts';

type KiroUsageAuth = {
    accessToken?: string;
    profileArn?: string;
};

type UsageBreakdown = {
    currentUsage?: number;
    currentUsageWithPrecision?: number;
    displayName?: string;
    displayNamePlural?: string;
    nextDateReset?: number | string;
    resourceType?: string;
    usageLimit?: number;
    usageLimitWithPrecision?: number;
};

type KiroUsagePayload = {
    nextDateReset?: number | string;
    subscriptionInfo?: { subscriptionTitle?: string };
    usageBreakdownList?: UsageBreakdown[];
};

const REQUEST_TIMEOUT_MS = 15_000;

const resetIso = (value: number | string | undefined) => {
    const timestamp =
        typeof value === 'number' ? value * 1_000 : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : '';
};

const usageValue = (value: UsageBreakdown, precise: keyof UsageBreakdown, fallback: keyof UsageBreakdown) => {
    const result = value[precise] ?? value[fallback];
    return typeof result === 'number' && Number.isFinite(result) ? result : 0;
};

const usageEndpoint = (profileArn: string) => {
    if (KIRO_USAGE_URL) {
        return KIRO_USAGE_URL;
    }
    const region = profileArn.split(':')[3] || 'us-east-1';
    return `https://management.${region}.kiro.dev/getUsageLimits`;
};

export const usageToLimitResult = (payload: KiroUsagePayload): LimitResult => {
    const models: Record<string, ModelLimit> = {};
    for (const [index, breakdown] of (payload.usageBreakdownList ?? []).entries()) {
        const used = usageValue(breakdown, 'currentUsageWithPrecision', 'currentUsage');
        const limit = usageValue(breakdown, 'usageLimitWithPrecision', 'usageLimit');
        if (limit <= 0) {
            continue;
        }
        const key = breakdown.resourceType?.toLowerCase() || `kiro-${index + 1}`;
        models[key] = {
            displayName: breakdown.displayNamePlural ?? breakdown.displayName ?? breakdown.resourceType ?? 'Usage',
            limit,
            percentage: Math.max(0, Math.min(100, Math.round((1 - used / limit) * 100))),
            resetTime: resetIso(breakdown.nextDateReset ?? payload.nextDateReset),
            used,
        };
    }

    return {
        expires: resetIso(payload.nextDateReset),
        models,
        ok: true,
        tier: payload.subscriptionInfo?.subscriptionTitle ?? 'Kiro',
    };
};

export const fetchKiroLimits = async (auth: KiroUsageAuth): Promise<LimitResult> => {
    if (!auth.accessToken || !auth.profileArn) {
        return { error: 'Saved Kiro session has no access token or profile', ok: false };
    }

    const url = new URL(usageEndpoint(auth.profileArn));
    url.searchParams.set('origin', 'AI_EDITOR');
    url.searchParams.set('profileArn', auth.profileArn);
    url.searchParams.set('resourceType', 'AGENTIC_REQUEST');
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'User-Agent': KIRO_USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            return { error: 'Saved Kiro access token is expired or rejected', ok: false };
        }
        throw new Error(`Kiro usage request failed with HTTP ${response.status}`);
    }
    return usageToLimitResult((await response.json()) as KiroUsagePayload);
};
