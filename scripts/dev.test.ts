import { expect, it } from 'bun:test';
import { isRuntimeSource, prepareDevEnvironment } from './dev.ts';

it('should restart development only for runtime source changes', () => {
    for (const path of ['server.ts', 'ui/client.tsx', 'ui/styles.css', 'storage/vault.ts']) {
        expect(isRuntimeSource(path)).toBe(true);
    }
    for (const path of ['server.test.ts', 'ui/client.test.tsx', 'notes.md', 'generated.js']) {
        expect(isRuntimeSource(path)).toBe(false);
    }
});

it('should create a fresh sandbox for mock development', async () => {
    const first = await prepareDevEnvironment('mock');
    const second = await prepareDevEnvironment('mock');
    try {
        expect(first.root).not.toBe(second.root);
        expect(first.env.DONDO_DEV_MODE).toBe('mock');
        expect(first.env.HOME).toStartWith(first.root);
        expect(first.env.DONDO_DATA_DIR).toStartWith(first.root);
        expect(first.env.DONDO_VAULT).toStartWith(first.root);
        expect(first.env.CODEX_AUTH_PATH).toStartWith(first.root);
        expect(first.env.CLINE_PROVIDERS_PATH).toStartWith(first.root);
        expect(first.env.KIRO_AUTH_PATH).toStartWith(first.root);
        expect(first.env.KIRO_PROFILE_PATH).toStartWith(first.root);
        expect(first.env.MINIMAX_CONFIG_PATH).toStartWith(first.root);
        expect(first.env.MINIMAX_LOCAL_STORAGE_PATH).toStartWith(first.root);
        expect(first.env.HOME).not.toBe(process.env.HOME);
    } finally {
        await first.cleanup();
        await second.cleanup();
    }
});
