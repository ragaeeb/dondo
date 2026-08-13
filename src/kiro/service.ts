import { randomUUID } from 'node:crypto';
import { chmod, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
    boundedMap,
    CORRUPTED_ACCOUNT_ERROR,
    selectRefreshEntries,
    sortAccountEntries,
    stateVersion,
} from '../account-state.ts';
import { createAsyncQueue, waitForAll } from '../async-queue.ts';
import {
    KIRO_AUTH_PATH,
    KIRO_AUTH_REFRESH_URL,
    KIRO_PROCESS_NAME,
    KIRO_PROFILE_PATH,
    KIRO_USER_AGENT,
    VAULT_PATH,
} from '../config.ts';
import { assertAccountKey, cleanLimitError, publicError } from '../errors.ts';
import { discardResponse, readBoundedResponseJson } from '../http.ts';
import { isProcessRunning } from '../process.ts';
import { readBoundedLocalText, writePrivateFile } from '../storage/file.ts';
import { readVaultSection, updateVaultSection } from '../storage/vault.ts';
import type { KiroSnapshot, KiroVault, LimitResult } from '../types.ts';
import { isKiroSnapshotConfigValid, type KiroAuth, parseKiroAuth, parseKiroJsonObject } from './auth.ts';
import { fetchKiroLimits } from './usage.ts';

type KiroLimitUpdate = {
    auth?: string;
    key: string;
    quota: LimitResult;
    sourceLimitVersion: string;
    sourceSnapshotVersion: string;
};

type KiroSessionFiles = {
    auth: string;
    clientRegistration?: string;
    profile?: string;
};

let activeKiroKey: string | undefined;
const queueKiroMutation = createAsyncQueue();

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const assertKiroClosed = async () => {
    if (await isProcessRunning(KIRO_PROCESS_NAME)) {
        throw publicError(
            409,
            'Quit Kiro completely before clearing or loading an account. Kiro must be closed while Dondo replaces its local login files.',
        );
    }
};

const liveAuth = async () => {
    return (await readBoundedLocalText(KIRO_AUTH_PATH)) ?? '';
};

const optionalFile = async (path: string) => {
    return (await readBoundedLocalText(path)) ?? undefined;
};

const clientRegistrationPath = (auth: KiroAuth | null) => {
    return auth?.clientIdHash && /^[a-f0-9]{40}$/i.test(auth.clientIdHash)
        ? join(dirname(KIRO_AUTH_PATH), `${auth.clientIdHash}.json`)
        : undefined;
};

const clearLiveFiles = async () => {
    const auth = parseKiroAuth(await liveAuth().catch(() => ''));
    const registrationPath = clientRegistrationPath(auth);
    const supportingPaths = [KIRO_PROFILE_PATH, ...(registrationPath ? [registrationPath] : [])];
    await waitForAll(supportingPaths.map((path) => rm(path, { force: true })));
    await rm(KIRO_AUTH_PATH, { force: true });
};

const authMatchScore = (a: KiroAuth | null, b: KiroAuth | null) => {
    if (!a || !b) {
        return 0;
    }
    if (a.accessToken && b.accessToken && a.accessToken === b.accessToken) {
        return 2;
    }
    return a.refreshToken === b.refreshToken ? 1 : 0;
};

const isSameAuth = (a: KiroAuth | null, b: KiroAuth | null) => {
    return authMatchScore(a, b) > 0;
};

const matchingKiroEntry = (section: KiroVault, auth: KiroAuth | null) => {
    const entries = Object.entries(section.data).filter(([, snapshot]) => isKiroSnapshotConfigValid(snapshot));
    const preferred = activeKiroKey ? entries.find(([key]) => key === activeKiroKey) : undefined;
    const candidates = preferred ? [preferred, ...entries.filter(([key]) => key !== activeKiroKey)] : entries;
    let best: [string, KiroSnapshot] | undefined;
    let bestScore = 0;
    for (const entry of candidates) {
        const score = authMatchScore(auth, parseKiroAuth(entry[1].auth));
        if (score > bestScore) {
            best = entry;
            bestScore = score;
        }
    }
    return best;
};

const refreshSocialAuth = async (auth: KiroAuth, key: string): Promise<KiroAuth> => {
    if (auth.authMethod !== 'social') {
        return auth;
    }

    const response = await fetch(KIRO_AUTH_REFRESH_URL, {
        body: JSON.stringify({ refreshToken: auth.refreshToken }),
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': KIRO_USER_AGENT,
        },
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
    }).catch(() => {
        throw publicError(502, 'Could not reach Kiro to validate the saved session');
    });
    if (!response.ok) {
        await discardResponse(response);
        if (response.status === 400 || response.status === 401 || response.status === 403) {
            throw publicError(
                409,
                `Saved Kiro session ${key} has been revoked. Sign in again, then replace this snapshot with Save current.`,
            );
        }
        throw publicError(502, `Kiro session validation failed with HTTP ${response.status}`);
    }

    let value: unknown;
    try {
        value = await readBoundedResponseJson(response, 'Kiro session refresh');
    } catch {
        throw publicError(502, 'Kiro returned an invalid session refresh response');
    }
    if (!isRecord(value)) {
        throw publicError(502, 'Kiro returned an incomplete session refresh response');
    }
    const refreshed = value;
    if (
        typeof refreshed.accessToken !== 'string' ||
        !refreshed.accessToken.trim() ||
        typeof refreshed.refreshToken !== 'string' ||
        !refreshed.refreshToken.trim() ||
        typeof refreshed.expiresIn !== 'number' ||
        !Number.isFinite(refreshed.expiresIn) ||
        refreshed.expiresIn <= 0 ||
        refreshed.expiresIn > 31_536_000 ||
        (refreshed.profileArn !== undefined &&
            (typeof refreshed.profileArn !== 'string' || !refreshed.profileArn.trim()))
    ) {
        throw publicError(502, 'Kiro returned an incomplete session refresh response');
    }

    const profileArn = refreshed.profileArn ?? auth.profileArn;
    return {
        ...auth,
        accessToken: refreshed.accessToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1_000).toISOString(),
        ...(profileArn ? { profileArn } : {}),
        refreshToken: refreshed.refreshToken,
    };
};

const readValidLiveAuth = async () => {
    const auth = await readBoundedLocalText(KIRO_AUTH_PATH);
    if (auth === null) {
        throw publicError(404, 'No live Kiro session found. Launch Kiro, sign in, then use Save current.');
    }
    if (!auth.trim()) {
        throw publicError(400, `${KIRO_AUTH_PATH} is empty`);
    }
    if (!parseKiroAuth(auth)) {
        throw publicError(400, `${KIRO_AUTH_PATH} is not valid Kiro auth JSON`);
    }
    return auth;
};

const assertReadableAccount = (section: KiroVault, key: string) => {
    if (section.corruptions?.[key]) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    const snapshot = section.data[key];
    if (!snapshot) {
        throw publicError(404, `No Kiro auth named ${key}`);
    }
    if (!isKiroSnapshotConfigValid(snapshot)) {
        throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
    }
    return snapshot;
};

const syncMatchingLiveKiro = async (providedAuthText?: string) => {
    const authText = providedAuthText ?? (await liveAuth().catch(() => ''));
    const auth = parseKiroAuth(authText);
    if (!auth) {
        activeKiroKey = undefined;
        return;
    }
    const section = await readVaultSection('kiro');
    const match = matchingKiroEntry(section, auth);
    if (!match?.[1]) {
        activeKiroKey = undefined;
        return;
    }
    const [key, source] = match;
    await updateVaultSection('kiro', (current) => {
        const snapshot = current.data[key];
        if (
            !snapshot ||
            !isKiroSnapshotConfigValid(snapshot) ||
            snapshot.auth !== source.auth ||
            !isSameAuth(auth, parseKiroAuth(snapshot.auth))
        ) {
            return { result: undefined, write: false };
        }
        if (snapshot.auth === authText) {
            return { result: undefined, write: false };
        }
        snapshot.auth = authText;
        snapshot.updatedAt = new Date().toISOString();
        delete current.limits[key];
        return { result: undefined };
    });
    activeKiroKey = key;
};

const fetchKiroLimitUpdates = async (
    section: KiroVault,
    force: boolean,
    targetKey: string | undefined,
    activeAuth: KiroAuth | null,
) => {
    if (targetKey) {
        assertReadableAccount(section, targetKey);
    }
    const readableData = Object.fromEntries(
        Object.entries(section.data).filter(([, snapshot]) => isKiroSnapshotConfigValid(snapshot)),
    );
    const selected = selectRefreshEntries(readableData, section.limits, targetKey ? { force, targetKey } : { force });
    return boundedMap(selected, async ([key, snapshot]): Promise<KiroLimitUpdate> => {
        const auth = parseKiroAuth(snapshot.auth) as KiroAuth;
        let refreshedAuth: string | undefined;
        let quota: LimitResult;
        try {
            quota = await fetchKiroLimits(auth);
            if (!quota.ok && quota.error === 'Saved Kiro access token is expired or rejected') {
                const refreshed = await refreshSocialAuth(auth, key);
                if (!isSameAuth(activeAuth, auth)) {
                    refreshedAuth = JSON.stringify(refreshed, null, 2);
                }
                quota = await fetchKiroLimits(refreshed);
            }
        } catch (error) {
            quota = cleanLimitError(error);
        }
        return {
            ...(refreshedAuth ? { auth: refreshedAuth } : {}),
            key,
            quota,
            sourceLimitVersion: stateVersion(section.limits[key] ?? null),
            sourceSnapshotVersion: stateVersion(snapshot),
        };
    });
};

const stagedPath = (path: string) => `${path}.${process.pid}.${randomUUID()}.stage`;

const rollbackLiveSession = async (originals: Map<string, string | undefined>) => {
    const rollback = await Promise.allSettled(
        [...originals].map(([path, text]) =>
            text === undefined ? rm(path, { force: true }) : writePrivateFile(path, text),
        ),
    );
    if (rollback.some((result) => result.status === 'rejected')) {
        throw publicError(500, 'Kiro session replacement failed and rollback was incomplete');
    }
};

const commitLiveSession = async (session: KiroSessionFiles) => {
    const currentAuth = parseKiroAuth(await liveAuth().catch(() => ''));
    const oldRegistrationPath = clientRegistrationPath(currentAuth);
    const newRegistrationPath = clientRegistrationPath(parseKiroAuth(session.auth));
    const desired = new Map<string, string | undefined>([
        [KIRO_PROFILE_PATH, session.profile],
        ...(newRegistrationPath ? [[newRegistrationPath, session.clientRegistration] as const] : []),
        ...(oldRegistrationPath && oldRegistrationPath !== newRegistrationPath
            ? [[oldRegistrationPath, undefined] as const]
            : []),
    ]);
    const originals = new Map<string, string | undefined>();
    const staged = new Map<string, string>();
    const authStage = stagedPath(KIRO_AUTH_PATH);
    let liveMutationStarted = false;

    try {
        originals.set(KIRO_AUTH_PATH, await optionalFile(KIRO_AUTH_PATH));
        for (const [path, text] of desired) {
            originals.set(path, await optionalFile(path));
            if (text !== undefined) {
                const stage = stagedPath(path);
                staged.set(path, stage);
                await writePrivateFile(stage, text);
            }
        }
        await writePrivateFile(authStage, session.auth);
        liveMutationStarted = true;
        for (const [path, text] of desired) {
            const stage = staged.get(path);
            if (text === undefined || !stage) {
                await rm(path, { force: true });
            } else {
                await rename(stage, path);
                await chmod(path, 0o600);
            }
        }
        await rename(authStage, KIRO_AUTH_PATH);
        await chmod(KIRO_AUTH_PATH, 0o600);
    } catch (error) {
        if (!liveMutationStarted) {
            throw error;
        }
        await rollbackLiveSession(originals);
        throw error;
    } finally {
        await waitForAll([...staged.values(), authStage].map((path) => rm(path, { force: true }))).catch(() => {});
    }
};

const saveKiroMutation = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const auth = await readValidLiveAuth();
    const registrationPath = clientRegistrationPath(parseKiroAuth(auth));
    const [profile, clientRegistration] = await Promise.all([
        optionalFile(KIRO_PROFILE_PATH),
        registrationPath ? optionalFile(registrationPath) : undefined,
    ]);
    if (profile !== undefined && !parseKiroJsonObject(profile)) {
        throw publicError(400, `${KIRO_PROFILE_PATH} is not a valid JSON object`);
    }
    if (clientRegistration !== undefined && !parseKiroJsonObject(clientRegistration)) {
        throw publicError(400, `${registrationPath} is not a valid JSON object`);
    }

    await updateVaultSection('kiro', (section) => {
        const existing = section.data[safeKey];
        if (section.corruptions?.[safeKey] || (existing && !isKiroSnapshotConfigValid(existing))) {
            throw publicError(409, CORRUPTED_ACCOUNT_ERROR);
        }
        const now = new Date().toISOString();
        section.data[safeKey] = {
            auth,
            ...(clientRegistration ? { clientRegistration } : {}),
            createdAt: existing?.createdAt ?? now,
            ...(profile ? { profile } : {}),
            updatedAt: now,
        };
        delete section.limits[safeKey];
        return { result: undefined };
    });
    activeKiroKey = safeKey;
};

export const saveKiro = async (key: string) => queueKiroMutation(() => saveKiroMutation(key));

const loadKiroMutation = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await assertKiroClosed();
    await syncMatchingLiveKiro();
    const section = await readVaultSection('kiro');
    const source = assertReadableAccount(section, safeKey);
    const parsed = parseKiroAuth(source.auth) as KiroAuth;
    const refreshed = await refreshSocialAuth(parsed, safeKey);
    const serialized = JSON.stringify(refreshed, null, 2);
    const session = await updateVaultSection('kiro', (current) => {
        const snapshot = assertReadableAccount(current, safeKey);
        if (snapshot.auth !== source.auth || snapshot.updatedAt !== source.updatedAt) {
            throw publicError(409, 'Saved Kiro account changed while it was being validated. Try loading it again.');
        }
        snapshot.auth = serialized;
        snapshot.updatedAt = new Date().toISOString();
        delete current.limits[safeKey];
        return {
            result: {
                auth: serialized,
                ...(snapshot.clientRegistration ? { clientRegistration: snapshot.clientRegistration } : {}),
                ...(snapshot.profile ? { profile: snapshot.profile } : {}),
            },
        };
    });

    await commitLiveSession(session);
    activeKiroKey = safeKey;
};

export const loadKiro = async (key: string) => queueKiroMutation(() => loadKiroMutation(key));

const clearKiroMutation = async () => {
    await assertKiroClosed();
    await syncMatchingLiveKiro();
    await clearLiveFiles();
    activeKiroKey = undefined;
};

export const clearKiro = async () => queueKiroMutation(clearKiroMutation);

const deleteKiroMutation = async (key: string) => {
    const safeKey = assertAccountKey(key);
    if (activeKiroKey === safeKey) {
        activeKiroKey = undefined;
    }
    await updateVaultSection('kiro', (section) => {
        if (!section.data[safeKey] && !section.corruptions?.[safeKey]) {
            throw publicError(404, `No Kiro auth named ${safeKey}`);
        }
        delete section.data[safeKey];
        delete section.limits[safeKey];
        if (section.corruptions) {
            delete section.corruptions[safeKey];
        }
        return { result: undefined };
    });
};

export const deleteKiro = async (key: string) => queueKiroMutation(() => deleteKiroMutation(key));

export const kiroState = async (options: { refreshLimitKey?: string; refreshLimits?: boolean } = {}) => {
    const liveAuthText = await queueKiroMutation(async () => {
        const current = await liveAuth().catch(() => '');
        await syncMatchingLiveKiro(current);
        return current;
    });
    const activeAuth = parseKiroAuth(liveAuthText);
    const refreshLimitKey = options.refreshLimitKey ? assertAccountKey(options.refreshLimitKey) : undefined;
    const snapshot = await readVaultSection('kiro');
    const updates = await fetchKiroLimitUpdates(snapshot, options.refreshLimits === true, refreshLimitKey, activeAuth);
    const section =
        updates.length === 0
            ? snapshot
            : await updateVaultSection('kiro', (current) => {
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
                      if (update.auth && update.auth !== saved.auth) {
                          saved.auth = update.auth;
                          saved.updatedAt = new Date().toISOString();
                      }
                      current.limits[update.key] = { fetchedAt: new Date().toISOString(), quota: update.quota };
                      changed = true;
                  }
                  return { result: current, write: changed };
              });
    const matchingKey = matchingKiroEntry(section, activeAuth)?.[0];
    activeKiroKey = matchingKey;
    const healthyEntries = Object.entries(section.data)
        .filter(([, saved]) => isKiroSnapshotConfigValid(saved))
        .map(([key, saved]: [string, KiroSnapshot]) => ({
            active: key === matchingKey,
            key,
            limitUpdatedAt: section.limits[key]?.fetchedAt ?? '',
            quota: section.limits[key]?.quota ?? null,
            updatedAt: saved.updatedAt,
        }));
    const semanticCorruptions = Object.entries(section.data)
        .filter(([, saved]) => !isKiroSnapshotConfigValid(saved))
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
        authPath: KIRO_AUTH_PATH,
        entries: sortAccountEntries([...healthyEntries, ...corruptedEntries]),
        vaultPath: VAULT_PATH,
    };
};
