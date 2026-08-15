import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
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
    let pid: number;
    try {
        const value = (await readFile(path, 'utf8')).trim();
        pid = Number(value);
    } catch {
        return false;
    }
    if (!Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) {
        return false;
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

export const withMutationLock = async <Result>(path: string, operation: () => Promise<Result>) => {
    await mkdir(dirname(path), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
        try {
            handle = await open(path, 'wx', 0o600);
            await handle.writeFile(`${process.pid}\n`, 'utf8');
            await handle.sync();
        } catch (error) {
            if ((error as { code?: unknown }).code !== 'EEXIST') {
                throw error;
            }
            if (await recoverAbandonedLock(path)) {
                continue;
            }
            if (Date.now() >= deadline) {
                throw publicError(409, 'Another account switch is already in progress');
            }
            await Bun.sleep(LOCK_RETRY_MS);
        }
    }

    try {
        return await operation();
    } finally {
        await handle.close();
        await rm(path, { force: true });
    }
};
