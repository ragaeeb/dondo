import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { link, mkdir, open as openFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { VAULT_PATH } from '../config.ts';
import { assertAccountKey, publicError, redactSecrets } from '../errors.ts';
import type {
    ClineVault,
    CodexVault,
    KiroVault,
    LimitCache,
    LimitResult,
    MinimaxVault,
    ModelLimit,
    PlatformVault,
    VaultCorruption,
    VaultSection,
} from '../types.ts';
import { isCurrentVaultCiphertext, open, resolveVaultKey, seal, type VaultKeyProvider } from './crypto.ts';
import { MAX_LOCAL_CREDENTIAL_FILE_BYTES, readBoundedTextFile, writePrivateFile } from './file.ts';

type VaultPlatform = 'antigravity' | 'cline' | 'codex' | 'kiro' | 'minimax';

type PlatformSection<Platform extends VaultPlatform> = Platform extends 'antigravity'
    ? PlatformVault
    : Platform extends 'cline'
      ? ClineVault
      : Platform extends 'codex'
        ? CodexVault
        : Platform extends 'kiro'
          ? KiroVault
          : MinimaxVault;

type VaultUpdate<T> = {
    result: T;
    write?: boolean;
};

type StoredSection = {
    data: Record<string, unknown>;
    limits: VaultSection<unknown>['limits'];
};

type StoredVault = Record<string, unknown>;

type DecodedSection<Platform extends VaultPlatform> = {
    damaged: Record<string, unknown>;
    healthy: Record<string, HealthyEntry>;
    section: PlatformSection<Platform>;
};

type SecretField = {
    name: string;
    optional?: boolean;
    secret?: boolean;
    timestamp?: boolean;
};

type PlatformCodec = {
    fields: readonly SecretField[];
};

type HealthyEntry = {
    digest: string;
    raw: unknown;
};

const PLATFORM_CODECS: Record<VaultPlatform, PlatformCodec> = {
    antigravity: {
        fields: [
            { name: 'account' },
            { name: 'createdAt', timestamp: true },
            { name: 'identity', secret: true },
            { name: 'kind' },
            { name: 'label' },
            { name: 'password', secret: true },
            { name: 'service' },
            { name: 'updatedAt', timestamp: true },
        ],
    },
    cline: {
        fields: [
            { name: 'createdAt', timestamp: true },
            { name: 'secrets', secret: true },
            { name: 'updatedAt', timestamp: true },
        ],
    },
    codex: {
        fields: [
            { name: 'auth', secret: true },
            { name: 'createdAt', timestamp: true },
            { name: 'updatedAt', timestamp: true },
        ],
    },
    kiro: {
        fields: [
            { name: 'auth', secret: true },
            { name: 'clientRegistration', optional: true, secret: true },
            { name: 'createdAt', timestamp: true },
            { name: 'profile', optional: true, secret: true },
            { name: 'updatedAt', timestamp: true },
        ],
    },
    minimax: {
        fields: [
            { name: 'config', secret: true },
            { name: 'createdAt', timestamp: true },
            { name: 'realUserId', optional: true, secret: true },
            { name: 'updatedAt', timestamp: true },
        ],
    },
};

const VAULT_PLATFORMS = new Set<VaultPlatform>(['antigravity', 'cline', 'codex', 'kiro', 'minimax']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Vaults contain credentials, but remain bounded so a malformed local file cannot force an unbounded read.
export const MAX_VAULT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_VAULT_METADATA_FIELD_BYTES = 4 * 1024;
export const MAX_VAULT_ACCOUNTS_PER_PLATFORM = 4_096;
export const MAX_VAULT_MODELS_PER_ACCOUNT = 256;
export const VAULT_LOCK_TIMEOUT_MS = 2_000;

const VAULT_LOCK_RETRY_MS = 25;
const VAULT_LOCK_STALE_MS = 2 * 60 * 1000;
const VAULT_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VAULT_RECOVERY_INVALID_STALE_MS = 250;

const vaultQueues = new Map<string, Promise<void>>();

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
    return isRecord(value) && typeof value.then === 'function';
};

const assertExactKeys = (value: Record<string, unknown>, keys: readonly string[], path: string, detail: string) => {
    const allowed = new Set(keys);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
        return invalidVaultShape(path, detail);
    }
};

const invalidVaultShape = (path: string, detail: string): never => {
    throw publicError(500, `Vault file has an invalid ${detail}: ${path}`);
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const validTimestamp = (value: string, allowEmpty = false) => {
    if (value === '') {
        return allowEmpty;
    }
    if (!ISO_INSTANT.test(value)) {
        return false;
    }
    const components = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (!components) {
        return false;
    }
    const [, year, month, day, hour, minute, second] = components.map(Number);
    if (
        year === undefined ||
        month === undefined ||
        day === undefined ||
        hour === undefined ||
        minute === undefined ||
        second === undefined ||
        month < 1 ||
        month > 12 ||
        hour > 23 ||
        minute > 59 ||
        second > 59
    ) {
        return false;
    }
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
    return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
};

const boundedText = (value: unknown, path: string, detail: string, maxBytes = MAX_VAULT_METADATA_FIELD_BYTES) => {
    if (typeof value !== 'string') {
        return invalidVaultShape(path, detail);
    }
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
        return invalidVaultShape(path, detail);
    }
    return value;
};

const storedText = (value: unknown, path: string) => {
    const text = boundedText(value, path, 'cached limits');
    return redactSecrets(text);
};

const timestampText = (value: unknown, path: string, detail: string, allowEmpty = false) => {
    const text = boundedText(value, path, detail);
    if (!validTimestamp(text, allowEmpty)) {
        return invalidVaultShape(path, detail);
    }
    return text;
};

const storedTimestamp = (value: unknown, path: string, allowEmpty = false) => {
    const text = timestampText(value, path, 'cached limits', allowEmpty);
    return text;
};

const percentage = (value: unknown, path: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        return invalidVaultShape(path, 'cached limits');
    }
    return value;
};

const optionalNonNegativeNumber = (value: unknown, path: string) => {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return invalidVaultShape(path, 'cached limits');
    }
    return value;
};

const normalizeModelLimit = (value: unknown, path: string): ModelLimit => {
    if (!isRecord(value)) {
        return invalidVaultShape(path, 'cached limits');
    }
    assertExactKeys(
        value,
        ['detail', 'displayName', 'limit', 'percentage', 'resetTime', 'used'],
        path,
        'cached limits',
    );
    const detail = value.detail === undefined ? undefined : storedText(value.detail, path);
    const limit = optionalNonNegativeNumber(value.limit, path);
    const used = optionalNonNegativeNumber(value.used, path);
    return {
        displayName: storedText(value.displayName, path),
        percentage: percentage(value.percentage, path),
        resetTime: storedTimestamp(value.resetTime, path, true),
        ...(detail === undefined ? {} : { detail }),
        ...(limit === undefined ? {} : { limit }),
        ...(used === undefined ? {} : { used }),
    };
};

const normalizeQuota = (value: unknown, path: string): LimitResult => {
    if (!isRecord(value) || typeof value.ok !== 'boolean') {
        return invalidVaultShape(path, 'cached limits');
    }
    if (!value.ok) {
        assertExactKeys(value, ['error', 'ok'], path, 'cached limits');
        return { error: storedText(value.error, path), ok: false };
    }
    assertExactKeys(value, ['expires', 'models', 'ok', 'tier'], path, 'cached limits');
    if (!isRecord(value.models)) {
        return invalidVaultShape(path, 'cached limits');
    }
    if (Object.keys(value.models).length > MAX_VAULT_MODELS_PER_ACCOUNT) {
        return invalidVaultShape(path, 'cached limits');
    }
    return {
        expires: storedTimestamp(value.expires, path, true),
        models: Object.fromEntries(
            Object.entries(value.models).map(([name, model]) => [
                redactSecrets(boundedText(name, path, 'cached limits')),
                normalizeModelLimit(model, path),
            ]),
        ),
        ok: true,
        tier: storedText(value.tier, path),
    };
};

const normalizeLimits = (value: unknown, path: string): Record<string, LimitCache> => {
    if (!isRecord(value)) {
        return invalidVaultShape(path, 'cached limits');
    }
    if (Object.keys(value).length > MAX_VAULT_ACCOUNTS_PER_PLATFORM) {
        return invalidVaultShape(path, 'cached limits');
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, cache]) => {
            if (!isRecord(cache)) {
                return invalidVaultShape(path, 'cached limits');
            }
            assertExactKeys(cache, ['fetchedAt', 'quota'], path, 'cached limits');
            return [
                key,
                {
                    fetchedAt: storedTimestamp(cache.fetchedAt, path),
                    quota: normalizeQuota(cache.quota, path),
                },
            ];
        }),
    );
};

const assertStoredAccountKey = (key: string, path: string) => {
    try {
        return assertAccountKey(key);
    } catch {
        return invalidVaultShape(path, 'stored account key');
    }
};

const normalizeStoredSection = (
    value: unknown,
    platform: VaultPlatform,
    path: string,
    requireFields = true,
): StoredSection => {
    if (!isRecord(value)) {
        return invalidVaultShape(path, `${platform} section`);
    }
    assertExactKeys(value, ['data', 'limits'], path, `${platform} section`);
    if (requireFields && (!Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'limits'))) {
        return invalidVaultShape(path, `${platform} section`);
    }
    if (value.data !== undefined && !isRecord(value.data)) {
        return invalidVaultShape(path, `${platform}.data section`);
    }
    if (value.limits !== undefined && !isRecord(value.limits)) {
        return invalidVaultShape(path, `${platform}.limits section`);
    }
    const data = (value.data ?? {}) as Record<string, unknown>;
    if (Object.keys(data).length > MAX_VAULT_ACCOUNTS_PER_PLATFORM) {
        return invalidVaultShape(path, `${platform}.data section`);
    }
    for (const key of Object.keys(data)) {
        assertStoredAccountKey(key, path);
    }
    const limits = normalizeLimits(value.limits ?? {}, path);
    for (const key of Object.keys(limits)) {
        assertStoredAccountKey(key, path);
        if (!Object.hasOwn(data, key)) {
            return invalidVaultShape(path, 'orphan cached limits');
        }
    }
    return { data, limits };
};

const normalizeStoredVault = (raw: unknown, path: string): StoredVault => {
    if (!isRecord(raw)) {
        return invalidVaultShape(path, 'top-level shape');
    }
    for (const key of Object.keys(raw)) {
        if (RESERVED_KEYS.has(key) || !VAULT_PLATFORMS.has(key as VaultPlatform)) {
            return invalidVaultShape(path, 'top-level key');
        }
        normalizeStoredSection(raw[key], key as VaultPlatform, path);
    }
    return { ...raw };
};

const platformSection = (stored: StoredVault, platform: VaultPlatform, path: string) => {
    const value = stored[platform];
    return normalizeStoredSection(value === undefined ? {} : value, platform, path, value !== undefined);
};

const entryHasCurrentCiphertext = (entry: unknown, codec: PlatformCodec) => {
    return isRecord(entry) && codec.fields.some((field) => field.secret && isCurrentVaultCiphertext(entry[field.name]));
};

const storedVaultHasCurrentCiphertext = (stored: StoredVault) => {
    for (const platform of VAULT_PLATFORMS) {
        const section = stored[platform];
        if (!isRecord(section) || !isRecord(section.data)) {
            continue;
        }
        if (Object.values(section.data).some((entry) => entryHasCurrentCiphertext(entry, PLATFORM_CODECS[platform]))) {
            return true;
        }
    }
    return false;
};

const queueVaultOperation = <T>(path: string, operation: () => Promise<T>) => {
    const queueKey = resolve(path);
    const previous = vaultQueues.get(queueKey) ?? Promise.resolve();
    const queued = previous.then(operation);
    const tail = queued.then(
        () => undefined,
        () => undefined,
    );
    vaultQueues.set(queueKey, tail);
    void tail.then(() => {
        if (vaultQueues.get(queueKey) === tail) {
            vaultQueues.delete(queueKey);
        }
    });
    return queued;
};

const errorCode = (error: unknown) => {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
};

const processIsAlive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errorCode(error) !== 'ESRCH';
    }
};

type LockSnapshot = {
    createdAt?: unknown;
    pid?: unknown;
    token?: unknown;
};

const lockOwnerPid = (metadata: LockSnapshot) => {
    const pid = metadata.pid;
    const token = metadata.token;
    const createdAt = metadata.createdAt;
    return typeof pid === 'number' &&
        Number.isInteger(pid) &&
        pid > 0 &&
        typeof token === 'string' &&
        token.length > 0 &&
        typeof createdAt === 'number' &&
        Number.isFinite(createdAt)
        ? pid
        : undefined;
};

const sameFile = (left: Stats, right: Stats) => {
    return left.dev === right.dev && left.ino === right.ino;
};

const staleLock = async (lockPath: string, invalidStaleMs = VAULT_LOCK_STALE_MS) => {
    try {
        const before = await stat(lockPath);
        const metadataText = await readBoundedTextFile(lockPath, { label: 'Vault lock file', maxBytes: 1024 });
        const after = await stat(lockPath);
        if (!sameFile(before, after)) {
            return null;
        }
        const metadata = JSON.parse(metadataText ?? '{}') as LockSnapshot;
        const pid = lockOwnerPid(metadata);
        const ageMs = Date.now() - after.mtimeMs;
        const stale =
            ageMs > VAULT_LOCK_MAX_AGE_MS || (pid === undefined ? ageMs > invalidStaleMs : !processIsAlive(pid));
        return stale ? after : null;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return null;
        }
        const lockStat = await stat(lockPath).catch(() => null);
        return lockStat && Date.now() - lockStat.mtimeMs > invalidStaleMs ? lockStat : null;
    }
};

const recoverStaleLock = async (lockPath: string) => {
    const stale = await staleLock(lockPath);
    if (!stale) {
        return false;
    }
    const stalePath = `${lockPath}.${randomUUID()}.stale`;
    try {
        const current = await stat(lockPath);
        if (!sameFile(stale, current)) {
            return false;
        }
        await rename(lockPath, stalePath);
        await rm(stalePath, { force: true });
        return true;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return true;
        }
        throw error;
    }
};

const recoveryPath = (lockPath: string) => `${lockPath}.recovery`;

const recoverCrashedGate = async (gatePath: string) => {
    const stale = await staleLock(gatePath, VAULT_RECOVERY_INVALID_STALE_MS);
    if (!stale) {
        return false;
    }
    const stalePath = `${gatePath}.${randomUUID()}.stale`;
    try {
        const current = await stat(gatePath);
        if (!sameFile(stale, current)) {
            return false;
        }
        await rename(gatePath, stalePath);
        await rm(stalePath, { force: true });
        return true;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return true;
        }
        throw error;
    }
};

const withRecoveryGate = async <T>(lockPath: string, operation: () => Promise<T>): Promise<T | undefined> => {
    const token = randomUUID();
    const gatePath = recoveryPath(lockPath);
    const candidatePath = `${gatePath}.${process.pid}.${token}.candidate`;
    let candidate: Awaited<ReturnType<typeof openFile>> | undefined;
    let ownership: Stats | undefined;
    let published = false;
    try {
        candidate = await openFile(candidatePath, 'wx', 0o600);
        await candidate.writeFile(JSON.stringify({ createdAt: Date.now(), pid: process.pid, token }), 'utf8');
        await candidate.sync();
        try {
            await link(candidatePath, gatePath);
        } catch (error) {
            if (errorCode(error) === 'EEXIST') {
                await recoverCrashedGate(gatePath);
                return undefined;
            }
            throw error;
        }
        published = true;
        ownership = await stat(gatePath);
        await rm(candidatePath, { force: true });
        return await operation();
    } finally {
        await candidate?.close().catch(() => undefined);
        await rm(candidatePath, { force: true }).catch(() => undefined);
        if (published) {
            const current = await stat(gatePath).catch(() => null);
            const metadataText = current
                ? await readBoundedTextFile(gatePath, {
                      label: 'Vault recovery lock file',
                      maxBytes: 1024,
                  }).catch(() => null)
                : null;
            let currentToken: unknown;
            try {
                currentToken = (JSON.parse(metadataText ?? '{}') as LockSnapshot).token;
            } catch {
                currentToken = undefined;
            }
            if (current && ownership && sameFile(ownership, current) && currentToken === token) {
                await rm(gatePath, { force: true });
            }
        }
    }
};

const recoveryInProgress = async (lockPath: string) => {
    const gatePath = recoveryPath(lockPath);
    if (!(await Bun.file(gatePath).exists())) {
        return false;
    }
    await recoverCrashedGate(gatePath);
    return Bun.file(gatePath).exists();
};

const releaseOwnedLock = async (lockPath: string, ownership: Stats, token: string) => {
    const deadline = Date.now() + VAULT_LOCK_TIMEOUT_MS;
    for (;;) {
        const released = await withRecoveryGate(lockPath, async () => {
            const current = await stat(lockPath).catch(() => null);
            if (!current || !sameFile(ownership, current)) {
                return true;
            }
            const metadataText = await readBoundedTextFile(lockPath, {
                label: 'Vault lock file',
                maxBytes: 1024,
            }).catch(() => null);
            if (metadataText === null) {
                return false;
            }
            let currentToken: unknown;
            try {
                currentToken = (JSON.parse(metadataText) as LockSnapshot).token;
            } catch {
                return false;
            }
            if (currentToken !== token) {
                return false;
            }
            await rm(lockPath, { force: true });
            return true;
        });
        if (released) {
            return;
        }
        if (Date.now() >= deadline) {
            throw publicError(503, 'Vault lock cleanup is busy in another Dondo process; try again');
        }
        await Bun.sleep(VAULT_LOCK_RETRY_MS);
    }
};

const recoverStaleLockSafely = async (lockPath: string) => {
    return (await withRecoveryGate(lockPath, () => recoverStaleLock(lockPath))) ?? false;
};

const publishLock = async (lockPath: string, token: string) => {
    const candidatePath = `${lockPath}.${process.pid}.${token}.candidate`;
    let handle: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
        handle = await openFile(candidatePath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ createdAt: Date.now(), pid: process.pid, token }), 'utf8');
        await handle.sync();
        const ownership = await handle.stat();
        try {
            await link(candidatePath, lockPath);
        } catch (error) {
            if (errorCode(error) === 'EEXIST') {
                await handle.close();
                handle = undefined;
                return null;
            }
            throw error;
        }
        await rm(candidatePath, { force: true }).catch(() => undefined);
        return { candidatePath, handle, ownership };
    } catch (error) {
        await handle?.close().catch(() => undefined);
        throw error;
    } finally {
        await rm(candidatePath, { force: true }).catch(() => undefined);
    }
};

const closePublishedLock = async (
    lockPath: string,
    published: NonNullable<Awaited<ReturnType<typeof publishLock>>>,
    token: string,
) => {
    try {
        await published.handle.close();
    } finally {
        try {
            await releaseOwnedLock(lockPath, published.ownership, token);
        } finally {
            await rm(published.candidatePath, { force: true });
        }
    }
};

const createVaultLock = async (lockPath: string) => {
    if (await recoveryInProgress(lockPath)) {
        return null;
    }
    const token = randomUUID();
    const published = await publishLock(lockPath, token);
    if (!published) {
        return null;
    }
    if (await recoveryInProgress(lockPath)) {
        await closePublishedLock(lockPath, published, token);
        return null;
    }
    return () => closePublishedLock(lockPath, published, token);
};

const acquireVaultLock = async (path: string) => {
    const lockPath = `${path}.lock`;
    const deadline = Date.now() + VAULT_LOCK_TIMEOUT_MS;
    await mkdir(dirname(path), { recursive: true });
    for (;;) {
        const release = await createVaultLock(lockPath);
        if (release) {
            return release;
        }

        if (await recoverStaleLockSafely(lockPath)) {
            continue;
        }
        if (Date.now() >= deadline) {
            throw publicError(503, 'Vault is busy in another Dondo process; try again');
        }
        await Bun.sleep(VAULT_LOCK_RETRY_MS);
    }
};

const withVaultLock = async <T>(path: string, operation: () => Promise<T>) => {
    const release = await acquireVaultLock(path);
    try {
        return await operation();
    } finally {
        await release();
    }
};

const readStoredVault = async (path: string): Promise<StoredVault> => {
    const text = await readBoundedTextFile(path, {
        errorStatus: 500,
        label: 'Vault file',
        maxBytes: MAX_VAULT_FILE_BYTES,
    });
    if (text === null) {
        return normalizeStoredVault({}, path);
    }
    let parsed: unknown;
    try {
        parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
        throw publicError(500, `Vault file is not valid JSON: ${path}`);
    }
    return normalizeStoredVault(parsed, path);
};

const corruption = (): VaultCorruption => ({
    corrupted: true,
    error: 'Stored encrypted credentials could not be opened',
});

const snapshotText = (field: SecretField, value: unknown, plaintextSecret: boolean) => {
    if (typeof value !== 'string') {
        throw new Error('Stored account field is not a string');
    }
    if (field.secret) {
        if (plaintextSecret && Buffer.byteLength(value, 'utf8') > MAX_LOCAL_CREDENTIAL_FILE_BYTES) {
            throw new Error('Stored account secret exceeds the 1 MiB size limit');
        }
        return value;
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_VAULT_METADATA_FIELD_BYTES) {
        throw new Error('Stored account metadata exceeds the 4 KiB size limit');
    }
    if (field.timestamp && !validTimestamp(value)) {
        throw new Error('Stored account timestamp is invalid');
    }
    return value;
};

const validateEntry = (rawEntry: unknown, codec: PlatformCodec, plaintextSecrets: boolean) => {
    if (!isRecord(rawEntry)) {
        throw new Error('Stored account entry is not an object');
    }
    const allowedFields = new Set(codec.fields.map((field) => field.name));
    if (Object.keys(rawEntry).some((name) => !allowedFields.has(name))) {
        throw new Error('Stored account entry has unexpected fields');
    }
    const entry: Record<string, string> = {};
    for (const field of codec.fields) {
        const value = rawEntry[field.name];
        if (value === undefined && field.optional) {
            continue;
        }
        entry[field.name] = snapshotText(field, value, plaintextSecrets);
    }
    return entry;
};

const associatedData = (
    platform: VaultPlatform,
    accountKey: string,
    secretField: string,
    entry: Record<string, string>,
    codec: PlatformCodec,
) => {
    const metadata = codec.fields
        .filter((field) => !field.secret)
        .map((field) => [field.name, entry[field.name]] as const);
    return JSON.stringify(['dondo-vault', 2, platform, accountKey, secretField, metadata]);
};

const entryDigest = (entry: Record<string, string>, codec: PlatformCodec) => {
    const digest = createHash('sha256');
    for (const field of codec.fields) {
        const value = entry[field.name];
        digest.update(`${Buffer.byteLength(field.name, 'utf8')}:`);
        digest.update(field.name, 'utf8');
        if (value === undefined) {
            digest.update(':absent;');
            continue;
        }
        digest.update(`:${Buffer.byteLength(value, 'utf8')}:`);
        digest.update(value, 'utf8');
        digest.update(';');
    }
    return digest.digest('hex');
};

const transformEntry = async (
    platform: VaultPlatform,
    accountKey: string,
    rawEntry: unknown,
    codec: PlatformCodec,
    plaintextInput: boolean,
    transform: (value: string, context: string) => Promise<string> | string,
) => {
    const input = validateEntry(rawEntry, codec, plaintextInput);
    const entry: Record<string, string> = {};
    for (const field of codec.fields) {
        const value = input[field.name];
        if (value === undefined) {
            if (field.optional) {
                continue;
            }
            throw new Error('Stored account field is missing');
        }
        const transformed = field.secret
            ? await transform(value, associatedData(platform, accountKey, field.name, input, codec))
            : value;
        entry[field.name] = field.secret && !plaintextInput ? snapshotText(field, transformed, true) : transformed;
    }
    return entry;
};

const decodeSection = async <Platform extends VaultPlatform>(
    platform: Platform,
    stored: StoredSection,
    key?: Buffer,
    keyProvider?: VaultKeyProvider,
): Promise<DecodedSection<Platform>> => {
    const data: Record<string, unknown> = {};
    const damaged: Record<string, unknown> = {};
    const healthy: Record<string, HealthyEntry> = {};
    const corruptions: Record<string, VaultCorruption> = {};
    const codec = PLATFORM_CODECS[platform];
    const entries = Object.entries(stored.data);
    const needsExistingKey = entries.some(([, entry]) => entryHasCurrentCiphertext(entry, codec));
    const effectiveKey = needsExistingKey ? await resolveVaultKey('existing', key, keyProvider) : undefined;

    for (const [accountKey, rawEntry] of entries) {
        try {
            const decoded = await transformEntry(platform, accountKey, rawEntry, codec, false, (value, context) => {
                if (!isCurrentVaultCiphertext(value) || !effectiveKey) {
                    throw new Error('Stored vault value is not enc:v2 ciphertext');
                }
                return open(value, effectiveKey, context);
            });
            data[accountKey] = decoded;
            healthy[accountKey] = { digest: entryDigest(decoded, codec), raw: rawEntry };
        } catch {
            damaged[accountKey] = rawEntry;
            corruptions[accountKey] = corruption();
        }
    }

    const section = {
        data,
        limits: stored.limits,
        ...(Object.keys(corruptions).length > 0 ? { corruptions } : {}),
    } as PlatformSection<Platform>;
    return { damaged, healthy, section };
};

const validateMutatedSection = <Platform extends VaultPlatform>(
    section: PlatformSection<Platform>,
    damaged: Record<string, unknown>,
    path: string,
) => {
    if (!isRecord(section.data) || !isRecord(section.limits)) {
        return invalidVaultShape(path, 'updated platform section');
    }
    if (Object.keys(section.data).length > MAX_VAULT_ACCOUNTS_PER_PLATFORM) {
        return invalidVaultShape(path, 'updated platform section');
    }
    for (const accountKey of Object.keys(section.data)) {
        assertStoredAccountKey(accountKey, path);
    }
    const limits = normalizeLimits(section.limits, path);
    for (const accountKey of Object.keys(limits)) {
        assertStoredAccountKey(accountKey, path);
        const preservedDamage = Object.hasOwn(damaged, accountKey) && section.corruptions?.[accountKey];
        if (!Object.hasOwn(section.data, accountKey) && !preservedDamage) {
            return invalidVaultShape(path, 'orphan cached limits');
        }
    }
    return limits;
};

const encodeSection = async <Platform extends VaultPlatform>(
    platform: Platform,
    section: PlatformSection<Platform>,
    damaged: Record<string, unknown>,
    healthy: Record<string, HealthyEntry>,
    hadCurrentCiphertext: boolean,
    path: string,
    key?: Buffer,
    keyProvider?: VaultKeyProvider,
): Promise<StoredSection> => {
    const codec = PLATFORM_CODECS[platform];
    const limits = validateMutatedSection(section, damaged, path);
    const plans = Object.entries(section.data).map(([accountKey, rawEntry]) => {
        const entry = validateEntry(rawEntry, codec, true);
        const digest = entryDigest(entry, codec);
        return { accountKey, digest, entry, reusable: healthy[accountKey]?.digest === digest };
    });
    const needsKey = plans.some((plan) => !plan.reusable);
    const keyMode = hadCurrentCiphertext ? 'existing' : 'create';
    const effectiveKey = needsKey ? await resolveVaultKey(keyMode, key, keyProvider) : undefined;
    const encrypted: Record<string, unknown> = {};
    for (const plan of plans) {
        if (plan.reusable) {
            encrypted[plan.accountKey] = healthy[plan.accountKey]?.raw;
            continue;
        }
        encrypted[plan.accountKey] = await transformEntry(
            platform,
            plan.accountKey,
            plan.entry,
            codec,
            true,
            (value, context) => seal(value, effectiveKey as Buffer, context),
        );
    }
    const preservedDamage = Object.fromEntries(
        Object.entries(damaged).filter(
            ([accountKey]) => section.corruptions?.[accountKey] && !Object.hasOwn(encrypted, accountKey),
        ),
    );
    return {
        data: { ...encrypted, ...preservedDamage },
        limits,
    };
};

const writeStoredVault = async (stored: StoredVault, path: string) => {
    const text = `${JSON.stringify(stored, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_VAULT_FILE_BYTES) {
        throw publicError(500, 'Vault file exceeds the 16 MiB size limit');
    }
    await writePrivateFile(path, text);
};

export const readVaultSection = async <Platform extends VaultPlatform>(
    platform: Platform,
    path = VAULT_PATH,
    key?: Buffer,
    keyProvider?: VaultKeyProvider,
): Promise<PlatformSection<Platform>> => {
    return queueVaultOperation(path, () =>
        withVaultLock(path, async () => {
            const stored = await readStoredVault(path);
            return (await decodeSection(platform, platformSection(stored, platform, path), key, keyProvider)).section;
        }),
    );
};

export const updateVaultSection = async <Platform extends VaultPlatform, T>(
    platform: Platform,
    operation: (section: PlatformSection<Platform>) => VaultUpdate<T>,
    path = VAULT_PATH,
    key?: Buffer,
    keyProvider?: VaultKeyProvider,
) => {
    return queueVaultOperation(path, () =>
        withVaultLock(path, async () => {
            const stored = await readStoredVault(path);
            const hadCurrentCiphertext = storedVaultHasCurrentCiphertext(stored);
            const decoded = await decodeSection(platform, platformSection(stored, platform, path), key, keyProvider);
            const update: unknown = operation(decoded.section);
            if (isPromiseLike(update)) {
                throw new TypeError('Vault update callback must be synchronous');
            }
            if (!isRecord(update) || !Object.hasOwn(update, 'result')) {
                throw new TypeError('Vault update callback returned an invalid result');
            }
            if (update.write !== undefined && typeof update.write !== 'boolean') {
                throw new TypeError('Vault update callback returned an invalid write flag');
            }
            if (update.write !== false) {
                stored[platform] = await encodeSection(
                    platform,
                    decoded.section,
                    decoded.damaged,
                    decoded.healthy,
                    hadCurrentCiphertext,
                    path,
                    key,
                    keyProvider,
                );
                await writeStoredVault(stored, path);
            }
            return update.result as T;
        }),
    );
};
