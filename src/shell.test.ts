import { expect, it } from 'bun:test';
import { isRunError, run } from './shell.ts';

it('should redact sensitive subprocess stderr in failure messages', async () => {
    await expect(run('bun', ['-e', 'console.error(`password: "secret"`); process.exit(2)'])).rejects.toThrow(
        'password: "[redacted]"',
    );
});

it('should pass private input over stdin and redact it from subprocess errors', async () => {
    const secret = 'vault-key-material-not-shaped-like-a-token';
    const error = await run(
        'bun',
        ['-e', 'const input = await Bun.stdin.text(); console.error(input.split(/\\r?\\n/)[0]); process.exit(7)'],
        { stdin: `${secret}\n${secret}\n` },
    ).catch((value: unknown) => value);

    expect(isRunError(error)).toBe(true);
    expect(String(error)).not.toContain(secret);
    if (isRunError(error)) {
        expect(error.stderr).not.toContain(secret);
        expect(error.stdout).not.toContain(secret);
    }
});

it('should handle a subprocess closing stdin before input is written', async () => {
    await expect(run('bun', ['-e', 'process.exit(0)'], { stdin: 'input-that-may-race-with-exit' })).resolves.toEqual({
        stderr: '',
        stdout: '',
    });
});

it('should enforce its timeout even when a subprocess ignores SIGTERM', async () => {
    const startedAt = Date.now();

    await expect(
        run('bun', ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)'], { timeoutMs: 25 }),
    ).rejects.toThrow('timed out');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
});

it('should reject subprocess output that exceeds the capture limit', async () => {
    for (const stream of ['stdout', 'stderr'] as const) {
        await expect(run('bun', ['-e', `process.${stream}.write('x'.repeat(1024 * 1024 + 1))`])).rejects.toThrow(
            `Subprocess ${stream} exceeded the 1 MiB capture limit`,
        );
    }
});

it('should reject subprocess output that is not valid UTF-8', async () => {
    await expect(run('bun', ['-e', 'process.stdout.write(Buffer.from([255]))'])).rejects.toThrow(
        'Subprocess stdout was not valid UTF-8',
    );
});
