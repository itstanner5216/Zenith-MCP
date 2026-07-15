# Session Handoff — 2026-07-14 (import-extension branch)

Context file for the next session/agent. Everything below is committed state,
not conversation memory.

## What this branch contains (all built + verified this session)

1. **Project-detection restoration** — full ladder inside `ProjectContext`
   (the ONLY resolver; guard test enforces it):
   registry → git → markers → global, binding tiers
   `explicit > registry > detected > global`, per-call process-tree ping at
   the dispatch seam (`withCallerEnvironmentPing` in server.ts — model does
   NOTHING, no schema injection ever).
2. **Never-refuse** — all 8 refusal throws removed; `getWorkingRoot()` is the
   non-null guarantee; grep-guard test prevents regression.
3. **Anti-litter materialization policy** — detection is signal, promotion is
   consent. Only registry/explicit tiers get `.mcp` DBs; detected roots route
   to the global DB; observations counted per distinct session in
   `project_observations` (global DB); notify-on-detect via MCP logging;
   opt-in `auto_promote_sessions` config knob (Advanced section; env override
   `ZENITH_AUTO_PROMOTE_SESSIONS`). Config file is never auto-written.
4. **Adversarial review** — 12 findings, all fixed, pinned in
   `tests/detection-review-regressions.test.js`.
5. **Verification** — 1,300 tests green across 98 files, tsc strict clean.

## Key files

- `src/core/project-context.ts` — the single resolver (tiers, ping, gates)
- `src/core/detection/{boundaries,process-tree}.ts` — PRIVATE pure helpers
- `tests/detection-*.test.js`, `tests/never-refuse.test.js` — the contracts
- `recovered-project-scoping/`, `recovered-js-source/` — history recovery
  (peak detection era + full pre-TS-conversion JS source)
- `docs/project-scoping/sandbox-mode-note.md` — deferred sandbox-mode work,
  decisions recorded
- `recovered-project-scoping/DETECTION-INVENTORY.md` — deduped mechanism map

## Coordination state

- Parallel worktree: `.claude/worktrees/edit-tool` (separate agent) — owns the
  edit tool ONLY. Rebases onto this branch after push. Its next job:
  `getSymbolDb` (symbol schema on the global DB + absolute-path keying).
  The seam is marked in `getWorkingRoot` — replace the workspace floor with
  global-DB routing, one line, tools unchanged.
- This branch deliberately made NO tool-file edits in the policy layer.

## Next up (queued by Tanner)

- **AST intelligence layer** — plan docs live at
  `docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md` and the expert review at
  `docs/reviews/AST-INTELLIGENCE-PLAN-REVIEW.md`. Related big plans:
  `docs/plans/CHIRON.md`, `docs/plans/KEYSTONE.md`, `docs/ARCHITECTURE.md`.
- Sandbox mode restoration (optional/config-gated, see note doc) — later.

## House rules (hard-won this session)

- ONE resolver. Detection changes go INSIDE ProjectContext.
- Never make the model responsible for detection.
- Never refuse the DB — degrade to global.
- tmp is never a project. Detection never writes. Promotion is deliberate.
- Config file is user-owned — agents never write it uninvited.
