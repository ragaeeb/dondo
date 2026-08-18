import { expect, it } from 'bun:test';
import { createMockKeychainRunner } from './mock-keychain.ts';

const runError = (error: unknown) => error as { code?: number; stderr?: string; stdout?: string };

it('should keep mock Keychain credentials in process memory', async () => {
    const run = createMockKeychainRunner();
    await run('/usr/bin/security', ['add-generic-password', '-s', 'dondo', '-a', 'vault-key', '-w'], {
        stdin: 'private-vault-key\n',
    });

    const stored = await run('/usr/bin/security', ['find-generic-password', '-s', 'dondo', '-a', 'vault-key', '-w']);

    expect(stored.stdout).toBe('private-vault-key\n');
});

it('should emulate Antigravity Keychain metadata without invoking security', async () => {
    const run = createMockKeychainRunner();
    await run('/usr/bin/security', [
        'add-generic-password',
        '-s',
        'gemini',
        '-a',
        'antigravity',
        '-l',
        'gemini',
        '-D',
        'Generic Password',
        '-w',
        'mock-password',
        '-U',
    ]);

    const snapshot = await run('/usr/bin/security', [
        'find-generic-password',
        '-s',
        'gemini',
        '-a',
        'antigravity',
        '-g',
    ]);

    expect(snapshot.stdout).toBe('');
    expect(snapshot.stderr).toContain('"labl"<blob>="gemini"');
    expect(snapshot.stderr).toContain('password: "mock-password"');
});

it('should report missing mock Keychain items with the security not-found code', async () => {
    const run = createMockKeychainRunner();

    const error = await run('/usr/bin/security', [
        'find-generic-password',
        '-s',
        'missing',
        '-a',
        'missing',
        '-w',
    ]).catch((value: unknown) => value);
    const value = runError(error);
    expect(value.code).toBe(44);
    expect(value.stderr).toBe('');
    expect(value.stdout).toBe('');
});

it('should escape control characters in mock Keychain diagnostics', async () => {
    const run = createMockKeychainRunner();
    await run(
        '/usr/bin/security',
        ['add-generic-password', '-s', 'gemini', '-a', 'antigravity', '-l', 'line\nlabel', '-w'],
        { stdin: 'password\\with\nnewline\n' },
    );

    const snapshot = await run('/usr/bin/security', [
        'find-generic-password',
        '-s',
        'gemini',
        '-a',
        'antigravity',
        '-g',
    ]);

    expect(snapshot.stderr).toContain('line\\nlabel');
    expect(snapshot.stderr).toContain('password: "password\\\\with"');
});
