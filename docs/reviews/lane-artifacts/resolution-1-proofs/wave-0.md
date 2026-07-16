# Wave 0 — Baseline

Date: 2026-07-16
Runtime: Node.js v26.5.0, pnpm 11.13.1

## Environment and install

Command:

```bash
PATH="$HOME/.nvm/versions/node/v26.5.0/bin:$PATH" \
  "$HOME/.nvm/versions/node/v26.5.0/bin/node" \
  /home/tanner/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.cjs \
  install
```

Result: PASS. Lockfile already current; no packages changed; zero warnings under the Node 26 invocation.

## Build

Command: the same Node 26/pnpm launcher with `build`.

Result: PASS. Both `zenith-toon` and `zenith-mcp` built successfully. Compiler errors: 0. Build warnings: 0.

## Full MCP package suite

Command: the same Node 26/pnpm launcher with `--filter zenith-mcp test`.

Result: BASELINE RED (exit 1), expected for this resolution campaign.

- Test files: 120 passed, 6 failed, 126 total.
- Tests: 1,754 passed, 17 failed, 2 skipped, 1,773 total.
- Runtime warning instances: 2 `MaxListenersExceededWarning`.
- Tooling diagnostic instances: 1 missing TypeScript source-map warning from Vite.

Requested findings reproduced before edits:

- A3: `keeps same-name incoming edge targets equal to a clean rebuild after a target body edit` — RED (`targetFile` was `null`, expected `target.ts`).
- A10: `does not advance the fact commit generation for a rolled-back inner savepoint` — RED (generation advanced 5 -> 6).
- A9: `orders adapter rows by SQLite BINARY UTF-8 bytes for adversarial paths and names` — RED (JavaScript UTF-16 post-sort reversed SQLite BINARY order).
- A4: `enumerates keyset-tied occurrence rows exactly once across one-row pages` — RED (second tied row skipped).
- A4 differential control: `metamorphic concat != one-shot when two facts share the page key` — RED (1 collected vs 2 total).
- A18: no pinning test existed at baseline; the brief requires one before implementation.

Inherited failures outside this worktree's five-finding brief remain the comparison baseline: four file-model relation paging failures, three astral Unicode boundary failures, one weak-resolved compile-time contract failure, two independent facade boundary failures beyond relation paging, one relation-object paging failure, and one source-domain membership failure.

Raw logs are retained for this run at:

- `/tmp/polaris-resolution-1-baseline-install.log`
- `/tmp/polaris-resolution-1-baseline-build.log`
- `/tmp/polaris-resolution-1-baseline-mcp-tests.log`

## Scope receipt

Before production edits, `git status --short` contained only the user-supplied untracked `.codex/hooks.json` and `POLARIS-RESOLUTION-PROMPTS.md`. No tracked source change existed.
