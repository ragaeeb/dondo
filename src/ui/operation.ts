export type OperationLock = {
    current: boolean;
};

export const runWithOperationLock = <Result>(
    lock: OperationLock,
    task: () => Promise<Result>,
): Promise<Result> | null => {
    if (lock.current) {
        return null;
    }
    lock.current = true;
    try {
        return task().finally(() => {
            lock.current = false;
        });
    } catch (error) {
        lock.current = false;
        return Promise.reject(error);
    }
};
