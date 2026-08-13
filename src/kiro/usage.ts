import { KIRO_USAGE_URL, KIRO_USER_AGENT } from '../config.ts';
import { discardResponse, readBoundedResponseJson } from '../http.ts';
import type { LimitResult, ModelLimit } from '../types.ts';

type KiroUsageAuth = {
    accessToken?: string;
    profileArn?: string;
};

const REQUEST_TIMEOUT_MS = 15_000;
const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const resetIso = (value: unknown) => {
    const timestamp =
        typeof value === 'number' ? value * 1_000 : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : '';
};

const usageValue = (value: Record<string, unknown>, precise: string, fallback: string) => {
    const result = value[precise] ?? value[fallback];
    return typeof result === 'number' && Number.isFinite(result) ? Math.max(0, result) : 0;
};

const usageEndpoint = (profileArn: string) => {
    if (KIRO_USAGE_URL) {
        return KIRO_USAGE_URL;
    }
    const candidate = profileArn.split(':')[3];
    const region = candidate && AWS_REGION_RE.test(candidate) ? candidate : 'us-east-1';
    return `https://management.${region}.kiro.dev/getUsageLimits`;
};

const breakdownModel = (value: unknown, index: number, defaultReset: unknown): [string, ModelLimit] | null => {
    if (!isRecord(value)) {
        return null;
    }
    const used = usageValue(value, 'currentUsageWithPrecision', 'currentUsage');
    const limit = usageValue(value, 'usageLimitWithPrecision', 'usageLimit');
    if (limit <= 0) {
        return null;
    }
    const resourceType = typeof value.resourceType === 'string' ? value.resourceType : '';
    const displayName =
        (typeof value.displayNamePlural === 'string' && value.displayNamePlural) ||
        (typeof value.displayName === 'string' && value.displayName) ||
        resourceType ||
        'Usage';
    return [
        resourceType.toLowerCase() || `kiro-${index + 1}`,
        {
            displayName,
            limit,
            percentage: Math.max(0, Math.min(100, Math.round((1 - used / limit) * 100))),
            resetTime: resetIso(value.nextDateReset ?? defaultReset),
            used,
        },
    ];
};

export const usageToLimitResult = (payload: unknown): LimitResult => {
    const record = isRecord(payload) ? payload : {};
    const rawBreakdowns = Array.isArray(record.usageBreakdownList) ? record.usageBreakdownList : [];
    const models: Record<string, ModelLimit> = {};
    for (const [index, rawBreakdown] of rawBreakdowns.entries()) {
        const entry = breakdownModel(rawBreakdown, index, record.nextDateReset);
        if (entry) {
            models[entry[0]] = entry[1];
        }
    }

    if (Object.keys(models).length === 0) {
        return { error: 'Kiro usage returned no quota fields', ok: false };
    }

    return {
        expires: resetIso(record.nextDateReset),
        models,
        ok: true,
        tier:
            isRecord(record.subscriptionInfo) && typeof record.subscriptionInfo.subscriptionTitle === 'string'
                ? record.subscriptionInfo.subscriptionTitle
                : 'Kiro',
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
        await discardResponse(response);
        if (response.status === 401 || response.status === 403) {
            return { error: 'Saved Kiro access token is expired or rejected', ok: false };
        }
        throw new Error(`Kiro usage request failed with HTTP ${response.status}`);
    }
    return usageToLimitResult(await readBoundedResponseJson<unknown>(response, 'Kiro usage'));
};
