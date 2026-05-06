# Zenith-MCP

> **The MCP filesystem your agent actually deserves.** Stop pasting line numbers. Stop grepping. Stop hoping your multi-file refactor didn't silently break the one odd function with a different signature. Zenith reads code like you do — by structure, not text — and edits it with the precision of an IDE engine, not a text replacement tool.

[![npm](https://img.shields.io/npm/v/zenith-mcp?label=zenith-mcp&color=6366f1)](https://www.npmjs.com/package/zenith-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io)

---

## Why Zenith?

Most MCP filesystem servers give you a hammer and ask you to sculpt. Zenith gives you a precision instrument intentionally built for serious AI-assisted development. Not just read and write — Zenith gives your AI agent genuine code intelligence: AST-aware editing, impact-graph refactoring, semantic search, and a version-controlled symbol database, all inside a hardened security sandbox.

| Capability | Typical MCP server | Zenith-MCP |
|---|---|---|
| **Edit precision** | Full-file overwrite or fragile text replacement | 3-mode surgical editing: content-match, block-boundary, or **AST symbol** — no line numbers needed |
| **Code understanding** | None | Tree-sitter AST parsing for **40+ languages**, lazy-loaded WASM, LRU-cached |
| **Search intelligence** | Grep or basic glob | BM25 pre-filter + ripgrep + BM25 post-rank, structural similarity, definition lookup |
| **Cross-file refactoring** | Not available | Impact-graph traversal (callers/callees), outlier detection, atomic multi-file apply with rollback |
| **Edit safety** | Write and hope | All-or-nothing in-memory validation → atomic temp-file swap → SQLite stash on failure |
| **Symbol versioning** | Not available | Every symbol edit auto-snapshots the original; point-in-time rollback via `stashRestore` |
| **Security model** | CWD or basic prefix check | `validatePath` with symlink resolution + re-check, exclusive-write `wx` flag, sensitive-file blocking, per-session isolation |
| **Transport** | stdio only | stdio **and** HTTP (Streamable HTTP + legacy SSE, bearer auth, per-session context, idle reaping) |

---

## What It Does (And Why It Matters)

### True code-awareness via Tree-sitter

Zenith ships WASM grammars for JavaScript, TypeScript, TSX, Python, Go, Rust, Java, C, C++, C#, Kotlin, PHP, Ruby, Swift, Bash, CSS, JSON, YAML, SQL, Markdown, Dart, Elixir, GraphQL, HCL, HTML, Lua, Make, Nix, Perl, Prisma, Proto, R, SCSS, Svelte, TOML, Vue, XML, CMake, Dockerfile, and more. Grammars are lazy-loaded on first use and cached after first load — minimal startup penalty.

This unlocks capabilities that are simply impossible with text search:

- **`edit_file` symbol mode** — "Replace the `AuthService.login` method" without knowing its line number. Zenith finds the AST bounds and replaces exactly the right block, then re-indents the new code to match the file.
- **`search_file` symbol lookup** — Read just the body of `BM25Index.score` across a 10,000-line file, with optional surrounding context.
- **`search_files` structural mode** — Find all functions with the same AST shape (Jaccard similarity over 3-gram node fingerprints) to detect copy-paste patterns or candidates for a common abstraction.
- **`search_files` definition mode** — Locate every file that *defines* `AuthService.login` using the parse tree, not a fragile regex.
- **Syntax gate** — After any edit, `checkSyntaxErrors()` walks the new AST and warns if `ERROR` or missing nodes were introduced.

### Intelligent two-stage search

Searching a 50,000-file monorepo without drowning the LLM context is a hard problem. Zenith solves it with a pipeline:

1. **BM25 pre-filter** — builds an in-memory BM25 corpus (file paths weighted 3×, first 8 KB of content) and selects the top-100 candidate files.
2. **ripgrep** — blazing-fast regex search scoped to those 100 files (with `.gitignore` awareness). Falls back to a pure-JS implementation when `rg` isn't available.
3. **BM25 post-rank** — if results exceed 50 lines, BM25 re-ranks individual result lines and fills the character budget with the most relevant hits.

The BM25 implementation is zero-dependency, inline (~120 lines), and uses entropy weighting (high-entropy terms are downweighted) plus sigmoid TF saturation for better precision than vanilla BM25.

### All-or-nothing atomic edits with stash recovery

Edit safety is not an afterthought. Every `edit_file` call:

1. Validates **all** edits against an in-memory copy of the file — exact match, then trimmed-whitespace match, then indent-stripped match within a ±50-line window.
2. If **any** edit fails, **zero** edits are applied and the file is untouched.
3. Failed edits are stashed to SQLite with their full payload. The AI retries via `stashRestore apply` with only the correction needed — unchanged edits rehydrate from the stash automatically.
4. Successful edits write to a temp file, verify the byte size, then `fs.rename()` for an atomic swap.

Block edits (`block_start` / `block_end`) and symbol edits (AST-located) follow the same pipeline.

### Cross-file impact refactoring

`refactor_batch` implements a full refactoring workflow:

1. **`query`** — traverses the per-project SQLite symbol graph (`edges` table) to find all callers (`forward`) or callees (`reverse`) of a symbol, up to 5 levels deep.
2. **`loadDiff`** — fetches each symbol's body plus N lines of context. Runs **outlier detection**: computes `getSymbolStructure()` for each occurrence (param shape, return type, decorators, modifiers, parent scope) and flags deviations from the modal pattern.
3. **`apply`** — parses a diff-style payload, gates on acknowledged outliers and syntax validity, then applies edits atomically per file. Successful patterns are cached for `reapply`.
4. **`reapply`** — applies a cached edit pattern to new targets without repeating the full workflow.

### Per-project symbol database

Each git repository gets a `.mcp/symbols.db` (auto-gitignored) with:
- `symbols` — definitions and references from the full Tree-sitter parse
- `edges` — caller → callee links for impact traversal
- `versions` — point-in-time snapshots of every symbol body touched by `edit_file` or `refactor_batch`, with a configurable TTL

Rollback is a single tool call: `refactor_batch restore`.

### Security-first design

- **`validatePath()`** — expands `~`, normalizes, prefix-checks against allowed directories, calls `fs.realpath()` to resolve symlinks, then re-checks the resolved path. Throws before any `fs` call if the check fails.
- **Exclusive writes** — new file creation uses the `wx` flag. Pre-existing symlinks at the target path cannot be exploited.
- **Sensitive file blocking** — `isSensitive()` uses `minimatch` globs to block `.env`, `*.pem`, `*.key`, `*credentials*`, `*secret*`, and more from appearing in search results and symbol indexing.
- **Per-session isolation (HTTP)** — each HTTP client gets its own `FilesystemContext`. MCP root negotiations for one session never affect another.

---

## Features

- **Read/write files** — text, media, and batch reads with budget-aware truncation and optional compression
- **Surgical editing** — content-match, block-replace, and symbol-aware edits with dry-run preview
- **Intelligent search** — content search with BM25 ranking, file discovery, symbol search, structural similarity, definition lookup, and single-file grep/symbol search
- **Cross-file refactoring** — impact analysis, batch symbol loading, and coordinated multi-file edits with rollback
- **Code awareness** — Tree-sitter AST parsing for 40+ languages (lazy-loaded WASM grammars)
- **Symbol indexing & versioning** — per-project SQLite index with impact graphs and automatic version snapshots
- **Stash & restore** — retry failed edits and restore symbol versions
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

---

## Directory Access Control

Directories can be specified via command-line arguments or dynamically via [MCP Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots).

### Method 1: Command-line Arguments
```bash
zenith-mcp /path/to/dir1 /path/to/dir2
```

### Method 2: MCP Roots (Recommended)
MCP clients that support Roots can dynamically update allowed directories at runtime via `roots/list_changed` notifications. Roots completely replace server-side directories when provided.

**Important:** If the server starts without CLI directories AND the client doesn't support roots (or provides empty roots), initialization will fail.

> **Why no fallback?** Allowed directories are a strict security sandbox — they determine what the AI can read and write. The server intentionally does *not* fall back to `process.cwd()` or auto-detected git roots for allowed directories, because that could accidentally expose sensitive files. A separate "project root" resolver (used only for the symbol index and stash database) does have fallbacks (git → marker detection → registry → global), but that layer never grants filesystem access.

### How It Works
1. **Server Startup** — uses CLI directories as the baseline
2. **Client Initialization** — if the client supports roots, the server requests `roots/list` and replaces allowed directories
3. **Runtime Updates** — `notifications/roots/list_changed` triggers a refresh
4. **Access Control** — all filesystem operations are restricted to allowed directories; symlinks are resolved and validated

---

## Tools

### `read_file`
Read a text file with flexible options (streaming line chunks, windowed reads, or exact line ranges).

- `path` (string)
- `maxChars` (number, optional, default 50000, up to 400000)
- `head` (number, optional) — first N lines
- `tail` (number, optional) — last N lines
- `offset` (number, optional) — start line (0-based), combine with `head`
- `aroundLine` (number, optional) — center window on this line
- `context` (number, optional, default 30) — window radius
- `ranges` (array of `{startLine, endLine}`, optional) — explicit line ranges
- `showLineNumbers` (boolean, optional)
- `compression` (boolean, optional) — compress whitespace via structured compression

> **Note:** For grep and symbol-based searching within a single file, use `search_file` instead.

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
- `createOnly` (boolean, optional) — compatibility alias for `failIfExists`
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
  - `path` (string)
  - `depth` (number, optional, default 1, max 10) — recursion depth
  - `includeSizes` (boolean, optional, default false)
  - `sortBy` (enum `"name" | "size"`, optional, default `"name"`) — requires `includeSizes`

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

### `search_file`
Single-file search by regex or symbol name. Read-only.

- `path` (string) — file to search
- `grep` (string, optional) — case-insensitive regex to match lines
- `grepContext` (number, optional, default 0, max 30) — context lines around matches
- `symbol` (string, optional) — symbol name, dot-qualified for methods (e.g. `AuthService.login`)
- `nearLine` (number, optional) — disambiguate multiple symbol matches
- `expandLines` (number, optional, default 0, max 50) — extra context around symbol
- `maxChars` (number, optional, default 50000, up to 400000)

### `file_manager`
Directory and file management operations.
- **mode: `mkdir`** — `path`
- **mode: `delete`** — `path` (file only, irreversible)
- **mode: `move`** — `source`, `destination`
- **mode: `info`** — `path` (returns size, created, modified, accessed, type, permissions)

### `stashRestore`
Retry failed edits and manage stash entries.

- **mode: `apply`** — retry a stashed edit or write
  - `stashId` (number)
  - `corrections` (array, optional) — disambiguation for failed edits
  - `newPath` (string, optional) — redirect a failed write
  - `dryRun` (boolean, optional)

- **mode: `restore`** — clear a stash entry by ID
  - `stashId` (number)

- **mode: `list`** — show all stash entries
  - `type` (enum `"edit" | "write"`, optional)

- **mode: `read`** — view a stash entry's contents
  - `stashId` (number)

> **Note:** For symbol version rollback (`restore`/`history`), use `refactor_batch`.

### `refactor_batch`
Apply one edit pattern across multiple similar symbols, with outlier detection and rollback.

- **mode: `query`** — impact analysis (callers or callees)
  - `target` (string) — symbol name
  - `fileScope` (string, optional)
  - `direction` (enum `"forward" | "reverse"`, default `"forward"`)
  - `depth` (number, default 1, max 5)

- **mode: `loadDiff`** — load symbol bodies with context into an editable diff
  - `selection` (array) — indices from prior query or explicit `{symbol, file}` pairs
  - `contextLines` (number, optional, default 5, max 30)
  - `loadMore` (boolean, optional, default false) — paginate truncated results

- **mode: `apply`** — apply edited diff to selected occurrences
  - `payload` (string) — edited diff with symbol headers
  - `dryRun` (boolean, optional)

- **mode: `reapply`** — reuse a cached payload on new targets
  - `symbolGroup` (string)
  - `newTargets` (array) — names or `{symbol, file}` pairs
  - `ack` (array, optional) — acknowledge flagged outliers by index
  - `dryRun` (boolean, optional)

- **mode: `restore`** — rollback a symbol to a prior version snapshot
  - `symbol` (string)
  - `file` (string)
  - `version` (number, optional) — omit to list available versions
  - `dryRun` (boolean, optional)

- **mode: `history`** — list available version snapshots for a symbol
  - `symbol` (string)
  - `file` (string, optional)

## Tool Annotations

| Tool                  | readOnlyHint | idempotentHint | destructiveHint | Notes                                           |
|-----------------------|--------------|----------------|-----------------|-------------------------------------------------|
| `read_file`           | `true`       | —              | —               | Pure read                                       |
| `read_media_file`     | `true`       | —              | —               | Pure read                                       |
| `read_multiple_files` | `true`       | —              | —               | Pure read                                       |
| `directory`           | `true`       | —              | —               | Pure read                                       |
| `search_files`        | `true`       | —              | —               | Pure read                                       |
| `search_file`         | `true`       | —              | —               | Pure read (single-file)                         |
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
| `ZENITH_MCP_ADAPTERS_ENABLED` | Comma-separated adapter names to enable (overrides config file) |
| `ZENITH_MCP_ADAPTER_BACKUP_DIR` | Backup directory for adapter config file changes |

## Adapter Configuration

Zenith-MCP can auto-configure MCP client config files for 16 platforms.

### Supported Adapters

| Adapter | Config Format | Platform |
|---------|---------------|----------|
| Claude Desktop | JSON | macOS, Windows |
| OpenCode | TOML | Linux, macOS |
| VS Code Copilot | JSON | All |
| Cline | JSON | All |
| Codex CLI | JSON | All |
| Codex Desktop | JSON5 | All |
| Continue.dev | JSON | All |
| Gemini CLI | JSON | All |
| GitHub Copilot | JSON | All |
| JetBrains | YAML | All |
| OpenClaw | JSON | All |
| Raycast | JSON | macOS |
| Roo Code | JSON | All |
| Warp | YAML | macOS, Linux |
| Zed | JSON | All |
| Antigravity | JSON | All |

### Adapter CLI

```bash
# List all available adapters
npx zenith-mcp-config --list

# Enable adapters (comma-separated)
npx zenith-mcp-config --enable claude_desktop,opencode

# Check status
npx zenith-mcp-config --status

# Set backup directory (for config file backups before modification)
npx zenith-mcp-config --backup-dir ~/.zenith-mcp/backups
```

Settings are persisted at `~/.zenith-mcp/adapter-config.json` and can be overridden via environment variables `ZENITH_MCP_ADAPTERS_ENABLED` and `ZENITH_MCP_ADAPTER_BACKUP_DIR`.

## Server Configuration

Zenith-MCP includes a config management system for managing external MCP server registrations.

### Admin CLI

```bash
# List configured servers and their tools
npx zenith-mcp-config-admin list

# Show detailed status
npx zenith-mcp-config-admin status

# Register a new server
npx zenith-mcp-config-admin install my-server npx -y my-mcp-server

# Scan configured servers
npx zenith-mcp-config-admin scan
```

Config is stored at `~/.zenith-mcp/zenith-mcp/servers.yaml`:

```yaml
servers:
  my-server:
    command: npx
    args: ["-y", "my-mcp-server"]
    transport: stdio
    enabled: true
    tools: {}
    toolFilters:
      allow: []
      deny: []

retrieval:
  enabled: false
  topK: 15
  scorer: bmxf
```

The `retrieval` section controls the optional tool retrieval pipeline. When enabled, Zenith dynamically filters the tool set presented to clients based on workspace context and conversation history, using a 6-tier scoring fallback (BMXF blend → env-only → keyword → static categories → frequency prior → universal).

## Project Structure

```
src/                    — TypeScript source (all modules)
  core/                 — Server core, security, search, tree-sitter, edit engine, symbol index
  tools/                — 11 MCP tool implementations
  cli/                  — stdio entry point
  server/               — HTTP entry point (Express 5)
  adapters/             — 16 MCP client config adapters
  config/               — Adapter settings, admin CLI, server config management
  retrieval/            — Opt-in 6-tier tool retrieval pipeline
  toon/                 — In-process compression library (BMX+, SageRank, codec)
  utils/                — Project scope resolution
dist/                   — Compiled output (gitignored)
  grammars/             — Copied Tree-sitter grammars and query files

grammars/               — Tree-sitter WASM grammars and SCM queries (source of truth copied into dist/ during build)
tests/                  — Test suites (Vitest)
```

## Development

```bash
npm install
npm run build    # tsc + copy grammars to dist/
npm test         # vitest run --coverage
npm run watch    # tsc --watch
```

## License

MIT License. See the LICENSE file in the project repository.
