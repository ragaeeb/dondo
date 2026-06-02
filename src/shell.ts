import { errorMessage, redactSecrets } from './errors.ts';

export type RunError = Error & {
    code: number;
    stderr: string;
    stdout: string;
};

type RunOptions = {
    timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

const safeArgs = (args: string[]) => {
    return args.map((arg, index) => (args[index - 1] === '-w' ? '[redacted]' : arg));
};

export const isRunError = (error: unknown): error is RunError => {
    return error instanceof Error && 'code' in error && 'stderr' in error && 'stdout' in error;
};

export const run = async (cmd: string, args: string[], options: RunOptions = {}) => {
    const proc = Bun.spawn([cmd, ...args], { stderr: 'pipe', stdout: 'pipe' });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]).finally(() => clearTimeout(timer));

    if (code !== 0) {
        const message = timedOut
            ? `${cmd} ${safeArgs(args).join(' ')} timed out`
            : `${cmd} ${safeArgs(args).join(' ')} failed (${code}): ${errorMessage(stderr || stdout)}`;
        throw Object.assign(new Error(message), {
            code,
            stderr: redactSecrets(stderr),
            stdout: redactSecrets(stdout),
        });
    }

    return { stderr, stdout };
};
