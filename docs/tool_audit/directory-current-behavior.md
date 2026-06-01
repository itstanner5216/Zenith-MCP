# `directory` — Current Implementation Breakdown

> **Purpose:** Reference document for understanding and redesigning `directory`.
> Documents what the tool currently does in exhaustive detail, tracing through all helpers and code paths, so the intended behavior can be redesigned from an accurate baseline.

---

## Source

**Tool file:** `packages/zenith-mcp/src/tools/directory.ts`

**Key dependencies:**
- `core/lib.ts` — `formatSize()` (used in list mode only)
- `core/shared.ts` — `getDefaultExcludes()`, `isSensitive()`, `getSensitivePatterns()`
- `core/tree-sitter.ts` — `isSupported()`, `getFileSymbols()`, `getFileSymbolSummary()`
- `node:fs/promises` — `readdir`, `stat`
- `minimatch` — glob pattern matching for excludes

---

## Schema

```
mode: "list" | "tree" (required)
path?: string                  — "Dir path." (defaults to '' which validatePath('') resolves to cwd)
depth?: number                 — int 1–10. Default 1 for list, unlimited (Infinity) for tree.
includeSizes?: boolean         — default false. List mode only.
sortBy?: "name" | "size"       — default "name". List mode only.
excludePatterns?: string[]     — default []. Glob exclude patterns.
showSymbols?: boolean          — default false. Tree mode only.
showSymbolNames?: boolean      — default false. Tree mode only (implies showSymbols).
```

**Annotations:** `readOnlyHint: true` (no `idempotentHint` or `destructiveHint` set).

The schema does not constrain `path` to be a directory — that check happens at runtime via `fs.readdir`.

---

## Schema Field Details

| Field | Type | Required | Default | Constraints / Notes |
|---|---|---|---|---|
| `mode` | `enum("list", "tree")` | Yes | — | Top-level branch |
| `path` | `string` | No | `''` | Empty string is passed to `ctx.validatePath('')` which resolves to `process.cwd()` |
| `depth` | `number` | No | List: `1`. Tree: `Infinity` | Zod `.int().min(1).max(10)`. Tree mode only applies the cap when `depth` is provided; no cap on `Infinity` default |
| `includeSizes` | `boolean` | No | `false` | List mode only — completely ignored in tree mode |
| `sortBy` | `"name"` \| `"size"` | No | `"name"` | List mode only — tree mode always sorts directories before files, both alphabetically |
| `excludePatterns` | `string[]` | No | `[]` | Combined with default excludes; uses minimatch with `dot: true` |
| `showSymbols` | `boolean` | No | `false` | Tree mode only. When true, parses every supported file with tree-sitter to produce a symbol-count summary |
| `showSymbolNames` | `boolean` | No | `false` | Tree mode only. Implies `showSymbols`. Also returns the first 50 symbol names per file |

---

## Code Path Decision

```
if (args.mode === "list") → List Path
else                       → Tree Path  (handles "tree", any other value would have been rejected by Zod)
```

The two paths share NO helpers — they have separately implemented walk functions, separately implemented exclude filtering, and separately implemented control-character escaping (`escapeCtrl` in list, `escapeControlChars` in tree — same logic, separate definitions).

---

## List Path

**Trigger:** `args.mode === "list"`.

**Process:**

1. Validate the path via `ctx.validatePath(args.path ?? '')` — empty string resolves to cwd
2. Compute `depth = max(1, min(args.depth || 1, 10))` — capped 1–10
3. Read flags: `includeSizes`, `sortBy`, `excludePatterns ?? []`
4. Load default excludes via `getDefaultExcludes()` (cached)
5. Define inline helpers `escapeCtrl()` and `compareEntries()`
6. Recursively walk via `listRecursive(validPath, 0, '')`
7. Return joined lines with `\n` separator

### `listRecursive(dirPath, currentDepth, relativeBase)`

1. Try `fs.readdir(dirPath, { withFileTypes: true })` — on failure (any error), append `[DENIED] <relativeBase or basename>` and return
2. Filter entries (in this order, all checks must pass):
   - **Sensitive file check:** `isSensitive(fullPath)` — drops anything matching `getSensitivePatterns()` (default: `**/.env, **/*.pem, **/*.key, **/*.crt, **/*credentials*, **/*secret*, **/docker-compose.yaml, **/docker-compose.yml, **/.config/**` plus user config overrides)
   - **Default excludes:** for each pattern in `getDefaultExcludes()`, drop if `entry.name === pattern` OR `minimatch(rel, pattern)` OR `minimatch(rel, '**/' + pattern)`
   - **User excludes:** for each pattern in `excludePatterns`:
     - If pattern contains `*`: minimatch `rel` against the pattern; if pattern has no `/`, also match against `**/pattern`
     - Else (literal): minimatch against pattern, `**/pattern`, AND `**/pattern/**`
3. Truncation cap: if `entries.length > LIST_CAP (250)`, set `truncated = true` and slice to 250
4. Stat phase (only if `includeSizes` or `sortBy === 'size'`): `Promise.all` over entries, calling `fs.stat` for each, defaulting to `size: 0` on stat error
5. Sort entries via `compareEntries`:
   - If `sortBy === 'size'` and sizes differ → larger size first (descending)
   - Else if one is a directory and the other isn't → directories first
   - Else → `localeCompare` with `numeric: true, sensitivity: 'base'` (case-insensitive numeric)
6. Build output lines:
   - Directories: `<relativePath>/` then recurse if `currentDepth + 1 < depth`
   - Files: `<relativePath>` (or `<relativePath>  <formattedSize>` when `includeSizes`)
7. If truncated, append `[truncated]` line
8. Return lines

**Key details:**
- The output is **flat with relative paths**, NOT indented like the tree path
- Each line is a relative path from the validated root (e.g., `src/index.ts`, `src/utils/`)
- The `[DENIED]` marker appears for any directory `readdir` fails on (permission denied, race condition, etc.)
- Truncation at 250 entries is applied **per directory**, not globally — each subdirectory has its own 250-entry budget
- `escapeCtrl` replaces control characters in filenames: `\t`, `\n`, `\r` become escape sequences; others become `\xHH`
- The size column for files uses `formatSize()` (e.g., `1.50 KB`, `2.10 MB`) — directories never show sizes
- Size comparison only differentiates non-equal sizes; equal sizes fall back to the directories-first → name-sort chain
- The depth check is `currentDepth + 1 < depth`, so `depth: 1` produces only the top-level entries (no recursion), `depth: 2` recurses one level, etc.

### List Mode Output Format

```
src/
src/index.ts
src/index.ts  1.50 KB         (when includeSizes)
src/utils/
src/utils/foo.ts  2.10 KB
[DENIED] some-restricted-dir
[truncated]
```

- One entry per line
- Relative paths from the validated root
- Trailing `/` on directories
- Optional size column separated by **two spaces**
- `[DENIED]` rows for `readdir` failures
- `[truncated]` appended when entries were capped

---

## Tree Path

**Trigger:** `args.mode === "tree"` (or any other non-`"list"` value, but Zod rejects those).

**Process:**

1. Validate the root via `ctx.validatePath(args.path ?? '')` — captured as `rootPath`
2. Compute `showSymbols = args.showSymbols || args.showSymbolNames || false` — `showSymbolNames: true` implicitly enables symbol parsing
3. Compute `showSymbolNames = args.showSymbolNames || false`
4. Initialize a closure-scoped counter `totalEntries = 0` for global truncation
5. Compute `maxDepth`:
   - If `args.depth != null`: `max(1, min(depth, 10))`
   - Else: `Infinity` ← **default for tree mode is unbounded recursion**
6. Load default excludes
7. Recursively build tree via `buildTree(rootPath, 0, args.excludePatterns)`
8. Format the tree as indented text via `formatIndent()`
9. If `totalEntries >= TREE_MAX_ENTRIES (500)`, append `\n[truncated]`
10. Return joined text

### `buildTree(currentPath, currentDepth, excludePatterns)`

1. Early return `[]` if `totalEntries >= 500`
2. Re-validate via `ctx.validatePath(currentPath)` — note: this is called recursively for every directory traversed
3. `fs.readdir(validPath, { withFileTypes: true })` — **no try/catch** here (unlike list mode); a permission error will throw and propagate up to the handler
4. Partition entries into `fileEntries[]` and `dirEntries[]`, applying filters per entry:
   - **Sensitive check:** skip if `isSensitive(fullPath)`
   - **User excludes:** same logic as list mode (with the same special-case for slash-containing patterns)
   - **Default excludes:** drop if `entry.name === pattern` OR `minimatch(relativePath, pattern)` OR `minimatch(relativePath, '**/' + pattern)` — note `relativePath` here is from `rootPath`, NOT from the parent dir
5. Symbol parsing phase (only if `showSymbols && fileEntries.length > 0`):
   - For each file: check `isSupported(fullPath)` (extension-based)
   - If `showSymbolNames`:
     - `getFileSymbols(fullPath, { kindFilter: 'def' })` — full symbol parse
     - Take first 50 symbols, format as `name (type)`
     - Also fetch summary via `getFileSymbolSummary(fullPath)` (separate parse — see issues below)
   - Else:
     - `getFileSymbolSummary(fullPath)` only — produces a string like `"3 functions, 2 classes"`
   - Errors caught and become `null` for that file
   - Results collected into `symbolResults: Map<filename, { summary, names }>`
6. Sort `dirEntries` and `fileEntries` separately by `localeCompare` (numeric, case-insensitive)
7. Walk `dirEntries`:
   - Stop if `totalEntries >= 500`
   - Recurse if `currentDepth + 1 < maxDepth`
   - Else create a stub entry with empty `children: []` (signals "this is a directory we did not descend into")
   - Increment `totalEntries`
8. Walk `fileEntries`:
   - Stop if `totalEntries >= 500`
   - Attach `symbols` (summary) and `symbolNames` if available
   - Increment `totalEntries`
9. Return the entries array

### `formatIndent(entries, depth)`

1. Indent string: `'  '.repeat(depth)` — two spaces per level
2. For each entry:
   - If `entry.children` is defined (directory): emit `<indent><name>/` then recurse
   - Else (file):
     - Optional `  (<symbols>)` suffix when `entry.symbols` is set
     - Optional `  [name1 (type1), name2 (type2), ...]` suffix when `entry.symbolNames` is set
3. Return all lines flattened

### `getFileSymbolSummary` — Detailed Behavior

**Source:** `core/tree-sitter/symbols.ts`

1. `getLangForFile(filePath)` — `null` → return `null`
2. `fs.stat(filePath)` — error → return `null`
3. **Skip files larger than 256 KB** (`stat.size > 256 * 1024`)
4. `fs.readFile(filePath, 'utf-8')` — error → return `null`
5. Call `getSymbolSummaryString(source, langName)`
6. Returns either `"3 functions, 1 class"`-style string or `null`

`getSymbolSummaryString`:
- Parses symbols, filters to definitions
- Counts each symbol type
- Returns a comma-separated count list ordered by a hardcoded priority list (`class, interface, type, enum, function, method, module, key, section, selector, keyframes, media, variable, constant, property, object, mixin, extension, macro, resource, output, provider, local`); any types outside the list are appended at the end
- Singular/plural via a hand-rolled `pluralize` (handles `s`-ending and `y`-ending words; defaults to `+s`)

### `getFileSymbols` — Detailed Behavior

**Source:** `core/tree-sitter/symbols.ts`

1. `getLangForFile(filePath)` — `null` → return `null`
2. `fs.readFile(filePath, 'utf-8')` — error → return `null`
3. Call `getSymbols(source, langName, options)` — full tree-sitter parse with the supplied filter (`kindFilter: 'def'` in directory's case)

**Note:** `getFileSymbols` does NOT have the 256 KB size guard that `getFileSymbolSummary` has. When `showSymbolNames` is true, both are called for the same file (see issue #1 below), but `getFileSymbols` will parse files of any size.

### Tree Mode Output Format

```
src/
  index.ts  (3 functions, 1 class)
  index.ts  (3 functions, 1 class)  [foo (function), Bar (class), ...]
  utils/
    helper.ts
docs/
  README.md
[truncated]
```

- Two-space indentation per depth level
- Trailing `/` on directories
- Symbol summary in `(...)` separated by **two spaces** from filename
- Symbol names in `[name (type), name (type), ...]` separated by **two spaces** from preceding text
- A directory at `maxDepth` becomes a stub (the `name/` line is emitted but no children) — the user cannot tell from the output whether the dir was empty or just truncated by depth

---

## Hardcoded Constants

| Constant | Value | Location | Purpose |
|---|---|---|---|
| `LIST_CAP` | 250 | top of file | Per-directory entry cap in list mode |
| `TREE_MAX_ENTRIES` | 500 | top of file | Global entry cap in tree mode |
| Symbol-summary file size cap | 256 KB | `getFileSymbolSummary` | Skip parsing files larger than this |
| Symbol-name first-N cap | 50 | tree path | Max symbol names returned per file |
| Depth cap | 10 | Zod schema | `min(1).max(10)` for both modes |
| Default depth (list) | 1 | tool handler | Top-level only |
| Default depth (tree) | `Infinity` | tool handler | Unbounded when `depth` not provided |
| Indentation unit | 2 spaces | `formatIndent` | Tree mode rendering |
| Separator before size/symbols | 2 spaces | both formatters | Visual gap |

---

## Filter Pipeline (both modes)

The exclude filter for both modes runs in this order:

1. **Sensitive patterns** (always applied) — non-overridable; controlled by config `advanced.sensitive_patterns` or hardcoded defaults
2. **Default excludes** (always applied) — controlled by config `advanced.default_excludes`; defaults include `node_modules, .git, .next, dist, build, coverage, *.min.js, *.min.css, *.map`, etc.
3. **User excludes** (`args.excludePatterns`)

Each pattern is tested against the **path relative to the search root** with `minimatch(..., { dot: true })`. The matcher tries multiple variants:

- For patterns containing `*`: literal pattern, plus `**/pattern` if no `/` is in the pattern
- For literal patterns: `pattern`, `**/pattern`, `**/pattern/**`

This is **not** standard gitignore semantics — there is no negation, no anchor-prefix, no per-directory `.gitignore` support.

The default-excludes filter in list mode also accepts an exact `entry.name === pattern` short-circuit, which the user-excludes filter does not.

---

## Path Resolution Quirks

1. List mode passes the relative-from-root path (`relativeBase`) into `listRecursive`, but tree mode computes `path.relative(rootPath, ...)` for each entry — different ways to express the same intent
2. List mode uses `path.join(relativeBase, entry.name)` for filter matching
3. Tree mode uses `path.relative(rootPath, path.join(currentPath, entry.name))` for filter matching
4. Both should produce equivalent output, but the list-mode `relativeBase` parameter is propagated through recursion while the tree-mode value is recomputed each time

---

## Symbol Information (tree mode only)

When `showSymbols` is true:

- Every file in every traversed directory is checked via `isSupported()` (extension lookup)
- Supported files are read and parsed via tree-sitter
- A best-effort summary string is computed and attached to the entry
- Errors are caught and become null

When `showSymbolNames` is true:

- Implies `showSymbols` (sets it to true)
- For each supported file, **two parses occur**: `getFileSymbols` (no size cap) and `getFileSymbolSummary` (with 256 KB cap)
- Symbol names are capped at 50 per file

There is no caching across calls — every `directory tree` invocation re-parses every file.

---

## Output Format

| Mode | Format |
|---|---|
| `list` | Flat list of relative paths, one per line; directories suffixed with `/`; optional sizes |
| `tree` | Indented multi-line tree; two spaces per depth; optional `(symbols)` and `[symbol names]` suffixes |

Both modes append `[truncated]` when their respective caps are hit.

---

## Interaction Between Parameters

| Mode | `depth` not set | `depth` set |
|---|---|---|
| `list` | Top-level only (depth = 1) | Recurses up to `depth` levels |
| `tree` | Unbounded recursion (capped only by `TREE_MAX_ENTRIES = 500`) | Recurses up to `depth` levels (capped at 10) |

| `showSymbols` | `showSymbolNames` | Behavior |
|---|---|---|
| `false` | `false` | No symbol parsing |
| `true` | `false` | Summary only — `(3 functions, 1 class)` |
| anything | `true` | Summary + first 50 names — `(3 functions, 1 class)  [foo (function), Bar (class)]` |

| `includeSizes` | `sortBy="size"` | Stat performed? |
|---|---|---|
| `false` | `false` | No |
| `true` | anything | Yes (sizes shown) |
| anything | `"size"` | Yes (sizes used for sort, displayed only if `includeSizes` is also true) |

---

## Params That Don't Do What They Suggest

1. **`includeSizes` and `sortBy` are silently ignored in tree mode** — the schema exposes them with no mode restriction, but the tree path never reads either field. A caller asking for tree mode with `includeSizes: true` gets no sizes and no error.

2. **`showSymbols` and `showSymbolNames` are silently ignored in list mode** — symmetrical to the above. List mode does not surface symbol information at all.

3. **`depth: 1` in tree mode produces a stub-children directory at the top** — the check `currentDepth + 1 < maxDepth` with `maxDepth: 1` evaluates to `0 + 1 < 1 = false` for the very first level of children, so directories at the top level appear with empty `children: []`. The output indents directories with no contents under them, which is misleading.

4. **`depth` description says "Defaults to 1 for list, unlimited for tree"** — accurate for list mode (cap at 10 also applies); accurate for tree mode (`Infinity` is the literal default), but the unbounded default combined with the global `TREE_MAX_ENTRIES = 500` creates a soft cap that isn't documented in the schema description.

5. **`excludePatterns` does not follow `.gitignore` semantics** — there is no negation (`!pattern`), no comment lines (`#`), no per-directory file resolution. Patterns are interpreted via minimatch with multiple fallback variants. A user expecting `.gitignore`-like behavior will be surprised.

6. **`path` defaults to `''`** — passing no path triggers `ctx.validatePath('')`, which resolves to `process.cwd()`. The MCP server's cwd at start is the working directory the binary was launched from, which may or may not be the project root. This is undocumented in the schema.

7. **Truncation marker placement is per-directory in list mode but global in tree mode** — list mode emits `[truncated]` inside each directory that exceeds 250 entries; tree mode emits a single `[truncated]` at the very end of the output regardless of where the cap was hit. A caller seeing `[truncated]` in tree mode cannot tell which subtree was incomplete.

---

## Known Issues / Smells

1. **`getFileSymbols` and `getFileSymbolSummary` are called sequentially when `showSymbolNames` is true** — both run their own `getLangForFile` and `fs.readFile`, parsing the same file twice. The 256 KB size guard in `getFileSymbolSummary` does NOT apply to the `getFileSymbols` call, so a 5 MB file would be fully read and parsed for names, then the summary call would short-circuit to `null` after the size check. This is wasteful and produces inconsistent output (names without a summary).

2. **Tree mode `readdir` has no try/catch** — list mode handles `readdir` failures gracefully with `[DENIED]`, but tree mode lets errors propagate. A single permission-denied subdirectory aborts the entire tree response. The tool throws to the MCP framework with whatever Node error the syscall produced.

3. **Tree mode re-validates every directory recursively** — `ctx.validatePath(currentPath)` runs on every recursion. After the initial root validation, the children paths are formed by `path.join` from validated parents, so they are inherently safe. The redundant validation adds latency without adding security (especially since Zenith is not sandboxed).

4. **No caching of `getDefaultExcludes()` or `getSensitivePatterns()` results across invocations** — both are cached in module-level variables (`_defaultExcludesCache`, `_sensitivePatternsCache`), but `invalidateCachesIfNeeded()` runs on every call. The cache effectively persists across calls only when no config changes have occurred since the last call.

5. **The list mode `[DENIED]` marker swallows the actual error** — any failure (`EACCES`, `ENOENT`, `ENOTDIR`, etc.) becomes the same `[DENIED]` line. A directory race-condition or a non-directory passed at the root level produces the same opaque output.

6. **Two separate `escapeControlChars`/`escapeCtrl` definitions** — the same logic is implemented twice (lines 56–64 and 246–257). This is a maintenance issue — a fix to one will not apply to the other.

7. **Symbol name list cap of 50 is hardcoded** — there is no parameter to widen or narrow this cap. For a file with 200 functions, only the first 50 are shown, and the user has no way to see the rest without invoking another tool.

8. **`isSensitive` calls `path.relative(os.homedir(), absPath)` per entry** — for a tree under `/var/log` this still computes a home-relative path. Performance is fine but the function is doing more work than needed for non-home paths. Pattern matching also runs against multiple variants per call.

9. **Tree mode allocates intermediate object trees** — `buildTree` returns `FileTreeEntry[]` which is then stringified by `formatIndent`. For a large tree near the 500-entry cap, this creates a deep nested object structure before any output is produced. Memory usage is bounded but the indirection is unnecessary for a string-only result.

10. **Default excludes are loaded once but read from a config string** — `getDefaultExcludes()` parses a comma-separated string from config every time the cache is invalidated. The default value embeds many entries that are technically minimatch globs (e.g., `*.min.js`, `*.map`). If a user customizes the config with a malformed glob, no validation runs.

11. **Tree mode exclude matching uses `relativePath` from `rootPath`, not from `currentPath`** — this is correct semantics but combined with the `**/pattern` fallback variants, deeply nested directories can match user patterns in unintended ways. For example, an exclude `node_modules` will match `vendor/foo/node_modules` (good) but also `src/something_node_modules_thing` if a glob fallback is too permissive (false positive risk).

12. **Source map comment at end of file** — line 284 contains `//# sourceMappingURL=directory.js.map`, a build artifact in the TypeScript source.

13. **Sort comparator in list mode mixes priorities** — for `sortBy: "size"`, equal sizes still trigger the directories-first rule. This means `0`-byte files always sort below directories regardless of whether the user wanted strict size ordering.

14. **No way to limit symbol-parsing depth or selectively enable per-directory** — `showSymbols` is global to the call. A user inspecting a large source tree must accept the parse cost across the entire result, even when only the top-level directories matter.

15. **The list mode flat-relative-path format and the tree mode indented format are inconsistent representations of the same data** — there is no shared formatter or shared filter; the two paths have drifted independently.
