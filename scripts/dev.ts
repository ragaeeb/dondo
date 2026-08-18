import { type FSWatcher, watch } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESTART_DELAY_MS = 75;
const SHUTDOWN_GRACE_MS = 1_000;
const ROOT_RUNTIME_FILES = new Set(['icon.png', 'icon.svg', 'package.json']);

export type DevMode = 'mock' | 'standard';

export type PreparedDevEnvironment = {
    cleanup: () => Promise<void>;
    env: NodeJS.ProcessEnv;
    root: string;
};

export const prepareDevEnvironment = async (mode: DevMode): Promise<PreparedDevEnvironment> => {
    if (mode === 'standard') {
        return { cleanup: async () => {}, env: { ...process.env }, root: '' };
    }

    const root = await mkdtemp(join(tmpdir(), 'dondo-dev-mock-'));
    const dataDir = join(root, 'data');
    return {
        cleanup: async () => {
            await rm(root, { force: true, recursive: true });
        },
        env: {
            ...process.env,
            CLINE_PROVIDERS_PATH: join(root, 'cline', 'providers.json'),
            CODEX_AUTH_PATH: join(root, 'codex', 'auth.json'),
            DONDO_DATA_DIR: dataDir,
            DONDO_DEV_MODE: 'mock',
            DONDO_VAULT: join(dataDir, 'vault.json'),
            HOME: join(root, 'home'),
            KIRO_AUTH_PATH: join(root, 'kiro', 'kiro-auth-token.json'),
            KIRO_PROFILE_PATH: join(root, 'kiro', 'profile.json'),
            MINIMAX_CONFIG_PATH: join(root, 'minimax', 'minimax-agent-config.json'),
            MINIMAX_LOCAL_STORAGE_PATH: join(root, 'minimax', 'Local Storage', 'leveldb'),
        },
        root,
    };
};

export const isRuntimeSource = (path: string) => {
    return !path.endsWith('.test.ts') && !path.endsWith('.test.tsx') && /\.(?:css|ts|tsx)$/u.test(path);
};

let child: ReturnType<typeof Bun.spawn> | undefined;
const devMode: DevMode = process.argv.slice(2).includes('--mock') ? 'mock' : 'standard';
let activeEnvironment: PreparedDevEnvironment | undefined;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let restartQueue = Promise.resolve();
let shuttingDown = false;
const watchers: FSWatcher[] = [];

const startServer = async () => {
    const environment = await prepareDevEnvironment(devMode);
    activeEnvironment = environment;
    try {
        child = Bun.spawn([process.execPath, 'src/server.ts'], {
            env: environment.env,
            stderr: 'inherit',
            stdin: 'inherit',
            stdout: 'inherit',
        });
    } catch (error) {
        activeEnvironment = undefined;
        await environment.cleanup().catch(() => undefined);
        throw error;
    }
};

const stopServer = async (server: ReturnType<typeof Bun.spawn>) => {
    const environment = activeEnvironment;
    let failure: unknown;
    try {
        server.kill('SIGTERM');
        const stopped = await Promise.race([
            server.exited.then(() => true),
            Bun.sleep(SHUTDOWN_GRACE_MS).then(() => false),
        ]);
        if (!stopped) {
            server.kill('SIGKILL');
            await server.exited.catch(() => undefined);
        }
    } catch (error) {
        failure = error;
    } finally {
        if (activeEnvironment === environment) {
            activeEnvironment = undefined;
        }
        try {
            await environment?.cleanup();
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure) {
        throw failure;
    }
};

const restartServer = async () => {
    const previous = child;
    child = undefined;
    if (previous) {
        await stopServer(previous);
    }
    if (!shuttingDown) {
        await startServer();
    }
};

const scheduleRestart = () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
        restartQueue = restartQueue.then(restartServer, restartServer);
    }, RESTART_DELAY_MS);
};

const shutdown = async (exitCode: number) => {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    clearTimeout(restartTimer);
    for (const watcher of watchers) {
        watcher.close();
    }
    try {
        await restartQueue;
    } catch {
        // A failed restart must not prevent the current child and sandbox from being cleaned up.
    } finally {
        const previous = child;
        child = undefined;
        try {
            if (previous) {
                await stopServer(previous);
            } else if (activeEnvironment) {
                const environment = activeEnvironment;
                activeEnvironment = undefined;
                await environment.cleanup();
            }
        } finally {
            process.exit(exitCode);
        }
    }
};

export const startDevWatcher = async () => {
    process.once('SIGINT', () => void shutdown(130));
    process.once('SIGTERM', () => void shutdown(143));
    try {
        await startServer();
        watchers.push(
            watch('src', { recursive: true }, (_event, filename) => {
                if (!filename || isRuntimeSource(String(filename))) {
                    scheduleRestart();
                }
            }),
            watch('.', (_event, filename) => {
                if (!filename || ROOT_RUNTIME_FILES.has(String(filename))) {
                    scheduleRestart();
                }
            }),
        );
    } catch (error) {
        for (const watcher of watchers) {
            watcher.close();
        }
        watchers.length = 0;
        const previous = child;
        child = undefined;
        if (previous) {
            await stopServer(previous).catch(() => undefined);
        } else if (activeEnvironment) {
            const environment = activeEnvironment;
            activeEnvironment = undefined;
            await environment.cleanup().catch(() => undefined);
        }
        throw error;
    }
};

if (import.meta.main) {
    await startDevWatcher();
}
