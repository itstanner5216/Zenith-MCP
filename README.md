# Zenith-MCP

> **The MCP filesystem server built for serious AI-assisted development.** Not just read/write — Zenith gives your AI agent genuine code intelligence: AST-aware editing, impact-graph refactoring, semantic search, and a version-controlled symbol database, all inside a hardened security sandbox.

[![npm](https://img.shields.io/npm/v/zenith-mcp?label=zenith-mcp&color=6366f1)](https://www.npmjs.com/package/zenith-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io)

---

## Why Zenith over other MCP filesystem servers?

Most MCP filesystem servers are thin wrappers around `fs.readFile` and `fs.writeFile`. Zenith is different at every layer:

| Capability | Typical MCP server | Zenith-MCP |
|---|---|---|
| **Edit precision** | Full-file overwrite or text replacement | 3-mode surgical editing: content-match, block-boundary, or **AST symbol** — no line numbers needed |
| **Code understanding** | None | Tree-sitter AST parsing for **20+ languages**, lazy-loaded WASM, LRU-cached |
| **Search intelligence** | Grep or basic glob | BM25 pre-filter + ripgrep + BM25 post-rank, structural similarity, definition lookup |
| **Cross-file refactoring** | Not available | Impact-graph traversal (callers/callees), outlier detection, atomic multi-file apply with rollback |
| **Edit safety** | Write and hope | All-or-nothing in-memory validation → atomic temp-file swap → SQLite stash on failure |
| **Symbol versioning** | Not available | Every symbol edit auto-snapshots the original; point-in-time rollback via `stashRestore` |
| **Security model** | CWD or basic prefix check | `validatePath` with symlink resolution + re-check, exclusive-write `wx` flag, sensitive-file blocking, per-session isolation |
| **Transport** | stdio only | stdio **and** HTTP (Streamable HTTP + legacy SSE, bearer auth, per-session context, idle reaping) |

---

## What the code actually does

### 🔬 True code-awareness via Tree-sitter

Zenith ships WASM grammars for JavaScript, TypeScript, TSX, Python, Go, Rust, Java, C, C++, C#, Kotlin, PHP, Ruby, Swift, Bash, CSS, JSON, YAML, SQL, Markdown, and more. Grammars are lazy-loaded on first use and permanently cached — zero startup penalty.

This unlocks capabilities that are simply impossible with text search:

- **`edit_file` symbol mode** — "Replace the `AuthService.login` method" without knowing its line number. Zenith finds the AST bounds and replaces exactly the right block, then re-indents the new code to match the file.
- **`read_text_file` symbol mode** — Read just the body of `BM25Index.score` across a 10 000-line file.
- **`search_files` structural mode** — Find all functions with the same AST shape (Jaccard similarity over 3-gram node fingerprints) to detect copy-paste patterns or candidates for a common abstraction.
- **`search_files` definition mode** — Locate every file that *defines* `AuthService.login` using the parse tree, not a fragile regex.
- **Syntax gate** — After any edit, `checkSyntaxErrors()` walks the new AST and warns if `ERROR` or missing nodes were introduced.

### 🧠 Intelligent two-stage search

Searching a 50 000-file monorepo without drowning the LLM context is a hard problem. Zenith solves it with a pipeline:

1. **BM25 pre-filter** — builds an in-memory BM25 corpus (file paths weighted 3×, first 8 KB of content) and selects the top-100 candidate files.
2. **ripgrep** — blazing-fast regex search scoped to those 100 files (with `.gitignore` awareness). Falls back to a pure-JS implementation when `rg` isn't available.
3. **BM25 post-rank** — if results exceed 50 lines, BM25 re-ranks individual result lines and fills the character budget with the most relevant hits.

The BM25 implementation is zero-dependency, inline (~120 lines), and uses entropy weighting (high-entropy terms are downweighted) plus sigmoid TF saturation for better precision than vanilla BM25.

### ⚡ All-or-nothing atomic edits with stash recovery

Edit safety is not an afterthought. Every `edit_file` call:

1. Validates **all** edits against an in-memory copy of the file — exact match, then trimmed-whitespace match, then indent-stripped match within a ±50-line window.
2. If **any** edit fails, **zero** edits are applied and the file is untouched.
3. Failed edits are stashed to SQLite with their full payload. The AI retries via `stashRestore apply` with only the correction needed — unchanged edits rehydrate from the stash automatically.
4. Successful edits write to a temp file, verify the byte size, then `fs.rename()` for an atomic swap.

Block edits (`block_start` / `block_end`) and symbol edits (AST-located) follow the same pipeline.

### 🔗 Cross-file impact refactoring

`refactor_batch` implements a full refactoring workflow:

1. **`query`** — traverses the per-project SQLite symbol graph (`edges` table) to find all callers (`forward`) or callees (`reverse`) of a symbol, up to 5 levels deep.
2. **`load`** — fetches each symbol's body plus N lines of context. Runs **outlier detection**: computes `getSymbolStructure()` for each occurrence (param shape, return type, decorators, modifiers, parent scope) and flags deviations from the modal pattern.
3. **`apply`** — parses a diff-style payload, gates on acknowledged outliers and syntax validity, then applies edits atomically per file. Successful patterns are cached for `reapply`.
4. **`reapply`** — applies a cached edit pattern to new targets without repeating the full workflow.

### 🗄️ Per-project symbol database

Each git repository gets a `.mcp/symbols.db` (auto-gitignored) with:
- `symbols` — definitions and references from the full Tree-sitter parse
- `edges` — caller → callee links for impact traversal
- `versions` — point-in-time snapshots of every symbol body touched by `edit_file` or `refactor_batch`, with a configurable TTL

Rollback is a single tool call: `stashRestore restore symbol:"AuthService.login"`.

### 🔒 Security-first design

- **`validatePath()`** — expands `~`, normalizes, prefix-checks against allowed directories, calls `fs.realpath()` to resolve symlinks, then re-checks the resolved path. Throws before any `fs` call if the check fails.
- **Exclusive writes** — new file creation uses the `wx` flag. Pre-existing symlinks at the target path cannot be exploited.
- **Sensitive file blocking** — `isSensitive()` uses `minimatch` globs to block `.env`, `*.pem`, `*.key`, `*credentials*`, `*secret*`, and more from appearing in search results and symbol indexing.
- **Per-session isolation (HTTP)** — each HTTP client gets its own `FilesystemContext`. MCP root negotiations for one session never affect another.

---

## Features

- **Read/write files** — text, media, and batch reads with budget-aware truncation and optional compression
- **Surgical editing** — content-match, block-replace, and symbol-aware edits with dry-run preview
- **Intelligent search** — content search with BM25 ranking, file discovery, symbol search, structural similarity, and definition lookup
- **Cross-file refactoring** — impact analysis, batch symbol loading, and coordinated multi-file edits with rollback
- **Code awareness** — Tree-sitter AST parsing for 20+ languages (lazy-loaded WASM grammars)
- **Symbol indexing & versioning** — per-project SQLite index with impact graphs and automatic version snapshots
- **Stash & restore** — retry failed edits, restore symbol versions, and manage project roots
- **Dynamic directory access control** via [MCP Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots)
- **Dual transport** — stdio (local) and HTTP (remote with Streamable HTTP + legacy SSE)

---

## Quick Start

### stdio (Local)
Standard MCP stdio transport for local clients like Claude Desktop or VS Code.

```bash
npx zenith-mcp /path/to/dir1 /path/to/dir2
```

### HTTP (Remote)
Express-based HTTP server supporting both Streamable HTTP and legacy SSE transports.

```bash
ZENITH_MCP_API_KEY=secret npx zenith-mcp-http /path/to/dir1 --port=3100 --host=0.0.0.0
```

**HTTP Endpoints:**
- `POST /mcp` — Streamable HTTP (initialize + messages)
- `GET /mcp` — Streamable HTTP SSE notification stream
- `DELETE /mcp` — Streamable HTTP session teardown
- `GET /sse` — Legacy SSE transport
- `POST /messages` — Legacy SSE message endpoint
- `GET /health` — Health check

Sessions are isolated per client and reaped after 30 minutes of idle time (configurable via `SESSION_TTL_MS`). All HTTP requests require `Authorization: Bearer <API_KEY>`.

## Directory Access Control

Directories can be specified via command-line arguments or dynamically via [MCP Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots).

### Method 1: Command-line Arguments
```bash
zenith-mcp /path/to/dir1 /path/to/dir2
```

### Method 2: MCP Roots (Recommended)
MCP clients that support Roots can dynamically update allowed directories at runtime via `roots/list_changed` notifications. Roots completely replace server-side directories when provided.

**Important:** If the server starts without CLI directories AND the client doesn't support roots (or provides empty roots), initialization will fail.

> **Why no fallback?** Allowed directories are a strict security sandbox — they determine what the AI can read and write. The server intentionally does *not* fall back to `process.cwd()` or auto-detected git roots, because that could accidentally expose sensitive files. A separate "project root" resolver (used only for the symbol index and stash database) does have fallbacks (git → cwd → registered roots → global), but that layer never grants filesystem access.

### How It Works
1. **Server Startup** — uses CLI directories as the baseline
2. **Client Initialization** — if the client supports roots, the server requests `roots/list` and replaces allowed directories
3. **Runtime Updates** — `notifications/roots/list_changed` triggers a refresh
4. **Access Control** — all filesystem operations are restricted to allowed directories; symlinks are resolved and validated

## Tools

### `read_text_file`
Read a text file with multiple modes.

- **mode: `standard`**
  - `path` (string)
  - `maxChars` (number, optional, default 50000, up to 400000)
  - `head` (number, optional) — first N lines
  - `tail` (number, optional) — last N lines
  - `offset` (number, optional) — start line (0-based), combine with `head`
  - `showLineNumbers` (boolean, optional)
  - `compression` (boolean, optional) — compress whitespace via structured compression

- **mode: `grep`**
  - `path` (string)
  - `grep` (string) — regex to match lines (case-insensitive)
  - `grepContext` (number, optional, default 0, max 30) — context lines around matches
  - `maxChars` (number, optional)
  - `showLineNumbers` (boolean, optional)

- **mode: `window`**
  - `path` (string)
  - `aroundLine` (number, optional) — center window on this line
  - `context` (number, optional, default 30) — window radius
  - `ranges` (array of `{startLine, endLine}`, optional) — explicit line ranges
  - `maxChars` (number, optional)
  - `showLineNumbers` (boolean, optional)

- **mode: `symbol`**
  - `path` (string)
  - `symbol` (string) — symbol name, dot-qualified for methods (e.g. `AuthService.login`)
  - `nearLine` (number, optional) — disambiguate multiple matches
  - `expandLines` (number, optional, default 0, max 50) — extra context around symbol
  - `maxChars` (number, optional)

### `read_media_file`
Read an image or audio file. Returns base64 data with MIME type.
- `path` (string)
- Supported: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`, `.mp3`, `.wav`, `.ogg`, `.flac`

### `read_multiple_files`
Read up to 50 files concurrently with dynamic character budget balancing.
- `paths` (string[])
- `maxCharsPerFile` (number, optional)
- `compression` (boolean, optional, default true) — compress whitespace
- `showLineNumbers` (boolean, optional, default false)
- Failed reads won't stop the entire operation

### `write_file`
Create, overwrite, or append to a file. Auto-creates parent directories. Atomic writes with temp-file + rename.
- `path` (string)
- `content` (string)
- `failIfExists` (boolean, optional) — fail if file already exists
- `append` (boolean, optional) — append instead of overwriting; smart-resumes overlapping tails

### `edit_file`
Surgical file editing with three modes. Supports dry-run preview. Failed edits are stashed for retry.

- **mode: `content`**
  - `oldContent` (string) — exact text to find (uses exact, trimmed, and indent-stripped matching)
  - `newContent` (string)

- **mode: `block`**
  - `block_start` (string) — trimmed first line of the block to replace
  - `block_end` (string) — trimmed last line of the block
  - `replacement_block` (string)

- **mode: `symbol`**
  - `symbol` (string) — symbol name, dot-qualified for methods
  - `newText` (string)
  - `nearLine` (number, optional)

All modes support `dryRun` to preview changes without writing.

### `directory`
Directory exploration with two modes.

- **mode: `list`** — list directory contents
  - `path` (string, optional)
  - `depth` (number, optional, default 1, max 10) — recursion depth
  - `includeSizes` (boolean, optional, default false)
  - `sortBy` (enum `"name" | "size"`, optional, default `"name"`) — requires `includeSizes`
  - `listAllowed` (boolean, optional, default false) — list allowed root directories instead

- **mode: `tree`** — recursive directory tree with optional symbol metadata
  - `path` (string)
  - `excludePatterns` (string[], optional) — glob patterns to exclude
  - `showSymbols` (boolean, optional, default false) — show symbol counts per file
  - `showSymbolNames` (boolean, optional, default false) — show symbol names per file

### `search_files`
Multi-mode search with ripgrep + BM25 ranking and JS fallback.

- **mode: `content`** — text/regex search (always case-insensitive)
  - `path` (string)
  - `contentQuery` (string) — text or regex to search for
  - `pattern` (string, optional) — glob to limit files
  - `contextLines` (number, optional, default 0)
  - `literalSearch` (boolean, optional, default false)
  - `countOnly` (boolean, optional, default false)
  - `includeHidden` (boolean, optional, default false)
  - `maxResults` (number, optional, default 50)

- **mode: `files`** — file discovery
  - `path` (string)
  - `pattern` (string, optional)
  - `namePattern` (string, optional)
  - `pathContains` (string, optional)
  - `extensions` (string[], optional)
  - `includeMetadata` (boolean, optional, default false)
  - `includeHidden` (boolean, optional, default false)
  - `maxResults` (number, optional, default 100)

- **mode: `symbol`** — find symbols by name substring, or list all symbols when omitted
  - `path` (string)
  - `symbolQuery` (string, optional) — omit to list all symbols
  - `symbolKind` (enum, optional, default `"any"`)
  - `pattern` (string, optional)
  - `maxResults` (number, optional, default 50)

- **mode: `structural`** — find structurally similar symbols (AST fingerprinting)
  - `path` (string)
  - `structuralQuery` (string) — symbol name to find similar definitions of
  - `symbolKind` (enum, optional, default `"any"`)
  - `maxResults` (number, optional, default 20)

- **mode: `definition`** — find files defining a specific symbol
  - `path` (string)
  - `definesSymbol` (string) — dot-qualified supported
  - `namePattern` (string, optional)
  - `pathContains` (string, optional)
  - `extensions` (string[], optional)
  - `maxResults` (number, optional, default 100)

### `file_manager`
Directory and file management operations.
- **mode: `mkdir`** — `path`
- **mode: `delete`** — `path` (file only, irreversible)
- **mode: `move`** — `source`, `destination`
- **mode: `info`** — `path` (returns size, created, modified, accessed, type, permissions)

### `stashRestore`
Retry failed edits, restore versions, browse stash, and manage project roots.

- **mode: `apply`** — retry a stashed edit or write
  - `stashId` (number)
  - `corrections` (array, optional) — disambiguation for failed edits
  - `newPath` (string, optional) — redirect a failed write
  - `dryRun` (boolean, optional)

- **mode: `restore`** — rollback a symbol version or clear a stash entry
  - `stashId` (number, optional)
  - `symbol` (string, optional)
  - `version` (number, optional)
  - `file` (string, optional)
  - `dryRun` (boolean, optional)

- **mode: `list`** — show all stash entries
  - `type` (enum `"edit" | "write"`, optional)

- **mode: `read`** — view a stash entry's contents
  - `stashId` (number)

- **mode: `init`** — register a non-git directory as a project root
  - `projectRoot` (string)
  - `projectName` (string, optional)

- **mode: `history`** — list version snapshots for a symbol
  - `symbol` (string)
  - `file` (string, optional)

### `refactor_batch`
Apply one edit pattern across multiple similar symbols, with outlier detection and rollback.

- **mode: `query`** — impact analysis (callers or callees)
  - `target` (string) — symbol name
  - `fileScope` (string, optional)
  - `direction` (enum `"forward" | "reverse"`, default `"forward"`)
  - `depth` (number, default 1, max 5)

- **mode: `load`** — load symbol bodies with context
  - `selection` (array) — indices from prior query or explicit `{symbol, file}` pairs
  - `contextLines` (number, optional, default 5, max 30)
  - `loadMore` (boolean, optional, default false)

- **mode: `apply`** — apply edited diff to selected occurrences
  - `payload` (string) — edited diff with symbol headers
  - `dryRun` (boolean, optional)

- **mode: `reapply`** — reuse a cached payload on new targets
  - `symbolGroup` (string)
  - `newTargets` (array) — names or `{symbol, file}` pairs
  - `dryRun` (boolean, optional)

## Tool Annotations

| Tool                  | readOnlyHint | idempotentHint | destructiveHint | Notes                                           |
|-----------------------|--------------|----------------|-----------------|-------------------------------------------------|
| `read_text_file`      | `true`       | —              | —               | Pure read                                       |
| `read_media_file`     | `true`       | —              | —               | Pure read                                       |
| `read_multiple_files` | `true`       | —              | —               | Pure read                                       |
| `directory`           | `true`       | —              | —               | Pure read                                       |
| `search_files`        | `true`       | —              | —               | Pure read                                       |
| `write_file`          | `false`      | `false`        | `true`          | Overwrites existing files                       |
| `edit_file`           | `false`      | `false`        | `true`          | Re-applying edits can fail or double-apply      |
| `file_manager`        | `false`      | `false`        | `true`          | Mixed: mkdir is idempotent, delete/move are not |
| `stashRestore`        | `false`      | `false`        | `true`          | Restores and applies are stateful               |
| `refactor_batch`      | `false`      | `false`        | `true`          | Multi-file writes                               |

## Usage with Claude Desktop

Add this to your `claude_desktop_config.json`:

### NPX (stdio)
```json
{
  "mcpServers": {
    "zenith": {
      "command": "npx",
      "args": [
        "-y",
        "zenith-mcp",
        "/Users/username/Desktop"
      ]
    }
  }
}
```

### HTTP
```json
{
  "mcpServers": {
    "zenith": {
      "url": "http://localhost:3100/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

## Usage with VS Code

**Method 1: User Configuration**
Open the Command Palette (`Ctrl + Shift + P`) and run `MCP: Open User Configuration`.

**Method 2: Workspace Configuration**
Add the configuration to `.vscode/mcp.json` in your workspace.

### NPX Example
```json
{
  "servers": {
    "zenith": {
      "command": "npx",
      "args": [
        "-y",
        "zenith-mcp",
        "${workspaceFolder}"
      ]
    }
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ZENITH_MCP_API_KEY` / `MCP_BRIDGE_API_KEY` / `COMMANDER_API_KEY` | API key for HTTP mode (required) |
| `SESSION_TTL_MS` | HTTP session idle timeout in ms (default: 1800000) |
| `CHAR_BUDGET` | Global character budget for reads (default: 400000) |
| `SEARCH_CHAR_BUDGET` | Character budget for search results (default: 15000) |
| `DEFAULT_EXCLUDES` | Comma-separated default exclude patterns |
| `SENSITIVE_PATTERNS` | Comma-separated sensitive file glob patterns |
| `REFACTOR_MAX_CHARS` | Max characters for refactor_batch (default: 30000) |
| `REFACTOR_MAX_CONTEXT` | Max context lines for refactor_batch (default: 30) |
| `REFACTOR_VERSION_TTL_HOURS` | Version snapshot TTL in hours (default: 24) |
| `TOON_PROJECT_DIR` | Path to the `toon` compression project (default: `/home/tanner/Projects/toon`) |

## Build

```bash
npm install
npm run build
```

The `dist/` directory contains the compiled output. No TypeScript compilation step is required; the project uses a dist-only JavaScript layout.

## License

MIT License. See the LICENSE file in the project repository.
