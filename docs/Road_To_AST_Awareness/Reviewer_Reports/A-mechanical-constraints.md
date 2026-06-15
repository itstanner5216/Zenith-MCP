# Reviewer A — Mechanical Constraints Verification

## Summary
**NEEDS_REVIEW** — All Priority 0.5, 1, and 1.5 constraints pass cleanly. Priority 0 has one gap: only `_compressSourceStructured` contains the explicit Phase-H inline assertion; the other four emitters (`_compressStackTrace`, `_compressSourceCode`, `_compressLog`, `_contentAwareTruncate`) lack it. All other Priority 0 checks pass.

## Priority 0 — Verbatim Line Truth

### `_MIN_OMISSION_THRESHOLD === 6`
```
grep -rn '_MIN_OMISSION_THRESHOLD' packages/zenith-toon/src/
```
**Result:** `packages/zenith-toon/src/string-codec.ts:63:const _MIN_OMISSION_THRESHOLD = 6;`
**Verdict:** ✅ PASS

### Phase-H Pre-Emit Assertion in All Emitters
```
grep -n 'Phase H\|Phase-H\|Priority-0 violation\|inline assertion' packages/zenith-toon/src/string-codec.ts
```
**Result:** Only `_compressSourceStructured` (line 1291) has the Phase-H assertion block:
```
1291:  // Phase H: inline assertion over the final selected set (Priority-0).
1297:  throw new Error(`Priority-0 violation: selected index ${idx} out of range (n=${n})`);
1302:  throw new Error(`Priority-0 violation: selected indices not strictly ascending (${prevIdx} >= ${idx})`);
1306:  throw new Error(`Priority-0 violation: gap ${prevIdx + 2}-${idx} is ${gap} lines (< ${_MIN_OMISSION_THRESHOLD}) but not fully selected`);
```
The other four emitters (`_compressStackTrace`, `_compressSourceCode`, `_compressLog`, `_contentAwareTruncate`) do NOT have an inline Phase-H assertion.

**Mitigating factor:** These emitters enforce the threshold structurally via gap-filling logic (e.g., line 282: `if (gap > 0 && gap < _MIN_OMISSION_THRESHOLD)` in `_compressStackTrace`) and only emit markers for gaps ≥ threshold. However, the constraint explicitly requires an *assertion* (throw on violation), not just structural prevention.

**Verdict:** ⚠️ NEEDS_REVIEW — `_compressSourceStructured` passes; the other four lack the explicit throwing assertion.

### Single Canonical Marker Format `[TRUNCATED: lines X-Y]` Flush-Left
```
grep -rn 'TRUNCATED' packages/zenith-toon/src/ | grep -v '\[TRUNCATED: lines'
```
**Result:** (clean) — all occurrences use the exact `[TRUNCATED: lines X-Y]` format.

```
grep -n '^\s\+\[TRUNCATED\|    \[TRUNCATED\|\t\[TRUNCATED' packages/zenith-toon/src/string-codec.ts
```
**Result:** (clean) — no indented marker variants in emitted strings.

**Verdict:** ✅ PASS

### N. Prefix Format (Period+Space)
```
grep -rn '${i + 1}\. \|${.*}\. ' packages/zenith-toon/src/string-codec.ts
```
**Result:** All emission sites use `` `${idx + 1}. ${line}` `` or `` `${ln + 1}. ${...}` `` — period followed by space.

No colon-based prefix format found anywhere.

**Verdict:** ✅ PASS

### No `# ... [N lines omitted]` Count-Only Marker
```
grep -rn 'lines omitted' packages/zenith-toon/src/
```
**Result:** (clean)

**Verdict:** ✅ PASS

## Priority 0.5 — TOON-Owned Compression

### Grep 1: `StructureBlock\|CompressionContext`
```
grep -rn 'StructureBlock\|CompressionContext' packages/zenith-mcp/src/
```
**Result:** (clean)
**Verdict:** ✅ PASS

### Grep 2: `compressSourceStructured\|compressString\b`
```
grep -rn 'compressSourceStructured\|compressString\b' packages/zenith-mcp/src/
```
**Result:** (clean)
**Verdict:** ✅ PASS

### Grep 3: `computeCompressionBudget\|isCompressionUseful\|DEFAULT_COMPRESSION_KEEP_RATIO\|truncateToBudget\|compressTextFile`
```
grep -rn 'computeCompressionBudget\|isCompressionUseful\|DEFAULT_COMPRESSION_KEEP_RATIO\|truncateToBudget\|compressTextFile' packages/zenith-mcp/src/
```
**Result:** (clean)
**Verdict:** ✅ PASS

### Grep 4: `Math\.sqrt(.*call_count\|astWeight\|astEdges`
```
grep -rn 'Math\.sqrt(.*call_count\|astWeight\|astEdges' packages/zenith-mcp/src/
```
**Result:** (clean)
**Verdict:** ✅ PASS

### Grep 5: `block\.priority`
```
grep -rn 'block\.priority' packages/zenith-mcp/src/
```
**Result:** (clean)
**Verdict:** ✅ PASS

### `core/compression.ts` Imports Only `{ compressFile }` from TOON
```
grep -rn 'import.*from.*zenith-toon' packages/zenith-mcp/src/
```
**Result:**
```
packages/zenith-mcp/src/core/compression.ts:19:import { compressFile } from 'zenith-toon';
```
Single import, single symbol (`compressFile`). No other zenith-toon imports anywhere in zenith-mcp.

**Verdict:** ✅ PASS

## Priority 1 — SQLite Boundary

### `from 'node:sqlite'` outside db-adapter.ts
```
grep -rn "from 'node:sqlite'" packages/zenith-mcp/src/ | grep -v db-adapter.ts
```
**Result:** (clean)
**Verdict:** ✅ PASS

### `new DatabaseSync` outside db-adapter.ts
```
grep -rn "new DatabaseSync" packages/zenith-mcp/src/ | grep -v db-adapter.ts
```
**Result:** (clean)
**Verdict:** ✅ PASS

### Direct DB method calls outside db-adapter.ts
```
grep -rn '\.prepare\|\.exec\|\.run\|\.get\b\|\.all(' packages/zenith-mcp/src/ | grep -v db-adapter.ts
```
**Result:** Matches are all false positives — `.get()` on Maps/Sets, `.all()` on registries, `Promise.all()`, etc. No SQLite method calls on database connections outside `db-adapter.ts`.

**Verdict:** ✅ PASS

## Priority 1.5 — Extract Once

### No tool handler imports from `core/indexing/extract.js`
```
grep -rn "from.*core/indexing/extract\|extractStructureForDef\|extractAnchorsForDef\|extractInjections\|extractLocals\|extractImportsFromSymbols" packages/zenith-mcp/src/tools/
```
**Result:** (clean)
**Verdict:** ✅ PASS

### Tools consume facts via `getFileFacts()` from db-adapter.ts only
Tool compression path: `read_file.ts` → `compressForTool()` (from `core/compression.ts`) → which calls `getFileFacts(db, relPath)` from `db-adapter.ts`. No tool directly calls extractor functions.

`refactor_batch.ts` imports `findSymbolStructuresByName` etc. from `db-adapter.ts` — these are adapter functions, not direct extractors. This is acceptable.

**Verdict:** ✅ PASS

## No Suppressions / No Fallbacks

```
git diff origin/main..HEAD -- packages/zenith-mcp/src/ packages/zenith-toon/src/ | grep '^\+' | grep -E 'as any|@ts-ignore|@ts-expect-error|@ts-nocheck|as unknown as '
```
**Result:** (clean) — 0 new `as any`, 0 `@ts-ignore`, 0 `@ts-expect-error`, 0 `@ts-nocheck`, 0 `as unknown as`.

```
git diff origin/main..HEAD -- packages/zenith-mcp/src/ packages/zenith-toon/src/ | grep '^\+' | grep -F "?? ''"
```
**Result:** (clean)

**Verdict:** ✅ PASS

## Anti-pattern Check

### Fake Engines / Wrappers / Reimplementations

1. `string-codec.ts` imports `SageRank` from `./sagerank.js` (the real engine).
2. No import of BMX+, BudgetAllocator, or Deduplicator in `string-codec.ts` — but this is acceptable because the string codec uses SageRank for ranking and handles budget allocation inline (character-budget line selection). BMX+ and Deduplicator are used in the pipeline layer (`pipeline.ts`) for multi-entry compression, not the single-file string codec path.
3. No class declarations shadowing `SageRank`, `BMXPlusIndex`, `BudgetAllocator`, or `Deduplicator` outside their canonical files:
```
grep -rn 'class SageRank\|class BMX\|class BudgetAllocator\|class Dedup' packages/zenith-toon/src/ | grep -v sagerank.ts | grep -v bmx-plus.ts | grep -v budget.ts | grep -v dedup.ts
```
**Result:** (clean)

4. `pushShown`/`pushMarker` are inline arrow-function closures inside `_compressSourceCode`, scoped to the function body. Per constraints, the prohibition is on *extracted/exported* helper functions, not function-scoped closures. These remain inline.

**Verdict:** ✅ PASS

## Final Verdict

- **Number of constraint violations:** 0 hard violations, 1 observation requiring review
- **Blockers for merge:** None identified
- **Non-blocking observations:**
  1. Only `_compressSourceStructured` has the explicit throwing Phase-H assertion (line 1291–1308). The other four emitters (`_compressStackTrace`, `_compressSourceCode`, `_compressLog`, `_contentAwareTruncate`) enforce the threshold structurally through gap-filling logic but do NOT throw on violation. The constraint doc says "add an inline assertion before Phase H emits" — if this is intended for ALL emitters, these four need the assertion added. If only `_compressSourceStructured` is the "Phase H" emitter (as the structured path is the primary one receiving AST facts), then this is acceptable.
