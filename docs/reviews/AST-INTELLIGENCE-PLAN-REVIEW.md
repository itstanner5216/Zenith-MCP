# AstIntelligence Plan Review — Verdict and Correction Set

Date: 2026-07-14. Reviewer: Claude (Fable). Plans under review, tested against the live worktree (`/home/tanner/Projects/Zenith-Worktrees/import-extension`), Mission.md, and AGENTS.md:

- **POLARIS** — `docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md` (1,777 lines)
- **MERIDIAN** — `docs/concepts/MERIDIAN.md` (1,909 lines)
- **PARALLAX** — `docs/concepts/PARALLAX.md` (1,127 lines)

**Verdict up front: POLARIS wins (weighted 4.88 / 5.0, vs MERIDIAN 3.95, PARALLAX 3.09).** Its factual receipts verified against the codebase with line-level precision, its architecture closes every defect this review empirically reproduced, and it is the only plan that ships a releasable AstIntelligence milestone on the existing v4 schema before any semantic build — the Mission's explicit requirement. Section 8 contains the complete patch set that closed every weakness found in it.

> **STATUS (2026-07-14, second pass): ALL SEVEN PATCHES APPLIED to `AST_INTELLIGENCE_SYNTHESIS.md` and re-verified (14/14 fragments, each anchored exactly once). POLARIS is implementation-ready.** Section 8 is now a historical record, not a to-do. Context since the original review: MERIDIAN.md and PARALLAX.md were deleted by the owner; the dual project-detection split was forensically resolved (three generations — git-walk original, abandoned ladder, config-registry rewrite); the dead Gen-2 ladder was deleted; and ProjectContext was rebuilt with detection INSIDE the class (`core/detection/`, encapsulation-guarded, anti-litter promotion policy). PATCH 7 was rewritten before application to record that rebuild as the plan's new ground truth instead of scheduling work the rebuild had already done.

---

## 1. Method

Three verification passes were executed (Sonnet subagents), not just document reading:

1. **POLARIS receipt audit** — every claim in its "Verified implementation ground" checked against actual source, file:line by file:line (16 claim groups).
2. **MERIDIAN receipt audit + design-soundness analysis** — its D5 dossier receipts, grammar census, package claims, plus a from-code soundness analysis of its advisory mechanism (14 claim groups).
3. **Empirical defect reproduction** — live Node harnesses run against the built `dist/` (temp projects, temp DBs, real tree-sitter parsing with the shipped wasm grammars). All seven hypotheses resolved; none untestable.

### 1.1 Empirical results (defects all three plans build upon)

| Claimed defect | Empirical result |
|---|---|
| G5 — same-line reference dedup loss (`extract.ts:78` key omits column) | **CONFIRMED.** `a(); a();` on one line → exactly 1 reference row / 1 edge. |
| G7 — stale-positive resolutions never reconsidered | **CONFIRMED.** Globally-unique `foo` resolved to `a.ts`; after adding a competing `b.ts:foo` and re-running the resolver, the edge still points at `a.ts` (resolver scans `callee_symbol_id IS NULL` only). |
| G8 — capped walk purges unvisited rows | **CONFIRMED.** Two-file project fully indexed, then `indexDirectory(maxFiles:1)` destroyed the second file's rows. |
| G12 — `INSERT OR REPLACE INTO files` cascade | **CONFIRMED (mechanism), latent.** Child symbol rows cascade-deleted on re-upsert; benign today only because `persist.ts` deletes children first. |
| FUTURE_SCHEMA — newer DB not rejected | **CONFIRMED.** `schema_version=99` DB re-inited without error or signal; base DDL runs before the version read (`db-adapter.ts:97–139` vs `:186`). |
| G11 — global key collision (`path.relative` as `files.path`) | **CONFIRMED (static/structural).** Hazard is real by construction; currently unreachable because `getDb` keys one DB per repoRoot. Becomes live the moment global-mode symbol indexing exists — which all three plans introduce. |
| Repo/test health | dist in sync with src; a representative vitest file passes clean under sandbox Node 22 (repo targets ^26.3). |

### 1.2 Receipt-audit outcomes

- **POLARIS:** every checkable ground claim VERIFIED, most exact to the line. Two trivia-grade partials (`getFileFacts` also returns a `referenceEdges` field; a couple of ±1–3 line drifts). One **real** gap: its Task 1.5 non-null-assertion allowlist misses 14 files that contain production `!` assertions (12 `adapters/platforms/*.ts` with `this.configPath()!`, `config/loader.ts:44`, `core/tree-sitter/symbols.ts:314`), so its own global no-non-null gate would fail as written. Its `rebuild` script, `@iarna/toml` and `jsonc-parser` runtime-dependency claims, and all 14 referenced existing test files: verified. Commit pin `d7f086b…` unverifiable (worktree git metadata lives outside the checkout).
- **MERIDIAN:** D5 dossier receipts verified with the same line-level precision (table census, migration rungs, error strings, grammar census 42 wasm / 35 tags with exactly the 7 claimed gap languages). Two real defects: (a) Task 1.3's allowlist cites `src/core/tree-sitter/resolve.ts` — **that file does not exist**; the resolver is `src/core/indexing/resolve.ts`; (b) its advisory mechanism is unsound (below). `Language.md`, which its dossier claims to have read at full fidelity, **does not exist anywhere in this worktree**.
- **PARALLAX:** structurally sound engine design, but the document carries stale pre-supersession content (v3-schema claims, scoring tables, and rulings that its own mid-document "commission update" reverses), and four of its locked decisions were later overturned by author rulings recorded in MERIDIAN (overlay R1, ingestion codec R2, parity demotion R3, sliding lease R4).

### 1.3 MERIDIAN advisory unsoundness (verified from code, not prose)

MERIDIAN's advisory (b) `orphaned_binding_use` = `import_bindings ⋈ edges` diff. Against the actual persisted shapes this **structurally admits false positives and cannot produce exact ranges**:

- Removing `import { drain }` while adding a local `function drain()` still fires the advisory — the call now resolves locally, but the join only checks binding-gone ∧ edge-persists.
- `extract.ts` builds edges by innermost-containing-def line containment and never consults locals/parameters — a parameter named `drain` shadowing the import is indistinguishable in the edges table.
- Edges carry no positions (`{container_def_id, referenced_name, callee_symbol_id, reference_kind}` only), so the advisory can point at "somewhere in container X, lines A–B," never the call site. MERIDIAN's Gate 13 (zero false positives, exact ranges) is unachievable from its stated mechanism. Additionally, `computeEditAdvisories(ctx, {path, before, after})` runs post-write — by then the DB already holds after-state facts, and the before-state facts it needs have been replaced; re-ingesting `before` bytes would corrupt live truth. POLARIS's two-stage capture/evaluate protocol (opaque pre-write baseline token; exact v5 references; proof-linked import bindings) exists precisely to fix both problems.

---

## 2. Evaluation Criteria

| Criterion (weight) | Rationale |
|---|---|
| Mission/contract fidelity (20%) | Mission.md, AGENTS.md, and the author rulings R1–R8 recorded in-repo are the constitution; violating a settled ruling makes a plan unimplementable as written. |
| Factual grounding (15%) | A plan whose receipts are wrong sends builders to files/lines that don't exist. |
| Correctness architecture (15%) | Proof-gated resolution, no evidence laundering, freshness, crash atomicity — the layer's whole point. |
| Standalone implementability (12%) | Closed allowlists, no adoption-by-reference, contracts a builder can execute without the other documents open. |
| Question-surface completeness (10%) | Fact-domain coverage with typed ignorance; the product boundary. |
| Testing rigor (10%) | Oracles, fault injection, adversarial fixtures; the difference between claimed and proven. |
| Existing-schema-first sequencing (8%) | Mission: "The initial implementation should work with the existing schema." |
| Boundedness/performance discipline (5%) | Caps, pagination, N+1 prohibition, RSS gates. |
| First-consumer (advisory) soundness (5%) | The edit-advisory protocol is the layer's first real client; an unsound one poisons the rebuilt fleet. |

## 3. Individual Analysis (condensed to what survives verification)

### POLARIS
**Strengths.** Type-level proof gating (`resolved` is unconstructible without a nonempty `BindingProof` — heuristic/legacy/text evidence physically cannot occupy the resolved arm); the only independently releasable v4 structural milestone (Wave 2) before any schema change; sound two-stage advisory; all six receipt-domain registries written in full per profile (the thing MERIDIAN promises and delegates); exhaustive fact ledger + keyset pagination (no silent truncation); session epoch pinning that correctly combines `PRAGMA data_version` (external commits) with a connection-local commit generation (own commits); complete 36-task closed-allowlist wave plan; every ground receipt verified.
**Weaknesses (all patched in §8).** Task 1.5 allowlist misses 14 asserting files → its global gate fails as written; Task 0.3 probes omit `data_version` semantics despite Decision 16 depending on them; commit pin unverifiable from inside the worktree; `Language.md` absence and Node-engine skew missing from the unchecked register; two ground-receipt line drifts; "already pinned TypeScript" is actually caret-ranged (`^6.0.3`) — a determinism hazard for receipt hashing.
**Gaps.** None found that survive the patch set.
**Incomplete ideas.** Provisional caps by design (settlement protocol is specified); real-DB rehearsal deliberately gated on owner-supplied copy.

### MERIDIAN
**Strengths.** Best dossier discipline in the pool (receipts verified to the line); basis-conservation law ("a join never upgrades evidence") as a property test; totality made structural (M1/M2); the four-widener coverage doctrine (D7) is the clearest articulation of the design question; integrity-wave-first; honest-miss shape (nearMisses/searchGrade/coverageProof); records the author rulings R1–R8 verbatim — historically valuable.
**Weaknesses.** Advisory (b) unsound as specified (§1.3) and Gate 13 unachievable; `heuristic_unique` may still occupy `status:'resolved'` on the v4 lane (empirically wrong answers presented as resolved-with-a-label; consumers ignoring `basis` inherit G6); Task 1.3 allowlist cites a nonexistent file (`core/tree-sitter/resolve.ts`); Waves 2–4 are adoption-by-reference ("reproduce the synthesis base's Phase …") to PARALLAX — a document containing deleted overlay content the builder must mentally filter, the exact W8 defect MERIDIAN's own dossier flags in others; the query face lands only at Wave 5, behind v5, profiles, and v6.
**Gaps.** Receipt-domain membership enumeration per profile promised (M7) but not written; no pagination/continuation story (caps + partial only).
**Incomplete ideas.** Eight-vs-nine method count drift (facade lists 9 members incl. `fileState`; advisory is a 10th module-level entry).

### PARALLAX
**Strengths.** Origin of the pool's best persistence machinery — immutable content-addressed units, lookup receipts with negative dependencies, single manifest CAS, clean-rebuild-equals-incremental oracle — all retained by both successors; strong native task detail; disciplined determinism/N+1 rules.
**Weaknesses.** Four locked decisions overturned by later author rulings: overlay FactView (D17/D18, Task 4.4 — writes-never-blocked ruling deletes it), 60-second session cliff (D19), routing-only codec (Task 2.5 vs. ingestion-codec ruling), and legacy parity/observe gates (Gates 11–12: 99.5% agreement with tools the Mission says will be **removed**). Phase 5 migrates the current tool fleet — directly contrary to the standing decision that no current tool survives this layer. Self-superseding document: early v3-schema claims and a first scoring/rulings block are reversed by the mid-document commission update, both left in place.
**Gaps.** No advisory design; no directory/scope aggregate; no honest-miss floor; v4 heuristic lane keeps authority until Phase 6 cutover.
**Incomplete ideas.** Profile receipt-domain membership named but never specified.

## 4. Comparison Matrix

| Criterion (weight) | POLARIS | MERIDIAN | PARALLAX |
|---|---|---|---|
| Mission/contract fidelity (20%) | **5** | 4 | 2 |
| Factual grounding (15%) | **5** | **5** | 3 |
| Correctness architecture (15%) | **5** | 4 | 4 |
| Standalone implementability (12%) | **4** | 3 | 4 |
| Question-surface completeness (10%) | **5** | 4 | 3 |
| Testing rigor (10%) | **5** | **5** | 4 |
| Existing-schema-first (8%) | **5** | 3 | 2 |
| Boundedness/perf (5%) | **5** | 4 | 4 |
| Advisory soundness (5%) | **5** | 2 | 2 |
| **Weighted total** | **4.88** | **3.95** | **3.09** |

## 5. Universal Blind Spots (no plan addresses)

1. **`Language.md` is absent from this worktree.** Mission.md calls it "an invaluable research document"; MERIDIAN claims to have read 303 KB of it; `find` across the entire worktree returns nothing. Restore it (or record its canonical external location) before implementation leans on it. (Patched into POLARIS's unchecked register.)
2. **The full production non-null-assertion inventory.** 24 files carry real assertions; every plan's accounting undercounts (POLARIS lists 10). (Patched.)
3. **`PRAGMA data_version` single-connection semantics** — it changes only on *other* connections' commits. POLARIS's epoch design already accounts for this but never probes it. (Patched.)
4. **Worktree git metadata lives outside the checkout** (`.git` → `/home/tanner/Projects/Zenith-MCP/.git/worktrees/import-extension`), so no in-repo process can verify a pinned commit. Wave 0 must re-pin at execution time. (Patched.)
5. **TypeScript is caret-ranged, not pinned** (`^6.0.3`) — a resolver minor-bump would silently change receipt-domain outcomes across machines. (Patched.)
6. **Cohabiting non-symbol tables** (`patterns`, `stash`, `config_backups`) appear in no plan's census; any physical-snapshot helper must enumerate all tables, not the symbol-pipeline subset. POLARIS's generic `physicalSnapshot` ("every table") already covers this; flagging so no builder "optimizes" it to a named list.

## 6. Assumptions (in lieu of clarifying questions)

| Question I would ask | Assumption made |
|---|---|
| Are author rulings R1–R8 (recorded in MERIDIAN's dossier) binding law? | Yes — in-repo, owner-dictated, encoded by both later plans; PARALLAX simply predates them. |
| Is Mission.md's "smallest coherent method set from actual current consumers" still operative? | Superseded by the recorded R8 ruling (total oracle over the fact domain; tools will be rebuilt). POLARIS/MERIDIAN both encode this; judged accordingly. |
| Must the first release run on the existing schema? | Yes — Mission.md states it plainly; only POLARIS satisfies it with a releasable v4 milestone. |
| Is the target this worktree at current HEAD? | Yes; all receipts verified against it on 2026-07-14. |

## 7. Ranking

1. **POLARIS — 4.88.** Got most right: the entire correctness architecture, verified grounding, and mission-compliant sequencing. Nothing disqualifying; seven patchable weaknesses (§8).
2. **MERIDIAN — 3.95.** Got most right: dossier rigor and the basis-conservation/totality laws. Disqualified by an unsound first-consumer mechanism, a resolvable-heuristic lane, a nonexistent-file allowlist entry, and adoption-by-reference of a partially-superseded base.
3. **PARALLAX — 3.09.** Got most right: the persistence/concurrency engine both successors inherited. Disqualified by four overturned locked decisions, tool-fleet migration the Mission forbids, and a self-superseding document unsafe to hand a builder.

MERIDIAN's genuinely superior fragments — the worked examples, the honest-miss answer shape, coverage-map table, and the R1–R8 record — are either already absorbed by POLARIS or are documentation rather than architecture. No cherry-pick from PARALLAX survives that POLARIS hasn't already carried (units, receipts, CAS, clean-rebuild oracle are all in POLARIS Waves 5). The correct move is POLARIS + the patch set below, not a fourth synthesis.

---

## 8. THE PATCH SET — apply to `docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md`

Each patch is exact find-and-replace. FIND blocks are verbatim, unique anchors in the current document (verified 2026-07-14). Apply in any order.

### PATCH 1 — Complete the Task 1.5 non-null-assertion allowlist (gate-breaking bug)

The global `polaris-no-non-null.test.js` gate scans all of `src/**/*.ts`, but the allowlist omits 14 files with production assertions. As written, Wave 1 cannot exit.

**FIND:**
```
**Closed allowlist — modify:**

- `packages/zenith-mcp/src/core/edit-engine.ts`
- `packages/zenith-mcp/src/core/shared.ts`
- `packages/zenith-mcp/src/core/symbol-index.ts`
- `packages/zenith-mcp/src/retrieval/pipeline.ts`
- `packages/zenith-mcp/src/retrieval/ranking/bmx-index.ts`
- `packages/zenith-mcp/src/retrieval/ranking/fusion.ts`
- `packages/zenith-mcp/src/retrieval/session.ts`
- `packages/zenith-mcp/src/retrieval/telemetry/tokens.ts`
- `packages/zenith-mcp/src/tools/refactor_batch.ts`
- `packages/zenith-mcp/src/tools/stash_restore.ts`
```

**REPLACE WITH:**
```
**Closed allowlist — modify:**

- `packages/zenith-mcp/src/core/edit-engine.ts`
- `packages/zenith-mcp/src/core/shared.ts`
- `packages/zenith-mcp/src/core/symbol-index.ts`
- `packages/zenith-mcp/src/retrieval/pipeline.ts`
- `packages/zenith-mcp/src/retrieval/ranking/bmx-index.ts`
- `packages/zenith-mcp/src/retrieval/ranking/fusion.ts`
- `packages/zenith-mcp/src/retrieval/session.ts`
- `packages/zenith-mcp/src/retrieval/telemetry/tokens.ts`
- `packages/zenith-mcp/src/tools/refactor_batch.ts`
- `packages/zenith-mcp/src/tools/stash_restore.ts`
- `packages/zenith-mcp/src/config/loader.ts`
- `packages/zenith-mcp/src/core/tree-sitter/symbols.ts`
- `packages/zenith-mcp/src/adapters/platforms/antigravity.ts`
- `packages/zenith-mcp/src/adapters/platforms/claude-desktop.ts`
- `packages/zenith-mcp/src/adapters/platforms/cline.ts`
- `packages/zenith-mcp/src/adapters/platforms/codex-cli.ts`
- `packages/zenith-mcp/src/adapters/platforms/codex-desktop.ts`
- `packages/zenith-mcp/src/adapters/platforms/continue-dev.ts`
- `packages/zenith-mcp/src/adapters/platforms/gemini-cli.ts`
- `packages/zenith-mcp/src/adapters/platforms/github-copilot.ts`
- `packages/zenith-mcp/src/adapters/platforms/gptme.ts`
- `packages/zenith-mcp/src/adapters/platforms/raycast.ts`
- `packages/zenith-mcp/src/adapters/platforms/roo-code.ts`
- `packages/zenith-mcp/src/adapters/platforms/warp.ts`
```

**FIND:**
```
Replace each assertion with an explicit invariant guard or mathematically correct default; array/typed-array accumulators use the correct `INF/-INF` semantics, never convenient zero. Build a TypeScript-AST test that rejects `NonNullExpression` anywhere under `src/**/*.ts` so the gate is syntax-aware rather than regex-based.
```

**REPLACE WITH:**
```
Replace each assertion with an explicit invariant guard or mathematically correct default; array/typed-array accumulators use the correct `INF/-INF` semantics, never convenient zero. Build a TypeScript-AST test that rejects `NonNullExpression` anywhere under `src/**/*.ts` so the gate is syntax-aware rather than regex-based.

The verified 2026-07-14 inventory this allowlist must clear: the ten files above the divider; twelve `adapters/platforms/*.ts` files sharing the identical `this.configPath()!;` pattern (fix once, apply twelve times — a guard that throws a typed configuration error when `configPath()` returns null); `config/loader.ts:44`; and `core/tree-sitter/symbols.ts:314` (`candidates[0]!` behind a "non-empty, just checked" comment — replace with an explicit length-guarded destructure so the invariant is code, not comment). `core/tree-sitter/injections.ts` greps as a match but is a false positive: its `!` characters are tree-sitter `#set!` predicate names in comments — the AST-based gate handles this correctly; a regex gate would not. If implementation discovers an asserting production file not listed here, stop and amend this allowlist rather than leaving the global gate red.
```

### PATCH 2 — Probe `PRAGMA data_version` semantics in Task 0.3

Decision 16's fact epoch depends on `data_version` changing only for *other* connections' commits; the probe suite never verifies that.

**FIND:**
```
Probe Node's SQLite recursive CTE with a `depth < 64` cycle guard; symbol/stash schema cohabitation in a temporary fake home; worktree root discovery; WAL reader visibility during an uncommitted writer; and global two-root isolation.
```

**REPLACE WITH:**
```
Probe Node's SQLite recursive CTE with a `depth < 64` cycle guard; symbol/stash schema cohabitation in a temporary fake home; worktree root discovery; WAL reader visibility during an uncommitted writer; global two-root isolation; and `PRAGMA data_version` semantics — assert on file-backed DBs that it increments when a second connection commits, and does NOT change on the same connection's own commits, rollbacks, or savepoint releases. Decision 16's fact epoch is the pair (data_version, connection-local outer-commit generation); both halves must be probed, because `data_version` alone is blind to same-connection writes and the generation counter alone is blind to external ones.
```

### PATCH 3 — Extend the Unchecked register (Language.md, git metadata, engine skew)

**FIND:**
```
- No assertion in this plan depends on current tool output parity. The only current-tool reference is evidence that a before/after lifecycle seam has existed; the reference client supplies the actual acceptance proof.
```

**REPLACE WITH:**
```
- No assertion in this plan depends on current tool output parity. The only current-tool reference is evidence that a before/after lifecycle seam has existed; the reference client supplies the actual acceptance proof.
- `Language.md`, the research survey Mission.md names as invaluable, is not present anywhere in this worktree (verified 2026-07-14). The dossier's citations of it are to an external copy. Restore it to `docs/concepts/` or record its canonical location before any implementation decision leans on it; no POLARIS contract depends on its contents.
- This checkout is a git worktree whose metadata lives outside it (`.git` -> `/home/tanner/Projects/Zenith-MCP/.git/worktrees/import-extension`), so the ground commit pin cannot be verified from inside the tree. Task 0.1 re-pins the actual `git rev-parse HEAD` at execution time and records it in the baseline fixture; a mismatch with the dossier pin is a stop-and-reverify event, not a silent proceed.
- The repository pins `engines.node ^26.3.0`; probe/qualification results gathered on any other Node major (e.g. a sandbox v22 with experimental `node:sqlite`) are soft evidence only. Wave 0 probes and Wave 7 measurements are release evidence only when run on a matching engine.
```

### PATCH 4 — Ground-receipt errata (line drift + missing-refusal precision)

**FIND:**
```
- `core/db-adapter.ts:95-335` is schema v4, but base DDL/ad-hoc mutations run before the schema version is read at line 186. `files` still uses `INSERT OR REPLACE` at lines 441-446.
```

**REPLACE WITH:**
```
- `core/db-adapter.ts:95-336` is schema v4, but base DDL/ad-hoc mutations run before the schema version is read at line 186, and a version newer than the ladder is silently accepted — the migration blocks are all `currentVersion < N` guards with no upper-bound refusal, so a v99 database re-initializes without any error or signal (empirically confirmed). The defect Task 1.1 fixes is therefore twofold: the pre-read DDL window and the missing FUTURE_SCHEMA rejection. `files` still uses `INSERT OR REPLACE` at lines 444-447; empirically, re-upserting a file cascade-deletes its child symbol rows (benign today only because `persist.ts` deletes children first — latent for any future file-keyed derived state).
```

**FIND:**
```
- `core/indexing/resolve.ts:4-16,144-170,209-224` resolves a unique same-file definition or globally unique name and only scans null `callee_symbol_id` rows. It proves neither import/export reachability nor recovery after a competitor appears.
```

**REPLACE WITH:**
```
- `core/indexing/resolve.ts` (resolveNameGroup 114-173: same-file unique 153-160, globally unique 165-168; resolveAllEdgeTargets 209-225) resolves a unique same-file definition or globally unique name and only scans null `callee_symbol_id` rows. It proves neither import/export reachability nor recovery after a competitor appears — empirically confirmed: after a competing same-name definition lands in a second file, the previously resolved edge still points at the original target through repeated resolver passes. Note this file is `core/indexing/resolve.ts`; no `core/tree-sitter/resolve.ts` exists (a sibling plan cites the wrong path).
```

### PATCH 5 — Re-ground the "Verified implementation ground" preamble with the executed verification

**FIND:**
```
Ground is the current `d7f086b68f4bf7355376d21432e652fd4dc2aa0a` checkout. The following claims were re-read in this checkout; the prior judgment's Node-26 harness results are accepted as supplied evidence but were not rerun during this synthesis.
```

**REPLACE WITH:**
```
Ground is the current `d7f086b68f4bf7355376d21432e652fd4dc2aa0a` checkout (re-pin at Wave 0 — the worktree's git metadata is outside the tree, so this pin is not verifiable from within it). The following claims were re-read in this checkout; the prior judgment's Node-26 harness results are accepted as supplied evidence but were not rerun during this synthesis. A 2026-07-14 independent verification pass subsequently re-confirmed every receipt below against source (line-exact in nearly all cases) and empirically reproduced G5 same-line dedup loss, G7 stale-positive persistence, G8 capped-walk purge, G12 upsert cascade, and silent future-schema acceptance as live harnesses against the built dist. One addendum: `getFileFacts` also returns a line-keyed `referenceEdges` field beyond the families listed below; it belongs to the raw-edge row of the fact ledger and is already covered by that ledger row.
```

### PATCH 6 — Pin TypeScript exactly when it moves to runtime (Task 4.2)

`package.json` carries `typescript: ^6.0.3` — caret-ranged, not pinned. Receipt domains hash resolver outcomes; an unpinned resolver version silently breaks cross-machine determinism.

**FIND:**
```
Move the already pinned TypeScript version to runtime dependencies. Implement only config parsing and `resolveModuleName`, plus the exact lexical/module/export/member/prelude receipt domains above.
```

**REPLACE WITH:**
```
Move TypeScript from devDependencies to runtime dependencies and pin it exactly in the same change (the current spec is caret-ranged `^6.0.3`; strip the caret to the resolved lockfile version). Receipt domains hash `resolveModuleName` outcomes and failed-lookup lists, so a resolver minor-bump would silently change domain digests across machines; the pinned version participates in the `module` receipt key via configHash, and any deliberate TypeScript upgrade is a receipt-domain-version event, not a routine dependency bump. Implement only config parsing and `resolveModuleName`, plus the exact lexical/module/export/member/prelude receipt domains above.
```

### PATCH 7 — Ground refresh for the 2026-07-14 ProjectContext rebuild (applied directly; final form)

Written after the original six and applied in the same pass. Four fragments, all in `AST_INTELLIGENCE_SYNTHESIS.md`:

1. **Verified-ground bullet replaced** — `core/project-context.ts` is now recorded as rebuilt: single routing authority with detection inside the class (`core/detection/boundaries.ts` pure-fs git/marker walk, `core/detection/process-tree.ts` caller-cwd evidence, both private behind an encapsulation guard test), resolution order explicit-binding → config registry → boundary detection → global fallback, anti-litter materialization (detection is signal, promotion is explicit), Gen-2 fossils deleted (recovered copies parked in `recovered-project-scoping/`, never importable), remaining dual-routing seams enumerated as fleet-rebuild casualties.
2. **Task 1.4 extended** — the `getIntelligenceStore` accessor must obey the anti-litter gate (a detected-but-unpromoted root routes to the global store; promotion upgrades routing — the intelligence path never silently materializes a project DB); `config/backup.ts` added to the allowlist so exactly one code path opens the global DB; `project_roots` must gain a reader or be documented as write-only compatibility; acceptance extended accordingly.
3. **Task 7.3 extended** — `docs/Developers-Guide.md` added to the allowlist; both docs were already corrected to the config-registry + internal-detection reality and must be kept aligned; the standing rule is stated: automatic detection lives INSIDE `ProjectContext`, never a second resolver.
4. **Ground preamble re-pinned** — the commit pin is marked as amended by the rebuild and re-pinned at Wave 0.

---

## 9. Self-Scrutiny

Scoring the patched POLARIS against the same criteria: implementability rises to 5 (the one verified gate-breaking gap is closed; the register now owns every unverifiable input), total 5.0 within this rubric's resolution — expected, since the patches were derived from the rubric's own findings.

**Bias check.** (1) POLARIS is the newest document and was itself written as a synthesis over the other two plus rulings — a structural advantage. That advantage is legitimate for this decision: the task is "which of these three should be implemented," not "which author reasoned best blind." Where POLARIS criticized MERIDIAN/PARALLAX, this review did not take its word — the advisory unsoundness, the resolver-path error, and the overlay/parity conflicts were independently re-derived from code and the in-repo ruling record. (2) Does POLARIS survive the weaknesses flagged in the others? Checked directly: its resolved-arm is type-gated (no heuristic lane), its advisory is two-stage with proof obligations, its allowlists were audited for nonexistent paths (all 14 referenced existing test files exist; the one inventory gap found is Patch 1). (3) Would different constraints change the ranking? Only one scenario: if the owner rescinded rulings R3/R8 and required strict minimal Mission scope with no v5/v6 ever, none of the three fits as written — but POLARIS's Waves 0–2 are severable as exactly that minimal, existing-schema deliverable, which the other two cannot claim. (4) Cost acknowledged: POLARIS is the largest commitment (36 tasks, 8 waves); the patch set adds no scope beyond making stated gates satisfiable.

**Top three residual risks (post-patch):**

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wave 4–5 profile/semantic scope strains a solo implementation timeline | Medium | Medium | Waves 0–2 are independently releasable; ship them first, reassess cadence at the Wave 2 gate |
| Provisional caps mis-sized for real repos until Wave 7 settlement | Medium | Low | Settlement formula is already specified; caps fail typed-partial, never silently |
| Real historical DB rehearsal never executed (no copy supplied) | Medium | High | Already a named UNEXECUTED release gate in the plan; supply a copy before cutover |
