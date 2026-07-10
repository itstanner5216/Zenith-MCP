// compress-source.ts — the entry point. It is the FIRST ENGINE.
//
// It is NOT an orchestrator: it does not know the downstream sequence, does not
// call BMX/removal/render, and never reads another engine's metadata. What it
// DOES — its own core process — is weigh every line by its share of the total
// file content and drop that determination onto the payload's `entry` metadata
// key, then hand the payload to its successor (SageRank). From there each engine
// drops its own stone and hands the payload to its own successor
// (SageRank -> BMX+ -> Removal -> Render). The compressed result emerges at the
// forward END of that chain — it never comes back here.
//
// Why the per-line file-share is the WHOLE reason this engine exists:
//   • FEASIBILITY — a 20K-char file that is 3 giant lines cannot satisfy
//     line-only removal + the 6-line-gap rule + the 30%-removed / 70%-kept
//     target. The feasibility check reads these weights to know a file is
//     impossible for toon's normal process BEFORE it runs, instead of sending it
//     downstream to fail.
//   • RENDER REBALANCING — to hold retention inside the 68–72% band the render
//     engine swaps lines in and out; pulling a line worth 3% of the file means
//     restoring ~equivalent weight (one ~3% line, or two smaller ones), never a
//     0.3% line. It can only do that arithmetic because every line already
//     carries its file-percentage, measured here.

import { SageRank } from './sagerank.js';

/**
 * One contiguous line-range unit of source. Line numbers are the coordinate
 * system: `startLine`/`endLine` arrive from the consumer (Zenith-MCP) as ground
 * truth and are never recomputed; `text` keeps its line-number prefix intact.
 */
export interface SourceBlock {
  readonly startLine: number;  // 1-based inclusive, as received — never re-derived
  readonly endLine: number;    // 1-based inclusive
  readonly text: string;       // block source WITH its line-number prefixes preserved
}

/**
 * The RESOLVED AST/symbol facts the consumer (Zenith-MCP) already indexed and
 * hands across the seam — data transport, not intelligence (the engines decide
 * what to DO with them). Line numbers are the coordinate system: a def's identity
 * is its `startLine`; an edge's endpoints are the caller/callee defs' lines
 * (`callerLine`/`calleeLine`), RESOLVED in the DB so duplicate/overloaded names can
 * never misroute an edge. SageRank reads `edges`; BMX+ reads `defs` + `edges`.
 */
// RawFileFacts is the SEAM TRANSPORT shape (every fact MCP hands over). Engines do NOT
// consume it directly: SageRank reads the narrower SourceFacts (edges); BMX+ reads
// BmxScoringFacts (defs/edges). Any code reading payload.source.facts MUST guard on
// `undefined` (Source.facts is optional). Adding fields here is invisible to the engines.
export interface RawFileFacts {
  readonly path: string;
  readonly langName: string | null;
  readonly defs: ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
    readonly type: string;
    readonly startLine: number;   // def identity line (1-based), as resolved by MCP
    readonly endLine: number;
    readonly visibility: string | null;
    readonly captureTag: string | null;
  }>;
  readonly references: ReadonlyArray<{
    readonly name: string;
    readonly type: string | null;
    readonly line: number;
    readonly endLine: number;
    readonly column: number;
  }>;
  readonly edges: ReadonlyArray<{
    readonly callerLine: number;  // resolved start line of the calling def
    readonly calleeLine: number;  // resolved start line of the called def
    readonly callCount: number;
  }>;
  readonly referenceEdges: ReadonlyArray<{
    readonly callerLine: number;      // resolved start line of the containing def
    readonly referencedName: string;  // raw referenced symbol name, resolved or unresolved
    readonly referenceCount: number;
  }>;
  readonly anchors: ReadonlyArray<{
    readonly symbolName: string;
    readonly kind: string;
    readonly line: number;
    readonly text: string;
  }>;
  readonly imports: ReadonlyArray<{
    readonly module: string;
    readonly importedNames: readonly string[];
    readonly line: number;
    readonly startLine: number;
    readonly endLine: number;
  }>;
  readonly importBindings: ReadonlyArray<{
    readonly source: string;
    readonly localName: string;
    readonly importedName: string | null;
    readonly importKind: 'named' | 'default' | 'namespace';
    readonly isTypeOnly: boolean;
    readonly line: number;
    readonly column: number;
  }>;
  readonly injections: ReadonlyArray<{
    readonly injectedLang: string;
    readonly startLine: number;
    readonly endLine: number;
  }>;
  readonly scopes: ReadonlyArray<{
    readonly scopeKind: string;   // tree-sitter node type (informational; e.g. 'statement_block')
    readonly startLine: number;   // 1-based, scope's first line
    readonly endLine: number;     // 1-based, inclusive
  }>;
}

/**
 * The immutable givens the consumer hands in. The engines READ from here; they
 * never write back into it. (This is the "source text" the backpack is strapped
 * onto.)
 */
export interface Source {
  readonly blocks: readonly SourceBlock[];   // numbered source, never re-derived
  readonly query: string | null;             // scan focus
  readonly charBudget: number;               // target the removal/render engines work within (chars)
  readonly modulePath?: string | null;       // optional file/module path; query material only
  readonly facts?: RawFileFacts;             // resolved AST/symbol facts (optional; engines guard on absence)
}

/**
 * The artifact that walks the engine chain — the source text plus its backpack.
 * `source` is immutable input. `metadata` is the OPEN backpack each engine drops
 * its own key into; every engine owns its key's TYPE in its own file, so nothing
 * here (and no file outside the engines) enumerates the engines. `output` is set
 * at the forward end of the chain. This file never reads `metadata` or `output`.
 */
export interface Payload {
  readonly source: Source;
  readonly metadata: Record<string, unknown>;
  output?: string;
}

/**
 * The entry engine's determination — its `entry` metadata key. Every absolute
 * line number mapped to its SHARE of the total file content: (characters in the
 * line) / (characters in the file), in [0,1]; ×100 is the percentage the file is
 * reasoned about in. Display line-number prefixes are excluded — only real
 * source content is weighed. Owned HERE; consumed by the feasibility check and
 * the render rebalancer, never re-computed downstream.
 */
export type EntryMetadata = ReadonlyMap<number, number>;

/**
 * The entry point and FIRST engine. Its core process: weigh every line by its
 * share of the whole file, drop that onto the payload's `entry` key, and hand
 * the payload to the next engine (SageRank) itself. It computes only its OWN
 * determination and reads no other engine's metadata; once it hands off it is
 * done — the engines carry the flow forward themselves.
 */
export function compressSource(source: Source): Payload {
  const payload: Payload = { source, metadata: {} };

  // ── Entry engine's core process: each line's share of the whole file ──────
  // Line identity is the absolute line number (block startLine + offset). The
  // visual "N. " line-number prefix is stripped so only real source content is
  // weighed. First pass counts characters per line; second pass normalises each
  // to a fraction of the file's total characters.
  const lineWeights = new Map<number, number>();
  let totalChars = 0;
  for (const b of source.blocks) {
    const physical = b.text.split('\n');
    for (let i = 0; i < physical.length; i++) {
      const content = (physical[i] ?? '').replace(/^\s*\d+[.:]\s?/, '');
      lineWeights.set(b.startLine + i, content.length);
      totalChars += content.length;
    }
  }
  if (totalChars > 0) {
    for (const [line, chars] of lineWeights) {
      lineWeights.set(line, chars / totalChars); // [0,1] share of total file content
    }
  }
  const determination: EntryMetadata = lineWeights;
  payload.metadata.entry = determination;

  // Hand the payload to its successor. From here the engines carry the flow.
  return new SageRank().run(payload);
}
