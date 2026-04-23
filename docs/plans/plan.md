# Pre-Batch Cleanup Sweep — Execution Plan

**Goal:** Eliminate every remaining bug/dead-code/duplication/response-discipline issue from prior code review so codebase is clean foundation for `refactor_batch` plan.
**Total Waves:** 1
**Total Tasks:** 4
**Max Parallel Tasks in Single Wave:** 4

## Wave 1 (4 parallel tasks, all on disjoint files)

1. **Task 1.1** — Create `dist/core/edit-engine.js` with extracted helpers:
   - Lift verbatim from `edit_file.js:283-409`: `findMatch`, `findOccurrence`, `mapTrimmedIndex`, `findOriginalEnd`, `generateDiagnostic`
   - NEW: `applyEditList(content, edits, {filePath, isBatch, disambiguations?})` returning `{workingContent, errors[]}` — pure function, no I/O
   - NEW: `syntaxWarn(filePath, content)` returning warning string
   - Exports: `findMatch`, `applyEditList`, `syntaxWarn` only

2. **Task 1.2** — Refactor `dist/tools/edit_file.js`:
   - Delete batch infra (lines 23-65, 67-112, 114-277, 283-409, 411-412, helper at 11-19)
   - Trim imports to: zod, fs, randomBytes, path, lib (normalizeLineEndings, createMinimalDiff), stash (stashEdits), engine (findMatch, applyEditList, syntaxWarn)
   - Tool description → `"Edit a text file."`
   - Replace handler with engine-driven version (~80-110 lines total)
   - Tighter ambiguous-block error: `Ambiguous: lines X-Y. stash:N`
   - Drop unused `repoRoot` local at :444
   - Drop unreachable validations at :498-499, :522

3. **Task 1.3** — Refactor `dist/tools/stash_restore.js`:
   - Fix 1 (BUG): add `dryRun` to restore-mode schema
   - Fix 2: `type` enum → `['edit', 'write']` (drop fake `'symbol'`)
   - Fix 3: delete unused `abs` variable
   - Fix 4: replace unreachable third-type else with explicit throw
   - Fix 5: import findMatch+applyEditList+syntaxWarn from `../core/edit-engine.js`
   - Fix 6: replace inline edit dispatch with `applyEditList` (passing disambiguations Map)
   - Fix 7: replace inline syntax check with `syntaxWarn`
   - Fix 8: empty-list message → `Empty.` / `Empty. (global)`
   - Fix 9: success messages → `Cleared.` and `Applied.${warning}` (no stashId parroting)
   - Fix 10: unify read-mode format → `[type] path\n...`

4. **Task 1.4** — Delete `dist/tools/_parked_batch_analysis.js` (no callers, comment-only)

## Wave 1 Verification

```bash
for f in dist/core/edit-engine.js dist/tools/edit_file.js dist/tools/stash_restore.js; do node -c "$f"; done
test ! -e dist/tools/_parked_batch_analysis.js
grep -rn "from './edit_file.js'" dist/tools/  # expect no matches
grep -rn "_batchSession\|loadDiff\|_parked_batch_analysis" dist/  # expect no matches
npm test
```

## Resolves issues

1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 (full coverage of remaining findings).

After this plan + `batched_symbol_editing.md` execution → zero remaining findings.
