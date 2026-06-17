// Omission markers — format, uniqueness, flush-left, and the 6-line floor.
//
// Source: docs/toon-constraints/constraints.md
//   - §1 _MIN_OMISSION_THRESHOLD = 6 (lines 161-181, 295)
//   - §3 single canonical marker `[TRUNCATED: lines X-Y]` (lines 194-258)
//   - anti-pattern table (lines 303-323): no `# ... [N lines omitted]`,
//     no `# L{n}`, no indented markers, no threshold = 1.

import { describe, it, expect } from 'vitest';
import { compressSourceStructured } from '../../src/index.js';
import {
  MARKER_RE,
  LEGACY_OMISSION_RE,
  L_ANNOTATION_RE,
  assertLineTruth,
  synthesizeStructure,
  syntheticSources,
  readFixture,
} from './invariants.js';

const REAL_FIXTURES = ['test-typescript.ts', 'test-python.py', 'test-rust.rs'];

function allStructuredOutputs(): Array<{ name: string; source: string; out: string }> {
  const results: Array<{ name: string; source: string; out: string }> = [];
  const sources = [
    ...REAL_FIXTURES.map((f) => ({ name: f, source: readFixture(f) })),
    ...syntheticSources(),
  ];
  for (const { name, source } of sources) {
    const structure = synthesizeStructure(source);
    for (const frac of [0.1, 0.2, 0.3, 0.45, 0.6]) {
      const out = compressSourceStructured(source, Math.floor(source.length * frac), structure);
      results.push({ name: `${name}@${frac}`, source, out });
    }
  }
  return results;
}

describe('Omission markers — canonical format only', () => {
  const outputs = allStructuredOutputs();

  it('every marker matches `[TRUNCATED: lines X-Y]` exactly and flush-left', () => {
    for (const { name, out } of outputs) {
      for (const line of out.split('\n')) {
        // Any line mentioning TRUNCATED must match the canonical shape exactly.
        if (line.includes('TRUNCATED')) {
          expect(line, `${name}: marker must be flush-left and canonical`).toMatch(MARKER_RE);
        }
        // Markers must never be indented.
        if (/TRUNCATED/.test(line)) {
          expect(line.startsWith(' ') || line.startsWith('\t'), `${name}: marker indented`).toBe(false);
        }
      }
    }
  });

  it('no legacy `# ... [N lines omitted]` count-only markers appear', () => {
    for (const { name, out } of outputs) {
      expect(LEGACY_OMISSION_RE.test(out), `${name}`).toBe(false);
    }
  });

  it('no `# L{n}` signature annotations appear', () => {
    for (const { name, out } of outputs) {
      expect(L_ANNOTATION_RE.test(out), `${name}`).toBe(false);
    }
  });

  it('marker ranges are strictly ascending and non-overlapping', () => {
    for (const { name, source, out } of outputs) {
      const { markers } = assertLineTruth(source, out, { minGap: 6, label: name });
      for (let i = 1; i < markers.length; i++) {
        expect(markers[i]!.x, `${name}: markers must not overlap`).toBeGreaterThan(markers[i - 1]!.y);
      }
    }
  });
});

describe('Omission markers — 6-line floor on the structured engine', () => {
  it('no internal omission gap is smaller than 6 lines', () => {
    for (const { name, source, out } of allStructuredOutputs()) {
      const { markers } = assertLineTruth(source, out, { label: name });
      for (const m of markers) {
        const span = m.y - m.x + 1;
        // Trailing-to-EOF markers are still bounded by the engine; an internal
        // marker (one abutted by shown lines on both sides) must span >= 6.
        const isTrailing = m.y === source.split('\n').length;
        if (!isTrailing) {
          expect(span, `${name}: internal gap ${m.x}-${m.y} < 6`).toBeGreaterThanOrEqual(6);
        }
      }
    }
  });

  it('small structural gaps are filled, not turned into sub-6 markers', () => {
    // Two blocks 3 lines apart: the engine must either show the gap or merge it
    // into a >=6 omission — never emit `[TRUNCATED: lines a-b]` for a 3-line hole.
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`function head${i}() { return ${i}; }`);
    lines.push('// gA');
    lines.push('// gB');
    lines.push('// gC');
    for (let i = 0; i < 20; i++) lines.push(`function tail${i}() { return ${i}; }`);
    const source = lines.join('\n');
    const structure = synthesizeStructure(source);
    const out = compressSourceStructured(source, Math.floor(source.length * 0.5), structure);
    const { markers } = assertLineTruth(source, out, { minGap: 6, label: 'gap-fill' });
    for (const m of markers) {
      expect(m.y - m.x + 1).toBeGreaterThanOrEqual(6);
    }
  });
});
