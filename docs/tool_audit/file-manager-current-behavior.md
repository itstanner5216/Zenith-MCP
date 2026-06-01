# `file_manager` — Current Implementation Breakdown

> **Purpose:** Reference document for understanding and redesigning `file_manager`.
> Documents what the tool currently does in exhaustive detail, tracing through all helpers and code paths, so the intended behavior can be redesigned from an accurate baseline.

---

## Source

**Tool file:** `packages/zenith-mcp/src/tools/filesystem.ts` (registered as `"file_manager"` despite the source filename)

**Key dependencies:**
- `core/lib.ts` — `getFileStats()`
- `node:fs/promises` — `mkdir`, `stat`, `unlink`, `rename`

---

## Schema

```
mode: "mkdir" | "delete" | "move" | "info" (required)
path?: string         — used by mkdir, delete, info
source?: string       — used by move only
destination?: string  — used by move only
```

**Annotations:** `readOnlyHint: false`, `idempotentHint: false`, `destructiveHint: true`.

The schema is flat: `path`, `source`, and `destination` are all optional at the schema level. The runtime handler validates which fields are required based on `mode`.

---

## Schema Field Details

| Field | Type | Required | Default | Used by |
|---|---|---|---|---|
| `mode` | `enum` | Yes | — | All branches |
| `path` | `string` | No (schema) — required runtime for mkdir/delete/info | — | mkdir, delete, info |
| `source` | `string` | No (schema) — required runtime for move | — | move |
| `destination` | `string` | No (schema) — required runtime for move | — | move |

There are no other fields. No flags for force-delete, recursive-delete, overwrite-on-move, atime/ctime, etc.

---

## Code Path Decision

A simple `if/else` chain on `args.mode`. There is no shared validation across modes — each mode validates its own required fields and calls its own filesystem operations.

```
if mode === "mkdir"   → mkdir branch
if mode === "delete"  → delete branch
if mode === "move"    → move branch
if mode === "info"    → info branch
else                  → throw "Unknown mode."
```

The fall-through `throw "Unknown mode."` is unreachable in practice because Zod rejects any non-enum mode value before the handler runs.

---

## `mkdir` Mode

**Trigger:** `args.mode === "mkdir"`.

**Process:**

1. Reject if `!args.path` → `throw new Error('path required for mkdir.')`
2. `validPath = await ctx.validatePath(args.path)` — uses the existing-file variant (NOT `validateNewFilePath`), which calls `fs.realpath` and tolerates `ENOENT` only when the parent exists
3. `fs.mkdir(validPath, { recursive: true })` — creates the directory and any missing intermediate directories
4. Return `"Created."`

**Key details:**
- `recursive: true` means existing directories produce no error (`EEXIST` is silently ignored by `recursive`)
- The tool returns `"Created."` even when the directory already existed — no distinction between "newly created" and "already existed"
- `validatePath()` succeeds for non-existent paths only if their parent directory exists. For multi-level missing paths, validation succeeds at the deepest existing ancestor (the resolved path is the as-typed absolute, not realpath'd) — so `mkdir -p a/b/c/d` works as expected
- If `args.path` points to a non-directory (e.g., an existing file), `fs.mkdir` will throw `EEXIST` despite `recursive: true` — the error propagates without wrapping

---

## `delete` Mode

**Trigger:** `args.mode === "delete"`.

**Process:**

1. Reject if `!args.path` → `throw new Error('path required for delete.')`
2. `validPath = await ctx.validatePath(args.path)`:
   - Catch the validation error
   - If the error is `ENOENT` (either via `code` or via message-substring match) → re-throw as `"Unable to locate file."`
   - Else re-throw the original error
3. `fs.stat(validPath)` — no try/catch; any error propagates raw
4. **Reject directories:** `if (stats.isDirectory()) throw new Error("Not a file.")`
5. `fs.unlink(validPath)` — no try/catch; any error propagates raw
6. Return `"Deleted."`

**Key details:**
- The `ENOENT` detection in step 2 has TWO branches: a strict `code === 'ENOENT'` check and a fallback `e.message.includes('ENOENT')`. The fallback handles wrapped errors but also matches any error message that happens to contain the substring "ENOENT" (e.g., a custom error message about ENOENT)
- The directory check is by design — `delete` is intentionally file-only per AGENTS.md ("`delete` is file-only unless intentionally changed and reviewed")
- Symlinks: `fs.realpath` resolves symlinks during validation, so `delete` on a symlink to a file deletes the **target** of the symlink, not the symlink itself. `delete` on a symlink to a directory triggers `"Not a file."` (the directory, not the symlink)
- There is no `force` option, no `recursive` option, no `trash` option — deletion is unconditional and permanent
- `EACCES`, `EBUSY`, and other delete failures propagate as raw Node errors

---

## `move` Mode

**Trigger:** `args.mode === "move"`.

**Process:**

1. Reject if `!args.source` → `throw new Error('source required for move.')`
2. Reject if `!args.destination` → `throw new Error('destination required for move.')`
3. `validSourcePath = await ctx.validatePath(args.source)` — uses existing-file variant
4. `validDestPath = await ctx.validatePath(args.destination)` — uses existing-file variant
5. `fs.rename(validSourcePath, validDestPath)`
6. Return `"Moved."`

**Key details:**
- BOTH paths are validated with `validatePath()`, NOT `validateNewFilePath()`. This means the destination must either already exist OR have an existing parent directory. A destination several levels deep into a missing tree fails validation with `"Parent directory does not exist: ..."` before `rename` is attempted
- `fs.rename` semantics:
  - Same filesystem: atomic rename
  - Different filesystem: throws `EXDEV` — there is NO fallback to copy + unlink
  - Source does not exist: throws `ENOENT`
  - Destination exists and is a non-empty directory (and source is a directory): throws `ENOTEMPTY`
  - Destination exists as a file and source is a file: silently overwrites on POSIX (Windows behavior depends on Node version)
- The handler does not check whether the destination already exists — there is no overwrite guard
- Works for both files and directories — there is no type-mismatch check (renaming a file over a directory or vice versa fails at `rename`)
- Symlinks at the source: `validatePath` resolves to the target, so the move actually moves the **target**, not the symlink

---

## `info` Mode

**Trigger:** `args.mode === "info"`.

**Process:**

1. Reject if `!args.path` → `throw new Error('path required for info.')`
2. `validPath = await ctx.validatePath(args.path)`
3. `info = await getFileStats(validPath)`
4. Format as `key: value\nkey: value\n...` and return

### `getFileStats()` — Detailed Behavior

**Source:** `core/lib.ts` (lines 177–188)

Returns:

```
{
  size: number              (bytes)
  created: Date             (stats.birthtime)
  modified: Date            (stats.mtime)
  accessed: Date            (stats.atime)
  isDirectory: boolean
  isFile: boolean
  permissions: string       (last 3 octal digits of stats.mode, e.g., "755")
}
```

The handler then renders each key/value pair as `key: value\n` lines using `Object.entries(info).map(...).join("\n")`.

**Key details:**
- Dates are stringified by their default `Date.prototype.toString()` (e.g., `"Fri Mar 15 2024 14:23:01 GMT+0000 (Coordinated Universal Time)"`), NOT ISO format — the output is locale/timezone-dependent
- `permissions` shows only the last three octal digits of the mode — so the file-type bits and the setuid/setgid/sticky bits are dropped. `0755` and `0o4755` (setuid 755) both display as `755`
- `birthtime` is reported as `created`. On Linux filesystems without `crtime` support (older ext4 mounts, etc.), `birthtime` may equal `mtime` or be epoch zero
- No symlink-aware variant — `fs.stat` (used by `getFileStats`) follows symlinks; symlink targets are reported, not the symlink itself
- No additional fields: no inode, no device, no link count, no owner/group, no extended attributes

---

## Output Format

| Mode | Success | Failure |
|---|---|---|
| `mkdir` | `"Created."` | Raw Node error (e.g., `EEXIST`, `EACCES`) |
| `delete` | `"Deleted."` | `"Unable to locate file."` for ENOENT, `"Not a file."` for directories, raw errors otherwise |
| `move` | `"Moved."` | Raw Node error or validation error |
| `info` | Multi-line `key: value` block | Raw Node error |

Sample `info` output:

```
size: 1234
created: Fri Mar 15 2024 14:23:01 GMT+0000 (Coordinated Universal Time)
modified: Fri Mar 15 2024 14:23:01 GMT+0000 (Coordinated Universal Time)
accessed: Fri Mar 15 2024 14:23:01 GMT+0000 (Coordinated Universal Time)
isDirectory: false
isFile: true
permissions: 644
```

---

## Path Validation Behavior

All four modes use `ctx.validatePath()` (the existing-file variant) — NOT `validateNewFilePath()`.

This has three consequences:

1. **`mkdir`** — validation succeeds only when the deepest-existing parent of the requested path exists. The caller can request a path under that parent that doesn't yet exist; `fs.mkdir({ recursive: true })` then creates the missing levels
2. **`delete`** — validation requires the file to exist (or its parent to exist), then the stat + unlink chain catches non-existence afterward. The wrapping `"Unable to locate file."` only applies to the validation error, NOT to a stat or unlink failure that throws ENOENT
3. **`move`** — both source AND destination are validated. The destination must either exist OR have an existing parent. A destination several levels into a missing tree is rejected with `"Parent directory does not exist: ..."` before `rename` is attempted. This effectively forbids `move` to a deeply nested non-existent destination, even when the move would be straightforward to perform

There is **no allowed-directory sandbox check** in any mode.

---

## Hardcoded Constants

There are no numeric or behavioral constants in this tool. All behavior is determined by `mode`, the path inputs, and the underlying filesystem semantics.

---

## Interaction Between Parameters

| `mode` | Required | Optional | Ignored |
|---|---|---|---|
| `mkdir` | `path` | — | `source`, `destination` |
| `delete` | `path` | — | `source`, `destination` |
| `move` | `source`, `destination` | — | `path` |
| `info` | `path` | — | `source`, `destination` |

Unused fields are silently ignored — supplying `path` to a `move` operation produces no error or warning.

---

## Params That Don't Do What They Suggest

1. **`delete` operates on files only — not "delete files"** — the schema description "delete files" is accurate, but a user expecting "delete this thing" semantics will be surprised when directories are rejected with `"Not a file."`. There is no `recursive` flag and no separate directory-deletion mode.

2. **`mkdir` always succeeds for existing directories** — `recursive: true` makes `mkdir` idempotent. The tool returns `"Created."` even when nothing was created. A caller wanting to detect "did I just create this?" cannot do so.

3. **`move` does not validate destination uniqueness** — the schema does not warn that a successful `move` may silently overwrite an existing destination file (POSIX rename semantics). There is no `failIfExists` parallel to `write_file`.

4. **`info` returns formatted dates, not ISO timestamps** — the date fields use `Date.prototype.toString()` which produces locale/timezone-dependent strings. Programmatic callers cannot easily parse the output.

5. **`info` permissions show only the lower 9 bits** — file-type and special bits (setuid, setgid, sticky) are stripped. A setuid binary at `0o4755` displays as `755`.

6. **`source`/`destination` field naming is move-specific** — the schema accepts these on every mode but only `move` uses them. The tool does not error on unused fields.

7. **`delete` distinguishes ENOENT only at validation time** — `validatePath` failing with ENOENT becomes `"Unable to locate file."`. But `fs.stat` or `fs.unlink` throwing ENOENT later (race condition: file deleted between validation and unlink) propagates the raw error. Two different code paths produce different error formats for the same logical condition.

---

## Known Issues / Smells

1. **No `recursive` mode for `delete`** — to remove an entire directory tree, the user must invoke another tool or fall back to shell. AGENTS.md explicitly notes this is intentional ("`delete` is file-only unless intentionally changed and reviewed"), but the schema description does not communicate it.

2. **`move` cannot create destination directories** — using `validatePath` instead of `validateNewFilePath` rejects a destination whose parent doesn't exist. A caller wanting to move-and-create-dirs has to call `mkdir` first. This is a usability gap compared to `write_file` which auto-creates parent directories.

3. **`move` does not handle `EXDEV` (cross-filesystem)** — `fs.rename` fails when source and destination are on different filesystems. There is no fallback to copy + unlink, and the user sees a raw `EXDEV` error.

4. **`info` exposes `accessed` (atime) which is often disabled on modern filesystems** — many filesystems are mounted with `noatime` or `relatime` for performance, in which case `atime` is meaningless. The tool reports it without indication.

5. **`delete` ENOENT wrapping is fragile** — the fallback `e.message.includes('ENOENT')` is a string-substring check. If Node ever changes error messages or if a custom error wrapper produces a different format, the friendly error would degrade to a raw error.

6. **No structured error format** — every failure throws `new Error(message)` which the MCP framework converts to a generic error. Callers cannot programmatically distinguish "destination already exists" from "destination filesystem full" from "permission denied".

7. **`mkdir` silently treats existing directory as success** — for callers needing to know whether a directory was newly created (e.g., for follow-up initialization), there is no way to detect this.

8. **`move` does no atomicity guarantee for cross-directory moves** — even within the same filesystem, if the destination directory is being modified concurrently, the rename may produce partial visibility (e.g., directory listings briefly missing the entry). This is a `rename` characteristic, not a tool bug, but it's not documented.

9. **`info` output format is human-readable but not machine-parseable** — the `key: value` block has no escaping. A filename containing a colon or newline does not appear in the output (only the resolved path is the input, and stats don't include the path), but the format itself precludes structured downstream consumption.

10. **`info` does not include the path it stat'd** — the response has no echo of which file was inspected. Per the AGENTS.md "Single-Target Rule" this is correct, but it means a batched workflow that wants to associate stats with paths must do so externally.

11. **Source map comment at end of file** — line 68 contains `//# sourceMappingURL=filesystem.js.map`, a build artifact in the TypeScript source.

12. **Source filename does not match registered tool name** — the file is `filesystem.ts` but registers as `"file_manager"`. AGENTS.md uses `file_manager` as the canonical name. The mismatch is mostly cosmetic but adds friction when navigating the codebase.

13. **No `dryRun` for any mode** — every mode either succeeds or fails; there is no preview. For `delete` and `move` (destructive operations), this means the user must be confident before invoking.

14. **`info` does not differentiate between "file does not exist" and "permission denied"** — `validatePath` throws the underlying error for both cases. The `delete` mode wraps ENOENT specifically; `info`, `mkdir`, and `move` do not.

15. **No symlink-aware operations** — `delete` on a symlink to a file deletes the target, not the link. There is no way to delete just the symlink. `info` on a symlink reports stats of the target. `move` resolves both endpoints. A caller wanting to manage symlinks themselves cannot do so through this tool.

16. **Mode dispatch is `if/if/if/if/throw` rather than a `switch`** — the four `if` blocks each have an early `return`, so fall-through is impossible. A `switch (args.mode)` would be more idiomatic and easier to extend. The current shape implies a slot for "fall through to next check" semantics that doesn't actually exist.
