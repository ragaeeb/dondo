import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { publicError } from '../errors.ts';

export const MAX_LOCAL_CREDENTIAL_FILE_BYTES = 1024 * 1024;

type BoundedTextOptions = {
    errorStatus?: number;
    label?: string;
    maxBytes?: number;
};

const sizeLabel = (bytes: number) => {
    if (bytes > 0 && bytes % (1024 * 1024) === 0) {
        return `${bytes / (1024 * 1024)} MiB`;
    }
    return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
};

const decodeUtf8 = (
    decoder: TextDecoder,
    value: Uint8Array | undefined,
    label: string,
    errorStatus: number,
    stream = false,
) => {
    try {
        return decoder.decode(value, { stream });
    } catch (error) {
        if (error instanceof TypeError) {
            throw publicError(errorStatus, `${label} is not valid UTF-8`);
        }
        throw error;
    }
};

export const readBoundedTextFile = async (path: string, options: BoundedTextOptions = {}) => {
    const label = options.label ?? 'Local credential file';
    const maxBytes = options.maxBytes ?? MAX_LOCAL_CREDENTIAL_FILE_BYTES;
    const errorStatus = options.errorStatus ?? 400;
    if (!Number.isFinite(maxBytes) || !Number.isInteger(maxBytes) || maxBytes < 0) {
        throw new TypeError('maxBytes must be a finite non-negative integer');
    }
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return null;
    }

    const reader = file.stream().getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const chunks: string[] = [];
    let total = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) {
                break;
            }
            total += next.value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw publicError(
                    errorStatus === 500 ? 500 : 413,
                    `${label} exceeds the ${sizeLabel(maxBytes)} size limit`,
                );
            }
            chunks.push(decodeUtf8(decoder, next.value, label, errorStatus, true));
        }
        chunks.push(decodeUtf8(decoder, undefined, label, errorStatus));
    } finally {
        reader.releaseLock();
    }
    return chunks.join('');
};

export const readBoundedLocalText = async (path: string, maxBytes = MAX_LOCAL_CREDENTIAL_FILE_BYTES) => {
    return readBoundedTextFile(path, { maxBytes });
};

export const writePrivateFile = async (path: string, text: string) => {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
        handle = await open(tempPath, 'wx', 0o600);
        await handle.writeFile(text, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(tempPath, path);
        await chmod(path, 0o600);
        const directory = await open(parent, 'r');
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } catch (error) {
        await handle?.close().catch(() => {});
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
};
