import { decodeToken } from '../antigravity/google.ts';
import { publicError } from '../errors.ts';
import { readVaultSection } from './vault.ts';

export type ExportPlatform = 'antigravity' | 'codex' | 'kiro' | 'minimax';

const platformNames: Record<ExportPlatform, string> = {
    antigravity: 'Antigravity',
    codex: 'Codex',
    kiro: 'Kiro',
    minimax: 'MiniMax',
};

const parseJsonConfig = (value: string, platform: ExportPlatform, key: string) => {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('Config must be a JSON object');
        }
        return parsed as Record<string, unknown>;
    } catch {
        throw publicError(500, `Saved ${platformNames[platform]} config for "${key}" is not valid JSON`);
    }
};

const assertAccounts = (platform: ExportPlatform, count: number) => {
    if (count === 0) {
        throw publicError(404, `No ${platformNames[platform]} accounts are saved to export`);
    }
};

export const exportPlatformWallet = async (platform: ExportPlatform, path?: string, key?: Buffer) => {
    const exportedAt = new Date().toISOString();

    if (platform === 'antigravity') {
        const section = await readVaultSection('antigravity', path, key);
        const entries = Object.entries(section.data);
        assertAccounts(platform, entries.length);
        return {
            accounts: entries.map(([accountKey, snap]) => {
                const tokenPayload = decodeToken(snap.password);
                if (!tokenPayload) {
                    throw publicError(500, `Saved Antigravity credentials for "${accountKey}" could not be decoded`);
                }
                return {
                    config: {
                        account: snap.account,
                        kind: snap.kind,
                        label: snap.label,
                        service: snap.service,
                        tokenPayload,
                    },
                    createdAt: snap.createdAt,
                    key: accountKey,
                    updatedAt: snap.updatedAt,
                };
            }),
            exportedAt,
            platform,
        };
    }

    if (platform === 'codex') {
        const section = await readVaultSection('codex', path, key);
        const entries = Object.entries(section.data);
        assertAccounts(platform, entries.length);
        return {
            accounts: entries.map(([accountKey, snap]) => ({
                config: parseJsonConfig(snap.auth, platform, accountKey),
                createdAt: snap.createdAt,
                key: accountKey,
                updatedAt: snap.updatedAt,
            })),
            exportedAt,
            platform,
        };
    }

    if (platform === 'minimax') {
        const section = await readVaultSection('minimax', path, key);
        const entries = Object.entries(section.data);
        assertAccounts(platform, entries.length);
        return {
            accounts: entries.map(([accountKey, snap]) => ({
                config: parseJsonConfig(snap.config, platform, accountKey),
                createdAt: snap.createdAt,
                key: accountKey,
                updatedAt: snap.updatedAt,
            })),
            exportedAt,
            platform,
        };
    }

    if (platform === 'kiro') {
        const section = await readVaultSection('kiro', path, key);
        const entries = Object.entries(section.data);
        assertAccounts(platform, entries.length);
        return {
            accounts: entries.map(([accountKey, snap]) => ({
                clientRegistration: snap.clientRegistration
                    ? parseJsonConfig(snap.clientRegistration, platform, accountKey)
                    : undefined,
                config: parseJsonConfig(snap.auth, platform, accountKey),
                createdAt: snap.createdAt,
                key: accountKey,
                profile: snap.profile ? parseJsonConfig(snap.profile, platform, accountKey) : undefined,
                updatedAt: snap.updatedAt,
            })),
            exportedAt,
            platform,
        };
    }

    throw publicError(400, `Unsupported export platform: ${String(platform)}`);
};
