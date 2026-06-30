import { describe, expect, it } from 'vitest';

import { compressFile } from 'zenith-toon';

const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const SHOWN_RE = /^(\d+)\. ([\s\S]*)$/;
const MIN_OMISSION_THRESHOLD = 6;

function numberLines(lines) {
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function makeFacts(defs, extra = {}) {
  return {
    path: 'src/priority0-fixture.ts',
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

function buildFunctionFixture() {
  const rawLines = [];
  const defs = [];
  for (let fn = 0; fn < 12; fn += 1) {
    const start = rawLines.length + 1;
    rawLines.push(`export function fn${fn}() {`);
    for (let i = 0; i < 10; i += 1) {
      rawLines.push(`  const v${fn}_${i} = "xxxxxxxxxxxxxxxxxxxx";`);
    }
    rawLines.push(`  return v${fn}_0;`);
    rawLines.push('}');
    defs.push({ name: `fn${fn}`, line: start, endLine: rawLines.length });
  }
  return { rawLines, source: numberLines(rawLines), facts: makeFacts(defs) };
}

function parseOutput(output) {
  const visible = [];
  const markers = [];
  const outputLines = output.split('\n');
  for (let index = 0; index < outputLines.length; index += 1) {
    const line = outputLines[index];
    const marker = MARKER_RE.exec(line);
    if (marker !== null) {
      markers.push({ index, x: Number(marker[1]), y: Number(marker[2]) });
      continue;
    }
    const shown = SHOWN_RE.exec(line);
    expect(shown, `every non-marker line must be "N. ...": ${JSON.stringify(line)}`).not.toBeNull();
    visible.push({ index, n: Number(shown[1]), text: line });
  }
  return { outputLines, visible, markers };
}

function assertPriority0(source, output) {
  const sourceLines = source.split('\n');
  const { outputLines, visible, markers } = parseOutput(output);
  expect(markers.length, 'fixture must exercise at least one omission marker').toBeGreaterThan(0);

  for (let i = 1; i < visible.length; i += 1) {
    expect(visible[i].n).toBeGreaterThan(visible[i - 1].n);
  }

  for (const shown of visible) {
    expect(shown.text).toBe(sourceLines[shown.n - 1]);
  }

  const shownSet = new Set(visible.map((line) => line.n));
  let previousMarkerEnd = 0;
  for (const marker of markers) {
    expect(outputLines[marker.index]).toBe(`[TRUNCATED: lines ${marker.x}-${marker.y}]`);
    expect(marker.x).toBeLessThanOrEqual(marker.y);
    expect(marker.x).toBeGreaterThan(previousMarkerEnd);
    previousMarkerEnd = marker.y;
    for (let line = marker.x; line <= marker.y; line += 1) {
      expect(shownSet.has(line), `marker ${marker.x}-${marker.y} overlaps shown line ${line}`).toBe(false);
    }
  }

  let expectedLine = 1;
  for (const line of outputLines) {
    const marker = MARKER_RE.exec(line);
    if (marker !== null) {
      const x = Number(marker[1]);
      const y = Number(marker[2]);
      expect(x).toBe(expectedLine);
      expect(y - x + 1).toBeGreaterThanOrEqual(MIN_OMISSION_THRESHOLD);
      expectedLine = y + 1;
      continue;
    }
    const shown = SHOWN_RE.exec(line);
    expect(shown).not.toBeNull();
    expect(Number(shown[1])).toBe(expectedLine);
    expectedLine += 1;
  }
  expect(expectedLine).toBe(sourceLines.length + 1);

  for (let i = 1; i < markers.length; i += 1) {
    const previous = markers[i - 1];
    const current = markers[i];
    const visibleBetween = visible.filter((line) => line.index > previous.index && line.index < current.index).length;
    expect(visibleBetween).toBeGreaterThanOrEqual(MIN_OMISSION_THRESHOLD);
  }
}

describe('compressFile — Priority-0 output invariants', () => {
  it('emits only verbatim numbered source lines and exact ranged markers', () => {
    const { source, facts } = buildFunctionFixture();
    const output = compressFile({ source, maxChars: Math.floor(source.length * 0.7), facts });

    expect(output).not.toBeNull();
    assertPriority0(source, output);
  });

  it('keeps the rendered output in the current 68-72% retention band', () => {
    const { source, facts } = buildFunctionFixture();
    const output = compressFile({ source, maxChars: Math.floor(source.length * 0.7), facts });

    expect(output).not.toBeNull();
    const ratio = output.length / source.length;
    expect(ratio).toBeGreaterThanOrEqual(0.68);
    expect(ratio).toBeLessThanOrEqual(0.72);
  });

  it('returns null instead of fabricating compression when no useful drop is possible', () => {
    const rawLines = [
      'export function tiny() {',
      '  return 1;',
      '}',
    ];
    const source = numberLines(rawLines);
    const facts = makeFacts([{ name: 'tiny', line: 1, endLine: 3 }]);

    expect(compressFile({ source, maxChars: source.length + 100, facts })).toBeNull();
  });
});
