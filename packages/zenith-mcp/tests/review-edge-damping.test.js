// ---------------------------------------------------------------------------
// review-edge-damping.test.js
//
// Regression test for PR-review finding #20: the Math.sqrt(callCount) edge-weight
// damping. compressFile receives raw callCount in facts.edges[].callCount and
// must apply the sqrt transform internally (a SageRank tuning concern that lives
// in TOON per Priority 0.5).
//
// compressSourceStructured and SageRank are no longer public exports, so the
// original "seam equivalence" and "engine sensitivity" proofs cannot be
// reproduced from the MCP side. This test asserts what CAN be observed through
// the public compressFile API:
//
//   1. Edges actually flow: compressFile with hot edges selects different
//      kept lines than compressFile with no edges (negative control).
//   2. Raw callCount facts are accepted at the seam without MCP-side weighting.
//
// A future TOON-side test should restore the sqrt-specific verification
// (byte-identical seam output vs. hand-damped reference).
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { compressFile } from 'zenith-toon';

function numberLines(lines) {
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function selectedLineNumbers(output) {
  return output
    .split('\n')
    .filter((line) => /^\d+\. /.test(line))
    .map((line) => Number.parseInt(line.split('.')[0], 10));
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

function hotEdges(defs, callCount) {
  return [
    { callerLine: defs[10].line, calleeLine: defs[8].line, callCount },
    { callerLine: defs[11].line, calleeLine: defs[8].line, callCount },
    { callerLine: defs[9].line, calleeLine: defs[8].line, callCount },
  ];
}

describe('TOON edge damping — public compressFile seam (review finding #20)', () => {
  it('edges actually flow: output selection differs with vs. without call edges', () => {
    const { source, defs } = buildSource();
    const maxChars = Math.floor(source.length * 0.7);

    const withEdges = compressFile({ source, maxChars, facts: factsFor(defs, hotEdges(defs, 16)) });
    const withoutEdges = compressFile({ source, maxChars, facts: factsFor(defs, []) });

    // Both must compress (null would be a legitimate "not useful" outcome, but
    // this fixture is designed to be compressible).
    expect(withEdges).not.toBeNull();
    expect(withoutEdges).not.toBeNull();

    // Edge weight genuinely reaches the ranking: the line selection changes.
    expect(selectedLineNumbers(withEdges)).not.toEqual(selectedLineNumbers(withoutEdges));
  });

  it('accepts raw callCount facts at the seam — no MCP-side weighting', () => {
    const { source, defs } = buildSource();
    const maxChars = Math.floor(source.length * 0.7);

    const result = compressFile({ source, maxChars, facts: factsFor(defs, hotEdges(defs, 16)) });

    expect(result).not.toBeNull();
    expect(result).toMatch(/\[TRUNCATED: lines \d+-\d+\]/);
  });
});
