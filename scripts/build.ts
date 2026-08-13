import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForAll } from '../src/async-queue.ts';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_OUTDIR = join(PROJECT_ROOT, 'dist');

const buildFailure = (label: string, logs: readonly { message: string }[]) => {
    return new Error(`${label} failed:\n${logs.map((log) => log.message).join('\n') || 'Unknown build error'}`);
};

const assertBuild = (label: string, result: Awaited<ReturnType<typeof Bun.build>>) => {
    if (!result.success) {
        throw buildFailure(label, result.logs);
    }
    return result;
};

const prepareOutput = async (outdir: string) => {
    const resolved = resolve(outdir);
    const temporaryRoot = resolve(tmpdir());
    if (
        basename(resolved) !== 'dist' ||
        (resolved !== resolve(DEFAULT_OUTDIR) && !resolved.startsWith(`${temporaryRoot}${sep}`))
    ) {
        throw new Error('Distribution output must be the project dist directory or a temporary dist directory');
    }
    const staged = join(dirname(resolved), `.dist-${process.pid}-${randomUUID()}`);
    await rm(staged, { force: true, recursive: true });
    await mkdir(join(staged, 'assets'), { recursive: true });
    return { resolved, staged };
};

export const buildDistribution = async (outdir = DEFAULT_OUTDIR) => {
    const { resolved, staged } = await prepareOutput(outdir);
    const backup = join(dirname(resolved), `.dist-${process.pid}-${randomUUID()}.backup`);
    let hasBackup = false;
    try {
        const ui = assertBuild(
            'Browser build',
            await Bun.build({
                entrypoints: [join(PROJECT_ROOT, 'src', 'ui', 'client.tsx')],
                jsx: { importSource: 'preact', runtime: 'automatic' },
                target: 'browser',
            }),
        );
        const appJs = ui.outputs.find((output) => output.path.endsWith('.js'));
        if (!appJs) {
            throw new Error('Browser build did not produce JavaScript');
        }
        await waitForAll([
            Bun.write(join(staged, 'assets', 'app.js'), appJs),
            Bun.write(join(staged, 'assets', 'styles.css'), Bun.file(join(PROJECT_ROOT, 'src', 'ui', 'styles.css'))),
            Bun.write(join(staged, 'icon.png'), Bun.file(join(PROJECT_ROOT, 'icon.png'))),
            Bun.write(join(staged, 'icon.svg'), Bun.file(join(PROJECT_ROOT, 'icon.svg'))),
        ]);
        assertBuild(
            'Server build',
            await Bun.build({
                define: { DONDO_BUNDLED_ASSETS: 'true' },
                entrypoints: [join(PROJECT_ROOT, 'src', 'server.ts')],
                outdir: staged,
                target: 'bun',
            }),
        );
        await rm(backup, { force: true, recursive: true });
        try {
            await stat(resolved);
            await rename(resolved, backup);
            hasBackup = true;
        } catch (error) {
            if ((error as { code?: unknown }).code !== 'ENOENT') {
                throw error;
            }
        }
        try {
            await rename(staged, resolved);
        } catch (error) {
            await rm(staged, { force: true, recursive: true });
            if (hasBackup) {
                await rm(resolved, { force: true, recursive: true });
                await rename(backup, resolved);
                hasBackup = false;
            }
            throw error;
        }
        if (hasBackup) {
            await rm(backup, { force: true, recursive: true });
            hasBackup = false;
        }
    } catch (error) {
        await rm(staged, { force: true, recursive: true });
        if (hasBackup) {
            await rm(resolved, { force: true, recursive: true });
            await rename(backup, resolved);
        }
        throw error;
    } finally {
        await rm(backup, { force: true, recursive: true }).catch(() => {});
    }
};

if (import.meta.main) {
    await buildDistribution();
    console.log('Built runnable distribution in dist');
}
