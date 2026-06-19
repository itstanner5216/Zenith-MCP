# zenith-toon — Goal

## The Problem This Solves

Reading a codebase is expensive. Every file a model reads consumes context. In a large project, a full codebase scan can cost a million tokens or more — and that is before the model has written a single line. The model arrives at the task with a bloated context window, less room to reason, and a clouded perspective built from thousands of lines it did not actually need to read in full.

The user pays for every token. The model performs worse with less room to think. Both problems have the same root cause: **files are read at full cost when full cost is not necessary.**

`zenith-toon` exists to fix that.

---

## What zenith-toon Does

`zenith-toon` is the compression brain of the Zenith MCP. Its job is to take a source file and produce a compressed version that gives a model the same understanding of that file at 70% of the contextual and token cost.

The target: **70% of the file retained, 30% compressed away.**

At that ratio, a codebase that would have cost 1,000,000 tokens to read and understand now costs 700,000. The model gets 300,000 tokens of extra room to reason, plan, and implement — before it has even written anything. That headroom is not a nice-to-have. It directly improves the quality of what follows.

This is not summarization. The model receives real file content: verbatim lines, real line numbers, explicit markers showing exactly what was omitted. Nothing is paraphrased, synthesized, or invented. Every line the model sees is a character-perfect copy of the real file at the real line number. The model can trust what it reads, and it can edit from it safely.

---

## How This Fits Into the MCP

The compression model is built around how agents actually use file reads:

**`read_multiple_files` — compressed by default.**
Batch file reads are for understanding a codebase, not for making targeted edits. Compression is on by default. An agent that wants uncompressed batch reads must explicitly opt in — the choice should be intentional, not the path of least resistance.

**`read_file` — uncompressed by default.**
A targeted single-file read is usually for editing. The agent knows which file it wants, it knows why, and it will likely be writing against the content it receives. Uncompressed is the right default. A `compress: true` param exists for when the agent wants to read a file for orientation rather than editing.

The compression path should be invisible and trustworthy. An agent using `read_multiple_files` should not have to think about compression — it should simply receive a faithful, compact representation of every file and get on with its work.

---

## What Good Compression Looks Like

The 30% that gets dropped must be the right 30%.

A good compressed file gives the model a complete understanding of:

- What the file defines and exports
- Which functions, classes, and modules are structurally important
- How the important pieces relate to each other
- Which logic is central, reused, or entry-point-like
- The coding patterns and nuances specific to this file
- Where content was removed and exactly which line ranges were omitted

What gets dropped is the low-signal body — the implementation details that follow predictably from the visible structure, the boilerplate that adds no new information, the repetitive patterns where seeing one instance is as good as seeing all of them.

The compression is not mechanical. It is intelligent. TOON uses AST structure, symbol graphs, call edges, and ranking engines (SageRank, BMX+) to determine what actually matters in a file. The goal is for a model that reads a TOON-compressed file to come away with the same mental model of that file as if it had read the full thing — just at 70 cents on the dollar and 70 percent of the contextual cost. 

---

## The Trust Contract

For compression to be useful it must be trustworthy. An agent that doubts what it is reading is worse than an agent that read nothing.

The contract is absolute:

- Every line shown maps verbatim to the real file at the exact line number shown
- Every omission is explicitly marked with the real line range that was removed
- There are no gaps the agent does not know about
- There is no invented, paraphrased, or synthesized content

If an agent reads line 48 in TOON output, line 48 in the actual file must contain exactly that content. No exceptions. This is not a formatting preference — it is the foundation the entire tool is built on. Violating it destroys trust and makes the tool worse than useless.

---

## The Long-Term Trajectory

70% retained is the current target. It is a reasonable goal that delivers real, measurable value. If we hit it reliably and intelligently, we have already accomplished creating a solution to a significant problem.

But the ceiling is higher. As compression intelligence improves — as TOON's AST awareness deepens, as ranking gets more precise, as the engines improve — the goal is to eventually move to 60%, then possibly 50%, while still giving the model a complete understanding of the file. The compression ratio improves; the quality of understanding does not regress.

That is the long-term bet: not just "smaller output" but "the same understanding, at a fraction of the cost," pushed as far as the intelligence of the compression can carry it.

---

## Design Consideration — Two Sides of the Same Cut

Most compression thinking starts from one direction: find the best 70% and keep it. That produces a good structural skeleton — anchors, exports, high-ranked definitions all make it through. But it has a blind spot: content can survive the cut simply by being near something important, or by scoring just above the threshold, without actually adding new information.

The other direction is worth equal attention: actively identify the weakest 30% and ask what earns removal. The question shifts from "is this valuable?" to "does this add anything the model doesn't already have from what else is shown?" That is a much more surgical lens.

Content that earns removal on that basis:
- Boilerplate that follows mechanically from a visible signature
- Error handling patterns already shown multiple times in the same file
- Comments that restate what the surrounding code already clearly says
- Middle cases in long switch/if chains where the pattern is obvious after the first few
- Getter/setter bodies when the field declaration is already visible

The signal for removal is **redundancy relative to already-shown content** — not just low absolute importance, but low *marginal* information given everything else the model sees in the output.

The best compression approach likely works both directions simultaneously: rank everything, anchor the high-value structure first, then fill the remaining budget by removing the most redundant content rather than purely adding the most valuable. The deduplicator already exists for exactly this purpose — it may be the most underutilized engine in the pipeline.

The place where these two perspectives meet is where compression gets genuinely intelligent.

---

## Package Ownership

`zenith-toon` owns all compression intelligence. This is non-negotiable.

`zenith-mcp` is the context provider and the pipe. It supplies:

- File text
- File path (repo-relative)
- Project root
- Budget / maxChars
- DB path or read-only project metadata
- Language and context hints
- Raw AST / symbol / edge facts it has already computed for other purposes

`zenith-mcp` must not decide which lines, symbols, blocks, or AST nodes matter for compression. It hands over raw facts. TOON does the reasoning.

---

## AST-Awareness Is Always the Direction

When choosing between two valid implementations of the same feature, ask which one improves AST awareness and makes the MCP more intelligent. The approach that uses actual AST structure — byte offsets, node boundaries, real scope containment — is always preferred over line-number approximations or row comparisons. This is the direction the codebase is moving.

---

## Codebase Alignment

The goal is to align the codebase with the intended design documented in these files. Agent-generated code that drifted from the intended design is not acceptable just because tests pass. Green tests with wrong architecture is still wrong. When code does not match the documented intent, it gets corrected — not worked around.

---

## Performance Is Correctness

N+1 queries, missing statement caching, unbounded operations with no size cap — these are bugs, not polish. They degrade the system for real use and they get fixed alongside everything else. There is no such thing as deferring a performance issue.
