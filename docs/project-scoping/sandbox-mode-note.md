# Sandbox Mode — Restoration Note (2026-07-14)

Status note written during the project-detection restoration so this doesn't
get lost. NOT scheduled work — a future, optional, config-gated feature.

## What exists today (verified 2026-07-14)

- Opt-in enforcement via the `sandbox` boolean in config (default `false`).
- Wired in `registerEnabledTools` → `ctx.setSandboxEnabled(config.sandbox)`,
  enforced in `lib.ts` → `validatePath` → `isInsideAllowed` (realpath'd both
  sides, path-separator boundary).
- Covered by `tests/sandbox-opt-in.test.js`.
- The detection ladder respects it: detection only sees validated paths, and
  detected roots are clamped to allowed dirs (`clampToAllowed`).
- History: enforcement used to be IMPLICIT (any configured dir enabled it);
  it was deliberately made opt-in to decouple "which dirs are known" from
  "is access enforced".

## What was lost vs. the original design (the gaps to restore)

1. **Hot reload.** The project registry hot-reloads on config mtime change
   (`ProjectContext._tryLazyReload`), but the `sandbox` flag is read ONCE at
   tool registration. Changing it mid-session does nothing until restart.
   Fix seam: re-apply `setSandboxEnabled` from the lazy-reload path (needs a
   ctx handle there, or a config-change callback).
2. **Project-based scoping.** Enforcement gates against the allowed-dirs list
   (CLI args + MCP roots), NOT the `### Projects` registry. The original
   sandboxed tools to the configured project. With the tier model this is
   now cheap: when enabled and `bindingTier` is `explicit`/`registry`,
   gate paths to `_boundRoot`.
3. **Fail-open on empty allowlist.** Sandbox on + no dirs = permissive
   (deliberate, so CLIs/tests don't brick).
   DECIDED (2026-07-14, Tanner): keep fail-open — sandbox is opt-in and
   default-off, so the silent-state risk is acceptable. Compensating
   control: emit a SESSION-START notification when `sandbox: true` but the
   allowlist is empty ("sandbox enabled but not enforcing — no directories
   configured"). Plumbing already exists in stdio.ts `oninitialized`
   (sendLoggingMessage warning block) — add one condition there.

## Intended shape (per Tanner)

- Optional, not baseline — a config knob (e.g. `sandbox_mode: project`),
  NOT default-on.
- Will serve a later mode-based purpose in Zenith.
- Should hot-reload like the registry does.
