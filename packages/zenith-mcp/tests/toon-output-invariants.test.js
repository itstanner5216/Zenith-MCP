import { describe, expect, it } from 'vitest';

import { compressFile, verifyOutput } from 'zenith-toon';

const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const SHOWN_RE = /^(\d+)\. /;
const MIN_OMISSION_THRESHOLD = 6;

function numberLines(lines) {
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function makeFacts(defs, extra = {}) {
  return {
    path: 'src/output-invariants.ts',
    langName: 'typescript',
    defs: defs.map((def) => ({
      name: def.name,
      kind: 'def',
      type: 'function',
      line: def.line,
      endLine: def.endLine,
      visibility: 'public',
      captureTag: null,
    })),
    references: [],
    edges: [],
    referenceEdges: [],
    anchors: [],
    imports: [],
    injections: [],
    scopes: [],
    ...extra,
  };
}

function buildFixture() {
  const rawLines = [];
  const defs = [];
  for (let fn = 0; fn < 12; fn += 1) {
    const start = rawLines.length + 1;
    rawLines.push(`export function unit${fn}() {`);
    for (let i = 0; i < 10; i += 1) {
      rawLines.push(`  const value${fn}_${i} = "xxxxxxxxxxxxxxxxxxxx";`);
    }
    rawLines.push(`  return value${fn}_0;`);
    rawLines.push('}');
    defs.push({ name: `unit${fn}`, line: start, endLine: rawLines.length });
  }
  return { source: numberLines(rawLines), facts: makeFacts(defs) };
}

function parseOutput(output) {
  const outputLines = output.split('\n');
  const visible = [];
  const markers = [];
  for (let index = 0; index < outputLines.length; index += 1) {
    const line = outputLines[index];
    const marker = MARKER_RE.exec(line);
    if (marker !== null) {
      markers.push({ index, x: Number(marker[1]), y: Number(marker[2]) });
      continue;
    }
    const shown = SHOWN_RE.exec(line);
    expect(shown, `unexpected output line ${index}: ${JSON.stringify(line)}`).not.toBeNull();
    visible.push({ index, n: Number(shown[1]), text: line });
  }
  return { outputLines, visible, markers };
}

function assertFullyAccounted(source, output) {
  const sourceLines = source.split('\n');
  const { outputLines, visible, markers } = parseOutput(output);
  const shownSet = new Set(visible.map((line) => line.n));
  expect(markers.length).toBeGreaterThan(0);

  let expected = 1;
  for (const line of outputLines) {
    const marker = MARKER_RE.exec(line);
    if (marker !== null) {
      const x = Number(marker[1]);
      const y = Number(marker[2]);
      expect(x).toBe(expected);
      expect(y).toBeGreaterThanOrEqual(x);
      expect(y - x + 1).toBeGreaterThanOrEqual(MIN_OMISSION_THRESHOLD);
      expected = y + 1;
      continue;
    }
    const shown = SHOWN_RE.exec(line);
    expect(shown).not.toBeNull();
    expect(Number(shown[1])).toBe(expected);
    expect(line).toBe(sourceLines[expected - 1]);
    expected += 1;
  }
  expect(expected).toBe(sourceLines.length + 1);

  for (let i = 1; i < visible.length; i += 1) {
    expect(visible[i].n).toBeGreaterThan(visible[i - 1].n);
  }

  for (const marker of markers) {
    expect(outputLines[marker.index]).toBe(`[TRUNCATED: lines ${marker.x}-${marker.y}]`);
    for (let line = marker.x; line <= marker.y; line += 1) {
      expect(shownSet.has(line)).toBe(false);
    }
  }

  for (let i = 1; i < markers.length; i += 1) {
    const previous = markers[i - 1];
    const current = markers[i];
    const visibleBetween = visible.filter((line) => line.index > previous.index && line.index < current.index).length;
    expect(visibleBetween).toBeGreaterThanOrEqual(MIN_OMISSION_THRESHOLD);
  }
}

describe('toon-output-invariants — public compressFile seam', () => {
  it('returns mechanically verifiable Priority-0 output', () => {
    const { source, facts } = buildFixture();
    const maxChars = Math.floor(source.length * 0.7);
    const output = compressFile({ source, maxChars, facts });

    expect(output).not.toBeNull();
    assertFullyAccounted(source, output);
  });

  it('passes TOON verifyOutput with matching removal metadata assumptions', () => {
    const { source, facts } = buildFixture();
    const maxChars = Math.floor(source.length * 0.7);
    const output = compressFile({ source, maxChars, facts });

    expect(output).not.toBeNull();
    const { markers } = parseOutput(output);
    const dropped = new Set();
    const eligible = new Map();
    for (const marker of markers) {
      for (let line = marker.x; line <= marker.y; line += 1) {
        dropped.add(line);
        eligible.set(line, true);
      }
    }
    let renderedSize = 0;
    for (const line of output.split('\n')) {
      const marker = MARKER_RE.exec(line);
      if (marker !== null) {
        renderedSize += line.length;
      } else {
        renderedSize += line.replace(/^\s*\d+[.:]\s?/, '').length;
      }
    }
    const fullSize = source
      .split('\n')
      .reduce((sum, line) => sum + line.replace(/^\s*\d+[.:]\s?/, '').length, 0);
    const bandSatisfied = renderedSize >= Math.ceil(0.68 * fullSize) && renderedSize <= Math.min(Math.floor(0.72 * fullSize), maxChars);

    verifyOutput(source, output, { dropped, eligible, renderedSize, bandSatisfied }, maxChars);
  });

  it('returns null for malformed or non-compressible seam input instead of throwing', () => {
    const source = numberLines(['just text', 'with no defs']);
    const facts = makeFacts([]);

    expect(() => compressFile({ source, maxChars: 10, facts })).not.toThrow();
    expect(compressFile({ source, maxChars: 10, facts })).toBeNull();
  });
});
