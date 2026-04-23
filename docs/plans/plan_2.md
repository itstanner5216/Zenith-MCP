# Refactor Batch Tool — Execution Plan

**Goal:** Implement `batched_symbol_editing.md` end-to-end. Wire the existing symbol-versioning subsystem into all symbol-mode write paths, then ship the new `refactor_batch` MCP tool with `query`/`load`/`apply`/`reapply` modes plus harden SQLite for parallel sub-agent use.

**Baseline assumed:** the prior cleanup plan has already been executed. `dist/core/edit-engine.js` exists and exports `findMatch`, `applyEditList(content, edits, {filePath, isBatch, disambiguations?}) → {workingContent, errors[]}`, `syntaxWarn(filePath, content)`. `dist/tools/edit_file.js` and `dist/tools/stash_restore.js` are lean and consume the engine. `dist/tools/_parked_batch_analysis.js` is deleted.

**Total Waves:** 2
**Total Tasks:** 8
**Max Parallel Tasks in Single Wave:** 7

---

## Wave 1: Versioning Wiring + Tool Foundation (7 tasks in parallel)

> **PARALLEL EXECUTION:** All 7 tasks run simultaneously. Each task touches a unique file. Every cross-task contract is fully specified in this plan, so no task needs another task's output on disk.
>
> **Dependencies:** None — runs against post-cleanup baseline.
>
> **File Safety:**
> - `dist/core/symbol-index.js`: only Task 1.1 ✓
> - `dist/core/edit-engine.js`: only Task 1.2 ✓
> - `dist/tools/edit_file.js`: only Task 1.3 ✓
> - `dist/tools/stash_restore.js`: only Task 1.4 ✓
> - `dist/core/tree-sitter.js`: only Task 1.5 ✓
> - `dist/tools/refactor_batch.js`: only Task 1.6 (CREATE) ✓
> - `dist/core/server.js`: only Task 1.7 ✓

---

### Task 1.1: Harden `dist/core/symbol-index.js` for parallel sub-agent use

**File:** Modify `dist/core/symbol-index.js`

**Codebase References:**
- Existing `getDb(repoRoot)` at `dist/core/symbol-index.js:36-109`
- Existing `versions` table at `dist/core/symbol-index.js:72-79`
- Existing line column migration at `dist/core/symbol-index.js:96`
- Existing `snapshotSymbol` at `dist/core/symbol-index.js:359-363`
- Existing `pruneOldSessions` at `dist/core/symbol-index.js:120-122`

**Implementation:**

1. **Add concurrency-safe pragmas** in `getDb()` immediately after the existing `db.pragma('journal_mode = WAL')` line (around line 48):
   ```js
   db.pragma('synchronous = NORMAL');
   db.pragma('busy_timeout = 5000');
   ```

2. **Add a `text_hash` column to `versions` for idempotent dedup.** After the existing line-column migration block (line 95-96), add:
   ```js
   try { db.exec('ALTER TABLE versions ADD COLUMN text_hash TEXT'); } catch { /* already exists */ }
   try {
       db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
   } catch { /* tolerate pre-existing duplicates */ }
   ```

3. **Modify `snapshotSymbol`** (lines 359-363) to compute and store the hash and use `INSERT OR IGNORE` so concurrent agents writing the same snapshot dedupe silently:
   ```js
   export function snapshotSymbol(db, symbolName, filePath, originalText, sessionId, line) {
       const textHash = createHash('md5').update(originalText || '').digest('hex');
       db.prepare(
           'INSERT OR IGNORE INTO versions (symbol_name, file_path, original_text, session_id, created_at, line, text_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
       ).run(symbolName, filePath, originalText, sessionId, Date.now(), line ?? null, textHash);
   }
   ```
   `createHash` is already imported at line 5.

4. **Add a TTL prune helper** below `pruneOldSessions` (around line 122):
   ```js
   export function pruneOldVersions(db, ttlMs) {
       const cutoff = Date.now() - ttlMs;
       db.prepare('DELETE FROM versions WHERE created_at < ?').run(cutoff);
   }

   export function defaultVersionTtlMs() {
       const hours = Number(process.env.REFACTOR_VERSION_TTL_HOURS) || 24;
       return hours * 60 * 60 * 1000;
   }
   ```

5. **Call `pruneOldVersions` on first DB open.** Inside `getDb()`, just before `_dbCache.set(repoRoot, db); return db;` (lines 107-108), add:
   ```js
   try { db.prepare('DELETE FROM versions WHERE created_at < ?').run(Date.now() - (Number(process.env.REFACTOR_VERSION_TTL_HOURS) || 24) * 60 * 60 * 1000); } catch { /* table may be mid-migration */ }
   ```

**Acceptance Criteria:**
- [ ] `node -c dist/core/symbol-index.js` passes
- [ ] `getDb()` sets `synchronous=NORMAL` and `busy_timeout=5000`
- [ ] `versions` table gains `text_hash` column with unique index on `(symbol_name, file_path, text_hash, session_id)`
- [ ] `snapshotSymbol()` uses `INSERT OR IGNORE` and computes md5 over `original_text`
- [ ] New exports: `pruneOldVersions`, `defaultVersionTtlMs`
- [ ] Calling `snapshotSymbol` twice with identical args inserts only one row

**What Complete Looks Like:** Two parallel agents calling `snapshotSymbol` for the same `(symbol, file, text, session)` produce a single row instead of duplicates. Concurrent writes never throw `SQLITE_BUSY`. Versions older than the TTL clear automatically when a process opens the DB.

**Verification:**
```bash
node -c dist/core/symbol-index.js
grep -n "synchronous = NORMAL\|busy_timeout\|INSERT OR IGNORE\|text_hash\|pruneOldVersions" dist/core/symbol-index.js | head -20
```
Expected: pragma, INSERT OR IGNORE, text_hash column ADD, and new exports all present.

---

### Task 1.2: Extend `dist/core/edit-engine.js` to return `pendingSnapshots`

**File:** Modify `dist/core/edit-engine.js` (created by prior cleanup plan)

**Codebase References:**
- The cleanup plan's spec for `applyEditList`: `(content, edits, {filePath, isBatch, disambiguations?}) → {workingContent, errors[]}`
- Existing symbol-mode behaviour (pre-cleanup) at `dist/tools/edit_file.js:496-516` — uses `findSymbol(workingContent, langName, edit.symbol, {kindFilter: 'def', nearLine: edit.nearLine})`
- `getLangForFile` at `dist/core/tree-sitter.js:107`
- `findSymbol` at `dist/core/tree-sitter.js:657`

**Implementation:**

Modify `applyEditList`'s return shape from `{workingContent, errors}` to `{workingContent, errors, pendingSnapshots}`.

`pendingSnapshots` is an array of objects, populated **only** for successful symbol-mode edits:
```js
{
    symbol: string,           // dot-qualified name as supplied
    originalText: string,     // verbatim text of the symbol BEFORE the edit
    line: number,             // sym.line (1-based, the symbol's start line)
    filePath: string          // the filePath passed in opts
}
```

Inside the symbol-mode branch of `applyEditList`, after locating `sym` via `findSymbol` and BEFORE applying the splice, capture:
```js
const lines = workingContent.split('\n');
const originalText = lines.slice(sym.line - 1, sym.endLine).join('\n');
// ... apply the splice as before ...
pendingSnapshots.push({
    symbol: edit.symbol,
    originalText,
    line: sym.line,
    filePath: opts.filePath,
});
```

`pendingSnapshots` must be `[]` (not `undefined`) when no symbol-mode edits succeed. Block-mode and content-mode edits NEVER push to `pendingSnapshots`.

Failed edits do NOT push (they go to `errors`).

**Acceptance Criteria:**
- [ ] `applyEditList` returns `{workingContent, errors, pendingSnapshots}`
- [ ] `pendingSnapshots` is always an array (never undefined)
- [ ] One symbol-mode edit yields exactly one snapshot entry
- [ ] Block-mode and content-mode edits produce zero snapshot entries
- [ ] Failed symbol-mode edits produce zero snapshot entries
- [ ] `originalText` exactly equals the joined lines `[sym.line, sym.endLine]` of the working content at the moment of the edit

**What Complete Looks Like:** Callers that want versioning iterate `result.pendingSnapshots` after a successful write and call `snapshotSymbol(db, ...)` for each entry. The engine itself remains pure — no DB or filesystem I/O.

**Verification:**
```bash
node -c dist/core/edit-engine.js
grep -n "pendingSnapshots" dist/core/edit-engine.js
```
Expected: `pendingSnapshots` declared, populated in symbol branch, included in return.

---

### Task 1.3: Wire snapshot commit into `dist/tools/edit_file.js`

**File:** Modify `dist/tools/edit_file.js` (lean post-cleanup version)

**Codebase References:**
- Pattern for path → repoRoot resolution: `dist/tools/stash_restore.js:134-136` — `await ctx.validatePath(filePath); findRepoRoot(absPath) || path.dirname(absPath); getDb(repoRoot)`
- `getProjectContext(ctx)` at `dist/core/project-context.js:236`
- `ctx.sessionId` reference at `dist/tools/stash_restore.js:140`
- `getSessionId(clientSessionId)` at `dist/core/symbol-index.js:115` (use as fallback when `ctx.sessionId` is undefined)
- `snapshotSymbol(db, symbol, filePath, originalText, sessionId, line)` at `dist/core/symbol-index.js:359` — the modified version from Task 1.1

**Implementation:**

After the cleanup plan, `edit_file.js` calls `applyEditList(...)` and writes the file via temp-file + rename. Add snapshot commit AFTER the rename succeeds and BEFORE the syntax-warn / response.

1. **Add imports** (top of file):
   ```js
   import { findRepoRoot, getDb, snapshotSymbol, getSessionId } from '../core/symbol-index.js';
   ```
   (Keep all existing imports.)

2. **Capture `pendingSnapshots`** from the engine call:
   ```js
   const { workingContent, errors, pendingSnapshots } = applyEditList(originalContent, args.edits, { filePath: validPath, isBatch });
   ```

3. **Commit snapshots** AFTER the successful `fs.rename` to disk and only when `!args.dryRun`:
   ```js
   if (!args.dryRun && pendingSnapshots.length > 0) {
       try {
           const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
           const db = getDb(repoRoot);
           const sessionId = ctx.sessionId || getSessionId();
           const relPath = path.relative(repoRoot, validPath);
           for (const snap of pendingSnapshots) {
               snapshotSymbol(db, snap.symbol, relPath, snap.originalText, sessionId, snap.line);
           }
       } catch { /* versioning is best-effort; never fail an edit because of it */ }
   }
   ```

4. **Path semantics:** snapshots store `relPath` (repo-relative), matching how `dist/tools/stash_restore.js:139` already keys version lookups. This keeps `restore`-mode lookups consistent.

5. **Do NOT** snapshot on dry-run.

**Acceptance Criteria:**
- [ ] `node -c dist/tools/edit_file.js` passes
- [ ] On successful symbol-mode edit, exactly one row appears in the project's `versions` table
- [ ] Block-mode and content-mode edits produce zero `versions` rows
- [ ] Dry-run edits produce zero `versions` rows
- [ ] Failures during snapshot capture do NOT fail the overall edit (try/catch swallows)
- [ ] Snapshots store repo-relative `file_path`, not absolute

**What Complete Looks Like:** Every successful symbol-mode edit through `edit_file` quietly records a pre-edit snapshot. `stashRestore`'s `restore` mode (Task 1.4) can then list and roll those back.

**Verification:**
```bash
node -c dist/tools/edit_file.js
grep -n "snapshotSymbol\|pendingSnapshots" dist/tools/edit_file.js
```
Expected: import present, loop iterates snapshots after rename, before syntax warn.

---

### Task 1.4: Extend `dist/tools/stash_restore.js` — apply-side snapshots, list-versions, history mode

**File:** Modify `dist/tools/stash_restore.js` (post-cleanup version)

**Codebase References:**
- Existing apply branch (pre-cleanup): `dist/tools/stash_restore.js:181-353` — post-cleanup it calls `applyEditList` like edit_file does
- Existing restore branch: `dist/tools/stash_restore.js:129-176`
- `getVersionHistory(db, symbolName, sessionId, filePath?)` at `dist/core/symbol-index.js:365-374` — returns `[{id, symbol_name, file_path, created_at}, ...]`
- `getVersionText(db, versionId)` at `dist/core/symbol-index.js:376-379`
- `restoreVersion(db, symbolName, versionId, sessionId, currentText)` at `dist/core/symbol-index.js:381-394`
- Path/DB resolution pattern: `dist/tools/stash_restore.js:134-136`
- Discriminated-union pattern: `dist/tools/edit_file.js:420-438`

**Implementation:**

1. **Add `history` mode** to the discriminated union in the schema. Insert as a new branch after the existing `init` branch:
   ```js
   z.object({
       mode: z.literal("history").describe("List version snapshots for a symbol."),
       symbol: z.string().describe("Symbol name. Dot-qualified for methods."),
       file: z.string().optional().describe("Restrict to one file."),
   }),
   ```

2. **Implement `history` handler** before the existing `restore` handler:
   ```js
   if (args.mode === 'history') {
       const filePath = args.file || ctx.getAllowedDirectories()[0];
       const absPath = await ctx.validatePath(filePath).catch(() => filePath);
       const repoRoot = findRepoRoot(absPath) || path.dirname(absPath);
       const db = getDb(repoRoot);
       const sessionId = ctx.sessionId || getSessionId();
       const relPath = args.file ? path.relative(repoRoot, absPath) : null;
       const rows = getVersionHistory(db, args.symbol, sessionId, relPath);
       if (!rows.length) {
           return { content: [{ type: 'text', text: 'Empty.' }] };
       }
       const lines = rows.map((r, i) => `v${i} ${r.file_path} ${new Date(r.created_at).toISOString()}`);
       return { content: [{ type: 'text', text: lines.join('\n') }] };
   }
   ```
   `getSessionId` import comes from `../core/symbol-index.js`.

3. **Replace `restore`-mode `args.version` undefined branch.** Currently lines 164-167 silently call `restoreVersion(db, args.symbol)` with no version. Replace with version-listing behaviour identical to `history` mode (so the agent can pick a version and re-call):
   ```js
   } else {
       const relPath = path.relative(repoRoot, absPath);
       const rows = getVersionHistory(db, args.symbol, ctx.sessionId || getSessionId(), relPath);
       if (!rows.length) {
           return { content: [{ type: 'text', text: 'Empty.' }] };
       }
       const lines = rows.map((r, i) => `v${i} ${new Date(r.created_at).toISOString()}`);
       return { content: [{ type: 'text', text: lines.join('\n') }] };
   }
   ```
   Drop the broken `restored ? 'restored' : 'no history'` line.

4. **Wire snapshots on the `apply` path.** The post-cleanup apply branch calls `applyEditList(originalContent, edits, {...})`. Capture `pendingSnapshots` from the result and, after the successful `fs.rename`, commit them with the same pattern as Task 1.3:
   ```js
   if (!args.dryRun && pendingSnapshots.length > 0) {
       try {
           const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
           const db = getDb(repoRoot);
           const sessionId = ctx.sessionId || getSessionId();
           const relPath = path.relative(repoRoot, validPath);
           for (const snap of pendingSnapshots) {
               snapshotSymbol(db, snap.symbol, relPath, snap.originalText, sessionId, snap.line);
           }
       } catch { /* best-effort */ }
   }
   ```
   Add `snapshotSymbol, getSessionId` to the existing `../core/symbol-index.js` import.

5. **Restore-mode after-restore snapshot:** after a successful restore writes the prior text back (around line 161 area), capture the CURRENT (pre-restore) text so the restore itself is reversible. The restore handler reads `content` at line 146 — snapshot that BEFORE writing the restored text:
   ```js
   if (!args.dryRun) {
       try {
           const sessionId = ctx.sessionId || getSessionId();
           const relPath = path.relative(repoRoot, absPath);
           // Capture current symbol text so the restore is itself reversible
           const curLines = content.split('\n');
           const curText = curLines.slice(sym.line - 1, sym.endLine).join('\n');
           snapshotSymbol(db, args.symbol, relPath, curText, sessionId, sym.line);
       } catch { /* best-effort */ }
       const tempPath = `${absPath}.${randomBytes(16).toString('hex')}.tmp`;
       await fs.writeFile(tempPath, newContent, 'utf-8');
       await fs.rename(tempPath, absPath);
       await indexFile(db, repoRoot, absPath);
   }
   ```

**Acceptance Criteria:**
- [ ] `node -c dist/tools/stash_restore.js` passes
- [ ] `mode: "history"` returns version list (or `"Empty."`) without restoring anything
- [ ] `mode: "restore"` with `version` omitted returns the version list, NOT a silent restore
- [ ] `mode: "restore"` with `version` defined still restores as before
- [ ] Successful `apply` of a stashed symbol-mode edit produces a `versions` row
- [ ] Successful `restore` produces a `versions` row capturing the pre-restore state (so restores are themselves reversible)
- [ ] All snapshot failures are swallowed; never fail the user-facing operation

**What Complete Looks Like:** `stashRestore` is now the user-facing surface for symbol versioning. Every symbol mutation through any tool produces a snapshot; agents can list, restore, and chain restores freely.

**Verification:**
```bash
node -c dist/tools/stash_restore.js
grep -n "mode === 'history'\|getVersionHistory.*sessionId\|snapshotSymbol" dist/tools/stash_restore.js
```
Expected: history branch present; getVersionHistory called from BOTH history and restore-with-no-version; snapshotSymbol called in apply branch and restore branch.

---

### Task 1.5: Add `getSymbolStructure` helper to `dist/core/tree-sitter.js`

**File:** Modify `dist/core/tree-sitter.js`

**Codebase References:**
- Pattern for tree walking: `dist/core/tree-sitter.js:822-849` (`getStructuralFingerprint`)
- Existing `loadLanguage(langName)` private helper used at `dist/core/tree-sitter.js:823`
- `Parser` import at top of file (already present)

**Implementation:**

Append a new exported async function at the end of the file, after `computeStructuralSimilarity` (line 882):

```js
/**
 * Extract a structural signature for the symbol whose definition spans
 * `startLine`..`endLine` (1-based, inclusive). Used by refactor_batch outlier
 * detection to flag occurrences whose shape differs from peers in the same
 * symbol group.
 *
 * Returns a comparable structure:
 *   {
 *     params: string[],          // node types of each parameter, in order
 *     returnKind: string|null,   // node type of return-type annotation, if present
 *     parentKind: string|null,   // node type of nearest enclosing definition or program
 *     decorators: string[],      // node types of decorators attached, in order
 *     modifiers: string[]        // sorted unique modifier tokens (async, generator, static, ...)
 *   }
 *
 * Returns null if the language cannot be loaded or no matching def node is found.
 */
export async function getSymbolStructure(source, langName, startLine, endLine) {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    try {
        const startRow = startLine - 1;
        const endRow = endLine - 1;

        // Find the smallest "definition-like" node that exactly spans the range.
        const DEF_TYPES = new Set([
            'function_declaration', 'function_definition', 'method_definition',
            'arrow_function', 'function', 'method',
            'class_declaration', 'class_definition',
            'function_signature', 'method_signature',
            'lexical_declaration', 'variable_declaration', // for `const fn = () => …`
        ]);

        let defNode = null;
        function findDef(node) {
            if (DEF_TYPES.has(node.type) &&
                node.startPosition.row === startRow &&
                node.endPosition.row === endRow) {
                defNode = node;
                return true;
            }
            for (let i = 0; i < node.childCount; i++) {
                if (findDef(node.child(i))) return true;
            }
            return false;
        }
        findDef(tree.rootNode);
        if (!defNode) return null;

        // Params: walk first child of type containing "param" or "formal_parameters"
        const params = [];
        function collectParams(node) {
            if (/parameters?$/.test(node.type) || node.type === 'formal_parameters') {
                for (let i = 0; i < node.childCount; i++) {
                    const c = node.child(i);
                    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
                    params.push(c.type);
                }
                return true;
            }
            for (let i = 0; i < node.childCount; i++) {
                if (collectParams(node.child(i))) return true;
            }
            return false;
        }
        collectParams(defNode);

        // Return type: child whose field name is "return_type" or whose type matches *_type
        let returnKind = null;
        for (let i = 0; i < defNode.childCount; i++) {
            const c = defNode.child(i);
            const fieldName = defNode.fieldNameForChild ? defNode.fieldNameForChild(i) : null;
            if (fieldName === 'return_type' || /^type_annotation$|^return_type$/.test(c.type)) {
                returnKind = c.type;
                break;
            }
        }

        // Parent kind: walk up to the nearest definition-like ancestor or program
        let parentKind = null;
        let p = defNode.parent;
        while (p) {
            if (DEF_TYPES.has(p.type) || p.type === 'program' || p.type === 'module' || p.type === 'source_file') {
                parentKind = p.type;
                break;
            }
            p = p.parent;
        }

        // Decorators: siblings of type "decorator" immediately preceding defNode,
        // OR children of type "decorator" within defNode.
        const decorators = [];
        if (defNode.parent) {
            const siblings = [];
            for (let i = 0; i < defNode.parent.childCount; i++) siblings.push(defNode.parent.child(i));
            const idx = siblings.indexOf(defNode);
            for (let i = idx - 1; i >= 0; i--) {
                if (siblings[i].type === 'decorator') decorators.unshift(siblings[i].type);
                else break;
            }
        }
        for (let i = 0; i < defNode.childCount; i++) {
            const c = defNode.child(i);
            if (c.type === 'decorator') decorators.push(c.type);
        }

        // Modifiers: tokens like 'async', 'static', '*' (generator)
        const MODIFIER_TYPES = new Set(['async', 'static', 'public', 'private', 'protected', 'readonly', '*']);
        const modifiers = new Set();
        function collectModifiers(node) {
            if (MODIFIER_TYPES.has(node.type)) modifiers.add(node.type);
            for (let i = 0; i < node.childCount; i++) collectModifiers(node.child(i));
        }
        for (let i = 0; i < defNode.childCount; i++) collectModifiers(defNode.child(i));

        return {
            params,
            returnKind,
            parentKind,
            decorators,
            modifiers: [...modifiers].sort(),
        };
    } finally {
        tree.delete();
        parser.delete();
    }
}
```

**Acceptance Criteria:**
- [ ] `node -c dist/core/tree-sitter.js` passes
- [ ] New named export `getSymbolStructure`
- [ ] Returns `null` for unsupported language
- [ ] Returns `null` when no def-like node spans the requested range
- [ ] Two structurally-identical functions produce deeply-equal results (params order, modifiers sorted)
- [ ] Async function vs sync function differ on `modifiers`
- [ ] Function vs method differ on `parentKind`

**What Complete Looks Like:** `refactor_batch` (Task 1.6) consumes this helper to compare each occurrence in a symbol group against its peers and flag those whose `params`/`returnKind`/`parentKind`/`decorators`/`modifiers` differ from the modal shape.

**Verification:**
```bash
node -c dist/core/tree-sitter.js
grep -n "^export async function getSymbolStructure" dist/core/tree-sitter.js
```
Expected: one match.

---

### Task 1.6: Create `dist/tools/refactor_batch.js` with `query` + `load` modes

**File:** Create `dist/tools/refactor_batch.js`

**Codebase References:**
- Tool registration template: `dist/tools/edit_file.js:414-441`
- Discriminated-union pattern: `dist/tools/edit_file.js:420-438`, `dist/tools/stash_restore.js:19-51`
- Project context resolution: `dist/tools/stash_restore.js:55` — `const pc = getProjectContext(ctx)`
- Repo root + DB: `dist/tools/stash_restore.js:134-136`
- `impactQuery(db, symbolName, {file?, depth?, direction?})` at `dist/core/symbol-index.js:253-353`
- `indexDirectory(db, repoRoot, repoRoot, {maxFiles: 5000})` at `dist/core/symbol-index.js:204`
- `ensureIndexFresh(db, repoRoot, [absPath])` at `dist/core/symbol-index.js:233`
- `findSymbol(source, langName, name, {kindFilter: 'def', nearLine?})` at `dist/core/tree-sitter.js:657`
- `getSymbolStructure(source, langName, startLine, endLine)` at `dist/core/tree-sitter.js` (added by Task 1.5)
- `getLangForFile(filePath)` at `dist/core/tree-sitter.js:107`
- `getSessionId(clientSessionId)` at `dist/core/symbol-index.js:115`
- `CHAR_BUDGET` at `dist/core/shared.js`
- Path validation: every file path must pass `await ctx.validatePath(absPath)` before any read

**Module-level constants (read once at import):**
```js
const MAX_CHARS = Number(process.env.REFACTOR_MAX_CHARS) || 30000;
const DEFAULT_CONTEXT = 5;
const MAX_CONTEXT_LINES = Math.min(30, Number(process.env.REFACTOR_MAX_CONTEXT) || 30);
```

**Module-level cache (per-process):**
```js
// Keyed by `${repoRoot}::${sessionId}` — the active load + remaining truncation pointer.
const _loadCache = new Map();
// Cached apply payloads for `reapply` (filled by Task 2.1).
const _payloadCache = new Map();
```

**Schema (`z.discriminatedUnion("mode", [...])` — query+load only in Wave 1; apply+reapply added by Task 2.1):**

```js
inputSchema: z.discriminatedUnion("mode", [
    z.object({
        mode: z.literal("query").describe("Find symbols that reference (or are referenced by) a target."),
        target: z.string().describe("Symbol name to query."),
        fileScope: z.string().optional().describe("Restrict to one file."),
        direction: z.enum(['forward', 'reverse']).default('forward').describe("forward = callers; reverse = callees."),
        depth: z.number().int().min(1).max(5).default(1).describe("Transitive levels to traverse."),
    }),
    z.object({
        mode: z.literal("load").describe("Load function bodies plus surrounding context for the chosen symbols."),
        selection: z.array(z.union([
            z.number().int().min(1).describe("1-based index from the prior query."),
            z.object({
                symbol: z.string(),
                file: z.string().optional(),
            }),
        ])).describe("Indices from the prior query, or explicit {symbol, file} pairs."),
        contextLines: z.number().int().min(0).max(MAX_CONTEXT_LINES).default(DEFAULT_CONTEXT).describe("Lines of context above and below each symbol."),
        loadMore: z.boolean().default(false).describe("Continue from the previous truncated load."),
    }),
])
```

**`query` handler:**
1. Resolve repo root via `getProjectContext(ctx).getRoot(args.fileScope)`. If none, throw `"No project root."`.
2. Open `db = getDb(repoRoot)`.
3. If `db.prepare('SELECT COUNT(*) AS n FROM files').get().n === 0`, await `indexDirectory(db, repoRoot, repoRoot, { maxFiles: 5000 })`. Otherwise fire-and-forget refresh.
4. Resolve `fileScope` (if given) to repo-relative path via `path.relative(repoRoot, await ctx.validatePath(args.fileScope))`.
5. Call `impactQuery(db, args.target, { file: relScope, depth: args.depth, direction: args.direction })`.
6. If result has `disambiguate: true`, return `"Multiple definitions:\n" + result.definitions.join('\n')`.
7. Cache the result list under `_loadCache.set(\`${repoRoot}::${sessionId}\`, { results: result.results, remaining: [], contextLines: null })` so `load` can reference indices.
8. Format response — group by file (`forward` direction has `filePath`; `reverse` has only `name`):
   ```
   1) validateCard[4x] (payments/validator.js)
   2) chargeStripe[3x] (payments/stripe.js)
   ...
   N total
   ```
   For `reverse`: `1) helperA[12x]` (no file column).
9. Empty result → `"No references."`.

**`load` handler:**
1. Resolve repo root + open db like `query`. Read `cacheKey = \`${repoRoot}::${sessionId}\``.
2. If `args.loadMore`: pull `cached = _loadCache.get(cacheKey)`; if no `remaining`, return `"Nothing to continue."`. Use `cached.remaining` as the work list and `cached.contextLines` as the context.
3. Otherwise resolve `args.selection` to a work list of `{symbol, filePath}` pairs:
   - Numeric entries → look up `cached.results[entry-1]` from the last query.
   - Object entries → use as-is, resolving relative path via repo-relative semantics.
   If `cached` is missing for numeric selections, return `"Run query first."`.
4. For each work-list entry:
   - Resolve `absPath = path.join(repoRoot, filePath)`. Validate with `ctx.validatePath(absPath)` (skip on failure).
   - Read source. Call `findSymbol(source, getLangForFile(absPath), symbol, { kindFilter: 'def' })`. Skip if no matches.
   - For each matched def, slice `(line, endLine)` plus `args.contextLines` above and below. Track running char count.
5. **Char budget enforcement:** while assembling the response string, after EACH symbol added, check `chars > MAX_CHARS`. If yes, push the remaining work-list entries into `cached.remaining` and break. NEVER truncate mid-symbol.
6. **Outlier flagging:** For each symbol-name group with ≥2 occurrences in this load, compute `getSymbolStructure(source, langName, line, endLine)` per occurrence. Determine the modal structure (deep-equal majority). Flag each occurrence whose structure differs with a `⚠ <reason>` suffix where `<reason>` is one of:
   - `"param shape differs"` (params array unequal to mode)
   - `"return type differs"` (returnKind unequal)
   - `"parent scope differs"` (parentKind unequal)
   - `"decorators differ"` (decorators arrays unequal)
   - `"modifiers differ"` (modifiers arrays unequal)
   Pick the first dimension that differs. If `getSymbolStructure` returns null for all, do not flag.
7. Update `_loadCache.set(cacheKey, { results: cached?.results || [], remaining, contextLines: args.contextLines })`.
8. Format response:
   ```
   <loadedCount> in <file1>, <count> in <file2>, ...
   <symbol> [<idx>] <relFile>[ ⚠ <reason>]
   <contextLines lines above>
   <symbol body>
   <contextLines lines below>
   <blank line>
   ...
   ```
   If truncated, append `\n[truncated] <remainingCount> remaining. Call load with loadMore=true.`

**Imports for the file:**
```js
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { getProjectContext } from '../core/project-context.js';
import {
    findRepoRoot, getDb, indexDirectory, ensureIndexFresh,
    impactQuery, getSessionId,
} from '../core/symbol-index.js';
import {
    getLangForFile, findSymbol, getSymbolStructure,
} from '../core/tree-sitter.js';
```

**Tool registration:**
```js
export function register(server, ctx) {
    server.registerTool("refactor_batch", {
        title: "Refactor Batch",
        description: "Apply one edit pattern across multiple similar symbols, with rollback.",
        inputSchema: /* schema above */,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {
        // ... handler ...
    });
}
```

**Acceptance Criteria:**
- [ ] `node -c dist/tools/refactor_batch.js` passes
- [ ] Tool registers as `refactor_batch` with two modes: `query`, `load`
- [ ] Schema is a `z.discriminatedUnion`; description is one sentence
- [ ] All param descriptions are direct imperatives (no "If true, …")
- [ ] Path inputs go through `ctx.validatePath`
- [ ] `query` builds the index on first call, returns indexed list, caches it
- [ ] `query` returns disambiguation list when target has multiple defs and no `fileScope`
- [ ] `load` rejects with `"Run query first."` when numeric selections lack a cached query
- [ ] `load` honours `MAX_CHARS`; emits `[truncated] N remaining` when over budget; never splits a symbol
- [ ] `load` flags outliers using `getSymbolStructure` (intra-group modal comparison) — never uses heuristics
- [ ] `loadMore=true` resumes from cached `remaining` and produces no duplicate entries
- [ ] Response strings: no markdown headers, no JSON dumps, no path parroting beyond what the format above shows

**What Complete Looks Like:** An agent can call `mode: "query", target: "validateCard"`, receive a numbered list, then call `mode: "load", selection: [1,2,3]` and receive ready-to-edit symbol bodies with context lines and outlier flags. No mutation has occurred.

**Verification:**
```bash
node -c dist/tools/refactor_batch.js
grep -n "discriminatedUnion\|MAX_CHARS\|getSymbolStructure\|loadMore" dist/tools/refactor_batch.js
```
Expected: union present, char-cap constants, structural helper used, loadMore branch present.

---

### Task 1.7: Register `refactor_batch` in `dist/core/server.js`

**File:** Modify `dist/core/server.js`

**Codebase References:**
- Existing import block: `dist/core/server.js:8-17`
- Existing `registerAllTools` function: `dist/core/server.js:51-62`

**Implementation:**

1. Add import after the existing `registerStashRestore` import (line 17):
   ```js
   import { register as registerRefactorBatch } from '../tools/refactor_batch.js';
   ```

2. Add the registration call inside `registerAllTools` after `registerStashRestore(server, ctx);` (line 61):
   ```js
   registerRefactorBatch(server, ctx);
   ```

That is the only change.

**Acceptance Criteria:**
- [ ] `node -c dist/core/server.js` passes
- [ ] One new import line referencing `refactor_batch.js`
- [ ] One new registration call inside `registerAllTools`
- [ ] No other lines change

**What Complete Looks Like:** When the MCP server starts, the `refactor_batch` tool is exposed alongside the existing tools.

**Verification:**
```bash
node -c dist/core/server.js
grep -n "refactor_batch\|registerRefactorBatch" dist/core/server.js
```
Expected: 2 matches (1 import, 1 call).

---

## Wave 1 Completion Verification

> BEFORE reporting Wave 1 as complete:
> Spawn a subagent to perform an independent review of the implementation.

Run end-to-end:
```bash
cd /home/tanner/Projects/Zenith-MCP
for f in dist/core/symbol-index.js dist/core/tree-sitter.js dist/core/edit-engine.js dist/core/server.js dist/tools/edit_file.js dist/tools/stash_restore.js dist/tools/refactor_batch.js; do
    node -c "$f" || echo "PARSE FAIL: $f"
done

# Sanity greps
grep -n "synchronous = NORMAL\|busy_timeout" dist/core/symbol-index.js
grep -n "INSERT OR IGNORE.*versions\|text_hash\|pruneOldVersions" dist/core/symbol-index.js
grep -n "pendingSnapshots" dist/core/edit-engine.js dist/tools/edit_file.js dist/tools/stash_restore.js
grep -n "mode === 'history'" dist/tools/stash_restore.js
grep -n "^export async function getSymbolStructure" dist/core/tree-sitter.js
grep -n "registerRefactorBatch" dist/core/server.js

# Full test suite
npm test
```

Expected: every `node -c` exits 0, every grep finds at least one match, `npm test` passes.

---

## Wave 2: Apply + Reapply on `refactor_batch.js` (1 task — sequential)

> **Dependencies:** Wave 1 must complete. Specifically Task 1.6 must have created `dist/tools/refactor_batch.js`.
>
> **File Safety:** Task 2.1 modifies `dist/tools/refactor_batch.js`. No other task touches it in this wave.

---

### Task 2.1: Add `apply` + `reapply` modes to `refactor_batch`

**File:** Modify `dist/tools/refactor_batch.js`

**Codebase References:**
- Schema and handler skeleton: created by Task 1.6 in Wave 1
- `applyEditList(content, edits, {filePath, isBatch, disambiguations?}) → {workingContent, errors, pendingSnapshots}` from `dist/core/edit-engine.js` (post-Task-1.2)
- `syntaxWarn(filePath, content)` from `dist/core/edit-engine.js`
- `snapshotSymbol`, `getDb`, `findRepoRoot`, `getSessionId` from `dist/core/symbol-index.js` (post-Task-1.1)
- `ensureIndexFresh(db, repoRoot, [absPath])` at `dist/core/symbol-index.js:233`
- Atomic write pattern: `dist/tools/edit_file.js:553-562`
- `checkSyntaxErrors(content, langName)` at `dist/core/tree-sitter.js:773` for the syntax pre-apply gate

**Add to imports:**
```js
import { randomBytes } from 'crypto';
import { applyEditList, syntaxWarn } from '../core/edit-engine.js';
import { snapshotSymbol, ensureIndexFresh, indexFile } from '../core/symbol-index.js';
import { checkSyntaxErrors } from '../core/tree-sitter.js';
```
(Add to the existing `symbol-index.js` and `tree-sitter.js` import statements rather than creating new ones.)

**Add per-session retry tracking:**
```js
// Keyed by `${repoRoot}::${sessionId}::${symbolName}`. Locks a group after 1 failed retry.
const _retryState = new Map();
```

**Schema additions** — append two more branches to the existing discriminated union:

```js
z.object({
    mode: z.literal("apply").describe("Apply the edited diff to all selected occurrences."),
    payload: z.string().describe("Edited diff string with symbol headers (e.g. \"validateCard 1,2,3 ack:3\")."),
    dryRun: z.boolean().default(false).describe("Run all gates without writing."),
}),
z.object({
    mode: z.literal("reapply").describe("Apply a previously-applied symbol-group payload to new targets."),
    symbolGroup: z.string().describe("Symbol name from a prior successful apply."),
    newTargets: z.array(z.union([
        z.string(),
        z.object({ symbol: z.string(), file: z.string().optional() }),
    ])).describe("New targets — names or {symbol, file} pairs."),
    dryRun: z.boolean().default(false).describe("Run all gates without writing."),
}),
```

**Payload parser** (helper inside the file):
```js
// Parses:
//   validateCard 1,2,3 ack:3
//   function validateCard(card) { ... }
//
//   chargeStripe 1,2
//   function chargeStripe(card, amount) { ... }
//
// Returns: [{symbol, indices: number[], ack: number[], body: string}, ...]
function parsePayload(payload) {
    const groups = [];
    const blocks = payload.split(/\n(?=[A-Za-z_$][\w$]*\s+\d)/);
    for (const block of blocks) {
        const nl = block.indexOf('\n');
        if (nl === -1) continue;
        const header = block.slice(0, nl).trim();
        const body = block.slice(nl + 1).replace(/\n+$/, '');
        const m = header.match(/^([A-Za-z_$][\w$.]*)\s+([\d,\s]+?)(?:\s+ack:([\d,\s]+))?$/);
        if (!m) continue;
        const symbol = m[1];
        const indices = m[2].split(',').map(s => Number(s.trim())).filter(Number.isFinite);
        const ack = m[3] ? m[3].split(',').map(s => Number(s.trim())).filter(Number.isFinite) : [];
        groups.push({ symbol, indices, ack, body });
    }
    return groups;
}
```

**`apply` handler** (insert in main switch before the closing of the handler):

1. Resolve repo root + db + sessionId. Read `cacheKey = \`${repoRoot}::${sessionId}\``, fetch `cached = _loadCache.get(cacheKey)`. If no cached load that contains every symbol in `payload`, reject with: `"No diff loaded. Call load first."`
2. Parse `args.payload` with `parsePayload`. For each group, look up the loaded entries under that symbol name. Reject with `"Unknown symbol: <name>. Load it first."` if not present.
3. **Gate 1 (load required)** — already enforced by step 1.
4. **Gate 2 (outlier ack)** — for every flagged occurrence (those that received `⚠` during load), require its index to appear in the group's `ack` list. On failure: `"Flagged outliers require ack: <indices>"`.
5. **Gate 3 (char budget)** — sum the lengths of every group's `body` × number of `indices`. If > `MAX_CHARS`, reject: `"Over char budget. Split the apply into smaller groups."`
6. **Gate 4 (syntax)** — for each group's `body` (the new function text), run `checkSyntaxErrors(body, langName)` using the language inferred from the first target's file. If errors, reject: `"Syntax error in <symbol>: line <L>:<C>"`.
7. **Per-occurrence application:** Build per-file edit lists. For each `{symbol, indices, body}`, look up the loaded occurrences, group by file, and produce `edit_file`-style symbol-mode edits: `{mode: 'symbol', symbol, newText: body}` (one edit per occurrence in that file). For multi-occurrence files, supply `disambiguations` keyed by edit-index → `{nearLine: <occurrence.line>}` so `applyEditList` can pick the right def.
8. For each file:
   - Read content. Call `applyEditList(content, edits, {filePath: absPath, isBatch: edits.length > 1, disambiguations})`.
   - If `errors.length > 0`: per-group failure semantics. Increment `_retryState.get(\`${repoRoot}::${sessionId}::${symbol}\`)` for each failed group. If retries == 1 (first failure), respond: `"Group <symbol> failed: <error>. Retry once or use edit_file directly."`. If retries == 2 (second failure), set state to "locked" and respond: `"Group <symbol> locked. Use edit_file directly."`. Other groups in this apply that succeeded HAVE ALREADY been written — do not roll back.
   - If `args.dryRun`: skip the write; collect a per-file dry-run summary.
   - Otherwise: atomic temp-file write + rename (pattern from `dist/tools/edit_file.js:553-562`).
   - On success: commit `pendingSnapshots` via `snapshotSymbol(...)` exactly as Task 1.3 does.
   - Re-index the file via `await ensureIndexFresh(db, repoRoot, [absPath])`.
9. Cache the payload per group: for each successful group, `_payloadCache.set(\`${repoRoot}::${sessionId}::${symbol}\`, { body: group.body, ack: group.ack })`.
10. Response on success: `"Applied <symbolCount> symbols across <fileCount> files."`. Append `syntaxWarn(absPath, finalContent)` for any file whose post-write parse warns.

**`reapply` handler:**
1. Resolve repo root + db + sessionId. Look up `_payloadCache.get(\`${repoRoot}::${sessionId}::${args.symbolGroup}\`)`. If missing, reject: `"No cached payload for <symbol>."`
2. Resolve `args.newTargets` to file/line pairs by calling `findSymbol(source, langName, name, {kindFilter: 'def'})` per target. Skip targets with no match (collect into a "skipped" list for the response).
3. Synthetically build a load entry for the new targets so the outlier-flagging path can run: for each target, compute `getSymbolStructure(...)`. Compare against the cached payload's modal structure (re-derived from the originally applied targets if recoverable, otherwise just compare new targets among themselves). Flag divergent targets — they require ack.
4. If any flagged target lacks an entry in the cached payload's `ack` list AND in `args.newTargets`, reject with the same `"Flagged outliers require ack: <indices>"` semantics. (For `reapply`, the agent must re-confirm by re-calling apply with explicit ack rather than implicit reuse.)
5. Otherwise build the edit list and run the same per-file apply pipeline as `apply` mode.
6. Response: `"Reapplied <count> targets."`

**Acceptance Criteria:**
- [ ] `node -c dist/tools/refactor_batch.js` passes
- [ ] Tool now exposes 4 modes: `query`, `load`, `apply`, `reapply`
- [ ] All four pre-apply gates fire correctly:
    - apply with no prior load → `"No diff loaded. Call load first."`
    - apply with unknown symbol → `"Unknown symbol: <name>. Load it first."`
    - apply with flagged occurrence missing ack → `"Flagged outliers require ack: <indices>"`
    - apply over char budget → `"Over char budget. Split the apply into smaller groups."`
    - apply with syntax error in body → `"Syntax error in <symbol>: line <L>:<C>"`
- [ ] Per-group failure: first failure returns retry message, second failure locks group
- [ ] Successful groups in a partially-failing apply are NOT rolled back (atomic per-file, not per-batch)
- [ ] Symbol snapshots committed to `versions` table on success (one per occurrence)
- [ ] Files re-indexed via `ensureIndexFresh` after successful write
- [ ] `_payloadCache` populated for each successful group
- [ ] `reapply` rejects with `"No cached payload for <symbol>."` when group never applied
- [ ] `reapply` runs the same outlier-ack pipeline against new targets

**What Complete Looks Like:** An agent runs `query → load → apply` and N similar functions are atomically rewritten across multiple files, with version snapshots created and per-file syntax validation. A subsequent `reapply` propagates the same change to newly-discovered targets without rewriting the body.

**Verification:**
```bash
node -c dist/tools/refactor_batch.js
grep -n 'mode === .apply.\|mode === .reapply.' dist/tools/refactor_batch.js
grep -n 'No diff loaded\|Unknown symbol\|Flagged outliers require ack\|Over char budget\|No cached payload' dist/tools/refactor_batch.js
grep -n 'snapshotSymbol\|ensureIndexFresh\|_payloadCache\|_retryState' dist/tools/refactor_batch.js
```
Expected: every gate string present; snapshot + reindex calls present; both caches accessed.

---

## Wave 2 Completion Verification

> BEFORE reporting Wave 2 as complete:
> Spawn a subagent to perform an independent review of the implementation.

```bash
cd /home/tanner/Projects/Zenith-MCP
node -c dist/tools/refactor_batch.js
node -e "
import('./dist/tools/refactor_batch.js').then(m => {
    if (typeof m.register !== 'function') { console.error('register missing'); process.exit(1); }
    console.log('register OK');
});
"
npm test
```

Expected: parses, registers, full vitest suite passes.

---

## End-to-End Acceptance (after both waves)

When both waves complete, the following must hold:

1. **Versioning is live:** every successful symbol-mode edit through `edit_file`, `stashRestore` apply, and `refactor_batch` apply produces a row in `.mcp/symbols.db` `versions` table.
2. **Versioning is exposed:** `stashRestore` `mode: "history"` lists snapshots; `mode: "restore"` with no version lists, with version restores.
3. **Concurrency-safe:** SQLite uses WAL + busy_timeout=5000 + synchronous=NORMAL. Idempotent INSERT prevents duplicate snapshots from concurrent agents.
4. **`refactor_batch` is registered** and exposes 4 modes: `query`, `load`, `apply`, `reapply`.
5. **All four pre-apply gates fire correctly.**
6. **Outlier detection is real:** uses `getSymbolStructure` (param node-types, return kind, parent kind, decorators, modifiers), not text heuristics.
7. **Char-based caps:** `MAX_CHARS = 30000` default, env-overridable.
8. **Context lines default 5, max 30,** env-overridable.
9. **TTL pruning:** versions older than 24h prune on DB open (env-overridable via `REFACTOR_VERSION_TTL_HOURS`).
10. **`npm test` passes** end-to-end with no regressions.

When all 10 hold, `batched_symbol_editing.md` is implemented and the previous review's findings are fully resolved.
