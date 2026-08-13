# Contributing

Dondo is a macOS-only Bun and TypeScript project. Install Bun 1.3.14 or newer and ensure the macOS `security` command
is available.

## Setup and development

```sh
bun install --frozen-lockfile
bun run dev
```

The development watcher restarts the server for runtime TypeScript, TSX, CSS, package metadata, and icon changes. Test
file edits do not restart it.

The package entry point and HTTP server are in `src/server.ts`. Platform behavior lives in `src/antigravity/`,
`src/codex/`, `src/cline/`, `src/kiro/`, and `src/minimax/`. Shared vault/encryption code is in `src/storage/`, shared
types are in `src/types.ts`, configuration is in `src/config.ts`, and the Preact UI is in `src/ui/`.

Do not add launcher shims, barrel exports, runtime compatibility layers, or dependencies without a concrete reduction in
complexity. Import concrete files directly and use arrow functions.

## Verification

Run every gate before opening a pull request:

```sh
bun run lint
bun run typecheck
bun test
bun run build
bun build src/server.ts --target=bun --outdir /tmp/dondo-build
```

Use `bun run format` for formatting-only writes or `bun run fix` for Biome's safe formatter, lint, and assist fixes.
`bun run lint` is the full read-only gate, including formatting, lint rules, assists, and warning rejection.
`bun run build` produces a self-contained runnable `dist/` directory and the build smoke test launches that artifact.

## Tests and secrets

- Isolate filesystem tests with temporary `DONDO_VAULT`, auth, config, and data paths. Never target a real application
  profile or vault.
- Keychain tests should inject the command runner. If a test must touch macOS Keychain, use a dedicated service/account,
  avoid parallel mutation, and clean it up.
- The packaged UI smoke test starts a real local server, so keep its environment and data directory isolated.
- Never commit, log, snapshot, or render credentials, Keychain payloads, auth/config contents, or decrypted exports.
- Only `POST /api/{platform}/export` may return credential payloads. Keep it local-only, confirmed, non-cacheable, and
  all-or-nothing.

## Pull requests

Keep changes narrow, add behavior-focused tests, preserve unrelated worktree changes, and document user-visible or
breaking behavior. Include the commands you ran and their results. Changes to storage, export, switching, or token
handling should explain their failure behavior and demonstrate that ordinary API responses remain redacted.
