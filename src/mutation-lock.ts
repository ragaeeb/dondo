import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { VAULT_PATH } from './config.ts';
import { publicError } from './errors.ts';

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

const processIsAlive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as { code?: unknown }).code === 'EPERM';
    }
};

const recoverAbandonedLock = async (path: string) => {
    let value: string;
    try {
        value = (await readFile(path, 'utf8')).trim();
    } catch {
        return false;
    }

    const pid = Number(value);
    if (Number.isSafeInteger(pid) && pid > 0) {
        if (processIsAlive(pid)) {
            return false;
        }
    } else {
        let ageMs: number;
        try {
            ageMs = Date.now() - (await stat(path)).mtimeMs;
        } catch {
            return false;
        }
        if (ageMs <= LOCK_TIMEOUT_MS) {
            return false;
        }
    }
    const abandoned = `${path}.${randomUUID()}.abandoned`;
    try {
        await rename(path, abandoned);
        await rm(abandoned, { force: true });
        return true;
    } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') {
            return true;
        }
        return false;
    }
};

type MutationLockHandle = Awaited<ReturnType<typeof open>>;

const tryOpenMutationLock = async (path: string): Promise<MutationLockHandle | undefined> => {
    let handle: MutationLockHandle | undefined;
    try {
        handle = await open(path, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        await handle.sync();
        return handle;
    } catch (error) {
        if (handle) {
            await handle.close().catch(() => {});
            await rm(path, { force: true }).catch(() => {});
        }
        if ((error as { code?: unknown }).code === 'EEXIST') {
            return undefined;
        }
        throw error;
    }
};

const acquireMutationLock = async (path: string) => {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        const handle = await tryOpenMutationLock(path);
        if (handle) {
            return handle;
        }
        if (await recoverAbandonedLock(path)) {
            continue;
        }
        if (Date.now() >= deadline) {
            throw publicError(409, 'Another account switch is already in progress');
        }
        await Bun.sleep(LOCK_RETRY_MS);
    }
};

export const withMutationLock = async <Result>(path: string, operation: () => Promise<Result>) => {
    await mkdir(dirname(path), { recursive: true });
    const handle = await acquireMutationLock(path);

    try {
        return await operation();
    } finally {
        await handle.close();
        await rm(path, { force: true });
    }
};

export type PlatformMutationLock = 'kiro' | 'minimax';

export const withPlatformMutationLock = async <Result>(
    platform: PlatformMutationLock,
    operation: () => Promise<Result>,
) => withMutationLock(`${VAULT_PATH}.${platform}-cycle.lock`, operation);
