import { describe, expect, it } from 'vitest';

import { compressFile } from 'zenith-toon';

function numberLines(lines) {
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function buildSource() {
  const rawLines = [];
  const defs = [];
  for (let fn = 0; fn < 12; fn += 1) {
    const start = rawLines.length + 1;
    rawLines.push(`export function edge${fn}() {`);
    for (let i = 0; i < 10; i += 1) {
      rawLines.push(`  const value${fn}_${i} = "xxxxxxxxxxxxxxxxxxxx";`);
    }
    rawLines.push(`  return value${fn}_0;`);
    rawLines.push('}');
    defs.push({ name: `edge${fn}`, line: start, endLine: rawLines.length });
  }
  return { source: numberLines(rawLines), defs };
}

function factsFor(defs, edges) {
  return {
    path: 'src/edge-damping.ts',
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
    edges,
    referenceEdges: [],
    anchors: [],
    imports: [],
    injections: [],
    scopes: [],
  };
}

function selectedLineNumbers(output) {
  return output
    .split('\n')
    .filter((line) => /^\d+\. /.test(line))
    .map((line) => Number.parseInt(line.split('.')[0], 10));
}

function hotEdges(defs, callCount) {
  return [
    { callerLine: defs[10].line, calleeLine: defs[8].line, callCount },
    { callerLine: defs[11].line, calleeLine: defs[8].line, callCount },
    { callerLine: defs[9].line, calleeLine: defs[8].line, callCount },
  ];
}

describe('TOON edge facts through the public compressFile seam', () => {
  it('line-keyed call edges are honored by compressFile output selection', () => {
    const { source, defs } = buildSource();
    const maxChars = Math.floor(source.length * 0.7);

    const withEdges = compressFile({ source, maxChars, facts: factsFor(defs, hotEdges(defs, 16)) });
    const withoutEdges = compressFile({ source, maxChars, facts: factsFor(defs, []) });

    expect(withEdges).not.toBeNull();
    expect(withoutEdges).not.toBeNull();
    expect(selectedLineNumbers(withEdges)).not.toEqual(selectedLineNumbers(withoutEdges));
  });

  it('accepts raw callCount facts at the seam without MCP-side weighting', () => {
    const { source, defs } = buildSource();
    const maxChars = Math.floor(source.length * 0.7);
    const lowCount = compressFile({ source, maxChars, facts: factsFor(defs, hotEdges(defs, 1)) });
    const highCount = compressFile({ source, maxChars, facts: factsFor(defs, hotEdges(defs, 16)) });

    expect(lowCount).not.toBeNull();
    expect(highCount).not.toBeNull();
    expect(lowCount).toMatch(/\[TRUNCATED: lines \d+-\d+\]/);
    expect(highCount).toMatch(/\[TRUNCATED: lines \d+-\d+\]/);
  });
});
