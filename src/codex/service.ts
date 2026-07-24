import { CODEX_AUTH_PATH, VAULT_PATH } from '../config.ts';
import { assertAccountKey, cleanLimitError, publicError } from '../errors.ts';
import { writePrivateFile } from '../storage/file.ts';
import { readVault, updateVault } from '../storage/vault.ts';
import type { AppVault, CodexSnapshot, LimitResult } from '../types.ts';
import { fetchCodexLimits } from './usage.ts';

const liveAuth = async () => {
    const file = Bun.file(CODEX_AUTH_PATH);
    return (await file.exists()) ? await file.text() : '';
};

const parseAuth = (auth: string) => {
    try {
        return JSON.parse(auth) as {
            OPENAI_API_KEY?: string | null;
            tokens?: { account_id?: string; refresh_token?: string };
        };
    } catch {
        return {};
    }
};

const isSameAuth = (a: ReturnType<typeof parseAuth>, b: ReturnType<typeof parseAuth>) => {
    if (a.tokens?.account_id || b.tokens?.account_id) {
        return a.tokens?.account_id === b.tokens?.account_id;
    }
    return !!a.OPENAI_API_KEY && a.OPENAI_API_KEY === b.OPENAI_API_KEY;
};

const hasNoUsageLeft = (quota: LimitResult | null) => {
    const limits = quota?.ok === true ? Object.entries(quota.models).filter(([key]) => key !== 'codex-credits') : [];
    return limits.length > 0 && limits.every(([, model]) => model.percentage <= 0);
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
    if (targetKey && !vault.codex.data[targetKey]) {
        throw publicError(404, `No Codex auth named ${targetKey}`);
    }

    for (const [key, snap] of Object.entries(vault.codex.data)) {
        if ((targetKey && key !== targetKey) || (!force && vault.codex.limits[key])) {
            continue;
        }
        const result = await fetchCodexLimits(snap.auth).catch((error) => ({
            quota: cleanLimitError(error),
        }));
        vault.codex.limits[key] = { fetchedAt: new Date().toISOString(), quota: result.quota };
        changed = true;
    }

    return changed;
};

export const saveCodex = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const authFile = Bun.file(CODEX_AUTH_PATH);
    if (!(await authFile.exists())) {
        throw publicError(404, `${CODEX_AUTH_PATH} does not exist`);
    }
    const auth = await authFile.text();
    if (!auth.trim()) {
        throw publicError(400, `${CODEX_AUTH_PATH} is empty`);
    }
    try {
        JSON.parse(auth);
    } catch {
        throw publicError(400, `${CODEX_AUTH_PATH} is not valid JSON`);
    }

    await updateVault(async (vault) => {
        const existing = vault.codex.data[safeKey];
        const now = new Date().toISOString();
        vault.codex.data[safeKey] = {
            auth,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        delete vault.codex.limits[safeKey];
        return { result: undefined };
    });
};

export const loadCodex = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const snap = (await readVault()).codex.data[safeKey];
    if (!snap) {
        throw publicError(404, `No Codex auth named ${safeKey}`);
    }

    await writePrivateFile(CODEX_AUTH_PATH, snap.auth);
};

export const deleteCodex = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await updateVault(async (vault) => {
        if (!vault.codex.data[safeKey]) {
            throw publicError(404, `No Codex auth named ${safeKey}`);
        }
        delete vault.codex.data[safeKey];
        delete vault.codex.limits[safeKey];
        return { result: undefined };
    });
};

export const codexState = async (options: { refreshLimitKey?: string; refreshLimits?: boolean } = {}) => {
    const refreshLimitKey = options.refreshLimitKey ? assertAccountKey(options.refreshLimitKey) : undefined;
    const vault = await updateVault(async (current) => {
        const changed = await updateMissingOrStaleLimits(current, options.refreshLimits === true, refreshLimitKey);
        return { result: current, write: changed };
    });
    const activeAuth = await liveAuth().catch(() => '');
    const active = parseAuth(activeAuth);

    return {
        authPath: CODEX_AUTH_PATH,
        entries: sortEntries(
            Object.entries(vault.codex.data).map(([key, snap]: [string, CodexSnapshot]) => {
                const cached = vault.codex.limits[key];
                return {
                    active: isSameAuth(active, parseAuth(snap.auth)),
                    key,
                    limitUpdatedAt: cached?.fetchedAt ?? '',
                    quota: cached?.quota ?? null,
                    updatedAt: snap.updatedAt,
                };
            }),
        ),
        vaultPath: VAULT_PATH,
    };
};
