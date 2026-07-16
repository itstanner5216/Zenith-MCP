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

**Primary rhythm — the owner's every-two-waves audit (owner ruling
2026-07-16).** The load-bearing synchronization points are the owner's
biweekly review-swarm + fix-swarm audits: **Wave-4 exit = Audit #1**,
**Wave-6 exit = Audit #2**, **Wave 7 = release gate** (see "Biweekly
adversarial audit" below). At each, BOTH lanes' work is fully merged on
integration HEAD and gate-verified ×3 before the owner runs the swarm,
and neither lane starts the next two-wave block until the owner closes
the audit. Everything below serves that rhythm.

Checkpoints between audits are **contract freezes at the seam, landed on
integration HEAD** — never direct lane-to-lane merges — and they exist
ONLY where a real cross-lane dependency (or a wave-exit gate) forces one,
never as scheduled ceremony.

- CP-0 (fork): both lanes fork from post-audit-merge integration HEAD.
  Nothing forks until the five audit lanes land and the baseline re-pins.
- A checkpoint = a named artifact: e.g. STORE lands "v5 row contracts +
  named-read signatures" (types + adapter read stubs + EQP pins); INTEL
  lands "composer question/answer payloads frozen." The artifact merges to
  integration first, alone, gate-verified; THEN both lanes rebase onto the
  new HEAD. These dependency-forced freezes are the ONLY checkpoints
  between audits — concretely CP-2 (STORE's v5 contract before INTEL's
  v5-precision reads), CP-4 (profile contract), CP-5 (v6/binding contract);
  each is triggered by the seam and owner-clocked, not scheduled.
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

## Biweekly adversarial audit (owner-run, every two waves)

The owner runs an independent adversarial review after every two waves —
after Wave 4 (covering v5 schema + extraction + receipts: the
highest-risk new ground) and after Wave 6 (binder, v6 units, advisory).
Wave 7 is itself a release-gate wave. The 2026-07 audit's lesson intake,
so the next one finds fewer and *different* findings:

1. **Contract-derived pins, written before implementation.** The dominant
   finding class (A5/A6/A7/A8/A14/A21/A2) was plan-vs-code drift where the
   implementer's own tests pinned the implementer's misunderstanding —
   including two tests that literally asserted the A5 bug. New rule: every
   plan MUST gets a pin that quotes the plan sentence it asserts, authored
   from the plan text, and cross-review specifically hunts bug-pins
   (assertions that encode a defect as expected).
2. **Differential/metamorphic oracles are definition-of-done** for
   anything with ordering, paging, accounting, or incremental semantics
   (A3/A4/A9/A10 class): concat-equals-one-shot, clean-rebuild-equals-
   incremental, permutation invariance, exhaustive transition matrices —
   the audit suites are the reusable template library.
3. **Every I/O boundary ships with fault-injection pins** at authoring
   time (A11/A12/A16/A17/A1 class): trigger faults, chmod, stub binaries,
   hostile filesystems — patterns now exist for all of them.
4. **No latent surfaces**: code no composer consumes is tested to its
   contract anyway or not merged (A18 class). Unicode/astral adversarial
   corpora are standing fixtures (A20/A9 class).
5. **Pre-audit self-audit**: before each owner review, both lanes run the
   audit playbook against their own two waves and fix or ledger what they
   find. The owner's audit should be finding what the internal pass
   *missed*, not what it skipped.

Honest expectation-setting: Waves 3–5 introduce semantic ground (binding,
five-language extraction) genuinely harder than Wave 2's plumbing. The
commitment is that the *preventable classes* above are prevented, so
owner-audit findings trend toward genuinely novel semantic edges — fewer,
and different in kind.

## Open items to settle at adoption

1. **RESOLVED — OWNER RULING 2026-07-16.** Continuing lead = **INTEL**
   (owns the composer/floor/session code it wrote and the 2.4 gate
   authorship); second lead = **STORE** (forks the clean surfaces with the
   strongest existing test scaffolding: ladder fixtures, atomicity suites,
   EQP pins). This is the owner's decision, not the lead's self-selection.
2. Second lead's identity/runtime (needs to be long-running and
   plan-literate; the Task 2.1/2.2 parallel agent already knows the
   contracts).
3. Whether the gate stays solely with the current lead or rotates (owner
   call; recommendation: gate mechanics stay in one place, review symmetry
   provides the check on the gate-holder's own lane).

## CP-0 operational layout (adopted 2026-07-16, post-audit)

- Fork point: the all-green audit-close commit (1817/0/2) plus the N12
  gitignore fix on `integration-next`.
- `Zenith-Worktrees/integration-next` — shared base + merge gate. No lane
  work is committed here directly; only gated merges, ledgers, receipts.
- `Zenith-Worktrees/polaris-intel` (branch `lane/intel`) — INTEL lead.
- `Zenith-Worktrees/polaris-store` (branch `lane/store`) — STORE lead.
- `Zenith-Worktrees/handoffs/` — completion-status drop; owner-clocked,
  never polled (protocol in its README).
- Each tree carries its own real pnpm install (no cross-tree symlinks —
  N1/N12 lessons).
- Retired: the import-extension worktree and the five resolution trees
  (all work preserved on candidate/* branches; FIX-REPORTs archived under
  docs/reviews/lane-artifacts/).

## OWNER RULING — peer model (2026-07-16, supersedes open item 3)

Stated by the owner directly:

- The two leads are **equals**. Neither directs the other; direction
  comes from the owner only.
- Each lead is **individually responsible for their own work**.
- On any disagreement between leads, the **owner is the tiebreaker**.
  One does not outrank the other.

Operational consequences:

- Open item 3 is resolved: there is no gate-holder rank. The merge-gate
  verifier is shared tooling; either lead runs it against their own
  candidate and the owner confirms merges into integration-next.
- Cross-review at checkpoints remains symmetric and is **peer input,
  never approval authority**. Review findings a lead disputes go to the
  owner with both positions stated; the disputed work waits on the owner,
  not on the reviewer.
- Briefs, acceptance checklists, and steering between leads are
  discontinued. Seam contracts (types.ts freezes, adapter read shapes)
  are negotiated as proposals either lead may contest — owner arbitrates.
- Leads communicate through the owner and the handoffs drop
  (owner-clocked, never polled). Handoff content is status, contracts,
  and questions — not instructions.
