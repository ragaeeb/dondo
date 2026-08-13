import { expect, it } from 'bun:test';
import type { run } from '../shell.ts';
import { createVaultKeyProvider, storeVaultSecret } from './secret.ts';

it('should store vault-key material through prompted stdin without putting it in argv', async () => {
    const secret = 'private-vault-key-material';
    let invocation: { args: string[]; stdin: string | undefined } | undefined;
    let command = '';
    const runCommand = (async (cmd, args, options) => {
        command = cmd;
        invocation = { args, stdin: options?.stdin };
        return { stderr: '', stdout: '' };
    }) as typeof run;

    await storeVaultSecret(secret, runCommand);

    expect(invocation?.args.at(-1)).toBe('-w');
    expect(invocation?.args).not.toContain(secret);
    expect(invocation?.stdin).toBe(`${secret}\n${secret}\n`);
    expect(command).toBe('/usr/bin/security');
});

it('should deduplicate concurrent cold vault-key lookups', async () => {
    let calls = 0;
    const runCommand = (async (_cmd, args) => {
        calls += 1;
        expect(args[0]).toBe('find-generic-password');
        await Bun.sleep(10);
        return { stderr: '', stdout: 'shared-key\n' };
    }) as typeof run;

    const vaultKey = createVaultKeyProvider(runCommand);
    const keys = await Promise.all([vaultKey('existing'), vaultKey('existing'), vaultKey('existing')]);

    expect(calls).toBe(1);
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[1]).toEqual(keys[2]);
});

it('should retry a cold vault-key lookup after rejection', async () => {
    let calls = 0;
    const runCommand = (async () => {
        calls += 1;
        if (calls === 1) {
            throw new Error('transient lookup failure');
        }
        return { stderr: '', stdout: 'recovered-key\n' };
    }) as typeof run;

    const vaultKey = createVaultKeyProvider(runCommand);
    await expect(vaultKey('existing')).rejects.toThrow('Dondo could not access the vault key in macOS Keychain');
    await expect(vaultKey('existing')).resolves.toBeInstanceOf(Buffer);
    expect(calls).toBe(2);
});

it('should reject a successful Keychain write when the persisted vault key is empty', async () => {
    let calls = 0;
    const runCommand = (async (_cmd, args) => {
        calls += 1;
        if (args[0] === 'add-generic-password') {
            return { stderr: '', stdout: '' };
        }
        return { stderr: '', stdout: '' };
    }) as typeof run;

    const vaultKey = createVaultKeyProvider(runCommand);
    await expect(vaultKey('create')).rejects.toThrow('Dondo could not verify the vault key in macOS Keychain');
    expect(calls).toBe(3);
});

it('should never create a vault key when an existing key is required', async () => {
    const commands: string[] = [];
    const runCommand = (async (_cmd, args) => {
        commands.push(args[0] ?? '');
        return { stderr: '', stdout: '' };
    }) as typeof run;

    const vaultKey = createVaultKeyProvider(runCommand);
    await expect(vaultKey('existing')).rejects.toThrow(
        'The Dondo vault key is missing from macOS Keychain; the encrypted vault cannot be opened',
    );
    expect(commands).toEqual(['find-generic-password']);
});

it('should create and verify a vault key only when creation is explicitly allowed', async () => {
    const commands: string[] = [];
    let stored = '';
    const runCommand = (async (_cmd, args, options) => {
        commands.push(args[0] ?? '');
        if (args[0] === 'add-generic-password') {
            stored = options?.stdin?.split('\n')[0] ?? '';
            return { stderr: '', stdout: '' };
        }
        return { stderr: '', stdout: stored ? `${stored}\n` : '' };
    }) as typeof run;

    const vaultKey = createVaultKeyProvider(runCommand);
    await expect(vaultKey('create')).resolves.toBeInstanceOf(Buffer);
    expect(commands).toEqual(['find-generic-password', 'add-generic-password', 'find-generic-password']);
});

it('should not escalate an in-flight existing-only lookup when creation is requested concurrently', async () => {
    const commands: string[] = [];
    let releaseLookup: (() => void) | undefined;
    const lookupStarted = Promise.withResolvers<void>();
    const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
    });
    const runCommand = (async (_cmd, args) => {
        commands.push(args[0] ?? '');
        lookupStarted.resolve();
        await lookupGate;
        return { stderr: '', stdout: '' };
    }) as typeof run;

    const vaultKey = createVaultKeyProvider(runCommand);
    const existing = vaultKey('existing');
    await lookupStarted.promise;
    const create = vaultKey('create');
    releaseLookup?.();

    const outcomes = await Promise.allSettled([existing, create]);
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(outcomes.map((outcome) => String(outcome.status === 'rejected' ? outcome.reason : ''))).toEqual([
        expect.stringContaining('vault key is missing'),
        expect.stringContaining('vault key is missing'),
    ]);
    expect(commands).toEqual(['find-generic-password']);
});
