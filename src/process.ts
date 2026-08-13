import { publicError } from './errors.ts';

export const isProcessRunning = async (name: string) => {
    const literalPattern = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const proc = Bun.spawn(['/usr/bin/pgrep', '-x', '--', literalPattern], {
        stderr: 'ignore',
        stdout: 'ignore',
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
        return true;
    }
    if (exitCode === 1) {
        return false;
    }
    throw publicError(500, 'Dondo could not verify whether the configured application process is running');
};
