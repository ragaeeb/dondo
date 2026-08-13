import { createHash } from 'node:crypto';
import { waitForAll } from './async-queue.ts';
import type { LimitCache, LimitResult } from './types.ts';

const DEFAULT_REFRESH_CONCURRENCY = 3;

type AccountEntry = {
    active: boolean;
    key: string;
    quota: LimitResult | null;
};

type RefreshOptions = {
    force: boolean;
    targetKey?: string;
};

export const CORRUPTED_ACCOUNT_ERROR = 'Saved account data is corrupted';

export const stateVersion = (value: unknown) => {
    return createHash('sha256')
        .update(JSON.stringify(value) ?? 'undefined')
        .digest('hex');
};

export const boundedMap = async <Input, Output>(
    inputs: readonly Input[],
    mapper: (input: Input, index: number) => Promise<Output>,
    concurrency = DEFAULT_REFRESH_CONCURRENCY,
) => {
    if (inputs.length === 0) {
        return [];
    }
    const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
    const workerCount = Math.max(1, Math.min(normalizedConcurrency, inputs.length));
    const results = new Array<Output>(inputs.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < inputs.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await mapper(inputs[index] as Input, index);
        }
    };
    await waitForAll(Array.from({ length: workerCount }, worker));
    return results;
};

export const selectRefreshEntries = <Snapshot>(
    data: Record<string, Snapshot>,
    limits: Record<string, LimitCache>,
    options: RefreshOptions,
) => {
    return Object.entries(data).filter(([key]) => {
        if (options.targetKey && key !== options.targetKey) {
            return false;
        }
        return options.force || !limits[key];
    });
};

export const sortAccountEntries = <Entry extends AccountEntry>(
    entries: readonly Entry[],
    isDepleted?: (quota: LimitResult | null) => boolean,
) => {
    return [...entries].sort((a, b) => {
        if (a.active !== b.active) {
            return a.active ? -1 : 1;
        }
        if (isDepleted) {
            const aDepleted = isDepleted(a.quota);
            const bDepleted = isDepleted(b.quota);
            if (aDepleted !== bDepleted) {
                return aDepleted ? 1 : -1;
            }
        }
        return a.key.localeCompare(b.key);
    });
};
