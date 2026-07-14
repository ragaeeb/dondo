import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { vaultKey } from './secret.ts';

const VERSION_PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const resolveKey = async (key?: Buffer) => {
    const resolved = key ?? (await vaultKey());
    if (resolved.byteLength !== 32) {
        throw new Error(`Vault encryption key must be 32 bytes; received ${resolved.byteLength}`);
    }
    return resolved;
};

export const seal = async (text: string, key?: Buffer) => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', await resolveKey(key), iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `${VERSION_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
};

export const open = async (text: string, key?: Buffer) => {
    if (!text.startsWith(VERSION_PREFIX)) {
        return text;
    }

    const raw = Buffer.from(text.slice(VERSION_PREFIX.length), 'base64');
    if (raw.byteLength < IV_BYTES + AUTH_TAG_BYTES) {
        throw new Error('Encrypted vault value is malformed');
    }
    const decipher = createDecipheriv('aes-256-gcm', await resolveKey(key), raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + AUTH_TAG_BYTES)), decipher.final()]).toString('utf8');
};
