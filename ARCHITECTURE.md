# Zenith-MCP Architecture & Developer Guide

A comprehensive code-level reference for the Zenith-MCP filesystem server. Read this document to understand every module, data flow, security boundary, and implementation detail.

---

## 1. Project Overview

Zenith-MCP is a Node.js Model Context Protocol (MCP) server that provides filesystem operations, code-aware editing, intelligent search, and cross-file refactoring. It supports two transports:

- **stdio** — local MCP transport for desktop clients (Claude Desktop, VS Code)
- **HTTP** — remote transport with Streamable HTTP + legacy SSE, bearer-token auth, and per-session isolation

Key capabilities:
- Flexible text reading (`head`, `tail`, `offset`, `aroundLine`, `ranges`, line numbers, and optional compression)
- Single-file grep and symbol lookup via `search_file`
- Surgical editing (content-match, block-replace, symbol-replace) with dry-run support
- Intelligent search (ripgrep + inline BM25 ranking, symbol search, structural similarity)
- Cross-file batch refactoring with impact analysis and rollback
- Tree-sitter AST parsing for 40+ languages (lazy-loaded WASM grammars)
- Per-project SQLite symbol indexing with version snapshots
- Stash system for retrying failed edits/writes
- Structured code compression via the TypeScript `toon` library and Node bridge

---

## 2. Entry Points

### `src/cli/stdio.ts`

The stdio entry point. Parses CLI arguments as baseline allowed directories, creates a single shared `FilesystemContext`, and connects over `StdioServerTransport`.

```javascript
const ctx = createFilesystemContext(allowedDirectories);
const server = createFilesystemServer(ctx);
attachRootsHandlers(server, ctx);
await server.connect(new StdioServerTransport());
```

- One process, one context, one server instance
- If no CLI directories are provided, prints a usage warning but continues; the server will throw during MCP initialization if the client also doesn't support roots
- Sets both the per-instance context dirs and the global `allowedDirectories` for backward compatibility

### `src/server/http.ts`

The HTTP entry point. Express app with session-per-client isolation.

```javascript
const baselineAllowedDirs = await resolveInitialAllowedDirectories(dirArgs);
function createSessionPair() {
    const ctx = createFilesystemContext([...baselineAllowedDirs]);
    const server = createFilesystemServer(ctx);
    attachRootsHandlers(server, ctx);
    return { ctx, server };
}
```

**Endpoints:**
- `POST /mcp` — Streamable HTTP messages
- `GET /mcp` — Streamable HTTP SSE notification stream
- `DELETE /mcp` — Session teardown
- `GET /sse` — Legacy SSE transport
- `POST /messages` — Legacy SSE message endpoint
- `GET /health` — Health check

**Session lifecycle:**
- Each new client gets a fresh `{ ctx, server }` pair
- Sessions are stored in a `Map` keyed by session ID
- `SESSION_TTL_MS` (default 30 min) reaper closes idle sessions
- Bearer token auth via `ZENITH_MCP_API_KEY` / `MCP_BRIDGE_API_KEY` / `COMMANDER_API_KEY`
- Transport types are never mixed (streamable vs SSE sessions are checked on every request)

---

## 3. High-Level Architecture

```
Entry (stdio.ts / http.ts)
    │
    ├──► createFilesystemContext(initialDirs)
    │       ├──► getAllowedDirectories()
    │       ├──► setAllowedDirectories(dirs)
    │       └──► validatePath(requestedPath)  ← security boundary
    │
    ├──► createFilesystemServer(ctx)
    │       ├──► configureRegistry()           ← adapter system init
    │       ├──► RetrievalPipeline init         ← opt-in tool retrieval
    │       └──► registerAllTools(server, ctx)
    │               ├──► read_file
    │               ├──► read_media_file
    │               ├──► read_multiple_files
    │               ├──► write_file
    │               ├──► edit_file
    │               ├──► directory
    │               ├──► search_files
    │               ├──► search_file
    │               ├──► file_manager
    │               ├──► stashRestore
    │               └──► refactor_batch
    │
    └──► attachRootsHandlers(server, ctx)
            ├──► oninitialized → listRoots() → setAllowedDirectories()
            └──► roots/list_changed → refresh dirs
```

### Module Map

| Module | Responsibility |
|--------|----------------|
| `src/core/server.ts` | Orchestrator: creates `McpServer`, registers tools, wires roots protocol, initializes adapter registry and retrieval pipeline |
| `src/core/lib.ts` | Security & I/O: `FilesystemContext` factory, `validatePath`, file ops, diff utils |
| `src/core/path-utils.ts` | Cross-platform path normalization (WSL-aware, UNC-aware) |
| `src/core/path-validation.ts` | Linux-focused path normalization with caching, `isPathWithinAllowedDirectories` |
| `src/core/roots-utils.ts` | Parses MCP root URIs (`file://...`) to validated directory paths |
| `src/core/shared.ts` | Search engine: inline BM25, ripgrep wrappers, media streaming, sensitive file detection |
| `src/core/tree-sitter.ts` | Semantic parsing: WASM grammar loading, symbol extraction, syntax checking, structural fingerprinting |
| `src/core/edit-engine.ts` | Pure-function edit verification: content/block/symbol matching, batch application |
| `src/core/symbol-index.ts` | SQLite schema, file indexing, impact queries, version snapshots |
| `src/core/project-context.ts` | Project root resolution via `project-scope.ts`; stash DB routing; manual project registration |
| `src/core/project-registry.ts` | `ProjectManifest`-based explicit project matching with 5-tier strategy |
| `src/core/stash.ts` | Stash persistence API (SQLite, per-project or global) |
| `src/core/compression.ts` | Compression budget math, truncation fallback, and Node child-process bridge to compiled `toon_bridge.js` |
| `src/core/toon_bridge.ts` | Bridge executable: reads a file, extracts tree-sitter structure, and runs the TypeScript toon codec (no Python) |
| `src/toon/` | Compression library: BMX+ scoring, SageRank, dedup, budget allocation, string codec |
| `src/utils/project-scope.ts` | Project root resolution ladder: git → MCP roots + git → markers → registry → global |

---

## 4. Security Model

### Allowed Directories (The Sandbox)

All filesystem operations MUST go through `ctx.validatePath(requestedPath)` before any `fs` call.

**Validation flow:**
1. Expand `~` to home directory
2. Resolve to absolute path (relative to `process.cwd()` if not absolute)
3. Normalize
4. Check if the requested path is within `_allowedDirectories`
5. Call `fs.realpath()` to resolve symlinks
6. Re-check if the real path (and its parent, if the file doesn't exist) is still within allowed directories
7. Return the real path

**Critical:** If `validatePath()` fails, the operation throws **before** any `fs` call.

### Sensitive File Blocking

`isSensitive(filePath)` in `src/core/shared.ts` blocks credentials files using `minimatch` globs:
- Default patterns: `.env`, `*.pem`, `*.key`, `*.crt`, `*credentials*`, `*secret*`, `docker-compose.yaml/yml`, `.config/**`
- Checked by search tools, tree-sitter indexing, and file discovery
- **Not** checked by direct read/write tools (the path sandbox is the primary defense)

### Exclusive Writes

`writeFileContent()` in `src/core/lib.ts` uses the `wx` flag for new files. If the file already exists, it falls back to a temp-file + atomic `fs.rename()` pattern. This prevents symlink-based attacks where an attacker pre-creates a symlink at the target path.

### Per-Session Isolation (HTTP)

Each HTTP session gets its own `FilesystemContext` copy. MCP roots negotiations for one session do not affect another. Session reaping prevents unbounded memory growth.

---

## 5. Core Modules Deep Dive

### 5.1 `src/core/lib.ts` — Filesystem Context & I/O

**`createFilesystemContext(initialAllowedDirectories)`**

Factory that returns a per-instance context object:
```javascript
{
  getAllowedDirectories(),
  setAllowedDirectories(dirs),
  validatePath(requestedPath)
}
```

HTTP mode creates one context per session. stdio mode creates one global context.

**I/O utilities:**
- `formatSize(bytes)` — human-readable sizes (B, KB, MB, GB, TB)
- `normalizeLineEndings(text)` — converts `\r\n` → `\n`
- `createUnifiedDiff(original, modified, filepath)` / `createMinimalDiff(...)` — diff generation
- `getFileStats(filePath)` — returns `{ size, created, modified, accessed, isDirectory, isFile, permissions }`
- `readFileContent(filePath, encoding)` — simple read
- `writeFileContent(filePath, content)` — exclusive write with temp-file fallback
- `applyFileEdits(filePath, edits, dryRun)` — legacy full-file edit application (content-match + indent-stripped match)
- `countOccurrences(text, search)` — substring count
- `tailFile(filePath, numLines)` / `headFile(filePath, numLines)` — efficient chunked reads
- `offsetReadFile(filePath, offset, length)` — line-based offset read
- `searchFilesWithValidation(rootPath, pattern, allowedDirectories, options)` — JS glob search with exclude patterns

### 5.2 `src/core/path-utils.ts` & `src/core/path-validation.ts`

**`path-utils.ts`** — Cross-platform normalization:
- Preserves WSL paths (`/mnt/c/...`)
- Converts Unix-style Windows paths (`/c/...`) only on Windows
- Handles UNC paths (`\\server\share`)
- Normalizes double slashes, trailing slashes

**`path-validation.ts`** — Linux-focused normalization with LRU cache (1000 entries):
- Strips quotes, expands `~`, rejects null bytes
- Uses Node's `path.normalize()`
- `isPathWithinAllowedDirectories(filePath, allowedDirectories)` — checks if resolved path starts with any allowed dir + `/`

### 5.3 `src/core/shared.ts` — Search Engine

**BM25 Index (`BM25Index` class)**

Inline zero-dependency BM25 implementation (~120 lines):
- **Tokenizer:** `/[a-z0-9_]+/g`, filters to length > 1 (or `a`/`i`)
- **IDF:** Lucene-variant (always non-negative): `log((N - df + 0.5) / (df + 0.5) + 1)`
- **Entropy weighting:** Per-term normalized entropy `[0, 1]`. High-entropy terms (evenly distributed) are downweighted; low-entropy terms (concentrated in few docs) are boosted.
- **Sigmoid TF saturation:** `tfComponent = 1 / (1 + exp(-k1 * (tf - K/2) / K))` instead of raw BM25 TF
- **Scoring:** TAAT (term-at-a-time) posting list traversal, scores normalized to `[0, 1]`

**Pre-filter mode:** `bm25PreFilterFiles(rootPath, query, topK, excludePatterns)`
- Builds a BM25 corpus from file paths (boosted 3×) + first 8KB of text files
- Indexes only known text extensions (60+ extensions hardcoded)
- Respects `.gitignore` via ripgrep when available; JS manual walk fallback
- Caps at 5000 files, 512KB per file
- `search_files` calls with topK=100; function default is 50

**Post-filter mode:** `bm25RankResults(lines, query, charBudget)`
- Ranks raw result lines by BM25 relevance
- Accumulates within `CHAR_BUDGET` (default 400k, override via env)

**Ripgrep integration:**
- `ripgrepAvailable()` — checks `/usr/bin/rg` for executable access
- `ripgrepSearch(rootPath, options)` — JSON output parsing, returns `{ file, line, content }[]`
- `ripgrepFindFiles(rootPath, options)` — `--files` mode with glob filtering
- Both respect `.gitignore`, `.ignore`, `.rgignore` automatically
- 30-second spawn timeout
- JS fallback for when ripgrep is unavailable

**Media:** `readFileAsBase64Stream(filePath)` — streams file to base64.

### 5.4 `src/core/tree-sitter.ts` — Semantic Parsing

**Language support:** 40+ languages via `EXT_TO_LANG` mapping and shipped WASM grammar files. Languages include JavaScript, TypeScript, TSX, Python, Bash, Go, Rust, Java, C, C++, C#, Kotlin, PHP, Ruby, Swift, CSS, JSON, YAML, SQL, Markdown, Dart, Elixir, GraphQL, HCL, HTML, Lua, Make, Nix, Perl, Prisma, Proto, R, SCSS, Svelte, TOML, Vue, XML, CMake, Dockerfile, and more.

**Lazy loading architecture:**
- `Parser.init()` — called once, loads `tree-sitter.wasm`
- `loadLanguage(langName)` — loads `tree-sitter-{lang}.wasm`, cached permanently in `_languageCache`
- `loadQueryString(langName)` — loads query files, cached permanently
- `getCompiledQuery(langName)` — compiles `Query` object, cached permanently

**Symbol cache:** Parsed symbols are cached by MD5 hash of `langName + source` in an LRU cache (100 entries).

**Core APIs:**
- `getSymbols(source, langName, options)` — returns `{ name, kind, type, line, endLine, column }[]`
  - Uses `query.matches()` to pair `@name.definition.*` captures with `@definition.*` body captures
  - `kindFilter`: `'def'` or `'ref'`
  - `typeFilter`: `'function'`, `'class'`, `'method'`, etc.
  - `nameFilter`: substring match on symbol name
- `getDefinitions(source, langName, options)` — convenience wrapper with `kindFilter: 'def'`
- `findSymbol(source, langName, symbolName, options)` — finds specific symbol by name
  - Supports dot-qualified names: `AuthService.login`
  - Walks parent containment for qualified names
  - Sorts by proximity to `nearLine` if multiple matches
- `getSymbolSummary(source, langName)` / `getSymbolSummaryString(...)` — counts by type, formatted compactly
- `getFileSymbols(filePath, options)` / `getFileSymbolSummary(filePath)` — file-to-symbols pipeline
- `checkSyntaxErrors(source, langName)` — walks AST for `ERROR` and missing nodes, returns `{ line, column }[]`
- `getStructuralFingerprint(source, langName, startLine, endLine)` — returns AST node types in range (for structural similarity)
- `computeStructuralSimilarity(fpA, fpB)` — Jaccard similarity of 3-grams over fingerprints
- `getSymbolStructure(source, langName, startLine, endLine)` — extracts params, return type, parent kind, decorators, modifiers
- `getCompressionStructure(source, langName)` — extracts definition blocks with control-flow anchors (for compression)

### 5.5 `src/core/edit-engine.ts` — Edit Verification

Pure-function edit application. No I/O.

**`findMatch(content, oldText, nearLine)`**

Three matching strategies (tried in order):
1. **Exact match** — `content.includes(normalizedOld)`
2. **Trimmed trailing whitespace match** — compares lines with `trimEnd()`, then maps index back to original
3. **Indentation-stripped match** — compares `trim()`'d lines within a ±50 line window of `nearLine`. Re-indents `newText` to match the file's indentation.

**`applyEditList(content, edits, options)`**

Processes edits sequentially against an in-memory string:
- `mode: 'content'` — uses `findMatch()` for `oldContent` → `newContent`
- `mode: 'block'` — finds all pairs of lines matching `block_start` and `block_end`, disambiguates with `disambiguations` map if multiple candidates
- `mode: 'symbol'` — uses `findSymbol()` to locate symbol bounds, replaces with `newText`

Returns `{ workingContent, errors, pendingSnapshots }`.
- `errors` is an array of `{ i, msg }` for failed edits
- `pendingSnapshots` is an array of `{ symbol, originalText, line, filePath }` for symbol-mode edits
- If any edit fails, **none** are applied to the file (the caller handles this)

**`syntaxWarn(filePath, content)`**
- Runs `checkSyntaxErrors()` on the modified content
- Returns a minimal warning string (`⚠ Parse errors at lines ...`) or empty string

### 5.6 `src/core/symbol-index.ts` — Symbol Database

**`findRepoRoot(filePath)`**
- Runs `git rev-parse --show-toplevel` with 5s timeout
- Returns `null` if not in a git repo

**`getDb(repoRoot)`**
- Creates `.mcp/symbols.db` in the repo root
- Auto-creates `.mcp/.gitignore` with `*` to prevent committing the DB
- WAL mode, normal sync, 5s busy timeout, foreign keys ON
- Schema:
  - `files(path PRIMARY KEY, hash, last_indexed)`
  - `symbols(id, name, kind, type, file_path, line, end_line, column)`
  - `edges(id, container_def_id, referenced_name)` — which def references which name
  - `versions(id, symbol_name, file_path, original_text, session_id, created_at, line, text_hash)` — version snapshots
  - `patterns(id, name UNIQUE, edit_body, symbol_kind, created_at)`
- Indexes: `symbols(name)`, `symbols(file_path)`, `symbols(kind, name)`, `edges(referenced_name)`, `edges(container_def_id)`, `versions(session_id)`, `versions(symbol_name, file_path, text_hash, session_id)` (dedup)
- Schema migrations handled with `try/catch` on `ALTER TABLE`
- Prunes old versions on open (default TTL: 24h, override via `REFACTOR_VERSION_TTL_HOURS`)

**`indexFile(db, repoRoot, absFilePath)`**
- Reads file, checks hash against `files` table
- If changed (or new), parses symbols via `getSymbols()`, separates defs/refs
- Transaction: delete old symbols → insert file → insert defs → insert refs → compute containment edges (innermost def for each ref)

**`indexDirectory(db, repoRoot, dirPath, opts)`**
- Walks directory, skips `DEFAULT_EXCLUDES`
- Batch-indexes in groups of 50

**`ensureIndexFresh(db, repoRoot, absFilePaths)`**
- Re-indexes only files whose hashes have changed

**`impactQuery(db, symbolName, opts)`**
- `direction: 'forward'` — who calls `symbolName`? (callers)
- `direction: 'reverse'` — what does `symbolName` call? (callees)
- `depth` — transitive levels (default 1, max 5)
- `file` — disambiguates when multiple files define the same symbol
- Returns `{ results, total }` or `{ disambiguate: true, definitions: [...] }`

**Version management:**
- `snapshotSymbol(db, symbolName, filePath, originalText, sessionId, line)` — saves current text
- `getVersionHistory(db, symbolName, sessionId, filePath)` — lists snapshots
- `getVersionText(db, versionId)` — retrieve text
- `restoreVersion(db, symbolName, versionId, sessionId, currentText)` — validates ownership, returns original text

### 5.7 `src/core/project-context.ts` — Project Root Resolution

Singleton `ProjectContext` class. The single authority on "what project am I in?"

**Resolution ladder** — delegates to `src/utils/project-scope.ts`:

1. **Git repo detection** from the file path itself (or `process.cwd()` when no file is given)
2. **MCP roots / allowed directories** — git detection on each root, with single-dir fallback if none have git
3. **Marker-based detection** — walks up from the resolved directory looking for 16 project markers: `package.json`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `requirements.txt`, `go.mod`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `composer.json`, `Gemfile`, `mix.exs`, `stack.yaml`, `CMakeLists.txt`, `.git`
4. **ProjectRegistry matching** — 5-tier matching (by ID, name, path segment, exact path, path prefix) against manually registered projects
5. **Global fallback** — `~/.zenith-mcp/`

**API:**
- `getRoot(filePath)` — main entry point; auto-promotes first-touched repo as bound root
- `getStashDb(filePath)` — returns `{ db, root, isGlobal }`
- `initProject(rootPath, name)` — manually registers a non-git directory as a project root (sticky, persists to global DB)
- `listRegisteredProjects()` — lists manually registered roots
- `refresh()` — force re-resolution (called on roots change)

**Storage:** `~/.zenith-mcp/global-stash.db` with `project_roots(root_path PRIMARY KEY, name, created_at)`.

### 5.8 `src/core/stash.ts` — Stash Persistence

All stash operations go through `ProjectContext` for DB resolution.

**`stashEntry(ctx, type, filePath, payload)`**
- Inserts into `stash(id, type, file_path, payload, attempts, created_at)`
- Returns `lastInsertRowid` as stash ID

**`getStashEntry(ctx, id, filePath)`** — retrieves and parses JSON payload.
**`consumeAttempt(ctx, id, filePath)`** — increments attempts, deletes if > 2. Returns `false` if max retries exceeded.
**`clearStash(ctx, id, filePath)`** — deletes entry.
**`listStash(ctx, filePath)`** — lists all entries.

Convenience wrappers:
- `stashEdits(ctx, filePath, edits, failedIndices)` — type `'edit'`
- `stashWrite(ctx, filePath, content, mode)` — type `'write'`

### 5.9 `src/core/compression.ts` & `src/core/toon_bridge.ts`

**`compressTextFile(validPath, rawText, maxChars, keepRatio)`**
- Computes target budget: `min(maxChars, rawLength * keepRatio)` (default keepRatio 0.70)
- Calls `runToonBridge(validPath, targetBudget)`
- Returns `{ text, targetBudget, rawLength, compressedLength }` or `null` if compression isn't useful

**`runToonBridge(validPath, budget)`**
- Spawns: `node dist/core/toon_bridge.js <filepath> <budget>` (the compiled JS bridge)
- The bridge process reads the file, extracts AST structure via tree-sitter `getCompressionStructure()`, then compresses using the TypeScript `toon` codec (`compressSourceStructured()` or `compressString()`)
- No Python dependency and no external service. This is still a short-lived Node child process spawned from the main server.
- 30-second timeout
- Falls back to returning `null` on any error

### 5.10 `src/toon/` — Compression Library

A full compression library ported from Python, operating entirely in-process with zero external dependencies.

| Module | Purpose |
|--------|---------|
| `bmx-plus.ts` | BMX+ scoring algorithm (BM25 variant) |
| `sagerank.ts` | SageRank scoring for relevance ranking |
| `dedup.ts` | Deduplication of compressed output |
| `budget.ts` | Character budget allocation |
| `config.ts` | Compression configuration |
| `encoder.ts` | Encoding utilities |
| `pipeline.ts` | Compression pipeline orchestration |
| `presets.ts` | Predefined compression presets |
| `router.ts` | Strategy routing for compression methods |
| `string-codec.ts` | Core codec: `compressSourceStructured()` and `compressString()` |
| `types.ts` | Type definitions (`StructureBlock`, etc.) |
| `utils.ts` | Utility functions |
| `index.ts` | Public API re-exports |

---

## 6. Tools Deep Dive

### `read_file`

**Schema:** single schema (no explicit `mode` enum)

- `path` (string)
- `maxChars` (number, optional, default 50000, up to 400k)
- `head` (number, optional) — first N lines
- `tail` (number, optional) — last N lines
- `offset` (number, optional) — start line (0-based), combine with `head`
- `aroundLine` (number, optional) — center window on this line
- `context` (number, optional, default 30) — window radius
- `ranges` (array of `{startLine, endLine}`, optional) — explicit line ranges
- `showLineNumbers` (boolean, optional)
- `compression` (boolean, optional) — compress whitespace via structured compression

**Flow & Windowing:**
- If `compression` is true, attempts `compressTextFile()` first; falls back to truncation
- `tail` uses efficient backward chunk reading
- `head` uses forward chunk reading
- `offset` + `head` uses line-based streaming
- Windowing (`aroundLine` / `ranges`) merges overlapping windows before reading and emits `---` separators between disjoint windows.
- Smart truncation: truncates at last newline before budget, adds `[truncated offset=N]` meta header

### `read_media_file`

`path` only. Streams file as base64. MIME type from extension lookup table.
Returns `{ type: 'image'|'audio'|'blob', data: base64, mimeType }`.

### `read_multiple_files`

`paths` (1–50), `maxCharsPerFile`, `compression` (default true), `showLineNumbers`.

**Budget algorithm:**
- Total budget = `CHAR_BUDGET - (fileCount * 200)`
- If no `maxCharsPerFile`: sorts files by size, allocates budget proportionally (larger files get more share, but capped)
- Reads in parallel with concurrency limit of 8
- Attempts compression per file; falls back to raw read with byte limit = `budget * 4`
- Final output truncated to `CHAR_BUDGET` if still over

### `write_file`

`path`, `content`, `failIfExists` (default false), `append` (default false).

- Normalizes line endings to `\n`
- Auto-creates parent directories
- If `append` and file exists: smart overlap detection
  - Compares last 500 lines of existing file against incoming content
  - Finds longest matching tail overlap
  - Appends only non-overlapping portion
- Atomic write: temp file → `fs.rename()`
- Write verification: compares temp file size to expected byte length
- On failure: stashes content and returns `stash:<id>`

### `edit_file`

`path`, `edits[]`, `dryRun` (default false).

**Edit schema:** discriminated union on `mode`
- `content`: `oldContent`, `newContent`
- `block`: `block_start`, `block_end`, `replacement_block`
- `symbol`: `symbol`, `newText`, `nearLine`

**Flow:**
1. Read file, normalize line endings
2. `applyEditList()` in memory
3. If errors: stash failed edits, return `stash:<id>` + failure messages
4. If dryRun: return minimal diff via `createMinimalDiff()`
5. Atomic write via temp file
6. Snapshot symbol versions to SQLite (best-effort, never fails the edit)
7. Run `syntaxWarn()` on result
8. Return `Applied.` + optional parse warning

### `directory`

**Schema:** discriminated union on `mode`

- **`list`** — `path`, `depth` (default 1, max 10), `includeSizes`, `sortBy` (`name`|`size`)
  - Recursively lists directory contents
  - Directories formatted with trailing `/`
  - 250-entry cap per directory level
  - Truncation indicator: `[truncated]`
  - On `fs.readdir` error: returns `[DENIED] <name>`
  - Size sorting requires `includeSizes`

- **`tree`** — `path`, `excludePatterns`, `showSymbols`, `showSymbolNames`
  - Recursive tree with 2-space indentation
  - 500-entry total cap
  - Respects `DEFAULT_EXCLUDES` + user `excludePatterns`
  - Symbol metadata fetched via `getFileSymbolSummary()` / `getFileSymbols()`
  - Control characters escaped in output

`directory` does not expose a `roots` mode. Allowed root directories are managed through CLI arguments and the MCP Roots protocol, not as a public directory tool operation.

### `search_files`

**Schema:** discriminated union on `mode`

- **`content`** — `path`, `contentQuery`, `pattern`, `contextLines` (default 0), `literalSearch`, `countOnly`, `includeHidden`, `maxResults` (default 50)
  - Always case-insensitive
  - If ripgrep available: attempts BM25 pre-filter (top 100 files) → ripgrep on filtered set
  - If pre-filter fails or query ≤ 2 chars: falls back to full ripgrep
  - If ripgrep unavailable: JS fallback with regex search
  - Post-filter: BM25 ranks results if > 50 lines, otherwise simple budget truncation
  - `SEARCH_CHAR_BUDGET` defaults to 15k (override via env)

- **`files`** — `path`, `pattern`, `namePattern`, `pathContains`, `extensions`, `includeMetadata`, `includeHidden`, `maxResults`
  - ripgrep `--files` when available, JS walk fallback
  - `includeMetadata` adds `(sizeKB, YYYY-MM-DD)` suffix

- **`symbol`** — `path`, `symbolQuery` (optional), `symbolKind`, `pattern`, `maxResults`
  - If `symbolQuery` omitted: lists all symbols
  - Scans supported files, parses definitions via `getDefinitions()`
  - Returns: `relPath:line [type] name (lines start-end)`

- **`structural`** — `path`, `structuralQuery`, `symbolKind`, `maxResults`
  - Requires git repo (for symbol index)
  - Builds structural fingerprint of query symbol via `getStructuralFingerprint()`
  - Compares to all candidates via `computeStructuralSimilarity()`
  - Returns matches with ≥ 0.5 similarity score

- **`definition`** — `path`, `definesSymbol`, `namePattern`, `pathContains`, `extensions`, `maxResults`
  - Finds files defining a specific symbol name
  - Supports dot-qualified names (e.g., `AuthService.login`)
  - Uses tree-sitter definition parsing, not text search

### `search_file`

Single-file search — grep or symbol lookup within one file. Read-only.

**Schema:** `path` (required), plus one of `grep` or `symbol`.

- **Grep mode** — `grep` (regex, case-insensitive), `grepContext` (default 0, max 30), `maxChars`, `nearLine`
  - Streaming `readline`-based scan with before/after context buffers
  - Emits `---` separators between disjoint match groups
  - Lines prefixed with `lineNum:*` for matches, `lineNum:` for context

- **Symbol mode** — `symbol` (dot-qualified), `nearLine`, `expandLines` (default 0, max 50), `maxChars`
  - Uses `findSymbol()` with `kindFilter: 'def'`
  - Returns symbol body plus `expandLines` context on each side
  - Always prefixes line numbers

### `file_manager`

**Schema:** discriminated union on `mode`

- `mkdir` — `path`: recursive directory creation
- `delete` — `path`: file deletion only (throws if directory)
- `move` — `source`, `destination`: `fs.rename()`
- `info` — `path`: returns metadata via `getFileStats()`

### `stashRestore`

**Schema:** discriminated union on `mode`

- **`apply`** — `stashId`, `corrections[]` (`{ index, startLine, nearLine }`), `newPath`, `dryRun`
  - Retrieves stashed edit or write
  - For edits: re-runs `applyEditList()` with disambiguations, writes atomically, clears stash
  - For writes: writes stashed content (with append overlap logic if mode was append), clears stash
  - Max 2 attempts; stash deleted on exceeded

- **`restore`** — `stashId`
  - Stash entry rollback: clears stash entry by ID.
  - *(Note: Symbol version history and restoration were moved to `refactor_batch` tool.)*

- **`list`** — `type` (`'edit'` | `'write'`, optional), `file` (optional)
  - Lists stash entries with attempt count

- **`read`** — `stashId`, `file` (optional)
  - Shows stash entry contents (edit modes + status, or write preview)

### `refactor_batch`

**Schema:** discriminated union on `mode`

- **`query`** — `target`, `fileScope`, `direction` (`forward`|`reverse`), `depth` (1–5)
  - Resolves project root, ensures symbol index exists
  - Runs `impactQuery()` on the symbol index
  - Caches results in `_loadCache` keyed by `${repoRoot}::${sessionId}`
  - Returns indexed list of callers or callees

- **`loadDiff`** — `selection[]` (index numbers or `{ symbol, file }`), `contextLines`, `loadMore`
  - Loads symbol bodies plus surrounding context
  - Fetches occurrences via `findSymbol()`
  - **Outlier detection:** computes `getSymbolStructure()` for each occurrence, finds modal structure, flags deviations (param shape, return type, parent scope, decorators, modifiers)
  - Emits blocks with headers: `symbol [index] relPath` (or `⚠ reason` if flagged)
  - Char budget: `MAX_CHARS` (default 30k, override via `REFACTOR_MAX_CHARS`)
  - Supports pagination via `loadMore`
  - Caches occurrences in `_loadCache`

- **`apply`** — `payload` (diff string with symbol headers), `dryRun`
  - Parses payload into groups: `symbol indices ack:ackList` + body
  - Gates:
    1. All symbols must exist in loaded cache
    2. Flagged outliers must be acknowledged (`ack` list)
    3. Char budget check
    4. Syntax check via `checkSyntaxErrors()`
  - Builds per-file edit bundles
  - Per-file atomic: if any edit in a file fails, that file is skipped entirely
  - Successful files written atomically, symbol versions snapshotted, index refreshed
  - Successful payloads cached in `_payloadCache` for `reapply`
  - Retry state: 2 attempts per symbol group, then locked ("Use edit_file directly")

- **`reapply`** — `symbolGroup`, `newTargets[]`, `dryRun`
  - Retrieves cached payload from `_payloadCache`
  - Resolves new targets via symbol index or explicit file hints
  - Re-runs outlier detection, syntax gate, char budget
  - Applies to new targets with same per-file atomic semantics

- **`restore`** — `symbol`, `file`, `version`, `dryRun`
  - Symbol version restore: reads version history, replaces symbol body via tree-sitter, snapshots current text first
  - `file` is required for restore; omitting `version` lists available snapshots instead of writing

- **`history`** — `symbol`, `file`
  - Lists version snapshots for a symbol from SQLite
  - `file` is optional for history and filters snapshots when provided

---

## 7. Adapter System

Zenith-MCP ships auto-configuration adapters for 16 MCP client platforms. These adapters read/write the client's native config file to register Zenith as an MCP server.

**Base class:** `src/adapters/base.ts` — `MCPConfigAdapter`
- Abstract methods: `configPath()`, `readConfig()`, `writeConfig()`, `registerServer()`, `discoverServers()`
- Properties: `toolName`, `displayName`, `configFormat` (`json`|`toml`|`yaml`|`json5`), `supportedPlatforms`
- Backup: `backup()` creates a `.bak` copy before any write

**Platform adapters:** `src/adapters/platforms/`
- `claude-desktop.ts`, `opencode.ts`, `cline.ts`, `codex-cli.ts`, `codex-desktop.ts`, `continue-dev.ts`, `gemini-cli.ts`, `github-copilot.ts`, `gptme.ts`, `jetbrains.ts`, `openclaw.ts`, `raycast.ts`, `roo-code.ts`, `warp.ts`, `zed.ts`, `antigravity.ts`
- Each exports an `adapter` singleton

**Registry:** `src/adapters/registry.ts` — `AdapterRegistry`
- Singleton with `configureRegistry(backupDir?)`, `getAdapter(toolName)`, `listAdapters()`
- Server initialization (`src/core/server.ts`) loads settings and initializes registry when adapters are enabled

**Config format helpers:** `src/adapters/helpers/` — `json5.ts`, `toml.ts`, `yaml.ts`

**Settings:** `src/config/adapter-settings.ts`
- Persisted at `~/.zenith-mcp/adapter-config.json`
- Env overrides: `ZENITH_MCP_ADAPTERS_ENABLED`, `ZENITH_MCP_ADAPTER_BACKUP_DIR`

**Adapter CLI:** `npx zenith-mcp-config`
- `--list` — show all adapters
- `--status` — show enabled adapters
- `--enable <names>` — enable comma-separated adapters
- `--disable <name>` — disable adapter
- `--backup-dir <path>` — set backup directory
- Interactive mode when no flags given

---

## 8. Config Management

### Zenith-MCP Server Config (`src/config/zenith-mcp/`)

YAML-based configuration for managing external MCP servers and tool retrieval settings.

**Config file:** `~/.zenith-mcp/zenith-mcp/servers.yaml` (legacy path: `~/.zenith-mcp/multi-mcp/servers.yaml`)

**Config structure:** `ZenithMcpConfig`
```yaml
servers:
  my-server:
    command: npx
    args: ["-y", "my-server"]
    env: {}
    transport: stdio
    enabled: true
    tools: {}
    toolFilters: { allow: [], deny: [] }
profiles:
  default:
    servers: [my-server]
retrieval:
  enabled: false
  topK: 15
  scorer: bmxf
```

**Config loading:** `loadZenithMcpConfig()` reads YAML, normalizes via `normalizeServerConfig()` which handles both TS-era and Python-era field names (e.g., `type` → `transport`, `triggers` → `toolFilters.allow`, `idle_timeout_minutes` → `idleTimeoutSeconds`).

**Tool cache:** `cache.ts`
- `mergeDiscoveredTools()` — merges discovered tools, preserves existing `enabled` state, updates `lastSeenAt`
- `cleanupStaleTools()` — removes disabled tools from previous discovery cycles
- `getEnabledTools()` — returns set of enabled tool names

**Admin CLI:** `npx zenith-mcp-config-admin`
- `list [--server-filter <name>] [--disabled-only]` — list servers and tools with staleness indicators
- `status` — multi-line status summary
- `install <server-name> [command] [args...]` — register a server
- `scan [server-name]` — read-only server discovery from config

---

## 9. Retrieval Pipeline

Opt-in (disabled by default) system for dynamically filtering the tool set presented to LLM clients based on workspace context and conversation history. Reduces context waste when Zenith is used as a proxy managing many MCP servers.

**Enabled via:** `retrieval.enabled: true` in `servers.yaml`

### Architecture

```
src/retrieval/
├── models.ts          — Core types: RetrievalConfig, ScoredTool, SessionRoutingState, RankingEvent
├── pipeline.ts        — RetrievalPipeline: main orchestration, 6-tier fallback
├── base.ts            — ToolRetriever / PassthroughRetriever interfaces
├── session.ts         — SessionStateManager: promote/demote tool tracking
├── catalog.ts         — Tool catalog snapshot builder
├── keyword-matcher.ts — Trigger-based keyword matching (Tier 3)
├── static-categories.ts — Predefined tool categories by project type (Tier 4)
├── rollout.ts         — Canary/session group assignment
├── routing-tool.ts    — Synthetic request_tool for demoted-tool access
├── zenith-integration.ts — Pipeline factory, MCP handler interceptors
├── zenith-tool-registry.ts — Local tool registry with Proxy-based live record
├── assembler.ts       — TieredAssembler for description truncation
├── ranking/
│   ├── bmx-index.ts   — BMXF scoring index
│   ├── fusion.ts      — Weighted RRF fusion + adaptive alpha
│   ├── ranker.ts      — Scorer orchestration
│   └── index.ts       — Re-exports
├── telemetry/
│   ├── scanner.ts     — Workspace fingerprinting
│   ├── tokens.ts      — Token extraction from project files
│   ├── evidence.ts    — Evidence aggregation
│   └── monitor.ts     — Telemetry polling
└── observability/
    ├── logger.ts      — JSONL ranking event logger
    ├── metrics.ts     — Rolling metrics (rescores, latency)
    └── replay.ts      — Log replay for debugging
```

### 6-Tier Fallback Ladder

The pipeline tries tiers in order; first successful result wins:

1. **BMXF blend** — env-signal + conversation-signal BMXF scoring with weighted RRF fusion and adaptive alpha blending
2. **BMXF env-only** — environment-signal-only scoring (workspace fingerprint)
3. **Keyword env-only** — trigger-based keyword matching against tool descriptions
4. **Static categories** — project type classification (rust_cli, python_web, node_web, infrastructure, generic) with pre-defined tool priority lists
5. **Frequency prior** — exponential-decay weighted frequency from historical ranking events log
6. **Universal fallback** — namespace-priority selection (12 tools max, one per server)

### Session Lifecycle

- `getToolsForList(sessionId, conversationContext)` — main entry point, called on every `tools/list` request
- Tracks turn boundaries, tool call history, argument keys, router proxy counts
- Promote/demote tools based on ranking scores and usage patterns
- `onToolCalled(sessionId, toolName, args, isRouterProxy)` — records direct vs proxy usage

### Routing Tool

When tools are demoted (not in active set), a synthetic `request_tool` is injected:
- `describe=true` → returns full tool schema
- `describe=false` → proxies the call through to the underlying tool
- Proxied calls are tracked separately for promotion decisions

---

## 10. MCP Roots Protocol

The server implements the MCP Roots Protocol for dynamic directory negotiation.

**Flow:**
1. Client sends `initialize` with capabilities
2. `oninitialized` handler checks `clientCapabilities.roots`
3. If supported: calls `server.server.listRoots()` to get client's roots
4. Roots are parsed via `src/core/roots-utils.ts` (`file://` URIs resolved, validated as directories)
5. `ctx.setAllowedDirectories(validatedRoots)` replaces all baseline directories
6. `src/core/project-context.ts` is notified via `onRootsChanged()` to refresh its root resolution
7. At runtime: client sends `notifications/roots/list_changed`
8. Server re-requests roots and repeats step 4–6

**Important:** If the client does not support roots and no CLI directories were provided, `oninitialized` throws an explicit error. There is no silent fallback to `cwd` for allowed directories.

---

## 11. Response Discipline (Agent Policy)

This is enforced by design across all tools:

- **Do not parrot inputs.** If the caller sent one path, do not return it.
- **Minimal success responses.** `'Applied.'`, `'Created.'`, `'Deleted.'` are sufficient.
- **Dry-run should be minimal.** A diff or `'Dry Run Successful'` is enough.
- **Failure = actionable new info only.** `'OLD_TEXT_NOT_FOUND'`, `'Symbol not found.'`
- **Stay in scope.** Read tools return content. Metadata tools return metadata. Don't duplicate.
- **No verbose formatting.** No headers, separators, or "nice" formatting that wastes tokens.

When modifying tools, guard aggressively against context bloat. If unsure whether to include a field, omit it.

---

## 12. Environment Variables Reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `ZENITH_MCP_API_KEY` / `MCP_BRIDGE_API_KEY` / `COMMANDER_API_KEY` | — | HTTP bearer token (required for HTTP mode) |
| `SESSION_TTL_MS` | 1800000 | HTTP session idle timeout |
| `CHAR_BUDGET` | 400000 | Global character budget for reads |
| `SEARCH_CHAR_BUDGET` | 15000 | Character budget for search result snippets |
| `DEFAULT_EXCLUDES` | `node_modules,.git,...` | Comma-separated default exclude patterns |
| `SENSITIVE_PATTERNS` | `**/.env,**/*.pem,...` | Comma-separated sensitive file globs |
| `REFACTOR_MAX_CHARS` | 30000 | Max chars for refactor_batch loads |
| `REFACTOR_MAX_CONTEXT` | 30 | Max context lines for refactor_batch |
| `REFACTOR_VERSION_TTL_HOURS` | 24 | Version snapshot TTL in hours |
| `ZENITH_MCP_ADAPTERS_ENABLED` | — | Comma-separated adapter names to enable |
| `ZENITH_MCP_ADAPTER_BACKUP_DIR` | — | Backup directory for adapter config changes |

---

## 13. Adding a New Tool

1. Create `src/tools/my_new_tool.ts`
2. Export `register(server, ctx)`
3. Use `zod` for strict `inputSchema`
4. **Mandatory:** Call `await ctx.validatePath(args.path)` (or `args.source` / `args.destination`) before any `fs` operation
5. Set `annotations: { readOnlyHint, idempotentHint, destructiveHint }`
6. Import and call `registerMyNewTool(server, ctx)` in `src/core/server.ts`
7. Follow response discipline: minimal outputs, no parroting inputs

---

## 14. Testing

- The project uses **Vitest 4.x** with `@vitest/coverage-v8`
- Tests in `tests/` reference compiled `dist/` modules
- Tree-sitter WASM files must be present for symbol-aware tests
- The compression bridge runs in-process (no Python required for tests)
- SQLite databases are created in `.mcp/` directories and `~/.zenith-mcp/` — clean these between test runs if needed

---

## 15. Source Layout

The entire project is TypeScript in `src/`, compiled to `dist/` via `tsc`. The `dist/` directory is gitignored.

```
src/                          — TypeScript source (all modules)
  core/                       — Server core: security, search, tree-sitter, edit engine, symbol index
  tools/                      — 11 MCP tool implementations
  cli/                        — stdio entry point
  server/                     — HTTP entry point (Express 5)
  adapters/                   — 16 MCP client config adapters + helpers
  config/                     — Adapter settings, admin CLI, server config management
  retrieval/                  — Opt-in 6-tier tool retrieval pipeline
  toon/                       — In-process compression library (BMX+, SageRank, codec)
  utils/                      — Project scope resolution
dist/                         — Compiled output (gitignored)
  grammars/                   — copied Tree-sitter WASM grammar files and query files/dirs

grammars/                     — Tree-sitter WASM grammars and SCM queries (source of truth)
tests/                        — Test suites (Vitest)
```

**Build:** `tsc` compiles `src/` to `dist/`, then `shx cp -r grammars dist/` copies the source-controlled grammar tree into `dist/grammars/`. The nested `grammars/grammars/` directory is intentional for the shipped grammar layout. The `prepare` npm script runs build automatically on install.

The retrieval pipeline is opt-in — `defaultRetrievalConfig()` sets `enabled: false`. The pipeline is initialized at server startup but remains inert until explicitly activated via config.
