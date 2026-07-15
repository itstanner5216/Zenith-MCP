# Session Handoff — 2026-07-15 (import-extension branch, POLARIS build)

Continuation of docs/SESSION-HANDOFF-2026-07-14.md. Everything below is
committed-state description, not conversation memory. The plan is
docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md (POLARIS); implementation began
this session. Plan amendments made during implementation are recorded INSIDE
the plan document at their tasks (search "Amendment (2026-07-15").

## Where the build stands

**Wave 0 (ground + oracles): COMPLETE.**
**Wave 1 (v4 repairs + store identity): COMPLETE — exit gate green ×3
(109 test files / 1,578 passed / 0 failed / 2 env-gated skips).**
**Wave 2: contract freeze landed (types.ts, limits.ts, contracts gate);
session factory / reads / composers NOT started.**

All five review-confirmed defects are FIXED and pinned as permanent
regressions in tests/polaris-current-failures.test.js (each comment names its
fixing task): G5 same-line ref dedup loss, G7 stale-positive resolution, G8
capped-walk purge, G12 upsert cascade, FUTURE_SCHEMA silent acceptance.

## What was built this session

### Wave 0 artifacts (tests/, fixtures/)
- fixtures/polaris-workspace/** (28 adversarial fixtures, 7 languages) +
  fixtures/polaris-expected.json — two-section truth corpus: `truth`
  (hand-authored five-state resolution answers, export facts, occurrence
  columns) and `currentV4` (verified current behavior; baseline asserts it
  with SUPERSET semantics on refs/edges so Wave-1 repairs could only add).
- polaris-baseline.test.js, polaris-current-failures.test.js,
  polaris-db-atomicity.test.js (16-boundary fault matrix over the persist
  transaction, trigger-injected, old-committed-or-new-committed proof),
  polaris-schema-migration.test.js (fixture⇄ladder drift alarm, v1→v4
  canonical preservation, per-rung fault injection, byte-identical
  future-schema refusal, env-gated real-DB rehearsal via
  POLARIS_REAL_DB_COPY), polaris-environment.test.js (CTE cycle guard, WAL
  isolation, data_version semantics, cohabitation, worktree discovery),
  polaris-performance.test.js (measured ground + the Wave-7 settlement
  formula reference implementation), polaris-query-plan.test.js (EQP pins +
  no-OFFSET rule), polaris-boundaries.test.js (extractor ingestion-only,
  queryRaw test-only, TOON manifest guard, facade discipline),
  helpers/polaris-db.js, fixtures/polaris-v1-schema.sql,
  fixtures/polaris-v4-schema.sql (ladder-DDL replays, self-verified).

### Wave 1 production changes (all in core/, none in tools except noted)
- db-adapter.ts: FUTURE_SCHEMA read-only inspection BEFORE any DDL
  (LATEST_SYMBOL_SCHEMA_VERSION=4); upsertFile → ON CONFLICT DO UPDATE;
  typed structure reads (readSymbolStructure ok|missing|corrupt,
  findSymbolStructuresByName → {rows, corrupt}); explicit
  deleteImports/ImportBindings/InjectionsByFile (the OR-REPLACE cascade had
  been the de-facto clear for file-FK'd tables — plan amended);
  affected-name primitives (getDefinitionNamesByFile,
  clearEdgeTargetsByNames w/ RETURNING + resolved-target arm for
  dot-qualified stales, getUnresolvedEdgesByNames, 100-chunked);
  legacy-global primitives (getLegacyGlobalFilePaths,
  rewriteLegacyGlobalRows — single transaction, collision abort, FK check).
- indexing/extract.ts: ref dedup key gains column (defs keep line-scoped
  compatibility key).
- indexing/persist.ts: one transaction = old-names read → clears → writes →
  affected-name clear+re-resolve (changedDefs = old∪new only when sets
  differ; cleared names returned so nothing commits owed).
- indexing/resolve.ts: resolveEdgesForNames (affected-name entry, savepoint-
  nested); resolveAllEdgeTargets retained as test/backfill + clean-oracle
  entry only — NO production sweep remains (structural test re-pinned).
- symbol-index.ts: IndexAddress + createProject/GlobalIndexAddress
  (g/<sha256(root)>/ codec); address-cored indexFileAt/indexDirectoryAt/
  ensureIndexFreshAt/ensureFreshFromContentAt with legacy-signature wrappers
  (tools unchanged); IndexCoverage {visited, complete, stopReason} with
  exhaustive-discovery→sort→cap (deterministic membership, purge only on
  complete walks); 16 MiB PROVISIONAL_MAX_SOURCE_BYTES with toolarge@1:
  sentinel (no parse, no purge); purge does deletion-side re-resolution.
- project-context.ts: getIntelligenceStore(anchor) — anti-litter gate
  (explicit/registry → project DB; detected/global → GLOBAL store scoped to
  longest containing allowed root; never materializes .mcp);
  getGlobalDbConnection/closeGlobalDb (the ONE global opener);
  ensureGlobalSymbolStore — future-guard first, symbol+stash cohabitation,
  three-way legacy branch (none / single-provable-root transactional rewrite
  / preserved-but-quarantined + legacy_global_scope_ambiguous).
- config/backup.ts: rides the shared global connection (no second opener).
- Task 1.5 (subagent): 73 NonNullExpression sites removed across 23 files;
  tools/ got MINIMAL mechanical treatment per owner instruction;
  tests/polaris-no-non-null.test.js is a syntax-aware AST gate with
  positive/negative anti-vacuity controls.

### Out-of-plan repo health (all disclosed)
- detection/boundaries.ts: junk-root laundering fix — found git/marker roots
  are junk-checked BEFORE clamping (a .git at $HOME could previously fabricate
  a "detected project" at any allowed subdir). Pinned as P2-4b in
  detection-review-regressions.test.js.
- detection-review-regressions.test.js made hermetic ($HOME stub + .git
  ceiling): it was reading the real ~/.zenith-mcp/config (18 projects) and
  the real home's .git mid-test.
- vitest.config.ts (new): testTimeout 20s / hookTimeout 30s — first-in-file
  tool registration tests sat exactly at the 5s default under full-suite
  parallel load.
- KNOWN LIMITATION: most non-polaris tests still read the real user config
  through getConfig() (e.g. default_excludes could theoretically alter
  indexing-test expectations on machines with exotic configs). Pre-existing;
  only detection-review-regressions and polaris-global-store are hermetic.

### Wave 2 contract freeze (landed early, verified)
- src/core/intelligence/types.ts — character-faithful transcription of the
  plan's Public contracts (verified against the plan line-by-line);
  deliberately OMITS AstSession/OpenSessionResult/ResolutionResult/
  OccurrenceFact/the six answer payloads/FsContext/facade functions (listed
  in its tail comment) — those are Task 2.1 integration work.
- src/core/intelligence/limits.ts — LOCKED_BOUNDS (Decision 22) +
  PROVISIONAL_LIMITS (Decision 23). Task 2.1 integration must re-point
  symbol-index's PROVISIONAL_MAX_SOURCE_BYTES here.
- tests/polaris-contracts.test.js — compile-time gate (10 fixtures: weak
  resolved variants rejected, brand forgery rejected,
  exactOptionalPropertyTypes enforced) + ESM-suffix scan.

## Next up (in order)
1. Task 2.1 integration: session factory (freshness, source-domain digest,
   data_version+commit-generation epoch, MAC'd keyset cursors, sliding
   lease), ast-intelligence.ts facade, fact-ledger compile map, remaining
   payload types. THEN 2.2 (v4 read set), 2.3 (seven composers + literal
   floor), 2.4 (adversarial/totality/determinism) → the releasable POLARIS
   Structural milestone (facade frozen after Wave 2).
2. Owner ruling captured mid-session: the CURRENT TOOL FLEET IS BEING
   REBUILT one-by-one after POLARIS — zero further investment in src/tools/*
   beyond compilation necessity.
3. Open judgment call (worker-flagged, accepted by lead, owner may overrule):
   the 12 platform adapters throw plain Error with config-specific messages
   ("typed configuration error" realized as message-typed, matching house
   convention — no custom error classes exist repo-wide). A dedicated error
   class needs base.ts or adapters/errors.ts allowlisted.

## Environment notes (this host)
- pnpm launcher is BROKEN (corrupt store link). Use direct binaries:
  cd packages/zenith-mcp && node scripts/patch-mcp-server-dts.mjs &&
  node_modules/.bin/tsc --build && node_modules/.bin/shx cp -r grammars dist/
  Tests: node_modules/.bin/vitest run [files]
- Node v26.4.0 (matches engines ^26.3.0 — release-grade evidence).
- ~/.zenith-mcp/config EXISTS with 18 projects; the real home has a .git
  stub — both bite any test that isn't hermetic about $HOME.
- Real-DB rehearsal gate: UNEXECUTED (set POLARIS_REAL_DB_COPY to a
  disposable copy to run it).

## House rules confirmed intact
- TOON: zero files under packages/zenith-toon touched (mechanically enforced
  by polaris-boundaries.test.js, which parses the plan's own allowlists).
  The seam now carries TRUE same-line reference counts (G5 fix) — richer
  facts, same shapes; all compression suites green at every checkpoint.
- ONE resolver (ProjectContext); never-refuse; detection never writes;
  config file never auto-written.
