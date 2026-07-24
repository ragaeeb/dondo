export type Snapshot = {
    service: string;
    account: string;
    label: string;
    kind: string;
    password: string;
    createdAt: string;
    updatedAt: string;
};

export type TokenPayload = {
    token?: {
        access_token?: string;
        refresh_token?: string;
        expiry?: string;
        token_type?: string;
    };
    auth_method?: string;
};

export type ModelLimit = {
    percentage: number;
    resetTime: string;
    displayName: string;
};

export type LimitResult =
    | { ok: true; tier: string; expires: string; models: Record<string, ModelLimit> }
    | { ok: false; error: string };

export type LimitCache = {
    fetchedAt: string;
    quota: LimitResult;
};

export type VaultSection<T> = {
    data: Record<string, T>;
    limits: Record<string, LimitCache>;
};

export type PlatformVault = VaultSection<Snapshot>;

export type CodexSnapshot = {
    auth: string;
    createdAt: string;
    updatedAt: string;
};

export type CodexVault = VaultSection<CodexSnapshot>;

export type MinimaxSnapshot = {
    config: string;
    createdAt: string;
    updatedAt: string;
};

export type MinimaxVault = VaultSection<MinimaxSnapshot>;

export type KiroSnapshot = {
    auth: string;
    clientRegistration?: string;
    createdAt: string;
    profile?: string;
    updatedAt: string;
};

export type KiroVault = VaultSection<KiroSnapshot>;

export type AppVault = {
    antigravity: PlatformVault;
    codex: CodexVault;
    kiro: KiroVault;
    minimax: MinimaxVault;
};
