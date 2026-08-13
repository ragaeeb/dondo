import type { LimitResult } from './types.ts';

export type PublicError = Error & {
    public: true;
    status: number;
};

export const publicError = (status: number, message: string): PublicError => {
    return Object.assign(new Error(message), { public: true as const, status });
};

export const isPublicError = (error: unknown): error is PublicError => {
    if (!(error instanceof Error) || !('public' in error) || error.public !== true || !('status' in error)) {
        return false;
    }
    const status = error.status;
    return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
};

export const redactSecrets = (value: unknown) => {
    return String(value)
        .replace(/Bearer\s+[^"\s]+/g, 'Bearer [redacted]')
        .replace(/password:\s*"[^"]*"/gi, 'password: "[redacted]"')
        .replace(
            /(["']?(?:access_?token|refresh_?token|id_?token|client_?secret|api_?key|openai_api_key|password|authorization)["']?\s*[:=]\s*["'])[^"']*(["'])/gi,
            '$1[redacted]$2',
        )
        .replace(
            /(["']?(?:access_?token|refresh_?token|id_?token|client_?secret|api_?key|openai_api_key|password|authorization)["']?\s*[:=]\s*)(?!["'])[^&\s,;}]+/gi,
            '$1[redacted]',
        )
        .replace(/(\btoken\s*=\s*)[^&\s]+/gi, '$1[redacted]');
};

export const errorMessage = (error: unknown) => {
    return redactSecrets(error instanceof Error ? error.message : String(error));
};

export const errorStatus = (error: unknown) => {
    return isPublicError(error) ? error.status : 500;
};

export const cleanLimitError = (error: unknown): LimitResult => ({
    error: isPublicError(error) ? errorMessage(error) : 'Could not refresh usage limits',
    ok: false,
});

export const assertAccountKey = (key: string) => {
    const trimmed = key.trim();
    const reserved = ['__proto__', 'constructor', 'prototype'].includes(trimmed);
    if (reserved || trimmed !== key || !/^[\w .@-]{1,80}$/.test(trimmed)) {
        throw publicError(400, 'Use 1-80 letters, numbers, spaces, dots, @, _ or - with no leading/trailing spaces');
    }
    return trimmed;
};
