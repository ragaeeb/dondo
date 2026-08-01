import { MINIMAX_PLATFORM_URL } from '../config.ts';
import type { LimitResult, ModelLimit } from '../types.ts';

export type MiniMaxConfig = {
    tokens?: { accessToken?: string };
};

type ModelRemains = {
    current_interval_remaining_percent?: number;
    current_interval_status?: number;
    current_weekly_remaining_percent?: number;
    current_weekly_status?: number;
    end_time?: number | string;
    interval_boost_permille?: number;
    model_name?: string;
    weekly_boost_permille?: number;
    weekly_end_time?: number | string;
};

type UsagePayload = {
    base_resp?: { status_code?: number; status_msg?: string };
    model_remains?: ModelRemains[];
};

const REQUEST_TIMEOUT_MS = 15_000;
const REMAINS_PATH = '/v1/api/openplatform/coding_plan/remains';
const NO_TOKEN_PLAN_STATUS = 2062;

const finiteNumber = (value: unknown) => {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const remainingPercentage = (value: unknown) => {
    const percent = finiteNumber(value);
    return percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(percent)));
};

const resetTime = (value: number | string | undefined) => {
    const timestamp = typeof value === 'number' ? value * 1_000 : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : '';
};

const totalFromBoost = (value: unknown) => {
    const boost = finiteNumber(value);
    return boost === undefined ? 100 : boost / 10;
};

const quota = (
    displayName: string,
    remaining: unknown,
    boost: unknown,
    endTime: number | string | undefined,
    status: unknown,
): ModelLimit | undefined => {
    if (status === 3) {
        return { detail: 'Unlimited', displayName, percentage: 100, resetTime: resetTime(endTime) };
    }
    const percentage = remainingPercentage(remaining);
    if (percentage === undefined) {
        return undefined;
    }
    const limit = totalFromBoost(boost);
    return {
        displayName,
        limit,
        percentage,
        resetTime: resetTime(endTime),
        used: Math.round(((100 - percentage) * limit) / 100),
    };
};

export const usageToLimitResult = (payload: UsagePayload): LimitResult => {
    if (payload.base_resp?.status_code === NO_TOKEN_PLAN_STATUS) {
        return {
            expires: '',
            models: {
                'minimax-free-access': {
                    detail: 'MiniMax does not report a numeric allowance for non-plan access',
                    displayName: 'Free / non-plan access',
                    percentage: 0,
                    resetTime: '',
                },
            },
            ok: true,
            tier: 'MiniMax Code · no token plan',
        };
    }
    if (payload.base_resp?.status_code && payload.base_resp.status_code !== 0) {
        return { error: payload.base_resp.status_msg ?? 'MiniMax usage request was rejected', ok: false };
    }
    const current = payload.model_remains?.[0];
    if (!current) {
        return { error: 'MiniMax usage returned no quota fields', ok: false };
    }

    const models: Record<string, ModelLimit> = {};
    const interval = quota(
        '5-hour quota',
        current.current_interval_remaining_percent,
        current.interval_boost_permille,
        current.end_time,
        current.current_interval_status,
    );
    const weekly = quota(
        'Weekly quota',
        current.current_weekly_remaining_percent,
        current.weekly_boost_permille,
        current.weekly_end_time,
        current.current_weekly_status,
    );
    if (interval) {
        models['minimax-5-hour'] = interval;
    }
    if (weekly) {
        models['minimax-weekly'] = weekly;
    }
    if (Object.keys(models).length === 0) {
        return { error: 'MiniMax usage returned no quota fields', ok: false };
    }
    return { expires: weekly?.resetTime ?? interval?.resetTime ?? '', models, ok: true, tier: 'MiniMax Code' };
};

export const fetchMiniMaxLimits = async (config: MiniMaxConfig): Promise<LimitResult> => {
    const accessToken = config.tokens?.accessToken;
    if (!accessToken) {
        return { error: 'Saved MiniMax config has no access token', ok: false };
    }
    const response = await fetch(new URL(REMAINS_PATH, MINIMAX_PLATFORM_URL), {
        headers: { token: accessToken },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
        return { error: 'Saved MiniMax access token is expired or rejected', ok: false };
    }
    if (!response.ok) {
        throw new Error(`MiniMax usage request failed with HTTP ${response.status}`);
    }
    return usageToLimitResult((await response.json()) as UsagePayload);
};
