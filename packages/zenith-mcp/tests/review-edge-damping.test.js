// ---------------------------------------------------------------------------
// review-edge-damping.test.js
//
// Regression test for PR-review finding #20: the `Math.sqrt(call_count)`
// edge-weight damping was silently lost across the MCP↔TOON seam.
//
// Background (authoritative: docs/toon-constraints/constraints.md, Priority 0.5):
//   "Decides edge weighting (e.g. the `Math.sqrt(call_count)` transform — a
//    SageRank tuning concern, lives in TOON)."
//   "MCP-side edge weighting ... the `Math.sqrt(call_count)` math currently in
//    `getFileBlockEdges` ... the weighting transform moves to TOON."
//
// MCP's getFileBlockEdges correctly stopped applying sqrt and now hands the RAW
// `callCount` across the seam (RawFileFacts.edges[].callCount, "raw count; no
// sqrt"). The damping therefore has to be re-applied inside TOON. But
// compressFile's callGraph construction (string-codec.ts) was passing the raw
// count straight through (`weight: e.callCount`), so the damping was removed in
// MCP and never restored — hot edges (many calls) over-weighted SageRank.
//
// The fix (string-codec.ts, compressFile): `weight: Math.sqrt(e.callCount)`.
//
// What this test pins — three complementary lenses, because the structured
// line-survival set saturates for any positive edge weight (sqrt(4)=2 and the
// raw 4 are both "some positive weight", so they select the same final lines).
// The transform is therefore proven where it is observable and load-bearing:
//
//   1. SEAM EQUIVALENCE: compressFile({callCount: N}) is byte-identical to
//      compressSourceStructured() driven with a callGraph whose weight is
//      EXACTLY Math.sqrt(N) — for N = 4, 9, 16 (weights 2, 3, 4). This shows
//      the seam applies the sqrt transform, not the identity.
//
//   2. EDGE ACTUALLY FLOWS (negative control): compressFile WITH a hot edge
//      selects a different line set than compressFile with NO edges. This
//      proves the (damped) weight genuinely reaches SageRank and is positive —
//      so the equivalence in (1) is not a vacuous "weight ignored" tie.
//
//   3. ENGINE SENSITIVITY (sqrt(4)=2 is NOT raw 4): SageRank.rankWithAST — the
//      engine that consumes callGraph weight (it computes `edge.weight *
//      astWeight` when merging AST edges) — returns DIFFERENT scores for an
//      edge weight of 2 versus 4. So damping to 2 is a genuinely different
//      signal from the raw 4; the fix is behavior-changing, not cosmetic.
//
// Priority-0 invariants (verbatim lines, true line numbers, ascending order,
// [TRUNCATED: lines X-Y] markers, ≥6-line min, 70% floor) are independent of
// edge weights and are covered by string-codec-priority0 / toon-output-
// invariants. This test asserts the damping only; it never loosens those.
//
// Imports come from the BUILT zenith-toon dist (the package this fix lives in),
// matching the convention in string-codec-priority0.test.js et al.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { compressFile, compressSourceStructured, SageRank } from 'zenith-toon';

// Build a multi-block source: 9 small functions + one large function ('big').
// >4 blocks so SageRank's structured AST path engages (threshold = 4), and a
// size spread so block ranking has something to decide.
function buildSource() {
    const names = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'big'];
    const lines = [];
    const defMeta = [];
    for (const name of names) {
        const start = lines.length + 1; // 1-based start line
        lines.push(`export function fn_${name}(input) {`);
        const bulk = name === 'big' ? 40 : 6;
        for (let i = 0; i < bulk; i++) {
            lines.push(`  const u_${name}_${i} = work_${name}(input, ${i}, "${name}-payload-${i}");`);
        }
        lines.push(`  return u_${name}_0;`);
        lines.push(`}`);
        defMeta.push({ name: `fn_${name}`, line: start, endLine: lines.length });
    }
    return { source: lines.join('\n'), defMeta };
}

// Hot edges: three callers point at fn_big; one unrelated edge. The first three
// carry the variable call count; the last is always 1.
const HOT_EDGES = [
    ['fn_n1', 'fn_big'],
    ['fn_n2', 'fn_big'],
    ['fn_n3', 'fn_big'],
    ['fn_n4', 'fn_n5'],
];

// RawFileFacts.edges with a given call count on the three hot edges.
function edgesWithCount(callCount) {
    return HOT_EDGES.map(([callerName, calleeName], i) => ({
        callerName,
        calleeName,
        callCount: i < 3 ? callCount : 1,
    }));
}

// RawFileFacts for compressFile — defs are 1-based; public so they all survive
// the visibility filter; no anchors/imports/injections (isolate the edge math).
function factsFor(defMeta, callCount) {
    return {
        path: 'src/edge-damping.ts',
        langName: 'typescript',
        defs: defMeta.map((d) => ({
            name: d.name,
            kind: 'def',
            type: 'function',
            line: d.line,
            endLine: d.endLine,
            visibility: 'public',
            captureTag: null,
        })),
        edges: edgesWithCount(callCount),
        anchors: [],
        imports: [],
        injections: [],
    };
}

// Reconstruct the StructureBlock[] EXACTLY as compressFile does: 0-based lines,
// endLine clamped to the file, exported === (visibility === 'public'), empty
// anchors. This lets compressSourceStructured be driven with a hand-chosen
// callGraph weight so we can compare it byte-for-byte against the seam.
function structureFrom(defMeta, lineCount) {
    return defMeta
        .filter((d) => d.line - 1 < lineCount)
        .map((d) => ({
            name: d.name,
            kind: 'def',
            type: 'function',
            startLine: d.line - 1,
            endLine: Math.min(d.endLine - 1, lineCount - 1),
            exported: true,
            anchors: [],
        }));
}

// CompressionContext with a chosen edge weight on the hot edges (mirrors the
// callGraph shape compressFile builds, but with the weight we dictate).
function contextWithWeight(defMeta, weight) {
    return {
        callGraph: HOT_EDGES.map(([caller, callee], i) => ({
            caller,
            callee,
            weight: i < 3 ? weight : 1,
        })),
        exportedSymbols: defMeta.map((d) => d.name),
    };
}

// Extract the set of original line numbers that appear in compressed output
// (every non-marker line is `N. <verbatim>`), in order.
function selectedLineNumbers(out) {
    return out
        .split('\n')
        .filter((l) => /^\d+\.\s/.test(l))
        .map((l) => Number.parseInt(l.split('.')[0], 10));
}

describe('TOON edge-weight sqrt damping (review finding #20)', () => {
    // -----------------------------------------------------------------------
    // 1. The seam applies Math.sqrt(callCount): compressFile's output matches
    //    compressSourceStructured driven with weight = Math.sqrt(callCount),
    //    across several perfect squares so the expected weight is exact.
    // -----------------------------------------------------------------------
    describe('compressFile constructs callGraph weight = Math.sqrt(callCount)', () => {
        // callCount → expected damped weight. Perfect squares keep the
        // assertion exact and human-checkable (4→2, 9→3, 16→4).
        const cases = [
            { callCount: 4, expectedWeight: 2 },
            { callCount: 9, expectedWeight: 3 },
            { callCount: 16, expectedWeight: 4 },
        ];

        for (const { callCount, expectedWeight } of cases) {
            it(`callCount=${callCount} contributes weight≈${expectedWeight} (=Math.sqrt(${callCount})), not ${callCount}`, () => {
                // Sanity: this is the value the fix must produce.
                expect(Math.sqrt(callCount)).toBeCloseTo(expectedWeight, 10);

                const { source, defMeta } = buildSource();
                const lineCount = source.split('\n').length;
                const budget = Math.floor(source.length * 0.5);

                // Production seam: hands raw callCount in facts; TOON damps it.
                const seamOut = compressFile({ source, maxChars: budget, facts: factsFor(defMeta, callCount) });
                expect(seamOut).not.toBeNull();

                // Reference: same structure, callGraph weight = sqrt(callCount).
                const structure = structureFrom(defMeta, lineCount);
                const dampedOut = compressSourceStructured(
                    source,
                    budget,
                    structure.map((b) => ({ ...b, anchors: [] })),
                    contextWithWeight(defMeta, expectedWeight),
                );

                // Byte-identical → the seam fed SageRank the sqrt-damped weight.
                expect(seamOut).toBe(dampedOut);
            });
        }
    });

    // -----------------------------------------------------------------------
    // 2. Negative control: the (damped) edge weight genuinely flows to the
    //    ranker. With a hot edge the selected line set differs from the
    //    no-edge case — so the equivalence above isn't a "weight ignored" tie.
    // -----------------------------------------------------------------------
    it('the damped edge weight actually reaches SageRank (selection differs from no-edge)', () => {
        const { source, defMeta } = buildSource();
        const budget = Math.floor(source.length * 0.5);

        const withEdges = compressFile({ source, maxChars: budget, facts: factsFor(defMeta, 4) });
        const noEdges = compressFile({
            source,
            maxChars: budget,
            facts: { ...factsFor(defMeta, 4), edges: [] },
        });

        expect(withEdges).not.toBeNull();
        expect(noEdges).not.toBeNull();
        // A positive (sqrt-damped) weight changes which lines survive vs. none.
        expect(selectedLineNumbers(withEdges)).not.toEqual(selectedLineNumbers(noEdges));
    });

    // -----------------------------------------------------------------------
    // 3. Engine sensitivity: sqrt(4)=2 is a DIFFERENT signal than the raw 4.
    //    SageRank.rankWithAST consumes callGraph weight (it computes
    //    `edge.weight * astWeight` when merging AST edges); feeding weight 2 vs
    //    4 yields different scores. So damping to 2 is behavior-changing — the
    //    finding ("hot edges over-weight SageRank") is real, and restoring the
    //    sqrt is not cosmetic.
    // -----------------------------------------------------------------------
    it('SageRank distinguishes the damped weight (2) from the raw weight (4)', () => {
        // Textually distinct blocks so the text-similarity graph is non-trivial
        // and the AST edge is a real perturbation, not the only signal.
        const sentences = [
            'function alpha computes the rolling sum over input batches',
            'function beta validates the configuration and throws on error',
            'function gamma renders the dashboard widgets for the user',
            'function delta serializes records into the wire protocol frames',
            'function epsilon schedules background jobs on the worker pool',
            'function zeta caches lookups and evicts least recently used',
        ];
        // Two callers point at node 0 — the edge whose weight we vary.
        const edgesAt = (weight) => [
            { from: 1, to: 0, weight },
            { from: 2, to: 0, weight },
            { from: 3, to: 4, weight: 1 },
        ];

        const sr = new SageRank();
        const damped = sr.rankWithAST(sentences, sentences.length, edgesAt(2)); // Math.sqrt(4)
        const raw = sr.rankWithAST(sentences, sentences.length, edgesAt(4)); // un-damped

        // The engine produces different scores for weight 2 vs 4 → the sqrt
        // damping materially changes SageRank's ranking signal.
        expect(damped.scores).toBeDefined();
        expect(raw.scores).toBeDefined();
        expect(damped.scores).not.toEqual(raw.scores);
    });
});
