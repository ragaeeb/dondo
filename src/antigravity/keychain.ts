import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { waitForAll } from '../async-queue.ts';
import { ANTIGRAVITY_ACCOUNT, ANTIGRAVITY_SERVICE } from '../config.ts';
import { publicError } from '../errors.ts';
import { isRunError, run } from '../shell.ts';
import type { AntigravityCredential } from '../types.ts';

const SECURITY_PATH = '/usr/bin/security';

export const parsePassword = (stderr: string) => {
    const match = stderr.match(/password: "((?:\\"|[^"])*)"/);
    if (!match) {
        throw new Error('Could not read password from security output');
    }
    return match[1]?.replace(/\\"/g, '"') ?? '';
};

export const deleteLivePassword = async (runCommand: typeof run = run) => {
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

export const readCurrentSnapshot = async (runCommand: typeof run = run): Promise<AntigravityCredential> => {
    return readSnapshot(runCommand).catch(() => {
        throw publicError(500, 'Dondo could not access the current Antigravity credential in macOS Keychain');
    });
};

const writeAndVerifySnapshot = async (snap: AntigravityCredential, runCommand: typeof run) => {
    await runCommand(
        SECURITY_PATH,
        ['add-generic-password', '-s', snap.service, '-a', snap.account, '-l', snap.label, '-D', snap.kind, '-U', '-w'],
        { stdin: `${snap.password}\n${snap.password}\n` },
    );
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

export const replaceLiveSnapshot = async (snap: AntigravityCredential, runCommand: typeof run = run) => {
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

export const clearLocalState = async () => {
    const home = homedir();
    await waitForAll(
        [
            join(home, '.antigravity-agent', 'cloud_accounts.db'),
            join(home, '.gemini', 'antigravity'),
            join(home, '.gemini', 'antigravity-ide'),
            join(home, '.gemini', 'antigravity-backup'),
            join(home, 'Library', 'Application Support', 'Antigravity'),
        ].map((path) => rm(path, { force: true, recursive: true })),
    );
};

export const clearLiveAuth = async (
    runCommand: typeof run = run,
    clearState: typeof clearLocalState = clearLocalState,
) => {
    await clearState();
    await deleteLivePassword(runCommand);
};
