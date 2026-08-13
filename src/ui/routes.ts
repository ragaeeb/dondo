export const platformTabs = [
    { id: 'antigravity', label: 'Antigravity' },
    { id: 'codex', label: 'Codex' },
    { id: 'cline', label: 'Cline' },
    { id: 'kiro', label: 'Kiro' },
    { id: 'minimax', label: 'MiniMax' },
] as const;

export type PlatformTab = (typeof platformTabs)[number]['id'];

const tabs = new Set<string>(platformTabs.map((tab) => tab.id));

export const tabFromPath = (pathname: string): PlatformTab => {
    const candidate = pathname.replace(/^\/|\/$/g, '');
    return tabs.has(candidate) ? (candidate as PlatformTab) : 'antigravity';
};

export const pathForTab = (tab: PlatformTab) => `/${tab}`;
