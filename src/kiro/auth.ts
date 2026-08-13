export type KiroAuth = {
    [key: string]: unknown;
    accessToken?: string;
    authMethod?: string;
    clientIdHash?: string;
    expiresAt?: string;
    profileArn?: string;
    provider?: string;
    refreshToken: string;
};

type KiroSnapshotConfig = {
    auth: string;
    clientRegistration?: string;
    profile?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const parseKiroAuth = (auth: string): KiroAuth | null => {
    try {
        const value = JSON.parse(auth) as unknown;
        if (!isRecord(value)) {
            return null;
        }
        for (const field of [
            'accessToken',
            'authMethod',
            'clientIdHash',
            'expiresAt',
            'profileArn',
            'provider',
            'refreshToken',
        ] as const) {
            if (value[field] !== undefined && typeof value[field] !== 'string') {
                return null;
            }
        }
        return typeof value.refreshToken === 'string' && value.refreshToken.trim() ? (value as KiroAuth) : null;
    } catch {
        return null;
    }
};

export const parseKiroJsonObject = (text: string) => {
    try {
        const value = JSON.parse(text) as unknown;
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
};

export const isKiroSnapshotConfigValid = (snapshot: KiroSnapshotConfig) => {
    return (
        parseKiroAuth(snapshot.auth) !== null &&
        (snapshot.profile === undefined || parseKiroJsonObject(snapshot.profile) !== null) &&
        (snapshot.clientRegistration === undefined || parseKiroJsonObject(snapshot.clientRegistration) !== null)
    );
};
