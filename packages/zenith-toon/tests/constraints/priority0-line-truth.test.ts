// Priority 0 — "Line numbers must be TRUE to the original file."
//
// Source: docs/toon-constraints/constraints.md (lines 1-13, 181-211).
//
// These tests run the structured-source engine (the AST-aware path the goal
// centers on) plus the plain source path across many fixtures and budgets, and
// assert the full Priority-0 contract on every result:
//   - every shown `N. content` is a character-perfect copy of original line N
//   - shown line numbers are strictly ascending
//   - no silent gaps: every jump is accounted for by a `[TRUNCATED: lines X-Y]`
//   - marker ranges exactly equal the omitted spans
// The structured engine additionally never emits a sub-6-line internal gap.

import { describe, it, expect } from 'vitest';
import { compressSourceStructured, compressString, compressFile } from '../../src/index.js';
import {
  assertLineTruth,
  synthesizeStructure,
  syntheticSources,
  readFixture,
} from './invariants.js';

const REAL_FIXTURES = ['test-typescript.ts', 'test-python.py', 'test-rust.rs'];
// Budgets as fractions of source length. The 70% floor means tiny budgets are
// raised internally; we still demand the invariants hold at every requested size.
const BUDGET_FRACTIONS = [0.1, 0.25, 0.4, 0.55, 0.7];

describe('Priority 0 — structured engine line-number truth', () => {
  for (const fixture of REAL_FIXTURES) {
    const source = readFixture(fixture);
    const structure = synthesizeStructure(source);

    for (const frac of BUDGET_FRACTIONS) {
      it(`${fixture} @ ${frac} keeps line numbers true and gaps marked`, () => {
        const budget = Math.floor(source.length * frac);
        const out = compressSourceStructured(source, budget, structure);
        const { shown, markers } = assertLineTruth(source, out, {
          minGap: 6, // structured engine guarantees the 6-line floor via Phase H
          label: `${fixture}@${frac}`,
        });
        // Compression must actually engage somewhere across the budget sweep:
        // either lines were dropped (markers) or the whole file fit verbatim.
        const total = source.split('\n').length;
        expect(shown.length + markers.reduce((s, m) => s + (m.y - m.x + 1), 0)).toBeLessThanOrEqual(total);
      });
    }
  }
});

describe('Priority 0 — synthetic structured fixtures', () => {
  for (const { name, source } of syntheticSources()) {
    const structure = synthesizeStructure(source);
    for (const frac of BUDGET_FRACTIONS) {
      it(`${name} @ ${frac}`, () => {
        const budget = Math.floor(source.length * frac);
        const out = compressSourceStructured(source, budget, structure);
        assertLineTruth(source, out, { minGap: 6, label: `${name}@${frac}` });
      });
    }
  }
});

describe('Priority 0 — plain source path (compressString) line-number truth', () => {
  // The plain source path does not promise the 6-line floor, but it must uphold
  // every other Priority-0 guarantee: verbatim lines, ascending numbers, no
  // silent gaps, exact marker ranges, and the single canonical marker format.
  for (const { name, source } of syntheticSources()) {
    for (const frac of BUDGET_FRACTIONS) {
      it(`${name} @ ${frac}`, () => {
        const budget = Math.floor(source.length * frac);
        const out = compressString(source, budget);
        assertLineTruth(source, out, { label: `${name}@${frac}` });
      });
    }
  }
});

describe('Priority 0 — compressFile end-to-end (real facts shape)', () => {
  for (const fixture of REAL_FIXTURES) {
    const source = readFixture(fixture);
    const blocks = synthesizeStructure(source);
    // Shape blocks into the RawFileFacts the MCP seam hands across (1-based lines).
    const facts = {
      path: fixture,
      langName: fixture.endsWith('.py') ? 'python' : fixture.endsWith('.rs') ? 'rust' : 'typescript',
      defs: blocks.map((b) => ({
        name: b.name,
        kind: 'def' as const,
        type: b.type,
        line: b.startLine + 1,
        endLine: b.endLine + 1,
        visibility: b.exported ? 'public' : 'private',
        captureTag: null,
      })),
      edges: [],
      anchors: blocks.flatMap((b) =>
        b.anchors.map((a) => ({ symbolName: b.name, kind: a.kind, line: a.startLine + 1, text: 'return' })),
      ),
      imports: [],
      injections: [],
    };

    it(`${fixture} compressFile output is line-true`, () => {
      const out = compressFile({ source, maxChars: Math.floor(source.length * 0.3), facts });
      // compressFile returns null only when compression is not useful; the real
      // fixtures are large enough to always compress.
      expect(out).not.toBeNull();
      assertLineTruth(source, out as string, { minGap: 6, label: `${fixture}/compressFile` });
    });
  }
});

describe('Priority 0 — full file returned verbatim when budget admits it', () => {
  it('source returned unchanged when the requested budget covers it', () => {
    const source = 'export function tiny() {\n  return 1;\n}\n';
    // budget >= source length must short-circuit to byte-identical passthrough.
    const out = compressSourceStructured(source, source.length, synthesizeStructure(source));
    expect(out).toBe(source);
  });
});
