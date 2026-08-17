import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { VAULT_PATH } from './config.ts';
import { publicError } from './errors.ts';

const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_ABANDONED_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 25;

const processIsAlive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as { code?: unknown }).code !== 'ESRCH';
    }
};

type LockFileState = {
    ageMs: number;
    pid: number | undefined;
};

const readLockFileState = async (path: string): Promise<LockFileState | undefined> => {
    try {
        const [file, value] = await Promise.all([stat(path), readFile(path, 'utf8')]);
        const owner = value.trim();
        const pidText = owner.split(':', 1)[0] ?? '';
        const pid = /^\d+$/u.test(pidText) ? Number(pidText) : undefined;
        return {
            ageMs: Math.max(0, Date.now() - file.mtimeMs),
            pid: Number.isSafeInteger(pid) && (pid ?? 0) > 0 ? pid : undefined,
        };
    } catch {
        return undefined;
    }
};

const recoverAbandonedLock = async (path: string) => {
    const state = await readLockFileState(path);
    if (!state) {
        return false;
    }

    const abandoned = state.pid ? !processIsAlive(state.pid) : state.ageMs > LOCK_ABANDONED_TIMEOUT_MS;
    if (!abandoned) {
        return false;
    }

    const abandonedPath = `${path}.${randomUUID()}.abandoned`;
    try {
        await rename(path, abandonedPath);
        await rm(abandonedPath, { force: true }).catch(() => undefined);
        return true;
    } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') {
            return true;
        }
        return false;
    }
};

type MutationLockHandle = Awaited<ReturnType<typeof open>>;
type MutationLockLease = {
    handle: MutationLockHandle;
    identity: { dev: number; ino: number };
    owner: string;
    path: string;
};

const tryOpenMutationLock = async (path: string): Promise<MutationLockLease | undefined> => {
    let handle: MutationLockHandle | undefined;
    const owner = `${process.pid}:${randomUUID()}`;
    try {
        handle = await open(path, 'wx', 0o600);
        await handle.writeFile(`${owner}\n`, 'utf8');
        await handle.sync();
        const file = await handle.stat();
        return { handle, identity: { dev: file.dev, ino: file.ino }, owner, path };
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

const releaseMutationLock = async (lease: MutationLockLease) => {
    let cleanupError: unknown;
    try {
        const current = await stat(lease.path);
        if (current.dev === lease.identity.dev && current.ino === lease.identity.ino) {
            const owner = (await readFile(lease.path, 'utf8')).trim();
            if (owner === lease.owner) {
                await rm(lease.path, { force: true });
            }
        }
    } catch (error) {
        if ((error as { code?: unknown }).code !== 'ENOENT') {
            cleanupError = error;
        }
    }
    await lease.handle.close().catch((error) => {
        cleanupError ??= error;
    });
    return cleanupError;
};

const acquireRecoveryGate = async (path: string) => {
    const gatePath = `${path}.recovery`;
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    for (;;) {
        const gate = await tryOpenMutationLock(gatePath);
        if (gate) {
            return gate;
        }
        await recoverAbandonedLock(gatePath);
        if (Date.now() >= deadline) {
            throw publicError(409, 'Another Dondo mutation is already in progress');
        }
        await Bun.sleep(LOCK_RETRY_MS);
    }
};

type MutationLockAttempt = {
    error?: unknown;
    failed: boolean;
    lease?: MutationLockLease;
};

const attemptMutationLock = async (path: string): Promise<MutationLockAttempt> => {
    try {
        const lease = await tryOpenMutationLock(path);
        if (!lease) {
            await recoverAbandonedLock(path);
        }
        return lease ? { failed: false, lease } : { failed: false };
    } catch (error) {
        return { error, failed: true };
    }
};

const releaseIfOwned = async (lease: MutationLockLease | undefined) => {
    if (lease) {
        await releaseMutationLock(lease);
    }
};

const finishMutationLockAttempt = async (
    attempt: MutationLockAttempt,
    gateCleanupError: unknown,
): Promise<MutationLockLease | undefined> => {
    if (attempt.failed || gateCleanupError) {
        await releaseIfOwned(attempt.lease);
        throw attempt.failed ? attempt.error : gateCleanupError;
    }
    return attempt.lease;
};

const acquireMutationLock = async (path: string) => {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    for (;;) {
        const gate = await acquireRecoveryGate(path);
        const attempt = await attemptMutationLock(path);
        const gateCleanupError = await releaseMutationLock(gate);
        const lease = await finishMutationLockAttempt(attempt, gateCleanupError);
        if (lease) {
            return lease;
        }
        if (Date.now() >= deadline) {
            throw publicError(409, 'Another Dondo mutation is already in progress');
        }
        await Bun.sleep(LOCK_RETRY_MS);
    }
};

export const withMutationLock = async <Result>(path: string, operation: () => Promise<Result>) => {
    await mkdir(dirname(path), { recursive: true });
    const lease = await acquireMutationLock(path);
    let operationFailed = false;
    let operationResult!: Result;
    let operationError: unknown;

    try {
        operationResult = await operation();
    } catch (error) {
        operationFailed = true;
        operationError = error;
    }

    const cleanupError = await releaseMutationLock(lease);
    if (operationFailed) {
        throw operationError;
    }
    if (cleanupError) {
        throw cleanupError;
    }
    return operationResult as Result;
};

export type PlatformMutationLock = 'kiro' | 'minimax';

export const withPlatformMutationLock = async <Result>(
    platform: PlatformMutationLock,
    operation: () => Promise<Result>,
) => withMutationLock(`${VAULT_PATH}.${platform}-cycle.lock`, operation);
