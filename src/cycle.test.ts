import { expect, it } from 'bun:test';
import { cycleCandidateKeys, cycleNext } from './cycle.ts';

it('orders saved account keys deterministically after the active account and wraps', () => {
    expect(cycleCandidateKeys(['zebra', 'alpha', 'middle'], 'middle')).toEqual(['zebra', 'alpha', 'middle']);
});

it('starts at index zero when no saved account matches the live credential', () => {
    expect(cycleCandidateKeys(['zebra', 'alpha', 'middle'], undefined)).toEqual(['alpha', 'middle', 'zebra']);
});

it('returns each saved account at most once without mutating the input', () => {
    const keys = ['zebra', 'alpha', 'alpha', 'middle'];

    expect(cycleCandidateKeys(keys, 'alpha')).toEqual(['middle', 'zebra', 'alpha']);
    expect(keys).toEqual(['zebra', 'alpha', 'alpha', 'middle']);
});

it('cycles a single account back to itself and handles an empty vault', () => {
    expect(cycleCandidateKeys(['only'], 'only')).toEqual(['only']);
    expect(cycleCandidateKeys([], undefined)).toEqual([]);
});

it('deduplicates healthy and corrupted account keys before cycling', () => {
    expect(cycleCandidateKeys(['saved', 'damaged', 'saved', 'damaged'], 'saved')).toEqual(['damaged', 'saved']);
});

it('cycles candidates through one shared runner and reports skipped accounts', async () => {
    const attempted: string[] = [];
    let skipped = 0;

    const result = await cycleNext({
        activeKey: 'alpha',
        candidateKeys: ['gamma', 'alpha', 'beta'],
        isUnavailable: (error) => error === 'unavailable',
        load: async (key) => {
            attempted.push(key);
            if (key === 'beta') {
                throw 'unavailable';
            }
        },
        noAvailableMessage: 'No account could be loaded',
        onSkip: () => {
            skipped += 1;
        },
    });

    expect(result).toEqual({ healed: true });
    expect(attempted).toEqual(['beta', 'gamma']);
    expect(skipped).toBe(1);
});

it('rethrows non-candidate failures from the shared cycle runner', async () => {
    await expect(
        cycleNext({
            activeKey: undefined,
            candidateKeys: ['account'],
            isUnavailable: () => false,
            load: async () => {
                throw new Error('fatal');
            },
            noAvailableMessage: 'not reached',
        }),
    ).rejects.toThrow('fatal');
});
