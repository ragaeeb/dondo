## Commands

- Use `rtk` as the default wrapper for shell commands that emit meaningful stdout or stderr.
- Prefer `rtk <command>` for `git`, tests, linters, searches, builds, and file reads.
- Fall back to raw commands only when `rtk` cannot express the command correctly.

## Project Shape

- Runtime: Bun.
- Package entry point: `src/server.ts`.
- Server code: `src/server.ts`.
- UI code: `src/ui/client.tsx`.
- UI CSS: `src/ui/styles.css`.
- Antigravity behavior: `src/antigravity/*`.
- Codex behavior: `src/codex/*`.
- Cline behavior: `src/cline/*`.
- Kiro behavior: `src/kiro/*`.
- MiniMax behavior: `src/minimax/*`.
- Shared account state: `src/account-state.ts`.
- Vault and encryption: `src/storage/*`.
- Shared types: `src/types.ts`.
- Config and constants: `src/config.ts`.

Do not reintroduce root launcher shims or barrel `index.ts` files. Import concrete files directly.

## Code Style

- Use arrow functions only. Do not add `function` declarations.
- Keep imports explicit and type-only where appropriate.
- Keep token-handling code simple and auditable.
- Do not log or render token payloads.
- Only the dedicated `POST /api/{platform}/export` attachment routes may return token payloads. All other API routes
  must keep token payloads out of responses, and export responses must remain local-only and non-cacheable.
- Keep UI components in Preact/TSX, not raw HTML template strings. The static document shell in `src/ui/html.ts` is the only allowed non-component HTML string.
- Keep CSS in `src/ui/styles.css`.
- Avoid new dependencies unless they remove substantial complexity. Node/Bun standard APIs are preferred.

## Storage

- The vault format is nested:

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
    "cline": {
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

- `antigravity.data` contains encrypted account snapshots.
- `antigravity.limits` contains cached limit data.
- `codex.data` contains encrypted `~/.codex/auth.json` snapshots.
- `codex.limits` contains cached Codex ChatGPT usage data.
- `cline.data` contains encrypted `~/.cline/data/settings/providers.json` snapshots; Cline has no limit cache.
- `kiro.data` contains encrypted Kiro auth, profile, and client-registration snapshots.
- `kiro.limits` contains cached Kiro usage data.
- `minimax.data` contains encrypted MiniMax Agent config snapshots.
- `minimax.limits` contains cached MiniMax quota and credit data.
- The nested encrypted format is a hard cut. Do not add flat-vault, plaintext, or runtime compatibility migrations.
- Preserve isolated corrupt entries across unrelated writes. They must remain deletable but not loadable, syncable,
  refreshable, or exportable.
- Default app data path logic lives in `src/config.ts`.

## Verification

Before finishing code changes, run:

```sh
bun run lint
bun run typecheck
bun test
bun build src/server.ts --target=bun --outdir /tmp/dondo-build
```

All four must pass. `bun run lint` is the full Biome formatting, lint, and assist gate, with warnings treated as errors.
