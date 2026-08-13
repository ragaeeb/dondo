import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { antigravityLanguageServerPath } from '../config.ts';

type GoogleOAuthClient = {
    clientId: string;
    clientSecret: string;
};

const googleSecretPrefix = 'GO' + 'CSPX-';
const clientIdPattern = /\d{10,}-[A-Za-z0-9_-]{1,128}\.apps\.googleusercontent\.com/g;
const clientSecretPattern = new RegExp(`${googleSecretPrefix}[A-Za-z0-9_-]{28}`, 'g');
const isNonEmptyString = (value: string | undefined): value is string => Boolean(value);
const SCAN_TAIL_BYTES = 512;
const MAX_LANGUAGE_SERVER_SCAN_BYTES = 192 * 1024 * 1024;
const MAX_DISCOVERED_VALUES = 64;
const MAX_CLIENT_CANDIDATES = 8;

type PositionedValue = {
    index: number;
    value: string;
};

const defaultLanguageServerPaths = () => [
    ...new Set(
        [
            antigravityLanguageServerPath(),
            '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
            join(homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'),
        ]
            .filter(isNonEmptyString)
            .map((path) => resolve(path)),
    ),
];

let cachedClients: Promise<GoogleOAuthClient[]> | undefined;

export const clearGoogleOAuthClientCache = () => {
    cachedClients = undefined;
};

const clientCandidates = (clientIds: PositionedValue[], clientSecrets: PositionedValue[]): GoogleOAuthClient[] => {
    if (clientIds.length === 0 || clientSecrets.length === 0) {
        return [];
    }

    return [...clientIds]
        .reverse()
        .flatMap((clientId) => {
            const priorSecrets = clientSecrets.filter((secret) => secret.index <= clientId.index).reverse();
            const laterSecrets = clientSecrets.filter((secret) => secret.index > clientId.index);
            return [...priorSecrets, ...laterSecrets].map((secret) => ({
                clientId: clientId.value,
                clientSecret: secret.value,
            }));
        })
        .slice(0, MAX_CLIENT_CANDIDATES);
};

const matches = (content: string, pattern: RegExp, offset = 0): PositionedValue[] => {
    return [...content.matchAll(pattern)].map((match) => ({
        index: offset + (match.index ?? 0),
        value: match[0],
    }));
};

export const extractGoogleOAuthClients = (content: string): GoogleOAuthClient[] => {
    return clientCandidates(matches(content, clientIdPattern), matches(content, clientSecretPattern));
};

export const extractGoogleOAuthClient = (content: string) => {
    return extractGoogleOAuthClients(content)[0] ?? null;
};

const appendUniqueMatches = (values: PositionedValue[], additions: PositionedValue[]) => {
    for (const addition of additions) {
        if (!values.some((value) => value.index === addition.index && value.value === addition.value)) {
            values.push(addition);
            if (values.length > MAX_DISCOVERED_VALUES) {
                values.shift();
            }
        }
    }
};

export const scanGoogleOAuthClients = async (
    stream: ReadableStream<Uint8Array>,
    maxBytes = MAX_LANGUAGE_SERVER_SCAN_BYTES,
) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new TypeError('OAuth binary scan byte limit must be a non-negative safe integer');
    }
    const clientIds: PositionedValue[] = [];
    const clientSecrets: PositionedValue[] = [];
    const reader = stream.getReader();
    let tail = '';
    let bytesRead = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const remaining = maxBytes - bytesRead;
            if (remaining <= 0) {
                await reader.cancel();
                break;
            }
            const boundedValue = value.subarray(0, remaining);
            const chunk = Buffer.from(boundedValue).toString('latin1');
            const content = `${tail}${chunk}`;
            const offset = bytesRead - tail.length;
            appendUniqueMatches(clientIds, matches(content, clientIdPattern, offset));
            appendUniqueMatches(clientSecrets, matches(content, clientSecretPattern, offset));
            bytesRead += boundedValue.byteLength;
            tail = content.slice(-SCAN_TAIL_BYTES);
            if (boundedValue.byteLength < value.byteLength || bytesRead >= maxBytes) {
                await reader.cancel();
                break;
            }
        }
    } finally {
        reader.releaseLock();
    }

    return clientCandidates(clientIds, clientSecrets);
};

const readDiscoveredClients = async () => {
    for (const path of defaultLanguageServerPaths()) {
        const file = Bun.file(path);
        if (!(await file.exists())) {
            continue;
        }
        const clients = await scanGoogleOAuthClients(file.stream());
        if (clients.length > 0) {
            return clients;
        }
    }
    return [];
};

export const googleOAuthClients = async () => {
    const discovery = cachedClients ?? readDiscoveredClients();
    cachedClients = discovery;
    try {
        return await discovery;
    } catch (error) {
        if (cachedClients === discovery) {
            cachedClients = undefined;
        }
        throw error;
    }
};
