export const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
    const parts = token.split('.');
    const encoded = parts[1];
    if (parts.length !== 3 || parts.some((part) => !part) || !encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
        return null;
    }
    try {
        const decoded = Buffer.from(encoded, 'base64url');
        if (decoded.toString('base64url') !== encoded) {
            return null;
        }
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)) as unknown;
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
};
