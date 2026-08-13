import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ExportPlatform, type ExportWalletResult, exportPlatformWallet } from './export.ts';
import { updateVaultSection } from './vault.ts';

const TEST_KEY = Buffer.alloc(32, 7);

const tempVaultPath = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-export-test-'));
    return { dir, path: join(dir, 'vault.json') };
};

const writeVaultFixture = async (path: string, value: unknown) => {
    await Bun.write(path, JSON.stringify(value));
};

const materializeWallet = (wallet: ExportWalletResult) => ({ ...wallet, accounts: [...wallet.accounts] });

it('should export Codex accounts with decrypted parsed configs', async () => {
    const { dir, path } = await tempVaultPath();
    const auth = {
        auth_mode: 'apikey',
        OPENAI_API_KEY: 'sk-test',
    };
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.work = {
                    auth: JSON.stringify(auth),
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );

        const exported = await exportPlatformWallet('codex', path, TEST_KEY);

        expect(materializeWallet(exported)).toMatchObject({
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
    const accessToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
        JSON.stringify({ user: { id: 'user-123' } }),
    ).toString('base64url')}.signature`;
    const config = {
        tokens: { accessToken },
        user: { userID: 'user-123' },
    };
    try {
        await updateVaultSection(
            'minimax',
            (section) => {
                section.data.personal = {
                    config: JSON.stringify(config),
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );

        const exported = await exportPlatformWallet('minimax', path, TEST_KEY);

        expect(materializeWallet(exported)).toMatchObject({
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

it('should export Cline accounts with decrypted parsed secrets', async () => {
    const { dir, path } = await tempVaultPath();
    const secrets = {
        providers: {
            cline: {
                settings: {
                    auth: {
                        accessToken: 'cline-access-token',
                        metadata: { userInfo: { email: 'cline@example.com', id: 'cline-user' } },
                        refreshToken: 'cline-refresh-token',
                    },
                    provider: 'cline',
                },
            },
        },
        unrelated: 'setting',
    };
    try {
        await updateVaultSection(
            'cline',
            (section) => {
                section.data.personal = {
                    createdAt: '2026-01-01T00:00:00.000Z',
                    secrets: JSON.stringify(secrets),
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );

        const exported = await exportPlatformWallet('cline', path, TEST_KEY);

        expect(materializeWallet(exported)).toMatchObject({
            accounts: [
                {
                    config: secrets,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    key: 'personal',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
            platform: 'cline',
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should export Kiro accounts with decrypted parsed auth', async () => {
    const { dir, path } = await tempVaultPath();
    const auth = {
        accessToken: 'kiro-access',
        authMethod: 'social',
        profileArn: 'arn:kiro:profile',
        provider: 'Google',
        refreshToken: 'kiro-refresh',
    };
    try {
        await updateVaultSection(
            'kiro',
            (section) => {
                section.data.personal = {
                    auth: JSON.stringify(auth),
                    clientRegistration: JSON.stringify({ clientId: 'kiro-client', clientSecret: 'kiro-secret' }),
                    createdAt: '2026-01-01T00:00:00.000Z',
                    profile: JSON.stringify({ email: 'kiro@example.com' }),
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );

        const exported = await exportPlatformWallet('kiro', path, TEST_KEY);

        expect(materializeWallet(exported)).toMatchObject({
            accounts: [
                {
                    clientRegistration: { clientId: 'kiro-client', clientSecret: 'kiro-secret' },
                    config: auth,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    key: 'personal',
                    profile: { email: 'kiro@example.com' },
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
            platform: 'kiro',
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
        await updateVaultSection(
            'antigravity',
            (section) => {
                section.data.work = {
                    account: 'antigravity',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    identity: 'google-user',
                    kind: 'Generic Password',
                    label: 'gemini',
                    password,
                    service: 'gemini',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );

        const exported = await exportPlatformWallet('antigravity', path, TEST_KEY);

        expect(materializeWallet(exported)).toMatchObject({
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
        await updateVaultSection(
            'antigravity',
            (section) => {
                section.data.broken = {
                    account: 'antigravity',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    identity: 'google-user',
                    kind: 'Generic Password',
                    label: 'gemini',
                    password: 'not-a-keyring-token',
                    service: 'gemini',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );

        const exported = await exportPlatformWallet('antigravity', path, TEST_KEY);
        expect(() => materializeWallet(exported)).toThrow(
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
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.broken = {
                    auth: malformed,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );

        const error = await exportPlatformWallet('codex', path, TEST_KEY)
            .then(materializeWallet)
            .catch((value: unknown) => value);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain('Saved Codex config for "broken" is not valid JSON');
        expect(String(error)).not.toContain(malformed);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject decrypted configs that are valid JSON but invalid for their platform', async () => {
    const cases = [
        ['cline', 'Cline', { secrets: '{}' }],
        ['codex', 'Codex', { auth: JSON.stringify({ auth_mode: 'apikey' }) }],
        ['kiro', 'Kiro', { auth: JSON.stringify({ refreshToken: '' }) }],
        ['minimax', 'MiniMax', { config: JSON.stringify({ tokens: { accessToken: 'not-a-jwt' } }) }],
    ] as const;

    for (const [platform, displayName, secretFields] of cases) {
        const { dir, path } = await tempVaultPath();
        try {
            await updateVaultSection(
                platform,
                (section) => {
                    Object.assign(section.data, {
                        broken: {
                            ...secretFields,
                            createdAt: '2026-01-01T00:00:00.000Z',
                            updatedAt: '2026-01-02T00:00:00.000Z',
                        },
                    });
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            );

            const exported = await exportPlatformWallet(platform, path, TEST_KEY);
            expect(() => materializeWallet(exported)).toThrow(
                `Saved ${displayName} config for "broken" is invalid or incomplete`,
            );
        } finally {
            await rm(dir, { force: true, recursive: true });
        }
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
        expect(String(error)).toContain('Saved Codex accounts include damaged credentials and cannot be exported');
        expect(String(error)).not.toContain(ciphertext);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should decrypt only the requested platform section', async () => {
    const { dir, path } = await tempVaultPath();
    const auth = { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-focused-test' };
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.focused = {
                    auth: JSON.stringify(auth),
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const fixture = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
        fixture.antigravity = {
            data: {
                unrelated: {
                    account: 'antigravity',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    kind: 'Generic Password',
                    label: 'gemini',
                    password: 'enc:v1:invalid',
                    service: 'gemini',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            },
            limits: {},
        };
        await writeVaultFixture(path, fixture);

        const exported = await exportPlatformWallet('codex', path, TEST_KEY);
        expect([...exported.accounts][0]?.config).toEqual(auth);
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
        update = updateVaultSection(
            'codex',
            (section) => {
                section.data.queued = {
                    auth: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-queued-test' }),
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            undefined,
            async () => {
                markStarted();
                await updateGate;
                return TEST_KEY;
            },
        );
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
        expect([...(await exported).accounts][0]?.key).toBe('queued');
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
