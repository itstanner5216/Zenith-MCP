# `read_file` — Current Implementation Breakdown

> **Purpose:** Reference document for understanding and redesigning `read_file`.
> Documents what the tool currently does in exhaustive detail, tracing through all helpers and code paths, so the intended behavior can be redesigned from an accurate baseline.

---

## Source

**Tool file:** `packages/zenith-mcp/src/tools/read_file.ts`

**Key dependencies:**
- `core/lib.ts` — `readFileContent()`, `FilesystemContext`
- `core/compression.ts` — `compressForTool()` (thin pipe to `zenith-toon`'s `compressFile()`)
- `core/shared.ts` — `getCharBudget()`
- `zenith-toon` package — `compressFile()`

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
   - When a line falls within a window, format it as `lineNum. lineContent`
   - Advance to the next window when `totalLines > currentWindow.endLine`
   - Insert `---` separator between non-contiguous collected regions (gap > 1 line)
   - Track character count; when `charCount + formatted.length + 1 > maxChars`, set `budgetExhausted = true` and stop collecting (but the stream continues to EOF to count total lines)
8. Join output lines with `\n`
9. If budget was exhausted, append `\n[truncated]` to the output
10. Return result as `{ content: [{ type: "text", text }] }`

**Key details:**
- Uses **streaming I/O** (`createReadStream`) — does not load the entire file into memory
- `aroundLine` and `ranges` can be combined in one call; all windows are merged
- Line numbers are 1-indexed in the output format `lineNum. content`
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
4. **Line numbering:** Split content by `\n`, remove trailing empty line if present, then prefix each line with `lineNumber. ` (1-indexed, dot-space) and rejoin with `\n`. This is the single authority for line-number placement — nothing downstream recomputes or re-prefixes.
5. **Compression** (only if `args.compression` is truthy AND `content.length <= maxChars * 4`):
   - Call `compressForTool(validPath, content, maxChars)` — a thin pipe to `zenith-toon`'s `compressFile()`
   - `compressForTool` strips the `N. ` prefix to index the real code against the symbol-index DB, then hands the prefixed text to `compressFile` with facts from `getFileFacts()` (DB-backed: defs, references, edges, referenceEdges, anchors, imports, importBindings, injections, scopes). All compression decisions belong to TOON — MCP only supplies raw facts.
   - If compression returns a non-null result, replace `content` with the compressed text and return immediately (no `[truncated]` appended — TOON owns the output).
   - If compression returns null (TOON decides it's not useful), fall through to truncation.
6. **Truncation:** If `content.length > maxChars`:
   - Find the last `\n` before `maxChars` via `content.lastIndexOf('\n', maxChars)`. If none, cut at `maxChars`.
   - Replace `content` with `content.slice(0, cutoff)`.
   - Set `truncated = true`.
7. If `truncated` is true, append `\n[truncated]` to the final text
8. Return result as `{ content: [{ type: "text", text }] }`

**Key details:**
- Reads the **entire file into memory** — no streaming
- Line numbering with `N. ` (dot-space) format happens BEFORE compression and truncation — it is the canonical text
- Compression is only attempted when `content.length <= maxChars * 4` (transport/IO bound) — beyond this, the truncation fallback applies directly
- When compression succeeds, TOON's output is emitted verbatim with no additional `[truncated]` suffix
- The `[truncated]` marker is appended only when the inline truncation path runs
- Trailing empty line removal: the code checks `if (srcLines[srcLines.length - 1] === '') srcLines.pop()` — this removes exactly one trailing empty line resulting from a file that ends with `\n`

---

## `compressForTool()` — Detailed Behavior

**Source:** `core/compression.ts` (lines 33–100)

**Signature:** `compressForTool(validPath: string, prefixedSource: string, maxChars: number): Promise<string | null>`

**Returns:** Compressed string, or `null` when compression is not useful.

**Process:**

1. If `maxChars <= 0` or `prefixedSource.length <= maxChars` → return `null` (compression not needed).
2. Detect language via `getLangForFile(validPath)`.
3. Locate repo root via `findRepoRoot(validPath)`. Compute `relPath` (repo-relative) or fall back to basename.
4. If a repo root is found, open the symbol-index DB and call `ensureFreshFromContent()` to content-address the file (on-demand indexing). Then query `getFileFacts(db, relPath)` from `db-adapter.ts`, which returns:
   - `defs` — from `symbols` table: name, type, line, endLine, visibility, captureTag
   - `references` — from `symbols` table: name, type, line, endLine, column
   - `edges` — intra-file call edges (JOIN on `callee_symbol_id`, grouped by caller/callee identity)
   - `referenceEdges` — intra-file reference edges (grouped by caller identity + referenced name)
   - `anchors` — from `anchors` table joined with `symbols`
   - `imports` / `importBindings` — from `imports` / `import_bindings` tables
   - `injections` — from `injections` table
   - `scopes` — from `local_scopes` table joined with `symbols`
   DB errors are silently caught — the facts payload degrades to empty arrays and TOON still compresses via its text path.
5. Call `compressFile({ source: prefixedSource, maxChars, facts })` from `zenith-toon`.
6. Return the compressed string (or `null`).

**Key details:**
- The MCP layer owns facts-gathering (DB queries); TOON owns every compression decision (budgeting, ranking, keep-ratio, truncation markers, usefulness gate).
- The `N. ` prefix is stripped only for indexing the real code — TOON receives and emits the prefixed text.
- On-demand indexing (`ensureFreshFromContent`) means compression works even for files that haven't been previously indexed by `search_files` or `refactor_batch`.
- `getFileFacts` provides resolved edges (callee lines from `callee_symbol_id` JOIN).

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
lineNum. lineContent
lineNum. lineContent
---
lineNum. lineContent
[truncated]
```

**Full-file path output:**
```
1. first line of file
2. second line of file
...
N. last line of file
[truncated]
```

**Compressed full-file output:**
The compression engine produces its own format with `[TRUNCATED: lines X-Y]` markers, `# ...` omission markers, etc., depending on the content type. The line-numbered input is fed to compression, so compressed output contains pre-numbered lines.

**Key details:**
- Line numbers are always 1-indexed
- The delimiter between line number and content is `. ` (dot-space)
- Both paths use `\n` as the line separator
- The `---` separator only appears in windowed output between non-contiguous blocks
- The `[truncated]` marker only appears when the budget was exceeded (full-file path) or `budgetExhausted` was set (windowed path). When compression succeeds, no `[truncated]` is appended — TOON owns the output.

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
- Line numbering with `N. ` prefix happens BEFORE the truncation check
- Truncation uses inline `content.lastIndexOf('\n', maxChars)` on the already-numbered content, then `content.slice(0, cutoff)`
- The number-prefix expansion is counted against the budget (unlike the old two-pass approach)

**Full-file path (with compression):**
- Same `maxChars` passed to `compressForTool` → `compressFile`
- All budgeting decisions are owned by TOON
- Compression is only attempted when `content.length <= maxChars * 4` (transport bound)

---

## Params That Don't Do What They Suggest

1. **`maxChars` described as "Up to 400K"** — the actual upper bound is `getCharBudget()`, which defaults to `400_000` but is configurable up to `2_000_000`. The schema description is misleading for custom configurations.

2. **`compression` in windowed reads** — accepted in the schema and never validated, but completely ignored when `aroundLine` or `ranges` is provided. No error or warning is returned.

3. **`context` without `aroundLine`** — the schema describes it as "Window radius. Default 30." but it has no effect whatsoever unless `aroundLine` is also provided. It does not affect `ranges` behavior.

4. **`maxChars` in full-file path** — truncation now operates on the already-numbered content (line numbers are prepended before the truncation check), so the budget is respected more faithfully than in the old two-pass approach. The `N. ` prefix characters do count against the budget.

5. **`ranges[].endLine`** — described as an explicit line range but has no upper-bound clamping. Values of `endLine: 999999999` are silently handled (the stream just reads to EOF). This is benign but the schema suggests it should be a real line number.

---

## Known Issues / Smells

1. **Line numbering budget inclusion** — line numbering (`N. ` prefix) is prepended before the truncation check, so the prefix characters count against `maxChars`. This is an improvement over the old two-pass approach but means smaller effective payload for files with many short lines.

2. **Compression vs truncation ordering** — compression is attempted first (when content ≤ `4× maxChars`). If compression succeeds, TOON's output is emitted verbatim and the truncation path is skipped. If compression returns null, the file is truncated. This ordering is correct but means files between `maxChars` and `4× maxChars` always incur the compression attempt cost even when truncation would suffice.

3. **Streaming reader still reads to EOF** — in the windowed path, when `budgetExhausted` is set or all windows are past, the stream continues to EOF (lines are skipped but `totalLines` keeps counting). The `totalLines` variable is counted but never used in the output — it's a wasted traversal. The stream could be destroyed early.

4. **No file size pre-check** — the full-file path reads the entire file into memory before checking if it exceeds `maxChars`. A 500MB binary file would be fully loaded as a UTF-8 string before truncation kicks in. The windowed path uses streaming but still reads to EOF.

5. **`compression` parameter does not compose with windowed reads** — compression is architecturally useful for large file reads, but the windowed path ignores it silently. A caller requesting compression on a ranged read gets no indication that compression was skipped.

6. **Truncation on already-numbered lines may cut mid-prefix** — the inline `content.lastIndexOf('\n', maxChars)` truncation operates on the `N. `-prefixed text. If `maxChars` falls inside a line-number prefix (e.g., `123. co`), the truncation will cut at the `\n` before it, losing that partial line. This is correct behavior (line-boundary truncation) but means the effective char count may be noticeably lower than `maxChars` for files with long lines.

7. **Line-number format inconsistency between paths** — the windowed path formats as `lineNum:lineContent` and the full-file path formats as `lineNum:lineContent` — both are consistent. However, the windowed path uses `---` separators between non-contiguous blocks, while the full-file path does not use any separator. This is by design but the behavioral difference is implicit, not documented.

8. **No `showLineNumbers` parameter** — unlike `read_multiple_files` which has `showLineNumbers`, `read_file` always includes line numbers with no way to disable them. The schema description does not mention that line numbers are always present.

9. **Visibility and captureTag are forwarded from DB** — the current `getFileFacts` pipe forwards `visibility` and `captureTag` from the `symbols` table (populated by the background indexer). TOON receives these signals; whether it uses them for prioritization is a TOON decision. The old `exported: false` hardcode is gone.

10. **Compression does on-demand indexing** — `compressForTool` calls `ensureFreshFromContent()` before querying `getFileFacts`, so the file is indexed on demand if it isn't already in the symbol-index DB. This means compression works even for files never touched by `search_files` or `refactor_batch`. However, if the repo root is outside a git repo or the DB can't be opened, the facts payload degrades to empty arrays and TOON compresses via its text-only path.

11. **Source map comment at bottom of file** — line 138 contains `//# sourceMappingURL=read_file.js.map` which suggests the source file may have been copied or generated from a compiled output. This is unusual for a source `.ts` file.
