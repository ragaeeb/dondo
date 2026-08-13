import type { PlatformTab } from './routes.ts';

type SaveFilePickerOptions = {
    excludeAcceptAllOption?: boolean;
    suggestedName?: string;
    types?: Array<{
        accept: Record<string, string[]>;
        description?: string;
    }>;
};

type ExportFileHandle = {
    createWritable: () => Promise<WritableStream<Uint8Array>>;
};

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<ExportFileHandle>;

export type ExportDestination = { fileHandle: ExportFileHandle; kind: 'file-system' } | { kind: 'blob' };

type ExportDependencies = {
    createObjectURL: (blob: Blob) => string;
    fetchExport: (path: string, init: RequestInit) => Promise<Response>;
    revokeObjectURL: (url: string) => void;
    schedule: (callback: () => void, delay: number) => void;
    triggerDownload: (url: string, filename: string) => void;
};

const BLOB_URL_REVOKE_DELAY_MS = 10_000;

const browserDependencies: ExportDependencies = {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    fetchExport: (path, init) => fetch(path, init),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    schedule: (callback, delay) => {
        setTimeout(callback, delay);
    },
    triggerDownload: (url, filename) => {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        try {
            document.body.append(link);
            link.click();
        } finally {
            link.remove();
        }
    },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isExportFileHandle = (value: unknown): value is ExportFileHandle =>
    isRecord(value) && typeof value.createWritable === 'function';

const responseErrorMessage = (payload: unknown, response: Response) => {
    if (isRecord(payload) && typeof payload.error === 'string' && payload.error.trim()) {
        return payload.error;
    }
    return response.statusText || `Request failed with status ${response.status}`;
};

const exportFilename = (response: Response, platform: PlatformTab) => {
    const disposition = response.headers.get('content-disposition') ?? '';
    const candidate = disposition.match(/filename="([^"]+)"/)?.[1];
    return candidate && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(candidate)
        ? candidate
        : `dondo-${platform}-wallet.json`;
};

const validateExportResponse = async (response: Response) => {
    if (!response.ok) {
        let payload: unknown;
        if ((response.headers.get('content-type') ?? '').includes('application/json')) {
            payload = await response.json().catch(() => null);
        }
        throw new Error(responseErrorMessage(payload, response));
    }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Export response was not JSON');
    }
};

const writeToFileSystem = async (
    response: Response,
    destination: Extract<ExportDestination, { kind: 'file-system' }>,
) => {
    if (!response.body) {
        throw new Error('Export response had no body');
    }
    let writable: WritableStream<Uint8Array>;
    try {
        writable = await destination.fileHandle.createWritable();
    } catch (error) {
        await response.body.cancel().catch(() => undefined);
        throw error;
    }
    try {
        await response.body.pipeTo(writable, { preventAbort: true });
    } catch (error) {
        await writable.abort(error).catch(() => undefined);
        throw error;
    }
};

const writeBlobDownload = async (response: Response, filename: string, dependencies: ExportDependencies) => {
    const blobUrl = dependencies.createObjectURL(await response.blob());
    try {
        dependencies.triggerDownload(blobUrl, filename);
    } finally {
        dependencies.schedule(() => dependencies.revokeObjectURL(blobUrl), BLOB_URL_REVOKE_DELAY_MS);
    }
};

const isPickerCancellation = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

const browserSaveFilePicker = () => {
    const picker: unknown = Reflect.get(window, 'showSaveFilePicker');
    if (typeof picker !== 'function') {
        return undefined;
    }
    return async (options?: SaveFilePickerOptions) => {
        const fileHandle: unknown = await Reflect.apply(picker, window, [options]);
        if (!isExportFileHandle(fileHandle)) {
            throw new Error('File picker returned an invalid handle');
        }
        return fileHandle;
    };
};

export const chooseExportDestination = async (
    platform: PlatformTab,
    picker: SaveFilePicker | undefined = browserSaveFilePicker(),
): Promise<ExportDestination | null> => {
    if (!picker) {
        return { kind: 'blob' };
    }
    try {
        const fileHandle = await picker({
            excludeAcceptAllOption: true,
            suggestedName: `dondo-${platform}-wallet.json`,
            types: [{ accept: { 'application/json': ['.json'] }, description: 'JSON wallet' }],
        });
        return { fileHandle, kind: 'file-system' };
    } catch (error) {
        if (isPickerCancellation(error)) {
            return null;
        }
        throw error;
    }
};

export const downloadPlatformExport = async (
    platform: PlatformTab,
    destination: ExportDestination,
    dependencies: ExportDependencies = browserDependencies,
) => {
    const response = await dependencies.fetchExport(`/api/${platform}/export`, {
        headers: { 'X-Dondo-Export': '1' },
        method: 'POST',
    });
    await validateExportResponse(response);
    if (destination.kind === 'file-system') {
        await writeToFileSystem(response, destination);
        return;
    }
    await writeBlobDownload(response, exportFilename(response, platform), dependencies);
};
