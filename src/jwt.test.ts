import { expect, it } from 'bun:test';
import { decodeJwtPayload } from './jwt.ts';

it('decodes only canonical JWT object payloads with valid UTF-8', () => {
    const token = (payload: Uint8Array) => `header.${Buffer.from(payload).toString('base64url')}.signature`;

    expect(decodeJwtPayload(token(Buffer.from(JSON.stringify({ sub: 'account' }))))).toEqual({ sub: 'account' });
    expect(decodeJwtPayload(token(Uint8Array.from([0xc3, 0x28])))).toBeNull();
    expect(decodeJwtPayload(`${token(Buffer.from('{}'))}.extra`)).toBeNull();
    expect(decodeJwtPayload(token(Buffer.from('[]')))).toBeNull();
});
