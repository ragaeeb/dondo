import { expect, it } from 'bun:test';
import { percentile, shouldInvestigate } from './benchmark-vault.ts';

it('should calculate a nearest-rank percentile without mutating samples', () => {
    const samples = [40, 10, 30, 20];

    expect(percentile(samples, 0.5)).toBe(20);
    expect(percentile(samples, 0.95)).toBe(40);
    expect(samples).toEqual([40, 10, 30, 20]);
});

it('should flag only p95 measurements above the storage investigation threshold', () => {
    expect(shouldInvestigate(100)).toBe(false);
    expect(shouldInvestigate(100.01)).toBe(true);
    expect(shouldInvestigate(150, 200)).toBe(false);
});
