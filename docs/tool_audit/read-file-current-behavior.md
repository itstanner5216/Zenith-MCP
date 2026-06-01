# `read_file` — Current Implementation Breakdown

> **Purpose:** Reference document for understanding and redesigning `read_file`.
> Documents what the tool currently does in exhaustive detail, tracing through all helpers and code paths, so the intended behavior can be redesigned from an accurate baseline.

---

## Source

**Tool file:** `packages/zenith-mcp/src/tools/read_file.ts`

**Key dependencies:**
- `core/lib.ts` — `readFileContent()`, `FilesystemContext`
- `core/compression.ts` — `compressTextFile()`, `truncateToBudget()`
- `core/shared.ts` — `getCharBudget()`
- `zenith-toon` package — `compressString()`, `compressSourceStructured()`

---

## Schema

```
path: string (required) — "File path."
maxChars?: number — "Max chars. Up to 400K."
compression?: boolean — "Compress file-read output."
aroundLine?: number — "Center window on this line."
context?: number — "Window radius. Default 30."
ranges?: Array<{ startLine: number; endLine: number }> — "Explicit line ranges."
```

**Annotations:** `readOnlyHint: true` (no `idempotentHint` or `destructiveHint` set)

**No `mode` enum.** This is a flat schema with no discriminated union — the code path branches based on which optional fields are present.

---

## Schema Field Details

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `path` | `string` | Yes | — | Passed through `ctx.validatePath()` before any I/O |
| `maxChars` | `number` | No | `50000` | Clamped to `min(userValue ?? 50000, getCharBudget())`. Schema description says "Up to 400K" but the actual cap is `getCharBudget()` which defaults to `400_000` and is configurable between `10_000` and `2_000_000` |
| `compression` | `boolean` | No | `undefined` (falsy) | Only evaluated in the full-file read path; silently ignored in the windowed read path |
| `aroundLine` | `number` | No | `undefined` | 1-indexed line number; triggers windowed read path when present |
| `context` | `number` | No | `30` | Radius around `aroundLine`; only meaningful when `aroundLine` is set; no min/max clamping applied |
| `ranges` | `Array<{startLine, endLine}>` | No | `undefined` | 1-indexed, inclusive on both ends; `startLine` is floored to `max(1, startLine)` but `endLine` has no upper bound clamping |

---

## Code Path Decision

The handler has exactly **two branches**, selected by a single `if` condition at the top:

```
if (args.aroundLine !== undefined || (args.ranges && args.ranges.length > 0))
  → Windowed Read Path
else
  → Full-File Read Path
```

There is no mode parameter. The branch is entirely determined by whether `aroundLine` or `ranges` is provided.

---

## Windowed Read Path

**Trigger:** `aroundLine` is set OR `ranges` has at least one entry.

**Process:**

1. Validate the file path via `ctx.validatePath()`
2. Compute `maxChars = min(args.maxChars ?? 50000, getCharBudget())`
3. Build a `windows: LineWindow[]` array from the inputs:
   - If `aroundLine` is set: push a window of `[aroundLine - context, aroundLine + context]` where `context` defaults to `30`. `startLine` is floored to `max(1, ...)` but `endLine` is NOT clamped to any maximum
   - If `ranges` has entries: push each range as a window with `startLine` floored to `max(1, ...)` but `endLine` NOT clamped
   - Both `aroundLine` and `ranges` can be provided simultaneously — both contribute windows
4. Sort all windows by `startLine` ascending
5. Merge overlapping/adjacent windows (gap ≤ 1 line apart)
6. Open a **streaming readline** on the validated file path (`createReadStream` + `createInterface`)
7. Stream through the file line-by-line (1-indexed), tracking `totalLines`:
   - Skip lines before the current window's `startLine`
   - When a line falls within a window, format it as `lineNum:lineContent`
   - Advance to the next window when `totalLines > currentWindow.endLine`
   - Insert `---` separator between non-contiguous collected regions (gap > 1 line)
   - Track character count; when `charCount + formatted.length + 1 > maxChars`, set `budgetExhausted = true` and stop collecting (but the stream continues to EOF to count total lines)
8. Join output lines with `\n`
9. If budget was exhausted, append `\n[truncated]` to the output
10. Return result as `{ content: [{ type: "text", text }] }`

**Key details:**
- Uses **streaming I/O** (`createReadStream`) — does not load the entire file into memory
- `aroundLine` and `ranges` can be combined in one call; all windows are merged
- Line numbers are 1-indexed in the output format `lineNum:content`
- The stream reads to EOF even after budget exhaustion (lines are skipped but counted)
- There is no upper-bound validation on `endLine` — values beyond the file length are silently capped by EOF
- There is no lower-bound validation on `context` — negative values would produce an inverted window (startLine > endLine), which would result in an empty output
- The `compression` parameter is **completely ignored** in this path
- The `---` separator counts 4 characters toward the budget (3 dashes + 1 newline)
- Budget check uses `<=` comparison: `charCount + formatted.length + 1 <= maxChars` — the +1 accounts for the newline join separator
- When `budgetExhausted` is true and `body` is empty, returns just `[truncated]`

---

## Full-File Read Path

**Trigger:** Neither `aroundLine` nor `ranges` is provided.

**Process:**

1. Validate the file path via `ctx.validatePath()`
2. Compute `maxChars = min(args.maxChars ?? 50000, getCharBudget())`
3. Read the entire file into memory via `readFileContent(validPath)` — which calls `fs.readFile(filePath, 'utf-8')`
4. **Truncation check:** If `content.length > maxChars`:
   - Call `truncateToBudget(content, maxChars)` (see detailed behavior below)
   - Replace `content` with the truncated text
   - Set `truncated = true`
5. **Line numbering:** Split content by `\n`, remove trailing empty line if present, then prefix each line with `lineNumber:` (1-indexed) and rejoin with `\n`
6. **Compression** (only if `args.compression` is truthy):
   - Call `compressTextFile(validPath, content, maxChars)` (see detailed behavior below)
   - If compression returns a non-null result, replace `content` with the compressed text
   - If compression returns null (not useful), keep the line-numbered content as-is
7. If `truncated` is true, append `\n[truncated]` to the final text
8. Return result as `{ content: [{ type: "text", text }] }`

**Key details:**
- Reads the **entire file into memory** — no streaming
- Line numbering happens AFTER truncation but BEFORE compression — so compressed output receives pre-numbered lines
- Truncation is applied before compression — this means if the file is larger than `maxChars`, it is first truncated, then the truncated (already budget-sized) content is passed to compression. Since the truncated content is already within budget, compression will usually return null (see `computeCompressionBudget` logic)
- The `[truncated]` marker is appended to the final output regardless of whether compression further changed the content
- Trailing empty line removal: the code checks `if (lines[lines.length - 1] === '') lines.pop()` — this removes exactly one trailing empty line resulting from a file that ends with `\n`

---

## `truncateToBudget()` — Detailed Behavior

**Source:** `core/compression.ts` (lines 41–58)

**Signature:** `truncateToBudget(text: unknown, budget: number): { text: string; truncated: boolean }`

**Process:**

1. If `text` is not a string → return `{ text: '', truncated: false }`
2. If `text.length <= budget`:
   - Check if text has any non-newline content: `text.replace(/\n/g, '').length > 0`
   - If yes → `{ text, truncated: false }`
   - If no (all newlines) → `{ text, truncated: true }` ← **NOTE: returns the full text but sets truncated=true for blank content**
3. If `text.length > budget`:
   - Find the last newline character at or before the `budget` position: `text.lastIndexOf('\n', budget)`
   - If no newline found → cut at exactly `budget`
   - Otherwise → cut at the newline position (preserving complete lines)
   - Return `{ text: text.slice(0, cutoff), truncated: true }`

**Key details:**
- Attempts to truncate at a line boundary to avoid splitting a line mid-way
- If the file has no newlines within the budget, it falls back to a hard character cutoff
- The "all-newlines" case is an edge case where `truncated` is set to `true` even though the full text is returned — this would cause a `[truncated]` marker on the output even though nothing was actually removed

---

## `compressTextFile()` — Detailed Behavior

**Source:** `core/compression.ts` (lines 70–140)

**Signature:** `compressTextFile(validPath, rawText, maxChars, keepRatio?)`

**Returns:** `{ text, targetBudget, rawLength, compressedLength } | null`

**Process:**

1. Compute target budget via `computeCompressionBudget(rawText.length, maxChars, keepRatio)`:
   - `keepRatio` defaults to `0.70` (70%)
   - `ratioBudget = max(1, floor(rawText.length * 0.70))`
   - `targetBudget = min(maxChars, ratioBudget)`
   - If rawLength ≤ 0 or not finite → budget is 0
2. If `targetBudget <= 0` or `targetBudget >= rawText.length` → return `null` (compression not needed or impossible)
3. **Structured compression attempt** (tree-sitter path):
   - Detect language via `getLangForFile(validPath)` — uses file extension/basename to map to tree-sitter grammar name
   - If language detected:
     - Parse symbols via `getSymbols(rawText, langName)` — full tree-sitter parse yielding definitions and references
     - Filter to `kind === 'def'` symbols only
     - Map symbols to `StructureBlock[]` with `startLine` and `endLine` converted to **0-indexed** (tree-sitter symbols are 1-indexed, `- 1` applied)
     - Each block gets `exported: false` and `anchors: []` (hardcoded)
     - **Call-graph enrichment**: `findRepoRoot(validPath)` tries to locate the git repo root, then if found:
       - Opens the symbol-index DB via `getDb(repoRoot)` (creates `.mcp/symbols.db` if needed)
       - Queries `getFileBlockEdges(db, relPath, blockNames)` for intra-file call edges
       - If edges found, adds them to `context.astEdges`
       - DB errors are silently caught (compressed without graph data)
     - Call `compressSourceStructured(rawText, targetBudget, structure, context)` from `zenith-toon`
   - If tree-sitter fails (parse error, no grammar) → falls through silently
4. **Unstructured fallback** (if structured compression returned null):
   - Call `compressString(rawText, targetBudget)` from `zenith-toon`
   - This auto-detects content type (source code, stack trace, JSON, log output, generic text) and applies appropriate compression strategy
5. **Usefulness check** via `isCompressionUseful(rawText, compressed, maxChars, keepRatio)`:
   - Returns false if compressed is null or empty
   - Returns false if `rawText.length === maxChars` exactly (already at budget)
   - Returns false if `targetBudget <= 0` or `targetBudget >= rawText.length`
   - Returns true only if ALL conditions met:
     - `compressed.length < rawText.length`
     - `compressed.length <= targetBudget`
     - `compressed.length < maxChars`
6. If not useful → return `null`
7. If useful → return `{ text: compressed, targetBudget, rawLength, compressedLength }`

**Key details:**
- The tool handler only uses `result.text` from the return value — `targetBudget`, `rawLength`, and `compressedLength` are discarded
- Compression uses in-process `zenith-toon` imports — no subprocess spawning
- The `DEFAULT_COMPRESSION_KEEP_RATIO` of `0.70` means the target is never more than 70% of the original
- When a file is already truncated to `maxChars` before compression is called, `computeCompressionBudget` will compute `ratioBudget = floor(maxChars * 0.70)` — so it tries to compress the already-truncated content to 70% of maxChars
- `exported` is always set to `false` for all blocks — the `zenith-toon` compressor can boost exported symbols but this information is never provided from the tree-sitter parse
- The call-graph enrichment only works if:
  - The file is inside a git repo
  - The symbol-index DB (`.mcp/symbols.db`) exists or can be created
  - The file has been indexed previously (edges exist in the DB)

---

## `getCharBudget()` — Detailed Behavior

**Source:** `core/shared.ts` (lines 20–24)

**Process:**

1. Load config from `~/.zenith-mcp/config` (cached after first load)
2. Read `config.advanced.char_budget`
3. If it's a valid number between `10_000` and `2_000_000` (inclusive), use it
4. Otherwise, default to `400_000`

**Config default:** `400_000` (from `DEFAULT_CONFIG.advanced.char_budget`)

---

## `readFileContent()` — Detailed Behavior

**Source:** `core/lib.ts` (line 190–192)

Simply calls `fs.readFile(filePath, encoding)` where encoding defaults to `'utf-8'`. Returns the entire file as a string. No size checks, no streaming, no guards.

---

## `validatePath()` — Detailed Behavior

**Source:** `core/lib.ts` (lines 34–63)

**Process:**

1. Expand `~` to home directory
2. Resolve to absolute path (relative paths resolved against `process.cwd()`)
3. Normalize the path
4. **No allowed-directory sandbox check** — the comment says "Zenith is intentionally not a sandbox"
5. Resolve symlinks with `fs.realpath()`
6. If `ENOENT` → check parent directory exists, return the (non-existent) path if parent is valid
7. If parent doesn't exist → throw `"Parent directory does not exist: ..."`
8. Returns the resolved real path

**Key detail:** This implementation does **not** enforce allowed-directory restrictions. The allowed-directory list is kept for project-context hints only.

---

## Output Format

**Windowed path output:**
```
lineNum:lineContent
lineNum:lineContent
---
lineNum:lineContent
[truncated]
```

**Full-file path output:**
```
1:first line of file
2:second line of file
...
N:last line of file
[truncated]
```

**Compressed full-file output:**
The compression engine produces its own format with `[TRUNCATED: lines X-Y]` markers, `# ...` omission markers, etc., depending on the content type. The line-numbered input is fed to compression, so compressed output contains pre-numbered lines.

**Key details:**
- Line numbers are always 1-indexed
- The delimiter between line number and content is `:` with no space
- Both paths use `\n` as the line separator
- The `---` separator only appears in windowed output between non-contiguous blocks
- The `[truncated]` marker only appears when the budget was exceeded (full-file path) or `budgetExhausted` was set (windowed path)

---

## Interaction Between Parameters

| `aroundLine` | `ranges` | `compression` | Path Taken | Compression Used? |
|---|---|---|---|---|
| absent | absent | absent | Full-file | No |
| absent | absent | `true` | Full-file | Yes (attempted) |
| present | absent | any | Windowed | No (ignored) |
| absent | present (non-empty) | any | Windowed | No (ignored) |
| present | present (non-empty) | any | Windowed | No (ignored) |
| absent | present (empty `[]`) | absent | Full-file | No |
| absent | present (empty `[]`) | `true` | Full-file | Yes (attempted) |

**Key observation:** An empty `ranges` array (`[]`) does NOT trigger the windowed path — the condition checks `args.ranges && args.ranges.length > 0`.

---

## Effective Budget Computation

The `maxChars` budget flows differently in each path:

**Windowed path:**
- `maxChars = min(args.maxChars ?? 50000, getCharBudget())`
- Budget is checked per-line as characters accumulate
- Budget includes the `---` separators (4 chars each)
- Budget check accounts for the newline between lines (+1 per line)

**Full-file path (no compression):**
- `maxChars = min(args.maxChars ?? 50000, getCharBudget())`
- `truncateToBudget` applies to the raw file content (BEFORE line numbering)
- Line numbering adds `lineNum:` prefix characters — this expansion is NOT counted against the budget
- So the actual output can be significantly larger than `maxChars` due to line number prefixes

**Full-file path (with compression):**
- Same `maxChars` passed to `compressTextFile`
- Compression budget = `min(maxChars, floor(rawText.length * 0.70))`
- Note: `rawText` here is the already line-numbered content (post-truncation, post-numbering)

---

## Params That Don't Do What They Suggest

1. **`maxChars` described as "Up to 400K"** — the actual upper bound is `getCharBudget()`, which defaults to `400_000` but is configurable up to `2_000_000`. The schema description is misleading for custom configurations.

2. **`compression` in windowed reads** — accepted in the schema and never validated, but completely ignored when `aroundLine` or `ranges` is provided. No error or warning is returned.

3. **`context` without `aroundLine`** — the schema describes it as "Window radius. Default 30." but it has no effect whatsoever unless `aroundLine` is also provided. It does not affect `ranges` behavior.

4. **`maxChars` in full-file path** — truncation is applied to the raw file content, but line numbering adds characters afterward. If a file is exactly `maxChars` long, the output will be `maxChars + (total_line_count * avg_line_number_prefix_length)` characters — the budget is not respected in the final output.

5. **`ranges[].endLine`** — described as an explicit line range but has no upper-bound clamping. Values of `endLine: 999999999` are silently handled (the stream just reads to EOF). This is benign but the schema suggests it should be a real line number.

---

## Known Issues / Smells

1. **Line numbering inflates output beyond `maxChars`** — truncation happens on raw content, then line numbers are prepended. For a 50K-char file read with `maxChars: 50000`, the output will be ~55K+ due to line number prefixes (`1:`, `2:`, ..., `1234:`). The budget is not faithfully enforced in the final output. This is further compounded when compression is enabled, as the compressor receives the inflated, line-numbered text.

2. **Compression after truncation is often a no-op** — when `content.length > maxChars`, the content is first truncated to fit the budget. Then compression tries to compress the already-budget-sized content to 70% of the budget. While this could work, the `isCompressionUseful` check can fail in edge cases where `rawText.length === maxChars` (returns false immediately). The truncation path sets `content` to a string whose length is ≤ `maxChars`, so the edge case where `rawText.length` equals `boundedMaxChars` exactly is real.

3. **Streaming reader still reads to EOF** — in the windowed path, when `budgetExhausted` is set or all windows are past, the stream continues to EOF (lines are skipped but `totalLines` keeps counting). The `totalLines` variable is counted but never used in the output — it's a wasted traversal. The stream could be destroyed early.

4. **No file size pre-check** — the full-file path reads the entire file into memory before checking if it exceeds `maxChars`. A 500MB binary file would be fully loaded as a UTF-8 string before truncation kicks in. The windowed path uses streaming but still reads to EOF.

5. **`compression` parameter does not compose with windowed reads** — compression is architecturally useful for large file reads, but the windowed path ignores it silently. A caller requesting compression on a ranged read gets no indication that compression was skipped.

6. **`truncateToBudget` edge case with all-newline content** — if a file contains only newline characters, `truncateToBudget` returns `{ text: fullContent, truncated: true }`, causing a `[truncated]` marker to appear on output that is not actually truncated. This is a minor cosmetic bug.

7. **Line-number format inconsistency between paths** — the windowed path formats as `lineNum:lineContent` and the full-file path formats as `lineNum:lineContent` — both are consistent. However, the windowed path uses `---` separators between non-contiguous blocks, while the full-file path does not use any separator. This is by design but the behavioral difference is implicit, not documented.

8. **No `showLineNumbers` parameter** — unlike `read_multiple_files` which has `showLineNumbers`, `read_file` always includes line numbers with no way to disable them. The schema description does not mention that line numbers are always present.

9. **`exported: false` hardcoded in compression** — the compression pipeline scores symbol blocks by priority, with exported symbols getting a boost (priority 300 vs 200). But `compressTextFile` always sets `exported: false` for all blocks, meaning the export signal is never provided. The `exportedSymbols` in `CompressionContext` is also never populated. This reduces compression quality for files with mixed exported/internal symbols.

10. **Compression's call-graph enrichment requires prior indexing** — `getFileBlockEdges` queries the symbol-index DB for call edges, but the DB is only populated by prior `indexDirectory()` or `indexFile()` calls (typically from `search_files structural` or `refactor_batch`). If the file hasn't been indexed, the DB query returns no edges, and compression proceeds without graph context. There is no on-demand indexing in the `read_file` compression path.

11. **Source map comment at bottom of file** — line 138 contains `//# sourceMappingURL=read_file.js.map` which suggests the source file may have been copied or generated from a compiled output. This is unusual for a source `.ts` file.
