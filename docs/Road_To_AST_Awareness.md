Now I have it directly. Here is my recommendation.

---

# Recommended setup: maximum AST/language/symbol awareness, fully routed through the DB layer

## Architectural ground rules (governs every file below)

1. **One and only one place imports `node:sqlite`:** `core/db-adapter.ts`. Already true (verified: grep returns exactly one hit). Every new SQL statement gets a named, typed adapter function — never `execRaw`/`queryRaw` in production code. `execRaw`/`queryRaw` are kept strictly as the test-time escape hatch they already are.
2. **All AST/language/symbol producers write through the adapter.** Extractors return plain typed records; an indexer module assembles them into a single DB transaction. Producers never touch the DB.
3. **All AST/language/symbol consumers read through the adapter.** Tools, compression (toon's facts feed), refactor, search — every one of them calls an adapter function, never a SQL string. `getFileBlockEdges` already proves the pattern.
4. **One transaction per file re-index.** Atomic replace (delete-by-file → insert all new rows for that file). Matches what `indexFile` already does — we just add more tables to the same transaction.
5. **Schema version pin.** A tiny `schema_version` table, single-row, checked at `getDb()` open so future capability additions get migrated cleanly without the current "try/catch on ALTER" stack.

---

## What the symbol DB needs to be able to represent (capability targets)

Everything tree-sitter and the `.scm` queries can give us, plus the relational structure to make it useful for refactor/search/compression-facts. From the grammars+queries audit:

| Capability | Sourced from | Currently in DB? |
|---|---|---|
| Definitions / references with name, kind, type, line, endLine, column | every `*-tags.scm` | yes |
| Per-file hash + last-indexed | files table | yes |
| Container-def → referenced-name call edges | `edges` | yes (string, no FK) |
| **Resolved cross-file edges** (caller def → callee def row id when resolvable) | symbol-index post-pass | no |
| **Per-symbol structural shape**: params (names + count), return type text, parent-scope kind+name, decorators, modifiers (public/private/static/async/abstract/const), generics, visibility | tree-sitter node traversal of each `@definition.*` body | no |
| **Anchors**: notable lines inside a def body (return statements, throws, key calls, control-flow heads) that ranking/compression cares about | tree-sitter walk inside def range | no |
| **Exported / public** flag | tree-sitter: `export`/`pub`/`public` modifier near def | no |
| **Imports / module edges** at file level (`import_statement`, `use_declaration`, `#include`, `require`, `from … import …`) — already captured as refs but type-erased | `@reference.module` / `@reference.import` captures already exist in every relevant query | partly (lives in `symbols` as kind=ref type=module, but no `imports` table) |
| **Embedded-language injections** (e.g. SQL in a JS tagged template, JS in HTML `<script>`) — the `injections.scm` files already exist for html/vue/svelte/md/php/dockerfile/nix/xml/js/ts/tsx/hcl | runtime + injections query | no |
| **Capture provenance** (which `.scm` capture name produced the row, e.g. `definition.function` vs `definition.method`) | already produced by `getSymbols` but flattened into `type` | partial (`type` holds the suffix but not the full `@definition.X` tag) |
| **Locals scopes** (function-local declarations, parameters, captures) — `locals.scm` exists for every supported language but is never executed | runtime + locals query | no |
| **Symbol body fingerprint** (hash of the def body text) — enables outlier detection for `refactor_batch` modal-structure check without re-reading files | sha1 of the def body slice | no |
| **Project root registry** at the global level | `initGlobalSchema.project_roots` already exists but isn't wired anywhere | dead |
| Version snapshots (already good) | versions | yes |

---

## File layout

All paths under `packages/zenith-mcp/src/`.

```
core/
  db-adapter.ts                       # unchanged role; grows new adapter functions only
  symbol-index.ts                     # orchestrator — slimmed; delegates to extractors
  tree-sitter/
    languages.ts                      # unchanged
    runtime.ts                        # unchanged
    symbols.ts                        # unchanged (legacy flat extractor — still used by tools that only want defs/refs)
    structure.ts                      # NEW — extracts SymbolStructure (params/return/parent/decorators/modifiers/generics/visibility)
    anchors.ts                        # NEW — extracts in-body anchor lines (returns/throws/key calls/control heads)
    imports.ts                        # NEW — extracts file-level import edges from @reference.import / @reference.module captures
    injections.ts                     # NEW — runs each language's injections.scm and yields embedded-language spans
    locals.ts                         # NEW — runs each language's locals.scm and yields per-def parameter + local rows
    body.ts                           # NEW — extracts def body slice + sha1 fingerprint
    capture-tags.ts                   # NEW — pure helpers for parsing @definition.X / @name.definition.X / @reference.X capture names
  indexing/
    extract.ts                        # NEW — pure: runs all extractors for one file, returns ParsedFileRecord (no DB)
    persist.ts                        # NEW — pure-ish: takes ParsedFileRecord + DbConnection, writes everything in ONE transaction
    types.ts                          # NEW — ParsedFileRecord and all sub-record shapes (single source of truth between extract & persist)
    resolve.ts                        # NEW — cross-file resolution pass: links edges.referenced_name → callee def symbol row id when unambiguous
```

Nothing else moves. `tools/`, `compression.ts`, `refactor_batch.ts` consumers only swap their imports (e.g. they ask `db-adapter` for richer rows instead of computing structure on the fly).

---

## File-by-file purposes & integrations

### `core/tree-sitter/capture-tags.ts` (NEW, ~40 LOC)
Pure parser for capture-name strings: `parseCaptureTag('@definition.method')` → `{ role: 'def', type: 'method', raw: 'definition.method' }`. Used everywhere a `.name` string from a tree-sitter capture needs to be classified. Lets us preserve the full provenance string in DB rows instead of erasing it the way `symbols.ts` does today (line 144–149).

### `core/tree-sitter/structure.ts` (NEW)
**Exports:** `extractStructure(rootNode, langName): SymbolStructure[]`

For every `@definition.*` body capture, walk the AST node to collect:
- `params: { name, typeText? }[]` — from `parameters`/`formal_parameters`/`parameter_list` children depending on language; uses a tiny per-language node-name table (kept in `structure.ts`, not added to grammars/).
- `returnText: string | null` — text of `return_type` / `type_annotation` child if present.
- `parentScope: { name, kind } | null` — nearest enclosing `class_declaration`/`module`/`namespace`/`impl_item`/etc.
- `decorators: string[]` — preceding `decorator`/`annotation` nodes (Python, TS, Java, C#).
- `modifiers: string[]` — `public/private/protected/static/async/abstract/const/final/override/pub/export` tokens.
- `generics: string | null` — text of `type_parameters` if present.
- `visibility: 'public'|'private'|'protected'|'package'|null` — derived from modifiers.
- `bodyHash: string` — sha1 of the body slice (delegated to `body.ts` to keep this file pure-walk).

This is what feeds `refactor_batch.ts`'s currently-empty `SymbolStructure[]`. **One file = one responsibility = one easy thing for future agents to extend per-language without touching the DB.**

### `core/tree-sitter/anchors.ts` (NEW)
**Exports:** `extractAnchors(defNode, langName): Anchor[]` where `Anchor = { line, kind: 'return'|'throw'|'call'|'control'|'export'|'await', text }`. Tree walk inside a def body picking up `return_statement`, `throw_statement`, top-level `call_expression`, `if/for/while/switch` heads, `await_expression`, etc. Per-language node-name table lives here.

Fed into compression facts (toon ranks anchors), and used by `refactor_batch` to render meaningful diff context.

### `core/tree-sitter/imports.ts` (NEW)
**Exports:** `extractImports(rootNode, langName, symbols): ImportEdge[]` where `ImportEdge = { module: string, importedNames: string[], line }`. Reuses the already-existing `@reference.import`/`@reference.module` captures (every language's `references.scm` has them). Emits one row per `import_statement` rather than one per imported name, with the names array preserved.

### `core/tree-sitter/locals.ts` (NEW)
**Exports:** `extractLocals(rootNode, langName, defs): LocalScope[]` where `LocalScope = { defSymbolId?: number, scopeKind, startLine, endLine, parameters: LocalSymbol[], locals: LocalSymbol[] }`. Runs the per-language `locals.scm` query (currently shipped for every supported language, never loaded). Output is keyed by the def whose range contains the scope so persist can link rows to symbol ids.

### `core/tree-sitter/injections.ts` (NEW)
**Exports:** `extractInjections(rootNode, langName): InjectionSpan[]` where `InjectionSpan = { hostLang, injectedLang, startLine, endLine, byteRange }`. Runs `injections.scm` for languages that ship one (html/vue/svelte/md/php/dockerfile/nix/xml/js/ts/tsx/hcl/bash). Persistence stores them in a new `injections` table; future passes can re-parse the injected text with the appropriate inner grammar to extract symbols from inside templates.

### `core/tree-sitter/body.ts` (NEW, tiny)
**Exports:** `bodySlice(source, startLine, endLine): string` and `bodyHash(slice): string`. Used by `structure.ts` and by version snapshotting so we stop hashing in three places with slightly different conventions.

### `core/indexing/types.ts` (NEW)
Single source of truth for the shape that crosses the extractor→persister boundary:

```ts
ParsedFileRecord {
  relPath, hash, lang, langCaptures: string[],     // e.g. ['definition.function','reference.module']
  symbols: SymbolRow[],                            // name, kind, type, captureTag, line, endLine, column, bodyHash?, parentSymbolKey?
  structures: StructureRow[],                      // FK by parentSymbolKey to SymbolRow
  anchors: AnchorRow[],                            // FK by parentSymbolKey
  imports: ImportRow[],                            // file-level
  locals: LocalScopeRow[],                         // FK by parentSymbolKey
  injections: InjectionRow[],                      // file-level
  edges: RawEdgeRow[],                             // container_def_key → referenced_name (resolution happens later in resolve.ts)
}
```

`parentSymbolKey` is a transient string (`${name}:${line}:${col}`) used only to wire FKs across the in-memory record before insert ids exist. The persister maps keys → real row ids inside the single transaction.

### `core/indexing/extract.ts` (NEW)
**Exports:** `extractParsedFile(source, langName, relPath): Promise<ParsedFileRecord>`

Parses once, then calls `symbols.ts::getSymbols` plus the new extractors against the same tree. **One parse, one tree, all extractors share it** — avoids the current double-parse pattern. No DB awareness at all.

### `core/indexing/persist.ts` (NEW)
**Exports:** `persistParsedFile(db, repoRoot, record: ParsedFileRecord): void`

Wraps everything in one `runTransaction`:

1. `deleteSymbolsByFile(db, relPath)` (already cascades via FK; same goes for new child tables once their FKs are declared)
2. `upsertFile(db, relPath, hash, now)`
3. Insert defs → record row ids in a key→id map
4. Insert refs (same as today) + insert edges using innermost-def logic
5. Insert structures, anchors, imports, locals, injections — each using the key→id map for FKs

**Every insert goes through a named db-adapter function.** New adapter functions added below.

### `core/indexing/resolve.ts` (NEW)
**Exports:** `resolveEdgeTargets(db, relPath): void` — best-effort cross-file resolution pass. For each unresolved `edges.referenced_name` originating in `relPath`, look up unambiguous matching def rows and populate a new nullable `edges.callee_symbol_id` column. Runs as a separate transaction after persist (not in the hot path of a single-file edit; runs after `indexDirectory` batches or on demand). Failure to resolve is fine — column stays null, edges still queryable by name as today.

### `core/symbol-index.ts` (MODIFIED, smaller)
- `indexFile` becomes: `parsed = await extractParsedFile(...)` → `persistParsedFile(db, repoRoot, parsed)`. The 80-line transaction body in the current file collapses to ~5 lines. Repo-root detection, the in-process `_dbCache`, `getDb`, `ensureIndexFresh`, `indexDirectory` walking, and version helpers all stay here.
- `indexDirectory` calls `resolveEdgeTargets` once at the end of the batch.

### `core/db-adapter.ts` (EXPANDED — new tables + new adapter functions only; never SQL outside this file)

**New schema additions inside `initSymbolSchema`:**

```sql
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

-- richer symbol fields (additive — keep current columns for backward compat)
ALTER TABLE symbols ADD COLUMN capture_tag TEXT;          -- e.g. 'definition.method'
ALTER TABLE symbols ADD COLUMN body_hash TEXT;            -- sha1 of body slice for defs
ALTER TABLE symbols ADD COLUMN parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE;
ALTER TABLE symbols ADD COLUMN visibility TEXT;           -- 'public'|'private'|'protected'|'package'|NULL

-- per-def structural shape (1:1 with a def symbol)
CREATE TABLE IF NOT EXISTS symbol_structures (
    symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
    params_json TEXT,            -- JSON array of {name, typeText?}
    return_text TEXT,
    decorators_json TEXT,        -- JSON array of strings
    modifiers_json TEXT,         -- JSON array of strings
    generics_text TEXT,
    parent_kind TEXT,
    parent_name TEXT
);

-- in-body anchors (N per def)
CREATE TABLE IF NOT EXISTS anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
    kind TEXT,                   -- 'return'|'throw'|'call'|'control'|'export'|'await'
    line INTEGER,
    text TEXT
);
CREATE INDEX IF NOT EXISTS idx_anchors_symbol ON anchors(symbol_id);

-- file-level imports (one row per import_statement)
CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
    module TEXT,
    imported_names_json TEXT,    -- JSON array; null = wildcard/side-effect import
    line INTEGER
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);
CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module);

-- per-def local scopes
CREATE TABLE IF NOT EXISTS local_scopes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
    scope_kind TEXT,
    start_line INTEGER,
    end_line INTEGER,
    parameters_json TEXT,        -- JSON array of {name, typeText?, line, column}
    locals_json TEXT             -- JSON array of {name, line, column}
);
CREATE INDEX IF NOT EXISTS idx_local_scopes_symbol ON local_scopes(symbol_id);

-- embedded-language injection spans
CREATE TABLE IF NOT EXISTS injections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
    host_lang TEXT,
    injected_lang TEXT,
    start_line INTEGER,
    end_line INTEGER,
    start_byte INTEGER,
    end_byte INTEGER
);
CREATE INDEX IF NOT EXISTS idx_injections_file ON injections(file_path);

-- cross-file edge resolution (additive column; null until resolved)
ALTER TABLE edges ADD COLUMN callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_symbol_id);
```

**New adapter functions** (verbatim signatures — every one wraps exactly one prepared statement; same style as the existing file):

- `insertSymbolStructure(conn, { symbolId, paramsJson, returnText, decoratorsJson, modifiersJson, genericsText, parentKind, parentName }): void`
- `getSymbolStructure(conn, symbolId): SymbolStructureRow | null`
- `findSymbolStructuresByName(conn, name, kind?): SymbolStructureRow[]` — feeds `refactor_batch`'s modal/outlier check directly
- `insertAnchor(conn, { symbolId, kind, line, text }): void`
- `getAnchorsForSymbol(conn, symbolId): AnchorRow[]`
- `getAnchorsForFile(conn, filePath): AnchorRow[]` — joins symbols→anchors; one round-trip for the compression facts feed
- `insertImport(conn, { filePath, module, importedNamesJson, line }): void`
- `getImportsForFile(conn, filePath): ImportRow[]`
- `getFilesImporting(conn, module): { file_path: string }[]` — file-level reverse import graph; useful for impact queries
- `insertLocalScope(conn, ...): void` and `getLocalScopesForSymbol(conn, symbolId)`
- `insertInjection(conn, ...): void` and `getInjectionsForFile(conn, filePath)`
- `updateEdgeCalleeSymbol(conn, edgeId, calleeSymbolId): void` and `getUnresolvedEdges(conn, originFilePath): EdgeRow[]`
- `setSymbolBodyHash(conn, symbolId, bodyHash, captureTag, parentSymbolId, visibility): void` — single update covering the new columns on `symbols`
- `getSchemaVersion(conn): number | null` / `setSchemaVersion(conn, n): void`
- One **aggregate** read used by toon-facts and the compression seam: `getFileFacts(conn, filePath): { defs, refs, edges, externalRefs, structures, anchors, imports, injections }` — a single adapter call returning everything needed to build the input record MCP hands to toon. Replaces the four-call dance currently in `compression.ts`.

### `core/symbol-index.ts` (additionally) — project root global registry
The dormant `initGlobalSchema.project_roots` table gets wired here: a tiny `registerRepoRoot(rootPath, name)` helper called from `getDb()` so the registry actually fills. Adapter functions already exist; only the call site is missing.

---

## How this guarantees we extract the maximum AST/language/symbol info

Mapping every grammar/query capability we identified earlier to the DB layer it lands in:

| Tree-sitter capability shipped in `grammars/` | Extractor file | DB destination | Adapter function |
|---|---|---|---|
| `@definition.<kind>` + `@name.definition.<kind>` (every language) | symbols.ts (existing) | `symbols` row (now with `capture_tag`, `body_hash`, `parent_symbol_id`, `visibility`) | `insertSymbol`, `setSymbolBodyHash` |
| `@reference.<kind>` (every language) | symbols.ts | `symbols` row kind='ref' + `edges` row | `insertSymbol`, `insertEdge` |
| `@reference.import` / `@reference.module` (bash, c, go, java, js, ts, php, py, rust, ruby, swift, kotlin, lua, …) | imports.ts | `imports` rows | `insertImport` |
| `locals.scm` scopes + `@local.parameter` / `@local.definition` / `@local.reference` (every supported language) | locals.ts | `local_scopes` rows | `insertLocalScope` |
| `injections.scm` (bash heredoc, dockerfile→bash, html→js/css, md fenced blocks, vue/svelte→js/ts/css/scss, php→html, js/ts tagged templates → html/css/sql/graphql, xml/nix/hcl) | injections.ts | `injections` rows | `insertInjection` |
| Per-def AST internals → params, return, decorators, modifiers, generics, parent scope | structure.ts | `symbol_structures` row | `insertSymbolStructure` |
| In-body anchor lines (returns/throws/control/key calls) | anchors.ts | `anchors` rows | `insertAnchor` |
| Body verbatim slice + content fingerprint | body.ts | `symbols.body_hash` + existing `versions.original_text` | `setSymbolBodyHash`, `snapshotVersion` |
| Cross-file def↔ref resolution (when unambiguous) | resolve.ts | `edges.callee_symbol_id` | `updateEdgeCalleeSymbol` |
| Capture provenance (`definition.function` vs `definition.method`) — currently flattened | capture-tags.ts | `symbols.capture_tag` | `insertSymbol` |

Coverage gap closure: the 7 grammars without queries today (cmake/dart/elixir/ini/make/perl/r) still get parsed but their symbol/structure/anchor extractors short-circuit cleanly — nothing breaks, those files just yield 0 rows. They get the same DB treatment automatically the day query files land in `grammars/queries/<lang>/`.

## Why every rule in your guidance is upheld

- **Single SQLite entrypoint.** Only `core/db-adapter.ts` imports `node:sqlite`. Verified today; preserved by construction. Every new SQL string is a new exported adapter function.
- **No tool/extractor/compression module ever sees SQL.** Extractors (`structure/anchors/imports/locals/injections/body`) are pure tree-sitter; persister (`indexing/persist.ts`) calls only `insertX`/`upsertX`/`update X` adapter functions; consumers (`tools/*`, `compression.ts`) call only `getX`/`findX` adapter functions.
- **No compression intelligence leaks into MCP.** The new `getFileFacts(conn, filePath)` aggregate adapter is a *facts* read — defs/refs/edges/externalRefs/structures/anchors/imports/injections. MCP hands the raw record to toon. Decisions (ranking, weighting, budget, line selection) remain in toon per the constraints doc.
- **No fake reimplementations.** No PageRank, BMX, BudgetAllocator, or Deduplicator appears anywhere in this file plan. The `edges.weight = sqrt(call_count)` math currently in `getFileBlockEdges` is **removed** as part of this work (per the ownership doc) — the adapter returns raw `call_count` and toon shapes weights inside SageRank's domain.
- **One transaction per file re-index.** Inherits today's pattern in `indexFile`; just covers more tables.
- **Backward compatible.** All schema changes are additive (new columns are nullable; new tables stand alone). Existing tools work unchanged on day one; new tools and the toon facts feed get richer data as it lands. `schema_version` lets future agents migrate safely without the current ALTER-in-try/catch pile.
- **Refactor_batch outlier flagging un-breaks itself.** The empty `SymbolStructure[]` arrays at `refactor_batch.ts:471` and `:974` get populated via `findSymbolStructuresByName` — a single adapter call per group. The whole `findModal`/`firstDiffReason`/`deepEqual` machinery already wired in that file lights back up with no further changes.

That's the plan. Hand me the task whenever you're ready.
