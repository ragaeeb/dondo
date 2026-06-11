import { homedir } from 'node:os';
import { join } from 'node:path';

const env = (key: string) => {
    const value = process.env[key]?.trim();
    return value ? value : undefined;
};

const appDataDir = () => {
    if (process.platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', 'Dondo');
    }
    if (process.platform === 'win32') {
        return join(env('LOCALAPPDATA') ?? join(homedir(), 'AppData', 'Local'), 'Dondo', 'Data');
    }
    return join(env('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share'), 'dondo');
};

const parsePort = () => {
    const raw = env('DONDO_PORT') ?? env('PORT') ?? '3000';
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid port: ${raw}`);
    }
    return port;
};

export const HOST = '127.0.0.1';
export const PORT = parsePort();
export const DATA_DIR = env('DONDO_DATA_DIR') ?? appDataDir();
export const VAULT_PATH = env('DONDO_VAULT') ?? env('ANTIGRAVITY_VAULT') ?? join(DATA_DIR, 'vault.json');
export const CODEX_AUTH_PATH = env('CODEX_AUTH_PATH') ?? join(homedir(), '.codex', 'auth.json');
export const MINIMAX_CONFIG_PATH =
    env('MINIMAX_CONFIG_PATH') ?? join(homedir(), 'Library', 'Application Support', 'MiniMax Agent', 'minimax-agent-config.json');

export const VAULT_KEY_SERVICE = 'dondo';
export const VAULT_KEY_ACCOUNT = 'vault-key';

export const ANTIGRAVITY_KEYCHAIN = env('ANTIGRAVITY_KEYCHAIN') ?? 'login.keychain-db';
export const ANTIGRAVITY_SERVICE = env('ANTIGRAVITY_SERVICE') ?? 'gemini';
export const ANTIGRAVITY_ACCOUNT = env('ANTIGRAVITY_ACCOUNT') ?? 'antigravity';

export const ANTIGRAVITY_VERSION = env('ANTIGRAVITY_VERSION') ?? '2.0.3';
export const ANTIGRAVITY_LANGUAGE_SERVER_PATH = env('ANTIGRAVITY_LANGUAGE_SERVER_PATH') ?? '';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const LOAD_PROJECT_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
export const QUOTA_URLS = [
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_USER_AGENT = 'codex-cli/1.0.0';
