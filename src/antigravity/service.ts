import { ANTIGRAVITY_ACCOUNT, ANTIGRAVITY_SERVICE, VAULT_PATH } from '../config.ts';
import { assertAccountKey, cleanLimitError, publicError } from '../errors.ts';
import { readVault, updateVault } from '../storage/vault.ts';
import type { AppVault, LimitResult, Snapshot } from '../types.ts';
import { decodeToken, fetchLimits } from './google.ts';
import { clearLiveAuth, readCurrentSnapshot, restoreSnapshot } from './keychain.ts';

const isSameSnapshot = (a: Snapshot | null, b: Snapshot) => {
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

const sortEntries = <T extends { active: boolean; key: string; quota: LimitResult | null }>(entries: T[]) => {
    return [...entries].sort((a, b) => {
        if (a.active !== b.active) {
            return a.active ? -1 : 1;
        }
        if (hasNoUsageLeft(a.quota) !== hasNoUsageLeft(b.quota)) {
            return hasNoUsageLeft(a.quota) ? 1 : -1;
        }
        return a.key.localeCompare(b.key);
    });
};

const updateMissingOrStaleLimits = async (vault: AppVault, force: boolean, targetKey?: string) => {
    let changed = false;
    if (targetKey && !vault.antigravity.data[targetKey]) {
        throw publicError(404, `No snapshot named ${targetKey}`);
    }

    for (const [key, snap] of Object.entries(vault.antigravity.data)) {
        if ((targetKey && key !== targetKey) || (!force && vault.antigravity.limits[key])) {
            continue;
        }
        const result = await fetchLimits(snap).catch((error) => ({
            quota: cleanLimitError(error),
        }));
        vault.antigravity.limits[key] = { fetchedAt: new Date().toISOString(), quota: result.quota };
        changed = true;
    }

    return changed;
};

export const saveAntigravity = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const snapshot = await readCurrentSnapshot();
    await updateVault(async (vault) => {
        vault.antigravity.data[safeKey] = snapshot;
        delete vault.antigravity.limits[safeKey];
        return { result: undefined };
    });
};

export const loadAntigravity = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const snap = (await readVault()).antigravity.data[safeKey];
    if (!snap) {
        throw publicError(404, `No snapshot named ${safeKey}`);
    }
    await restoreSnapshot(snap);
};

export const clearAntigravity = async () => {
    await clearLiveAuth();
};

export const antigravityState = async (options: { refreshLimitKey?: string; refreshLimits?: boolean } = {}) => {
    const refreshLimitKey = options.refreshLimitKey ? assertAccountKey(options.refreshLimitKey) : undefined;
    const vault = await updateVault(async (current) => {
        const changed = await updateMissingOrStaleLimits(current, options.refreshLimits === true, refreshLimitKey);
        return { result: current, write: changed };
    });
    const live = await readCurrentSnapshot().catch(() => null);

    return {
        account: ANTIGRAVITY_ACCOUNT,
        entries: sortEntries(
            Object.entries(vault.antigravity.data).map(([key, snap]: [string, Snapshot]) => {
                const cached = vault.antigravity.limits[key];
                return {
                    account: snap.account,
                    active: isSameSnapshot(live, snap),
                    key,
                    limitUpdatedAt: cached?.fetchedAt ?? '',
                    quota: cached?.quota ?? null,
                    service: snap.service,
                    updatedAt: snap.updatedAt,
                };
            }),
        ),
        service: ANTIGRAVITY_SERVICE,
        vaultPath: VAULT_PATH,
    };
};
