Priority 0 — Above everything else:

Line numbers must be TRUE to the original file. This is non-negotiable and must be verified mechanically, not assumed. Every shown line N. content means that line exists at position N in the uncompressed source. The output must be in ascending line-number order with no gaps except where a [TRUNCATED: lines X-Y] marker explicitly accounts for the missing range.

After all fixes, add an inline assertion before Phase H emits: walk the final selected set and verify:

 - Every selected index maps to lines[index] from the original split
 - Selected indices are strictly ascending
 - Every gap between consecutive selected indices either has a valid marker (≥6 lines) or the gap lines are also selected

If this assertion can ever fail, the implementation is broken regardless of what the compression quality looks like.

anything from 68-72 percent is acceptable, for the added markers, it doesnt need to be exactly 70 just within that range


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


### 1. `_MIN_OMISSION_THRESHOLD` Must Remain Enforced (currently = 10)

**The rule:** No two truncation markers in the output may be closer than 10 lines from each other. The minimum block of shown content between any two markers must be at least 10 lines.

**What this prevents:** Output like this:
```
[TRUNCATED: lines 1-20]
21. code
22. code
23. code
[TRUNCATED: lines 24-50]
```
That 3-line sliver between two markers is pointless — it's too small to be useful context and it fragments the output.

**What this does NOT mean:** It does NOT have a default resolution. It does NOT mean "always include more lines to reach 10" and it does NOT mean "always drop the small block." The resolution is an intelligent AST-driven decision:
- If those lines are important (high-value anchors, central logic), expand the shown block to meet the 10-line minimum
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
- `_MIN_OMISSION_THRESHOLD` (6) must remain enforced in the reassembly loop — no marker for gaps < 10 lines
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
| Making the threshold configurable per-call | Unnecessary complexity; 10 is the right value |
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
