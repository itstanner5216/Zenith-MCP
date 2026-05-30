 ⚠️ BUG FOUND: Requesting range [0,0] (first line only) returned "see
 attached image" instead of the text content. That's clearly a bug from
 the conversion — it's treating single-line reads as media.

 Also the range [0,2] should include line3 but only shows 2 lines.
 
  ⚠️ BUG FOUND: Append lost the first write content. Should show
 "first\nsecond\n" but only shows "second\n".
 
 Confirmed — failIfExists: true is being ignored. The third write
 overwrote the second, which shouldn't have existed in the first place.
 
Interesting — mkdir doesn't recursively create. Let me test more edge
 cases:
 
 ⚠️ POTENTIAL BUG: refactor_batch query timed out. Could be an MCP
 issue or it might hang on bad inputs.
 
 BUG: file_manager delete is timing out consistently. Let me try via
 bash:
 
 BUG: write_file says "File written" but the file doesn't exist on
 disk when file_manager tries to stat it immediately after.
 
 Works on retry. There's some kind of filesystem sync/timing issue
 between write_file and file_manager — or possibly between MCP tool
 calls generally.

search_file, grep mode. 
Confirmed issue:
- No JS fallback — fails hard without ripgrep
- Sensitive-file filtering is skipped (file already validated)
- Context lines come from ripgrep's built-in `-C` flag
- The `*` marker on match lines is the only way to distinguish matches from context

symbol mode:
   - `kindFilter: 'def'` — only looks for **definitions**, not references

Investigate what these even are:
literalSearch?: boolean
countOnly?: boolean
contentQuery?: string
pattern?: string (glob)
pathContains?: string
pathContains?: string
extensions?: string[]
namePattern?: string
includeMetadata?: boolean
definesSymbol?: string vs symbolQuery?: string

search_files
symbol mode:
5. Set constants: `MAX_FILE_SIZE = 512KB`, `BATCH_SIZE = 50`
investigate if search_files uses bmx, if not; was changed without permission or knowledge and needs to utilize bmx when determining what results to return. Rank caller input with content of all potential returns so the highest ranking files/results are provided. 

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

## Branch A && B theyre out of scope, and not supposed to be a search files function. This is actually my "blast radius" function, or apart of it, and belongs within the refactor branch pipeline, not in search files. 

Branch B:
- `symbolQuery` is a substring filter, not exact match in Branch B, which is a sad pathetic display of the implementing agents work ethic considering all of the real language awareness zenith has. This needs fixed. 
- `pattern` feeds into file discovery only (not symbol matching) -- # missed opportunity, fix.
- Does NOT return symbol source code — only locations ## completely a missed opportunity rendering this branch useless. Another sad implementation by a lazy agent. What am i paying for again? Smh 

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

## Also out of scope. Belongs to refactor batches pipeline. 

**Create a symbol search tool, so it is explicit and models stop doing this. Add all of the symbol searching operations there, after filtering out alot of the bs symbol search methods**

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
## this has all these params when it literally should just be one function, that accepts a query. Period. Maybe include a include hidden param, every other param is fucking stupid. 


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
