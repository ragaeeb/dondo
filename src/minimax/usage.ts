import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MINIMAX_AGENT_URL, MINIMAX_LOCAL_STORAGE_PATH, MINIMAX_PLATFORM_URL, MINIMAX_UUID } from '../config.ts';
import { discardResponse, readBoundedResponseJson } from '../http.ts';
import { decodeJwtPayload } from '../jwt.ts';
import type { LimitResult, ModelLimit } from '../types.ts';

export type MiniMaxConfig = {
    [key: string]: unknown;
    tokens: { accessToken: string };
};

type Workspace = {
    has_token_plan?: boolean;
    opcredit_balance?: number | string;
    selected?: boolean;
    total_remains_credit?: number | string;
    workspace_type?: number;
};

type WorkspacePayload = {
    base_resp?: { status_code?: number };
    workspaces?: Workspace[];
};

type MembershipPayload = {
    base_resp?: { status_code?: number };
    op_credit_summary?: {
        total_remaining_amount?: number | string;
    };
};

type WorkspaceState = {
    hasTokenPlan: boolean;
};

type WorkspaceCreditState = WorkspaceState & {
    creditBalance: number;
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
const LEVELDB_SCAN_TAIL_BYTES = 320;
const MAX_LEVELDB_FILE_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_LEVELDB_SCAN_FILES = 64;
const MAX_LEVELDB_TOTAL_SCAN_BYTES = 64 * 1024 * 1024;
const UNIQUE_ID_PATTERN = /UNIQUE[\s\S]{0,220}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu;

let uniqueUserIdPromise: Promise<string> | undefined;
const checkInPromises = new Map<string, Promise<MiniMaxCheckInResult>>();

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

export const miniMaxTokenIdentity = (accessToken: string) => {
    const user = decodeJwtPayload(accessToken)?.user;
    const identity = isRecord(user) ? user.id : undefined;
    return typeof identity === 'string' && identity ? identity : '';
};

export const parseMiniMaxConfig = (text: string): MiniMaxConfig | null => {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(value) || !isRecord(value.tokens)) {
        return null;
    }
    for (const [key, tokenValue] of Object.entries(value.tokens)) {
        if (key !== 'accessToken' || typeof tokenValue !== 'string') {
            return null;
        }
    }
    const accessToken = value.tokens.accessToken;
    if (typeof accessToken !== 'string' || !accessToken.trim() || !miniMaxTokenIdentity(accessToken)) {
        return null;
    }
    return value as MiniMaxConfig;
};

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

type LevelDbScanResult = {
    bytesRead: number;
    userId: string;
};

const scanMiniMaxUniqueUserIdWithUsage = async (
    stream: ReadableStream<Uint8Array>,
    maxBytes = MAX_LEVELDB_FILE_SCAN_BYTES,
): Promise<LevelDbScanResult> => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new TypeError('MiniMax LevelDB scan byte limit must be a non-negative safe integer');
    }
    const reader = stream.getReader();
    let tail = '';
    let bytesRead = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                return { bytesRead, userId: '' };
            }
            const remaining = maxBytes - bytesRead;
            if (remaining <= 0) {
                await reader.cancel();
                return { bytesRead, userId: '' };
            }
            const boundedValue = value.subarray(0, remaining);
            const content = `${tail}${Buffer.from(boundedValue).toString('latin1')}`;
            bytesRead += boundedValue.byteLength;
            const candidate = content.match(UNIQUE_ID_PATTERN)?.[1];
            if (candidate) {
                await reader.cancel();
                return { bytesRead, userId: candidate };
            }
            tail = content.slice(-LEVELDB_SCAN_TAIL_BYTES);
            if (boundedValue.byteLength < value.byteLength || bytesRead >= maxBytes) {
                await reader.cancel();
                return { bytesRead, userId: '' };
            }
        }
    } finally {
        reader.releaseLock();
    }
};

export const scanMiniMaxUniqueUserId = async (
    stream: ReadableStream<Uint8Array>,
    maxBytes = MAX_LEVELDB_FILE_SCAN_BYTES,
) => {
    return (await scanMiniMaxUniqueUserIdWithUsage(stream, maxBytes)).userId;
};

const uniqueUserIdInFile = async (path: string, maxBytes: number) => {
    return scanMiniMaxUniqueUserIdWithUsage(Bun.file(path).stream(), maxBytes);
};

const discoverUniqueUserId = async () => {
    if (MINIMAX_UUID) {
        return MINIMAX_UUID;
    }
    try {
        const names = (await readdir(MINIMAX_LOCAL_STORAGE_PATH)).filter((name) => /\.(ldb|log)$/u.test(name));
        let remainingBytes = MAX_LEVELDB_TOTAL_SCAN_BYTES;
        for (const name of names.sort().reverse().slice(0, MAX_LEVELDB_SCAN_FILES)) {
            const maxBytes = Math.min(MAX_LEVELDB_FILE_SCAN_BYTES, remainingBytes);
            if (maxBytes <= 0) {
                break;
            }
            let result: LevelDbScanResult;
            try {
                result = await uniqueUserIdInFile(join(MINIMAX_LOCAL_STORAGE_PATH, name), maxBytes);
            } catch {
                remainingBytes -= maxBytes;
                continue;
            }
            remainingBytes -= result.bytesRead;
            if (result.userId) {
                return result.userId;
            }
        }
    } catch {
        return '';
    }
    return '';
};

export const clearMiniMaxUniqueUserIdCache = () => {
    uniqueUserIdPromise = undefined;
};

export const miniMaxUniqueUserId = async () => {
    const discovery = uniqueUserIdPromise ?? discoverUniqueUserId();
    uniqueUserIdPromise = discovery;
    try {
        return await discovery;
    } catch (error) {
        if (uniqueUserIdPromise === discovery) {
            uniqueUserIdPromise = undefined;
        }
        throw error;
    }
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
    const uuid = (await miniMaxUniqueUserId()) || '0';
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
        unix: String(unix),
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
    let value: unknown;
    try {
        value = await readBoundedResponseJson<unknown>(userInfoResponse, 'MiniMax account identity');
    } catch {
        return null;
    }
    const data = isRecord(value) && isRecord(value.data) ? value.data : {};
    const userInfo = isRecord(data.userInfo) ? data.userInfo : {};
    const realUserId = userInfo.realUserID;
    return typeof realUserId === 'string' && realUserId.trim() ? { realUserId } : null;
};

const signedAgentExtraInfoRequest = async (accessToken: string, realUserId: string) => {
    return signedAgentRequest(accessToken, USER_EXTRA_INFO_PATH, 'POST', realUserId);
};

const workspaceState = (payload: WorkspacePayload): WorkspaceState | LimitResult => {
    if (payload.base_resp?.status_code && payload.base_resp.status_code !== 0) {
        return { error: 'MiniMax account state request was rejected', ok: false };
    }
    const workspace = payload.workspaces?.find((item) => item.selected) ?? payload.workspaces?.[0];
    if (!workspace) {
        return { error: 'MiniMax account state returned no workspace', ok: false };
    }
    return {
        hasTokenPlan: workspace.has_token_plan === true,
    };
};

export const workspaceToLimitResult = (state: WorkspaceCreditState): LimitResult => {
    return {
        expires: '',
        models: { 'minimax-credits': creditModel(state.creditBalance) },
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

const membershipCreditBalance = (payload: MembershipPayload) => {
    if (payload.base_resp?.status_code && payload.base_resp.status_code !== 0) {
        return undefined;
    }
    const balance = finiteNumber(payload.op_credit_summary?.total_remaining_amount);
    return balance === undefined ? undefined : Math.max(0, balance);
};

const remainingPercentage = (value: unknown) => {
    const percent = finiteNumber(value);
    return percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(percent)));
};

const resetTime = (value: unknown) => {
    const timestamp =
        typeof value === 'number' ? value * 1_000 : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '';
    }
    const date = new Date(timestamp);
    return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
};

const totalFromBoost = (value: unknown) => {
    const boost = finiteNumber(value);
    return boost === undefined || boost <= 0 ? undefined : Math.min(Number.MAX_SAFE_INTEGER, boost) / 10;
};

const quota = (
    displayName: string,
    remaining: unknown,
    boost: unknown,
    endTime: unknown,
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
        ...(limit === undefined ? {} : { limit }),
        percentage,
        resetTime: resetTime(endTime),
        ...(limit === undefined ? {} : { used: Math.min(limit, Math.round(((100 - percentage) * limit) / 100)) }),
    };
};

export const usageToLimitResult = (payload: unknown): LimitResult => {
    const record = isRecord(payload) ? payload : {};
    const baseResponse = isRecord(record.base_resp) ? record.base_resp : {};
    const statusCode = finiteNumber(baseResponse.status_code);
    if (statusCode === NO_TOKEN_PLAN_STATUS) {
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
    if (statusCode !== undefined && statusCode !== 0) {
        return { error: 'MiniMax usage request was rejected', ok: false };
    }
    const current = Array.isArray(record.model_remains) ? record.model_remains[0] : undefined;
    if (!isRecord(current)) {
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
            points < 0 ||
            status < 1 ||
            status > 4
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
    return scene === undefined || !Number.isInteger(scene) || scene < 0 || days.length === 0 ? null : { days, scene };
};

const checkInResponsePayload = async (response: Response, label: string) => {
    if (response.status === 401 || response.status === 403) {
        await discardResponse(response);
        throw new Error('Saved MiniMax access token is expired or rejected');
    }
    if (!response.ok) {
        await discardResponse(response);
        throw new Error(`MiniMax ${label} request failed with HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
        payload = await readBoundedResponseJson(response, `MiniMax ${label}`);
    } catch {
        throw new Error(`MiniMax ${label} response was not valid JSON`);
    }
    const baseResponse = isRecord(payload) && isRecord(payload.base_resp) ? payload.base_resp : {};
    const statusCode = finiteNumber(baseResponse.status_code);
    if (statusCode !== undefined && statusCode !== 0) {
        throw new Error(`MiniMax ${label} request was rejected`);
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

const resolvedIdentity = async (accessToken: string) => {
    const identity = await resolveAgentIdentity(accessToken);
    if (!identity) {
        throw new Error('Saved MiniMax access token has no readable user identity');
    }
    if (!('response' in identity)) {
        return identity.realUserId;
    }
    await discardResponse(identity.response);
    if (identity.response.status === 401 || identity.response.status === 403) {
        throw new Error('Saved MiniMax access token is expired or rejected');
    }
    throw new Error(`MiniMax account identity request failed with HTTP ${identity.response.status}`);
};

const currentCheckIn = async (accessToken: string, realUserId: string) => {
    const response = await signedAgentRequest(accessToken, SIGN_IN_STATUS_PATH, 'GET', realUserId);
    if (!response) {
        throw new Error('MiniMax account state request failed');
    }
    const payload = await checkInResponsePayload(response, 'check-in status');
    const panel = checkInPanel(isRecord(payload) ? payload.data : undefined);
    if (!panel) {
        throw new Error('MiniMax check-in status returned no valid schedule');
    }
    const today = panel.days.find((day) => day.isToday);
    if (!today) {
        throw new Error('MiniMax check-in status returned no current day');
    }
    return { panel, today };
};

const unclaimedResult = (today: MiniMaxCheckInDay, panel: MiniMaxCheckInPanel): MiniMaxCheckInResult => ({
    alreadyClaimed: today.status === 3,
    claimed: false,
    dayNo: today.dayNo,
    panel,
    points: today.points,
    status: checkInStatus(today.status),
});

const claimedResult = async (
    accessToken: string,
    realUserId: string,
    today: MiniMaxCheckInDay,
    statusPanel: MiniMaxCheckInPanel,
): Promise<MiniMaxCheckInResult> => {
    const response = await signedAgentRequest(accessToken, SIGN_IN_CLAIM_PATH, 'POST', realUserId);
    if (!response) {
        throw new Error('MiniMax check-in request failed');
    }
    const payload = await checkInResponsePayload(response, 'check-in claim');
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
    const claimResult = finiteNumber(data.claim_result);
    if (claimResult !== 1 && claimResult !== 2) {
        throw new Error('MiniMax check-in response did not include a valid claim result');
    }
    const dayNo = finiteNumber(data.day_no);
    const points = finiteNumber(data.points);
    return {
        alreadyClaimed: claimResult === 2,
        claimed: claimResult === 1,
        dayNo: dayNo !== undefined && Number.isInteger(dayNo) && dayNo >= 1 ? dayNo : today.dayNo,
        panel: checkInPanel(data.panel) ?? statusPanel,
        points: points !== undefined && points >= 0 ? points : today.points,
        status: 'claimed',
    };
};

const performMiniMaxCheckIn = async (accessToken: string): Promise<MiniMaxCheckInResult> => {
    const realUserId = await resolvedIdentity(accessToken);
    const { panel, today } = await currentCheckIn(accessToken, realUserId);
    if (today.status !== 2) {
        return unclaimedResult(today, panel);
    }
    return claimedResult(accessToken, realUserId, today, panel);
};

export const checkInMiniMax = async (config: MiniMaxConfig): Promise<MiniMaxCheckInResult> => {
    const accessToken = config.tokens.accessToken;
    const tokenIdentity = miniMaxTokenIdentity(accessToken);
    if (!tokenIdentity) {
        throw new Error('Saved MiniMax access token has no readable user identity');
    }
    const existing = checkInPromises.get(tokenIdentity);
    if (existing) {
        return existing;
    }
    const pending = performMiniMaxCheckIn(accessToken);
    checkInPromises.set(tokenIdentity, pending);
    try {
        return await pending;
    } finally {
        if (checkInPromises.get(tokenIdentity) === pending) {
            checkInPromises.delete(tokenIdentity);
        }
    }
};

const savedTokenRejected = (): LimitResult => ({
    error: 'Saved MiniMax access token is expired or rejected',
    ok: false,
});

const agentResponseError = async (response: Response, label: string): Promise<LimitResult | null> => {
    if (response.status === 401 || response.status === 403) {
        await discardResponse(response);
        return savedTokenRejected();
    }
    if (response.ok) {
        return null;
    }
    await discardResponse(response);
    return { error: `MiniMax ${label} request failed with HTTP ${response.status}`, ok: false };
};

const fetchWorkspaceState = async (accessToken: string, realUserId: string): Promise<WorkspaceState | LimitResult> => {
    let response: Response | null;
    try {
        response = await signedAgentExtraInfoRequest(accessToken, realUserId);
    } catch {
        return { error: 'MiniMax account state request failed', ok: false };
    }
    if (!response) {
        return { error: 'MiniMax account state request failed', ok: false };
    }
    const responseError = await agentResponseError(response, 'account state');
    if (responseError) {
        return responseError;
    }
    try {
        return workspaceState(await readBoundedResponseJson<WorkspacePayload>(response, 'MiniMax account state'));
    } catch {
        return { error: 'MiniMax account state response was not valid JSON', ok: false };
    }
};

type MembershipResult = {
    creditBalance?: number;
    fatal?: LimitResult;
};

const fetchMembership = async (accessToken: string, realUserId: string): Promise<MembershipResult> => {
    let response: Response | null;
    try {
        response = await signedAgentRequest(accessToken, MEMBERSHIP_PATH, 'POST', realUserId);
    } catch {
        return {};
    }
    if (!response) {
        return {};
    }
    if (response.status === 401 || response.status === 403) {
        await discardResponse(response);
        return { fatal: savedTokenRejected() };
    }
    if (!response.ok) {
        await discardResponse(response);
        return {};
    }
    try {
        const creditBalance = membershipCreditBalance(
            await readBoundedResponseJson<MembershipPayload>(response, 'MiniMax membership'),
        );
        return creditBalance === undefined ? {} : { creditBalance };
    } catch {
        return {};
    }
};

const freeAccessResult = (): LimitResult => ({
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
});

const fetchPlanUsage = async (accessToken: string): Promise<LimitResult> => {
    let response: Response;
    try {
        response = await fetch(new URL(REMAINS_PATH, MINIMAX_PLATFORM_URL), {
            headers: { token: accessToken },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        return { error: 'MiniMax usage request failed', ok: false } as LimitResult;
    }
    const responseError = await agentResponseError(response, 'usage');
    if (responseError) {
        return responseError;
    }
    try {
        return usageToLimitResult(await readBoundedResponseJson<unknown>(response, 'MiniMax usage'));
    } catch {
        return { error: 'MiniMax usage response was not valid JSON', ok: false };
    }
};

const fetchAgentIdentity = async (accessToken: string): Promise<AgentIdentityResult | LimitResult | null> => {
    try {
        const identity = await resolveAgentIdentity(accessToken);
        if (!identity || !('response' in identity)) {
            return identity;
        }
        return (await agentResponseError(identity.response, 'account identity')) ?? null;
    } catch {
        return { error: 'MiniMax account state request failed', ok: false };
    }
};

export const fetchMiniMaxLimits = async (config: MiniMaxConfig): Promise<LimitResult> => {
    const accessToken = config.tokens.accessToken;
    const identity = await fetchAgentIdentity(accessToken);
    if (!identity) {
        return { error: 'Saved MiniMax access token has no readable user identity', ok: false };
    }
    if ('ok' in identity) {
        return identity;
    }
    if ('response' in identity) {
        return { error: 'MiniMax account identity request failed', ok: false };
    }
    const state = await fetchWorkspaceState(accessToken, identity.realUserId);
    if ('ok' in state) {
        return state;
    }
    if (!state.hasTokenPlan) {
        const membership = await fetchMembership(accessToken, identity.realUserId);
        if (membership.fatal) {
            return membership.fatal;
        }
        return membership.creditBalance === undefined
            ? freeAccessResult()
            : workspaceToLimitResult({ creditBalance: membership.creditBalance, hasTokenPlan: false });
    }
    const [membership, usage] = await Promise.all([
        fetchMembership(accessToken, identity.realUserId),
        fetchPlanUsage(accessToken),
    ]);
    if (membership.fatal) {
        return membership.fatal;
    }
    return membership.creditBalance === undefined ? usage : addCreditModel(usage, membership.creditBalance);
};
