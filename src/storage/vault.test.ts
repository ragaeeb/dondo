import { expect, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVault, updateVault, writeVault } from './vault.ts';

const tempVault = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-vault-test-'));
    return { dir, path: join(dir, 'vault.json') };
};

it('should read a missing vault as nested empty platform sections', async () => {
    const { dir, path } = await tempVault();
    try {
        await expect(readVault(path)).resolves.toEqual({
            antigravity: { data: {}, limits: {} },
            codex: { data: {}, limits: {} },
            kiro: { data: {}, limits: {} },
            minimax: { data: {}, limits: {} },
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should write the vault with private file permissions', async () => {
    const { dir, path } = await tempVault();
    try {
        await writeVault(
            {
                antigravity: { data: {}, limits: {} },
                codex: { data: {}, limits: {} },
                kiro: { data: {}, limits: {} },
                minimax: { data: {}, limits: {} },
            },
            path,
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

        await expect(readVault(path)).rejects.toThrow(`Vault file is not valid JSON: ${path}`);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should serialize queued vault updates', async () => {
    const { dir, path } = await tempVault();
    try {
        await Promise.all([
            updateVault(async (vault) => {
                vault.antigravity.limits.a = {
                    fetchedAt: 'a',
                    quota: { error: 'a', ok: false },
                };
                return { result: undefined };
            }, path),
            updateVault(async (vault) => {
                vault.codex.limits.b = {
                    fetchedAt: 'b',
                    quota: { error: 'b', ok: false },
                };
                return { result: undefined };
            }, path),
            updateVault(async (vault) => {
                vault.minimax.limits.c = {
                    fetchedAt: 'c',
                    quota: { error: 'c', ok: false },
                };
                return { result: undefined };
            }, path),
            updateVault(async (vault) => {
                vault.kiro.limits.d = {
                    fetchedAt: 'd',
                    quota: { error: 'd', ok: false },
                };
                return { result: undefined };
            }, path),
        ]);

        const vault = await readVault(path);
        expect(vault.antigravity.limits.a?.fetchedAt).toBe('a');
        expect(vault.codex.limits.b?.fetchedAt).toBe('b');
        expect(vault.minimax.limits.c?.fetchedAt).toBe('c');
        expect(vault.kiro.limits.d?.fetchedAt).toBe('d');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
