# Zenith-MCP symbol/search methods audit

Scope: `packages/zenith-mcp/src/core/tree-sitter.ts` (and the submodules it re-exports), `core/symbol-index.ts`, `core/db-adapter.ts`, `tools/search_file.ts`, `tools/search_files.ts`, `tools/refactor_batch.ts`, `tools/edit_file.ts`, and `core/edit-engine.ts`.

Important framing:
- `src/core/tree-sitter.ts` is only a **barrel file**. The real logic lives in `src/core/tree-sitter/*.ts`.
- Zenith has **two different symbol systems**:
  1. **Live parse**: parse the current file contents with tree-sitter and operate on exact line spans.
  2. **Indexed DB**: persist symbol/edge/version rows in `.mcp/symbols.db` and query them later.
- The tools mix these approaches. Discovery often uses the DB; final edit boundaries usually come from a fresh live parse.

---

## 1. Core tree-sitter functions (the parsing layer)

## 1.1 Barrel surface: `src/core/tree-sitter.ts`

This file contains no logic; it re-exports the public parsing/search API:

```ts
export {
    getSymbols,
    getDefinitions,
    getSymbolSummary,
    getSymbolSummaryString,
    findSymbol,
    getFileSymbols,
    getFileSymbolSummary,
    checkSyntaxErrors,
} from './tree-sitter/symbols.js';

export {
    getStructuralFingerprint,
    computeStructuralSimilarity,
    getSymbolStructure,
} from './tree-sitter/structural-similarity.js';
```

So the real audit target is the submodules below.

## 1.2 Language/runtime helpers

### `getLangForFile`

```ts
export function getLangForFile(filePath?: string): string | null {
```

- **What it does**
  1. Normalizes `undefined` to `''`.
  2. Looks up a language by file extension.
  3. If extension lookup fails, falls back to exact basename lookup.
  4. Special-cases `Dockerfile`/`dockerfile.*` variants.
- **Called by**
  - `search_file` symbol mode
  - `search_files` symbol/definition/structural modes
  - `refactor_batch` load/apply/reapply/restore flows
  - `edit-engine` symbol mode and syntax warning path
  - `symbol-index` indexing functions
- **Returns**
  - Tree-sitter language name string, or `null` if unsupported.
- **Filtering / error handling**
  - No exceptions; unsupported files simply return `null`.
- **Nuances / gotchas**
  - This is the first gate for all live symbol work.
  - Parse-capable-only languages (for example ones with WASM but no tags query) still return a language here; later symbol lookup can still fail because `getCompiledQuery()` may return `null`.

### `isSupported`

```ts
export function isSupported(filePath: string): boolean {
    return getLangForFile(filePath) !== null;
}
```

- **What it does**: Boolean wrapper around `getLangForFile`.
- **Called by**
  - `search_files` symbol/definition discovery
  - `symbol-index.shouldIndexFile`
  - `directory` tool (outside the audited tool list)
- **Returns**: `true` if the path maps to a tree-sitter language.
- **Nuances**
  - "Supported" means "has a language mapping", not "has symbol tags". A file can pass `isSupported` and still fail symbol lookup later.

### `loadLanguage`

```ts
export async function loadLanguage(langName: string): Promise<Language | null> {
```

- **What it does**
  1. Checks the in-memory Promise cache.
  2. Lazily initializes the tree-sitter WASM runtime.
  3. Verifies the grammar WASM exists and is readable.
  4. Runs the PIC side-module guard (`isIncompatiblePicSideModule`) before calling `Language.load()`.
  5. Loads the grammar and caches the Promise permanently.
- **Called by**
  - `getSymbols`
  - `checkSyntaxErrors`
  - `getStructuralFingerprint`
  - `getSymbolStructure`
- **Returns**
  - `Language`, or `null` if the grammar is unavailable/unreadable/incompatible.
- **Filtering / error handling**
  - Returns `null` on missing file or load failure.
  - Writes diagnostics to stderr/console for load/inspection failures.
- **Nuances / gotchas**
  - This is **parse-layer availability**, not symbol-query availability.
  - Languages without `*-tags.scm` can still be parsed by this function.

### `getCompiledQuery`

```ts
export async function getCompiledQuery(langName: string): Promise<Query | null> {
```

- **What it does**
  1. Checks the compiled query cache.
  2. Calls `loadLanguage`.
  3. Reads `<lang>-tags.scm` via `loadQueryString`.
  4. Compiles the query and caches it.
- **Called by**: `getSymbols` only.
- **Returns**
  - `Query`, or `null` if either the language or the tags query is unavailable.
- **Filtering / error handling**
  - Compilation failures are logged and cached as `null`.
- **Nuances / gotchas**
  - This is the hard boundary between **parse-capable** and **symbol-query-capable** languages.
  - If this returns `null`, all symbol lookup APIs built on `getSymbols` return `null` too.

### `treeSitterAvailable`

```ts
export async function treeSitterAvailable(): Promise<boolean> {
```

- **What it does**
  1. Calls `ensureInit()`.
  2. Lists the grammars directory.
  3. Returns `true` if any `.wasm` exists.
- **Called by**: no in-repo callers found.
- **Returns**: boolean health-check result.
- **Nuances / gotchas**
  - This is effectively dead code in the current `src/` tree.
  - It checks runtime availability, not whether a particular language has tags queries.

## 1.3 Symbol extraction and lookup

### `getSymbols`

```ts
export async function getSymbols(source: string, langName: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
```

- **What it does**
  1. Hashes `langName + ':' + source` and checks the shared symbol LRU cache.
  2. Loads the language (`loadLanguage`).
  3. Loads/compiles the tags query (`getCompiledQuery`).
  4. Parses the source with tree-sitter.
  5. Runs `query.matches(tree.rootNode)`.
  6. For each match, finds:
     - one `name.*` capture
     - one `definition.*` or `reference.*` body capture
  7. Builds `SymbolInfo` objects:
     - `name` from the name capture text
     - `kind` = `def` or `ref`
     - `type` from the capture suffix
     - `line`/`column` from the **name** capture start
     - `endLine` from the body capture end if present, else the name capture end
  8. Deduplicates by `${name}:${kind}:${line}`.
  9. Sorts by line.
  10. Caches the unfiltered result, then applies filters.
- **Called by**
  - `getDefinitions`
  - `getSymbolSummary`
  - `findSymbol`
  - `getFileSymbols`
  - `symbol-index.indexFile`
- **Returns**
  - `SymbolInfo[]` on success
  - `null` if the language cannot be loaded or the tags query is unavailable
- **Filtering / disambiguation**
  - Uses internal `applyFilters()` to honor:
    - `kindFilter`
    - `typeFilter`
    - case-insensitive substring `nameFilter`
    - `excludeNames`
- **Nuances / gotchas**
  - `nearLine` exists in `SymbolFilterOptions`, but `applyFilters()` does **not** use it. `nearLine` only matters in `findSymbol()`.
  - `line` is name-based, not body-start-based; decorated constructs can therefore be range-anchored at the name line.
  - `null` means "symbol querying unavailable", not "zero matches".

### `getDefinitions`

```ts
export async function getDefinitions(source: string, langName: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
    return getSymbols(source, langName, { ...options, kindFilter: 'def' });
}
```

- **What it does**: thin wrapper over `getSymbols()` that forces `kindFilter: 'def'`.
- **Called by**
  - `search_files` symbol mode
  - `search_files` definition mode
  - `getCompressionStructure`
- **Returns**: definition-only `SymbolInfo[]`, or `null`.
- **Nuances**
  - This inherits all `getSymbols()` semantics, including `null` when tags queries are missing.
  - Several tools incorrectly treat `null` like "no matches" instead of "symbol querying unavailable".

### `getSymbolSummary`

```ts
export async function getSymbolSummary(source: string, langName: string): Promise<{ defs: Record<string, number>; refs: Record<string, number>; defTotal: number; refTotal: number } | null> {
```

- **What it does**
  1. Calls `getSymbols()`.
  2. Counts definitions and references per `type`.
  3. Returns totals plus per-type maps.
- **Called by**: `getSymbolSummaryString` only.
- **Returns**
  - `{ defs, refs, defTotal, refTotal }`, or `null`.
- **Nuances**
  - Not used by the audited search/refactor tools.

### `getSymbolSummaryString`

```ts
export async function getSymbolSummaryString(source: string, langName: string): Promise<string | null> {
```

- **What it does**
  1. Calls `getSymbolSummary()`.
  2. Formats definition counts in a preferred type order.
  3. Falls back to alphabetical leftovers.
- **Called by**: `getFileSymbolSummary` only.
- **Returns**
  - Human-readable string like `"3 functions, 1 class"`, or `null`.
- **Nuances**
  - Used by `directory`, not by the audited tool modes.

### `findSymbol`

```ts
export async function findSymbol(source: string, langName: string, symbolName: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
```

- **What it does**
  1. Defaults `kindFilter` to `def`.
  2. Splits dot-qualified names (`A.B.method`) into parent qualifiers and a target name.
  3. Calls `getSymbols()` for all matching symbols of the requested kind.
  4. Filters to exact-name matches on the target name.
  5. If the name is qualified, verifies each candidate is nested inside matching parent definitions.
  6. If multiple matches remain and `nearLine` is provided, sorts by distance to `nearLine`.
- **Called by**
  - `search_file` symbol mode
  - `edit-engine.applyEditList` symbol mode
  - `refactor_batch` loadDiff, reapply, and restore
- **Returns**
  - `SymbolInfo[]` sorted by line/proximity, or `null` if symbol queries are unavailable
- **Filtering / disambiguation**
  - Exact name match only (`===`), not substring search.
  - Parent disambiguation is containment-based (`parent.line <= child.line && parent.endLine >= child.endLine`).
- **Nuances / gotchas**
  - It does **not** throw on ambiguity; callers decide whether multiple matches are acceptable.
  - If parent verification needs defs and the def lookup returns `null`, it returns the unverified matches instead of failing.
  - `search_files` definition mode reimplements this logic manually instead of calling `findSymbol()`.

### `getFileSymbols`

```ts
export async function getFileSymbols(filePath: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
```

- **What it does**
  1. Resolves language from the file path.
  2. Reads the file.
  3. Calls `getSymbols()`.
- **Called by**: `directory` only.
- **Returns**: `SymbolInfo[] | null`.
- **Nuances**
  - Not used by the audited tools.

### `getFileSymbolSummary`

```ts
export async function getFileSymbolSummary(filePath: string): Promise<string | null> {
```

- **What it does**
  1. Resolves language.
  2. `stat`s the file.
  3. Skips files larger than 256 KB.
  4. Reads the file and calls `getSymbolSummaryString()`.
- **Called by**: `directory` only.
- **Returns**: summary string or `null`.
- **Nuances**
  - This is another tree-sitter export that is not part of the audited tool flows.

### `checkSyntaxErrors`

```ts
export async function checkSyntaxErrors(source: string, langName: string): Promise<Array<{ line: number; column: number }> | null> {
```

- **What it does**
  1. Loads the language.
  2. Parses the input.
  3. If `rootNode.hasError` is false, returns `[]`.
  4. Walks the tree collecting `ERROR` and `isMissing` nodes.
  5. Stops after 10 errors.
- **Called by**
  - `edit-engine.syntaxWarn`
  - `refactor_batch` apply/reapply/restore syntax gates
- **Returns**
  - `[]` for syntactically clean input
  - up to 10 `{ line, column }` records when parse errors are found
  - `null` when the language cannot be loaded
- **Nuances / gotchas**
  - It works on arbitrary text, including full files or replacement symbol bodies.
  - Since it uses only `loadLanguage()`, it also works for parse-only languages.

## 1.4 Structural analysis helpers

### `getStructuralFingerprint`

```ts
export async function getStructuralFingerprint(source: string, langName: string, startLine: number, endLine: number): Promise<string[]> {
```

- **What it does**
  1. Loads the language and parses the file.
  2. Walks the whole AST.
  3. Appends `node.type` for every node whose **start row** falls inside the requested line range.
- **Called by**: `search_files` structural mode.
- **Returns**
  - Ordered `string[]` fingerprint.
  - `[]` on parse/language failure.
- **Nuances / gotchas**
  - It is range-based, not symbol-name-based.
  - Nodes that overlap the range but start before it are excluded.
  - No tags query is required; only the parser must load.

### `computeStructuralSimilarity`

```ts
export function computeStructuralSimilarity(fingerprintA: string[], fingerprintB: string[]): number {
```

- **What it does**
  1. Builds 3-gram sets from both fingerprints.
  2. Computes Jaccard similarity.
  3. Special-cases very short fingerprints: if both have no 3-grams, it falls back to full sequence equality.
- **Called by**: `search_files` structural mode.
- **Returns**: number from `0.0` to `1.0`.
- **Nuances**
  - Structural mode hard-codes a `>= 0.5` acceptance threshold in the tool.

### `getSymbolStructure`

```ts
export async function getSymbolStructure(source: string, langName: string, startLine: number, endLine: number): Promise<SymbolStructure | null> {
```

- **What it does**
  1. Loads the language and parses the source.
  2. Walks the tree looking for a node whose `type` is in `DEF_TYPES` and whose start/end rows exactly match the supplied range.
  3. Extracts a compact structural signature:
     - parameter node types
     - return type node kind
     - nearest parent def/program/module kind
     - decorators
     - modifiers (`async`, `static`, `public`, etc.)
- **Called by**: `refactor_batch` loadDiff and reapply outlier detection.
- **Returns**: `SymbolStructure | null`.
- **Filtering / error handling**
  - Returns `null` if no matching def node is found.
- **Nuances / gotchas**
  - This depends on the input line range exactly matching the AST def node range.
  - Because `findSymbol()` ranges are name-anchored, unusual grammars/decorator layouts can produce `null` here.
  - Like `getStructuralFingerprint`, this only requires parser availability.

### `getCompressionStructure`

```ts
export async function getCompressionStructure(source?: string, langName?: string): Promise<BlockEntry[] | null> {
```

- **What it does**
  1. Calls `getDefinitions()` to get definition blocks.
  2. Converts defs into block entries.
  3. Drops nested/duplicate blocks.
  4. If the language has anchor rules, parses the file and attaches control-flow/call anchors to the innermost containing block.
- **Called by**: `core/toon_bridge.ts` only.
- **Returns**
  - `null` if symbol queries are unavailable
  - `[]` if defs are available but none were found
  - `BlockEntry[]` otherwise
- **Nuances**
  - Not used by `search_file`, `search_files`, `refactor_batch`, or `edit_file`.
  - It is structural analysis, but it is part of compression, not symbol lookup.

---

## 2. Symbol index functions (the DB/indexing layer)

## 2.1 Infrastructure helpers

### `findRepoRoot`

```ts
export function findRepoRoot(filePath: string): string | null {
```

- **What it does**
  1. Resolves the directory to run in.
  2. Runs `git rev-parse --show-toplevel`.
- **Called by**
  - `edit_file` snapshot path resolution
  - `refactor_batch` restore mode
- **Returns**: repo root or `null`.
- **Nuances**
  - If Git lookup fails, callers fall back to a directory/project-context heuristic.

### `getDb`

```ts
export function getDb(repoRoot: string): DbConnection {
```

- **What it does**
  1. Reuses a cached `DbConnection` per repo root.
  2. Ensures `.mcp/` exists and contains a `.gitignore`.
  3. Opens `.mcp/symbols.db`.
  4. Initializes schema.
  5. Registers a process-exit close handler once.
  6. Prunes expired versions on open.
- **Called by**
  - `search_files` structural mode
  - `edit_file`
  - `refactor_batch`
- **Returns**: open `DbConnection`.
- **Nuances**
  - Version pruning is best-effort; migration issues are swallowed.

### `getSessionId`

```ts
export function getSessionId(clientSessionId?: string): string {
```

- **What it does**: uses the tool session id if present; otherwise synthesizes `${pid}:${cwd}`.
- **Called by**
  - `edit_file`
  - `refactor_batch`
- **Returns**: session identifier string.
- **Nuances**
  - Version history is session-scoped, so this value directly affects what history/restore can see.

### `pruneOldSessions`

```ts
export function pruneOldSessions(db: DbConnection, currentSessionId: string): void {
    pruneOtherSessions(db, currentSessionId);
}
```

- **What it does**: wrapper around `pruneOtherSessions()`.
- **Called by**: no in-repo callers found.
- **Nuances**
  - Dead/unwired in the current codebase.

## 2.2 Internal indexing gates

### `shouldIndexFile`

```ts
function shouldIndexFile(repoRoot: string, absPath: string): boolean {
```

- **What it does**
  1. Requires `isSupported(absPath)`.
  2. Rejects `isSensitive(absPath)`.
  3. Rejects excluded directory segments.
  4. Rejects excluded basenames/glob patterns against relative paths.
- **Called by**
  - `indexFile`
  - `indexDirectory`
  - `ensureIndexFresh`
- **Returns**: boolean.
- **Nuances**
  - This is the index’s main scope filter.
  - Parse-only languages pass this gate, but later may still be purged if `getSymbols()` returns `null`.

### `purgeIndexedPath`

```ts
function purgeIndexedPath(db: DbConnection, relPath: string): void {
```

- **What it does**
  1. Starts a transaction.
  2. Deletes all symbol rows for the file.
  3. Deletes the file row.
- **Called by**
  - `indexFile`
  - `indexDirectory` stale-row cleanup
  - `ensureIndexFresh`
- **Returns**: void.
- **Nuances**
  - Any unreadable, unsupported, excluded, or symbol-query-unavailable file gets removed from the index.

## 2.3 Index build/refresh

### `indexFile`

```ts
export async function indexFile(db: DbConnection, repoRoot: string, absFilePath: string): Promise<void> {
```

- **What it does**
  1. Converts the path to repo-relative form and rejects path escapes.
  2. Applies `shouldIndexFile()`; non-eligible files are purged.
  3. Reads the file; unreadable files are purged.
  4. Hashes content and skips unchanged files via `getFileHash()`.
  5. Resolves language with `getLangForFile()`; if missing, purges.
  6. Calls `getSymbols()`; if it returns `null`, purges.
  7. Splits symbols into defs and refs.
  8. Inside one transaction:
     - deletes old symbols
     - upserts the `files` row
     - inserts defs into `symbols`
     - inserts refs into `symbols`
     - for each ref, finds the **innermost containing def** and inserts an `edges` row from that def to `ref.name`
- **Called by**
  - `indexDirectory`
  - `ensureIndexFresh`
  - `refactor_batch` restore (after write)
- **Returns**: `Promise<void>`.
- **Filtering / error handling**
  - Errors mostly cause purge-and-return rather than exceptions.
- **Nuances / gotchas**
  - The graph is **name-based**, not resolved-definition-based.
  - The "caller" of a ref is inferred by line containment only.
  - Files in languages with parsers but no tags query are removed from the index entirely.

### `indexDirectory`

```ts
export async function indexDirectory(db: DbConnection, repoRoot: string, dirPath: string, opts: IndexDirectoryOpts = {}): Promise<void> {
```

- **What it does**
  1. Recursively walks `dirPath` up to `maxFiles`.
  2. Uses `shouldIndexFile()` to decide which files to visit.
  3. Computes the set of visited repo-relative paths.
  4. Uses `getFilesByPrefix()` to find already-indexed rows under the same directory and purges anything not visited this run.
  5. Calls `indexFile()` in batches of 50.
- **Called by**
  - `search_files` structural mode
  - `refactor_batch` query mode
- **Returns**: `Promise<void>`.
- **Nuances**
  - This both adds/updates rows and purges stale rows in the indexed subtree.
  - `search_files` structural mode passes `maxFiles: 2000`; `refactor_batch` broad query uses `5000`.

### `ensureIndexFresh`

```ts
export async function ensureIndexFresh(db: DbConnection, repoRoot: string, absFilePaths: string[]): Promise<number> {
```

- **What it does**
  1. Iterates only the supplied file list.
  2. Re-applies `shouldIndexFile()`.
  3. Reads the file and rehashes it.
  4. Re-indexes only when the stored hash differs.
- **Called by**
  - `refactor_batch` query mode (best-effort refresh of known indexed files)
  - `refactor_batch` apply/reapply (after writes)
- **Returns**: number of reindexed files.
- **Nuances / gotchas**
  - It does **not** discover new files; it only refreshes explicitly supplied paths.

## 2.4 Graph traversal / impact analysis

### `impactQuery`

```ts
export function impactQuery(db: DbConnection, symbolName: string, opts: ImpactQueryOpts = {}): ImpactDisambiguate | ImpactSuccess {
```

- **What it does**
  1. Finds all definition files for `symbolName` via `findSymbolFiles()`.
  2. If multiple def files exist and no `file` constraint was supplied, returns a disambiguation payload instead of traversing.
  3. Traverses the graph breadth-first up to `depth`.
  4. Uses:
     - `getCallers()` / `getCallersFiltered()` for forward mode
     - `getCallees()` / `getCalleesFiltered()` for reverse mode
  5. Applies the `file` constraint **only on the first hop**.
  6. Deduplicates visited nodes by symbol name.
- **Called by**: `refactor_batch` query mode.
- **Returns**
  - `{ disambiguate: true, definitions: string[] }`, or
  - `{ results: ImpactResult[], total: number }`
- **Filtering / error handling**
  - Filtered variants try to reduce same-name contamination on the first hop.
- **Nuances / gotchas**
  - This is a **heuristic call graph** built from name references, not semantic resolution.
  - Visited-state uses only the symbol name, so same-name defs in different files collapse together after disambiguation.

## 2.5 Versioning

### `snapshotSymbol`

```ts
export function snapshotSymbol(db: DbConnection, symbolName: string, filePath: string | null, originalText: string, sessionId: string, line: number | null = null): void {
```

- **What it does**
  1. MD5-hashes the original text.
  2. Calls `snapshotVersion()` with symbol name, file path, session id, timestamp, line, and `textHash`.
- **Called by**
  - `edit_file`
  - `refactor_batch` apply/reapply/restore
  - `stash_restore` (outside the requested tool list)
- **Returns**: void.
- **Nuances**
  - The DB schema deduplicates identical snapshots per `(symbol_name, file_path, text_hash, session_id)`.

### `getVersionHistory`

```ts
export function getVersionHistory(db: DbConnection, symbolName: string, sessionId: string, filePath?: string): ReturnType<typeof adapterGetVersionHistory> {
```

- **What it does**: thin wrapper around the adapter query.
- **Called by**: `refactor_batch` history and restore modes.
- **Returns**: newest-first version rows for the current session.
- **Nuances**
  - Session-scoped: older snapshots from other sessions are invisible.

### `getVersionText`

```ts
export function getVersionText(db: DbConnection, versionId: number): string | null {
```

- **What it does**: wrapper around adapter text lookup.
- **Called by**: `refactor_batch` restore mode.
- **Returns**: stored symbol body or `null`.

### `restoreVersion`

```ts
export function restoreVersion(db: DbConnection, symbolName: string, versionId: number, sessionId: string, currentText?: string): string {
```

- **What it does**
  1. Loads version metadata.
  2. Verifies symbol name and session ownership.
  3. Optionally snapshots `currentText` before restore.
  4. Returns the stored version text.
- **Called by**: no in-repo callers found.
- **Returns**: restored text string, or throws.
- **Nuances / gotchas**
  - This helper is effectively dead code.
  - `refactor_batch` restore reimplements restore behavior itself so it can also do file staleness checks, live symbol re-location, syntax warnings, and atomic writeback.

---

## 3. DB adapter symbol-related queries (the raw SQL layer)

This section covers the raw SQL helpers that the higher layers actually rely on.

## 3.1 File-table helpers that support symbol indexing

### `getFileHash`

```ts
export function getFileHash(conn: DbConnection, filePath: string): string | null {
```

- **What it does**: `SELECT hash FROM files WHERE path = ?`.
- **Called by**: `symbol-index.indexFile`, `symbol-index.ensureIndexFresh`, `refactor_batch` restore staleness check.
- **Returns**: stored content hash or `null`.

### `getFilesByPrefix`

```ts
export function getFilesByPrefix(conn: DbConnection, prefix: string): { path: string }[] {
```

- **What it does**: `SELECT path FROM files WHERE path LIKE ?`.
- **Called by**: `symbol-index.indexDirectory` stale-row cleanup.
- **Returns**: indexed file rows under a prefix.

### `getFileCount`

```ts
export function getFileCount(conn: DbConnection): number {
```

- **What it does**: `SELECT COUNT(*) AS n FROM files`.
- **Called by**: `refactor_batch` query mode.
- **Returns**: number of indexed files.
- **Nuances**
  - `refactor_batch` uses `count === 0` as a signal to rebuild broadly.

### `getFilePaths`

```ts
export function getFilePaths(conn: DbConnection): { path: string }[] {
```

- **What it does**: `SELECT path FROM files`.
- **Called by**: `refactor_batch` query mode background refresh.
- **Returns**: all indexed repo-relative paths.

## 3.2 Symbol-table writes and lookups

### `insertSymbol`

```ts
export function insertSymbol(
    conn: DbConnection,
    symbol: {
```

- **What it does**: inserts one row into `symbols`.
- **Called by**: `symbol-index.indexFile`.
- **Returns**: inserted row id.
- **Nuances**
  - `indexFile` stores both defs and refs in the same table and distinguishes them with `kind`.

### `deleteSymbolsByFile`

```ts
export function deleteSymbolsByFile(conn: DbConnection, filePath: string): void {
```

- **What it does**: `DELETE FROM symbols WHERE file_path = ?`.
- **Called by**: `symbol-index.purgeIndexedPath`, `symbol-index.indexFile`.
- **Returns**: void.

### `findSymbolFiles`

```ts
export function findSymbolFiles(conn: DbConnection, name: string, kind: string): { file_path: string }[] {
```

- **What it does**: `SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = ?`.
- **Called by**
  - `symbol-index.impactQuery`
  - `refactor_batch` loadDiff and reapply resolution
- **Returns**: distinct files only.
- **Nuances**
  - This does not return line ranges, so callers often need a second live parse.

### `findSymbolDetails`

```ts
export function findSymbolDetails(conn: DbConnection, name: string, kind: string): { file_path: string; line: number; end_line: number; kind: string; type: string }[] {
```

- **What it does**: exact-name lookup in `symbols` returning file/line/type metadata.
- **Called by**: `search_files` structural mode.
- **Returns**: detail rows.

### `findSymbolDetailsScoped`

```ts
export function findSymbolDetailsScoped(conn: DbConnection, name: string, kind: string, filePrefix: string): { file_path: string; line: number; end_line: number; kind: string; type: string }[] {
```

- **What it does**: same as `findSymbolDetails`, but constrained by `file_path LIKE ?`.
- **Called by**: `search_files` structural mode.
- **Returns**: scoped detail rows.

### `findStructuralCandidates`

```ts
export function findStructuralCandidates(
    conn: DbConnection,
    opts?: { type?: string; filePrefix?: string }
```

- **What it does**
  1. Builds SQL dynamically from `symbols WHERE kind = 'def'`.
  2. Optionally adds `AND type = ?`.
  3. Optionally adds `AND file_path LIKE ?`.
  4. Orders by symbol name.
- **Called by**: `search_files` structural mode.
- **Returns**: `{ name, file_path, line, end_line }[]`.
- **Nuances**
  - Candidate ranking happens later in live-parse code, not here.

## 3.3 Edge-table writes and graph queries

### `insertEdge`

```ts
export function insertEdge(conn: DbConnection, containerDefId: number, referencedName: string): void {
```

- **What it does**: inserts one `edges` row.
- **Called by**: `symbol-index.indexFile`.
- **Returns**: void.
- **Nuances**
  - Edges are stored as `(container_def_id, referenced_name)`, so the graph is reference-name-based.

### `getCallers`

```ts
export function getCallers(conn: DbConnection, referencedName: string): { name: string; file_path: string; refCount: number }[] {
```

- **What it does**
  1. Joins `edges` to `symbols` on `container_def_id`.
  2. Filters by `e.referenced_name = ?` and `s.kind = 'def'`.
  3. Groups by caller symbol name + file.
- **Called by**: `symbol-index.impactQuery` forward mode.
- **Returns**: caller rows with counts.

### `getCallees`

```ts
export function getCallees(conn: DbConnection, symbolName: string): { name: string; callCount: number }[] {
```

- **What it does**
  1. Joins `edges` to the containing def symbol row.
  2. Filters by `s.name = ?` and `s.kind = 'def'`.
  3. Groups by `e.referenced_name`.
- **Called by**: `symbol-index.impactQuery` reverse mode.
- **Returns**: callee-name rows with counts.
- **Nuances**
  - File is not returned here, because the query is already anchored to the caller symbol name.

### `getCallersFiltered`

```ts
export function getCallersFiltered(
    conn: DbConnection,
    referencedName: string,
    originSymbol: string,
    originFile: string
): { name: string; file_path: string; refCount: number }[] {
```

- **What it does**
  1. Performs the same base join as `getCallers()`.
  2. Excludes caller files that define a competing symbol with the same name in another file.
- **Called by**: `symbol-index.impactQuery` forward first-hop when a file constraint exists.
- **Returns**: filtered caller rows.
- **Nuances / gotchas**
  - This is a heuristic to reduce same-name cross-file pollution; it is not full symbol resolution.

### `getCalleesFiltered`

```ts
export function getCalleesFiltered(conn: DbConnection, symbolName: string, filePath: string): { name: string; callCount: number }[] {
```

- **What it does**: same as `getCallees()`, but also filters `s.file_path = ?`.
- **Called by**: `symbol-index.impactQuery` reverse first-hop when a file constraint exists.
- **Returns**: scoped callee rows.

## 3.4 Version-table helpers

### `snapshotVersion`

```ts
export function snapshotVersion(
    conn: DbConnection,
    entry: {
```

- **What it does**: `INSERT OR IGNORE` into `versions`.
- **Called by**: `symbol-index.snapshotSymbol`.
- **Returns**: void.
- **Nuances**
  - Dedup relies on the unique index over `(symbol_name, file_path, text_hash, session_id)`.

### `getVersionHistory`

```ts
export function getVersionHistory(
    conn: DbConnection,
    symbolName: string,
    sessionId: string,
    filePath?: string
): { id: number; symbol_name: string; file_path: string; created_at: number; text_hash: string }[] {
```

- **What it does**
  1. Selects version rows for a symbol + session.
  2. Optionally constrains by file path.
  3. Orders newest first.
- **Called by**
  - `symbol-index.getVersionHistory`
  - `refactor_batch` history/restore via that wrapper
- **Returns**: history rows.
- **Nuances**
  - It does **not** return `line`; `refactor_batch` extends the row type locally because the DB can contain that column.

### `getVersionText`

```ts
export function getVersionText(conn: DbConnection, id: number): string | null {
```

- **What it does**: selects `original_text` by version id.
- **Called by**
  - `symbol-index.getVersionText`
  - `refactor_batch` restore via that wrapper
- **Returns**: stored text or `null`.

### `getVersionMeta`

```ts
export function getVersionMeta(conn: DbConnection, id: number): { original_text: string; symbol_name: string; session_id: string } | null {
```

- **What it does**: reads enough metadata to validate a restore.
- **Called by**: `symbol-index.restoreVersion` only.
- **Returns**: meta row or `null`.
- **Nuances**
  - Because `restoreVersion` is unused, this is effectively unused in current tool flows.

### `pruneOldVersions`

```ts
export function pruneOldVersions(conn: DbConnection, beforeTimestamp: number): void {
```

- **What it does**: deletes expired version rows.
- **Called by**: `symbol-index.getDb`.
- **Returns**: void.

### `pruneOtherSessions`

```ts
export function pruneOtherSessions(conn: DbConnection, keepSessionId: string): void {
```

- **What it does**: deletes all versions not owned by one session.
- **Called by**: `symbol-index.pruneOldSessions` only.
- **Nuances**
  - Unused because `pruneOldSessions` is unused.

## 3.5 Transaction support

### `runTransaction`

```ts
export function runTransaction(conn: DbConnection, fn: () => void): void {
```

- **What it does**
  1. Starts `BEGIN` for top-level calls.
  2. Uses nested `SAVEPOINT`s for re-entrant calls.
  3. Commits/releases on success.
  4. Rolls back on error.
- **Called by**
  - `symbol-index.purgeIndexedPath`
  - `symbol-index.indexFile`
- **Returns**: void.
- **Nuances**
  - This is what makes file reindexing atomic at the DB level.

---

## 4. Tool-level usage map

## 4.1 `search_file.ts`

### Symbol mode

Flow:

```text
validatePath
  -> getLangForFile(validPath)
  -> fs.readFile(validPath)
  -> findSymbol(source, langName, args.symbol, { kindFilter: 'def', nearLine? })
  -> slice source lines using sym.line..sym.endLine
```

Behavior:
- Requires a single file and a single symbol name.
- Uses **live tree-sitter parsing only**; no DB index.
- Rejects unsupported extensions early.
- If `findSymbol()` returns multiple matches and `nearLine` is missing, it throws `Multiple matches. Use nearLine.`

Gotchas:
- It collapses `findSymbol() === null` and `findSymbol().length === 0` into the same `Symbol not found.` path. So parse-only languages with no tags query get a misleading error.

## 4.2 `search_files.ts`

### Mode: `symbol`

Flow:

```text
discover candidate files (ripgrep or JS walk)
  -> isSupported(file)
  -> getLangForFile(file)
  -> fs.readFile(file)
  -> getDefinitions(source, langName, symOpts)
  -> format results
```

Behavior:
- Live parses every candidate file in batches.
- Does **not** use the DB index.
- `listAll` mode (`symbolQuery` omitted) lists every definition found.
- Query mode uses `nameFilter` substring matching and optional `typeFilter`.

Gotchas:
- This is substring search, not exact symbol resolution.
- Large files over 512 KB are skipped.
- If `getDefinitions()` returns `null`, the file is silently treated as having no symbols.

### Mode: `definition`

Flow:

```text
discover candidate files
  -> isSupported(file)
  -> getLangForFile(file)
  -> fs.readFile(file)
  -> getDefinitions(source, langName)
  -> manual exact-name + parent-containment filtering
```

Behavior:
- Searches for files defining an exact symbol name.
- Supports dot-qualified names by duplicating the containment logic from `findSymbol()`.

Gotchas / inconsistencies:
- This mode **does not call `findSymbol()`** even though it reimplements the same qualifier logic.
- Output paths are absolute (`filePath`) here, while symbol mode uses root-relative paths.
- Missing tags queries are again treated as "no matches".

### Mode: `structural`

Flow:

```text
resolveProjectRoot
  -> getDb(repoRoot)
  -> indexDirectory(db, repoRoot, rootPath)
  -> findSymbolDetails / findSymbolDetailsScoped for the query symbol
  -> getStructuralFingerprint(query symbol)
  -> findStructuralCandidates(db, { type?, filePrefix? })
  -> getStructuralFingerprint(each candidate)
  -> computeStructuralSimilarity(queryFp, candidateFp)
```

Behavior:
- This is the clearest hybrid flow in the codebase:
  - **DB index** finds the query symbol and candidate defs.
  - **Live parsing** computes fingerprints and similarity.
- Uses a fixed similarity threshold of `0.5`.

Gotchas / inconsistencies:
- If multiple indexed defs exist for the query symbol, the tool returns a disambiguation message and asks the caller to narrow the `path`; there is no dedicated file argument.
- Self-skip logic checks only `cand.name === args.structuralQuery && cand.file_path === qRow.file_path`, not line number, so same-name defs in the same file are all skipped.

### Modes: `content` and `files`

- These do not use the symbol stack and are outside this audit.

## 4.3 `refactor_batch.ts`

### Mode: `query`

Flow:

```text
getDb(repoRoot)
  -> if empty/broad scope: indexDirectory(...)
  -> else best-effort ensureIndexFresh(...)
  -> impactQuery(db, target, { file, depth, direction })
```

Behavior:
- Pure **indexed DB graph traversal**.
- No live tree-sitter lookups in the query result itself.

Gotchas:
- The graph is name-based, so same-name symbols can still contaminate results.
- File constraint is only applied on hop 1 inside `impactQuery()`.

### Mode: `loadDiff`

Flow:

```text
(selection)
  -> possibly resolve files via findSymbolFiles(db, symbol, 'def')
  -> fs.readFile(file)
  -> getLangForFile(file)
  -> findSymbol(source, langName, symbol, { kindFilter: 'def' })
  -> getSymbolStructure(...) for outlier detection
```

Behavior:
- Starts from indexed query output or explicit symbol/file pairs.
- Switches to **live tree-sitter** to find exact symbol bodies.
- Adds structural outlier flags by comparing `getSymbolStructure()` results to the modal shape for each symbol group.

Gotchas:
- If `findSymbol()` returns `null` (tags query unavailable), the occurrence is silently skipped.
- Outlier detection depends on exact line-range alignment.

### Mode: `apply`

Flow:

```text
cached loadDiff occurrences
  -> parse payload groups
  -> syntax-check each replacement body via checkSyntaxErrors
  -> bundle edits per file
  -> applyEditList(content, edits, disambiguations)
  -> full-file checkSyntaxErrors(result.workingContent)
  -> atomic write
  -> snapshotSymbol(...)
  -> ensureIndexFresh(...)
```

Behavior:
- Uses live symbol resolution via `applyEditList()` (which itself calls `findSymbol()` in symbol mode).
- Rebuilds index entries after successful writes.

Gotchas:
- Final edit targeting is live-parse-based, not index-based.
- Outlier acknowledgements are enforced before any write.
- Per-file atomicity is preserved even if one edit in the bundle fails.

### Mode: `reapply`

Flow:

```text
cached successful payload
  -> resolve new targets via findSymbolFiles(db, ...) if needed
  -> fs.readFile + findSymbol(...)
  -> optional getSymbolStructure(...) outlier gate
  -> applyEditList(...)
  -> checkSyntaxErrors(full file)
  -> write + snapshotSymbol + ensureIndexFresh
```

Behavior:
- DB is used for candidate file discovery.
- Live parse is used again for exact replacement boundaries.

### Modes: `history` and `restore`

Flow:

```text
history:
  getVersionHistory(db, symbol, sessionId, relPath?)

restore:
  getVersionHistory(...)
    -> getVersionText(versionId)
    -> fs.readFile(current file)
    -> getFileHash(db, relPath) for staleness warning
    -> getLangForFile(absPath)
    -> findSymbol(current content, langName, symbol, { kindFilter: 'def' })
    -> snapshotSymbol(current text)
    -> atomic write
    -> indexFile(...)
```

Behavior:
- Version lookup is DB-backed.
- Actual restore target selection is live-parse-based.
- When multiple current matches exist, restore first tries the stored snapshot line, then falls back to a shared-line-overlap heuristic against the stored text.

Gotchas / inconsistencies:
- `refactor_batch` does **not** use `symbol-index.restoreVersion()`; it implements a richer restore flow itself.

## 4.4 `edit_file.ts` + `core/edit-engine.ts`

### `edit_file` symbol mode path

Flow:

```text
edit_file
  -> applyEditList(originalContent, edits, { filePath, isBatch })
     -> symbol edit branch
        -> getLangForFile(filePath)
        -> findSymbol(workingContent, langName, symbol, { kindFilter: 'def', nearLine? })
        -> replace sym.line..sym.endLine in workingContent
        -> record pendingSnapshots
  -> atomic write
  -> snapshotSymbol(...) for pendingSnapshots
  -> syntaxWarn(validPath, workingContent)
```

Behavior:
- This is a pure live-parse edit path.
- Every edit runs against the **current `workingContent`**, so later edits see earlier edits.

Important edit-engine nuances:
- If `findSymbol()` returns `null`, edit-engine emits a good, explicit message:
  - `Symbol queries not available for <langName> ... Use block or content mode instead.`
- If there are multiple matches and no `nearLine`, edit-engine returns `Multiple matches. Use nearLine.`
- `syntaxWarn()` uses `checkSyntaxErrors()` after the write calculation, but suppresses warnings for `.mdx`, `.jsonc`, `.json5`, `.jsonl`, and `.ndjson` because strict grammars would be misleading there.

---

## 5. Data flow diagrams

## 5.1 Single-file exact symbol lookup (`search_file`)

```text
file path
  -> getLangForFile
  -> findSymbol
      -> getSymbols
          -> loadLanguage
          -> getCompiledQuery
          -> tree-sitter parse + tags query matches
  -> return exact source slice
```

## 5.2 Cross-file symbol listing (`search_files` symbol/definition)

```text
directory
  -> discover files
  -> isSupported / getLangForFile
  -> getDefinitions per file
      -> getSymbols
  -> filter/format results
```

This is entirely live-parse, repeated file-by-file.

## 5.3 Structural similarity (`search_files` structural)

```text
directory
  -> getDb
  -> indexDirectory
      -> indexFile
          -> getSymbols
          -> insertSymbol / insertEdge
  -> findSymbolDetails* for the query symbol
  -> live-parse query file -> getStructuralFingerprint
  -> findStructuralCandidates from DB
  -> live-parse each candidate -> getStructuralFingerprint
  -> computeStructuralSimilarity
```

This is the strongest DB + live hybrid in the codebase.

## 5.4 Refactor/query/edit lifecycle

```text
query mode:
  indexDirectory / ensureIndexFresh
    -> impactQuery (DB graph)

loadDiff:
  findSymbolFiles? (DB)
    -> findSymbol (live)
    -> getSymbolStructure (live)

apply/reapply:
  applyEditList
    -> findSymbol (live)
  snapshotSymbol (DB versions)
  ensureIndexFresh / indexFile (DB refresh)
```

The refactor pipeline uses the DB for coarse discovery/history and live parsing for the actual write target.

---

## 6. Comparison: live-parse vs. indexed approaches

| Aspect | Live tree-sitter parse | Indexed DB approach |
|---|---|---|
| Primary entry points | `findSymbol`, `getDefinitions`, `checkSyntaxErrors`, `getStructuralFingerprint`, `getSymbolStructure` | `indexFile`, `indexDirectory`, `impactQuery`, `findSymbolFiles`, `findSymbolDetails*`, version queries |
| Source of truth | Current file contents on disk (or in-memory `workingContent`) | Last indexed snapshot in `.mcp/symbols.db` |
| Best at | Exact edit boundaries, current code, syntax gates, structural comparison | Broad repo discovery, repeated queries, graph traversal, version history |
| Weak at | Repo-wide scans can be expensive; repeated file parses | Can become stale; graph is only name-based; parse-only/no-tags languages disappear from the index |
| Requires tags query? | For symbol lookups yes; for syntax/structure no | Yes, because indexing depends on `getSymbols()` |
| Disambiguation style | `nearLine`, parent containment, current file text | file-level disambiguation, graph traversal heuristics |

### Practical relationship in Zenith today

1. **The DB is not authoritative for edit boundaries.**
   - Even after querying the DB, refactor and edit flows re-run live `findSymbol()` before modifying text.
2. **The DB is authoritative only for coarse discovery/history.**
   - `impactQuery`, `findSymbolFiles`, `findSymbolDetails*`, and version history all come from SQLite.
3. **Structural mode is intentionally mixed.**
   - DB narrows the candidate set; live parsing computes the actual structural similarity.
4. **Parse-only languages split the system.**
   - `loadLanguage()` can succeed while `getCompiledQuery()` fails.
   - Result: syntax checks and structural fingerprints work, but `getSymbols()`/`findSymbol()`/indexing do not.

### Most important inconsistencies to address in a refactor

1. **Missing-tags behavior is inconsistent.**
   - `edit-engine` reports it explicitly.
   - `search_file`, `search_files`, and parts of `refactor_batch` mostly collapse it into "not found" or silent skipping.
2. **Exact symbol resolution is duplicated.**
   - `findSymbol()` exists, but `search_files` definition mode reimplements qualified-name containment manually.
3. **Tool outputs disagree on path style.**
   - Some modes return relative paths; others return absolute paths.
4. **The graph is name-based, not semantic.**
   - `edges.referenced_name` stores only raw names, so overloads/shadowing are heuristic territory.
5. **The index excludes parse-only languages entirely.**
   - Live syntax/structure can still work for those languages, but repo-wide indexed features cannot.
6. **There is dead/unused API surface.**
   - `treeSitterAvailable`, `pruneOldSessions`, and `restoreVersion` have no in-repo callers.

### Dead code / not used by the audited tools

- **No in-repo callers found**
  - `treeSitterAvailable`
  - `pruneOldSessions`
  - `restoreVersion`
- **Used elsewhere, but not by `search_file` / `search_files` / `refactor_batch` / `edit_file`**
  - `getFileSymbols`
  - `getFileSymbolSummary`
  - `getSymbolSummary`
  - `getSymbolSummaryString`
  - `getCompressionStructure`

---

## Bottom line

Zenith currently has a deliberate split:
- **Live parsing** is the precise, current-state mechanism.
- **SQLite indexing** is the scalable, approximate discovery mechanism.

The refactor pressure points are not just performance; they are semantic consistency:
- one exact-symbol lookup path
- one consistent "unsupported vs not found" contract
- one consistent path/output contract
- a clearer contract for when the DB may be stale or approximate
- a decision on whether the graph should stay name-based or become symbol-identity-based
