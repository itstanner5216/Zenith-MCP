// ---------------------------------------------------------------------------
// rev2-toon-unsupported-lang.test.js
//
// Review-2 disposition [Z] (cubic #43 P2) — Rule 12: TOON must NEVER deny a
// compression request. An UNSUPPORTED language (no tree-sitter lang name, no
// structural defs) is a MANDATORY fallback to TOON's UNSTRUCTURED text engine
// (compressString), which is independently capable of ~70% compression with no
// AST/lang data. It must NOT early-return null and force the read tool into
// plain truncation.
//
// THE BUG (fail-before): packages/zenith-toon/src/string-codec.ts compressFile
// had `if (req.facts.langName === null && req.facts.defs.length === 0) return
// null;`. For an unsupported-language file (langName null, defs empty),
// compressFile returned null, so the caller fell back to dumb truncation
// instead of TOON's unstructured compression — a Rule-12 violation.
//
// THE FIX (pass-after): that early-return now routes the null-langName /
// no-defs case to compressString(source, maxChars) — the SAME unstructured
// engine _compressSourceStructured delegates to when structure is empty
// (string-codec.ts:1252 `return compressString(text, budget)`). It returns the
// compressed string; it only returns null if even the unstructured output is
// not shorter than the source (mirrors the structured path's usefulness gate).
//
// This test drives compressFile with langName:null + empty defs over multi-line
// inputs LONGER than maxChars and asserts a NON-null compressed string that
// respects the unstructured path's verbatim / 1-based-line-number / single
// flush-left `[TRUNCATED: lines X-Y]` marker invariants — NOT null.
//
// Import is from the BUILT zenith-toon dist (the package this fix lives in),
// resolved via the `zenith-toon` workspace name exactly like every other seam
// test (toon-output-invariants, review-edge-damping, stack-trace-detection).
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { compressFile } from 'zenith-toon';

const NON_MARKER_RE = /^(\d+)\. ([\s\S]*)$/;
const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;

// Build a RawFileFacts payload for an UNSUPPORTED language: langName null, no
// defs / edges / anchors / imports / injections. This is exactly the shape the
// seam hands TOON when tree-sitter has no grammar for the file.
function unsupportedFacts(relPath) {
    return {
        path: relPath,
        langName: null,
        defs: [],
        edges: [],
        anchors: [],
        imports: [],
        injections: [],
    };
}

// Parse the unstructured-path output into visible (`N. text`) and marker
// (`[TRUNCATED: lines X-Y]`) lines, asserting every output line matches exactly
// one of the two legal shapes (Priority-0: no synthetic/foreign lines).
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
            throw new Error(
                `Output line ${i} matches neither "N. " nor "[TRUNCATED: lines X-Y]" shape: ${JSON.stringify(line)}`,
            );
        }
    }
    return { lines, visible, markers };
}

describe('rev2 [Z] Rule 12 — unsupported language compresses via the unstructured path (never denies)', () => {
    // A multi-line plain-text fixture (NOT recognized as source/JSON/stack/log)
    // with a long, droppable middle so the unstructured content-aware truncate
    // keeps head+tail and omits >= 6 contiguous middle lines (forcing a real
    // `[TRUNCATED: lines X-Y]` marker). Every line is distinct so verbatim
    // mapping is unambiguous.
    const PROSE_LINES = [
        'Chapter One: the opening remarks of an unsupported document format.',
        'This paragraph establishes the setting and the principal characters.',
        'Background detail line three carries context the reader may want later.',
        'Background detail line four expands on the surrounding circumstances.',
        'Background detail line five is filler that the compressor may drop.',
        'Background detail line six is more droppable connective narration.',
        'Background detail line seven continues the low-signal middle section.',
        'Background detail line eight keeps the omittable region comfortably long.',
        'Background detail line nine is still squarely inside the droppable middle.',
        'Background detail line ten remains low-value orientation prose.',
        'Background detail line eleven pads the omission well past six lines.',
        'Background detail line twelve is the last of the heavy middle padding.',
        'Penultimate line thirteen begins steering back toward the conclusion.',
        'Final line fourteen: the closing remarks of the unsupported document.',
    ];
    const PROSE_SOURCE = PROSE_LINES.join('\n');

    it('returns a NON-null compressed string (not null) for langName:null + empty defs', () => {
        // maxChars far below the source length. compressFile floors at 70%
        // internally; we only need it to NOT deny and to actually shorten.
        const maxChars = 200;
        expect(PROSE_SOURCE.length).toBeGreaterThan(maxChars);

        const out = compressFile({
            source: PROSE_SOURCE,
            maxChars,
            facts: unsupportedFacts('docs/unsupported.prose'),
        });

        // FAIL-BEFORE: the pre-fix early-return produced `null` here. The
        // caller would then emit raw/truncated bytes, denying compression.
        // PASS-AFTER: a real compressed string from the unstructured engine.
        expect(out).not.toBeNull();
        expect(typeof out).toBe('string');

        // Rule 12 / usefulness: it actually compressed (shorter than source).
        expect(out.length).toBeLessThan(PROSE_SOURCE.length);
    });

    it('the returned string respects the unstructured path invariants (verbatim, 1-based numbers, single flush-left marker)', () => {
        const maxChars = 200;
        const out = compressFile({
            source: PROSE_SOURCE,
            maxChars,
            facts: unsupportedFacts('docs/unsupported.prose'),
        });
        expect(out).not.toBeNull();

        const { visible, markers } = parseOutput(out);

        // Something was shown and something was omitted — i.e. this exercised a
        // genuine unstructured compression, not a verbatim passthrough.
        expect(visible.length).toBeGreaterThan(0);
        expect(markers.length).toBeGreaterThan(0);

        // Priority-0 §2 verbatim: every visible line's post-prefix text is a
        // character-perfect copy of the corresponding 1-based original line.
        for (const v of visible) {
            expect(
                v.text,
                `Verbatim mismatch at line ${v.n}: got ${JSON.stringify(v.text)}, expected ${JSON.stringify(PROSE_LINES[v.n - 1])}`,
            ).toBe(PROSE_LINES[v.n - 1]);
        }

        // Priority-0: visible line numbers strictly ascending, all in range.
        for (let i = 1; i < visible.length; i++) {
            expect(visible[i].n).toBeGreaterThan(visible[i - 1].n);
        }
        for (const v of visible) {
            expect(v.n).toBeGreaterThanOrEqual(1);
            expect(v.n).toBeLessThanOrEqual(PROSE_LINES.length);
        }

        // Markers: canonical flush-left `[TRUNCATED: lines X-Y]` (Y >= X), each
        // range disjoint from every shown line number (the marker claims those
        // lines are NOT in the output).
        const shownSet = new Set(visible.map((v) => v.n));
        let prevHi = 0;
        for (const m of markers) {
            expect(m.y).toBeGreaterThanOrEqual(m.x);
            expect(m.x).toBeGreaterThan(prevHi);
            prevHi = m.y;
            for (let ln = m.x; ln <= m.y; ln++) {
                expect(
                    shownSet.has(ln),
                    `Marker range ${m.x}-${m.y} overlaps visible line ${ln}`,
                ).toBe(false);
            }
        }

        // Every internal gap >= 6 between consecutive visible numbers is
        // covered by an exact-range marker positioned between them (the
        // unstructured path's omission-threshold + verbatim mapping contract).
        for (let i = 1; i < visible.length; i++) {
            const prev = visible[i - 1];
            const curr = visible[i];
            const gap = curr.n - prev.n - 1;
            if (gap >= 6) {
                const between = markers.filter((m) => m.idx > prev.idx && m.idx < curr.idx);
                const exact = between.find((m) => m.x === prev.n + 1 && m.y === curr.n - 1);
                expect(
                    exact,
                    `gap ${prev.n}->${curr.n} (${gap} lines) missing exact-range marker ${prev.n + 1}-${curr.n - 1}`,
                ).toBeDefined();
            }
        }
    });

    it('also compresses an unsupported-language STACK-TRACE-shaped input (no defs) rather than denying', () => {
        // Second content shape proving the fallback is the real auto-detecting
        // unstructured engine, not a single-branch hack. A stack trace with
        // langName null still routes through compressString and compresses.
        const STACK_SOURCE = [
            "TypeError: Cannot read properties of null (reading 'map')",
            '    at processItems (/app/src/utils.js:42:15)',
            '    at handleRequest (/app/src/server.js:108:9)',
            '    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)',
            '    at next (/app/node_modules/express/lib/router/route.js:144:13)',
            '    at Route.dispatch (/app/node_modules/express/lib/router/route.js:114:3)',
            '    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)',
            '    at /app/node_modules/express/lib/router/index.js:284:15',
            '    at Function.process_params (/app/node_modules/express/lib/router/index.js:346:12)',
        ].join('\n');

        const out = compressFile({
            source: STACK_SOURCE,
            maxChars: 100,
            facts: unsupportedFacts('logs/crash.unknownext'),
        });

        // FAIL-BEFORE: null. PASS-AFTER: compressed string, shorter than input.
        expect(out).not.toBeNull();
        expect(typeof out).toBe('string');
        expect(out.length).toBeLessThan(STACK_SOURCE.length);

        // Output shape is the unstructured invariant set — every line is either
        // a verbatim `N. ` line or a flush-left `[TRUNCATED: lines X-Y]` marker.
        const { visible, markers } = parseOutput(out);
        expect(visible.length).toBeGreaterThan(0);
        const stackLines = STACK_SOURCE.split('\n');
        for (const v of visible) {
            expect(v.text).toBe(stackLines[v.n - 1]);
        }
        let prevHi = 0;
        for (const m of markers) {
            expect(m.y).toBeGreaterThanOrEqual(m.x);
            expect(m.x).toBeGreaterThan(prevHi);
            prevHi = m.y;
        }
    });

    it('still honors the legitimate empty-source guard (returns null on empty input)', () => {
        // The empty-source early-return is legitimate and stays: an empty file
        // has nothing to compress. Only the langName/no-defs branch became a
        // fallback-to-unstructured; this guard is untouched.
        const out = compressFile({
            source: '',
            maxChars: 100,
            facts: unsupportedFacts('docs/empty.prose'),
        });
        expect(out).toBeNull();
    });
});
