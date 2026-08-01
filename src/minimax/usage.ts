import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MINIMAX_AGENT_URL, MINIMAX_LOCAL_STORAGE_PATH, MINIMAX_PLATFORM_URL, MINIMAX_UUID } from '../config.ts';
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

type Workspace = {
    has_token_plan?: boolean;
    opcredit_balance?: number | string;
    selected?: boolean;
    total_remains_credit?: number | string;
    workspace_type?: number;
};

type WorkspacePayload = {
    base_resp?: { status_code?: number; status_msg?: string };
    workspaces?: Workspace[];
};

type UserInfoPayload = {
    data?: {
        userInfo?: {
            realUserID?: string;
        };
    };
};

type WorkspaceState = {
    creditBalance: number;
    hasTokenPlan: boolean;
};

const REQUEST_TIMEOUT_MS = 15_000;
const REMAINS_PATH = '/v1/api/openplatform/coding_plan/remains';
const NO_TOKEN_PLAN_STATUS = 2062;
const USER_INFO_PATH = '/v1/api/user/info';
const USER_EXTRA_INFO_PATH = '/matrix/api/v1/user/get_user_extra_info';
const SIGNATURE_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2';

const finiteNumber = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
};

const decodeTokenPayload = (accessToken: string) => {
    try {
        const encodedPayload = accessToken.split('.')[1];
        if (!encodedPayload) {
            return {} as { user?: { id?: unknown } };
        }
        return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as { user?: { id?: unknown } };
    } catch {
        return {} as { user?: { id?: unknown } };
    }
};

export const miniMaxTokenIdentity = (accessToken: string) => {
    const identity = decodeTokenPayload(accessToken).user?.id;
    return typeof identity === 'string' && identity ? identity : '';
};

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

const uniqueUserId = async () => {
    if (MINIMAX_UUID) {
        return MINIMAX_UUID;
    }
    try {
        const names = (await readdir(MINIMAX_LOCAL_STORAGE_PATH)).filter((name) => /\.(ldb|log)$/u.test(name));
        for (const name of names.sort().reverse()) {
            const text = Buffer.from(await Bun.file(join(MINIMAX_LOCAL_STORAGE_PATH, name)).arrayBuffer()).toString('latin1');
            const marker = text.indexOf('UNIQUE');
            const candidate = marker >= 0 ? text.slice(marker, marker + 220).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu)?.[0] : undefined;
            if (candidate) {
                return candidate;
            }
        }
    } catch {
        return '';
    }
    return '';
};

const signedAgentRequest = async (
    accessToken: string,
    path: string,
    method: 'GET' | 'POST',
    userId: string,
): Promise<Response | null> => {
    const uuid = await uniqueUserId();
    if (!userId || !uuid) {
        return null;
    }
    const unix = Math.floor(Date.now() / 1_000);
    const params = new URLSearchParams({
        app_id: '3001',
        biz_id: '3',
        browser_name: 'Chrome',
        device_id: '12345678',
        device_platform: 'web',
        lang: 'en',
        os_name: 'macOS',
        sys_language: 'en',
        timezone_offset: String(-new Date().getTimezoneOffset()),
        token: accessToken,
        unix: String(unix),
        user_id: userId,
        uuid,
        version_code: '22201',
    });
    const requestPath = `${path}?${params}`;
    const body = '{}';
    return fetch(new URL(requestPath, MINIMAX_AGENT_URL), {
        headers: {
            'Content-Type': 'application/json',
            token: accessToken,
            'x-signature': md5(`${unix}${SIGNATURE_SECRET}${body}`),
            'x-timestamp': String(unix),
            yy: md5(`${encodeURIComponent(requestPath)}_${body}${md5(String(unix))}ooui`),
        },
        ...(method === 'POST' ? { body } : {}),
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
};

const signedAgentExtraInfoRequest = async (accessToken: string) => {
    const accountId = miniMaxTokenIdentity(accessToken);
    if (!accountId) {
        return null;
    }
    const userInfoResponse = await signedAgentRequest(accessToken, USER_INFO_PATH, 'GET', accountId);
    if (!userInfoResponse?.ok) {
        return userInfoResponse;
    }
    const userInfo = (await userInfoResponse.json()) as UserInfoPayload;
    const realUserId = userInfo.data?.userInfo?.realUserID ?? accountId;
    return signedAgentRequest(accessToken, USER_EXTRA_INFO_PATH, 'POST', realUserId);
};

const workspaceState = (payload: WorkspacePayload): WorkspaceState | LimitResult => {
    if (payload.base_resp?.status_code && payload.base_resp.status_code !== 0) {
        return { error: payload.base_resp.status_msg ?? 'MiniMax account state request was rejected', ok: false };
    }
    const workspace = payload.workspaces?.find((item) => item.selected) ?? payload.workspaces?.[0];
    if (!workspace) {
        return { error: 'MiniMax account state returned no workspace', ok: false };
    }
    return {
        creditBalance: Math.max(
            0,
            finiteNumber(workspace.opcredit_balance) ?? finiteNumber(workspace.total_remains_credit) ?? 0,
        ),
        hasTokenPlan: workspace.has_token_plan === true,
    };
};

export const workspaceToLimitResult = (state: WorkspaceState): LimitResult => {
    return {
        expires: '',
        models: {
            'minimax-free-daily': {
                detail: 'Token valid · MiniMax does not report a free daily quota',
                displayName: 'Free daily quota',
                percentage: 100,
                resetTime: '',
            },
        },
        ok: true,
        tier: state.hasTokenPlan ? 'MiniMax Code' : 'MiniMax Code · free access',
    };
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
    let stateResponse: Response | null;
    try {
        stateResponse = await signedAgentExtraInfoRequest(accessToken);
    } catch {
        return { error: 'MiniMax account state request failed', ok: false };
    }
    if (!stateResponse) {
        return { error: 'Saved MiniMax access token has no readable user identity', ok: false };
    }
    if (stateResponse.status === 401 || stateResponse.status === 403) {
        return { error: 'Saved MiniMax access token is expired or rejected', ok: false };
    }
    if (!stateResponse.ok) {
        return { error: `MiniMax account state request failed with HTTP ${stateResponse.status}`, ok: false };
    }
    const stateResult = workspaceState((await stateResponse.json()) as WorkspacePayload);
    if ('ok' in stateResult) {
        return stateResult;
    }
    if (!stateResult.hasTokenPlan) {
        return workspaceToLimitResult(stateResult);
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
