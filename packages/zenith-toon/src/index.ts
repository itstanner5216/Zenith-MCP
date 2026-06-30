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
 * The OPTIONAL refinement facts `tileByDefs` may use to subdivide WITHIN the def
 * partition — never to move a def boundary. `defs` remain the base partition; these
 * only carve finer sub-blocks inside an already-tiled def-owned (or gap) block.
 *
 *   • HARD spans (own their lines, paint widest→narrowest innermost-wins, exactly
 *     like the def paint): `scopes` subdivide large def-owned blocks at real
 *     sub-function boundaries (every `{}`, loop, catch); `injections` isolate
 *     embedded-language regions in def OR gap blocks.
 *   • SOFT hints (no ownership; only split an OVERSIZED leftover, and only when BOTH
 *     resulting sides clear `MIN_SUB_BLOCK_LINES`): `anchors` are single-line split
 *     hints; `imports` are top-level line hints grouped into contiguous clusters
 *     OUTSIDE defs.
 *
 * A refinement is ONLY ever honoured when it is fully CONTAINED in one baseline
 * block. Because baseline blocks are maximal runs of single def-ownership, "contained
 * in a baseline block" is exactly "does not cross a def boundary" — so no refinement
 * can ever erase a def `startLine` boundary. Omitting `refine` (the 2-arg call) yields
 * today's def-aligned partition byte-for-byte.
 */
export interface TileRefinements {
  readonly scopes?: ReadonlyArray<{ startLine: number; endLine: number; scopeKind: string }>;
  readonly injections?: ReadonlyArray<{ startLine: number; endLine: number; injectedLang: string }>;
  readonly anchors?: ReadonlyArray<{ line: number; kind: string; symbolName: string; text: string }>;
  readonly imports?: ReadonlyArray<{ line: number; module: string }>;
}

// ── Tiling thresholds (L1) — named constants, tunable from T7's payoff data. ───────
// Every boundary the tiler emits derives from a REAL fact span/line; these thresholds
// only decide WHEN a block is large enough to be worth subdividing and how small a
// sub-block may legally get. They are sizes (line counts), never importance scores.
const MIN_DROP_RUN = 6;             // matches removal's marker/run floor (Rule 1): a sub-block
                                    // smaller than a droppable run cannot help the gate, so it is
                                    // the natural floor for "worth ranking as its own unit".
const MIN_SUB_BLOCK_LINES = MIN_DROP_RUN; // smallest hard sub-block (and smallest legal soft-split
                                    // side) worth ranking; DERIVED from MIN_DROP_RUN so no split can
                                    // ever produce a piece below the removal gate's own minimum run —
                                    // the two floors are one number by construction, never drift.
const LARGE_BLOCK_LINES = 18;       // only subdivide def-/gap-blocks longer than this.
                                    // Source spec (hyperagent.md:43) suggested >12 (= 2× MIN). 18 chosen
                                    // conservatively so ~13–18-line functions aren't shattered into sub-min
                                    // slivers. TUNABLE: if T7 shows dense engine files under-compress, lower
                                    // toward 12; if T7 shows a tiny-block flood, raise. Re-tune from T7 data.
const ANCHOR_SPLIT_MIN_BLOCK = 24;  // only SOFT-split (anchor / import-cluster) a leftover block longer
                                    // than this. Strictly > LARGE_BLOCK_LINES so a soft split only ever
                                    // acts on a block hard-subdivision already failed to break up.
const TINY_FRAGMENT_LINES = 4;      // merge a sub-block shorter than this into a neighbour — UNLESS it is
                                    // a def signature (its startLine is a def boundary, which is inviolate).

/**
 * Build a `SourceBlock` for the inclusive line range [startLine..endLine] by slicing
 * the file's physical lines VERBATIM — original `N. ` prefixes intact, `startLine`
 * the true source line, never recomputed. The single place block text is cut, so the
 * verbatim/line-number guarantee is enforced once for the base partition AND every
 * refinement. `physical` is 0-indexed; source lines are 1-based, hence the `-1`.
 */
function sliceBlock(physical: readonly string[], startLine: number, endLine: number): SourceBlock {
  const text = physical.slice(startLine - 1, endLine).join('\n'); // verbatim, prefixes intact
  return { startLine, endLine, text };
}

/**
 * Paint the inclusive range [rangeStart..rangeEnd] with HARD subspans exactly as the
 * def partition is painted (widest→narrowest, so a narrower/more-nested span overwrites
 * a wider one — innermost-wins), then return the maximal equal-ownership runs as
 * inclusive [start,end] pairs that exactly tile the range. Only spans CONTAINED in the
 * range and at least `minSpan` lines long are honoured: containment within a single
 * baseline block is exactly "does not cross a def boundary" (baseline blocks are
 * maximal single-ownership runs), so this can never erase a def boundary; the length
 * floor stops a sub-`minSpan` span from carving a tiny block (J2 "below-threshold spans
 * create NO tiny blocks") — a tiny inner span is simply absorbed by whatever wider span
 * or the background covers it. With no honoured span the whole range is one run, so a
 * duplicate scope==def span (which spans the entire block) collapses back to the block
 * unchanged (J6), needing no special case.
 */
function paintHardSubspans(
  rangeStart: number,
  rangeEnd: number,
  spans: ReadonlyArray<{ startLine: number; endLine: number }>,
  minSpan: number,
): Array<{ start: number; end: number }> {
  const len = rangeEnd - rangeStart + 1;
  // owner index into `kept`, or -1 for the range's own background. Local to the range.
  const owner = new Int32Array(len).fill(-1);
  const kept: Array<{ startLine: number; endLine: number }> = [];
  for (const sp of spans) {
    const s = Math.max(rangeStart, Math.floor(sp.startLine));
    const e = Math.min(rangeEnd, Math.floor(sp.endLine));
    // CONTAINED in this baseline block (==does not cross a def boundary) AND wide enough.
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (sp.startLine < rangeStart || sp.endLine > rangeEnd) continue; // not contained -> skip
    if (e - s + 1 < minSpan) continue; // below the sub-block floor -> absorbed, no tiny block
    kept.push({ startLine: s, endLine: e });
  }
  kept.sort((a, b) => {
    const wa = a.endLine - a.startLine;
    const wb = b.endLine - b.startLine;
    if (wb !== wa) return wb - wa;        // widest first -> narrower paints last (innermost wins)
    return a.startLine - b.startLine;     // deterministic tie-break by ascending line
  });
  for (let ki = 0; ki < kept.length; ki++) {
    const sp = kept[ki];
    if (sp === undefined) continue;
    for (let line = sp.startLine; line <= sp.endLine; line++) owner[line - rangeStart] = ki;
  }
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = rangeStart;
  for (let line = rangeStart + 1; line <= rangeEnd + 1; line++) {
    const prevOwner = owner[line - 1 - rangeStart] ?? -1;
    const curOwner = line <= rangeEnd ? (owner[line - rangeStart] ?? -1) : Number.NaN;
    if (line > rangeEnd || curOwner !== prevOwner) {
      runs.push({ start: runStart, end: line - 1 });
      runStart = line;
    }
  }
  return runs;
}

/**
 * SOFT-split the inclusive range [rangeStart..rangeEnd] at the given candidate hint
 * lines — but ONLY when the range is genuinely oversized (> `minBlock`) and ONLY at a
 * hint where BOTH resulting sides are ≥ `minSide` (M3). Soft hints own no lines: a hint
 * that would shave off a sub-`minSide` sliver is ignored, so a split never produces a
 * piece below the rank-worthy floor. This identical both-sides rule is applied to anchor
 * hints AND import-cluster hints — same helper, so it can never be honoured for one and
 * forgotten for the other. Hints are processed in ascending order against a moving
 * left edge (deterministic), each accepted hint opening the next sub-block.
 */
function softSplitByHints(
  rangeStart: number,
  rangeEnd: number,
  hintLines: readonly number[],
  minBlock: number,
  minSide: number,
): Array<{ start: number; end: number }> {
  if (rangeEnd - rangeStart + 1 <= minBlock) return [{ start: rangeStart, end: rangeEnd }];
  const sorted = [...hintLines].filter((l) => l > rangeStart && l <= rangeEnd).sort((a, b) => a - b);
  const out: Array<{ start: number; end: number }> = [];
  let left = rangeStart;
  for (const h of sorted) {
    const leftSize = h - left;            // [left .. h-1] inclusive -> h - left lines
    const rightSize = rangeEnd - h + 1;   // [h .. rangeEnd] inclusive
    if (leftSize >= minSide && rightSize >= minSide) {
      out.push({ start: left, end: h - 1 });
      left = h;
    }
  }
  out.push({ start: left, end: rangeEnd });
  return out;
}

/**
 * Group top-level import LINES into maximal contiguous CLUSTERS and return the candidate
 * SOFT-split boundaries those clusters imply: the first line of each cluster (separating a
 * preamble from the imports) and the line just after each cluster (separating the imports
 * from the code that follows). Two adjacent imports never produce an interior split — only
 * the cluster's outer edges are offered — which is exactly "group contiguous import lines
 * into clusters" rather than splitting between every import. The boundaries are still only
 * hints: `softSplitByHints` enforces the oversized + both-sides≥MIN rule, so a cluster at a
 * block edge (which would shave a sub-MIN sliver) is simply not acted on. Deduped + sorted
 * for deterministic application.
 */
function importClusterBoundaries(importLines: readonly number[]): number[] {
  const sorted = [...importLines].filter((l) => Number.isFinite(l)).sort((a, b) => a - b);
  const boundaries = new Set<number>();
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    if (start === undefined) { i++; continue; }
    let end = start;
    let j = i + 1;
    while (j < sorted.length) {
      const nxt = sorted[j];
      if (nxt === undefined) break;
      if (nxt === end + 1) { end = nxt; j++; continue; } // contiguous -> extend cluster
      if (nxt === end) { j++; continue; }                // duplicate line -> skip
      break;
    }
    boundaries.add(start);   // split before the cluster (preamble | imports)
    boundaries.add(end + 1); // split after the cluster (imports | following code)
    i = j;
  }
  return [...boundaries].sort((a, b) => a - b);
}

/**
 * Merge tiny sub-blocks (< `TINY_FRAGMENT_LINES`) produced by subdivision into a
 * neighbour, WITHOUT ever erasing a def `startLine` boundary. A sub-block whose start
 * is a def boundary (`protectedStarts`) is the def's SIGNATURE: it is never merged, so a
 * 1–3 line signature stays its own rankable sub-block (and the def boundary survives).
 * Every other tiny fragment is merged into its PREVIOUS sub-block when one exists (the
 * merged block keeps the earlier start, so no boundary moves), else into the NEXT. This
 * prefers keeping the earlier, hard-span/anchored block over a trailing soft fragment.
 * Operates only WITHIN one baseline block's sub-block list, so a merge can never cross a
 * baseline (hence def) boundary. Input sub-blocks are contiguous and ascending; output
 * stays contiguous, ascending, and identical in union.
 */
function mergeTinyFragments(
  subBlocks: ReadonlyArray<{ start: number; end: number }>,
  protectedStarts: ReadonlySet<number>,
): Array<{ start: number; end: number }> {
  if (subBlocks.length <= 1) return subBlocks.map((b) => ({ start: b.start, end: b.end }));
  const merged: Array<{ start: number; end: number }> = [];
  for (const b of subBlocks) {
    const size = b.end - b.start + 1;
    const isProtected = protectedStarts.has(b.start);
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (size < TINY_FRAGMENT_LINES && !isProtected && prev !== undefined) {
      prev.end = b.end; // backward merge: earlier start kept, no boundary erased
      continue;
    }
    merged.push({ start: b.start, end: b.end });
  }
  // A tiny, non-protected LEADING fragment has no predecessor above; fold it forward
  // into the next sub-block (its start is the baseline block start — a gap start here,
  // never a def boundary, since a def-owned block's first sub-block is protected).
  if (merged.length >= 2) {
    const first = merged[0];
    const second = merged[1];
    if (
      first !== undefined &&
      second !== undefined &&
      first.end - first.start + 1 < TINY_FRAGMENT_LINES &&
      !protectedStarts.has(first.start)
    ) {
      second.start = first.start;
      merged.shift();
    }
  }
  return merged;
}

/**
 * TILE THE FILE INTO DEF-ALIGNED BLOCKS — the structural input SageRank needs.
 *
 * The seam receives the whole file as one raw (already `N.`-prefixed) string. One
 * block is useless to SageRank: it ranks BLOCKS by call-graph centrality, and with
 * a single block every call-graph edge collapses to a self-loop, so the structural
 * signal vanishes and nothing is ever eligible to drop. This tiler turns the file
 * into one block per definition (plus blocks for the regions between defs), and then
 * — when `refine` is supplied — subdivides the LARGE def-owned/gap blocks at real
 * fact-backed boundaries so the call graph connects finer units and SageRank can
 * find the important minority inside dense functions too.
 *
 * `defs` are the BASE PARTITION; `refine` only subdivides WITHIN def-owned (and gap)
 * blocks — it NEVER moves a def boundary. Omitting `refine` (the 2-arg call) yields
 * the def-only partition byte-for-byte, the same blocks this function produced before
 * refinement existed (the existing 2-arg callers/tests stay byte-identical).
 *
 * GUARANTEES (the tiling contract — every one is required for line-number fidelity):
 *   • COMPLETE + CONTIGUOUS: every physical line 1..N lands in EXACTLY one block;
 *     blocks are ascending and never overlap. (Without this, the verbatim
 *     reconstruction and the omission accounting downstream break.)
 *   • VERBATIM: each line's ORIGINAL prefixed text is carried unchanged; line
 *     numbers are NEVER recomputed — a block's `startLine` is the true source line.
 *   • EDGE-ALIGNED: every leaf def's `startLine` is exactly a block boundary, so
 *     SageRank's `_factsToASTEdges` resolves caller/callee lines to real block
 *     indices (exact-startLine match), lighting up the call-graph fusion. Subdivision
 *     preserves this: a refinement is honoured only when CONTAINED in one baseline
 *     block, and a baseline block's first sub-block always starts at the block start —
 *     so for a def-owned block that sub-block is the def's signature and keeps its
 *     `startLine`. (Centrality then relocates onto the signature sub-block by design.)
 *   • NESTING via INNERMOST-WINS: when defs nest (a method inside a class), each
 *     line belongs to the SMALLEST def covering it. The outer def's remaining lines
 *     (its header/preamble, gaps between methods) become their own blocks. This is
 *     the class -> preamble + per-method split: each method stays a distinct
 *     rankable unit, which is what the method-to-method call graph needs.
 *
 * FALLBACK: with no usable defs the whole file is returned as ONE block (refinements
 * never create blocks without a def base partition — scopes only carve WITHIN def
 * blocks). SageRank then has nothing to discriminate, removal finds nothing eligible,
 * and the seam honestly returns null ("use raw") — never a fabricated cut.
 */
export function tileByDefs(
  prefixedSource: string,
  defs: readonly DefSpan[],
  refine?: TileRefinements,
): SourceBlock[] {
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

  // The set of def START lines that survived clamping — the INVIOLATE boundaries. A
  // refinement may never produce a partition in which one of these stops being a block
  // start, and the def signature sub-block carrying it is never merged away.
  const defStartSet = new Set<number>();
  for (const sp of spans) defStartSet.add(sp.startLine);

  // Group maximal runs of equal ownership into contiguous baseline blocks, recording
  // each block's owner index (>=0 def, -1 gap). A run of the same owner index becomes
  // one block spanning exactly those lines — the IDENTICAL baseline partition to the
  // pre-refinement tiler; refinement (below) only ever subdivides one of these blocks.
  const baseBlocks: Array<{ start: number; end: number; ownerIdx: number }> = [];
  let runStart = 1;
  for (let line = 2; line <= n + 1; line++) {
    const prevOwner = owner[line - 1] ?? -1;
    const curOwner = line <= n ? (owner[line] ?? -1) : Number.NaN; // NaN at n+1 forces a final flush
    if (line > n || curOwner !== prevOwner) {
      baseBlocks.push({ start: runStart, end: line - 1, ownerIdx: owner[runStart] ?? -1 });
      runStart = line;
    }
  }

  // 2-arg form (or empty refinements): emit the def-only partition byte-identically.
  if (refine === undefined) {
    return baseBlocks.map((b) => sliceBlock(physical, b.start, b.end));
  }

  const scopes = refine.scopes ?? [];
  const injections = refine.injections ?? [];
  const anchors = refine.anchors ?? [];
  const imports = refine.imports ?? [];

  // Subdivide each baseline block. The union of one block's sub-blocks is exactly that
  // block, so concatenating across baseline blocks (in ascending order) keeps the whole
  // partition complete + contiguous + verbatim, with every baseline (def) boundary intact.
  const out: SourceBlock[] = [];
  for (const block of baseBlocks) {
    const size = block.end - block.start + 1;
    const isDef = block.ownerIdx >= 0;

    // Small blocks are never subdivided — below LARGE_BLOCK_LINES there is nothing worth
    // carving, and a whole def/gap stays one rankable unit.
    if (size <= LARGE_BLOCK_LINES) {
      out.push(sliceBlock(physical, block.start, block.end));
      continue;
    }

    // (H4/H5) HARD subdivision. Def-owned blocks subdivide at CONTAINED scopes ∪
    // injections; gap blocks subdivide at CONTAINED injections only (scopes own no
    // module-level lines). Painted widest→narrowest (innermost-wins), tiny spans
    // absorbed by the >= MIN_SUB_BLOCK_LINES floor.
    const hardSpans = isDef ? [...scopes, ...injections] : [...injections];
    let pieces = paintHardSubspans(block.start, block.end, hardSpans, MIN_SUB_BLOCK_LINES);

    // (H5/H6) SOFT subdivision of an OVERSIZED LEFTOVER piece — soft hints own no lines
    // and never make the FIRST cut of a def block (J10: an anchor inside a def block does
    // NOT split THE def block; anchors are for leftovers only). So:
    //   • a GAP block's pieces get import-cluster hints (H5, clusters OUTSIDE defs) AND
    //     anchor hints (H6);
    //   • a DEF block's pieces get anchor hints ONLY when hard subdivision actually carved
    //     it (pieces.length > 1) — i.e. anchors only refine a def's already-separated BODY,
    //     never the whole def block — and never the SIGNATURE piece (the one whose start is
    //     a def boundary), which stays intact so edges keep resolving to it (centrality (i)).
    // BOTH paths only act on a piece > ANCHOR_SPLIT_MIN_BLOCK and only where both resulting
    // sides ≥ MIN_SUB_BLOCK_LINES — the SAME rule, enforced once in softSplitByHints.
    const importBoundaries = importClusterBoundaries(imports.map((im) => Math.floor(im.line)));
    const anchorLines = anchors.map((a) => Math.floor(a.line)).filter((l) => Number.isFinite(l));
    const defWasHardSubdivided = isDef && pieces.length > 1;
    const refined: Array<{ start: number; end: number }> = [];
    for (const piece of pieces) {
      const isSignaturePiece = isDef && defStartSet.has(piece.start);
      let leftovers: Array<{ start: number; end: number }> = [piece];
      if (!isDef && importBoundaries.length > 0) {
        // Import clusters are top-level hints — only OUTSIDE defs (gap blocks). Split at
        // cluster EDGES (M3 both-sides rule), never between two adjacent imports.
        leftovers = leftovers.flatMap((lo) =>
          softSplitByHints(lo.start, lo.end, importBoundaries, ANCHOR_SPLIT_MIN_BLOCK, MIN_SUB_BLOCK_LINES),
        );
      }
      const anchorsAllowed = anchorLines.length > 0 && (!isDef || (defWasHardSubdivided && !isSignaturePiece));
      if (anchorsAllowed) {
        leftovers = leftovers.flatMap((lo) =>
          softSplitByHints(lo.start, lo.end, anchorLines, ANCHOR_SPLIT_MIN_BLOCK, MIN_SUB_BLOCK_LINES),
        );
      }
      for (const lo of leftovers) refined.push(lo);
    }
    pieces = refined;

    // Merge tiny fragments without erasing a def boundary (the signature sub-block,
    // whose start is in defStartSet, is never merged). Then cut verbatim block text.
    const finalPieces = mergeTinyFragments(pieces, defStartSet);
    for (const p of finalPieces) out.push(sliceBlock(physical, p.start, p.end));
  }
  return out;
}


export { compressSource };

// The INPUT contract: the immutable `Source` the consumer fills in. INPUT only —
// no rankings, no engine results, no engine internals leave this module.
export type { Source, SourceBlock };

// Diagnostic re-export only — NOT part of the compression API. Lets measurement/fidelity
// probes (e.g. tests/_tiling-measure.mjs) independently re-verify a returned string with
// the SAME engine the gate uses, instead of re-implementing H1–H7. Surfaces facts the
// engine already computes. The MCP seam is unaffected: compression.ts still imports only
// `compressFile`, so this widens no compression decision out of TOON.
export { verifyOutput } from './removal.js';
export type { RemovalMetadata } from './removal.js';

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
    readonly references: ReadonlyArray<{
      readonly name: string;
      readonly type: string | null;
      readonly line: number;
      readonly endLine: number;
      readonly column: number;
    }>;
    readonly edges: ReadonlyArray<{
      readonly callerLine: number;
      readonly calleeLine: number;
      readonly callCount: number;
    }>;
    readonly referenceEdges: ReadonlyArray<{
      readonly callerLine: number;
      readonly referencedName: string;
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
    }>;
    readonly injections: ReadonlyArray<{
      readonly injectedLang: string;
      readonly startLine: number;
      readonly endLine: number;
    }>;
    readonly scopes: ReadonlyArray<{
      readonly scopeKind: string;
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
    //     for the regions between defs, tiling every line 1..N exactly once, THEN
    //     subdivided WITHIN the large def/gap blocks at the refinement facts
    //     (scopes/injections as hard spans; anchors/imports as soft hints). This is
    //     the structural input SageRank needs — one block per file makes every
    //     call-graph edge a self-loop, so the structural signal (and thus any
    //     eligibility to drop) vanishes; finer fact-backed blocks give it more to
    //     discriminate. tileByDefs preserves line numbers verbatim and keeps every def
    //     start line a block boundary so edges resolve. It is a structural PARTITION of
    //     the given lines, not a ranking — which defs/blocks matter stays SageRank's
    //     decision; the seam only groups lines by the spans the DB already resolved.
    //     With no defs it returns one block -> no discrimination -> honest null (use raw).
    //   • maxChars -> charBudget   • facts.path -> modulePath   • no scan query.
    //   • facts -> Source.facts: forwarded verbatim EXCEPT defs.line -> defs.startLine
    //     (MCP's DB column name -> TOON's coordinate vocabulary). Edges already arrive
    //     RESOLVED + line-keyed from the seam; nothing here re-resolves or re-weights.
    // Kept INSIDE the try so a malformed request degrades to "use raw" too, never throws.
    const blocks = tileByDefs(
      request.source,
      request.facts.defs.map(d => ({ startLine: d.line, endLine: d.endLine })),
      {
        scopes: request.facts.scopes,
        injections: request.facts.injections,
        anchors: request.facts.anchors,
        imports: request.facts.imports,
      },
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
        references: request.facts.references,
        edges: request.facts.edges,
        referenceEdges: request.facts.referenceEdges,
        anchors: request.facts.anchors,
        imports: request.facts.imports,
        injections: request.facts.injections,
        scopes: request.facts.scopes,
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
