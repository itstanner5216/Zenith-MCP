# POLARIS Audit-Fix Lane Reviews

Reviewer: implementation lead. Protocol per the audit-fix ledger: read-only
review of the lane worktree, hunk-by-hunk classification of every test edit
(owner ruling N3: judged by property strength, never by stasis), then gate
verification of a patch snapshot merged onto integration HEAD. The failure
ledger is `.polaris-gate/audit-baseline-46b341f.json` (17 failing / 65
passing at fork 46b341f). Nothing here is owner-approved until Tanner merges;
every recommendation below is a lead decision — pending owner.

---

## Lane: resolution-1 — A3 / A10 / A9 / A4 / A18

**Verdict: ACCEPT — recommend merge as delivered.** Zero regressions, zero
weakened properties, all five findings fixed at root cause, no public
contract or facade changes, zero TOON proximity.

### Gate result (authoritative)

- Candidate: `candidate/resolution-1` (d851cc8) = patch snapshot of the
  lane's **uncommitted** working tree + its new A18 suite; merged onto
  integration HEAD 62491f0.
- Suite: **1,768 passed / 12 failed / 2 skipped.** Newly green: 4 ledger
  keys (A3 clean-rebuild equivalence, A4 tied-row exactly-once, A9 BINARY
  ordering, A10 savepoint generation) **+ 1 renamed test adjudicated clean
  per N3** — the occurrences-differential pin was rewritten to a *stronger*
  property (concat == one-shot over the six-field tuple) and passes.
- Foreign failures: 12/12 byte-identical to baseline. No mutations, no new
  failures. Report: `.polaris-gate/reports/candidate_resolution-1-*.json`.
- Cross-check: the lead's independent 8-cell A10 behavioral proof suite
  passes **8/8 unmodified** against this lane's implementation.

### Per-finding assessment

- **A3 (equal-name-set orphaning) — root cause, correct.** The `setsDiffer`
  shortcut was simply wrong once row replacement is understood as identity
  change (ON DELETE SET NULL erases old target IDs even when name sets are
  equal). Unconditional old∪new invalidation plus an exact dot-terminal
  expansion in the CLEAR. The suffix SQL was hand-verified: 1-indexed
  `substr` arithmetic correct for single- and multi-dot qualifiers; mere
  suffixes (`xmethod` vs `method`) correctly rejected; fully parameterized
  (VALUES table, no LIKE/GLOB). Costs more re-resolution per persist than
  the broken optimization; correctness bought honestly.

- **A10 (rolled-back savepoint bumps commitGeneration) — correct;
  equivalent to the lead's candidate.** Frame-stack model: per-frame
  `changesBefore` + `rolledBackChanges`; aborts propagate the frame's full
  attempted span (discarding, not re-adding, descendant voids — no double
  count); releases propagate accumulated voids; outer commit bumps only on
  net retained writes. Verified against the lead's replacement-void model:
  functionally identical on all proven cells, with added stack-invariant
  guards that fail loud on depth drift. **Recommendation: take this lane's
  version, retire `lead/a10-epoch`.** It ships integrated with the
  cluster's other fixes as one tested unit. Optional follow-on: add the
  lead's 8-cell suite as extra pins (already proven green against this
  implementation).

- **A9 (JS UTF-16 vs SQLite BINARY ordering) — code correct; one governance
  item.** All JS textual sorts/merges on the fact path now use
  `Buffer.compare` UTF-8 byte order (evidence comparators with a
  mixed-type guard, session domain/content-digest sorts, adapter
  post-merges). The direction is functionally forced — keyset predicates
  evaluate under SQLite BINARY, and Decision 24's exactly-once breaks at
  page boundaries if JS disagrees — and the owner-accepted audit test pins
  it. But the lane's claim "Decision 26 authorizes this, no amendment
  required" overreaches: Decision 26 fixes *field sequences* and is
  **silent on string collation**. Silent plan + chosen collation = gap-fill.
  **Owner item: one-line Decision 26 ratification** ("all canonical string
  orderings are UTF-8 byte order, matching SQLite BINARY") so the other
  four lanes and Wave 3+ inherit an explicit rule. Lead will draft the
  proposed amendment, marked pending, on request.

- **A4 (occurrence keyset not a strict total order) — exemplary.** The
  lane's own prompt suggested an `internalId` tiebreaker; the lane refused
  it as plan-violating (row IDs never affect factual data / never leak
  through cursors) and delivered the factual tuple
  `(path,line,column,endLine,kind,name)` in predicate and ORDER BY, with
  true full-key duplicates rejected as STORE_CORRUPT rather than silently
  collapsed. Only the internal adapter request type changed; cursor payload
  shape unchanged; no composer consumes this read yet. **Watch-item
  (documented, not blocking):** a grammar capturing one node as both def
  and ref with *identical* `type` strings would trip the multiplicity
  check; no grammar in the 28-file cross-language corpus does, and
  fail-loud → typed `repair_store` is the right bias if one ever appears.

- **A18 (NULL spans vanish from range reads) — correct, latent-path
  hardening.** Every family arm admits valid-overlap OR null-endpoint rows;
  anchors keep the `end_line→line` fallback (only `line IS NULL` is
  corruption); imports test COALESCE'd effective endpoints; corruption
  surfaces as family-only discriminators scanned pre-parse, thrown as
  STORE_CORRUPT, scoped to the requested file via the bounds join. Read is
  not yet consumed by any composer (locationAt uses `assembleFile`), so
  this is hardening of a Wave-3 surface plus 8 new pins including two the
  lane found red mid-review and fixed (anchor/import fallback families).

### Test-edit adjudication (N3)

- `polaris-independent-adversarial-contracts.test.js`: **purely additive**
  (+114, zero deletions).
- `polaris-audit-occurrences-differential.test.js`: driver mechanically
  forced to six-field keys by the internal type change; test renamed with a
  **strictly stronger** assertion. Clean. Ledger note: at merge, the
  baseline entry migrates to the successor test name.
- `polaris-independent-v4-oracles.test.js`: fixture kind-alternation
  flattened to `'function'` — verified this *preserves* the Unicode
  name-ordering oracle's power (kind now sorts before name in the tuple;
  alternation would have split the corpus and gutted the anti-vacuity
  assertion, which survives intact).
- `polaris-v4-reads.test.js`: +2 lines, mechanical key-shape update.

### Merge notes / owner items

1. The lane's work is **uncommitted in its worktree** — one `git clean`
   from gone. `candidate/resolution-1` (d851cc8) is the durable mergeable
   artifact; recommend committing in-lane too, or merging the candidate
   promptly.
2. A9 collation ratification (above) — one line, unblocks consistent
   treatment across remaining lanes.
3. A10 duplicate resolution: take lane's, retire `lead/a10-epoch`
   (lead recommendation; no attachment).
4. `FIX-REPORT.md` + `proofs/` are evidence, excluded from the candidate;
   packaging (keep in-lane vs archive under `docs/reviews/`) is the
   owner's call.
5. Out of scope here: the A19-shaped work appearing in the integration
   worktree belongs to a different (path-confused) agent — see ledger N4;
   it will be reviewed as its own delivery.
