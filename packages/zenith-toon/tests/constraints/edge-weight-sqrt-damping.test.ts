// edge-weight-sqrt-damping.test.ts
//
// Regression lock for the `Math.sqrt(callCount)` edge-weight damping — the
// SageRank tuning transform that lives at sagerank.ts `_factsToASTEdges`
// (`weight: Math.sqrt(e.callCount)`, the line that Priority 0.5 names explicitly
// as "Decides edge weighting ... a SageRank tuning concern; lives in TOON").
//
// WHY THIS LIVES IN zenith-toon/tests (not zenith-mcp/tests): compressFile's
// observable output — WHICH lines survive compression — SATURATES for any
// positive edge weight. Math.sqrt(4)=2 and the raw 4 are both "some positive
// weight", so they select the SAME surviving line set, and the transform is
// UNOBSERVABLE through the public seam. The old MCP-level guard
// (review-edge-damping.test.js) therefore leaned on `compressSourceStructured`
// and the `SageRank` class — both since removed from the public API. The
// damping itself still lives in the engine; this test pins it at the ENGINE
// level, where it is both observable and load-bearing, importing directly from
// `../../src/sagerank.js` — the SAME white-box convention `removal-fen-proofs`
// / `removal-scaling-proofs` use for `../../src/removal.js`.
//
// Three lenses (mirroring the original three-lens rigor, expressed against the
// current engine):
//   1. TRANSFORM IS sqrt: `_factsToASTEdges(callCount=N)` emits an edge whose
//      weight is EXACTLY Math.sqrt(N), for N = 1, 2, 4, 9, 16, 100. Direct
//      white-box access to the private transform site — the only place the
//      callCount → weight projection happens. (Accessed via a typed cast, not
//      `as any` per Rule 6; TS `private` is erased at runtime.)
//   2. NOT THE RAW callCount: the same call with callCount=4 emits weight 2,
//      NEVER 4 — guards the EXACT regression this lock exists for (the damping
//      being silently lost across the seam as `weight: e.callCount`).
//   3. LOAD-BEARING through the PUBLIC ranker: `rankWithAST` (public) produces
//      DIFFERENT scores for edge weight 2 vs 4 — so the damped weight genuinely
//      changes SageRank's ranking signal. If this ever becomes equal, the
//      ranker stopped consuming edge weight and the damping no longer matters.
//
// If the sqrt is ever removed or replaced, lenses 1 and 2 fail immediately;
// lens 3 fails if the weight stops reaching the ranker at all.

import { describe, expect, it } from 'vitest';

import { SageRank } from '../../src/sagerank.js';

type ASTEdge = { from: number; to: number; weight: number };
type EdgeFacts = {
  readonly edges: ReadonlyArray<{
    readonly callerLine: number;
    readonly calleeLine: number;
    readonly callCount: number;
  }>;
};
type Block = { readonly startLine: number };

// White-box view of the private transform site. A typed cast (not `as any`:
// Rule 6) — this is a co-located engine regression test and the transform site
// is exactly what we are pinning.
type SageRankInternals = {
  _factsToASTEdges(
    facts: EdgeFacts | undefined,
    blocks: ReadonlyArray<Block>,
  ): ASTEdge[];
};

// Two blocks so caller→callee resolves to two DISTINCT indices (self-loops are
// dropped by _factsToASTEdges). callerLine/calleeLine match the block startLines
// so the exact-match resolution path fires.
const BLOCKS: ReadonlyArray<Block> = [{ startLine: 1 }, { startLine: 5 }];
const FIXED_EDGE = { callerLine: 5, calleeLine: 1 };

// Run callCount through the transform; return the emitted weight, or -1 if the
// edge was dropped (which would itself be a regression for any callCount >= 1).
function emittedWeight(callCount: number): number {
  const sr = new SageRank() as unknown as SageRankInternals;
  const facts: EdgeFacts = { edges: [{ ...FIXED_EDGE, callCount }] };
  const edges = sr._factsToASTEdges(facts, BLOCKS);
  return edges[0]?.weight ?? -1;
}

describe('SageRank edge-weight sqrt damping — weight = Math.sqrt(callCount)', () => {
  // ── Lens 1: the transform is exactly sqrt(callCount) ──────────────────────
  it('emits weight = Math.sqrt(callCount) exactly for perfect squares (4→2, 9→3, 16→4)', () => {
    const cases = [
      { callCount: 4, expected: 2 },
      { callCount: 9, expected: 3 },
      { callCount: 16, expected: 4 },
      { callCount: 100, expected: 10 },
    ];
    for (const { callCount, expected } of cases) {
      expect(emittedWeight(callCount)).toBe(expected);
      // Sanity: the expected value really is Math.sqrt(callCount).
      expect(Math.sqrt(callCount)).toBe(expected);
    }
  });

  it('emits weight = Math.sqrt(callCount) for non-squares too — proving sqrt, not a table', () => {
    // callCount = 1 is the identity point (sqrt(1) = 1): no damping, no inflation.
    expect(emittedWeight(1)).toBe(1);
    // callCount = 2: weight is the irrational √2, proving the transform is sqrt
    // (not a "divide by 2" approximation, not a lookup, not floor(sqrt)).
    const w = emittedWeight(2);
    expect(w).toBeCloseTo(Math.sqrt(2), 10);
    expect(w * w).toBeCloseTo(2, 10);
    // callCount = 3 likewise: √3, irrational.
    expect(emittedWeight(3)).toBeCloseTo(Math.sqrt(3), 10);
  });

  // ── Lens 2: NOT the raw callCount — guards the exact lost-damping regression ──
  it('damps — never emits the raw callCount as the weight (callCount=4 → 2, not 4)', () => {
    // The regression this locks: `weight: e.callCount` instead of
    // `weight: Math.sqrt(e.callCount)`. Raw 4 must NOT appear.
    expect(emittedWeight(4)).not.toBe(4);
    expect(emittedWeight(4)).toBe(2);
    // Larger counts are damped too: 16 → 4 (not 16), 100 → 10 (not 100).
    expect(emittedWeight(16)).not.toBe(16);
    expect(emittedWeight(100)).not.toBe(100);
  });

  it('drops non-positive / non-finite callCounts (no zero-weight or NaN edges leak)', () => {
    // Mirrors the guard at the transform site: `if (!Number.isFinite(e.callCount)
    // || e.callCount <= 0) continue;`. A zero/NaN/Infinity weight would corrupt
    // the ranker, so these must produce NO edge.
    const sr = new SageRank() as unknown as SageRankInternals;
    const bad = [0, -1, NaN, Infinity, -Infinity];
    for (const callCount of bad) {
      const edges = sr._factsToASTEdges(
        { edges: [{ ...FIXED_EDGE, callCount }] },
        BLOCKS,
      );
      expect(edges.length, `callCount=${callCount} must produce no edge`).toBe(0);
    }
  });

  // ── Lens 3: the (damped) weight is load-bearing in the PUBLIC ranker ──────
  it('rankWithAST (public) yields different scores for weight 2 vs 4 — damping changes the signal', () => {
    // Distinct block texts so the text-similarity graph is non-trivial and the
    // AST edge is a real perturbation, not the only signal.
    const sentences = [
      'function alpha computes the rolling sum over input batches',
      'function beta validates the configuration and throws on error',
      'function gamma renders the dashboard widgets for the user',
      'function delta serializes records into the wire protocol frames',
      'function epsilon schedules background jobs on the worker pool',
      'function zeta caches lookups and evicts least recently used',
    ];
    const sr = new SageRank();
    // Two callers point at node 0 — the edge whose weight we vary.
    const edgesAt = (weight: number): ASTEdge[] => [
      { from: 1, to: 0, weight },
      { from: 2, to: 0, weight },
      { from: 3, to: 4, weight: 1 },
    ];
    const damped = sr.rankWithAST(sentences, sentences.length, edgesAt(2)); // Math.sqrt(4)
    const raw = sr.rankWithAST(sentences, sentences.length, edgesAt(4)); // un-damped

    expect(damped.scores).toBeDefined();
    expect(raw.scores).toBeDefined();
    // The engine treats weight 2 and 4 as different signals → sqrt(4)=2 is a
    // genuinely different input than the raw 4. If this ever becomes equal, the
    // ranker stopped consuming edge weight and the damping is no longer
    // load-bearing (the regression the original review-edge-damping caught).
    expect(damped.scores).not.toEqual(raw.scores);
  });
});
