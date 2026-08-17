import { createHash, randomBytes } from 'node:crypto';
import { DEV_MODE, VAULT_KEY_ACCOUNT, VAULT_KEY_SERVICE } from '../config.ts';
import { publicError } from '../errors.ts';
import { mockKeychainRun } from '../mock-keychain.ts';
import { isRunError, run } from '../shell.ts';

export type VaultKeyMode = 'create' | 'existing';

const SECURITY_PATH = '/usr/bin/security';
const defaultRunCommand = DEV_MODE === 'mock' ? mockKeychainRun : run;

const digestSecret = (secret: string) => createHash('sha256').update(secret).digest();

const readVaultSecret = async (runCommand: typeof run) => {
    return await runCommand(SECURITY_PATH, [
        'find-generic-password',
        '-s',
        VAULT_KEY_SERVICE,
        '-a',
        VAULT_KEY_ACCOUNT,
        '-w',
    ])
        .then(({ stdout }) => stdout.trim())
        .catch((error) => {
            if (isRunError(error) && error.code === 44) {
                return '';
            }
            throw error;
        });
};

export const storeVaultSecret = async (secret: string, runCommand: typeof run = defaultRunCommand) => {
    await runCommand(SECURITY_PATH, ['add-generic-password', '-s', VAULT_KEY_SERVICE, '-a', VAULT_KEY_ACCOUNT, '-w'], {
        stdin: `${secret}\n`,
    });
};

const loadExistingVaultKey = async (runCommand: typeof run) => {
    const found = await readVaultSecret(runCommand).catch(() => {
        throw publicError(500, 'Dondo could not access the vault key in macOS Keychain');
    });
    if (found) {
        return digestSecret(found);
    }
    throw publicError(500, 'The Dondo vault key is missing from macOS Keychain; the encrypted vault cannot be opened');
};

const loadOrCreateVaultKey = async (runCommand: typeof run) => {
    const found = await readVaultSecret(runCommand).catch(() => {
        throw publicError(500, 'Dondo could not access the vault key in macOS Keychain');
    });
    if (found) {
        return digestSecret(found);
    }

    const secret = randomBytes(32).toString('base64');
    await storeVaultSecret(secret, runCommand).catch(async () => {
        const racedSecret = await readVaultSecret(runCommand).catch(() => '');
        if (racedSecret) {
            return;
        }
        throw publicError(500, 'Dondo could not persist the vault key in macOS Keychain');
    });

    const stored = await readVaultSecret(runCommand).catch(() => {
        throw publicError(500, 'Dondo could not verify the vault key in macOS Keychain');
    });
    if (!stored) {
        throw publicError(500, 'Dondo could not verify the vault key in macOS Keychain');
    }
    return digestSecret(stored);
};

export const createVaultKeyProvider = (runCommand: typeof run = defaultRunCommand) => {
    let cachedKey: Buffer | undefined;
    let pendingKey: Promise<Buffer> | undefined;
    return async (mode: VaultKeyMode) => {
        if (cachedKey) {
            return cachedKey;
        }
        if (pendingKey) {
            return pendingKey;
        }
        const load = mode === 'existing' ? loadExistingVaultKey : loadOrCreateVaultKey;
        pendingKey = load(runCommand)
            .then((key) => {
                cachedKey = key;
                return key;
            })
            .finally(() => {
                pendingKey = undefined;
            });
        return pendingKey;
    };
};

export const vaultKey = createVaultKeyProvider();
