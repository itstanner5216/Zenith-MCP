# Wave 3 — A9 canonical UTF-8 ordering

Date: 2026-07-16
Finding: A9 — SQLite BINARY and JavaScript UTF-16 post-sorts disagreed

## Pre-edit proof

The supplied independent oracle was RED after a clean build. Adversarial U+E000 and U+10000 paths/names were returned by raw SQLite in BINARY UTF-8 order, then reversed by JavaScript UTF-16 post-sorts. The fixture mechanically proved the two orderings disagree, so the failure was non-vacuous.

## Accepted change

- Shared evidence comparators now apply UTF-8 byte order only to textual arms; numeric positions, proof grades, booleans, and null-last distance retain their original semantics.
- Source-domain and content-domain members are sorted by UTF-8 bytes before caps and hashes.
- Cross-chunk structure and file-hash reads merge by the same textual order as SQLite BINARY.
- Derived directory and language aggregate keys use the same byte order.
- The recursive canonical JSON writer remains unchanged because A9 concerns factual sequence order, not object-key serialization.

Plan basis: Decision 26, Task 2.2 set-read determinism, Task 2.4 input-permutation invariance, and Definition of Done items 10–11.

## Validation

- MCP build: PASS, 0 compiler errors.
- Supplied A9 pinning test: PASS.
- Plan-linked focused suites: PASS, 68/68.
- Unicode occurrence differential controls: PASS, 2/2.
- Independent review: ACCEPT, confidence 0.99, zero code findings.
- Independent adversarial review: PASS, 3/3. Covered candidate/position priorities, 205-row structure and 207-key hash chunk merges, Unicode aggregates, exact source/content digest permutations, and mutation controls.
- `git diff --check`: PASS.
- A9 violation scan: no SQL `OFFSET`, no TypeScript non-null assertion, no TOON file, no public contract change.

## Full-suite comparison

```text
Baseline: 120 files passed, 6 failed; 1754 tests passed, 17 failed, 2 skipped.
Wave 1:  120 files passed, 6 failed; 1755 tests passed, 16 failed, 2 skipped.
Wave 2:  120 files passed, 6 failed; 1756 tests passed, 15 failed, 2 skipped.
Wave 3:  120 files passed, 6 failed; 1757 tests passed, 14 failed, 2 skipped.
```

No previously passing test regressed. The exact A9 baseline failure is gone; the two A4 occurrence pins remain RED as expected before Wave 4.

## Rejected alternatives

1. **Rejected:** alter canonical JSON object-key ordering. That changes hashes/cursor authentication without addressing the bounded factual sequence contract.
2. **Rejected:** keep JavaScript relational comparison after SQLite reads. That reinstates UTF-16 order and is the reproduced defect.
3. **Not generally available:** rely exclusively on SQL ordering. Cross-chunk merges and filesystem/content-domain inputs necessarily require an in-process canonical comparator.

## Evidence files

- `/tmp/polaris-resolution-1-a9-build.log`
- `/tmp/polaris-resolution-1-a9-pinning.log`
- `/tmp/polaris-resolution-1-a9-focused.log`
- `/tmp/polaris-resolution-1-a9-unicode.log`
- `/tmp/polaris-resolution-1-a9-full-suite.log`
- `/tmp/polaris-resolution-1-a9-independent-review-pass.log`
- `.superpowers/review/a9-independent-review.md`
- `.superpowers/review/a9-ordering-review.test.js`
