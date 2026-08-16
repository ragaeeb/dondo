import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDistribution } from './build.ts';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_ICON_BYTES = 200_000;

it('should keep the source icon as a bounded 512 by 512 PNG', async () => {
    const bytes = await Bun.file(join(process.cwd(), 'icon.png')).bytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect([...bytes.slice(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
    expect(view.getUint32(16)).toBe(512);
    expect(view.getUint32(20)).toBe(512);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_ICON_BYTES);
});

const startedServerUrl = async (child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) {
                const error = await new Response(child.stderr).text();
                throw new Error(`Built server exited before startup: ${error}`);
            }
            output += decoder.decode(next.value, { stream: true });
            const url = output.match(/Dondo running at (http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
            if (url) {
                return url;
            }
            if (Buffer.byteLength(output, 'utf8') > 4 * 1024) {
                throw new Error('Built server startup output exceeded 4 KiB');
            }
        }
    } finally {
        clearTimeout(timeout);
        reader.releaseLock();
    }
};

it('builds a runnable distribution with its browser assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dondo-build-smoke-'));
    const outdir = join(root, 'dist');
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
        await buildDistribution(outdir);
        child = Bun.spawn(['bun', join(outdir, 'server.js')], {
            env: {
                ...globalThis.process.env,
                DONDO_DATA_DIR: join(root, 'data'),
                DONDO_PORT: '32000',
            },
            stderr: 'pipe',
            stdin: 'ignore',
            stdout: 'pipe',
        });
        const serverUrl = await startedServerUrl(child);
        const response = await fetch(serverUrl);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('<title>Dondo</title>');
        const [appJs, css, icon, favicon] = await Promise.all([
            fetch(`${serverUrl}/assets/app.js`),
            fetch(`${serverUrl}/assets/styles.css`),
            fetch(`${serverUrl}/icon.png`),
            fetch(`${serverUrl}/favicon.ico`),
        ]);
        expect([appJs.status, css.status, icon.status, favicon.status]).toEqual([200, 200, 200, 200]);
        expect((await appJs.text()).length).toBeGreaterThan(1_000);
        expect((await css.text()).length).toBeGreaterThan(1_000);
        expect(icon.headers.get('content-type')).toBe('image/png');
        expect(favicon.headers.get('content-type')).toBe('image/png');
        const iconBytes = await icon.bytes();
        const faviconBytes = await favicon.bytes();
        expect(iconBytes.byteLength).toBeGreaterThan(1_000);
        expect(faviconBytes).toEqual(iconBytes);
    } finally {
        child?.kill('SIGKILL');
        await child?.exited.catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    }
});
