import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicError } from '../src/errors.ts';
import { readVaultSection, updateVaultSection } from '../src/storage/vault.ts';

const BENCHMARK_KEY = Buffer.alloc(32, 23);
const MAX_VAULT_BYTES = 16 * 1024 * 1024;
const STORAGE_INVESTIGATION_THRESHOLD_MS = 100;
export const BENCHMARK_SAMPLE_COUNT = 20;
const ACCOUNT_COUNTS = [1, 10, 100, 1_000, 4_096];
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

type BenchmarkMetric = {
    medianMs: number;
    p95Ms: number;
};

type BenchmarkScenario = {
    accountsPerPlatform: number;
    fileBytes: number;
    metrics?: {
        codexPlatformDecrypt: BenchmarkMetric;
        fullFileReadParse: BenchmarkMetric;
        noWriteUpdate: BenchmarkMetric;
        oneAccountUpdate: BenchmarkMetric;
    };
    skipped?: string;
};

const accountKey = (index: number) => `account-${index}`;

export const percentile = (samples: readonly number[], fraction: number) => {
    if (samples.length === 0) {
        throw new Error('Cannot calculate a percentile from no samples');
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1));
    return sorted[rank] as number;
};

export const shouldInvestigate = (p95Ms: number, thresholdMs = STORAGE_INVESTIGATION_THRESHOLD_MS) => {
    return p95Ms > thresholdMs;
};

export const benchmarkMetric = (samples: readonly number[]): BenchmarkMetric => ({
    medianMs: Number(percentile(samples, 0.5).toFixed(2)),
    p95Ms: percentile(samples, 0.95),
});

const elapsedMs = async (operation: () => Promise<unknown>) => {
    const started = Bun.nanoseconds();
    await operation();
    return (Bun.nanoseconds() - started) / 1_000_000;
};

const measure = async (operation: () => Promise<unknown>): Promise<BenchmarkMetric> => {
    await operation();
    const samples: number[] = [];
    for (let index = 0; index < BENCHMARK_SAMPLE_COUNT; index += 1) {
        samples.push(await elapsedMs(operation));
    }
    return benchmarkMetric(samples);
};

const seedAntigravity = async (count: number, path: string) => {
    await updateVaultSection(
        'antigravity',
        (section) => {
            for (let index = 0; index < count; index += 1) {
                section.data[accountKey(index)] = {
                    account: 'antigravity',
                    createdAt: TIMESTAMP,
                    identity: 'synthetic-account',
                    kind: 'Generic Password',
                    label: 'gemini',
                    password: `synthetic-antigravity-${index}`,
                    service: 'gemini',
                    updatedAt: TIMESTAMP,
                };
            }
            return { result: undefined };
        },
        path,
        BENCHMARK_KEY,
    );
};

const seedCodex = async (count: number, path: string) => {
    await updateVaultSection(
        'codex',
        (section) => {
            for (let index = 0; index < count; index += 1) {
                section.data[accountKey(index)] = {
                    auth: JSON.stringify({ OPENAI_API_KEY: `synthetic-codex-${index}` }),
                    createdAt: TIMESTAMP,
                    updatedAt: TIMESTAMP,
                };
            }
            return { result: undefined };
        },
        path,
        BENCHMARK_KEY,
    );
};

const seedCline = async (count: number, path: string) => {
    await updateVaultSection(
        'cline',
        (section) => {
            for (let index = 0; index < count; index += 1) {
                section.data[accountKey(index)] = {
                    createdAt: TIMESTAMP,
                    secrets: JSON.stringify({ provider: `synthetic-cline-${index}` }),
                    updatedAt: TIMESTAMP,
                };
            }
            return { result: undefined };
        },
        path,
        BENCHMARK_KEY,
    );
};

const seedKiro = async (count: number, path: string) => {
    await updateVaultSection(
        'kiro',
        (section) => {
            for (let index = 0; index < count; index += 1) {
                section.data[accountKey(index)] = {
                    auth: JSON.stringify({ refreshToken: `synthetic-kiro-${index}` }),
                    createdAt: TIMESTAMP,
                    updatedAt: TIMESTAMP,
                };
            }
            return { result: undefined };
        },
        path,
        BENCHMARK_KEY,
    );
};

const seedMinimax = async (count: number, path: string) => {
    await updateVaultSection(
        'minimax',
        (section) => {
            for (let index = 0; index < count; index += 1) {
                section.data[accountKey(index)] = {
                    config: JSON.stringify({
                        tokens: {
                            accessToken: `header.${Buffer.from(
                                JSON.stringify({ user: { id: `synthetic-minimax-${index}` } }),
                            ).toString('base64url')}.signature`,
                        },
                    }),
                    createdAt: TIMESTAMP,
                    realUserId: `synthetic-user-${index}`,
                    updatedAt: TIMESTAMP,
                };
            }
            return { result: undefined };
        },
        path,
        BENCHMARK_KEY,
    );
};

const seedVault = async (count: number, path: string) => {
    await seedAntigravity(count, path);
    await seedCodex(count, path);
    await seedCline(count, path);
    await seedKiro(count, path);
    await seedMinimax(count, path);
};

const measureScenario = async (count: number): Promise<BenchmarkScenario> => {
    const root = await mkdtemp(join(tmpdir(), 'dondo-vault-benchmark-'));
    const path = join(root, 'vault.json');
    try {
        try {
            await seedVault(count, path);
        } catch (error) {
            if (!isPublicError(error) || error.message !== 'Vault file exceeds the 16 MiB size limit') {
                throw error;
            }
            return {
                accountsPerPlatform: count,
                fileBytes: MAX_VAULT_BYTES + 1,
                skipped: 'Vault file exceeds the 16 MiB size limit',
            };
        }
        const metrics = {
            codexPlatformDecrypt: await measure(() => readVaultSection('codex', path, BENCHMARK_KEY)),
            fullFileReadParse: await measure(async () => {
                JSON.parse(await Bun.file(path).text());
            }),
            noWriteUpdate: await measure(() =>
                updateVaultSection(
                    'codex',
                    (section) => ({ result: Object.keys(section.data).length, write: false }),
                    path,
                    BENCHMARK_KEY,
                ),
            ),
            oneAccountUpdate: await measure(() =>
                updateVaultSection(
                    'codex',
                    (section) => {
                        const account = section.data[accountKey(0)];
                        if (!account) {
                            throw new Error('Benchmark account was not seeded');
                        }
                        account.updatedAt = new Date().toISOString();
                        return { result: undefined };
                    },
                    path,
                    BENCHMARK_KEY,
                ),
            ),
        };
        return { accountsPerPlatform: count, fileBytes: Bun.file(path).size, metrics };
    } finally {
        await rm(root, { force: true, recursive: true });
    }
};

const main = async () => {
    const scenarios: BenchmarkScenario[] = [];
    let skippedAfterLimit = false;
    for (const count of ACCOUNT_COUNTS) {
        if (skippedAfterLimit) {
            scenarios.push({
                accountsPerPlatform: count,
                fileBytes: MAX_VAULT_BYTES + 1,
                skipped: 'Skipped because a smaller benchmark scenario exceeded the 16 MiB vault limit',
            });
            continue;
        }
        const scenario = await measureScenario(count);
        scenarios.push(scenario);
        skippedAfterLimit = Boolean(scenario.skipped) || scenario.fileBytes > MAX_VAULT_BYTES;
    }
    const investigate = scenarios.some((scenario) =>
        Object.values(scenario.metrics ?? {}).some((metric) => shouldInvestigate(metric.p95Ms)),
    );
    console.log(
        JSON.stringify(
            {
                investigate,
                investigationThresholdMs: STORAGE_INVESTIGATION_THRESHOLD_MS,
                scenarios,
            },
            null,
            2,
        ),
    );
};

if (import.meta.main) {
    await main();
}
