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
 * into the refactor's `Source`, ignites the engine chain, and GUARANTEES graceful
 * degradation: any failure inside the chain is caught here and turned into the
 * "fall back to raw text" signal, so a real-time caller is never interrupted by a
 * compression failure. Contains NO compression logic.
 *
 * Returns `null` for now — the honest, documented "fall back to raw text" signal.
 * The compressed string is produced at the chain's FORWARD END (render). The
 * removal gate now exists but does not DROP lines yet (sub-stage 5A), and render is
 * not built, so there is no real compressed output to surface — returning the
 * gate's full-source output would pass raw text off as compressed. We do NOT
 * fabricate output and do NOT pass raw source off as compressed. Real output is
 * wired when the render sub-stage produces genuinely dropped-line content.
 */
export function compressFile(request: CompressFileRequest): string | null {
  try {
    // PURE shape mapping — zero compression decisions (the seam makes none):
    //   • source (one raw string) -> a single line-ranged block, lines 1..N. One
    //     block imposes no structure of our own; block-splitting is a TOON-internal
    //     decision for a later stage, not the seam's to make.
    //   • maxChars -> charBudget   • facts.path -> modulePath   • no scan query.
    //   • facts -> Source.facts: forwarded verbatim EXCEPT defs.line -> defs.startLine
    //     (MCP's DB column name -> TOON's coordinate vocabulary). Edges already arrive
    //     RESOLVED + line-keyed from the seam; nothing here re-resolves or re-weights.
    // Kept INSIDE the try so a malformed request degrades to "use raw" too, never throws.
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

    // Ignite the chain (compressSource -> SageRank -> BMX+ -> removal). compressSource
    // now RETURNS the final Payload — the wire real compressed output will flow back
    // through once render exists.
    const result = compressSource(source);
    // 5A: the removal gate does not DROP lines yet, so result.output is the FULL
    // source. Returning it here would pass raw text off as "compressed" — the
    // anti-pattern this file's contract forbids — so we still return null (honest
    // "use raw"). The wire (reading result.output) is connected when real
    // dropped-line output exists (the render sub-stage).
    void result;
    return null;
  } catch (err) {
    // Degrade to "use raw" — the caller's task is NEVER interrupted by a toon
    // failure. Failure is invisible to the CALLER by design; it must remain visible
    // to the OPERATOR. This is toon's single observation point for compression
    // failures, and it is toon's OWN guarantee at its OWN public boundary — not
    // borrowed from the seam's catch. compressFile is now honest for ANY consumer.
    // TODO(telemetry): wire failure logging here — onCompressionFailure(err) or similar.
    // Deliberate named no-op for now (not a swallowed error); see parked telemetry work.
    void err; // acknowledge err so it is not an "unused variable"
    return null;
  }
}
