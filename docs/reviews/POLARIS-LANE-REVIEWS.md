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

---

## Lane: resolution-5 — A2 / A6 / A7 / A15 / A21 (contracts cluster)

**Verdict: ACCEPT AS PROPOSED AMENDMENTS — every fix requires the owner's
explicit approval before merge** (all five change public types, payloads, or
answer values; the lane itself framed them exactly that way and self-adopted
nothing — the correct governance posture, applied lane-side without
prompting).

### Gate result (authoritative)

- Candidate: `candidate/resolution-5` (0442c96), assembled in a scratch
  worktree from the lane's uncommitted diff + 3 new pinning suites; merged
  onto corrected integration HEAD 05838f9.
- Suite: **1,773 passed / 11 failed / 2 skipped.** Newly green: exactly the
  6 predicted baseline signatures (A2 compile-oracle + A6 ×5 paging/facade).
  Foreign failures 11/11 unchanged; zero mutations; zero new failures;
  **zero existing tests edited by this lane** (no N3 adjudication needed).
- Gate history, disclosed: the first run STOPped on 4 failures that were
  the lead's own leaked A10 proof suite on integration HEAD (ledger N5,
  lead process error, now removed) — not a resolution-5 defect. Clean
  rerun above. Res1's published numbers predate the leak and stand.

### Per-amendment recommendation (lead decision — pending owner)

1. **A2 (`ResolvedCandidateBasis`) — approve; nearest to a non-amendment.**
   Plan line 441 *verbatim* mandates this exclusion; the implementation had
   failed to encode it. Grep-verified zero `resolved` constructors at v4 →
   pure compile-time tightening. Their alternative 2 (stricter
   `ProvenLocatedSymbol` split) is worth remembering at Wave 5, not now.
2. **A6 (atomic object-section position; `identity.facts: null`) —
   approve.** Adopts the `location.ts` house pattern; `consumed +=
   factCount` reconciles returned/total; unknown object sections fail loud.
   Two accepted semantics noted: atomic emission may overshoot the page
   limit when budget remains (Decision 24 says page maxima aren't
   truncation), and non-carrying pages are asymmetric (`identity: null` vs
   `relations` empty arrays) — forced by the shapes, element-level
   exactly-once holds either way.
3. **A7 (faithful projections; `ImportFact.origin`; multi-domain sections)
   — approve.** Largest surface, but every field maps 1:1 to a persisted
   column (verified in diff); orphans/unmatched bindings surface explicitly
   instead of vanishing; byteRange kept discrete rather than fabricating
   `precision:'byte'` (plan-conformant); the never-requested
   `import_binding` coverage domain is a real conservation fix.
4. **A15 (real frontier identity) — approve.** PK-joined LEFT JOIN can't
   multiply rows; `locateTarget` mints real fact keys with full null-guards
   (returns null, never fabricates); byte-identity oracle proves candidate
   keys equal the target's own declaration keys; `compareCandidates` reused
   (Rule 17). Coherence: candidates stay `heuristic_name`, which their own
   A2 fix compile-bans from the resolved arm. One question filed for the
   A14 lane's collision check: unkeyable *ancestors* are skipped from
   `parentChain` (shorter-but-real chain) — defensible, adjacent territory.
5. **A21 (drop `lastIndexedAt`) — approve.** Plan line 732 is unambiguous;
   residual references are one doc comment + their negative-assertion test.

### Merge notes

- **`questions/file.ts` three-way collision incoming:** resolution-5 (A6/A7
  assembly+paging), resolution-2 (in-flight, same file), and the
  path-confused agent's A19 (`parseJsonStringArray`, same file). Merge
  order within file.ts should be: res5 first (largest, structural), then
  A19 (3-line local change, trivial rebase), then res2 adjudicated against
  both.
- Work is uncommitted in the lane worktree (same risk as res1);
  `candidate/resolution-5` (0442c96) is the durable artifact.
- RED-first was proven mechanically (12/13 new assertions fail with source
  reverted; the 13th is a count-invariant that holds vacuously — honest
  disclosure by the lane).

---

## Lane: resolution-3 — A1 / A11 / A12 / A16 / A17 (session-security cluster) — INTERIM

**Status: verification CONFIRMED-SO-FAR (independent subagent, snapshot-safe,
revert-proven baseline); final review holds until the lane writes FIX-REPORT.md.**

- Surface: session.ts (112 lines), shared.ts (5), polaris-session.test.js (24),
  + 3 new independent-oracle suites (content-receipts, store-failure-typed,
  walk-coverage). Nothing beyond the expected surface.
- All five cluster findings targeted with evidence-matching changes: A1 (.mcp
  force-excluded even under custom excludes), A11 (canonical content ordering,
  duplicate-key INVALID_QUERY, honest updated/unchanged split, unattempted tail
  omitted), A12 (incomplete_walk coverage on readdir failure), A16
  (typedStoreFailure at query seam AND the previously-uncaught open-time
  pin-view transaction; deliberately excludes transient/misuse errors), A17
  (validatePath on anchor + file + directory selectors).
- Modified existing test adjudicated per N3: the changed expectation is
  STRONGER (old version's own comment admitted it encoded the bug — failed
  file sat in `unchanged`; new version pins exact arrays plus a no-leak guard).
- Numbers (verifier's own runs): baseline 17 failed / 1754 passed re-proven by
  revert; fixed state 15 failed / 1762 passed; the two flipped reds are
  exactly this cluster's baseline signatures (A1 .mcp fileCount, A17 realpath
  validator); all 15 non-cluster failures byte-identical. Constraints clean.
- Gate run + verdict section owed when FIX-REPORT.md lands.

---

## Lane: resolution-4 — A13 / A20 (text-floor cluster)

**Verdict: ACCEPT — recommend merge as delivered. Zero proposed amendments**
(no public type, signature, or payload changes; `FloorOutcome` untouched),
zero existing tests edited, zero regressions.

### Verification (independent subagent, CONFIRMED on all nine claims)

- Method: own builds judged by exit code, RED-first re-proof by revert +
  rebuild (both RED signatures reproduced exactly: rg argv containing the
  over-bound and past-budget files; 3 astral misclassifications), snapshot
  restoration proven byte-identical (sha256), lane work untouched.
- A13: bounded pre-pass mirrors the scan loop's stat/per-file/budget
  discipline; content-fresh files accounted in plannedBytes but never
  handed to rg; non-regular paths excluded (a directory can no longer make
  rg recurse — the purest form of the unbounded work); TOCTOU membership
  guard on the rg fast-path closes the pre-pass/scan race. Output proven
  invariant: outcome fields pinned pre- and post-fix, on-paper corpus trace
  reproduced. The oracle is genuinely independent (stub rg writes argv to
  disk; assertions read the log, never the function's return; anti-vacuity
  companion proves reachability).
- A20: whole-code-point boundary extraction ([...].at(-1)/.at(0)); zero
  UTF-16 .slice splits remain on the boundary path; three baseline BUG
  signatures flip, BMP/emoji/punct controls stay green. Consistent with the
  earlier window-boundary audit (adjacent window edges are exact; U+FFFD
  from partial bytes lands only on the far end).
- Disclosed forceScanner edge (test-only knob; all-out-of-bounds + rg
  unavailable no longer throws): verified nothing depends on the old throw.
- Full suite in-lane: 1,759 passed / 14 failed — the 14 are byte-identical
  non-cluster baseline failures, pre-existence re-proven by revert.

### Gate result (authoritative)

- Candidate: `candidate/resolution-4` (6d7a981), scratch-assembled; merged
  onto integration HEAD 05419c7.
- Newly green: exactly the 3 A20 baseline signatures (A13 had no baseline
  signature; its proof is the lane's new independent-oracle suite). Foreign
  14/14 unchanged; zero mutations; zero new failures. Diff surface: 2
  entries, pure.

### Merge notes

- Cleanest lane of the four reviewed so far: single-file source change,
  no contract surface, no test edits, no collisions with any other lane
  (text-floor.ts has exactly one claimant).
- Work uncommitted in-lane (same durability risk); candidate 6d7a981 is
  the durable artifact.
- The report's stale plan-line citation (763–767 → actual 775–786) was
  self-corrected by the lane against text, not line numbers — the right
  instinct given the plan doc's drift.

---

## resolution-3 — FINAL VERDICT: ACCEPT (merged)

FIX-REPORT delivered (copilot session-state) and reconciled 1:1 against the
independent verifier's earlier findings: identical numbers (17/1754 →
15/1762 in-lane), identical mechanics, RED-first proofs for all five
(A17 validatePath guard-only routing, A1 mandatory .mcp exclude both
branches, A11 four-sub-bug receipt fix, A12 incomplete_walk, A16
typedStoreFailure two-seam classifier). Alternatives ranked per finding;
the A17×A12 interaction explicitly de-risked; the one team-test
correction was previously adjudicated STRONGER under N3. Constraints
clean (no OFFSET, no non-null assertions, TOON untouched, no public type
changes). Merged into integration-next with one lead seam fix recorded as
N8 (A9×A11 content-key ordering + discriminating pin). Post-merge:
1790 passed / 7 failed / 2 skipped; A17+A1 signatures closed exactly.
