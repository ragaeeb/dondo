import { type ComponentChildren, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import packageJson from '../../package.json';
import type { LimitResult, ModelLimit } from '../types.ts';
import { chooseExportDestination, downloadPlatformExport } from './export.ts';
import { runWithOperationLock } from './operation.ts';
import { responseErrorMessage } from './response.ts';
import { type PlatformTab, pathForTab, platformTabs, tabFromPath } from './routes.ts';

type AccountEntry = {
    active: boolean;
    corrupted?: boolean;
    error?: string;
    key: string;
    limitUpdatedAt: string;
    quota: LimitResult | null;
    updatedAt: string;
};

type AccountState = {
    entries: AccountEntry[];
    vaultPath: string;
    account?: string;
    authPath?: string;
    configPath?: string;
    providersPath?: string;
    service?: string;
};

type MinimaxCheckInResult = {
    alreadyClaimed: boolean;
    claimed: boolean;
    dayNo: number;
    points: number;
    status: 'claimed' | 'claimable' | 'disabled' | 'upcoming';
};

type MinimaxCheckInAllResult = {
    alreadyClaimed: number;
    attempted: number;
    claimed: number;
    failed: number;
    unavailable: number;
};

type LoadResult = {
    checkIn?: MinimaxCheckInResult;
    ok: boolean;
};

type OperationKind =
    | 'check-in-all'
    | 'clear'
    | 'delete'
    | 'export'
    | 'initial-load'
    | 'load'
    | 'refresh-all'
    | 'refresh-one'
    | 'save'
    | 'sync';

type Operation = {
    key?: string;
    kind: OperationKind;
};

type Status = {
    error: boolean;
    message: string;
};

type ClearAction = {
    confirmation: string;
    placement: 'form' | 'toolbar';
    successStatus: string;
};

type ToolbarAction = {
    kind: 'check-in-all';
    label: string;
    pendingLabel: string;
    pendingStatus: string;
    refreshLimitsAfter?: boolean;
    run: () => Promise<string>;
};

type PanelConfig<State extends AccountState> = {
    clear?: ClearAction;
    describeState: (state: State) => string;
    displayName: string;
    instructions?: ComponentChildren;
    limits?: boolean;
    loadSuccess?: (key: string, result: LoadResult) => string;
    platform: PlatformTab;
    syncResource?: 'auth' | 'config';
    toolbarActions?: ToolbarAction[];
};

type PanelViewProps<State extends AccountState> = {
    busy: boolean;
    config: PanelConfig<State>;
    keyValue: string;
    onClear: () => void;
    onDelete: (key: string) => void;
    onExport: () => void;
    onKeyInput: (value: string) => void;
    onLoad: (key: string) => void;
    onRefreshAll: () => void;
    onRefreshOne: (key: string) => void;
    onSave: (event: Event) => void;
    onSync: (key: string) => void;
    onToolbarAction: (action: ToolbarAction) => void;
    operation: Operation | null;
    state: State | null;
    status: Status;
};

const CORRUPTED_ENTRY_MESSAGE = 'Saved account data is corrupted. Delete it and save it again.';
const UNKNOWN_ERROR_MESSAGE = 'Something went wrong. Please try again.';

const errorMessage = (error: unknown) => {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
        return error;
    }
    return UNKNOWN_ERROR_MESSAGE;
};

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
    const hasBody = body !== undefined;
    const response = await fetch(path, {
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        headers: { 'Content-Type': 'application/json' },
        method: hasBody ? 'POST' : 'GET',
    });
    const contentType = response.headers.get('content-type') ?? '';
    let payload: unknown;

    if (contentType.includes('application/json')) {
        try {
            payload = await response.json();
        } catch {
            throw new Error(response.ok ? 'Server returned invalid JSON' : responseErrorMessage(null, response));
        }
    }

    if (!response.ok) {
        throw new Error(responseErrorMessage(payload, response));
    }
    if (payload === undefined) {
        throw new Error('Server returned an unexpected response');
    }
    return payload as T;
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
            {!data.detail ? (
                <progress
                    class="bar"
                    max={100}
                    value={width}
                    aria-label={`${data.displayName || name} quota remaining`}
                    aria-valuetext={`${data.percentage}% left`}
                >
                    {data.percentage}% left
                </progress>
            ) : null}
            <div class="small">
                {data.used !== undefined && data.limit !== undefined ? `${data.used} / ${data.limit} used · ` : ''}
                {data.detail ?? `${data.percentage}% left`}
                {data.resetTime ? ` · resets ${formatDate(data.resetTime)}` : ''}
            </div>
        </div>
    );
};

type AccountRowProps = {
    busy: boolean;
    entry: AccountEntry;
    onDelete: (key: string) => void;
    onLoad: (key: string) => void;
    onRefresh?: (key: string) => void;
    onSync?: (key: string) => void;
    operation: Operation | null;
    showLimits: boolean;
};

type AccountActionProps = {
    disabled: boolean;
    entry: AccountEntry;
    kind: 'load' | 'refresh-one' | 'sync';
    label: string;
    onAction: (key: string) => void;
    operation: Operation | null;
    pendingLabel: string;
};

const AccountAction = ({ disabled, entry, kind, label, onAction, operation, pendingLabel }: AccountActionProps) => {
    const pending = operation?.kind === kind && operation.key === entry.key;
    return (
        <button
            type="button"
            aria-busy={pending || undefined}
            disabled={disabled}
            title={entry.corrupted ? CORRUPTED_ENTRY_MESSAGE : undefined}
            onClick={() => onAction(entry.key)}
        >
            {pending ? pendingLabel : label}
        </button>
    );
};

const AccountActions = ({
    busy,
    entry,
    onDelete,
    onLoad,
    onRefresh,
    onSync,
    operation,
}: Omit<AccountRowProps, 'showLimits'>) => {
    const deleting = operation?.kind === 'delete' && operation.key === entry.key;
    const unavailable = busy || entry.corrupted === true;

    return (
        <div class="actions">
            <button
                class="danger"
                type="button"
                aria-busy={deleting || undefined}
                disabled={busy}
                onClick={() => onDelete(entry.key)}
            >
                {deleting ? 'Deleting…' : 'Delete'}
            </button>
            {onRefresh ? (
                <AccountAction
                    disabled={unavailable}
                    entry={entry}
                    kind="refresh-one"
                    label="Refresh"
                    operation={operation}
                    pendingLabel="Refreshing…"
                    onAction={onRefresh}
                />
            ) : null}
            {onSync ? (
                <AccountAction
                    disabled={unavailable}
                    entry={entry}
                    kind="sync"
                    label="Sync current"
                    operation={operation}
                    pendingLabel="Syncing…"
                    onAction={onSync}
                />
            ) : null}
            <AccountAction
                disabled={unavailable}
                entry={entry}
                kind="load"
                label="Load"
                operation={operation}
                pendingLabel="Loading…"
                onAction={onLoad}
            />
        </div>
    );
};

const AccountQuota = ({ entry, showLimits }: Pick<AccountRowProps, 'entry' | 'showLimits'>) => {
    if (entry.corrupted) {
        return <div class="corrupt-note err small">{CORRUPTED_ENTRY_MESSAGE}</div>;
    }
    if (!showLimits) {
        return null;
    }
    if (!entry.quota?.ok) {
        return <div class="err small">{entry.quota?.error ?? 'No cached limit data'}</div>;
    }
    return (
        <div class="quota">
            {Object.entries(entry.quota.models).map((model) => (
                <ModelCard key={model[0]} model={model} />
            ))}
        </div>
    );
};

const AccountRow = ({ busy, entry, operation, showLimits, ...actions }: AccountRowProps) => {
    const rowBusy = operation?.key === entry.key;

    return (
        <article class={entry.corrupted ? 'corrupted row' : 'row'} aria-busy={rowBusy || undefined}>
            <div class="row-head">
                <div>
                    <div class="keyline">
                        <div class="key">{entry.key}</div>
                        {entry.active ? <span class="badge">Active</span> : null}
                        {entry.corrupted ? <span class="badge badge-error">Corrupted</span> : null}
                    </div>
                    {entry.updatedAt ? (
                        <div class="muted small">
                            Updated {formatDate(entry.updatedAt)}
                            {entry.limitUpdatedAt ? ` · limits ${formatDate(entry.limitUpdatedAt)}` : ''}
                            {entry.quota?.ok ? ` · ${entry.quota.tier}` : ''}
                        </div>
                    ) : null}
                </div>
                <AccountActions busy={busy} entry={entry} operation={operation} {...actions} />
            </div>
            <AccountQuota entry={entry} showLimits={showLimits} />
        </article>
    );
};

const PanelToolbar = <State extends AccountState>({
    busy,
    config,
    onClear,
    onExport,
    onRefreshAll,
    onToolbarAction,
    operation,
    state,
}: Pick<
    PanelViewProps<State>,
    'busy' | 'config' | 'onClear' | 'onExport' | 'onRefreshAll' | 'onToolbarAction' | 'operation' | 'state'
>) => (
    <div class="toolbar">
        <div class="muted small">{state ? config.describeState(state) : ''}</div>
        <div class="toolbar-actions">
            {config.clear?.placement === 'toolbar' ? (
                <button
                    type="button"
                    aria-busy={operation?.kind === 'clear' || undefined}
                    disabled={busy}
                    onClick={onClear}
                >
                    {operation?.kind === 'clear' ? 'Clearing…' : 'Clear live'}
                </button>
            ) : null}
            <button
                type="button"
                aria-busy={operation?.kind === 'export' || undefined}
                disabled={busy || !state?.entries.length}
                onClick={onExport}
            >
                {operation?.kind === 'export' ? 'Exporting…' : 'Export'}
            </button>
            {config.limits ? (
                <button
                    type="button"
                    aria-busy={operation?.kind === 'refresh-all' || undefined}
                    disabled={busy}
                    onClick={onRefreshAll}
                >
                    {operation?.kind === 'refresh-all' ? 'Refreshing…' : 'Refresh limits'}
                </button>
            ) : null}
            {config.toolbarActions?.map((action) => (
                <button
                    type="button"
                    key={action.kind}
                    aria-busy={operation?.kind === action.kind || undefined}
                    disabled={busy}
                    onClick={() => onToolbarAction(action)}
                >
                    {operation?.kind === action.kind ? action.pendingLabel : action.label}
                </button>
            ))}
        </div>
    </div>
);

const PanelForm = <State extends AccountState>({
    busy,
    config,
    keyValue,
    onClear,
    onKeyInput,
    onSave,
    operation,
    status,
}: Pick<
    PanelViewProps<State>,
    'busy' | 'config' | 'keyValue' | 'onClear' | 'onKeyInput' | 'onSave' | 'operation' | 'status'
>) => (
    <section class="panel">
        {config.instructions ? <div class="instructions muted small">{config.instructions}</div> : null}
        <form onSubmit={onSave}>
            <label class="sr-only" for={`${config.platform}-account-label`}>
                {config.displayName} account label
            </label>
            <input
                id={`${config.platform}-account-label`}
                value={keyValue}
                placeholder="Account label"
                autocomplete="off"
                disabled={busy}
                maxLength={80}
                required
                onInput={(event) => onKeyInput(event.currentTarget.value)}
            />
            <button
                class="primary"
                type="submit"
                aria-busy={operation?.kind === 'save' || undefined}
                disabled={busy || !keyValue.trim()}
            >
                {operation?.kind === 'save' ? 'Saving…' : 'Save current'}
            </button>
            {config.clear?.placement === 'form' ? (
                <button
                    type="button"
                    aria-busy={operation?.kind === 'clear' || undefined}
                    disabled={busy}
                    onClick={onClear}
                >
                    {operation?.kind === 'clear' ? 'Clearing…' : 'Clear live'}
                </button>
            ) : null}
        </form>
        <div
            class={status.error ? 'err status' : 'muted status'}
            role={status.error ? 'alert' : 'status'}
            aria-atomic="true"
            aria-live={status.error ? 'assertive' : 'polite'}
        >
            {status.message}
        </div>
    </section>
);

const AccountList = <State extends AccountState>({
    busy,
    config,
    onDelete,
    onLoad,
    onRefreshOne,
    onSync,
    operation,
    state,
}: Pick<
    PanelViewProps<State>,
    'busy' | 'config' | 'onDelete' | 'onLoad' | 'onRefreshOne' | 'onSync' | 'operation' | 'state'
>) => (
    <section class="list" aria-label={`Saved ${config.displayName} accounts`}>
        {state?.entries.length ? (
            state.entries.map((entry) => (
                <AccountRow
                    key={entry.key}
                    busy={busy}
                    entry={entry}
                    operation={operation}
                    showLimits={config.limits ?? false}
                    onDelete={onDelete}
                    onLoad={onLoad}
                    {...(config.limits ? { onRefresh: onRefreshOne } : {})}
                    {...(config.syncResource ? { onSync } : {})}
                />
            ))
        ) : (
            <div class="muted">No saved accounts yet.</div>
        )}
    </section>
);

const PanelView = <State extends AccountState>({ active, ...props }: PanelViewProps<State> & { active: boolean }) => (
    <div hidden={!active} aria-busy={props.busy || undefined}>
        <PanelToolbar {...props} />
        <PanelForm {...props} />
        <AccountList {...props} />
    </div>
);

const PlatformAccountPanel = <State extends AccountState>({
    active,
    config,
}: {
    active: boolean;
    config: PanelConfig<State>;
}) => {
    const [state, setState] = useState<State | null>(null);
    const [status, setStatus] = useState<Status>({ error: false, message: '' });
    const [key, setKey] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [operation, setOperation] = useState<Operation | null>(null);
    const operationLock = useRef(false);
    const busy = operation !== null;

    const setMessage = (message: string, error = false) => setStatus({ error, message });

    const fetchState = async (mode: 'limits' | 'state', entryKey?: string) => {
        const nextState = await api<State>(
            mode === 'limits' ? `/api/${config.platform}/limits/refresh` : `/api/${config.platform}/state`,
            mode === 'limits' ? (entryKey ? { key: entryKey } : {}) : undefined,
        );
        setState(nextState);
        setLoaded(true);
        return nextState;
    };

    const runOperation = async (
        nextOperation: Operation,
        pendingStatus: string,
        task: () => Promise<string | undefined>,
    ): Promise<boolean> => {
        const started = runWithOperationLock(operationLock, async () => {
            setOperation(nextOperation);
            setMessage(pendingStatus);
            try {
                setMessage((await task()) ?? '');
            } catch (error) {
                setMessage(errorMessage(error), true);
            } finally {
                setOperation(null);
            }
        });
        if (!started) {
            return false;
        }
        await started;
        return true;
    };

    const save = (event: Event) => {
        event.preventDefault();
        const trimmed = key.trim();
        if (!trimmed) {
            return;
        }
        void runOperation({ kind: 'save' }, 'Saving...', async () => {
            await api(`/api/${config.platform}/save`, { key: trimmed });
            setKey('');
            await fetchState('state');
            return `Saved ${trimmed}`;
        });
    };

    const load = (entryKey: string) => {
        void runOperation({ key: entryKey, kind: 'load' }, `Loading ${entryKey}...`, async () => {
            const result = await api<LoadResult>(`/api/${config.platform}/load`, { key: entryKey });
            await fetchState('state');
            return config.loadSuccess?.(entryKey, result) ?? `Loaded ${entryKey}`;
        });
    };

    const remove = (entryKey: string) => {
        if (
            !confirm(
                `Delete the saved ${config.displayName} account "${entryKey}"? This does not sign out the live account.`,
            )
        ) {
            return;
        }
        void runOperation({ key: entryKey, kind: 'delete' }, `Deleting ${entryKey}...`, async () => {
            await api(`/api/${config.platform}/delete`, { key: entryKey });
            await fetchState('state');
            return `Deleted ${entryKey}`;
        });
    };

    const refreshOne = (entryKey: string) => {
        void runOperation({ key: entryKey, kind: 'refresh-one' }, `Refreshing ${entryKey}...`, async () => {
            await fetchState('limits', entryKey);
            return `Refreshed ${entryKey}`;
        });
    };

    const syncCurrent = (entryKey: string) => {
        if (!confirmSyncCurrent(config.displayName, entryKey)) {
            return;
        }
        void runOperation(
            { key: entryKey, kind: 'sync' },
            `Syncing current ${config.displayName} ${config.syncResource} to ${entryKey}...`,
            async () => {
                await api(`/api/${config.platform}/save`, { key: entryKey });
                await fetchState(config.limits ? 'limits' : 'state', config.limits ? entryKey : undefined);
                return `Synced ${entryKey}`;
            },
        );
    };

    const refreshAll = () => {
        void runOperation({ kind: 'refresh-all' }, 'Refreshing limits...', async () => {
            await fetchState('limits');
            return 'Refreshed limits';
        });
    };

    const exportWallet = () => {
        if (
            !confirm(
                `This downloads an unencrypted JSON file containing all saved ${config.displayName} credentials. Keep it private. Continue?`,
            )
        ) {
            return;
        }
        void runOperation({ kind: 'export' }, `Exporting ${config.displayName} wallet...`, async () => {
            const destination = await chooseExportDestination(config.platform);
            if (!destination) {
                return '';
            }
            await downloadPlatformExport(config.platform, destination);
            return `Exported ${config.displayName} wallet`;
        });
    };

    const clearLive = () => {
        if (!config.clear || !confirm(config.clear.confirmation)) {
            return;
        }
        void runOperation({ kind: 'clear' }, 'Clearing...', async () => {
            await api(`/api/${config.platform}/clear`, {});
            await fetchState('state');
            return config.clear?.successStatus;
        });
    };

    const runToolbarAction = (action: ToolbarAction) => {
        void runOperation({ kind: action.kind }, action.pendingStatus, async () => {
            const message = await action.run();
            if (action.refreshLimitsAfter) {
                await fetchState('limits').catch(() => undefined);
            }
            return message;
        });
    };

    useEffect(() => {
        if (!active || loaded) {
            return;
        }
        let cancelled = false;
        const attempt = () => {
            if (cancelled) {
                return;
            }
            void runOperation({ kind: 'initial-load' }, 'Loading accounts...', async () => {
                await fetchState('state');
                return '';
            }).then((started) => {
                if (!started && !cancelled) {
                    window.setTimeout(attempt, 50);
                }
            });
        };
        attempt();
        return () => {
            cancelled = true;
        };
    }, [active, loaded]);

    return (
        <PanelView
            active={active}
            busy={busy}
            config={config}
            keyValue={key}
            operation={operation}
            state={state}
            status={status}
            onClear={clearLive}
            onDelete={remove}
            onExport={exportWallet}
            onKeyInput={setKey}
            onLoad={load}
            onRefreshAll={refreshAll}
            onRefreshOne={refreshOne}
            onSave={save}
            onSync={syncCurrent}
            onToolbarAction={runToolbarAction}
        />
    );
};

const ANTIGRAVITY_CONFIG: PanelConfig<AccountState> = {
    clear: {
        confirmation: 'Clear the live Antigravity keychain item and local auth state?',
        placement: 'form',
        successStatus: 'Cleared live Antigravity auth state',
    },
    describeState: (state) => `${state.service ?? ''}/${state.account ?? ''} · ${state.vaultPath}`,
    displayName: 'Antigravity',
    limits: true,
    platform: 'antigravity',
    syncResource: 'auth',
};

const CODEX_CONFIG: PanelConfig<AccountState> = {
    describeState: (state) => `${state.authPath ?? ''} · ${state.vaultPath}`,
    displayName: 'Codex',
    limits: true,
    platform: 'codex',
    syncResource: 'auth',
};

const CLINE_CONFIG: PanelConfig<AccountState> = {
    describeState: (state) => `${state.providersPath ?? ''} · ${state.vaultPath}`,
    displayName: 'Cline',
    platform: 'cline',
    syncResource: 'auth',
};

const KIRO_CONFIG: PanelConfig<AccountState> = {
    clear: {
        confirmation:
            'Is Kiro fully quit, and did you save the current account? Dondo will remove its local login files without remotely signing out.',
        placement: 'toolbar',
        successStatus: 'Cleared live Kiro auth. Reopen Kiro to sign in.',
    },
    describeState: (state) => `${state.authPath ?? ''} · ${state.vaultPath}`,
    displayName: 'Kiro',
    instructions:
        'While signed in, save the current account. Then fully quit Kiro and use Clear live. Reopen Kiro, sign into the next account, and save it. To switch later, quit Kiro, load an account here, then reopen Kiro.',
    limits: true,
    loadSuccess: (key) => `Loaded ${key}. Reopen Kiro to use it.`,
    platform: 'kiro',
};

export const minimaxCheckInMessage = (result: MinimaxCheckInResult) => {
    if (result.claimed) {
        return `checked in for ${result.points} credits`;
    }
    if (result.alreadyClaimed) {
        return `already checked in today for ${result.points} credits`;
    }
    if (result.status === 'disabled') {
        return 'check-in is disabled today';
    }
    return 'check-in is not available yet';
};

export const minimaxCheckInAllMessage = (result: MinimaxCheckInAllResult) =>
    `Checked in all MiniMax accounts: ${result.claimed} claimed, ${result.alreadyClaimed} already checked in, ${result.unavailable} unavailable, ${result.failed} failed (${result.attempted} attempted)`;

export const minimaxLoadSuccessMessage = (key: string, result: LoadResult) =>
    result.checkIn ? `Loaded ${key}; ${minimaxCheckInMessage(result.checkIn)}` : `Loaded ${key}`;

const minimaxCheckInAll = async () => {
    const result = await api<MinimaxCheckInAllResult>('/api/minimax/check-in-all', {});
    return minimaxCheckInAllMessage(result);
};

const MINIMAX_CONFIG: PanelConfig<AccountState> = {
    describeState: (state) => `${state.configPath ?? ''} · ${state.vaultPath}`,
    displayName: 'MiniMax',
    limits: true,
    loadSuccess: minimaxLoadSuccessMessage,
    platform: 'minimax',
    syncResource: 'config',
    toolbarActions: [
        {
            kind: 'check-in-all',
            label: 'Check-In for All Accounts',
            pendingLabel: 'Checking in all…',
            pendingStatus: 'Checking in all MiniMax accounts...',
            refreshLimitsAfter: true,
            run: minimaxCheckInAll,
        },
    ],
};

const PANEL_CONFIGS: Record<PlatformTab, PanelConfig<AccountState>> = {
    antigravity: ANTIGRAVITY_CONFIG,
    cline: CLINE_CONFIG,
    codex: CODEX_CONFIG,
    kiro: KIRO_CONFIG,
    minimax: MINIMAX_CONFIG,
};

const App = () => {
    const [tab, setTab] = useState<PlatformTab>(() => tabFromPath(window.location.pathname));

    const selectTab = (nextTab: PlatformTab) => {
        if (nextTab === tab) {
            return;
        }
        history.pushState(null, '', pathForTab(nextTab));
        setTab(nextTab);
    };

    useEffect(() => {
        const updateTabFromLocation = () => setTab(tabFromPath(window.location.pathname));
        window.addEventListener('popstate', updateTabFromLocation);
        return () => window.removeEventListener('popstate', updateTabFromLocation);
    }, []);

    return (
        <main>
            <div class="top">
                <div class="brand">
                    <img src="/icon.svg" alt="" />
                    <h1>Dondo</h1>
                </div>
            </div>
            <nav class="tabs" aria-label="Platforms">
                {platformTabs.map((item) => (
                    <button
                        type="button"
                        key={item.id}
                        aria-current={tab === item.id ? 'page' : undefined}
                        class={tab === item.id ? 'active tab' : 'tab'}
                        onClick={() => selectTab(item.id)}
                    >
                        {item.label}
                    </button>
                ))}
            </nav>
            {platformTabs.map((item) => (
                <PlatformAccountPanel key={item.id} active={tab === item.id} config={PANEL_CONFIGS[item.id]} />
            ))}
            <footer class="footer">
                <a href={packageJson.homepage} target="_blank" rel="noreferrer">
                    GitHub
                </a>
            </footer>
        </main>
    );
};

const root = typeof document === 'undefined' ? null : document.getElementById('app');
if (root) {
    render(<App />, root);
}
