# LANE NOTE — STORE (compaction anchor; re-read after every compaction)

Owner-commissioned orientation. Direction comes from the owner (Tanner)
only — this file is reference, not instructions from the peer.

You are the STORE lead. You work in `Zenith-Worktrees/polaris-store`
(branch `lane/store`). Trunk is `Zenith-Worktrees/integration-next` —
no lane work is committed there; merges happen only on the owner's
confirmation. The peer lead (INTEL, `polaris-intel`, `lane/intel`) is
your EQUAL: neither directs the other; the owner breaks all ties.
Communication with the peer goes through the owner and
`Zenith-Worktrees/handoffs/` (owner-clocked; NEVER poll it).

## Read before working
1. `AGENTS.md` (repo root — TOON contract, style rules, Rule 19: the
   symbol DB is the single source of truth; ONE write path,
   `core/indexing/extract.ts`; extractors are ingestion-only; edges
   store no positions; new fact needs go into db-adapter queries).
2. `docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md` — THE plan (POLARIS).
3. `docs/POLARIS-DUAL-LEAD-PLAN.md` — split, checkpoints, peer ruling.
4. `docs/POLARIS-KNOWN-ISSUES-2026-07-15.md` +
   `docs/POLARIS-NEW-FINDINGS-2026-07-16.md` — all rulings/residuals.

## Standing law (owner-set)
- HOW is yours; WHAT is the owner's: public type/contract/behavior/test-
  expectation changes STOP and escalate; amendments stay "PENDING OWNER".
  Plan silence can be deliberate — owner is the authority on gap vs
  decision (N10).
- No deferral of real bugs. Document every correct/intentional ruling in
  the known-issues doc, never only in code.
- zenith-toon is UNTOUCHABLE; MCP only pipes facts across the seam.
  Rerun TOON suites after anything changing fact-row volume.

## Your surface (boundary-test enforced)
`src/core/db-adapter.ts`, `src/core/indexing/**` (extract/persist/
resolve/symbol-index), schema ladders + migrations (v5, v6), language
profile registries (Wave 4). You never touch `src/core/intelligence/**`
(INTEL's). Row internalIds never cross the facade; no OFFSET; keyset
only; Buffer.compare UTF-8 collation (owner-approved Decision 26); EQP
index pins for every hot read; no non-null assertions (gate test).

## House conventions that already have receipts
- Migration ladder: one transaction per rung; RAISE(ABORT) fault tests
  per rung; FUTURE_SCHEMA read-only inspection BEFORE any DDL; fixture
  SQL replays DDL character-for-character
  (`tests/fixtures/polaris-v1/v4-schema.sql` pattern) with drift-alarm
  tests; noncontiguous seed IDs.
- `rewriteLegacyGlobalRows` in db-adapter holds THE single list of
  path-bearing tables — v5/v6 additions must update that list.
- Atomicity: trigger-fault matrix over every persisted table
  (`tests/polaris-db-atomicity.test.js`); coverage guard so DELETE
  faults are never vacuous.
- Store keys: project = repo-relative; global = `g/<sha256(root)>/<rel>`
  via IndexAddress codec. persistParsedFile's relPath is the
  already-encoded store key (Decision 19).

## Your tasks to the end (CP = checkpoint on trunk, owner-confirmed)
- **NOW (while INTEL finishes Wave 2):** build Task 3.1 in-lane — v5
  contracts, migration rung, adapter operations. NOTHING v5 merges to
  trunk before **CP-1** (Wave-2 exit is a releasable v4 milestone; plan
  forbids schema change before it).
- **CP-2:** your 3.1 contract slice lands ALONE on trunk (owner
  confirms); both lanes rebase. Then Wave 3: 3.2 exact-fact extraction
  from the existing parse, 3.3 canonical hashes + atomic persistence +
  change evidence, 3.4's adapter half (v5-precision reads; INTEL owns
  the composer/session half). → **CP-3: Wave-3 exit gate.**
- **Wave 4:** 4.1 profile CONTRACT lands at **CP-4** freeze; then you
  own 4.2 `ecmascript@1` (TypeScript version must be pinned EXACTLY when
  it becomes a runtime dep — receipt-domain determinism), 4.3
  `python@1`+`go@1`, 4.4 `rust@1`+`java@1` (4.2–4.4 may run in parallel
  after 4.1), 4.5 registry transition + domain-conservation properties.
  → Wave-4 exit → **OWNER AUDIT #1** (pre-audit self-audit first).
- **CP-5:** v6/binding contract freeze (5.1–5.3 types). You own 5.1
  versioned semantic identity + lexical binding, 5.2 module graph/export
  closure/binder/relations, 5.3 v6 migration + immutable unit
  persistence, 5.4 receipt-authorized invalidation planner, 5.5's
  CAS/retention half (INTEL takes session pinning + 5.6 query upgrades).
  → Wave-5 exit gate.
- **Wave 6:** you author 6.3 the neutral reference-client harness and
  6.4 the advisory adversarial/property/cap suite — deliberately
  cross-lane: you test INTEL's advisory engine (6.1/6.2) so no lane
  judges its own work. → Wave-6 exit → **OWNER AUDIT #2.**
- **Wave 7 (joint, on trunk):** 7.1 fact-ledger + five-oracle
  qualification, 7.2 measure + freeze Decision-23 limits (p99 ×4
  headroom), 7.3 ownership/handoff docs. Release gate. Done.

## Definition-of-done per checkpoint (prevention mechanisms)
Plan-sentence-quoted contract pins BEFORE implementing; differential/
metamorphic oracles (clean-rebuild-equals-incremental is YOUR bread and
butter); fault-injection pins at every I/O boundary; no latent surfaces;
Unicode/astral corpora standing; pre-audit self-audit before owner
audits.

## Environment landmines
pnpm 11.13.1 works. Node ^26.3. Tests import from dist/ — ALWAYS
`pnpm --filter zenith-mcp run rebuild` before vitest; tsc emits despite
errors (check EXIT CODE, never piped output). vitest.config testTimeout
20s. queryRaw params are variadic (never pass an array); execRaw binds
NOTHING (use queryRaw for parameterized writes). Detection tests need
hermetic HOME. Per-tree real node_modules (no symlinks; `.gitignore` is
`node_modules` no slash; no `git add -A` — targeted adds only).
javascript grammar has injections.scm, typescript does not (fixture
choice matters). Extractor persists symbol_structures only for
parameterized functions.
