// validate.test.ts
//
// Pure output validation for compressFile. Takes the original raw text and the
// compressed output string and answers only questions you can settle by reading
// the two texts against each other. Every check is a property of the OUTPUT.
//
// Constraints enforced (AGENTS.md repo-wide contract):
//   1. Structure        — every output line is a valid marker OR an `N. ` content line
//   2. Line fidelity    — every shown line carries its TRUE original number, content verbatim
//   3. Coverage         — output reconstructs [1..N] exactly: ascending, no silent gaps
//   4. Marker format    — exactly `[TRUNCATED: lines X-Y]`, flush-left, real range
//   5. Min block (6)    — every block of consecutive shown lines is >= 6 (Rule 1)
//   6. Ratio            — retained content in [68%, 72%]

import { describe, it, expect } from 'vitest';
import { compressFile } from '../../src/index.js';
import type { CompressFileRequest } from '../../src/index.js';

// ── Parsing ────────────────────────────────────────────────────────────────────

const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const SHOWN_RE = /^(\d+)\. (.+)$/;

function parseOutput(output: string) {
  const outLines = output.split('\n');
  if (outLines.length > 0 && outLines[outLines.length - 1] === '') outLines.pop();

  const visible: { n: number; raw: string; text: string }[] = [];
  const markers: { x: number; y: number; raw: string }[] = [];
  const bad: string[] = [];

  for (const raw of outLines) {
    const mm = MARKER_RE.exec(raw);
    if (mm) {
      markers.push({ x: Number(mm[1]), y: Number(mm[2]), raw });
      continue;
    }
    const sm = SHOWN_RE.exec(raw);
    if (sm) {
      visible.push({ n: Number(sm[1]), raw, text: sm[2] });
      continue;
    }
    bad.push(raw);
  }
  return { visible, markers, bad };
}

// ── Validation ─────────────────────────────────────────────────────────────────

interface Metrics {
  originalLines: number;
  shownLines: number;
  markers: number;
  retainedPct: number;
  minShownBlock: number;
}

function validate(rawOriginal: string, output: string): Metrics {
  const originalLines = rawOriginal.split('\n');
  const lineCount = originalLines.length;

  const { visible, markers, bad } = parseOutput(output);

  // 1. Structure
  expect(bad, `unrecognized output line(s): ${JSON.stringify(bad[0])}`).toHaveLength(0);

  // 2. Line fidelity — every shown line matches the original
  for (const v of visible) {
    expect(v.n).toBeGreaterThanOrEqual(1);
    expect(v.n).toBeLessThanOrEqual(lineCount);
    const expected = `${v.n}. ${originalLines[v.n - 1] ?? ''}`;
    expect(v.raw, `line ${v.n} not verbatim`).toBe(expected);
  }

  // 3. Coverage — walk output lines in order. Every gap >= 1 between
  // cursor+1 and the next token must match a marker. Shown lines must
  // appear at cursor+1 (ascending).
  let cursor = 0;
  const shownRuns: number[] = [];
  let currentRun = 0;
  const closeRun = () => {
    if (currentRun > 0) shownRuns.push(currentRun);
    currentRun = 0;
  };

  // Build tokens in output order from the already-parsed visible+markers.
  // The output is lines, each is either visible or marker. Build a unified
  // ordered list by re-walking the output.
  const outLines = output.split('\n');
  if (outLines.length > 0 && outLines[outLines.length - 1] === '') outLines.pop();

  const vSet = new Map(visible.map((v) => [v.raw, v]));
  const mSet = new Map(markers.map((m) => [m.raw, m]));

  for (const raw of outLines) {
    const v = vSet.get(raw);
    if (v) {
      if (v.n !== cursor + 1) {
        expect(v.n, `line ${v.n}: expected ${cursor + 1} (gap or out of order)`).toBe(cursor + 1);
      }
      cursor = v.n;
      currentRun++;
      continue;
    }
    const m = mSet.get(raw);
    if (m) {
      closeRun();
      expect(m.x).toBeLessThanOrEqual(m.y);
      expect(m.x, `marker ${m.raw}: expected start ${cursor + 1}, got ${m.x}`).toBe(cursor + 1);
      expect(m.x).toBeGreaterThanOrEqual(1);
      expect(m.y).toBeLessThanOrEqual(lineCount);
      cursor = m.y;
      continue;
    }
  }
  closeRun();
  expect(cursor, `output ends at ${cursor}, original has ${lineCount}`).toBe(lineCount);

  // 4. Marker format — checked inline above (y >= x, range bounds)

  // 5. Min block >= 6 (Rule 1: interior shown runs only — between two markers)
  // Head and tail blocks are NOT required to meet the minimum.
  const interiorRuns = shownRuns.length > 2
    ? shownRuns.slice(1, -1)
    : [];
  for (const run of interiorRuns) {
    expect(run, `interior shown block of ${run} lines < 6`).toBeGreaterThanOrEqual(6);
  }
  const minBlock = shownRuns.length > 0 ? Math.min(...shownRuns) : Infinity;

  // 6. Ratio [68%, 72%]
  const fullChars = originalLines.reduce((a, l) => a + l.length, 0);
  const keptChars = visible.reduce((a, v) => a + (originalLines[v.n - 1] ?? '').length, 0);
  const markerChars = markers.reduce((a, m) => a + m.raw.length, 0);
  const retainedPct = fullChars > 0 ? ((keptChars + markerChars) / fullChars) * 100 : 100;
  expect(retainedPct, `retention ${retainedPct.toFixed(1)}% outside [68%,72%]`).toBeGreaterThanOrEqual(68);
  expect(retainedPct).toBeLessThanOrEqual(72);

  return {
    originalLines: lineCount,
    shownLines: visible.length,
    markers: markers.length,
    retainedPct,
    minShownBlock: minBlock,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function prefix(raw: string): string {
  return raw.split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n');
}

function facts(overrides: Partial<CompressFileRequest['facts']> = {}): CompressFileRequest['facts'] {
  return {
    path: 'src/fixture.ts',
    langName: 'typescript',
    defs: [],
    references: [],
    edges: [],
    referenceEdges: [],
    anchors: [],
    imports: [],
    importBindings: [],
    injections: [],
    scopes: [],
    ...overrides,
  };
}

function fixture12Functions(): { raw: string; defs: CompressFileRequest['facts']['defs'] } {
  const lines: string[] = [];
  const defs: CompressFileRequest['facts']['defs'] = [];
  for (let fn = 0; fn < 12; fn += 1) {
    const start = lines.length + 1;
    lines.push(`export function fn${fn}() {`);
    for (let i = 0; i < 10; i += 1) {
      lines.push(`  const v${fn}_${i} = "xxxxxxxxxxxxxxxxxxxx";`);
    }
    lines.push(`  return v${fn}_0;`);
    lines.push('}');
    defs.push({ name: `fn${fn}`, kind: 'def', type: 'function', line: start, endLine: lines.length, visibility: 'public', captureTag: null });
  }
  return { raw: lines.join('\n'), defs };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validate output invariants', () => {
  it('12-function fixture passes all validation gates', () => {
    const { raw, defs } = fixture12Functions();
    const source = prefix(raw);
    const output = compressFile({ source, maxChars: Math.floor(source.length * 0.7), facts: facts({ defs }) });

    if (output === null) {
      throw new Error('compressFile returned null for the compressible 12-function fixture');
    }
    const m = validate(raw, output);
    expect(m.shownLines).toBeGreaterThan(0);
    expect(m.markers).toBeGreaterThan(0);
    expect(m.retainedPct).toBeGreaterThanOrEqual(68);
    expect(m.retainedPct).toBeLessThanOrEqual(72);
  });

  it('tiny file returns null (raw is served)', () => {
    const raw = 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n';
    const source = prefix(raw);
    expect(compressFile({ source, maxChars: source.length + 100, facts: facts() })).toBeNull();
  });

  it('empty file returns null', () => {
    expect(compressFile({ source: '', maxChars: 100, facts: facts() })).toBeNull();
  });
});
