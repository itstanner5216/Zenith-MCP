// zenith-toon — source-code line-range compressor.
//
// `compressFile` is the SEAM ADAPTER the consumer (Zenith-MCP) imports: it accepts
// the exact { source, maxChars, facts } shape `compression.ts` passes today and
// adapts it into the refactor's `Source`. It makes ZERO compression decisions of its
// own — the engines decide everything — but it IS the trust boundary: before it
// surfaces a cut it runs Phase-H verification (`verifyOutput`) over the exact string,
// so a result that fails the contract degrades to "use raw" instead of shipping.
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
import { verifyOutput, type RemovalMetadata } from './removal.js';

/**
 * A def span as the tiler consumes it — the resolved 1-based inclusive line range
 * of a single definition, taken straight from `facts.defs` (the DB's resolved
 * symbols). `startLine` is the def's identity line, the SAME key SageRank's
 * `_factsToASTEdges` resolves call-graph edges against — so blocks built on these
 * spans are edge-aligned by construction.
 *
 * Exported (with `tileByDefs`) for the tiling-correctness guard only — the partition
 * is verifiable structure, not a ranking, so exposing it widens no compression API.
 */
export interface DefSpan {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * TILE THE FILE INTO DEF-ALIGNED BLOCKS — the structural input SageRank needs.
 *
 * The seam receives the whole file as one raw (already `N.`-prefixed) string. One
 * block is useless to SageRank: it ranks BLOCKS by call-graph centrality, and with
 * a single block every call-graph edge collapses to a self-loop, so the structural
 * signal vanishes and nothing is ever eligible to drop. This tiler turns the file
 * into one block per definition (plus blocks for the regions between defs), so the
 * call graph finally connects distinct blocks and SageRank can find the important
 * minority.
 *
 * GUARANTEES (the tiling contract — every one is required for line-number fidelity):
 *   • COMPLETE + CONTIGUOUS: every physical line 1..N lands in EXACTLY one block;
 *     blocks are ascending and never overlap. (Without this, the verbatim
 *     reconstruction and the omission accounting downstream break.)
 *   • VERBATIM: each line's ORIGINAL prefixed text is carried unchanged; line
 *     numbers are NEVER recomputed — a block's `startLine` is the true source line.
 *   • EDGE-ALIGNED: every leaf def's `startLine` is exactly a block boundary, so
 *     SageRank's `_factsToASTEdges` resolves caller/callee lines to real block
 *     indices (exact-startLine match), lighting up the call-graph fusion.
 *   • NESTING via INNERMOST-WINS: when defs nest (a method inside a class), each
 *     line belongs to the SMALLEST def covering it. The outer def's remaining lines
 *     (its header/preamble, gaps between methods) become their own blocks. This is
 *     the class -> preamble + per-method split: each method stays a distinct
 *     rankable unit, which is what the method-to-method call graph needs.
 *
 * FALLBACK: with no usable defs the whole file is returned as ONE block. SageRank
 * then has nothing to discriminate, removal finds nothing eligible, and the seam
 * honestly returns null ("use raw") — never a fabricated cut. Facts-present is when
 * compression engages; facts-absent degrades to raw, exactly as the contract wants.
 */
export function tileByDefs(prefixedSource: string, defs: readonly DefSpan[]): SourceBlock[] {
  const physical = prefixedSource.split('\n');
  const n = physical.length; // physical lines == source lines 1..n
  if (n === 0) return [];

  // owner[line] = the index into a sorted, INNERMOST-wins def list that owns this
  // 1-based line, or -1 for a non-def (gap) line. Building per-line ownership first
  // makes the contiguous tiling trivially correct: we just group maximal runs of
  // equal ownership. Innermost-wins falls straight out of applying wider spans
  // first and narrower spans last (a narrower, more-nested def overwrites).
  const owner = new Int32Array(n + 1).fill(-1); // index 0 unused (lines are 1-based)

  // Keep only in-range, well-formed spans; clamp to the file. Sort widest-first so
  // that painting narrower (more deeply nested) spans afterward overwrites the
  // wider outer def on the overlapping lines -> innermost wins.
  const spans: Array<{ startLine: number; endLine: number }> = [];
  for (const d of defs) {
    const s = Math.max(1, Math.floor(d.startLine));
    const e = Math.min(n, Math.floor(d.endLine));
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) spans.push({ startLine: s, endLine: e });
  }
  spans.sort((a, b) => {
    const wa = a.endLine - a.startLine;
    const wb = b.endLine - b.startLine;
    if (wb !== wa) return wb - wa; // widest first
    return a.startLine - b.startLine;
  });
  for (let si = 0; si < spans.length; si++) {
    const sp = spans[si];
    if (sp === undefined) continue;
    for (let line = sp.startLine; line <= sp.endLine; line++) owner[line] = si;
  }

  // Group maximal runs of equal ownership into contiguous blocks. A run of the same
  // owner index (def or the shared -1 gap marker) becomes one block spanning
  // exactly those lines, with its original prefixed text joined verbatim.
  const blocks: SourceBlock[] = [];
  let runStart = 1;
  for (let line = 2; line <= n + 1; line++) {
    const prevOwner = owner[line - 1] ?? -1;
    const curOwner = line <= n ? (owner[line] ?? -1) : Number.NaN; // NaN at n+1 forces a final flush
    if (line > n || curOwner !== prevOwner) {
      const text = physical.slice(runStart - 1, line - 1).join('\n'); // verbatim, prefixes intact
      blocks.push({ startLine: runStart, endLine: line - 1, text });
      runStart = line;
    }
  }
  return blocks;
}


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
 * degradation: any failure inside the chain — OR a Phase-H verification failure on
 * the result — is caught here and turned into the "fall back to raw text" signal, so
 * a real-time caller is never interrupted by a compression failure or an unsafe cut.
 *
 * Returns the COMPRESSED string when the removal gate genuinely dropped lines, the
 * result is smaller than the input, AND the output passes Phase-H verification
 * (verifyOutput) — the keystone being H2: every kept line is character-for-character
 * its original at the number it carries, so the output is safe to edit against.
 * Otherwise it returns `null` — the honest "fall back to raw text" signal. It never
 * fabricates output, never passes raw source off as compressed, and never ships a cut
 * it could not independently re-verify. Real compressed output is produced at the
 * chain's forward end (the removal gate), carried back as `result.output`; this
 * adapter only proves it trustworthy before letting it cross the seam.
 */
export function compressFile(request: CompressFileRequest): string | null {
  try {
    // PURE shape mapping — zero compression decisions (the seam makes none):
    //   • source (one raw, already `N.`-prefixed string) -> def-ALIGNED blocks via
    //     tileByDefs: one block per definition (from facts.defs spans) plus blocks
    //     for the regions between defs, tiling every line 1..N exactly once. This is
    //     the structural input SageRank needs — one block per file makes every
    //     call-graph edge a self-loop, so the structural signal (and thus any
    //     eligibility to drop) vanishes. tileByDefs preserves line numbers verbatim
    //     and aligns block boundaries to def start lines so edges resolve. It is a
    //     structural PARTITION of the given lines, not a ranking — which defs matter
    //     stays SageRank's decision; the seam only groups lines by the spans the DB
    //     already resolved. With no defs it returns one block -> no discrimination
    //     -> honest null downstream (use raw).
    //   • maxChars -> charBudget   • facts.path -> modulePath   • no scan query.
    //   • facts -> Source.facts: forwarded verbatim EXCEPT defs.line -> defs.startLine
    //     (MCP's DB column name -> TOON's coordinate vocabulary). Edges already arrive
    //     RESOLVED + line-keyed from the seam; nothing here re-resolves or re-weights.
    // Kept INSIDE the try so a malformed request degrades to "use raw" too, never throws.
    const blocks = tileByDefs(
      request.source,
      request.facts.defs.map(d => ({ startLine: d.line, endLine: d.endLine })),
    );
    const source: Source = {
      blocks,
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
    // RETURNS the final Payload: result.output is the compressed string the chain
    // produced, and result.metadata.removal is the gate's determination.
    const result = compressSource(source);
    // The removal gate now drops lines and emits real `[TRUNCATED: lines X-Y]`
    // markers, so result.output is GENUINE compressed output. We surface it ONLY
    // when there is real compression to surface: the gate actually dropped lines
    // AND the result is smaller than the input. Otherwise we return null — the
    // honest "fall back to raw text" signal — because returning the full source as
    // "compressed" is the anti-pattern this file's contract forbids. We never
    // fabricate output and never pass raw source off as compressed.
    const removal = result.metadata.removal;
    const dropped =
      removal !== null && typeof removal === 'object' && 'dropped' in removal
        ? (removal as { dropped: ReadonlySet<number> }).dropped
        : null;
    const output = result.output;
    if (
      typeof output === 'string' &&
      dropped !== null &&
      dropped.size > 0 &&
      output.length < request.source.length
    ) {
      // The trust boundary: Phase-H verification re-derives everything from this exact
      // string and the original source, INDEPENDENTLY of the engine's bookkeeping, and
      // THROWS on any violation (H2 keystone: a kept line's number can never lie about
      // its content). The throw lands in the catch below → null → "use raw," so a cut
      // that fails the contract is never shipped. We verify the precise string we are
      // about to return — nothing is re-prefixed, re-rendered, or mutated after this.
      verifyOutput(request.source, output, removal as RemovalMetadata, request.maxChars);
      return output;
    }
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
