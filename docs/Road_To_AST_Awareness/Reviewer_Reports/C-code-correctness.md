# Reviewer C — Code Correctness Deep Review

## Summary
The implementing PR cleared the `any`/cast suppressions the plan example carried and the indexing pipeline is well-typed end-to-end, but a small number of correctness concerns remain — most notably a non-null assertion at the MCP→TOON seam that masks a real `string | null` mismatch, a few unfiltered AST walks in `extract.ts` that can pick the wrong node, and a sub-threshold dedup key in the symbol pass.

## Critical Findings (block merge)
*None.* No bug observed that causes data corruption, incorrect compression output, or schema breakage given current call sites.

## Important Findings (fix before merge)

1. **[suppression] `compression.ts:52` — `type: d.type!` non-null assertion masks a real `string | null` mismatch.**
   `FileFacts.defs[].type` is declared `string | null` (db-adapter.ts:925-ish for `getFileFacts`), but `RawFileFacts.defs[].type` in `zenith-toon/src/types.ts:89` is required `string`. The `!` silences the type error rather than handling the null. In practice the value is currently always populated by `extract.ts:90`, but the compile-time guarantee is broken and this is exactly the kind of "no suppressions" violation called out in `constraints.md`. Replace with `d.type ?? ''` (or tighten the FileFacts column to non-null after a one-shot data check) and remove the `!`.

2. **[edge case] `extract.ts:118-128` — `findDefNode` walks **without** filtering on `DEF_TYPES`.**
   The inner walk matches any node whose `startPosition.row === startRow` and `endPosition.row === endRow`. When a symbol has no `bodyCapture`, `endLine = nameCapture.endPosition.row + 1`, i.e. the row range collapses to the name token. The DFS will then return the name `identifier` node (or another inner span) and pass it to `extractAnchorsForDef`. The downstream effect is silent loss of anchors for that def (the name node has no statement children). The fix is to gate the match on `DEF_TYPES.has(node.type)` like `structure.ts:findDef` already does (line 139), and to keep walking past sibling-row matches.

3. **[edge case] `extract.ts:57` — `seen` dedup key is `${name}:${kind}:${line}`, no column.**
   Two captures on the same line with the same name+kind collide and the second is dropped. The most realistic trigger is a TS multi-declarator (`const a = …, a = …`) or a re-export on the same line. Add `:${column}` to the key (the column is already on `nameCapture.node.startPosition.column`).

4. **[fragile invariant] `persist.ts:18-23` — relies on `INSERT OR REPLACE INTO files` to cascade-clear `imports` and `injections`.**
   `deleteSymbolsByFile` only deletes from `symbols` and cascades to symbol-FK-children (`symbol_structures`, `anchors`, `local_scopes`, edges-via-`callee_symbol_id` SET NULL). `imports` and `injections` are FK'd to `files(path) ON DELETE CASCADE`, not `symbols`. They are only cleared because the subsequent `upsertFile` happens to issue `INSERT OR REPLACE INTO files`, which under SQLite semantics deletes the conflicting row first, triggering the cascade. This is correct today but undocumented and silently breaks if anyone changes upsertFile to `ON CONFLICT DO UPDATE`. Either (a) add an explicit `DELETE FROM imports WHERE file_path = ?` and `DELETE FROM injections WHERE file_path = ?` at the top of `persistParsedFile`, or (b) document the dependency loudly in both files.

5. **[regression risk] `db-adapter.ts:174-244` — v0→v1 migration is not atomic.**
   The `ALTER TABLE … ADD COLUMN` statements and the subsequent `db.exec` of the child-table CREATEs are not wrapped in `BEGIN/COMMIT`. If the second `db.exec` block throws (e.g. permission/disk error mid-batch), `schema_version` is never bumped, but the four ADDed columns remain. On the next process start, `currentVersion < 1` is still true, the ALTERs are retried — the duplicate-column errors are swallowed correctly, so this is *idempotent* — but a partial run leaves a window where the schema is half-migrated and `getFileFacts` (which reads `capture_tag`) can succeed against rows whose values were never written by `updateSymbolExtras`. Recommend wrapping the migration body in `runTransaction` (DDL is transactional in SQLite).

## Minor / Style Observations (non-blocking)

- **`structure.ts:107` references `MODIFIER_KEYWORDS` before its const declaration at line 116.** This is legal — the function body executes at call time, after module init — but the reverse order will trip up readers and any future refactor that hoists initialization. Move the `const MODIFIER_KEYWORDS` declaration above `modifierKeywordsFor` to remove the apparent TDZ smell.
- **`db-adapter.ts:910` `queryRaw(... ...params: any[]): any[]`** still uses `any` — pre-existing, not introduced by this PR; flagged so it isn't lost.
- **`db-adapter.ts:998-1023` `findSymbolStructuresByName`** parses `params_json` etc. with `JSON.parse(...)`, whose return is `any` and is silently cast to `string[]` via the declared return type. Functionally fine (round-trip is lossless for `string[]`), but consider validating shape, or at least asserting with `as unknown as string[]` to make the type lattice explicit.
- **`compression.ts:35`** `let dbFacts: FileFacts = { defs: [], edges: [], anchors: [], imports: [], injections: [] };` is fine, but with `exactOptionalPropertyTypes` you must keep every key present (it does); a future drop of one of them would silently become a typed bug.
- **`anchors.ts:228-232` `DEF_NODE_TYPES`** is rebuilt per call. Negligible but trivially hoistable as a module-level `const`.
- **`locals.ts:71-72`** "directChild" predicate uses *strict* containment `iStart > scopeStartRow && iEnd < scopeEndRow`. If a child scope starts/ends on the same line as the outer scope (single-line lambda/anonymous block), it will not be flagged inner and its params/locals will be claimed by both scopes. Realistic only on JS/TS one-liners; minor.
- **`injections.ts:73-79`** the two-level `match.setProperties` → `query.setProperties[match.patternIndex]` lookup is implemented exactly per the d.ts annotations and uses no casts. Good.
- **`resolve.ts:51-55`** strict dot-qualified rule: `findSymbolByNameUnique(shortName)` then `findSymbolParent(shortTarget.id).name === qualifier`. Implemented correctly; the parent check uses `parent_symbol_id` (db-adapter.ts:1098) — not the heuristic null-parent fallback. ✓
- **`resolve.ts:35` / `db-adapter.ts:1077-1085`** `findSymbolByNameUnique` does `LIMIT 2` and returns null unless `rows.length === 1`. Correct.
- **`symbol-index.ts:276-278`** `resolveEdgeTargets` is correctly called once-per-file *after* the batch index loop completes — matches the plan.
- **`db-adapter.ts:583`** the `Math.sqrt(call_count)` damping has been removed from `getFileBlockEdges`; raw `call_count` is now returned, with a comment ceding sqrt to TOON. ✓
- **`string-codec.ts:63 / 1445 / 1490`** single `_MIN_OMISSION_THRESHOLD = 6` declaration; 0.70 keep-floor enforced in both `compressString` and `compressSourceStructured`. ✓
- **`string-codec.ts:1291-1310`** Phase H assertion is present in the structured-source emitter — but **only there**. The other four emitters (`_compressStackTrace` 153-343, `_compressLog` 462-647, `_compressSourceCode` 656-953, `_contentAwareTruncate` 1345-1437) inline the threshold check but do not throw on Priority-0 violations. The constraint document phrases the assertion as singular ("before Phase H emits"), so this is arguably compliant, but if the project intent is "every emitter validates", three more emitters need the same final-set walk.
- **`string-codec.ts:1322 / 1369`** per-line cost includes the `${idx+1}. ` prefix width, so output cannot exceed `budget`. ✓ The structured emitter's final budget-break at 1328/1332 enforces this on emit.

## Per-File Notes

### `extract.ts`
- `nameCapture: QueryCapture | null` and `bodyCapture: QueryCapture | null` are properly typed (lines 41-42). The plan's `any` was fixed. ✓
- Tag parsing slices: `'name.definition.'.length === 16`, `'name.reference.'.length === 15` — correct.
- `bestParent` containment uses `d.line <= s.line && d.endLine >= s.endLine` and minimizes `endLine - line` span; correct selection of *smallest enclosing* def. (Self is excluded via `if (d === s) continue`.)
- `endLine` fallback to `nameCapture.endPosition.row + 1` when there's no body capture is consistent with `symbols.ts`, but combined with the unfiltered `findDefNode` (Important #2) it can produce empty anchor sets for declaration-style defs.
- Visibility derivation order at lines 103-105: export/public/pub → private → protected. The order is fine because each `else if` is mutually exclusive on disjoint keyword sets. ✓
- Edge containment (lines 168-178) uses the same innermost-def heuristic; good.
- `seen` dedup key (Important #3) — drop second occurrence on same line.

### `persist.ts`
- Single `runTransaction` wraps **all** writes (line 19). ✓
- `parentSymbolKey` resolution depends on insertion order: parents must be inserted before children for `keyToId.get(parentKey)` to succeed. Because `rawSymbols.sort((a,b) => a.line - b.line)` in extract.ts orders by source line, an enclosing parent's name-line is *always* less than the child's, so `keyToId` is always populated when the child is processed. ✓ (Worth a comment, since it isn't obvious why this works.)
- FK cascade reliance for `imports`/`injections` is fragile — see Important #4.
- JSON.stringify round-trip: `params: string[]`, `decorators: string[]`, `modifiers: string[]`, `parameters/locals: { name; line; column }[]` — all JSON-safe, no `undefined` values. ✓

### `resolve.ts`
- All updates inside one `runTransaction`. ✓
- Strict dot-qualified rule implementation is correct; parent lookup goes through `parent_symbol_id` FK, not heuristic.
- `findSymbolByNameUnique` LIMIT 2 / length===1 check is correct.

### `types.ts`
- Boundary types match producer (`extract.ts`) and consumer (`persist.ts`) exactly.
- `AnchorRow.line` is **0-based** (line 33 comment); `LocalScopeRow.startLine/endLine` are **1-based** (extract.ts line 162). The mismatch is intentional but undocumented across the boundary — consider adding a comment in `types.ts` flagging the per-field convention.

### `structure.ts`
- TDZ ordering nit only (Minor).
- `paramContainersFor`/`modifierKeywordsFor` fallbacks correct. ✓
- `findDef` correctly handles both exact-span and `decorated_definition` wrapper (lines 138-156) — note the wrapper case at 146-150 `node.endPosition.row === endRow` lets the wrapper match if its body's last row aligns. ✓
- `collectParams` recursion: stops at nested defs via `if (!isRoot && DEF_TYPES.has(node.type)) return false;`. ✓

### `anchors.ts`
- `walk(depth=0)` does not skip self at the root; `if (depth > 0 && DEF_NODE_TYPES.has(node.type)) return;` skips only nested defs. ✓
- `defStartRow` filter `node.startPosition.row > defStartRow` excludes the signature line itself. ✓
- `DEF_NODE_TYPES` is a small subset of `runtime.ts:DEF_TYPES` (intentional — only "function-like" containers count for anchor-stop). Acceptable.

### `injections.ts`
- Two-level setProperties lookup is correct and uncast (relies on the d.ts types). ✓

### `locals.ts`
- "Direct child" filter algorithm: O(scopes²) but correct for nested scopes. Edge case for same-row containment noted in Minor.

### `imports.ts`
- `byLine` grouping assumes refs on the same source line belong to the same import. True for nearly all single-line `import …` statements. Multi-line imports (`import {\n a,\n b \n} from 'x'`) — every `imported` ref will be on its own line, so each gets its own `ImportEdge` row with `module: importRefs[0]!.name` (since `moduleRef` is on yet a different line). Result: per-language behavior leaks here. Could be improved by walking up to the enclosing import statement node, but the current behavior is consistent with the previous implementation and not a regression.

### `db-adapter.ts`
- v0→v1 migration ladder: idempotent on retry (Important #5 about atomicity, not idempotence).
- ALTER try/catch correctly swallows only `duplicate column` / `already exists`. ✓
- `getFileFacts` SQL projection matches `FileFacts` interface (`capture_tag AS captureTag`, `end_line AS endLine`). ✓
- `findSymbolParent` JOIN on `parent_symbol_id` is correct.
- `Math.sqrt(call_count)` removed from line 583. ✓
- No new `as any` casts in the new functions.

### `symbol-index.ts`
- `indexFile` correctly returns early on errors via `purgeIndexedPath` + return. ✓
- `indexDirectory` calls `resolveEdgeTargets` once per file *after* the parallel batch indexing completes (lines 268-278). ✓ Matches plan.

### `compression.ts`
- Imports exactly `{ compressFile } from 'zenith-toon'`. ✓
- Empty-facts default in catch (DB unavailable) is correct.
- Field mapping to `RawFileFacts` is complete, **except** for the `d.type!` non-null assertion (Important #1).

### `read_file.ts` / `read_multiple_files.ts` / `refactor_batch.ts`
- `compressForTool` is awaited; `null` is handled (`if (compressed !== null) content = compressed;`). ✓
- `read_multiple_files.ts` budget math: `effectiveBudget = Math.max(0, budget - entryPrefix.length)` is identical to the prior implementation; the pre-existing entry-prefix concern is preserved, not regressed.
- `refactor_batch.ts` correctly populates `SymbolStructure` from `findSymbolStructuresByName`, removing the pre-existing TODOs.

### `string-codec.ts` (`zenith-toon`)
- `compressFile` (1503-1525) parses inputs, builds `StructureBlock[]` and `CompressionContext`, calls `compressSourceStructured` which floors at 70% (1490-1491). ✓
- Single `_MIN_OMISSION_THRESHOLD = 6` declaration (line 63); all uses point here. ✓
- Phase H assertion (1291-1310) is present in the structured-source emitter. Not present in the four other emitters (Minor).
- Per-line cost charges the `N. ` prefix width; budget-break loops at 1322-1336 keep output within `budget`. ✓
- Output lines are emitted as `${idx+1}. ${verbatim}` and gap markers as flush-left `[TRUNCATED: lines X-Y]` per the spec. ✓

## Final Verdict
- Critical issues: 0
- Important issues: 5
- Minor issues: ~12
- **Recommendation: NEEDS-FIXES** — none of the Important findings are merge-blockers in the strict sense (current behavior is correct on the inputs the test suite exercises), but at least #1 (suppression at the seam), #2 (unfiltered findDefNode), and #3 (dedup key missing column) are cheap, mechanical fixes that should be done before merge to honor the "no suppressions / strict typing" mandate from `constraints.md` and to avoid silent fact-loss in indexing.
