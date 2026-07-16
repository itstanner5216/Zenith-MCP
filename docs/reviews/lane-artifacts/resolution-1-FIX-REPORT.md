# POLARIS Resolution 1 — Fix Report

Runtime for all evidence: Node.js v26.5.0 and pnpm 11.13.1. Tests import built `dist`, so every focused proof follows a successful rebuild/build.

## A3 — Same-name reindex orphans incoming edges

### Reproduction proof

The supplied independent test failed before source edits: after changing only the body of `targetUnique`, the incremental database retained the new file hash but its incoming edge target became `null`; a from-empty database built from the same final bytes resolved to `target.ts`. This proves incremental state diverged from the independent clean oracle.

### Root cause and plan-correct fix

`persistParsedFile` deletes and reinserts every definition row, so definition storage identity changes even when the set of names does not. The `setsDiffer` shortcut incorrectly skipped invalidation in that case. Removing only that shortcut was insufficient for qualified groups because `ON DELETE SET NULL` erased the old target ID before a post-replacement clear could associate `Outer.method` with definition name `method`.

The accepted fix implements Task 1.3's atomic affected-name protocol at the real identity boundary:

- old-union-new definition names are always affected under wholesale row replacement;
- the named adapter clear matches exact plain names and exact dot-terminal groups with parameterized SQLite text operations, never `LIKE`/`GLOB`;
- every full touched reference group is re-resolved before the outer persistence transaction commits.

No public type, contract, payload, facade export, or TOON behavior changed. No proposed amendment is required.

### Green proof

- Supplied pinning test: PASS.
- Five Task 1.3 companion suites: PASS.
- Independent adversarial review: 2/2 PASS, including qualified first arrival, qualified same-name identity replacement, wildcard anti-vacuity, rollback, and clean-oracle equality.
- Independent verdict: ACCEPT, confidence 0.98, zero findings.

### Full-suite no-regression proof

The full MCP suite improved from 1,754 passing / 17 failing to 1,755 passing / 16 failing. All remaining failures are byte-identical baseline findings assigned elsewhere or later in this resolution brief; no previously passing test failed.

### Ranked alternatives

1. **Implemented:** unconditional identity invalidation plus exact terminal-group expansion inside the existing set-oriented clear. Complete, atomic, and one ownership locus.
2. **Viable but not selected:** capture resolved incoming groups before deletion plus separately query unresolved qualified groups. Correct but adds another read and more state to carry across replacement.
3. **Rejected:** remove `setsDiffer` only. It satisfies the plain-name fixture but leaves qualified target replacement incorrect.

## A10 — Rolled-back inner savepoint advances the fact epoch

### Reproduction proof

The supplied independent test executed a real write inside a nested `runTransaction`, threw to roll back that savepoint, caught the error inside an otherwise read-only outer transaction, and committed the outer transaction. Raw SQL proved the attempted row did not exist, but the private epoch advanced from generation 5 to 6.

### Root cause and plan-correct fix

`total_changes()` counts attempted writes even when a later `ROLLBACK TO` removes them. The old outer before/after comparison therefore could not implement Decision 16's committed-only generation.

The accepted fix keeps rollback accounting at the transaction owner. Private per-connection frames record the attempted-write baseline and descendant rollback deltas. Successful releases propagate only already-rolled-back descendant deltas; aborting frames propagate their whole attempted delta; the outer generation advances once only when a successful commit retains at least one row write. `PRAGMA data_version` remains the separate external-commit signal.

No public type, contract, payload, facade export, or TOON behavior changed. No proposed amendment is required.

### Green proof

- Supplied pinning test: PASS.
- Existing environment, DB atomicity, and session suites: 60/60 PASS.
- Independent adversarial transaction suite: 3/3 PASS.
- Independent verdict: ACCEPT, confidence 0.99, zero findings.

### Full-suite no-regression proof

The full MCP suite improved from the A3 gate's 1,755 passing / 16 failing to 1,756 passing / 15 failing. No previously passing test failed.

### Ranked alternatives

1. **Implemented:** rollback-aware transaction-frame accounting, preserving the existing two-part epoch and one transaction owner.
2. **Not selected:** instrument every adapter write and explicitly mark frames dirty. Wider coupling and easier to bypass through raw/returning writes.
3. **Rejected:** unconditional generation on outer commit or raw `total_changes()` comparison. The first invalidates on reads; the second is A10 itself.

## A9 — SQLite BINARY versus JavaScript UTF-16 ordering

### Reproduction proof

The supplied independent pin used U+E000 and U+10000, whose JavaScript UTF-16 and SQLite BINARY/UTF-8 orders disagree. Before the fix, adapter rows that SQLite returned in byte order were reversed by JavaScript post-sorts. The control proved SQLite itself returned U+E000 first and the adapter returned U+10000 first.

### Root cause and plan-correct fix

Several cross-chunk merges, derived aggregate sorts, session-domain sorts, and shared evidence comparators used JavaScript relational string comparison or default `.sort()`. That reintroduced UTF-16 code-unit order after set reads whose canonical authority is SQLite BINARY.

The accepted fix implements Decision 26 consistently:

- textual canonical comparisons use `Buffer.compare(Buffer.from(value, 'utf8'), ...)`;
- numeric positions and closed-enum ranks keep their existing numeric semantics;
- unavoidable post-query merges for 100-ID/key chunks use the same UTF-8 order as SQLite;
- source/content domain members and derived directory/language aggregates use that order before caps, folds, and digests;
- canonical JSON's separate recursive object-key writer was deliberately left unchanged.

No public type, contract, payload, facade export, cursor encoding, or TOON behavior changed. No proposed amendment is required.

### Green proof

- Supplied A9 pinning test: PASS.
- Plan-linked ordering, conservation, session, and v4-read suites: 68/68 PASS.
- Unicode occurrence differential controls: 2/2 PASS.
- Independent adversarial ordering suite: 3/3 PASS, covering candidate/position priority, 205-row structure merges, 207-key hash merges, aggregate ordering, source/content digest permutations, and mutation anti-vacuity.
- Independent verdict: ACCEPT, confidence 0.99, zero findings.

### Full-suite no-regression proof

The full MCP suite improved from the A10 gate's 1,756 passing / 15 failing to 1,757 passing / 14 failing. No previously passing test failed. The remaining 14 failures are the exact inherited baseline findings, including the two A4 occurrence-pagination pins that this wave intentionally did not touch.

### Ranked alternatives

1. **Implemented:** UTF-8 byte comparison at every necessary JavaScript textual merge/sort while preserving numeric and enum order.
2. **Viable only where no merge is required:** let one SQLite statement own the complete order. This cannot replace cross-chunk or filesystem/content-domain ordering.
3. **Rejected:** default JavaScript `.sort()` or `<`/`>` on canonical text. That is the reproduced A9 defect.

## A4 — Occurrence keyset pagination is not a strict total order

### Reproduction proof

Both supplied pins were RED before the fix. Two legal occurrences shared `(path,line,column,name)` but differed in persisted kind/end-line facts. A one-shot read returned both with `total:2`; walking one-row pages collected only the first because the four-field `>` predicate skipped every remaining tie.

### Plan conflict and plan-correct resolution

The prompt suggested `internalId` as the final tiebreaker, but the locked plan explicitly forbids row IDs and insertion order in pagination and factual ordering (Decisions 5, 24, and 26 plus the cursor contract). Putting `internalId` into the keyset would make opposite insertion orders produce opposite canonical sequences; serializing it into the eventual opaque cursor would also expose a base64url-decodable database identity. That alternative would require a `PROPOSED AMENDMENT — PENDING OWNER APPROVAL`, so it was not adopted.

A plan-correct fix was available. The accepted internal adapter key is the line-precision factual tuple `(path,line,column,endLine,kind,name)`, matching the v4 fact identity and position comparator. The exact tuple is used in the keyset predicate and both SQL orderings under SQLite BINARY. A full-domain multiplicity check rejects two rows with the same complete stable key as `STORE_CORRUPT`; ordering/collapsing such rows by storage identity would violate the same contract.

Only the internal adapter request type changed. The public facade types and `(scopeKey,domainDigest,snapshotKey,queryDigest,lastCanonicalKey)` cursor payload remain unchanged, and no SQLite identity crosses the facade. No proposed amendment is required for the accepted implementation.

### Green proof

- Both supplied A4 pins: PASS.
- V4 read, raw-row differential, Unicode, exact-total, and page-walk suites: 36/36 PASS.
- Added insertion-order/duplicate-key adversarial contract: PASS.
- Independent adversarial review: 3/3 PASS, covering reversed inserts, UTF-8/end-line/kind/name ties at page sizes 1/2/3, captured one-statement SQL shape, exact parameters, empty tails, duplicate corruption, and recovery.
- Independent verdict: ACCEPT, confidence 0.99, zero findings.

### Full-suite no-regression proof

The full MCP suite removed both A4 baseline failures. With one new A4 regression test added, the result is 1,760 passing / 12 inherited failures / 2 skipped across 1,774 tests. No previously passing test failed; the remaining 12 failures exactly match the baseline findings assigned to other worktrees.

### Ranked alternatives

1. **Implemented:** stable factual tuple plus full-key corruption rejection. Plan-exact, insertion-invariant, set-oriented, and one statement.
2. **Not selected:** append a derived stable fact hash. Identity-safe, but harder to keyset in SQLite and inconsistent with the locked position tuple.
3. **Rejected / amendment required:** `internalId` tiebreaker. It fixes the symptom by violating identity, ordering, and cursor rules.
4. **Rejected:** SQL `OFFSET`. Explicitly forbidden and unstable under mutation.

## A18 — Nullable malformed spans disappear from range reads

### Reproduction proof

No supplied pin existed, so raw-SQL oracles were added first. The first RED inserted malformed symbol, scope, and injection rows owned by the requested file and independently proved every required line span contained NULL. The old overlap predicates returned UNKNOWN and filtered those rows; `readV4FactsIntersectingRange` returned normally instead of surfacing corruption. A second file containing the same corruptions did not poison a clean-file query, proving the fixture was file-scoped and non-vacuous.

Final integration review then challenged the two legacy-fallback families. A second pre-production RED proved an anchor with no start line and imports with either effective `COALESCE(start_line,line)` or `COALESCE(end_line,line)` still disappeared. Exactly those three new tests failed while the five existing A18 tests passed. Each fixture included a valid anchor/import fallback row, so the correction had to distinguish an absent effective span from legitimate fallback—not merely reject nullable storage columns.

### Root cause and plan-correct fix

All five fact arms applied their overlap predicates before TypeScript could observe an absent effective endpoint. Under SQL three-valued logic, `NULL <= bound` or `NULL >= bound` is UNKNOWN, so the row silently vanished and a consumer could claim a complete range answer over an unknowable fact domain.

The accepted fix keeps Task 2.2's single set-oriented statement. Symbol, scope, and injection arms admit either a valid overlap or a NULL stored endpoint. The anchor arm treats only `line IS NULL` as corruption, retaining its valid `end_line -> line` fallback. The import arm tests the two effective `COALESCE(...,line)` endpoints, retaining nullable explicit endpoints whenever base `line` supplies a real span and accepting a null base line when both explicit endpoints are present. Every arm emits a private family-only corruption reason. The adapter scans all returned rows for that discriminator before parsing any payload, then throws the established `STORE_CORRUPT:` prefix. The existing session boundary converts that prefix to the typed non-retryable failure. Corruption remains scoped by the existing requested-file joins, even when the non-NULL endpoint lies outside the query range.

No exported type, fact payload, facade behavior, schema, cursor, or TOON code changed. The error exposes no row ID or file path. No proposed amendment is required.

### Green proof

- New shipped A18 suite: 8/8 PASS. It covers all five families, both missing effective import endpoints, raw overlap anti-vacuity, repair, out-of-file isolation, and valid anchor/import fallbacks.
- Existing v4 read and independent raw-oracle suites: 27/27 PASS.
- Independent adversarial A18 suite: 12/12 PASS, covering both NULL endpoints for symbol/scope/injection, malformed anchor/import effective spans, valid fallback combinations, out-of-range rows, repair, valid all-family ordering/payloads, one executed statement, and all five expected EQP index routes.
- Independent verdict: ACCEPT, confidence 0.99, zero findings.

### Full-suite no-regression proof

With eight new A18 tests, the full MCP result is 1,768 passing / 12 inherited failures / 2 skipped across 1,782 tests. The exact 12 failures are unchanged from the post-A4 baseline; no previously passing test failed.

### Ranked alternatives

1. **Implemented:** per-arm malformed discriminator plus overlap-or-corruption admission in the existing statement. One scan per family, no race, no silent row.
2. **Correct but not selected:** corruption sentinel CTEs unioned into the same statement. It duplicates family scans and predicate ownership.
3. **Rejected:** a separate preflight query. It breaks the exact one-statement bound and creates a read gap.
4. **Rejected:** `COALESCE` fabricated symbol/scope/injection spans or validate only rows that already passed overlap. Both preserve false completeness.

## Final integration status

All five assigned fixes have independent ACCEPT verdicts. A separate cross-wave integration review found one A18 fallback-family gap, required the missing cases to be pinned RED, and then ACCEPTED the corrected complete diff at 0.99 confidence with no active P0–P3 findings. A final contract audit independently ACCEPTED 18/18 checks at 0.99 confidence with zero actionable findings.

Fresh final-gate evidence under Node.js v26.5.0:

- both-package workspace build: PASS;
- consolidated assigned pins plus every independent adversarial suite: 36/36 selected PASS;
- boundary and production non-null guards: 11/11 PASS;
- full `zenith-toon` suite: 33/33 PASS;
- full `zenith-mcp` suite: 1,768 PASS / 12 inherited FAIL / 2 skipped (1,782 total).

The MCP suite is not represented as globally green. Its exact 12 remaining failures—four file-model relation paging, three astral text-floor, one weak-resolved compile contract, three facade-boundary, and one source-domain membership—were present at baseline and belong to the other resolution worktrees. No assigned-finding or previously passing test regressed.

Final evidence: `proofs/final-verification.md`, `.superpowers/review/final-integration-review.md`, and `.superpowers/review/final-contract-audit.md`.
