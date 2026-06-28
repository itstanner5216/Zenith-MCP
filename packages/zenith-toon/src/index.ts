// zenith-toon — source-code line-range compressor.
//
// `compressFile` is the SEAM ADAPTER the consumer (Zenith-MCP) imports: it accepts
// the exact { source, maxChars, facts } shape `compression.ts` passes today and
// adapts it into the refactor's `Source`. It makes ZERO compression decisions —
// pure shape mapping — mirroring the seam's own rule on the MCP side.
//
// `compressSource` is the refactor's native entry: it builds the payload from the
// `Source` and ignites the first engine. From there the engines carry the flow
// themselves — each reads the whole payload, appends its OWN determination as
// metadata, and hands the payload to its own successor. Nothing out here
// orchestrates, re-ranks, normalizes, aggregates, or re-exports their internals.
//
// The engines (SageRank, BMX+, removal, render) and their RESULTS are NOT part of
// the public API. The seam hands them the RESOLVED facts MCP already indexed via
// `Source.facts`; from there each engine reads what it needs off the payload
// (SageRank the call-graph edges, BMX+ the defs + edges) and decides everything
// itself. This module only TRANSPORTS those facts in — it ranks/weighs nothing.
import { compressSource, type Source, type SourceBlock } from './compress-source.js';

export { compressSource };

// The INPUT contract: the immutable `Source` the consumer fills in. INPUT only —
// no rankings, no engine results, no engine internals leave this module.
export type { Source, SourceBlock };

/**
 * The argument shape Zenith-MCP hands across the seam today
 * (packages/zenith-mcp/src/core/compression.ts → `compressFile({ source, maxChars,
 * facts })`). Mirrored here so the adapter typechecks against the real call. These
 * are raw FACTS only; the adapter reads nothing back into them and decides nothing.
 */
export interface CompressFileRequest {
  readonly source: string;
  readonly maxChars: number;
  readonly facts: {
    readonly path: string;
    readonly langName: string | null;
    readonly defs: ReadonlyArray<{
      readonly name: string;
      readonly kind: string;
      readonly type: string;
      readonly line: number;
      readonly endLine: number;
      readonly visibility: string | null;
      readonly captureTag: string | null;
    }>;
    readonly edges: ReadonlyArray<{
      readonly callerLine: number;
      readonly calleeLine: number;
      readonly callCount: number;
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
    }>;
    readonly injections: ReadonlyArray<{
      readonly injectedLang: string;
      readonly startLine: number;
      readonly endLine: number;
    }>;
  };
}

/**
 * Seam adapter for Zenith-MCP. Adapts the MCP's { source, maxChars, facts } call
 * into the refactor's `Source` and ignites the engine chain. Contains NO
 * compression logic.
 *
 * Returns `null` for now — the honest, documented "fall back to raw text" signal.
 * The compressed string is produced at the chain's FORWARD END (render); removal
 * and render do not exist yet and the entry returns void, so the chain surfaces
 * nothing to return here. We do NOT fabricate output and do NOT pass raw source
 * off as compressed. Real output is wired when the removal/render gate is built.
 */
export function compressFile(request: CompressFileRequest): string | null {
  // PURE shape mapping — zero compression decisions (the seam makes none):
  //   • source (one raw string) -> a single line-ranged block, lines 1..N. One
  //     block imposes no structure of our own; block-splitting is a TOON-internal
  //     decision for a later stage, not the seam's to make.
  //   • maxChars -> charBudget   • facts.path -> modulePath   • no scan query.
  //   • facts -> Source.facts: forwarded verbatim EXCEPT defs.line -> defs.startLine
  //     (MCP's DB column name -> TOON's coordinate vocabulary). Edges already arrive
  //     RESOLVED + line-keyed from the seam; nothing here re-resolves or re-weights.
  const lineCount = request.source.split('\n').length;
  const source: Source = {
    blocks: [{ startLine: 1, endLine: lineCount, text: request.source }],
    query: null,
    charBudget: request.maxChars,
    modulePath: request.facts.path,
    facts: {
      path: request.facts.path,
      langName: request.facts.langName,
      defs: request.facts.defs.map(d => ({
        name: d.name, kind: d.kind, type: d.type,
        startLine: d.line, endLine: d.endLine,
        visibility: d.visibility, captureTag: d.captureTag,
      })),
      edges: request.facts.edges,
      anchors: request.facts.anchors,
      imports: request.facts.imports,
      injections: request.facts.injections,
    },
  };

  // Ignite the chain (compressSource -> SageRank -> BMX+ -> removal -> render).
  compressSource(source);
  return null;
}
