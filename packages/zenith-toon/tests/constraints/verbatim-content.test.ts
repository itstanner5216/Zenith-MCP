// Verbatim output & no synthetic summarization.
//
// Source: docs/toon-constraints/constraints.md
//   - §2 verbatim, character-perfect lines (lines 183-236)
//   - §4 no "smart" per-item JSON/array compression (lines 205-262)
//   - anti-pattern table: no "summary" lines, no `{ showing: [...], total }`,
//     no comment stripping, no reordering (lines 303-323)
// And docs/toon-goal/zenith-toon-goal.md: "must not move, paraphrase,
// synthesize, or annotate file content."

import { describe, it, expect } from 'vitest';
import { compressSourceStructured } from '../../src/index.js';
import type { StructureBlock } from '../../src/index.js';
import { assertLineTruth, synthesizeStructure } from './invariants.js';

// Tokens that betray synthetic/summarized output — none may appear.
const SYNTHETIC_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\.\.\.\s*\(\d+\s+more/i, why: '"... (N more items)" array summary' },
  { re: /\bshowing\s*:/i, why: '`showing:` item-selection summary' },
  { re: /\b\d+\s+(?:helper\s+)?(?:functions?|items?|lines?)\s+omitted\b/i, why: 'count-only "N omitted" summary' },
  { re: /"__toon(?:_template)?"/, why: 'TOON pipeline metadata leaked into source output' },
];

describe('Verbatim — structured source output never synthesizes', () => {
  it('keeps comments and string literals byte-perfect', () => {
    const source = [
      '// IMPORTANT: do not strip this comment',
      'export function build(config) {',
      '  const banner = "Zenith-TOON :: verbatim guarantee";',
      '  // step 1: validate',
      '  if (!config) throw new Error("missing config");',
      '  // step 2: assemble',
      '  const parts = [];',
      '  for (let i = 0; i < 10; i++) parts.push(`row ${i}`);',
      '  // step 3: join',
      '  return parts.join("\\n");',
      '}',
      'export function teardown() {',
      '  // cleanup comment that must survive verbatim',
      '  return null;',
      '}',
    ].join('\n');
    const out = compressSourceStructured(source, Math.floor(source.length * 0.5), synthesizeStructure(source));
    // Every shown line is verbatim (checker enforces character-perfect copy).
    assertLineTruth(source, out, { minGap: 6, requireTrailingMarker: false,
          requireLeadingMarker: false, label: 'verbatim-comments' });
    for (const { re, why } of SYNTHETIC_PATTERNS) {
      expect(re.test(out), `synthetic content: ${why}`).toBe(false);
    }
  });

  it('does not emit synthetic per-item summaries for JSON given structure', () => {
    // A JSON document compressed through the STRUCTURED path (caller supplies
    // block bounds) must be line-edited like any other file — never collapsed
    // into `"... (N more similar items)"` or `{ showing: [...] }`.
    const items = Array.from({ length: 60 }, (_, i) => `  { "id": ${i}, "name": "item-${i}", "active": ${i % 2 === 0} }`);
    const source = ['[', items.join(',\n'), ']'].join('\n');
    const total = source.split('\n').length;
    // One synthetic block spanning the array body so structure.length > 0.
    const structure: StructureBlock[] = [
      {
        name: 'array', kind: 'def', type: 'array',
        startLine: 0, endLine: total - 1, exported: true, anchors: [],
      },
    ];
    const out = compressSourceStructured(source, Math.floor(source.length * 0.4), structure);
    assertLineTruth(source, out, { minGap: 6, requireTrailingMarker: false,
          requireLeadingMarker: false, label: 'json-structured' });
    for (const { re, why } of SYNTHETIC_PATTERNS) {
      expect(re.test(out), `JSON synthetic content: ${why}`).toBe(false);
    }
  });

  it('never reorders lines (output line numbers are monotonic)', () => {
    const source = Array.from({ length: 50 }, (_, i) => `const v${i} = step(${i});`).join('\n');
    const out = compressSourceStructured(source, Math.floor(source.length * 0.3), synthesizeStructure(source));
    const { shown } = assertLineTruth(source, out, { minGap: 6, requireTrailingMarker: false,
          requireLeadingMarker: false, label: 'no-reorder' });
    const sorted = [...shown].sort((a, b) => a - b);
    expect(shown).toEqual(sorted);
  });
});
