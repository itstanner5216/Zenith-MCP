# Full Codebase Review — 2026-05-08

## Scope Reviewed

Reviewed the Zenith-MCP repository as a TypeScript MCP filesystem server with these main architecture surfaces:

- transports: `src/cli/stdio.ts`, `src/server/http.ts`
- MCP tool registration/orchestration: `src/core/server.ts`, `src/tools/*`
- filesystem sandbox and path handling: `src/core/lib.ts`, `src/core/path-utils.ts`, `src/core/path-validation.ts`, `src/core/roots-utils.ts`
- edit/stash/refactor/versioning pipeline: `src/core/edit-engine.ts`, `src/core/stash.ts`, `src/core/project-context.ts`, `src/core/symbol-index.ts`, `src/tools/edit_file.ts`, `src/tools/stash_restore.ts`, `src/tools/refactor_batch.ts`
- search/tree-sitter/compression: `src/core/shared.ts`, `src/core/tree-sitter.ts`, `src/tools/search_file.ts`, `src/tools/search_files.ts`, `src/core/compression.ts`, `src/toon/*`
- adapter/config/auto-write system: `src/adapters/*`, `src/config/*`
- tests and docs: `tests/*`, `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `docs/*`

Validation run:

- `npx tsc --noEmit --pretty false` passed.
- `npx vitest run --coverage=false` failed: 29 failures across 6 files. Failures include stale mocks for `loadConfig`, stale path-validation tests importing removed exports, project-context/global DB leakage, refactor_batch indexing not populating expected symbols, and existing stash rows causing empty-stash assertions to fail.

## Verdict

**REQUEST CHANGES**

The codebase has strong feature breadth and a mostly coherent module split, but there are several correctness/security-boundary issues in first-run stdio behavior, project/session scoping, sandbox side-effect writes, auto-write backup semantics, and new-file creation. The test suite is also not currently a reliable green gate.

---

## Critical / High Findings

### 1. First-run wizard corrupts MCP stdio and can block headless startup

**Severity:** High  
**Files:** `src/cli/stdio.ts:30-31`, `src/config/wizard.ts:119-224`, `src/server/http.ts:37-38`

When `~/.zenith-mcp/config` is missing, the stdio entrypoint runs `runFirstRunWizard()` before connecting the MCP transport. The wizard writes banners/prompts/results with `console.log` and reads from `stdin`. In stdio MCP mode, stdout/stdin are the protocol channel, so a first-run launch by Claude/Codex/other MCP clients emits non-JSON UI text into stdout and waits for human input instead of speaking MCP. The HTTP entrypoint has a related daemon problem: a missing config starts an interactive wizard before env/API-key validation and before the server listens.

**Impact:** first-time stdio installs can fail/hang and corrupt the MCP protocol; headless HTTP services can block on an interactive prompt.

**Recommendation:** never run an interactive wizard from stdio transport startup. Create defaults non-interactively or fail with a stderr-only instruction and a separate explicit setup command. For HTTP, validate required env first and require explicit setup when non-interactive.

---

### 2. Project root resolution writes `.mcp` databases outside allowed roots

**Severity:** High  
**Files:** `src/utils/project-scope.ts:76-82`, `src/core/symbol-index.ts:81-85`, `src/tools/edit_file.ts:80-84`, `src/tools/refactor_batch.ts:286-293`

The filesystem sandbox validates the user-requested file/directory, but the project/symbol layer independently promotes the enclosing git root even when the allowed MCP root is only a subdirectory. For example, if the allowed root is `/repo/src`, editing `/repo/src/a.ts` or running `refactor_batch` can resolve `/repo` via `git rev-parse`, then `getDb(repoRoot)` creates/writes `/repo/.mcp/symbols.db`. That write is outside the allowed directory and bypasses `ctx.validatePath()` entirely.

**Impact:** sandboxed sessions can create/modify metadata outside their declared allowed roots. This weakens the main security boundary and surprises callers that intentionally granted only a subdirectory.

**Recommendation:** constrain resolved project roots to allowed directories before any `.mcp` write. If the git root is outside the sandbox, use the most specific allowed directory, a validated in-sandbox metadata location, or the global stash DB.

---

### 3. ProjectContext singleton breaks HTTP per-session isolation

**Severity:** High  
**Files:** `src/server/http.ts:128-132`, `src/core/project-context.ts:258-264`, `src/core/project-context.ts:270-273`

HTTP creates a fresh `FilesystemContext` for each session, but `getProjectContext(ctx)` stores a single process-global `ProjectContext` constructed from the first context and returns it for every later session. Root-change notifications are also global. In multi-session HTTP mode, stash/refactor/project-root state can therefore be resolved with another session's allowed directories, registry, bound root, or refresh lifecycle.

**Impact:** per-session isolation is incomplete for stash/refactor/project context. A later session can inherit stale root decisions from an earlier session, and roots changes from one session can perturb another.

**Recommendation:** key `ProjectContext` by session/context or store it directly on the per-session `FilesystemContext`. Avoid process-global mutable context for session-scoped state.

---

### 4. `write_file` cannot create nested parent directories despite claiming it can

**Severity:** High  
**Files:** `src/tools/write_file.ts:30-43`, `src/core/lib.ts:53-65`

`write_file` validates the final target path before it creates parent directories. For a new file such as `/allowed/new/nested/file.txt`, `validatePath()` calls `realpath()` on the non-existent file, then tries `realpath()` on `/allowed/new/nested`; because that parent does not exist yet, validation throws `Parent directory does not exist` before `fs.mkdir(parentDir, { recursive: true })` can run. I confirmed this behavior with a temporary `/tmp` probe.

**Impact:** the advertised “Auto-creates parent directories” feature only works when the immediate parent already exists. Multi-level new file creation fails even inside an allowed root.

**Recommendation:** add a validated “creation path” mode that walks upward to the nearest existing ancestor, validates that ancestor is inside the sandbox after realpath, then allows creating the remaining descendants without crossing symlinks.

---

### 5. Auto-write backup modes are bypassed by adapter-level backups

**Severity:** High  
**Files:** `src/adapters/base.ts:19-27`, representative adapter `src/adapters/platforms/claude-desktop.ts:43-47`, `src/config/auto-write.ts:92-103`

`autoWriteToMcpConfigs()` calls `backupFile()` with the selected `backup_mode`, but then each known platform adapter calls `this.backup(p)` inside `writeConfig()`. That legacy backup always writes a `.bak` file when the config exists. As a result, `backup_mode: none` still creates backup files, `backup_mode: sqlite` still creates filesystem backups, and `backup_mode: file` creates duplicate backup artifacts with different naming/retention behavior.

**Impact:** user-facing backup settings are not honored for known adapters, and auto-write creates extra files even when the user explicitly selected no file backups.

**Recommendation:** move backup responsibility to `auto-write.ts` and disable adapter-local backups during auto-write, or make adapter backup behavior accept and honor the configured mode.

---

### 6. Current test suite is not a passing regression gate

**Severity:** High  
**Files:** `tests/path-validation.test.js`, `tests/core-server.test.js`, `tests/project-context.test.js`, `tests/refactor-batch.test.js`, `tests/stash_restore_task_1_4.test.js`

`npx vitest run --coverage=false` currently fails 29 tests. The failures are not cosmetic: path-validation tests import `normalizePath`/`expandHome` from `dist/core/path-validation.js` even though those functions now live in `path-utils`; core-server mocks do not provide the newly required `loadConfig` export; project-context tests hit a readonly global SQLite DB; refactor_batch indexing/load tests return no symbols; stash list tests see existing repository stash rows instead of an empty isolated DB.

**Impact:** changes to the codebase cannot currently be validated by the normal test command, and several failures point at real global-state/test-isolation risks in the stash/project architecture.

**Recommendation:** update stale tests for current module boundaries, isolate HOME/Zenith DB paths per test process before importing modules, and ensure refactor_batch tests build against the same runtime source surface used by the package.

---

## Medium Findings / Feature Correctness

### 7. JS content-search fallback can miss matches because it uses a global RegExp

**Severity:** Medium  
**File:** `src/tools/search_files.ts:571-574`, `src/tools/search_files.ts:647-654`

When ripgrep is unavailable or returns null, content mode compiles the query with flags `gi` and reuses that regex across every line. JavaScript regexes with `g` retain `lastIndex` between `.test()` calls, so consecutive lines or lines with matches before the previous `lastIndex` can be skipped.

**Impact:** search results and `countOnly` are incorrect on systems without `/usr/bin/rg` or when ripgrep fails.

**Recommendation:** remove `g` for per-line `.test()` or reset `contentRegex.lastIndex = 0` before each line.

---

### 8. `countOnly` reports capped ripgrep results as if they were full counts

**Severity:** Medium  
**Files:** `src/core/shared.ts:262-263`, `src/tools/search_files.ts:615-618`

`ripgrepSearch()` always includes `--max-count 100` and `-m 500`, and also stops collecting after `maxResults`. Content mode then returns `matches: ${rgResults.length}` for `countOnly`. On repositories with more than the cap, the tool reports the truncated number without indicating it is capped.

**Impact:** callers using `countOnly` for impact sizing or search completeness get undercounts.

**Recommendation:** use a separate uncapped/count-oriented ripgrep path for `countOnly`, or report the cap explicitly (for example `matches: >=500`).

---

### 9. Custom MCP config auto-write only recognizes `mcpServers`

**Severity:** Medium  
**File:** `src/config/auto-write.ts:216-226`

Custom path verification treats only a top-level `mcpServers` object as an MCP config. The built-in adapters in this repo support several other schemas (`mcp_servers` for Codex, `mcp.servers` for gptme, `mcp` for OpenCode, `context_servers` for Zed, list-style `mcpServers` for Continue.dev). Custom config files using those valid schemas are skipped even though the platform-specific adapters know how to write them.

**Impact:** the custom path feature does not work for several supported client formats.

**Recommendation:** reuse adapter schema handlers or extend `verifyAndWriteMcpConfig()` to detect/write the same shapes supported by `src/adapters/platforms/*`.

---

### 10. Symbol indexing does not apply sensitive-file filtering

**Severity:** Medium  
**Files:** `src/core/symbol-index.ts:254-266`, `src/core/shared.ts:39-44`

The docs state that sensitive files are blocked from symbol indexing, but `indexDirectory()` only checks `DEFAULT_EXCLUDES` by basename and `isSupported()`. It does not call `isSensitive()`. Supported source files with names like `credentials.ts`, `secret_config.py`, or files under a sensitive `.config` path can be parsed and stored in the symbol DB.

**Impact:** sensitive file paths and symbol names can enter `.mcp/symbols.db` and later appear in symbol/refactor/search outputs.

**Recommendation:** call `isSensitive(fullPath)` before indexing files and before persisting symbol rows.

---

## Structural / Maintainability Findings

### 11. Large modules concentrate too much behavior

**Severity:** Medium  
**Files:** `src/tools/refactor_batch.ts` (1277 lines), `src/core/tree-sitter.ts` (1082 lines), `src/toon/string-codec.ts` (1066 lines), `src/toon/sagerank.ts` (882 lines), `src/toon/pipeline.ts` (741 lines), `src/tools/search_files.ts` (710 lines), `src/retrieval/pipeline.ts` (652 lines)

Several files are far above the 500-line maintainability threshold and combine parsing, state management, validation, formatting, persistence, and tool output. `refactor_batch.ts` in particular mixes schema definition, query/load/apply/reapply/restore/history, outlier checks, diff parsing, cache management, writes, and version snapshots in one file.

**Impact:** bugs in these modules are harder to isolate and test, and global caches/state are easier to misuse.

**Recommendation:** split by workflow stage and pure side-effect boundary: e.g. `refactor/query.ts`, `refactor/load.ts`, `refactor/apply.ts`, `refactor/versioning.ts`, `refactor/format.ts`; split `tree-sitter` into grammar/query loading, symbol extraction, compression structure, syntax checking, and structural similarity.

---

### 12. Committed runtime surface and source surface are not aligned

**Severity:** Medium  
**Files:** `dist/config/adapter-cli.js`, `dist/config/adapter-settings.js`, `dist/config/zenith-mcp/*`, `src/config/*`, `package.json`

The local runtime `dist/` contains config/admin CLI files that have no `src/` equivalents, while `package.json` publishes only `dist`. `npm run build` compiles `src` into `dist` but does not clean or regenerate those orphaned runtime files from source. This creates a hidden source-of-truth split: clean builds from source cannot recreate every runtime file currently present in `dist`.

**Impact:** published/runtime behavior can depend on stale generated files that TypeScript, tests, and code review do not cover.

**Recommendation:** either restore source files for every runtime `dist` file or remove orphaned runtime files and references; add a clean-build parity check that fails when `dist` contains files not generated from `src` or tracked grammar assets.

---

## Positive Notes

- The core path validator performs both requested-path and realpath symlink checks for normal existing-file operations, which is the right foundation for a filesystem MCP sandbox.
- The edit engine’s in-memory batch validation before writing is a good safety pattern; keeping failed edits stashed for retry is useful when it does not leak across projects/sessions.
- HTTP transport correctly creates distinct MCP server/context pairs per session at the transport layer; the remaining issue is the lower project/stash singleton.
