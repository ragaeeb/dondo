import { expect, it } from 'bun:test';

it('should keep client markup free of CSP-blocked inline styles', async () => {
    const source = await Bun.file(new URL('./client.tsx', import.meta.url)).text();

    expect(source).toContain('<progress');
    expect(source).not.toMatch(/\sstyle\s*=/u);
});
