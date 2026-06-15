# Reviewer E — Priority 0 Line-Truth Deep Review

**File:** `packages/zenith-toon/src/string-codec.ts` (1525 lines)
**PR:** #23 / branch `pr-23` / HEAD `a13fa71`
**Diff base:** parent `0700d44` → `a13fa71` (string-codec hunks: imports + 5 line-emitters; `_compressJson` block 349–453 untouched).

## Summary
Three of the five line-based emitters fully honor Priority-0; **two (`_compressSourceCode`, `_compressLog`) silently violate the `_MIN_OMISSION_THRESHOLD = 6` invariant** — the former by emitting markers for 1-line gaps, the latter by dropping sub-threshold gaps without filling them and by emitting an unbudgeted/unthrottled trailing marker. Only `_compressSourceStructured` carries an explicit Phase-H assertion; the author's claim that Phase-H exists in *every* emitter is overstated.

## Per-Emitter Findings

### `_compressStackTrace` (line 153)
- **Inline emit:** ✓ yes (no shared helper; emit walk lines 302–342 inline).
- **Pre-emit assertion (Phase H):** ✗ no explicit assertion. Correctness is by construction (`${idx + 1}. ${line}` with `idx` taken from `selected`), but no `printed === sourceIdx + 1` check exists.
- **Marker format:** ✓ canonical `[TRUNCATED: lines X-Y]` (lines 271, 307, 324, 336). Flush-left, uppercase, ASCII dash, lowercase `lines`.
- **N. prefix:** ✓ `${idx + 1}. ${line}` (line 314).
- **Budget accounts for prefix:** ✓ `String(hi+1).length + 2` charged at lines 187, 199, 237, 254, 290.
- **Threshold:** ✓ tiny-gap fill in Phase 5 (lines 276–296) plus `>= _MIN_OMISSION_THRESHOLD` checks at leading (306), middle (323), trailing (335).

### `_compressJson` (line 349) — *excluded; item-based, not line-based.* See "_compressJson untouched" below.

### `_compressLog` (line 462)
- **Inline emit:** ✓ yes (lines 614–646 inline).
- **Pre-emit assertion (Phase H):** ✗ none.
- **Marker format:** ✓ canonical at lines 513, 620, 640, 643. Flush-left.
- **N. prefix:** ✓ `${entry.originalIdx + 1}. ${entry.line}` (line 626).
- **Budget accounts for prefix:** ✓ at lines 579, 599 (`String(... originalIdx + 1).length + 2`).
- **Threshold:** ✗ **PARTIALLY VIOLATED**.
  - Mid-stream gap correctly checks `>= _MIN_OMISSION_THRESHOLD` (line 619), but **no tiny-gap fill phase exists**, so a sub-threshold gap (1–5 lines) is *silently dropped* — output has e.g. `5. foo` followed directly by `8. baz` with neither marker nor verbatim lines 6–7. This breaks Priority-0 "verbatim line truth" because lines 6–7 are simply missing with no marker explaining the discontinuity.
  - **Trailing marker (line 640) is NOT threshold-gated AND NOT budget-checked** — `result += '\n[TRUNCATED: lines ${lastKept + 2}-${lines.length}]'` runs whenever `lastKept < lines.length - 1`, so a 1-line trailing tail produces `[TRUNCATED: lines N-N]`, and the resulting string can exceed `budget`.
  - **Trailing marker uses `lines.length` of the raw split (counts blanks)** but `lastKept` tracks `originalIdx`. If output was truncated mid-loop by the budget-break at line 627, `includedIndices` (populated in Phases 4/5 *before* emission) over-reports what was actually emitted, so the trailing marker can claim ranges that overlap with lines that never made it out.

### `_compressSourceCode` (line 656)
- **Inline emit:** ✓ yes; uses local `pushShown` / `pushMarker` closures (lines 887–900).
- **Pre-emit assertion (Phase H):** ✗ none.
- **Marker format:** ✓ canonical, flush-left (line 895). The previous indented form (`${omitIndent}[TRUNCATED: lines ...]`) was correctly removed in this PR.
- **N. prefix:** ✓ `${idx + 1}. ${line}` (line 888).
- **Budget accounts for prefix:** ✓ `lc()` helper at line 803–810 charges `String(idx+1).length + 2`; `pushShown` budget-breaks per line.
- **Threshold:** ✗ **VIOLATED**. The emit walk (lines 921–946) opens `omitStart` at the first non-included line and closes it at the next included line, then emits `pushMarker(omitStart + 1, idx)` *with no threshold check*. A single non-included line between two `mandatory`/`includedBody` lines yields `[TRUNCATED: lines X-X]`. There is also **no tiny-gap fill** anywhere in this function, so sub-threshold gaps are not promoted to verbatim either. This contradicts both the Phase-H invariant in the structured path (line 1305) and the comment at line 881 ("every omitted gap becomes a single flush-left `[TRUNCATED: lines X-Y]`" — but Priority-0 requires gaps `< 6` to *not* exist as markers and to *stay verbatim*).
- **Trailing range (line 949):** uses `lines.length` (1-based exclusive end). If `omitStart == lines.length - 1`, marker is `lines N-N` for a single trailing line — same sub-threshold violation.

### `_compressSourceStructured` (line 993)
- **Inline emit:** ✓ yes; emit walk inline at lines 1315–1336.
- **Pre-emit assertion (Phase H):** ✓ **the only emitter with one** (lines 1291–1310). Checks: in-range index, strictly ascending, and `gap > 0 && gap < threshold` throws. (It does *not* check `printed === sourceIdx + 1` literally — but emission constructs `${ln + 1}. ` directly from the same key, so the invariant cannot be violated by construction. Acceptable.)
- **Marker format:** ✓ canonical (lines 1171, 1324). Flush-left.
- **N. prefix:** ✓ `${ln + 1}. ${resultLines.get(ln)!}` (line 1321).
- **Budget accounts for prefix:** ✓ `lineCost` at line 1158 charges prefix width; emit loop budget-breaks at lines 1328, 1332.
- **Threshold:** ✓ tiny-gap fill (lines 1221–1241) + sliver-settle pass (lines 1248–1289) + `>= threshold` check at line 1323. This is the gold-standard implementation.

### `_contentAwareTruncate` (line 1345)
- **Inline emit:** ✓ yes (lines 1397–1436).
- **Pre-emit assertion (Phase H):** ✗ none.
- **Marker format:** ✓ canonical (lines 1409, 1423, 1371-reserve). Flush-left.
- **N. prefix:** ✓ `${idx + 1}. ${lines[idx]!}` (lines 1411, 1429).
- **Budget accounts for prefix:** ✓ `lineCost` at line 1369 charges prefix width; `markerReserve` (line 1371) reserved up front; budget-break at 1430.
- **Threshold:** ⚠ marker emitted only when `gap >= _MIN_OMISSION_THRESHOLD` (lines 1408, 1422), but if the head/tail head→tail gap is 1–5 lines, **no fill is done either** — same kind of silent discontinuity as `_compressLog`. In practice the 70 % keep floor at the public entry usually makes this gap large, so this is a latent rather than common failure.

## `_compressJson` untouched
Verified: `git diff 0700d44..a13fa71 -- packages/zenith-toon/src/string-codec.ts` produces zero hunks crossing lines 349–454 (the function body) and zero `+/-` lines mentioning `_compressJson` or `JSON Compression`. Hunk boundaries listed: 9, 60, 180, 195, 233, 248, 283, 295, 320, 559, 580, 589, 785, 856, 1110, 1123, 1153, 1162, 1254, 1333. ✓

## Marker hunt
- Canonical `[TRUNCATED: lines X-Y]` count: **19** occurrences in `string-codec.ts` (lines 271, 300, 307, 324, 336, 513, 611, 620, 640, 643, 881, 895, 1171, 1313, 1324, 1365, 1371, 1409, 1423). All template-literal forms; all flush-left.
- Old `[N lines omitted]` form: **0**. ✓
- Old `# L\d` / `# L${...}` prefixed comment markers: **0**. ✓
- Indented variants (`\s+\[TRUNCATED:`): **0** in source — the previous `${omitIndent}[TRUNCATED: ...]` literal at the old line 906 was removed in this PR. ✓

## Threshold
`_MIN_OMISSION_THRESHOLD = 6` declared at **line 63** (was `10` in parent). All 14 use sites consistent: lines 282, 306, 323, 335, 619, 1200, 1230, 1275, 1276, 1279, 1305, 1323, 1408, 1422. No literal `6` or `10` hardcoded as a threshold elsewhere. ✓

## Keep floor
- 0.70 enforced at **`compressString` line 1445** and **`compressSourceStructured` line 1490**: `const minBudget = Math.max(1, Math.floor(text.length * 0.70)); budget = Math.max(budget, minBudget);`
- Both public entry points apply it before delegating; emitters then receive a budget guaranteed ≥ 70 % of input.
- ✗ `compressFile` (line 1503) calls `compressSourceStructured(req.source, req.maxChars, ...)` which passes through the keep floor, so OK.
- The five private emitters do not enforce it themselves, and that is correct (the invariant is at the public boundary).

## Pre-emit assertion (Phase H)
| Emitter | Phase-H assertion |
|---|---|
| `_compressStackTrace` | **MISSING** — relies on by-construction emission |
| `_compressLog` | **MISSING** |
| `_compressSourceCode` | **MISSING** |
| `_compressSourceStructured` | ✓ present, lines 1291–1310 (range/ascending/sub-threshold) |
| `_contentAwareTruncate` | **MISSING** |

The author's PR description ("Phase-H pre-emit assertion" at every line emitter) is **inaccurate**. Only one of five has it. The construction-equivalent argument is plausible for the other four (every emit site computes `${idx + 1}. ` directly from the same `idx` used to read the source line), but the specification asks for an explicit invariant check, and four emitters do not perform one.

## New test pin coverage (`packages/zenith-mcp/tests/string-codec-priority0.test.js`, 217 lines)
- Marker pin: `MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/` — **strict, anchored, flush-left** (line 17). Per-marker also re-asserted with `toBe` (line 47). Excellent.
- Prefix pin: `SHOWN_RE = /^(\d+)\. ([\s\S]*)$/` — strict, anchored (line 18); content compared `toBe(origLines[num - 1])` (line 67) — this is **verbatim character-exact**.
- Threshold pin: `nonBlankSincePrevMarker >= 6` between two markers (lines 53–55). However, this pins the *between-markers* sliver; it does NOT pin the cross-cutting "no sub-threshold gap with no marker" rule that `_compressLog` and `_compressSourceCode` violate.
- Ascending pin: shown numbers strictly ascending (lines 73–75); marker ranges ascending and disjoint from shown (lines 79–86). ✓
- Coverage scope: all four `it()` blocks call **`compressSourceStructured` only** — the path that does honor Priority-0. **No test exercises `_compressSourceCode`, `_compressLog`, `_compressStackTrace`, or `_contentAwareTruncate`.** The two emitters with confirmed violations are not under test pin.
- Identity pin (line 215): `compressSourceStructured(src, src.length + 100, ...)` returns input unchanged. ✓

## Final Verdict

### Priority-0 violations (confirmed by code reading)
1. **`_compressSourceCode` emit walk (lines 921–946)** — emits `[TRUNCATED: lines X-X]` for 1-line gaps; no `_MIN_OMISSION_THRESHOLD` check; no tiny-gap fill. Sub-threshold markers will appear in real output for any TS/Python file where a single body line is dropped between two retained anchors.
2. **`_compressLog`** —
   - (a) silently drops 1–5 line sub-threshold gaps with no marker and no verbatim fill (Phase 6 emit, lines 614–631), creating non-verbatim discontinuities;
   - (b) trailing marker (line 640) is neither budget-checked nor threshold-checked, can exceed `maxChars`, and can emit `[TRUNCATED: lines N-N]` for a 1-line tail;
   - (c) trailing-marker range derived from `includedIndices` populated *before* the budget-break loop, so the range can claim lines that were never emitted.
3. **Author's "Phase-H pre-emit assertion at every line-based emitter" claim is overstated** — only `_compressSourceStructured` has it (lines 1291–1310). Four emitters lack the explicit assertion.
4. **`_contentAwareTruncate`** — latent: head/tail with sub-threshold gap produces a silent discontinuity (no marker, no fill). Mitigated in practice by the 70 % keep floor making the gap large.

### Recommendation: **NEEDS-FIXES**

Required before merge (Priority-0 cannot ship with #1 or #2):
- Add tiny-gap fill **and/or** sub-threshold marker suppression to `_compressSourceCode` emit walk (mirror the `_compressSourceStructured` pattern at lines 1221–1241).
- Add the same tiny-gap fill to `_compressLog` Phase 6, and budget-/threshold-gate the trailing marker at line 640.
- Either add Phase-H assertions to the four other emitters, or correct the PR description to scope the claim to `_compressSourceStructured`.
- Extend `string-codec-priority0.test.js` to also drive `compressString` through `_compressSourceCode` and `_compressLog` paths so the regressions above would be caught.

Strong points (do not regress):
- Canonical marker form is now consistent across all 19 occurrences (no `[N lines omitted]`, no `# L${n}`, no indented variant).
- `_MIN_OMISSION_THRESHOLD = 6` is single-sourced and consistent.
- N. prefix width is correctly charged to budget in every emitter.
- 0.70 keep floor is correctly applied at both public entry points.
- The new test file's regex pins are appropriately strict.
- `_compressJson` is genuinely untouched.
