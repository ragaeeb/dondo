import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seal } from './crypto.ts';
import { type ExportPlatform, exportPlatformWallet } from './export.ts';
import { updateVault } from './vault.ts';

const TEST_KEY = Buffer.alloc(32, 7);

const tempVaultPath = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-export-test-'));
    return { dir, path: join(dir, 'vault.json') };
};

const writeVaultFixture = async (path: string, value: unknown) => {
    await Bun.write(path, JSON.stringify(value));
};

it('should export Codex accounts with decrypted parsed configs', async () => {
    const { dir, path } = await tempVaultPath();
    const auth = {
        OPENAI_API_KEY: 'sk-test',
        tokens: { account_id: 'acct_123', refresh_token: 'refresh-test' },
    };
    try {
        await writeVaultFixture(path, {
            codex: {
                data: {
                    work: {
                        auth: await seal(JSON.stringify(auth), TEST_KEY),
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    },
                },
                limits: {},
            },
        });

        const exported = await exportPlatformWallet('codex', path, TEST_KEY);

        expect(exported).toMatchObject({
            accounts: [
                {
                    config: auth,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    key: 'work',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
            platform: 'codex',
        });
        expect(exported.exportedAt).toBeTruthy();
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should export MiniMax accounts with decrypted parsed configs', async () => {
    const { dir, path } = await tempVaultPath();
    const config = {
        tokens: { accessToken: 'minimax-token' },
        user: { userID: 'user-123' },
    };
    try {
        await writeVaultFixture(path, {
            minimax: {
                data: {
                    personal: {
                        config: await seal(JSON.stringify(config), TEST_KEY),
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    },
                },
                limits: {},
            },
        });

        const exported = await exportPlatformWallet('minimax', path, TEST_KEY);

        expect(exported).toMatchObject({
            accounts: [
                {
                    config,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    key: 'personal',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
            platform: 'minimax',
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should export Antigravity accounts with one decoded credential payload', async () => {
    const { dir, path } = await tempVaultPath();
    const tokenPayload = {
        token: {
            access_token: 'access-test',
            refresh_token: 'refresh-test',
        },
    };
    const password = `go-keyring-base64:${Buffer.from(JSON.stringify(tokenPayload)).toString('base64')}`;

    try {
        await writeVaultFixture(path, {
            antigravity: {
                data: {
                    work: {
                        account: 'antigravity',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        kind: 'Generic Password',
                        label: 'gemini',
                        password: await seal(password, TEST_KEY),
                        service: 'gemini',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    },
                },
                limits: {},
            },
        });

        const exported = await exportPlatformWallet('antigravity', path, TEST_KEY);

        expect(exported).toMatchObject({
            accounts: [
                {
                    config: {
                        account: 'antigravity',
                        kind: 'Generic Password',
                        label: 'gemini',
                        service: 'gemini',
                        tokenPayload,
                    },
                    createdAt: '2026-01-01T00:00:00.000Z',
                    key: 'work',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
            platform: 'antigravity',
        });
        expect(JSON.stringify(exported)).not.toContain(password);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject an empty platform export', async () => {
    const { dir, path } = await tempVaultPath();
    try {
        await expect(exportPlatformWallet('codex', path, TEST_KEY)).rejects.toThrow(
            'No Codex accounts are saved to export',
        );
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject malformed Antigravity token data', async () => {
    const { dir, path } = await tempVaultPath();
    try {
        await writeVaultFixture(path, {
            antigravity: {
                data: {
                    broken: {
                        account: 'antigravity',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        kind: 'Generic Password',
                        label: 'gemini',
                        password: 'not-a-keyring-token',
                        service: 'gemini',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    },
                },
                limits: {},
            },
        });

        await expect(exportPlatformWallet('antigravity', path, TEST_KEY)).rejects.toThrow(
            'Saved Antigravity credentials for "broken" could not be decoded',
        );
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject malformed JSON configs without returning their contents', async () => {
    const { dir, path } = await tempVaultPath();
    const malformed = 'Bearer private-test-value';
    try {
        await writeVaultFixture(path, {
            codex: {
                data: {
                    broken: {
                        auth: malformed,
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    },
                },
                limits: {},
            },
        });

        const error = await exportPlatformWallet('codex', path, TEST_KEY).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain('Saved Codex config for "broken" is not valid JSON');
        expect(String(error)).not.toContain(malformed);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject corrupted encrypted configs without returning ciphertext', async () => {
    const { dir, path } = await tempVaultPath();
    const ciphertext = 'enc:v1:AAAA';
    try {
        await writeVaultFixture(path, {
            codex: {
                data: {
                    broken: {
                        auth: ciphertext,
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    },
                },
                limits: {},
            },
        });

        const error = await exportPlatformWallet('codex', path, TEST_KEY).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain('Encrypted vault value is malformed');
        expect(String(error)).not.toContain(ciphertext);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should decrypt only the requested platform section', async () => {
    const { dir, path } = await tempVaultPath();
    const auth = { OPENAI_API_KEY: 'sk-focused-test' };
    try {
        await writeVaultFixture(path, {
            antigravity: {
                data: {
                    unrelated: {
                        account: 'antigravity',
                        createdAt: '',
                        kind: 'Generic Password',
                        label: 'gemini',
                        password: 'enc:v1:invalid',
                        service: 'gemini',
                        updatedAt: '',
                    },
                },
                limits: {},
            },
            codex: {
                data: {
                    focused: {
                        auth: await seal(JSON.stringify(auth), TEST_KEY),
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    },
                },
                limits: {},
            },
        });

        const exported = await exportPlatformWallet('codex', path, TEST_KEY);
        expect(exported.accounts[0]?.config).toEqual(auth);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should queue an export behind an in-flight vault update', async () => {
    const { dir, path } = await tempVaultPath();
    let releaseUpdate = () => {};
    let markStarted = () => {};
    const updateGate = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
    });
    const updateStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    let update: Promise<unknown> | undefined;
    let exported: ReturnType<typeof exportPlatformWallet> | undefined;

    try {
        update = updateVault(async () => {
            markStarted();
            await updateGate;
            await writeVaultFixture(path, {
                codex: {
                    data: {
                        queued: {
                            auth: JSON.stringify({ OPENAI_API_KEY: 'sk-queued-test' }),
                            createdAt: '2026-01-01T00:00:00.000Z',
                            updatedAt: '2026-01-02T00:00:00.000Z',
                        },
                    },
                    limits: {},
                },
            });
            return { result: undefined, write: false };
        }, path);
        await updateStarted;

        let exportSettled = false;
        exported = exportPlatformWallet('codex', path, TEST_KEY);
        void exported.then(
            () => {
                exportSettled = true;
            },
            () => {
                exportSettled = true;
            },
        );
        await Bun.sleep(10);
        expect(exportSettled).toBe(false);

        releaseUpdate();
        await update;
        expect((await exported).accounts[0]?.key).toBe('queued');
    } finally {
        releaseUpdate();
        await update?.catch(() => undefined);
        await exported?.catch(() => undefined);
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject unsupported platforms at runtime', async () => {
    await expect(exportPlatformWallet('unknown' as ExportPlatform)).rejects.toThrow(
        'Unsupported export platform: unknown',
    );
});
