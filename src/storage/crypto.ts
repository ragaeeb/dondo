import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type VaultKeyMode, vaultKey } from './secret.ts';

export type VaultKeyProvider = (mode: VaultKeyMode) => Promise<Buffer>;

const VERSION_PREFIX = 'enc:v2:';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const assertKey = (key: Buffer) => {
    const resolved = key;
    if (resolved.byteLength !== 32) {
        throw new Error(`Vault encryption key must be 32 bytes; received ${resolved.byteLength}`);
    }
    return resolved;
};

export const resolveVaultKey = async (mode: VaultKeyMode, key?: Buffer, keyProvider: VaultKeyProvider = vaultKey) => {
    return assertKey(key ?? (await keyProvider(mode)));
};

export const isCurrentVaultCiphertext = (value: unknown): value is string => {
    return typeof value === 'string' && value.startsWith(VERSION_PREFIX);
};

export const seal = (text: string, key: Buffer, associatedData: string) => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', assertKey(key), iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `${VERSION_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
};

export const open = (text: string, key: Buffer, associatedData: string) => {
    if (!isCurrentVaultCiphertext(text)) {
        throw new Error('Stored vault value is not enc:v2 ciphertext');
    }

    const encoded = text.slice(VERSION_PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new Error('Encrypted vault value is malformed');
    }
    const raw = Buffer.from(encoded, 'base64');
    if (raw.toString('base64') !== encoded) {
        throw new Error('Encrypted vault value is malformed');
    }
    if (raw.byteLength < IV_BYTES + AUTH_TAG_BYTES) {
        throw new Error('Encrypted vault value is malformed');
    }
    const decipher = createDecipheriv('aes-256-gcm', assertKey(key), raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + AUTH_TAG_BYTES)), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
};
