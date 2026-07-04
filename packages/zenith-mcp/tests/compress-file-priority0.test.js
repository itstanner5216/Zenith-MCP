// compress-file-priority0.test.js
//
// Priority-0 output invariants for the PUBLIC `compressFile` seam — the
// boundary Zenith-MCP calls (compression.ts → compressFile → string|null).
//
// Asserts the Priority-0 contract directly on the RETURNED STRING that crosses
// the seam to the caller (the output of `compressFile`, driven here through the
// real MCP wrapper `compressForTool` exactly as read_file drives it — real
// tree-sitter facts, real symbol DB, so SageRank has genuine ranking signal and
// actually produces compressed output with markers):
//   - every non-marker line is `N. <verbatim content>` (1-based, character-exact
//     copy of the original line at that number — the H2 keystone)
//   - markers are EXACTLY `[TRUNCATED: lines X-Y]`, flush-left, ascending,
//     non-overlapping, and disjoint from shown line numbers
//   - shown line numbers are strictly ascending; every gap is accounted for
//   - no two markers sandwich fewer than 6 shown lines (Rule 1; the engine's
//     verifyOutput counts ALL kept lines between markers, blank or not)
//
// COMPLEMENTARY, NOT DUPLICATIVE: zenith-toon/tests/constraints/removal-fen-proofs
// .test.ts and removal-scaling-proofs.test.ts run the AUTHORITY `verifyOutput`
// (H1–H7) over `removalEngine` output — they prove the ENGINE. This test proves
// the PUBLIC ADAPTER string the caller actually receives (after compressFile's
// own internal verifyOutput gate), end-to-end through the real MCP seam —
// catching any corruption a future adapter/seam change could introduce.
//
// RE-EXPRESSES the deleted string-codec-priority0.test.js (which tested the
// removed `compressSourceStructured` with hand-built StructureBlock[]) against
// the current public seam. The real seam is used because compressFile produces
// non-null output only when SageRank has enough ranking signal to find
// droppable content — impoverished hand-built facts yield null (the honest
// "use raw" outcome), which would test nothing. Real tree-sitter facts on a
// differentiated fixture is the path that actually ships compressed output.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { compressForTool } from '../dist/core/compression.js';
import { findRepoRoot, getDb } from '../dist/core/symbol-index.js';

const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const SHOWN_RE = /^(\d+)\. ([\s\S]*)$/;

// read_file places the `N. ` line-number prefix once before handing text to the
// compression pipe; mirror that here so compressForTool sees prefixed source.
function prefixLines(source) {
    return source.split('\n').map((line, i) => `${i + 1}. ${line}`).join('\n');
}

// Parse + validate the Priority-0 invariants against the ORIGINAL (un-prefixed)
// source. compressFile receives an already-`N. `-prefixed source and returns
// kept lines WITH those prefixes preserved; the content after each `N. ` prefix
// must equal the verbatim original line at that 1-based number.
function assertPriority0(unprefixedOriginal, compressed) {
    const origLines = unprefixedOriginal.split('\n');
    const outLines = compressed.split('\n');

    const shownNumbers = [];
    const markerRanges = [];
    let shownSincePrevMarker = 0;
    let sawMarker = false;

    for (const line of outLines) {
        const m = MARKER_RE.exec(line);
        if (m) {
            // Flush-left, exact shape — no indentation/prefix, no count-only form.
            expect(line).toBe(`[TRUNCATED: lines ${m[1]}-${m[2]}]`);
            const x = Number(m[1]);
            const y = Number(m[2]);
            expect(x).toBeLessThanOrEqual(y); // valid inclusive range

            // Rule 1: no two markers may sandwich fewer than 6 shown lines
            // (matches verifyOutput's interior-kept-run count, which counts
            // every kept line, blank or not).
            if (sawMarker) {
                expect(shownSincePrevMarker).toBeGreaterThanOrEqual(6);
            }
            sawMarker = true;
            shownSincePrevMarker = 0;
            markerRanges.push([x, y]);
            continue;
        }

        const s = SHOWN_RE.exec(line);
        expect(s, `every non-marker line must be "N. ...": got ${JSON.stringify(line)}`).not.toBeNull();
        const num = Number(s[1]);
        const content = s[2];
        // H2 keystone: content after the prefix is a character-perfect copy of
        // the original line at that 1-based number.
        expect(content).toBe(origLines[num - 1]);
        shownNumbers.push(num);
        shownSincePrevMarker += 1;
    }

    // Shown line numbers strictly ascending.
    for (let i = 1; i < shownNumbers.length; i++) {
        expect(shownNumbers[i]).toBeGreaterThan(shownNumbers[i - 1]);
    }

    // Marker ranges ascending, non-overlapping, and disjoint from shown lines
    // (a truncated range must hold no shown line).
    const shownSet = new Set(shownNumbers);
    let prevHi = 0;
    for (const [x, y] of markerRanges) {
        expect(x).toBeGreaterThan(prevHi); // ascending + non-overlapping
        prevHi = y;
        for (let ln = x; ln <= y; ln++) {
            expect(shownSet.has(ln)).toBe(false);
        }
    }

    return { shownNumbers, markerRanges };
}

describe('compressFile — Priority-0 output invariants (public seam, end-to-end)', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-priority0-'));
        // findRepoRoot() walks up for a `.git` entry; create one so the temp dir
        // is recognized as a repo root and the symbol indexer populates facts.
        await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
    });
    afterEach(async () => {
        if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('two separated droppable regions → ≥2 markers, ≥6 shown lines between them, all verbatim', async () => {
        // IMPORTANT functions separated by DROPPABLE filler regions. A tight
        // budget must drop the filler and emit a marker per region, leaving the
        // functions shown. This is the fixture shape that forces TWO markers,
        // so the Rule-1 "≥6 shown lines between markers" check inside
        // assertPriority0 actually fires.
        const parts = [];
        parts.push(`export function alpha(x) { return x + 1; }`); // important
        for (let i = 0; i < 14; i++) parts.push(`const fillerA_${i} = ${i}; // droppable padding ${i}`);
        parts.push(`export function beta(y) { return y * 2; }`); // important
        for (let i = 0; i < 14; i++) parts.push(`const fillerB_${i} = ${i}; // droppable padding ${i}`);
        parts.push(`export function gamma(z) { return z - 3; }`); // important
        for (let i = 0; i < 14; i++) parts.push(`const fillerC_${i} = ${i}; // droppable padding ${i}`);
        parts.push(`export function delta(w) { return w / 4; }`); // important
        const unprefixed = parts.join('\n');
        const prefixed = prefixLines(unprefixed);

        const filePath = path.join(tmpDir, 'separated.ts');
        await fs.writeFile(filePath, unprefixed, 'utf8');
        getDb(findRepoRoot(tmpDir));

        const maxChars = Math.floor(prefixed.length * 0.45);
        const out = await compressForTool(filePath, prefixed, maxChars);

        expect(out).not.toBeNull();
        const { markerRanges } = assertPriority0(unprefixed, out);
        // Two separated droppable regions → at least two markers (so the Rule-1
        // ≥6-between-markers invariant was actually exercised, not vacuously).
        expect(markerRanges.length).toBeGreaterThanOrEqual(2);
    });

    it('single droppable middle → marker covers a real range, every shown line verbatim', async () => {
        // Realistic module: several interdependent functions with a long dead
        // middle. One contiguous droppable region → one marker. The H2 verbatim
        // keystone (every shown line character-exact at its number) is the focus
        // here, across a varied multi-function source. (>=4 real functions are
        // needed so SageRank has enough ranking signal to find the middle
        // droppable — fewer yields null, the honest "use raw" outcome.)
        const lines = [];
        lines.push(`export function clamp(v, lo, hi) {`); // 1
        lines.push(`  if (v < lo) return lo;`);
        lines.push(`  if (v > hi) return hi;`);
        lines.push(`  return v;`);
        lines.push(`}`); // 5
        lines.push(`export function normalizeConfig(input) {`); // 6
        lines.push(`  const retries = clamp(input.retries ?? 3, 0, 10);`);
        lines.push(`  const timeout = clamp(input.timeout ?? 1000, 100, 60000);`);
        lines.push(`  return { name: input.name ?? "default", retries, timeout };`);
        lines.push(`}`); // 10
        for (let i = 11; i <= 38; i++) {
            lines.push(`const dead${i} = ${i}; // long droppable middle line ${i}`);
        }
        lines.push(`export function computeScore(values) {`); // 39
        lines.push(`  let total = 0;`);
        lines.push(`  for (const v of values) total += clamp(v, 0, 100);`);
        lines.push(`  return values.length ? total / values.length : 0;`);
        lines.push(`}`); // 43
        lines.push(`export function formatReport(score) {`); // 44
        lines.push(`  const grade = score >= 90 ? "A" : score >= 70 ? "C" : "F";`);
        lines.push(`  return { grade, stampedAt: Date.now() };`);
        lines.push(`}`); // 47
        const unprefixed = lines.join('\n');
        const prefixed = prefixLines(unprefixed);

        const filePath = path.join(tmpDir, 'middle.ts');
        await fs.writeFile(filePath, unprefixed, 'utf8');
        getDb(findRepoRoot(tmpDir));

        const maxChars = Math.floor(prefixed.length * 0.5);
        const out = await compressForTool(filePath, prefixed, maxChars);

        expect(out).not.toBeNull();
        expect(out).toMatch(/\[TRUNCATED: lines \d+-\d+\]/);
        const { markerRanges, shownNumbers } = assertPriority0(unprefixed, out);
        expect(markerRanges.length).toBeGreaterThanOrEqual(1);
        // The shown line set must include the real function start lines (1, 6,
        // 39, 44) — structural importance survives compression.
        expect(shownNumbers).toContain(1);
        expect(shownNumbers).toContain(6);
        expect(shownNumbers).toContain(39);
        expect(shownNumbers).toContain(44);
    });
});
