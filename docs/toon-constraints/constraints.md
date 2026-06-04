Priority 0 — Above everything else:

Line numbers must be TRUE to the original file. This is non-negotiable and must be verified mechanically, not assumed. Every shown line N. content means that line exists at position N in the uncompressed source. The output must be in ascending line-number order with no gaps except where a [TRUNCATED: lines X-Y] marker explicitly accounts for the missing range.

After all fixes, add an inline assertion before Phase H emits: walk the final selected set and verify:

 - Every selected index maps to lines[index] from the original split
 - Selected indices are strictly ascending
 - Every gap between consecutive selected indices either has a valid marker (≥6 lines) or the gap lines are also selected

If this assertion can ever fail, the implementation is broken regardless of what the compression quality looks like.

anything from 68-72 percent is acceptable, for the added markers, it doesnt need to be exactly 70 just within that range

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

What crosses the seam is **facts**: "here is the raw text, here is the language, here are the symbols/defs/refs/edges I already have indexed, here is the project root, here is the budget."

What does NOT cross the seam is **decisions**: which lines to keep, which symbols matter, how to weight edges, how to allocate budget, what the keep-ratio should be, whether compression was worth it, how to format markers, where to truncate.

### MCP's Role

MCP is the context provider and the pipe. It may:

- Read the file off disk
- Resolve language / path / project-root / DB-path context
- Reuse its already-computed AST/symbol/edge data (from `getSymbols`, `getFileBlockEdges`, the symbol-index DB, etc.) and hand the **raw results** to TOON as inputs
- Pass the caller's budget / maxChars through as a number
- Take TOON's returned string and place it in the tool response, untouched

MCP must not post-process, re-truncate, re-budget, re-wrap, decorate, or otherwise modify TOON's returned text. Pipe in, pipe out.

### TOON's Role

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

- `computeCompressionBudget`, `isCompressionUseful`, `DEFAULT_COMPRESSION_KEEP_RATIO`, `truncateToBudget`, `compressTextFile` — compression decisions, all TOON's job
- MCP-side construction of `StructureBlock[]` or `CompressionContext` (MCP supplies the raw symbol/edge data; TOON shapes it)
- MCP-side edge weighting for compression purposes (the `Math.sqrt(call_count)` math currently in `getFileBlockEdges` — the **query** can stay; the weighting transform moves to TOON)
- Any helper / wrapper / adapter / "bridge" file in MCP whose purpose is to pre-shape data for TOON. MCP hands over raw facts; TOON does the shaping.
- Any new MCP-side file with "compression" or "toon" in its name

Note: MCP keeping `getSymbols`, `getFileBlockEdges`, `findRepoRoot`, the symbol-index DB, etc. is **fine and expected** — those serve `edit_file`, `refactor_batch`, `directory` listings, search, and the AST-fact hand-off to TOON. What's forbidden is MCP using them to make compression decisions.

### For Subagents

If you are about to write compression logic — line selection, budget math, ranking, marker emission, keep-ratio decisions, "useful compression" gates, fallback truncation, anchor extraction, structure shaping — inside `packages/zenith-mcp/`, **stop**. You are wrong. Move to `packages/zenith-toon/` and do it there.

If you are about to reimplement SageRank / BMX+ / BudgetAllocator / Deduplicator anywhere — including inside TOON — **stop**. They already exist in `packages/zenith-toon/src/{sagerank,bmx-plus,budget,dedup}.ts`. Import them. Do not write a "simpler" version.

MCP's side of the integration seam should look approximately like:

```ts
// MCP gathers facts it already has
const languageInfo = getLangForFile(path);
const symbolInfo   = await getSymbols(rawText, languageInfo);    // reused from MCP's existing index
const edgeInfo     = getFileBlockEdges(db, relPath, defNames);   // raw query result, no weighting

// Hand them to TOON — TOON decides everything from here
const compressed = await zenithToon.compressFile({
  rawText, languageInfo, symbolInfo, edgeInfo, budget, projectRoot,
});

return { content: [{ type: 'text', text: compressed }] };
```

If MCP's side of the seam contains keep-ratio math, structure construction, edge weighting, fallback selection, or anything that looks like a decision, something has leaked out of TOON that shouldn't have.

---

---


I dont know what youre talking about but youre making up shit i never said and making this so complicated and it is literally simple. Ready? 

This? Bad, not allowed:
[TRUNCATED: lines 1-20]
21. code
22. code
23. code
[TRUNCATED: lines 24-50]

Good. Must produce at least: 
[TRUNCATED: lines 03-13]
14.code
15. code
16. code
17. code
18.code
19. code
20. code
21. code
22.code
23. code
24. code
[TRUNCATED: lines 25-50]


This Example. Good. Why? The code block is greater than 10 lines of code. Meets constraint length, good:
[TRUNCATED: lines 03-13]
14.code
15. code
16. code
17. code
18.code
19. code
20. code
21. code
22.code
23. code
24. code
25. code
26. code
27. code.
28. code.
29. code
[TRUNCATED: lines 29-56]

Bad, why? Less than 10 lines of code, makes result useless, bad, not allowed: 
[TRUNCATED: lines 03-13]
14.code
15. code
16. code
[TRUNCATED: lines 17-21]
22.code
23. code
24. code
[TRUNCATED: lines 25-50]


### 1. `_MIN_OMISSION_THRESHOLD` Must Remain Enforced (currently = 6)

**The rule:** No two truncation markers in the output may be closer than 6 lines from each other. The minimum block of shown content between any two markers must be at least 6 lines. (Earlier drafts of this doc said 10; 10 turned out to be essentially impossible to satisfy alongside the 68–72% keep-ratio. The correct, enforced value is **6**.)

**What this prevents:** Output like this:
```
[TRUNCATED: lines 1-20]
21. code
22. code
23. code
[TRUNCATED: lines 24-50]
```
That 3-line sliver between two markers is pointless — it's too small to be useful context and it fragments the output.

**What this does NOT mean:** It does NOT have a default resolution. It does NOT mean "always include more lines to reach 6" and it does NOT mean "always drop the small block." The resolution is an intelligent AST-driven decision:
- If those lines are important (high-value anchors, central logic), expand the shown block to meet the 6-line minimum
- If those lines are unimportant, merge them into the surrounding truncation (drop them)

There is no mechanical default. The selection intelligence decides which resolution is correct based on what those lines actually contain.

**Critical:** This constraint does NOT permit rearranging, altering, or synthesizing code. The output is still verbatim lines from the file at their real line numbers. You are choosing which contiguous blocks to SHOW and which to DROP — never moving, editing, or reordering lines.    this is the constraint, not to include by default

### 2. Output Lines Must Be Verbatim (Character-Perfect Copies of Input Lines)

Every line in the compressed output that is NOT an omission marker MUST be a character-for-character copy of the corresponding line in the original file. Do not:
- Paraphrase or summarize code
- Remove or add whitespace
- Reformat or restructure lines
- Create "smart" condensed representations
- Generate synthetic JSON summaries like `{ items: 47, showing: [0,1,2] }`

**Why:** The compressed output is consumed by a model that may need to edit the file. The model must be able to reference any visible line by its exact content and know that content exists verbatim in the real file, true down to the line numbers aligning. If you alter even one character, edits targeting that line will fail.

### 3. Omission Markers Must Be Present and Must Report Line Ranges

When lines ARE omitted (and the count >= `_MIN_OMISSION_THRESHOLD`), the output MUST contain a marker that tells the reader exactly which lines are missing. The existing marker format is:
BUT what it must be when you are finished is a single marker used for everything zoon touches, that looks exactly like this: 

```
[TRUNCATED: lines X-Y]
```

**Why:** Without markers, the model sees what looks like a continuous file and has no idea content is missing. It may attempt edits that span a gap, producing corrupted results. The marker is the model's only signal that there's a discontinuity.

### 4. No "Smart" Per-Item JSON/Array Compression

Do not implement item-level compression for JSON arrays (e.g., "showing items 0, 24, 47 of 50"). JSON files are edited by line number, same as every other file type. The line-based compression model applies uniformly to all content types when operating in the structured-source path.

### 5. Output Must Map to Original Line Numbers

The signature annotation (`# L{n}`) and omission markers together must give the model enough information to reconstruct which original file lines correspond to which output lines. Do not break this mapping.

### 6. No Helpers, No Wrappers — Inline Corrections Only

Do NOT create helper functions, wrapper functions, or utility abstractions to "clean up" or "centralize" marker logic, output formatting, or any existing inline behavior. If a marker is being emitted incorrectly, fix the literal line where the marker string is constructed. If line selection logic is wrong, fix it where it lives.

**Why:** Every time a model creates a `formatOmissionMarker()` helper or an `emitLines()` wrapper, it introduces a layer of indirection that:
- Makes it trivial to accidentally change output format in one place and break all call sites
- Obscures the actual control flow (you can't see what's emitted by reading the loop)
- Invites future models to "improve" the helper and silently break invariants

The existing code is intentionally inline. Keep it that way. If you need to change how a marker is formatted, change the template string literal at the point of emission. If you need to change how lines are selected, change the loop/condition that selects them. No abstractions, no indirection, no "minimal" wrappers.

---

### 2. Output Lines Must Be Verbatim (Character-Perfect Copies of Input Lines)

Every line in the compressed output that is NOT an omission marker MUST be the original line prefixed ONLY with its line number (`N. `). The content after the prefix must be a character-for-character copy of the corresponding line in the original file. Do not:
- Paraphrase or summarize code
- Remove or add whitespace (beyond the `N. ` prefix)
- Reformat or restructure lines
- Create "smart" condensed representations
- Generate synthetic JSON summaries like `{ items: 47, showing: [0,1,2] }`
- Append annotations, suffixes, or metadata to lines

**Why:** The compressed output is consumed by a model that may need to edit the file. The model must be able to reference any visible line by its exact content and know that content exists verbatim in the real file, true down to the line numbers aligning. If you alter even one character, edits targeting that line will fail.

### 3. Omission Markers Must Be Present and Must Report Line Ranges

When lines ARE omitted (and the count >= `_MIN_OMISSION_THRESHOLD`), the output MUST contain a marker that tells the reader exactly which lines are missing. The existing marker format is:

```
    # ... [N lines omitted]
```

or for the unstructured path:

```
    [TRUNCATED: lines X-Y]
```

BUT what it must be when you are finished is a single marker used for everything zoon touches, that looks exactly like this: 

```
[TRUNCATED: lines X-Y]
```

**Why:** Without markers, the model sees what looks like a continuous file and has no idea content is missing. It may attempt edits that span a gap, producing corrupted results. The marker is the model's only signal that there's a discontinuity.

### 4. No "Smart" Per-Item JSON/Array Compression

Do not implement item-level compression for JSON arrays (e.g., "showing items 0, 24, 47 of 50"). JSON files are edited by line number, same as every other file type. The line-based compression model applies uniformly to all content types when operating in the structured-source path.

### 5. Output Must Include Original Line Numbers

Every output line must be prefixed with its original 1-based line number in the standard format used by file-reading tools:

```
1. import path from 'path';
2. import { normalizeLineEndings } from '../core/lib.js';
...
52. }
[TRUNCATED: lines 53-132]
133. function mapTrimmedIndex(original: string, trimmed: string, trimmedIdx: number): number {
134.   const originalChars = [...original];
```

The line number prefix (`N. `) tells the model exactly which line it's looking at in the real file. Combined with `[TRUNCATED: lines X-Y]` markers, there is zero ambiguity about file position. This is the same numbering format every file-reading tool uses — the compression output must match it exactly.

### 6. No Helpers, No Wrappers — Inline Corrections Only

Do NOT create helper functions, wrapper functions, or utility abstractions to "clean up" or "centralize" marker logic, output formatting, or any existing inline behavior. If a marker is being emitted incorrectly, fix the literal line where the marker string is constructed. If line selection logic is wrong, fix it where it lives.

**Why:** Every time a model creates a `formatOmissionMarker()` helper or an `emitLines()` wrapper, it introduces a layer of indirection that:
- Makes it trivial to accidentally change output format in one place and break all call sites
- Obscures the actual control flow (you can't see what's emitted by reading the loop)
- Invites future models to "improve" the helper and silently break invariants

The existing code is intentionally inline. Keep it that way. If you need to change how a marker is formatted, change the template string literal at the point of emission. If you need to change how lines are selected, change the loop/condition that selects them. No abstractions, no indirection, no "minimal" wrappers.

### Constraints on the Implementation

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
| Generating "summary" lines like `// 3 helper functions omitted` | Not verbatim — model can't use these for edits |
| Per-JSON-item markers like `{ showing: [0,1,2], total: 50 }` | JSON is line-edited, not item-edited |
| Stripping comments to "save space" | Comments are verbatim file content; stripping them means output doesn't map to real file |
| Reordering output lines to group by importance | Breaks line-number correspondence |
| Adding new marker formats without the line range info | Model loses track of what's missing |
| Making the threshold configurable per-call | Unnecessary complexity; 6 is the right value |
| Removing blank lines between blocks to "save budget" | Breaks line-number mapping |
| Creating helper/wrapper functions like `formatMarker()` or `emitLine()` | Adds indirection that obscures control flow and invites future silent breakage — fix logic inline where it lives |
| "Centralizing" marker emission into a single utility | Same problem; the code is inline by design, keep it inline |
| Skipping signature allocation "to save body budget" | 80 chars per signature is negligible vs body lines; invisible functions are catastrophic for comprehension |
| Emitting signatures with `# L{n}` annotations instead of proper line number prefixes | The `# L{n}` suffix is a hack; use standard `N. ` prefix on every line like file-reading tools do |
| Using `# ... [N lines omitted]` format (count-only) | Doesn't tell the model WHICH lines are missing; use `[TRUNCATED: lines X-Y]` |
| Adding indentation/prefix to truncation markers | Markers must be flush-left so they're visually unambiguous as metadata, not code |
| Filling partial blocks top-down ignoring anchors | Wastes budget on variable declarations instead of showing returns/control flow |
| Adding signatures AFTER/BEYOND the budget as a "second pass" | Defeats the entire purpose of compression; everything must fit WITHIN the 70% budget, signatures included |

---
