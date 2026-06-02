import { VAULT_PATH } from '../config.ts';
import { publicError } from '../errors.ts';
import type { AppVault, CodexSnapshot, CodexVault, PlatformVault, Snapshot, VaultSection } from '../types.ts';
import { open, seal } from './crypto.ts';
import { writePrivateFile } from './file.ts';

type VaultUpdate<T> = {
    result: T;
    write?: boolean;
};

const emptySection = <T>(): VaultSection<T> => ({ data: {}, limits: {} });

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

let vaultQueue = Promise.resolve();

const normalizeVault = (raw: unknown): AppVault => {
    const input = isRecord(raw) ? raw : {};
    const antigravity = isRecord(input.antigravity) ? input.antigravity : {};
    const codex = isRecord(input.codex) ? input.codex : {};

    return {
        antigravity: {
            data: isRecord(antigravity.data) ? (antigravity.data as Record<string, Snapshot>) : {},
            limits: isRecord(antigravity.limits) ? (antigravity.limits as PlatformVault['limits']) : {},
        },
        codex: {
            data: isRecord(codex.data) ? (codex.data as Record<string, CodexSnapshot>) : {},
            limits: isRecord(codex.limits) ? (codex.limits as CodexVault['limits']) : {},
        },
    };
};

const decryptPlatform = async (platform: PlatformVault): Promise<PlatformVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(platform.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, password: await open(snap.password) },
            ]),
        ),
    ),
    limits: platform.limits ?? {},
});

const encryptPlatform = async (platform: PlatformVault): Promise<PlatformVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(platform.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, password: await seal(snap.password) },
            ]),
        ),
    ),
    limits: platform.limits ?? {},
});

const decryptCodex = async (codex: CodexVault): Promise<CodexVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(codex.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, auth: await open(snap.auth) },
            ]),
        ),
    ),
    limits: codex.limits ?? {},
});

const encryptCodex = async (codex: CodexVault): Promise<CodexVault> => ({
    data: Object.fromEntries(
        await Promise.all(
            Object.entries(codex.data ?? {}).map(async ([key, snap]) => [
                key,
                { ...snap, auth: await seal(snap.auth) },
            ]),
        ),
    ),
    limits: codex.limits ?? {},
});

const readVaultFile = async (path: string): Promise<AppVault> => {
    const text = await Bun.file(path).text();
    let parsed: unknown = {};
    try {
        parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
        throw publicError(500, `Vault file is not valid JSON: ${path}`);
    }
    const vault = normalizeVault(parsed);
    return { antigravity: await decryptPlatform(vault.antigravity), codex: await decryptCodex(vault.codex) };
};

export const writeVault = async (vault: AppVault, path = VAULT_PATH) => {
    await writePrivateFile(
        path,
        `${JSON.stringify(
            { antigravity: await encryptPlatform(vault.antigravity), codex: await encryptCodex(vault.codex) },
            null,
            2,
        )}\n`,
    );
};

export const readVault = async (path = VAULT_PATH): Promise<AppVault> => {
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return { antigravity: emptySection<Snapshot>(), codex: emptySection<CodexSnapshot>() };
    }
    return readVaultFile(path);
};

export const updateVault = async <T>(operation: (vault: AppVault) => Promise<VaultUpdate<T>>, path = VAULT_PATH) => {
    const queued = vaultQueue.then(async () => {
        const vault = await readVault(path);
        const update = await operation(vault);
        if (update.write !== false) {
            await writeVault(vault, path);
        }
        return update.result;
    });
    vaultQueue = queued.then(
        () => undefined,
        () => undefined,
    );
    return queued;
};
