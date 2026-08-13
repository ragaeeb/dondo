import {
    boundedMap,
    CORRUPTED_ACCOUNT_ERROR,
    selectRefreshEntries,
    sortAccountEntries,
    stateVersion,
} from '../account-state.ts';
import { MINIMAX_CONFIG_PATH, VAULT_PATH } from '../config.ts';
import { assertAccountKey, cleanLimitError, publicError } from '../errors.ts';
import { readBoundedLocalText, writePrivateFile } from '../storage/file.ts';
import { readVaultSection, updateVaultSection } from '../storage/vault.ts';
import type { LimitResult, MinimaxSnapshot, MinimaxVault } from '../types.ts';
import {
    checkInMiniMax,
    fetchMiniMaxLimits,
    type MiniMaxConfig,
    miniMaxTokenIdentity,
    parseMiniMaxConfig,
} from './usage.ts';

type MiniMaxLimitUpdate = {
    key: string;
    quota: LimitResult;
    sourceLimitVersion: string;
    sourceSnapshotVersion: string;
};

const liveConfig = async () => {
    return (await readBoundedLocalText(MINIMAX_CONFIG_PATH)) ?? '';
};

const parseConfig = (config: string) => {
    return parseMiniMaxConfig(config);
};

const identity = (config: MiniMaxConfig | null) => (config ? miniMaxTokenIdentity(config.tokens.accessToken) : '');

const isSameConfig = (a: MiniMaxConfig | null, b: MiniMaxConfig | null) => {
    const aIdentity = identity(a);
    const bIdentity = identity(b);
    return Boolean(aIdentity && bIdentity && aIdentity === bIdentity);
};

export const invalidateMiniMaxIdentityLimits = (section: MinimaxVault, tokenIdentity: string) => {
    let changed = false;
    for (const [key, snapshot] of Object.entries(section.data)) {
        if (identity(parseConfig(snapshot.config)) !== tokenIdentity || !section.limits[key]) {
            continue;
        }
        delete section.limits[key];
        changed = true;
    }
    return changed;
};

const isReadableSnapshot = (snapshot: MinimaxSnapshot) => parseConfig(snapshot.config) !== null;

const assertReadableAccount = (section: MinimaxVault, key: string) => {
    if (section.corruptions?.[key]) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    const snapshot = section.data[key];
    if (!snapshot) {
        throw publicError(404, `No MiniMax config named ${key}`);
    }
    if (!isReadableSnapshot(snapshot)) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    return snapshot;
};

const fetchMiniMaxLimitUpdates = async (section: MinimaxVault, force: boolean, targetKey?: string) => {
    if (targetKey) {
        assertReadableAccount(section, targetKey);
    }
    const readableData = Object.fromEntries(
        Object.entries(section.data).filter(([, snapshot]) => isReadableSnapshot(snapshot)),
    );
    const selected = selectRefreshEntries(readableData, section.limits, targetKey ? { force, targetKey } : { force });
    return boundedMap(selected, async ([key, snapshot]): Promise<MiniMaxLimitUpdate> => {
        const parsed = parseConfig(snapshot.config) as MiniMaxConfig;
        const quota = await fetchMiniMaxLimits(parsed).catch((error) => cleanLimitError(error));
        return {
            key,
            quota,
            sourceLimitVersion: stateVersion(section.limits[key] ?? null),
            sourceSnapshotVersion: stateVersion(snapshot),
        };
    });
};

export const saveMinimax = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const config = await readBoundedLocalText(MINIMAX_CONFIG_PATH);
    if (config === null) {
        throw publicError(404, `${MINIMAX_CONFIG_PATH} does not exist`);
    }
    if (!config.trim()) {
        throw publicError(400, `${MINIMAX_CONFIG_PATH} is empty`);
    }
    if (!parseConfig(config)) {
        throw publicError(400, `${MINIMAX_CONFIG_PATH} is not valid MiniMax config JSON`);
    }

    await updateVaultSection('minimax', (section) => {
        const existing = section.data[safeKey];
        if (section.corruptions?.[safeKey] || (existing && !isReadableSnapshot(existing))) {
            throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
        }
        const now = new Date().toISOString();
        section.data[safeKey] = {
            config,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        delete section.limits[safeKey];
        return { result: undefined };
    });
};

export const loadMinimax = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const snapshot = assertReadableAccount(await readVaultSection('minimax'), safeKey);
    await writePrivateFile(MINIMAX_CONFIG_PATH, snapshot.config);
    await updateVaultSection('minimax', (section) => {
        const current = section.data[safeKey];
        if (!current || current.config !== snapshot.config || current.updatedAt !== snapshot.updatedAt) {
            return { result: undefined, write: false };
        }
        delete section.limits[safeKey];
        return { result: undefined };
    });
};

export const deleteMinimax = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await updateVaultSection('minimax', (section) => {
        if (!section.data[safeKey] && !section.corruptions?.[safeKey]) {
            throw publicError(404, `No MiniMax config named ${safeKey}`);
        }
        delete section.data[safeKey];
        delete section.limits[safeKey];
        if (section.corruptions) {
            delete section.corruptions[safeKey];
        }
        return { result: undefined };
    });
};

export const checkInMinimax = async (key?: string) => {
    const safeKey = key ? assertAccountKey(key) : undefined;
    const section = await readVaultSection('minimax');
    let configText: string;

    if (safeKey) {
        configText = assertReadableAccount(section, safeKey).config;
    } else {
        configText = await liveConfig();
    }

    const config = parseConfig(configText);
    if (!config) {
        throw publicError(404, 'No valid live MiniMax session found. Sign into MiniMax, then save the account.');
    }
    const result = await checkInMiniMax(config);
    const tokenIdentity = identity(config);
    if (result.claimed && tokenIdentity) {
        await updateVaultSection('minimax', (current) => {
            return { result: undefined, write: invalidateMiniMaxIdentityLimits(current, tokenIdentity) };
        });
    }
    return result;
};

export const minimaxState = async (options: { refreshLimitKey?: string; refreshLimits?: boolean } = {}) => {
    const refreshLimitKey = options.refreshLimitKey ? assertAccountKey(options.refreshLimitKey) : undefined;
    const snapshot = await readVaultSection('minimax');
    const updates = await fetchMiniMaxLimitUpdates(snapshot, options.refreshLimits === true, refreshLimitKey);
    const section =
        updates.length === 0
            ? snapshot
            : await updateVaultSection('minimax', (current) => {
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
                      current.limits[update.key] = { fetchedAt: new Date().toISOString(), quota: update.quota };
                      changed = true;
                  }
                  return { result: current, write: changed };
              });
    const activeConfig = parseConfig(await liveConfig().catch(() => ''));
    const parsedEntries = Object.entries(section.data).map(
        ([key, saved]) => [key, saved, parseConfig(saved.config)] as const,
    );
    const healthyEntries = parsedEntries
        .filter(([, , config]) => config !== null)
        .map(([key, saved, config]) => {
            const cached = section.limits[key];
            return {
                active: isSameConfig(activeConfig, config),
                key,
                limitUpdatedAt: cached?.fetchedAt ?? '',
                quota: cached?.quota ?? null,
                updatedAt: saved.updatedAt,
            };
        });
    const semanticCorruptions = parsedEntries.filter(([, , config]) => config === null).map(([key]) => key);
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
        configPath: MINIMAX_CONFIG_PATH,
        entries: sortAccountEntries([...healthyEntries, ...corruptedEntries]),
        vaultPath: VAULT_PATH,
    };
};
