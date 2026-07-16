# Wave 5 — A18 nullable-span corruption boundary

Date: 2026-07-16
Finding: A18 — SQL three-valued overlap predicates hid malformed spans

## Pre-edit proof

A deterministic pin was written before production changes. Independent raw SQL first proved one NULL-span row from each direct-span family—symbol, scope, and injection—belonged to the requested file. The existing overlap-only predicates returned no malformed row, and the adapter returned normally rather than raising `STORE_CORRUPT`.

```text
A18 RED: 1 failed, 1 passed.
Failure: expected readV4FactsIntersectingRange to throw; it returned.
Control: malformed spans in another file did not poison a clean-file read.
```

Final integration review then identified the equivalent hidden-row risk in the two fallback families. Three more cases were added and executed against the pre-extension build: anchor `line IS NULL`, import effective start NULL, and import effective end NULL. All three independently proved the malformed row existed and the legacy overlap returned none; only those three failed while the prior five A18 tests remained green.

```text
A18 fallback-family RED: 3 failed, 5 passed.
Valid controls: anchor end-line fallback and import base-line fallback remained present.
```

## Accepted change

The existing range statement now carries one private `corruption_reason` column:

- symbol rows are admitted when they overlap or `line`/`end_line` is NULL;
- anchor rows are admitted when they overlap or their required start `line` is NULL; a NULL `end_line` still validly falls back to `line`;
- scope rows are admitted when they overlap or `start_line`/`end_line` is NULL;
- import rows are admitted when they overlap or either effective `COALESCE(explicit,line)` endpoint is NULL; nullable explicit endpoints with a usable base line remain valid;
- injection rows are admitted when they overlap or `start_line`/`end_line` is NULL;
- every returned row is checked for corruption before any payload JSON is parsed;
- the error contains only the family and condition, never storage identity or path.

All file joins, valid projections, canonical ordering, legitimate anchor/import `COALESCE` semantics, and the one-statement ownership boundary remain unchanged. Plan basis: Task 2.2, Task 2.4 corrupt-fact totality, Decision 28, and the Wave 2 range completeness contract.

## Validation

- MCP build: PASS, 0 compiler errors.
- New shipped A18 pin/control suite: PASS, 8/8.
- Existing v4 read and independent raw-oracle suites: PASS, 27/27.
- Statement-count and EQP gates: PASS; one execution and all five expected index routes remain.
- Independent review: ACCEPT, confidence 0.99, zero findings.
- Independent adversarial suite: PASS, 12/12. Covered both endpoints for direct-span families, malformed anchor/import effective spans, SQL-3VL anti-vacuity, out-of-range rows, repair, file isolation, valid order/payloads, and every legitimate fallback combination.
- `git diff --check`: PASS.
- A18 violation scan: no `OFFSET`, no TypeScript non-null assertion, no TOON file, no public type/payload change, no ID/path in corruption detail.

## Full-suite comparison

```text
Baseline: 120 files passed, 6 failed; 1754 tests passed, 17 failed, 2 skipped (1773).
Wave 4:  121 files passed, 5 failed; 1760 tests passed, 12 failed, 2 skipped (1774).
Wave 5:  122 files passed, 5 failed; 1768 tests passed, 12 failed, 2 skipped (1782).
```

Wave 5 adds eight passing tests and introduces no new failure. The remaining 12 failures are the exact inherited baseline findings outside this worktree's five-item assignment.

## Ranked alternatives

1. **Implemented:** one-statement per-arm corruption admission/discriminator.
2. **Not selected:** additional corruption sentinel arms in the same CTE; correct but duplicates scans.
3. **Rejected:** a separate corruption preflight statement; violates the fixed statement bound and creates a race window.
4. **Rejected:** synthesized fallback spans or post-filter-only validation; either fabricates facts or retains the silent-loss defect.

## Evidence files

- `/tmp/polaris-resolution-1-a18-red.log`
- `/tmp/polaris-resolution-1-a18-build.log`
- `/tmp/polaris-resolution-1-a18-green.log`
- `/tmp/polaris-resolution-1-a18-focused.log`
- `/tmp/polaris-resolution-1-a18-full-suite.log`
- `/tmp/polaris-resolution-1-a18-anchor-import-red.log`
- `/tmp/polaris-resolution-1-a18-anchor-import-build.log`
- `/tmp/polaris-resolution-1-a18-anchor-import-green.log`
- `/tmp/polaris-resolution-1-a18-anchor-import-focused.log`
- `/tmp/polaris-resolution-1-a18-anchor-import-full-suite.log`
- `.superpowers/review/a18-independent-review.md`
- `.superpowers/review/a18-adversarial-review.test.js`
