# Dondo

<p>
  <img src="./icon.png" alt="Dondo icon" width="96" height="96" />
</p>

[![npm](https://img.shields.io/npm/v/dondo-donuts?color=111827)](https://www.npmjs.com/package/dondo-donuts)
[![Bun](https://img.shields.io/badge/runtime-Bun-fbf0df?logo=bun&logoColor=000)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/code-TypeScript-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org)
[![Preact](https://img.shields.io/badge/ui-Preact-673ab8?logo=preact&logoColor=fff)](https://preactjs.com)
[![Biome](https://img.shields.io/badge/lint-Biome-60a5fa?logo=biome&logoColor=fff)](https://biomejs.dev)
[![macOS](https://img.shields.io/badge/platform-macOS-111827?logo=apple&logoColor=fff)](https://www.apple.com/macos)
[![Antigravity](https://img.shields.io/badge/switches-Antigravity-2563eb)](https://antigravity.google)
[![Codex](https://img.shields.io/badge/switches-Codex-10a37f)](https://openai.com/codex)
[![Kiro](https://img.shields.io/badge/switches-Kiro-7c3aed)](https://kiro.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/ragaeeb/dondo?color=6f42c1)](https://github.com/ragaeeb/dondo/issues)
[![wakatime](https://wakatime.com/badge/user/a0b906ce-b8e7-4463-8bce-383238df6d4b/project/1c226a67-6f05-42d3-a8c3-591ef0fa09fd.svg)](https://wakatime.com/badge/user/a0b906ce-b8e7-4463-8bce-383238df6d4b/project/1c226a67-6f05-42d3-a8c3-591ef0fa09fd)

Dondo is a small local Bun app for saving and switching local AI tool accounts. It starts a local web UI, stores saved accounts in an encrypted local vault, and currently supports Antigravity, Codex, Kiro, and MiniMax.

Current platform support is macOS. Dondo uses the macOS `security` CLI for the local vault key, and Antigravity account switching uses macOS Keychain entries.

## Install

Install Bun 1.3 or newer, then run:

```sh
bunx dondo-donuts
```

Then open the URL printed by the server. By default Dondo starts at:

```text
http://127.0.0.1:3000
```

If that port is busy, Dondo uses the next available port. The server binds to `127.0.0.1` only.

## Development

```sh
bun install
bun run start
```

Useful checks:

```sh
bun run typecheck
bun run lint
bun test
bun build src/server.ts --target=bun --outdir /tmp/dondo-build
```

## Storage

Dondo stores its vault at the platform data directory:

- macOS: `~/Library/Application Support/Dondo/vault.json`
- Windows: `%LOCALAPPDATA%/Dondo/Data/vault.json`
- Linux: `$XDG_DATA_HOME/dondo/vault.json` or `~/.local/share/dondo/vault.json`

Set `DONDO_DATA_DIR` to override the directory, or `ANTIGRAVITY_VAULT` to override the full vault path.
`DONDO_VAULT` also overrides the full vault path and takes precedence over the historical `ANTIGRAVITY_VAULT` name.
When upgrading, rename `ANTIGRAVITY_VAULT` to `DONDO_VAULT` for clarity; the historical name remains supported.

Vault shape:

```json
{
    "antigravity": {
        "data": {},
        "limits": {}
    },
    "codex": {
        "data": {},
        "limits": {}
    },
    "kiro": {
        "data": {},
        "limits": {}
    },
    "minimax": {
        "data": {},
        "limits": {}
    }
}
```

`antigravity.data` stores saved account snapshots. The token-bearing `password` field is encrypted with AES-256-GCM before writing to disk. Non-secret metadata such as labels, service names, and timestamps remains readable in the vault so the UI can list accounts. The encryption key is a random local secret stored in macOS Keychain as `dondo / vault-key`.

`antigravity.limits` stores cached rate-limit data. Dondo fetches missing limits on first load and refreshes cached limits only when the UI `Refresh limits` button is used.

`codex.data` stores encrypted snapshots of `~/.codex/auth.json`. Loading a saved Codex account writes that snapshot back to `~/.codex/auth.json` with `0600` permissions.

`codex.limits` stores cached Codex ChatGPT usage data. Dondo fetches missing limits on first load and refreshes cached limits only when the UI `Refresh limits` button is used.

`kiro.data` stores encrypted snapshots of `~/.aws/sso/cache/kiro-auth-token.json`. Loading a saved Kiro account
writes a freshly validated snapshot back to the same path with `0600` permissions. Kiro watches this file and picks
up account changes while the IDE is running. If Kiro has remotely revoked a saved session, Dondo rejects the load
without replacing the current live credentials.

To add multiple accounts, use `Save current` while signed in, fully quit Kiro, and use `Clear live`. Reopen Kiro,
sign into the next account, and save it under another label. To switch accounts later, fully quit Kiro, load the
saved account in Dondo, and reopen Kiro. Dondo snapshots the auth token, cached profile, and the client-registration
credential used by Builder ID or enterprise sessions. `Clear live` removes those account-specific local artifacts
without calling Kiro's remote logout endpoint.
The Kiro account rows intentionally do not offer `Sync current`, because that action cannot verify that the live
account matches the row label.

`kiro.limits` is reserved for future Kiro usage data and is currently empty.

`minimax.data` stores encrypted snapshots of `~/Library/Application Support/MiniMax Agent/minimax-agent-config.json`. Loading a saved MiniMax account writes that snapshot back to the same path with `0600` permissions.

`minimax.limits` stores mocked MiniMax limit data. The current implementation records the load or refresh time because the MiniMax rate-limit endpoint is not yet known.

Each limit cache entry has this shape:

```json
{
    "fetchedAt": "2026-06-02T00:00:00.000Z",
    "quota": {
        "ok": true,
        "tier": "plus",
        "expires": "",
        "models": {}
    }
}
```

Encrypted strings use the `enc:v1:` envelope: AES-256-GCM with a 12-byte IV, 16-byte auth tag, then ciphertext, base64 encoded.

## Environment

```sh
DONDO_PORT=3000
PORT=3000
DONDO_DATA_DIR=/custom/data/dir
DONDO_VAULT=/custom/vault.json
ANTIGRAVITY_VAULT=/custom/vault.json
ANTIGRAVITY_SERVICE=gemini
ANTIGRAVITY_ACCOUNT=antigravity
ANTIGRAVITY_KEYCHAIN=login.keychain-db
ANTIGRAVITY_VERSION=2.0.3
ANTIGRAVITY_LANGUAGE_SERVER_PATH=/Applications/Antigravity.app/Contents/Resources/bin/language_server
CODEX_AUTH_PATH=~/.codex/auth.json
KIRO_AUTH_PATH=~/.aws/sso/cache/kiro-auth-token.json
KIRO_PROFILE_PATH="~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/profile.json"
KIRO_AUTH_REFRESH_URL=https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken
MINIMAX_CONFIG_PATH=~/Library/Application Support/MiniMax Agent/minimax-agent-config.json
```

`DONDO_PORT` takes precedence over `PORT`; both set the preferred starting port, and Dondo uses the next available port if that port is busy. `ANTIGRAVITY_KEYCHAIN` is passed as the keychain argument to macOS `security` commands, for example `login.keychain-db` or an absolute keychain path.

Antigravity limit refreshes can use the saved Google refresh token to rotate an expired saved access token, then write the refreshed token blob back to the encrypted vault entry. Dondo discovers Antigravity's Google OAuth client from the local Antigravity language server binary. Codex limit refreshes only call the usage endpoint with the saved access token.

## Local API

All API requests must be sent to localhost. Mutating routes require `POST` with a JSON object body. Export routes
require `POST` and the `X-Dondo-Export: 1` header.

- `GET /api/antigravity/state`
- `POST /api/antigravity/export`
- `POST /api/antigravity/limits/refresh` with optional `{ "key": "label" }`
- `POST /api/antigravity/save` with `{ "key": "label" }`
- `POST /api/antigravity/load` with `{ "key": "label" }`
- `POST /api/antigravity/delete` with `{ "key": "label" }`
- `POST /api/antigravity/clear`
- `GET /api/codex/state`
- `POST /api/codex/export`
- `POST /api/codex/limits/refresh` with optional `{ "key": "label" }`
- `POST /api/codex/save` with `{ "key": "label" }`
- `POST /api/codex/load` with `{ "key": "label" }`
- `POST /api/codex/delete` with `{ "key": "label" }`
- `GET /api/kiro/state`
- `POST /api/kiro/export`
- `POST /api/kiro/save` with `{ "key": "label" }`
- `POST /api/kiro/load` with `{ "key": "label" }`
- `POST /api/kiro/delete` with `{ "key": "label" }`
- `POST /api/kiro/clear`
- `GET /api/minimax/state`
- `POST /api/minimax/export`
- `POST /api/minimax/limits/refresh` with optional `{ "key": "label" }`
- `POST /api/minimax/save` with `{ "key": "label" }`
- `POST /api/minimax/load` with `{ "key": "label" }`
- `POST /api/minimax/delete` with `{ "key": "label" }`

`Clear live` deletes the live Antigravity Keychain item plus these local Antigravity state paths:

- `~/.antigravity-agent/cloud_accounts.db`
- `~/.gemini/antigravity`
- `~/.gemini/antigravity-ide`
- `~/.gemini/antigravity-backup`
- `~/Library/Application Support/Antigravity`

## Security Model

Dondo is designed to be easy to inspect:

- The server listens on `127.0.0.1`.
- State and limit APIs do not return token payloads.
- Saved token payloads are encrypted at rest.
- Rate-limit API calls happen server-side.
- Token payloads and Codex `auth.json` contents are never rendered in the UI.

The export routes are the sole API exception: they return every saved account for the selected platform as an
unencrypted JSON attachment. The UI asks for explicit confirmation before calling them. Export requires a local
`POST` request with a dedicated confirmation header, is rate limited with the rest of the local API, and uses
`Cache-Control: no-store`. The downloaded file contains live credentials and must be stored and shared as carefully
as the original auth files.

This protects against casual plaintext scraping of the vault file. A process running as the same logged-in user may still be able to access local Keychain items depending on operating-system policy. Antigravity restore currently passes the token blob to the macOS `security` CLI as an argument, which can be visible briefly to same-user process listings.

## License

MIT
