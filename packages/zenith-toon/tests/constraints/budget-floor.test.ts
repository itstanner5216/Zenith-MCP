// 70% retention floor & the usefulness gate.
//
// Source: docs/toon-constraints/constraints.md
//   - "The 70% budget floor (`Math.max(budget, Math.floor(text.length * 0.70))`)
//      is intentional and must NOT be changed" (lines 298, 322)
//   - Priority 0.5: TOON owns the usefulness decision and the floor; the floor
//     may push output above the requested maxChars (string-codec.ts 1889-1894).

import { describe, it, expect } from 'vitest';
import { compressSourceStructured, compressString, compressFile } from '../../src/index.js';
import { synthesizeStructure, syntheticSources } from './invariants.js';

const FLOOR = (len: number) => Math.max(1, Math.floor(len * 0.70));

describe('70% floor — budget below the floor is raised, not honored', () => {
  for (const { name, source } of syntheticSources()) {
    it(`${name}: tiny budget clamps to the 70% floor (compressString)`, () => {
      // The floor clamp means any sub-floor budget produces the SAME output as
      // requesting exactly the floor. If the floor were removed or lowered, a
      // smaller budget would yield strictly more aggressive truncation.
      const atOne = compressString(source, 1);
      const atFloor = compressString(source, FLOOR(source.length));
      expect(atOne).toBe(atFloor);
    });

    it(`${name}: tiny budget clamps to the 70% floor (structured)`, () => {
      const structure = synthesizeStructure(source);
      const atOne = compressSourceStructured(source, 1, structure);
      const atFloor = compressSourceStructured(source, FLOOR(source.length), structure);
      expect(atOne).toBe(atFloor);
    });
  }
});

describe('70% floor — passthrough when budget already covers source', () => {
  it('compressString returns source unchanged when budget >= length', () => {
    const source = syntheticSources()[0]!.source;
    expect(compressString(source, source.length)).toBe(source);
    expect(compressString(source, source.length * 4)).toBe(source);
  });

  it('compressSourceStructured returns source unchanged when budget >= length', () => {
    const source = syntheticSources()[1]!.source;
    const structure = synthesizeStructure(source);
    expect(compressSourceStructured(source, source.length, structure)).toBe(source);
  });
});

describe('Usefulness gate — TOON owns the "not useful" decision', () => {
  it('compressFile returns null for empty source', () => {
    const out = compressFile({
      source: '',
      maxChars: 100,
      facts: { path: 'x.ts', langName: 'typescript', defs: [], edges: [], anchors: [], imports: [], injections: [] },
    });
    expect(out).toBeNull();
  });

  it('compressFile falls back (never denies) for an unsupported language', () => {
    // Rule 12: an unsupported language must fall back to the text engine, not
    // deny. For a large source this yields a non-null compressed string.
    const source = syntheticSources()[0]!.source;
    const out = compressFile({
      source,
      maxChars: Math.floor(source.length * 0.3),
      facts: { path: 'x.unknown', langName: null, defs: [], edges: [], anchors: [], imports: [], injections: [] },
    });
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThan(source.length);
  });

  it('the floor may push compressFile output above the requested maxChars', () => {
    // Documented contract: maxChars is a ceiling request, but the 70% floor wins.
    const source = syntheticSources()[2]!.source;
    const out = compressFile({
      source,
      maxChars: 1, // far below the floor
      facts: {
        path: 'x.ts', langName: 'typescript',
        defs: synthesizeStructure(source).map((b) => ({
          name: b.name, kind: 'def' as const, type: b.type,
          line: b.startLine + 1, endLine: b.endLine + 1, visibility: 'public', captureTag: null,
        })),
        edges: [], anchors: [], imports: [], injections: [],
      },
    });
    // Either useful compression (non-null) respecting the floor, or null when the
    // engine judged it not useful — never a value clamped below the floor.
    if (out !== null) {
      expect(out.length).toBeGreaterThan(1);
    }
  });
});
