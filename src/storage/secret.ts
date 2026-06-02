import { createHash, randomBytes } from 'node:crypto';
import { VAULT_KEY_ACCOUNT, VAULT_KEY_SERVICE } from '../config.ts';
import { isRunError, run } from '../shell.ts';

let cachedKey: Buffer | undefined;

const digestSecret = (secret: string) => createHash('sha256').update(secret).digest();

const readVaultSecret = async () => {
    return await run('security', ['find-generic-password', '-s', VAULT_KEY_SERVICE, '-a', VAULT_KEY_ACCOUNT, '-w'])
        .then(({ stdout }) => stdout.trim())
        .catch((error) => {
            if (isRunError(error) && error.code === 44) {
                return '';
            }
            throw error;
        });
};

export const vaultKey = async () => {
    if (cachedKey) {
        return cachedKey;
    }

    const found = await readVaultSecret();
    if (found) {
        cachedKey = digestSecret(found);
        return cachedKey;
    }

    const secret = randomBytes(32).toString('base64');
    await run('security', [
        'add-generic-password',
        '-s',
        VAULT_KEY_SERVICE,
        '-a',
        VAULT_KEY_ACCOUNT,
        '-w',
        secret,
    ]).catch(async (error) => {
        const racedSecret = await readVaultSecret();
        if (racedSecret) {
            return;
        }
        throw error;
    });

    cachedKey = digestSecret((await readVaultSecret()) || secret);
    return cachedKey;
};
