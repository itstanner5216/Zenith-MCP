// bmx-knee.test.ts — Phase 5 proof.
//
// BMX+ now exposes a KNEE: alongside its per-line scores it publishes a `core`
// set of line numbers it deems important — the same kind of bounded cut SageRank
// already exposes (findScoreCoreCount), so BMX+ can cast a comparable vote in the
// consensus the removal gate will need.
//
// bmx-plus.ts statically imports `removalEngine` from './removal.js', the one
// intentional unbuilt red. vitest.config.ts aliases it to a passthrough stub while
// removal.ts is absent, so the module loads — the knee runs BEFORE the removal
// handoff (bmxEngine sets metadata.bmx, THEN returns removalEngine(payload)). This
// is test-only: it creates no src file and the build stays red on ./removal.js.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bmxEngine, scoreLines } from '../../src/bmx-plus.js';
import type { Payload, SourceBlock } from '../../src/compress-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');

// A file with a clear informativeness cliff: lines 1-4 carry rare, unique
// identifiers (high BMX+ score); lines 6-14 are identical boilerplate (low, equal
// score). A real knee must keep the informative minority and cut the tail.
const SRC = [
  '1. function computeBudgetAllocation(totalTokens, keepRatio) {',
  '2.   const flooredBudget = Math.floor(totalTokens * keepRatio);',
  '3.   const clampedResult = Math.max(flooredBudget, MINIMUM_BUDGET_FLOOR);',
  '4.   return clampedResult;',
  '5. }',
  '6. const a = 1;',
  '7. const a = 1;',
  '8. const a = 1;',
  '9. const a = 1;',
  '10. const a = 1;',
  '11. const a = 1;',
  '12. const a = 1;',
  '13. const a = 1;',
  '14. const a = 1;',
].join('\n');

const BLOCK: SourceBlock = { startLine: 1, endLine: 14, text: SRC };

function makePayload(): Payload {
  return { source: { blocks: [BLOCK], query: null, charBudget: 10_000 }, metadata: {} };
}

// Mirror bmxEngine's own block→line flattening so we can call scoreLines with the
// EXACT same input it uses internally (for the "scores unchanged" check).
function blocksToLines(blocks: readonly SourceBlock[]): Array<{ line: number; text: string }> {
  const lines: Array<{ line: number; text: string }> = [];
  for (const b of blocks) {
    const physical = b.text.split('\n');
    for (let i = 0; i < physical.length; i++) {
      const content = (physical[i] ?? '').replace(/^\s*\d+[.:]\s?/, '');
      lines.push({ line: b.startLine + i, text: content });
    }
  }
  return lines;
}

describe('Phase 5 — BMX+ exposes a bounded, deterministic, weighted-gap knee', () => {
  it('produces a core that is bounded, nonempty, deterministic, leaves scores untouched, and matches SageRank in kind', () => {
    const out = bmxEngine(makePayload());
    const bmx = out.metadata.bmx as { scores: ReadonlyMap<number, number>; core: ReadonlySet<number> };

    const nonBlank = [...bmx.scores.values()].filter((s) => s > 0).length;

    // (1) bounded: the core is the important MINORITY, strictly smaller than the
    //     set of score-bearing lines (a knee that keeps everything is no knee).
    const coreBounded = bmx.core.size < nonBlank;

    // (2) nonempty: BMX+ always names at least one important line.
    const coreNonempty = bmx.core.size >= 1;

    // (3) deterministic: identical input → identical core set.
    const core2 = (bmxEngine(makePayload()).metadata.bmx as { core: ReadonlySet<number> }).core;
    const deterministic =
      bmx.core.size === core2.size && [...bmx.core].every((l) => core2.has(l));

    // (4) scores unchanged: metadata.bmx.scores is byte-identical to scoreLines's
    //     raw output on the same lines — the knee ADDS, never alters.
    const raw = scoreLines(blocksToLines([BLOCK]), undefined, null);
    const scoresUnchanged =
      raw.size === bmx.scores.size && [...raw].every(([l, s]) => bmx.scores.get(l) === s);

    // (5) method matches SageRank: the weighted-gap formula (relGap * absGap/range),
    //     the 0.05 floor, and the n>3 singleton skip — NOT a mean-relative gate.
    const bmxSrc = fs.readFileSync(path.join(SRC_DIR, 'bmx-plus.ts'), 'utf8');
    const sageSrc = fs.readFileSync(path.join(SRC_DIR, 'sagerank.ts'), 'utf8');
    const kneeStart = bmxSrc.indexOf('function findBmxCoreCount');
    const kneeBody = bmxSrc.slice(kneeStart, kneeStart + 1400);
    const weightedGap = /relGap\s*\*\s*\(\s*absGap\s*\/\s*range\s*\)/;
    const methodMatches =
      kneeStart > 0 &&
      weightedGap.test(kneeBody) &&
      /bestGap\s*>\s*0\.05/.test(kneeBody) &&
      /n\s*>\s*3\s*\?\s*1\s*:\s*0/.test(kneeBody) &&
      !/\bmean\b/i.test(kneeBody) &&            // no mean-relative gate
      weightedGap.test(sageSrc);                // SageRank uses the same formula

    console.log(`bmx core bounded: ${coreBounded}`);                       // core < non-blank lines
    console.log(`bmx core nonempty: ${coreNonempty}`);                     // core >= 1
    console.log(`bmx knee deterministic: ${deterministic}`);               // two runs → identical core
    console.log(`bmx scores unchanged: ${scoresUnchanged}`);              // scores === scoreLines raw
    console.log(`bmx knee method matches sagerank: ${methodMatches}`);     // weighted-gap, not mean-relative
    console.log(`  (core=${JSON.stringify([...bmx.core].sort((a, b) => a - b))} of ${nonBlank} non-blank lines)`);

    expect(coreBounded, 'core strictly smaller than non-blank line count').toBe(true);
    expect(coreNonempty, 'core has at least one line').toBe(true);
    expect(deterministic, 'identical input yields identical core').toBe(true);
    expect(scoresUnchanged, 'scores map byte-identical to scoreLines output').toBe(true);
    expect(methodMatches, 'weighted-gap method mirrors findScoreCoreCount, no mean gate').toBe(true);
  });
});
