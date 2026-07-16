// polaris-audit-text-floor-unicode.test.js — INDEPENDENT CORRECTNESS AUDIT
//
// Auditor-authored. The literal floor's encoding boundaries. Oracles:
//   * UTF-16 column: HAND-COMPUTED from Unicode code-point widths (plan
//     Amendment 2026-07-15 F2 — columns are 0-based UTF-16 code units, plan
//     line 423). Not the code's output.
//   * rg vs in-process: DIFFERENTIAL — two independent scanners must agree on
//     byte offsets for the same Unicode content (plan: "behaviorally equivalent
//     for exact identifiers", line 1304).
//   * boundary annotation: hand-reasoned Unicode \p{L}/\p{N} semantics with
//     positive/negative controls.
//
// FINDING F2 (LOW — annotation-only, never affects match correctness or
// absence proofs): boundaryAnnotation extracts the adjacent character with
// `.slice(-1)` / `.slice(0,1)` on decoded UTF-8, which splits a surrogate pair.
// A supplementary-plane identifier char (\p{L}/\p{N}) adjacent to a hit is thus
// tested as a lone surrogate and misclassified as a NON-identifier, wrongly
// annotating the hit as sitting on an identifier boundary. Contract note: the
// flag is explicitly "annotation only — a non-boundary hit is still a hit"
// (text-floor.ts) so this cannot corrupt matches or absence proofs; it is a
// pure accuracy defect in the `identifierBoundary` field relative to the
// function's own \p{L}\p{N}_$ intent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanLiteralFloor } from '../dist/core/intelligence/text-floor.js';

const RG_AVAILABLE = (() => {
    try {
        const r = spawnSync('rg', ['--version'], { encoding: 'utf8' });
        return r.error === undefined && r.status === 0;
    } catch {
        return false;
    }
})();

// In-hand content is scanned in process; a disk file lets us also drive rg.
function memFile(storeKey, content) {
    return { storeKey, absPath: `/nonexistent/${storeKey}`, content };
}

let diskRoot;
function diskFile(rel, content) {
    const abs = path.join(diskRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return { storeKey: rel, absPath: abs };
}

beforeAll(() => {
    diskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-audit-floor-'));
});

afterAll(() => {
    try { fs.rmSync(diskRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('text floor — UTF-16 column is hand-computed, not snapshotted', () => {
    // Independent reference: build a line whose bytes before the literal are
    // known Unicode code points, and compute the expected 0-based UTF-16 column
    // BY HAND from their UTF-16 widths (astral = 2 code units, BMP = 1).
    const cases = [
        // "HERE" after "😀café=" :
        //   😀 U+1F600 = 2 u16 (4 bytes); c a f = 3 u16 (3 bytes);
        //   é U+00E9   = 1 u16 (2 bytes); '=' = 1 u16 (1 byte)
        //   => column 2+3+1+1 = 7 ; byte 4+3+2+1 = 10
        { content: '\u{1F600}café=HERE\n', literal: 'HERE', col: 7, byte: 10 },
        // "X" after two astral chars 𝌆𝌇 (each 2 u16 / 4 bytes) => col 4, byte 8
        { content: '\u{1D306}\u{1D307}X=1\n', literal: 'X', col: 4, byte: 8 },
        // literal itself contains é: "aéb" then literal "naïve"
        //   a(1) é(1) b(1) space(1) => naïve starts at col 4, byte a1é2b1 sp1 =5
        { content: 'aéb naïve\n', literal: 'naïve', col: 4, byte: 5 },
    ];
    for (const [i, c] of cases.entries()) {
        it(`case ${i}: literal ${JSON.stringify(c.literal)} at UTF-16 column ${c.col}`, () => {
            const out = scanLiteralFloor(c.literal, [memFile('m.ts', c.content)],
                { forceScanner: 'in_process' });
            expect(out.matches).toHaveLength(1);
            expect(out.matches[0].line).toBe(1);
            expect(out.matches[0].column).toBe(c.col);
            expect(out.matches[0].byteOffset).toBe(c.byte);
        });
    }

    it('anti-vacuity: a wrong hand-computed column would be RED', () => {
        const out = scanLiteralFloor('HERE', [memFile('m.ts', '\u{1F600}café=HERE\n')],
            { forceScanner: 'in_process' });
        // If locate() (wrongly) counted code POINTS not UTF-16 units, 😀 would
        // contribute 1 not 2 and the column would be 6. Prove the test can tell.
        expect(out.matches[0].column).not.toBe(6);
        expect(out.matches[0].column).toBe(7);
    });

    it('column on a later line accounts only for that line prefix', () => {
        // "😀\ncafé=HERE" — HERE on line 2 at column 5 (café=), byte offset
        //   after "😀\n" (4+1=5) + "café=" (3+2+1=6) = 11.
        const out = scanLiteralFloor('HERE', [memFile('m.ts', '\u{1F600}\ncafé=HERE\n')],
            { forceScanner: 'in_process' });
        expect(out.matches[0].line).toBe(2);
        expect(out.matches[0].column).toBe(5);
        expect(out.matches[0].byteOffset).toBe(11);
    });
});

describe('text floor — rg and in-process agree on Unicode byte offsets (differential)', () => {
    // Two independent code paths (the rg binary vs buffer.indexOf) must report
    // the same match set for Unicode content. Only byte offsets can differ —
    // line/column/boundary are computed in-process from the real bytes for both.
    const CONTENT = [
        'const café = targetß;',        // multibyte before + after the literal
        'x = targetß + 😀targetß;',      // astral char immediately before a hit
        '// targetß mentioned in a comment 𝌆',
        'targetß',                       // at EOF, no trailing newline
    ].join('\n');

    it('same byte-offset multiset for a multibyte literal', () => {
        if (!RG_AVAILABLE) return; // rg optional; equivalence only when present
        const f = diskFile('uni-diff.ts', CONTENT);
        const viaRg = scanLiteralFloor('targetß', [f], { forceScanner: 'rg' });
        const viaProc = scanLiteralFloor('targetß', [f], { forceScanner: 'in_process' });
        expect(viaRg.scanner).toBe('rg');
        expect(viaProc.scanner).toBe('in_process');

        const offsets = (o) => o.matches.map((m) => m.byteOffset).sort((a, b) => a - b);
        expect(offsets(viaRg)).toEqual(offsets(viaProc));
        // And the full match tuples (offset/line/column/boundary) must match.
        const tup = (o) => o.matches
            .map((m) => `${m.byteOffset}:${m.line}:${m.column}:${m.identifierBoundary}`)
            .sort();
        expect(tup(viaRg)).toEqual(tup(viaProc));
    });

    it('anti-vacuity: the differential can distinguish scanners (wrong literal → both empty, equal; real literal → nonempty)', () => {
        const f = diskFile('uni-diff2.ts', CONTENT);
        const proc = scanLiteralFloor('targetß', [f], { forceScanner: 'in_process' });
        expect(proc.matches.length).toBeGreaterThan(1); // literal really occurs
        const absent = scanLiteralFloor('targetßZZZ', [f], { forceScanner: 'in_process' });
        expect(absent.matches).toHaveLength(0);         // control: no false hits
    });
});

describe('text floor — FINDING F2: boundary annotation and supplementary-plane chars', () => {
    // Oracle: a \p{L} or \p{N} character immediately adjacent to the literal
    // means the hit is NOT on an identifier boundary (identifierBoundary=false),
    // per the function's own /[\p{L}\p{N}_$]/u intent. Independent reference:
    // JS Unicode property escapes on the FULL code point.
    const scan = (content) =>
        scanLiteralFloor('target', [memFile('m.ts', content)], { forceScanner: 'in_process' })
            .matches[0];

    it('CONTROL: BMP letter before/after → boundary false', () => {
        expect(scan('atarget\n').identifierBoundary).toBe(false);
        expect(scan('targetb\n').identifierBoundary).toBe(false);
    });

    it('CONTROL: non-identifier (space / punctuation) → boundary true', () => {
        expect(scan(' target \n').identifierBoundary).toBe(true);
        expect(scan('(target)\n').identifierBoundary).toBe(true);
    });

    it('CONTROL: astral NON-letter (emoji) adjacent → boundary true (correct either way)', () => {
        // 😀 is category So, not \p{L}\p{N}; boundary should be true. This passes
        // regardless of the surrogate bug, isolating the defect to astral
        // identifier chars.
        expect(scan('\u{1F600}target\n').identifierBoundary).toBe(true);
        expect(scan('target\u{1F600}\n').identifierBoundary).toBe(true);
    });

    it('BUG: astral LETTER (\\p{L}) before the literal is misclassified as a boundary', () => {
        // U+1D44E MATHEMATICAL ITALIC SMALL A is \p{L}. Correct: false.
        expect(/\p{L}/u.test('\u{1D44E}'), 'oracle: astral char is a letter').toBe(true);
        expect(scan('\u{1D44E}target\n').identifierBoundary,
            'letter precedes literal ⇒ not a boundary').toBe(false);
    });

    it('BUG: astral LETTER (\\p{L}) after the literal is misclassified as a boundary', () => {
        // Exercises the `.slice(0,1)` (high-surrogate) side.
        expect(scan('target\u{1D44E}\n').identifierBoundary,
            'letter follows literal ⇒ not a boundary').toBe(false);
    });

    it('BUG: astral NUMBER (\\p{N}) adjacent is misclassified as a boundary', () => {
        // U+1D7CE MATHEMATICAL BOLD DIGIT ZERO is \p{N}; the regex includes \p{N}.
        expect(/\p{N}/u.test('\u{1D7CE}'), 'oracle: astral char is a number').toBe(true);
        expect(scan('\u{1D7CE}target\n').identifierBoundary,
            'number precedes literal ⇒ not a boundary').toBe(false);
    });
});
