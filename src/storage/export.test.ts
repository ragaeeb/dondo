import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPlatformWallet } from './export.ts';

const tempVaultPath = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-export-test-'));
    return { dir, path: join(dir, 'vault.json') };
};

it('should export Codex accounts with unencrypted parsed configs', async () => {
    const { dir, path } = await tempVaultPath();
    try {
        await Bun.write(
            path,
            JSON.stringify({
                codex: {
                    data: {
                        work: {
                            auth: JSON.stringify({
                                OPENAI_API_KEY: 'sk-test',
                                tokens: { account_id: 'acct_123', refresh_token: 'refresh-test' },
                            }),
                            createdAt: '2026-01-01T00:00:00.000Z',
                            updatedAt: '2026-01-02T00:00:00.000Z',
                        },
                    },
                    limits: {},
                },
            }),
        );

        const exported = await exportPlatformWallet('codex', path);

        expect(exported.platform).toBe('codex');
        expect(exported.accounts).toEqual([
            {
                config: {
                    OPENAI_API_KEY: 'sk-test',
                    tokens: { account_id: 'acct_123', refresh_token: 'refresh-test' },
                },
                createdAt: '2026-01-01T00:00:00.000Z',
                key: 'work',
                updatedAt: '2026-01-02T00:00:00.000Z',
            },
        ]);
        expect(exported.exportedAt).toBeTruthy();
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should export MiniMax accounts with unencrypted parsed configs', async () => {
    const { dir, path } = await tempVaultPath();
    try {
        await Bun.write(
            path,
            JSON.stringify({
                minimax: {
                    data: {
                        personal: {
                            config: JSON.stringify({
                                tokens: { accessToken: 'minimax-token' },
                                user: { userID: 'user-123' },
                            }),
                            createdAt: '2026-01-01T00:00:00.000Z',
                            updatedAt: '2026-01-02T00:00:00.000Z',
                        },
                    },
                    limits: {},
                },
            }),
        );

        const exported = await exportPlatformWallet('minimax', path);

        expect(exported.platform).toBe('minimax');
        expect(exported.accounts[0]).toEqual({
            config: {
                tokens: { accessToken: 'minimax-token' },
                user: { userID: 'user-123' },
            },
            createdAt: '2026-01-01T00:00:00.000Z',
            key: 'personal',
            updatedAt: '2026-01-02T00:00:00.000Z',
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should export Antigravity accounts with decoded unencrypted token payloads', async () => {
    const { dir, path } = await tempVaultPath();
    const tokenPayload = {
        token: {
            access_token: 'access-test',
            refresh_token: 'refresh-test',
        },
    };
    const password = `go-keyring-base64:${Buffer.from(JSON.stringify(tokenPayload)).toString('base64')}`;

    try {
        await Bun.write(
            path,
            JSON.stringify({
                antigravity: {
                    data: {
                        work: {
                            account: 'antigravity',
                            createdAt: '2026-01-01T00:00:00.000Z',
                            kind: 'Generic Password',
                            label: 'gemini',
                            password,
                            service: 'gemini',
                            updatedAt: '2026-01-02T00:00:00.000Z',
                        },
                    },
                    limits: {},
                },
            }),
        );

        const exported = await exportPlatformWallet('antigravity', path);

        expect(exported.platform).toBe('antigravity');
        expect(exported.accounts[0]).toEqual({
            config: {
                account: 'antigravity',
                kind: 'Generic Password',
                label: 'gemini',
                password,
                service: 'gemini',
                tokenPayload,
            },
            createdAt: '2026-01-01T00:00:00.000Z',
            key: 'work',
            updatedAt: '2026-01-02T00:00:00.000Z',
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
