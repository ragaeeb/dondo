import type { CycleNextResult, CycleSkipReporter } from './cycle.ts';
import { errorMessage, isPublicError } from './errors.ts';

type CycleOperation = (onSkip: CycleSkipReporter) => Promise<CycleNextResult>;

export type CyclePlatform = 'antigravity' | 'cline' | 'codex' | 'kiro' | 'minimax';

export type CycleCliDependencies = {
    cycle: (platform: CyclePlatform, onSkip: CycleSkipReporter) => Promise<CycleNextResult>;
    writeStderr: (text: string) => void;
    writeStdout: (text: string) => void;
};

const platformLabels: Record<CyclePlatform, string> = {
    antigravity: 'Antigravity',
    cline: 'Cline',
    codex: 'Codex',
    kiro: 'Kiro',
    minimax: 'MiniMax',
};

const cycleOperations: Record<CyclePlatform, CycleOperation> = {
    antigravity: async (onSkip) => (await import('./antigravity/service.ts')).cycleNextAntigravity({ onSkip }),
    cline: async (onSkip) => (await import('./cline/service.ts')).cycleNextCline({ onSkip }),
    codex: async (onSkip) => (await import('./codex/service.ts')).cycleNextCodex({ onSkip }),
    kiro: async (onSkip) => (await import('./kiro/service.ts')).cycleNextKiro({ onSkip }),
    minimax: async (onSkip) => (await import('./minimax/service.ts')).cycleNextMinimax({ onSkip }),
};

const defaultDependencies: CycleCliDependencies = {
    cycle: (platform, onSkip) => cycleOperations[platform](onSkip),
    writeStderr: (text) => process.stderr.write(text),
    writeStdout: (text) => process.stdout.write(text),
};

const USAGE = 'Usage: dondo-donuts <antigravity|cline|codex|kiro|minimax> next [--json]\n';
const CLI_CYCLE_ERROR_CODE = 'ACCOUNT_SWITCH_FAILED';

const isCyclePlatform = (value: string | undefined): value is CyclePlatform =>
    typeof value === 'string' && Object.hasOwn(platformLabels, value);

export const runCli = async (
    args: readonly string[],
    dependencies: CycleCliDependencies = defaultDependencies,
): Promise<number | null> => {
    if (args.length === 0) {
        return null;
    }
    const [platformValue, action, option] = args;
    if (
        !isCyclePlatform(platformValue) ||
        action !== 'next' ||
        (option !== undefined && option !== '--json') ||
        args.length > 3
    ) {
        dependencies.writeStderr(USAGE);
        return 2;
    }

    const platform = platformValue;
    const label = platformLabels[platform];
    const machineReadable = option === '--json';
    const onSkip = () => {
        if (!machineReadable) {
            dependencies.writeStderr(`Skipped an unavailable saved ${label} account.\n`);
        }
    };
    try {
        const result = await dependencies.cycle(platform, onSkip);
        dependencies.writeStdout(
            machineReadable
                ? `${JSON.stringify({ action: 'next', healed: result.healed, ok: true, platform })}\n`
                : `Switched to the next available ${label} account.\n`,
        );
        return 0;
    } catch (error) {
        const message = isPublicError(error)
            ? errorMessage(error)
            : `Could not switch to an available ${label} account.`;
        dependencies.writeStderr(
            machineReadable
                ? `${JSON.stringify({
                      action: 'next',
                      code: CLI_CYCLE_ERROR_CODE,
                      error: message,
                      ok: false,
                      platform,
                  })}\n`
                : `${message}\n`,
        );
        return 1;
    }
};
