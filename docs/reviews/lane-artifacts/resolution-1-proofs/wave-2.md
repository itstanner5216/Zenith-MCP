# Wave 2 — A10 rollback-aware fact epoch

Date: 2026-07-16
Finding: A10 — rolled-back inner savepoint advanced the fact epoch

## Pre-edit proof

The supplied independent oracle was RED after a clean build. A write inside an inner `runTransaction` was rolled back, the enclosing outer transaction committed no row, yet `commitGeneration` advanced from 5 to 6. Raw SQL proved the attempted row was absent.

Root cause: SQLite `total_changes()` is monotonic and includes writes subsequently rolled back to a savepoint. Comparing only the outer before/after values therefore measured attempted writes, not committed facts.

## Accepted change

`runTransaction` now maintains private per-connection transaction frames:

- each frame records its starting attempted-write count and descendant rollback count;
- a successful nested release propagates only its descendant rollback count;
- a nested abort propagates its entire attempted-write delta because the containing savepoint erased all of it;
- a successful outer commit increments the generation only when `total delta - rolled-back delta > 0`;
- every exit pops the frame and restores depth.

`PRAGMA data_version` remains the independent other-connection half of Decision 16's epoch. Exported signatures and the `FactEpoch` shape are unchanged.

Plan basis: Decision 16, Task 0.3, Task 2.1, and the freshness clauses in the Definition of Done.

## Validation

- MCP build: PASS, 0 compiler errors.
- Supplied A10 pinning test: PASS.
- Existing environment + DB atomicity + session suites: PASS, 60/60.
- Independent review: ACCEPT, confidence 0.99, zero code findings.
- Independent real-SQL review suite: PASS, 3/3. Covered mixed surviving/rolled-back writes, successful releases, triple nesting, containing-frame abort, outer-abort cleanup and immediate reuse, and two-connection `data_version`/generation independence.
- `git diff --check`: PASS.
- A10 violation scan: no SQL `OFFSET`, no TypeScript non-null assertion, no TOON file, no public contract change.

## Full-suite comparison

```text
Baseline: 120 files passed, 6 failed; 1754 tests passed, 17 failed, 2 skipped.
Wave 1:  120 files passed, 6 failed; 1755 tests passed, 16 failed, 2 skipped.
Wave 2:  120 files passed, 6 failed; 1756 tests passed, 15 failed, 2 skipped.
```

No previously passing test regressed. The exact A10 baseline failure is gone.

## Rejected alternatives

1. **Rejected:** increment after every outer commit. Read-only outer transactions would falsely invalidate sessions.
2. **Rejected:** continue using raw `total_changes()` without rollback accounting. That is the reproduced defect.
3. **Not selected:** instrument every adapter write call or create SQLite session changesets. Both duplicate transaction ownership broadly and add substantially more hot-path coupling than frame-local rollback accounting.

## Evidence files

- `/tmp/polaris-resolution-1-a10-build.log`
- `/tmp/polaris-resolution-1-a10-pinning.log`
- `/tmp/polaris-resolution-1-a10-focused.log`
- `/tmp/polaris-resolution-1-a10-full-suite.log`
- `.superpowers/review/a10-independent-review.md`
- `.superpowers/review/a10-transaction-frame-review.test.js`
