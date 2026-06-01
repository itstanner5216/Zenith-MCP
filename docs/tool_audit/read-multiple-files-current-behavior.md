# `read_multiple_files` — Current Implementation Breakdown

> **Purpose:** Reference document for refactoring `read_multiple_files`.
> Documents what the tool currently does in exhaustive detail so the intended behavior can be redesigned from an accurate baseline.

---

## Overview

**Source:** `packages/zenith-mcp/src/tools/read_multiple_files.ts`

**Purpose:** Read up to 50 text files in a single call, with per-file budget balancing, optional compression, line numbering, and truncation. Returns all results concatenated into a single text response.

**Annotations:** `readOnlyHint: true`

**Key dependencies:**
- `getCharBudget()` from `core/shared.ts` — global character budget from config
- `truncateToBudget()` from `core/compression.ts` — line-boundary-aware truncation
- `compressTextFile()` from `core/compression.ts` — tree-sitter-aware TOON compression
- `ctx.validatePath()` from `core/lib.ts` — path expansion/resolution/validation

---

## Schema

```
paths: string[] (required, min 1, max 50)
    File paths to read.

maxCharsPerFile?: number (optional, no default, no min/max validation)
    Max characters per file. When provided, all files share the same fixed budget.
    When omitted, budgets are dynamically allocated per file based on file size.

compression?: boolean (optional, default: true via Zod .default(true))
    Compress file-read output. Enables TOON compression pipeline.
```

**Note:** This is a flat schema with no mode enum. All three fields are always relevant.

---

## Internal Types

```typescript
interface FileInfoValid {
    requestedPath: string;   // Original path from args
    validPath: string;       // Resolved/validated path
    size: number;            // File size in bytes from stat
    error: null;
    budget?: number;         // Per-file character budget (set in Phase 2)
}

interface FileInfoError {
    requestedPath: string;
    validPath: null;
    size: number;            // Always 0 for errors
    error: string;           // Error message string
    budget?: number;
}

type FileInfo = FileInfoValid | FileInfoError;
```

---

## Concurrency Limiter: `parallelMap()`

A custom concurrency-limited parallel mapper is defined inline in the module:

```typescript
async function parallelMap<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    concurrency = 8
): Promise<R[]>
```

- **Default concurrency:** 8
- Creates `min(concurrency, items.length)` workers
- Each worker pulls from a shared `nextIndex` counter (non-atomic but safe in single-threaded JS)
- Preserves input order in results array
- Throws if `items[i]` is `undefined` — explicit invariant check
- Used in both Phase 1 (validation) and Phase 3 (reading)

---

## Execution Flow

### Phase 1: Path Validation and Sizing

1. Record `fileCount = args.paths.length`
2. For each path in `args.paths` (parallel, concurrency 8):
   - Call `ctx.validatePath(filePath)` to expand `~`, resolve to absolute, resolve symlinks
   - Call `fs.stat(validPath)` to get file size
   - On success: produce `FileInfoValid` with `requestedPath`, `validPath`, `size`, `error: null`
   - On failure (any error from validate or stat): produce `FileInfoError` with `requestedPath`, `validPath: null`, `size: 0`, and the error message string
3. Errors do **not** abort the operation — failed files are captured and reported inline in the output

**Key details:**
- `validatePath()` is not a sandbox check — Zenith intentionally does not sandbox. It resolves paths (tilde expansion, symlink resolution) and validates parent existence
- Both path validation and stat are done in one parallel pass
- There is no sensitive-file filter — unlike search tools, `read_multiple_files` does not call `isSensitive()`

---

### Phase 2: Budget Calculation

4. Filter `fileInfos` to get `validFiles` (those with `error === null`)
5. Compute global budget: `totalBudget = getCharBudget() - (fileCount * 200)`
   - The `200` per-file overhead deduction accounts for per-file labels and formatting
   - `getCharBudget()` reads `advanced.char_budget` from config, validated range 10,000–2,000,000, default 400,000

**Branch A — User-specified `maxCharsPerFile`:**

6. `perFileBudget = Math.min(args.maxCharsPerFile, totalBudget)`
   - All files get the same budget
   - The budget is capped at `totalBudget`, meaning a user-specified value can be reduced
   - **Subtle:** the cap is `totalBudget` (the entire pool), not `totalBudget / fileCount`. A single file could consume the entire budget if `maxCharsPerFile` is large enough

**Branch B — Dynamic budget allocation (no `maxCharsPerFile`):**

6. Sort valid files by size ascending (smallest first)
7. Iterate through sorted files, distributing budget greedily:
   - `share = Math.floor(remainingBudget / remainingFiles)` — equal split of what's left
   - `needed = Math.min(Math.ceil(file.size * 1.15), share)` — the smaller of 115% of file size or the equal share
   - Assign `needed` as the file's budget
   - Subtract `needed` from `remainingBudget`, decrement `remainingFiles`
8. Set `perFileBudget = null` (signals per-file mode)
9. Apply budgets back to `fileInfos`: look up each valid file's budget from the map, fallback to `Math.floor(totalBudget / fileCount)` if not found

**Key details:**
- The 1.15× multiplier on file size accounts for line-number prefix expansion (each line gains `N:` prefix characters)
- Smallest files are allocated first, so they take only what they need and leave surplus for larger files
- The budget map uses `requestedPath` as the key, not `validPath` — this could cause mismatches if two different requested paths resolve to the same valid path (though this edge case is unlikely)
- Error files get no budget assignment in the dynamic path (their `error !== null` so the `forEach` check skips them)
- The fallback `Math.floor(totalBudget / fileCount)` divides by total `fileCount` (including error files), not `validFiles.length`

---

### Phase 3: File Reading

10. For each file in `fileInfos` (parallel, concurrency 8):
    - Compute `displayPath`: use `validPath` if available, else `requestedPath`
    - Create `fileLabel = "- " + path.basename(displayPath)` — just the filename, not the full path

**Error case:**

11. If `fileInfo.error !== null`: return `"- filename\nERROR: error message"`

**Success case:**

12. Determine the effective budget for this file:
    - If `perFileBudget !== null` (user specified): use `perFileBudget`
    - Else: use `fileInfo.budget`, fallback to `Math.floor(totalBudget / fileCount)`
13. Compute `entryPrefix = fileLabel + "\n"`
14. **Read the file with byte limit:**
    - `byteLimit = budget * 4` — assumes worst-case 4 bytes per character (UTF-8 max)
    - Open file with `fs.open(validPath, 'r')`
    - Allocate `Buffer.allocUnsafe(byteLimit)` — uninitialized for performance
    - Read up to `byteLimit` bytes from offset 0
    - Convert the read bytes to UTF-8 string
    - Close the file descriptor in a `finally` block
15. **Apply budget truncation:**
    - `effectiveBudget = Math.max(0, budget - entryPrefix.length)` — reserves space for the label
    - Call `truncateToBudget(content, effectiveBudget)` which:
      - Returns the string unchanged if `length <= budget` (but flags `truncated: true` if the content is all-whitespace)
      - Otherwise finds the last newline at or before `budget` chars and cuts there
      - If no newline found within budget, cuts at exactly `budget` chars
    - Update `content` and `truncated` flag from the result
16. **Add line numbers:**
    - Split content by `\n`
    - Remove trailing empty line if present (artifact of files ending with newline)
    - Map each line to `"lineNum:content"` format (1-indexed)
    - Join back with `\n`
17. **Attempt compression** (if `args.compression !== false`, which is the default):
    - Call `compressTextFile(validPath, content, effectiveBudget)`
    - This function:
      1. Computes `targetBudget = computeCompressionBudget(rawText.length, maxChars, 0.70)`
         - `ratioBudget = max(1, floor(rawText.length * 0.70))`
         - Returns `min(maxChars, ratioBudget)`
      2. Returns `null` if `targetBudget <= 0` or `targetBudget >= rawText.length` (no compression needed)
      3. Detects language via `getLangForFile()` using the file extension
      4. If language is supported: parses symbols with tree-sitter, builds `StructureBlock[]`, queries symbol-index for call-graph edges, calls `compressSourceStructured()`
      5. Falls back to `compressString()` (unstructured compression) if tree-sitter fails or language is unsupported
      6. Validates result with `isCompressionUseful()`:
         - Returns `false` if compressed is null, empty, or raw text is empty
         - Returns `false` if raw text length exactly equals the bounded max chars
         - Returns `false` if target budget is 0 or >= raw text length
         - Requires: `compressedLength < rawLength AND compressedLength <= targetBudget AND compressedLength < maxChars`
      7. Returns the compressed text or `null` if compression wasn't useful
    - If compression returns non-null: replace `content` with the compressed text
18. **Format the final entry:**
    - If truncated: `"- filename\ncontent\n[truncated]"`
    - If not: `"- filename\ncontent"`

**On read error (Phase 3 catch block):**

19. Return `"- filename\nERROR: error message"` — identical format to validation errors

---

### Phase 4: Final Assembly

20. Join all file results with `"\n\n"` (double newline separator)
21. Apply final global budget check:
    - If total text length exceeds `getCharBudget()`: hard-slice at `getCharBudget()` chars and append `"\n[truncated]"`
    - This is a raw `text.slice()`, NOT a line-boundary-aware truncation
22. Return single `{ content: [{ type: "text", text: finalText }] }`

---

## Budget Flow Summary

```
getCharBudget() (config, default 400,000)
    └── totalBudget = charBudget - (fileCount * 200)
        ├── [if maxCharsPerFile] → perFileBudget = min(maxCharsPerFile, totalBudget)
        │       └── effectiveBudget = max(0, perFileBudget - entryPrefix.length)
        └── [if no maxCharsPerFile] → dynamic per-file budgets (greedy allocation)
                └── effectiveBudget = max(0, fileInfo.budget - entryPrefix.length)
                    ├── truncateToBudget(content, effectiveBudget)
                    └── compressTextFile(validPath, content, effectiveBudget)
                        └── targetBudget = min(effectiveBudget, floor(content.length * 0.70))

Final: if total output > getCharBudget() → hard slice
```

---

## Hardcoded Constants

| Constant | Value | Location | Purpose |
|---|---|---|---|
| Max paths | 50 | Zod schema `.max(50)` | Array size limit |
| Min paths | 1 | Zod schema `.min(1)` | Array must be non-empty |
| Per-file overhead | 200 chars | Phase 2, line 89 | Budget deduction for labels/formatting |
| Parallelism limit | 8 | `parallelMap()` default | Max concurrent file operations |
| Size inflation factor | 1.15 (115%) | Phase 2, line 101 | Accounts for line-number prefix expansion |
| Byte-to-char ratio | 4 | Phase 3, line 124 | UTF-8 worst-case bytes per char |
| Compression keep ratio | 0.70 (70%) | `DEFAULT_COMPRESSION_KEEP_RATIO` | Target compression ratio |
| Compression default | `true` | Zod schema `.default(true)` | Compression enabled by default |
| `getCharBudget()` default | 400,000 | `shared.ts` / `schema.ts` | Global character budget |
| `getCharBudget()` valid range | 10,000–2,000,000 | `shared.ts` line 22 | Config validation range |

---

## Output Format

The tool produces a single text block with all files concatenated:

```
- filename1.ts
1:first line of content
2:second line of content
3:third line

- filename2.ts
1:first line
2:second line
[truncated]

- filename3.ts
ERROR: ENOENT: no such file or directory
```

**Format rules:**
- Each file starts with `- basename` (just the filename, no directory path)
- Content lines are prefixed with 1-indexed line numbers: `N:content`
- Files are separated by `\n\n` (double newline)
- `[truncated]` appears after the content of files that exceeded their budget
- Failed files show `ERROR: message` instead of content
- No metadata, no file sizes, no paths beyond the basename

---

## Comparison with `read_file`

| Aspect | `read_file` | `read_multiple_files` |
|---|---|---|
| File count | 1 | 1–50 |
| Budget source | `min(maxChars ?? 50000, getCharBudget())` | Dynamic allocation or fixed per-file |
| Default max chars | 50,000 | Entire `getCharBudget()` minus overhead, split among files |
| Windowed reading | `aroundLine`, `ranges`, `context` | Not supported |
| Line numbers | Always added (`N:content`) | Always added (`N:content`) |
| Compression | Opt-in (`args.compression` checked truthily) | Opt-out (default `true`, checked `!== false`) |
| Truncation | `truncateToBudget()` | `truncateToBudget()` per file + raw `slice()` final |
| File label | None | `- basename` prefix per file |
| Error handling | Throws | Inline per-file `ERROR:` messages |
| Byte-limited read | No (reads entire file via `readFileContent`) | Yes (`fs.open` + `Buffer.allocUnsafe(budget * 4)`) |

---

## Params That Don't Do What They Suggest

1. **`maxCharsPerFile` is capped at `totalBudget`, not at `totalBudget / fileCount`** — If a user sets `maxCharsPerFile: 100000` with 10 files and a 400K budget, the actual per-file budget is `min(100000, 400000 - 2000) = 100000`. But the total possible output across all files is 1,000,000, which exceeds `getCharBudget()`. The final hard-slice at `getCharBudget()` saves this, but files at the end of the results array will be silently truncated mid-content without a `[truncated]` marker.

2. **`compression` default `true` is set in the Zod schema** — But the runtime check is `args.compression !== false` (line 146), meaning `undefined` also passes. This means compression is always active unless the caller explicitly passes `false`. The Zod `.default(true)` is technically redundant since the `!== false` check already handles the `undefined` case, but they produce the same behavior.

3. **File labels use `basename` only** — The `displayPath` variable is computed as `validPath` or `requestedPath`, but only `path.basename(displayPath)` is used in the label. If two files have the same filename in different directories, their labels will be identical and indistinguishable in the output. The full path is never shown.

4. **`maxCharsPerFile` has no schema-level min/max validation** — Unlike `read_file`'s `maxChars` which has an implicit cap at `getCharBudget()`, `maxCharsPerFile` is only constrained at runtime by `Math.min(args.maxCharsPerFile, totalBudget)`. Values of 0 or negative numbers are accepted by the schema and would produce `effectiveBudget = max(0, negative - prefix)` = 0, effectively returning just the file label.

---

## Known Issues / Smells

1. **Dynamic budget allocation uses `requestedPath` as the map key** — The budget map in Phase 2 is keyed by `requestedPath`, but the same file could appear under different requested paths (e.g., with and without trailing slash, absolute vs relative). If `requestedPath` doesn't match the map key exactly, the fallback `Math.floor(totalBudget / fileCount)` kicks in, which divides by total file count including error files rather than valid file count.

2. **`Buffer.allocUnsafe()` is used for file reading** — While this is safe because the buffer is immediately overwritten by `fd.read()` and only `bytesRead` bytes are used, `allocUnsafe` leaves uninitialized memory in the buffer. If `bytesRead` were incorrectly used, stale memory could leak into the output. The performance benefit over `Buffer.alloc()` is minimal for this use case.

3. **`truncateToBudget()` has unusual behavior for whitespace-only content** — If `text.length <= budget` but the text is entirely newlines (no non-newline characters), `truncated` is set to `true`. This means a small whitespace-only file that fits within budget would still get a `[truncated]` marker, which is misleading.

4. **Line numbers are added BEFORE compression** — Content is line-numbered (`1:content`, `2:content`, etc.) and then passed to the compression pipeline. The compression engine operates on the line-numbered text, not the raw source. This means:
   - Tree-sitter parsing inside `compressTextFile()` receives line-numbered content, which may confuse language detection or AST parsing
   - The compression budget calculation uses the length of the line-numbered text as `rawLength`
   - However, `compressTextFile()` uses the `validPath` for language detection via extension, so tree-sitter grammar selection is not affected — only the actual parsing of the content may be affected by the line-number prefixes

5. **The final global truncation is a raw `text.slice()`, not line-boundary-aware** — While per-file truncation uses `truncateToBudget()` which cuts at newline boundaries, the final safety truncation at `getCharBudget()` does a raw `text.slice()` that can cut mid-line or even mid-UTF-8 character sequence (though the content is already a JS string at this point, so mid-character is not possible).

6. **No deduplication of requested paths** — If the same path appears multiple times in the `paths` array, it will be validated, read, and returned multiple times, consuming budget for each duplicate.

7. **Error files consume format overhead but no budget allocation** — In dynamic budget mode, the `totalBudget` deducts `200 * fileCount` for ALL files including ones that fail validation, but the greedy allocation only iterates over `validFiles`. This means the overhead deduction for error files is "wasted" — it reduces the pool available to valid files without being used.

8. **Compression is attempted even when truncation already occurred** — After `truncateToBudget()` cuts the content, the truncated content is then passed to `compressTextFile()`. The compression target budget is computed from the truncated text length, not the original. Since the text is already at or under `effectiveBudget`, the compression check `targetBudget >= rawText.length` (where `rawText.length <= effectiveBudget`) may frequently return `null` because `targetBudget = min(effectiveBudget, floor(truncatedLength * 0.70))` — for the compression to activate, the truncated text must be longer than `effectiveBudget` (which it can't be, since truncation already cut it to fit). This means **compression only activates for files that were NOT truncated** — i.e., files smaller than their budget.

9. **Line numbers are unconditional by design** — `read_multiple_files` does not expose a `showLineNumbers` parameter. Every file body is line-numbered by default so multi-file reads are immediately citeable and patchable.

10. **Source map comment at end of file** — Line 171 contains `//# sourceMappingURL=read_multiple_files.js.map`, which suggests this file may have been copied from or generated alongside a compiled output at some point.
