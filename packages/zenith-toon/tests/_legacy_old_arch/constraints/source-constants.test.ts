// Source-constant guards — the constants the constraints forbid changing.
//
// Source: docs/toon-constraints/constraints.md §"Constraints on the
// Implementation" (lines 291-299) and §6 "No Helpers, No Wrappers" (213-222,
// 280-289). These pin the literal invariants in zenith-toon/src/string-codec.ts.

import { describe, it, expect } from 'vitest';
import { readToonSource } from './invariants.js';

const codec = readToonSource('string-codec.ts');

describe('Constants — the 6-line omission threshold', () => {
  it('_MIN_OMISSION_THRESHOLD is declared as exactly 6', () => {
    expect(codec).toMatch(/const\s+_MIN_OMISSION_THRESHOLD\s*=\s*6\s*;/);
    // Guard against a silent downgrade to a useless 1-line threshold.
    expect(codec).not.toMatch(/_MIN_OMISSION_THRESHOLD\s*=\s*1\s*;/);
  });

  it('the threshold constant is still referenced by the selection/emit logic', () => {
    const refs = [...codec.matchAll(/_MIN_OMISSION_THRESHOLD/g)];
    // Many call sites enforce it; a handful at minimum must remain wired in.
    expect(refs.length).toBeGreaterThanOrEqual(5);
  });
});

describe('Constants — the 70% retention floor', () => {
  it('the floor expression is present in both public string entry points', () => {
    const floors = [...codec.matchAll(/Math\.max\(1,\s*Math\.floor\(text\.length\s*\*\s*0\.70\)\)/g)];
    // compressString and compressSourceStructured each enforce it.
    expect(floors.length).toBeGreaterThanOrEqual(2);
  });

  it('the floor uses the canonical 0.70 ratio (lowering it drops the match above)', () => {
    // The two enforced floor sites are the exact `* 0.70` form; a weakened ratio
    // would change those literals and fail the >= 2 assertion above. Pin the
    // literal directly too for an explicit failure message on drift.
    expect(codec).toMatch(/Math\.floor\(text\.length\s*\*\s*0\.70\)/);
  });
});

describe('Marker template — single canonical literal, no count-only format', () => {
  it('the only emitted marker template is `[TRUNCATED: lines X-Y]`', () => {
    const templates = [...codec.matchAll(/\[TRUNCATED: lines \$\{[^}]+\}-\$\{[^}]+\}\]/g)];
    expect(templates.length, 'canonical marker template must be used').toBeGreaterThan(0);
  });

  it('no `[N lines omitted]` count-only marker is emitted from source', () => {
    expect(codec).not.toMatch(/lines\s+omitted/i);
  });

  it('no `# L{n}` signature-annotation template is emitted from source', () => {
    expect(codec).not.toMatch(/`#\s*L\$\{/);
    expect(codec).not.toMatch(/'#\s*L'\s*\+/);
  });
});

describe('Signature & exports — the public contract is unchanged', () => {
  it('compressSourceStructured keeps its (text, budget, structure, context?) shape', () => {
    // Order and names are part of the seam contract MCP relies on.
    const sig = codec.match(
      /export function compressSourceStructured\(\s*text:\s*string,\s*budget:\s*number,\s*structure:\s*StructureBlock\[\],\s*context\?:\s*CompressionContext,?\s*\):\s*string/,
    );
    expect(sig, 'compressSourceStructured signature drifted').not.toBeNull();
  });

  it('compressSourceStructured and compressFile remain exported', () => {
    expect(codec).toMatch(/export function compressSourceStructured\(/);
    expect(codec).toMatch(/export function compressFile\(/);
    expect(codec).toMatch(/export function compressString\(/);
  });
});

describe('No helper/wrapper abstractions over marker emission', () => {
  it('no centralizing marker/line-emit helpers were introduced', () => {
    // §6: emission stays inline. Guard against the exact abstractions the
    // constraints call out (and close variants).
    const BANNED_HELPERS = [
      /\bformatOmissionMarker\b/,
      /\bformatMarker\b/,
      /\bemitMarker\b/,
      /\bemitOmission\b/,
      /\bemitLine\b/,
      /\bemitLines\b/,
    ];
    for (const re of BANNED_HELPERS) {
      expect(re.test(codec), `banned helper abstraction ${re} found`).toBe(false);
    }
  });
});
