### Phase 0 — Context reading (no subagent, prerequisite)

- **Task 1 (plan)** — Read codebase, `docs/tool_audit`, `docs/toon-constraints`, `docs/toon-goal`.

This is not a parallel-subagent slot. Each downstream subagent loads the relevant context per its task brief.

---

### Wave 1a — 5 tasks parallel

| Task | File written | Purpose |
|---|---|---|
| R | `core/tree-sitter/runtime.ts` | `DEF_TYPES` + `QUERIES_LANG_MAP` + `getCompiledModularQuery()` |
| 5 | `core/tree-sitter/languages.ts` | `.cs`/`.csx` → `c_sharp` mapping |
| 6 | `core/tree-sitter/capture-tags.ts` (NEW) | `parseCaptureTag()` |
| 7 | `core/tree-sitter/body.ts` (NEW) | `bodySlice()`, `bodyHash()` |
| 8 | `core/tree-sitter/structure.ts` (NEW) | Per-language tables, `extractStructureForDef()` |

#### Review Checkpoint after Wave 1a — 3 agents

| Reviewer | Focus |
|---|---|
| A | Priority 0.5 mechanical: confirm Task R added no compression-decision symbols and no forbidden imports. |
| B | Structure tables: `PARAM_CONTAINERS_BY_LANG` and `MODIFIER_KEYWORDS_BY_LANG` cover all 17 languages, the global-fallback path is correct, and `extractStructureForDef(langName, …)` uses per-language lookups (not the deprecated single global set). |
| C | `parseCaptureTag` handles every `@definition.<X>` and `@reference.<X>` variant present in the shipped `grammars/queries/**` and returns `null` for unknown tags. |

---

### Wave 1b — 5 tasks parallel

| Task | File written | Purpose |
|---|---|---|
| 9 | `core/tree-sitter/anchors.ts` (NEW) | `ANCHOR_RULES`, `extractAnchorsForDef()` |
| 10 | `core/tree-sitter/imports.ts` (NEW) | `extractImportsFromSymbols()` |
| 11 | `core/tree-sitter/injections.ts` (NEW) | `extractInjections()` with two-level `setProperties` lookup |
| 12 | `core/tree-sitter/locals.ts` (NEW) | `extractLocals()` |
| 13 | `core/indexing/types.ts` (NEW) | Shared types for the extract/persist pipeline |

#### Review Checkpoint after Wave 1b — 3 agents

| Reviewer | Focus |
|---|---|
| D | `injections.ts` two-level lookup: confirm `QueryMatch.setProperties` is checked first, then `Query.setProperties[match.patternIndex]` as fallback. Types must derive from `web-tree-sitter@0.26.9` `.d.ts` (no `as any`). |
| E | `anchors.ts` `ANCHOR_RULES` covers `TODO`/`FIXME`/`XXX`/`HACK` across language families; comment-pattern matching is per-language (not a single regex). |
| F | `indexing/types.ts` field shapes match every consumer in plan Tasks 14/15 verbatim — no missing fields, no off-by-name renames. |

---

### Wave 1c — 3 tasks parallel

| Task | File written | Purpose |
|---|---|---|
| 17 | `core/db-adapter.ts` | v0→v1 migration + 18 adapter functions + `project_roots` DDL |
| T | `packages/zenith-toon/src/{string-codec,types,index}.ts` | `compressFile(req)` + `RawFileFacts` + re-export |
| 23 | `core/tree-sitter.ts` | Barrel re-exports of Wave-1a/1b modules |

#### Review Checkpoint after Wave 1c — 3 agents

| Reviewer | Focus |
|---|---|
| G | db-adapter migration is additive (all new columns nullable, all new tables `IF NOT EXISTS`); every adapter uses `prepareOrCache`; `node:sqlite` import remains the sole hit; `project_roots` DDL is inside the v0→v1 ladder, not floating. |
| H | zenith-toon `compressFile` signature matches exactly what Task 19 will call; `RawFileFacts` type contains zero MCP-side decision fields (no priorities, no weights, no `astWeight`); the re-export in `index.ts` is the single public symbol added. |
| H2 | tree-sitter.ts barrel re-exports every symbol name listed in the plan (Tasks 6–12, R); no extras leak; no internal helpers re-exported. |

---

### Wave 2 — 4 tasks parallel

| Task | File written | Purpose |
|---|---|---|
| 14 | `core/indexing/extract.ts` (NEW) | Single-parse orchestrator |
| 15 | `core/indexing/persist.ts` (NEW) | Single-transaction DB writer |
| 16 | `core/indexing/resolve.ts` (NEW) | Cross-file edge resolution with strict parent check |
| 19 | `core/compression.ts` | Gutted to facts pipe + `compressFile` call |

#### Review Checkpoint after Wave 2 — 4 agents

| Reviewer | Focus |
|---|---|
| I | `extract.ts` orchestrator calls each leaf extractor exactly once and assembles `ParsedFile` correctly; per-language `getCompiledModularQuery` lookups are guarded with `null` fallthrough. |
| J | `persist.ts` wraps every insert in **one** `runTransaction`; no partial-write window between symbols/structures/anchors/imports/injections/locals. |
| K | `resolve.ts` strict parent check: `findSymbolParent` is called and its return's `name` must equal the qualifier — `Foo.bar` is rejected when `bar`'s unique parent is not literally named `Foo`. |
| L | `compression.ts` Priority 0.5 mechanical: zero hits for `StructureBlock`, `CompressionContext`, `computeCompressionBudget`, `isCompressionUseful`, `DEFAULT_COMPRESSION_KEEP_RATIO`, `truncateToBudget`, `compressTextFile`, `Math.sqrt(.*call_count`, `block.priority`. The single `from 'zenith-toon'` import is `{ compressFile }`. |

---

### Wave 3 — 4 tasks parallel

| Task | File written | Purpose |
|---|---|---|
| 18 | `core/symbol-index.ts` | `indexFile` delegation; `indexDirectory` resolve pass; `getDb` upserts `project_roots` |
| 20 | `tools/read_file.ts` | Swap `compressTextFile` → `compressForTool`; inline 3-line truncator |
| 21 | `tools/read_multiple_files.ts` | Same swap |
| 22 | `tools/refactor_batch.ts` | Lines 471–473 and 974–975 populated from `findSymbolStructuresByName` |

*(No review checkpoint here — cumulative task count since last review is 4. The 5-task trigger fires inside Wave 4's first task, so the review lands after Wave 4 below.)*

---

### Wave 4 — 1 task (sequenced due to file collisions)

| Task | Files written | Purpose |
|---|---|---|
| 24 | `core/db-adapter.ts` + `tools/refactor_batch.ts` | `insertPattern`/`getPattern` adapters + reapply consumer wiring |

#### Review Checkpoint after Wave 4 — 4 agents
*(Cumulative tasks since last review: 18, 20, 21, 22, 24 = 5 tasks. Trigger met.)*

| Reviewer | Focus |
|---|---|
| M | `symbol-index.ts`: `indexFile` is now a thin delegation to `extractParsedFile` + `persistParsedFile`; `indexDirectory` calls `resolveEdgeTargets` post-batch; `getDb` upserts `project_roots`. |
| N | `read_file.ts` and `read_multiple_files.ts` both pass raw text + budget to `compressForTool`; no compression decisions leak into MCP; the inline truncator is the documented 3-line form, not a function call. |
| O | `refactor_batch.ts` outlier detection at lines 471–473 and 974–975 now reads from `findSymbolStructuresByName`; old hardcoded placeholders are gone; results drive `findModal` / `firstDiffReason` correctly. |
| P | Task 24 reapply consumer correctly calls `insertPattern` on apply-success and `getPattern` on reapply-load; the two new adapter functions use `prepareOrCache` and `INSERT OR REPLACE`. |

---

### Wave 5 — Operator-driven gate (not a subagent wave)

Execute the plan's **Test Repair Gate** (T1–T5) and **Mechanical Verification** (9 grep/build/test checks) sections in order. Both already live inline in `Road_To_AST_Awareness_v3.md`. v3 is not declared landed until both gates pass.

---

## 7. Phase 0 — Context reading

**Phase 0 is required but minimal:** just plan Task 1's reading list. It produces no file writes and consumes no subagent slot. The reading is repeated as needed inside each downstream subagent's brief (each gets the relevant slice of the plan plus the four `docs/` references).

This satisfies the framework's "Phase 0 must be as small as possible — 2-3 tasks maximum" rule (we have 1 task, and it is non-coding).

---

## 8. Validation Checklist

- [x] **All files that will be created, modified, or read are listed** — §2 File Inventory.
- [x] **All tasks are decomposed to single-subagent units** — §3 Task Decomposition (21 subagent tasks).
- [x] **All dependencies between tasks are explicitly mapped AND PROVEN in the Dependency Proof Table** — §4.
- [x] **No unproven dependencies remain** — every claim in §4 has a completed "because ___" sentence; the two REAL entries are Rule-1 file-write collisions, not dependencies.
- [x] **All file conflicts are identified and resolved via wave separation** — §5 (runtime.ts via merge; db-adapter.ts + refactor_batch.ts via Wave 4 isolation of Task 24).
- [x] **No same-file edits within any wave (Rule 1)** — confirmed per-wave in §6.
- [x] **No intra-wave dependencies in any wave (Rule 2)** — confirmed per-wave in §6 using the §4 proofs.
- [x] **No task depends on future-created files (Rule 3)** — under strict reading, all "future deps" are edit-time-FALSE; under the defensive-ordering overlay, every wave's outputs make the next wave's imports resolve on disk.
- [x] **Every wave can execute from the repo state at wave start (Rule 4)** — confirmed per-wave in §6.
- [x] **Phase 0 is minimal or absent** — Phase 0 is 1 non-coding task (context reading); well under the 2-3-task cap.
- [x] **Parallelization is maximized** — within the 5-task cap, Waves 1a and 1b are saturated (5/5); Waves 1c, 2, 3 are at 3/4/4 because moving more tasks earlier would either violate the cap, violate defensive ordering, or destabilize review surfaces. The §6 wave plan is provably parallelism-maximal under the operator's cap + defensive overlay.
- [x] **BOTH documents exist** — `docs/superpowers/audits/reasoning-road-to-ast-awareness.md` and `docs/superpowers/audits/2026-06-04-road-to-ast-awareness-audit.md` (this file).

---
