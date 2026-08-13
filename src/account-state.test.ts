import { expect, it } from 'bun:test';
import { boundedMap, selectRefreshEntries, sortAccountEntries, stateVersion } from './account-state.ts';
import type { LimitCache } from './types.ts';

it('produces fixed-size deterministic state versions', () => {
    const first = stateVersion({ auth: 'credential', updatedAt: 'now' });

    expect(first).toHaveLength(64);
    expect(stateVersion({ auth: 'credential', updatedAt: 'now' })).toBe(first);
    expect(stateVersion({ auth: 'replacement', updatedAt: 'now' })).not.toBe(first);
});

it('maps every bounded input in order, including undefined values', async () => {
    let active = 0;
    let maximumActive = 0;
    const result = await boundedMap(
        [3, undefined, 1, 2],
        async (value, index) => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await Bun.sleep((4 - index) * 2);
            active -= 1;
            return `${index}:${String(value)}`;
        },
        2,
    );

    expect(result).toEqual(['0:3', '1:undefined', '2:1', '3:2']);
    expect(maximumActive).toBe(2);
});

it('normalizes invalid bounded-map concurrency to one worker', async () => {
    let active = 0;
    let maximumActive = 0;
    await boundedMap(
        [1, 2],
        async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await Bun.sleep(1);
            active -= 1;
        },
        Number.NaN,
    );
    expect(maximumActive).toBe(1);
});

it('waits for every bounded worker to settle before propagating a failure', async () => {
    let delayedFinished = false;
    await expect(
        boundedMap(
            ['failed', 'delayed'],
            async (value) => {
                if (value === 'failed') {
                    throw new Error('mapper failed');
                }
                await Bun.sleep(10);
                delayedFinished = true;
            },
            2,
        ),
    ).rejects.toThrow('mapper failed');
    expect(delayedFinished).toBe(true);
});

it('selects only stale refresh entries unless a forced target is requested', () => {
    const data = { cached: { token: 'one' }, fresh: { token: 'two' }, stale: { token: 'three' } };
    const cachedLimit: LimitCache = {
        fetchedAt: '2026-01-01T00:00:00.000Z',
        quota: { error: 'unavailable', ok: false },
    };
    const limits = { cached: cachedLimit, fresh: cachedLimit };

    expect(selectRefreshEntries(data, limits, { force: false }).map(([key]) => key)).toEqual(['stale']);
    expect(selectRefreshEntries(data, limits, { force: true, targetKey: 'fresh' }).map(([key]) => key)).toEqual([
        'fresh',
    ]);
});

it('sorts active accounts first and depleted accounts last without mutating input', () => {
    const available = {
        expires: '',
        models: { quota: { displayName: 'Quota', percentage: 50, resetTime: '' } },
        ok: true as const,
        tier: '',
    };
    const depleted = {
        expires: '',
        models: { quota: { displayName: 'Quota', percentage: 0, resetTime: '' } },
        ok: true as const,
        tier: '',
    };
    const entries = [
        { active: false, key: 'depleted', quota: depleted },
        { active: false, key: 'available', quota: available },
        { active: true, key: 'active', quota: depleted },
    ];
    const originalOrder = entries.map(({ key }) => key);
    const sorted = sortAccountEntries(entries, (quota) =>
        quota?.ok === true ? Object.values(quota.models).every((model) => model.percentage <= 0) : false,
    );

    expect(sorted.map(({ key }) => key)).toEqual(['active', 'available', 'depleted']);
    expect(entries.map(({ key }) => key)).toEqual(originalOrder);
});
