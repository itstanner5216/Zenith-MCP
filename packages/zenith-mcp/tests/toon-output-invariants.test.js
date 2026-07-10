// ---------------------------------------------------------------------------
// toon-output-invariants.test.js
//
// Priority-0 / H1–H7 mechanical invariant suite for compressFile output.
// Every assertion is independently derived from the output string against the
// input source; nothing depends on TOON-internal metadata.
//
// H1 — Every shown line number is strictly ascending.
// H2 — Every shown line is a character-perfect copy of the original at that
//      line number (the verbatim keystone).
// H3 — Every marker is the exact canonical format: [TRUNCATED: lines X-Y],
//      flush-left, with X ≤ Y.
// H4 — Every gap between consecutive shown ranges where the dropped line count
//      is ≥ 6 is accounted for by a valid marker whose range matches the gap.
// H5 — Markers and shown line numbers are pairwise disjoint.
// H6 — Rendered output length (kept lines + marker characters) lies in the
//      [68%, 72%] retention band.
// H7 — At least 6 shown lines exist between any two markers (interior shown
//      runs meet the minimum).
//
// Null IS a valid return for "compression not useful" (Rule 12, Priority 0.4).
// Tests that exercise a genuinely compressible fixture assert non-null; tests
// that exercise degenerate/uncompressible input accept null.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { compressFile } from 'zenith-toon';

const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const SHOWN_RE = /^(\d+)\. (.+)$/;
const MIN_OMISSION = 6;

// ── helpers ──────────────────────────────────────────────────────────────────

function prefixLines(lines) {
  return lines.join('\n');
}

function prefixedArray(rawLines) {
  return rawLines.map((line, i) => `${i + 1}. ${line}`);
}

function parseOutput(output) {
  const outLines = output.split('\n');
  const visible = [];
  const markers = [];
  for (let i = 0; i < outLines.length; i++) {
    const line = outLines[i];
    const m = MARKER_RE.exec(line);
    if (m) {
      markers.push({ idx: i, x: Number(m[1]), y: Number(m[2]) });
      continue;
    }
    const s = SHOWN_RE.exec(line);
    expect(s, `output line ${i} not a valid shown line or marker: ${JSON.stringify(line)}`).not.toBeNull();
    visible.push({ idx: i, n: Number(s[1]), text: s[2] });
  }
  return { outputLines: outLines, visible, markers };
}

function emptyFacts(path = 'src/fixture.ts', langName = 'typescript') {
  return {
    path,
    langName,
    defs: [],
    references: [],
    edges: [],
    referenceEdges: [],
    anchors: [],
    imports: [],
    importBindings: [],
    injections: [],
    scopes: [],
  };
}

function fixtureFacts(defs, path = 'src/fixture.ts') {
  return {
    ...emptyFacts(path),
    defs: defs.map((d) => ({
      name: d.name,
      kind: 'def',
      type: 'function',
      line: d.line,
      endLine: d.endLine,
      visibility: 'public',
      captureTag: null,
    })),
  };
}

// ── H1–H5: line-level invariants ────────────────────────────────────────────

function assertLineInvariants(source, prefixedArray, output) {
  const { visible, markers } = parseOutput(output);
  const nSource = prefixedArray.length;

  // H1: ascending shown line numbers
  for (let i = 1; i < visible.length; i++) {
    expect(visible[i].n).toBeGreaterThan(visible[i - 1].n);
  }
  for (const v of visible) {
    expect(v.n).toBeGreaterThanOrEqual(1);
    expect(v.n).toBeLessThanOrEqual(nSource);
  }

  // H2: verbatim — every shown output line matches the corresponding prefixed
  // input line EXACTLY (the `N. <content>` prefix is part of both).
  for (const v of visible) {
    const expected = prefixedArray[v.n - 1];
    expect(
      `${v.n}. ${v.text}`,
      `H2 verbatim failure at line ${v.n}`,
    ).toBe(expected);
  }

  // H3: marker format — canonical [TRUNCATED: lines X-Y] with X ≤ Y
  for (const m of markers) {
    expect(m.y).toBeGreaterThanOrEqual(m.x);
  }

  // H5: markers are disjoint from shown line numbers
  const shownSet = new Set(visible.map((v) => v.n));
  let prevHi = 0;
  for (const m of markers) {
    expect(m.x).toBeGreaterThan(prevHi);
    prevHi = m.y;
    for (let ln = m.x; ln <= m.y; ln++) {
      expect(shownSet.has(ln), `marker ${m.x}-${m.y} overlaps shown line ${ln}`).toBe(false);
    }
  }

  // H4: every internal gap ≥ 6 is covered by an exact-range marker
  for (let i = 1; i < visible.length; i++) {
    const prev = visible[i - 1];
    const curr = visible[i];
    const gap = curr.n - prev.n - 1;
    if (gap >= MIN_OMISSION) {
      const between = markers.filter((m) => m.idx > prev.idx && m.idx < curr.idx);
      const exact = between.find((m) => m.x === prev.n + 1 && m.y === curr.n - 1);
      expect(
        exact,
        `gap ${prev.n}→${curr.n} (${gap} lines) missing exact-range marker ${prev.n + 1}-${curr.n - 1}`,
      ).toBeDefined();
    }
  }

  // H7: interior shown runs ≥ 6 (at least 6 shown lines between any two markers).
  // (Note: the engine's verifyOutput labels this same invariant H5 in its throw messages.)
  for (let i = 1; i < markers.length; i++) {
    const prev = markers[i - 1];
    const curr = markers[i];
    const shownBetween = visible.filter((v) => v.idx > prev.idx && v.idx < curr.idx).length;
    expect(
      shownBetween,
      `fewer than ${MIN_OMISSION} shown lines between markers at ${prev.x}-${prev.y} and ${curr.x}-${curr.y}`,
    ).toBeGreaterThanOrEqual(MIN_OMISSION);
  }

  return { visible, markers, nSource };
}

// ── fixture: 12 small functions, 13 lines each (156 total) ──────────────────

function buildFunctionFixture() {
  const rawLines = [];
  const defs = [];
  for (let fn = 0; fn < 12; fn += 1) {
    const start = rawLines.length + 1;
    rawLines.push(`export function fn${fn}() {`);
    for (let i = 0; i < 10; i += 1) {
      rawLines.push(`  const v${fn}_${i} = "xxxxxxxxxxxxxxxxxxxx";`);
    }
    rawLines.push(`  return v${fn}_0;`);
    rawLines.push('}');
    defs.push({ name: `fn${fn}`, line: start, endLine: rawLines.length });
  }
  const source = prefixLines(prefixedArray(rawLines));
  return { rawLines, prefixedLines: prefixedArray(rawLines), source, defs, facts: fixtureFacts(defs) };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('compressFile — Priority-0 output invariants (H1–H7)', () => {
  it('H1–H5 + H7: verbatim, ascending, marker format, gap coverage, disjointness, 6-line min', () => {
    const { source, prefixedLines, facts } = buildFunctionFixture();
    const output = compressFile({ source, maxChars: Math.floor(source.length * 0.7), facts });

    expect(output).not.toBeNull();
    assertLineInvariants(source, prefixedLines, output);
  });

  it('H6: retention band — rendered output is in [68%, 72%]', () => {
    const { source, facts } = buildFunctionFixture();
    const output = compressFile({ source, maxChars: Math.floor(source.length * 0.7), facts });

    expect(output).not.toBeNull();
    const ratio = output.length / source.length;
    expect(ratio, `retention ${(ratio * 100).toFixed(1)}% below 68% floor`).toBeGreaterThanOrEqual(0.68);
    expect(ratio, `retention ${(ratio * 100).toFixed(1)}% above 72% ceiling`).toBeLessThanOrEqual(0.72);
  });

  it('returns null when no useful compression is possible (small file fits in budget)', () => {
    const rawLines = ['export function tiny() {', '  return 1;', '}'];
    const source = prefixLines(prefixedArray(rawLines));
    const facts = fixtureFacts([{ name: 'tiny', line: 1, endLine: 3 }]);

    expect(compressFile({ source, maxChars: source.length + 100, facts })).toBeNull();
  });

  it('budget sweep — compressFile never throws across a range of budgets', () => {
    const { source, facts } = buildFunctionFixture();
    const budgets = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.5, 2.0];

    for (const mult of budgets) {
      const maxChars = Math.floor(source.length * mult);
      // Must not throw — compressFile catches internally and degrades to null.
      const result = compressFile({ source, maxChars, facts });
      // Both string and null are valid outcomes; only exception is a bug.
      expect([null, 'string']).toContain(result === null ? null : typeof result);
    }
  });

  it('empty input returns null', () => {
    expect(compressFile({ source: '', maxChars: 100, facts: emptyFacts() })).toBeNull();
  });

  it('single-line input returns null (nothing to drop)', () => {
    const line = 'export const single = 1;';
    const source = `1. ${line}`;
    expect(compressFile({ source, maxChars: 50, facts: emptyFacts() })).toBeNull();
  });
});
