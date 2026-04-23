## Developer Documentation & Cheat Sheet: Secure Filesystem MCP Server

## CRITICAL
You are working on tool design and implementation for an agent system where context efficiency is critical.

Previous failures:

The previous tool design produced extreme tool bloat: about 7.5x useless tool output for every 1x useful information. This wasted context, degraded memory, and harmed agent performance.

Design rule:
1. Return only new, decision-relevant information.
2. Do NOT return information the caller already knows, can directly infer from the request, or can get from a separate tool that already exists for that purpose. Each tool has an explicit scope. No tool should step outside of its scope, regardless if it’s “helpful” 

Required workflow:
- Do NOT parrot request inputs back in the response.
- Do NOT return paths, selectors, mode names, line ranges, oldText, newText, diffs, metadata, or summaries unless they are strictly necessary to disambiguate the result or recover from failure.
- Stay within the tool’s scope. A tool should return only what is necessary for its own job.
- If another dedicated tool exists for metadata, diagnostics, file info, diff inspection, or search, do not duplicate that functionality in another tool’s return. Stay within the tools scope. 
- Prefer MINIMAL success responses. 
- Do not be “helpful” by adding verbose diagnostics. Headers, separators, extra non essentials for “nice” formatting. 

Response discipline:
- Success should usually be as small as possible, for example:
  '{successful}'
- Dry-run should usually be minimal, for example:
  '{Dry Run Successful}'
- Failure should include only actionable new information, for example:
  {“OLD_TEXT_NOT_FOUND"}
  {"PARSE_ERROR","message":"Expression expected.","line":91,"}

Examples of what NOT to do:
**Bad**:
{"ok":true,"path":"/x/y/z.ts","mode":"symbol","symbol":"buildPrompt","line":84,"oldText":"…","newText":"…","summary":"Successfully updated buildPrompt in /x/y/z.ts"}
**Why this is bad**:
The caller already knows the path, target, and requested edit.
Special rule for single-target operations:
- If the caller sent one path, do not parrot back that path.
Only include identifiers like path or edit index when needed to distinguish among multiple possible targets or failures in batch edits or similar use cases where it is needed. 

Rich internals do NOT need to be boasted about in the tool operators returns, that means they do NOT need to be told “this tool has XYZ features and does N” in reference to what the tool does on the backend.

**Enforced repo policy **:
- When designing or modifying tools, optimize for minimal, scope-correct, non-duplicative outputs. Guard aggressively against context bloat. If unsure whether to include a field, omit it unless it clearly changes the caller’s next action.

---

### 1. High-Level Architecture & File Structure

The server uses a modular architecture, isolating tool logic from core engine capabilities.

*   **`index.js` (The Orchestrator):** The primary entry point. It parses CLI arguments, establishes allowed directories, initializes the `McpServer`, dynamic imports tools, and sets up the MCP Roots Protocol for dynamic workspace negotiation.
*   **`lib.js` (Security & IO):** Houses low-level file operations. Crucially, it contains `validatePath()`, which expands `~`, resolves symlinks, and enforces that all operations remain within `allowedDirectories`.
*   **`shared.js` & `bm25.py` (The Search Engine):** Manages the `ripgrep` integration and houses the custom BM25 ranking algorithm.
*   **`tree-sitter.js` (Semantic Parsing):** Manages the loading of WASM grammars and `.scm` queries for 20+ programming languages to enable AST-aware features.
*   **`tools/` (The Endpoints):** Directory containing isolated tool definitions (e.g., `edit_file.js`, `search_files.js`).

---

### 2. Key Integrations: Search & Semantics

#### Tree-sitter (Semantic Code Awareness)
Instead of treating code as plain text, the server uses `web-tree-sitter` (WASM) to understand the Abstract Syntax Tree (AST).
*   **Lazy Loading:** WASM binaries (e.g., `tree-sitter-python.wasm`) and AST queries (e.g., `python-tags.scm`) are loaded only when a file of that type is first encountered, minimizing overhead.
*   **Caching:** Parsed AST symbols are stored in an LRU cache (capped at 100 entries), keyed by a hash of the source code.
*   **Usage:** Upgrades tools to be "code-aware." For example, `find_files` can locate where a specific class is *defined*, and `edit_file` can target a logical block like `symbol: "AuthService.login"` for replacement without knowing line numbers.

#### BM25 & Ripgrep (Intelligent Search)
To navigate massive codebases while respecting the LLM context limit (`CHAR_BUDGET` ~400k), the server employs a two-stage search:
1.  **BM25 Pre-filtering:** When scanning a repository, the server builds an in-memory BM25 index of file paths and their first ~8KB. It ranks them against the natural language query to find the top 50 candidates, passing *only* those to `ripgrep`.
2.  **Ripgrep Execution:** Executes extremely fast regex searches on the pre-filtered files (or falls back to a JS implementation if `rg` is unavailable).
3.  **BM25 Post-filtering:** If the results exceed `RANK_THRESHOLD` (50 lines), BM25 ranks the individual result lines. The most relevant matches are prioritized to fill the character budget, and the rest are truncated.

---

### 3. Code-Level Nuances: Security & Editing

#### Edit Verification & Execution (`edit_file.js`)
The `edit_file` tool operates using a **Memory-First, All-or-Nothing** approach:
1.  **In-Memory Validation:** Edits are verified against an in-memory string of the file.
    *   *Content Match Mode:* Uses 3 strategies: exact match, trimmed match (ignores trailing spaces), and indent-stripped match (finds logic blocks and re-indents `newText` to match the file).
    *   *Range Mode:* Strictly requires `verifyStart` and `verifyEnd` strings only, you never have to write the full old text block, 2 lines instead of the currently enforced full old text of up to potentially 100 plus lines. The server asserts the trimmed contents of `startLine` and `endLine` match exactly to catch external file drift.
    *   *Symbol Mode:* Uses Tree-sitter to find the exact bounds of the symbol to replace, prevents full old text parroting as well.
2.  **Atomic Commit:** If *any* edit in a multi-edit batch fails validation, the whole batch is rejected and the file is untouched. Edits are stashed to SQLite for retry via `stashApply`. Single edits that fail are also stashed. On success, writes to a temp file, verifies size, and uses `fs.rename()` for an atomic swap.

#### The Stash System
Failed edits and writes are persisted to SQLite (`stash_edits` / `stash_writes` tables) with a 120-second TTL and 2-attempt limit.
*   On edit failure, the error returns a `stashId` and lists only the failed edits with their specific mismatch.
*   On write failure (e.g., permission denied, bad path), the content is stashed and a `stashId` is returned.
*   The LLM retries via `stashApply` — providing the `stashId` and corrected verifications for only the failed edits (or a corrected `path` for writes). Unchanged edits rehydrate from the stash.
*   After 2 failed attempts or 120s, the stash entry is deleted.


#### Security Hardening
*   **Sensitive Files:** `isSensitive()` blocks access to credentials (`.env`, `.pem`, etc.) using `minimatch` glob patterns.
*   **Exclusive Writes:** New file creation uses the `wx` flag to ensure the file doesn't already exist, preventing malicious writes through pre-existing symlinks.

---

### 4. Tool Catalog Reference

| Tool Name               | Key Capabilities                   | Parameters & Nuances                                                                                                      |
| :---------------------- | :--------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| **create_directory**    | Recursively creates directories.   | `path` (Idempotent).                                                                                                      |
| **delete_file**         | Permanently deletes a file.        | `path` (Cannot delete directories).                                                                                       |
| **directory_tree**      | Indented text tree of dirs/files.  | `path`, `excludePatterns`, `showSymbols` (Appends Tree-sitter metadata). Caps at 500 entries.                             |
| **edit_file**           | Surgical, safe file modification.  | `path`, `edits`. Modes: Content Match, Range, Symbol. Supports dry-runs. Failures stashed for retry.                      |
| **stashApply**          | Retry failed edits/writes.         | `stashId`, `type` (edit/write), `fixes` (corrected verifications), `path` (for write retries). 2 attempts max.            |
| **find_files**          | Fast file location.                | `path`, `namePattern`, `pathContains`, `relevanceQuery` (BM25), `definesSymbol` (Tree-sitter).                            |
| **get_file_info**       | Gets file/dir metadata.            | `path` (Returns size, mtime, permissions).                                                                                |
| **list_directory**      | Text-format directory listing.     | `path`, `depth`, `listAllowed` (Lists root workspaces). Caps at 250 entries/dir.                                          |
| **move_file**           | Moves or renames files/dirs.       | `source`, `destination` (Both must be allowed).                                                                           |
| **read_media_file**     | Reads images/audio.                | `path` (Returns Base64 + MIME type).                                                                                      |
| **read_multiple_files** | Reads multiple files concurrently. | `paths`. Dynamically balances `CHAR_BUDGET`, truncating the largest files if needed.                                      |
| **read_text_file**      | Versatile text reader.             | `path`, `head/tail/offset`, `grep` (with context), windowed reading (`aroundLine`), Tree-sitter block reading (`symbol`). |
| **search_files**        | Content and symbol search.         | `path`, `contentQuery`, `symbolQuery`, `listSymbols`. Uses Ripgrep + BM25 ranking.                                        |
| **write_file**          | Creates/overwrites/appends files.  | `path`, `content`, `createOnly`, `append` (Smart-resumes overlapping tails). Atomic writes.                               |

---

### 5. Developer Cheat Sheet

**Adding a New Tool:**
1. Create `tools/my_new_tool.js`.
2. Export `register(server)`.
3. Use `zod` for strict `inputSchema`.
4. **Mandatory:** Call `await validatePath(args.path)` before *any* `fs` operation.
5. Import and call it in `index.js`.

**Tree-sitter Snippet (Finding a Symbol):**

```javascript
import { findSymbol } from '../tree-sitter.js';
// Finds the bounds of a method named 'login' inside 'AuthService'
const matches = await findSymbol(sourceCode, 'javascript', 'AuthService.login', { kindFilter: 'def' });
console.log(`Starts at line: ${matches[0].line}, ends at: ${matches[0].endLine}`);
```

**BM25 Snippet (Ranking Search Results):**

```javascript
import { bm25RankResults, CHAR_BUDGET } from '../shared.js';
// Takes raw Ripgrep output lines and ranks them by relevance to the query
const { ranked } = bm25RankResults(rawRipgrepLines, "authentication logic", CHAR_BUDGET);
```
