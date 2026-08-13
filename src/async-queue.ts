export type AsyncQueue = <Result>(operation: () => Promise<Result>) => Promise<Result>;

export const createAsyncQueue = (): AsyncQueue => {
    let tail: Promise<void> = Promise.resolve();
    return <Result>(operation: () => Promise<Result>) => {
        const queued = tail.then(operation);
        tail = queued.then(
            () => undefined,
            () => undefined,
        );
        return queued;
    };
};

export const waitForAll = async (operations: readonly Promise<unknown>[]) => {
    const results = await Promise.allSettled(operations);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
        throw failure.reason;
    }
};
