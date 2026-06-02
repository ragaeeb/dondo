import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export const writePrivateFile = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
        handle = await open(tempPath, 'w', 0o600);
        await handle.writeFile(text, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(tempPath, path);
        await chmod(path, 0o600);
    } catch (error) {
        await handle?.close().catch(() => {});
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
};
