import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const env = (key: string) => {
    const value = process.env[key]?.trim();
    return value ? value : undefined;
};

if (process.platform !== 'darwin') {
    throw new Error(`Dondo supports macOS only; unsupported platform: ${process.platform}`);
}

const appDataDir = () => {
    return join(homedir(), 'Library', 'Application Support', 'Dondo');
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
export const VAULT_PATH = env('DONDO_VAULT') ?? join(DATA_DIR, 'vault.json');
export const CODEX_AUTH_PATH = env('CODEX_AUTH_PATH') ?? join(homedir(), '.codex', 'auth.json');
export const CLINE_PROVIDERS_PATH =
    env('CLINE_PROVIDERS_PATH') ?? join(homedir(), '.cline', 'data', 'settings', 'providers.json');
export const KIRO_AUTH_PATH = env('KIRO_AUTH_PATH') ?? join(homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
export const KIRO_PROFILE_PATH =
    env('KIRO_PROFILE_PATH') ??
    join(
        homedir(),
        'Library',
        'Application Support',
        'Kiro',
        'User',
        'globalStorage',
        'kiro.kiroagent',
        'profile.json',
    );
export const KIRO_PROCESS_NAME = env('KIRO_PROCESS_NAME') ?? 'Kiro';
export const KIRO_AUTH_REFRESH_URL =
    env('KIRO_AUTH_REFRESH_URL') ?? 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
export const KIRO_USAGE_URL = env('KIRO_USAGE_URL');
export const KIRO_USER_AGENT = env('KIRO_USER_AGENT') ?? 'KiroIDE-0.0.0-dondo';
export const MINIMAX_CONFIG_PATH =
    env('MINIMAX_CONFIG_PATH') ??
    join(homedir(), 'Library', 'Application Support', 'MiniMax Agent', 'minimax-agent-config.json');
export const MINIMAX_PLATFORM_URL = env('MINIMAX_PLATFORM_URL') ?? 'https://platform.minimax.io';
export const MINIMAX_AGENT_URL = env('MINIMAX_AGENT_URL') ?? 'https://agent.minimax.io';
export const MINIMAX_UUID = env('MINIMAX_UUID');
export const MINIMAX_LOCAL_STORAGE_PATH =
    env('MINIMAX_LOCAL_STORAGE_PATH') ?? join(dirname(MINIMAX_CONFIG_PATH), 'Local Storage', 'leveldb');

export const VAULT_KEY_SERVICE = 'dondo';
export const VAULT_KEY_ACCOUNT = 'vault-key';

export const ANTIGRAVITY_SERVICE = env('ANTIGRAVITY_SERVICE') ?? 'gemini';
export const ANTIGRAVITY_ACCOUNT = env('ANTIGRAVITY_ACCOUNT') ?? 'antigravity';

export const ANTIGRAVITY_VERSION = env('ANTIGRAVITY_VERSION') ?? '2.0.3';
export const ANTIGRAVITY_PROCESS_NAME = env('ANTIGRAVITY_PROCESS_NAME') ?? 'Antigravity';
export const antigravityLanguageServerPath = () => env('ANTIGRAVITY_LANGUAGE_SERVER_PATH') ?? '';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const LOAD_PROJECT_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
export const QUOTA_URLS = [
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_USER_AGENT = 'codex-cli/1.0.0';
