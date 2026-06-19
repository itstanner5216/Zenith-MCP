// Phase H — the inline Priority-0 assertion can never fail for valid input.
//
// Source: docs/toon-constraints/constraints.md lines 5-11:
//   "add an inline assertion before Phase H emits ... If this assertion can ever
//    fail, the implementation is broken." And string-codec.ts 1611-1630 throws on
//   any non-ascending / out-of-range / sub-threshold-but-unselected gap.
//
// Strategy: hammer the structured engine with randomized (but reproducible)
// StructureBlock layouts and budgets over the real fixtures. The engine must
// never throw and every output must satisfy the full Priority-0 contract.

import { describe, it, expect } from 'vitest';
import { compressSourceStructured } from '../../src/index.js';
import type { StructureBlock } from '../../src/index.js';
import { assertLineTruth, mulberry32, readFixture, readToonSource } from './invariants.js';

const REAL_FIXTURES = ['test-typescript.ts', 'test-python.py', 'test-rust.rs'];

function randomStructure(source: string, rng: () => number): StructureBlock[] {
  const total = source.split('\n').length;
  const blocks: StructureBlock[] = [];
  const count = 2 + Math.floor(rng() * 10);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(rng() * total);
    const span = Math.floor(rng() * 30);
    const end = Math.min(total - 1, start + span);
    const anchorLine = start + Math.floor(rng() * Math.max(1, end - start));
    blocks.push({
      name: `blk${i}`,
      kind: 'def',
      type: rng() > 0.5 ? 'function' : 'class',
      startLine: start,
      endLine: end,
      exported: rng() > 0.5,
      anchors:
        rng() > 0.4
          ? [{ startLine: anchorLine, endLine: anchorLine, kind: rng() > 0.5 ? 'return' : 'if', priority: 400 }]
          : [],
    });
  }
  return blocks;
}

describe('Phase H — randomized structures never break Priority-0', () => {
  for (const fixture of REAL_FIXTURES) {
    it(`${fixture}: 200 random structure/budget combinations stay line-true`, () => {
      const source = readFixture(fixture);
      const rng = mulberry32(0xC0FFEE ^ fixture.length);
      for (let iter = 0; iter < 200; iter++) {
        const structure = randomStructure(source, rng);
        const budget = 1 + Math.floor(rng() * source.length);
        let out = '';
        // Phase H must never throw for in-range structure.
        expect(() => {
          out = compressSourceStructured(source, budget, structure);
        }, `${fixture} iter ${iter}`).not.toThrow();
        // And the emitted output must satisfy the contract.
        assertLineTruth(source, out, { minGap: 6, label: `${fixture}#${iter}` });
    });
  }
});

describe('Phase H — the assertion is present and wired to the threshold', () => {
  it('string-codec.ts still throws a Priority-0 violation on sub-threshold gaps', () => {
    const src = readToonSource('string-codec.ts');
    // The guard text must remain — silently deleting it would let drift through.
    expect(src).toMatch(/Priority-0 violation: selected index .* out of range/);
    expect(src).toMatch(/Priority-0 violation: selected indices not strictly ascending/);
    expect(src).toMatch(/Priority-0 violation: gap .* but not fully selected/);
    // The gap guard must compare against the named threshold constant.
    expect(src).toMatch(/gap > 0 && gap < _MIN_OMISSION_THRESHOLD/);
  });
});
