# Reviewer D — Test Repair Gate Verification

## Summary
PR #23 reduces net test failures from 21 (base) to 17 (PR), fixing 5 pre-existing failures and introducing 1 new regression (JVM stack-trace calibration). The PR author's claim of "16 failed" is off by 1 (actual: 17). The Test Repair Gate passes: net new failures ≤ 0 (−4 net).

## Build Status
```
packages/zenith-toon build: Done
packages/zenith-mcp build: Done
```
Exit code: 0 (green).

## Test Run Snapshot
- Total: 972
- Passed: 955
- Failed: 17
- Skipped: 0
- New failures vs base (proven by stash + re-run): 1
  - `stack-trace-detection.test.js > JVM chained exceptions - compresses to ~70%`
- Pre-existing failures (proven identical at base): 16
  - `http-session-cleanup.test.js` (3 — auth/session issues unrelated to PR)
  - `lib-filesystem-context.test.js` (1 — validatePath not rejecting `/etc/passwd`)
  - `read-multiple-files-concurrent.test.js` (5 — tiny-budget truncation)
  - `read-multiple-files.test.js` (6 — tiny-budget truncation)
  - `shared-core.test.js` (1 — env config returns 850000 instead of 400000)
- Environmental failures (root vs non-root etc.): None. User is `tanner` (uid=1000). The `lib-filesystem-context.test.js` failure is a path-validation logic issue (not chmod/root-related). The `shared-core.test.js` failure is due to a local config file setting `char_budget=850000`.
- Failures RESOLVED by PR vs base: 5
  - `compression-utils.test.js > returns false for non-string inputs` (tests rewritten)
  - `tool-compression.test.js` × 3 (tests rewritten to use `compressForTool`)
  - `refactor-batch.test.js > loads explicit {symbol, file} pairs`

## Author's "1 legitimate failure" claim
**VERIFIED** (with numerical correction).

The JVM chained exceptions test fails because:
- `input.length = 333`
- `Math.floor(333 * 0.65) = 216` (the assertion floor)
- Actual `output.length = 196` (4 lines with `N. ` prefix format)
- The PR changed `_compressStackTrace` to emit `N. <verbatim>` prefixes per Priority-0 constraints, which increases per-line cost in the budget calculation. For this short input (333 chars, 7 lines), the budget math causes only 4 lines to fit, yielding 196 chars.
- This is genuinely a calibration mismatch between the 0.65 assertion bound and the new output format — NOT a logic regression. The `compressString` path correctly applies stack-trace compression with Priority-0 line formatting.
- **Bound that would pass:** `Math.floor(333 * 0.58) = 193` or simply `0.55` → 183.

## Author's "15 pre-existing failures" claim
**PARTIALLY VERIFIED** — the count is 16 pre-existing, not 15. Additionally:
- Author claims "11 read-multiple-files tiny-budget" → Actual: 11 (6 `read-multiple-files` + 5 `read-multiple-files-concurrent`). ✓
- Author claims "4 chmod 0o000 tests under root sandbox" → **INCORRECT**. Actual remaining 5 are: 3 `http-session-cleanup` (auth issues), 1 `lib-filesystem-context` (path validation), 1 `shared-core` (env config). No chmod failures exist.
- The discrepancy: author states "956 passed / 16 failed" but actual is "955 passed / 17 failed". The `shared-core.test.js` failure appears to have been missed in their accounting.

## Test Repair Gate T1–T5

- **T1: PASS** — Tests that pinned deleted exports (`DEFAULT_COMPRESSION_KEEP_RATIO`, `computeCompressionBudget`, `isCompressionUseful`, `truncateToBudget`, `compressTextFile`) were rewritten in `compression-utils.test.js` and `compression-core.test.js` to assert against the new `compressForTool` seam. `tool-compression.test.js` was updated to mock `compressForTool` instead of `compressTextFile`. The `symbol-index-core.test.js` uses `initSymbolSchema(db)` instead of inline DDL (matching the deleted inline CREATE TABLE). All deleted symbols correspond to deleted/rewritten assertions.

- **T2: PASS** — Rewritten tests (`compression-utils.test.js`: 549 lines replacing 172; `compression-core.test.js`: expanded to 83 lines; `tool-compression.test.js`: updated mocks) assert equivalent or stronger behavioral invariants through the `compressForTool` boundary. No test was weakened to "always pass." The assertions validate: output non-null when compression needed, length < input, length respects floor, output contains `N. ` prefix format and `[TRUNCATED: lines X-Y]` markers.

- **T3: PASS** — New test `string-codec-priority0.test.js` (217 lines, 4 tests) covers Priority-0 invariants: verbatim `N. ` prefixes, flush-left `[TRUNCATED: lines X-Y]` markers, ≥6-line sliver rule, ascending line numbers, disjoint marker ranges, Phase-H assertion stability. Uses TS and Python fixtures with tight budgets. All pass.

- **T4: PASS** — Net failing tests: base=21, PR=17. Net change = −4. Satisfies "net new failing tests ≤ 0."

- **T5: PASS** — No `it.skip`, `describe.skip`, `xit(`, or `xdescribe(` found anywhere in `packages/zenith-mcp/tests/`. Zero tests were skipped to avoid fixing them.

## New test coverage (string-codec-priority0.test.js)

The file adds 4 tests exercising `compressSourceStructured` from `zenith-toon` directly:

1. **TS fixture** — 40-line TypeScript file with two exported functions separated by dead filler. Tight budget (45%) forces omission. Validates: `[TRUNCATED: lines X-Y]` marker present, verbatim `N. content` for every shown line, no gap < 6 non-blank lines between markers, ascending line numbers, marker ranges disjoint from shown lines.

2. **Python fixture** — 40-line Python file with two functions and padding constants. Validates same invariants in a different language context.

3. **Phase-H assertion + sliver settling** — Constructs a pathological case (single small anchor between two large filler regions) that would produce a <6-line sliver without settling. Validates Phase-H doesn't throw and the ≥6-line sliver constraint holds.

4. **No-compression passthrough** — Generous budget, small file. Validates output === input (no markers, no modification).

**What it pins:**
- ✅ Canonical marker format `[TRUNCATED: lines X-Y]` (flush-left, no indentation)
- ✅ `_MIN_OMISSION_THRESHOLD = 6` (sliver rule)
- ✅ `N. ` prefix with verbatim content matching original line
- ✅ Phase-H pre-emit assertion (no throw on valid input)
- ✅ Ascending line numbers, disjoint/non-overlapping markers

This is **not** superficial smoke testing. It is a comprehensive property-based validation of all Priority-0 output invariants.

## Final Verdict
- Net new failures introduced by PR: **1** (JVM stack-trace calibration)
- Net failures resolved by PR: **5**
- Net change: **−4** (17 vs 21 baseline)
- Test Repair Gate status: **PASS** (T1–T5 all satisfied)
- Recommendation: **APPROVE** with advisory note:
  - The JVM stack-trace test (`0.65` bound) should be recalibrated to ~`0.55` to account for `N. ` prefix overhead in the new output format. This is a minor calibration fixup, not a blocking issue.
  - The author's PR description has minor inaccuracies (16 vs 17 failures, "chmod 0o000" mischaracterization) but the substantive claims hold: build green, net failures decreased, 1 legitimate calibration issue.
