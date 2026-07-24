import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
    KIRO_AUTH_PATH,
    KIRO_AUTH_REFRESH_URL,
    KIRO_PROCESS_NAME,
    KIRO_PROFILE_PATH,
    KIRO_USER_AGENT,
    VAULT_PATH,
} from '../config.ts';
import { assertAccountKey, publicError } from '../errors.ts';
import { writePrivateFile } from '../storage/file.ts';
import { readVault, updateVault } from '../storage/vault.ts';
import type { KiroSnapshot } from '../types.ts';

type KiroAuth = {
    accessToken?: string;
    authMethod?: string;
    clientIdHash?: string;
    expiresAt?: string;
    profileArn?: string;
    provider?: string;
    refreshToken: string;
};

type KiroRefreshResponse = {
    accessToken: string;
    expiresIn: number;
    profileArn?: string;
    refreshToken: string;
};

let activeKiroKey: string | undefined;

const isKiroRunning = async () => {
    if (process.platform === 'win32') {
        const proc = Bun.spawn(['tasklist', '/FI', `IMAGENAME eq ${KIRO_PROCESS_NAME}`, '/NH'], {
            stderr: 'ignore',
            stdout: 'pipe',
        });
        const output = await new Response(proc.stdout).text();
        return (await proc.exited) === 0 && output.toLowerCase().includes(KIRO_PROCESS_NAME.toLowerCase());
    }

    const proc = Bun.spawn(['pgrep', '-x', KIRO_PROCESS_NAME], {
        stderr: 'ignore',
        stdout: 'ignore',
    });
    return (await proc.exited) === 0;
};

const assertKiroClosed = async () => {
    if (await isKiroRunning()) {
        throw publicError(
            409,
            'Quit Kiro completely before clearing or loading an account. Kiro must be closed while Dondo replaces its local login files.',
        );
    }
};

const parseAuth = (auth: string): KiroAuth | null => {
    try {
        const value = JSON.parse(auth) as unknown;
        if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value) ||
            typeof (value as { refreshToken?: unknown }).refreshToken !== 'string' ||
            !(value as { refreshToken: string }).refreshToken
        ) {
            return null;
        }
        return value as KiroAuth;
    } catch {
        return null;
    }
};

const liveAuth = async () => {
    const file = Bun.file(KIRO_AUTH_PATH);
    return (await file.exists()) ? await file.text() : '';
};

const optionalFile = async (path: string) => {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : undefined;
};

const clientRegistrationPath = (auth: KiroAuth | null) => {
    return auth?.clientIdHash && /^[a-f0-9]{40}$/i.test(auth.clientIdHash)
        ? join(dirname(KIRO_AUTH_PATH), `${auth.clientIdHash}.json`)
        : undefined;
};

const clearLiveFiles = async () => {
    const auth = parseAuth(await liveAuth().catch(() => ''));
    const registrationPath = clientRegistrationPath(auth);
    const paths = [KIRO_AUTH_PATH, KIRO_PROFILE_PATH, ...(registrationPath ? [registrationPath] : [])];
    await Promise.all(paths.map((path) => rm(path, { force: true })));
};

const isSameAuth = (a: KiroAuth | null, b: KiroAuth | null) => {
    return Boolean(a && b && a.refreshToken === b.refreshToken);
};

const refreshSocialAuth = async (auth: KiroAuth, key: string) => {
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
        value = await response.json();
    } catch {
        throw publicError(502, 'Kiro returned an invalid session refresh response');
    }
    const refreshed = value as Partial<KiroRefreshResponse>;
    if (
        typeof refreshed.accessToken !== 'string' ||
        !refreshed.accessToken ||
        typeof refreshed.refreshToken !== 'string' ||
        !refreshed.refreshToken ||
        typeof refreshed.expiresIn !== 'number' ||
        !Number.isFinite(refreshed.expiresIn) ||
        refreshed.expiresIn <= 0
    ) {
        throw publicError(502, 'Kiro returned an incomplete session refresh response');
    }

    return {
        ...auth,
        accessToken: refreshed.accessToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1_000).toISOString(),
        profileArn: refreshed.profileArn ?? auth.profileArn,
        refreshToken: refreshed.refreshToken,
    };
};

const readValidLiveAuth = async () => {
    const authFile = Bun.file(KIRO_AUTH_PATH);
    if (!(await authFile.exists())) {
        throw publicError(404, 'No live Kiro session found. Launch Kiro, sign in, then use Save current.');
    }
    const auth = await authFile.text();
    if (!auth.trim()) {
        throw publicError(400, `${KIRO_AUTH_PATH} is empty`);
    }
    if (!parseAuth(auth)) {
        throw publicError(400, `${KIRO_AUTH_PATH} is not valid Kiro auth JSON`);
    }
    return auth;
};

const syncActiveKiro = async () => {
    if (!activeKiroKey) {
        return;
    }
    const auth = await liveAuth().catch(() => '');
    if (!parseAuth(auth)) {
        activeKiroKey = undefined;
        return;
    }

    const key = activeKiroKey;
    await updateVault(async (vault) => {
        const snap = vault.kiro.data[key];
        if (!snap || snap.auth === auth) {
            return { result: undefined, write: false };
        }
        snap.auth = auth;
        snap.updatedAt = new Date().toISOString();
        return { result: undefined };
    });
};

export const saveKiro = async (key: string) => {
    const safeKey = assertAccountKey(key);
    const auth = await readValidLiveAuth();
    const registrationPath = clientRegistrationPath(parseAuth(auth));
    const [profile, clientRegistration] = await Promise.all([
        optionalFile(KIRO_PROFILE_PATH),
        registrationPath ? optionalFile(registrationPath) : undefined,
    ]);

    await updateVault(async (vault) => {
        const existing = vault.kiro.data[safeKey];
        const now = new Date().toISOString();
        vault.kiro.data[safeKey] = {
            auth,
            clientRegistration,
            createdAt: existing?.createdAt ?? now,
            profile,
            updatedAt: now,
        };
        return { result: undefined };
    });
    activeKiroKey = safeKey;
};

export const loadKiro = async (key: string) => {
    const safeKey = assertAccountKey(key);
    await assertKiroClosed();
    await syncActiveKiro();
    const session = await updateVault(async (vault) => {
        const snap = vault.kiro.data[safeKey];
        if (!snap) {
            throw publicError(404, `No Kiro auth named ${safeKey}`);
        }
        const parsed = parseAuth(snap.auth);
        if (!parsed) {
            throw publicError(500, `Saved Kiro auth named ${safeKey} is not valid Kiro auth JSON`);
        }

        const refreshed = await refreshSocialAuth(parsed, safeKey);
        const serialized = JSON.stringify(refreshed, null, 2);
        snap.auth = serialized;
        snap.updatedAt = new Date().toISOString();
        return {
            result: {
                auth: serialized,
                clientRegistration: snap.clientRegistration,
                profile: snap.profile,
            },
        };
    });

    await clearLiveFiles();
    await writePrivateFile(KIRO_AUTH_PATH, session.auth);
    const registrationPath = clientRegistrationPath(parseAuth(session.auth));
    await Promise.all([
        session.profile ? writePrivateFile(KIRO_PROFILE_PATH, session.profile) : undefined,
        registrationPath && session.clientRegistration
            ? writePrivateFile(registrationPath, session.clientRegistration)
            : undefined,
    ]);
    activeKiroKey = safeKey;
};

export const clearKiro = async () => {
    await assertKiroClosed();
    activeKiroKey = undefined;
    await clearLiveFiles();
};

export const deleteKiro = async (key: string) => {
    const safeKey = assertAccountKey(key);
    if (activeKiroKey === safeKey) {
        activeKiroKey = undefined;
    }
    await updateVault(async (vault) => {
        if (!vault.kiro.data[safeKey]) {
            throw publicError(404, `No Kiro auth named ${safeKey}`);
        }
        delete vault.kiro.data[safeKey];
        delete vault.kiro.limits[safeKey];
        return { result: undefined };
    });
};

export const kiroState = async () => {
    await syncActiveKiro();
    const vault = await readVault();
    const activeAuth = parseAuth(await liveAuth().catch(() => ''));
    const matchingKey = Object.entries(vault.kiro.data).find(([, snap]) =>
        isSameAuth(activeAuth, parseAuth(snap.auth)),
    )?.[0];
    if (matchingKey) {
        activeKiroKey = matchingKey;
    } else if (!activeAuth) {
        activeKiroKey = undefined;
    }

    return {
        authPath: KIRO_AUTH_PATH,
        entries: Object.entries(vault.kiro.data)
            .map(([key, snap]: [string, KiroSnapshot]) => ({
                active: isSameAuth(activeAuth, parseAuth(snap.auth)),
                key,
                limitUpdatedAt: '',
                quota: null,
                updatedAt: snap.updatedAt,
            }))
            .sort((a, b) => {
                if (a.active !== b.active) {
                    return a.active ? -1 : 1;
                }
                return a.key.localeCompare(b.key);
            }),
        vaultPath: VAULT_PATH,
    };
};
