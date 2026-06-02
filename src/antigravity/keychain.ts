import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ANTIGRAVITY_ACCOUNT, ANTIGRAVITY_KEYCHAIN, ANTIGRAVITY_SERVICE } from '../config.ts';
import { run } from '../shell.ts';
import type { Snapshot } from '../types.ts';

export const parsePassword = (stderr: string) => {
    const match = stderr.match(/password: "((?:\\"|[^"])*)"/);
    if (!match) {
        throw new Error('Could not read password from security output');
    }
    return match[1]?.replace(/\\"/g, '"') ?? '';
};

const keychainArgs = () => {
    return ANTIGRAVITY_KEYCHAIN ? [ANTIGRAVITY_KEYCHAIN] : [];
};

const deleteLivePassword = async () => {
    await run('security', [
        'delete-generic-password',
        '-s',
        ANTIGRAVITY_SERVICE,
        '-a',
        ANTIGRAVITY_ACCOUNT,
        ...keychainArgs(),
    ]).catch(() => {});
};

export const readCurrentSnapshot = async (): Promise<Snapshot> => {
    const { stderr } = await run('security', [
        'find-generic-password',
        '-s',
        ANTIGRAVITY_SERVICE,
        '-a',
        ANTIGRAVITY_ACCOUNT,
        '-g',
        ...keychainArgs(),
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

export const restoreSnapshot = async (snap: Snapshot) => {
    await deleteLivePassword();
    await run('security', [
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
        ...keychainArgs(),
    ]);
};

export const clearLiveAuth = async () => {
    await deleteLivePassword();
    const home = homedir();
    await Promise.all(
        [
            join(home, '.antigravity-agent', 'cloud_accounts.db'),
            join(home, '.gemini', 'antigravity'),
            join(home, '.gemini', 'antigravity-ide'),
            join(home, '.gemini', 'antigravity-backup'),
            join(home, 'Library', 'Application Support', 'Antigravity'),
        ].map((path) => rm(path, { force: true, recursive: true })),
    );
};
