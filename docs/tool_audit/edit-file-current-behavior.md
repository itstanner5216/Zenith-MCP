# `edit_file` — Current Implementation Breakdown

> **Purpose:** Reference document for understanding and redesigning `edit_file`.
> Documents what the tool currently does in exhaustive detail, tracing through all helpers and code paths, so the intended behavior can be redesigned from an accurate baseline.

---

## Source

**Tool file:** `packages/zenith-mcp/src/tools/edit_file.ts`

**Key dependencies:**
- `core/lib.ts` — `normalizeLineEndings()`, `createMinimalDiff()`
- `core/edit-engine.ts` — `applyEditList()`, `syntaxWarn()`, `findMatch()` and the three match strategies
- `core/stash.ts` — `stashEdits()`
- `core/tree-sitter.ts` — `getLangForFile()`, `findSymbol()`, `checkSyntaxErrors()`
- `core/symbol-index.ts` — `getDb()`, `snapshotSymbol()`, `getSessionId()`
- `core/project-context.ts` — `getProjectContext()`
- `node:fs/promises` — `readFile`, `writeFile`, `rename`, `unlink`
- `node:crypto` — `randomBytes()`

---

## Schema

```
path: string (required) — "File to edit."
edits: Array<EditOperation> (required)
dryRun: boolean (default: false) — "Preview without writing."

EditOperation = {
  mode: "block" | "content" | "symbol" (required)
  // block mode:
  block_start?: string         "First line of block."
  block_end?: string           "Last line of block."
  replacement_block?: string   "Replacement text."
  // content mode:
  oldContent?: string          "Text to find."
  newContent?: string          "Replacement text."
  // symbol mode:
  symbol?: string              "Symbol name."
  newText?: string             "Replacement text."
  // shared:
  nearLine?: number            "Approx line number."
}
```

**Annotations:** `readOnlyHint: false`, `idempotentHint: false`, `destructiveHint: true`.

**No top-level mode** — the discriminator is `edits[i].mode`. Every entry in the array can use a different mode.

The schema does NOT enforce per-mode required fields with Zod — every per-mode field is `.optional()`. Validation that the right fields are present for the chosen mode happens at runtime inside `applyEditList`.

---

## Schema Field Details

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `path` | `string` | Yes | — | Passed through `ctx.validatePath()`; the file MUST exist (no `validateNewFilePath` here) |
| `edits` | `Array<EditOperation>` | Yes | — | No min/max length in Zod; `args.edits?.length === 0` is checked at runtime → throws `"No edits provided."` |
| `dryRun` | `boolean` | No | `false` | When true, returns a minimal unified diff and does NOT write |
| `edits[].mode` | `enum` | Yes | — | Must be exactly `"block"`, `"content"`, or `"symbol"` |
| `edits[].block_start/end/replacement_block` | `string` | "block" mode | — | All three required when mode is `"block"`; checked inside `applyEditList`; missing → per-edit error |
| `edits[].oldContent/newContent` | `string` | "content" mode | — | Both required when mode is `"content"`; non-null assertion (`!`) inside engine — missing produces a TypeScript-runtime undefined that is dereferenced |
| `edits[].symbol/newText` | `string` | "symbol" mode | — | Both required when mode is `"symbol"`; non-null assertion inside engine |
| `edits[].nearLine` | `number` | No | `undefined` | 1-indexed approximate line; used as a tiebreaker for ambiguous matches in all three modes |

---

## Top-Level Process

The handler executes a fixed sequence with no conditional branching at the top level. The branching all happens inside `applyEditList` (per edit, by mode).

```
1. Validate path (must exist)
2. Reject empty edits array
3. Read file as UTF-8 and normalize line endings (CRLF → LF)
4. Determine isBatch = edits.length > 1
5. Call applyEditList(originalContent, edits, { filePath, isBatch })
   → returns { workingContent, errors[], pendingSnapshots[] }
6. If errors.length > 0: stash the original edits + failed indices, throw
7. If dryRun: return createMinimalDiff(original, working, validPath)
8. Atomic write: temp file → rename
9. Best-effort symbol-version snapshots (only for "symbol" mode edits)
10. Run a syntax-error check via tree-sitter
11. Return "Applied." plus optional parse-error suffix
```

---

## Step-by-Step Process

### 1. Path Validation

`ctx.validatePath()` is the existing-file variant (resolves `~`, makes absolute, runs `realpath`). If the file doesn't exist, the path returned is the non-resolved absolute path (parent must exist), but step 3 (`fs.readFile`) will then fail with `ENOENT`. There is no friendly "file does not exist" message — the raw filesystem error propagates.

There is **no allowed-directory sandbox check**.

### 2. Empty-Edits Guard

`if (!args.edits?.length) throw new Error('No edits provided.')`.

The Zod schema requires `edits` to be an array but does NOT enforce a minimum length, so this runtime guard is the only check. An empty array reaches the handler and is rejected before any I/O.

### 3. Read + Line-Ending Normalization

`fs.readFile(validPath, 'utf-8')` reads the entire file into memory; no streaming, no size guard. The result is run through `normalizeLineEndings()` which only converts `\r\n` to `\n` (lone `\r` is left alone — see `write_file` audit for the same caveat).

### 4. Batch Flag

`isBatch = args.edits.length > 1`. This flag is forwarded into `applyEditList`, which uses it only to prefix per-edit diagnostics with `#N: ` (e.g., `"#2: oldContent not found."`). When there is a single edit, the prefix is empty.

### 5. `applyEditList()` — Core Engine

**Source:** `core/edit-engine.ts` (lines 196–376)

A pure, in-memory function. No I/O. Walks `edits[]` and, for each edit, branches on `edit.mode` to perform the corresponding mutation against a `workingContent` string. Errors are collected into an `errors[]` array — they do NOT abort the loop.

This is critical: **a failing edit does not stop subsequent edits from being attempted against the partially-updated content**. Each successful edit mutates `workingContent`, and the next edit runs against the new state. A failing edit leaves `workingContent` unchanged at that step but the loop continues.

#### Block Mode (`edit.mode === 'block'`)

1. Required-field check: all of `block_start`, `block_end`, `replacement_block` must be set; missing → error `"<tag>block mode requires block_start, block_end, and replacement_block."` (where `<tag>` is `#N: ` for batch, empty for single)
2. Split `workingContent` by `\n` into `lines`
3. Multi-line anchor support:
   - Split `block_start` and `block_end` by `\n`
   - Anchor lines: `anchorStart = startInputLines[0].trim()`, `anchorEnd = endInputLines[last].trim()`
   - Verification lines: any non-empty trimmed lines from `block_start[1:]` and `block_end[:-1]` must appear **in order** somewhere within the candidate range
4. Find candidates: for each `s` where `lines[s].trim() === anchorStart`, scan forward for `e ≥ s` where `lines[e].trim() === anchorEnd`. If verifyLines exist, scan `[s+1, e)` for them in order. First successful `e` is taken; the search for `e` then breaks (only the first end-anchor per start is used)
5. Resolve which candidate to use:
   - 0 candidates → error `"<tag>block_start not found in file."`
   - 1 candidate → use it
   - >1 candidates:
     - If `disambiguations.get(i).startLine` is set (from stash retry): pick the candidate at exactly `startLine - 1`; missing → error `"<tag>no match at line <startLine>."`
     - Else if `nearLine` is set (from edit or disambiguation): sort candidates by `|c.start - (nearLine - 1)|` and pick the closest
     - Else → error `"<tag>Ambiguous: lines a-b, c-d, ... Provide startLine or nearLine."`
6. Replace lines `[chosen.start ... chosen.end]` (inclusive) with `splitLines(replacement_block)` via `Array.splice`
7. Rejoin with `\n` and continue

**Key details:**
- Anchor matching is whitespace-trimmed (`.trim()` on both sides)
- Verification lines are also trimmed; empty trimmed lines are skipped
- The block range is inclusive on both ends; `block_end` is consumed and replaced
- The replacement is split on `\n` so multi-line replacements work; if `replacement_block` is empty, `''.split('\n')` produces `['']` (a single empty line is inserted)

#### Symbol Mode (`edit.mode === 'symbol'`)

1. Determine `nearLine` from `disambiguations.get(i).nearLine` or `edit.nearLine`
2. `getLangForFile(filePath)` — extension-based language detection; `null` → error `"<tag>Unsupported file type."`
3. `findSymbol(workingContent, langName, edit.symbol, { kindFilter: 'def', nearLine? })` — tree-sitter symbol lookup with `kindFilter: 'def'` (only definitions, not references)
4. Three failure paths:
   - `findSymbol` returns `null` (grammar exists but no tags query for the language) → error `"<tag>Symbol queries not available for <lang> (grammar present, tags query missing). Use block or content mode instead."`
   - Empty array → error `"<tag>Symbol not found."`
   - Multiple matches AND `nearLine` not set → error `"<tag>Multiple matches. Use nearLine."`
5. `sym = symbolMatches[0]` (the closest to `nearLine` if provided, else the first match)
6. Slice the original lines from `sym.line - 1` to `sym.endLine` to capture `originalText` (used for snapshotting)
7. Replace those lines with `splitLines(newText)` via `Array.splice(sym.line - 1, sym.endLine - (sym.line - 1), ...newLines)`
8. Push a `pendingSnapshots` entry: `{ symbol, originalText, line: sym.line, filePath }`
9. Rejoin and continue

**Key details:**
- `kindFilter: 'def'` means only top-level/method/function definitions are matched — references to the symbol elsewhere in the file are not matched
- Dot-qualified names (e.g., `Class.method`) are supported by `findSymbol` natively
- The `originalText` capture happens BEFORE the splice, so the snapshot reflects the pre-edit body
- The snapshot is recorded in `pendingSnapshots` here but only persisted to the symbol-index DB later (after the file write succeeds)
- A symbol that spans 0 lines or has invalid `line/endLine` would still be spliced — there is no defensive check
- `splice(start, deleteCount, ...newItems)` with `deleteCount = sym.endLine - (sym.line - 1)` removes `endLine - line + 1` lines (inclusive), then inserts the new lines

#### Content Mode (`edit.mode === 'content'`)

1. Determine `nearLine` from disambiguations or edit
2. `findMatch(workingContent, edit.oldContent, nearLine)` runs three strategies in order:

   **Strategy 1 — Exact match:**
   - Normalize `oldContent` line endings
   - Find all occurrences of the needle via `findOccurrence` (uses `indexOf` in a loop)
   - With no `nearLine`: returns the first occurrence
   - With `nearLine`: computes the line number of each match and picks the one closest to `nearLine`

   **Strategy 2 — Trimmed trailing whitespace:**
   - Build `trimmedContent` and `trimmedOld` by `.trimEnd()` per line
   - Run `findOccurrence` on the trimmed strings
   - If found, map the trimmed index back to the original index via `mapTrimmedIndex` (line-and-column reconstruction)
   - Compute `endPos` by counting forward `oldLinesTrimmed.length` newlines via `findOriginalEnd`
   - Returns the original-content match span

   **Strategy 3 — Indentation-stripped match:**
   - Trim every line of both `content` and `oldContent` (full `.trim()`, not just trailing)
   - Search window is `[searchStart, searchEnd]`:
     - With `nearLine`: `[max(0, nearLine - 50), min(N, nearLine + 50)]` — a 100-line window around the hint
     - Without `nearLine`: the entire file
   - For each starting position `i`, verify `strippedOld.length` consecutive lines all match by `.trim()` equality
   - First match wins

3. If no strategy matches → error from `generateDiagnostic(...)`:
   - Searches for the first non-empty trimmed line of `oldContent` in the working content
   - If a partial line-substring match is found → `"<tag>oldContent not found. Near line N."`
   - If any other line of `oldContent` appears in the file → `"<tag>oldContent not found. Near line N."`
   - Else → `"<tag>oldContent not found."`
4. Apply the replacement:
   - For `'exact'` and `'trim-trailing'`: `workingContent = workingContent.slice(0, idx) + newContent + workingContent.slice(idx + matchedText.length)`
   - For `'indent-stripped'`: re-indent `newContent` to preserve the original indentation:
     - `originalIndent` = leading whitespace of the first matched line
     - `oldIndent` = leading whitespace of the first line of `oldContent`
     - For each new line beyond the first: compute `relIndent = lineIndent.length - oldIndent.length`, then prepend `originalIndent + ' '.repeat(max(0, relIndent))` and append `line.trimStart()`
     - The first new line gets `originalIndent + line.trimStart()`
     - Tabs vs spaces are NOT distinguished — `' '.repeat(N)` always uses spaces

**Key details:**
- The three strategies are tried in order; the first to find a match wins
- `nearLine` is a tiebreaker for strategies 1 and 2 (closest match) and a search-window restrictor for strategy 3
- Strategy 3 uses a fixed window of ±50 lines when `nearLine` is provided — this is hardcoded
- Indent-stripped re-indentation can change relative indentation if the new content has tabs and the matched indentation has spaces (or vice versa)
- If `oldContent` is an empty string, `findOccurrence` returns `0` (first match at index 0) — silently inserts `newContent` at the start of the file

### 6. Failure Path → Stash

If `errors.length > 0`:

1. Collect failed edit indices: `errors.map(e => e.i)`
2. `stashEdits(ctx, validPath, args.edits, failedIndices)` inserts a row into the stash SQLite DB with the **full original edits array** plus the indices that failed
3. Throw `"<N> failed. stash:<stashId>\n<concatenated error messages joined by \n>"`

**Key details:**
- The stashed payload includes ALL edits from the call, not just the failed ones — this lets `stashRestore apply` re-run the entire batch with corrections
- Successfully-applied edits in the same call are also stashed (they will re-run on retry)
- The error message contains every per-edit failure separated by `\n` — multi-failure cases produce multi-line errors
- No partial write occurs — even though the engine produces a `workingContent` reflecting all successful edits, the file is NOT written when any edit fails

### 7. Dry-Run Path

If `args.dryRun === true` AND `errors.length === 0`:

`createMinimalDiff(originalContent, workingContent, validPath)` produces a unified diff with `context: 0` (no surrounding context, only the changed hunks). The diff includes the file path twice (header convention for unified diffs) but with empty "label" strings at the top. No file write occurs. The snapshot recording (step 9) is also skipped.

### 8. Atomic Write

1. `tempPath = "${validPath}.${randomBytes(16).toString('hex')}.tmp"`
2. `fs.writeFile(tempPath, workingContent, 'utf-8')`
3. `fs.rename(tempPath, validPath)`
4. On failure: best-effort `fs.unlink(tempPath)`, then re-throw the original error

**Key differences from `write_file`:**
- No size verification step (`tempStat.size === Buffer.byteLength(...)`) — `edit_file` skips this
- No stash on write failure — the original error propagates as-is
- The error message is whatever Node throws (no friendlier wrapping)

### 9. Snapshot Recording (Symbol-mode edits only)

Only runs if `pendingSnapshots.length > 0` AND the write succeeded AND `dryRun` is false.

1. Get project context: `getProjectContext(ctx)`
2. Resolve repo root: `pc.getRoot(validPath) || path.dirname(validPath)` — fallback to file's parent dir
3. Open the symbol-index DB: `getDb(repoRoot)` (creates `.mcp/symbols.db` if missing)
4. Compute `sessionId = ctx.sessionId || getSessionId()` — uses the MCP session ID or generates a process-scoped one
5. Compute `relPath = path.relative(repoRoot, validPath)`
6. For each snapshot, call `snapshotSymbol(db, snap.symbol, relPath, snap.originalText, sessionId, snap.line)`:
   - Computes md5 hash of the original text
   - Inserts a `versions` row with `(symbol_name, file_path, text, session_id, created_at, line, text_hash)`

**Key details:**
- Wrapped in `try/catch` — any DB error is silently swallowed (snapshotting is best-effort)
- The snapshot stores the **pre-edit** body as `originalText`, so `refactor_batch restore/history` can roll back to it
- The session ID determines which `refactor_batch restore` calls can see the snapshot — sessions are isolated
- Snapshots only happen for `symbol` mode edits — `block` and `content` mode edits are not versioned, even if they overlap a symbol

### 10. Syntax Warning

`syntaxWarn(validPath, workingContent)`:

1. Extension extraction (lowercased)
2. Suppression list check: `.mdx`, `.jsonc`, `.json5`, `.jsonl`, `.ndjson` → return `''` immediately. These extensions point at strict grammars that reject the dialect's idiomatic syntax (`.geojson` and `.topojson` are NOT suppressed because they are strict JSON)
3. `getLangForFile()` — `null` → return `''`
4. `checkSyntaxErrors(content, langName)` — tree-sitter parse, collect ERROR nodes
5. If errors: return `"\nParse errors at lines <line:col>, <line:col>, ..."`
6. Any thrown exception during steps 1–5 → return `''` (silent failure)

The string is appended directly to `"Applied."`. No edits are reverted on syntax failure — the warning is informational only.

### 11. Success Response

```json
{ "content": [{ "type": "text", "text": "Applied.<warningOrEmpty>" }] }
```

Examples:
- `"Applied."`
- `"Applied.\nParse errors at lines 17:5, 42:1"`

For dry-run, the response is the unified diff text:
- `"Index: /abs/path/file.ts\n===...\n--- file.ts\n+++ file.ts\n@@ -10,1 +10,1 @@\n-old line\n+new line\n"`

---

## Output Format

| Scenario | Output |
|---|---|
| All edits applied successfully | `"Applied."` |
| Applied + syntax errors detected | `"Applied.\nParse errors at lines L:C, L:C, ..."` |
| Dry-run, all edits resolve | Unified diff with `context: 0` |
| Any edit fails | Throws `"<N> failed. stash:<id>\n<per-edit error 1>\n<per-edit error 2>..."` |
| File not found | Raw Node error from `fs.readFile` |
| Empty `edits` array | Throws `"No edits provided."` |
| Write/rename fails | Throws the raw Node error (no stash, no message wrap) |

---

## Match Strategy Comparison (content mode)

| Strategy | What it ignores | Search window | Re-indent on apply |
|---|---|---|---|
| Exact | Nothing | Whole file | No |
| Trim-trailing | Trailing whitespace per line | Whole file | No |
| Indent-stripped | All leading + trailing whitespace per line | `nearLine ± 50` lines if `nearLine` set, else whole file | Yes (preserves matched line's indent + relative indent of new content) |

The strategies are tried in order. The first to find at least one match wins. `nearLine` is used as a tiebreaker (strategies 1 and 2) or as a window restrictor (strategy 3).

---

## Disambiguation Map

The `disambiguations` parameter in `applyEditList` is a `Map<editIndex, { startLine?, nearLine? }>` that is populated by `stashRestore apply` when retrying a previously-failed edit batch. Direct callers of `edit_file` cannot pass it — only `nearLine` per-edit is exposed in the schema.

| Source | What it provides | Used by |
|---|---|---|
| `disambiguations.get(i).startLine` | Exact 1-indexed start line for block-mode candidate selection | Block mode only |
| `disambiguations.get(i).nearLine` | Approximate line for tiebreaker | All three modes |
| `edit.nearLine` | Same as above, but inline in the edit | All three modes |

The disambiguation map's `nearLine` overrides `edit.nearLine` when both are present.

---

## Hardcoded Constants

| Constant | Value | Location | Purpose |
|---|---|---|---|
| Indent-stripped search window | 50 lines | `findMatch` strategy 3 | Bounds the indent-stripped scan when `nearLine` is set |
| Temp suffix bytes | 16 | `randomBytes(16)` | Collision-resistant temp filename |
| Encoding | `'utf-8'` | `readFile` / `writeFile` | Always UTF-8 |
| Snapshot hash algo | `md5` | `snapshotSymbol` | Cheap fingerprint for version detection |
| Suppressed syntax extensions | `.mdx`, `.jsonc`, `.json5`, `.jsonl`, `.ndjson` | `syntaxWarn` | Skip parse-error reporting for non-strict dialects |

---

## Interaction Between Parameters

| `dryRun` | All edits resolve | Errors present | Behavior |
|---|---|---|---|
| `false` | yes | no | Write file, snapshot symbol edits, return `"Applied.<warning>"` |
| `true` | yes | no | No write, no snapshot, return minimal unified diff |
| `false` | partially | yes | No write, stash entire edits array, throw with stash ID + all error messages |
| `true` | partially | yes | No write, stash entire edits array, throw with stash ID + all error messages (dryRun is ignored when there are errors) |

**Key observation:** `dryRun` does NOT prevent stashing on failure — even a dry-run that fails creates a stash entry. There is no "preview-only, no side effects" mode.

---

## Params That Don't Do What They Suggest

1. **`dryRun: true` still creates a stash entry on failure** — the docstring says "Preview without writing", but the failure path runs unconditionally before the dryRun branch. A user expecting a no-side-effects preview will be surprised that retrying the same dryRun produces multiple stash rows.

2. **`edits[]` mode-specific fields are all marked `.optional()`** — the schema accepts an edit like `{ mode: "block" }` with no other fields. The runtime check inside `applyEditList` produces a per-edit error, but the schema allows it through. Schema-level validation could reject malformed edits before they reach the engine.

3. **`nearLine` semantics differ across modes** — in block mode it's a tiebreaker over multiple anchor matches; in content mode strategies 1 and 2 it's a tiebreaker; in content mode strategy 3 it's a search-window restrictor (±50 lines); in symbol mode it's both required-when-multiple-matches AND a tiebreaker for `findSymbol`'s internal ranking. Same parameter name, different effective behavior per mode.

4. **`block_start` / `block_end` accept multi-line input** — the schema describes them as "First line of block." and "Last line of block.", but the engine treats multi-line strings as anchor + verification lines. A user passing a multi-line `block_start` thinking it's a single-string anchor will get behavior they didn't expect (intermediate lines become verification predicates).

5. **`oldContent: ""` silently replaces nothing at index 0** — `findOccurrence("any", "", undefined)` returns `0`, so an empty `oldContent` matches at the start of the file and the engine inserts `newContent` at position 0. There is no schema-level guard against empty `oldContent`.

6. **`applyEditList` continues after a failed edit** — when one edit in a batch fails, subsequent edits still run against the partially-mutated `workingContent`. This means a later edit that depends on text inserted by an earlier failed edit will also fail, but a later edit independent of the failure may "succeed" against unexpected state. The atomicity guarantee is at the file level (no write on any error), not the edit level.

7. **No `path` echoed in success/failure responses** — the `Single-Target Rule` from AGENTS.md is honored. However, in batch error messages, individual edits are tagged with `#N: ` only when `isBatch` is true (more than one edit). A single failing edit gets no index prefix, which is mostly fine but inconsistent if a future change adds always-tagged messages.

---

## Known Issues / Smells

1. **`edits` field has no schema-level minimum** — Zod allows `edits: []` and the runtime check `if (!args.edits?.length)` is the only guard. If the schema were `z.array(...).min(1)`, the empty case would be rejected with a more standardized Zod error.

2. **Per-mode field requirements are enforced at runtime, not at schema time** — every mode-specific field is `.optional()`. A schema using a discriminated union (`z.discriminatedUnion('mode', [...])`) would catch missing fields at validation time and produce structured errors.

3. **Non-null assertions in the engine** — `applyEditList` uses `edit.oldContent!`, `edit.newContent!`, `edit.symbol!`, `edit.newText!` with the TypeScript non-null assertion operator. If the validation chain ever changes and a missing field reaches these lines, the runtime will pass `undefined` into `findMatch` / `findSymbol` which will then throw a type-error or behave unpredictably. The schema-level validation should make these fields actually required for their mode.

4. **No write-verification step** — `write_file` stats the temp file and compares byte length before renaming. `edit_file` does not. A truncated write that nonetheless completes `writeFile` without error would proceed to rename with corrupted content.

5. **No stash on write/rename failure** — `write_file` stashes the payload when atomic write fails. `edit_file` does not — the raw error propagates. A user who hits an `EXDEV` or quota error on edit gets no stash entry and must re-construct the entire edits array.

6. **Snapshot recording is best-effort and silent** — DB errors are caught and swallowed. A symbol edit can succeed at the file level but fail to record a version, and the user has no indication. Later `refactor_batch restore/history` calls will simply not find that version.

7. **`syntaxWarn` runs the full tree-sitter parse on every edit** — for large files, this adds latency to every edit even when no syntax issue exists. The result is a single line appended to the response. The cost-to-value ratio is high for many use cases. There is no opt-out.

8. **Indent-stripped re-indent uses spaces only** — the re-indent calculation `' '.repeat(max(0, relIndent))` uses spaces regardless of whether the file uses tabs. A tab-indented file edited with indent-stripped strategy may end up with mixed tab+space indentation in the new content.

9. **Strategy 3's ±50 search window is hardcoded** — there is no way to widen or narrow the indent-stripped match window. For files with very long methods or for searches across distant locations, this can cause spurious failures.

10. **`generateDiagnostic` is "best-effort"** — when no match is found, the diagnostic searches for partial line matches to suggest a near line. Its output (`"oldContent not found. Near line N."`) can be misleading when N is genuinely unrelated to where the user expected the match.

11. **Multi-line block anchors are convenient but fragile** — verification lines must appear in order within the candidate range, but they are matched after `.trim()` so any line whose trimmed form equals the verification predicate counts. False-positive verification can cause the wrong block range to be chosen.

12. **The handler does not enforce a per-call edit count limit** — a single call could include thousands of edits. Each edit re-runs `String.split('\n')`, `Array.splice`, and `Array.join('\n')` over the full content. For large files with many edits, this is `O(N×M)` and can be very slow. There is no batched-region optimization.

13. **`isBatch = edits.length > 1` is the only batching signal** — there is no concept of an "atomic edit group" within a larger batch. All-or-nothing applies to the entire `edits[]` array.

14. **`originalContent` is captured BEFORE any edit runs**, but `pendingSnapshots[i].originalText` for symbol-mode edits is captured from `workingContent` at the time of that edit. If a previous content-mode edit modifies a symbol's body before a symbol-mode edit runs against the same symbol, the recorded `originalText` reflects the post-content-edit state, not the file's true original state. Rolling back via `refactor_batch restore` would restore to that intermediate state, not the pre-call state.

15. **Atomic write does not preserve file permissions or ownership** — `fs.writeFile` creates the temp file with default permissions, and `fs.rename` replaces the target with that file. On a file that had restricted permissions, mode bits may change after edit. There is no `fs.chmod` to restore the original mode.
