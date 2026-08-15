import {
    boundedMap,
    CORRUPTED_ACCOUNT_ERROR,
    selectRefreshEntries,
    sortAccountEntries,
    stateVersion,
} from '../account-state.ts';
import { createAsyncQueue } from '../async-queue.ts';
import { MINIMAX_CONFIG_PATH, VAULT_PATH } from '../config.ts';
import { type CycleNextResult, type CycleSkipReporter, cycleCandidateKeys } from '../cycle.ts';
import { assertAccountKey, cleanLimitError, publicError } from '../errors.ts';
import { readBoundedLocalText, writePrivateFile } from '../storage/file.ts';
import { readVaultSection, updateVaultSection } from '../storage/vault.ts';
import type { LimitResult, MinimaxSnapshot, MinimaxVault } from '../types.ts';
import {
    checkInMiniMax,
    fetchMiniMaxLimits,
    type MiniMaxCheckInResult,
    type MiniMaxConfig,
    miniMaxTokenIdentity,
    parseMiniMaxConfig,
    resolveMiniMaxRealUserId,
} from './usage.ts';

type MiniMaxLimitUpdate = {
    key: string;
    quota: LimitResult;
    realUserId?: string;
    sourceLimitVersion: string;
    sourceSnapshotVersion: string;
};

export type MiniMaxCheckInOutcome = Omit<MiniMaxCheckInResult, 'panel'>;

export type MiniMaxCheckInAllResult = {
    alreadyClaimed: number;
    attempted: number;
    claimed: number;
    failed: number;
    unavailable: number;
};

type MiniMaxCheckInUpdate = {
    outcome: MiniMaxCheckInOutcome | null;
    realUserId?: string;
    tokenIdentity: string;
};

const queueMiniMaxCycle = createAsyncQueue();

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

const updateMiniMaxIdentityRealUserId = (section: MinimaxVault, tokenIdentity: string, realUserId: string) => {
    let changed = false;
    for (const snapshot of Object.values(section.data)) {
        if (identity(parseConfig(snapshot.config)) !== tokenIdentity || snapshot.realUserId === realUserId) {
            continue;
        }
        snapshot.realUserId = realUserId;
        changed = true;
    }
    return changed;
};

const isReadableSnapshot = (snapshot: MinimaxSnapshot) => parseConfig(snapshot.config) !== null;

const checkInOutcome = ({ panel: _, ...outcome }: MiniMaxCheckInResult): MiniMaxCheckInOutcome => outcome;

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
        let realUserId: string | undefined;
        const quota = await fetchMiniMaxLimits(parsed, {
            onRealUserIdResolved: (resolved) => {
                realUserId = resolved;
            },
            ...(snapshot.realUserId ? { realUserId: snapshot.realUserId } : {}),
        }).catch((error) => cleanLimitError(error));
        return {
            key,
            quota,
            ...(realUserId ? { realUserId } : {}),
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
    const parsedConfig = parseConfig(config);
    if (!parsedConfig) {
        throw publicError(400, `${MINIMAX_CONFIG_PATH} is not valid MiniMax config JSON`);
    }
    const resolvedRealUserId = await resolveMiniMaxRealUserId(parsedConfig).catch(() => undefined);

    await updateVaultSection('minimax', (section) => {
        const existing = section.data[safeKey];
        if (section.corruptions?.[safeKey] || (existing && !isReadableSnapshot(existing))) {
            throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
        }
        const now = new Date().toISOString();
        section.data[safeKey] = {
            config,
            createdAt: existing?.createdAt ?? now,
            ...(resolvedRealUserId
                ? { realUserId: resolvedRealUserId }
                : existing?.realUserId && identity(parseConfig(existing.config)) === identity(parsedConfig)
                  ? { realUserId: existing.realUserId }
                  : {}),
            updatedAt: now,
        };
        delete section.limits[safeKey];
        return { result: undefined };
    });
};

export const loadMinimax = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const snapshot = assertReadableAccount(await readVaultSection('minimax'), safeKey);
    const config = parseConfig(snapshot.config) as MiniMaxConfig;
    let realUserId: string | undefined;
    const outcome = checkInOutcome(
        await checkInMiniMax(config, {
            onRealUserIdResolved: (resolved) => {
                realUserId = resolved;
            },
            ...(snapshot.realUserId ? { realUserId: snapshot.realUserId } : {}),
        }),
    );
    await writePrivateFile(MINIMAX_CONFIG_PATH, snapshot.config);
    await updateVaultSection('minimax', (section) => {
        const current = section.data[safeKey];
        if (!current || current.config !== snapshot.config || current.updatedAt !== snapshot.updatedAt) {
            return { result: undefined, write: false };
        }
        const tokenIdentity = identity(config);
        const identityChanged =
            tokenIdentity && realUserId ? updateMiniMaxIdentityRealUserId(section, tokenIdentity, realUserId) : false;
        const changed = tokenIdentity ? invalidateMiniMaxIdentityLimits(section, tokenIdentity) : false;
        return { result: undefined, write: identityChanged || changed };
    });
    return outcome;
};

export const cycleNextMinimax = async (options: { onSkip?: CycleSkipReporter } = {}): Promise<CycleNextResult> =>
    queueMiniMaxCycle(async () => {
        const section = await readVaultSection('minimax');
        const activeIdentity = identity(parseConfig(await liveConfig().catch(() => '')));
        const activeKey = Object.entries(section.data)
            .filter(([, snapshot]) => activeIdentity && identity(parseConfig(snapshot.config)) === activeIdentity)
            .map(([key]) => key)
            .sort((left, right) => left.localeCompare(right, 'en'))[0];
        const keys = cycleCandidateKeys(
            [...Object.keys(section.data), ...Object.keys(section.corruptions ?? {})],
            activeKey,
        );
        let healed = false;
        for (const key of keys) {
            try {
                await loadMinimax(key);
                return { healed };
            } catch {
                healed = true;
                options.onSkip?.();
            }
        }
        throw publicError(409, 'No saved MiniMax account could be loaded');
    });

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

    const saved = safeKey ? assertReadableAccount(section, safeKey) : undefined;
    if (saved) {
        configText = saved.config;
    } else {
        configText = await liveConfig();
    }

    const config = parseConfig(configText);
    if (!config) {
        throw publicError(404, 'No valid live MiniMax session found. Sign into MiniMax, then save the account.');
    }
    let realUserId: string | undefined;
    const result = await checkInMiniMax(config, {
        onRealUserIdResolved: (resolved) => {
            realUserId = resolved;
        },
        ...(saved?.realUserId ? { realUserId: saved.realUserId } : {}),
    });
    const tokenIdentity = identity(config);
    if (tokenIdentity && (result.claimed || realUserId)) {
        await updateVaultSection('minimax', (current) => {
            const identityChanged = realUserId
                ? updateMiniMaxIdentityRealUserId(current, tokenIdentity, realUserId)
                : false;
            const limitsChanged = result.claimed ? invalidateMiniMaxIdentityLimits(current, tokenIdentity) : false;
            return { result: undefined, write: identityChanged || limitsChanged };
        });
    }
    return result;
};

export const checkInAllMinimax = async (): Promise<MiniMaxCheckInAllResult> => {
    const section = await readVaultSection('minimax');
    const uniqueConfigs = new Map<string, { config: MiniMaxConfig; realUserId?: string }>();
    for (const snapshot of Object.values(section.data)) {
        const config = parseConfig(snapshot.config);
        const tokenIdentity = identity(config);
        if (config && tokenIdentity && !uniqueConfigs.has(tokenIdentity)) {
            uniqueConfigs.set(tokenIdentity, {
                config,
                ...(snapshot.realUserId ? { realUserId: snapshot.realUserId } : {}),
            });
        }
    }

    const updates = await boundedMap(
        [...uniqueConfigs.entries()],
        async ([tokenIdentity, saved]): Promise<MiniMaxCheckInUpdate> => {
            let realUserId: string | undefined;
            try {
                const result = await checkInMiniMax(saved.config, {
                    onRealUserIdResolved: (resolved) => {
                        realUserId = resolved;
                    },
                    ...(saved.realUserId ? { realUserId: saved.realUserId } : {}),
                });
                return {
                    outcome: checkInOutcome(result),
                    ...(realUserId ? { realUserId } : {}),
                    tokenIdentity,
                };
            } catch {
                return { outcome: null, ...(realUserId ? { realUserId } : {}), tokenIdentity };
            }
        },
        3,
    );
    const claimedIdentities = updates.filter((update) => update.outcome?.claimed).map((update) => update.tokenIdentity);
    if (claimedIdentities.length > 0 || updates.some((update) => update.realUserId)) {
        await updateVaultSection('minimax', (current) => {
            let changed = false;
            for (const update of updates) {
                if (update.realUserId) {
                    changed =
                        updateMiniMaxIdentityRealUserId(current, update.tokenIdentity, update.realUserId) || changed;
                }
            }
            for (const tokenIdentity of claimedIdentities) {
                changed = invalidateMiniMaxIdentityLimits(current, tokenIdentity) || changed;
            }
            return { result: undefined, write: changed };
        });
    }

    return updates.reduce<MiniMaxCheckInAllResult>(
        (summary, update) => {
            if (!update.outcome) {
                summary.failed += 1;
            } else if (update.outcome.claimed) {
                summary.claimed += 1;
            } else if (update.outcome.alreadyClaimed) {
                summary.alreadyClaimed += 1;
            } else {
                summary.unavailable += 1;
            }
            return summary;
        },
        {
            alreadyClaimed: 0,
            attempted: updates.length,
            claimed: 0,
            failed: 0,
            unavailable: 0,
        },
    );
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
                      if (update.realUserId && saved.realUserId !== update.realUserId) {
                          saved.realUserId = update.realUserId;
                      }
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
