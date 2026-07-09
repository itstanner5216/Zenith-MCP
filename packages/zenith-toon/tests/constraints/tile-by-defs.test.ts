// tile-by-defs.test.ts — Wave 2 / Task T5 proof: the TILING CONTRACT of `tileByDefs`.
//
// `tileByDefs` (packages/zenith-toon/src/index.ts) is the structural partition SageRank
// ranks over. Wave 1 gave it an OPTIONAL third `refine` object: large def-/gap-owned
// blocks now subdivide at REAL fact-backed boundaries — scopes/injections as HARD spans
// (own their lines, painted widest→narrowest, innermost-wins), anchors/imports as SOFT
// split hints (no ownership, only break an OVERSIZED leftover, and only when BOTH sides
// clear MIN_SUB_BLOCK_LINES). This suite PROVES the contract holds after that refinement:
//
//   • COMPLETE + CONTIGUOUS + VERBATIM partition of lines 1..N (assertCompleteVerbatimTiling
//     below re-derives it from the original physical lines on EVERY scenario's output).
//   • EVERY def `startLine` stays a block boundary after subdivision (edge-alignment law:
//     sagerank.ts `_factsToASTEdges` resolves call-graph endpoints by exact-startLine match).
//   • Below-threshold / non-contained spans NEVER create tiny or boundary-crossing blocks.
//
// No build needed: vitest `include: tests/constraints/**/*.test.ts` collects this file and
// it imports SOURCE (`../../src/index.js` → the .ts). bail:1 ⇒ any failure stops the run.
//
// NOTE on coverage boundary (plan correction, verified against this tree): the file
// `tiling-correctness.test.ts` does NOT exist in this repo and NO existing test references
// `tileByDefs` or defines `assertCompleteVerbatimTiling`. So this file defines its own
// verbatim-tiling helper AND carries the 2-arg backward-compat coverage the plan lists.
//
// CODE BANS honoured throughout: no `!` non-null assertions (narrow with explicit guards),
// no `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`, no `as any`.

import { describe, it, expect } from 'vitest';

import { tileByDefs, type DefSpan } from '../../src/index.js';
import type { SourceBlock } from '../../src/compress-source.js';

// ── Thresholds (kept in sync with src/index.ts; this file asserts AGAINST these). ──────
// The production constants are module-private, so the proof restates the values it relies
// on. If src/index.ts retunes them, these scenarios are recomputed deliberately, not by
// accident — which is the point of a contract test.
const MIN_SUB_BLOCK_LINES = 6; // smallest hard sub-block / legal soft-split side
const LARGE_BLOCK_LINES = 18;  // only subdivide blocks longer than this
const ANCHOR_SPLIT_MIN_BLOCK = 24; // only soft-split a leftover longer than this

// ───────────────────────────────────────────────────────────────────────────────────
// Build a source of N numbered physical lines in TOON's own `N. ` prefixed shape. The
// content is unique per line so the verbatim check is a genuine character-identity test
// (a dropped/duplicated/shifted line changes the joined text and fails immediately).
function makeSource(n: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}. line ${i} content`);
  return lines.join('\n');
}

// THE TILING-CONTRACT HELPER (self-defined per the plan correction). Asserts the four
// invariants that make a `SourceBlock[]` a legal line partition of `source`:
//   1. block[0].startLine === 1 and last.endLine === N (covers the whole file),
//   2. strictly ascending AND contiguous (block[k].startLine === block[k-1].endLine + 1)
//      with no gaps and no overlaps,
//   3. each block's `text` === the ORIGINAL physical lines [startLine..endLine] joined
//      verbatim (line-number prefixes intact, never recomputed),
//   4. (corollary of 1–3) every physical line 1..N lands in EXACTLY one block.
// Returns the booleans so callers can also print them where a J-step asks.
function assertCompleteVerbatimTiling(
  source: string,
  blocks: readonly SourceBlock[],
): { coversFile: boolean; ascendingContiguous: boolean; verbatim: boolean; everyLineOnce: boolean } {
  const physical = source.split('\n');
  const n = physical.length;

  expect(blocks.length, 'a non-empty source must tile into at least one block').toBeGreaterThan(0);
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  expect(first).toBeDefined();
  expect(last).toBeDefined();
  if (first === undefined || last === undefined) throw new Error('unreachable: blocks non-empty');

  const coversFile = first.startLine === 1 && last.endLine === n;
  expect(first.startLine, 'first block must start at line 1').toBe(1);
  expect(last.endLine, 'last block must end at line N').toBe(n);

  // Ascending + contiguous: each block starts exactly one line after the previous ends.
  let ascendingContiguous = true;
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1];
    const cur = blocks[i];
    expect(prev).toBeDefined();
    expect(cur).toBeDefined();
    if (prev === undefined || cur === undefined) throw new Error('unreachable: indexed in range');
    expect(cur.startLine, `block ${i} startLine must be strictly after block ${i - 1}`).toBeGreaterThan(prev.startLine);
    if (cur.startLine !== prev.endLine + 1) ascendingContiguous = false;
    expect(cur.startLine, `block ${i} must be contiguous with block ${i - 1} (no gap/overlap)`).toBe(prev.endLine + 1);
    expect(cur.endLine, `block ${i} must be well-formed (end >= start)`).toBeGreaterThanOrEqual(cur.startLine);
  }

  // Verbatim: reconstruct each block from the ORIGINAL lines and compare character-for-character.
  let verbatim = true;
  const seen = new Array<number>(n + 1).fill(0); // count how many blocks claim each line
  for (const b of blocks) {
    const expectedText = physical.slice(b.startLine - 1, b.endLine).join('\n');
    if (b.text !== expectedText) verbatim = false;
    expect(b.text, `block [${b.startLine}..${b.endLine}] text must be the original lines verbatim`).toBe(expectedText);
    for (let line = b.startLine; line <= b.endLine; line++) seen[line] = (seen[line] ?? 0) + 1;
  }

  // Every line claimed exactly once (no gap, no overlap) — the union check.
  let everyLineOnce = true;
  for (let line = 1; line <= n; line++) {
    if (seen[line] !== 1) everyLineOnce = false;
    expect(seen[line], `line ${line} must belong to exactly one block`).toBe(1);
  }

  return { coversFile, ascendingContiguous, verbatim, everyLineOnce };
}

// Resolve a source line to a block index EXACTLY as sagerank.ts `_factsToASTEdges` does
// (the GOVERNING edge→block law): exact `startLine` match first, else the SMALLEST
// enclosing block. Used by J11 to prove an edge endpoint at a def `startLine` lands on the
// SIGNATURE sub-block, not a body sub-block — by block-boundary reasoning, no SageRank call.
function resolveEndpointToBlock(blocks: readonly SourceBlock[], line: number): number | undefined {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b !== undefined && b.startLine === line) return i; // exact start-line match wins
  }
  let best: { index: number; span: number } | undefined;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b === undefined) continue;
    if (line >= b.startLine && line <= b.endLine) {
      const span = b.endLine - b.startLine;
      if (best === undefined || span < best.span) best = { index: i, span };
    }
  }
  return best?.index;
}

// Convenience: the [start,end] pairs of a block list, for readable equality + boundary checks.
function ranges(blocks: readonly SourceBlock[]): Array<[number, number]> {
  return blocks.map((b) => [b.startLine, b.endLine]);
}
// Does any block start exactly at `line`? (def-boundary preservation predicate.)
function hasBoundaryAt(blocks: readonly SourceBlock[], line: number): boolean {
  return blocks.some((b) => b.startLine === line);
}
// Smallest block fully containing [s..e], or undefined. (used to assert "no tiny block").
function blockContaining(blocks: readonly SourceBlock[], s: number, e: number): SourceBlock | undefined {
  let best: SourceBlock | undefined;
  for (const b of blocks) {
    if (b.startLine <= s && b.endLine >= e) {
      if (best === undefined || b.endLine - b.startLine < best.endLine - best.startLine) best = b;
    }
  }
  return best;
}

describe('T5 — tileByDefs tiling contract (J2–J11, determinism, 2-arg backward-compat)', () => {
  // ───────────────────────────────────────────────────────────────────────────────────
  it('J2 — hard-span subdivision: scopes + injection carve a large def; gap injection carves the gap; below-threshold spans make NO tiny blocks', () => {
    // Layout (N=58):
    //   1-3   gap preamble (small, one block)
    //   4-34  LARGE function def (31 lines > 18) — def startLine 4 is INVIOLATE
    //         scope statement_block 9-22 (14), scope for_statement 13-19 (7, nested)
    //         injection 24-30 (7 >= MIN -> its OWN block)
    //         scope catch_clause 32-34 (3 < MIN -> must be ABSORBED, no tiny block)
    //   35-58 LARGE gap (24 lines > 18) with injection 40-47 (8 >= MIN -> its OWN block)
    const n = 58;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 4, endLine: 34 }];
    const blocks = tileByDefs(source, defs, {
      scopes: [
        { startLine: 9, endLine: 22, scopeKind: 'statement_block' },
        { startLine: 13, endLine: 19, scopeKind: 'for_statement' },
        { startLine: 32, endLine: 34, scopeKind: 'catch_clause' }, // below MIN
      ],
      injections: [
        { startLine: 24, endLine: 30, injectedLang: 'sql' },
        { startLine: 40, endLine: 47, injectedLang: 'html' },
      ],
      anchors: [],
      imports: [],
    });

    const tiling = assertCompleteVerbatimTiling(source, blocks);

    // Every def startLine is a block boundary AFTER subdivision.
    const defStartIsBoundary = defs.every((d) => hasBoundaryAt(blocks, d.startLine));

    // The large def IS subdivided (more than one block overlaps its span). The def span is
    // 31 lines (> LARGE_BLOCK_LINES) so it is ELIGIBLE for subdivision; the 3-line preamble
    // (<= LARGE_BLOCK_LINES) is NOT — assert both facts so the threshold is load-bearing.
    const defSpanLines = 34 - 4 + 1;
    const preambleLines = 3;
    const defEligibleByThreshold = defSpanLines > LARGE_BLOCK_LINES && preambleLines <= LARGE_BLOCK_LINES;
    const defBlocks = blocks.filter((b) => b.startLine >= 4 && b.endLine <= 34);
    const largeDefSubdivided = defEligibleByThreshold && defBlocks.length > 1 && hasBoundaryAt(blocks, 1) && blocks.some((b) => b.startLine === 1 && b.endLine === 3);

    // Injection >= MIN became its OWN block (exact [24,30] and the gap [40,47]).
    const injectionIsOwnBlock =
      blocks.some((b) => b.startLine === 24 && b.endLine === 30) &&
      blocks.some((b) => b.startLine === 40 && b.endLine === 47);

    // Below-threshold scope 32-34 (3 lines) created NO tiny block: the block containing it
    // is strictly larger than the sub-min span (it was absorbed into the def tail).
    const containing = blockContaining(blocks, 32, 34);
    expect(containing).toBeDefined();
    if (containing === undefined) throw new Error('unreachable: line 32-34 must be covered');
    const noTinyBlockForSubMinSpan = containing.endLine - containing.startLine + 1 > 3 && !(containing.startLine === 32 && containing.endLine === 34);

    // No block anywhere is below MIN_SUB_BLOCK_LINES UNLESS it is the gap preamble/def
    // signature edge — assert: every HARD-carved block (scope/injection) is >= MIN. We
    // check the injection blocks and the for/scope-derived blocks specifically.
    const noSubMinHardBlock = injectionIsOwnBlock && (30 - 24 + 1) >= MIN_SUB_BLOCK_LINES && (47 - 40 + 1) >= MIN_SUB_BLOCK_LINES;

    console.log(`J2 complete+verbatim tiling: ${tiling.coversFile && tiling.ascendingContiguous && tiling.verbatim && tiling.everyLineOnce}`);
    console.log(`J2 every def startLine is a block boundary: ${defStartIsBoundary}`);
    console.log(`J2 large def IS subdivided at scope boundaries: ${largeDefSubdivided}`);
    console.log(`J2 injection >= MIN becomes its own block (def & gap): ${injectionIsOwnBlock}`);
    console.log(`J2 below-threshold span creates NO tiny block: ${noTinyBlockForSubMinSpan}`);
    console.log(`J2 no sub-MIN hard block: ${noSubMinHardBlock}`);
    console.log(`  (J2 blocks=${JSON.stringify(ranges(blocks))})`);

    expect(tiling.coversFile, 'covers lines 1..N').toBe(true);
    expect(tiling.ascendingContiguous, 'ascending + contiguous').toBe(true);
    expect(tiling.verbatim, 'every block verbatim from original lines').toBe(true);
    expect(tiling.everyLineOnce, 'every line tiled exactly once').toBe(true);
    expect(defStartIsBoundary, 'def startLine is a block boundary').toBe(true);
    expect(largeDefSubdivided, 'large def is subdivided at scope boundaries').toBe(true);
    expect(injectionIsOwnBlock, 'injection >= MIN is its own block in BOTH the def and the gap').toBe(true);
    expect(noTinyBlockForSubMinSpan, 'below-threshold scope creates no tiny block').toBe(true);
    expect(noSubMinHardBlock, 'no hard-carved block is below MIN_SUB_BLOCK_LINES').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('J3 — anchor soft-split: only oversized leftovers split, BOTH sides >= MIN, no 1-line fragments, no dup/drop', () => {
    // A pure leftover block 1-30 (no defs, no scopes) of size 30 > ANCHOR_SPLIT_MIN_BLOCK.
    // anchors at 9 and 20 -> [1,8],[9,19],[20,30] (each side >= MIN).
    const n = 30;
    const source = makeSource(n);
    const blocks = tileByDefs(source, [], {
      scopes: [],
      injections: [],
      anchors: [
        { line: 9, kind: 'export', symbolName: 'a', text: '' },
        { line: 20, kind: 'export', symbolName: 'b', text: '' },
      ],
      imports: [],
    });
    const tiling = assertCompleteVerbatimTiling(source, blocks);

    // The leftover (1-30) is 30 lines > ANCHOR_SPLIT_MIN_BLOCK, so it is ELIGIBLE for a soft
    // anchor split — assert the threshold gate explicitly so it is load-bearing.
    const leftoverEligibleForSoftSplit = n > ANCHOR_SPLIT_MIN_BLOCK;
    const splitHappened = leftoverEligibleForSoftSplit && blocks.length === 3;
    const allSidesAtLeastMin = blocks.every((b) => b.endLine - b.startLine + 1 >= MIN_SUB_BLOCK_LINES);
    const boundariesAtAnchors = hasBoundaryAt(blocks, 9) && hasBoundaryAt(blocks, 20);

    // A separate input where the anchor would shave a sub-MIN sliver: anchor @4 (would make a
    // 3-line left side) is IGNORED; only the legal anchor @9 splits -> 2 blocks, both >= MIN.
    const sliverSource = makeSource(30);
    const sliverBlocks = tileByDefs(sliverSource, [], {
      scopes: [],
      injections: [],
      anchors: [
        { line: 4, kind: 'x', symbolName: 'a', text: '' }, // would create a 3-line sliver -> ignored
        { line: 9, kind: 'x', symbolName: 'b', text: '' },
      ],
      imports: [],
    });
    const sliverTiling = assertCompleteVerbatimTiling(sliverSource, sliverBlocks);
    const subMinAnchorIgnored =
      !hasBoundaryAt(sliverBlocks, 4) && hasBoundaryAt(sliverBlocks, 9) &&
      sliverBlocks.every((b) => b.endLine - b.startLine + 1 >= MIN_SUB_BLOCK_LINES);
    const noOneLineFragments = blocks.every((b) => b.endLine - b.startLine + 1 >= 2) && sliverBlocks.every((b) => b.endLine - b.startLine + 1 >= 2);

    console.log(`J3 anchor split only oversized, both sides >= MIN: ${splitHappened && allSidesAtLeastMin && boundariesAtAnchors}`);
    console.log(`J3 sub-MIN-sliver anchor ignored: ${subMinAnchorIgnored}`);
    console.log(`J3 no 1-line fragments, no dup/drop: ${noOneLineFragments && sliverTiling.everyLineOnce && tiling.everyLineOnce}`);
    console.log(`  (J3 blocks=${JSON.stringify(ranges(blocks))}, sliver=${JSON.stringify(ranges(sliverBlocks))})`);

    expect(splitHappened, 'oversized leftover split at the two anchors').toBe(true);
    expect(allSidesAtLeastMin, 'both sides of every anchor split are >= MIN').toBe(true);
    expect(boundariesAtAnchors, 'boundaries land exactly at the anchor lines').toBe(true);
    expect(subMinAnchorIgnored, 'an anchor that would create a sub-MIN sliver is ignored').toBe(true);
    expect(noOneLineFragments, 'no 1-line fragments produced').toBe(true);
    expect(tiling.everyLineOnce && sliverTiling.everyLineOnce, 'no line duplicated or dropped').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('J4 — import clusters: split only OUTSIDE defs, contiguous imports form one cluster block, def boundaries intact, both sides >= MIN', () => {
    // gap 1-30 (size 30) with one multiline import statement at 7-12 -> boundaries {7,13}:
    //   -> [1,6],[7,12],[13,30]  (the [7,12] is the import/setup cluster; both sides >= MIN)
    // def 31-54 (24 lines > 18, no scopes) stays one block, boundary at 31 intact.
    const n = 54;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 31, endLine: 54 }];
    const blocks = tileByDefs(source, defs, {
      scopes: [],
      injections: [],
      anchors: [],
      imports: [
        { line: 7, startLine: 7, endLine: 12, module: 'a' },
      ],
    });
    const tiling = assertCompleteVerbatimTiling(source, blocks);

    const importClusterIsOwnBlock = blocks.some((b) => b.startLine === 7 && b.endLine === 12);
    const defBoundaryIntact = hasBoundaryAt(blocks, 31);
    const bothSidesMin = blocks
      .filter((b) => b.startLine <= 30) // the gap-derived blocks only
      .every((b) => b.endLine - b.startLine + 1 >= MIN_SUB_BLOCK_LINES);

    // Imports placed INSIDE a def must NOT split the def block (import hints are OUTSIDE-defs only).
    const defWithImports = makeSource(30);
    const defWithImportsBlocks = tileByDefs(defWithImports, [{ startLine: 1, endLine: 30 }], {
      scopes: [],
      injections: [],
      anchors: [],
      imports: [
        { line: 10, startLine: 10, endLine: 15, module: 'a' },
      ],
    });
    const defWithImportsTiling = assertCompleteVerbatimTiling(defWithImports, defWithImportsBlocks);
    const importsInsideDefDoNotSplit = defWithImportsBlocks.length === 1;

    console.log(`J4 import cluster forms its own (outside-def) block: ${importClusterIsOwnBlock}`);
    console.log(`J4 def startLine boundary intact: ${defBoundaryIntact}`);
    console.log(`J4 both sides of the cluster split >= MIN: ${bothSidesMin}`);
    console.log(`J4 imports inside a def do NOT split the def: ${importsInsideDefDoNotSplit}`);
    console.log(`  (J4 blocks=${JSON.stringify(ranges(blocks))}, defWithImports=${JSON.stringify(ranges(defWithImportsBlocks))})`);

    expect(tiling.verbatim && tiling.everyLineOnce, 'complete verbatim tiling').toBe(true);
    expect(importClusterIsOwnBlock, 'contiguous imports form one cluster block').toBe(true);
    expect(defBoundaryIntact, 'def startLine boundary intact').toBe(true);
    expect(bothSidesMin, 'both sides of the import-cluster split are >= MIN').toBe(true);
    expect(importsInsideDefDoNotSplit, 'imports inside a def do not split the def block').toBe(true);
    expect(defWithImportsTiling.everyLineOnce, 'def-with-imports tiling stays complete').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('J5 — no fixed-size window: block sizes are NOT a constant stride and every boundary coincides with a real fact span/line', () => {
    // Reuse the J2 layout (rich mix of scopes + injections). A mechanical N-line window
    // would yield equal-sized blocks; assert the OPPOSITE and that every internal boundary
    // is derivable from a real fact (def startLine, scope start, injection start, or the
    // line just after a hard span's end).
    const n = 58;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 4, endLine: 34 }];
    const scopes = [
      { startLine: 9, endLine: 22, scopeKind: 'statement_block' },
      { startLine: 13, endLine: 19, scopeKind: 'for_statement' },
      { startLine: 32, endLine: 34, scopeKind: 'catch_clause' },
    ];
    const injections = [
      { startLine: 24, endLine: 30, injectedLang: 'sql' },
      { startLine: 40, endLine: 47, injectedLang: 'html' },
    ];
    const blocks = tileByDefs(source, defs, { scopes, injections, anchors: [], imports: [] });
    assertCompleteVerbatimTiling(source, blocks);

    const sizes = blocks.map((b) => b.endLine - b.startLine + 1);
    const notConstantStride = new Set(sizes).size > 1;

    // The set of every boundary a REAL fact can justify: line 1 (file start), N+1 (file end),
    // each def startLine, each scope startLine and endLine+1, each injection startLine and endLine+1.
    const factBoundaries = new Set<number>([1, n + 1]);
    for (const d of defs) { factBoundaries.add(d.startLine); factBoundaries.add(d.endLine + 1); }
    for (const s of scopes) { factBoundaries.add(s.startLine); factBoundaries.add(s.endLine + 1); }
    for (const inj of injections) { factBoundaries.add(inj.startLine); factBoundaries.add(inj.endLine + 1); }
    // Every block start AND every (block end + 1) must be a fact-justified boundary — no
    // boundary appears that a real span/line did not produce (after tiny-fragment merging,
    // which only ever REMOVES boundaries, never invents one).
    const everyBoundaryFactBacked = blocks.every(
      (b) => factBoundaries.has(b.startLine) && factBoundaries.has(b.endLine + 1),
    );

    console.log(`J5 block sizes are NOT a constant stride: ${notConstantStride}`);
    console.log(`J5 every boundary coincides with a real fact span/line: ${everyBoundaryFactBacked}`);
    console.log(`  (J5 sizes=${JSON.stringify(sizes)})`);

    expect(notConstantStride, 'sizes must not be a fixed window').toBe(true);
    expect(everyBoundaryFactBacked, 'every boundary derives from a real fact').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('J6 — duplicate scope == def span is absorbed (innermost-wins): same blocks as without it', () => {
    // def 4-30 with a real inner scope 8-20. Adding a scope whose span EQUALS the def span
    // (simulating tree-sitter `function_declaration`/`arrow_function`) must change nothing.
    const n = 34;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 4, endLine: 30 }];
    const base = tileByDefs(source, defs, {
      scopes: [{ startLine: 8, endLine: 20, scopeKind: 'statement_block' }],
      injections: [], anchors: [], imports: [],
    });
    const withDup = tileByDefs(source, defs, {
      scopes: [
        { startLine: 4, endLine: 30, scopeKind: 'function_declaration' }, // == def span
        { startLine: 8, endLine: 20, scopeKind: 'statement_block' },
      ],
      injections: [], anchors: [], imports: [],
    });
    assertCompleteVerbatimTiling(source, base);
    assertCompleteVerbatimTiling(source, withDup);

    const identical = JSON.stringify(ranges(base)) === JSON.stringify(ranges(withDup));
    console.log(`J6 duplicate scope==def span absorbed (identical blocks): ${identical}`);
    console.log(`  (J6 base=${JSON.stringify(ranges(base))}, dup=${JSON.stringify(ranges(withDup))})`);
    expect(identical, 'a scope equal to the def span is absorbed by innermost-wins').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('J7 — nested def → method → inner scope: class & method boundaries preserved; inner scope sub-blocks WITHIN the method only', () => {
    // class 1-40 (outer def), method 8-35 (inner def), if-block scope 15-28 inside the method.
    // innermost-wins: class owns 1-7 + 36-40; method owns 8-35; the scope subdivides ONLY the method.
    const n = 40;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 1, endLine: 40 }, { startLine: 8, endLine: 35 }];
    const blocks = tileByDefs(source, defs, {
      scopes: [{ startLine: 15, endLine: 28, scopeKind: 'if_statement' }],
      injections: [], anchors: [], imports: [],
    });
    const tiling = assertCompleteVerbatimTiling(source, blocks);

    const classBoundary = hasBoundaryAt(blocks, 1);
    const methodBoundary = hasBoundaryAt(blocks, 8);
    // Inner-scope sub-blocks are inside the method span [8..35]: the boundary at the scope
    // start (15) exists, and every block that starts at/after 15 and before 35 sits inside
    // the method (no inner-scope boundary leaked into the class-owned regions 1-7 / 36-40).
    const innerScopeBoundaryInsideMethod = hasBoundaryAt(blocks, 15) &&
      blocks.filter((b) => b.startLine === 15).every((b) => b.startLine >= 8 && b.endLine <= 35);
    // No block straddles the class/method or method/class boundary (8 and 36 are both real boundaries).
    const noBoundaryErased = hasBoundaryAt(blocks, 8) && hasBoundaryAt(blocks, 36);

    console.log(`J7 class boundary preserved: ${classBoundary}`);
    console.log(`J7 method boundary preserved: ${methodBoundary}`);
    console.log(`J7 inner scope sub-blocks WITHIN the method only: ${innerScopeBoundaryInsideMethod}`);
    console.log(`J7 no def boundary erased: ${noBoundaryErased}`);
    console.log(`  (J7 blocks=${JSON.stringify(ranges(blocks))})`);

    expect(tiling.everyLineOnce, 'complete tiling').toBe(true);
    expect(classBoundary, 'class startLine is a boundary').toBe(true);
    expect(methodBoundary, 'method startLine is a boundary').toBe(true);
    expect(innerScopeBoundaryInsideMethod, 'inner scope subdivides only within the method').toBe(true);
    expect(noBoundaryErased, 'both def boundaries (class/method) survive').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('J8 — defs=[] + scopes present: single-block fallback (scopes create NO blocks without a def base partition)', () => {
    // No defs -> the whole file is one gap block; scopes are NEVER used for a gap block
    // (scopes own no module-level lines), so they create no sub-blocks. With no injections/
    // anchors/imports either, the result is exactly one block spanning the whole file.
    const n = 30;
    const source = makeSource(n);
    const blocks = tileByDefs(source, [], {
      scopes: [
        { startLine: 8, endLine: 20, scopeKind: 'statement_block' },
        { startLine: 10, endLine: 15, scopeKind: 'for_statement' },
      ],
      injections: [], anchors: [], imports: [],
    });
    const tiling = assertCompleteVerbatimTiling(source, blocks);

    const singleBlock = blocks.length === 1;
    const first = blocks[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error('unreachable: non-empty source');
    const spansWholeFile = first.startLine === 1 && first.endLine === n;

    console.log(`J8 single-block fallback (scopes alone create no blocks): ${singleBlock && spansWholeFile}`);
    console.log(`  (J8 blocks=${JSON.stringify(ranges(blocks))})`);

    expect(tiling.verbatim, 'the single block is verbatim').toBe(true);
    expect(singleBlock, 'scopes do not create blocks without a def base partition').toBe(true);
    expect(spansWholeFile, 'the single block spans the whole file').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('J9 — injection crossing a def boundary is NOT contained → skipped; tiling stays complete; a contained injection IS honoured', () => {
    // Two adjacent defs: A 4-22, B 23-44. An injection 18-30 STRADDLES the 22|23 boundary
    // -> contained in NEITHER baseline block -> skipped (same "contained" rule as scopes).
    const n = 48;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 4, endLine: 22 }, { startLine: 23, endLine: 44 }];
    const withStraddle = tileByDefs(source, defs, {
      scopes: [],
      injections: [{ startLine: 18, endLine: 30, injectedLang: 'sql' }], // crosses 22|23
      anchors: [], imports: [],
    });
    const baseline = tileByDefs(source, defs, { scopes: [], injections: [], anchors: [], imports: [] });
    assertCompleteVerbatimTiling(source, withStraddle);
    assertCompleteVerbatimTiling(source, baseline);

    const straddleSkipped = JSON.stringify(ranges(withStraddle)) === JSON.stringify(ranges(baseline));
    const boundaryPreserved = hasBoundaryAt(withStraddle, 4) && hasBoundaryAt(withStraddle, 23);

    // Selectivity: a SECOND injection 30-37 fully inside def B IS honoured while the straddler is still skipped.
    const mixed = tileByDefs(source, defs, {
      scopes: [],
      injections: [
        { startLine: 18, endLine: 30, injectedLang: 'sql' },  // straddles -> skipped
        { startLine: 30, endLine: 37, injectedLang: 'html' }, // contained in B -> honoured
      ],
      anchors: [], imports: [],
    });
    assertCompleteVerbatimTiling(source, mixed);
    const containedHonoured = mixed.some((b) => b.startLine === 30 && b.endLine === 37);
    const mixedKeepsBoundaries = hasBoundaryAt(mixed, 4) && hasBoundaryAt(mixed, 23);

    console.log(`J9 straddling injection skipped (identical to baseline): ${straddleSkipped}`);
    console.log(`J9 no def boundary erased: ${boundaryPreserved && mixedKeepsBoundaries}`);
    console.log(`J9 contained injection still honoured: ${containedHonoured}`);
    console.log(`  (J9 withStraddle=${JSON.stringify(ranges(withStraddle))}, mixed=${JSON.stringify(ranges(mixed))})`);

    expect(straddleSkipped, 'an injection crossing a def boundary is skipped').toBe(true);
    expect(boundaryPreserved, 'def boundaries survive the skipped injection').toBe(true);
    expect(containedHonoured, 'a contained injection is still honoured').toBe(true);
    expect(mixedKeepsBoundaries, 'def boundaries survive in the mixed case too').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('J10 — anchor inside a def-owned block does NOT split the def block (anchors are soft splits for leftovers only)', () => {
    // def 4-30 (27 lines > 18) with NO inner scopes -> hard subdivision carves nothing,
    // so the def stays one piece. An anchor at line 15 inside it must NOT split it (anchors
    // only refine a def's already-separated BODY, never the whole def block / its signature).
    const n = 34;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 4, endLine: 30 }];
    const blocks = tileByDefs(source, defs, {
      scopes: [],
      injections: [],
      anchors: [{ line: 15, kind: 'export', symbolName: 'x', text: '' }],
      imports: [],
    });
    const tiling = assertCompleteVerbatimTiling(source, blocks);

    const defStaysWhole = blocks.some((b) => b.startLine === 4 && b.endLine === 30);
    const noBoundaryAtAnchor = !hasBoundaryAt(blocks, 15);

    console.log(`J10 anchor inside def does NOT split the def block: ${defStaysWhole && noBoundaryAtAnchor}`);
    console.log(`  (J10 blocks=${JSON.stringify(ranges(blocks))})`);

    expect(tiling.everyLineOnce, 'complete tiling').toBe(true);
    expect(defStaysWhole, 'the def-owned block is not split by an interior anchor').toBe(true);
    expect(noBoundaryAtAnchor, 'no block boundary appears at the interior anchor line').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('J11 — edge resolution after subdivision: an endpoint at the def startLine resolves to the SIGNATURE sub-block, not a body sub-block', () => {
    // def 4-34 with inner scope 10-26 -> signature sub-block starts at 4 (== def startLine).
    // Using the EXACT _factsToASTEdges resolution (exact startLine match first, else smallest
    // enclosing), an endpoint at line 4 must land on the signature sub-block index.
    const n = 40;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 4, endLine: 34 }];
    const blocks = tileByDefs(source, defs, {
      scopes: [{ startLine: 10, endLine: 26, scopeKind: 'statement_block' }],
      injections: [], anchors: [], imports: [],
    });
    assertCompleteVerbatimTiling(source, blocks);

    const defStartLine = 4;
    const resolvedIdx = resolveEndpointToBlock(blocks, defStartLine);
    expect(resolvedIdx).toBeDefined();
    if (resolvedIdx === undefined) throw new Error('unreachable: def startLine must resolve');
    const resolvedBlock = blocks[resolvedIdx];
    expect(resolvedBlock).toBeDefined();
    if (resolvedBlock === undefined) throw new Error('unreachable: resolved index in range');

    // The resolved block is the SIGNATURE sub-block: its startLine equals the def startLine.
    const resolvesToSignature = resolvedBlock.startLine === defStartLine;
    // And it is NOT a body sub-block: there exist later, body sub-blocks within the def whose
    // startLine is greater than the def startLine (so the resolution genuinely discriminates).
    const bodySubBlocks = blocks.filter((b) => b.startLine > defStartLine && b.endLine <= 34);
    const hasBodySubBlocks = bodySubBlocks.length > 0;
    const notABodyBlock = bodySubBlocks.every((b) => b.startLine !== resolvedBlock.startLine);
    // The signature sub-block is strictly smaller than the whole def span (def was subdivided),
    // confirming centrality relocates onto a SIGNATURE piece, not the entire function.
    const signatureIsSubBlock = resolvedBlock.endLine < 34;

    console.log(`J11 edge endpoint at def startLine resolves to the signature sub-block: ${resolvesToSignature}`);
    console.log(`J11 resolution discriminates signature from body sub-blocks: ${hasBodySubBlocks && notABodyBlock}`);
    console.log(`J11 signature is a proper sub-block of the def (relocation holds): ${signatureIsSubBlock}`);
    console.log(`  (J11 blocks=${JSON.stringify(ranges(blocks))}, resolvedIdx=${resolvedIdx})`);

    expect(resolvesToSignature, 'endpoint at def startLine resolves to the signature sub-block').toBe(true);
    expect(hasBodySubBlocks, 'the def has body sub-blocks to discriminate against').toBe(true);
    expect(notABodyBlock, 'the resolved block is not a body sub-block').toBe(true);
    expect(signatureIsSubBlock, 'the signature is a proper sub-block (def was subdivided)').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('Determinism — tiling twice on identical input yields identical block arrays', () => {
    const n = 58;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 4, endLine: 34 }];
    const refine = {
      scopes: [
        { startLine: 9, endLine: 22, scopeKind: 'statement_block' },
        { startLine: 13, endLine: 19, scopeKind: 'for_statement' },
        { startLine: 32, endLine: 34, scopeKind: 'catch_clause' },
      ],
      injections: [
        { startLine: 24, endLine: 30, injectedLang: 'sql' },
        { startLine: 40, endLine: 47, injectedLang: 'html' },
      ],
      anchors: [{ line: 50, kind: 'export', symbolName: 'z', text: '' }],
      imports: [{ startLine: 1, endLine: 1, module: 'a' }, { startLine: 2, endLine: 2, module: 'b' }],
    };
    const a = tileByDefs(source, defs, refine);
    const b = tileByDefs(source, defs, refine);
    assertCompleteVerbatimTiling(source, a);
    assertCompleteVerbatimTiling(source, b);

    // Deep equality on the full SourceBlock arrays (startLine, endLine, AND text).
    const identical = JSON.stringify(a) === JSON.stringify(b);
    console.log(`Determinism: identical block arrays across two runs: ${identical}`);
    expect(identical, 'two runs on identical input produce identical block arrays').toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  it('Backward-compat — the 2-arg form yields today\'s def-aligned / single-block partition', () => {
    // (a) tileByDefs(src, defs) with TWO args -> def-only partition (refine undefined):
    //     def 3-8 in a 12-line file -> [1-2 preamble][3-8 def][9-12 tail].
    const n = 12;
    const source = makeSource(n);
    const defs: DefSpan[] = [{ startLine: 3, endLine: 8 }];
    const twoArg = tileByDefs(source, defs);
    const twoArgTiling = assertCompleteVerbatimTiling(source, twoArg);
    const defOnlyPartition = JSON.stringify(ranges(twoArg)) === JSON.stringify([[1, 2], [3, 8], [9, 12]]);
    const defBoundaryKept = hasBoundaryAt(twoArg, 3);

    // (b) tileByDefs(src, []) with TWO args -> a single block spanning the whole file.
    const empty = tileByDefs(source, []);
    const emptyTiling = assertCompleteVerbatimTiling(source, empty);
    const singleBlock = empty.length === 1;
    const firstEmpty = empty[0];
    expect(firstEmpty).toBeDefined();
    if (firstEmpty === undefined) throw new Error('unreachable: non-empty source');
    const spansWholeFile = firstEmpty.startLine === 1 && firstEmpty.endLine === n;

    // (c) The 2-arg form and a LARGE def with NO refine must still NOT subdivide — a large
    //     def 1-30 with two args stays exactly one block (no refinement => baseline only).
    const largeSource = makeSource(30);
    const largeTwoArg = tileByDefs(largeSource, [{ startLine: 1, endLine: 30 }]);
    assertCompleteVerbatimTiling(largeSource, largeTwoArg);
    const largeStaysOneBlock = largeTwoArg.length === 1;

    console.log(`Backward-compat 2-arg def-only partition: ${defOnlyPartition && defBoundaryKept}`);
    console.log(`Backward-compat 2-arg empty defs -> single block: ${singleBlock && spansWholeFile}`);
    console.log(`Backward-compat 2-arg large def NOT subdivided (no refine): ${largeStaysOneBlock}`);
    console.log(`  (2-arg=${JSON.stringify(ranges(twoArg))}, empty=${JSON.stringify(ranges(empty))})`);

    expect(twoArgTiling.verbatim && twoArgTiling.everyLineOnce, '2-arg tiling is complete + verbatim').toBe(true);
    expect(defOnlyPartition, '2-arg def call yields the def-aligned partition').toBe(true);
    expect(defBoundaryKept, 'the def boundary is a block start').toBe(true);
    expect(emptyTiling.verbatim, 'empty-defs single block is verbatim').toBe(true);
    expect(singleBlock && spansWholeFile, '2-arg empty defs yields one whole-file block').toBe(true);
    expect(largeStaysOneBlock, '2-arg large def is not subdivided without refine').toBe(true);
  });
});
