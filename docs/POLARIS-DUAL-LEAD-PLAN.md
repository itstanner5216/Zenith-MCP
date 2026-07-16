# POLARIS Dual-Lead Execution Plan — PROPOSED, PENDING OWNER APPROVAL

Owner: Tanner. Drafted by the current lead 2026-07-16 at the owner's request:
two leads in two worktrees, each owning a coherent HALF of remaining work,
split for trivial merges, with explicit alignment checkpoints.

## Why this split works

The architecture already has one load-bearing seam, enforced by the
boundaries suite since Wave 0: **facts are made and stored on one side;
facts are read and composed on the other.** db-adapter.ts is the only SQL
owner; extractors are ingestion-only; composers are pure; types.ts is
frozen and owner-gated. Splitting ON that seam means the two lanes touch
disjoint files by construction, and the only shared surfaces are ones that
already have collision-proof disciplines (append-only named-read region;
owner-gated contracts).

## The two lanes

### Lane STORE — "facts exist, durably"
Owns: `core/db-adapter.ts`, `core/indexing/*`, tree-sitter fact modules,
schema fixtures, migration ladder + atomicity suites.
- Wave 3: Task 3.1 v5 contracts/DDL (explicit v4→v5 ladder after the
  future-version guard, JSON SQL-validation, version-advance-last, one hash
  invalidation); Task 3.2 new extractors (binding facts, exports,
  signatures, relations; extract.ts + locals.ts).
- Wave 4: receipt-domain persistence (pinned TypeScript version per Task
  4.2), FactView bulk reads.
- Wave 5: v6 unit/snapshot tables, change-log, activation primitives.

### Lane INTEL — "facts answer questions, provably"
Owns: `core/intelligence/*` (session, evidence, text-floor, questions/*),
facade, composer test suites.
- Wave 2 remainder: queryOccurrences + resolveAt (literal floor + candidate
  protocol), traceRelations, contextFor; then Task 2.4 adversarial/
  totality/conservation/determinism suite feeding the ×3 exit gate.
- Wave 4: profile receipt composition, `structural@1`.
- Wave 5/6: binder consumption, proof-gated resolution answers, advisory
  lifecycle (captureEditBaseline / evaluateEditAdvisories real
  implementations).

Wave-by-wave assignment beyond the immediate horizon is by theme; at each
wave boundary the leads pin exact task text from the plan against their
lane before starting (no drift from memory).

## Checkpoint protocol (the alignment mechanism)

Checkpoints are **contract freezes at the seam, landed on integration
HEAD** — never direct lane-to-lane merges.

- CP-0 (fork): both lanes fork from post-audit-merge integration HEAD.
  Nothing forks until the five audit lanes land and the baseline re-pins.
- A checkpoint = a named artifact: e.g. STORE lands "v5 row contracts +
  named-read signatures" (types + adapter read stubs + EQP pins); INTEL
  lands "composer question/answer payloads frozen." The artifact merges to
  integration first, alone, gate-verified; THEN both lanes rebase onto the
  new HEAD. Cadence: per task-pair, roughly weekly-equivalent, not per-wave
  (too coarse) or per-commit (too chatty).
- Seam rules between checkpoints: STORE may append named reads (append-only
  region, proven by 2.2); INTEL consumes only reads that exist on
  integration HEAD. Neither lane edits `types.ts` outside a checkpoint, and
  contract changes remain owner-gated amendments regardless of lane.
- Wave discipline survives: a wave's exit gate (full suite ×3) runs on
  integration HEAD with BOTH lanes' work merged, before either lane starts
  the next wave.

## Merge + review rules

- Nothing merges without the gate (unchanged). The gate harness runs on
  every candidate from either lane.
- Cross-review, symmetric: each lead reviews the other's candidate before
  merge (hunk-level, N3 test-adjudication rules apply). The gate's
  mechanical verdict plus the OTHER lead's review replaces
  self-certification — no lead merges their own work unreviewed.
- Failure-signature ledger continues: each merge must shrink/hold the set
  exactly as predicted; the baseline re-pins after each checkpoint.
- FIX-REPORT-style proof culture carries over to both lanes for anything
  risk-bearing (RED-first, independent oracles, ranked alternatives).

## Standing constraints (both lanes)

TOON untouched; single facade file; store keys/row IDs never cross;
no OFFSET; no non-null assertions; strict Zod; real engines only; no
deferral of known defects; owner decides WHAT, leads decide HOW; all
rulings documented in the known-issues/new-findings ledgers, never only in
code comments.

## Open items to settle at adoption

1. Who runs Lane STORE vs INTEL (current lead's recommendation: current
   lead takes INTEL — it owns the composer/floor/session code it wrote and
   the 2.4 gate authorship; the second lead takes STORE, forking clean
   surfaces with the strongest existing test scaffolding: ladder fixtures,
   atomicity suites, EQP pins).
2. Second lead's identity/runtime (needs to be long-running and
   plan-literate; the Task 2.1/2.2 parallel agent already knows the
   contracts).
3. Whether the gate stays solely with the current lead or rotates (owner
   call; recommendation: gate mechanics stay in one place, review symmetry
   provides the check on the gate-holder's own lane).
