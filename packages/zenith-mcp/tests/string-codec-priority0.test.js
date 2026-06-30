import { describe, expect, it } from 'vitest';

import { compressSourceStructured } from 'zenith-toon';

// ---------------------------------------------------------------------------
// Priority-0 invariant tests for the structured-source compression path.
//
// These assert directly on real `compressSourceStructured` output:
//   - every non-marker line is `N. <verbatim content>` (1-based, character-exact)
//   - markers are exactly `[TRUNCATED: lines X-Y]`, flush-left, ascending,
//     non-overlapping with shown line numbers
//   - no two markers sandwich fewer than 6 shown non-blank lines
//   - the inline Phase-H assertion never throws on valid input
// Fixtures are tiny and inline; budgets are tight so omissions are forced.
// ---------------------------------------------------------------------------

const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const SHOWN_RE = /^(\d+)\. ([\s\S]*)$/;

/** Build a StructureBlock; 0-based start/end inclusive, matching toon's types. */
function block(name, kind, startLine, endLine, exported, anchors = []) {
  return { name, kind, type: kind, startLine, endLine, exported, anchors };
}

function anchor(startLine, endLine, kind = 'return', priority = 300) {
  return { startLine, endLine, kind, priority };
}

/**
 * Parse + validate the four Priority-0 invariants against the original source.
 * Returns the parsed marker ranges and shown line numbers for further asserts.
 */
function assertPriority0(original, compressed) {
  const origLines = original.split('\n');
  const outLines = compressed.split('\n');

  const shownNumbers = [];
  const markerRanges = [];
  // Tracks count of shown NON-BLANK lines since the previous marker.
  let nonBlankSincePrevMarker = 0;
  let sawMarker = false;

  for (const line of outLines) {
    const m = MARKER_RE.exec(line);
    if (m) {
      // No indentation/prefix allowed: the literal must equal the matched form.
      expect(line).toBe(`[TRUNCATED: lines ${m[1]}-${m[2]}]`);
      const x = Number(m[1]);
      const y = Number(m[2]);
      expect(x).toBeLessThanOrEqual(y); // valid inclusive range

      // No two markers may sandwich < 6 shown non-blank lines.
      if (sawMarker) {
        expect(nonBlankSincePrevMarker).toBeGreaterThanOrEqual(6);
      }
      sawMarker = true;
      nonBlankSincePrevMarker = 0;
      markerRanges.push([x, y]);
      continue;
    }

    const s = SHOWN_RE.exec(line);
    expect(s, `every non-marker line must be "N. ...": got ${JSON.stringify(line)}`).not.toBeNull();
    const num = Number(s[1]);
    const content = s[2];
    // Verbatim: content after the prefix equals the original line at that number.
    expect(content).toBe(origLines[num - 1]);
    shownNumbers.push(num);
    if (content.trim() !== '') nonBlankSincePrevMarker += 1;
  }

  // Shown line numbers strictly ascending.
  for (let i = 1; i < shownNumbers.length; i++) {
    expect(shownNumbers[i]).toBeGreaterThan(shownNumbers[i - 1]);
  }

  // Marker ranges ascending, non-overlapping, and disjoint from shown lines.
  const shownSet = new Set(shownNumbers);
  let prevHi = 0;
  for (const [x, y] of markerRanges) {
    expect(x).toBeGreaterThan(prevHi); // ascending + non-overlapping
    prevHi = y;
    for (let ln = x; ln <= y; ln++) {
      expect(shownSet.has(ln)).toBe(false); // truncated ranges hold no shown lines
    }
  }

  return { shownNumbers, markerRanges };
}

describe('compressSourceStructured — Priority-0 output invariants', () => {
  it('TS fixture: N. verbatim prefixes, flush-left TRUNCATED markers, no <6 sliver', () => {
    // 40-line TS file: two real functions separated by a long dead middle so a
    // tight budget must drop the middle and emit a marker.
    const tsLines = [];
    tsLines.push(`import { foo } from './foo';`);          // 1
    tsLines.push(`import { bar } from './bar';`);           // 2
    tsLines.push(``);                                       // 3
    tsLines.push(`export function alpha(x: number): number {`); // 4
    tsLines.push(`  const a = x + 1;`);                     // 5
    tsLines.push(`  const b = a * 2;`);                     // 6
    tsLines.push(`  const c = b - 3;`);                     // 7
    tsLines.push(`  return c;`);                            // 8
    tsLines.push(`}`);                                      // 9
    for (let i = 10; i <= 31; i++) {
      tsLines.push(`const dead${i} = ${i}; // filler line ${i} kept long enough to cost budget`);
    }
    tsLines.push(`export function beta(y: number): number {`); // 32
    tsLines.push(`  const p = y * 10;`);                    // 33
    tsLines.push(`  const q = p + 7;`);                     // 34
    tsLines.push(`  const r = q - 2;`);                     // 35
    tsLines.push(`  const s = r / 1;`);                     // 36
    tsLines.push(`  const t = s + 0;`);                     // 37
    tsLines.push(`  return t;`);                            // 38
    tsLines.push(`}`);                                      // 39
    tsLines.push(``);                                       // 40
    const ts = tsLines.join('\n');

    // 0-based inclusive lines. alpha: 3..8, beta: 31..38 (with return anchors).
    const structure = [
      block('alpha', 'function', 3, 8, true, [anchor(7, 7)]),
      block('beta', 'function', 31, 38, true, [anchor(37, 37)]),
    ];

    const budget = Math.floor(ts.length * 0.45); // below 0.70 floor → floor governs
    const out = compressSourceStructured(ts, budget, structure);

    // Must have actually compressed (markers present) given the tight budget.
    expect(out).toMatch(/\[TRUNCATED: lines \d+-\d+\]/);
    const { markerRanges } = assertPriority0(ts, out);
    expect(markerRanges.length).toBeGreaterThanOrEqual(1);
  });

  it('Python fixture: verbatim mapping holds and markers cover real ranges', () => {
    const pyLines = [];
    pyLines.push(`import os`);                              // 1
    pyLines.push(`import sys`);                             // 2
    pyLines.push(``);                                       // 3
    pyLines.push(`def compute(values):`);                  // 4
    pyLines.push(`    total = 0`);                          // 5
    pyLines.push(`    for v in values:`);                   // 6
    pyLines.push(`        total += v`);                     // 7
    pyLines.push(`    return total`);                       // 8
    pyLines.push(``);                                       // 9
    for (let i = 10; i <= 33; i++) {
      pyLines.push(`_unused_${i} = ${i}  # padding constant number ${i} to consume budget`);
    }
    pyLines.push(`def summarize(rows):`);                   // 34
    pyLines.push(`    acc = []`);                           // 35
    pyLines.push(`    for r in rows:`);                     // 36
    pyLines.push(`        acc.append(r * 2)`);              // 37
    pyLines.push(`        acc.append(r + 1)`);              // 38
    pyLines.push(`    result = sum(acc)`);                  // 39
    pyLines.push(`    return result`);                      // 40
    const py = pyLines.join('\n');

    // compute: 3..7 (return anchor 7), summarize: 33..39 (return anchor 39).
    const structure = [
      block('compute', 'function', 3, 7, true, [anchor(7, 7)]),
      block('summarize', 'function', 33, 39, true, [anchor(39, 39)]),
    ];

    const budget = Math.floor(py.length * 0.5);
    const out = compressSourceStructured(py, budget, structure);

    expect(out).toMatch(/\[TRUNCATED: lines \d+-\d+\]/);
    assertPriority0(py, out);
  });

  it('Phase-H never throws and emits no <6 shown sliver between two markers', () => {
    // Force a configuration that, before sliver settling, would leave a tiny
    // shown island (a single anchor line) between two omitted regions. The
    // settle step must either expand it to >=6 or drop it — never leave a <6
    // sliver — and the assertion must not throw.
    const lines = [];
    for (let i = 1; i <= 12; i++) lines.push(`head_filler_${i} = ${i}  # leading filler ${i}`); // 1..12
    lines.push(`def important(a, b, c):`);   // 13
    lines.push(`    x = a + b`);              // 14
    lines.push(`    y = x + c`);              // 15
    lines.push(`    return y`);               // 16 (anchor)
    for (let i = 17; i <= 40; i++) lines.push(`tail_filler_${i} = ${i}  # trailing filler ${i}`); // 17..40
    const src = lines.join('\n');

    // Only one tiny important block (with a return anchor) in the middle.
    const structure = [
      block('important', 'function', 12, 15, true, [anchor(15, 15)]),
    ];

    const budget = Math.floor(src.length * 0.4);
    // Must not throw the Phase-H assertion on this valid input.
    const out = compressSourceStructured(src, budget, structure);

    const { markerRanges } = assertPriority0(src, out);
    // If two markers exist, assertPriority0 already enforced the >=6 sliver rule.
    // Confirm the important anchor line content is verbatim if shown.
    if (out.includes('16. ')) {
      const m = /^16\. (.*)$/m.exec(out);
      expect(m[1]).toBe('    return y');
    }
    expect(Array.isArray(markerRanges)).toBe(true);
  });

  it('does not throw on a fixture where everything fits (no markers, all verbatim)', () => {
    const lines = [
      `export const A = 1;`,
      `export const B = 2;`,
      `export function tiny() {`,
      `  return A + B;`,
      `}`,
    ];
    const src = lines.join('\n');
    const structure = [block('tiny', 'function', 2, 4, true, [anchor(3, 3)])];
    // Generous budget: text.length <= budget → returns text unchanged.
    const out = compressSourceStructured(src, src.length + 100, structure);
    expect(out).toBe(src); // unchanged, no markers, fully verbatim
  });
});
