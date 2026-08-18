import { expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getAvailablePort = async () =>
    new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Could not allocate a mock smoke-test port')));
                return;
            }
            server.close(() => resolve(address.port));
        });
    });

const startedServerUrl = async (child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8_000);
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) {
                const error = await new Response(child.stderr).text();
                throw new Error(`Mock server exited before startup: ${error}`);
            }
            output += decoder.decode(next.value, { stream: true });
            const url = output.match(/Dondo running at (http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
            if (url) {
                return url;
            }
            if (Buffer.byteLength(output, 'utf8') > 8 * 1024) {
                throw new Error('Mock server startup output exceeded 8 KiB');
            }
        }
    } finally {
        clearTimeout(timeout);
        reader.releaseLock();
    }
};

it('should exercise Antigravity save, load-state, and clear through the sandboxed mock mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dondo-mock-smoke-'));
    const home = join(root, 'home');
    const data = join(root, 'data');
    const port = await getAvailablePort();
    const child = Bun.spawn([process.execPath, 'src/server.ts'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            ANTIGRAVITY_PROCESS_NAME: 'dondo-antigravity-mock-test-not-running',
            DONDO_DATA_DIR: data,
            DONDO_DEV_MODE: 'mock',
            DONDO_PORT: String(port),
            HOME: home,
        },
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
    });
    try {
        const serverUrl = await startedServerUrl(child);
        const version = await fetch(`${serverUrl}/api/version`);
        expect(version.status).toBe(200);
        expect(await version.json()).toEqual({ apiVersion: 1, appVersion: expect.any(String) });

        const save = await fetch(`${serverUrl}/api/antigravity/save`, {
            body: JSON.stringify({ key: 'mock-account' }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        expect(save.status).toBe(200);

        const state = await fetch(`${serverUrl}/api/antigravity/state`);
        const stateText = await state.text();
        expect(state.status).toBe(200);
        expect(stateText).toContain(`${data}/vault.json`);
        expect(stateText).toContain('mock-account');
        expect(stateText).not.toContain('mock-access-token');
        expect(stateText).not.toContain('mock-refresh-token');

        const localStateMarker = join(home, '.gemini', 'antigravity', 'marker');
        await mkdir(join(home, '.gemini', 'antigravity'), { recursive: true });
        await Bun.write(localStateMarker, 'sandbox-only');

        const load = await fetch(`${serverUrl}/api/antigravity/load`, {
            body: JSON.stringify({ key: 'mock-account' }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        expect(load.status).toBe(200);
        expect(await Bun.file(localStateMarker).text()).toBe('sandbox-only');

        const clear = await fetch(`${serverUrl}/api/antigravity/clear`, {
            body: '{}',
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        expect(clear.status).toBe(200);
        expect(await Bun.file(localStateMarker).text()).toBe('sandbox-only');

        const afterClear = await fetch(`${serverUrl}/api/antigravity/state`);
        expect(afterClear.status).toBe(200);
        expect(await afterClear.text()).not.toContain('mock-access-token');
    } finally {
        child.kill('SIGKILL');
        await child.exited.catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    }
});
