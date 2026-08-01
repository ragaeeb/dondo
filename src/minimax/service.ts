import { MINIMAX_CONFIG_PATH, VAULT_PATH } from '../config.ts';
import { assertAccountKey, cleanLimitError, publicError } from '../errors.ts';
import { writePrivateFile } from '../storage/file.ts';
import { readVault, updateVault } from '../storage/vault.ts';
import type { AppVault, MinimaxSnapshot } from '../types.ts';
import { fetchMiniMaxLimits, miniMaxTokenIdentity, type MiniMaxConfig } from './usage.ts';

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
    const detail = quota?.ok ? quota.models['minimax-free-daily']?.detail : undefined;
    return detail?.includes('free daily credit') ?? false;
};

const updateMiniMaxLimits = async (vault: AppVault, force: boolean, targetKey?: string) => {
    let changed = false;
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
            vault.minimax.limits[key] = { fetchedAt: new Date().toISOString(), quota: await fetchMiniMaxLimits(parseConfig(snap.config)) };
        } catch (error) {
            vault.minimax.limits[key] = { fetchedAt: new Date().toISOString(), quota: cleanLimitError(error) };
        }
        changed = true;
    }

    return changed;
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

export const minimaxState = async (options: { refreshLimitKey?: string; refreshLimits?: boolean } = {}) => {
    const refreshLimitKey = options.refreshLimitKey ? assertAccountKey(options.refreshLimitKey) : undefined;
    const vault = await updateVault(async (current) => {
        const changed = await updateMiniMaxLimits(current, options.refreshLimits === true, refreshLimitKey);
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
