import { VAULT_PATH } from '../config.ts';
import { publicError } from '../errors.ts';
import type {
    AppVault,
    CodexSnapshot,
    CodexVault,
    KiroSnapshot,
    KiroVault,
    MinimaxSnapshot,
    MinimaxVault,
    PlatformVault,
    Snapshot,
    VaultSection,
} from '../types.ts';
import { open, seal } from './crypto.ts';
import { writePrivateFile } from './file.ts';

type VaultUpdate<T> = {
    result: T;
    write?: boolean;
};

const emptySection = <T>(): VaultSection<T> => ({ data: {}, limits: {} });

const emptyVault = (): AppVault => ({
    antigravity: emptySection<Snapshot>(),
    codex: emptySection<CodexSnapshot>(),
    kiro: emptySection<KiroSnapshot>(),
    minimax: emptySection<MinimaxSnapshot>(),
});

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

let vaultQueue = Promise.resolve();

const queueVaultOperation = <T>(operation: () => Promise<T>) => {
    const queued = vaultQueue.then(operation);
    vaultQueue = queued.then(
        () => undefined,
        () => undefined,
    );
    return queued;
};

const normalizeVault = (raw: unknown): AppVault => {
    const input = isRecord(raw) ? raw : {};
    const antigravity = isRecord(input.antigravity) ? input.antigravity : {};
    const codex = isRecord(input.codex) ? input.codex : {};
    const kiro = isRecord(input.kiro) ? input.kiro : {};
    const minimax = isRecord(input.minimax) ? input.minimax : {};

    return {
        antigravity: {
            data: isRecord(antigravity.data) ? (antigravity.data as Record<string, Snapshot>) : {},
            limits: isRecord(antigravity.limits) ? (antigravity.limits as PlatformVault['limits']) : {},
        },
        codex: {
            data: isRecord(codex.data) ? (codex.data as Record<string, CodexSnapshot>) : {},
            limits: isRecord(codex.limits) ? (codex.limits as CodexVault['limits']) : {},
        },
        kiro: {
            data: isRecord(kiro.data) ? (kiro.data as Record<string, KiroSnapshot>) : {},
            limits: isRecord(kiro.limits) ? (kiro.limits as KiroVault['limits']) : {},
        },
        minimax: {
            data: isRecord(minimax.data) ? (minimax.data as Record<string, MinimaxSnapshot>) : {},
            limits: isRecord(minimax.limits) ? (minimax.limits as MinimaxVault['limits']) : {},
        },
    };
};

const decryptPlatform = async (platform: PlatformVault, encryptionKey?: Buffer): Promise<PlatformVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(platform.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, password: await open(snap.password, encryptionKey) },
            ]),
        ),
    ),
    limits: platform.limits ?? {},
});

const encryptPlatform = async (platform: PlatformVault, encryptionKey?: Buffer): Promise<PlatformVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(platform.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, password: await seal(snap.password, encryptionKey) },
            ]),
        ),
    ),
    limits: platform.limits ?? {},
});

const decryptCodex = async (codex: CodexVault, encryptionKey?: Buffer): Promise<CodexVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(codex.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, auth: await open(snap.auth, encryptionKey) },
            ]),
        ),
    ),
    limits: codex.limits ?? {},
});

const encryptCodex = async (codex: CodexVault, encryptionKey?: Buffer): Promise<CodexVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(codex.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, auth: await seal(snap.auth, encryptionKey) },
            ]),
        ),
    ),
    limits: codex.limits ?? {},
});

const decryptKiro = async (kiro: KiroVault, encryptionKey?: Buffer): Promise<KiroVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(kiro.data ?? {}).map(async ([key, snap]) => [
                key,
                {
                    ...snap,
                    auth: await open(snap.auth, encryptionKey),
                    clientRegistration: snap.clientRegistration
                        ? await open(snap.clientRegistration, encryptionKey)
                        : undefined,
                    profile: snap.profile ? await open(snap.profile, encryptionKey) : undefined,
                },
            ]),
        ),
    ),
    limits: kiro.limits ?? {},
});

const encryptKiro = async (kiro: KiroVault, encryptionKey?: Buffer): Promise<KiroVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(kiro.data ?? {}).map(async ([key, snap]) => [
                key,
                {
                    ...snap,
                    auth: await seal(snap.auth, encryptionKey),
                    clientRegistration: snap.clientRegistration
                        ? await seal(snap.clientRegistration, encryptionKey)
                        : undefined,
                    profile: snap.profile ? await seal(snap.profile, encryptionKey) : undefined,
                },
            ]),
        ),
    ),
    limits: kiro.limits ?? {},
});

const decryptMinimax = async (minimax: MinimaxVault, encryptionKey?: Buffer): Promise<MinimaxVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(minimax.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, config: await open(snap.config, encryptionKey) },
            ]),
        ),
    ),
    limits: minimax.limits ?? {},
});

const encryptMinimax = async (minimax: MinimaxVault, encryptionKey?: Buffer): Promise<MinimaxVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(minimax.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, config: await seal(snap.config, encryptionKey) },
            ]),
        ),
    ),
    limits: minimax.limits ?? {},
});

const readStoredVault = async (path: string): Promise<AppVault> => {
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return emptyVault();
    }

    const text = await file.text();
    let parsed: unknown = {};
    try {
        parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
        throw publicError(500, `Vault file is not valid JSON: ${path}`);
    }
    return normalizeVault(parsed);
};

const readVaultFile = async (path: string, key?: Buffer): Promise<AppVault> => {
    const vault = await readStoredVault(path);
    return {
        antigravity: await decryptPlatform(vault.antigravity, key),
        codex: await decryptCodex(vault.codex, key),
        kiro: await decryptKiro(vault.kiro, key),
        minimax: await decryptMinimax(vault.minimax, key),
    };
};

export const writeVault = async (vault: AppVault, path = VAULT_PATH, key?: Buffer) => {
    await writePrivateFile(
        path,
        `${JSON.stringify(
            {
                antigravity: await encryptPlatform(vault.antigravity, key),
                codex: await encryptCodex(vault.codex, key),
                kiro: await encryptKiro(vault.kiro, key),
                minimax: await encryptMinimax(vault.minimax, key),
            },
            null,
            2,
        )}\n`,
    );
};

export const readVault = async (path = VAULT_PATH, key?: Buffer): Promise<AppVault> => {
    return readVaultFile(path, key);
};

export const readVaultSection = async <Platform extends keyof AppVault>(
    platform: Platform,
    path = VAULT_PATH,
    key?: Buffer,
): Promise<AppVault[Platform]> => {
    return queueVaultOperation(async () => {
        const vault = await readStoredVault(path);
        if (platform === 'antigravity') {
            return (await decryptPlatform(vault.antigravity, key)) as AppVault[Platform];
        }
        if (platform === 'codex') {
            return (await decryptCodex(vault.codex, key)) as AppVault[Platform];
        }
        if (platform === 'kiro') {
            return (await decryptKiro(vault.kiro, key)) as AppVault[Platform];
        }
        if (platform === 'minimax') {
            return (await decryptMinimax(vault.minimax, key)) as AppVault[Platform];
        }
        throw new Error(`Unsupported vault platform: ${String(platform)}`);
    });
};

export const updateVault = async <T>(operation: (vault: AppVault) => Promise<VaultUpdate<T>>, path = VAULT_PATH) => {
    return queueVaultOperation(async () => {
        const vault = await readVault(path);
        const update = await operation(vault);
        if (update.write !== false) {
            await writeVault(vault, path);
        }
        return update.result;
    });
};
