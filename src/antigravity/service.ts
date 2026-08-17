import {
    boundedMap,
    CORRUPTED_ACCOUNT_ERROR,
    selectRefreshEntries,
    sortAccountEntries,
    stateVersion,
} from '../account-state.ts';
import { createAsyncQueue } from '../async-queue.ts';
import { ANTIGRAVITY_ACCOUNT, ANTIGRAVITY_PROCESS_NAME, ANTIGRAVITY_SERVICE, DEV_MODE, VAULT_PATH } from '../config.ts';
import { assertAccountKey, cleanLimitError, publicError } from '../errors.ts';
import { isProcessRunning } from '../process.ts';
import { readVaultSection, updateVaultSection } from '../storage/vault.ts';
import type { AntigravityCredential, LimitResult, PlatformVault, Snapshot } from '../types.ts';
import { decodeToken, fetchLimits, resolveGoogleIdentity } from './google.ts';
import { clearLiveAuth, clearLocalState, readCurrentSnapshot, replaceLiveSnapshot } from './keychain.ts';

type AntigravityLimitUpdate = {
    key: string;
    password?: string;
    quota: LimitResult;
    sourceLimitVersion: string;
    sourceSnapshotVersion: string;
};

const queueAntigravityOperation = createAsyncQueue();
let liveIdentityCache: { identity: string; passwordVersion: string } | undefined;

const hasSameToken = (a: AntigravityCredential | null, b: Snapshot) => {
    if (a?.service !== b.service || a.account !== b.account) {
        return false;
    }
    const aRefresh = decodeToken(a.password)?.token?.refresh_token;
    const bRefresh = decodeToken(b.password)?.token?.refresh_token;
    if (aRefresh || bRefresh) {
        return aRefresh === bRefresh;
    }
    return a.password === b.password;
};

const hasNoUsageLeft = (quota: LimitResult | null) => {
    const limits = quota?.ok === true ? Object.values(quota.models) : [];
    return limits.length > 0 && limits.every((model) => model.percentage <= 0);
};

const isReadableCredential = (snapshot: AntigravityCredential) => {
    return (
        snapshot.account === ANTIGRAVITY_ACCOUNT &&
        snapshot.service === ANTIGRAVITY_SERVICE &&
        decodeToken(snapshot.password) !== null
    );
};

const isReadableSnapshot = (snapshot: Snapshot) => {
    return isReadableCredential(snapshot) && Boolean(snapshot.identity.trim());
};

const resolveIdentity = async (credential: AntigravityCredential): Promise<{ identity: string; password?: string }> => {
    if (DEV_MODE === 'mock') {
        return { identity: 'mock-account' };
    }
    return resolveGoogleIdentity(credential);
};

const liveIdentity = async (credential: AntigravityCredential | null) => {
    if (!credential || !isReadableCredential(credential)) {
        return null;
    }
    const passwordVersion = stateVersion(credential.password);
    if (liveIdentityCache?.passwordVersion === passwordVersion) {
        return liveIdentityCache.identity;
    }
    const resolved = await resolveIdentity(credential);
    liveIdentityCache = { identity: resolved.identity, passwordVersion };
    return resolved.identity;
};

const assertReadableAccount = (section: PlatformVault, key: string) => {
    if (section.corruptions?.[key]) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    const snapshot = section.data[key];
    if (!snapshot) {
        throw publicError(404, `No snapshot named ${key}`);
    }
    if (!isReadableSnapshot(snapshot)) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    return snapshot;
};

const assertAntigravityClosed = async () => {
    if (await isProcessRunning(ANTIGRAVITY_PROCESS_NAME)) {
        throw publicError(
            409,
            'Quit Antigravity completely before clearing or loading an account. Antigravity must be closed while Dondo replaces its local login state.',
        );
    }
};

const fetchAntigravityLimitUpdates = async (section: PlatformVault, force: boolean, targetKey?: string) => {
    if (targetKey) {
        assertReadableAccount(section, targetKey);
    }
    if (DEV_MODE === 'mock') {
        return [];
    }
    const readableData = Object.fromEntries(
        Object.entries(section.data).filter(([, snapshot]) => isReadableSnapshot(snapshot)),
    );
    const selected = selectRefreshEntries(readableData, section.limits, targetKey ? { force, targetKey } : { force });
    return boundedMap(selected, async ([key, snapshot]): Promise<AntigravityLimitUpdate> => {
        const result = await fetchLimits(snapshot).catch((error) => ({
            password: undefined,
            quota: cleanLimitError(error),
        }));
        return {
            key,
            ...(result.password ? { password: result.password } : {}),
            quota: result.quota,
            sourceLimitVersion: stateVersion(section.limits[key] ?? null),
            sourceSnapshotVersion: stateVersion(snapshot),
        };
    });
};

const saveAntigravityOperation = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const credential = await readCurrentSnapshot();
    if (!isReadableCredential(credential)) {
        throw publicError(400, 'Current Antigravity credential payload is invalid');
    }
    const resolved = await resolveIdentity(credential).catch(() => {
        throw publicError(502, 'Could not verify the current Antigravity account identity');
    });
    const snapshot: Snapshot = {
        ...credential,
        identity: resolved.identity,
        password: resolved.password ?? credential.password,
    };
    await updateVaultSection('antigravity', (section) => {
        const existing = section.data[safeKey];
        if (section.corruptions?.[safeKey] || (existing && !isReadableSnapshot(existing))) {
            throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
        }
        section.data[safeKey] = {
            ...snapshot,
            createdAt: existing?.createdAt ?? snapshot.createdAt,
        };
        delete section.limits[safeKey];
        return { result: undefined };
    });
    liveIdentityCache = { identity: resolved.identity, passwordVersion: stateVersion(credential.password) };
};

export const saveAntigravity = (key: string) => queueAntigravityOperation(() => saveAntigravityOperation(key));

const loadAntigravityOperation = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await assertAntigravityClosed();
    const snapshot = assertReadableAccount(await readVaultSection('antigravity'), safeKey);
    await clearLocalState();
    await replaceLiveSnapshot(snapshot);
    liveIdentityCache = { identity: snapshot.identity, passwordVersion: stateVersion(snapshot.password) };
};

export const loadAntigravity = (key: string) => queueAntigravityOperation(() => loadAntigravityOperation(key));

export const deleteAntigravity = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await updateVaultSection('antigravity', (section) => {
        if (!section.data[safeKey] && !section.corruptions?.[safeKey]) {
            throw publicError(404, `No snapshot named ${safeKey}`);
        }
        delete section.data[safeKey];
        delete section.limits[safeKey];
        if (section.corruptions) {
            delete section.corruptions[safeKey];
        }
        return { result: undefined };
    });
};

const clearAntigravityOperation = async () => {
    await assertAntigravityClosed();
    await clearLiveAuth();
    liveIdentityCache = undefined;
};

export const clearAntigravity = () => queueAntigravityOperation(clearAntigravityOperation);

export const antigravityState = async (options: { refreshLimitKey?: string; refreshLimits?: boolean } = {}) => {
    const refreshLimitKey = options.refreshLimitKey ? assertAccountKey(options.refreshLimitKey) : undefined;
    const snapshot = await readVaultSection('antigravity');
    const updates = await fetchAntigravityLimitUpdates(snapshot, options.refreshLimits === true, refreshLimitKey);
    const section =
        updates.length === 0
            ? snapshot
            : await updateVaultSection('antigravity', (current) => {
                  let changed = false;
                  for (const update of updates) {
                      const saved = current.data[update.key];
                      if (
                          !saved ||
                          stateVersion(saved) !== update.sourceSnapshotVersion ||
                          stateVersion(current.limits[update.key] ?? null) !== update.sourceLimitVersion
                      ) {
                          continue;
                      }
                      if (update.password) {
                          saved.password = update.password;
                          saved.updatedAt = new Date().toISOString();
                      }
                      current.limits[update.key] = { fetchedAt: new Date().toISOString(), quota: update.quota };
                      changed = true;
                  }
                  return { result: current, write: changed };
              });
    const live = await queueAntigravityOperation(() => readCurrentSnapshot().catch(() => null));
    const activeIdentity = await queueAntigravityOperation(() => liveIdentity(live).catch(() => null));
    const healthyEntries = Object.entries(section.data).map(([key, saved]: [string, Snapshot]) => {
        const snapshotValid = isReadableSnapshot(saved);
        const cached = section.limits[key];
        return {
            account: saved.account,
            active: snapshotValid && (activeIdentity ? saved.identity === activeIdentity : hasSameToken(live, saved)),
            ...(!snapshotValid ? { corrupted: true as const, error: CORRUPTED_ACCOUNT_ERROR } : {}),
            key,
            limitUpdatedAt: cached?.fetchedAt ?? '',
            quota: cached?.quota ?? null,
            service: saved.service,
            updatedAt: saved.updatedAt,
        };
    });
    const corruptedEntries = Object.keys(section.corruptions ?? {}).map((key) => ({
        account: '',
        active: false,
        corrupted: true as const,
        error: CORRUPTED_ACCOUNT_ERROR,
        key,
        limitUpdatedAt: '',
        quota: null,
        service: '',
        updatedAt: '',
    }));

    return {
        account: ANTIGRAVITY_ACCOUNT,
        entries: sortAccountEntries([...healthyEntries, ...corruptedEntries], hasNoUsageLeft),
        service: ANTIGRAVITY_SERVICE,
        vaultPath: VAULT_PATH,
    };
};
