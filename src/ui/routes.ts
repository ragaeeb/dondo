export type PlatformTab = 'antigravity' | 'cline' | 'codex' | 'kiro' | 'minimax';

const tabs = new Set<PlatformTab>(['antigravity', 'cline', 'codex', 'kiro', 'minimax']);

export const tabFromPath = (pathname: string): PlatformTab => {
    const candidate = pathname.replace(/^\/|\/$/g, '');
    return tabs.has(candidate as PlatformTab) ? (candidate as PlatformTab) : 'antigravity';
};

export const pathForTab = (tab: PlatformTab) => `/${tab}`;
