import { decodeJwtPayload } from '../jwt.ts';

export type CodexAuth = {
    OPENAI_API_KEY?: string | null;
    auth_mode: 'apikey' | 'chatgpt';
    last_refresh?: string | null;
    tokens?: {
        access_token: string;
        account_id?: string | null;
        id_token: string;
        refresh_token: string;
    } | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());

const idTokenClaimIdentity = (token: string) => {
    const payload = decodeJwtPayload(token);
    if (!payload) {
        return '';
    }
    const auth = isRecord(payload['https://api.openai.com/auth']) ? payload['https://api.openai.com/auth'] : {};
    for (const value of [auth.chatgpt_account_id, auth.chatgpt_user_id, auth.user_id, payload.sub]) {
        if (nonEmptyString(value)) {
            return value;
        }
    }
    return '';
};

const parsedRecord = (text: string) => {
    try {
        const value = JSON.parse(text) as unknown;
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
};

const isOptionalString = (value: unknown) => value === undefined || value === null || typeof value === 'string';

const optionalTokensValid = (tokens: unknown) => {
    if (tokens === undefined || tokens === null) {
        return true;
    }
    if (!isRecord(tokens)) {
        return false;
    }
    return ['access_token', 'account_id', 'id_token', 'refresh_token'].every((field) =>
        isOptionalString(tokens[field]),
    );
};

const optionalFieldsValid = (value: Record<string, unknown>) => {
    return (
        isOptionalString(value.OPENAI_API_KEY) &&
        isOptionalString(value.last_refresh) &&
        optionalTokensValid(value.tokens)
    );
};

const chatGptTokensValid = (tokens: Record<string, unknown>) => {
    return (
        nonEmptyString(tokens.access_token) &&
        nonEmptyString(tokens.id_token) &&
        nonEmptyString(tokens.refresh_token) &&
        (tokens.account_id === undefined || tokens.account_id === null || typeof tokens.account_id === 'string')
    );
};

const resolvedAuthMode = (value: Record<string, unknown>): CodexAuth['auth_mode'] | null => {
    if (value.auth_mode === undefined) {
        if (nonEmptyString(value.OPENAI_API_KEY)) {
            return 'apikey';
        }
        return isRecord(value.tokens) ? 'chatgpt' : null;
    }
    return value.auth_mode === 'apikey' || value.auth_mode === 'chatgpt' ? value.auth_mode : null;
};

export const parseCodexAuth = (text: string): CodexAuth | null => {
    const value = parsedRecord(text);
    const authMode = value ? resolvedAuthMode(value) : null;
    if (!value || !authMode || !optionalFieldsValid(value)) {
        return null;
    }
    if (authMode === 'apikey') {
        return nonEmptyString(value.OPENAI_API_KEY) ? ({ ...value, auth_mode: authMode } as CodexAuth) : null;
    }
    if (!isRecord(value.tokens)) {
        return null;
    }
    const tokens = value.tokens;
    if (!chatGptTokensValid(tokens)) {
        return null;
    }
    return { ...value, auth_mode: authMode } as CodexAuth;
};

export const codexAuthIdentity = (auth: CodexAuth | null) => {
    if (auth?.auth_mode !== 'chatgpt') {
        return auth?.OPENAI_API_KEY ?? '';
    }
    const tokens = auth.tokens;
    return tokens?.account_id || (tokens?.id_token ? idTokenClaimIdentity(tokens.id_token) || tokens.id_token : '');
};
