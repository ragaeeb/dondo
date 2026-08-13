import { expect, it } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { open } from './crypto.ts';

const TEST_KEY = Buffer.alloc(32, 5);

const sealBytes = (plaintext: Uint8Array, associatedData: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', TEST_KEY, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `enc:v2:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
};

it('should reject authenticated ciphertext whose plaintext is not valid UTF-8', () => {
    const associatedData = '["test"]';
    const ciphertext = sealBytes(new Uint8Array([0xc3, 0x28]), associatedData);

    expect(() => open(ciphertext, TEST_KEY, associatedData)).toThrow();
});

it('should reject noncanonical base64 ciphertext encodings', () => {
    const associatedData = '["test"]';
    const ciphertext = sealBytes(new Uint8Array([0x7b]), associatedData);
    const encoded = ciphertext.slice('enc:v2:'.length);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const tailIndex = alphabet.indexOf(encoded.at(-2) ?? '');
    const replacement = alphabet[(tailIndex & 0b11_1100) | ((tailIndex + 1) & 0b11)];
    const noncanonical = `enc:v2:${encoded.slice(0, -2)}${replacement}=`;

    expect(Buffer.from(noncanonical.slice('enc:v2:'.length), 'base64')).toEqual(Buffer.from(encoded, 'base64'));
    expect(() => open(noncanonical, TEST_KEY, associatedData)).toThrow('Encrypted vault value is malformed');
});
