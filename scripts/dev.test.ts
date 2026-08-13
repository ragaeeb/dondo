import { expect, it } from 'bun:test';
import { isRuntimeSource } from './dev.ts';

it('should restart development only for runtime source changes', () => {
    for (const path of ['server.ts', 'ui/client.tsx', 'ui/styles.css', 'storage/vault.ts']) {
        expect(isRuntimeSource(path)).toBe(true);
    }
    for (const path of ['server.test.ts', 'ui/client.test.tsx', 'notes.md', 'generated.js']) {
        expect(isRuntimeSource(path)).toBe(false);
    }
});
