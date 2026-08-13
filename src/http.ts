export const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;

const sizeLabel = (maxBytes: number) => {
    if (maxBytes > 0 && maxBytes % (1024 * 1024) === 0) {
        return `${maxBytes / (1024 * 1024)} MiB`;
    }
    return `${maxBytes} ${maxBytes === 1 ? 'byte' : 'bytes'}`;
};

const sizeError = (label: string, maxBytes: number) =>
    new Error(`${label} response exceeded the ${sizeLabel(maxBytes)} size limit`);
const invalidUtf8Error = (label: string) => new Error(`${label} response was not valid UTF-8`);

const assertMaxBytes = (maxBytes: number) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new Error('HTTP response byte limit must be a non-negative safe integer');
    }
};

export const discardResponse = async (response: Response) => {
    await response.body?.cancel().catch(() => {});
};

export const readBoundedResponseText = async (
    response: Response,
    label: string,
    maxBytes = MAX_HTTP_RESPONSE_BYTES,
) => {
    assertMaxBytes(maxBytes);
    const contentLengthHeader = response.headers.get('content-length');
    const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
    if (Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength > maxBytes) {
        await discardResponse(response);
        throw sizeError(label, maxBytes);
    }
    if (!response.body) {
        return '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const chunks: string[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                try {
                    chunks.push(decoder.decode());
                    return chunks.join('');
                } catch {
                    throw invalidUtf8Error(label);
                }
            }
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel().catch(() => {});
                throw sizeError(label, maxBytes);
            }
            try {
                chunks.push(decoder.decode(value, { stream: true }));
            } catch {
                await reader.cancel().catch(() => {});
                throw invalidUtf8Error(label);
            }
        }
    } finally {
        reader.releaseLock();
    }
};

export const readBoundedResponseJson = async <Result>(
    response: Response,
    label: string,
    maxBytes = MAX_HTTP_RESPONSE_BYTES,
): Promise<Result> => {
    const text = await readBoundedResponseText(response, label, maxBytes);
    try {
        return JSON.parse(text) as Result;
    } catch {
        throw new Error(`${label} response was not valid JSON`);
    }
};
