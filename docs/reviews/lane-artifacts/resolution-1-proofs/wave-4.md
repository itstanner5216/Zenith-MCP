# Wave 4 — A4 identity-free strict occurrence keyset

Date: 2026-07-16
Finding: A4 — tied legal occurrence rows were dropped between pages

## Pre-edit proof

The supplied independent pin and raw-row differential were both RED. A one-shot read returned two facts and exact total 2, but a one-row keyset walk returned only one because both rows shared the old `(path,line,column,name)` cursor position.

## Constraint resolution

The suggested `internalId` tiebreaker conflicts with locked Decisions 5/24/26 and the cursor prose: database row identity and insertion order must never affect factual ordering or pagination. Reversing insert order mechanically reverses row IDs, so the conflict cannot be hidden. Encoding an ID into the future cursor would additionally cross the facade because its authenticated body is encoded, not encrypted.

The accepted fix instead uses `(path,line,column,endLine,kind,name)`, the v4 line-precision analogue of the locked position/fact identity. It appears identically in the keyset `WHERE`, page ordering, and final compound ordering. Exact repetitions of the complete stable key are detected across the full filtered domain in the same statement and rejected as `STORE_CORRUPT`.

This changes only an internal adapter request type. Public cursor fields, facade types, and payload shape are unchanged, so no amendment was adopted or required.

## Validation

- MCP build: PASS, 0 compiler errors.
- Supplied A4 pins: PASS, 2/2.
- Plan-linked v4 read/independent oracle/occurrence differential suites: PASS, 36/36.
- Added shipped adversarial control: PASS. Reverse insertion order yields identical ID-stripped pages; an exact stable-key duplicate throws and succeeds after repair.
- Independent review: ACCEPT, confidence 0.99, zero findings.
- Independent review suite: PASS, 3/3. Captured exactly one SQL statement with the same tuple and parameter order, no ID ordering, and no `OFFSET`; exercised page sizes 1/2/3, UTF-8 ties, empty tails, corruption, and recovery.
- `git diff --check`: PASS.
- A4 violation scan: no SQL `OFFSET`, no TypeScript non-null assertion, no TOON file, no public cursor or facade change.

## Full-suite comparison

```text
Baseline: 120 files passed, 6 failed; 1754 tests passed, 17 failed, 2 skipped (1773).
Wave 3:  120 files passed, 6 failed; 1757 tests passed, 14 failed, 2 skipped (1773).
Wave 4:  121 files passed, 5 failed; 1760 tests passed, 12 failed, 2 skipped (1774).
```

Wave 4 fixes both existing A4 failures and adds one passing regression test. No previously passing test regressed. The remaining 12 failures are the exact inherited baseline set outside this worktree's five findings.

## Ranked alternatives

1. **Implemented:** stable six-field fact tuple plus exact-duplicate corruption gate.
2. **Not selected:** derived fact-key hash in SQL. Stable, but needlessly departs from the locked canonical position tuple.
3. **Rejected / amendment required:** append SQLite `internalId`. It makes output insertion-dependent and would leak into the future continuation position.
4. **Rejected:** `OFFSET`, explicitly forbidden by the plan and brief.

## Evidence files

- `/tmp/polaris-resolution-1-a4-build.log`
- `/tmp/polaris-resolution-1-a4-pinning.log`
- `/tmp/polaris-resolution-1-a4-focused.log`
- `/tmp/polaris-resolution-1-a4-adversarial.log`
- `/tmp/polaris-resolution-1-a4-full-suite.log`
- `/tmp/polaris-resolution-1-a4-independent-review-pass.log`
- `.superpowers/review/a4-independent-review.md`
- `.superpowers/review/a4-adversarial-review.test.js`
