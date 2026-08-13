import { expect, it } from 'bun:test';
import { discardResponse, readBoundedResponseJson, readBoundedResponseText } from './http.ts';

it('should cancel a response body that will not be consumed', async () => {
    let cancelled = false;
    const response = new Response(
        new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
        }),
    );

    await discardResponse(response);

    expect(cancelled).toBe(true);
});

it('should accept a response exactly at the configured byte limit', async () => {
    const text = 'éé';
    expect(await readBoundedResponseText(new Response(text), 'Test', Buffer.byteLength(text))).toBe(text);
});

it('should decode a multibyte character split across response chunks', async () => {
    const encoded = Buffer.from('€');
    const response = new Response(
        new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.enqueue(encoded.subarray(0, 1));
                controller.enqueue(encoded.subarray(1));
                controller.close();
            },
        }),
    );
    expect(await readBoundedResponseText(response, 'Provider', 3)).toBe('€');
});

it('should assemble a highly chunked response without losing bytes', async () => {
    const response = new Response(
        new ReadableStream<Uint8Array>({
            start: (controller) => {
                for (let index = 0; index < 4_096; index += 1) {
                    controller.enqueue(Uint8Array.of(97 + (index % 26)));
                }
                controller.close();
            },
        }),
    );
    const expected = Array.from({ length: 4_096 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('');

    expect(await readBoundedResponseText(response, 'Provider', 4_096)).toBe(expected);
});

it('should reject and cancel a streamed response above the byte limit', async () => {
    let cancelled = false;
    const response = new Response(
        new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
            start: (controller) => {
                controller.enqueue(Buffer.from('1234'));
                controller.enqueue(Buffer.from('5'));
            },
        }),
    );

    await expect(readBoundedResponseText(response, 'Provider', 4)).rejects.toThrow(
        'Provider response exceeded the 1 MiB size limit',
    );
    expect(cancelled).toBe(true);
});

it('should reject declared oversized responses and cancel without reading', async () => {
    let cancelled = false;
    const response = new Response(
        new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
        }),
        { headers: { 'content-length': '5' } },
    );
    await expect(readBoundedResponseText(response, 'Provider', 4)).rejects.toThrow('size limit');
    expect(cancelled).toBe(true);
});

it('should reject invalid UTF-8 and invalid byte limits without exposing content', async () => {
    await expect(readBoundedResponseText(new Response(Uint8Array.from([0xc3, 0x28])), 'Provider', 2)).rejects.toThrow(
        'Provider response was not valid UTF-8',
    );
    await expect(readBoundedResponseText(new Response('ok'), 'Provider', Number.NaN)).rejects.toThrow(
        'non-negative safe integer',
    );
    await expect(readBoundedResponseText(new Response('ok'), 'Provider', -1)).rejects.toThrow(
        'non-negative safe integer',
    );
});

it('should parse bounded JSON and redact malformed response content', async () => {
    await expect(readBoundedResponseJson(new Response('{'), 'Codex')).rejects.toThrow(
        'Codex response was not valid JSON',
    );
    await expect(readBoundedResponseJson<{ ok: boolean }>(Response.json({ ok: true }), 'Codex')).resolves.toEqual({
        ok: true,
    });
});
