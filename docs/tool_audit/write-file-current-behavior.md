# `write_file` — Current Implementation Breakdown

> **Purpose:** Reference document for understanding and redesigning `write_file`.
> Documents what the tool currently does in exhaustive detail, tracing through all helpers and code paths, so the intended behavior can be redesigned from an accurate baseline.

---

## Source

**Tool file:** `packages/zenith-mcp/src/tools/write_file.ts`

**Key dependencies:**
- `core/lib.ts` — `validateNewFilePath()`, `normalizeLineEndings()`, `findResumeOffset()`
- `core/stash.ts` — `stashWrite()`
- `node:fs/promises` — `stat`, `mkdir`, `readFile`, `writeFile`, `rename`, `unlink`
- `node:crypto` — `randomBytes()` (for the temp filename suffix)

---

## Schema

```
path: string (required) — "File to write."
content: string (required) — "Content to write."
failIfExists?: boolean (default: false) — "Fail if the file already exists."
append?: boolean (default: false) — "Append instead of overwriting."
```

**Annotations:** `readOnlyHint: false`, `idempotentHint: false`, `destructiveHint: true`.

**No `mode` enum.** Behavior switches on the two boolean flags `failIfExists` and `append`. Both have Zod `.default(false)`, so they are always defined at runtime.

---

## Schema Field Details

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `path` | `string` | Yes | — | Passed through `ctx.validateNewFilePath()` (does NOT require the file to exist; resolves the nearest existing ancestor and re-attaches missing segments) |
| `content` | `string` | Yes | — | No size limit, no encoding option — always written as UTF-8 |
| `failIfExists` | `boolean` | No | `false` | If `true` and the file already exists at `validPath`, throws `"File already exists."` before writing |
| `append` | `boolean` | No | `false` | If `true` and the file exists, performs a resume-aware append. If the file does NOT exist, behaves like a normal write (no special handling) |

---

## Code Path Decision

There is no mode parameter; the handler runs a fixed sequence with conditional branches:

```
1. Validate path (validateNewFilePath — non-existence allowed)
2. Normalize line endings of args.content
3. Stat the target → set `existed` flag
4. If failIfExists && existed → throw
5. mkdir -p parentDir
6. If append && existed → compute resume-aware merged content
7. Write to <validPath>.<random>.tmp
8. Stat the temp file, verify byte length matches
9. Rename temp → validPath
10. On any failure between steps 7–9: unlink temp, stash payload, throw
11. Return one of three success messages
```

The combination `failIfExists: true, append: true` is accepted by the schema but step 4 will throw before step 6 if the file exists. If the file does not exist, `failIfExists` is satisfied and `append` collapses to a plain write of `normalizedContent`.

---

## Step-by-Step Process

### 1. Path Validation (`validateNewFilePath`)

**Source:** `core/lib.ts` (lines 83–95)

Unlike `validatePath()`, this variant tolerates non-existent target paths.

Process:

1. Expand `~` via `expandHome()`
2. Resolve to absolute path (relative resolved against `process.cwd()`)
3. Normalize the path (null-byte check, slash normalization via `normalizePath()`)
4. Walk up parent directories via `resolveNearestExistingAncestor()` until one exists; collect each missing segment along the way
5. `realpath()` the nearest existing ancestor
6. Re-join the missing segments onto the resolved ancestor and return

**Key details:**
- Symlinks in the existing ancestor are resolved; the missing trailing segments are appended literally without symlink resolution
- If no ancestor exists at all (root reached), throws `"No existing ancestor found for path: ..."`
- There is **no allowed-directory sandbox check** — Zenith is intentionally not sandboxed
- A `path` that points to an existing **directory** is not rejected here; the failure surfaces later at the `fs.rename()` step (renaming a file over a directory fails with `EISDIR`/`ENOTEMPTY` depending on platform)

### 2. Line-Ending Normalization

`normalizeLineEndings()` runs `text.replace(/\r\n/g, '\n')` once. Lone `\r` characters are NOT normalized — only CRLF pairs become LF.

### 3. Existence Check

`fs.stat(validPath)` is called. The result is reduced to a boolean `existed` flag — file size, mode, type (file vs directory) are all discarded.

- `ENOENT` → `existed = false`
- Any other errno → re-thrown as `"Cannot access file: <code>"` (the original error is dropped)

### 4. `failIfExists` Check

If `args.failIfExists === true` and `existed === true`, throws `"File already exists."`. The check uses the post-stat `existed` flag, so an existing **directory** at that path also triggers this error.

### 5. Parent Directory Creation

`fs.mkdir(parentDir, { recursive: true })` runs unconditionally — even if the parent already exists, even on overwrite of an existing file.

- `EEXIST` is ignored (mkdir of an existing dir)
- Any other errno is wrapped: `"Cannot create parent directory: <message>"`

### 6. Append Branch (only when `append && existed`)

When both conditions hold, a resume-aware merge runs:

1. Read existing file as UTF-8: `fs.readFile(validPath, 'utf-8')`
2. Split existing content by `\n`
3. Split `normalizedContent` by `\n`
4. Take the **last 500 lines** of the existing content as `tailLines`
5. Call `findResumeOffset(tailLines, incomingLines)` to detect overlap
6. If overlap > 0: `appendContent = incomingLines.slice(overlap).join('\n')`
7. If overlap == 0: `appendContent = normalizedContent`
8. Insert a `\n` separator only if the existing content does not already end in `\n`
9. `finalContent = existing + separator + appendContent`

If the read fails for any reason: `"Cannot read existing file for append: <message>"`.

When `append` is set but the file does **not** exist, the merge logic is skipped entirely and `finalContent` stays equal to `normalizedContent` — the eventual write produces a brand-new file.

### `findResumeOffset()` — Detailed Behavior

**Source:** `core/lib.ts` (lines 126–157)

Detects how many leading lines of `incomingLines` already appear in the tail of the existing file, so the same content is not appended twice on retry.

Process:

1. Strip a single trailing empty line from each array (artifact of `split('\n')` on newline-terminated text)
2. If either array is empty → return `0`
3. Define `trim = (s) => s.trimEnd()` (only trailing whitespace/CR is trimmed)
4. Take the trimmed first incoming line as the anchor
5. Walk through `existing` looking for an index `i` where `trim(existing[i]) === firstIncoming`
6. Compute `overlapLen = min(existing.length - i, incoming.length)`
7. Verify that ALL `overlapLen` lines starting at `i` match `incoming[0..overlapLen)` under `trimEnd` comparison
8. If they all match → return `overlapLen`; else continue searching
9. If no anchor match works → return `0`

**Key details:**
- The comparison ignores trailing whitespace per line but is case-sensitive and order-sensitive
- The first match wins — if the same anchor line appears multiple times in the tail, only the first one is checked
- The 500-line window in the caller bounds how far back resume detection can reach
- If the existing tail contains a complete prefix of `incoming` followed by additional text, the function will still match and return `overlapLen` based on `incoming.length`, then the slice produces an empty `appendContent` — effectively a no-op append (with the separator possibly still added)

### 7–9. Atomic Write (temp file + rename)

1. Compute `tempPath = "${validPath}.${randomBytes(16).toString('hex')}.tmp"` — 16 random bytes hex-encoded → 32 chars
2. `fs.writeFile(tempPath, finalContent, 'utf-8')`
3. `fs.stat(tempPath)` and compare `tempStat.size` against `Buffer.byteLength(finalContent, 'utf-8')`
4. If mismatch → throws `"Write verification failed."`
5. `fs.rename(tempPath, validPath)` — atomic on the same filesystem (POSIX guarantee), best-effort on Windows

**Key details:**
- The temp file lives in the same directory as the target — on a different filesystem the rename would fail with `EXDEV`, which is not handled specially
- If the directory is not writable, the initial `writeFile` fails before verification
- The size check protects against partial writes / encoding mismatches but does NOT verify the bytes themselves match (no hash, no re-read)

### 10. Failure Recovery → Stash

The catch block around steps 7–9:

1. Best-effort `fs.unlink(tempPath)` (errors swallowed)
2. Call `stashWrite(ctx, validPath, normalizedContent, args.append ? 'append' : 'write')`
   - Inserts a row into the stash SQLite DB (project-scoped if a project root is found, else global at `~/.zenith-mcp/`)
   - Stores the **un-merged** `normalizedContent`, not the resume-aware `finalContent`
   - Returns the stash row ID
3. Throws `"Write failed. Cached as stash:<id>."`

The stashed payload uses mode `'append'` or `'write'` — a later `stashRestore apply` would re-run the same merge logic against whatever the file looks like at retry time.

### 11. Success Response

The handler returns one of three text messages depending on the path taken:

| Condition | Message |
|---|---|
| `args.append === true` | `"Content appended."` |
| `existed === true` (overwrite) | `"File updated."` |
| Otherwise (new file) | `"File written."` |

Returned as `{ content: [{ type: "text", text: message }] }`. No path, no byte count, no metadata.

The branches are evaluated in order, so `append: true` always reports `"Content appended."` even when the file did not previously exist (in which case it was effectively a fresh write).

---

## Output Format

**Success:**
```
Content appended.
```
or
```
File updated.
```
or
```
File written.
```

**Failure (failIfExists):**
```
Error: File already exists.
```

**Failure (write/rename/verification):**
```
Error: Write failed. Cached as stash:<id>.
```

**Failure (append read):**
```
Error: Cannot read existing file for append: <node error message>
```

**Failure (parent mkdir, non-EEXIST):**
```
Error: Cannot create parent directory: <node error message>
```

**Failure (stat, non-ENOENT):**
```
Error: Cannot access file: <code or 'unknown error'>
```

---

## Hardcoded Constants

| Constant | Value | Location | Purpose |
|---|---|---|---|
| Temp suffix bytes | 16 | `randomBytes(16)` | Collision-resistant temp filename |
| Append tail window | 500 lines | `existingLines.slice(-500)` | Bounds resume-overlap search |
| Encoding | `'utf-8'` | `readFile` / `writeFile` | Always UTF-8; not configurable |

---

## Interaction Between Parameters

| `failIfExists` | `append` | File Exists | Behavior |
|---|---|---|---|
| `false` | `false` | yes | Overwrite → `"File updated."` |
| `false` | `false` | no | Create → `"File written."` |
| `false` | `true` | yes | Resume-aware append → `"Content appended."` |
| `false` | `true` | no | Plain create with full content → `"Content appended."` (label says append but it was a fresh write) |
| `true` | `false` | yes | Throws `"File already exists."` |
| `true` | `false` | no | Create → `"File written."` |
| `true` | `true` | yes | Throws `"File already exists."` (append never reached) |
| `true` | `true` | no | Plain create with full content → `"Content appended."` |

---

## Params That Don't Do What They Suggest

1. **`append` on a non-existent file silently becomes a plain write** — the merge logic is gated by `args.append && existed`, so when the file does not exist, `finalContent` is just `normalizedContent`. The success message still reads `"Content appended."`, which is misleading: nothing was appended; a new file was created with the full content.

2. **`append` description says "Append instead of overwriting" but it actually does resume-aware merging** — the schema does not communicate that overlapping lines are detected and skipped. A caller expecting raw concatenation will be surprised when `findResumeOffset` deduplicates a leading prefix of their `content`.

3. **`failIfExists` triggers on existing directories too** — the description says "Fail if the file already exists" but the underlying check is just `fs.stat()` succeeding, which also matches directories, FIFOs, sockets, etc. When `failIfExists` is `false`, the same situation later fails at `fs.rename()` instead.

4. **`content` has no size limit or budget** — unlike `read_file`, there is no `getCharBudget()` involvement on the write side. A multi-gigabyte `content` string is accepted, written, stat-verified, and renamed without any guard. The Zod schema only requires `z.string()`.

5. **`failIfExists` and `append` are independently typed** — the schema accepts `failIfExists: true, append: true`. The combination is valid (the file is created if missing, fails if present), but it is also redundant — when `failIfExists: true` succeeds, the file did not exist, so `append` has nothing to append to and behaves identically to a fresh write.

---

## Known Issues / Smells

1. **`existed` is computed via `fs.stat` and `failIfExists` triggers on directories** — if the user calls `write_file` with a directory path and `failIfExists: false`, the tool proceeds past the existence check, attempts `mkdir -p` on the parent, writes the temp file in the parent dir, then fails at `fs.rename()` because rename of a file over a non-empty directory is not portable. The temp file is then unlinked and the payload stashed. The error message `"Write failed. Cached as stash:<id>."` does not communicate that the target was a directory.

2. **Append-mode line-ending detection only handles CRLF** — `normalizeLineEndings` strips `\r\n` but leaves bare `\r` (old Mac classic line endings, or content that mixes line-ending styles). On a file with `\r`-only line endings, the existing-content split into lines will produce one giant "line" and `findResumeOffset` will fail to detect any overlap.

3. **The stash payload stores `normalizedContent`, not `finalContent`** — when an append-mode write fails after the merge, the stash records the original incoming content. If the user retries via `stashRestore apply`, the merge runs again against the file as it then exists. This is intentional (resume-friendly), but it means the user cannot inspect what was actually about to be written via `stashRestore read`.

4. **Temp file collisions are theoretically possible** — `randomBytes(16)` provides 128 bits of entropy, so collisions are astronomically unlikely. However, if the parent directory has restrictive permissions or quota limits, the temp file can fail to create, and the failure path stashes the payload but does not communicate that the directory was the problem (only the catch-all `"Write failed."` is surfaced).

5. **Size verification only checks byte count, not content** — `tempStat.size === Buffer.byteLength(finalContent, 'utf-8')` confirms no bytes were lost in transit, but it does not detect filesystem-level corruption that preserves length (e.g., a sparse-file or bit-flip scenario). A read-back hash check would be more robust but slower.

6. **`fs.rename()` is not atomic across filesystems** — if `validPath` is on a different filesystem than its parent (rare but possible with bind mounts or tmpfs overlays), `EXDEV` is thrown, the catch block stashes the payload, and the user sees the generic `"Write failed."` message. There is no automatic copy-then-unlink fallback.

7. **`mkdir -p` runs even when the parent already exists** — this is correct behavior (mkdir is idempotent with `recursive: true`) but it is also one extra syscall on every write. Most callers write into existing directories.

8. **The `append` resume window is fixed at 500 lines** — there is no way to widen or disable this. For files with very long historical lines (e.g., a single JSON-per-line log), 500 lines could be many megabytes; for files with mostly short lines, 500 lines may not reach far enough into the past to detect a long overlap.

9. **Resume-overlap match is anchored on the first incoming line** — if the first incoming line is very generic (e.g., a blank line, a `}` on its own line, or a common log prefix), `findResumeOffset` may anchor at the wrong place in the tail. The full-overlap verification step then rejects the false anchor and the loop tries the next match, but multiple false anchors can quietly degrade performance on large tails.

10. **No `dryRun` parameter** — there is no way to preview what would be written, no way to compare against the existing content, and no diff is produced on success or failure. Callers must use `read_file` separately if they want a before/after comparison. This is in contrast to `edit_file` which has both `dryRun` and minimal-diff output.

11. **Error message format is inconsistent** — some failures use `"Cannot <verb>: <message>"`, the failIfExists case uses a bare `"File already exists."`, and the write-failure case includes a `stash:<id>` reference. There is no structured error format (e.g., JSON with `code` and `message`) to help callers branch on failure type.
