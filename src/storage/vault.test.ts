import { expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat, truncate, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    MAX_VAULT_ACCOUNTS_PER_PLATFORM,
    MAX_VAULT_FILE_BYTES,
    MAX_VAULT_MODELS_PER_ACCOUNT,
    readVaultSection,
    updateVaultSection,
} from './vault.ts';

const TEST_KEY = Buffer.alloc(32, 3);

const tempVault = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-vault-test-'));
    return { dir, path: join(dir, 'vault.json') };
};

const runChild = async (code: string) => {
    const child = Bun.spawn(['bun', '-e', code], { stderr: 'pipe', stdout: 'pipe' });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) {
        throw new Error(`Child process failed (${exitCode}): ${stderr}`);
    }
};

it('should read missing platform sections as empty', async () => {
    const { dir, path } = await tempVault();
    try {
        const sections = await Promise.all([
            readVaultSection('antigravity', path, TEST_KEY),
            readVaultSection('cline', path, TEST_KEY),
            readVaultSection('codex', path, TEST_KEY),
            readVaultSection('kiro', path, TEST_KEY),
            readVaultSection('minimax', path, TEST_KEY),
        ]);
        expect(sections).toEqual([
            { data: {}, limits: {} },
            { data: {}, limits: {} },
            { data: {}, limits: {} },
            { data: {}, limits: {} },
            { data: {}, limits: {} },
        ]);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should write a platform section with private file permissions', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.private = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                section.limits.private = {
                    fetchedAt: '2026-01-03T00:00:00.000Z',
                    quota: { error: 'private', ok: false },
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );

        expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should include the vault path in corrupt JSON errors', async () => {
    const { dir, path } = await tempVault();
    try {
        await Bun.write(path, '{');

        await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow(
            `Vault file is not valid JSON: ${path}`,
        );
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should serialize queued vault updates', async () => {
    const { dir, path } = await tempVault();
    try {
        await Promise.all([
            updateVaultSection(
                'antigravity',
                (section) => {
                    section.data.a = {
                        account: 'antigravity',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        identity: 'google-user',
                        kind: 'Generic Password',
                        label: 'a',
                        password: 'a',
                        service: 'a',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                    section.limits.a = {
                        fetchedAt: '2026-01-03T00:00:00.000Z',
                        quota: { error: 'a', ok: false },
                    };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
            updateVaultSection(
                'codex',
                (section) => {
                    section.data.b = {
                        auth: '{}',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                    section.limits.b = {
                        fetchedAt: '2026-01-03T00:00:00.000Z',
                        quota: { error: 'b', ok: false },
                    };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
            updateVaultSection(
                'minimax',
                (section) => {
                    section.data.c = {
                        config: '{}',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                    section.limits.c = {
                        fetchedAt: '2026-01-03T00:00:00.000Z',
                        quota: { error: 'c', ok: false },
                    };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
            updateVaultSection(
                'cline',
                (section) => {
                    section.data.e = {
                        createdAt: '2026-01-01T00:00:00.000Z',
                        secrets: '{}',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                    section.limits.e = {
                        fetchedAt: '2026-01-03T00:00:00.000Z',
                        quota: { error: 'e', ok: false },
                    };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
            updateVaultSection(
                'kiro',
                (section) => {
                    section.data.d = {
                        auth: '{}',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                    section.limits.d = {
                        fetchedAt: '2026-01-03T00:00:00.000Z',
                        quota: { error: 'd', ok: false },
                    };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
        ]);

        const [antigravity, codex, minimax, kiro, cline] = await Promise.all([
            readVaultSection('antigravity', path, TEST_KEY),
            readVaultSection('codex', path, TEST_KEY),
            readVaultSection('minimax', path, TEST_KEY),
            readVaultSection('kiro', path, TEST_KEY),
            readVaultSection('cline', path, TEST_KEY),
        ]);
        expect(antigravity.limits.a).toBeDefined();
        expect(codex.limits.b).toBeDefined();
        expect(minimax.limits.c).toBeDefined();
        expect(kiro.limits.d).toBeDefined();
        expect(cline.limits.e).toBeDefined();
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should serialize operations per vault path without blocking a different path', async () => {
    const first = await tempVault();
    const second = await tempVault();
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
    });
    let firstUpdate: Promise<void> | undefined;

    try {
        firstUpdate = updateVaultSection(
            'codex',
            (section) => {
                section.data.first = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                section.limits.first = { fetchedAt: '2026-01-03T00:00:00.000Z', quota: { error: 'first', ok: false } };
                return { result: undefined };
            },
            first.path,
            undefined,
            async () => {
                markFirstStarted();
                await firstGate;
                return TEST_KEY;
            },
        );
        await firstStarted;

        await expect(
            updateVaultSection(
                'codex',
                (section) => {
                    section.data.second = {
                        auth: '{}',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                    section.limits.second = {
                        fetchedAt: '2026-01-03T00:00:00.000Z',
                        quota: { error: 'second', ok: false },
                    };
                    return { result: undefined };
                },
                second.path,
                TEST_KEY,
            ),
        ).resolves.toBeUndefined();
    } finally {
        releaseFirst();
        await firstUpdate?.catch(() => undefined);
        await rm(first.dir, { force: true, recursive: true });
        await rm(second.dir, { force: true, recursive: true });
    }
});

it('should queue reads behind writes on the same vault path', async () => {
    const { dir, path } = await tempVault();
    let releaseUpdate = () => {};
    let markStarted = () => {};
    const gate = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
    });
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    let update: Promise<void> | undefined;
    let read: ReturnType<typeof readVaultSection<'codex'>> | undefined;

    try {
        update = updateVaultSection(
            'codex',
            (section) => {
                section.data.queued = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                section.limits.queued = {
                    fetchedAt: '2026-01-03T00:00:00.000Z',
                    quota: { error: 'queued', ok: false },
                };
                return { result: undefined };
            },
            path,
            undefined,
            async () => {
                markStarted();
                await gate;
                return TEST_KEY;
            },
        );
        await started;
        read = readVaultSection('codex', path, TEST_KEY);
        let settled = false;
        void read.then(() => {
            settled = true;
        });
        await Bun.sleep(10);
        expect(settled).toBe(false);

        releaseUpdate();
        expect((await read).limits.queued).toBeDefined();
    } finally {
        releaseUpdate();
        await update?.catch(() => undefined);
        await read?.catch(() => undefined);
        await rm(dir, { force: true, recursive: true });
    }
});

it('should isolate corrupt entries and preserve their raw values during a section update', async () => {
    const { dir, path } = await tempVault();
    const damagedAuth = 'enc:v1:AAAA';
    try {
        await updateVaultSection(
            'antigravity',
            (section) => {
                section.data.untouched = {
                    account: 'antigravity',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    identity: 'google-user',
                    kind: 'Generic Password',
                    label: 'gemini',
                    password: 'go-keyring-base64:healthy',
                    service: 'gemini',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.healthy = {
                    auth: JSON.stringify({ OPENAI_API_KEY: 'healthy' }),
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const fixture = JSON.parse(await Bun.file(path).text()) as {
            antigravity: { data: Record<string, unknown>; limits: Record<string, unknown> };
            cline?: unknown;
            codex: { data: Record<string, unknown>; limits: Record<string, unknown> };
        };
        fixture.cline = {
            data: {
                untouched: {
                    createdAt: '2026-01-01T00:00:00.000Z',
                    secrets: 'enc:v1:invalid',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            },
            limits: {},
        };
        fixture.codex.data.damaged = {
            auth: damagedAuth,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        };
        await Bun.write(path, JSON.stringify(fixture, null, 4));

        const section = await readVaultSection('codex', path, TEST_KEY);
        expect(JSON.parse(section.data.healthy?.auth ?? '{}')).toEqual({ OPENAI_API_KEY: 'healthy' });
        expect(section.data.damaged).toBeUndefined();
        expect(section.corruptions?.damaged).toEqual({
            corrupted: true,
            error: 'Stored encrypted credentials could not be opened',
        });

        const before = JSON.parse(await Bun.file(path).text()) as typeof fixture;
        await updateVaultSection(
            'codex',
            (current) => {
                current.limits.healthy = {
                    fetchedAt: '2026-01-03T00:00:00.000Z',
                    quota: { error: 'redacted-safe', ok: false },
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const after = JSON.parse(await Bun.file(path).text()) as typeof fixture;

        expect((after.codex.data.damaged as { auth?: unknown } | undefined)?.auth).toBe(damagedAuth);
        expect(JSON.stringify(after.antigravity)).toBe(JSON.stringify(before.antigravity));
        expect(after.cline).toEqual(before.cline);

        await updateVaultSection(
            'codex',
            (current) => {
                if (current.corruptions) {
                    delete current.corruptions.damaged;
                }
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const afterDelete = JSON.parse(await Bun.file(path).text()) as typeof fixture;
        expect(afterDelete.codex.data.damaged).toBeUndefined();
        expect(JSON.stringify(afterDelete.antigravity)).toBe(JSON.stringify(before.antigravity));
        expect(afterDelete.cline).toEqual(before.cline);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should hard-reject plaintext stored secret fields as corruption', async () => {
    const { dir, path } = await tempVault();
    try {
        await Bun.write(
            path,
            JSON.stringify({
                codex: {
                    data: {
                        plaintext: {
                            auth: '{"OPENAI_API_KEY":"secret"}',
                            createdAt: '2026-01-01T00:00:00.000Z',
                            updatedAt: '2026-01-02T00:00:00.000Z',
                        },
                    },
                    limits: {},
                },
            }),
        );

        const section = await readVaultSection('codex', path, TEST_KEY);
        expect(section.data).toEqual({});
        expect(section.corruptions?.plaintext?.corrupted).toBe(true);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should propagate a global vault-key failure instead of marking entries corrupt', async () => {
    const { dir, path } = await tempVault();
    try {
        await Bun.write(
            path,
            JSON.stringify({
                codex: {
                    data: {
                        saved: {
                            auth: 'enc:v2:AAAA',
                            createdAt: '2026-01-01T00:00:00.000Z',
                            updatedAt: '2026-01-02T00:00:00.000Z',
                        },
                    },
                    limits: {},
                },
            }),
        );
        let lookups = 0;
        const unavailableKey = async () => {
            lookups += 1;
            throw new Error('Keychain authorization failed');
        };

        await expect(readVaultSection('codex', path, undefined, unavailableKey)).rejects.toThrow(
            'Keychain authorization failed',
        );
        expect(lookups).toBe(1);

        await Bun.write(path, JSON.stringify({ codex: { data: {}, limits: {} } }));
        await expect(readVaultSection('codex', path, undefined, unavailableKey)).resolves.toEqual({
            data: {},
            limits: {},
        });
        expect(lookups).toBe(1);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should require an existing key for enc:v2 without creating a replacement', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.saved = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const modes: string[] = [];
        const missingExistingKey = async (mode: 'create' | 'existing') => {
            modes.push(mode);
            throw new Error('Vault encryption key is unavailable from macOS Keychain');
        };

        await expect(readVaultSection('codex', path, undefined, missingExistingKey)).rejects.toThrow(
            'Vault encryption key is unavailable from macOS Keychain',
        );
        expect(modes).toEqual(['existing']);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should create a key only for the first enc:v2 row, including alongside damaged v1 rows', async () => {
    const { dir, path } = await tempVault();
    try {
        await Bun.write(
            path,
            JSON.stringify({
                codex: {
                    data: {
                        legacy: {
                            auth: 'enc:v1:AAAA',
                            createdAt: '2026-01-01T00:00:00.000Z',
                            updatedAt: '2026-01-02T00:00:00.000Z',
                        },
                    },
                    limits: {},
                },
            }),
        );
        const modes: string[] = [];
        const createKey = async (mode: 'create' | 'existing') => {
            modes.push(mode);
            return TEST_KEY;
        };

        await updateVaultSection(
            'codex',
            (section) => {
                section.data.current = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            undefined,
            createKey,
        );
        expect(modes).toEqual(['create']);

        modes.length = 0;
        const section = await readVaultSection('codex', path, undefined, createKey);
        expect(section.data.current?.auth).toBe('{}');
        expect(section.corruptions?.legacy?.corrupted).toBe(true);
        expect(modes).toEqual(['existing']);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should bind ciphertext to its account key and plaintext metadata', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.first = {
                    auth: '{"OPENAI_API_KEY":"bound"}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const original = JSON.parse(await Bun.file(path).text()) as {
            codex: { data: Record<string, Record<string, unknown>>; limits: Record<string, unknown> };
        };

        original.codex.data.second = original.codex.data.first as Record<string, unknown>;
        await Bun.write(path, JSON.stringify(original));
        const transplanted = await readVaultSection('codex', path, TEST_KEY);
        expect(transplanted.data.first).toBeDefined();
        expect(transplanted.corruptions?.second?.corrupted).toBe(true);

        const tampered = JSON.parse(await Bun.file(path).text()) as typeof original;
        const first = tampered.codex.data.first as Record<string, unknown>;
        first.updatedAt = '2026-01-03T00:00:00.000Z';
        delete tampered.codex.data.second;
        await Bun.write(path, JSON.stringify(tampered));
        const metadataTamper = await readVaultSection('codex', path, TEST_KEY);
        expect(metadataTamper.corruptions?.first?.corrupted).toBe(true);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reuse unchanged healthy ciphertext and reseal only changed accounts', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.a = {
                    auth: '{"account":"a"}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                section.data.b = {
                    auth: '{"account":"b"}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const rawData = async () => {
            const stored = JSON.parse(await Bun.file(path).text()) as {
                codex: { data: Record<string, Record<string, string>> };
            };
            return stored.codex.data;
        };
        const initial = await rawData();

        await updateVaultSection(
            'codex',
            (section) => {
                section.limits.a = { fetchedAt: '2026-01-03T00:00:00.000Z', quota: { error: 'cached', ok: false } };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const limitsOnly = await rawData();
        expect(limitsOnly).toEqual(initial);

        await updateVaultSection(
            'codex',
            (section) => {
                const a = section.data.a;
                if (a) {
                    a.updatedAt = '2026-01-01T00:00:00.000Z';
                }
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const changed = await rawData();
        expect(changed.a?.auth).not.toBe(initial.a?.auth);
        expect(changed.b).toEqual(initial.b);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should cap decoded and staged secret strings by exact UTF-8 bytes', async () => {
    const { dir, path } = await tempVault();
    const atLimit = 'é'.repeat((1024 * 1024) / 2);
    try {
        await expect(
            updateVaultSection(
                'codex',
                (section) => {
                    section.data.allowed = {
                        auth: atLimit,
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
        ).resolves.toBeUndefined();

        const before = await Bun.file(path).text();
        await expect(
            updateVaultSection(
                'codex',
                (section) => {
                    section.data.tooLarge = {
                        auth: `${atLimit}é`,
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
        ).rejects.toThrow('Stored account secret exceeds the 1 MiB size limit');
        expect(await Bun.file(path).text()).toBe(before);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should fail closed on malformed vault shapes without rewriting them', async () => {
    const { dir, path } = await tempVault();
    try {
        const original = '["do-not-overwrite"]';
        await Bun.write(path, original);

        await expect(
            updateVaultSection(
                'codex',
                (section) => {
                    section.limits.changed = { fetchedAt: '2026-01-03T00:00:00.000Z', quota: { error: '', ok: false } };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
        ).rejects.toThrow('Vault file has an invalid top-level shape');
        expect(await Bun.file(path).text()).toBe(original);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject explicitly malformed platform sections instead of defaulting them', async () => {
    const { dir, path } = await tempVault();
    try {
        await Bun.write(path, '{"codex":null}');

        await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow('invalid codex section');
        expect(await Bun.file(path).text()).toBe('{"codex":null}');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject explicitly present platform sections missing data or limits', async () => {
    const { dir, path } = await tempVault();
    try {
        for (const codex of [{}, { data: {} }, { limits: {} }]) {
            const original = JSON.stringify({ codex });
            await Bun.write(path, original);
            await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow('invalid codex section');
            expect(await Bun.file(path).text()).toBe(original);
        }
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject malformed or residue-bearing untouched platform sections', async () => {
    const { dir, path } = await tempVault();
    try {
        for (const cline of [[], { data: {}, legacy: { password: 'plaintext' }, limits: {} }]) {
            const original = JSON.stringify({ cline, codex: { data: {}, limits: {} } });
            await Bun.write(path, original);
            await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow('invalid cline section');
            expect(await Bun.file(path).text()).toBe(original);
        }
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject historical flat and unknown top-level vault fields without rewriting them', async () => {
    const { dir, path } = await tempVault();
    try {
        for (const original of ['{"data":{"secret":"plaintext"},"limits":{}}', '{"futurePlatform":{"secret":true}}']) {
            await Bun.write(path, original);
            await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow('invalid top-level key');
            expect(await Bun.file(path).text()).toBe(original);
        }
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should isolate entries with unexpected or malformed snapshot fields', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.valid = {
                    auth: '{"OPENAI_API_KEY":"safe"}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const stored = JSON.parse(await Bun.file(path).text()) as {
            codex: { data: Record<string, Record<string, unknown>>; limits: Record<string, unknown> };
        };
        const valid = stored.codex.data.valid as Record<string, unknown>;
        await Bun.write(
            path,
            JSON.stringify({
                codex: {
                    data: {
                        missing: { auth: valid.auth, updatedAt: '2026-01-02T00:00:00.000Z' },
                        unexpected: { ...valid, plaintext: 'secret' },
                        valid,
                        wrongType: { ...valid, createdAt: 1 },
                    },
                    limits: {},
                },
            }),
        );

        const section = await readVaultSection('codex', path, TEST_KEY);
        expect(Object.keys(section.data)).toEqual(['valid']);
        expect(Object.keys(section.corruptions ?? {}).sort()).toEqual(['missing', 'unexpected', 'wrongType']);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject invalid stored account keys and orphan cached limits', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.valid = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const stored = JSON.parse(await Bun.file(path).text()) as {
            codex: { data: Record<string, Record<string, unknown>> };
        };
        const valid = stored.codex.data.valid;
        for (const codex of [
            { data: { constructor: valid }, limits: {} },
            {
                data: { valid },
                limits: { orphan: { fetchedAt: '2026-01-03T00:00:00.000Z', quota: { error: '', ok: false } } },
            },
        ]) {
            await Bun.write(path, JSON.stringify({ codex }));
            await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow(
                /invalid (stored account key|orphan cached limits)/,
            );
        }
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should refuse callback output that would make the vault invalid', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.valid = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const original = await Bun.file(path).text();

        await expect(
            updateVaultSection(
                'codex',
                (section) => {
                    section.limits.orphan = { fetchedAt: '2026-01-03T00:00:00.000Z', quota: { error: '', ok: false } };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
        ).rejects.toThrow('invalid orphan cached limits');
        expect(await Bun.file(path).text()).toBe(original);

        await expect(
            updateVaultSection(
                'codex',
                (section) => {
                    section.data.invalid = {
                        auth: '{}',
                        createdAt: 'yesterday',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
        ).rejects.toThrow('Stored account timestamp is invalid');
        expect(await Bun.file(path).text()).toBe(original);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject an asynchronous vault update callback without replacing the vault', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.original = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const original = await Bun.file(path).text();
        const unsafeUpdate = updateVaultSection as unknown as (
            platform: 'codex',
            operation: (section: unknown) => unknown,
            path: string,
            key: Buffer,
        ) => Promise<unknown>;

        await expect(unsafeUpdate('codex', async () => ({ result: undefined }), path, TEST_KEY)).rejects.toThrow(
            'Vault update callback must be synchronous',
        );
        await expect(unsafeUpdate('codex', () => null, path, TEST_KEY)).rejects.toThrow(
            'Vault update callback returned an invalid result',
        );
        await expect(
            unsafeUpdate('codex', () => ({ result: undefined, write: 'yes' }), path, TEST_KEY),
        ).rejects.toThrow('Vault update callback returned an invalid write flag');
        expect(await Bun.file(path).text()).toBe(original);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should isolate malformed snapshot timestamps and reject malformed cached timestamps', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.account = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const stored = JSON.parse(await Bun.file(path).text()) as {
            codex: { data: Record<string, Record<string, unknown>>; limits: Record<string, unknown> };
        };
        const account = stored.codex.data.account as Record<string, unknown>;
        account.createdAt = 'not-an-instant';
        await Bun.write(path, JSON.stringify(stored));
        expect((await readVaultSection('codex', path, TEST_KEY)).corruptions?.account?.corrupted).toBe(true);

        account.createdAt = '';
        stored.codex.limits.account = { fetchedAt: 'not-an-instant', quota: { error: '', ok: false } };
        await Bun.write(path, JSON.stringify(stored));
        await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow('invalid cached limits');

        stored.codex.limits.account = { fetchedAt: '', quota: { error: '', ok: false } };
        await Bun.write(path, JSON.stringify(stored));
        await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow('invalid cached limits');

        delete stored.codex.limits.account;
        account.createdAt = '2026-02-30T00:00:00.000Z';
        await Bun.write(path, JSON.stringify(stored));
        expect((await readVaultSection('codex', path, TEST_KEY)).corruptions?.account?.corrupted).toBe(true);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should report malformed UTF-8 in the server-owned vault as a storage failure', async () => {
    const { dir, path } = await tempVault();
    try {
        await Bun.write(path, new Uint8Array([0xc3, 0x28]));

        const error = await readVaultSection('codex', path, TEST_KEY).catch((value: unknown) => value);
        expect((error as { status?: number }).status).toBe(500);
        expect(String(error)).toContain('Vault file is not valid UTF-8');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should transform every account in a multi-entry section', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data = Object.fromEntries(
                    Array.from({ length: 64 }, (_, index) => [
                        `account-${index}`,
                        {
                            auth: JSON.stringify({ index }),
                            createdAt: '2026-01-01T00:00:00.000Z',
                            updatedAt: '2026-01-02T00:00:00.000Z',
                        },
                    ]),
                );
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );

        const section = await readVaultSection('codex', path, TEST_KEY);
        expect(Object.keys(section.data)).toHaveLength(64);
        await updateVaultSection('codex', (current) => ({ result: Object.keys(current.data).length }), path, TEST_KEY);
        expect(Object.keys((await readVaultSection('codex', path, TEST_KEY)).data)).toHaveLength(64);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should preserve concurrent updates from separate Dondo processes', async () => {
    const { dir, path } = await tempVault();
    const moduleUrl = new URL('./vault.ts', import.meta.url).href;
    const childCode = (accountKey: string, delay: number) => `
        import { updateVaultSection } from ${JSON.stringify(moduleUrl)};
        const key = Buffer.alloc(32, 3);
        await Bun.sleep(${delay});
        await updateVaultSection('codex', (section) => {
            section.data[${JSON.stringify(accountKey)}] = {
                auth: JSON.stringify({ account: ${JSON.stringify(accountKey)} }),
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
            };
            return { result: undefined };
        }, ${JSON.stringify(path)}, key);
    `;

    try {
        await Promise.all([runChild(childCode('first', 150)), runChild(childCode('second', 0))]);
        const section = await readVaultSection('codex', path, TEST_KEY);
        expect(Object.keys(section.data).sort()).toEqual(['first', 'second']);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should retry release when owned lock metadata is temporarily unreadable or mismatched', async () => {
    const { dir, path } = await tempVault();
    const lockPath = `${path}.lock`;
    let restoreMetadata = Promise.resolve();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                const metadata = readFileSync(lockPath, 'utf8');
                writeFileSync(lockPath, '{');
                restoreMetadata = new Promise<void>((resolve, reject) => {
                    setTimeout(() => {
                        try {
                            const parsed = JSON.parse(metadata) as Record<string, unknown>;
                            writeFileSync(lockPath, JSON.stringify({ ...parsed, token: 'temporary-mismatch' }));
                        } catch (error) {
                            reject(error);
                        }
                    }, 10);
                    setTimeout(() => {
                        try {
                            writeFileSync(lockPath, metadata);
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                    }, 75);
                });
                section.data.account = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        await restoreMetadata;
        expect(await Bun.file(lockPath).exists()).toBe(false);
    } finally {
        await restoreMetadata.catch(() => undefined);
        await rm(dir, { force: true, recursive: true });
    }
});

it('should recover a lock left by a crashed Dondo process', async () => {
    const { dir, path } = await tempVault();
    const lockPath = `${path}.lock`;
    const crashCode = `
        import { open } from 'node:fs/promises';
        const handle = await open(${JSON.stringify(lockPath)}, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ createdAt: Date.now(), pid: process.pid, token: 'crashed' }));
        await handle.sync();
        process.exit(0);
    `;

    try {
        await runChild(crashCode);
        expect(await Bun.file(lockPath).exists()).toBe(true);
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.recovered = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        expect((await readVaultSection('codex', path, TEST_KEY)).data.recovered).toBeDefined();
        expect(await Bun.file(lockPath).exists()).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should serialize competing recovery attempts for one crashed vault lock', async () => {
    const { dir, path } = await tempVault();
    const lockPath = `${path}.lock`;
    const moduleUrl = new URL('./vault.ts', import.meta.url).href;
    const crashCode = `
        import { open } from 'node:fs/promises';
        const handle = await open(${JSON.stringify(lockPath)}, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ createdAt: Date.now(), pid: process.pid, token: 'crashed' }));
        await handle.sync();
        process.exit(0);
    `;
    const updateCode = (accountKey: string) => `
        import { updateVaultSection } from ${JSON.stringify(moduleUrl)};
        await updateVaultSection('codex', (section) => {
            section.data[${JSON.stringify(accountKey)}] = {
                auth: '{}',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
            };
            return { result: undefined };
        }, ${JSON.stringify(path)}, Buffer.alloc(32, 3));
    `;

    try {
        await runChild(crashCode);
        await Promise.all([runChild(updateCode('first')), runChild(updateCode('second'))]);

        const section = await readVaultSection('codex', path, TEST_KEY);
        expect(Object.keys(section.data).sort()).toEqual(['first', 'second']);
        expect(await Bun.file(`${lockPath}.recovery`).exists()).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should not steal an old lock owned by a live Dondo process', async () => {
    const { dir, path } = await tempVault();
    const lockPath = `${path}.lock`;
    const old = new Date(Date.now() - 10 * 60 * 1000);
    try {
        await Bun.write(lockPath, JSON.stringify({ createdAt: old.getTime(), pid: process.pid, token: 'live' }));
        await utimes(lockPath, old, old);
        const error = await readVaultSection('codex', path, TEST_KEY).catch((value: unknown) => value);
        expect((error as { status?: number }).status).toBe(503);
        expect(await Bun.file(lockPath).text()).toContain('"token":"live"');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should not create or replace a vault lock while stale recovery is active', async () => {
    const { dir, path } = await tempVault();
    const lockPath = `${path}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    try {
        await Bun.write(recoveryPath, JSON.stringify({ createdAt: Date.now(), pid: process.pid, token: 'live' }));
        const read = readVaultSection('codex', path, TEST_KEY);
        await Bun.sleep(50);
        expect(await Bun.file(lockPath).exists()).toBe(false);

        await rm(recoveryPath);
        await expect(read).resolves.toEqual({ data: {}, limits: {} });
        expect(await Bun.file(lockPath).exists()).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should recover a stale recovery gate left by a crashed process', async () => {
    const { dir, path } = await tempVault();
    const recoveryPath = `${path}.lock.recovery`;
    const crashCode = `
        import { open } from 'node:fs/promises';
        const handle = await open(${JSON.stringify(recoveryPath)}, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ createdAt: Date.now(), pid: process.pid, token: 'crashed' }));
        await handle.sync();
        process.exit(0);
    `;
    try {
        await runChild(crashCode);
        expect(await Bun.file(recoveryPath).exists()).toBe(true);
        await expect(readVaultSection('codex', path, TEST_KEY)).resolves.toEqual({ data: {}, limits: {} });
        expect(await Bun.file(recoveryPath).exists()).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should recover an empty recovery gate after its short initialization grace period', async () => {
    const { dir, path } = await tempVault();
    const recoveryPath = `${path}.lock.recovery`;
    try {
        await Bun.write(recoveryPath, '');
        const old = new Date(Date.now() - 1_000);
        await utimes(recoveryPath, old, old);

        await expect(readVaultSection('codex', path, TEST_KEY)).resolves.toEqual({ data: {}, limits: {} });
        expect(await Bun.file(recoveryPath).exists()).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject oversized vault files before materializing them', async () => {
    const { dir, path } = await tempVault();
    try {
        await Bun.write(path, '');
        await truncate(path, MAX_VAULT_FILE_BYTES + 1);

        const error = await readVaultSection('codex', path, TEST_KEY).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(Error);
        expect((error as { status?: number }).status).toBe(500);
        expect(String(error)).toContain('Vault file exceeds the 16 MiB size limit');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should refuse an oversized vault write without replacing the readable file', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.safe = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const before = await Bun.file(path).text();
        const secret = 'x'.repeat(1024 * 1024);

        const error = await updateVaultSection(
            'codex',
            (section) => {
                for (let index = 0; index < 16; index += 1) {
                    section.data[`large-${index}`] = {
                        auth: secret,
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-02T00:00:00.000Z',
                    };
                }
                return { result: undefined };
            },
            path,
            TEST_KEY,
        ).catch((value: unknown) => value);

        expect((error as { status?: number }).status).toBe(500);
        expect(String(error)).toContain('Vault file exceeds the 16 MiB size limit');
        expect(String(error)).not.toContain(secret);
        expect(await Bun.file(path).text()).toBe(before);
        await expect(readVaultSection('codex', path, TEST_KEY)).resolves.toBeDefined();
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should validate and redact cached limits read from the vault', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.safe = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const stored = JSON.parse(await Bun.file(path).text()) as {
            codex: { data: Record<string, Record<string, unknown>> };
        };
        const encrypted = stored.codex.data.safe;
        await Bun.write(
            path,
            JSON.stringify({
                codex: {
                    data: { safe: encrypted },
                    limits: {
                        safe: {
                            fetchedAt: '2026-01-01T00:00:00.000Z',
                            quota: { error: 'Bearer private-limit-token', ok: false },
                        },
                    },
                },
            }),
        );
        const section = await readVaultSection('codex', path, TEST_KEY);
        expect(section.limits.safe?.quota).toEqual({ error: 'Bearer [redacted]', ok: false });

        await Bun.write(
            path,
            JSON.stringify({
                codex: {
                    data: { unsafe: encrypted },
                    limits: {
                        unsafe: {
                            fetchedAt: '2026-01-03T00:00:00.000Z',
                            quota: { models: { bad: 'secret' }, ok: true },
                        },
                    },
                },
            }),
        );
        await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow('invalid cached limits');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should enforce bounded percentages and non-negative usage in cached model limits', async () => {
    const { dir, path } = await tempVault();
    let encrypted: Record<string, unknown>;
    const fixture = (models: Record<string, unknown>) => ({
        codex: {
            data: { account: encrypted },
            limits: {
                account: {
                    fetchedAt: '2026-01-01T00:00:00.000Z',
                    quota: { expires: '', models, ok: true, tier: 'test' },
                },
            },
        },
    });
    const model = {
        displayName: 'Model',
        limit: 100,
        percentage: 50,
        resetTime: '',
        used: 50,
    };

    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.account = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        encrypted = (
            JSON.parse(await Bun.file(path).text()) as {
                codex: { data: Record<string, Record<string, unknown>> };
            }
        ).codex.data.account as Record<string, unknown>;
        await Bun.write(
            path,
            JSON.stringify(
                fixture({
                    empty: { ...model, limit: 0, percentage: 0, used: 0 },
                    full: { ...model, percentage: 100 },
                }),
            ),
        );
        await expect(readVaultSection('codex', path, TEST_KEY)).resolves.toBeDefined();

        for (const invalid of [
            { ...model, percentage: -1 },
            { ...model, percentage: 101 },
            { ...model, used: -1 },
            { ...model, limit: -1 },
        ]) {
            await Bun.write(path, JSON.stringify(fixture({ invalid })));
            await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow('invalid cached limits');
        }
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should bound platform account and per-account model counts', async () => {
    const { dir, path } = await tempVault();
    try {
        await updateVaultSection(
            'codex',
            (section) => {
                section.data.account = {
                    auth: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                };
                return { result: undefined };
            },
            path,
            TEST_KEY,
        );
        const original = await Bun.file(path).text();
        const encrypted = (JSON.parse(original) as { codex: { data: Record<string, Record<string, unknown>> } }).codex
            .data.account;
        const model = {
            displayName: 'Model',
            percentage: 0,
            resetTime: '',
        };
        const models = Object.fromEntries(
            Array.from({ length: MAX_VAULT_MODELS_PER_ACCOUNT + 1 }, (_, index) => [`model-${index}`, model]),
        );
        await Bun.write(
            path,
            JSON.stringify({
                codex: {
                    data: { account: encrypted },
                    limits: {
                        account: {
                            fetchedAt: '2026-01-03T00:00:00.000Z',
                            quota: { expires: '', models, ok: true, tier: 'test' },
                        },
                    },
                },
            }),
        );
        await expect(readVaultSection('codex', path, TEST_KEY)).rejects.toThrow('invalid cached limits');

        await Bun.write(path, original);
        await expect(
            updateVaultSection(
                'codex',
                (section) => {
                    section.data = Object.fromEntries(
                        Array.from({ length: MAX_VAULT_ACCOUNTS_PER_PLATFORM + 1 }, (_, index) => [
                            `account-${index}`,
                            {
                                auth: '{}',
                                createdAt: '2026-01-01T00:00:00.000Z',
                                updatedAt: '2026-01-02T00:00:00.000Z',
                            },
                        ]),
                    );
                    return { result: undefined };
                },
                path,
                TEST_KEY,
            ),
        ).rejects.toThrow('invalid updated platform section');
        expect(await Bun.file(path).text()).toBe(original);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
