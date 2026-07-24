import { expect, it } from 'bun:test';
import { pathForTab, tabFromPath } from './routes.ts';

it('should map platform tabs to reloadable routes', () => {
    expect(tabFromPath('/')).toBe('antigravity');
    expect(tabFromPath('/antigravity')).toBe('antigravity');
    expect(tabFromPath('/codex')).toBe('codex');
    expect(tabFromPath('/kiro')).toBe('kiro');
    expect(tabFromPath('/minimax')).toBe('minimax');
    expect(tabFromPath('/unknown')).toBe('antigravity');

    expect(pathForTab('antigravity')).toBe('/antigravity');
    expect(pathForTab('codex')).toBe('/codex');
    expect(pathForTab('kiro')).toBe('/kiro');
    expect(pathForTab('minimax')).toBe('/minimax');
});

