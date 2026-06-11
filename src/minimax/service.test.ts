import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runMiniMaxScript = async (env: Record<string, string>) => {
    const script = `
        const { loadMinimax, minimaxState, saveMinimax } = await import('./src/minimax/service.ts');
        const configPath = process.env.MINIMAX_CONFIG_PATH;
        const vaultPath = process.env.DONDO_VAULT;
        await saveMinimax('saved');
        await Bun.write(configPath, JSON.stringify({ user: { userID: 'other' }, tokens: { accessToken: 'dummy-other' } }));
        const before = await minimaxState();
        await loadMinimax('saved');
        const after = await minimaxState();
        const loadedConfig = JSON.parse(await Bun.file(configPath).text());
        const vaultText = await Bun.file(vaultPath).text();
        console.log(JSON.stringify({
            activeBeforeLoad: before.entries[0]?.active ?? null,
            activeAfterLoad: after.entries[0]?.active ?? null,
            loadedUserID: loadedConfig.user?.userID ?? '',
            quotaOk: after.entries[0]?.quota?.ok ?? null,
            limitUpdatedAt: after.entries[0]?.limitUpdatedAt ?? '',
            resetTime: after.entries[0]?.quota?.ok ? after.entries[0].quota.models['minimax-loaded-at']?.resetTime ?? '' : '',
            vaultHasPlainToken: vaultText.includes('dummy-token'),
        }));
    `;
    const proc = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stderr: 'pipe',
        stdout: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(stderr);
    }
    return JSON.parse(stdout) as {
        activeAfterLoad: boolean;
        activeBeforeLoad: boolean;
        limitUpdatedAt: string;
        loadedUserID: string;
        quotaOk: boolean;
        resetTime: string;
        vaultHasPlainToken: boolean;
    };
};

it('should save and load MiniMax configs with mocked load-time limits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-test-'));
    const configPath = join(dir, 'minimax-agent-config.json');
    const vaultPath = join(dir, 'vault.json');
    try {
        await Bun.write(
            configPath,
            JSON.stringify({ user: { userID: 'saved-user' }, tokens: { accessToken: 'dummy-token' } }),
        );

        const result = await runMiniMaxScript({
            DONDO_VAULT: vaultPath,
            MINIMAX_CONFIG_PATH: configPath,
        });

        expect(result.activeBeforeLoad).toBe(false);
        expect(result.activeAfterLoad).toBe(true);
        expect(result.loadedUserID).toBe('saved-user');
        expect(result.quotaOk).toBe(true);
        expect(result.limitUpdatedAt).toBeTruthy();
        expect(result.resetTime).toBe(result.limitUpdatedAt);
        expect(result.vaultHasPlainToken).toBe(false);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
