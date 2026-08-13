import { type FSWatcher, watch } from 'node:fs';

const RESTART_DELAY_MS = 75;
const SHUTDOWN_GRACE_MS = 1_000;
const ROOT_RUNTIME_FILES = new Set(['icon.png', 'icon.svg', 'package.json']);

export const isRuntimeSource = (path: string) => {
    return !path.endsWith('.test.ts') && !path.endsWith('.test.tsx') && /\.(?:css|ts|tsx)$/u.test(path);
};

let child: ReturnType<typeof Bun.spawn> | undefined;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let restartQueue = Promise.resolve();
let shuttingDown = false;
const watchers: FSWatcher[] = [];

const startServer = () => {
    child = Bun.spawn([process.execPath, 'src/server.ts'], {
        stderr: 'inherit',
        stdin: 'inherit',
        stdout: 'inherit',
    });
};

const stopServer = async (server: ReturnType<typeof Bun.spawn>) => {
    server.kill('SIGTERM');
    const stopped = await Promise.race([
        server.exited.then(() => true),
        Bun.sleep(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!stopped) {
        server.kill('SIGKILL');
        await server.exited.catch(() => undefined);
    }
};

const restartServer = async () => {
    const previous = child;
    child = undefined;
    if (previous) {
        await stopServer(previous);
    }
    if (!shuttingDown) {
        startServer();
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
    await restartQueue;
    if (child) {
        await stopServer(child);
    }
    process.exit(exitCode);
};

export const startDevWatcher = () => {
    startServer();
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
    process.once('SIGINT', () => void shutdown(130));
    process.once('SIGTERM', () => void shutdown(143));
};

if (import.meta.main) {
    startDevWatcher();
}
