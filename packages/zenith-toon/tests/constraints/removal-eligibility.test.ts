// removal-eligibility.test.ts — Phase 6 (sub-stage 5A) proof.
//
// The removal gate is the value-blind engine at the forward end of the chain. This
// sub-stage builds ONLY its data contract + the ELIGIBILITY PARTITION: a strict
// boolean per absolute line, true iff BOTH ranking engines independently judged the
// line non-core (equal co-vetoes, ANDed — no blend, no weighting). No line is
// dropped yet; output is the full source unchanged.
//
// removal.ts now EXISTS, so the guarded `./removal.js` alias in vitest.config.ts
// self-disables and bmx-plus's `import { removalEngine } from './removal.js'`
// resolves to the REAL engine. Probe 8 below runs the whole chain end-to-end and
// asserts the gate's own determination (metadata.removal) is present — which a
// passthrough stub would NEVER set, so it doubles as proof the real engine loaded.

import { describe, it, expect } from 'vitest';

import { removalEngine } from '../../src/removal.js';
import { compressSource } from '../../src/compress-source.js';
import { compressFile, type CompressFileRequest } from '../../src/index.js';
import type { Payload, SourceBlock } from '../../src/compress-source.js';

// Two contiguous blocks, six absolute lines (1..6), with KNOWN mocked engine cores
// so the eligibility projection is fully determined:
//   • SageRank core = block 0  -> lines 1,2,3 protected (block-core -> line projection)
//   • BMX+ core     = line 5    -> line 5 protected
// Expected eligibility: 1,2,3 = false (sage), 4 = true, 5 = false (bmx), 6 = true.
const BLOCK0: SourceBlock = { startLine: 1, endLine: 3, text: '1. alpha\n2. beta\n3. gamma' };
const BLOCK1: SourceBlock = { startLine: 4, endLine: 6, text: '4. delta\n5. epsilon\n6. zeta' };
const FULL_SOURCE = [BLOCK0.text, BLOCK1.text].join('\n');

function mockedPayload(): Payload {
  return {
    source: { blocks: [BLOCK0, BLOCK1], query: null, charBudget: 10_000 },
    metadata: {
      // Realistic SageRankMetadata shape; the gate reads ONLY coreIndices.
      sagerank: { scores: [0.9, 0.1], rankedIndices: [0, 1], coverageOrder: [0, 1], coreIndices: [0] },
      // Realistic BMXMetadata shape; the gate reads ONLY core.
      bmx: { scores: new Map<number, number>(), core: new Set<number>([5]) },
    },
  };
}

describe('Phase 6 (5A) — removal gate: boolean eligibility = AND of non-cores', () => {
  it('partitions lines into a strict boolean eligibility map, fails loud, and emits full source unchanged', () => {
    const out = removalEngine(mockedPayload());
    const removal = out.metadata.removal as { eligible: ReadonlyMap<number, boolean> };
    const eligible = removal.eligible;

    const sageCoreLines = new Set<number>([1, 2, 3]); // block 0 projected onto its lines
    const bmxCoreLines = new Set<number>([5]);
    const allLines = [1, 2, 3, 4, 5, 6];

    // (1) eligible is a boolean map — every line present, every value strictly
    //     true/false, never a number.
    const eligibleIsBooleanMap =
      eligible.size === allLines.length &&
      allLines.every((l) => typeof eligible.get(l) === 'boolean');

    // (2) protected = union of cores — every sage-core OR bmx-core line is eligible=false.
    const protectedUnion = new Set<number>([...sageCoreLines, ...bmxCoreLines]);
    const protectedIsUnion = [...protectedUnion].every((l) => eligible.get(l) === false);

    // (3) eligible = neither core — every eligible=true line is in NEITHER core.
    const eligibleIsNeither = allLines
      .filter((l) => eligible.get(l) === true)
      .every((l) => !sageCoreLines.has(l) && !bmxCoreLines.has(l));

    // (4) block-core projects to lines — all lines of core block 0 are protected.
    const blockCoreProjects = [1, 2, 3].every((l) => eligible.get(l) === false);

    // (5) fail-loud on missing/malformed engine output — throws in every degenerate case.
    const throwsWhen = (metadata: Record<string, unknown>): boolean => {
      try {
        removalEngine({ source: { blocks: [BLOCK0, BLOCK1], query: null, charBudget: 10_000 }, metadata });
        return false;
      } catch {
        return true;
      }
    };
    const failLoud =
      throwsWhen({}) &&                                                     // both absent
      throwsWhen({ sagerank: { coreIndices: [0] } }) &&                     // bmx absent
      throwsWhen({ bmx: { core: new Set<number>([5]) } }) &&               // sagerank absent
      throwsWhen({ sagerank: {}, bmx: { core: new Set<number>([5]) } }) && // sagerank malformed (no coreIndices)
      throwsWhen({ sagerank: { coreIndices: [0] }, bmx: {} });             // bmx malformed (no core Set)

    // (6) output is full source (no drop yet) — output == all lines, unchanged.
    const outputIsFullSource = out.output === FULL_SOURCE;

    // (7) compressFile catches throw -> returns null (does NOT propagate). The chain's
    //     shape-mapping is inside the try, so a malformed request degrades to null
    //     rather than throwing — toon never interrupts the caller. (The gate's OWN
    //     fail-loud throw is proven directly in probe 5.)
    const malformed = { source: null, maxChars: 100 } as unknown as CompressFileRequest;
    let compressFileCatches = false;
    try {
      compressFileCatches = compressFile(malformed) === null;
    } catch {
      compressFileCatches = false; // propagated -> boundary failed
    }

    // (8) compressSource returns Payload (not void) — compressFile gets a handle on
    //     the final payload. The REAL engine chain runs end-to-end (the removal-stub
    //     has self-disabled now that src/removal.ts exists), so the returned payload
    //     carries the gate's own determination (metadata.removal) and its output.
    const chainResult = compressSource({ blocks: [BLOCK0, BLOCK1], query: null, charBudget: 10_000 });
    const compressSourceReturnsPayload =
      typeof chainResult === 'object' &&
      chainResult !== null &&
      'removal' in chainResult.metadata &&
      typeof chainResult.output === 'string';

    console.log(`eligible is boolean map: ${eligibleIsBooleanMap}`);               // every value strict boolean
    console.log(`protected = union of cores: ${protectedIsUnion}`);               // sage OR bmx -> eligible=false
    console.log(`eligible = neither core: ${eligibleIsNeither}`);                 // eligible=true -> in neither
    console.log(`block-core projects to lines: ${blockCoreProjects}`);            // core block's lines protected
    console.log(`fail-loud on missing engine output: ${failLoud}`);              // throws on any missing/malformed
    console.log(`output is full source (no drop yet): ${outputIsFullSource}`);    // output == all lines, unchanged
    console.log(`compressFile catches throw -> returns null: ${compressFileCatches}`); // boundary degrades, no propagate
    console.log(`compressSource returns Payload: ${compressSourceReturnsPayload}`);    // not void; final payload handle
    console.log(`  (eligible=${JSON.stringify([...eligible.entries()])})`);

    expect(eligibleIsBooleanMap, 'every line maps to a strict boolean').toBe(true);
    expect(protectedIsUnion, 'sage-core OR bmx-core lines are all protected (eligible=false)').toBe(true);
    expect(eligibleIsNeither, 'eligible=true lines are in neither core').toBe(true);
    expect(blockCoreProjects, 'all lines of a core block are protected').toBe(true);
    expect(failLoud, 'throws on any missing/malformed engine verdict').toBe(true);
    expect(outputIsFullSource, 'output is the full source unchanged').toBe(true);
    expect(compressFileCatches, 'compressFile catches the throw and returns null').toBe(true);
    expect(compressSourceReturnsPayload, 'compressSource returns the final Payload').toBe(true);
  });
});
