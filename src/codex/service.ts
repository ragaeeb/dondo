import {
    boundedMap,
    CORRUPTED_ACCOUNT_ERROR,
    selectRefreshEntries,
    sortAccountEntries,
    stateVersion,
} from '../account-state.ts';
import { CODEX_AUTH_PATH, VAULT_PATH } from '../config.ts';
import { assertAccountKey, cleanLimitError, publicError } from '../errors.ts';
import { readBoundedLocalText, writePrivateFile } from '../storage/file.ts';
import { readVaultSection, updateVaultSection } from '../storage/vault.ts';
import type { CodexSnapshot, CodexVault, LimitResult } from '../types.ts';
import { codexAuthIdentity, parseCodexAuth } from './auth.ts';
import { fetchCodexLimits } from './usage.ts';

type CodexLimitUpdate = {
    key: string;
    quota: LimitResult;
    sourceLimitVersion: string;
    sourceSnapshotVersion: string;
};

const liveAuth = async () => {
    return (await readBoundedLocalText(CODEX_AUTH_PATH)) ?? '';
};

const isSameAuth = (a: ReturnType<typeof parseCodexAuth>, b: ReturnType<typeof parseCodexAuth>) => {
    const aIdentity = codexAuthIdentity(a);
    const bIdentity = codexAuthIdentity(b);
    return Boolean(aIdentity && bIdentity && aIdentity === bIdentity);
};

const hasNoUsageLeft = (quota: LimitResult | null) => {
    const limits = quota?.ok === true ? Object.entries(quota.models).filter(([key]) => key !== 'codex-credits') : [];
    return limits.length > 0 && limits.every(([, model]) => model.percentage <= 0);
};

const isReadableSnapshot = (snapshot: CodexSnapshot) => parseCodexAuth(snapshot.auth) !== null;

const assertReadableAccount = (section: CodexVault, key: string) => {
    if (section.corruptions?.[key]) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    const snapshot = section.data[key];
    if (!snapshot) {
        throw publicError(404, `No Codex auth named ${key}`);
    }
    if (!isReadableSnapshot(snapshot)) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    return snapshot;
};

const fetchCodexLimitUpdates = async (section: CodexVault, force: boolean, targetKey?: string) => {
    if (targetKey) {
        assertReadableAccount(section, targetKey);
    }
    const readableData = Object.fromEntries(
        Object.entries(section.data).filter(([, snapshot]) => isReadableSnapshot(snapshot)),
    );
    const selected = selectRefreshEntries(readableData, section.limits, targetKey ? { force, targetKey } : { force });
    return boundedMap(selected, async ([key, snapshot]): Promise<CodexLimitUpdate> => {
        const result = await fetchCodexLimits(snapshot.auth).catch((error) => ({ quota: cleanLimitError(error) }));
        return {
            key,
            quota: result.quota,
            sourceLimitVersion: stateVersion(section.limits[key] ?? null),
            sourceSnapshotVersion: stateVersion(snapshot),
        };
    });
};

export const saveCodex = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const auth = await readBoundedLocalText(CODEX_AUTH_PATH);
    if (auth === null) {
        throw publicError(404, `${CODEX_AUTH_PATH} does not exist`);
    }
    if (!auth.trim()) {
        throw publicError(400, `${CODEX_AUTH_PATH} is empty`);
    }
    if (!parseCodexAuth(auth)) {
        throw publicError(400, `${CODEX_AUTH_PATH} is not valid Codex auth JSON`);
    }

    await updateVaultSection('codex', (section) => {
        const existing = section.data[safeKey];
        if (section.corruptions?.[safeKey] || (existing && !isReadableSnapshot(existing))) {
            throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
        }
        const now = new Date().toISOString();
        section.data[safeKey] = {
            auth,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        delete section.limits[safeKey];
        return { result: undefined };
    });
};

export const loadCodex = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const currentAuthText = await liveAuth().catch(() => '');
    const currentAuth = parseCodexAuth(currentAuthText);
    const snapshot = await updateVaultSection('codex', (section) => {
        let target = assertReadableAccount(section, safeKey);
        const activeKey = Object.entries(section.data).find(([, saved]) =>
            isSameAuth(currentAuth, parseCodexAuth(saved.auth)),
        )?.[0];
        const active = activeKey ? section.data[activeKey] : undefined;
        if (activeKey && active && currentAuth && currentAuthText !== active.auth) {
            const updated = { ...active, auth: currentAuthText, updatedAt: new Date().toISOString() };
            section.data[activeKey] = updated;
            delete section.limits[activeKey];
            if (activeKey === safeKey) {
                target = updated;
            }
            return { result: target };
        }
        return { result: target, write: false };
    });
    await writePrivateFile(CODEX_AUTH_PATH, snapshot.auth);
};

export const deleteCodex = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await updateVaultSection('codex', (section) => {
        if (!section.data[safeKey] && !section.corruptions?.[safeKey]) {
            throw publicError(404, `No Codex auth named ${safeKey}`);
        }
        delete section.data[safeKey];
        delete section.limits[safeKey];
        if (section.corruptions) {
            delete section.corruptions[safeKey];
        }
        return { result: undefined };
    });
};

export const codexState = async (options: { refreshLimitKey?: string; refreshLimits?: boolean } = {}) => {
    const refreshLimitKey = options.refreshLimitKey ? assertAccountKey(options.refreshLimitKey) : undefined;
    const snapshot = await readVaultSection('codex');
    const updates = await fetchCodexLimitUpdates(snapshot, options.refreshLimits === true, refreshLimitKey);
    const section =
        updates.length === 0
            ? snapshot
            : await updateVaultSection('codex', (current) => {
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
    const active = parseCodexAuth(await liveAuth().catch(() => ''));
    const healthyEntries = Object.entries(section.data)
        .filter(([, saved]) => isReadableSnapshot(saved))
        .map(([key, saved]: [string, CodexSnapshot]) => {
            const cached = section.limits[key];
            return {
                active: isSameAuth(active, parseCodexAuth(saved.auth)),
                key,
                limitUpdatedAt: cached?.fetchedAt ?? '',
                quota: cached?.quota ?? null,
                updatedAt: saved.updatedAt,
            };
        });
    const semanticCorruptions = Object.entries(section.data)
        .filter(([, saved]) => !isReadableSnapshot(saved))
        .map(([key]) => key);
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
        authPath: CODEX_AUTH_PATH,
        entries: sortAccountEntries([...healthyEntries, ...corruptedEntries], hasNoUsageLeft),
        vaultPath: VAULT_PATH,
    };
};
