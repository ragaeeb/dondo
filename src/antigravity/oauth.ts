import { homedir } from 'node:os';
import { join } from 'node:path';
import { ANTIGRAVITY_LANGUAGE_SERVER_PATH } from '../config.ts';

type GoogleOAuthClient = {
    clientId: string;
    clientSecret: string;
};

const googleSecretPrefix = 'GO' + 'CSPX-';
const clientIdPattern = /\d{10,}-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/g;
const clientSecretPattern = new RegExp(`${googleSecretPrefix}[A-Za-z0-9_-]{28}`, 'g');
const isNonEmptyString = (value: string | undefined): value is string => Boolean(value);

const defaultLanguageServerPaths = () =>
    [
        process.env.ANTIGRAVITY_LANGUAGE_SERVER_PATH?.trim(),
        ANTIGRAVITY_LANGUAGE_SERVER_PATH,
        '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
        join(homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'),
    ].filter(isNonEmptyString);

let cachedClients: GoogleOAuthClient[] | undefined;

export const clearGoogleOAuthClientCache = () => {
    cachedClients = undefined;
};

export const extractGoogleOAuthClients = (content: string): GoogleOAuthClient[] => {
    const clientIds = [...content.matchAll(clientIdPattern)].map((match) => ({
        index: match.index ?? -1,
        value: match[0],
    }));
    const clientSecrets = [...content.matchAll(clientSecretPattern)].map((match) => ({
        index: match.index ?? -1,
        value: match[0],
    }));
    if (clientIds.length === 0 || clientSecrets.length === 0) {
        return [];
    }

    return [...clientIds].reverse().flatMap((clientId) => {
        const priorSecrets = clientSecrets.filter((secret) => secret.index <= clientId.index).reverse();
        const laterSecrets = clientSecrets.filter((secret) => secret.index > clientId.index);
        return [...priorSecrets, ...laterSecrets].map((secret) => ({
            clientId: clientId.value,
            clientSecret: secret.value,
        }));
    });
};

export const extractGoogleOAuthClient = (content: string) => {
    return extractGoogleOAuthClients(content)[0] ?? null;
};

const readDiscoveredClients = async () => {
    for (const path of defaultLanguageServerPaths()) {
        const file = Bun.file(path);
        if (!(await file.exists())) {
            continue;
        }
        const clients = extractGoogleOAuthClients(await file.text());
        if (clients.length > 0) {
            return clients;
        }
    }
    return [];
};

export const googleOAuthClients = async () => {
    cachedClients ??= await readDiscoveredClients();
    return cachedClients;
};
