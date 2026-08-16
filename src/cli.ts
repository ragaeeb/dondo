import type { CycleNextResult, CycleSkipReporter } from './cycle.ts';
import { errorMessage, isPublicError } from './errors.ts';

type CycleOperation = (onSkip: CycleSkipReporter) => Promise<CycleNextResult>;

export type CycleCliDependencies = {
    cycleKiro: CycleOperation;
    cycleMinimax: CycleOperation;
    writeStderr: (text: string) => void;
    writeStdout: (text: string) => void;
};

type CyclePlatform = 'kiro' | 'minimax';

const defaultDependencies: CycleCliDependencies = {
    cycleKiro: async (onSkip) => (await import('./kiro/service.ts')).cycleNextKiro({ onSkip }),
    cycleMinimax: async (onSkip) => (await import('./minimax/service.ts')).cycleNextMinimax({ onSkip }),
    writeStderr: (text) => process.stderr.write(text),
    writeStdout: (text) => process.stdout.write(text),
};

const USAGE = 'Usage: dondo-donuts <minimax|kiro> next [--json]\n';

const displayPlatform = (platform: CyclePlatform) => (platform === 'kiro' ? 'Kiro' : 'MiniMax');

export const runCli = async (
    args: readonly string[],
    dependencies: CycleCliDependencies = defaultDependencies,
): Promise<number | null> => {
    if (args.length === 0) {
        return null;
    }
    const [platformValue, action, option] = args;
    if (
        (platformValue !== 'kiro' && platformValue !== 'minimax') ||
        action !== 'next' ||
        (option !== undefined && option !== '--json') ||
        args.length > 3
    ) {
        dependencies.writeStderr(USAGE);
        return 2;
    }

    const platform = platformValue;
    const label = displayPlatform(platform);
    const onSkip = () => dependencies.writeStderr(`Skipped an unavailable saved ${label} account.\n`);
    try {
        const result = await (platform === 'kiro' ? dependencies.cycleKiro(onSkip) : dependencies.cycleMinimax(onSkip));
        dependencies.writeStdout(
            option === '--json'
                ? `${JSON.stringify({ action: 'next', healed: result.healed, ok: true, platform })}\n`
                : `Switched to the next available ${label} account.\n`,
        );
        return 0;
    } catch (error) {
        const message = isPublicError(error)
            ? errorMessage(error)
            : `Could not switch to an available ${label} account.`;
        dependencies.writeStderr(`${message}\n`);
        return 1;
    }
};
