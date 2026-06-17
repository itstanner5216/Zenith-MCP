## Priority 0 — Line Number Fidelity (NON-NEGOTIABLE)

Line numbers must be TRUE to the original file. This is non-negotiable and must be verified mechanically, not assumed. Every shown line `N. content` means that line exists at position N in the uncompressed source. The output must be in ascending line-number order with no gaps except where a `[TRUNCATED: lines X-Y]` marker explicitly accounts for the missing range.

After all fixes, add an inline assertion before Phase H emits: walk the final selected set and verify:

- Every selected index maps to `lines[index]` from the original split
- Selected indices are strictly ascending
- Every gap between consecutive selected indices either has a valid marker (≥6 lines) or the gap lines are also selected

If this assertion can ever fail, the implementation is broken regardless of what the compression quality looks like.

Anything from 68–72% is acceptable. For the added markers, it does not need to be exactly 70%, just within that range.

This includes truncation markers, anything above 72 percent is not acceptable. 
---

## Priority 0.5 — Package Ownership (NON-NEGOTIABLE)

Every single TOON / compression-related **decision** lives in `packages/zenith-toon`. Period. No exceptions.

### The Seam

The data flow is exactly:

```
caller → zenith-mcp (read tool)
          zenith-mcp → zenith-toon : { rawText, languageInfo, astInfo, symbolInfo, budget/maxChars, ...allowed read-only context }
          zenith-toon → zenith-mcp : compressed text string
zenith-mcp → caller : that exact string, verbatim, as the tool result
```

MCP is allowed — and expected — to hand TOON the AST / symbol / language information it has already computed for other purposes (tree-sitter parses, symbol-index rows, call-graph edges, file/project metadata). TOON should not re-parse what MCP already knows. That hand-off is **data transport**, not intelligence transfer.

What crosses the seam is **facts**: “here is the raw text, here is the language, here are the symbols/defs/refs/edges I already have indexed, here is the project root, here is the budget.”

What does NOT cross the seam is **decisions**: which lines to keep, which symbols matter, how to weight edges, how to allocate budget, what the keep-ratio should be, whether compression was worth it, how to format markers, where to truncate.

### MCP’s Role

MCP is the context provider and the pipe. It may:

- Read the file off disk
- Resolve language / path / project-root / DB-path context
- Reuse its already-computed AST/symbol/edge data (from `getSymbols`, `getFileBlockEdges`, the symbol-index DB, etc.) and hand the **raw results** to TOON as inputs
- Pass the caller’s budget / maxChars through as a number
- Take TOON’s returned string and place it in the tool response, untouched

MCP must not post-process, re-truncate, re-budget, re-wrap, decorate, or otherwise modify TOON’s returned text. Pipe in, pipe out.

### TOON’s Role

TOON owns every compression decision. Given the inputs MCP supplies, TOON:

- Decides which symbols / blocks / lines are structurally important
- Constructs its own `StructureBlock[]` / `Anchor[]` / `ASTEdge[]` / `CompressionContext` from the AST/symbol facts MCP handed in (TOON does the shaping; MCP just supplies the raw symbol rows and edge rows)
- Decides edge weighting (e.g. the `Math.sqrt(call_count)` transform — a SageRank tuning concern, lives in TOON)
- Computes the budget, the keep-ratio, the 70% floor, allocator decisions
- Runs SageRank, BMX+, Deduplicator, BudgetAllocator
- Performs line selection, marker emission, the Phase H assertion, the verbatim/line-number guarantees
- Decides whether compression is useful and falls back to truncation if not
- Returns the final compressed string

### Forbidden in `zenith-mcp` (rip out on sight)

These exist in MCP today and must move to TOON:

- `computeCompressionBudget`, `isCompressionUseful`, `DEFAULT_COMPRESSION_KEEP_RATIO`, `truncateToBudget`, `compressTextFile` — compression decisions, all TOON’s job
- MCP-side construction of `StructureBlock[]` or `CompressionContext` (MCP supplies the raw symbol/edge data; TOON shapes it)
- MCP-side edge weighting for compression purposes (the `Math.sqrt(call_count)` math currently in `getFileBlockEdges` — the **query** can stay; the weighting transform moves to TOON)
- Any helper / wrapper / adapter / “bridge” file in MCP whose purpose is to pre-shape data for TOON. MCP hands over raw facts; TOON does the shaping.
- Any new MCP-side file with “compression” or “toon” in its name

Note: MCP keeping `getSymbols`, `getFileBlockEdges`, `findRepoRoot`, the symbol-index DB, etc. is **fine and expected** — those serve `edit_file`, `refactor_batch`, `directory` listings, search, and the AST-fact hand-off to TOON. What’s forbidden is MCP using them to make compression decisions.

### For Subagents

If you are about to write compression logic — line selection, budget math, ranking, marker emission, keep-ratio decisions, “useful compression” gates, fallback truncation, anchor extraction, structure shaping — inside `packages/zenith-mcp/`, **stop**. You are wrong. Move to `packages/zenith-toon/` and do it there.

If you are about to reimplement SageRank / BMX+ / BudgetAllocator / Deduplicator anywhere — including inside TOON — **stop**. They already exist in `packages/zenith-toon/src/{sagerank,bmx-plus,budget,dedup}.ts`. Delegate to them fully — invoke their complete pipeline as designed, delegate to toon's pre-existing engines, do not import processes from them. Do not cherry-pick pieces of their internals. Do not write a "simpler" version.

MCP’s side of the integration seam should look approximately like:

```ts
// MCP gathers facts it already has
const languageInfo = getLangForFile(path);
const symbolInfo   = await getSymbols(rawText, languageInfo);    // reused from MCP’s existing index
const edgeInfo     = getFileBlockEdges(db, relPath, defNames);   // raw query result, no weighting

// Hand them to TOON — TOON decides everything from here
const compressed = await zenithToon.compressFile({
  rawText, languageInfo, symbolInfo, edgeInfo, budget, projectRoot,
});

return { content: [{ type: ‘text’, text: compressed }] };
```

If MCP’s side of the seam contains keep-ratio math, structure construction, edge weighting, fallback selection, or anything that looks like a decision, something has leaked out of TOON that should not have.

---

## Rule 1 — `_MIN_OMISSION_THRESHOLD` Must Remain Enforced (= 6)

**The rule:** No two truncation markers in the output may be closer than 6 lines from each other. The minimum block of shown content between any two markers must be at least 6 lines.

**What this prevents — Bad, not allowed (3-lines before another truncation occurs):**
```
[TRUNCATED: lines 1-20]
21. code
22. code
23. code
[TRUNCATED: lines 24-50]
```

**Good — must produce at least 6 continuous lines between markers:**
```
[TRUNCATED: lines 03-18]
19. code
20. code
21. code
22.code
23. code
24. code
25.code
26. code
[TRUNCATED: lines 27-50]
```

**Good — good (6 lines of code, meets constraint):**
```
[TRUNCATED: lines 03-13]
14.code
15. code
16. code
17. code
18.code
19. code
20. code
[TRUNCATED: lines 20-56]
```

**Bad — fewer than 6 lines of code between markers, makes result useless:**
```
[TRUNCATED: lines 03-13]
14.code
15. code
16. code
[TRUNCATED: lines 17-21]
22.code
23. code
24. code
[TRUNCATED: lines 25-50]
```

**Resolution is AST-driven, not mechanical:** This rule does NOT have a default resolution. The selection intelligence decides:
- If the short block contains important lines (high-value anchors, central logic) → expand the shown block to meet the 6-line minimum
- If the short block contains unimportant lines → merge them into the surrounding truncation (drop them)

There is no mechanical default. The selection intelligence decides which resolution is correct based on what those lines actually contain.

**Critical:** This constraint does NOT permit rearranging, altering, or synthesizing code. The output is still verbatim lines from the file at their real line numbers. You are choosing which contiguous blocks to SHOW and which to DROP — never moving, editing, or reordering lines.

---

## Rule 2 — Output Lines Must Be Verbatim (Character-Perfect Copies)

Every line in the compressed output that is NOT an omission marker MUST be the original line prefixed ONLY with its line number (`N. `). The content after the prefix must be a character-for-character copy of the corresponding line in the original file. Do not:

- Paraphrase or summarize code
- Remove or add whitespace (beyond the `N. ` prefix)
- Reformat or restructure lines
- Create “smart” condensed representations
- Generate synthetic JSON summaries like `{ items: 47, showing: [0,1,2] }`
- Append annotations, suffixes, or metadata to lines

**Why:** The compressed output is consumed by a model that may need to edit the file. The model must be able to reference any visible line by its exact content and know that content exists verbatim in the real file, true down to the line numbers aligning. If you alter even one character, edits targeting that line will fail.

---

## Rule 3 — Omission Markers Must Be Present and Must Report Line Ranges

When lines ARE omitted (and the count >= `_MIN_OMISSION_THRESHOLD`), the output MUST contain a marker that tells the reader exactly which lines are missing. The marker format is exactly:

```
[TRUNCATED: lines X-Y]
```

This is the single unified marker format for everything TOON touches. Do NOT use `# ... [N lines omitted]`, count-only formats, or indented variants.

**Why:** Without markers, the model sees what looks like a continuous file and has no idea content is missing. It may attempt edits that span a gap, producing corrupted results. The marker is the model’s only signal that there’s a discontinuity. Additionally these markers must be easy and consistent for the model utilizing the tool to identify. Do not implement any other form of a truncation marker.

---

## Rule 4 — No “Smart” Per-Item JSON/Array Compression

Do not implement item-level compression for JSON arrays (e.g., “showing items 0, 24, 47 of 50”). JSON files are edited by line number, same as every other file type. The line-based compression model applies uniformly to all content types when operating in the structured-source path.

---

## Rule 5 — Output Must Include Original Line Numbers

Every output line must be prefixed with its original 1-based line number in the standard format used by file-reading tools:

```
1. import path from ‘path’;
2. import { normalizeLineEndings } from ‘../core/lib.js’;
...
52. }
[TRUNCATED: lines 53-132]
133. function mapTrimmedIndex(original: string, trimmed: string, trimmedIdx: number): number {
134.   const originalChars = [...original];
```

The line number prefix (`N. `) tells the model exactly which line it’s looking at in the real file. Combined with `[TRUNCATED: lines X-Y]` markers, there is zero ambiguity about file position. This is the same numbering format every file-reading tool uses — the compression output must match it exactly.

---

## Rule 6 — NO Non-Null Assertions

Do not use TypeScript non-null assertions (`!`). They suppress the type checker and hide real nullability issues. If a value might be `null` or `undefined`, handle it explicitly: use a proper type guard. Non-null assertions are never acceptable as a shortcut.

---

## Rule 7 — Tool Call Sandboxing Must Be Explicitly Opted In

Tool call sandboxing or blocking of tool usage must only be active if explicitly enabled in Zenith’s configuration. The default behavior must never block a tool call. Blocking is opt-in, not opt-out.

---

## Rule 8 — API Key Validation Belongs Only in HTTP Streamable Endpoints

API key / bearer token validation must only exist in the HTTP streamable transport. SSE and stdio transports are local — they must remain key-free. Do not add authentication checks to SSE or stdio endpoints.

---

## Rule 9 — All Schemas Must Be Strict

Every Zod schema (and any other validation schema) must be strict. No passthrough, no partial, no loose validation. Unknown fields must be rejected, not silently dropped or forwarded. If a schema needs to evolve, update it explicitly — do not loosen it as a workaround.

---

## Rule 10 — Line Numbering in Output Is Always Mandatory

Line numbers must always be present in TOON output and in all tool output that returns file content. There must never be a parameter, flag, option, or config knob that disables or removes line numbering. Line numbers are not a display preference — they are structural metadata the model depends on for edits. Making them optional would silently break edit reliability.

---

## Rule 11 — No Helpers, No Wrappers — Inline Corrections Only

Do NOT create helper functions, wrapper functions, or utility abstractions to “clean up” or “centralize” marker logic, output formatting, or any existing inline behavior. If a marker is being emitted incorrectly, fix the literal line where the marker string is constructed. If line selection logic is wrong, fix it where it lives.

**Why:** Every time a model creates a `formatOmissionMarker()` helper or an `emitLines()` wrapper, it introduces a layer of indirection that:
- Makes it trivial to accidentally change output format in one place and break all call sites
- Obscures the actual control flow (you can’t see what’s emitted by reading the loop)
- Invites future models to “improve” the helper and silently break invariants

The existing code is intentionally inline. Keep it that way. If you need to change how a marker is formatted, change the template string literal at the point of emission. If you need to change how lines are selected, change the loop/condition that selects them. No abstractions, no indirection, no “minimal” wrappers.

---

## Rule 12 — TOON Must Never Deny a Compression Request

Both the structured (AST-aware) path and the unstructured (text-based) path must always produce compressed output. TOON must never return without having compressed through at least one path. Unsupported languages are a mandatory fallback to the unstructured path — not a refusal. The unstructured path is independently capable of intelligent compression at ~70% retention with no language or AST data at all. It is the universal fallback and must never be removed or degraded. If either path can fail to produce output, the implementation is broken — stop and fix it immediately.

---

## Rule 13 — Always Choose the Most Robust Solution

When two valid approaches exist for the same problem, always implement the most robust, highest-quality one. Never the "minimal safe option" or the simpler-but-weaker alternative. Ask: which approach is more correct, more resilient to edge cases, and better for the codebase long-term? That is always the answer.

---

## Rule 14 — Never Defer a Real Bug or Correctness Issue

When something is identified as broken, it gets fixed. Not deferred, not noted, not ticketed and silently forgotten. There is no such thing as "out of scope" — agents must think in terms of what improves the MCP as a whole, not in terms of PR boundaries. If something is broken, it is always in scope.

---

## Rule 15 — `facts.path` Across the MCP→TOON Seam Must Be Repo-Relative

The `facts.path` field passed to TOON must be a repo-relative path, not an absolute path. Passing an absolute path is a bug. Convert before crossing the seam.

---

## Rule 16 — These Documents Outrank Bot Review Findings

When a code review bot's finding contradicts a documented constraint or goal, these documents win. Bot findings are advisory. No agent should act on a bot suggestion that conflicts with the documented rules here — the correct answer always comes from these files and from the user directly.

---

## Rule 17 — Use the Real Engines — Delegate Fully

Do not make a fake baby version of something that already exists.

The repo already has the smart thing. Delegate to it fully — invoke its complete pipeline as designed. Do not cherry-pick pieces of its internals. Do not write a "simpler" version:

- SageRank: `packages/zenith-toon/src/sagerank.ts`
- BMX+: `packages/zenith-toon/src/bmx-plus.ts`
- Budget allocation: `packages/zenith-toon/src/budget.ts`
- Deduplication: `packages/zenith-toon/src/dedup.ts`
- Routing/config: `packages/zenith-toon/src/router.ts`, `packages/zenith-toon/src/config.ts`
- Pipeline/string codec: `packages/zenith-toon/src/pipeline.ts`, `packages/zenith-toon/src/string-codec.ts`

SageRank is not PageRank. Do not replace it with generic centrality scoring or a simplified graph-ranker. Read and integrate the actual implementation.

---

## Rule 18 — Forbidden Designs

Do not propose or implement:

- Fake local SageRank, BMX/BM25, graph ranking, budget allocators, or dedupers
- One giant pipeline file that recreates existing engines
- MCP-side compression intelligence or tree-sitter-to-TOON adapters
- CLI bridge scripts as the main architecture
- Summarization or synthetic output
- Anything that makes the model distrust what line number it is looking at

---

## Constraints on the Implementation

- Do not change the function signature: `(text, budget, structure, astEdges?) → string`
- Do not change the public API (`compressSourceStructured` export)
- `_MIN_OMISSION_THRESHOLD` (6) must remain enforced in the reassembly loop — no marker for gaps < 6 lines
- Every non-marker output line must be a character-perfect copy of the input
- Still works correctly when `astEdges` is undefined/empty (fallback = no connectivity boost, same behavior as today minus fixes 1-4/6)
- The 70% budget floor (`Math.max(budget, Math.floor(text.length * 0.70))`) is intentional and must NOT be changed
- All changes are inline in `_compressSourceStructured()` — no new helper functions, no new files

---

## ANTI-PATTERNS TO EXPLICITLY AVOID

| Anti-pattern | Why it fails |
|---|---|
| Setting `_MIN_OMISSION_THRESHOLD = 1` or removing the check | Creates useless single-line markers that cost more than showing the line |
| Generating “summary” lines like `// 3 helper functions omitted` | Not verbatim — model can’t use these for edits |
| Per-JSON-item markers like `{ showing: [0,1,2], total: 50 }` | JSON is line-edited, not item-edited |
| Stripping comments to “save space” | Comments are verbatim file content; stripping them means output doesn’t map to real file |
| Reordering output lines to group by importance | Breaks line-number correspondence |
| Adding new marker formats without the line range info | Model loses track of what’s missing |
| Making the threshold configurable per-call | Unnecessary complexity; 6 is the right value |
| Removing blank lines between blocks to “save budget” | Breaks line-number mapping |
| Creating helper/wrapper functions like `formatMarker()` or `emitLine()` | Adds indirection that obscures control flow and invites future silent breakage — fix logic inline where it lives |
| “Centralizing” marker emission into a single utility | Same problem; the code is inline by design, keep it inline |
| Skipping signature allocation “to save body budget” | 80 chars per signature is negligible vs body lines; invisible functions are catastrophic for comprehension |
| Emitting signatures with `# L{n}` annotations instead of proper line number prefixes | The `# L{n}` suffix is a hack; use standard `N. ` prefix on every line like file-reading tools do |
| Using `# ... [N lines omitted]` format (count-only) | Doesn’t tell the model WHICH lines are missing; use `[TRUNCATED: lines X-Y]` |
| Adding indentation/prefix to truncation markers | Markers must be flush-left so they’re visually unambiguous as metadata, not code |
| Filling partial blocks top-down ignoring anchors | Wastes budget on variable declarations instead of showing returns/control flow |
| Adding signatures AFTER/BEYOND the budget as a “second pass” | Defeats the entire purpose of compression; everything must fit WITHIN the 70% budget, signatures included |
| Using TypeScript non-null assertions (`!`) | Suppresses the type checker and hides real nullability issues; handle nullability explicitly |
| Enabling tool call sandboxing/blocking without explicit config opt-in | Default behavior must never block a tool call; blocking is opt-in |
| Using loose/passthrough schemas | Unknown fields must be rejected; schemas must be strict |
| Adding a `showLineNumbers` / `lineNumbers` opt-out param | Line numbers are mandatory structural metadata, not a display option — never make them optional |

---
