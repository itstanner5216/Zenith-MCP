# Wave 1 — A3 same-name reindex identity repair

Date: 2026-07-16
Finding: A3 — same-name reindex orphaned incoming edges

## Pre-edit proof

The existing independent oracle was RED after a clean Node 26 build:

```text
polaris-independent-adversarial-contracts.test.js
keeps same-name incoming edge targets equal to a clean rebuild after a target body edit

incremental targetFile: null
clean targetFile:       target.ts
```

Anti-vacuity controls proved that the target bytes and persisted file hash changed and that a from-empty build resolved the edited definition.

## Accepted change

- `persistParsedFile` now treats every old/new definition name as identity-changed because file replacement deletes and reinserts every definition row, regardless of name-set equality.
- `clearEdgeTargetsByNames` expands each changed definition name to exact plain or dot-qualified terminal reference groups with parameterized SQLite equality/`length`/`substr` logic. It uses no wildcard operator.
- Replacement, clear, and re-resolution remain inside the same outer transaction; the clear returns full reference groups for exact re-resolution before commit.

Plan basis: Task 1.3, the repaired-v4 persistence model, and Definition of Done item 6.

## Validation

- MCP build: PASS, 0 compiler errors.
- Supplied A3 pinning test: PASS (1 passed, 4 skipped).
- Task 1.3 focused set: 5 plan-linked files passed; within the shared independent file, only the four untouched baseline findings remained red. Total: 65 passed, 4 baseline failures.
- Independent review: ACCEPT, confidence 0.98, zero code findings.
- Independent adversarial review: PASS, 2/2. Covered qualified first arrival, qualified same-name row-ID replacement, exact `_` terminal matching without wildcard leakage, rollback at re-resolution, and incremental equality with raw null-all plus full clean resolution.
- `git diff --check`: PASS.
- Changed-file violation scan: no SQL `OFFSET`, no TypeScript non-null assertion, no TOON file.

## Full-suite comparison

```text
Baseline: 120 files passed, 6 failed; 1754 tests passed, 17 failed, 2 skipped.
Wave 1:  120 files passed, 6 failed; 1755 tests passed, 16 failed, 2 skipped.
```

No previously passing test regressed. The exact A3 baseline failure is gone.

## Rejected alternatives

1. **Rejected:** remove `setsDiffer` and otherwise retain exact-name clearing. This passes the supplied plain-name pin but strands qualified groups after the FK erases the old target identity.
2. **Not selected:** add a separate pre-delete incoming-edge receipt query. Correct when combined with unresolved-group expansion, but duplicates work the existing set-oriented clear can own directly.

## Evidence files

- `/tmp/polaris-resolution-1-a3-build.log`
- `/tmp/polaris-resolution-1-a3-pinning.log`
- `/tmp/polaris-resolution-1-a3-focused.log`
- `/tmp/polaris-resolution-1-a3-full-suite.log`
- `.superpowers/review/a3-independent-review.md`
- `.superpowers/review/a3-adversarial-review.test.js`
