# TOON CONSTRAINTS & GOALS — REPO-WIDE CONTRACT

*this is the literal source of truth*

## TOON CONSTRAINTS

- These are the requirements. Finding a violation of this document in the code-base does not mean it is acceptable; it means you should stop and correct the deviation in the most robust and beneficial-to-the-entire-MCP way you can, always prioritizing robustness, correctness, and optimal MCP performance.

### Priority 0 — Line Number Fidelity (NON-NEGOTIABLE)

Line numbers must be TRUE to the original file. This is non-negotiable and must be verified mechanically, not assumed. Every shown line `N. content` means that line exists at position N in the uncompressed source. The output must be in ascending line-number order with no gaps except where a `[TRUNCATED: lines X-Y]` marker explicitly accounts for the missing range.

This is enforced mechanically by `verifyOutput` (H1–H7 in `removal.ts`), which runs over the FINAL compressed string before it is returned and re-derives everything from the output text. In particular it verifies:

- Every shown line is a character-perfect copy of the original line at that exact number (the H2 verbatim keystone)
- Shown line numbers are strictly ascending
- Every gap between consecutive shown ranges is either accounted for by a valid `[TRUNCATED: lines X-Y]` marker (≥6 lines) or the gap lines are themselves shown

If `verifyOutput` can ever pass on output where this is false, the implementation is broken regardless of what the compression quality looks like. (See "The Throw / Null / Verify Contract" below for how a failed verification degrades safely to raw.)

Retention: anything from 68–72% is acceptable. The rendered output — kept lines plus truncation-marker characters — must land in that band. It does not need to be exactly 70%. **Anything above 72% is not acceptable.** The band is enforced exactly by the selection DP (`selectDropsToBand`); it is not a post-hoc check.

---

### Priority 0.4 — The Throw / Null / Verify Contract (NON-NEGOTIABLE)

This section exists because it is the single most-misread part of the codebase. The behavior below is **correct and intentional** — do not "fix" it, and do not flag it as a violation.

**`compressFile` returns `string | null`.** This is its real, declared signature (`index.ts`). Returning `null` is a first-class, correct outcome — it means "compression was not useful or could not be produced safely; the caller must use the raw file." A null return is **never** a bug on its own. The MCP boundary treats null as "serve raw, verbatim."

**The gate throws on internal inconsistency — on purpose.** `selectDropsToBand`, the marker accounting, the separability self-check, and the post-quantization true-band recompute all THROW the moment anything is inconsistent (reconstruction failure, a marker that stops being separable, a selection that is not truly in-band, length mismatches, etc.). These throws are the *mechanism* of the safety guarantee, not a failure of it. A throw inside the engine is the engine refusing to ship a cut it cannot prove correct.

**`compressFile` is the containment boundary.** Every such throw is caught at `compressFile` (`index.ts`) and converted to `null` → the caller serves raw. So:

- Throwing **internally** = correct. It is how TOON guarantees it never ships an unverified or inconsistent cut.
- Throwing **out to the caller** (escaping `compressFile`) = forbidden. The public boundary must always resolve to `string | null`, never propagate an exception.
- Shipping a cut that has not passed `verifyOutput` = forbidden.
- Returning `null` because compression wasn't useful, the band was unreachable, or verification failed = correct (the file is served raw).

When you see engine code that throws, or `compressFile` returning null, **that is the design working.** Do not add try/catch swallowing inside the engines to "stop the throws," do not make `compressFile` return a non-null fallback string when the real outcome is "use raw," and do not introduce a second, dumber selection algorithm as a "never-fail" fallback. One selection engine; it throws when it must; the boundary degrades to raw.

---

### Priority 0.5 — Package Ownership (NON-NEGOTIABLE)

Every single TOON / compression-related **decision** lives in `packages/zenith-toon`. Period. No exceptions.

#### The Seam

The data flow is exactly:

```
caller → zenith-mcp (read tool)
          zenith-mcp → zenith-toon : { rawText, languageInfo, astInfo/facts, symbolInfo, edges/refs, budget/maxChars, projectRoot, ...allowed read-only context }
          zenith-toon → zenith-mcp : compressed text string  (or null → "use raw")
zenith-mcp → caller : that exact string (or the raw file), verbatim, as the tool result
```

MCP is allowed — and expected — to hand TOON the AST / symbol / language / edge / reference facts it has already computed for other purposes (tree-sitter parses, symbol-index rows, call-graph edges, file/project metadata). TOON should not re-parse what MCP already knows. That hand-off is **data transport**, not intelligence transfer.

What crosses the seam is **facts**: "here is the raw text, here is the language, here are the symbols/defs/refs/edges I already have indexed, here is the project root, here is the budget."

What does NOT cross the seam is **decisions**: which lines to keep, which symbols matter, how to weight edges, how to allocate budget, what the keep-ratio should be, whether compression was worth it (the usefulness/null decision is TOON's), how to format markers, where to truncate.

The MCP-side seam adapter is `compressFile` in `index.ts`; the refactor's native entry is `compressSource`. MCP imports `compressFile`, passes facts, and takes back `string | null`.

#### MCP's Role

MCP is the context provider and the pipe. It may:

- Read the file off disk
- Resolve language / path / project-root / DB-path context
- Reuse its already-computed AST/symbol/edge/reference data and hand the **raw results** to TOON as inputs
- Pass the caller's budget / maxChars through as a number
- Take TOON's returned string and place it in the tool response, untouched — or, if TOON returns `null`, serve the raw file

MCP must not post-process, re-truncate, re-budget, re-wrap, decorate, or otherwise modify TOON's returned text. Pipe in, pipe out.

#### TOON's Role

TOON owns every compression decision. Given the inputs MCP supplies, TOON:

- Decides which symbols / blocks / lines are structurally important
- Constructs its own block/anchor/edge/fact shapes from the raw symbol/edge/reference rows MCP handed in (TOON does the shaping; MCP just supplies the raw rows)
- Decides edge weighting (a SageRank tuning concern; lives in TOON)
- Computes the budget, the retention band, allocator decisions
- Runs SageRank and BMX+, then the value-blind removal gate and selection DP
- Performs line selection, marker emission, and the `verifyOutput` (H1–H7) guarantee
- Decides whether compression is useful and returns `null` (→ caller uses raw) when it is not
- Returns the final compressed string, or `null`

#### Forbidden in `zenith-mcp` (rip out on sight)

- Any compression decision: keep-ratio math, "is compression useful" gates, budget computation, fallback/truncation selection, structure/anchor construction, edge weighting for compression
- MCP-side construction of compression block/context shapes (MCP supplies raw symbol/edge/reference rows; TOON shapes them)
- Any helper / wrapper / adapter / "bridge" file in MCP whose purpose is to pre-shape data for TOON
- Any new MCP-side file with "compression" or "toon" in its name

Note: MCP keeping `getSymbols`, the block/edge queries, repo-root resolution, the symbol-index DB, etc. is **fine and expected** — those serve `edit_file`, `refactor_batch`, `directory`, search, and the fact hand-off to TOON. What's forbidden is MCP using them to make compression *decisions*.

#### For Subagents

If you are about to write compression logic — line selection, budget math, ranking, marker emission, keep-ratio decisions, "useful compression" gates, fallback selection, anchor extraction, structure shaping — inside `packages/zenith-mcp/`, **stop.** Move it to `packages/zenith-toon/`.

If you are about to reimplement SageRank / BMX+ / the budget logic / the removal gate anywhere — including inside TOON — **stop.** They already exist in `packages/zenith-toon/src/{sagerank,bmx-plus,budget,removal}.ts`. Invoke the existing pipeline as designed; do not cherry-pick their internals and do not write a "simpler" version.

MCP's side of the integration seam should look approximately like:

```ts
// MCP gathers facts it already has
const languageInfo = getLangForFile(path);
const symbolInfo   = await getSymbols(rawText, languageInfo);   // reused from MCP's existing index
const edgeInfo     = getFileBlockEdges(db, relPath, defNames);  // raw query result, no weighting

// Hand them to TOON — TOON decides everything from here
const compressed = zenithToon.compressFile({
  source: { rawText, languageInfo, facts: { symbolInfo, edgeInfo, /* defs, refs, ... */ }, budget, projectRoot },
});

// compressed is `string | null`. null means "use raw."
return { content: [{ type: 'text', text: compressed ?? rawText }] };
```

If MCP's side of the seam contains keep-ratio math, structure construction, edge weighting, fallback selection, or anything that looks like a decision, something has leaked out of TOON that should not have.

---

### Rule 1 — The 6-Line Minimum Must Remain Enforced (= 6)

**The rule:** No two truncation markers in the output may be closer than 6 lines apart. The minimum block of shown content between any two markers must be at least 6 lines. Equivalently: every dropped run is ≥6 lines, and every interior shown run (between two gaps) is ≥6 lines.

This is enforced **structurally inside the selection DP's state machine** (`selectDropsToBand` in `removal.ts`) — it is a property of which selections are reachable, not a post-hoc reassembly check — and it is re-verified by `verifyOutput`.

**Bad — fewer than 6 shown lines between markers (not allowed):**
```
[TRUNCATED: lines 03-13]
14. code
15. code
16. code
[TRUNCATED: lines 17-21]
22. code
```

**Good — at least 6 continuous shown lines between markers:**
```
[TRUNCATED: lines 03-13]
14. code
15. code
16. code
17. code
18. code
19. code
[TRUNCATED: lines 20-56]
```

**Resolution is signal-driven, not mechanical:** this rule has no fixed mechanical default. The selection intelligence decides: if a too-short shown block contains important lines, expand it to meet the 6-line minimum; if it contains unimportant lines, merge them into the surrounding truncation (drop them).

**Critical:** this constraint does NOT permit rearranging, altering, or synthesizing code. The output is still verbatim lines at their real line numbers. You are choosing which contiguous blocks to SHOW and which to DROP — never moving, editing, or reordering lines.

**Future note (not yet implemented; do not implement without the owner raising it):**
A possible later improvement is degrading the 6-line minimum to 5 (or 4, capped) ONLY at the brink where the band would otherwise be infeasible — measured against a "would-rescue rate" first, because a throw→raw is already a safe outcome. Until that is explicitly designed and measured, **6 is the firm minimum.**

---

### Rule 2 — Output Lines Must Be Verbatim (Character-Perfect Copies)

Every non-marker line in the output MUST be the original line prefixed ONLY with its line number (`N. `). The content after the prefix is a character-for-character copy of the corresponding original line. Do not:

- Paraphrase or summarize code
- Add or remove whitespace (beyond the `N. ` prefix)
- Reformat or restructure lines
- Create "smart" condensed representations
- Generate synthetic JSON summaries like `{ items: 47, showing: [0,1,2] }`
- Append annotations, suffixes, or metadata to lines

**Why:** the output is consumed by a model that may edit the file. It must be able to reference any visible line by exact content and trust that content exists verbatim at that line number. Alter one character and edits targeting that line fail. This is the H2 keystone in `verifyOutput`.

---

### Rule 3 — Omission Markers Must Be Present and Must Report Line Ranges

When lines are omitted (gap ≥ 6), the output MUST contain a marker giving the exact missing range. The format is exactly:

```
[TRUNCATED: lines X-Y]
```

This is the single unified marker format, flush-left, for everything TOON touches. Do NOT use `# ... [N lines omitted]`, count-only formats, or indented variants. The marker is the model's only signal of a discontinuity.

---

### Rule 4 — No "Smart" Per-Item JSON/Array Compression

Do not implement item-level compression for JSON arrays (e.g. "showing items 0, 24, 47 of 50"). JSON files are edited by line number like every other file type. The line-based model applies uniformly.

---

### Rule 5 — Output Must Include Original Line Numbers

Every output line is prefixed with its original 1-based line number in the standard file-reading format (`N. `). Combined with `[TRUNCATED: lines X-Y]` markers, there is zero ambiguity about file position.

---

### Rule 6 — NO Non-Null Assertions

Do not use TypeScript non-null assertions (`!`). They suppress the type checker and hide real nullability. If a value might be `null`/`undefined`, handle it explicitly with a guard or a semantically-correct default. (Note: under strict `noUncheckedIndexedAccess`, typed-array and array index reads are `T | undefined`; guard them with the value that is actually guaranteed there — e.g. `?? INF` / `?? -INF` for min/max accumulators, never a convenient `?? 0` that would corrupt the math.) Non-null assertions are never an acceptable shortcut.

---

### Rule 7 — Tool Call Sandboxing Must Be Explicitly Opted In

Tool-call sandboxing or blocking must only be active if explicitly enabled in Zenith's configuration. The default must never block a tool call. Blocking is opt-in.

---

### Rule 8 — API Key Validation Belongs Only in HTTP Streamable Endpoints

API key / bearer token validation must only exist in the HTTP streamable transport. SSE and stdio transports are local and must remain key-free.

---

### Rule 9 — All Schemas Must Be Strict

Every Zod (or other validation) schema must be strict. No passthrough, no partial, no loose validation. Unknown fields are rejected, not silently dropped or forwarded. Evolve schemas explicitly; do not loosen as a workaround.

---

### Rule 10 — Line Numbering in Output Is Always Mandatory

Line numbers must always be present in TOON output and all tool output returning file content. There must never be a parameter, flag, or config knob that disables line numbering. Line numbers are structural metadata the model depends on for edits, not a display preference.

---

### Rule 11 — No Helpers, No Wrappers — Inline Corrections Only

Do NOT create helper/wrapper/utility abstractions to "clean up" or "centralize" marker logic, output formatting, selection, or any existing inline behavior. If a marker is emitted wrong, fix the literal line where the marker string is built. If selection is wrong, fix it where it lives.

**Why:** every `formatOmissionMarker()` or `emitLines()` wrapper adds indirection that makes it trivial to change output format in one place and break all call sites, obscures control flow, and invites future "improvements" that silently break invariants. The code is intentionally inline. Keep it inline.

---

### Rule 12 — TOON Always ATTEMPTS Compression; It May Decline to Ship It

TOON must never *refuse to try*. Both the structured (AST-aware) path and the unstructured (text-based) path must always be available; an unsupported language is a mandatory fallback to the unstructured path, never a refusal to run. The unstructured path is the universal fallback and must never be removed or degraded.

But "always attempts" is **not** "always returns compressed output." TOON legitimately returns `null` — meaning "use the raw file" — when compression is not useful (the output would not beat raw), when the retention band is genuinely unreachable for an input, or when a candidate cut fails `verifyOutput`. That null is the correct, safe outcome (see Priority 0.4). What is forbidden is a code path that *can't even attempt* compression, or one that ships an unverified/inconsistent cut instead of degrading to raw.

In short: **never refuse to try; always either ship a verified cut or return null for raw.** Both are success.

---

### Rule 13 — Always Choose the Most Robust Solution

When two valid approaches exist, implement the most robust, highest-quality one — never the "minimal safe option" or the simpler-but-weaker alternative. Ask which is more correct, more resilient to edge cases, and better long-term. That is the answer.

---

### Rule 14 — Never Defer a Real Bug or Correctness Issue

When something is broken, it gets fixed — not deferred, noted, or ticketed and forgotten. There is no "out of scope": think in terms of what improves the MCP as a whole, not PR boundaries. If it's broken, it's in scope.

---

### Rule 15 — `facts.path` Across the MCP→TOON Seam Must Be Repo-Relative

The `facts.path` passed to TOON must be repo-relative, not absolute. Convert before crossing the seam.

---

### Rule 16 — These Documents Outrank Bot Review Findings

When a code-review bot's finding contradicts a documented constraint or goal, these documents win. Bot findings are advisory. Do not act on a bot suggestion that conflicts with the rules here — the correct answer comes from these files and from the owner directly.

---

### Rule 17 — Use the Real Engines — Delegate Fully

Do not make a fake baby version of something that already exists. The repo already has the smart thing; invoke its complete pipeline as designed. Do not cherry-pick internals or write a "simpler" version. The live engines are:

- SageRank (block centrality): `packages/zenith-toon/src/sagerank.ts`
- BMX+ (lexical line ranking): `packages/zenith-toon/src/bmx-plus.ts`
- Budget logic: `packages/zenith-toon/src/budget.ts`
- The removal gate + selection DP + `verifyOutput`: `packages/zenith-toon/src/removal.ts`
- Entry / chain ignition: `packages/zenith-toon/src/compress-source.ts`
- Public boundary (`compressFile`, `compressSource` export): `packages/zenith-toon/src/index.ts`

SageRank is not generic PageRank — read and integrate the actual implementation; do not replace it with simplified centrality scoring.

---

### Rule 18 — Forbidden Designs

Do not propose or implement:

- Fake local SageRank, BMX/BM25, graph ranking, or budget allocators
- Reintroduction of the old dedup / router / pipeline / string-codec engines
- One giant pipeline file that recreates existing engines
- MCP-side compression intelligence or tree-sitter-to-TOON adapters
- CLI bridge scripts as the main architecture
- Summarization or synthetic output
- A second, "never-fail" selection algorithm bolted on as a fallback to the exact DP (the DP throws on inconsistency by design; `compressFile` degrades to raw — that IS the fallback)
- Anything that makes the model distrust which line number it is looking at

---

### The Value-Blind Gate (how selection actually decides)

The removal gate has **no ranking of its own** and blends **no scores**. It consumes only boolean *verdicts* from the ranking engines:

```
eligible[line] = NOT sage-core(line) AND NOT bmx-core(line)
```

Two equal co-vetoes, ANDed. SageRank and BMX+ each expose their important minority ("core") via their own knee on their own score curve; the gate protects a line if *either* engine cores it, and only the lines *neither* engine cores are eligible to drop. No per-engine coefficient, no combined importance number, no magnitude ever crosses into the gate.

Any future signal added to selection must preserve this: it speaks to the gate in a **directive** (a boolean set — e.g. "prefer to drop these when possible"), never a score the gate compares. A prefer-to-drop signal may only reorder the choice **among equally-optimal-net, already-valid selections** (a tie-break inside reconstruction); it must never change what is eligible, never trade away band-optimality, and never force an illegal or out-of-band cut.

---

### Constraints on the Implementation

- Do not change the public boundary: `compressFile(request): string | null` (`index.ts`), nor the `compressSource` native entry/export.
- Do not change the selection signature `selectDropsToBand(weights, lines, eligible, netMin, netMax): DropSelection`, nor the `DropSelection` shape `{ drop, netRemoved, bandSatisfied }`.
- The 6-line minimum (Rule 1) is enforced structurally in the selection DP — keep it there; do not move it to a post-hoc reassembly check.
- Every non-marker output line is a character-perfect copy of the input (Rule 2 / H2).
- The retention band [68%, 72%] is enforced exactly by the DP and re-checked by `verifyOutput` H6 — do not replace it with an approximate floor.
- The gate throws on any inconsistency; `compressFile` catches and degrades to raw (Priority 0.4) — do not swallow the throws inside the engines, and do not let an exception escape `compressFile`.
- Selection still works when AST/edge/reference facts are sparse or empty (graceful degradation — fewer protections, same guarantees, may legitimately return null for raw).
- No new helper functions, no new files for inline behavior (Rule 11).

---

### ANTI-PATTERNS TO EXPLICITLY AVOID

| Anti-pattern | Why it fails |
|---|---|
| Setting the 6-line minimum to 1 or removing the check | Creates useless single-line markers that cost more than showing the line |
| Generating "summary" lines like `// 3 helper functions omitted` | Not verbatim — model can't use these for edits |
| Per-JSON-item markers like `{ showing: [0,1,2], total: 50 }` | JSON is line-edited, not item-edited |
| Stripping comments to "save space" | Comments are verbatim file content; stripping breaks the line map |
| Reordering output lines to group by importance | Breaks line-number correspondence |
| Adding new marker formats without the line range | Model loses track of what's missing |
| Making the 6-line threshold configurable per-call | Unnecessary complexity; 6 is the value |
| Removing blank lines between blocks to "save budget" | Breaks line-number mapping |
| Creating helper/wrapper functions like `formatMarker()` / `emitLine()` | Indirection that obscures control flow and invites silent breakage — fix logic inline |
| Treating a `null` return from `compressFile` as a bug | Null is the correct "use raw" outcome (Priority 0.4) |
| Swallowing the gate's internal throws with try/catch inside the engines | The throws are the safety mechanism; only `compressFile` catches, and only to degrade to raw |
| Adding a second "never-fail" greedy selector as a fallback to the exact DP | Introduces a dumber algorithm and lets tests pass on valid-but-suboptimal output; the DP + degrade-to-raw IS the fallback |
| "Restoring" the dedup / router / pipeline engines because a stale rule mentions them | They were removed in the refactor; the redundancy idea lives in the value-blind gate now |
| Asserting only "output is valid" in tests instead of "output is optimal + verifies" | Validity tests can't catch a sub-optimal or wrong-path selection — assert optimality vs. brute force and true-band membership |
| Skipping signature allocation "to save body budget" | Invisible functions are catastrophic for comprehension; signatures are negligible cost |
| Emitting `# L{n}` annotations instead of `N. ` prefixes | The suffix is a hack; use the standard prefix on every line |
| Using `# ... [N lines omitted]` (count-only) | Doesn't say WHICH lines are missing; use `[TRUNCATED: lines X-Y]` |
| Indenting truncation markers | Markers must be flush-left, visually unambiguous as metadata |
| Adding signatures BEYOND the budget as a "second pass" | Everything must fit WITHIN the band, signatures included |
| Using TypeScript non-null assertions (`!`) | Suppresses the checker and hides nullability; handle it explicitly |
| Enabling tool-call sandboxing without explicit config opt-in | Default must never block a tool call |
| Using loose/passthrough schemas | Unknown fields must be rejected |
| Adding a `showLineNumbers` opt-out param | Line numbers are mandatory structural metadata |

---

## TOON GOALS

- This is what TOON's end goal looks like, why we're creating it, why it matters, and how every constraint above is a contract that creates the vision of TOON. Deviating is not a simple deviation — it changes the primary core decisions TOON was designed from.

### The Problem This Solves

Reading a codebase is expensive. Every file a model reads consumes context. In a large project, a full scan can cost a million tokens or more — before the model has written a single line. The model arrives bloated, with less room to reason and a clouded perspective built from thousands of lines it did not need to read in full.

The user pays for every token. The model performs worse with less room to think. Both problems share one root cause: **files are read at full cost when full cost is not necessary.** `zenith-toon` exists to fix that.

### What zenith-toon Does

`zenith-toon` is the compression brain of the Zenith MCP. It takes a source file and produces a compressed version that gives a model the same understanding at ~70% of the contextual and token cost.

The target: **~70% of the file retained (the [68%, 72%] band), ~30% compressed away.**

At that ratio, a codebase that would have cost 1,000,000 tokens to read now costs ~700,000 — 300,000 tokens of extra room to reason, plan, and implement before writing anything.

This is not summarization. The model receives real file content: verbatim lines, real line numbers, explicit markers showing exactly what was omitted. Nothing is paraphrased, synthesized, or invented. Every shown line is a character-perfect copy of the real file at the real line number. The model can trust what it reads and edit from it safely.

### How This Fits Into the MCP

**`read_multiple_files` — compressed by default.** Batch reads are for understanding a codebase, not targeted edits. Compression is on by default; uncompressed batch reads are an explicit opt-in.

**`read_file` — uncompressed by default.** A targeted single-file read is usually for editing. Uncompressed is the right default. A `compress: true` param exists for orientation reads.

The compression path should be invisible and trustworthy — an agent using `read_multiple_files` should simply receive a faithful, compact representation and get on with its work. (When TOON returns null for a given file, that file is served raw — also invisible and correct.)

### What Good Compression Looks Like

The 30% that gets dropped must be the right 30%. A good compressed file gives the model a complete understanding of: what the file defines and exports; which functions/classes/modules are structurally important; how the important pieces relate; which logic is central, reused, or entry-point-like; the patterns specific to this file; and exactly which line ranges were omitted.

What gets dropped is the low-signal body — implementation that follows predictably from visible structure, boilerplate that adds no new information, repetitive patterns where one instance is as good as all.

The compression is intelligent, not mechanical. TOON uses AST structure, symbol graphs, call edges, and ranking engines (SageRank, BMX+) to determine what matters. The goal: a model that reads a TOON-compressed file comes away with the same mental model as if it had read the full thing — at 70 cents on the dollar.

### The Trust Contract

For compression to be useful it must be trustworthy. An agent that doubts what it reads is worse than one that read nothing. The contract is absolute:

- Every shown line maps verbatim to the real file at the exact line number shown
- Every omission is explicitly marked with the real range removed
- There are no gaps the agent does not know about
- There is no invented, paraphrased, or synthesized content

If an agent reads line 48 in TOON output, line 48 in the actual file must contain exactly that. No exceptions. This is the foundation the entire tool is built on, and `verifyOutput` enforces it mechanically on every shipped cut.

### The Long-Term Trajectory

70% retained is the current target and delivers real, measurable value. As compression intelligence improves — deeper AST awareness, more precise ranking, better signals — the goal is to move toward 60%, then possibly 50%, while still giving the model a complete understanding. The ratio improves; the quality of understanding does not regress. The bet is not "smaller output" but "the same understanding, at a fraction of the cost," pushed as far as the intelligence can carry it.

### Design Consideration — Two Sides of the Same Cut

Most compression thinking starts one direction: find the best 70% and keep it. That yields a good skeleton — anchors, exports, high-ranked defs survive — but has a blind spot: content can survive simply by being near something important or scoring just above threshold, without adding new information.

The other direction deserves equal attention: actively identify the weakest 30% and ask what earns removal. The question shifts from "is this valuable?" to "does this add anything the model doesn't already have from what else is shown?" — a more surgical lens. Content that earns removal on that basis: boilerplate that follows mechanically from a visible signature; error handling already shown multiple times in the file; comments that restate adjacent code; middle cases in long switch/if chains where the pattern is obvious; getter/setter bodies when the field is visible.

The signal for removal is **redundancy relative to already-shown content** — low *marginal* information, not just low absolute importance. In the current architecture this lens lives in the value-blind gate's eligibility (and is the natural home for a future prefer-to-drop ordering signal) — **not** in a separate deduplicator pass (that engine was removed). The place where "keep the best" and "drop the most redundant" meet is where compression gets genuinely intelligent.

### AST-Awareness Is Always the Direction

When choosing between two valid implementations of the same feature, prefer the one that improves AST awareness and makes the MCP more intelligent. Real AST structure — byte offsets, node boundaries, real scope containment — is always preferred over line-number approximations or row comparisons. This is the direction the codebase moves.

### Codebase Alignment

The goal is to align the codebase with the intended design in these files. Agent-generated code that drifted from the intended design is not acceptable just because tests pass. Green tests with wrong architecture is still wrong. When code doesn't match documented intent, it gets corrected — not worked around.

### Performance Is Correctness

N+1 queries, missing statement caching, unbounded operations with no size cap — these are bugs, not polish. They degrade the system for real use and get fixed alongside everything else. There is no deferring a performance issue. (Memory bounds matter specifically: the selection DP is bounded by construction — see the `fen` bitset/tight-window design and the adaptive net-axis quantization for giant-line inputs — never by an unbounded allocation that risks OOM.)
