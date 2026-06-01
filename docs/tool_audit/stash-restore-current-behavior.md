# `stashRestore` — Current Implementation Breakdown

> **Purpose:** Reference document for understanding and redesigning `stashRestore`.
> Documents what the tool currently does in exhaustive detail, tracing through all helpers and code paths, so the intended behavior can be redesigned from an accurate baseline.

---

## Source

**Tool file:** `packages/zenith-mcp/src/tools/stash_restore.ts`

**Key dependencies:**
- `core/lib.ts` — `normalizeLineEndings()`, `createMinimalDiff()`, `findResumeOffset()`
- `core/stash.ts` — `getStashEntry()`, `consumeAttempt()`, `clearStash()`, `listStash()`
- `core/edit-engine.ts` — `applyEditList()`, `syntaxWarn()`
- `core/symbol-index.ts` — `getDb()`, `snapshotSymbol()`, `getSessionId()`
- `core/project-context.ts` — `getProjectContext()`
- `core/db-adapter.ts` (transitively) — raw SQLite stash table operations
- `node:fs/promises` — `readFile`, `writeFile`, `rename`, `unlink`, `mkdir`, `stat`
- `node:crypto` — `randomBytes` (temp file naming)

---

## Schema

```
mode: "apply" | "restore" | "list" | "read" (required)
stashId?: number                                     — required for apply, read, restore
corrections?: Array<{ index, startLine?, nearLine? }> — apply only
newPath?: string                                      — apply only (write redirect)
dryRun?: boolean (default false)                     — apply only
file?: string                                         — list/read/restore filter
type?: "edit" | "write"                              — list filter only
```

**Annotations:** `readOnlyHint: false`, `idempotentHint: false`, `destructiveHint: true`.

The schema is flat; nothing is mode-discriminated. The handler validates which fields are required at runtime.

---

## Schema Field Details

| Field | Type | Required | Default | Used by |
|---|---|---|---|---|
| `mode` | enum | Yes | — | All branches |
| `stashId` | number | No (schema) — required runtime for apply/read/restore | — | apply, read, restore |
| `corrections` | array | No | `[]` | apply (edit type only) |
| `corrections[].index` | number | Yes (within entry) | — | 1-based edit index |
| `corrections[].startLine` | number | No | — | block edits |
| `corrections[].nearLine` | number | No | — | symbol edits |
| `newPath` | string | No | — | apply (write type only) |
| `dryRun` | boolean | No | `false` | apply |
| `file` | string | No | — | list, read, restore |
| `type` | enum | No | — | list only |

The Zod schema attaches `.default(false)` to `dryRun`, so omitted callers receive `false`. All other fields are bare optionals.

---

## Code Path Decision

A linear `if`-chain on `args.mode`:

```
if mode === "list"    → list branch
if mode === "read"    → read branch
if mode === "restore" → restore branch
if mode === "apply"   → apply branch
                        → split on entry.type ('edit' | 'write')
else throw "Invalid mode."
```

The trailing `throw 'Invalid mode.'` is unreachable in practice because Zod validates the enum before the handler runs.

---

## Stash Storage Model

Underlying data lives in a SQLite table named `stash`:

```
id          INTEGER PRIMARY KEY
type        TEXT          -- 'edit' or 'write'
file_path   TEXT NULL
payload     TEXT          -- JSON-serialized edits or write payload
attempts    INTEGER       -- 0 on insert
created_at  INTEGER       -- Date.now() at insert
```

Database location is resolved via `getProjectContext(ctx).getStashDb(filePath)`:

1. Resolve the project root via the project-context ladder (git → MCP roots → markers → registry → global).
2. If a project root is detected, open the project-scoped DB and report `isGlobal: false`.
3. Otherwise open the global DB at `~/.zenith-mcp/` and report `isGlobal: true`.

`ensureStashTables()` is called every time, so tables are created lazily on first use.

The `payload` JSON has two shapes depending on `type`:

```ts
// edit
{ edits: Edit[]; failedIndices: number[] }

// write
{ content: string; mode: string }   // mode = 'append' | 'overwrite'
```

---

## `list` Mode

**Trigger:** `args.mode === "list"`.

**Process:**

1. Call `listStash(ctx, args.file)` → returns `{ entries, isGlobal }`. The DB query is a bare `SELECT * FROM stash ORDER BY id` — `args.file` is ONLY used to pick the project-scope-vs-global DB; it is **not** used to filter rows.
2. If `args.type` is set, filter the in-memory array: `entries.filter(e => e.type === args.type)`.
3. If empty, return `"Empty."` (or `"Empty. (global)"` when `isGlobal` is true).
4. Otherwise format each entry as:
   ```
   #${id} [${type}] ${filePath || '(no path)'} (attempt ${attempts}/2)
   ```
5. If `isGlobal` is true, prepend a banner line:
   ```
   (global stash — no project detected)
   ```
6. Return the joined block.

**Key details:**
- `args.file` does NOT filter list results — it only selects the database scope. A caller listing stash for `src/foo.ts` actually receives every stash entry in the project scope.
- The list shows `attempts` as `attempts/2`, but the meaning is "attempts so far" not "attempts remaining" — see `consumeAttempt` semantics below.
- A stash row whose `file_path` is NULL renders as `(no path)`.
- Dates (`created_at`) are not rendered.
- There is no pagination, no count cap, no sort options.

---

## `read` Mode

**Trigger:** `args.mode === "read"`.

**Process:**

1. Reject if `!args.stashId` → `throw 'stashId required.'`.
2. `entry = getStashEntry(ctx, args.stashId, args.file)`. The `file` argument again selects the DB scope only — not a row filter — so the lookup actually fetches the row by ID from whatever DB the project context resolves to.
3. If the row is not found → `throw 'Stash #N not found.'`.
4. Branch on `entry.type`:
   - `'edit'`: iterate `entry.payload.edits` and render one line per edit:
     ```
     #${i+1} [${FAILED|ok}] ${mode}
     ```
     where `mode` is one of:
     - `symbol:${symbolName}` (truthy `e.symbol`)
     - `block:${block_start}...${block_end}` (truthy `e.block_start`)
     - `content` (otherwise)
     The `FAILED|ok` flag comes from `entry.payload.failedIndices.includes(i)`.
     Header line: `[edit] ${entry.filePath || '(no path)'}`.
   - `'write'`: produce a 500-character preview (`p.content.slice(0, 500) + '...'` if longer; the full content otherwise). Header line: `[write] ${entry.filePath || '(no path)'}`.
   - Anything else → `throw 'Unknown stash type: ${entry.type}'`.

**Key details:**
- The 500-character preview is byte-naive — it slices on JavaScript string indices, so a multi-byte boundary cut produces a malformed UTF-16 unit pair only when surrogate pairs straddle the cut. ASCII payloads render fine.
- The block-edit detection uses truthy `e.block_start`, so `block_start: 0` would fall through to the `content` label even though the edit is structurally a block edit.
- The edit listing exposes the symbol name verbatim, but does NOT render the new content. Callers cannot peek at the proposed text from `read`.
- Failed indices are derived from the stored `failedIndices` array — they are NOT recomputed against the current file, so after the file mutates a stash's "FAILED" labels may no longer reflect what would happen on retry.

---

## `restore` Mode

**Trigger:** `args.mode === "restore"`.

**Process:**

1. Reject if `!args.stashId` → `throw 'stashId required for restore.'`.
2. Fetch the entry to confirm it exists.
3. If not found → `throw 'Stash #N not found.'`.
4. `clearStash(ctx, args.stashId, args.file)` → executes `DELETE FROM stash WHERE id = ?`.
5. Return `"Cleared."`.

**Key details:**
- The mode name is `restore`, but the operation is "delete the stash entry," not "restore the file." Per AGENTS.md the symbol-version restore is in `refactor_batch`, not here. The naming is misleading.
- There is no confirmation, no dry-run, no "restore the file from a saved snapshot."
- The fetch+delete is two separate queries — there is a tiny TOCTOU window between them, but it would only matter for two concurrent `restore` calls hitting the same ID.
- The `file` argument selects DB scope only.

---

## `apply` Mode (top-level)

**Trigger:** `args.mode === "apply"`.

**Process:**

1. Reject if `!args.stashId` → `throw 'stashId required.'`.
2. Fetch the entry; reject if missing.
3. Path-shape gates:
   - If `entry.filePath` is null AND `entry.type === 'edit'` → `throw 'Stash #N has no file path.'` (edits cannot be redirected; they must target their original file).
   - If `entry.filePath` is null AND `entry.type === 'write'` AND `!args.newPath` → `throw 'Stash #N has no file path. Provide newPath.'`.
4. Branch on `entry.type` ('edit' or 'write'). A truly unknown type at this point throws `Unknown stash type`.

The apply flow consults `consumeAttempt` to enforce the 2-retry cap. **Dry-run skips the attempt counter entirely** — repeated dry-runs do not consume attempts.

### `consumeAttempt` Semantics

Defined in `core/stash.ts` with `MAX_ATTEMPTS = 2`:

```
attempts = current value
next     = attempts + 1
write next back
if next > MAX_ATTEMPTS: deleteStash(); return false
else                  : return true
```

This means the third call to `consumeAttempt` returns `false` AND deletes the stash row — there is no third retry. The list/read mode `attempts/2` display reflects the count of consumed attempts so far (after this call increments it), not attempts remaining.

---

## `apply` (Edit Branch)

**Trigger:** `entry.type === 'edit'` inside the apply branch.

**Process:**

1. If `!args.dryRun`: call `consumeAttempt(ctx, stashId, entry.filePath!)`. If it returns `false`, `throw 'Stash #N: max retries (2) exceeded. Stash removed.'`. (The stash is already deleted by the helper.)
2. `validPath = await ctx.validatePath(entry.filePath!)` — uses the existing-file variant. This will fail if the stashed file no longer exists.
3. Read original file: `originalContent = normalizeLineEndings(await fs.readFile(validPath, 'utf-8'))`.
4. Build a `disambiguations` Map from `args.corrections`:
   - For each correction, set `disambiguations.set(c.index - 1, { startLine, nearLine })`.
   - The 1→0-based conversion is implicit in the `c.index - 1`.
5. Call `applyEditList(originalContent, edits, { filePath: validPath, isBatch: edits.length > 1, disambiguations })`.
6. If `errors.length > 0`:
   - Concatenate error messages with `\n`.
   - `throw '${N} failed.\n${failMsg}'`.
   - The stash is NOT cleared on this failure path — but `consumeAttempt` already incremented the counter, so a third failure deletes the row.
7. If `args.dryRun`:
   - Compute and return `createMinimalDiff(originalContent, workingContent, validPath)`.
   - The temp file path is NOT written.
8. Otherwise atomic write:
   - `tempPath = ${validPath}.${randomBytes(16).toString('hex')}.tmp`
   - `fs.writeFile(tempPath, workingContent, 'utf-8')`
   - `fs.rename(tempPath, validPath)`
   - On error, attempt `fs.unlink(tempPath)` (errors silently swallowed) and re-throw.
9. `clearStash(ctx, args.stashId, entry.filePath ?? undefined)` — the stash is removed only on a successful real apply.
10. Snapshot symbols (best-effort):
    - Resolve repo root via `getProjectContext(ctx).getRoot(validPath)` (falls back to `path.dirname(validPath)`).
    - Open the project DB.
    - For each `pendingSnapshot` returned by `applyEditList`, call `snapshotSymbol(db, snap.symbol, relPath, snap.originalText, sessionId, snap.line)` if `snap.symbol` is defined.
    - Any exception is silently swallowed (`/* best-effort */`).
11. Run `syntaxWarn(validPath, workingContent)` and append the warning string (which is `''` on no warnings) to the success text.
12. Return `Applied.${warning}`.

**Key details:**
- `corrections[].index` is **1-based** in the public schema and **0-based** internally. A caller using zero-based indices silently misaligns.
- Both `corrections[].startLine` and `corrections[].nearLine` flow through `applyEditList`, but only one is meaningful for any given edit mode (block vs symbol). The schema does not enforce mutual exclusion.
- `disambiguations` is a sparse `Map` — corrections for non-existent edit indices are silently ignored by `applyEditList`.
- The atomic-write temp file uses a 16-byte (32-hex-char) random suffix; collisions are negligible.
- Dry-run does NOT exercise `consumeAttempt`, so a caller can dry-run indefinitely. Once they call without `dryRun`, attempts begin counting.
- A failed apply leaves both the stash AND the original file untouched — but `consumeAttempt` was incremented before the apply attempt. A series of two failed retries leaves the row in place at attempt 2; the third attempt's `consumeAttempt` call finds the row, increments it to 3, deletes the row, and returns `false`. The user sees `max retries (2) exceeded. Stash removed.` even though they technically attempted three times.
- The success message has no trailing newline before `${warning}`. If `syntaxWarn` returns a non-empty string starting without a newline, the format collapses to `Applied.<warning>` on one line.

---

## `apply` (Write Branch)

**Trigger:** `entry.type === 'write'` inside the apply branch.

**Process:**

1. `targetPath = args.newPath || entry.filePath`. Throw if both are null.
2. If `!args.dryRun`: `consumeAttempt(ctx, stashId, targetPath)`; throw on exhaustion (same semantics as edit).
3. `validPath = await ctx.validatePath(targetPath)` — existing-file variant. This means a `newPath` whose parent doesn't exist fails validation; `newPath` cannot reach into a deeply nested non-existent directory tree.
4. Pull `content` from `entry.payload.content`.
5. Ensure parent dir: `fs.mkdir(path.dirname(validPath), { recursive: true })`. Catches `EEXIST` only — other failures throw `Cannot create directory: ${msg}`.
6. If `args.dryRun`: return `${Buffer.byteLength(content, 'utf-8')} bytes`.
7. Generate temp path: `${validPath}.${randomBytes(16).toString('hex')}.tmp`.
8. Branch on `entry.payload.mode`:
   - **`'append'`**:
     1. Try `fs.stat(validPath)` to detect whether the file exists; on `ENOENT` (or any error) treat as "did not exist."
     2. If the file existed:
        - Read the entire current file.
        - Split both the existing file and the stashed `content` on `\n`.
        - Take the last 500 lines of the existing file as `tailLines`.
        - Compute `overlap = findResumeOffset(tailLines, incomingLines)`.
        - If `overlap > 0`, drop the first `overlap` lines from `incomingLines` and re-join with `\n`. This is the new chunk to append.
        - Insert a `\n` separator only if the existing file does not already end with one.
        - `finalContent = existing + separator + appendChunk`.
     3. If the file did not exist, `finalContent = content`.
     4. `fs.writeFile(tempPath, finalContent, 'utf-8'); fs.rename(tempPath, validPath)`.
   - **anything else** (treated as overwrite):
     - `fs.writeFile(tempPath, content, 'utf-8'); fs.rename(tempPath, validPath)`.
9. On error: try `fs.unlink(tempPath)` (silently swallowed), then `throw 'Write retry failed: ${msg}'`.
10. `clearStash(ctx, stashId, targetPath)`.
11. Return `"Applied."`.

**Key details:**
- The append path runs `findResumeOffset` against the **current** file state at retry time — so if the file was partially written by an earlier attempt, the helper correctly skips the overlapping prefix and appends only the new tail. This is the same dedup mechanism used by `write_file` in append mode.
- `findResumeOffset` only inspects the **last 500 lines** of the existing file. If a partial write left more than 500 lines pending, the overlap detection misses it and the appended content includes a duplicated prefix.
- The append branch reads the entire existing file into memory, even though only the last 500 lines are used for overlap detection. For very large files, this is wasteful.
- The "overwrite vs append" decision is made from the stashed payload's `mode` field, NOT from any current `args` field. A caller cannot change the apply mode between original write and retry.
- The append separator logic: if `existing.endsWith('\n')` is true, no separator. Otherwise a `\n` is inserted. This means appending to a CRLF-terminated file produces a mixed `\r\n` / `\n` boundary because the existing content's trailing `\r\n` includes a `\n`, satisfying `endsWith('\n')`. Subtle, but probably fine in practice.
- Successful write does NOT run `syntaxWarn` (unlike edit). A retried write of malformed code produces no syntax feedback.
- No symbol snapshotting on write apply — only edit apply records snapshots.
- The dry-run output for write returns ONLY the byte count. It does not return a diff against any existing file or a preview of the content.
- `newPath` MUST point at a path whose parent already exists; the only directory creation is `mkdir(parentDir, { recursive: true })` AFTER `validatePath` has already approved the path. Validation rejects deep non-existent destinations before that `mkdir` runs.

---

## Output Format

| Mode | Success | Failure |
|---|---|---|
| `list` (empty) | `"Empty."` or `"Empty. (global)"` | — |
| `list` (non-empty) | Optional banner + lines `#ID [type] path (attempt N/2)` | — |
| `read` (edit) | `[edit] PATH\n#1 [ok\|FAILED] mode\n...` | `'Stash #N not found.'` |
| `read` (write) | `[write] PATH\n${content[:500]}...?` | same |
| `restore` | `"Cleared."` | `'Stash #N not found.'` |
| `apply` (edit, real) | `Applied.${warning}` | `'${N} failed.\n${msgs}'` or `'max retries (2) exceeded'` |
| `apply` (edit, dry) | minimal diff | same |
| `apply` (write, real) | `"Applied."` | `'Write retry failed: ${msg}'` |
| `apply` (write, dry) | `"${N} bytes"` | same |

---

## Hardcoded Constants

| Constant | Value | Where |
|---|---|---|
| `MAX_ATTEMPTS` | `2` | `core/stash.ts` |
| Tail-line scan window | `500` lines | `apply` write append branch |
| Read preview length | `500` chars | `read` write branch |
| Temp file random suffix | `16` bytes (32 hex chars) | apply branches |

There are no caps on `corrections.length`, no DB row caps, no list-output truncation cap, no per-call timeout.

---

## Interaction Between Parameters

| `mode` | Required | Optional | Ignored |
|---|---|---|---|
| `list` | — | `file`, `type` | `stashId`, `corrections`, `newPath`, `dryRun` |
| `read` | `stashId` | `file` | `corrections`, `newPath`, `dryRun`, `type` |
| `restore` | `stashId` | `file` | `corrections`, `newPath`, `dryRun`, `type` |
| `apply` (edit) | `stashId` | `corrections`, `dryRun`, `file` | `newPath`, `type` |
| `apply` (write) | `stashId` | `newPath`, `dryRun`, `file` | `corrections`, `type` |

Unused fields are silently ignored — supplying `corrections` to a `list` operation produces no error. `type` is ignored everywhere except `list`, even when supplying it would conceptually narrow a `read` lookup.

---

## Path Validation Behavior

- `apply` (both branches) call `ctx.validatePath()` (existing-file variant) — NOT `validateNewFilePath()`. A `newPath` whose parent does not exist is rejected before the in-handler `mkdir(... { recursive: true })` runs.
- `list`/`read`/`restore` do NOT validate paths at all — they only use `args.file` to select a DB scope. A caller can list/read/restore stash entries belonging to files they cannot validate, as long as `getProjectContext` resolves to a DB.
- There is no allowed-directory sandbox check in any mode beyond what `validatePath` enforces.

---

## Params That Don't Do What They Suggest

1. **`file` (in `list`/`read`/`restore`) does not filter by file** — it only routes to the project-vs-global DB. A `list` call with `file: 'src/foo.ts'` returns every entry in the project scope, not just entries for that file.

2. **`restore` does not restore anything** — it deletes the stash row. Users expecting "restore my file from a snapshot" will not find that here; that lives in `refactor_batch restore/history`. The mode name is misleading.

3. **`corrections[].index` is 1-based** — the schema description says `1-based edit index`, which is accurate, but the code internally subtracts 1 immediately. A caller using 0-based indices (consistent with most array conventions) silently targets the wrong edit.

4. **`newPath` is `apply`-only AND write-only** — supplying it with an edit-type stash silently does nothing. Supplying it with a `read` or `list` does nothing. The schema description says "redirect write to a different path," which is accurate but not enforced by Zod.

5. **`type` is `list`-only** — supplying it with `read`/`restore`/`apply` is silently ignored. There is no error to inform the caller that their narrowing intent was lost.

6. **`dryRun` is `apply`-only** — silently ignored on every other mode. A caller dry-running a `restore` (perhaps wanting to see what would be cleared) gets the actual delete with no warning.

7. **`attempts/2` display shows attempts consumed, not remaining** — `(attempt 1/2)` after one failed apply means "one attempt consumed, two allowed." A reader assuming "1 of 2 attempts available" misreads the meaning.

8. **`MAX_ATTEMPTS = 2` is hard-coded** — the user-facing error says `max retries (2) exceeded`, but the actual semantics are that a stash row survives ≤ 2 real-apply attempts; the third one fails AND deletes the row. There is no config knob.

9. **Dry-run skips the attempt counter** — a caller running `dryRun: true` repeatedly does not consume attempts. This is a feature for previews, but it means "I dry-ran twice and got success, so my real apply will work" is true; "I dry-ran ten times so my budget is gone" is false.

10. **`read` for an edit stash does not show the new content** — only the symbol/block label is printed. To see what would change, the caller must `apply` with `dryRun: true`.

---

## Known Issues / Smells

1. **`file` argument is overloaded** — it serves dual purpose as DB scope hint AND as a notional file filter, but only the first half is implemented. The schema description "filter by file path" implies the second.

2. **`list` has no filter by file path** — even though the schema advertises `file` as a filter for `list/read/restore`, the SQL query is unfiltered. A user with many stash entries from many files cannot narrow the output.

3. **`restore` mode name collides with `refactor_batch restore`** — the Zenith-MCP catalog has two separate "restore" concepts. AGENTS.md flags this explicitly: "stashRestore restore clears a stash entry by ID. Symbol version rollback is handled by refactor_batch restore." Two different operations, same word.

4. **The block-edit detection in `read` uses truthy `block_start`** — `block_start: 0` would render as `content` instead of `block:0...?`. Probably never happens in practice (line 0 is invalid), but a fragile check.

5. **Write apply append uses a hard 500-line tail window** — for large files where a partial write left more than 500 lines pending, overlap detection silently fails and the next retry duplicates content.

6. **Append apply reads the entire existing file into memory** — even though only the last 500 lines are scanned for overlap. Wasteful for large logs.

7. **`consumeAttempt` increments BEFORE the apply runs** — a transient `validatePath` error counts as a consumed attempt. So does a syntax-failed `applyEditList`, even though the underlying problem might have been entirely outside the user's intent (e.g., the file was concurrently modified).

8. **`consumeAttempt` deletes the stash on the third call before throwing** — the user sees `max retries (2) exceeded. Stash removed.`, but no opportunity to inspect or repair. The deletion is irreversible.

9. **No way to extend the retry budget** — there is no `--reset-attempts` operation. A stash exhausted by transient infrastructure errors must be reconstructed from scratch.

10. **Write apply does NOT run `syntaxWarn`** — a retried write of broken code produces no warning, despite edit retries doing so.

11. **Edit apply success message has no separator before warning** — `Applied.${warning}` collapses if the warning string doesn't begin with whitespace/newline.

12. **Symbol snapshotting on edit apply is best-effort and silent** — failures are swallowed entirely (`/* best-effort */`). Snapshot DB corruption goes unnoticed.

13. **`getStashEntry` ignores type** — even though `type` is on the schema, the internal lookup is by `id` alone. Mismatches between the requested type and the actual row are detected only by the apply branch's type-discriminated logic.

14. **The `read` preview cap of 500 chars is not configurable** — large write payloads cannot be inspected in full from this tool. The caller must apply-with-dry-run to see a diff.

15. **`read` does not show whether the stash has been retried** — neither the per-edit failure list nor the entry's current `attempts` count is included. The caller must combine `list` + `read` to learn both.

16. **Append-mode separator logic ignores CRLF nuance** — a CRLF-terminated existing file is seen as ending with `\n` (because the `\n` of `\r\n` satisfies `endsWith('\n')`). The appended chunk is concatenated without re-inserting `\r`, producing a mixed line ending.

17. **No `corrections` validation** — `corrections[].index` referencing a non-existent edit is silently ignored. A typo (`index: 5` for a stash with 3 edits) produces no error, no warning.

18. **No structured error format** — every failure throws a string-based `Error`. Callers cannot programmatically distinguish "stash expired" from "validation failed" from "max retries" from "edit failed".

19. **`apply` write dry-run output is just a byte count** — no diff against any existing file, no preview of the content, no destination echo. For large writes, the byte count is the only signal.

20. **`apply` mutates state non-atomically across the stash + filesystem boundary** — `consumeAttempt` runs before the file write. If the process crashes between them, the attempt is consumed but no work was done.

21. **Apply dry-run for edit returns a diff but does not validate against the current file's symbol/block structure beyond what `applyEditList` checks** — a dry-run that succeeds doesn't guarantee the next non-dry-run will succeed (the file may have changed between calls).

22. **No way to clear all stash entries at once** — `restore` requires a specific `stashId`. Bulk cleanup must be scripted outside this tool.

23. **`isGlobal` banner appears on `list` only** — `read`/`restore`/`apply` operating on a global stash give no visual indication that the stash is global rather than project-scoped.

24. **Source filename and tool name are mismatched** — file is `stash_restore.ts` but tool registers as `stashRestore`. Most other tools' filenames match their tool names verbatim or in snake_case form; the camelCase tool name is the outlier in the current catalog.

25. **`type` filter is post-fetch in JavaScript** — `list` reads every row from SQLite, then filters by type in memory. Not a perf issue at current stash sizes, but the wasted I/O is unnecessary.

26. **Dry-run paths for write and edit return different output shapes** — edit returns a diff, write returns a byte count. There is no way to dry-run-preview a write's content.

27. **`apply` edit branch atomic write does not snapshot if `clearStash` succeeds but symbol snapshotting fails silently** — the snapshot block runs after `clearStash`, so a snapshot failure leaves the file written, the stash gone, and no symbol record. Best-effort by design, but invisible to the caller.

28. **The `'Invalid mode.'` fall-through is unreachable** — Zod rejects out-of-enum modes before the handler. Dead code.

29. **`getStashEntry`/`clearStash`/`consumeAttempt` all re-resolve project context per call** — for a sequence of stash operations, the project-context ladder runs repeatedly. Caching is up to the project-context layer.

30. **No way to copy/duplicate a stash entry** — once consumed (real apply or 2-retry exhaustion), the original payload is lost.
