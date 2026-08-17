import type { run } from './shell.ts';

type MockKeychainItem = {
    account: string;
    kind: string;
    label: string;
    password: string;
    service: string;
};

const MOCK_ANTIGRAVITY_PASSWORD = `go-keyring-base64:${Buffer.from(
    JSON.stringify({
        auth_method: 'mock',
        token: { access_token: 'mock-access-token', refresh_token: 'mock-refresh-token' },
    }),
).toString('base64')}`;

const itemKey = (service: string, account: string) => `${service}\u0000${account}`;

const argumentValue = (args: string[], name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
};

const missingItem = () => {
    return Object.assign(new Error('Mock Keychain item was not found'), { code: 44, stderr: '', stdout: '' });
};

const escapedPassword = (password: string) => JSON.stringify(password).slice(1, -1);

const keychainItem = (args: string[]) => {
    const service = argumentValue(args, '-s');
    const account = argumentValue(args, '-a');
    if (!service || !account) {
        throw new Error('Mock Keychain operation requires a service and account');
    }
    return { account, key: itemKey(service, account), service };
};

const findKeychainItem = (items: Map<string, MockKeychainItem>, args: string[]) => {
    const { key } = keychainItem(args);
    const item = items.get(key);
    if (!item) {
        throw missingItem();
    }
    if (args.includes('-w')) {
        return { stderr: '', stdout: `${item.password}\n` };
    }
    return {
        stderr: `"labl"<blob>="${escapedPassword(item.label)}"\npassword: "${escapedPassword(item.password)}"`,
        stdout: '',
    };
};

const addKeychainItem = (items: Map<string, MockKeychainItem>, args: string[], stdin: string | undefined) => {
    const { account, key, service } = keychainItem(args);
    const password = argumentValue(args, '-w') ?? stdin?.split(/\r?\n/u)[0] ?? '';
    if (!password) {
        throw new Error('Mock Keychain writes require a secret');
    }
    items.set(key, {
        account,
        kind: argumentValue(args, '-D') ?? 'Generic Password',
        label: argumentValue(args, '-l') ?? service,
        password,
        service,
    });
    return { stderr: '', stdout: '' };
};

const deleteKeychainItem = (items: Map<string, MockKeychainItem>, args: string[]) => {
    const { key } = keychainItem(args);
    if (!items.delete(key)) {
        throw missingItem();
    }
    return { stderr: '', stdout: '' };
};

export const createMockKeychainRunner = (seedAntigravity = false): typeof run => {
    const items = new Map<string, MockKeychainItem>();
    if (seedAntigravity) {
        items.set(itemKey('gemini', 'antigravity'), {
            account: 'antigravity',
            kind: 'Generic Password',
            label: 'gemini',
            password: MOCK_ANTIGRAVITY_PASSWORD,
            service: 'gemini',
        });
    }

    return async (_command, args, options = {}) => {
        if (args[0] === 'find-generic-password') {
            return findKeychainItem(items, args);
        }
        if (args[0] === 'add-generic-password') {
            return addKeychainItem(items, args, options.stdin);
        }
        if (args[0] === 'delete-generic-password') {
            return deleteKeychainItem(items, args);
        }
        throw new Error('Unsupported mock Keychain operation');
    };
};

export const mockKeychainRun = createMockKeychainRunner(true);
