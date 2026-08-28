import { CORRUPTED_ACCOUNT_ERROR } from './account-state.ts';
import { isPublicError, publicError } from './errors.ts';

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

export type CycleNextOptions = {
    activeKey: string | undefined;
    candidateKeys: readonly string[];
    isUnavailable: (error: unknown) => boolean;
    load: (key: string) => Promise<unknown>;
    noAvailableMessage: string;
    onSkip?: CycleSkipReporter | undefined;
};

export const isUnavailableAccountError = (error: unknown) => {
    return (
        isPublicError(error) &&
        (error.status === 404 || (error.status === 409 && error.message === CORRUPTED_ACCOUNT_ERROR))
    );
};

export const cycleNext = async ({
    activeKey,
    candidateKeys,
    isUnavailable,
    load,
    noAvailableMessage,
    onSkip,
}: CycleNextOptions): Promise<CycleNextResult> => {
    let healed = false;
    for (const key of cycleCandidateKeys(candidateKeys, activeKey)) {
        try {
            await load(key);
            return { healed };
        } catch (error) {
            if (!isUnavailable(error)) {
                throw error;
            }
            healed = true;
            onSkip?.();
        }
    }
    throw publicError(409, noAvailableMessage);
};
