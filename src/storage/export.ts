import { decodeToken } from '../antigravity/google.ts';
import { parseClineProviders } from '../cline/providers.ts';
import { parseCodexAuth } from '../codex/auth.ts';
import { ANTIGRAVITY_ACCOUNT, ANTIGRAVITY_SERVICE } from '../config.ts';
import { publicError } from '../errors.ts';
import { isKiroSnapshotConfigValid } from '../kiro/auth.ts';
import { parseMiniMaxConfig } from '../minimax/usage.ts';
import type { VaultSection } from '../types.ts';
import { readVaultSection } from './vault.ts';

export type ExportPlatform = 'antigravity' | 'cline' | 'codex' | 'kiro' | 'minimax';

const platformNames: Record<ExportPlatform, string> = {
    antigravity: 'Antigravity',
    cline: 'Cline',
    codex: 'Codex',
    kiro: 'Kiro',
    minimax: 'MiniMax',
};

export type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;

export type JsonObject = {
    [key: string]: JsonValue;
};

const jsonChildren = (value: unknown) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return [];
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('Config contains a non-finite number');
        }
        return [];
    }
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'object') {
        throw new Error('Config contains a non-JSON value');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Config contains a non-plain object');
    }
    return Object.values(value);
};

const assertJsonObject = (value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Config must be a JSON object');
    }
    const pending: unknown[] = [value];
    while (pending.length > 0) {
        pending.push(...jsonChildren(pending.pop()));
    }
    return value as JsonObject;
};

const parseJsonConfig = (value: string, platform: ExportPlatform, key: string) => {
    try {
        return assertJsonObject(JSON.parse(value) as unknown);
    } catch {
        throw publicError(500, `Saved ${platformNames[platform]} config for "${key}" is not valid JSON`);
    }
};

const parseValidatedConfig = (
    value: string,
    platform: ExportPlatform,
    key: string,
    validate: (text: string) => unknown,
) => {
    const parsed = parseJsonConfig(value, platform, key);
    if (!validate(value)) {
        throw publicError(500, `Saved ${platformNames[platform]} config for "${key}" is invalid or incomplete`);
    }
    return parsed;
};

const assertAccounts = (platform: ExportPlatform, count: number) => {
    if (count === 0) {
        throw publicError(404, `No ${platformNames[platform]} accounts are saved to export`);
    }
};

const assertExportable = (platform: ExportPlatform, section: VaultSection<unknown>) => {
    if (section.corruptions && Object.keys(section.corruptions).length > 0) {
        throw publicError(
            500,
            `Saved ${platformNames[platform]} accounts include damaged credentials and cannot be exported`,
        );
    }
};

export type ExportedAccount = {
    config: JsonObject;
    key: string;
    [key: string]: JsonValue;
};

export type ExportWalletResult = {
    accounts: Iterable<ExportedAccount>;
    exportedAt: string;
    platform: ExportPlatform;
};

type AccountExporter = (path?: string, key?: Buffer) => Promise<Iterable<ExportedAccount>>;

const mappedAccounts = <Snapshot>(
    platform: ExportPlatform,
    data: Record<string, Snapshot>,
    mapper: (accountKey: string, snapshot: Snapshot) => ExportedAccount,
): Iterable<ExportedAccount> => {
    const accountKeys = Object.keys(data);
    assertAccounts(platform, accountKeys.length);
    return {
        [Symbol.iterator]: () => {
            let index = 0;
            return {
                next: (): IteratorResult<ExportedAccount> => {
                    const accountKey = accountKeys[index];
                    if (accountKey === undefined) {
                        return { done: true, value: undefined };
                    }
                    index += 1;
                    return { done: false, value: mapper(accountKey, data[accountKey] as Snapshot) };
                },
            };
        },
    };
};

const exportAntigravityAccounts: AccountExporter = async (path, key) => {
    const section = await readVaultSection('antigravity', path, key);
    assertExportable('antigravity', section);
    return mappedAccounts('antigravity', section.data, (accountKey, snap) => {
        if (snap.account !== ANTIGRAVITY_ACCOUNT || snap.service !== ANTIGRAVITY_SERVICE) {
            throw publicError(500, `Saved Antigravity credentials for "${accountKey}" do not match this installation`);
        }
        const tokenPayload = decodeToken(snap.password);
        if (!tokenPayload) {
            throw publicError(500, `Saved Antigravity credentials for "${accountKey}" could not be decoded`);
        }
        return {
            config: assertJsonObject({
                account: snap.account,
                kind: snap.kind,
                label: snap.label,
                service: snap.service,
                tokenPayload,
            }),
            createdAt: snap.createdAt,
            key: accountKey,
            updatedAt: snap.updatedAt,
        };
    });
};

const exportClineAccounts: AccountExporter = async (path, key) => {
    const section = await readVaultSection('cline', path, key);
    assertExportable('cline', section);
    return mappedAccounts('cline', section.data, (accountKey, snap) => ({
        config: parseValidatedConfig(snap.secrets, 'cline', accountKey, parseClineProviders),
        createdAt: snap.createdAt,
        key: accountKey,
        updatedAt: snap.updatedAt,
    }));
};

const exportCodexAccounts: AccountExporter = async (path, key) => {
    const section = await readVaultSection('codex', path, key);
    assertExportable('codex', section);
    return mappedAccounts('codex', section.data, (accountKey, snap) => ({
        config: parseValidatedConfig(snap.auth, 'codex', accountKey, parseCodexAuth),
        createdAt: snap.createdAt,
        key: accountKey,
        updatedAt: snap.updatedAt,
    }));
};

const exportKiroAccounts: AccountExporter = async (path, key) => {
    const section = await readVaultSection('kiro', path, key);
    assertExportable('kiro', section);
    return mappedAccounts('kiro', section.data, (accountKey, snap) => {
        if (!isKiroSnapshotConfigValid(snap)) {
            throw publicError(500, `Saved Kiro config for "${accountKey}" is invalid or incomplete`);
        }
        return {
            ...(snap.clientRegistration
                ? { clientRegistration: parseJsonConfig(snap.clientRegistration, 'kiro', accountKey) }
                : {}),
            config: parseJsonConfig(snap.auth, 'kiro', accountKey),
            createdAt: snap.createdAt,
            key: accountKey,
            ...(snap.profile ? { profile: parseJsonConfig(snap.profile, 'kiro', accountKey) } : {}),
            updatedAt: snap.updatedAt,
        };
    });
};

const exportMinimaxAccounts: AccountExporter = async (path, key) => {
    const section = await readVaultSection('minimax', path, key);
    assertExportable('minimax', section);
    return mappedAccounts('minimax', section.data, (accountKey, snap) => ({
        config: parseValidatedConfig(snap.config, 'minimax', accountKey, parseMiniMaxConfig),
        createdAt: snap.createdAt,
        key: accountKey,
        updatedAt: snap.updatedAt,
    }));
};

const accountExporters: Record<ExportPlatform, AccountExporter> = {
    antigravity: exportAntigravityAccounts,
    cline: exportClineAccounts,
    codex: exportCodexAccounts,
    kiro: exportKiroAccounts,
    minimax: exportMinimaxAccounts,
};

const isExportPlatform = (platform: string): platform is ExportPlatform => {
    return Object.hasOwn(accountExporters, platform);
};

export const exportPlatformWallet = async (
    platform: ExportPlatform,
    path?: string,
    key?: Buffer,
): Promise<ExportWalletResult> => {
    if (!isExportPlatform(platform)) {
        throw publicError(400, `Unsupported export platform: ${String(platform)}`);
    }
    return {
        accounts: await accountExporters[platform](path, key),
        exportedAt: new Date().toISOString(),
        platform,
    };
};
