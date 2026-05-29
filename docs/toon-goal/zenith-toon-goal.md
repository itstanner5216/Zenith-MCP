# zenith-toon — Goal

## Purpose

`zenith-toon` is the compression brain between code files and the model. Its job is to reduce a file to the ~70% that preserves understanding while dropping the ~30% least useful for orientation.

The model should still receive real file content: verbatim lines, real line numbers, and explicit omission markers. This is not summarization.

## What Good Compression Preserves

A good compressed file lets the model understand:

- what the file defines and exports
- which functions/classes/modules are structurally important
- how the important pieces relate
- which logic is central, reused, or entry-point-like
- where content was removed and which real line ranges were omitted

It must not move, paraphrase, synthesize, or annotate file content.

## AST Awareness Vision

The central question is what to keep. Text heuristics alone are not enough. The important signal is structural: exports, definitions, calls, references, ownership, dependency edges, file/module relationships, and AST/code-graph shape.

The goal is for AST/code-graph awareness to be primary intelligence inside `zenith-toon`, not an after-the-fact patch and not an adapter owned by `zenith-mcp`.

`zenith-toon` should reason about source structure the way a developer would: keep the pieces that explain the file and its role in the codebase; drop low-signal body that follows from the visible structure.

## Package Ownership

`zenith-toon` owns compression intelligence.

`zenith-mcp` may provide:

- file text
- file path
- project root
- budget/maxChars
- DB path or read-only project metadata
- language/context hints

`zenith-mcp` must not decide which lines, symbols, blocks, AST nodes, or graph nodes matter for compression. MCP is the caller/context provider. TOON is the brain.

## Use the Real Engines

Do not make a fake baby version of something that already exists.

If the repo already has the smart thing, import it and call it:

- SageRank: `packages/zenith-toon/src/sagerank.ts`
- BMX+: `packages/zenith-toon/src/bmx-plus.ts`
- budget allocation: `packages/zenith-toon/src/budget.ts`
- deduplication: `packages/zenith-toon/src/dedup.ts`
- routing/config: `packages/zenith-toon/src/router.ts`, `packages/zenith-toon/src/config.ts`
- pipeline/string codec surfaces: `packages/zenith-toon/src/pipeline.ts`, `packages/zenith-toon/src/string-codec.ts`

SageRank may be inspired by PageRank, but it is not PageRank. Do not replace SageRank with generic PageRank, generic centrality scoring, or a simplified graph-ranker. Read and integrate the actual `SageRank` implementation.

## Forbidden Designs

Do not propose or implement:

- fake local SageRank
- fake local BMX/BM25
- fake local graph ranking that imitates SageRank
- fake budget allocators or dedupers
- one giant pipeline file that recreates existing engines
- MCP-side compression intelligence
- MCP-side tree-sitter-to-TOON compression adapters
- CLI bridge scripts as the main architecture
- summarization or synthetic output

## Correct Direction

The desired direction is an ownership fix, not a fake rewrite.

Make AST-aware compression belong inside `zenith-toon`. Reuse the existing TOON engines. Keep MCP boring. Make future agents unable to satisfy this goal by writing weaker local knockoffs.
