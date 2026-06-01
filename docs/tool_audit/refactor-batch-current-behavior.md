# `refactor_batch` — Current Implementation Breakdown

> **Purpose:** Reference document for understanding and redesigning `refactor_batch`.
> Documents what the tool currently does in exhaustive detail, tracing through all helpers and code paths, so the intended behavior can be redesigned from an accurate baseline.

---

## Source

**Tool file:** `packages/zenith-mcp/src/tools/refactor_batch.ts` (1281 lines)

**Key dependencies:**
- `core/symbol-index.ts` — `getDb()`, `indexDirectory()`, `ensureIndexFresh()`, `indexFile()`, `impactQuery()`, `getSessionId()`, `findRepoRoot()`, `snapshotSymbol()`, `getVersionHistory()`, `getVersionText()`
- `core/tree-sitter.ts` — `getLangForFile()`, `findSymbol()`, `checkSyntaxErrors()`
- `core/edit-engine.ts` — `applyEditList()`, `syntaxWarn()`, `Edit` type
- `core/lib.ts` — `normalizeLineEndings()`
- `core/db-adapter.ts` — `getFileCount()`, `getFilePaths()`, `findSymbolFiles()`, `getFileHash()`
- `core/project-context.ts` — `getProjectContext()`
- `config/` — `loadConfig()` lazily for `advanced.refactor_max_chars` and `advanced.refactor_max_context`
- `node:fs/promises` — `readFile`, `writeFile`, `rename`, `unlink`
- `node:crypto` — `randomBytes` (temp file naming), `createHash` (file staleness check)

---

## Schema

```
mode: "query" | "loadDiff" | "apply" | "reapply" | "restore" | "history"  (required, .strict())
target?: string                                            — query only
fileScope?: string                                         — query only
direction: "forward" | "reverse" (default "forward")       — query only
depth: number (1..5, default 1)                            — query only
selection?: Array<number | { symbol: string; file? }>      — loadDiff only
contextLines: number (0..min(30, refactor_max_context), default 5) — loadDiff only
loadMore: boolean (default false)                          — loadDiff only
payload?: string                                            — apply only
dryRun: boolean (default false)                            — apply, reapply, restore
symbolGroup?: string                                       — reapply only
newTargets?: Array<string | { symbol: string; file? }>     — reapply only
ack?: number[] (each >= 1)                                  — reapply only
symbol?: string                                            — restore, history
file?: string                                              — restore (required runtime), history (optional)
version?: number (>= 0)                                    — restore only
```

**Annotations:** `readOnlyHint: false`, `idempotentHint: false`, `destructiveHint: true`.

**Strictness:** The Zod schema is `.strict()` — unknown top-level fields are rejected before the handler runs.

---

## Schema Field Details

| Field | Type | Default | Modes |
|---|---|---|---|
| `mode` | enum | — | All |
| `target` | string | — | `query` (required runtime) |
| `fileScope` | string | — | `query` |
| `direction` | enum | `"forward"` | `query` |
| `depth` | int 1..5 | `1` | `query` |
| `selection` | array | — | `loadDiff` (required unless `loadMore=true`) |
| `contextLines` | int 0..min(30, config) | `5` | `loadDiff` |
| `loadMore` | bool | `false` | `loadDiff` |
| `payload` | string | — | `apply` (required) |
| `dryRun` | bool | `false` | `apply`, `reapply`, `restore` |
| `symbolGroup` | string | — | `reapply` (required) |
| `newTargets` | array | — | `reapply` (required) |
| `ack` | int[] (>=1) | — | `apply` (per-group via payload header), `reapply` (top-level) |
| `symbol` | string | — | `restore` (required), `history` (required) |
| `file` | string | — | `restore` (required), `history` (optional filter) |
| `version` | int >= 0 | — | `restore`; absent means "list versions" |

The `contextLines` max is computed lazily from config: `Math.min(30, getRbConfig().advanced.refactor_max_context)`. The hard ceiling is `30` regardless of config.

---

## Code Path Decision

A linear `if`-chain on `args.mode`. No shared per-call setup beyond `pc = getProjectContext(ctx)`. Order:

```
if mode === 'query'    → query branch
if mode === 'loadDiff' → load branch
if mode === 'apply'    → apply branch
if mode === 'reapply'  → reapply branch
if mode === 'history'  → history branch
if mode === 'restore'  → restore branch
else throw 'Invalid mode.'
```

The trailing `throw 'Invalid mode.'` is unreachable because Zod rejects out-of-enum values.

---

## Module-Level State

This tool maintains in-memory caches keyed by `${repoRoot}::${sessionId}` (or `::${symbolName}` for payload/retry):

| Cache | Type | Eviction | Purpose |
|---|---|---|---|
| `_loadCache` | `Map<string, LoadCache>` | LRU at `CACHE_MAX_ENTRIES = 64` | Stores `query` results AND `loadDiff` occurrences + modal structure |
| `_payloadCache` | `Map<string, PayloadCache>` | LRU at `CACHE_MAX_ENTRIES = 64` | Stores successful apply payload body + ack + modal structure for reapply |
| `_retryState` | `Map<string, number>` | None (grows unbounded) | Per-symbol-group failure counter; `>= 2` locks the group |
| `_rbConfig` | `ZenithConfig \| null` | None | Lazy config singleton |

`evictOldest` walks the Map iterator (insertion order) and deletes the excess oldest entries.

**Important:** `_retryState` is never cleared. A long-running session that fails on many symbols accumulates entries forever; only process restart clears them.

---

## `query` Mode

**Trigger:** `args.mode === 'query'`.

**Process:**

1. If `!args.target` → return `'target required for query.'` (as content, not thrown).
2. If `args.fileScope` is provided → `resolvedScope = await ctx.validatePath(args.fileScope)`.
3. Get allowed directories. If neither `resolvedScope` nor any allowed dir is set → `throw 'No allowed directories configured.'`.
4. Pick `rootHint = resolvedScope ?? allowedDirs[0]`.
5. `repoRoot = pc.getRoot(rootHint)`; throw `'No project root.'` if null.
6. Open the project symbol DB.
7. Indexing decision:
   - If `getFileCount(db) === 0` OR `!args.fileScope` → run **synchronous** `indexDirectory(db, repoRoot, repoRoot, { maxFiles: 5000 })`.
   - Otherwise → fire-and-forget freshness refresh via `ensureIndexFresh` (errors silently swallowed).
8. If `fileScope` was provided, validate it again (yes, twice) and compute the repo-relative path.
9. Call `impactQuery(db, args.target, { file: relScope ?? null, depth: args.depth, direction: args.direction })`.
10. If result is a disambiguation request → return `'Multiple definitions:\n${defs.join('\n')}'`.
11. Otherwise cache `{ results, remaining: [], contextLines: null }` under the session key.
12. If no results → `'No references.'`.
13. Otherwise render one line per result:
    - forward: `${i+1}) ${name}[${refCount}x] (${filePath})`
    - reverse: `${i+1}) ${name}[${callCount}x]`
14. Append `${N} total` as the last line.

**Key details:**
- `fileScope` is validated TWICE (once for the root hint, once for the relative path) — duplicate I/O.
- The 5000-file cap on `indexDirectory` is hard-coded; large monorepos silently get a partial index.
- The synchronous full index runs on either `getFileCount === 0` OR missing `fileScope`. A second broad query immediately repeats the synchronous index even if no files changed — it's not gated by freshness.
- The cache stores `contextLines: null` here; `loadDiff` will use `DEFAULT_CONTEXT = 5` as fallback.
- The cached results' indices (1-based) are the source of truth for subsequent `loadDiff` numeric selection.
- Reverse-direction results have no `filePath` — the parens-trailing format collapses to `(undefined)` if the renderer were called for a reverse result (it's not; the conditional handles it).

---

## `loadDiff` Mode

**Trigger:** `args.mode === 'loadDiff'`.

**Process:**

1. If `!args.selection?.length && !args.loadMore` → `'selection required for loadDiff (or use loadMore=true to continue).'`
2. Require at least one allowed directory → `throw` otherwise.
3. `repoRoot = pc.getRoot(allowedDirs[0])`; throw if null.
4. Open the DB; compute session cache key.
5. Build `workList: WorkItem[]`:
   - **`loadMore=true`**: if no cached `remaining` → `'Nothing to continue.'`. Otherwise `workList = cached.remaining.slice()` and `contextLines = cached.contextLines ?? DEFAULT_CONTEXT`.
   - **`loadMore=false`**: `contextLines = args.contextLines ?? DEFAULT_CONTEXT`. For each entry in `selection`:
     - **number**: look up `cached.results[entry - 1]`. If missing → `'Run query first.'`. If `r.filePath` exists, push `{ symbol: r.name, filePath: r.filePath }`. Otherwise (reverse-query result) → query `findSymbolFiles(db, r.name, 'def')` and push one work item per definition file.
     - **`{symbol, file?}`**: if `file` is absolute, relativize to `repoRoot`. If `file` is omitted → query `findSymbolFiles(...)` for definitions and push each. Else push `{symbol, filePath}` as-is.
6. Walk `workList`, resolving every work item to one or more `RawOccurrence` records:
   - `absPath = path.join(repoRoot, filePath)`.
   - `ctx.validatePath(absPath)` — skip on failure.
   - `fs.readFile` — skip on failure.
   - `getLangForFile(validPath)` — skip if null.
   - `findSymbol(source, langName, symbol, { kindFilter: 'def' })` — skip if no matches.
   - For each match, push an occurrence record with `{symbol, relFile, absPath, source, sourceLines, line, endLine, workIndex}`.
7. **Outlier flagging stub:** group occurrences by symbol name. For groups of >= 2, build a `structs` array (currently always empty — there's a `// TODO: Populate actual SymbolStructure from AST` comment) and call `findModal(structs)`. With empty `structs`, `findModal` returns `null`, so the flagging block is effectively a no-op today.
8. Emit blocks:
   - For each occurrence (capped by `getMaxChars()` — once `totalChars + block.length > maxChars` the loop breaks and `cutAt` records the cut point):
     - Compute context-above (`sourceLines[occ.line-1-contextLines .. occ.line-1]` prefixed with `│ `).
     - Body (`sourceLines[occ.line-1 .. occ.endLine]`) without prefix.
     - Context-below (`sourceLines[occ.endLine .. occ.endLine+contextLines]` prefixed with `│ `).
     - Header: `${symbol} [${globalIndex}] ${relFile}` or with `⚠ ${flag}` suffix when flagged.
     - `globalIndex = startIndex + i + 1`, where `startIndex = args.loadMore ? cached.occurrences.length : 0` — indices are global across paginated loads.
     - Track per-file emit counts in `fileCounts`.
9. Compute `remaining`: every workIndex not represented in `occurrences[0..cutAt]` is preserved for the next `loadMore`. **Note:** `remaining` is computed in work-item terms, not occurrence terms — a work item with multiple matched occurrences is retained in `remaining` if ANY of its occurrences was cut.

Wait — re-reading: `loadedWorkIndices = new Set(occurrences.slice(0, cutAt).map(o => o.workIndex))`. Then `remaining` collects workItems whose index is NOT in that set. So a work item whose first occurrence was emitted (cutAt > that occurrence's index) is considered "loaded" entirely, and its other occurrences are silently dropped. This is a bug: if a work item maps to two occurrences and only the first is emitted, the second is lost.

10. Cache update: `{ results: cached?.results, remaining, contextLines, occurrences: priorOccurrences.concat(emittedOccurrences), modalBySymbol }`.
11. If no blocks emitted → `'No symbols loaded.'`.
12. Otherwise output:
    - Header: `n in file1, m in file2, ...` (joined per-file emit counts).
    - Block list joined with `\n`.
    - If `remaining.length > 0`: `\n[truncated] ${N} remaining. Call loadDiff with loadMore=true.`

**Key details:**
- The `│ ` prefix on context lines is decorative — it's literally the box-drawing character, intended to visually distinguish read-only context from editable body.
- The `loadMore` pagination preserves only work-item indices, NOT occurrence indices — so multi-occurrence work items at the cut boundary may lose later occurrences.
- The modal-outlier flagging is a stub (`structs` is always empty); no occurrences are flagged in practice. The `modalBySymbol` cache is therefore also always empty.
- The char budget includes both context AND body in `block.length`. Large context choices reduce how many bodies fit.
- `getMaxChars()` is read lazily from config (`advanced.refactor_max_chars`).
- The first block is ALWAYS emitted regardless of budget (`totalChars > 0` check skips the budget gate on the initial iteration). A single oversize symbol will exceed the budget.

---

## `apply` Mode

**Trigger:** `args.mode === 'apply'`.

**Process:**

1. Require `args.payload` → `'payload required for apply.'`.
2. Require allowed dirs, resolve `repoRoot`.
3. Load `cached` from `_loadCache[${repoRoot}::${sessionId}]`.
4. `groups = parsePayload(args.payload)` — see Payload Format below.
5. If no groups parsed → `'No diff loaded. Call loadDiff first.'`
6. If no cached occurrences → `'No diff loaded. Call loadDiff first.'`
7. Build `loadedSymbols: Map<string, LoadedOccurrence[]>` from cached occurrences.
8. Compute `flaggedIndices` = set of every cached occurrence with a non-null `flag`. (Today: always empty because the loadDiff flagging is a stub.)
9. **Symbol-existence gate:** every `g.symbol` must be in `loadedSymbols` → otherwise `'Unknown symbol: ${name}. Run loadDiff first.'`.
10. **Outlier-ack gate:** for each group, if any of its `indices` are flagged AND not in the group's `ack` list → `'Flagged outliers require ack: ${list}'`.
11. **Char-budget gate:** `sum(g.body.length * g.indices.length)` across all groups must be <= `getMaxChars()`; otherwise `'Over char budget. Split the apply into smaller groups.'`.
12. **Per-group syntax gate:** for each group, take the first matched occurrence's language and run `checkSyntaxErrors(g.body, langName)`. On any error → `'Syntax error in ${g.symbol}: line ${L}:${C}'`. Infrastructure errors silently swallowed.
13. **Build per-file bundles** (`fileBundles: Map<absPath, FileBundle>`): for each group, select all occurrences whose `index` is in `g.indices`. For each selected occurrence, push an `Edit` of mode `symbol` with `{ symbol: g.symbol, newText: g.body }` into the bundle, and set a `disambiguations[editIdx] = { nearLine: occ.line }` for unambiguous targeting.
14. **Execute bundles**, file-by-file:
    - Read file content. On read failure → mark every group in this file as failed (with retry counter increment).
    - `applyEditList(content, edits, { filePath, isBatch: edits.length > 1, disambiguations })`.
    - If `result.errors.length > 0`:
      - Identify failing edit indices; map back to symbols.
      - For each failing symbol, increment `_retryState[${repoRoot}::${sessionId}::${sym}]`. If count reaches >= 2, message is `Group ${sym} locked. Use edit_file directly.`; otherwise `Group ${sym} failed: ${msg}. Retry once or use edit_file directly.`
      - Co-located groups in the same file (not the direct cause) get `Group ${sym} skipped: co-located with failed group in same file.`
      - Per-file atomicity: NO write happens for this file.
    - **Full-file syntax gate after edits**: run `checkSyntaxErrors(result.workingContent, fileLang)`. On any errors, mark every group in the bundle as failed (with retry counter increments). Locations are concatenated in the error message.
    - If `dryRun`:
      - Increment `successfulFileCount`, add every group's symbol to `successfulGroupNames`.
      - Best-effort accumulate `syntaxWarn` output into `warningSuffix`.
      - Skip the write.
    - Atomic write: `tempPath = absPath + '.' + randomBytes(16).toString('hex') + '.tmp'`; `writeFile`; `rename`. On error, `unlink` the temp file silently and mark every group in the file failed (with retry counter increment).
    - On successful write:
      - Increment `successfulFileCount` and add group names.
      - Best-effort: `snapshotSymbol` for each `pendingSnapshot` returned by `applyEditList`.
      - Best-effort: `ensureIndexFresh(db, repoRoot, [absPath])`.
      - Best-effort: accumulate `syntaxWarn` into `warningSuffix`.
15. **Payload-cache update (success only, not dry-run):** for each group whose symbol succeeded and is not in `failedGroupMessages`, store `_payloadCache[${repoRoot}::${sessionId}::${g.symbol}] = { body: g.body, ack: g.ack, modalStructure: cached?.modalBySymbol?.get(g.symbol) || null }`.
16. **Response:**
    - If any failures:
      - Lines = all failed messages.
      - If any successes, prepend `Applied ${okCount} symbols across ${successfulFileCount} files.` (with `okCount = symbols not in failedGroupMessages`).
      - Append `warningSuffix`.
    - Else if `dryRun`:
      - `Dry run: ${N} symbols across ${F} files.`
      - If any acked outliers: `Acknowledged outliers: ${list}`.
      - If `warningSuffix`: trimmed and appended.
    - Else: `Applied ${N} symbols across ${F} files.${warningSuffix}`.

### Payload Format

Parsed by `parsePayload()`:

```
symbolName1 idx1,idx2[,...] [ack:N[,M,...]]
function symbolName1(...) { ... new body ... }

symbolName2 idx3,idx4
function symbolName2(...) { ... new body ... }
```

- Split rule: `/\n(?=[A-Za-z_$][\w$.]*\s+\d)/` — i.e., a newline followed by an identifier-then-space-then-digit pattern.
- Header regex: `/^([A-Za-z_$][\w$.]*)\s+([\d,\s]+?)(?:\s+ack:([\d,\s]+))?$/`.
- Symbol names support dotted form (e.g., `AuthService.login`).
- Indices and ack values are parsed as numbers, non-finite values filtered out.
- Body is everything from the first newline to the next header block, with trailing newlines stripped.
- The split regex is split-at-boundaries — if a body line happens to start with `identifier digits`, that line is mistaken for a new group header. Defensive payloads avoid this with leading indentation, but the format is fragile.

**Key apply details:**
- Per-file atomicity is true: a file with any failed edit is not written, even if other edits in that file would have succeeded.
- Cross-file atomicity is NOT true: independent files with successful bundles still write. A partial apply across files is possible.
- `_retryState` tracks per-symbol-group failures; the second failure locks the group's message but does NOT prevent the apply from being attempted again — it merely changes the failure message.
- The full-file syntax gate runs against `result.workingContent` after the edit engine completes. It catches structural errors that the per-body syntax check missed.
- `pendingSnapshots` are committed AFTER the write succeeds; if `snapshotSymbol` throws, the snapshot is silently lost.
- `ensureIndexFresh` runs after each file write; this re-syncs the symbol DB so subsequent queries see the new state.

---

## `reapply` Mode

**Trigger:** `args.mode === 'reapply'`.

**Process:**

1. Require `args.symbolGroup` → `'symbolGroup required for reapply.'`.
2. Require `args.newTargets?.length` → `'newTargets required for reapply.'`.
3. Require allowed dirs; resolve `repoRoot`; open DB.
4. Look up `_payloadCache[${repoRoot}::${sessionId}::${symbolGroup}]`. If missing → `'No cached payload for ${symbolGroup}.'`
5. Resolve each `newTargets` entry to `ReapplyTarget`:
   - String entry: `symName = entry`, `file = undefined`.
   - Object entry: `symName = entry.symbol`, `file = entry.file`.
   - If `file` provided, use as the only candidate file. Else `findSymbolFiles(db, symName, 'def')` to enumerate definitions; if empty, add to `skipped[]`.
   - For each candidate file: `validatePath`, `readFile`, `getLangForFile`, `findSymbol(... kindFilter: 'def')`. Push every match as a `ReapplyTarget` with `{symbol, absPath, relFile, source, line, endLine}`.
   - If no matches added across all candidates, push to `skipped[]`.
6. If `!targets.length` → `'Reapplied 0 targets.${skipped ? ` (skipped ${N})` : ''}'`.
7. **Outlier gate:** stub (same as `loadDiff`). `structs` is always empty, so `findModal` returns `null` and no outliers are flagged. The `ack` parameter is therefore inactive in practice.
8. **Syntax gate** on cached body using the first target's language. On error → `'Syntax error in ${symbolGroup}: line L:C'`.
9. **Char budget gate**: `cachedPayload.body.length * targets.length > getMaxChars()` → `'Over char budget. Split the apply into smaller groups.'`.
10. Build per-file `ReapplyBundle` with one `Edit` per target (mode `symbol`, body from cache, `disambiguations[i] = { nearLine: target.line }`).
11. For each file bundle:
    - Read file (on failure, `reapplyFailedCount += occMeta.length`).
    - `applyEditList`. On any errors → `reapplyFailedCount += occMeta.length`, skip.
    - Full-file syntax gate. On errors → `reapplyFailedCount += occMeta.length`, skip.
    - If `dryRun` → `reappliedCount += occMeta.length`, skip the write.
    - Otherwise atomic write. On error → `reapplyFailedCount += occMeta.length`, skip.
    - On success: `reappliedCount += occMeta.length`, snapshot symbols (best-effort), `ensureIndexFresh` (best-effort), accumulate `syntaxWarn` (best-effort).
12. Response:
    - `skippedSuffix = skipped.length ? ` (skipped ${N})` : ''`
    - `failedSuffix = reapplyFailedCount ? ` (${N} failed)` : ''`
    - dryRun: `Dry run: ${N} targets.${skippedSuffix}${failedSuffix}`
    - real: `Reapplied ${N} targets.${skippedSuffix}${failedSuffix}${warningSuffix}`

**Key reapply details:**
- The cached payload is keyed by `(repoRoot, sessionId, symbolGroup)`. A different sessionId cannot reuse another session's payload.
- `reapply` does NOT update `_payloadCache` on success — only initial `apply` populates it.
- `reapply` has NO retry-locking via `_retryState`. Failures are simply counted; the caller can re-attempt indefinitely.
- Unlike `apply`, `reapply` does not return per-target failure messages — only an aggregate count.
- The `ack` field is parsed but inert today (outlier flagging is stubbed).
- An explicit `entry.file` is NOT made repo-relative; it's pushed verbatim into `candidateFiles` and joined with `repoRoot` only if non-absolute. An absolute path bypasses repo-root resolution.

---

## `history` Mode

**Trigger:** `args.mode === 'history'`.

**Process:**

1. Require `args.symbol` → `'symbol required for history.'`.
2. If `args.file` provided: `resolvedFile = await ctx.validatePath(args.file)`.
3. Require allowed dirs OR a resolved file.
4. Pick `rootHint = resolvedFile ?? allowedDirs[0]`.
5. `repoRoot = pc.getRoot(rootHint)`; throw if null.
6. Open DB; compute session id.
7. If `resolvedFile`, compute `relPath = path.relative(repoRoot, resolvedFile)`.
8. `rows = getVersionHistory(db, args.symbol, sessionId, relPath)`.
9. If empty → `'No version history for ${args.symbol}.'`.
10. Otherwise format: `v${i} ${file_path} ${text_hash.slice(0,8)} ${ISO timestamp}`.

**Key details:**
- The version index `i` is the array position, not a stable DB id — versions deleted from the DB shift the indices.
- The `text_hash` displayed is the first 8 hex chars of an MD5; the full hash is in the DB.
- The history is session-scoped (`sessionId` is part of the query). Versions snapshotted in a different session do not appear.
- Without `file`, history is unfiltered by file — a symbol with the same name in multiple files returns all versions across files. The `file_path` column distinguishes them in output.

---

## `restore` Mode

**Trigger:** `args.mode === 'restore'`.

**Process:**

1. Require `args.symbol` → `'symbol required for restore.'`.
2. Require `args.file` → `'file required for restore.'`.
3. `absPath = await ctx.validatePath(args.file)`.
4. `repoRoot = findRepoRoot(absPath) || pc.getRoot()`. Throw if null. **Note:** This uses a different resolution than other branches — `findRepoRoot` directly inspects the path's ancestors for a git/marker root, bypassing the project-context registry.
5. Open DB; compute sessionId; `relPath = path.relative(repoRoot, absPath)`.
6. If `args.version === undefined`:
   - List versions (same format as `history` but file-filtered): `v${i} ${hash8} ${ISO}` (no file_path column).
   - If no rows → `'No version history for ${symbol} in ${relPath}.'`
7. Otherwise lookup the version:
   - `history[args.version]` (array index, NOT a DB id).
   - If undefined → `${symbol}: version ${v} not found. ${N} versions available.`
   - `restoredText = getVersionText(db, versionEntry.id)`; if missing → `${symbol}: version ${v} text missing.`
8. Read current file (with line-ending normalization). On failure → `${symbol}: file not found — ${relPath}.`
9. **Staleness check:** compare MD5 of current content to `getFileHash(db, relPath)`. If differ, set `fileChanged = true` (used for the warning suffix). Failure silently swallowed.
10. `langName = getLangForFile(absPath)`. If null → `${symbol}: unsupported language for ${relPath}.`
11. `matches = await findSymbol(content, langName, args.symbol, { kindFilter: 'def' })`. If empty → `${symbol}: not found in ${relPath}.`
12. **Disambiguation** (when multiple matches):
    - First try matching by `versionEntry.line`.
    - If not found OR sym still equals `firstMatch`: body-similarity heuristic — compute overlap between each candidate's current body lines and the restored text lines (treating each as a `Set` of trimmed lines). Pick the highest-overlap candidate.
13. Splice: replace `lines[sym.line-1 .. sym.endLine]` with `restoredText.split('\n')`. Join with `\n`.
14. Build warning suffixes: `staleWarning` if `fileChanged`, `syntaxWarning` if `checkSyntaxErrors(newContent, langName)` returns errors.
15. If `dryRun` → `Dry run: would restore ${symbol} to v${v}.${staleWarning}${syntaxWarning}`.
16. **Snapshot the CURRENT body BEFORE overwriting** (so the restore is itself restorable). Best-effort.
17. Atomic write via temp file + rename. On error → `Restore failed: ${msg}`.
18. Re-index: `indexFile(db, repoRoot, absPath)` (best-effort).
19. Return `${symbol}: restored to v${v}.${staleWarning}${syntaxWarning}`.

**Key restore details:**
- `version` is an array index, NOT a DB id. The same `version: 0` may mean different rows over time as the table grows.
- The disambiguation heuristic for multiple-match symbols (overloads, redefinitions) uses naive set-based overlap, not a proper diff or AST comparison. Symbols with similar-but-not-identical bodies may swap.
- The pre-overwrite snapshot is unconditional on success; even a "restore back to current content" creates a new version row.
- The staleness check uses `getFileHash(db, relPath)`. This hash is populated by indexing operations; a never-indexed file has no stored hash and the staleness check silently passes.
- `findRepoRoot` is preferred over `pc.getRoot()` here. The difference is subtle: `findRepoRoot` walks the path's ancestors for `.git` etc., ignoring any explicit project registration. A user with overlapping projects may see different roots between `restore` and `history`.
- Multi-line ending normalization runs ONLY on the read of the current file (`normalizeLineEndings(...)`), not on the restored text. If the snapshot was taken from CRLF content but the current file is LF, the splice produces mixed endings.
- `syntaxWarn` (the looser per-edit warning) is NOT run; only `checkSyntaxErrors` is. The two produce different output formats.

---

## Output Format Summary

| Mode | Success | Empty | Failure |
|---|---|---|---|
| `query` | `${idx}) name[Nx] (file)` lines + `${N} total` | `'No references.'` | `'Multiple definitions:\n...'`, `'target required for query.'`, throw |
| `loadDiff` | header (`n in file, m in file`) + blocks + optional `[truncated] ...` | `'No symbols loaded.'`, `'Nothing to continue.'` | `'selection required ...'`, `'Run query first.'`, throw |
| `apply` | `Applied N symbols across F files.${warning}` | — | per-group failure list, `'Over char budget'`, `'Syntax error in S: line L:C'`, `'Unknown symbol: X'`, `'Flagged outliers require ack: ...'`, `'No diff loaded ...'` |
| `apply` (dryRun) | `Dry run: N symbols across F files.\n[Acknowledged outliers: ...]\n[warnings]` | — | — |
| `reapply` | `Reapplied N targets.${skipped}${failed}${warning}` | `'Reapplied 0 targets.${skipped}'` | `'No cached payload ...'`, `'symbolGroup required'`, `'newTargets required'`, `'Syntax error ...'`, `'Over char budget ...'`, `'Flagged outliers require ack: ...'` |
| `reapply` (dryRun) | `Dry run: N targets.${skipped}${failed}` | same | same |
| `history` | `v0 file hash ISO\nv1 ...` | `'No version history for SYM.'` | `'symbol required for history.'`, throw |
| `restore` (list) | `v0 hash ISO\n...` | `'No version history for SYM in REL.'` | `'symbol required ...'`, `'file required ...'`, throw |
| `restore` (apply) | `${symbol}: restored to v${v}.${stale}${syntax}` | — | `'${symbol}: version ${v} not found. ${N} versions available.'`, `'${symbol}: file not found — REL.'`, `'${symbol}: unsupported language ...'`, `'${symbol}: not found in REL.'`, `'Restore failed: ${msg}'` |
| `restore` (dryRun) | `Dry run: would restore SYM to vN.${stale}${syntax}` | same | same |

---

## Hardcoded Constants

| Constant | Value | Where |
|---|---|---|
| `DEFAULT_CONTEXT` | `5` | `getRbConfig`-adjacent |
| `contextLines` ceiling | `30` (regardless of config) | Computed in `getMaxContextLines()` |
| `depth` ceiling | `5` | Zod schema |
| `indexDirectory` `maxFiles` | `5000` | `query` branch synchronous index |
| `CACHE_MAX_ENTRIES` | `64` | LRU cap for `_loadCache` and `_payloadCache` |
| `_retryState` cap | none | Map grows unbounded |
| Retry lock threshold | `>= 2` failures | Per-symbol failure counter |
| Temp file suffix | `randomBytes(16)` (32 hex chars) | All atomic writes |
| Hash algorithm | `md5` | File staleness check in restore |
| Hash displayed | first `8` chars | history/restore listing |
| `text_hash` slice | `8` | Display formatting |

Config-driven:
- `advanced.refactor_max_chars` — char budget for `loadDiff` emit and `apply`/`reapply` aggregate.
- `advanced.refactor_max_context` — upper bound for `contextLines` (clamped at 30).

---

## Interaction Between Parameters

| `mode` | Required | Used | Ignored |
|---|---|---|---|
| `query` | `target` | `fileScope`, `direction`, `depth` | `selection`, `contextLines`, `loadMore`, `payload`, `dryRun`, `symbolGroup`, `newTargets`, `ack`, `symbol`, `file`, `version` |
| `loadDiff` | `selection` OR `loadMore=true` | `contextLines`, `loadMore` | `target`, `fileScope`, `direction`, `depth`, `payload`, `dryRun`, `symbolGroup`, `newTargets`, `ack`, `symbol`, `file`, `version` |
| `apply` | `payload` | `dryRun` | `target`, `fileScope`, `direction`, `depth`, `selection`, `contextLines`, `loadMore`, `symbolGroup`, `newTargets`, `ack`, `symbol`, `file`, `version` |
| `reapply` | `symbolGroup`, `newTargets` | `ack`, `dryRun` | everything else |
| `history` | `symbol` | `file` | `target`, `fileScope`, `direction`, `depth`, `selection`, `contextLines`, `loadMore`, `payload`, `dryRun`, `symbolGroup`, `newTargets`, `ack`, `version` |
| `restore` | `symbol`, `file` | `version`, `dryRun` | `target`, `fileScope`, `direction`, `depth`, `selection`, `contextLines`, `loadMore`, `payload`, `symbolGroup`, `newTargets`, `ack` |

Unused fields are silently ignored — the Zod `.strict()` constraint catches unknown fields, but not mis-applied known fields.

---

## Path Validation Behavior

- `query`: `fileScope` is validated (twice). `pc.getRoot(rootHint)` derives the project root.
- `loadDiff`: every `absPath = path.join(repoRoot, filePath)` is validated; failures cause the work item to be silently skipped (no per-item error reporting).
- `apply`: relies on the cached occurrences' already-validated `absPath`. There is no re-validation per apply call — a file moved out of the allowed dir after `loadDiff` would still be written to.
- `reapply`: every candidate file is validated per-call; failures silently skip.
- `history`: `file` is validated only when provided.
- `restore`: `file` is required and validated. The `repoRoot` resolution uses `findRepoRoot` first (path ancestor walk), then falls back to `pc.getRoot()`.

There is no allowed-directory sandbox check beyond what `validatePath` enforces.

---

## Params That Don't Do What They Suggest

1. **`fileScope` for `query` is validated twice** — once for `rootHint` derivation, once for relative-path computation. No observable bug, just wasted I/O.

2. **`direction: 'reverse'` cached results have no `filePath`** — `loadDiff` numeric selection of a reverse result triggers a `findSymbolFiles` lookup to resolve definition files. The reverse query did not actually return the symbol's location.

3. **`selection: number` is 1-based** — consistent with the rendered query output, but inconsistent with most array-indexing conventions.

4. **`contextLines` is clamped at `min(30, config)`** — a config-set value above 30 is silently capped. Users tuning configs higher than 30 see no effect.

5. **`loadMore` indexing is per-work-item, not per-occurrence** — a work item with multiple occurrences may lose later occurrences when its first is emitted and the others were not.

6. **`payload` header regex is fragile** — a body line starting with `identifier digits` (e.g., `loop 100 times`) can be misparsed as a new group header. Indentation usually protects, but the format is not robust.

7. **`payload` indices are NOT validated against the group's actual occurrences** — a typo like `validateCard 9` (when only `1,2,3` exist) results in `selected = []` for that group — the group silently makes no edits, with no error.

8. **`payload` symbol must match the cached loaded set exactly** — partial matches don't work; case is significant.

9. **`ack` (apply payload form)** — outlier flagging is currently a stub, so all flags are empty and `ack` values are inert.

10. **`ack` (reapply top-level)** — same: outlier flagging is stubbed for reapply.

11. **`dryRun` for `apply` does NOT run snapshot/index-refresh** — that's correct, but the warning suffix accumulation MAY include warnings from successful dry-runs that wouldn't appear on a real apply if it failed later.

12. **`reapply` doesn't lock failed symbols** — unlike `apply` (which uses `_retryState`), `reapply` failures are only counted, not throttled. A caller can retry indefinitely.

13. **`reapply` doesn't populate `_payloadCache`** — only the initial `apply` does. A symbol that succeeded via `reapply` cannot itself be re-`reapply`-ed without going through `apply` first.

14. **`restore` uses `findRepoRoot` instead of the project-context ladder** — a project explicitly registered via `pc.initProject(...)` but not at a git/marker boundary may have its restore operate against a different repo root than `history`.

15. **`restore` version index is array-position, not stable id** — `version: 0` means "oldest currently-stored," not "the first version ever taken." Versions deleted from the DB shift indices.

16. **`restore` body-similarity heuristic for overloaded symbols** — uses naive line-set overlap. Symbols with similar bodies may swap; the only signal is the post-restore line numbers, which the user has no way to inspect from the response.

17. **`restore` snapshot of current text uses `sym.line`** — for the disambiguated match, which may not be the originally-snapshotted symbol. The new snapshot's `line` field corresponds to the current file, not the original.

18. **`history` returns version index as `v0, v1, ...`** — looks stable but isn't. New snapshots can be inserted between sessions (visible only within their session due to sessionId filtering), so `v0` in one session may not correspond to `v0` in another.

19. **`history`/`restore` listing format differs slightly** — `history` includes the file_path column; `restore` (when `version` is undefined) omits it. Two formats for almost the same data.

20. **`apply` per-group syntax check uses the FIRST matched occurrence's language** — for a group spanning files in different languages (rare but possible with same-named functions), only one language is checked. The other language's check is skipped.

21. **`apply` `'Group X locked'` message is fired at retry count >= 2 but does not actually prevent re-attempts** — the lock is purely cosmetic on the message; subsequent calls re-run the entire apply pipeline.

22. **`_retryState` is unbounded** — a long-lived process apply-ing many failing symbols accumulates entries forever.

23. **`apply` co-located group skipping** — a successful group in a file with a failing co-located group is reported as `skipped: co-located with failed group in same file.`. The caller cannot opt to apply only the successful one; per-file atomicity is hard-coded.

---

## Known Issues / Smells

1. **`loadDiff` outlier flagging is a stub** — the `structs` array that `findModal` consumes is never populated (explicit `// TODO` comment). Every `flagByOccurrence` is empty, every `modalBySymbol` value is empty, every `flaggedIndices` set in `apply` is empty. The entire outlier/ack machinery (in both apply and reapply) is therefore inactive in production.

2. **`reapply` outlier flagging is also a stub** — same TODO, same inactive ack mechanism.

3. **`loadMore` pagination drops occurrences** — multi-occurrence work items at the boundary lose all but the first emitted occurrence.

4. **First `loadDiff` block always emits regardless of budget** — `totalChars > 0` skip causes the very first block to bypass the char-budget check. A single huge symbol exceeds `getMaxChars()`.

5. **`indexDirectory` cap of 5000 files is silent** — repos larger than this get a partial index with no warning.

6. **Synchronous full re-index on broad `query` is unconditional** — every broad query triggers a full re-index regardless of staleness. Wasted I/O for repeated queries.

7. **Payload parser is regex-based and fragile** — body lines that match the header pattern (`/^ident\s+\d/`) are misparsed.

8. **Payload empty body silently parses** — `parsePayload` accepts a group whose body is the empty string. The apply replaces the symbol body with nothing.

9. **Per-file atomicity but no cross-file atomicity** — a multi-file apply that partially fails leaves some files written and others not. There is no rollback for cross-file partial failure.

10. **`_retryState` grows unbounded** — no eviction policy. A long-running session leaks memory proportional to unique failing symbols.

11. **`_retryState` is purely cosmetic** — the "locked" message does not prevent further apply attempts.

12. **Tool returns user-error messages as `content`, not thrown errors** — `target required for query.`, `payload required for apply.`, etc. are returned as text content. Other errors (`'No allowed directories configured.'`, `'No project root.'`) are thrown. Inconsistent error contract.

13. **`apply` per-group syntax check vs full-file syntax check have different error formats** — per-group: `Syntax error in NAME: line L:C`. Full-file: `Group NAME failed: parse errors at L:C, L:C`. Two paths to the same conceptual failure.

14. **`apply` syntax check infrastructure errors are silently swallowed** — `catch { /* best-effort */ }` around `checkSyntaxErrors`. A broken WASM grammar causes silent acceptance of malformed payloads.

15. **`apply` co-located group skipping is communicated only by message text** — no structured field. Callers parsing the text to decide whether to retry must do regex matching.

16. **`reapply` failures lose detail** — only an aggregate count is returned. The caller cannot tell which target failed, only how many.

17. **`reapply` skipped[] is symbol-name-only** — `(skipped 3)` doesn't list which symbols were skipped or why (no definition vs. no validation vs. no match).

18. **`history`/`restore` text_hash slice of 8 chars** — collision-prone for large histories; mostly fine for display.

19. **`restore` body-similarity heuristic doesn't tie-break deterministically** — equal-overlap matches pick the last one tested (loop assignment). Subsequent restores may select different matches.

20. **`restore` pre-overwrite snapshot uses `sym.line` from current file** — saved as the snapshot's line, but the actual identity of `sym` may be a different overload than the originally snapshotted one. The version chain becomes mixed.

21. **`restore` `findRepoRoot` vs `pc.getRoot` divergence** — see Params #14.

22. **`restore` newline normalization is inconsistent** — current file is normalized; restored text is not. Mixed-ending splices possible.

23. **`history` is session-scoped** — versions from other sessions are invisible. A long-term version history needs persistence across sessions, which the current schema technically supports but the query filter blocks.

24. **`indexFile` after restore but `ensureIndexFresh` after apply** — different update mechanisms for the same DB. `indexFile` is heavier (full re-parse); `ensureIndexFresh` is incremental.

25. **`apply` payload cache stores `ack`, but reapply ignores it** — `_payloadCache.set({..., ack: g.ack})` records the original ack list, but `reapply` only consults its own top-level `ack` param.

26. **The unreachable `throw 'Invalid mode.'`** — Zod enum validation makes it dead code.

27. **`evictOldest` walks the iterator one at a time** — for large evictions, this is O(n). Negligible at the 64-entry cap.

28. **`_loadCache` mixes `query` results and `loadDiff` occurrences in the same entry** — `query` writes `{results, remaining: [], contextLines: null}`; `loadDiff` overwrites with `{results: cached?.results || [], remaining, contextLines, occurrences, modalBySymbol}`. A loadDiff without a prior query starts with empty `results`. The mixed semantics make it hard to invalidate selectively.

29. **`evictOldest` is called after every cache write** — for the 64-entry cap and small Map sizes, this is fine. For larger workloads, the per-call cost grows.

30. **`apply` warningSuffix accumulates ALL files' warnings into one string** — there's no per-file attribution. A multi-file apply with warnings just gets a concatenated blob.

31. **`reapply` `successfulFileCount` is not tracked** — only target count, even though the underlying iteration is per-file. The output cannot say "applied across N files."

32. **Tool file is 1281 lines** — six modes, multiple gates, several inline interfaces. Refactoring per-mode into separate files would improve maintainability.

33. **`getRbConfig()` reads config lazily into `_rbConfig`** — never invalidated. A config change at runtime is not picked up until process restart.

34. **No way to inspect the current `_payloadCache`** — there is no `list` operation for the payload cache. Callers cannot tell whether a `symbolGroup` is cached without attempting a `reapply`.

35. **No way to clear caches** — neither `_loadCache`, `_payloadCache`, nor `_retryState` is exposed. A stuck cache requires process restart.

36. **`apply` per-group ack list is parsed from the payload header** — separate from the `ack` top-level parameter (which is for `reapply`). The two `ack` semantics are easily confused.

37. **`indexDirectory`'s 5000-file cap and `loadDiff`'s char budget are silent failure modes** — both produce partial results without explicit indication that "more was available."

38. **`apply` writes files even if subsequent files in the iteration fail** — the loop continues past a failed-file write, attempting other files. This is the cross-file non-atomicity from #9, here for completeness.

39. **No persistent telemetry for refactor operations** — `_retryState` is in-memory only. A locked group survives the lock only as long as the process does.

40. **The `mode` description in the schema mentions "rollback" as a feature of `restore`** — but the rollback is per-symbol via tree-sitter splice, not a file-level git-style revert. Users expecting `restore` to revert the entire file will be surprised.
