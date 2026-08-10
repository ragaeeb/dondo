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

type MembershipPayload = {
    base_resp?: { status_code?: number; status_msg?: string };
    op_credit_summary?: {
        total_remaining_amount?: number | string;
    };
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

export type MiniMaxCheckInDay = {
    dayNo: number;
    isToday: boolean;
    points: number;
    status: number;
};

export type MiniMaxCheckInPanel = {
    days: MiniMaxCheckInDay[];
    scene: number;
};

export type MiniMaxCheckInResult = {
    alreadyClaimed: boolean;
    claimed: boolean;
    dayNo: number;
    panel: MiniMaxCheckInPanel;
    points: number;
    status: 'claimed' | 'claimable' | 'disabled' | 'upcoming';
};

const REQUEST_TIMEOUT_MS = 15_000;
const REMAINS_PATH = '/v1/api/openplatform/coding_plan/remains';
const NO_TOKEN_PLAN_STATUS = 2062;
const USER_INFO_PATH = '/v1/api/user/info';
const USER_EXTRA_INFO_PATH = '/matrix/api/v1/user/get_user_extra_info';
const MEMBERSHIP_PATH = '/matrix/api/v1/commerce/get_membership_info';
const SIGN_IN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status';
const SIGN_IN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim';
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

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
    if (!userId) {
        return null;
    }
    const timestamp = Math.floor(Date.now() / 1_000) * 1_000;
    const unix = Math.floor(timestamp / 1_000);
    const uuid = (await uniqueUserId()) || '0';
    const params = new URLSearchParams({
        app_id: '3001',
        biz_id: '3',
        browser_name: 'Chrome',
        device_id: '12345678',
        device_platform: 'web',
        is_desktop: '1',
        lang: 'en',
        os_name: 'macOS',
        sys_language: 'en',
        timezone_offset: String(-60 * new Date().getTimezoneOffset()),
        token: accessToken,
        unix: String(timestamp),
        user_id: userId,
        uuid,
        version_code: '22201',
    });
    const requestPath = `${path}?${params}`;
    const body = method === 'POST' ? '{}' : '';
    return fetch(new URL(requestPath, MINIMAX_AGENT_URL), {
        headers: {
            'Content-Type': 'application/json',
            client: 'desktop',
            token: accessToken,
            'x-signature': md5(`${unix}${SIGNATURE_SECRET}${body}`),
            'x-timestamp': String(unix),
            yy: md5(`${encodeURIComponent(requestPath)}_${body || '{}'}${md5(String(timestamp))}ooui`),
        },
        ...(method === 'POST' ? { body } : {}),
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
};

type AgentIdentityResult = { realUserId: string } | { response: Response };

const resolveAgentIdentity = async (accessToken: string): Promise<AgentIdentityResult | null> => {
    const accountId = miniMaxTokenIdentity(accessToken);
    if (!accountId) {
        return null;
    }
    const userInfoResponse = await signedAgentRequest(accessToken, USER_INFO_PATH, 'GET', accountId);
    if (!userInfoResponse?.ok) {
        return userInfoResponse ? { response: userInfoResponse } : null;
    }
    let userInfo: UserInfoPayload;
    try {
        userInfo = (await userInfoResponse.json()) as UserInfoPayload;
    } catch {
        userInfo = {};
    }
    return { realUserId: userInfo.data?.userInfo?.realUserID ?? accountId };
};

const signedAgentExtraInfoRequest = async (accessToken: string, realUserId?: string) => {
    const identityResult = realUserId ? { realUserId } : await resolveAgentIdentity(accessToken);
    if (!identityResult) {
        return null;
    }
    if ('response' in identityResult) {
        return identityResult.response;
    }
    return signedAgentRequest(accessToken, USER_EXTRA_INFO_PATH, 'POST', identityResult.realUserId);
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
            'minimax-credits': {
                detail: `Credit: ${formatCreditBalance(state.creditBalance)}`,
                displayName: 'Credits',
                percentage: 100,
                resetTime: '',
            },
        },
        ok: true,
        tier: state.hasTokenPlan ? 'MiniMax Code' : 'MiniMax Code · free access',
    };
};

const formatCreditBalance = (value: number) => {
    return Math.floor(Math.max(0, value)).toLocaleString('en-US');
};

const creditModel = (creditBalance: number): ModelLimit => ({
    detail: `Credit: ${formatCreditBalance(creditBalance)}`,
    displayName: 'Credits',
    percentage: 100,
    resetTime: '',
});

const addCreditModel = (result: LimitResult, creditBalance: number): LimitResult => {
    if (!result.ok) {
        return result;
    }
    return {
        ...result,
        models: {
            'minimax-credits': creditModel(creditBalance),
            ...result.models,
        },
    };
};

const membershipCreditBalance = (payload: MembershipPayload, fallback: number) => {
    if (payload.base_resp?.status_code && payload.base_resp.status_code !== 0) {
        return fallback;
    }
    return Math.max(0, finiteNumber(payload.op_credit_summary?.total_remaining_amount) ?? fallback);
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
                    percentage: 100,
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

const checkInPanel = (value: unknown): MiniMaxCheckInPanel | null => {
    if (!isRecord(value)) {
        return null;
    }
    const scene = finiteNumber(value.scene);
    const rawDays = Array.isArray(value.days) ? value.days : [];
    const days = rawDays.flatMap((rawDay) => {
        if (!isRecord(rawDay)) {
            return [];
        }
        const dayNo = finiteNumber(rawDay.day_no);
        const points = finiteNumber(rawDay.points);
        const status = finiteNumber(rawDay.status);
        if (
            dayNo === undefined ||
            points === undefined ||
            status === undefined ||
            !Number.isInteger(dayNo) ||
            !Number.isInteger(status) ||
            dayNo < 1 ||
            points < 0
        ) {
            return [];
        }
        return [
            {
                dayNo,
                isToday: rawDay.is_today === true,
                points,
                status,
            },
        ];
    });
    return scene === undefined || !Number.isInteger(scene) || days.length === 0 ? null : { days, scene };
};

const checkInResponsePayload = async (response: Response, label: string) => {
    if (response.status === 401 || response.status === 403) {
        throw new Error('Saved MiniMax access token is expired or rejected');
    }
    if (!response.ok) {
        throw new Error(`MiniMax ${label} request failed with HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new Error(`MiniMax ${label} response was not valid JSON`);
    }
    const baseResponse = isRecord(payload) && isRecord(payload.base_resp) ? payload.base_resp : {};
    const statusCode = finiteNumber(baseResponse.status_code);
    if (statusCode !== undefined && statusCode !== 0) {
        throw new Error(
            typeof baseResponse.status_msg === 'string'
                ? baseResponse.status_msg
                : `MiniMax ${label} request was rejected`,
        );
    }
    return payload;
};

const checkInStatus = (status: number): MiniMaxCheckInResult['status'] => {
    if (status === 2) {
        return 'claimable';
    }
    if (status === 3) {
        return 'claimed';
    }
    if (status === 4) {
        return 'disabled';
    }
    return 'upcoming';
};

export const checkInMiniMax = async (config: MiniMaxConfig): Promise<MiniMaxCheckInResult> => {
    const accessToken = config.tokens?.accessToken;
    if (!accessToken) {
        throw new Error('Saved MiniMax config has no access token');
    }
    const identityResult = await resolveAgentIdentity(accessToken);
    if (!identityResult) {
        throw new Error('Saved MiniMax access token has no readable user identity');
    }
    if ('response' in identityResult) {
        if (identityResult.response.status === 401 || identityResult.response.status === 403) {
            throw new Error('Saved MiniMax access token is expired or rejected');
        }
        throw new Error(`MiniMax account identity request failed with HTTP ${identityResult.response.status}`);
    }

    const statusResponse = await signedAgentRequest(
        accessToken,
        SIGN_IN_STATUS_PATH,
        'GET',
        identityResult.realUserId,
    );
    if (!statusResponse) {
        throw new Error('MiniMax account state request failed');
    }
    const statusPayload = await checkInResponsePayload(statusResponse, 'check-in status');
    const statusPanel = checkInPanel(isRecord(statusPayload) ? statusPayload.data : undefined);
    if (!statusPanel) {
        throw new Error('MiniMax check-in status returned no valid schedule');
    }
    const today = statusPanel.days.find((day) => day.isToday);
    if (!today) {
        throw new Error('MiniMax check-in status returned no current day');
    }
    if (today.status !== 2) {
        return {
            alreadyClaimed: today.status === 3,
            claimed: false,
            dayNo: today.dayNo,
            panel: statusPanel,
            points: today.points,
            status: checkInStatus(today.status),
        };
    }

    const claimResponse = await signedAgentRequest(
        accessToken,
        SIGN_IN_CLAIM_PATH,
        'POST',
        identityResult.realUserId,
    );
    if (!claimResponse) {
        throw new Error('MiniMax check-in request failed');
    }
    const claimPayload = await checkInResponsePayload(claimResponse, 'check-in claim');
    const claimData = isRecord(claimPayload) && isRecord(claimPayload.data) ? claimPayload.data : {};
    const claimResult = finiteNumber(claimData.claim_result);
    if (claimResult !== 1 && claimResult !== 2) {
        throw new Error('MiniMax check-in response did not include a valid claim result');
    }
    const claimPanel = checkInPanel(claimData.panel) ?? statusPanel;
    const claimDayNo = finiteNumber(claimData.day_no);
    const claimPoints = finiteNumber(claimData.points);
    return {
        alreadyClaimed: claimResult === 2,
        claimed: claimResult === 1,
        dayNo: claimDayNo !== undefined && Number.isInteger(claimDayNo) ? claimDayNo : today.dayNo,
        panel: claimPanel,
        points: claimPoints !== undefined && claimPoints >= 0 ? claimPoints : today.points,
        status: 'claimed',
    };
};

export const fetchMiniMaxLimits = async (config: MiniMaxConfig): Promise<LimitResult> => {
    const accessToken = config.tokens?.accessToken;
    if (!accessToken) {
        return { error: 'Saved MiniMax config has no access token', ok: false };
    }
    let identityResult: AgentIdentityResult | null;
    try {
        identityResult = await resolveAgentIdentity(accessToken);
    } catch {
        return { error: 'MiniMax account state request failed', ok: false };
    }
    if (!identityResult) {
        return { error: 'Saved MiniMax access token has no readable user identity', ok: false };
    }
    if ('response' in identityResult) {
        if (identityResult.response.status === 401 || identityResult.response.status === 403) {
            return { error: 'Saved MiniMax access token is expired or rejected', ok: false };
        }
        return { error: `MiniMax account state request failed with HTTP ${identityResult.response.status}`, ok: false };
    }
    let stateResponse: Response | null;
    try {
        stateResponse = await signedAgentExtraInfoRequest(accessToken, identityResult.realUserId);
    } catch {
        return { error: 'MiniMax account state request failed', ok: false };
    }
    if (!stateResponse) {
        return { error: 'MiniMax account state request failed', ok: false };
    }
    if (!stateResponse.ok) {
        if (stateResponse.status === 401 || stateResponse.status === 403) {
            return { error: 'Saved MiniMax access token is expired or rejected', ok: false };
        }
        return { error: `MiniMax account state request failed with HTTP ${stateResponse.status}`, ok: false };
    }
    const stateResult = workspaceState((await stateResponse.json()) as WorkspacePayload);
    if ('ok' in stateResult) {
        return stateResult;
    }
    let creditBalance = stateResult.creditBalance;
    try {
        const membershipResponse = await signedAgentRequest(
            accessToken,
            MEMBERSHIP_PATH,
            'POST',
            identityResult.realUserId,
        );
        if (membershipResponse?.status === 401 || membershipResponse?.status === 403) {
            return { error: 'Saved MiniMax access token is expired or rejected', ok: false };
        }
        if (membershipResponse?.ok) {
            creditBalance = membershipCreditBalance(
                (await membershipResponse.json()) as MembershipPayload,
                creditBalance,
            );
        }
    } catch {
        // The workspace endpoint remains a valid fallback for older accounts and test fixtures.
    }
    const accountState = { ...stateResult, creditBalance };
    if (!stateResult.hasTokenPlan) {
        return workspaceToLimitResult(accountState);
    }
    const response = await fetch(new URL(REMAINS_PATH, MINIMAX_PLATFORM_URL), {
        headers: { token: accessToken },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
        return { error: 'Saved MiniMax access token is expired or rejected', ok: false };
    }
    if (!response.ok) {
        return { error: `MiniMax usage request failed with HTTP ${response.status}`, ok: false };
    }
    return addCreditModel(usageToLimitResult((await response.json()) as UsagePayload), creditBalance);
};
