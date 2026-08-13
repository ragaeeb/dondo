export type ClineAccount = {
    accessToken?: string;
    accountId?: string;
    email?: string;
    id?: string;
    refreshToken?: string;
};

type ClineProviderFile = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const parseJsonRecord = (text: string) => {
    try {
        const value = JSON.parse(text) as unknown;
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
};

const stringValue = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

const hasValidOptionalStrings = (record: Record<string, unknown>, keys: readonly string[]) => {
    return keys.every((key) => record[key] === undefined || typeof record[key] === 'string');
};

const providerSettings = (provider: unknown) => {
    if (!isRecord(provider) || !isRecord(provider.settings) || !isRecord(provider.settings.auth)) {
        return null;
    }
    return hasValidOptionalStrings(provider.settings, ['provider']) ? provider.settings : null;
};

const providerMetadata = (auth: Record<string, unknown>) => {
    if (auth.metadata !== undefined && !isRecord(auth.metadata)) {
        return null;
    }
    const metadata = isRecord(auth.metadata) ? auth.metadata : {};
    if (!hasValidOptionalStrings(metadata, ['accountId', 'email', 'userId'])) {
        return null;
    }
    if (metadata.userInfo !== undefined && !isRecord(metadata.userInfo)) {
        return null;
    }
    const userInfo = isRecord(metadata.userInfo) ? metadata.userInfo : {};
    return hasValidOptionalStrings(userInfo, ['email', 'id']) ? { metadata, userInfo } : null;
};

const parseProviderAccount = (provider: unknown): ClineAccount | null => {
    const settings = providerSettings(provider);
    if (!settings) {
        return null;
    }
    const providerName = stringValue(settings.provider);
    if (providerName && providerName !== 'cline') {
        return null;
    }
    const auth = settings.auth as Record<string, unknown>;
    if (!hasValidOptionalStrings(auth, ['accessToken', 'accountId', 'refreshToken'])) {
        return null;
    }
    const accessToken = stringValue(auth.accessToken);
    const context = providerMetadata(auth);
    if (!accessToken || !context) {
        return null;
    }
    const { metadata, userInfo } = context;
    const accountId = stringValue(auth.accountId) ?? stringValue(metadata.accountId);
    const email = stringValue(metadata.email) ?? stringValue(userInfo.email);
    const id = stringValue(metadata.userId) ?? stringValue(userInfo.id);
    const refreshToken = stringValue(auth.refreshToken);
    return {
        accessToken,
        ...(accountId ? { accountId } : {}),
        ...(email ? { email } : {}),
        ...(id ? { id } : {}),
        ...(refreshToken ? { refreshToken } : {}),
    };
};

export const parseClineProviders = (text: string) => {
    const providersFile = parseJsonRecord(text);
    if (!providersFile || !isRecord(providersFile.providers)) {
        return null;
    }
    const account = parseProviderAccount(providersFile.providers.cline);
    return account ? { account, providers: providersFile as ClineProviderFile } : null;
};
