import { ANTIGRAVITY_ACCOUNT, ANTIGRAVITY_SERVICE, DEV_MODE } from '../config.ts';
import { publicError } from '../errors.ts';
import { mockKeychainRun } from '../mock-keychain.ts';
import { isRunError, run } from '../shell.ts';
import type { AntigravityCredential } from '../types.ts';

const SECURITY_PATH = '/usr/bin/security';
const defaultRunCommand = DEV_MODE === 'mock' ? mockKeychainRun : run;

export const parsePassword = (stderr: string) => {
    const match = stderr.match(/password: "((?:\\"|[^"])*)"/);
    if (!match) {
        throw new Error('Could not read password from security output');
    }
    return match[1]?.replace(/\\"/g, '"') ?? '';
};

export const deleteLivePassword = async (runCommand: typeof run = defaultRunCommand) => {
    await runCommand(SECURITY_PATH, [
        'delete-generic-password',
        '-s',
        ANTIGRAVITY_SERVICE,
        '-a',
        ANTIGRAVITY_ACCOUNT,
    ]).catch((error) => {
        if (!isRunError(error) || error.code !== 44) {
            throw publicError(500, 'Dondo could not delete the Antigravity credential from macOS Keychain');
        }
    });
};

const readSnapshot = async (runCommand: typeof run): Promise<AntigravityCredential> => {
    const { stderr } = await runCommand(SECURITY_PATH, [
        'find-generic-password',
        '-s',
        ANTIGRAVITY_SERVICE,
        '-a',
        ANTIGRAVITY_ACCOUNT,
        '-g',
    ]);
    const now = new Date().toISOString();
    return {
        account: ANTIGRAVITY_ACCOUNT,
        createdAt: now,
        kind: 'Generic Password',
        label: stderr.match(/"labl"<blob>="([^"]*)"/)?.[1] ?? ANTIGRAVITY_SERVICE,
        password: parsePassword(stderr),
        service: ANTIGRAVITY_SERVICE,
        updatedAt: now,
    };
};

const readOptionalSnapshot = async (runCommand: typeof run) => {
    return readSnapshot(runCommand).catch((error) => {
        if (isRunError(error) && error.code === 44) {
            return null;
        }
        throw publicError(500, 'Dondo could not access the current Antigravity credential in macOS Keychain');
    });
};

export const readCurrentSnapshot = async (
    runCommand: typeof run = defaultRunCommand,
): Promise<AntigravityCredential> => {
    return readSnapshot(runCommand).catch(() => {
        throw publicError(500, 'Dondo could not access the current Antigravity credential in macOS Keychain');
    });
};

const writeAndVerifySnapshot = async (snap: AntigravityCredential, runCommand: typeof run) => {
    await runCommand(SECURITY_PATH, [
        'add-generic-password',
        '-s',
        snap.service,
        '-a',
        snap.account,
        '-l',
        snap.label,
        '-D',
        snap.kind,
        '-w',
        snap.password,
        '-U',
    ]);
    const restored = await runCommand(SECURITY_PATH, [
        'find-generic-password',
        '-s',
        snap.service,
        '-a',
        snap.account,
        '-w',
    ]);
    if (restored.stdout.replace(/\r?\n$/, '') !== snap.password) {
        throw new Error('macOS Keychain did not persist the restored credential');
    }
};

export const replaceLiveSnapshot = async (snap: AntigravityCredential, runCommand: typeof run = defaultRunCommand) => {
    const previous = await readOptionalSnapshot(runCommand);
    try {
        await writeAndVerifySnapshot(snap, runCommand);
    } catch {
        try {
            if (previous) {
                await writeAndVerifySnapshot(previous, runCommand);
            } else {
                await deleteLivePassword(runCommand);
            }
        } catch {
            throw publicError(
                500,
                'Dondo could not restore the previous Antigravity credential after a failed replacement',
            );
        }
        throw publicError(500, 'Dondo could not replace the Antigravity credential in macOS Keychain');
    }
};

export const clearLiveAuth = async (runCommand: typeof run = defaultRunCommand) => {
    await deleteLivePassword(runCommand);
};
