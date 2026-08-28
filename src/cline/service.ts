import { CORRUPTED_ACCOUNT_ERROR, sortAccountEntries } from '../account-state.ts';
import { CLINE_PROVIDERS_PATH, VAULT_PATH } from '../config.ts';
import { type CycleNextResult, type CycleSkipReporter, cycleNext, isUnavailableAccountError } from '../cycle.ts';
import { assertAccountKey, publicError } from '../errors.ts';
import { decodeJwtPayload } from '../jwt.ts';
import { readBoundedLocalText, writePrivateFile } from '../storage/file.ts';
import { readVaultSection, updateVaultSection } from '../storage/vault.ts';
import type { ClineSnapshot, ClineVault } from '../types.ts';
import { type ClineAccount, parseClineProviders } from './providers.ts';

const liveFile = async () => {
    const text = await readBoundedLocalText(CLINE_PROVIDERS_PATH);
    return text === null ? null : { path: CLINE_PROVIDERS_PATH, text };
};

const readValidLiveFile = async () => {
    const current = await liveFile();
    if (!current) {
        throw publicError(
            404,
            `No live Cline session found at ${CLINE_PROVIDERS_PATH}. Sign into Cline, then use Save current.`,
        );
    }
    if (!current.text.trim()) {
        throw publicError(400, `${CLINE_PROVIDERS_PATH} is empty`);
    }
    if (!parseClineProviders(current.text)) {
        throw publicError(400, `${CLINE_PROVIDERS_PATH} does not contain a valid Cline account token`);
    }
    return current;
};

const jwtSubject = (token: string) => {
    const subject = decodeJwtPayload(token)?.sub;
    return typeof subject === 'string' ? subject : '';
};

const identity = (account: ClineAccount) => {
    return (
        account.accountId ||
        account.id ||
        account.email ||
        (account.accessToken ? jwtSubject(account.accessToken) : '') ||
        account.accessToken ||
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

const isReadableSnapshot = (snapshot: ClineSnapshot) => parseClineProviders(snapshot.secrets) !== null;

const assertReadableAccount = (section: ClineVault, key: string) => {
    if (section.corruptions?.[key]) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    const snapshot = section.data[key];
    if (!snapshot) {
        throw publicError(404, `No Cline auth named ${key}`);
    }
    if (!isReadableSnapshot(snapshot)) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    return snapshot;
};

export const saveCline = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const current = await readValidLiveFile();
    await updateVaultSection('cline', (section) => {
        const existing = section.data[safeKey];
        if (section.corruptions?.[safeKey] || (existing && !isReadableSnapshot(existing))) {
            throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
        }
        const now = new Date().toISOString();
        section.data[safeKey] = {
            createdAt: existing?.createdAt ?? now,
            secrets: current.text,
            updatedAt: now,
        };
        delete section.limits[safeKey];
        return { result: undefined };
    });
};

export const loadCline = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const snap = assertReadableAccount(await readVaultSection('cline'), safeKey);
    await writePrivateFile(CLINE_PROVIDERS_PATH, snap.secrets);
};

export const cycleNextCline = async (options: { onSkip?: CycleSkipReporter } = {}): Promise<CycleNextResult> => {
    const section = await readVaultSection('cline');
    const current = await liveFile().catch(() => null);
    const activeAccount = current ? (parseClineProviders(current.text)?.account ?? null) : null;
    const activeKey = Object.entries(section.data)
        .filter(([, snapshot]) => isSameAccount(activeAccount, parseClineProviders(snapshot.secrets)?.account ?? null))
        .map(([key]) => key)
        .sort((left, right) => left.localeCompare(right, 'en'))[0];
    return cycleNext({
        activeKey,
        candidateKeys: [...Object.keys(section.data), ...Object.keys(section.corruptions ?? {})],
        isUnavailable: isUnavailableAccountError,
        load: loadCline,
        noAvailableMessage: 'No saved Cline account could be loaded',
        onSkip: options.onSkip,
    });
};

export const deleteCline = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await updateVaultSection('cline', (section) => {
        if (!section.data[safeKey] && !section.corruptions?.[safeKey]) {
            throw publicError(404, `No Cline auth named ${safeKey}`);
        }
        delete section.data[safeKey];
        delete section.limits[safeKey];
        if (section.corruptions) {
            delete section.corruptions[safeKey];
        }
        return { result: undefined };
    });
};

export const clineState = async () => {
    const section = await readVaultSection('cline');
    const current = await liveFile().catch(() => null);
    const activeAccount = current ? (parseClineProviders(current.text)?.account ?? null) : null;
    const parsedEntries = Object.entries(section.data).map(
        ([key, snap]) => [key, snap, parseClineProviders(snap.secrets)] as const,
    );
    const healthyEntries = parsedEntries
        .filter(([, , account]) => account !== null)
        .map(([key, snap, account]) => entry(key, snap, isSameAccount(activeAccount, account?.account ?? null)));
    const semanticCorruptions = parsedEntries.filter(([, , account]) => account === null).map(([key]) => key);
    const corruptedEntries = [...Object.keys(section.corruptions ?? {}), ...semanticCorruptions].map((key) => ({
        active: false,
        corrupted: true as const,
        error: CORRUPTED_ACCOUNT_ERROR,
        key,
        limitUpdatedAt: '',
        quota: null,
        updatedAt: '',
    }));
    return {
        entries: sortAccountEntries([...healthyEntries, ...corruptedEntries]),
        providersPath: CLINE_PROVIDERS_PATH,
        vaultPath: VAULT_PATH,
    };
};
