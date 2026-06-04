# Audit: Road_To_AST_Awareness.md (v1)

## 1. Strengths

1. **Correct architectural invariant preservation.** The plan explicitly states that only `db-adapter.ts` imports `node:sqlite` (verified: exactly one hit at line 1). Every new SQL gets a named adapter function — no SQL in extractors, tools, or consumers.

2. **Single-transaction-per-file.** The plan's `persist.ts` wraps everything in one `runTransaction` call, matching the pattern already enforced by `symbol-index.ts::indexFile` at lines 228–273. The `parentSymbolKey` transient-key→real-id mapping within the transaction is a sound design for resolving in-memory FK targets before insert IDs exist.

3. **One parse, all extractors.** `extract.ts` proposes parsing once and sharing the tree across all extractors. This avoids the double-parse problem (today `compression.ts` calls `getSymbols` which parses, then `getCompressionStructure` in ref-compression-structure.ts would parse again).

4. **Additive schema changes.** New columns are nullable, new tables stand alone. Existing tools continue to work unchanged. This is correct and safe.

5. **Removal of `Math.sqrt(call_count)` from `getFileBlockEdges`.** The plan correctly identifies this as a SageRank tuning concern per the constraints doc (Priority 0.5, lines 56–58: "Decides edge weighting (e.g. the `Math.sqrt(call_count)` transform — a SageRank tuning concern, lives in TOON)"). The proposal to return raw `call_count` is correct.

6. **`getFileFacts` aggregate read.** A single adapter call that returns all structural data for one file aligns with the constraints doc's seam design — MCP gathers facts, hands them to TOON. This avoids the current four-call dance in `compression.ts`.

7. **Coverage-gap closure.** The plan addresses all 7 query-less grammars (cmake/dart/elixir/ini/make/perl/r) with a clean short-circuit behavior rather than crashing.

8. **`resolve.ts` as a separate pass.** Cross-file edge resolution running after batch indexing (not in the hot path) is architecturally correct — it avoids blocking single-file edits.

9. **Correct identification that `refactor_batch.ts` lines 471–473 and 974–978 are the broken sites** and that `findSymbolStructuresByName` would feed them.

## 2. Weaknesses

### W1: `runtime.ts` only loads `<lang>-tags.scm` — plan doesn't address this

The plan proposes `locals.ts`, `injections.ts`, and `imports.ts` that all require running queries from the per-language modular files (`locals.scm`, `injections.scm`, `references.scm`). However, `runtime.ts::getCompiledQuery` (lines 256–283) ONLY loads `${langName}-tags.scm`:

```typescript
const scmPath = path.join(QUERIES_DIR, `${langName}-tags.scm`);
```

The plan says `runtime.ts` is "unchanged" but the new extractors need a way to compile and cache `locals.scm`, `injections.scm`, etc. This is a critical gap — without it, `extractLocals`, `extractInjections`, and the modular `references.scm`-based import extraction cannot function.

### W2: `structure.ts` / `anchors.ts` per-language node-name tables — maintenance burden unacknowledged

The plan says "tiny per-language node-name table" but doesn't provide the actual tables. For the 7 query-less grammars and languages with unusual AST shapes (bash has no `formal_parameters`, Lisp-family has no clear return type), the plan says "short-circuit cleanly" but provides no specification of how `extractStructure` distinguishes between "language has no applicable nodes" vs "something broke."

### W3: JSON columns require parsing in consumers

The plan stores `params_json`, `decorators_json`, `modifiers_json`, `parameters_json`, `locals_json`, `imported_names_json` as TEXT columns. The `findSymbolStructuresByName` adapter function returns `SymbolStructureRow` — but `refactor_batch.ts::findModal` (which does `deepEqual` comparison) needs parsed arrays. The plan doesn't specify WHERE this `JSON.parse` happens. If it's in the adapter, the adapter is doing non-SQL work. If it's in the consumer, every consumer must parse identically.

### W4: `parent_symbol_id` population is unspecified

The plan adds `parent_symbol_id INTEGER REFERENCES symbols(id)` to the `symbols` table but never describes how it gets populated. Current `getSymbols` returns a flat list. There's no containment detection pass specified. The `ParsedFileRecord.symbols[].parentSymbolKey` field is mentioned but `extract.ts` doesn't describe how it determines which symbol contains which — this requires comparing line ranges, which the current `getSymbols` output does provide, but the algorithm is missing.

### W5: Cross-file `resolve.ts` race condition unexplored

The plan says "`resolveEdgeTargets(db, relPath)` runs as a separate transaction after persist." But what happens when:
- File A calls `foo()` defined in File B
- File A is re-indexed → edges created with `callee_symbol_id = NULL`  
- File B is re-indexed → old `foo` def row deleted (FK CASCADE), File B's new `foo` gets a new row ID
- `resolveEdgeTargets` for File A now runs — but File B's symbols have different IDs

The plan doesn't address when the resolve pass re-runs for stale resolutions (a previously-resolved edge whose callee was re-indexed). The `ON DELETE SET NULL` on `callee_symbol_id` partially helps (stale resolutions become NULL again), but the plan doesn't explain what triggers re-resolution.

### W6: `injections` table has no current consumer

The plan creates an `injections` table and `getInjectionsForFile` adapter function, but nothing in the plan actually CONSUMES injection data. It's explicitly speculative: "future passes can re-parse the injected text." This mirrors the dead `patterns` table — schema without consumers.

### W7: Schema migration ladder is incomplete

The plan introduces `schema_version` and says "checked at `getDb()` open" but provides no migration ladder. What's version 0? What's version 1? What are the idempotent steps? What's the rollback story? The current `initSymbolSchema` uses `CREATE TABLE IF NOT EXISTS` + try/catch ALTER TABLE — the plan doesn't show how these interact with the new `schema_version` table. If `schema_version` doesn't exist yet (pre-upgrade DB), how does the system bootstrap?

### W8: The plan doesn't remove MCP-side compression decision functions

The constraints doc (Priority 0.5, lines 63–71) explicitly lists functions that "exist in MCP today and must move to TOON":
- `computeCompressionBudget`
- `isCompressionUseful`  
- `DEFAULT_COMPRESSION_KEEP_RATIO`
- `truncateToBudget`
- `compressTextFile`

The plan says "tools/compression.ts consumers only swap their imports" but never specifies WHICH functions are removed, what replaces their call sites in `read_file.ts` (line 113: `compressTextFile(validPath, content, maxChars)`) and `read_multiple_files.ts` (line 147: `compressTextFile(validPath, content, effectiveBudget)`), or what the new seam looks like.

### W9: `getFileBlockEdges` returning raw `call_count` — TOON's `_mergeASTEdges` expects `weight`

Looking at `sagerank.ts::_mergeASTEdges` (line 873–909), it receives `Array<{ from: number; to: number; weight: number }>` and multiplies by `astWeight` (default 2.0). The current `getFileBlockEdges` returns `weight: Math.sqrt(call_count)`. If we remove the sqrt and pass raw `call_count`, that means a function called 100 times gets `weight: 100 * 2.0 = 200` vs the current `weight: 10 * 2.0 = 20`. This is a 10× change in edge strength. The plan doesn't address whether TOON's `_mergeASTEdges` needs to apply its own transform, or whether the `weight` field in `ASTEdge` (from `types.ts`) should be renamed to `rawCount`.

### W10: `ref-compression-structure.ts` and `ref-structural-similarity.ts` already exist but aren't referenced

The docs directory contains complete reference implementations:
- `ref-compression-structure.ts` — `getCompressionStructure()` with per-language anchor rules (16 languages)
- `ref-structural-similarity.ts` — `getSymbolStructure()` with `SymbolStructure`, `DEF_TYPES`, structural fingerprinting

These are NOT imported anywhere in the codebase (verified by grep). The plan proposes `structure.ts` and `anchors.ts` that overlap significantly with these reference designs but doesn't acknowledge them. The reference `getSymbolStructure` already implements params/returnKind/parentKind/decorators/modifiers extraction — meaning the plan's `structure.ts` is reinventing what already exists as a reference.

### W11: `c_sharp` vs `csharp` duplication unaddressed

Both `c_sharp-tags.scm` (91 lines, rich captures: field/constructor/delegate/enum/enumerator/event/interface/method/namespace/property/record/struct) and `csharp-tags.scm` (19 lines, minimal: only function/class/method) exist with DIFFERENT content. The `languages.ts` maps `.cs` → `'csharp'`, so the rich `c_sharp-tags.scm` is NEVER loaded. This means C# gets impoverished symbol extraction. The plan doesn't address this.

### W12: Loose `tree-sitter-javascript.wasm` at grammars root

A `tree-sitter-javascript.wasm` exists at `/packages/zenith-mcp/grammars/` (alongside `tree-sitter.wasm`) AND the canonical one is at `/packages/zenith-mcp/grammars/grammars/tree-sitter-javascript.wasm`. The `runtime.ts` loads from `GRAMMARS_DIR` (the `grammars/grammars/` path), so the root-level copy is dead weight. Plan doesn't address this.

### W13: `imports.ts` claims to reuse `@reference.import`/`@reference.module` captures but they come from `<lang>-tags.scm`

The `python-tags.scm` does include `@reference.import` and `@reference.module` captures. So `getSymbols` already returns these as `kind:'ref', type:'import'` or `type:'module'` rows. The plan's `imports.ts` could theoretically just post-process the existing `getSymbols` output rather than needing a separate extractor — but the plan proposes it as a separate tree-sitter pass. This is valid if we want richer data (the module path string, the list of imported names), but the plan should acknowledge that basic import/module refs are ALREADY indexed by `symbol-index.ts` today.

## 3. Fidelity to Constraints/Goals Docs

### Priority 0 (Line-number truth)
Not violated by the plan — the plan doesn't touch compression output formatting.

### Priority 0.5 (Package ownership)

**Partially upheld.** The plan correctly:
- Removes `sqrt(call_count)` from MCP (line 273: "adapter returns raw `call_count` and toon shapes weights inside SageRank's domain")
- Proposes `getFileFacts` as a facts-only aggregate

**Violated by omission.** The plan:
- Does NOT specify removal of `computeCompressionBudget`, `isCompressionUseful`, `DEFAULT_COMPRESSION_KEEP_RATIO`, `truncateToBudget`, `compressTextFile` from MCP
- Does NOT specify what replaces them in `read_file.ts` and `read_multiple_files.ts`
- The constraints doc says these "exist in MCP today and must move to TOON" — the plan leaves them in place

### Forbidden designs
- ✅ No SageRank/BMX+ reimplementation proposed
- ✅ No MCP-side compression decision proposed (the plan's new code is purely extraction/persistence)
- ❌ The plan doesn't REMOVE existing MCP-side compression decisions

### Required engines
- ✅ Plan correctly identifies TOON engines as the consumers of the facts
- ❌ No specification of how `getFileFacts` output maps to TOON's `compressSourceStructured` input types (`StructureBlock[]`, `CompressionContext`)

## 4. Robustness

### FK cascades
Mostly correct. `ON DELETE CASCADE` on child tables means deleting a file's symbols cascades to structures/anchors/local_scopes. `ON DELETE SET NULL` on `edges.callee_symbol_id` is correct — stale cross-file references become NULL rather than orphans.

### What happens when `getSymbols` returns null mid-batch
The plan inherits `indexFile`'s existing behavior: `purgeIndexedPath` removes stale data. But if `extractParsedFile` fails mid-way (tree-sitter parse succeeds but `extractStructure` throws for a specific language), the plan doesn't specify partial-failure handling.

### Grammar upgrades
Additive schema + `body_hash` means re-indexing detects content changes. But schema changes between grammar versions (new captures, renamed node types) could silently produce different `capture_tag` values. No versioning of grammar content is proposed.

### Concurrent `indexDirectory` + single-file `indexFile`
Both use `runTransaction`, and SQLite WAL handles concurrent reads. But two concurrent `indexFile` calls for the same file could produce duplicate work (both check hash, both proceed). The plan doesn't add locking beyond what `busy_timeout` provides.

## 5. Does it maximize AST extraction from the grammars?

### Captures the plan DOES surface:
- `@name.definition.*` / `@definition.*` → symbols table ✅
- `@name.reference.*` / `@reference.*` → symbols table + edges ✅
- `@reference.import` / `@reference.module` → imports table ✅
- `@local.parameter` / `@local.definition` / `@local.reference` → local_scopes table ✅
- Injection content via `injections.scm` → injections table ✅

### Captures the plan MISSES or FLATTENS:

1. **The full `@definition.*` long tail is preserved** via `capture_tag` column — good. C# alone has: field, constructor, delegate, enum, enumerator, event, interface, method, namespace, property, record, struct. These all get stored as `capture_tag = 'definition.field'` etc.

2. **`@reference.property`** (Python attribute access) — present in tags.scm, currently indexed as `kind:'ref', type:'property'`. The plan preserves this.

3. **`@reference.call`** — present in Python/JS/TS tags.scm. Currently indexed. Plan preserves.

4. **C# rich captures ARE lost** because `languages.ts` maps `.cs` → `'csharp'` but the rich tags file is `c_sharp-tags.scm`. Only the minimal `csharp-tags.scm` loads. **Critical gap.**

5. **Injection metadata is correctly proposed** (host lang + injected lang + range) but has no consumer.

6. **The `locals.scm` `@scope` captures** are proposed to be extracted by `locals.ts` — good coverage.

7. **The plan doesn't extract the modular `definitions.scm` captures** that are richer than `<lang>-tags.scm` in some languages. For example, `typescript/definitions.scm` has arrow functions via variable declarator, abstract classes, interface declarations, type aliases — but `typescript-tags.scm` already includes most of these. The modular files are largely a superset. Loading them in ADDITION would produce duplicates unless deduped.

### Loose `tree-sitter-javascript.wasm`
Not addressed. Dead file at grammars root.

### `c_sharp` vs `csharp` alias
Not addressed. Results in impoverished C# extraction.
