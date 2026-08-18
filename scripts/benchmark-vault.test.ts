import { expect, it } from 'bun:test';
import { BENCHMARK_SAMPLE_COUNT, benchmarkMetric, percentile, shouldInvestigate } from './benchmark-vault.ts';

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

it('should evaluate investigation thresholds against the unrounded p95', () => {
    const metric = benchmarkMetric([0, 0, 0, 0, 100.004]);

    expect(metric.p95Ms).toBe(100.004);
    expect(metric.medianMs).toBe(0);
    expect(shouldInvestigate(metric.p95Ms)).toBe(true);
});

it('should use enough measured samples for a meaningful p95 estimate', () => {
    expect(BENCHMARK_SAMPLE_COUNT).toBeGreaterThanOrEqual(20);
});
