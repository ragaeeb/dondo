import { expect, it } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    MAX_LOCAL_CREDENTIAL_FILE_BYTES,
    readBoundedLocalText,
    readBoundedTextFile,
    writePrivateFile,
} from './file.ts';

it('should return null for absent local credential files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-bounded-file-test-'));
    try {
        await expect(readBoundedLocalText(join(dir, 'missing.json'))).resolves.toBeNull();
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should read bounded UTF-8 credential text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-bounded-file-test-'));
    const path = join(dir, 'credential.json');
    try {
        await Bun.write(path, 'é');
        await expect(readBoundedLocalText(path, 2)).resolves.toBe('é');
        await expect(readBoundedLocalText(path, 1)).rejects.toThrow(
            'Local credential file exceeds the 1 byte size limit',
        );
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject files larger than the default limit without exposing content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-bounded-file-test-'));
    const path = join(dir, 'credential.json');
    const secret = `Bearer ${'x'.repeat(MAX_LOCAL_CREDENTIAL_FILE_BYTES)}`;
    try {
        await Bun.write(path, secret);
        const error = await readBoundedLocalText(path).catch((value: unknown) => value);
        expect((error as { status?: number }).status).toBe(413);
        expect(String(error)).not.toContain(secret);
        expect(String(error)).toContain('1 MiB size limit');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should reject malformed UTF-8 without decoding replacement characters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-bounded-file-test-'));
    const path = join(dir, 'credential.json');
    try {
        await Bun.write(path, new Uint8Array([0xc3, 0x28]));
        const error = await readBoundedLocalText(path).catch((value: unknown) => value);
        expect((error as { status?: number }).status).toBe(400);
        expect(String(error)).toContain('Local credential file is not valid UTF-8');
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});

it('should validate bounded-reader limits before reading a file', async () => {
    for (const maxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(readBoundedLocalText('/path/does/not/matter', maxBytes)).rejects.toThrow(
            'maxBytes must be a finite non-negative integer',
        );
    }
});

it('should preserve stream errors that are unrelated to UTF-8 decoding', async () => {
    const originalFile = Bun.file;
    const streamError = new TypeError('simulated stream failure');
    Bun.file = (() => ({
        exists: async () => true,
        stream: () =>
            new ReadableStream<Uint8Array>({
                pull: (controller) => controller.error(streamError),
            }),
    })) as unknown as typeof Bun.file;
    try {
        await expect(readBoundedTextFile('simulated')).rejects.toBe(streamError);
    } finally {
        Bun.file = originalFile;
    }
});

it('should atomically replace private files with mode 0600 and clean up its temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dondo-private-file-test-'));
    const path = join(dir, 'credential.json');
    try {
        await Bun.write(path, 'old');
        await writePrivateFile(path, 'new');

        expect(await Bun.file(path).text()).toBe('new');
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await readdir(dir)).sort()).toEqual(['credential.json']);
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
