import { expect, it } from 'bun:test';
import { type CycleCliDependencies, runCli } from './cli.ts';
import { publicError } from './errors.ts';

const run = async (args: string[], overrides: Partial<CycleCliDependencies> = {}) => {
    let stdout = '';
    let stderr = '';
    const dependencies: CycleCliDependencies = {
        cycleKiro: async () => ({ healed: false }),
        cycleMinimax: async () => ({ healed: false }),
        writeStderr: (text) => {
            stderr += text;
        },
        writeStdout: (text) => {
            stdout += text;
        },
        ...overrides,
    };
    return { exitCode: await runCli(args, dependencies), stderr, stdout };
};

it('leaves an empty argument list for the UI server entry point', async () => {
    expect(await run([])).toEqual({ exitCode: null, stderr: '', stdout: '' });
});

it('runs the strict positional next contract with safe human output', async () => {
    let minimaxCalls = 0;
    const result = await run(['minimax', 'next'], {
        cycleMinimax: async () => {
            minimaxCalls += 1;
            return { healed: false };
        },
    });

    expect(minimaxCalls).toBe(1);
    expect(result).toEqual({
        exitCode: 0,
        stderr: '',
        stdout: 'Switched to the next available MiniMax account.\n',
    });
});

it('supports machine-readable output without account metadata', async () => {
    const result = await run(['kiro', 'next', '--json'], {
        cycleKiro: async (onSkip) => {
            onSkip();
            return { healed: true };
        },
    });

    expect(JSON.parse(result.stdout)).toEqual({ action: 'next', healed: true, ok: true, platform: 'kiro' });
    expect(result.stdout).not.toMatch(/label|accountKey|count|index|token/iu);
    expect(result.stderr).toBe('Skipped an unavailable saved Kiro account.\n');
    expect(result.exitCode).toBe(0);
});

it('rejects flags and commands outside the stable contract without invoking a platform', async () => {
    let calls = 0;
    const dependency = async () => {
        calls += 1;
        return { healed: false };
    };

    for (const args of [
        ['minimax', '--next'],
        ['kiro', 'next', '--verbose'],
        ['minimax', 'list'],
        ['minimax', 'next', '--json', 'unexpected'],
    ]) {
        const result = await run(args, { cycleKiro: dependency, cycleMinimax: dependency });
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('Usage: dondo-donuts <minimax|kiro> next [--json]\n');
    }
    expect(calls).toBe(0);
});

it('does not expose account labels or unexpected error details', async () => {
    const secretLabel = 'private-account-label';
    const result = await run(['minimax', 'next'], {
        cycleMinimax: async (onSkip) => {
            onSkip();
            throw new Error(`${secretLabel}: accessToken=secret-value`);
        },
    });

    expect(result).toEqual({
        exitCode: 1,
        stderr: 'Skipped an unavailable saved MiniMax account.\nCould not switch to an available MiniMax account.\n',
        stdout: '',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretLabel);
    expect(`${result.stdout}${result.stderr}`).not.toContain('secret-value');
});

it('preserves safe actionable platform errors such as the Kiro process-closed rule', async () => {
    const result = await run(['kiro', 'next'], {
        cycleKiro: async () => {
            throw publicError(409, 'Quit Kiro completely before cycling accounts.');
        },
    });

    expect(result).toEqual({
        exitCode: 1,
        stderr: 'Quit Kiro completely before cycling accounts.\n',
        stdout: '',
    });
});
