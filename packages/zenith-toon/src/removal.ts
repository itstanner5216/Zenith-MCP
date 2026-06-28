// removal.ts — the REMOVAL GATE. The value-blind engine at the forward end of the
// chain (entry -> SageRank -> BMX+ -> Removal -> Render). It is the first engine
// that CAN drop lines, but it has NO ranking of its own and never invents one: it
// reads the two ranking engines' verdicts off the payload and decides exactly ONE
// thing — which lines are even ELIGIBLE to be dropped.
//
// THE GATE'S ONE RULE (all this sub-stage builds):
//   A line is eligible for removal ONLY if BOTH ranking engines independently
//   judged it non-core. Either engine's "this is important" verdict PROTECTS the
//   line outright. There is NO blending of the two engines — no per-engine
//   coefficient, no combined number. They are equal co-vetoes, ANDed:
//       protected[line] = sage-core(line) OR bmx-core(line)
//       eligible[line]  = NOT protected[line]     // i.e. NOT sage-core AND NOT bmx-core
//   `eligible` is a strict BOOLEAN per line. The gate never asks "how important is
//   this line" — only "did BOTH engines say it is droppable." That is precisely
//   what keeps the gate from ever degrading into a standalone chopper with opinions
//   of its own: it has no opinions, only the two engines' booleans.
//
// FAIL LOUD, DEGRADE OUTSIDE: if either engine's verdict is missing or malformed
// the gate THROWS — it must never improvise a selection from half the evidence.
// That throw is contained at toon's own public boundary (index.ts `compressFile`),
// which degrades to "use raw content," so a real-time caller is never interrupted
// by a compression failure. Loud to the operator, invisible to the caller.
//
// SUB-STAGE 5A SCOPE: this builds the data contract and the eligibility partition
// ONLY. It does NOT yet drop any line. It computes eligibility, records it as the
// gate's own determination, and sets `payload.output` to the FULL source unchanged
// — the honest "nothing dropped yet" state. The DP that actually selects which
// eligible lines to drop (within the char budget, honouring the 6-line-gap rule)
// arrives in sub-stage 5B. Until then, returning the full source is the only
// honest output: anything that dropped lines now would be unproven, and anything
// that passed the full file off as "compressed" would be a lie.

import type { Payload } from './compress-source.js';

/**
 * The removal gate's determination — the `removal` metadata key it owns. For this
 * sub-stage it carries the ELIGIBILITY PARTITION and nothing else: a strict boolean
 * per ABSOLUTE line number — `true` when BOTH ranking engines judged the line
 * non-core (so it is a candidate for removal), `false` when at least one engine
 * protected it.
 *
 * It is deliberately NOT a number: no per-line importance, no blend, no ordering.
 * The gate ANDs two boolean cores; it computes nothing a line could be ranked by.
 * Defined and owned HERE; the DP (sub-stage 5B) and the render engine consume it.
 */
export interface RemovalMetadata {
  readonly eligible: ReadonlyMap<number, boolean>;
}

/**
 * The removal gate's core process. It (1) FAILS LOUD if either ranking engine's
 * verdict is missing/malformed — it cannot and must not gate on half the evidence;
 * (2) projects the SageRank BLOCK core onto lines and reads the BMX+ LINE core;
 * (3) computes the boolean eligibility partition (protected = sage-core OR bmx-core;
 * eligible = neither); (4) records that as its own determination; and (5) — for
 * THIS sub-stage only — emits the FULL source unchanged as output (nothing dropped
 * yet).
 *
 * It is the forward end of the chain: render is not built, so it calls no successor
 * and simply returns the payload. Line identity is always block.startLine + offset,
 * carried verbatim — never recomputed.
 */
export function removalEngine(payload: Payload): Payload {
  // ── (1) FAIL LOUD on missing/malformed engine verdicts ──────────────────────
  // The gate has no ranking of its own; without BOTH engine cores it cannot decide
  // eligibility. Throw rather than improvise — the throw is caught and degraded to
  // "use raw" at toon's public boundary (index.ts), so it never reaches the caller.
  const sagerankMeta = payload.metadata.sagerank;
  if (typeof sagerankMeta !== 'object' || sagerankMeta === null || !('coreIndices' in sagerankMeta)) {
    throw new Error(
      'removalEngine: payload.metadata.sagerank is missing or malformed (expected ' +
        'SageRank coreIndices). The gate has no ranking of its own and cannot ' +
        'operate without both engine cores.',
    );
  }
  const sageCoreRaw = sagerankMeta.coreIndices;
  if (!Array.isArray(sageCoreRaw)) {
    throw new Error('removalEngine: SageRank coreIndices is not an array — malformed metadata.sagerank.');
  }

  const bmxMeta = payload.metadata.bmx;
  if (typeof bmxMeta !== 'object' || bmxMeta === null || !('core' in bmxMeta)) {
    throw new Error(
      'removalEngine: payload.metadata.bmx is missing or malformed (expected the ' +
        'BMX+ core line set). The gate cannot operate without both engine cores.',
    );
  }
  const bmxCoreRaw = bmxMeta.core;
  if (!(bmxCoreRaw instanceof Set)) {
    throw new Error('removalEngine: the BMX+ core is not a Set — malformed metadata.bmx.');
  }

  // The SageRank core is BLOCK INDICES (index-aligned to source.blocks); the BMX+
  // core is ABSOLUTE LINE NUMBERS. Collect each as a numeric membership set.
  // Defensive number-only collection: anything non-numeric in a verdict is ignored,
  // never coerced — line/block identity stays exact.
  const sageCoreBlocks = new Set<number>();
  for (const idx of sageCoreRaw) {
    if (typeof idx === 'number') sageCoreBlocks.add(idx);
  }
  const bmxCoreLines = new Set<number>();
  for (const ln of bmxCoreRaw) {
    if (typeof ln === 'number') bmxCoreLines.add(ln);
  }

  // ── (2) Flatten blocks -> absolute lines. IDENTICAL flattening to bmxEngine
  //    (block.text.split('\n'), startLine + i) so line numbering matches across
  //    engines. Record each line's owning BLOCK INDEX (to project the SageRank
  //    block core onto lines) and its ORIGINAL prefixed text (preserved verbatim
  //    for the placeholder output — never mutated, never recomputed). ────────────
  const flat: Array<{ line: number; blockIndex: number; text: string }> = [];
  const blocks = payload.source.blocks;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b === undefined) continue; // Rule 6: explicit guard, no non-null assertion
    const physical = b.text.split('\n');
    for (let i = 0; i < physical.length; i++) {
      flat.push({ line: b.startLine + i, blockIndex: bi, text: physical[i] ?? '' });
    }
  }

  // ── (3) ELIGIBILITY PARTITION — the heart of the gate. A line is eligible ONLY
  //    if NEITHER engine protected it. Equal co-vetoes, ANDed — no blend. The value
  //    is a strict boolean; the gate computes no importance number. Every line is
  //    present in the map. ───────────────────────────────────────────────────────
  const eligible = new Map<number, boolean>();
  for (const f of flat) {
    const protectedBySage = sageCoreBlocks.has(f.blockIndex); // its block is core
    const protectedByBmx = bmxCoreLines.has(f.line);          // its line is core
    eligible.set(f.line, !protectedBySage && !protectedByBmx);
  }

  // ── (4) Drop the gate's stone in the backpack: the boolean partition only. ────
  const determination: RemovalMetadata = { eligible };
  payload.metadata.removal = determination;

  // ── (5) Placeholder output — NOTHING dropped yet. The full source: every line in
  //    ascending order with its ORIGINAL prefixed text, joined by '\n'. The DP that
  //    drops eligible lines arrives in sub-stage 5B; until then any "compressed"
  //    output would be the full file passed off as compressed — a lie the design
  //    forbids — so the gate emits the file unchanged. ─────────────────────────────
  payload.output = flat.map((f) => f.text).join('\n');

  // Forward end of the chain: render is not built yet, so call no successor.
  return payload;
}
