import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import packageJson from '../../package.json';
import type { LimitResult, ModelLimit } from '../types.ts';

type AccountEntry = {
    active: boolean;
    key: string;
    updatedAt: string;
    limitUpdatedAt: string;
    quota: LimitResult | null;
};

type AntigravityState = {
    account: string;
    entries: AccountEntry[];
    service: string;
    vaultPath: string;
};

type CodexState = {
    authPath: string;
    entries: AccountEntry[];
    vaultPath: string;
};

type MinimaxState = {
    configPath: string;
    entries: AccountEntry[];
    vaultPath: string;
};

type Tab = 'antigravity' | 'codex' | 'minimax';

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, {
        body: body ? JSON.stringify(body) : undefined,
        headers: { 'Content-Type': 'application/json' },
        method: body ? 'POST' : 'GET',
    });
    const contentType = response.headers.get('content-type') ?? '';
    const json = contentType.includes('application/json') ? await response.json() : { error: await response.text() };
    if (!response.ok) {
        throw new Error(json.error ?? response.statusText);
    }
    return json as T;
};

const formatDate = (value: string) => (value ? new Date(value).toLocaleString() : '');
const confirmSyncCurrent = (platform: string, key: string) =>
    confirm(`Replace "${key}" with the currently active ${platform} credentials? This overwrites the saved account.`);

const ModelCard = ({ model }: { model: [string, ModelLimit] }) => {
    const [name, data] = model;
    const width = Math.max(0, Math.min(100, data.percentage));

    return (
        <div class="model">
            <div>
                <b>{data.displayName || name}</b>
            </div>
            <div class="muted small">{name}</div>
            <div class="bar">
                <div class="fill" style={{ width: `${width}%` }} />
            </div>
            <div class="small">
                {data.percentage}% left{data.resetTime ? ` · resets ${formatDate(data.resetTime)}` : ''}
            </div>
        </div>
    );
};

const AccountRow = ({
    entry,
    pending,
    onLoad,
    onRefresh,
    onSync,
}: {
    entry: AccountEntry;
    pending: boolean;
    onLoad: (key: string) => void;
    onRefresh: (key: string) => void;
    onSync: (key: string) => void;
}) => (
    <article class="row">
        <div class="row-head">
            <div>
                <div class="keyline">
                    <div class="key">{entry.key}</div>
                    {entry.active ? <span class="badge">Active</span> : null}
                </div>
                <div class="muted small">
                    Updated {formatDate(entry.updatedAt)}
                    {entry.limitUpdatedAt ? ` · limits ${formatDate(entry.limitUpdatedAt)}` : ''}
                    {entry.quota?.ok ? ` · ${entry.quota.tier}` : ''}
                </div>
            </div>
            <div class="actions">
                <button type="button" disabled={pending} onClick={() => onRefresh(entry.key)}>
                    Refresh
                </button>
                <button type="button" disabled={pending} onClick={() => onSync(entry.key)}>
                    Sync current
                </button>
                <button type="button" disabled={pending} onClick={() => onLoad(entry.key)}>
                    Load
                </button>
            </div>
        </div>
        {entry.quota?.ok ? (
            <div class="quota">
                {Object.entries(entry.quota.models).map((model) => (
                    <ModelCard key={model[0]} model={model} />
                ))}
            </div>
        ) : (
            <div class="err small">{entry.quota?.error ?? 'No cached limit data'}</div>
        )}
    </article>
);

const AntigravityPanel = ({ active }: { active: boolean }) => {
    const [state, setState] = useState<AntigravityState | null>(null);
    const [status, setStatus] = useState('');
    const [key, setKey] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [pendingKey, setPendingKey] = useState('');

    const refresh = async (forceLimits = false) => {
        setStatus(forceLimits ? 'Refreshing limits...' : 'Loading accounts...');
        setState(
            await api<AntigravityState>(
                forceLimits ? '/api/antigravity/limits/refresh' : '/api/antigravity/state',
                forceLimits ? {} : undefined,
            ),
        );
        setLoaded(true);
        setStatus('');
    };

    const save = async (event: Event) => {
        event.preventDefault();
        const trimmed = key.trim();
        if (!trimmed) {
            return;
        }
        setStatus('Saving...');
        try {
            await api('/api/antigravity/save', { key: trimmed });
            setKey('');
            await refresh(false);
            setStatus(`Saved ${trimmed}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
    };

    const load = async (entryKey: string) => {
        setStatus(`Loading ${entryKey}...`);
        setPendingKey(entryKey);
        try {
            await api('/api/antigravity/load', { key: entryKey });
            await refresh(false);
            setStatus(`Loaded ${entryKey}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingKey('');
        }
    };

    const refreshOne = async (entryKey: string) => {
        setStatus(`Refreshing ${entryKey}...`);
        setPendingKey(entryKey);
        try {
            setState(await api<AntigravityState>('/api/antigravity/limits/refresh', { key: entryKey }));
            setStatus(`Refreshed ${entryKey}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingKey('');
        }
    };

    const syncCurrent = async (entryKey: string) => {
        if (!confirmSyncCurrent('Antigravity', entryKey)) {
            return;
        }
        setStatus(`Syncing current Antigravity auth to ${entryKey}...`);
        setPendingKey(entryKey);
        try {
            await api('/api/antigravity/save', { key: entryKey });
            await refreshOne(entryKey);
            setStatus(`Synced ${entryKey}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingKey('');
        }
    };

    const clear = async () => {
        if (!confirm('Clear the live Antigravity keychain item and local auth state?')) {
            return;
        }
        setStatus('Clearing...');
        try {
            await api('/api/antigravity/clear', {});
            await refresh(false);
            setStatus('Cleared live Antigravity auth state');
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
    };

    useEffect(() => {
        if (!active || loaded) {
            return;
        }
        refresh(false).catch((error) => {
            setStatus(error.message);
        });
    }, [active, loaded]);

    return (
        <div hidden={!active}>
            <div class="toolbar">
                <div class="muted small">{state ? `${state.service}/${state.account} · ${state.vaultPath}` : ''}</div>
                <button type="button" onClick={() => refresh(true).catch((error) => setStatus(error.message))}>
                    Refresh limits
                </button>
            </div>
            <section class="panel">
                <form onSubmit={save}>
                    <input
                        value={key}
                        placeholder="Account label"
                        autocomplete="off"
                        onInput={(event) => setKey(event.currentTarget.value)}
                    />
                    <button class="primary" type="submit">
                        Save current
                    </button>
                    <button type="button" onClick={() => clear().catch((error) => setStatus(error.message))}>
                        Clear live
                    </button>
                </form>
                <div id="status" class="status muted">
                    {status}
                </div>
            </section>
            <section class="list">
                {state?.entries.length ? (
                    state.entries.map((entry) => (
                        <AccountRow
                            key={entry.key}
                            entry={entry}
                            pending={pendingKey === entry.key}
                            onLoad={load}
                            onRefresh={refreshOne}
                            onSync={syncCurrent}
                        />
                    ))
                ) : (
                    <div class="muted">No saved accounts yet.</div>
                )}
            </section>
        </div>
    );
};

const CodexPanel = ({ active }: { active: boolean }) => {
    const [state, setState] = useState<CodexState | null>(null);
    const [status, setStatus] = useState('');
    const [key, setKey] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [pendingKey, setPendingKey] = useState('');

    const refresh = async (forceLimits = false) => {
        setStatus(forceLimits ? 'Refreshing limits...' : 'Loading accounts...');
        setState(
            await api<CodexState>(
                forceLimits ? '/api/codex/limits/refresh' : '/api/codex/state',
                forceLimits ? {} : undefined,
            ),
        );
        setLoaded(true);
        setStatus('');
    };

    const save = async (event: Event) => {
        event.preventDefault();
        const trimmed = key.trim();
        if (!trimmed) {
            return;
        }
        setStatus('Saving...');
        try {
            await api('/api/codex/save', { key: trimmed });
            setKey('');
            await refresh(false);
            setStatus(`Saved ${trimmed}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
    };

    const load = async (entryKey: string) => {
        setStatus(`Loading ${entryKey}...`);
        setPendingKey(entryKey);
        try {
            await api('/api/codex/load', { key: entryKey });
            await refresh(false);
            setStatus(`Loaded ${entryKey}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingKey('');
        }
    };

    const refreshOne = async (entryKey: string) => {
        setStatus(`Refreshing ${entryKey}...`);
        setPendingKey(entryKey);
        try {
            setState(await api<CodexState>('/api/codex/limits/refresh', { key: entryKey }));
            setStatus(`Refreshed ${entryKey}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingKey('');
        }
    };

    const syncCurrent = async (entryKey: string) => {
        if (!confirmSyncCurrent('Codex', entryKey)) {
            return;
        }
        setStatus(`Syncing current Codex auth to ${entryKey}...`);
        setPendingKey(entryKey);
        try {
            await api('/api/codex/save', { key: entryKey });
            await refreshOne(entryKey);
            setStatus(`Synced ${entryKey}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingKey('');
        }
    };

    useEffect(() => {
        if (!active || loaded) {
            return;
        }
        refresh(false).catch((error) => {
            setStatus(error.message);
        });
    }, [active, loaded]);

    return (
        <div hidden={!active}>
            <div class="toolbar">
                <div class="muted small">{state ? `${state.authPath} · ${state.vaultPath}` : ''}</div>
                <button type="button" onClick={() => refresh(true).catch((error) => setStatus(error.message))}>
                    Refresh limits
                </button>
            </div>
            <section class="panel">
                <form onSubmit={save}>
                    <input
                        value={key}
                        placeholder="Account label"
                        autocomplete="off"
                        onInput={(event) => setKey(event.currentTarget.value)}
                    />
                    <button class="primary" type="submit">
                        Save current
                    </button>
                </form>
                <div class="status muted">{status}</div>
            </section>
            <section class="list">
                {state?.entries.length ? (
                    state.entries.map((entry) => (
                        <AccountRow
                            key={entry.key}
                            entry={entry}
                            pending={pendingKey === entry.key}
                            onLoad={load}
                            onRefresh={refreshOne}
                            onSync={syncCurrent}
                        />
                    ))
                ) : (
                    <div class="muted">No saved accounts yet.</div>
                )}
            </section>
        </div>
    );
};

const MinimaxPanel = ({ active }: { active: boolean }) => {
    const [state, setState] = useState<MinimaxState | null>(null);
    const [status, setStatus] = useState('');
    const [key, setKey] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [pendingKey, setPendingKey] = useState('');

    const refresh = async (forceLimits = false) => {
        setStatus(forceLimits ? 'Refreshing limits...' : 'Loading accounts...');
        setState(
            await api<MinimaxState>(
                forceLimits ? '/api/minimax/limits/refresh' : '/api/minimax/state',
                forceLimits ? {} : undefined,
            ),
        );
        setLoaded(true);
        setStatus('');
    };

    const save = async (event: Event) => {
        event.preventDefault();
        const trimmed = key.trim();
        if (!trimmed) {
            return;
        }
        setStatus('Saving...');
        try {
            await api('/api/minimax/save', { key: trimmed });
            setKey('');
            await refresh(false);
            setStatus(`Saved ${trimmed}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
    };

    const load = async (entryKey: string) => {
        setStatus(`Loading ${entryKey}...`);
        setPendingKey(entryKey);
        try {
            await api('/api/minimax/load', { key: entryKey });
            await refresh(false);
            setStatus(`Loaded ${entryKey}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingKey('');
        }
    };

    const refreshOne = async (entryKey: string) => {
        setStatus(`Refreshing ${entryKey}...`);
        setPendingKey(entryKey);
        try {
            setState(await api<MinimaxState>('/api/minimax/limits/refresh', { key: entryKey }));
            setStatus(`Refreshed ${entryKey}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingKey('');
        }
    };

    const syncCurrent = async (entryKey: string) => {
        if (!confirmSyncCurrent('MiniMax', entryKey)) {
            return;
        }
        setStatus(`Syncing current MiniMax config to ${entryKey}...`);
        setPendingKey(entryKey);
        try {
            await api('/api/minimax/save', { key: entryKey });
            await refreshOne(entryKey);
            setStatus(`Synced ${entryKey}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingKey('');
        }
    };

    useEffect(() => {
        if (!active || loaded) {
            return;
        }
        refresh(false).catch((error) => {
            setStatus(error.message);
        });
    }, [active, loaded]);

    return (
        <div hidden={!active}>
            <div class="toolbar">
                <div class="muted small">{state ? `${state.configPath} · ${state.vaultPath}` : ''}</div>
                <button type="button" onClick={() => refresh(true).catch((error) => setStatus(error.message))}>
                    Refresh limits
                </button>
            </div>
            <section class="panel">
                <form onSubmit={save}>
                    <input
                        value={key}
                        placeholder="Account label"
                        autocomplete="off"
                        onInput={(event) => setKey(event.currentTarget.value)}
                    />
                    <button class="primary" type="submit">
                        Save current
                    </button>
                </form>
                <div class="status muted">{status}</div>
            </section>
            <section class="list">
                {state?.entries.length ? (
                    state.entries.map((entry) => (
                        <AccountRow
                            key={entry.key}
                            entry={entry}
                            pending={pendingKey === entry.key}
                            onLoad={load}
                            onRefresh={refreshOne}
                            onSync={syncCurrent}
                        />
                    ))
                ) : (
                    <div class="muted">No saved accounts yet.</div>
                )}
            </section>
        </div>
    );
};

const App = () => {
    const [tab, setTab] = useState<Tab>('antigravity');

    return (
        <main>
            <div class="top">
                <div class="brand">
                    <img src="/icon.svg" alt="" />
                    <h1>Dondo</h1>
                </div>
            </div>
            <nav class="tabs" aria-label="Platforms">
                <button
                    type="button"
                    class={tab === 'antigravity' ? 'tab active' : 'tab'}
                    onClick={() => setTab('antigravity')}
                >
                    Antigravity
                </button>
                <button type="button" class={tab === 'codex' ? 'tab active' : 'tab'} onClick={() => setTab('codex')}>
                    Codex
                </button>
                <button
                    type="button"
                    class={tab === 'minimax' ? 'tab active' : 'tab'}
                    onClick={() => setTab('minimax')}
                >
                    MiniMax
                </button>
            </nav>
            <AntigravityPanel active={tab === 'antigravity'} />
            <CodexPanel active={tab === 'codex'} />
            <MinimaxPanel active={tab === 'minimax'} />
            <footer class="footer">
                <a href={packageJson.homepage} target="_blank" rel="noreferrer">
                    GitHub
                </a>
            </footer>
        </main>
    );
};

const root = document.getElementById('app');
if (root) {
    render(<App />, root);
}
