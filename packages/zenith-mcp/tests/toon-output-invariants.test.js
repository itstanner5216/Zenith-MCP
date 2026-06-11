// ---------------------------------------------------------------------------
// toon-output-invariants.test.js
//
// Mechanical invariant suite for zenith-toon's public string/compress API.
//
// Two layers:
//   1. compressString over the four stack-trace fixtures from
//      tests/stack-trace-detection.test.js (verbatim copies of the inputs):
//      asserts the Priority-0 tiling rule (no unmarked internal gaps of any
//      size, except the documented Python STOP case from proofs/wave1-T4.md),
//      verbatim mapping, ascending visible numbers, exact marker shape, and
//      header preservation. The Python STOP — selection [0,1,2,3,7], one
//      3-line internal sub-threshold unmarked gap, both headers (line 1
//      Traceback, line 8 ValidationError) preserved — is PINNED here so a
//      future "fix" that restores tiling by dropping a header fails loudly.
//
//   2. compressFile over a synthetic source + matching 1-based facts payload
//      (shape from packages/zenith-toon/src/types.ts): asserts the structured
//      path tiles 1..N perfectly — ascending, verbatim, every internal gap of
//      ANY size covered by an exact-range marker. The fixture is designed so
//      _compressSourceStructured's output starts at line 1, ends at line N,
//      and has exactly one internal ≥ 6-line marker for the truncated middle
//      (the structured emit does NOT emit leading/trailing markers, so the
//      fixture pins the path that DOES tile cleanly — that's the
//      production-correct shape; the Priority-0 invariant is "every internal
//      gap >= threshold gets a marker", which this fixture exercises).
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { compressString, compressFile } from 'zenith-toon';

const NON_MARKER_RE = /^(\d+)\. ([\s\S]*)$/;
const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const _MIN_OMISSION_THRESHOLD = 6;

// --- Stack-trace fixtures — copied VERBATIM from tests/stack-trace-detection.test.js. ---
// The verbatim copy is intentional: those four fixtures are the ground truth
// the Wave-1 T4 work was sized against; the invariant suite must pin the
// SAME inputs the test it grew out of pins. Any change here without a matching
// change in stack-trace-detection.test.js would let the two suites drift.
const STACK_FIXTURES = {
    'javascript-error': {
        input: `TypeError: Cannot read properties of null (reading 'map')
    at processItems (/app/src/utils.js:42:15)
    at handleRequest (/app/src/server.js:108:9)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:144:13)
    at Route.dispatch (/app/node_modules/express/lib/router/route.js:114:3)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at /app/node_modules/express/lib/router/index.js:284:15
    at Function.process_params (/app/node_modules/express/lib/router/index.js:346:12)`,
        budget: 100,
    },
    'python-traceback': {
        input: `Traceback (most recent call last):
  File "/app/main.py", line 42, in handle_request
    result = process_data(payload)
  File "/app/processor.py", line 18, in process_data
    validated = schema.validate(data)
  File "/app/schema.py", line 7, in validate
    raise ValidationError("Invalid field")
ValidationError: Invalid field`,
        budget: 100,
    },
    'jvm-chained': {
        input: `java.lang.RuntimeException: Failed to initialize
    at com.app.Server.start(Server.java:42)
    at com.app.Main.main(Main.java:10)
Caused by: java.sql.SQLException: Connection refused
    at com.mysql.Driver.connect(Driver.java:88)
    at com.app.Database.getConnection(Database.java:33)
    at com.app.Server.initDb(Server.java:38)`,
        budget: 100,
    },
    'chained-headers-boundary': {
        input: `NullPointerException: value was null
Caused by: IllegalStateException: service not initialized
Some additional context message here`,
        budget: 10,
    },
};

// Header-line detection — matches the production stack-header signal used by
// _STACK_HEADER_RE in string-codec.ts (line 29):
//   /^(?:Traceback \(most recent call last\):|Caused by:\s|[\w.$]+(?:Error|Exception|Fault|Panic)(?::|$))/
// PLUS "first line is always a header" (the production preserves it as the
// primary exception header in every fixture). Indented frame lines that
// happen to contain 'Error' (e.g. Python's `    raise ValidationError(...)`)
// are NOT headers: they are frames. This matches the proofs/wave1-T4.md STOP
// arithmetic where Python's headers are line 1 (Traceback) and line 8
// (ValidationError) — not the indented `raise ValidationError(...)` frame.
function isExceptionHeader(line, isFirst) {
    if (isFirst) return true;
    if (/^\s/.test(line)) return false; // indented => frame, never a header
    if (/^Traceback/.test(line)) return true;
    if (/^Caused by/.test(line)) return true;
    if (/^[\w.$]+(?:Error|Exception|Fault|Panic)(?::|$)/.test(line)) return true;
    return false;
}

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

describe('toon-output-invariants — compressString over stack-trace fixtures', () => {
    for (const [name, { input, budget }] of Object.entries(STACK_FIXTURES)) {
        it(`${name}: tiling, verbatim, headers, ascending`, () => {
            const inputLines = input.split('\n');
            const out = compressString(input, budget);
            const { visible, markers } = parseOutput(out);

            // Visible numbers strictly ascending (Priority-0 §2).
            for (let i = 1; i < visible.length; i++) {
                expect(visible[i].n).toBeGreaterThan(visible[i - 1].n);
            }

            // Every non-marker line equals `${n}. ` + verbatim input line n.
            // The SHOWN_RE / NON_MARKER_RE captures `text` from `^(\d+)\. (.*)$`,
            // so `text` is the literal post-prefix content; comparing it to
            // `inputLines[n - 1]` is the exact verbatim check.
            for (const v of visible) {
                const expected = inputLines[v.n - 1];
                expect(
                    v.text,
                    `Verbatim mismatch at line ${v.n} in ${name}: got ${JSON.stringify(v.text)}, expected ${JSON.stringify(expected)}`,
                ).toBe(expected);
            }

            // Markers' literal shape — every marker line equals exactly the
            // canonical `[TRUNCATED: lines X-Y]` form (Y >= X). The parse
            // already matched MARKER_RE, but we re-assert the literal so a
            // future regression that adds e.g. indentation, a trailing
            // newline, or any other annotation fails loudly.
            for (const m of markers) {
                expect(m.x).toBeLessThanOrEqual(m.y);
                expect(out.split('\n')[m.idx]).toBe(`[TRUNCATED: lines ${m.x}-${m.y}]`);
            }

            // Marker ranges ascending and disjoint from each other.
            const shownSet = new Set(visible.map(v => v.n));
            let prevHi = 0;
            for (const m of markers) {
                expect(m.x).toBeGreaterThan(prevHi);
                prevHi = m.y;
                // Marker ranges must not overlap a shown line number — the
                // marker literal claims those lines are NOT in the output, so
                // a shown number inside the range is a contract violation.
                for (let ln = m.x; ln <= m.y; ln++) {
                    expect(
                        shownSet.has(ln),
                        `Marker range ${m.x}-${m.y} in ${name} overlaps visible number ${ln}`,
                    ).toBe(false);
                }
            }

            // Every internal gap >= _MIN_OMISSION_THRESHOLD between consecutive
            // visible numbers MUST be covered by an exact-range marker
            // `lines [prev + 1, next - 1]` positioned between them.
            for (let i = 1; i < visible.length; i++) {
                const prev = visible[i - 1];
                const curr = visible[i];
                const gap = curr.n - prev.n - 1;
                if (gap >= _MIN_OMISSION_THRESHOLD) {
                    const expectedX = prev.n + 1;
                    const expectedY = curr.n - 1;
                    const between = markers.filter(
                        m => m.idx > prev.idx && m.idx < curr.idx,
                    );
                    const exact = between.find(m => m.x === expectedX && m.y === expectedY);
                    expect(
                        exact,
                        `${name}: gap ${prev.n}->${curr.n} (${gap} lines) missing exact-range marker ${expectedX}-${expectedY}; got ${JSON.stringify(between.map(({ x, y }) => [x, y]))}`,
                    ).toBeDefined();
                }
            }

            // TRAILING omission has a marker REGARDLESS of size. The wave-1
            // fixup ruling (proofs/wave1-T4.md FIX 2 part D) explicitly
            // relaxed the trailing-marker emission threshold to >= 1 — so a
            // single missing trailing line must still produce a marker. If
            // the visible end IS the input end there is no trailing
            // omission; otherwise the very last output line must be a
            // `[TRUNCATED: lines X-Y]` marker that covers exactly
            // [last_visible + 1, input.lines].
            if (visible.length > 0) {
                const lastVisible = visible[visible.length - 1].n;
                const totalLines = inputLines.length;
                if (lastVisible < totalLines) {
                    const expectedX = lastVisible + 1;
                    const expectedY = totalLines;
                    const trailingMarker = markers[markers.length - 1];
                    expect(
                        trailingMarker,
                        `${name}: trailing omission (lines ${expectedX}-${expectedY}) but no trailing marker emitted.`,
                    ).toBeDefined();
                    expect(trailingMarker.x).toBe(expectedX);
                    expect(trailingMarker.y).toBe(expectedY);
                    // The trailing marker is the LAST line of output.
                    expect(trailingMarker.idx).toBe(out.split('\n').length - 1);
                }
            }

            // Exception-header preservation. Headers (by the production
            // header signal — see isExceptionHeader for the matching rule)
            // that the input contained must appear in the output's visible
            // line set. This is the strict reading of proofs/wave1-T4.md
            // FIX 2 part A "header preservation override".
            const inputHeaderLineNums = [];
            for (let i = 0; i < inputLines.length; i++) {
                if (isExceptionHeader(inputLines[i], i === 0)) {
                    inputHeaderLineNums.push(i + 1); // 1-based
                }
            }
            const visibleSet = new Set(visible.map(v => v.n));
            const missingHeaders = inputHeaderLineNums.filter(n => !visibleSet.has(n));
            expect(
                missingHeaders,
                `${name}: input header line numbers ${JSON.stringify(inputHeaderLineNums)} but missing from output: ${JSON.stringify(missingHeaders)}`,
            ).toEqual([]);

            // Finding N2 (i) — Marker spacing contract. Between any two
            // consecutive markers in the output, there must be at least
            // _MIN_OMISSION_THRESHOLD (=6) visible lines. This is the
            // structural reading of "no marker closer than 6 shown lines to
            // the next": markers cannot cluster, because the only legal
            // reason to emit a marker is a gap >= 6 in the input — and a
            // gap >= 6 already forces >= 6 visible lines between the marker
            // boundaries by construction (a marker covers lines X..Y of the
            // INPUT, so the previous marker's Y is < the next marker's X,
            // and the >= 6 emission threshold means each marker pair is
            // separated in OUTPUT by at least 6 visible lines too). Single-
            // marker fixtures are vacuously satisfied; multi-marker outputs
            // (BUG 4a sweep, multi-segment structured emit) are the real
            // pin point. Each pair is checked independently so the failure
            // message identifies WHICH pair clustered.
            for (let i = 1; i < markers.length; i++) {
                const prev = markers[i - 1];
                const curr = markers[i];
                // Count visible (N. ) lines strictly between the two marker
                // line indices in output order — markers themselves don't
                // count, and any other markers would have already been
                // flagged by the ascending+disjoint pair check above.
                const visibleBetween = visible.filter(
                    v => v.idx > prev.idx && v.idx < curr.idx,
                ).length;
                expect(
                    visibleBetween,
                    `${name}: marker pair [${prev.x}-${prev.y}] -> [${curr.x}-${curr.y}] has only ${visibleBetween} visible lines between them (contract: >= ${_MIN_OMISSION_THRESHOLD})`,
                ).toBeGreaterThanOrEqual(_MIN_OMISSION_THRESHOLD);
            }

            // Finding N2 (ii) — Retention band 0.65 <= out/in <= 0.75 for
            // the FULL-SIZE stack fixtures. The band lock applies to every
            // full-size fixture EXCEPT the wave1-T4 fixup-documented JVM
            // exception (its own carve-out below). ChainedHeaders is
            // excluded too (its own test only bounds it loosely — see
            // stack-trace-detection.test.js:90-92 — and the band
            // floor/ceiling math collapses for a 3-line trace where a
            // single header line is already > 75% of the input).
            //
            // Pinned post-fix measurements (re-measured during this task
            // against the current dist): Express 428/626 = 0.6837 (in
            // band), Python 218/329 = 0.6626 (in band), JVM 270/333 =
            // 0.8108 (ABOVE 0.75 ceiling — see JVM carve-out below).
            //
            // JVM carve-out, documented in proofs/wave1-T4.md ("The 0.75
            // ceiling is an internal guide; the spec only requires floor
            // and `< input`"): the wave1-T4 fixup explicitly relaxed the
            // trailing-marker emission threshold to >= 1 (FIX 2 part D)
            // because trailing omissions MUST always carry a marker. The
            // resulting `[TRUNCATED: lines 6-7]` marker adds ~23 chars,
            // pushing JVM's ratio above 0.75. The fixup proof's summary
            // table (line 405) records JVM at 270 chars / 0.811 ratio /
            // PASS — i.e., the spec post-fixup is floor + `< input` for
            // JVM, not floor + ceiling. This test pins that exact
            // post-fixup byte count (270) so any drift in either
            // direction fails loudly.
            if (name !== 'chained-headers-boundary') {
                const ratio = out.length / input.length;
                const floorBytes = Math.floor(input.length * 0.65);
                expect(
                    out.length,
                    `${name}: retention floor — out=${out.length} vs floor=${floorBytes} (ratio ${ratio.toFixed(4)})`,
                ).toBeGreaterThanOrEqual(floorBytes);
                if (name === 'jvm-chained') {
                    // JVM exception: pin to the exact post-wave1-T4-fixup
                    // value AND the universal `< input.length` upper
                    // bound. NOT a relaxation — the wave1-T4 proof's
                    // FIX 2 ruling made trailing-marker emission strict
                    // (overrides the soft 0.75 ceiling); locking 270
                    // exactly captures that decision.
                    expect(
                        out.length,
                        `${name}: post-wave1-T4-fixup pinned size (270 chars; trailing-marker emission overrides 0.75 soft ceiling)`,
                    ).toBe(270);
                    expect(out.length).toBeLessThan(input.length);
                } else {
                    // Express + Python: full band lock (floor AND ceiling).
                    const ceilingBytes = Math.floor(input.length * 0.75);
                    expect(
                        out.length,
                        `${name}: retention ceiling — out=${out.length} vs ceiling=${ceilingBytes} (ratio ${ratio.toFixed(4)})`,
                    ).toBeLessThanOrEqual(ceilingBytes);
                }
            }
        });
    }

    it('python-traceback STOP: exactly ONE internal sub-threshold (<6) unmarked gap; selection [0,1,2,3,7]; both headers preserved', () => {
        // PIN the documented Python STOP case. The full arithmetic is in
        // proofs/wave1-T4.md Fixup section "Python — traceback ... STOP CASE":
        // every legal selection containing BOTH headers and zero internal
        // sub-threshold gaps is either below the 0.65 retention floor
        // ([0,7] @ 72 chars) or longer than the input ([0..7] @ 354 chars >
        // input 329). The actual production output `[0,1,2,3,7]` is the
        // least-bad legal output: in-band, both headers preserved, ONE
        // residual unmarked sub-threshold gap (3 lines between visible 4 and
        // visible 8). If a future code change "fixes" the gap by dropping
        // either header, THIS assertion fails — that is the point.
        const { input, budget } = STACK_FIXTURES['python-traceback'];
        const out = compressString(input, budget);
        const { visible, markers } = parseOutput(out);

        // The exact documented selection.
        expect(visible.map(v => v.n)).toEqual([1, 2, 3, 4, 8]);

        // Both headers (line 1 `Traceback`, line 8 `ValidationError`) survive.
        const inputLines = input.split('\n');
        expect(inputLines[0]).toBe('Traceback (most recent call last):');
        expect(inputLines[7]).toBe('ValidationError: Invalid field');
        const visibleSet = new Set(visible.map(v => v.n));
        expect(visibleSet.has(1)).toBe(true);
        expect(visibleSet.has(8)).toBe(true);

        // Exactly one INTERNAL sub-threshold unmarked gap.
        let subThresholdUnmarked = 0;
        for (let i = 1; i < visible.length; i++) {
            const gap = visible[i].n - visible[i - 1].n - 1;
            if (gap > 0 && gap < _MIN_OMISSION_THRESHOLD) {
                // Marker between them? If not, count it.
                const between = markers.filter(
                    m => m.idx > visible[i - 1].idx && m.idx < visible[i].idx,
                );
                if (between.length === 0) subThresholdUnmarked += 1;
            }
        }
        expect(subThresholdUnmarked).toBe(1);
    });

    it('every NON-Python fixture has ZERO unmarked internal gaps of any size', () => {
        // The flip side of the STOP pin: every OTHER fixture must be strict
        // Priority-0 internal. A future regression that introduces a
        // sub-threshold unmarked gap on JS/JVM/ChainedHeaders trips here
        // before slipping under the >=6 assertion above (which only catches
        // ≥ threshold gaps).
        for (const [name, { input, budget }] of Object.entries(STACK_FIXTURES)) {
            if (name === 'python-traceback') continue; // documented STOP
            const out = compressString(input, budget);
            const { visible, markers } = parseOutput(out);

            let unmarkedInternal = 0;
            for (let i = 1; i < visible.length; i++) {
                const gap = visible[i].n - visible[i - 1].n - 1;
                if (gap > 0) {
                    const between = markers.filter(
                        m => m.idx > visible[i - 1].idx && m.idx < visible[i].idx,
                    );
                    if (between.length === 0) unmarkedInternal += 1;
                }
            }
            expect(
                unmarkedInternal,
                `${name}: must have ZERO unmarked internal gaps of any size`,
            ).toBe(0);
        }
    });
});

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
        return { source, facts };
    }

    it('synthetic source tiles 1..N perfectly: ascending, verbatim, every gap covered', () => {
        const { source, facts } = buildSynthetic();
        const sourceLines = source.split('\n');
        const N = sourceLines.length;
        expect(N).toBe(36); // sanity-pin the fixture

        const out = compressFile({ source, maxChars: 300, facts });
        expect(out, 'compressFile must return a non-null result for this fixture').not.toBeNull();
        expect(out.length).toBeLessThan(source.length); // usefulness gate passed

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
        const { source, facts } = buildSynthetic();
        const sourceLines = source.split('\n');
        const N = sourceLines.length;
        expect(N).toBe(36);

        // Budget sweep. Include:
        //   - the proof's passing budget (300)
        //   - the formerly-throwing range (520+) — sample broadly
        //   - tight-budget edges around the 70% floor (904 * 0.70 = 632)
        //   - budgets > source length (compressFile must return null cleanly)
        const minBudget = Math.max(1, Math.floor(source.length * 0.70));
        const budgets = [
            100, 200, 300, 400,
            minBudget - 5, minBudget, minBudget + 5,
            500, 520, 540, 560, 580, 600, 620, 640, 660, 680, 700,
            720, 740, 760, 780, 800, 820, 840, 860, 880, 900, 920,
            source.length - 1, source.length, source.length + 10,
        ];

        for (const budget of budgets) {
            // The fix's central post-condition: compressFile MUST NOT throw,
            // for any budget, against this fixture. (The Phase-H assertion is
            // the safety net; the convergence is what makes the assertion
            // never fire.)
            let out;
            expect(
                () => { out = compressFile({ source, maxChars: budget, facts }); },
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

describe('toon-output-invariants — source-code path marker disjointness', () => {
    // T14 (BUG 4a regression lock): _compressSourceCode buffers blank lines
    // across omission boundaries (string-codec.ts pendingBlankIdx flush). The
    // pre-fix code emitted the marker as [TRUNCATED: lines omitStart+1 - idx]
    // where `idx` is the 0-based index of the NEXT non-blank line in input,
    // i.e. the visible number that's about to be printed AFTER the buffered
    // blanks. If pendingBlankIdx is non-empty when the marker fires, the
    // marker's Y bound can equal the visible number that follows it. Concrete
    // proof case (proofs/wave3-T13.md §4a): marker `[TRUNCATED: lines 5-8]`
    // immediately followed by visible `8. ` (the buffered blank), so the
    // marker text says line 8 is omitted but line 8 IS shown. The T14 fix
    // caps Y at the FIRST buffered blank's 1-based number (the last omitted
    // line), so the marker stops strictly before the first buffered blank.
    //
    // Fixture: a source-code-classified input (triggers `_isSourceCode` ->
    // `_compressSourceCode` from `compressString`) with low-value omissible
    // blocks BORDERED by blank lines. Engineered from the 4a proof recipe so
    // the pre-fix code emits the overlapping marker on this exact input.
    it('source-code path markers never overlap visible lines (BUG 4a lock)', () => {
        // Build a TypeScript-like source where:
        //   - lines 1-4 are kept (import + interface — comment-like top
        //     content that the source-code priority keeps);
        //   - line 5 is BLANK (buffered across the omission boundary);
        //   - lines 6-38 are a low-value omissible block (large underscore-
        //     prefixed helper — low priority, gets truncated);
        //   - line 39 is BLANK (buffered AFTER the omission, BEFORE the next
        //     visible line — this is the line whose number the pre-fix
        //     marker overlapped);
        //   - lines 40-42 are a kept public function.
        const lines = [];
        lines.push('import fs from "fs";');                          // 1
        lines.push('export interface Config {');                     // 2
        lines.push('  name: string;');                                // 3
        lines.push('}');                                              // 4
        lines.push('');                                               // 5  BLANK
        lines.push('function _bigHelper() {');                        // 6
        for (let i = 0; i < 30; i++) {
            lines.push(`  const x${i} = ${i};`);                      // 7-36
        }
        lines.push('  return 1;');                                    // 37
        lines.push('}');                                              // 38
        lines.push('');                                               // 39 BLANK
        lines.push('export function publicApi(): Config {');         // 40
        lines.push('  return { name: "x" };');                       // 41
        lines.push('}');                                              // 42
        const source = lines.join('\n');
        expect(lines.length).toBe(42);

        // Multiple budgets, all small enough to force the source-code path
        // through an internal omission. Each value here previously produced
        // an overlapping marker (verified live against the pre-fix dist
        // during T14 reproduction).
        for (const budget of [200, 300, 400, 500, 600]) {
            const out = compressString(source, budget);
            const { visible, markers } = parseOutput(out);

            // Every marker range MUST be disjoint from the set of visible
            // line numbers (BUG 4a — this is the strict regression check).
            const shownSet = new Set(visible.map(v => v.n));
            for (const m of markers) {
                for (let ln = m.x; ln <= m.y; ln++) {
                    expect(
                        shownSet.has(ln),
                        `budget=${budget}: marker range ${m.x}-${m.y} overlaps visible number ${ln} — BUG 4a regression`,
                    ).toBe(false);
                }
            }

            // Strict marker shape literal — guard against any annotation drift.
            for (const m of markers) {
                expect(m.x).toBeLessThanOrEqual(m.y);
                expect(out.split('\n')[m.idx]).toBe(`[TRUNCATED: lines ${m.x}-${m.y}]`);
            }

            // Visible numbers strictly ascending (Priority-0 §2 — sanity
            // check the rest of the contract on this fixture too).
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
                    `budget=${budget}: verbatim mismatch at line ${v.n}`,
                ).toBe(lines[v.n - 1]);
            }

            // Sanity guards: the fixture is engineered so the omission
            // exercise actually triggers. At least one marker must be
            // emitted (otherwise the test isn't exercising the seam).
            expect(
                markers.length,
                `budget=${budget}: fixture failed to exercise an omission — at least one marker expected`,
            ).toBeGreaterThanOrEqual(1);

            // Each gap >= _MIN_OMISSION_THRESHOLD between consecutive
            // visibles must be covered by an exact-range marker
            // `lines [prev+1, next-1]` (strict marker convention — this is
            // the assertion family that the 4a fix straightens out, since
            // pre-fix the Y bound could overshoot into the buffered blank's
            // visible number).
            for (let i = 1; i < visible.length; i++) {
                const prev = visible[i - 1];
                const curr = visible[i];
                const gap = curr.n - prev.n - 1;
                if (gap < _MIN_OMISSION_THRESHOLD) continue;
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
        }
    });
});
