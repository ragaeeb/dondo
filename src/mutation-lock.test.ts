import { expect, it } from 'bun:test';
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMutationLock } from './mutation-lock.ts';

it('serializes mutations sharing a cross-process lock path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-mutation-lock-'));
    const path = join(dir, 'cycle.lock');
    const events: string[] = [];
    try {
        const first = withMutationLock(path, async () => {
            events.push('first-start');
            await Bun.sleep(20);
            events.push('first-end');
        });
        await Bun.sleep(2);
        const second = withMutationLock(path, async () => {
            events.push('second-start');
            events.push('second-end');
        });

        await Promise.all([first, second]);
        expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
        expect(await Bun.file(path).exists()).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('releases a mutation lock after failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-mutation-lock-'));
    const path = join(dir, 'cycle.lock');
    try {
        await expect(
            withMutationLock(path, async () => {
                throw new Error('failed');
            }),
        ).rejects.toThrow('failed');
        await expect(withMutationLock(path, async () => 'recovered')).resolves.toBe('recovered');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('recovers a lock left by a process that no longer exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-mutation-lock-'));
    const path = join(dir, 'cycle.lock');
    try {
        await Bun.write(path, '2147483647\n');
        await expect(withMutationLock(path, async () => 'recovered')).resolves.toBe('recovered');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('recovers an old lock with invalid contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-mutation-lock-'));
    const path = join(dir, 'cycle.lock');
    try {
        await Bun.write(path, 'not-a-pid\n');
        const old = new Date(0);
        await utimes(path, old, old);
        expect((await stat(path)).mtimeMs).toBe(0);
        await expect(withMutationLock(path, async () => 'recovered')).resolves.toBe('recovered');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('closes the handle and removes the lock after acquisition write or sync failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-mutation-lock-failure-'));
    const path = join(dir, 'cycle.lock');
    const script = `
        const { mock } = await import('bun:test');
        let failure = 'write';
        let closed = 0;
        let removed = 0;
        const realFs = await import('node:fs/promises');
        mock.module('node:fs/promises', () => ({
            ...realFs,
            mkdir: async () => {},
            open: async () => ({
                close: async () => { closed += 1; },
                sync: async () => {
                    if (failure === 'sync') throw new Error('sync failed');
                },
                writeFile: async () => {
                    if (failure === 'write') throw new Error('write failed');
                },
            }),
            rm: async () => { removed += 1; },
        }));
        const { withMutationLock } = await import('./src/mutation-lock.ts');
        const errors = [];
        for (const step of ['write', 'sync']) {
            failure = step;
            try {
                await withMutationLock(process.env.DONDO_LOCK_PATH, async () => {});
            } catch (error) {
                errors.push(String(error));
            }
        }
        console.log(JSON.stringify({ closed, errors, removed }));
    `;
    try {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: { ...process.env, DONDO_LOCK_PATH: path },
            stderr: 'pipe',
            stdout: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        if (exitCode !== 0) {
            throw new Error(stderr);
        }
        expect(JSON.parse(stdout)).toEqual({
            closed: 2,
            errors: ['Error: write failed', 'Error: sync failed'],
            removed: 2,
        });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
}, 30_000);

it('serializes mutations from separate Bun processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-mutation-lock-subprocess-'));
    const path = join(dir, 'cycle.lock');
    const eventsPath = join(dir, 'events.txt');
    const script = `
        const lockPath = process.env.DONDO_LOCK_PATH;
        const eventsPath = process.env.DONDO_EVENTS_PATH;
        const label = process.env.DONDO_LOCK_LABEL;
        const { withMutationLock } = await import('./src/mutation-lock.ts');
        const append = async (value) => {
            const current = await Bun.file(eventsPath).text();
            await Bun.write(eventsPath, current + value + '\\n');
        };
        await withMutationLock(lockPath, async () => {
            await append(label + '-start');
            await Bun.sleep(75);
            await append(label + '-end');
        });
    `;
    const run = async (label: string) => {
        const proc = Bun.spawn([process.execPath, '--eval', script], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                DONDO_EVENTS_PATH: eventsPath,
                DONDO_LOCK_LABEL: label,
                DONDO_LOCK_PATH: path,
            },
            stderr: 'pipe',
            stdout: 'pipe',
        });
        const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        if (exitCode !== 0) {
            throw new Error(stderr);
        }
    };

    try {
        await Bun.write(eventsPath, '');
        await Promise.all([run('first'), run('second')]);
        const events = (await Bun.file(eventsPath).text()).trim().split('\n');
        expect(events).toHaveLength(4);
        const firstLabel = events[0]?.replace(/-start$/u, '');
        const secondLabel = events[2]?.replace(/-start$/u, '');
        expect(events).toEqual([
            `${firstLabel}-start`,
            `${firstLabel}-end`,
            `${secondLabel}-start`,
            `${secondLabel}-end`,
        ]);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
}, 30_000);
