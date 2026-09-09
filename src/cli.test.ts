import { expect, it } from 'bun:test';
import { type CycleCliDependencies, type CyclePlatform, runCli } from './cli.ts';
import { publicError } from './errors.ts';

const cyclePlatforms: CyclePlatform[] = ['antigravity', 'cline', 'codex', 'kiro', 'minimax'];

const run = async (
    args: string[],
    overrides: Partial<Omit<CycleCliDependencies, 'cycle'>> & {
        cycle?: CycleCliDependencies['cycle'];
    } = {},
) => {
    let stdout = '';
    let stderr = '';
    const dependencies: CycleCliDependencies = {
        cycle: async () => ({ healed: false }),
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
        cycle: async (platform) => {
            expect(platform).toBe('minimax');
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
        cycle: async (platform, onSkip) => {
            expect(platform).toBe('kiro');
            onSkip?.();
            return { healed: true };
        },
    });

    expect(JSON.parse(result.stdout)).toEqual({ action: 'next', healed: true, ok: true, platform: 'kiro' });
    expect(result.stdout).not.toMatch(/label|accountKey|count|index|token/iu);
    expect(result.stderr).toBe('');
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
        const result = await run(args, { cycle: dependency });
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('Usage: dondo-donuts <antigravity|cline|codex|kiro|minimax> next [--json]\n');
    }
    expect(calls).toBe(0);
});

it('dispatches the same next contract for every supported platform', async () => {
    const calls: CyclePlatform[] = [];
    for (const platform of cyclePlatforms) {
        const result = await run([platform, 'next'], {
            cycle: async (calledPlatform) => {
                calls.push(calledPlatform);
                return { healed: false };
            },
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(
            `Switched to the next available ${platform === 'antigravity' ? 'Antigravity' : platform === 'cline' ? 'Cline' : platform === 'codex' ? 'Codex' : platform === 'kiro' ? 'Kiro' : 'MiniMax'} account.\n`,
        );
    }
    expect(calls).toEqual(cyclePlatforms);
});

it('does not expose account labels or unexpected error details', async () => {
    const secretLabel = 'private-account-label';
    const result = await run(['minimax', 'next'], {
        cycle: async (_platform, onSkip) => {
            onSkip?.();
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
        cycle: async () => {
            throw publicError(409, 'Quit Kiro completely before cycling accounts.');
        },
    });

    expect(result).toEqual({
        exitCode: 1,
        stderr: 'Quit Kiro completely before cycling accounts.\n',
        stdout: '',
    });
});

it('keeps machine-readable failures on stderr when JSON output is requested', async () => {
    const result = await run(['minimax', 'next', '--json'], {
        cycle: async (_platform, onSkip) => {
            onSkip?.();
            throw publicError(409, 'No saved MiniMax account could be loaded');
        },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
        action: 'next',
        code: 'ACCOUNT_SWITCH_FAILED',
        error: 'No saved MiniMax account could be loaded',
        ok: false,
        platform: 'minimax',
    });
});
