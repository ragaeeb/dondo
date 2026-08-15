import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
