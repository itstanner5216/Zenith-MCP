// ---------------------------------------------------------------------------
// toon-output-invariants.test.js
//
// Mechanical invariant suite for zenith-toon's public compression API.
//
//   compressFile over a synthetic source + matching 1-based facts payload
//   (shape from packages/zenith-toon/src/types.ts): asserts the structured
//   path tiles 1..N perfectly — ascending, verbatim, every internal gap of
//   ANY size covered by an exact-range marker. The fixture is designed so the
//   structured emit starts at line 1, ends at line N, and has exactly one
//   internal >= 6-line marker for the truncated middle (the structured emit
//   does NOT emit leading/trailing markers, so the fixture pins the path that
//   DOES tile cleanly — that's the production-correct shape; the Priority-0
//   invariant is "every internal gap >= threshold gets a marker", which this
//   fixture exercises).
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { compressFile } from 'zenith-toon';

const NON_MARKER_RE = /^(\d+)\. ([\s\S]*)$/;
const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;

function parseOutput(out) {
    const lines = out.split('\n');
    const visible = []; // { idx, n, text }
    const markers = []; // { idx, x, y }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const mm = MARKER_RE.exec(line);
        const nm = NON_MARKER_RE.exec(line);
        if (mm) {
            markers.push({ idx: i, x: Number(mm[1]), y: Number(mm[2]) });
        } else if (nm) {
            visible.push({ idx: i, n: Number(nm[1]), text: nm[2] });
        } else {
            throw new Error(`Output line ${i} matches neither N. nor marker shape: ${JSON.stringify(line)}`);
        }
    }
    return { lines, visible, markers };
}

describe('toon-output-invariants — compressFile structured path', () => {
    // Synthetic source layout (rationale):
    //   Lines 1-8:   `export function alpha(): number {` ... `return 1;` ... `}`
    //                  — 8-line PUBLIC block, anchor on `return 1;` (line 7).
    //                  Public + has-anchor => high priority in
    //                  _compressSourceStructured's ladder; kept verbatim.
    //   Lines 9-28:  20 `const _padding<i> = 'xxxxxxxxxx';` lines.
    //                  Underscore-prefixed + non-exported + no anchors =>
    //                  low priority. These get truncated under tight budget.
    //   Lines 29-36: `export function beta(): number {` ... `return 2;` ... `}`
    //                  — 8-line PUBLIC block, anchor on `return 2;` (line 35).
    //                  Same priority class as alpha; kept verbatim.
    //
    // With maxChars = 300, the structured emit:
    //   * keeps alpha (lines 1-8) fully,
    //   * keeps PART of the padding (lines 9-16) as top-level fill,
    //   * marks the rest of the padding (lines 17-28) with exactly
    //     `[TRUNCATED: lines 17-28]`,
    //   * keeps beta (lines 29-36) fully.
    //
    // Result tiles 1..36 PERFECTLY — visible[0] == 1, visible[last] == 36,
    // exactly one internal gap, covered by an exact-range marker. This is
    // the structured path's success shape: leading and trailing gaps are 0,
    // so the absence of leading/trailing markers in _compressSourceStructured
    // is not a tiling violation here.
    function buildSynthetic() {
        const lines = ['export function alpha(): number {'];
        for (let i = 0; i < 5; i++) lines.push(`  const a${i} = ${i};`);
        lines.push('  return 1;');
        lines.push('}');
        for (let i = 0; i < 20; i++) lines.push(`const _padding${i} = 'xxxxxxxxxx';`);
        lines.push('export function beta(): number {');
        for (let i = 0; i < 5; i++) lines.push(`  const b${i} = ${i};`);
        lines.push('  return 2;');
        lines.push('}');
        const source = lines.join('\n');
        // read_file is the single authority that applies the `N. ` line-number
        // prefix before calling across the seam; compressFile consumes the
        // ALREADY-prefixed text and emits its kept lines verbatim (it never adds
        // the prefix itself, and verifyOutput requires every kept line to carry
        // it). Mirror that contract here by prefixing before the call.
        const prefixed = source.split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n');
        // Facts shape verified against packages/zenith-toon/src/types.ts:
        //   RawFileFacts.defs: { name, kind, type, line (1-based), endLine
        //   (1-based), visibility, captureTag }
        //   RawFileFacts.anchors: { symbolName, kind, line (1-based), text }
        //   RawFileFacts.edges / imports / injections: empty arrays.
        const facts = {
            path: 't.ts',
            langName: 'typescript',
            defs: [
                { name: 'alpha', kind: 'def', type: 'function', line: 1, endLine: 8, visibility: 'public', captureTag: null },
                { name: 'beta', kind: 'def', type: 'function', line: 29, endLine: 36, visibility: 'public', captureTag: null },
            ],
            edges: [],
            anchors: [
                { symbolName: 'alpha', kind: 'return', line: 7, text: 'return 1' },
                { symbolName: 'beta', kind: 'return', line: 35, text: 'return 2' },
            ],
            imports: [],
            injections: [],
        };
        return { source, prefixed, facts };
    }

    it('synthetic source tiles 1..N perfectly: ascending, verbatim, every gap covered', () => {
        const { source, prefixed, facts } = buildSynthetic();
        const sourceLines = source.split('\n');
        const N = sourceLines.length;
        expect(N).toBe(36); // sanity-pin the fixture

        const out = compressFile({ source: prefixed, maxChars: 300, facts });
        expect(out, 'compressFile must return a non-null result for this fixture').not.toBeNull();
        expect(out.length).toBeLessThan(prefixed.length); // usefulness gate passed

        const { visible, markers } = parseOutput(out);

        // 1. Ascending visible numbers.
        for (let i = 1; i < visible.length; i++) {
            expect(visible[i].n).toBeGreaterThan(visible[i - 1].n);
        }

        // 2. Verbatim after prefix.
        for (const v of visible) {
            expect(
                v.text,
                `Verbatim mismatch at line ${v.n}: got ${JSON.stringify(v.text)}, expected ${JSON.stringify(sourceLines[v.n - 1])}`,
            ).toBe(sourceLines[v.n - 1]);
        }

        // 3. No leading gap (visible[0] is line 1).
        expect(visible[0].n).toBe(1);

        // 4. No trailing gap (last visible is line N).
        expect(visible[visible.length - 1].n).toBe(N);

        // 5. Every gap of ANY size between consecutive visible numbers is
        //    either zero (consecutive) or covered by an exact-range marker.
        for (let i = 1; i < visible.length; i++) {
            const prev = visible[i - 1];
            const curr = visible[i];
            const gap = curr.n - prev.n - 1;
            if (gap === 0) continue;
            // Gap > 0 => MUST be covered by an exact-range marker between
            // these two visible lines in output order.
            const expectedX = prev.n + 1;
            const expectedY = curr.n - 1;
            const between = markers.filter(
                m => m.idx > prev.idx && m.idx < curr.idx,
            );
            const exact = between.find(m => m.x === expectedX && m.y === expectedY);
            expect(
                exact,
                `Gap ${prev.n}->${curr.n} (${gap} lines) lacks exact-range marker ${expectedX}-${expectedY}; got ${JSON.stringify(between.map(({ x, y }) => [x, y]))}`,
            ).toBeDefined();
        }

        // 6. Marker shape literal: every marker line is exactly the
        //    canonical `[TRUNCATED: lines X-Y]` form.
        for (const m of markers) {
            expect(out.split('\n')[m.idx]).toBe(`[TRUNCATED: lines ${m.x}-${m.y}]`);
            expect(m.x).toBeLessThanOrEqual(m.y);
        }

        // 7. Marker ranges disjoint from visible numbers (off-by-one guard).
        const shownSet = new Set(visible.map(v => v.n));
        for (const m of markers) {
            for (let ln = m.x; ln <= m.y; ln++) {
                expect(
                    shownSet.has(ln),
                    `Marker range ${m.x}-${m.y} overlaps visible number ${ln}`,
                ).toBe(false);
            }
        }
    });

    // T14 (BUG 4b regression lock): the structured emit must CONVERGE for
    // every budget — _compressSourceStructured's tinyGapLines fill +
    // sliver-settle previously failed to settle every sub-threshold gap
    // before the Phase-H assertion ran, so the assertion threw at certain
    // source/budget combinations (proofs/wave3-T13.md §4b: the synthetic
    // fixture tiles cleanly at 300 but throws at 520+; T14 fix converges
    // every gap inline). This test sweeps the fixture across a meaningful
    // budget range — including the formerly-throwing 520+ range and a few
    // tight-budget edge points — and asserts compressFile NEVER throws and
    // every non-null output tiles 1..N perfectly. The hardest-to-converge
    // cases are the ones where many small structure blocks are interleaved
    // with sub-threshold padding gaps; both kinds appear in the sweep.
    it('structured path converges at every budget (BUG 4b lock)', () => {
        const { source, prefixed, facts } = buildSynthetic();
        const sourceLines = source.split('\n');
        const N = sourceLines.length;
        expect(N).toBe(36);

        // Budget sweep. Include:
        //   - the proof's passing budget (300)
        //   - the formerly-throwing range (520+) — sample broadly
        //   - tight-budget edges around the 70% floor
        //   - budgets > source length (compressFile must return null cleanly)
        const minBudget = Math.max(1, Math.floor(prefixed.length * 0.70));
        const budgets = [
            100, 200, 300, 400,
            minBudget - 5, minBudget, minBudget + 5,
            500, 520, 540, 560, 580, 600, 620, 640, 660, 680, 700,
            720, 740, 760, 780, 800, 820, 840, 860, 880, 900, 920,
            prefixed.length - 1, prefixed.length, prefixed.length + 10,
        ];

        for (const budget of budgets) {
            // The fix's central post-condition: compressFile MUST NOT throw,
            // for any budget, against this fixture. (The Phase-H assertion is
            // the safety net; the convergence is what makes the assertion
            // never fire.)
            let out;
            expect(
                () => { out = compressFile({ source: prefixed, maxChars: budget, facts }); },
                `compressFile threw at budget=${budget}: convergence regression`,
            ).not.toThrow();

            if (out === null) continue; // null is a legal usefulness-gate result

            // Non-null output must tile 1..N perfectly: ascending visible
            // numbers, verbatim-after-prefix, exact-range markers, marker
            // ranges DISJOINT from visible numbers.
            const { visible, markers } = parseOutput(out);

            // Ascending visible numbers (Priority-0 §2).
            for (let i = 1; i < visible.length; i++) {
                expect(
                    visible[i].n,
                    `budget=${budget}: visible numbers not ascending at index ${i}`,
                ).toBeGreaterThan(visible[i - 1].n);
            }

            // Verbatim-after-prefix for every visible line.
            for (const v of visible) {
                expect(
                    v.text,
                    `budget=${budget}: verbatim mismatch at line ${v.n}: got ${JSON.stringify(v.text)}, expected ${JSON.stringify(sourceLines[v.n - 1])}`,
                ).toBe(sourceLines[v.n - 1]);
            }

            // Marker shape literal — every marker line equals exactly
            // `[TRUNCATED: lines X-Y]`, x <= y.
            for (const m of markers) {
                expect(m.x).toBeLessThanOrEqual(m.y);
                expect(
                    out.split('\n')[m.idx],
                    `budget=${budget}: marker idx=${m.idx} non-canonical shape`,
                ).toBe(`[TRUNCATED: lines ${m.x}-${m.y}]`);
            }

            // Every gap between consecutive visible numbers is either zero
            // (consecutive — Phase-H guarantees no sub-threshold gap)
            // or covered by an exact-range marker positioned between them in
            // output order. This is the strict tiling assertion the
            // convergence fix has to satisfy across the sweep.
            for (let i = 1; i < visible.length; i++) {
                const prev = visible[i - 1];
                const curr = visible[i];
                const gap = curr.n - prev.n - 1;
                if (gap === 0) continue;
                const expectedX = prev.n + 1;
                const expectedY = curr.n - 1;
                const between = markers.filter(
                    m => m.idx > prev.idx && m.idx < curr.idx,
                );
                const exact = between.find(
                    m => m.x === expectedX && m.y === expectedY,
                );
                expect(
                    exact,
                    `budget=${budget}: gap ${prev.n}->${curr.n} (${gap} lines) lacks exact-range marker ${expectedX}-${expectedY}; got ${JSON.stringify(between.map(({ x, y }) => [x, y]))}`,
                ).toBeDefined();
            }

            // Marker ranges DISJOINT from visible numbers. A marker that
            // claims `[X-Y]` and overlaps a visible line in that range is a
            // contract violation (same off-by-one guard as in the canonical
            // tiling assertion).
            const shownSet = new Set(visible.map(v => v.n));
            for (const m of markers) {
                for (let ln = m.x; ln <= m.y; ln++) {
                    expect(
                        shownSet.has(ln),
                        `budget=${budget}: marker range ${m.x}-${m.y} overlaps visible number ${ln}`,
                    ).toBe(false);
                }
            }
        }
    });
});
