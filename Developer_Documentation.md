# Developer Documentation: Secure Filesystem MCP Server

This document provides a comprehensive guide for developers to understand, maintain, and extend the **Secure Filesystem MCP Server**.

---

## 1. High-Level Architecture
The server is built using the **Model Context Protocol (MCP)**, designed to provide LLMs with safe, high-performance access to the local filesystem.

### Evolutionary Context
The codebase has recently migrated from a monolithic architecture (`index.js.bak`) to a **modular architecture**.
- **Entry Point:** `index.js` initializes the `McpServer` and handles lifecycle events.
- **Tools:** Logic for specific capabilities is isolated in the `tools/` directory.
- **Core Engine:** Shared logic for security, pathing, and search resides in the root-level `.js` files.

---

## 2. Core Components & Interactions

### `index.js` (The Orchestrator)
- Parses command-line arguments to set initial `allowedDirectories`.
- Implements the **MCP Roots Protocol**, allowing clients to dynamically grant access to new directories.
- Dynamically registers tools imported from the `tools/` directory.

### `lib.js` (Low-Level IO & Security)
- **`validatePath(requestedPath)`**: The most critical security function. It expands `~`, resolves symlinks, and ensures the resulting real path resides within an allowed directory.
- **Atomic Operations**: Implements safe writes using temporary files and `fs.rename` to prevent race conditions and partial writes.
- **Unified Diffing**: Uses the `diff` library to generate and apply surgical edits.

### `tree-sitter.js` (Semantic Awareness)
- Integrates **Tree-sitter (WASM)** to parse source code in 20+ languages.
- Provides `getSymbols`, `getDefinitions`, and `findSymbol`.
- Enables "Symbol-based Editing" where an LLM can say "replace the body of the `sendMessage` function" without knowing line numbers.

### `shared.js` & `bm25.py` (The Search Engine)
- Contains **BM25Index**, a Term-At-A-Time (TAAT) lexical search engine.
- **Pre-filtering:** Uses BM25 to find the top 50 relevant files before running `ripgrep`.
- **Post-filtering:** Ranks `ripgrep` output by relevance to ensure the most "important" matches appear first within character budgets.

---

## 3. Key Integrations

| Feature | Integration | Purpose |
| :--- | :--- | :--- |
| **Search** | `ripgrep` (`rg`) | Blazing fast content search and file discovery. |
| **Parsing** | `web-tree-sitter` | Multi-language symbol extraction and navigation. |
| **Validation** | `zod` | Strict input schema validation for all MCP tools. |
| **Pathing** | `minimatch` | Glob pattern matching for excludes and sensitive file blocking. |

---

## 4. Code-Level Nuances & Gotchas

### Security Hardening
- **Sensitive Files:** `isSensitive()` in `shared.js` blocks access to `.env`, `.pem`, `.key`, and other credentials based on patterns.
- **Atomic Writes:** `writeFileContent` uses the `wx` flag to ensure exclusive creation, preventing symlink-following attacks.

### Path Normalization
- **WSL Support:** `path-utils.js` contains specific logic to *avoid* converting `/mnt/c` paths to Windows format, as Node.js in WSL handles them natively.
- **Trailing Slashes:** Directories are normalized with trailing slashes in listings to distinguish them from files.

### Performance & Memory
- **Character Budgets:** `CHAR_BUDGET` (~400k chars) is enforced across `read_multiple_files` and `search_files` to prevent crashing the LLM context or the server.
- **Lazy Loading:** Tree-sitter WASM and grammars are loaded only when first needed.

---

## 5. Developer's Cheat Sheet

### Adding a New Tool
1. Create `tools/my_new_tool.js`.
2. Export a `register(server)` function.
3. Use `zod` for `inputSchema`.
4. **Must** call `validatePath(args.path)` before any file operation.
5. Register it in `index.js`.

### Performing a Surgical Edit
The `edit_file` tool supports multiple matching strategies:
- **Exact:** Matches `oldText` byte-for-byte.
- **Trimmed:** Matches ignoring trailing whitespace.
- **Indent-stripped:** Matches ignoring leading whitespace but preserves original indentation in the replacement.

### Finding a Symbol
```javascript
// Example: Find the 'User' class in a file
import { findSymbol } from '../tree-sitter.js';
const matches = await findSymbol(source, 'javascript', 'User', { kindFilter: 'def' });
// matches[0].line -> Start of class
// matches[0].endLine -> End of class body
```

### Search Pipeline Flow
1. **Pre-filter:** `bm25PreFilterFiles` identifies candidate files.
2. **Execute:** `ripgrepSearch` scans those files for the `contentQuery`.
3. **Post-filter:** `bm25RankResults` sorts matches by relevance.
4. **Budget:** Results are truncated to fit within `CHAR_BUDGET`.

---

## 6. Directory Structure Reference
```text
.filesys/
├── index.js          # Entry point (Modular)
├── lib.js            # Security & Atomic IO
├── shared.js         # Search Engine & Config
├── tree-sitter.js    # Semantic Parsing
├── path-utils.js     # OS-specific path handling
├── grammars/         # WASM binaries for Tree-sitter
└── tools/            # Individual MCP tool definitions
    ├── read_text_file.js
    ├── edit_file.js
    └── ...
```
