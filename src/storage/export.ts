import { decodeToken } from '../antigravity/google.ts';
import { readVault } from './vault.ts';

export type ExportPlatform = 'antigravity' | 'codex' | 'minimax';

const parseJsonConfig = (value: string) => {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
};

export const exportPlatformWallet = async (platform: ExportPlatform, path?: string) => {
    const vault = await readVault(path);
    const exportedAt = new Date().toISOString();

    if (platform === 'antigravity') {
        return {
            accounts: Object.entries(vault.antigravity.data).map(([key, snap]) => ({
                config: {
                    account: snap.account,
                    kind: snap.kind,
                    label: snap.label,
                    password: snap.password,
                    service: snap.service,
                    tokenPayload: decodeToken(snap.password),
                },
                createdAt: snap.createdAt,
                key,
                updatedAt: snap.updatedAt,
            })),
            exportedAt,
            platform,
        };
    }

    if (platform === 'codex') {
        return {
            accounts: Object.entries(vault.codex.data).map(([key, snap]) => ({
                config: parseJsonConfig(snap.auth),
                createdAt: snap.createdAt,
                key,
                updatedAt: snap.updatedAt,
            })),
            exportedAt,
            platform,
        };
    }

    return {
        accounts: Object.entries(vault.minimax.data).map(([key, snap]) => ({
            config: parseJsonConfig(snap.config),
            createdAt: snap.createdAt,
            key,
            updatedAt: snap.updatedAt,
        })),
        exportedAt,
        platform,
    };
};
