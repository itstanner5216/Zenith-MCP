# Zenith-MCP Developer Documentation & Cheat Sheet

Internal developer guidance for Zenith-MCP tool design, implementation, and maintenance.

This document is intentionally stricter and more implementation-focused than the public README. The README sells the project. This file keeps tool behavior honest, compact, and aligned with the current MCP contract.

---

## CRITICAL: Context Efficiency Is a Product Feature

Zenith-MCP is used by agents. Tool output is model context. Context bloat directly hurts reasoning, memory, latency, and edit reliability.

Previous tool design failures produced extreme output bloat: roughly 7.5x useless output for every 1x useful information.

### Design Rule

Return only **new, decision-relevant information**.

Do not return information the caller already knows, can infer from the request, or can retrieve from a separate tool whose scope already covers that job.

### Required Workflow

- Do not parrot request inputs back in responses.
- Do not return paths, selectors, mode names, line ranges, old text, new text, diffs, metadata, or summaries unless they are required for disambiguation or recovery.
- Keep every tool inside its explicit scope.
- Do not duplicate metadata, diagnostics, diff inspection, search, or file-info functionality across unrelated tools.
- Prefer minimal success responses.
- Avoid decorative headers, separators, and âniceâ formatting that costs tokens without changing the callerâs next action.

### Response Discipline

Success should usually be tiny:

```text
Applied.
```

Dry-run should usually be minimal:

```text
Dry run successful.
```

Failure should include only actionable new information:

```json
{"error":"OLD_TEXT_NOT_FOUND"}
```

```json
{"error":"PARSE_ERROR","message":"Expression expected.","line":91}
```

### Bad Output Example

```json
{
  "ok": true,
  "path": "/x/y/z.ts",
  "mode": "symbol",
  "symbol": "buildPrompt",
  "line": 84,
  "oldText": "â¦",
  "newText": "â¦",
  "summary": "Successfully updated buildPrompt in /x/y/z.ts"
}
```

Why this is bad:

- The caller already knows the path, mode, and symbol.
- The response duplicates the requested edit.
- The line number is not needed unless disambiguation/recovery depends on it.
- The summary adds no decision-relevant information.

### Single-Target Rule

If the caller sent one path, do not echo that path back.

Include identifiers such as path, edit index, or symbol only when needed to distinguish multiple targets, multiple failures, or recovery steps.

### Enforced Repo Policy

When designing or modifying tools, optimize for:

- minimal output
- scope-correct output
- non-duplicative output
- actionable failure details
- zero âlook how powerful I amâ backend boasting in tool returns

When unsure whether to include a field, omit it unless it clearly changes the callerâs next action.

---

## 1. Architecture Snapshot

Zenith-MCP is a TypeScript MCP filesystem server compiled from `src/` to `dist/`.

Runtime artifacts live in `dist/`; source of truth lives in `src/` plus the root `grammars/` directory.

### Entry Points

- `src/cli/stdio.ts` â `dist/cli/stdio.js`
  - stdio transport
  - one process, one `FilesystemContext`, one `McpServer`
  - CLI directories provide the baseline allowed-directory sandbox
  - MCP Roots can replace the allowed directories at initialization/runtime

- `src/server/http.ts` â `dist/server/http.js`
  - Express HTTP server
  - Streamable HTTP plus legacy SSE
  - bearer-token auth
  - per-session `{ ctx, server }` isolation
  - idle session reaping via `SESSION_TTL_MS`

### Core Orchestrator

- `src/core/server.ts`
  - creates the `McpServer`
  - loads adapter settings
  - configures adapter registry when enabled
  - initializes retrieval integration
  - registers all tools
  - wires MCP Roots handlers

### Core Modules

| Module | Responsibility |
|---|---|
| `src/core/lib.ts` | `FilesystemContext`, path validation, file I/O, diffs, stats |
| `src/core/shared.ts` | ripgrep integration, BM25 search/ranking, sensitive-file detection |
| `src/core/tree-sitter.ts` | WASM grammar loading, query loading, symbols, definitions, syntax checks, structural fingerprints |
| `src/core/edit-engine.ts` | pure in-memory content/block/symbol edit verification |
| `src/core/symbol-index.ts` | SQLite symbol DB, impact graph, version snapshots, patterns |
| `src/core/project-context.ts` | project root resolution and stash DB routing |
| `src/core/project-registry.ts` | explicit project matching/registration |
| `src/core/stash.ts` | SQLite-backed edit/write stash API |
| `src/core/compression.ts` | compression budget math and JS bridge subprocess invocation |
| `src/core/toon_bridge.ts` | compiled JS bridge that calls tree-sitter + in-process TOON compression |
| `src/toon/` | TypeScript compression library |
| `src/adapters/` | MCP client config adapters |
| `src/config/` | adapter settings, config CLIs, external-server config |
| `src/retrieval/` | opt-in tool retrieval/filtering pipeline |

### Build Artifacts

- `dist/` is gitignored and generated by `npm run build`.
- `grammars/` is tracked source.
- Build copies `grammars/` into `dist/grammars/`.

The nested `grammars/grammars/` directory is intentional. Do not âclean it upâ unless the runtime resolver is changed and tested.

---

## 2. Security Model

### Allowed Directory Sandbox

All filesystem operations must validate target paths through `ctx.validatePath()` before any filesystem read/write/stat/delete/move.

Validation flow:

1. expand `~`
2. resolve to absolute path
3. normalize
4. check requested path against allowed directories
5. resolve symlinks with `realpath`
6. re-check resolved path against allowed directories
7. return the validated path

If validation fails, the tool must fail before touching the filesystem.

### Sensitive File Filtering

`isSensitive()` blocks credential-like files from search/index/discovery output using configured minimatch patterns.

Typical defaults include:

- `.env`
- `*.pem`
- `*.key`
- `*.crt`
- `*credentials*`
- `*secret*`
- `.config/**`

Direct read/write security is primarily the allowed-directory sandbox. Search/index/discovery tools also apply sensitive-file filtering.

### Write Safety

Writes should follow the established safe-write pattern:

- create parent directories when appropriate
- use exclusive creation where needed
- use temp-file + `rename()` for atomic replacement
- verify write size when available
- stash failed write payloads when recovery is useful

---

## 3. Search & Semantics

### Tree-sitter

Zenith uses `web-tree-sitter` and tracked WASM grammars to parse code structurally.

Tree-sitter powers:

- `edit_file` symbol mode
- `search_file` symbol lookup
- `search_files` symbol mode
- `search_files` definition mode
- `search_files` structural mode
- `refactor_batch` symbol loading/outlier detection
- syntax warnings after edits
- structured compression anchors

Guidelines:

- Use symbols for code-aware targeting.
- Use grep/content search only when text matching is the right operation.
- Never fake symbol behavior with line-number guesses when tree-sitter can locate the target.

### BM25 + Ripgrep

`search_files content` uses a staged pipeline:

1. BM25 file pre-filter over file paths and content snippets
2. ripgrep over candidate files, with JS fallback
3. BM25 post-rank when result lines exceed the ranking threshold
4. budget-aware truncation

Keep output result-focused. Do not dump search diagnostics unless they explain a failure or change the callerâs next step.

### Symbol Index

Each project can get a `.mcp/symbols.db` SQLite database.

Key tables:

- `files`
- `symbols`
- `edges`
- `versions`
- `patterns`

Used for:

- impact queries
- caller/callee traversal
- version snapshots
- rollback
- reapply pattern support

The `.mcp/` database directory is generated project state and should stay ignored.

---

## 4. Editing Model

### `edit_file`

`edit_file` is the primary surgical edit tool.

Supported edit modes:

- `content`
  - `oldContent`
  - `newContent`

- `block`
  - `block_start`
  - `block_end`
  - `replacement_block`

- `symbol`
  - `symbol`
  - `newText`
  - `nearLine` optional

Top-level args:

- `path`
- `edits[]`
- `dryRun`

### Edit Verification

The edit engine is memory-first:

1. read file
2. normalize line endings
3. apply every edit to an in-memory working string
4. if any edit fails, write nothing
5. if dry-run, return a minimal preview/diff
6. if successful, atomic-write the result
7. snapshot touched symbols best-effort
8. return minimal success plus only necessary warnings

Content matching tries:

1. exact match
2. trimmed trailing whitespace match
3. indentation-stripped match near `nearLine`

Symbol matching uses tree-sitter bounds. Prefer this for code edits when the symbol is known.

### Stash Recovery

Failed edit/write payloads can be stashed and retried through `stashRestore`.

Current `stashRestore` modes:

- `apply`
- `restore`
- `list`
- `read`

Important distinction:

- `stashRestore restore` clears a stash entry by ID.
- Symbol version rollback is handled by `refactor_batch restore`.
- Symbol history is handled by `refactor_batch history`.
- Project root registration is not a `stashRestore` mode.

Keep stash responses concise. Return the stash ID and only the failed edit indices/details needed for the next correction.

---

## 5. Current Tool Catalog

| Tool | Scope | Key Args |
|---|---|---|
| `read_file` | Read one text file with windowing/truncation/compression | `path`, `maxChars`, `head`, `tail`, `offset`, `aroundLine`, `context`, `ranges`, `showLineNumbers`, `compression` |
| `read_media_file` | Read supported media as base64 | `path` |
| `read_multiple_files` | Read up to 50 files with budget balancing | `paths`, `maxCharsPerFile`, `compression`, `showLineNumbers` |
| `write_file` | Create/overwrite/append text | `path`, `content`, `failIfExists`, `createOnly`, `append` |
| `edit_file` | Surgical content/block/symbol edits | `path`, `edits[]`, `dryRun` |
| `directory` | Directory list/tree exploration | `mode: list/tree`, `path`, `depth`, `includeSizes`, `sortBy`, `excludePatterns`, `showSymbols`, `showSymbolNames` |
| `search_files` | Multi-file content/files/symbol/structural/definition search | `mode`, `path`, mode-specific query fields |
| `search_file` | Single-file grep or symbol lookup | `path`, `grep`, `grepContext`, `symbol`, `nearLine`, `expandLines`, `maxChars` |
| `file_manager` | mkdir/delete/move/info | `mode`, `path`, `source`, `destination` |
| `stashRestore` | Retry/inspect/clear stashed edit/write failures | `mode: apply/restore/list/read`, `stashId`, `corrections`, `newPath`, `dryRun`, `type` |
| `refactor_batch` | Cross-file symbol refactoring and symbol version rollback | `mode: query/loadDiff/apply/reapply/restore/history` |

### Tool Notes

#### `read_file`

No `mode` enum.

Use it for reading text ranges/windows. Do not add grep or symbol lookup here; those belong to `search_file`.

#### `search_file`

Single-file grep/symbol lookup.

Use for:

- âgrep this one fileâ
- âread this symbol bodyâ
- âshow context around this symbolâ

#### `directory`

Modes:

- `list`
- `tree`

No `roots` mode. No `listAllowed`.

Allowed roots are negotiated through MCP Roots and exposed through context, not a public directory mode.

#### `search_files`

Modes:

- `content`
- `files`
- `symbol`
- `structural`
- `definition`

Keep modes distinct. Do not make `content` return file metadata beyond what is needed for search hits.

#### `file_manager`

Modes:

- `mkdir`
- `delete`
- `move`
- `info`

`delete` is file-only unless intentionally changed and reviewed.

#### `refactor_batch`

Modes:

- `query`
- `loadDiff`
- `apply`
- `reapply`
- `restore`
- `history`

Schema highlights:

- `query`: `target`, `fileScope`, `direction`, `depth`
- `loadDiff`: `selection`, `contextLines`, `loadMore`
- `apply`: `payload`, `dryRun`
- `reapply`: `symbolGroup`, `newTargets`, `ack`, `dryRun`
- `restore`: `symbol`, `file`, `version`, `dryRun`
- `history`: `symbol`, `file`

Do not document or call `load`; the mode is `loadDiff`.

Do not use `target`/`fileScope` for `restore` or `history`; those use `symbol`/`file`.

---

## 6. Project Root Resolution

Project root resolution is separate from filesystem access control.

Allowed directories answer:

> What can the agent access?

Project root resolution answers:

> Where should project-scoped state such as `.mcp/symbols.db` live?

Resolution ladder:

1. git repo from the file path or cwd
2. MCP roots / allowed directories
3. project markers such as `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc.
4. explicit project registry
5. global fallback at `~/.zenith-mcp/`

Never let project-root fallback expand filesystem permissions. Only `allowedDirectories` control access.

---

## 7. Refactor Workflow

Typical safe workflow:

1. `search_files` or `refactor_batch query`
2. `refactor_batch loadDiff`
3. inspect outliers
4. `refactor_batch apply` with `dryRun: true`
5. `refactor_batch apply`
6. `refactor_batch history` / `restore` only when rollback is needed

### Query

`query` uses the symbol graph:

- `forward`: callers of target
- `reverse`: callees from target
- `depth`: 1â5

### loadDiff

`loadDiff` loads symbol bodies plus context.

It also computes outlier flags from symbol structure:

- parameter shape
- return type
- parent scope
- decorators
- modifiers

### apply

`apply` gates on:

- loaded cache exists
- payload parses
- outliers acknowledged
- char budget
- syntax checks
- per-file edit atomicity

A failed edit in one file must not write that file. Other independent files may still apply if their bundles pass.

### reapply

`reapply` uses a cached successful payload against new targets.

It must repeat outlier detection and syntax gates. Cached payload is not permission to skip validation.

### restore/history

Use these for symbol version snapshots:

```json
{"mode":"history","symbol":"AuthService.login","file":"src/auth.ts"}
```

```json
{"mode":"restore","symbol":"AuthService.login","file":"src/auth.ts","version":0,"dryRun":true}
```

---

## 8. Adapter System

Adapters live in `src/adapters/`.

Purpose: auto-configure external MCP clients to register Zenith.

Key pieces:

- `src/adapters/base.ts`
  - `MCPConfigAdapter` abstract base class

- `src/adapters/platforms/`
  - per-client adapters

- `src/adapters/registry.ts`
  - adapter registry
  - `configureRegistry()`
  - `getAdapter()`
  - `listAdapters()`

- `src/adapters/helpers/`
  - JSON5, TOML, YAML helpers

Settings:

- `~/.zenith-mcp/adapter-config.json`
- `ZENITH_MCP_ADAPTERS_ENABLED`
- `ZENITH_MCP_ADAPTER_BACKUP_DIR`

CLI:

```bash
npx zenith-mcp-config --list
npx zenith-mcp-config --status
npx zenith-mcp-config --enable claude_desktop,opencode
npx zenith-mcp-config --disable opencode
npx zenith-mcp-config --backup-dir ~/.zenith-mcp/backups
```

Keep adapter write operations conservative:

- read native config
- preserve unknown fields
- backup before mutation
- write only necessary changes
- never print entire config files unless explicitly requested

---

## 9. Config Management

Config management lives in `src/config/zenith-mcp/`.

Config file:

```text
~/.zenith-mcp/zenith-mcp/servers.yaml
```

Legacy config path may still be normalized during load.

Main concepts:

- external MCP server registrations
- tool cache
- profiles
- optional retrieval configuration

Admin CLI:

```bash
npx zenith-mcp-config-admin list
npx zenith-mcp-config-admin status
npx zenith-mcp-config-admin install <server-name> [command] [args...]
npx zenith-mcp-config-admin scan [server-name]
```

Developer rule: config CLIs can be verbose for humans, but MCP tool responses should remain minimal.

---

## 10. Retrieval Pipeline

Retrieval is opt-in and disabled by default.

Enabled through config:

```yaml
retrieval:
  enabled: true
```

Purpose: reduce active tool-list bloat when Zenith manages or proxies larger tool sets.

Fallback ladder:

1. BMXF blend of environment + conversation signals
2. BMXF environment-only
3. keyword environment-only
4. static project categories
5. frequency prior
6. universal fallback

Key components:

- `src/retrieval/pipeline.ts`
- `src/retrieval/session.ts`
- `src/retrieval/ranking/`
- `src/retrieval/telemetry/`
- `src/retrieval/observability/`
- `src/retrieval/routing-tool.ts`
- `src/retrieval/zenith-integration.ts`

The synthetic routing tool can expose demoted tools on demand. Track proxy usage separately from direct usage.

---

## 11. Compression

Compression is TypeScript-based and has no Python dependency.

Flow:

1. `read_file` / `read_multiple_files` request compression
2. `compressTextFile()` computes the budget
3. `runToonBridge()` spawns the compiled JS bridge
4. `dist/core/toon_bridge.js` reads the file, uses tree-sitter structure, and calls the in-process TOON codec
5. caller accepts compressed output only if it is actually useful

Important nuance:

- `compression.ts` uses a Node subprocess for isolation/timeouts.
- The bridge itself performs in-process TypeScript compression.
- âNo Pythonâ does not mean âno child process.â

---

## 12. Adding or Changing a Tool

Checklist:

1. Add or edit `src/tools/<tool>.ts`.
2. Export `register(server, ctx)`.
3. Use strict Zod schemas.
4. Every filesystem path must pass through `ctx.validatePath()` before filesystem access.
5. Set annotations:
   - `readOnlyHint`
   - `idempotentHint`
   - `destructiveHint`
6. Register the tool in `src/core/server.ts`.
7. Add/update tests.
8. Keep output minimal.
9. Update README only for public-facing behavior.
10. Update ARCHITECTURE.md for detailed implementation behavior.
11. Update this file for developer-facing cheat-sheet changes.

Path field checklist:

- single target: `path`
- source/destination pair: `source`, `destination`
- refactor symbol file hint: `file`
- query scope hint: `fileScope`

Do not invent parallel names unless there is a compatibility reason.

---

## 13. Testing Notes

The project uses Vitest.

General flow:

```bash
npm install
npm run build
npm test
```

Tests usually import compiled `dist/` modules, so build first.

Tree-sitter tests require grammars to exist under `dist/grammars/`, which the build script creates by copying root `grammars/`.

Generated local state to clean when needed:

- `dist/`
- `coverage/`
- `.mcp/`
- `~/.zenith-mcp/`

---

## 14. Code Snippets

### Find a Symbol

```ts
import { findSymbol } from '../core/tree-sitter.js';

const matches = await findSymbol(sourceCode, 'javascript', 'AuthService.login', {
  kindFilter: 'def',
});
```

### Rank Search Results

```ts
import { bm25RankResults, CHAR_BUDGET } from '../core/shared.js';

const ranked = bm25RankResults(rawRipgrepLines, 'authentication logic', CHAR_BUDGET);
```

### Validate Before Filesystem Access

```ts
const validPath = await ctx.validatePath(args.path);
const content = await fs.readFile(validPath, 'utf8');
```

### Minimal Tool Return

```ts
return {
  content: [{ type: 'text', text: 'Applied.' }],
};
```

---

## 15. Things Not To Regress

- Do not reintroduce `read_text_file`.
- Do not add grep or symbol modes back into `read_file`.
- Do not document `directory.roots`.
- Do not document `directory.listAllowed`.
- Do not use `refactor_batch load`; use `loadDiff`.
- Do not use `target`/`fileScope` for `refactor_batch restore/history`; use `symbol`/`file`.
- Do not move runtime-only generated state into git.
- Do not put grammars back under `dist/` as source of truth.
- Do not make tool returns verbose just because the backend has impressive internals.