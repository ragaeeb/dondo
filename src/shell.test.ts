import { expect, it } from 'bun:test';
import { run } from './shell.ts';

it('should redact sensitive subprocess stderr in failure messages', async () => {
    await expect(run('bun', ['-e', 'console.error(`password: "secret"`); process.exit(2)'])).rejects.toThrow(
        'password: "[redacted]"',
    );
});
