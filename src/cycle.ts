export const cycleCandidateKeys = (savedKeys: readonly string[], activeKey: string | undefined) => {
    const ordered = [...new Set(savedKeys)].sort((left, right) => left.localeCompare(right, 'en'));
    const activeIndex = activeKey === undefined ? -1 : ordered.indexOf(activeKey);
    if (activeIndex < 0) {
        return ordered;
    }
    return [...ordered.slice(activeIndex + 1), ...ordered.slice(0, activeIndex + 1)];
};

export type CycleNextResult = {
    healed: boolean;
};

export type CycleSkipReporter = () => void;
