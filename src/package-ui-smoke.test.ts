import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const TIMEOUT_MS = 30_000;

type PackageManifest = {
    name: string;
    version: string;
};

type Probe = {
    bodyText: string;
    contentType: string | null;
    ok: boolean;
    status: number;
};

const packageTarballPath = (dir: string, manifest: PackageManifest) =>
    join(dir, `${manifest.name}-${manifest.version}.tgz`);

const getAvailablePort = async () =>
    new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, HOST, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Could not allocate a smoke-test port')));
                return;
            }
            server.close(() => resolve(address.port));
        });
    });

const runCommand = async (argv: string[], cwd: string) => {
    const proc = Bun.spawn(argv, { cwd, stderr: 'pipe', stdout: 'pipe' });
    const [exitCode, stdoutText, stderrText] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(`${argv.join(' ')} failed\n${stdoutText}\n${stderrText}`.trim());
    }
};

const waitForHealthyUi = async (url: string) => {
    const deadline = Date.now() + TIMEOUT_MS;
    let lastError = '';

    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            const probe: Probe = {
                bodyText: await response.text(),
                contentType: response.headers.get('content-type'),
                ok: response.ok,
                status: response.status,
            };
            if (
                probe.ok &&
                probe.contentType?.includes('text/html') &&
                probe.bodyText.includes('<title>Dondo</title>') &&
                probe.bodyText.includes('Dondo') &&
                !probe.bodyText.includes('Welcome to Bun!')
            ) {
                return probe;
            }
            lastError = `HTTP ${probe.status}: ${probe.bodyText.slice(0, 120)}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }

        await Bun.sleep(250);
    }

    throw new Error(`Timed out waiting for Dondo UI at ${url}${lastError ? ` (${lastError})` : ''}`);
};

describe('packaged UI smoke', () => {
    it('should launch the UI server through the packaged bunx dondo path', async () => {
        const manifest = (await Bun.file('package.json').json()) as PackageManifest;
        const tempDir = await mkdtemp(join(tmpdir(), 'dondo-packaged-ui-smoke-'));
        const port = await getAvailablePort();

        try {
            await runCommand(['bun', 'pm', 'pack', '--destination', tempDir], process.cwd());
            await Bun.write(join(tempDir, 'package.json'), '{"name":"dondo-smoke","private":true}\n');

            const proc = Bun.spawn(['bunx', '--package', packageTarballPath(tempDir, manifest), 'dondo'], {
                cwd: tempDir,
                env: {
                    ...process.env,
                    CODEX_AUTH_PATH: join(tempDir, 'auth.json'),
                    DONDO_DATA_DIR: join(tempDir, 'data'),
                    DONDO_PORT: String(port),
                },
                stderr: 'pipe',
                stdout: 'pipe',
            });
            const stdoutPromise = new Response(proc.stdout).text();
            const stderrPromise = new Response(proc.stderr).text();

            try {
                const probe = await waitForHealthyUi(`http://${HOST}:${port}/`);
                expect(probe.status).toBe(200);
            } catch (error) {
                proc.kill();
                const [stdoutText, stderrText] = await Promise.all([
                    stdoutPromise.catch(() => ''),
                    stderrPromise.catch(() => ''),
                    proc.exited.catch(() => undefined),
                ]);
                throw new Error(
                    [
                        error instanceof Error ? error.message : String(error),
                        stdoutText.trim() ? `stdout:\n${stdoutText}` : '',
                        stderrText.trim() ? `stderr:\n${stderrText}` : '',
                    ]
                        .filter(Boolean)
                        .join('\n\n'),
                );
            } finally {
                proc.kill();
                await Promise.all([
                    proc.exited.catch(() => undefined),
                    stdoutPromise.catch(() => ''),
                    stderrPromise.catch(() => ''),
                ]);
            }
        } finally {
            await rm(tempDir, { force: true, recursive: true });
        }
    }, 60_000);
});
