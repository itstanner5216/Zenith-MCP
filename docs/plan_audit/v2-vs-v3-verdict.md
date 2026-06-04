v3 wins.

The decisive reason is that v3 is the only plan that attempts a one-pass, no-deferral AST-awareness implementation: it lands injections, locals, anchors, structural rows, cross-file resolution, `patterns` wiring, `project_roots` wiring, and the two `refactor_batch.ts` outlier TODO fixes in one plan, while v2 explicitly defers injections and leaves dead schemas unwired. The codebase and grammar inventory support v3's core expansion: `runtime.ts` currently only loads `<lang>-tags.scm`, `refactor_batch.ts` has empty `SymbolStructure[]` arrays at the exact two sites both plans cite, `languages.ts` currently maps C# to the poorer `csharp` tags file, and the shipped query directories really do include 13 `injections.scm` languages. v3 has a serious seam inconsistency in its literal `compression.ts` snippet, but v2 has the same forbidden MCP-side shaping problem plus explicit deferrals; v3 is still the better plan to execute because its surface area is more complete, more concrete, and closer to the non-negotiable ownership boundary.

## Scoring table

| Axis | v2 | v3 | Evidence cite |
|---|---:|---:|---|
| 1. Fidelity to Priority 0 | 4 | 4 | `constraints.md` Priority 0 requires true original line numbers, valid `[TRUNCATED: lines X-Y]` markers, 68-72% retention, verbatim lines, and `_MIN_OMISSION_THRESHOLD = 6` (`docs/toon-constraints/constraints.md` lines 1-14, 161-181, 183-200, 291-299). Neither plan edits TOON's Phase H/marker loop directly; both mostly avoid touching output emission. |
| 2. Fidelity to Priority 0.5 package ownership | 2 | 3 | v2 deletes forbidden exports in `§core/compression.ts — GUTTED` but still imports `StructureBlock`/`CompressionContext` and builds them in MCP (`Road_To_AST_Awareness_v2.md` lines 1122-1128, 1153-1200, 1218). v3 has a stronger deletion checklist (`Road_To_AST_Awareness_v3.md` lines 2099-2107) and raw `call_count`, but its literal seam still constructs `StructureBlock[]`/`CompressionContext` (`Road_To_AST_Awareness_v3.md` lines 1715-1825), conflicting with `constraints.md` lines 52-70. |
| 3. DB-layer invariant | 4 | 4 | Current invariant verified: only `db-adapter.ts` imports `node:sqlite` (`packages/zenith-mcp/src/core/db-adapter.ts` line 1; grep returned one hit). Both plans add named adapter functions. v3 is more complete (`Road_To_AST_Awareness_v3.md` lines 1513-1649), but still includes a few `handle(conn).prepare` examples rather than uniform `prepareOrCache` (e.g. line 1559). |
| 4. Maximum AST extraction from shipped grammars | 3 | 5 | v2 defers injections (`Road_To_AST_Awareness_v2.md` lines 1328-1330) and has ellipsis-heavy anchor tables. v3 lands `extractInjections`, `extractLocals`, capture provenance, structures, anchors, imports, and body hashes (`Road_To_AST_Awareness_v3.md` lines 812-1111, 1116-1304). Grammar inventory verified 13 `injections.scm` languages: bash, css, dockerfile, hcl, html, javascript, markdown, nix, php, svelte, tsx, vue, xml. |
| 5. No deferrals | 1 | 5 | v2 explicitly says `Does not add injections extraction (Phase 2)` and `Does not add a patterns table consumer` / `Does not wire project_roots` (`Road_To_AST_Awareness_v2.md` lines 1352-1357). v3 states `No deferrals. No Phase 2.` (`Road_To_AST_Awareness_v3.md` line 5) and includes deliverables for injections/patterns/project_roots. |
| 6. Concreteness / implementability | 3 | 5 | v2 has concrete DDL and snippets, but also placeholders: `/* ... full table from ref */` in `ANCHOR_RULES` (`Road_To_AST_Awareness_v2.md` lines 255-275) and comments like `// ... process @scope` (`lines 374-378`). v3 provides literal `QUERIES_LANG_MAP`, literal `ANCHOR_RULES`, exact file paths, exact refactor sites, DDL, and deliverable checklists (`Road_To_AST_Awareness_v3.md` lines 120-218, 519-708, 1911-1948, 2008-2107). |
| 7. Schema migration discipline | 3 | 4 | v2 has a v0→v1 ladder and rollback story (`Road_To_AST_Awareness_v2.md` lines 831-910). v3 adds the interaction with existing try/catch ALTERs (`Road_To_AST_Awareness_v3.md` lines 1442-1512) and includes injections/project_roots in the checklist, though the `project_roots` DDL is described separately rather than fully integrated in the main DDL snippet (`lines 1693-1711, 2036-2050`). |
| 8. Cross-file resolution correctness | 4 | 4 | Both specify unambiguous-name resolution and `ON DELETE SET NULL`. v2 describes batch-only resolve (`Road_To_AST_Awareness_v2.md` lines 736-781). v3 pins trigger and concurrency more explicitly (`Road_To_AST_Awareness_v3.md` lines 1386-1438, 1681-1691), but its dot-qualified fallback can incorrectly link a short name if ambiguous resolution policy is not carefully enforced (`lines 1420-1431`). |
| 9. Engine-duplication avoidance | 3 | 3 | Current TOON has real engines: `SageRank` (`sagerank.ts`), `BMXPlusIndex` (`bmx-plus.ts`), `BudgetAllocator` (`budget.ts`), `Deduplicator` (`dedup.ts`). Both plans avoid reimplementing those. Both correctly remove `Math.sqrt(row.call_count)` from MCP (`v2` lines 1310-1322; `v3` lines 1651-1661), and `SageRank._mergeASTEdges` really consumes `edge.weight` and multiplies it by `astWeight` (`sagerank.ts` lines 873-909). Both lose points because their literal MCP seam still shapes TOON types. |
| 10. Dead-schema discipline | 1 | 3 | v2 explicitly leaves `patterns` and `project_roots` unwired (`Road_To_AST_Awareness_v2.md` lines 1354-1356). v3 wires `patterns` through `insertPattern`/`getPattern` and `refactor_batch reapply` (`Road_To_AST_Awareness_v3.md` lines 1969-1988), and attempts `project_roots` in `getDb` (`lines 1693-1711`), but the project-root design is questionable because current `initGlobalSchema.project_roots` is global while v3 registers it in the project DB. |
| 11. Build/test non-regression | 3 | 3 | Current build passed: `packages/zenith-toon build: Done`, `packages/zenith-mcp build: Done`. Current tests did not pass before either plan: `8 failed | 44 passed`, `21 failed | 947 passed`. Neither plan can claim non-regression without updating tests, especially compression tests that currently expect old `compressTextFile` behavior. |
| 12. Realism of per-language tables | 2 | 4 | v2 says literal maps for 5 core languages plus fallback (`Road_To_AST_Awareness_v2.md` lines 20-24) but uses reference placeholders. v3 provides literal anchor rules for 18 languages (`Road_To_AST_Awareness_v3.md` lines 519-708), explicit C# remap (`lines 224-239`), and queryless fall-through (`lines 1998-2005`). It still uses generic parameter container/modifier sets rather than true per-language parameter maps (`lines 344-355`). |
| 13. Truthfulness against source inventory | 2 | 4 | v2 says C# uses `c_sharp-tags.scm` as 91-line rich vs `csharp-tags.scm` minimal (`Road_To_AST_Awareness_v2.md` lines 140-152), which is true for tags but not modular `definitions.scm`. v3 explicitly calls out that `typescript/injections.scm` is absent and lists the 13 actual injection languages (`Road_To_AST_Awareness_v3.md` lines 37-48). v3 is still internally inconsistent about the compression seam. |
| **Total** | **35** | **51** | v3 wins by 16 points. |

## Disqualification check

No Priority 0 violation is proposed by either plan: neither plan changes TOON marker format, line ordering, or the line-number/verbatim contract directly. Current TOON itself is not fully compliant with the constraint document — for example `packages/zenith-toon/src/string-codec.ts` currently has `_MIN_OMISSION_THRESHOLD = 10` at line 63 while `constraints.md` requires 6, and `_compressSourceStructured` still emits indented `# ... [N lines omitted]` markers at lines 1207 and 1229 — but that is current-code debt, not a v2/v3 plan difference.

Priority 0.5 is where v2 effectively loses. The constraint says TOON constructs `StructureBlock[]` / `Anchor[]` / `ASTEdge[]` / `CompressionContext` and MCP must supply facts only (`constraints.md` lines 52-56), and the forbidden list says to rip out `computeCompressionBudget`, `isCompressionUseful`, `DEFAULT_COMPRESSION_KEEP_RATIO`, `truncateToBudget`, `compressTextFile`, MCP-side `StructureBlock[]`/`CompressionContext`, MCP-side edge weighting, and any MCP bridge that pre-shapes data (`constraints.md` lines 63-71). v2's literal seam still imports `compressString`, `compressSourceStructured`, `StructureBlock`, and `CompressionContext`, then maps `defs` into `StructureBlock[]` and creates `const context: CompressionContext = {}` (`Road_To_AST_Awareness_v2.md` lines 1122-1128, 1153-1164). That is an offending design.

v3 is not clean here either: its prose says it removes MCP shaping (`Road_To_AST_Awareness_v3.md` lines 17-18, 29-30), but its literal `core/compression.ts — GUTTED` snippet still imports `StructureBlock`/`CompressionContext` and constructs both (`Road_To_AST_Awareness_v3.md` lines 1728-1733, 1757-1767). v3's own self-audit admits: `⚠️ compressForTool still constructs minimal StructureBlock[] and CompressionContext` (`Road_To_AST_Awareness_v3.md` lines 2127-2131). I score that as a major seam risk, but not enough to make v2 preferable: v2 contains the same seam violation plus explicit deferrals and dead schemas. The winning plan must execute its seam correction first.

## Per-axis defense

### 1. Fidelity to Priority 0

v2 does not directly modify TOON's output emission. Its `§core/compression.ts — GUTTED` says MCP returns `compressed` untouched except for a length check (`Road_To_AST_Awareness_v2.md` lines 1207-1215), and its `What This Plan Does NOT Do` says it does not touch TOON internals (`lines 1352-1359`). That avoids new Priority 0 harm, but it also does not repair current TOON violations.

v3 similarly states `Priority 0` is not affected because marker emission and assertions live inside TOON (`Road_To_AST_Awareness_v3.md` lines 2110-2122). This is directionally correct for AST indexing, but v3 overclaims: current `string-codec.ts` does not yet enforce the required `_MIN_OMISSION_THRESHOLD = 6`, line-number prefix, or single marker format. Both plans get 4, not 5, because they rely on TOON internals that currently need constraint work.

### 2. Fidelity to Priority 0.5 package ownership

v2 has the right deletion list (`computeCompressionBudget`, `isCompressionUseful`, `DEFAULT_COMPRESSION_KEEP_RATIO`, `truncateToBudget`, `compressTextFile`) in `Road_To_AST_Awareness_v2.md` line 1218 and removes `Math.sqrt` at lines 1310-1322. But its seam still constructs `StructureBlock[]` and `CompressionContext` in MCP (`lines 1153-1200`), which `constraints.md` lines 52-70 forbids.

v3 is better because it has a full deletion checklist (`Road_To_AST_Awareness_v3.md` lines 2099-2107), raw `call_count`, and a stronger statement that TOON owns shaping (`lines 17-18, 29-30). However, the literal code block contradicts that by creating `StructureBlock[]`, `CompressionContext`, anchor mappings, exported symbols, and injection priority boosts in MCP (`lines 1757-1813`). This is the main known risk of executing v3.

### 3. DB-layer invariant

The current DB invariant is verified by source and grep: only `packages/zenith-mcp/src/core/db-adapter.ts` imports `node:sqlite` at line 1. Existing `symbol-index.ts` imports only adapter functions (`symbol-index.ts` lines 9-33), preserving the single SQL boundary.

v2 and v3 both add DDL and adapter functions inside `db-adapter.ts` and keep extractors DB-free. v3 is more comprehensive, including `insertInjection`, `getInjectionsForFile`, `getLocalScopesForSymbol`, `insertPattern`, `getPattern`, and `getSchemaVersion` (`Road_To_AST_Awareness_v3.md` lines 1513-1649, 1969-1988). Both lose one point because some examples use `handle(conn).prepare` for dynamic SQL rather than the requested simple `prepareOrCache` body.

### 4. Maximum AST extraction from shipped grammars

The grammar inventory supports v3. Query directories exist for 36 languages, and every query directory has `locals.scm`; 13 have `injections.scm`: bash, css, dockerfile, hcl, html, javascript, markdown, nix, php, svelte, tsx, vue, xml. `python/locals.scm` captures `@scope`, `@local.parameter`, `@local.definition`, and `@local.reference`; `typescript/definitions.scm` captures functions, arrow functions, classes, interfaces, type aliases, enums, methods, variables, and properties.

v2 lands locals and structures but explicitly defers injections (`Road_To_AST_Awareness_v2.md` lines 1328-1330). v3 lands `extractInjections` (`Road_To_AST_Awareness_v3.md` lines 812-894), `extractLocals` (`lines 898-1025), `InjectionRow` in `ParsedFileRecord` (`lines 1077-1111), and persists them (`lines 1371-1374). That is a decisive coverage advantage.

### 5. No deferrals

v2 fails this axis outright. Its `What This Plan Does NOT Do` lists `Does not add injections extraction (Phase 2)`, `Does not add a patterns table consumer`, and `Does not wire initGlobalSchema / project_roots` (`Road_To_AST_Awareness_v2.md` lines 1352-1357). The user's rubric explicitly forbids deferrals.

v3 states `Fully implementable. No deferrals. No Phase 2.` (`Road_To_AST_Awareness_v3.md` line 5). It includes injections, patterns, project roots, refactor wiring, schema, and consumers in the same deliverables checklist (`lines 2008-2107). That earns the full score.

### 6. Concreteness / implementability

v2 has runnable-looking snippets for `runtime.ts`, `extract.ts`, `persist.ts`, `resolve.ts`, and `db-adapter.ts`, but the extractor details are still incomplete. `anchors.ts` says `/* ... full table from ref */` for most language maps (`Road_To_AST_Awareness_v2.md` lines 255-275), and `locals.ts` leaves `// ... process @scope` (`lines 374-378). Those are implementation gaps.

v3 gives literal TypeScript for `QUERIES_LANG_MAP`, `getCompiledModularQuery`, `capture-tags.ts`, `body.ts`, `structure.ts`, `anchors.ts`, `injections.ts`, `locals.ts`, `extract.ts`, `persist.ts`, `resolve.ts`, adapter functions, and the two refactor TODO replacement sites (`Road_To_AST_Awareness_v3.md` lines 120-218, 246-488, 519-708, 812-1304, 1312-1438, 1513-1649, 1911-1948). It is much more executable.

### 7. Schema migration discipline

v2 introduces `schema_version`, v0→v1, nullable columns, standalone tables, and an additive rollback story (`Road_To_AST_Awareness_v2.md` lines 831-910). It is solid but less explicit about interaction with existing migrations.

v3 includes the same ladder and explicitly says the current `versions` ALTER try/catch blocks remain as pre-v1 bootstrap, while the new ladder starts at v0→v1 for new columns/tables (`Road_To_AST_Awareness_v3.md` lines 1442-1512). That is better migration discipline. The caveat is `project_roots`: v3 says it adds project-roots creation to the v1 migration (`lines 1705-1711), but the main DDL block at lines 1469-1503 does not show it.

### 8. Cross-file resolution correctness

Current `symbol-index.ts` stores only string `referenced_name` edges (`symbol-index.ts` lines 246-271; `db-adapter.ts` lines 442-447). Both plans add nullable `callee_symbol_id` with `ON DELETE SET NULL` and resolve only unambiguous definitions.

v2 gives a clean algorithm and explains batch-only resolution (`Road_To_AST_Awareness_v2.md` lines 736-781). v3 is equally concrete and pins the trigger after `indexDirectory` batches (`Road_To_AST_Awareness_v3.md` lines 1386-1438, 1681-1691). v3's dot-qualified fallback (`Foo.bar` → `bar`) needs caution because it can violate the strict unambiguity rule if not scoped carefully (`lines 1420-1431), so both score 4.

### 9. Engine-duplication avoidance

The TOON engines exist and should not be reimplemented: `SageRank` is in `packages/zenith-toon/src/sagerank.ts`, `BMXPlusIndex` in `bmx-plus.ts`, `BudgetAllocator` in `budget.ts`, and `Deduplicator` in `dedup.ts`. The pipeline imports and uses these engines directly (`pipeline.ts` lines 9-17, 228-247, 282-617).

Both plans avoid fake local SageRank/BMX/budget/dedup. Both correctly recognize that `SageRank._mergeASTEdges` consumes an edge `weight` and multiplies by `astWeight`, with no internal sqrt transform (`sagerank.ts` lines 873-909). Therefore raw `call_count` should cross the seam and TOON should decide any dampening. Both plans lose points because they still let MCP shape structured compression inputs in their literal seam code.

### 10. Dead-schema discipline

Current `db-adapter.ts` already has a `patterns` table in `initSymbolSchema` (`db-adapter.ts` lines 126-132) and `project_roots` only in `initGlobalSchema` (`lines 179-190). `AGENTS.md` says `patterns` is used for reapply pattern support (`AGENTS.md` lines 216-234), but current `refactor_batch.ts` stores successful payloads only in an in-memory `_payloadCache` (`refactor_batch.ts` lines 129-133, 833-840).

v2 explicitly leaves `patterns` and `project_roots` unwired (`Road_To_AST_Awareness_v2.md` lines 1354-1356). v3 wires `patterns` with `insertPattern`/`getPattern` and a `refactor_batch.ts` call site (`Road_To_AST_Awareness_v3.md` lines 1969-1988). v3 also attempts project root registration (`lines 1693-1711), but the implementation target is imperfect because it registers in project `symbols.db`, not a global registry.

### 11. Build/test non-regression

The current build is green: `pnpm -s build` completed with `packages/zenith-toon build: Done` and `packages/zenith-mcp build: Done`. That confirms the baseline compiles before either plan.

The current test suite is not green: `pnpm -s test --run` ended with `8 failed | 44 passed (52)` files and `21 failed | 947 passed (968)` tests. The displayed failures include `tests/tool-compression.test.js` expectations around old line numbering and `compressTextFile` behavior. Therefore neither plan may claim non-regression without updating compression/read-tool tests.

### 12. Realism of per-language tables

v2 says it will provide literal maps for five core languages plus fallback (`Road_To_AST_Awareness_v2.md` lines 20-24), but its `ANCHOR_RULES` block is mostly placeholders and comments (`lines 255-286). That is not enough for the required one-pass implementation.

v3 gives concrete `ANCHOR_RULES` for javascript, typescript, tsx, python, go, rust, java, c, cpp, c_sharp, kotlin, php, ruby, swift, bash, lua, nix, and scss (`Road_To_AST_Awareness_v3.md` lines 519-708). It also provides queryless fall-through for cmake, dart, elixir, ini, make, perl, and r (`lines 1998-2005). It is not perfect: `structure.ts` uses generic `PARAM_CONTAINER_TYPES` rather than true per-language parameter-node maps (`lines 344-355), so it gets 4, not 5.

### 13. Truthfulness against source inventory

The prompt asked to verify C# and injections directly. The filesystem confirms both `tree-sitter-csharp.wasm` and `tree-sitter-c_sharp.wasm` exist. The rich-vs-minimal difference is in root tag files: `c_sharp-tags.scm` has 91 lines and captures constructors/properties/fields/events/delegates/enumerators/references; `csharp-tags.scm` has 19 lines and is minimal. But modular `c_sharp/definitions.scm` and `csharp/definitions.scm` are both 61 lines and identical. Any plan claiming `definitions.scm` is 91 vs 19 is wrong; v3 correctly distinguishes this in `Corrections from Prior Plans` (`Road_To_AST_Awareness_v3.md` lines 37-48).

v3 also correctly says the prompt's implied `typescript/injections.scm` is false: the inventory has `tsx/injections.scm` and `javascript/injections.scm`, but no `typescript/injections.scm`. That correction appears in `Road_To_AST_Awareness_v3.md` lines 47-48 and matches direct reads: attempting to read `typescript/injections.scm` returned `ENOENT`, while `tsx/injections.scm` and `javascript/injections.scm` exist and contain injection captures.

## Direct head-to-head on contested items

### Injections

v2 loses. It says the `injections` table exists but `injections.ts` and `extractInjections` are `deferred to Phase 2` (`Road_To_AST_Awareness_v2.md` lines 1328-1330). That directly violates the no-deferrals requirement.

v3 wins. It claims 13 languages with `injections.scm` (`Road_To_AST_Awareness_v3.md` lines 47-48), and the grammar inventory verifies exactly: bash, css, dockerfile, hcl, html, javascript, markdown, nix, php, svelte, tsx, vue, xml. Direct reads confirm real captures: `javascript/injections.scm` has template literal injections for html/css/graphql/sql; `tsx/injections.scm` adds JSX expressions; `vue`, `svelte`, `html`, `markdown`, `php`, `dockerfile`, and `bash` all have concrete `@injection.content` rules.

### The `compressForTool` seam

v2's seam is literal but forbidden: it imports `StructureBlock` and `CompressionContext`, builds `StructureBlock[]` in MCP, maps DB anchors onto blocks, builds `astEdges`, and calls `compressSourceStructured` (`Road_To_AST_Awareness_v2.md` lines 1122-1200). That violates `constraints.md` lines 52-70.

v3's prose is better but its literal code is still wrong. It says it removes TOON-type construction (`Road_To_AST_Awareness_v3.md` lines 17-18, 29-30), but the replacement code still imports `StructureBlock`/`CompressionContext` and constructs them (`lines 1728-1767). It even boosts block priority for injections in MCP (`lines 1800-1808), which is a compression decision. v3 wins overall despite this because it names the issue and includes the broader ownership deletion checklist; first execution change must fix this seam.

### `Math.sqrt(call_count)` removal

Both plans specify removal. v2 says `weight: Math.sqrt(row.call_count)` becomes `weight: row.call_count` and explains TOON owns dampening (`Road_To_AST_Awareness_v2.md` lines 1310-1322). v3 says the same (`Road_To_AST_Awareness_v3.md` lines 1651-1661, 2099-2107).

The source confirms current MCP applies the transform: `getFileBlockEdges` has `weight: Math.sqrt(row.call_count)` in `packages/zenith-mcp/src/core/db-adapter.ts` line 514. The grep command in the prompt used `sqrt(call_count)`, which returned no hit because the source uses `row.call_count`; direct file read is the authoritative evidence. TOON's `_mergeASTEdges` multiplies `.weight` by `astWeight` and performs no sqrt (`sagerank.ts` lines 873-909), so raw counts are the correct seam fact.

### `patterns` and `project_roots` wiring

v2 explicitly does not wire either (`Road_To_AST_Awareness_v2.md` lines 1354-1356). That is a dead-schema negative.

v3 wires `patterns` concretely through `insertPattern` and `getPattern` (`Road_To_AST_Awareness_v3.md` lines 1969-1988), aligning with current `patterns` table DDL (`db-adapter.ts` lines 126-132) and `refactor_batch.ts`'s current in-memory `_payloadCache` gap (`refactor_batch.ts` lines 129-133, 833-840). v3's `project_roots` wiring is less clean: it calls `upsertProjectRoot` in project DB and adds project-roots DDL to the project schema (`Road_To_AST_Awareness_v3.md` lines 1693-1711), while current source defines `project_roots` in `initGlobalSchema` (`db-adapter.ts` lines 179-190). Still, v3 picks a direction; v2 punts.

### Schema migration ladder

v2 has a migration ladder and rollback story (`Road_To_AST_Awareness_v2.md` lines 831-910). It is workable.

v3 is more concrete because it adds interaction with current unconditional `versions` ALTER migrations (`Road_To_AST_Awareness_v3.md` lines 1509-1512). Current source confirms those existing try/catch migrations at `db-adapter.ts` lines 141-176. v3 wins this item, with the caveat that `project_roots` DDL must be made explicit in the same migration block.

### Per-language `ANCHOR_RULES` / `DEF_TYPES`

v2 gives a `DEF_TYPES` set and an anchor section, but the anchor rules are mostly `/* ... */` placeholders (`Road_To_AST_Awareness_v2.md` lines 121-137, 255-275). It also claims adoption of the reference design rather than providing the full literal map.

v3 gives literal `DEF_TYPES` (`Road_To_AST_Awareness_v3.md` lines 85-116) and literal `ANCHOR_RULES` for 18 languages (`lines 519-708). The source reference `docs/ref-compression-structure.ts` has similar language coverage but lacks `c_sharp` and `scss`; v3 improves the saved reference. v3 wins.

### C# `csharp` vs `c_sharp` mapping

Current `languages.ts` maps `.cs` and `.csx` to `csharp` (`packages/zenith-mcp/src/core/tree-sitter/languages.ts` lines 63-66). The rich tags file is `c_sharp-tags.scm` with 91 lines; the minimal tags file is `csharp-tags.scm` with 19 lines. Both plans propose mapping `.cs`/`.csx` to `c_sharp` (`v2` lines 140-152; `v3` lines 224-239).

v3 is more accurate because it calls out that modular `c_sharp/definitions.scm` and `csharp/definitions.scm` are both 61 lines (`Road_To_AST_Awareness_v3.md` lines 37-38). The rich-vs-minimal distinction is tags, not definitions. v3 wins.

### The two `refactor_batch.ts` `SymbolStructure[]` TODO sites

The source confirms the two dead sites: `const structs: (SymbolStructure | null)[] = []; // TODO` in `loadDiff` (`refactor_batch.ts` lines 471-473) and in `reapply` (`lines 974-975). Current `findModal` and `firstDiffReason` are already implemented (`refactor_batch.ts` lines 166-207), so populating structures will activate existing machinery.

v2 gives a general replacement pattern and says to repeat it for reapply (`Road_To_AST_Awareness_v2.md` lines 1273-1308). v3 gives exact before/after for both sites, including `relPath`/line matching for loadDiff and targets for reapply (`Road_To_AST_Awareness_v3.md` lines 1911-1948). v3 wins.

### Single-parse shared-tree pattern

v2 claims new extractors but actually calls `getSymbols`, `getSymbolStructure`, `getBlockAnchors`, and `extractLocals` separately (`Road_To_AST_Awareness_v2.md` lines 469-624). Current `getSymbols` parses internally (`symbols.ts` lines 102-186), and v2's proposed structure/anchor extractors also parse internally. That violates the intended single-parse efficiency.

v3 explicitly parses once in `extract.ts`, stores `const rootNode = tree.rootNode`, runs the tags query against that root, and passes the root to structure, anchors, injections, and locals (`Road_To_AST_Awareness_v3.md` lines 1120-1304). v3 wins decisively.

## Known risks of the winning plan

1. **The compression seam must be corrected before coding.** v3's literal `compressForTool` still constructs TOON types and boosts priority in MCP. That conflicts with `constraints.md` Priority 0.5. The execution should replace this with a raw-facts call into a TOON-owned API, or add that API in `packages/zenith-toon` first.
2. **TOON's current output constraints are already out of compliance.** `string-codec.ts` currently has `_MIN_OMISSION_THRESHOLD = 10`, indented `# ... [N lines omitted]` markers, and signature suffixes like `# L{n}`. v3 does not repair that; separate TOON constraint work is still needed.
3. **`injections.ts` predicate/property handling may be fragile.** v3 uses `(match as any).setProperties`; web-tree-sitter's actual predicate/property API needs verification before relying on static `#set! injection.language` extraction.
4. **`project_roots` wiring is architecturally muddy.** Current code has `initGlobalSchema` for a global registry, but v3 registers project roots in the project DB. That should be clarified before implementation.
5. **Dynamic SQL in adapter examples should be normalized.** Some v3 functions use `handle(conn).prepare` directly. Keep the invariant by using named adapter functions and `prepareOrCache` where feasible.
6. **Current tests are failing before the plan.** Build is green, but tests are not. Execution must update or repair tests as part of landing the plan.
7. **Per-language structural extraction is still approximate.** v3's anchor table is literal, but parameter/return extraction uses generic node-type sets and may miss language-specific shapes.

## Recommended execution order for v3

1. **Fix the MCP→TOON seam first.** Add or expose a TOON-owned raw-facts API if necessary, then make MCP pass only raw text, language/path/project metadata, symbol rows, edge rows, imports, anchors/injection facts, and budget. Do not construct `StructureBlock[]`, `CompressionContext`, priority boosts, edge weights, or truncation decisions in MCP.
2. **Land the DB migration and adapter functions.** Add `schema_version`, v0→v1 additive schema, injections/local/anchors/imports/structures columns/tables, `callee_symbol_id`, and adapter reads/writes. Keep `node:sqlite` isolated to `db-adapter.ts`.
3. **Land runtime query loading and C# mapping.** Add `QUERIES_LANG_MAP`, `getCompiledModularQuery`, `DEF_TYPES`, and change `.cs`/`.csx` to `c_sharp`. This unlocks all later extractors.
4. **Land the single-parse extractor/persister pipeline.** Implement `extractParsedFile` with one parser/tree, then persist records in one transaction. Include locals, injections, imports, body hashes, structures, anchors, and raw edges.
5. **Wire consumers and tests.** Replace `symbol-index.ts` indexing, add batch edge resolution, populate both `refactor_batch.ts` structure TODO sites, persist/reload `patterns`, resolve `project_roots`, and update read/compression tests against the corrected seam.

v3 wins.
