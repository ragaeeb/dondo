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
            fiveHourRemaining: after.entries[0]?.quota?.ok ? after.entries[0].quota.models['minimax-5-hour']?.percentage ?? null : null,
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
        fiveHourRemaining: number | null;
        vaultHasPlainToken: boolean;
    };
};

it('should save and load MiniMax configs with MiniMax Code quota limits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-minimax-test-'));
    const configPath = join(dir, 'minimax-agent-config.json');
    const vaultPath = join(dir, 'vault.json');
    const server = Bun.serve({
        fetch: (request) => {
            const pathname = new URL(request.url).pathname;
            if (pathname.endsWith('/v1/api/openplatform/coding_plan/remains')) {
                return Response.json({
                    model_remains: [
                        {
                            current_interval_remaining_percent: 48.4,
                            current_weekly_remaining_percent: 75,
                            end_time: 1_800_000_000,
                            interval_boost_permille: 500,
                            weekly_boost_permille: 1_000,
                            weekly_end_time: 1_800_400_000,
                        },
                    ],
                });
            }
            return new Response('Not found', { status: 404 });
        },
        port: 0,
    });
    try {
        await Bun.write(
            configPath,
            JSON.stringify({ tokens: { accessToken: 'dummy-token' }, user: { userID: 'saved-user' } }),
        );

        const result = await runMiniMaxScript({
            DONDO_VAULT: vaultPath,
            MINIMAX_CONFIG_PATH: configPath,
            MINIMAX_PLATFORM_URL: `http://127.0.0.1:${server.port}`,
        });

        expect(result.activeBeforeLoad).toBe(false);
        expect(result.activeAfterLoad).toBe(true);
        expect(result.loadedUserID).toBe('saved-user');
        expect(result.quotaOk).toBe(true);
        expect(result.limitUpdatedAt).toBeTruthy();
        expect(result.fiveHourRemaining).toBe(48);
        expect(result.vaultHasPlainToken).toBe(false);
    } finally {
        server.stop(true);
        await rm(dir, { force: true, recursive: true });
    }
});
