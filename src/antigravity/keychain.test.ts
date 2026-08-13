import { expect, it } from 'bun:test';
import type { run } from '../shell.ts';
import type { AntigravityCredential } from '../types.ts';
import {
    clearLiveAuth,
    deleteLivePassword,
    parsePassword,
    readCurrentSnapshot,
    replaceLiveSnapshot,
} from './keychain.ts';

const snapshot = (password: string): AntigravityCredential => ({
    account: 'antigravity',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'Generic Password',
    label: 'gemini',
    password,
    service: 'gemini',
    updatedAt: '2026-01-01T00:00:00.000Z',
});

const runError = (code: number, message = `security failed ${code}`) => {
    return Object.assign(new Error(message), { code, stderr: '', stdout: '' });
};

it('should parse escaped keychain password output without greedy capture', () => {
    const stderr = '"labl"<blob>="gemini"\npassword: "go-keyring-base64:abc\\"def"\n"extra"<blob>="ignored"';

    expect(parsePassword(stderr)).toBe('go-keyring-base64:abc"def');
});

it('should read the current snapshot through the injected command runner', async () => {
    let command = '';
    const runCommand = (async (cmd) => {
        command = cmd;
        return {
            stderr: '"labl"<blob>="gemini"\npassword: "go-keyring-base64:test"',
            stdout: '',
        };
    }) as typeof run;

    const current = await readCurrentSnapshot(runCommand);

    expect(current).toMatchObject({
        account: 'antigravity',
        label: 'gemini',
        password: 'go-keyring-base64:test',
        service: 'gemini',
    });
    expect(command).toBe('/usr/bin/security');
});

it('should wrap Keychain read failures in fixed public copy', async () => {
    const denied = (async () => {
        throw runError(55, 'security says password: "private"');
    }) as typeof run;

    const error = await readCurrentSnapshot(denied).catch((value: unknown) => value);
    expect((error as { status?: number }).status).toBe(500);
    expect(String(error)).toContain('Dondo could not access the current Antigravity credential in macOS Keychain');
    expect(String(error)).not.toContain('private');
});

it('should replace an absent credential through repeated prompted stdin without a secret argv', async () => {
    const next = snapshot('go-keyring-base64:private-snapshot');
    const invocations: Array<{ args: string[]; stdin: string | undefined }> = [];
    const runCommand = (async (_cmd, args, options) => {
        invocations.push({ args, stdin: options?.stdin });
        if (args.at(-1) === '-g') {
            throw runError(44);
        }
        if (args[0] === 'find-generic-password') {
            return { stderr: '', stdout: `${next.password}\n` };
        }
        return { stderr: '', stdout: '' };
    }) as typeof run;

    await replaceLiveSnapshot(next, runCommand);

    const add = invocations.find(({ args }) => args[0] === 'add-generic-password');
    expect(add?.args.at(-1)).toBe('-w');
    expect(add?.args).not.toContain(next.password);
    expect(add?.args).not.toContain('login.keychain-db');
    expect(add?.stdin).toBe(`${next.password}\n${next.password}\n`);
});

it('should restore the previous credential after a failed replacement', async () => {
    const previous = snapshot('go-keyring-base64:previous');
    const next = snapshot('go-keyring-base64:next');
    const additions: Array<{ args: string[]; stdin: string | undefined }> = [];
    let addCalls = 0;
    const runCommand = (async (_cmd, args, options) => {
        if (args.at(-1) === '-g') {
            return {
                stderr: `"labl"<blob>="gemini"\npassword: "${previous.password}"`,
                stdout: '',
            };
        }
        if (args[0] === 'add-generic-password') {
            additions.push({ args, stdin: options?.stdin });
            addCalls += 1;
            if (addCalls === 1) {
                throw runError(55);
            }
            return { stderr: '', stdout: '' };
        }
        return { stderr: '', stdout: `${previous.password}\n` };
    }) as typeof run;

    await expect(replaceLiveSnapshot(next, runCommand)).rejects.toThrow(
        'Dondo could not replace the Antigravity credential in macOS Keychain',
    );
    expect(additions.map(({ stdin }) => stdin)).toEqual([
        `${next.password}\n${next.password}\n`,
        `${previous.password}\n${previous.password}\n`,
    ]);
    for (const addition of additions) {
        expect(addition.args).not.toContain(next.password);
        expect(addition.args).not.toContain(previous.password);
    }
});

it('should delete a newly created credential when exact readback fails', async () => {
    const next = snapshot('go-keyring-base64:private-snapshot');
    const commands: string[] = [];
    const runCommand = (async (_cmd, args) => {
        commands.push(args[0] ?? '');
        if (args.at(-1) === '-g') {
            throw runError(44);
        }
        return { stderr: '', stdout: '' };
    }) as typeof run;

    await expect(replaceLiveSnapshot(next, runCommand)).rejects.toThrow(
        'Dondo could not replace the Antigravity credential in macOS Keychain',
    );
    expect(commands).toEqual([
        'find-generic-password',
        'add-generic-password',
        'find-generic-password',
        'delete-generic-password',
    ]);
});

it('should return a fixed error when replacement rollback also fails', async () => {
    const previous = snapshot('go-keyring-base64:previous');
    const next = snapshot('go-keyring-base64:next');
    const runCommand = (async (_cmd, args) => {
        if (args.at(-1) === '-g') {
            return {
                stderr: `"labl"<blob>="gemini"\npassword: "${previous.password}"`,
                stdout: '',
            };
        }
        throw runError(55, `failed with ${next.password} and ${previous.password}`);
    }) as typeof run;

    const error = await replaceLiveSnapshot(next, runCommand).catch((value: unknown) => value);
    expect(String(error)).toContain('could not restore the previous Antigravity credential');
    expect(String(error)).not.toContain(next.password);
    expect(String(error)).not.toContain(previous.password);
});

it('should abort before replacement when the prior credential cannot be read', async () => {
    const commands: string[] = [];
    const runCommand = (async (_cmd, args) => {
        commands.push(args[0] ?? '');
        throw runError(55);
    }) as typeof run;

    await expect(replaceLiveSnapshot(snapshot('private'), runCommand)).rejects.toThrow(
        'Dondo could not access the current Antigravity credential in macOS Keychain',
    );
    expect(commands).toEqual(['find-generic-password']);
});

it('should ignore only Keychain not-found failures when deleting a live credential', async () => {
    const missing = (async () => {
        throw runError(44);
    }) as typeof run;
    const denied = (async () => {
        throw runError(55);
    }) as typeof run;

    await expect(deleteLivePassword(missing)).resolves.toBeUndefined();
    const error = await deleteLivePassword(denied).catch((value: unknown) => value);
    expect((error as { status?: number }).status).toBe(500);
    expect(String(error)).toContain('Dondo could not delete the Antigravity credential from macOS Keychain');
    expect(String(error)).not.toContain('security failed 55');
});

it('should preserve the live credential when local-state cleanup fails', async () => {
    let deleted = false;
    const runCommand = (async () => {
        deleted = true;
        return { stderr: '', stdout: '' };
    }) as typeof run;
    const clearState = async () => {
        expect(deleted).toBe(false);
        throw new Error('cleanup failed');
    };

    await expect(clearLiveAuth(runCommand, clearState)).rejects.toThrow('cleanup failed');
    expect(deleted).toBe(false);
});

it('should delete the live credential only after local-state cleanup succeeds', async () => {
    const events: string[] = [];
    const runCommand = (async () => {
        events.push('delete');
        return { stderr: '', stdout: '' };
    }) as typeof run;

    await clearLiveAuth(runCommand, async () => {
        events.push('clear-state');
    });
    expect(events).toEqual(['clear-state', 'delete']);
});
