import type { LimitResult } from './types.ts';

export type PublicError = Error & {
    status: number;
};

export const publicError = (status: number, message: string): PublicError => {
    return Object.assign(new Error(message), { status });
};

export const redactSecrets = (value: unknown) => {
    return String(value)
        .replace(/Bearer\s+[^"\s]+/g, 'Bearer [redacted]')
        .replace(/password:\s*"[^"]*"/gi, 'password: "[redacted]"')
        .replace(
            /(["']?(?:access_token|refresh_token|id_token|accessToken|OPENAI_API_KEY)["']?\s*[:=]\s*["'])[^"']+(["'])/gi,
            '$1[redacted]$2',
        );
};

export const errorMessage = (error: unknown) => {
    return redactSecrets(error instanceof Error ? error.message : String(error));
};

export const errorStatus = (error: unknown) => {
    return typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status: unknown }).status) || 500
        : 500;
};

export const cleanLimitError = (error: unknown): LimitResult => ({
    error: errorMessage(error),
    ok: false,
});

export const assertAccountKey = (key: string) => {
    const trimmed = key.trim();
    if (trimmed !== key || !/^[\w .@-]{1,80}$/.test(trimmed)) {
        throw publicError(400, 'Use 1-80 letters, numbers, spaces, dots, @, _ or - with no leading/trailing spaces');
    }
    return trimmed;
};
