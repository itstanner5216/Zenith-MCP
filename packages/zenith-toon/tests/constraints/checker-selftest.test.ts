// Self-tests for the invariant checker.
//
// The constraint suite is only as trustworthy as `assertLineTruth`. These tests
// prove the checker is non-vacuous: it must REJECT every class of Priority-0
// violation. (Reviewer concern: a checker with a blind spot silently blesses
// drift — e.g. an earlier version missed leading/trailing omissions.)

import { describe, it, expect } from 'vitest';
import { assertLineTruth } from './invariants.js';

const SOURCE = ['1one', '2two', '3three', '4four', '5five', '6six', '7seven', '8eight', '9nine', '10ten'].join('\n');
// Shown form: `N. <content>` where content is SOURCE line N (1-based).
const shown = (n: number) => `${n}. ${SOURCE.split('\n')[n - 1]}`;

describe('checker self-test — accepts valid Priority-0 output', () => {
  it('accepts a full verbatim passthrough', () => {
    const out = SOURCE.split('\n').map((_, i) => shown(i + 1)).join('\n');
    expect(() => assertLineTruth(SOURCE, out)).not.toThrow();
  });

  it('accepts an internal omission with an exact marker', () => {
    // Show 1, omit 2-9 (8 lines, >= minGap), show 10.
    const out = [shown(1), '[TRUNCATED: lines 2-9]', shown(10)].join('\n');
    expect(() => assertLineTruth(SOURCE, out, { minGap: 6 })).not.toThrow();
  });

  it('accepts a leading marker then content to EOF', () => {
    const out = ['[TRUNCATED: lines 1-6]', shown(7), shown(8), shown(9), shown(10)].join('\n');
    expect(() => assertLineTruth(SOURCE, out)).not.toThrow();
  });

  it('accepts a trailing marker to EOF', () => {
    const out = [shown(1), shown(2), shown(3), '[TRUNCATED: lines 4-10]'].join('\n');
    expect(() => assertLineTruth(SOURCE, out)).not.toThrow();
  });
});

describe('checker self-test — rejects every violation class', () => {
  it('rejects non-verbatim content', () => {
    const out = [shown(1), '2. TAMPERED', shown(3)].join('\n');
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/not verbatim/);
  });

  it('rejects descending / non-ascending line numbers', () => {
    const out = [shown(1), shown(1)].join('\n'); // line 1 repeated → not strictly ascending
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/ascending/);
  });

  it('rejects a silent internal gap (no marker)', () => {
    const out = [shown(1), shown(5)].join('\n'); // 2-4 dropped, no marker
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/silent gap/);
  });

  it('rejects a silent leading gap (first line > 1, no marker)', () => {
    const out = [shown(4), shown(5), shown(6), shown(7), shown(8), shown(9), shown(10)].join('\n');
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/silent leading gap/);
  });

  it('rejects a silent trailing gap when trailing markers are required', () => {
    const out = [shown(1), shown(2), shown(3)].join('\n'); // 4-10 dropped, no marker
    expect(() => assertLineTruth(SOURCE, out, { requireTrailingMarker: true })).toThrow(/silent trailing gap/);
  });

  it('rejects a marker whose range does not abut the next shown line', () => {
    const out = [shown(1), '[TRUNCATED: lines 2-5]', shown(10)].join('\n'); // should be 2-9
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/does not abut/);
  });

  it('rejects an inverted marker range', () => {
    const out = [shown(1), '[TRUNCATED: lines 9-2]', shown(10)].join('\n');
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/inverted/);
  });

  it('rejects an out-of-bounds marker', () => {
    const out = [shown(1), '[TRUNCATED: lines 2-99]'].join('\n');
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/out of file bounds/);
  });

  it('rejects a sub-minGap omission when minGap is set', () => {
    const out = [shown(1), '[TRUNCATED: lines 2-4]', shown(5), shown(6), shown(7), shown(8), shown(9), shown(10)].join('\n');
    expect(() => assertLineTruth(SOURCE, out, { minGap: 6 })).toThrow(/< minimum 6/);
  });

  it('rejects legacy `[N lines omitted]` markers', () => {
    const out = [shown(1), '# ... [4 lines omitted]', shown(6), shown(7), shown(8), shown(9), shown(10)].join('\n');
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/legacy/);
  });

  it('rejects `# L{n}` annotations', () => {
    const out = [`1. ${SOURCE.split('\n')[0]} # L1`, shown(2)].join('\n');
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/# L\{n\}/);
  });

  it('rejects an unparseable output line', () => {
    const out = [shown(1), 'not a numbered line and not a marker', shown(3)].join('\n');
    expect(() => assertLineTruth(SOURCE, out)).toThrow(/neither a numbered line nor a marker/);
  });
});
