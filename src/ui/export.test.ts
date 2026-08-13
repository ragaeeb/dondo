import { describe, expect, it } from 'bun:test';
import { chooseExportDestination, downloadPlatformExport, type ExportDestination } from './export.ts';
import { runWithOperationLock } from './operation.ts';

const jsonResponse = (body = '{"ok":true}') =>
    new Response(body, {
        headers: {
            'Content-Disposition': 'attachment; filename="dondo-codex-wallet-test.json"',
            'Content-Type': 'application/json',
        },
    });

const dependencies = (response: Response) => ({
    createObjectURL: () => 'blob:wallet',
    fetchExport: async () => response,
    revokeObjectURL: () => undefined,
    schedule: (callback: () => void) => callback(),
    triggerDownload: () => undefined,
});

describe('platform export download', () => {
    it('streams a response directly to a selected file without creating a Blob URL', async () => {
        const chunks: Uint8Array[] = [];
        let objectUrls = 0;
        const writable = new WritableStream<Uint8Array>({
            write: (chunk) => {
                chunks.push(chunk);
            },
        });
        const destination: ExportDestination = {
            fileHandle: { createWritable: async () => writable },
            kind: 'file-system',
        };
        const deps = {
            ...dependencies(jsonResponse()),
            createObjectURL: () => {
                objectUrls += 1;
                return 'blob:unused';
            },
        };

        await downloadPlatformExport('codex', destination, deps);

        expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('{"ok":true}');
        expect(objectUrls).toBe(0);
    });

    it('aborts the selected writable when response streaming fails', async () => {
        let aborted = false;
        const writable = new WritableStream<Uint8Array>({
            abort: () => {
                aborted = true;
            },
        });
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => controller.error(new Error('network interrupted')),
        });
        const response = new Response(body, { headers: { 'Content-Type': 'application/json' } });

        await expect(
            downloadPlatformExport(
                'codex',
                { fileHandle: { createWritable: async () => writable }, kind: 'file-system' },
                dependencies(response),
            ),
        ).rejects.toThrow('network interrupted');
        expect(aborted).toBe(true);
    });

    it('cancels the response when the selected file cannot be opened', async () => {
        let cancelled = false;
        const response = new Response(
            new ReadableStream<Uint8Array>({
                cancel: () => {
                    cancelled = true;
                },
            }),
            { headers: { 'Content-Type': 'application/json' } },
        );

        await expect(
            downloadPlatformExport(
                'codex',
                {
                    fileHandle: {
                        createWritable: async () => {
                            throw new Error('destination unavailable');
                        },
                    },
                    kind: 'file-system',
                },
                dependencies(response),
            ),
        ).rejects.toThrow('destination unavailable');
        expect(cancelled).toBe(true);
    });

    it('cancels an unexpected non-JSON response body', async () => {
        let cancelled = false;
        const response = new Response(
            new ReadableStream<Uint8Array>({
                cancel: () => {
                    cancelled = true;
                },
            }),
            { headers: { 'Content-Type': 'text/html' } },
        );

        await expect(downloadPlatformExport('codex', { kind: 'blob' }, dependencies(response))).rejects.toThrow(
            'Export response was not JSON',
        );
        expect(cancelled).toBe(true);
    });

    it('cancels a non-JSON error response before reporting its status', async () => {
        let cancelled = false;
        const response = new Response(
            new ReadableStream<Uint8Array>({
                cancel: () => {
                    cancelled = true;
                },
            }),
            { headers: { 'Content-Type': 'text/plain' }, status: 502, statusText: 'Bad Gateway' },
        );

        await expect(downloadPlatformExport('codex', { kind: 'blob' }, dependencies(response))).rejects.toThrow(
            'Bad Gateway',
        );
        expect(cancelled).toBe(true);
    });

    it('uses the Blob fallback and always schedules Object URL cleanup', async () => {
        const events: string[] = [];
        const deps = {
            ...dependencies(jsonResponse()),
            createObjectURL: () => {
                events.push('create');
                return 'blob:wallet';
            },
            revokeObjectURL: (url: string) => events.push(`revoke:${url}`),
            schedule: (callback: () => void, delay: number) => {
                events.push(`schedule:${delay}`);
                callback();
            },
            triggerDownload: (url: string, filename: string) => events.push(`download:${url}:${filename}`),
        };

        await downloadPlatformExport('codex', { kind: 'blob' }, deps);

        expect(events).toEqual([
            'create',
            'download:blob:wallet:dondo-codex-wallet-test.json',
            'schedule:10000',
            'revoke:blob:wallet',
        ]);
    });

    it('treats picker cancellation as a clean cancellation before any fetch', async () => {
        let pickerCalls = 0;
        const destination = await chooseExportDestination('codex', async () => {
            pickerCalls += 1;
            throw new DOMException('Cancelled', 'AbortError');
        });

        expect(pickerCalls).toBe(1);
        expect(destination).toBeNull();
    });

    it('keeps the operation locked while the picker is open and ignores a second export click', async () => {
        let pickerCalls = 0;
        let resolvePicker: () => void = () => undefined;
        const pickerResult = new Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>((resolve) => {
            resolvePicker = () => resolve({ createWritable: async () => new WritableStream<Uint8Array>() });
        });
        const picker = () => {
            pickerCalls += 1;
            return pickerResult;
        };
        const lock = { current: false };
        const choose = () => chooseExportDestination('codex', picker);

        const first = runWithOperationLock(lock, choose);
        const second = runWithOperationLock(lock, choose);

        expect(pickerCalls).toBe(1);
        expect(lock.current).toBe(true);
        expect(second).toBeNull();
        resolvePicker();
        expect(await first).toMatchObject({ kind: 'file-system' });
        expect(lock.current).toBe(false);
    });
});
