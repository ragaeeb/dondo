# Dondo

<p>
  <img src="./icon.png" alt="Dondo icon" width="96" height="96" />
</p>

Dondo is a small local Bun app for saving and switching local AI tool accounts. It starts a local web UI, stores saved accounts in an encrypted local vault, and currently supports Antigravity and Codex.

Current platform support is macOS. Dondo uses the macOS `security` CLI for the local vault key, and Antigravity account switching uses macOS Keychain entries.

## Install

Install Bun 1.3 or newer, then run:

```sh
bunx dondo
```

Then open:

```text
http://localhost:3000
```

The server binds to `127.0.0.1` only.

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
    }
}
```

`antigravity.data` stores saved account snapshots. The token-bearing `password` field is encrypted with AES-256-GCM before writing to disk. Non-secret metadata such as labels, service names, and timestamps remains readable in the vault so the UI can list accounts. The encryption key is a random local secret stored in macOS Keychain as `dondo / vault-key`.

`antigravity.limits` stores cached rate-limit data. Dondo fetches missing limits on first load and refreshes cached limits only when the UI `Refresh limits` button is used.

`codex.data` stores encrypted snapshots of `~/.codex/auth.json`. Loading a saved Codex account writes that snapshot back to `~/.codex/auth.json` with `0600` permissions.

`codex.limits` stores cached Codex ChatGPT usage data. Dondo fetches missing limits on first load and refreshes cached limits only when the UI `Refresh limits` button is used.

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
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
CODEX_AUTH_PATH=~/.codex/auth.json
```

`DONDO_PORT` takes precedence over `PORT`. `ANTIGRAVITY_KEYCHAIN` is passed as the keychain argument to macOS `security` commands, for example `login.keychain-db` or an absolute keychain path.

The default Google OAuth constants are the public upstream Antigravity desktop-client values. You can override them with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` if upstream changes.

## Local API

All API requests must be sent to localhost. Mutating routes require `POST` with a JSON object body.

- `GET /api/antigravity/state`
- `POST /api/antigravity/limits/refresh` with optional `{ "key": "label" }`
- `POST /api/antigravity/save` with `{ "key": "label" }`
- `POST /api/antigravity/load` with `{ "key": "label" }`
- `POST /api/antigravity/clear`
- `GET /api/codex/state`
- `POST /api/codex/limits/refresh` with optional `{ "key": "label" }`
- `POST /api/codex/save` with `{ "key": "label" }`
- `POST /api/codex/load` with `{ "key": "label" }`

`Clear live` deletes the live Antigravity Keychain item plus these local Antigravity state paths:

- `~/.antigravity-agent/cloud_accounts.db`
- `~/.gemini/antigravity`
- `~/.gemini/antigravity-ide`
- `~/.gemini/antigravity-backup`
- `~/Library/Application Support/Antigravity`

## Security Model

Dondo is designed to be easy to inspect:

- The server listens on `127.0.0.1`.
- Tokens are not returned to the browser API.
- Saved token payloads are encrypted at rest.
- Rate-limit API calls happen server-side.
- Codex `auth.json` contents are never rendered or returned by the API.

This protects against casual plaintext scraping of the vault file. A process running as the same logged-in user may still be able to access local Keychain items depending on operating-system policy. Antigravity restore currently passes the token blob to the macOS `security` CLI as an argument, which can be visible briefly to same-user process listings.

## License

MIT
