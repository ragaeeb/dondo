import { MINIMAX_CONFIG_PATH, VAULT_PATH } from '../config.ts';
import { assertAccountKey, cleanLimitError, publicError } from '../errors.ts';
import { writePrivateFile } from '../storage/file.ts';
import { readVault, updateVault } from '../storage/vault.ts';
import type { AppVault, LimitCache, MinimaxSnapshot } from '../types.ts';
import { checkInMiniMax, fetchMiniMaxLimits, miniMaxTokenIdentity, type MiniMaxConfig } from './usage.ts';

type StoredMinimaxConfig = MiniMaxConfig & {
    user?: {
        email?: string;
        realUserID?: string;
        userID?: string;
        userMail?: string;
        userName?: string;
        username?: string;
    };
};

const liveConfig = async () => {
    const file = Bun.file(MINIMAX_CONFIG_PATH);
    return (await file.exists()) ? await file.text() : '';
};

const parseConfig = (config: string): StoredMinimaxConfig => {
    try {
        return JSON.parse(config) as StoredMinimaxConfig;
    } catch {
        return {};
    }
};

const stringValue = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

const identity = (config: StoredMinimaxConfig) => {
    return (
        stringValue(config.tokens?.accessToken ? miniMaxTokenIdentity(config.tokens.accessToken) : '') ??
        stringValue(config.user?.realUserID) ??
        stringValue(config.user?.userID) ??
        stringValue(config.user?.userMail) ??
        stringValue(config.user?.email) ??
        stringValue(config.user?.username) ??
        stringValue(config.user?.userName) ??
        ''
    );
};

const isSameConfig = (a: StoredMinimaxConfig, b: StoredMinimaxConfig) => {
    const aIdentity = identity(a);
    const bIdentity = identity(b);
    return Boolean(aIdentity && bIdentity && aIdentity === bIdentity);
};

const hasLegacyPlaceholderLimit = (vault: AppVault, key: string) => {
    const quota = vault.minimax.limits[key]?.quota;
    return quota?.ok && 'minimax-loaded-at' in quota.models;
};

const hasMislabelledFreeQuotaLimit = (vault: AppVault, key: string) => {
    const quota = vault.minimax.limits[key]?.quota;
    if (!quota?.ok) {
        return false;
    }
    const legacyModel = quota.models['minimax-free-daily'] ?? quota.models['minimax-free-access'];
    return Boolean(legacyModel?.detail?.includes('free daily') || legacyModel?.detail?.includes('numeric allowance'));
};

const fetchMiniMaxLimitUpdates = async (vault: AppVault, force: boolean, targetKey?: string) => {
    const updates = new Map<string, LimitCache>();
    if (targetKey && !vault.minimax.data[targetKey]) {
        throw publicError(404, `No MiniMax config named ${targetKey}`);
    }
    for (const [key, snap] of Object.entries(vault.minimax.data)) {
        if (
            (targetKey && key !== targetKey) ||
            (!force &&
                vault.minimax.limits[key] &&
                !hasLegacyPlaceholderLimit(vault, key) &&
                !hasMislabelledFreeQuotaLimit(vault, key))
        ) {
            continue;
        }
        try {
            updates.set(key, {
                fetchedAt: new Date().toISOString(),
                quota: await fetchMiniMaxLimits(parseConfig(snap.config)),
            });
        } catch (error) {
            updates.set(key, { fetchedAt: new Date().toISOString(), quota: cleanLimitError(error) });
        }
    }

    return updates;
};

export const saveMinimax = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const configFile = Bun.file(MINIMAX_CONFIG_PATH);
    if (!(await configFile.exists())) {
        throw publicError(404, `${MINIMAX_CONFIG_PATH} does not exist`);
    }
    const config = await configFile.text();
    if (!config.trim()) {
        throw publicError(400, `${MINIMAX_CONFIG_PATH} is empty`);
    }
    try {
        JSON.parse(config);
    } catch {
        throw publicError(400, `${MINIMAX_CONFIG_PATH} is not valid JSON`);
    }

    await updateVault(async (vault) => {
        const existing = vault.minimax.data[safeKey];
        const now = new Date().toISOString();
        vault.minimax.data[safeKey] = {
            config,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        delete vault.minimax.limits[safeKey];
        return { result: undefined };
    });
};

export const loadMinimax = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const snap = (await readVault()).minimax.data[safeKey];
    if (!snap) {
        throw publicError(404, `No MiniMax config named ${safeKey}`);
    }

    await writePrivateFile(MINIMAX_CONFIG_PATH, snap.config);
    await updateVault(async (vault) => {
        delete vault.minimax.limits[safeKey];
        return { result: undefined };
    });
};

export const deleteMinimax = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await updateVault(async (vault) => {
        if (!vault.minimax.data[safeKey]) {
            throw publicError(404, `No MiniMax config named ${safeKey}`);
        }
        delete vault.minimax.data[safeKey];
        delete vault.minimax.limits[safeKey];
        return { result: undefined };
    });
};

export const checkInMinimax = async (key?: string) => {
    const safeKey = key ? assertAccountKey(key) : undefined;
    const vault = await readVault();
    let config = '';
    let savedKey = safeKey;

    if (safeKey) {
        const snapshot = vault.minimax.data[safeKey];
        if (!snapshot) {
            throw publicError(404, `No MiniMax config named ${safeKey}`);
        }
        config = snapshot.config;
    } else {
        config = await liveConfig();
        const activeEntry = Object.entries(vault.minimax.data).find(([, snapshot]) =>
            isSameConfig(parseConfig(config), parseConfig(snapshot.config)),
        );
        savedKey = activeEntry?.[0];
        if (!config.trim() && savedKey) {
            config = vault.minimax.data[savedKey]?.config ?? '';
        }
    }

    if (!config.trim()) {
        throw publicError(404, 'No live MiniMax session found. Sign into MiniMax, then save the account.');
    }
    const result = await checkInMiniMax(parseConfig(config));
    const keyToInvalidate = savedKey;
    if (result.claimed && keyToInvalidate) {
        await updateVault(async (current) => {
            delete current.minimax.limits[keyToInvalidate];
            return { result: undefined };
        });
    }
    return result;
};

export const minimaxState = async (options: { refreshLimitKey?: string; refreshLimits?: boolean } = {}) => {
    const refreshLimitKey = options.refreshLimitKey ? assertAccountKey(options.refreshLimitKey) : undefined;
    const snapshot = await readVault();
    const updates = await fetchMiniMaxLimitUpdates(snapshot, options.refreshLimits === true, refreshLimitKey);
    const vault = await updateVault(async (current) => {
        if (refreshLimitKey && !current.minimax.data[refreshLimitKey]) {
            throw publicError(404, `No MiniMax config named ${refreshLimitKey}`);
        }
        let changed = false;
        for (const [key, update] of updates) {
            if (!current.minimax.data[key]) {
                continue;
            }
            current.minimax.limits[key] = update;
            changed = true;
        }
        return { result: current, write: changed };
    });
    const activeConfig = parseConfig(await liveConfig().catch(() => ''));
    return {
        configPath: MINIMAX_CONFIG_PATH,
        entries: Object.entries(vault.minimax.data)
            .map(([key, snap]: [string, MinimaxSnapshot]) => {
                const cached = vault.minimax.limits[key];
                return {
                    active: isSameConfig(activeConfig, parseConfig(snap.config)),
                    key,
                    limitUpdatedAt: cached?.fetchedAt ?? '',
                    quota: cached?.quota ?? null,
                    updatedAt: snap.updatedAt,
                };
            })
            .sort((a, b) => {
                if (a.active !== b.active) {
                    return a.active ? -1 : 1;
                }
                return a.key.localeCompare(b.key);
            }),
        vaultPath: VAULT_PATH,
    };
};
