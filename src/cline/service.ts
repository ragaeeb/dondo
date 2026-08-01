import { CLINE_SECRETS_PATH, VAULT_PATH } from '../config.ts';
import { assertAccountKey, publicError } from '../errors.ts';
import { writePrivateFile } from '../storage/file.ts';
import { readVault, updateVault } from '../storage/vault.ts';
import type { ClineSnapshot } from '../types.ts';

const CLINE_ACCOUNT_KEY = 'cline:clineAccountId';

type ClineAccount = {
    idToken?: string;
    refreshToken?: string;
    userInfo?: {
        email?: string;
        id?: string;
    };
};

type ClineSecrets = Record<string, unknown>;

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

const parseAccount = (secrets: ClineSecrets): ClineAccount | null => {
    const raw = secrets[CLINE_ACCOUNT_KEY];
    if (typeof raw !== 'string' || !raw.trim()) {
        return null;
    }
    const account = parseJsonRecord(raw);
    return typeof account?.idToken === 'string' && account.idToken ? (account as ClineAccount) : null;
};

const parseSecrets = (text: string) => {
    const secrets = parseJsonRecord(text);
    if (!secrets) {
        return null;
    }
    const account = parseAccount(secrets);
    return account ? { account, secrets } : null;
};

const liveSecrets = async () => {
    const file = Bun.file(CLINE_SECRETS_PATH);
    return (await file.exists()) ? await file.text() : '';
};

const readValidLiveSecrets = async () => {
    const file = Bun.file(CLINE_SECRETS_PATH);
    if (!(await file.exists())) {
        throw publicError(404, `No live Cline session found. Sign into Cline, then use Save current.`);
    }
    const text = await file.text();
    if (!text.trim()) {
        throw publicError(400, `${CLINE_SECRETS_PATH} is empty`);
    }
    const parsed = parseSecrets(text);
    if (!parsed) {
        throw publicError(400, `${CLINE_SECRETS_PATH} does not contain a valid Cline account token`);
    }
    return text;
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
    return account.userInfo?.id || account.userInfo?.email || (account.idToken ? jwtSubject(account.idToken) : '') || '';
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
    const secrets = await readValidLiveSecrets();
    await updateVault(async (vault) => {
        const existing = vault.cline.data[safeKey];
        const now = new Date().toISOString();
        vault.cline.data[safeKey] = {
            createdAt: existing?.createdAt ?? now,
            secrets,
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
    if (!parseSecrets(snap.secrets)) {
        throw publicError(500, `Saved Cline auth named ${safeKey} does not contain a valid account token`);
    }
    await writePrivateFile(CLINE_SECRETS_PATH, snap.secrets);
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
    const activeAccount = parseSecrets(await liveSecrets().catch(() => ''))?.account ?? null;
    return {
        entries: Object.entries(vault.cline.data)
            .map(([key, snap]: [string, ClineSnapshot]) => entry(key, snap, isSameAccount(activeAccount, parseSecrets(snap.secrets)?.account ?? null)))
            .sort((a, b) => {
                if (a.active !== b.active) {
                    return a.active ? -1 : 1;
                }
                return a.key.localeCompare(b.key);
            }),
        secretsPath: CLINE_SECRETS_PATH,
        vaultPath: VAULT_PATH,
    };
};
