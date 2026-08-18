import { expect, it } from 'bun:test';

it('should ignore the removed ANTIGRAVITY_VAULT compatibility variable', async () => {
    const script = `
        delete process.env.DONDO_VAULT;
        process.env.ANTIGRAVITY_VAULT = '/tmp/legacy-antigravity-vault.json';
        const { VAULT_PATH } = await import('./src/config.ts');
        console.log(JSON.stringify({ vaultPath: VAULT_PATH }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        stderr: 'pipe',
        stdout: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(stderr);
    }
    expect(JSON.parse(stdout).vaultPath).not.toBe('/tmp/legacy-antigravity-vault.json');
});

it('uses the Antigravity macOS process name by default', async () => {
    const script = `
        delete process.env.ANTIGRAVITY_PROCESS_NAME;
        const { ANTIGRAVITY_PROCESS_NAME } = await import('./src/config.ts');
        console.log(JSON.stringify({ processName: ANTIGRAVITY_PROCESS_NAME }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        stderr: 'pipe',
        stdout: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(stderr);
    }
    expect(JSON.parse(stdout)).toEqual({ processName: 'Antigravity' });
});

it('does not expose destructive Antigravity application-state paths', async () => {
    const config = (await import('./config.ts')) as Record<string, unknown>;

    expect('ANTIGRAVITY_LOCAL_STATE_PATHS' in config).toBe(false);
});
