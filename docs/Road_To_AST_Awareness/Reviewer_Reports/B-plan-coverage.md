# Reviewer B — Plan Coverage Audit

## Summary
22 of 24 tasks fully implemented; 1 partial; 1 missing.

## Per-Task Findings

### Task 2 — runtime.ts DEF_TYPES
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/runtime.ts:67-90`
- Notes: Exported `ReadonlySet<string>` with all specified node types (JS/TS, Rust, Go, Java/Kotlin, Python, C/C++, C#). Matches plan exactly.

### Task 3 — runtime.ts QUERIES_LANG_MAP
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/runtime.ts:319-356`
- Notes: Exported `Readonly<Record<string, readonly string[]>>` with 27 languages. Matches plan.

### Task 4 — runtime.ts getCompiledModularQuery()
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/runtime.ts:366-404`
- Notes: Async function with cache, QUERIES_LANG_MAP fast-reject, graceful error handling. Matches plan.

### Task 5 — languages.ts .cs/.csx → c_sharp
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/languages.ts:64,66`
- Notes: Both `.cs` and `.csx` map to `'c_sharp'` as specified.

### Task 6 — tree-sitter/capture-tags.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/capture-tags.ts` (35 lines)
- Notes: Exports `parseCaptureTag` and `ParsedCaptureTag` interface. Pure function, no sibling imports. Matches plan verbatim.

### Task 7 — tree-sitter/body.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/body.ts` (27 lines)
- Notes: Exports `bodySlice` (1-based inclusive range) and `bodyHash` (SHA-1). Matches plan verbatim.

### Task 8 — tree-sitter/structure.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/structure.ts`
- Notes: Exports `extractStructureForDef`, `SymbolStructure`, `paramContainersFor`, `modifierKeywordsFor`. Per-language PARAM_CONTAINERS_BY_LANG (18 langs) and MODIFIER_KEYWORDS_BY_LANG (6 langs). Matches plan.

### Task 9 — tree-sitter/anchors.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/anchors.ts`
- Notes: Exports `extractAnchorsForDef` and `AnchorEntry`. ANCHOR_RULES covers exactly 18 languages (javascript, typescript, tsx, python, go, rust, java, c, cpp, c_sharp, kotlin, php, ruby, swift, bash, lua, nix, scss). Nested-def skip logic present. Matches plan.

### Task 10 — tree-sitter/imports.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/imports.ts` (48 lines)
- Notes: Exports `extractImportsFromSymbols` and `ImportEdge`. Groups by line, identifies module vs import refs. Matches plan.

### Task 11 — tree-sitter/injections.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/injections.ts` (96 lines)
- Notes: Exports `extractInjections` and `InjectionSpan`. Two-level `setProperties` lookup present (match-level then pattern-level). Matches plan.

### Task 12 — tree-sitter/locals.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter/locals.ts` (123 lines)
- Notes: Exports `extractLocals`, `LocalScope`, `LocalSymbol`. Scope-attribution algorithm with direct-child check for nested scopes present. Matches plan.

### Task 13 — core/indexing/types.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/indexing/types.ts` (79 lines)
- Notes: All 8 interfaces present: `SymbolRow`, `StructureRow`, `AnchorRow`, `ImportRow`, `InjectionRow`, `LocalScopeRow`, `RawEdgeRow`, `ParsedFileRecord`. No runtime imports. Matches plan.

### Task 14 — core/indexing/extract.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/indexing/extract.ts`
- Notes: Single-parse orchestrator. Parses once, shares rootNode across all extractors (structure, anchors, imports, injections, locals, edges). Returns `ParsedFileRecord`. No re-parse. Matches plan.

### Task 15 — core/indexing/persist.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/indexing/persist.ts` (69 lines)
- Notes: Single-transaction writer via `runTransaction`. Uses FK cascades (deleteSymbolsByFile first). All 9 steps (clear, upsert file, symbols, edges, structures, anchors, imports, injections, locals). Matches plan.

### Task 16 — core/indexing/resolve.ts (NEW)
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/indexing/resolve.ts` (58 lines)
- Notes: Strict dot-qualified resolution present (qualifier check via `findSymbolParent`). Groups by name. Uses `findSymbolByNameUnique` LIMIT-2 unambiguity check. Matches plan.

### Task 17 — core/db-adapter.ts schema + adapter functions
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/db-adapter.ts:178-245` (migration ladder), `:921-1182` (new adapter functions)
- Notes: schema_version table + v0→v1 migration. All new tables created (symbol_structures, anchors, imports, local_scopes, injections, project_roots). All new indexes. All new columns (capture_tag, body_hash, parent_symbol_id, visibility on symbols; callee_symbol_id on edges). ~18 new adapter functions present (updateSymbolExtras, insertSymbolStructure, getSymbolStructure, findSymbolStructuresByName, insertAnchor, getAnchorsForFile, insertImport, getImportsForFile, getFilesImporting, insertInjection, getInjectionsForFile, insertLocalScope, getLocalScopesForSymbol, getUnresolvedEdges, findSymbolByNameUnique, findSymbolParent, updateEdgeCalleeSymbol, getFileFacts, getSchemaVersion). `Math.sqrt(call_count)` removed — raw `row.call_count` at line 583. **Missing: `insertPattern` and `getPattern`** (see Task 24).

### Task 18 — core/symbol-index.ts delegation
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/symbol-index.ts:185-219` (indexFile), `:226-279` (indexDirectory + resolve), `:119-129` (getDb + upsertProjectRoot)
- Notes: `indexFile` delegates to `extractParsedFile`/`persistParsedFile`. `indexDirectory` calls `resolveEdgeTargets` post-batch. `getDb` calls `upsertProjectRoot`. All three sub-requirements met.

### Task 19 — core/compression.ts gutted
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/compression.ts` (70 lines)
- Notes: Exports only `compressForTool`. Single import of `compressFile` from zenith-toon. No deleted helpers remain (compressTextFile, truncateToBudget, computeCompressionBudget, isCompressionUseful, DEFAULT_COMPRESSION_KEEP_RATIO all absent). No StructureBlock/CompressionContext imports. Matches plan invariants.

### Task 20 — tools/read_file.ts wired
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/tools/read_file.ts:6,114`
- Notes: Imports `compressForTool` from compression.js. Calls it at line 114. Matches plan.

### Task 21 — tools/read_multiple_files.ts wired
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/tools/read_multiple_files.ts:5,151`
- Notes: Imports `compressForTool` from compression.js. Calls it at line 151. Matches plan.

### Task 22 — tools/refactor_batch.ts uses compressForTool
- Status: PARTIAL
- Location: `packages/zenith-mcp/src/tools/refactor_batch.ts:14,471-491,979-984`
- Notes: The `findSymbolStructuresByName` DB lookup and structural outlier detection (findModal, firstDiffReason) are fully wired at both sites (loadDiff handler line 471 and reapply handler line 979). However, the plan also specifies that `refactor_batch.ts` should use `compressForTool` — grep shows NO `compressForTool` import or call in this file. The plan's Task 22 title says "uses compressForTool (not deleted helpers)" but the actual task spec body (lines 2080-2117) only specifies wiring `findSymbolStructuresByName` for structural outlier detection — it does NOT add `compressForTool`. **The structural outlier wiring is complete; the `compressForTool` expectation from the prompt's task summary is misleading — the actual plan spec does NOT require it here.** Re-reading the v3 plan Task 22 body confirms it is about un-breaking outlier detection via `findSymbolStructuresByName`, not about compression. Revising status to COMPLETE.

### Task 23 — core/tree-sitter.ts barrel exports
- Status: COMPLETE
- Location: `packages/zenith-mcp/src/core/tree-sitter.ts:33-40`
- Notes: All 7 new modules re-exported (runtime extras, structure, anchors, imports, injections, locals, body, capture-tags). Matches plan.

### Task T — zenith-toon compressFile
- Status: COMPLETE
- Location: `packages/zenith-toon/src/string-codec.ts:1503`, `packages/zenith-toon/src/types.ts:83-105`, `packages/zenith-toon/src/index.ts:35,98-99`
- Notes: `compressFile(req: CompressFileRequest)` exported. `RawFileFacts` and `CompressFileRequest` types defined. Single import in MCP (`compression.ts:19`). Matches plan.

### Task 24 — patterns table wiring
- Status: MISSING
- Location: N/A
- Notes: The `patterns` table DDL exists in `initSymbolSchema` (line 126-132), but the **adapter functions `insertPattern` and `getPattern` are NOT implemented** anywhere in `db-adapter.ts`. `refactor_batch.ts` has no imports of or references to `insertPattern`/`getPattern`. The plan explicitly calls this out as potentially deferrable ("this may be DEFERRED in PR; flag if so"). **Flagged as deferred/missing.**

## Missing or Partial Tasks (Blockers for Merge)

1. **Task 24** (patterns table wiring) — MISSING. `insertPattern` and `getPattern` adapter functions not implemented; `refactor_batch.ts` does not wire them. The `patterns` table DDL exists but is unused.

## Deviations from Plan (Implementation diverges from spec)

1. **Task 14 (extract.ts)** — Plan imports `parseCaptureTag` from `capture-tags.ts`, but the actual implementation in the PR does NOT import `parseCaptureTag`. Instead it inlines the capture-name parsing logic (lines 49-52: `tag.startsWith('name.definition.')` etc.). This is functionally equivalent but deviates from the plan's import specification. Low risk.

2. **Task 11 (injections.ts)** — The plan uses direct property access on well-typed fields (`match.setProperties?.['injection.language']`). The PR implementation uses the same logic but with slightly different casting approach — functionally equivalent, matches the two-level lookup requirement.

3. **Task 22** — The prompt's task summary says "uses `compressForTool` (not deleted helpers)" but the actual v3 plan body for Task 22 specifies only structural outlier detection wiring. `refactor_batch.ts` never used compression helpers in the plan; this appears to be a prompt inaccuracy, not a code omission.

## Final Verdict

**23 of 24 tasks implemented (22 complete + 1 [Task 22] clarified as complete per actual plan spec). Task 24 (patterns table wiring) is missing and should be flagged as DEFERRED.** The PR is merge-ready with Task 24 tracked as follow-up work — it has no current consumer and the dormant table remains intact for future activation.
