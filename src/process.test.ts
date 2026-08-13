import { expect, it } from 'bun:test';
import { isProcessRunning } from './process.ts';

it('terminates pgrep options before a configured process name', async () => {
    const originalSpawn = Bun.spawn;
    let command: string[] = [];
    try {
        for (const [exitCode, expected] of [
            [0, true],
            [1, false],
        ] as const) {
            Bun.spawn = ((args: string[]) => {
                command = args;
                return { exited: Promise.resolve(exitCode) };
            }) as unknown as typeof Bun.spawn;
            expect(await isProcessRunning('-hostile-name')).toBe(expected);
            expect(command).toEqual(['/usr/bin/pgrep', '-x', '--', '-hostile-name']);
        }
    } finally {
        Bun.spawn = originalSpawn;
    }
});

it('escapes configured process names as literal pgrep patterns', async () => {
    const originalSpawn = Bun.spawn;
    let command: string[] = [];
    Bun.spawn = ((args: string[]) => {
        command = args;
        return { exited: Promise.resolve(1) };
    }) as unknown as typeof Bun.spawn;
    try {
        expect(await isProcessRunning('Kiro.*[test]')).toBe(false);
        expect(command).toEqual(['/usr/bin/pgrep', '-x', '--', 'Kiro\\.\\*\\[test\\]']);
    } finally {
        Bun.spawn = originalSpawn;
    }
});

it('fails closed when pgrep cannot evaluate the process state', async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = (() => ({ exited: Promise.resolve(2) })) as unknown as typeof Bun.spawn;
    try {
        const error = await isProcessRunning('Kiro').catch((value: unknown) => value);
        expect((error as { status?: number }).status).toBe(500);
        expect(String(error)).toContain('could not verify whether the configured application process is running');
    } finally {
        Bun.spawn = originalSpawn;
    }
});
