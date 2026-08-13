import { redactSecrets } from './errors.ts';

export type RunError = Error & {
    code: number;
    stderr: string;
    stdout: string;
};

export type RunOptions = {
    stdin?: string;
    timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;

const captureOutput = async (stream: ReadableStream<Uint8Array>, label: string, terminate: () => void) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) {
                try {
                    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
                } catch {
                    throw new Error(`${label} was not valid UTF-8`);
                }
            }
            total += next.value.byteLength;
            if (total > MAX_CAPTURE_BYTES) {
                terminate();
                await reader.cancel().catch(() => undefined);
                throw new Error(`${label} exceeded the 1 MiB capture limit`);
            }
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
};

const safeArgs = (args: string[]) => {
    return args.map((arg, index) => (args[index - 1] === '-w' ? '[redacted]' : arg));
};

const redactPrivateInput = (value: unknown, stdin?: string) => {
    let redacted = redactSecrets(value);
    const privateValues = new Set([stdin, stdin?.trim(), ...(stdin?.split(/\r?\n/) ?? [])]);
    for (const secret of privateValues) {
        if (secret) {
            redacted = redacted.replaceAll(secret, '[redacted]');
        }
    }
    return redacted;
};

export const isRunError = (error: unknown): error is RunError => {
    return error instanceof Error && 'code' in error && 'stderr' in error && 'stdout' in error;
};

export const run = async (cmd: string, args: string[], options: RunOptions = {}) => {
    const proc = Bun.spawn([cmd, ...args], {
        stderr: 'pipe',
        stdin: options.stdin === undefined ? 'ignore' : 'pipe',
        stdout: 'pipe',
    });
    if (options.stdin !== undefined && proc.stdin) {
        proc.stdin.write(options.stdin);
        proc.stdin.end();
    }
    const terminate = () => {
        proc.kill('SIGKILL');
    };
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        terminate();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const [stdout, stderr, code] = await Promise.all([
        captureOutput(proc.stdout, 'Subprocess stdout', terminate),
        captureOutput(proc.stderr, 'Subprocess stderr', terminate),
        proc.exited,
    ]).finally(() => clearTimeout(timer));

    if (code !== 0) {
        const message = timedOut
            ? `${cmd} ${safeArgs(args).join(' ')} timed out`
            : `${cmd} ${safeArgs(args).join(' ')} failed (${code}): ${redactPrivateInput(stderr || stdout, options.stdin)}`;
        throw Object.assign(new Error(message), {
            code,
            stderr: redactPrivateInput(stderr, options.stdin),
            stdout: redactPrivateInput(stdout, options.stdin),
        });
    }

    return { stderr, stdout };
};
