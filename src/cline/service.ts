import { CLINE_PROVIDERS_PATH, VAULT_PATH } from '../config.ts';
import { assertAccountKey, publicError } from '../errors.ts';
import { writePrivateFile } from '../storage/file.ts';
import { readVault, updateVault } from '../storage/vault.ts';
import type { ClineSnapshot } from '../types.ts';

type ClineAccount = {
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

const parseProviderAccount = (provider: unknown): ClineAccount | null => {
    if (!isRecord(provider) || !isRecord(provider.settings) || !isRecord(provider.settings.auth)) {
        return null;
    }
    const providerName = stringValue(provider.settings.provider);
    if (providerName && providerName !== 'cline') {
        return null;
    }
    const auth = provider.settings.auth;
    const accessToken = stringValue(auth.accessToken);
    if (!accessToken) {
        return null;
    }
    const metadata = isRecord(auth.metadata) ? auth.metadata : {};
    const userInfo = isRecord(metadata.userInfo) ? metadata.userInfo : {};
    return {
        accessToken,
        accountId: stringValue(auth.accountId) ?? stringValue(metadata.accountId),
        email: stringValue(metadata.email) ?? stringValue(userInfo.email),
        id: stringValue(metadata.userId) ?? stringValue(userInfo.id),
        refreshToken: stringValue(auth.refreshToken),
    };
};

const parseProviders = (text: string) => {
    const providersFile = parseJsonRecord(text);
    if (!providersFile || !isRecord(providersFile.providers)) {
        return null;
    }
    const account = parseProviderAccount(providersFile.providers.cline);
    return account ? { account, providers: providersFile as ClineProviderFile } : null;
};

const liveFile = async () => {
    const file = Bun.file(CLINE_PROVIDERS_PATH);
    return (await file.exists()) ? { path: CLINE_PROVIDERS_PATH, text: await file.text() } : null;
};

const readValidLiveFile = async () => {
    const current = await liveFile();
    if (!current) {
        throw publicError(404, `No live Cline session found at ${CLINE_PROVIDERS_PATH}. Sign into Cline, then use Save current.`);
    }
    if (!current.text.trim()) {
        throw publicError(400, `${CLINE_PROVIDERS_PATH} is empty`);
    }
    if (!parseProviders(current.text)) {
        throw publicError(400, `${CLINE_PROVIDERS_PATH} does not contain a valid Cline account token`);
    }
    return current;
};

const jwtSubject = (token: string) => {
    const part = token.split('.')[1];
    if (!part) {
        return '';
    }
    try {
        const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sub?: unknown };
        return typeof payload.sub === 'string' ? payload.sub : '';
    } catch {
        return '';
    }
};

const identity = (account: ClineAccount) => {
    return (
        account.accountId ||
        account.id ||
        account.email ||
        (account.accessToken ? jwtSubject(account.accessToken) : '') ||
        ''
    );
};

const isSameAccount = (a: ClineAccount | null, b: ClineAccount | null) => {
    const aIdentity = a ? identity(a) : '';
    const bIdentity = b ? identity(b) : '';
    return Boolean(aIdentity && bIdentity && aIdentity === bIdentity);
};

const entry = (key: string, snap: ClineSnapshot, active: boolean) => ({
    active,
    key,
    limitUpdatedAt: '',
    quota: null,
    updatedAt: snap.updatedAt,
});

export const saveCline = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const current = await readValidLiveFile();
    await updateVault(async (vault) => {
        const existing = vault.cline.data[safeKey];
        const now = new Date().toISOString();
        vault.cline.data[safeKey] = {
            createdAt: existing?.createdAt ?? now,
            secrets: current.text,
            updatedAt: now,
        };
        delete vault.cline.limits[safeKey];
        return { result: undefined };
    });
};

export const loadCline = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const snap = (await readVault()).cline.data[safeKey];
    if (!snap) {
        throw publicError(404, `No Cline auth named ${safeKey}`);
    }
    if (!parseProviders(snap.secrets)) {
        throw publicError(500, `Saved Cline auth named ${safeKey} does not contain a valid providers file`);
    }
    await writePrivateFile(CLINE_PROVIDERS_PATH, snap.secrets);
};

export const deleteCline = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await updateVault(async (vault) => {
        if (!vault.cline.data[safeKey]) {
            throw publicError(404, `No Cline auth named ${safeKey}`);
        }
        delete vault.cline.data[safeKey];
        delete vault.cline.limits[safeKey];
        return { result: undefined };
    });
};

export const clineState = async () => {
    const vault = await readVault();
    const current = await liveFile();
    const activeAccount = current ? parseProviders(current.text)?.account ?? null : null;
    return {
        entries: Object.entries(vault.cline.data)
            .map(([key, snap]: [string, ClineSnapshot]) =>
                entry(key, snap, isSameAccount(activeAccount, parseProviders(snap.secrets)?.account ?? null)),
            )
            .sort((a, b) => {
                if (a.active !== b.active) {
                    return a.active ? -1 : 1;
                }
                return a.key.localeCompare(b.key);
            }),
        providersPath: CLINE_PROVIDERS_PATH,
        vaultPath: VAULT_PATH,
    };
};
