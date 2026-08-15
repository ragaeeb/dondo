# Dondo

<p>
  <img src="./icon.png" alt="Dondo icon" width="96" height="96" />
</p>

[![npm](https://img.shields.io/npm/v/dondo-donuts?color=111827)](https://www.npmjs.com/package/dondo-donuts)
[![Bun](https://img.shields.io/badge/runtime-Bun-fbf0df?logo=bun&logoColor=000)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/code-TypeScript-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org)
[![Preact](https://img.shields.io/badge/ui-Preact-673ab8?logo=preact&logoColor=fff)](https://preactjs.com)
[![Biome](https://img.shields.io/badge/quality-Biome-60a5fa?logo=biome&logoColor=fff)](https://biomejs.dev)
[![macOS](https://img.shields.io/badge/platform-macOS-111827?logo=apple&logoColor=fff)](https://www.apple.com/macos)
[![Antigravity](https://img.shields.io/badge/switches-Antigravity-2563eb)](https://antigravity.google)
[![Codex](https://img.shields.io/badge/switches-Codex-10a37f)](https://openai.com/codex)
[![Cline](https://img.shields.io/badge/switches-Cline-0f766e)](https://cline.bot)
[![Kiro](https://img.shields.io/badge/switches-Kiro-7c3aed)](https://kiro.dev)
[![MiniMax](https://img.shields.io/badge/switches-MiniMax-e11d48)](https://www.minimax.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](./LICENSE)

Dondo is a small local Bun app for saving and switching Antigravity, Codex, Cline, Kiro, and MiniMax accounts. It
runs a Preact UI on loopback, keeps saved credentials in an encrypted local vault, and fetches supported usage limits
server-side without returning token payloads from ordinary state APIs.

**Dondo supports macOS only.** It uses the macOS `security` CLI and the login user's default Keychain for its vault
key and Antigravity credentials. Custom Keychain files are not supported.

## Install

Install Bun 1.3.14 or newer, then run:

```sh
bunx dondo-donuts
```

Open the URL printed by the server. Dondo starts at `http://127.0.0.1:3000` by default and tries the next available
port when that port is occupied. It never binds to a non-loopback interface.

To cycle a saved MiniMax or Kiro account without opening the UI, use the CLI:

```sh
bunx dondo-donuts minimax next
bunx dondo-donuts kiro next
```

Add `--json` for a stable machine-readable result. Cycling uses deterministic saved-account order, wraps after the
last account, and skips unavailable sessions until one loads. It never accepts an account label and never lists or
prints saved labels, account identities, indices, or credentials. Kiro must be fully quit before cycling.

## Using Dondo

Open a platform tab and use `Save current` while that application's desired account is live. A saved account can then
be loaded, deleted, and, where supported, refreshed or synchronized with the current account. Export downloads every
saved account for one platform as an unencrypted JSON attachment after an explicit warning.

### Antigravity switching

Loading Antigravity replaces its live Keychain credential and removes these local state paths before restoration:

- `~/.antigravity-agent/cloud_accounts.db`
- `~/.gemini/antigravity`
- `~/.gemini/antigravity-ide`
- `~/.gemini/antigravity-backup`
- `~/Library/Application Support/Antigravity`

`Clear live` deletes the live Keychain item and the same local state. Antigravity must be fully quit before loading or
clearing; Dondo rejects either operation while its process is running so it cannot restore stale state. Reopen it after
the operation. These actions change local login state; they do not remotely revoke the account.

### Kiro switching

Kiro must be fully quit before `Load` or `Clear live`; Dondo rejects either operation while Kiro is running. Save the
current account first, quit Kiro, clear its live files, reopen it, sign into the next account, and save that account under
a new label. To switch later, quit Kiro, load the saved account in Dondo, and reopen Kiro.

Dondo snapshots Kiro's auth token, optional profile, and matching client registration. Loading validates or refreshes
the saved session, stages the replacement files, and then commits them with `0600` permissions. Clearing removes those
local account files without calling Kiro's remote logout endpoint. Kiro intentionally has no `Sync current` row action.

## Vault and recovery

The default vault is `~/Library/Application Support/Dondo/vault.json`. Set `DONDO_DATA_DIR` to replace its containing
directory or `DONDO_VAULT` to replace the complete vault path.

The current vault contract is a hard cut to nested, encrypted platform sections:

```json
{
    "antigravity": { "data": {}, "limits": {} },
    "cline": { "data": {}, "limits": {} },
    "codex": { "data": {}, "limits": {} },
    "kiro": { "data": {}, "limits": {} },
    "minimax": { "data": {}, "limits": {} }
}
```

Dondo does not perform runtime migrations from historical flat vaults, plaintext secret fields, or `enc:v1`
ciphertexts. Back up an old vault before upgrading and re-save accounts from their live applications into the current
format. Existing `enc:v1` rows appear as `Corrupted`; delete and re-save them before exporting. The historical
`ANTIGRAVITY_VAULT` environment name is no longer supported; use `DONDO_VAULT`. The historical
`ANTIGRAVITY_KEYCHAIN` override is also unsupported; Dondo always uses the default Keychain.

Secret-bearing fields are encrypted independently with AES-256-GCM in an `enc:v2:` envelope. Each ciphertext is bound
to its platform, account label, secret field, and non-secret snapshot metadata, so copying it to another row or changing
its metadata fails authentication. The random vault secret is stored in the default macOS Keychain as
`dondo / vault-key`; only non-secret labels, timestamps, and cached limit metadata remain readable in the vault. Codex,
Cline, Kiro, and MiniMax live files restored by Dondo are written with `0600` permissions.

The vault file is not a self-contained credential backup. If the `dondo / vault-key` Keychain item is lost, Dondo
refuses to generate a replacement while `enc:v2` data exists because doing so would make the loss permanent and
silent. Restore that Keychain item from backup, or remove the unreadable vault and save every account again from its
live application.

If one saved credential cannot be decrypted or has an invalid stored shape, Dondo isolates and preserves its raw vault
entry. The UI shows a redacted `Corrupted` row: it cannot be loaded, synchronized, or refreshed, but it can be deleted.
Delete that row and use `Save current` to create it again. Other healthy accounts remain usable.

An export is all-or-nothing for the selected platform. If any saved account for that platform is damaged, Dondo refuses
the entire export instead of silently producing an incomplete wallet. In browsers that support the File System Access
API, Dondo asks for the destination before requesting the wallet and streams the response directly to that file; a
failed stream is aborted so a partial file is not committed. Other browsers use a temporary in-memory Blob download.

### Platform data

| Platform | Live source restored by Dondo | Cached usage |
| --- | --- | --- |
| Antigravity | Default macOS Keychain service/account configured below | Model quotas |
| Codex | `~/.codex/auth.json` | ChatGPT usage windows |
| Cline | `~/.cline/data/settings/providers.json` | None |
| Kiro | `~/.aws/sso/cache/kiro-auth-token.json` plus related profile/registration | Agentic-request usage |
| MiniMax | `~/Library/Application Support/MiniMax Agent/minimax-agent-config.json` | 5-hour, weekly, and credit balance |

Loading a MiniMax account automatically performs its Daily Check-In before replacing the live configuration. The
MiniMax toolbar can check in every saved account with concurrency bounded to three; failures are isolated and reported
only as aggregate counts. Successful claims invalidate affected cached limits so credit balances can be refreshed.

Codex snapshots follow the current Codex CLI auth contract: API-key accounts use `auth_mode: "apikey"` and ChatGPT
accounts use `auth_mode: "chatgpt"`. The historical `auth_mode: "api_key"` spelling is rejected; sign in again with a
current Codex CLI and re-save that account.

Cline snapshots contain the current `providers.json` contract only; historical settings or secret-file layouts are not
read or migrated. MiniMax snapshots require a non-empty JWT access token with the current account identity claim;
legacy identity heuristics are not used. Kiro snapshots require a refresh token and valid JSON objects for any saved
profile or client registration. A saved label with any semantically invalid configuration is shown as `Corrupted` and
must be deleted before that label can be saved again.

## Environment

All overrides are optional.

| Variable | Default or behavior |
| --- | --- |
| `DONDO_PORT` | Preferred port, default `3000`; takes precedence over `PORT` |
| `PORT` | Fallback preferred port |
| `DONDO_DATA_DIR` | `~/Library/Application Support/Dondo` |
| `DONDO_VAULT` | `vault.json` under `DONDO_DATA_DIR` |
| `ANTIGRAVITY_SERVICE` | `gemini` |
| `ANTIGRAVITY_ACCOUNT` | `antigravity` |
| `ANTIGRAVITY_VERSION` | `2.0.3` request version |
| `ANTIGRAVITY_PROCESS_NAME` | `Antigravity` |
| `ANTIGRAVITY_LANGUAGE_SERVER_PATH` | Optional language-server binary used for local OAuth client discovery |
| `CODEX_AUTH_PATH` | `~/.codex/auth.json` |
| `CLINE_PROVIDERS_PATH` | `~/.cline/data/settings/providers.json` |
| `KIRO_AUTH_PATH` | `~/.aws/sso/cache/kiro-auth-token.json` |
| `KIRO_PROFILE_PATH` | Kiro's macOS global-storage `profile.json` |
| `KIRO_PROCESS_NAME` | `Kiro` |
| `KIRO_AUTH_REFRESH_URL` | Kiro desktop session refresh endpoint |
| `KIRO_USAGE_URL` | Optional usage endpoint override; normally derived from the profile region |
| `KIRO_USER_AGENT` | `KiroIDE-0.0.0-dondo` |
| `MINIMAX_CONFIG_PATH` | MiniMax Agent's macOS `minimax-agent-config.json` |
| `MINIMAX_AGENT_URL` | `https://agent.minimax.io` |
| `MINIMAX_PLATFORM_URL` | `https://platform.minimax.io` |
| `MINIMAX_UUID` | Optional MiniMax device UUID override |
| `MINIMAX_LOCAL_STORAGE_PATH` | `Local Storage/leveldb` beside `MINIMAX_CONFIG_PATH` |

For local development, use repository-relative override paths such as `DONDO_DATA_DIR=./local-data` rather than a real
application vault.

## Local API

Every API request must target `localhost` or `127.0.0.1`, and the request URL and `Host` header must agree. When an
`Origin` header is present, it must exactly equal the local server origin, including host and port. JSON body routes
require `Content-Type: application/json` and a top-level object.

The complete route surface is:

- `GET /api/{platform}/state` for `antigravity`, `codex`, `cline`, `kiro`, and `minimax`.
- `POST /api/{platform}/export` for all five platforms. It requires `X-Dondo-Export: 1`.
- `POST /api/{platform}/save`, `/load`, and `/delete` for all five platforms with `{ "key": "label" }`.
- `POST /api/{platform}/limits/refresh` for Antigravity, Codex, Kiro, and MiniMax with optional
  `{ "key": "label" }`.
- `POST /api/antigravity/clear` and `POST /api/kiro/clear` with an empty JSON object.
- `POST /api/minimax/check-in` with optional `{ "key": "label" }`.
- `POST /api/minimax/check-in-all` with an empty JSON object; its response contains aggregate counts only.

The server accepts at most **16 KiB** per JSON request body, serializes at most **8 MiB** per export attachment, and
reads at most **16 MiB** from the vault file. Local API traffic is rate limited to 120 requests per 10 seconds.
Live credential files, captured system-command output, and each upstream HTTP response are limited to **1 MiB**.
OAuth discovery scans at most **192 MiB** from a language-server binary; MiniMax identity discovery examines the newest
64 LevelDB/log files, reads at most **16 MiB** from each, and stops after **64 MiB** in total.
The vault accepts at most 4,096 accounts per platform, 256 cached models per account, and 4 KiB per non-secret metadata
field.

State, limit, mutation, and error responses are non-cacheable and never contain credential payloads. Export is the only
token-bearing API response. It is a local-only, non-cacheable attachment and should be protected like the original auth
files.

When Dondo writes a vault secret or Antigravity credential through the macOS `security` CLI, it sends the secret over
the child process's standard input instead of placing it in the process argument list. Command failures redact both
private input and recognizable token fields. macOS may still show a Keychain access prompt, and another process running
as the logged-in user remains within the local trust boundary.

## Development

```sh
bun install --frozen-lockfile
bun run dev
```

`bun run dev` restarts the local server when runtime TypeScript, TSX, CSS, package metadata, or icons change. Test-only
edits do not restart it. Run the full gates before submitting a change:

```sh
bun run lint
bun run typecheck
bun test
bun run build
bun build src/server.ts --target=bun --outdir /tmp/dondo-build
```

`bun run lint` checks formatting, lint rules, and import/key-order assists with warnings treated as failures.
`bun run format` writes formatting only; `bun run fix` applies Biome's safe formatter, lint, and assist fixes. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for test isolation and pull request expectations.

`bun run build` writes a runnable `dist/server.js` plus its browser bundle, stylesheet, and icons. Launch that artifact
with `bun dist/server.js`; it does not depend on the source tree at runtime.

## License

MIT
