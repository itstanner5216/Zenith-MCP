# Search Tools — Current Implementation Breakdown

> **Purpose:** Reference document for refactoring `search_file` and `search_files`.
> Documents what each mode currently does in exhaustive detail so the intended behavior can be redesigned from an accurate baseline.

---

## Tool 1: `search_file` (single file)

**Source:** `packages/zenith-mcp/src/tools/search_file.ts`

**Schema:**
```
path: string (required)
maxChars?: number (budget cap, max ~400K, default 50K)
grep?: string (regex pattern)
grepContext?: number (context lines, 0–30, default 0)
symbol?: string (symbol name, dot-qualified for methods)
nearLine?: number (disambiguation for multiple symbol matches)
expandLines?: number (extra lines above/below symbol bounds, 0–50)
```

**Validation:** Must provide either `grep` or `symbol`. Throws if neither.

---

### search_file — grep mode

**Trigger:** `args.grep` is truthy

**Process:**

1. Validate the file path via `ctx.validatePath()`
2. Check `ripgrepAvailable()` — **hard requirement**; throws `'Regex grep requires ripgrep. In-process regex execution is disabled for safety.'` if not present
3. Calls `ripgrepSearch()` with:
   - `contentQuery`: the grep regex
   - `ignoreCase: true` (always case-insensitive)
   - `maxResults: 10000`
   - `contextLines`: clamped to 0–30
   - `fileList: [validPath]` (single file)
   - `includeContextLines: true`
   - `skipSensitiveFilter: true` (because the single file is already validated)
   - `maxMatchesPerFile: 500`
4. If ripgrep returns null → throws with `lastRipgrepError` detail
5. If results are empty → returns `'No matches.'`
6. Sorts results by `.line` ascending
7. Formats output:
   - Each line: `lineNum:*content` for actual matches, `lineNum:content` for context lines
   - Inserts `---` separator between non-contiguous blocks (gap > 1 line)
   - Stops adding lines when `maxChars` budget is exhausted
8. Returns joined output

**Key details:**
- No JS fallback — fails hard without ripgrep
- Always case-insensitive
- Sensitive-file filtering is skipped (file already validated)
- Context lines come from ripgrep's built-in `-C` flag
- The `*` marker on match lines is the only way to distinguish matches from context

---

### search_file — symbol mode

**Trigger:** `args.symbol` is truthy (and `args.grep` is falsy)

**Process:**

1. Validate the file path
2. Get language via `getLangForFile()` — throws `'Unsupported file type.'` if not detected
3. Read entire file content as UTF-8
4. Split content into lines array, count total lines
5. Call `findSymbol(source, langName, symbolName, { kindFilter: 'def', nearLine? })`:
   - `kindFilter: 'def'` — only looks for **definitions**, not references
   - `nearLine` passed through if provided for disambiguation
6. If no matches → throws `'Symbol not found.'`
7. If multiple matches AND no `nearLine` → throws `'Multiple matches. Use nearLine.'`
8. Takes `matches[0]` — the first (or nearest) match
9. Computes display range:
   - `startLine = max(1, sym.line - expandLines)`
   - `endLine = min(totalLines, sym.endLine + expandLines)`
10. Slices the source lines for that range
11. Prefixes each line with its line number: `lineNum:content`
12. Returns the numbered source slice

**Key details:**
- This is the **only tool that returns actual symbol source code** (not just location)
- Uses tree-sitter for precise symbol bounds
- Dot-qualified names supported (e.g., `Class.method`) — handled by `findSymbol()`
- `expandLines` adds context above and below the symbol's AST bounds
- No BM25, no ranking — it's a direct AST lookup
- If the symbol has multiple definitions in the same file, `nearLine` is required to disambiguate

---

## Tool 2: `search_files` (multi-file, directory-scoped)

**Source:** `packages/zenith-mcp/src/tools/search_files.ts`

**Schema:**
```
mode: "content" | "files" | "symbol" | "definition" (required)
path: string (required — directory to search)
maxResults?: number
contentQuery?: string
pattern?: string (glob)
contextLines?: number
literalSearch?: boolean
countOnly?: boolean
includeHidden?: boolean
pathContains?: string
extensions?: string[]
namePattern?: string
includeMetadata?: boolean
symbolQuery?: string
symbolKind?: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'module' | 'any'
definesSymbol?: string
```

**Note:** This is a flat schema where different params are relevant to different modes. Many params are ignored depending on mode.

---

### search_files — `symbol` mode

**Trigger:** `args.mode === "symbol"`

**Relevant params:** `path`, `symbolQuery`, `symbolKind`, `pattern`, `maxResults`

**Process:**

1. Validate root path
2. **File discovery:**
   - Try ripgrep `--files` with `namePattern` from `args.pattern`, exclude defaults, cap 2000
   - If ripgrep returns 0 results: JS walkdir fallback (respects default excludes + sensitive filter, cap 2000)
3. Filter discovered files to tree-sitter-supported extensions only
4. If no supported files → return `'No supported files found.'`
5. Set constants: `MAX_FILE_SIZE = 512KB`, `BATCH_SIZE = 50`
6. Determine `typeFilter` from `symbolKind` (if not 'any')

**Branch A — List All (no `symbolQuery`):**

7. For each file (in batches of 50, parallel):
   - Skip if size > 512KB or size === 0
   - Get language, read source
   - Call `getDefinitions(source, lang, { typeFilter? })` — gets all definitions
   - Format: `relPath: name (type:line), name (type:line), ...`
8. Budget-truncate the output lines

**Branch B — Symbol Query (has `symbolQuery`):**

7. For each file (in batches of 50, parallel):
   - Skip if size > 512KB or size === 0
   - Get language, read source
   - Call `getDefinitions(source, lang, { nameFilter: symbolQuery, typeFilter? })`
   - `nameFilter` is a **substring match** against symbol names
   - Format: `relPath:line  [type] name (lines line-endLine)`
8. Stop processing once `maxResults` reached (default 50, max 500)
9. Budget-truncate

**Key details:**
- This does **live tree-sitter parsing** of every file — no index DB involved
- `symbolQuery` is a substring filter, not exact match
- `pattern` feeds into file discovery only (not symbol matching)
- Does NOT return symbol source code — only locations
- 512KB file size cap is hardcoded
- No JS regex search here — purely tree-sitter

---

### search_files — `definition` mode

**Trigger:** `args.mode === "definition"`

**Relevant params:** `path`, `definesSymbol`, `extensions`, `namePattern`, `pathContains`, `maxResults`

**Process:**

1. Set `userMaxResults` (default 100, max 500)
2. **File discovery:**
   - Build effective pattern from `extensions` (single ext → glob) or `namePattern`
   - Try ripgrep `--files` with the effective pattern, `pathContains`, cap `maxResults * 5` or 2000
   - If 0 results: JS walkdir fallback with regex-ified `namePattern` and `pathContains`
3. Apply `extensions` filter to results
4. Filter to tree-sitter-supported files only
5. If no supported files → return not found message
6. Require `definesSymbol` — throws if missing
7. **Parse and search** (batches of 50, parallel):
   - For each file: skip if >512KB or empty
   - Get language, read source, call `getDefinitions(source, lang)` — all defs
   - Split `definesSymbol` by `.` into `[...parentNames, targetName]`
   - Filter definitions by exact `targetName` match
   - If dot-qualified: verify parent containment (each parent must contain child by line range)
   - Collect all matches per file
8. Stop when `maxResults` files with matches found
9. Format: `filePath:line  [type] name (lines line-endLine)`

**Key details:**
- This does **live tree-sitter parsing** — no index DB
- `definesSymbol` is an **exact match** (unlike `symbolQuery` in symbol mode which is substring)
- Supports dot-qualified hierarchical containment: `Class.method` checks that `method` is lexically inside `Class`
- Does NOT return source code — only locations
- Very similar to `symbol` mode but with exact matching and parent-chain verification

---

### search_files — `files` mode

**Trigger:** `args.mode === "files"`

**Relevant params:** `path`, `pattern`, `namePattern`, `pathContains`, `extensions`, `includeMetadata`, `includeHidden`, `maxResults`

**Process:**

1. Set `userMaxResults` (default 100, max 500)
2. **File discovery:**
   - Build effective pattern: `args.pattern` takes priority over `namePattern` or single-ext glob
   - Try ripgrep `--files` with effective pattern, `pathContains`, cap `maxResults * 2` or 2000
   - If 0 results: JS walkdir fallback with regex-ified `namePattern`, glob `pattern`, `pathContains`
3. Apply `extensions` filter if specified
4. Slice to `maxResults`, sort alphabetically
5. If `includeMetadata`: stat each file, append `(sizeKB, modifiedDate)`
6. Budget-truncate and return

**Key details:**
- Purely a file-finding tool — no content search, no parsing
- `pattern` is a minimatch glob matched against relative paths
- `namePattern` is regex-matched against filenames only (not full paths)
- Default excludes always applied (node_modules, .git, etc.)
- Sensitive files filtered out
- `includeHidden` is accepted in schema but **only used in content mode** — does nothing here

---

### search_files — `content` mode

**Trigger:** `args.mode === "content"` (or fallthrough after other modes don't match)

**Relevant params:** `path`, `contentQuery` (required), `pattern`, `extensions`, `pathContains`, `contextLines`, `literalSearch`, `countOnly`, `includeHidden`, `maxResults`

**Process:**

1. Require `contentQuery` — throws if missing
2. Set `userMaxResults` (default 50, max 500), `contextLines` (default 0)
3. Build `contentFileFilter()` function that checks `pathContains`, `extensions`, `pattern` against each result
4. Check ripgrep availability — if no ripgrep AND not `literalSearch`, throws

**Ripgrep path (if available):**

5. **BM25 pre-filter** (if query > 2 chars):
   - `bm25PreFilterFiles(rootPath, contentQuery, 100, excludes)` → top 100 candidate files
   - Filter candidates through `contentFileFilter`
   - Run ripgrep against those candidate files only
6. **Full ripgrep fallback** (if BM25 fails, query ≤ 2 chars, or no pre-filter results):
   - Run ripgrep against entire rootPath with all excludes
7. Apply `contentFileFilter` to ripgrep results
8. If `countOnly`: return `matches: N\nfiles: N`
9. **BM25 post-rank** (if results > `RANK_THRESHOLD`):
   - `bm25RankResults(rawLines, contentQuery, searchCharBudget)` → re-ranked by relevance
10. Otherwise: budget-truncate linearly
11. Format: `filePath:line: content` per match

**JS fallback path (literal search only, no ripgrep):**

5. Walk directory tree recursively
6. For each file passing `contentFileFilter`:
   - Read file, split into lines
   - Test each line against escaped literal regex (from `contentQuery`)
   - Collect: `filePath:line: trimmedContent` (content capped at 500 chars)
   - Stop at 200 total matches
7. If `countOnly`: return match/file counts
8. BM25 post-rank if above threshold, else budget-truncate

**Key details:**
- Two completely different code paths depending on ripgrep availability
- BM25 pre-filter is a **smart file selector** — narrows the search space before ripgrep runs
- BM25 post-rank is a **result relevance ranker** — reorders results by term relevance
- `RANK_THRESHOLD` determines when post-ranking kicks in (avoids ranking small result sets)
- `contextLines` only works with ripgrep (JS fallback doesn't support context)
- `literalSearch: true` escapes the query for both ripgrep (--fixed-strings) and JS fallback
- `includeHidden` is passed to ripgrep as `--hidden` flag
- `getSearchCharBudget()` is used (separate from main `getCharBudget()`) for output truncation

---

## Overlap Matrix

| Capability | `search_file` | `search_files` mode |
|---|---|---|
| Regex grep in one file | ✅ grep mode | ✅ content (with fileList of 1) |
| Return symbol source code | ✅ symbol mode | ❌ (returns locations only) |
| Substring symbol search | ❌ | ✅ symbol mode |
| Exact symbol definition find | ❌ | ✅ definition mode |
| List all symbols in scope | ❌ | ✅ symbol mode (no query) |
| Find files by glob/name | ❌ | ✅ files mode |
| BM25 ranked content search | ❌ | ✅ content mode |
| Context lines in grep | ✅ (ripgrep -C) | ✅ (ripgrep -C) |

---

## Key Behavioral Differences: grep in search_file vs content in search_files

| Aspect | `search_file` grep | `search_files` content |
|---|---|---|
| Scope | Single file | Directory tree |
| Case sensitivity | Always insensitive | Always insensitive |
| Ripgrep required | Yes (hard fail) | No (JS literal fallback) |
| BM25 pre-filter | N/A (one file) | Yes (for queries > 2 chars) |
| BM25 post-rank | No | Yes (if results > threshold) |
| Context lines | Yes (via ripgrep -C) | Yes (via ripgrep -C) |
| Output format | `line:*content` with `---` separators | `file:line: content` |
| Sensitive filter | Skipped (file pre-validated) | Applied |
| Max matches | 500 per file, 10K total | 500 via ripgrep, 200 via JS |
| JS fallback | None | Literal search only |

---

## Params That Don't Do What They Suggest

1. **`includeHidden` in files mode** — accepted in schema but only passed to ripgrep in content mode; does nothing in files/symbol/definition modes
2. **`pattern` in symbol mode** — only filters file discovery (ripgrep `--files`), not symbol matching
3. **`maxResults` in content mode** — default 50 but the ripgrep call uses `max(userMaxResults, 500)` meaning it always fetches at least 500 lines regardless; the actual cap is the char budget
4. **`contextLines` with JS fallback** — silently ignored; only ripgrep supports it
5. **`namePattern` vs `pattern`** — both exist, both filter files, with overlapping but different semantics (regex on filename vs glob on relative path)

---

## Known Issues / Smells

1. **`search_file` has no JS fallback for grep** — if ripgrep isn't available, single-file regex search completely fails. Yet the tool description doesn't communicate this requirement.

2. **`search_files` definition mode is almost identical to symbol mode** — definition uses exact match + parent-chain verification; symbol uses substring match. Both do live tree-sitter parsing of every file.

3. **BM25 pre-filter can cause false negatives** — if the BM25 file ranker excludes a file that actually contains the match, the ripgrep pass won't find it. The fallback is a full ripgrep scan, but it only triggers if the pre-filter returns 0 candidates (not if it returns some but misses others).

5. **`search_file` symbol mode uses `findSymbol()` while `search_files` definition mode uses `getDefinitions()`** — these are different tree-sitter functions with different matching behavior. `findSymbol` supports dot-qualification natively; `getDefinitions` + manual parent-chain checking is a re-implementation of similar logic.

6. **Two separate walks with different semantics** — `search_files` has at least 4 different `walk()` implementations (one per mode) with slightly different filter logic and directory validation behavior.

7. **Content mode's `pattern` does double duty** — passed to ripgrep as `filePattern` AND used in `contentFileFilter` for the JS fallback, but the ripgrep `filePattern` is interpreted differently (as a glob by rg) than the minimatch usage in the JS filter.
