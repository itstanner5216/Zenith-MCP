# LANE NOTE — INTEL (compaction anchor; re-read after every compaction)

You are the INTEL lead. You work in `Zenith-Worktrees/polaris-intel`
(branch `lane/intel`). Trunk is `Zenith-Worktrees/integration-next` —
nobody commits lane work there; merges happen only on the owner's (Tanner's)
confirmation. The peer lead (STORE, `polaris-store`, `lane/store`) is your
EQUAL: you never direct them, they never direct you, the owner breaks all
ties. Communication with the peer goes through the owner and
`Zenith-Worktrees/handoffs/` (owner-clocked; NEVER poll it).

## Read before working
1. `AGENTS.md` (repo root — TOON contract, style rules, Rule 19).
2. `docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md` — THE plan (POLARIS).
3. `docs/POLARIS-DUAL-LEAD-PLAN.md` — split, checkpoints, peer ruling.
4. `docs/KNOWN-ISSUES-LANE-INTEL.md` — YOUR running ledger (owner rules inside; every surfaced issue goes here FIRST). Historical: `docs/POLARIS-KNOWN-ISSUES-2026-07-15.md`, `docs/POLARIS-NEW-FINDINGS-2026-07-16.md` (N1–N12).

## Standing law (owner-set)
- HOW is yours; WHAT is the owner's. Public type/contract/behavior/test-
  expectation changes STOP and escalate. Proposed amendments stay
  "PENDING OWNER" until his explicit yes. Plan silence can be deliberate
  — the owner is the authority on gap vs decision (N10).
- No deferral of real bugs. Not correct now = no next phase.
- Every correct/intentional ruling goes in the known-issues doc, never
  only code comments.
- zenith-toon is UNTOUCHABLE. Compression seam only via `core/compression.ts`.
- TOON suites rerun after anything that changes fact-row volume.

## Your surface (boundary-test enforced)
`src/core/intelligence/**` (session, evidence, text-floor, questions/*,
ast-intelligence facade, types at checkpoints only), advisory lifecycle.
You consume db-adapter ONLY via QuestionToolkit/named reads. internalId
never crosses the facade. No OFFSET. Buffer.compare UTF-8 collation
everywhere (owner-approved Decision 26). Coverage per N7 Option A.

## Your tasks to the end (CP = checkpoint on trunk, owner-confirmed)
- **NOW (Wave 2 finish):** composers `queryOccurrences` + `resolveAt`
  (literal-floor coupling, candidate protocol; floor is
  acceleration-only, rg never trusted for absence), `traceRelations`
  (depth 1–5, all legacy edges = frontier), `contextFor`. Then Task 2.4
  (adversarial/totality/conservation/determinism; include the two
  recorded gaps: project-mode registry-tier composer runs, root
  dirKey='' scopeModel probe). Then ×3 identical full-suite runs.
  → **CP-1: Wave-2 exit, releasable v4 milestone.** STORE's v5 work may
  merge only after CP-1.
- **CP-2 (STORE lands v5 contracts/3.1 alone; you rebase):** consume in
  Task 3.4's surface half — composer/session upgrades to v5 precision
  (byte ranges via ExactSourceRange; columns are UTF-16 code units,
  owner-approved F2). STORE owns 3.2/3.3 and 3.4's adapter half.
  → **CP-3: Wave-3 exit gate.**
- **Wave 4:** 4.1's INTEL half — FactView wiring into session +
  structural profile behavior (profile CONTRACT types land at **CP-4**
  freeze first). STORE owns 4.2–4.5 language profiles/registries.
  → Wave-4 exit → **OWNER AUDIT #1** (pre-audit self-audit first).
- **CP-5 (v6/binding contract freeze: BindingProof, unit identity —
  STORE lands 5.1–5.3 types):** your half: semantic session pinning
  (5.5's session side) and **5.6 upgrade every fact-domain query to
  semantic proof** (resolved status constructible only with BindingBasis
  + NonEmpty proof — the type gate already exists).
  → Wave-5 exit gate.
- **Wave 6:** 6.1 statement check, 6.2 opaque baseline capture +
  after-state evaluation (captureEditBaseline/evaluateEditAdvisories go
  real). STORE authors 6.3 neutral client + 6.4 adversarial suite
  AGAINST your engine (cross-lane independence — do not write your own
  judge). → Wave-6 exit → **OWNER AUDIT #2.**
- **Wave 7 (joint, on trunk):** 7.1 five-oracle qualification, 7.2
  measure + freeze Decision-23 limits from p99×4 headroom, 7.3 handoff
  docs. Release gate. Done.

## Definition-of-done per checkpoint (prevention mechanisms)
Plan-sentence-quoted contract pins BEFORE implementing; differential/
metamorphic oracles for ordering/paging/accounting; fault-injection pins
at every I/O boundary; no latent surfaces; Unicode/astral corpora
standing; pre-audit self-audit before each owner audit.

## Open residuals you own or watch
- N11: candidate qualifiedName non-nullable — one-field amendment,
  pending owner (optional).
- Known-issues OPEN items: unpinned session behaviors → pin in 2.4.
- FACT_LEDGER v5 domains flip from unavailable as waves land.
- A6 accepted semantics: atomic emission may overshoot page limit.

## Environment landmines
pnpm 11.13.1 works. Node ^26.3. Tests import from dist/ — ALWAYS
`pnpm --filter zenith-mcp run rebuild` before vitest; tsc emits despite
errors (check EXIT CODE, never piped output). vitest.config testTimeout
20s. queryRaw params are variadic (never pass an array); execRaw binds
NOTHING. Detection tests need hermetic HOME. Per-tree real node_modules
(no symlinks — N1/N12; `.gitignore` says `node_modules` no slash; and no
`git add -A` — targeted adds only). Perf output needs
`--disableConsoleIntercept`.
