import { expect, it } from 'bun:test';
import { createAsyncQueue, waitForAll } from './async-queue.ts';

it('serializes operations and continues after a rejected operation', async () => {
    const queue = createAsyncQueue();
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const operation = (name: string, reject = false) =>
        queue(async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            events.push(`${name}-start`);
            await Bun.sleep(2);
            events.push(`${name}-end`);
            active -= 1;
            if (reject) {
                throw new Error(name);
            }
            return name;
        });

    const first = operation('first');
    const failed = operation('failed', true).catch((error: unknown) => String(error));
    const last = operation('last');

    expect(await Promise.all([first, failed, last])).toEqual(['first', 'Error: failed', 'last']);
    expect(maximumActive).toBe(1);
    expect(events).toEqual(['first-start', 'first-end', 'failed-start', 'failed-end', 'last-start', 'last-end']);
});

it('waits for every operation to settle before propagating a failure', async () => {
    let delayedFinished = false;
    const delayed = Bun.sleep(10).then(() => {
        delayedFinished = true;
    });

    await expect(waitForAll([Promise.reject(new Error('failed')), delayed])).rejects.toThrow('failed');
    expect(delayedFinished).toBe(true);
});
