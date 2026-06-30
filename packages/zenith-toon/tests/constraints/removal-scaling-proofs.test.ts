// removal-scaling-proofs.test.ts — PRODUCTION-PATH verification of the ADAPTIVE
// NET-AXIS QUANTIZATION in `selectDropsToBand` (src/removal.ts).
//
// The selection DP's reachability table is (n+1)·STATES·WORDS Uint32 words, and WORDS
// tracks the net WINDOW WIDTH — which is pseudo-polynomial in a file's TOTAL character
// weight. A file of megabyte-scale lines would size that table into the gigabytes and
// OOM the process. The engine instead divides the net axis by the smallest integer
// scale g ≥ 1 that fits MAX_REACH_WORDS, runs the SAME exact multi-gap DP on the
// coarsened axis, and RECOMPUTES the true net from the ORIGINAL integer weights + the
// real markerLen. Normal files stay at g = 1 (byte-identical — proven by the fen suite,
// whose largest table sits at ~50.78M words, well under the 125M-word / 500 MiB ceiling).
//
// This suite forces g > 1 the way the spec requires: with GENUINELY oversized inputs
// driven through the REAL const path (no override) — 40 lines of ~320 000 chars each, an
// exact (g = 1) table that provably exceeds MAX_REACH_WORDS. It proves the four contract
// properties the design must hold in the scaled regime:
//
//   PROOF S1 — (a) FEASIBLE: a valid in-band cut exists ⇒ the scaled selection, with its
//              true net recomputed from the original integer weights, lands in the TRUE
//              [netMin, netMax]; the selection is structurally valid; and the independent
//              netOf accounting equals the engine's reported netRemoved.
//   PROOF S2 — (b) INFEASIBLE: when quantization cannot place the true band, the engine
//              DROPS NOTHING (net 0, bandSatisfied false) so compressFile's usefulness
//              gate serves the file raw — it NEVER ships a quantization-skewed out-of-band
//              cut.
//   PROOF S3 — (c) verifyOutput H1–H7 passes on the TRUE-number output produced end-to-end
//              by removalEngine in the scaled regime.
//   PROOF S4 — (d) DETERMINISM (Invariant 7): identical giant input ⇒ byte-identical
//              result at g > 1.
//   PROOF S5 — the scaling MATH holds across MANY scales (g = 2…large): a cheap sweep that
//              forces higher g via the optional maxReachWords seam (small inputs, no giant
//              allocation) and re-checks the universal guarantee at every scale.
//
// The exact (g = 1) table size is bounded BELOW by (n+1)·STATES·⌈netMax/32⌉ (the window
// must at least reach netMax, and its floor windowLo ≤ 0). Asserting that lower bound
// exceeds the ceiling proves the exact path could not have run — i.e. scaling necessarily
// engaged — without reading any engine internal.

import { describe, it, expect } from 'vitest';

import {
  removalEngine,
  selectDropsToBand,
  verifyOutput,
  MAX_REACH_WORDS,
  type RemovalMetadata,
} from '../../src/removal.js';
import type { Payload, SourceBlock } from '../../src/compress-source.js';
import { runsValid, netOf, STATES } from '../../bench/invariants.js';

// Generous per-test timeout: each giant case allocates a few-hundred-MiB scaled reach
// table (comparable to the fen suite's n=2000 case at ~203 MiB) and runs in well under a
// second; the ceiling is only here so a slow CI box can never trip vitest's 5 s default.
const PROOF_TIMEOUT_MS = 600_000;

// ── The giant input: 40 lines, each ~320 000 chars, ALL eligible. fullSize ≈ 12.8M, so the
//    exact (g = 1) reach table would be ~140M words (~560 MiB) > the 125M ceiling ⇒ g = 2. A
//    valid in-band cut is a single ~12-line run. Built ONCE and shared by S1/S2/S4. ────────
const GIANT_N = 40;
const GIANT_W = 320_000;
const giantWeights: number[] = new Array<number>(GIANT_N).fill(GIANT_W);
const giantLines: number[] = Array.from({ length: GIANT_N }, (_v, i) => i + 1);
const giantEligible: boolean[] = new Array<boolean>(GIANT_N).fill(true);
const GIANT_FULL = GIANT_N * GIANT_W; // 12_800_000

// A "normal" 68–72% band over the giant file (same ratios the gate uses).
const FEASIBLE_NET_MIN = Math.ceil(0.28 * GIANT_FULL); // = fullSize − HI
const FEASIBLE_NET_MAX = Math.floor(0.32 * GIANT_FULL); // = fullSize − LO

// A NARROW band wedged between two reachable nets (12-line run = 3.84M, 13-line run = 4.16M),
// so NO structurally valid arrangement lands inside it ⇒ the scaled engine must serve raw.
const INFEASIBLE_NET_MIN = 3_900_000;
const INFEASIBLE_NET_MAX = 4_050_000;

// Lower bound on the exact (g = 1) table for a given netMax: WORDS ≥ ⌈netMax/32⌉ because the
// window must reach netMax and its floor is ≤ 0. If THIS exceeds the budget, the exact path
// could not have allocated — scaling necessarily engaged.
function exactTableLowerBound(n: number, netMax: number): number {
  return (n + 1) * STATES * Math.ceil(netMax / 32);
}

describe('adaptive net-axis quantization — production-path proofs (feasible / infeasible / verify / determinism / scale-sweep)', () => {
  // ── PROOF S1 — (a) FEASIBLE giant input, REAL const path: scaling engages and the true
  //    (original-weight) net lands in the TRUE band. ───────────────────────────────────────
  it('PROOF S1 — feasible giant input forces g>1 (real const) and the recomputed true net is in the true band', () => {
    const lower = exactTableLowerBound(GIANT_N, FEASIBLE_NET_MAX);
    // Prove the exact (g = 1) table could not have run under the production ceiling.
    expect(
      lower,
      `exact g=1 table lower bound (${lower}) must exceed MAX_REACH_WORDS (${MAX_REACH_WORDS}) so scaling necessarily engaged`,
    ).toBeGreaterThan(MAX_REACH_WORDS);

    const t0 = performance.now();
    const sel = selectDropsToBand(giantWeights, giantLines, giantEligible, FEASIBLE_NET_MIN, FEASIBLE_NET_MAX);
    const ms = performance.now() - t0;
    console.log(
      `\nPROOF S1 — n=${GIANT_N} w=${GIANT_W} fullSize=${GIANT_FULL} band=[${FEASIBLE_NET_MIN},${FEASIBLE_NET_MAX}]\n` +
        `  exact g=1 table ≥ ${lower} words (> ${MAX_REACH_WORDS} ceiling) ⇒ g>1 forced; ` +
        `selectDropsToBand: ${ms.toFixed(1)}ms, netRemoved=${sel.netRemoved}, bandSatisfied=${sel.bandSatisfied}`,
    );

    const dropped = sel.drop.filter((d) => d === true).length;
    expect(dropped, 'a feasible band must produce a non-empty cut (not the raw fallback)').toBeGreaterThan(0);
    // Structural validity: eligibility + dropped-run≥6 + interior-kept-run≥6 (scale-invariant).
    expect(runsValid(sel.drop, giantEligible), 'scaled selection must be structurally valid').toBe(true);
    // The engine's reported netRemoved must equal the INDEPENDENT char accounting from the
    // original integer weights + real markerLen — i.e. the true net, not the scaled net.
    expect(netOf(sel.drop, giantWeights, giantLines), 'reported netRemoved must equal independent true-net accounting').toBe(sel.netRemoved);
    // (a): the TRUE net lands inside the real band.
    expect(sel.bandSatisfied, 'a valid in-band cut exists ⇒ bandSatisfied').toBe(true);
    expect(sel.netRemoved).toBeGreaterThanOrEqual(FEASIBLE_NET_MIN);
    expect(sel.netRemoved).toBeLessThanOrEqual(FEASIBLE_NET_MAX);
    // Bounded: nowhere near an OOM-era wall.
    expect(ms, 'scaled solve completes far under the 5 s wall').toBeLessThan(5000);
  }, PROOF_TIMEOUT_MS);

  // ── PROOF S2 — (b) INFEASIBLE giant input: degrade to raw via the existing machinery. ────
  it('PROOF S2 — when the true band is unreachable, the scaled engine drops nothing (serves raw), never out-of-band', () => {
    const lower = exactTableLowerBound(GIANT_N, INFEASIBLE_NET_MAX);
    expect(lower, 'infeasible case must also force scaling').toBeGreaterThan(MAX_REACH_WORDS);

    const sel = selectDropsToBand(giantWeights, giantLines, giantEligible, INFEASIBLE_NET_MIN, INFEASIBLE_NET_MAX);
    console.log(
      `\nPROOF S2 — narrow band=[${INFEASIBLE_NET_MIN},${INFEASIBLE_NET_MAX}] between reachable nets 3.84M/4.16M\n` +
        `  netRemoved=${sel.netRemoved}, bandSatisfied=${sel.bandSatisfied}, dropped=${sel.drop.filter((d) => d === true).length}`,
    );

    // Degrade-to-raw: drop nothing so removal.dropped is empty and compressFile serves raw.
    expect(sel.drop.some((d) => d === true), 'unreachable true band ⇒ drop nothing').toBe(false);
    expect(sel.netRemoved, 'drop-nothing net is 0').toBe(0);
    expect(sel.bandSatisfied, 'drop-nothing is honestly out-of-band').toBe(false);
    // Universal guarantee: the reported net still matches independent accounting (0).
    expect(netOf(sel.drop, giantWeights, giantLines)).toBe(sel.netRemoved);
  }, PROOF_TIMEOUT_MS);

  // ── PROOF S3 — (c) verifyOutput H1–H7 on the scaled regime's TRUE-number output ──────────
  it('PROOF S3 — removalEngine end-to-end on a giant file produces output that passes verifyOutput (H1–H7) at g>1', () => {
    // Build the prefixed source the gate would compress: 40 lines of ~320k chars each.
    const physical: string[] = new Array<string>(GIANT_N);
    for (let i = 0; i < GIANT_N; i++) physical[i] = `${i + 1}. ` + 'x'.repeat(GIANT_W);
    const rawPrefixed = physical.join('\n');
    const charBudget = GIANT_FULL; // ⇒ keptCeiling = HI ⇒ a normal 68–72% band

    const block: SourceBlock = { startLine: 1, endLine: GIANT_N, text: rawPrefixed };
    const payload: Payload = {
      source: { blocks: [block], query: null, charBudget },
      metadata: {
        sagerank: { coreIndices: [] as number[] }, // nothing protected ⇒ all eligible
        bmx: { core: new Set<number>() },
      },
    };

    const out = removalEngine(payload);
    const removal = out.metadata.removal as RemovalMetadata | undefined;
    const output = out.output;
    expect(removal, 'removalEngine must return removal metadata').not.toBeUndefined();
    expect(typeof output, 'removalEngine must return an output string').toBe('string');
    if (removal === undefined || typeof output !== 'string') return;

    console.log(
      `\nPROOF S3 — removalEngine on n=${GIANT_N} fullSize=${GIANT_FULL}: ` +
        `dropped=${removal.dropped.size}, renderedSize=${removal.renderedSize}, bandSatisfied=${removal.bandSatisfied}`,
    );

    // The giant file is feasible ⇒ a real cut shipped through the scaled path.
    expect(removal.dropped.size, 'feasible giant file must compress (non-empty dropped set)').toBeGreaterThan(0);
    expect(removal.bandSatisfied, 'feasible giant file lands in band').toBe(true);
    // The keystone: verify H1–H7 on the EXACT string compressFile would return. Throws on any
    // violation (verbatim/line-number/marker/band); a clean return is the proof.
    expect(() => verifyOutput(rawPrefixed, output, removal, charBudget)).not.toThrow();
  }, PROOF_TIMEOUT_MS);

  // ── PROOF S4 — (d) DETERMINISM at g>1 ───────────────────────────────────────────────────
  it('PROOF S4 — running the scaled (g>1) selection twice on identical giant input is byte-identical', () => {
    const a = selectDropsToBand(giantWeights, giantLines, giantEligible, FEASIBLE_NET_MIN, FEASIBLE_NET_MAX);
    const b = selectDropsToBand(giantWeights, giantLines, giantEligible, FEASIBLE_NET_MIN, FEASIBLE_NET_MAX);
    let identical = a.netRemoved === b.netRemoved && a.bandSatisfied === b.bandSatisfied && a.drop.length === b.drop.length;
    if (identical) {
      for (let i = 0; i < a.drop.length; i++) {
        if (a.drop[i] !== b.drop[i]) {
          identical = false;
          break;
        }
      }
    }
    console.log(`\nPROOF S4 — scaled determinism: ${identical ? 'byte-identical' : 'FAIL'}`);
    expect(identical, 'g>1 selection must be deterministic (Invariant 7)').toBe(true);
  }, PROOF_TIMEOUT_MS);

  // ── PROOF S5 — the scaling MATH across many scales, cheaply (optional maxReachWords seam) ─
  // 60 lines × 10 000 chars, all eligible, a normal band. The REAL const keeps this at g = 1
  // (table ~9.6M words), so to exercise g = 2…large WITHOUT allocating giant tables we pass a
  // shrunken maxReachWords — the optional, defaulted seam that exists ONLY for this. Each
  // budget still drives the SAME production code path; we assert the universal guarantee at
  // every scale: reported net == independent accounting, structurally valid, and (since this
  // input is feasible) the recomputed true net lands in the true band.
  it('PROOF S5 — scaled selection holds across many g (cheap seam sweep): valid, true-net-accurate, in-band', () => {
    const n = 60;
    const w = 10_000;
    const weights: number[] = new Array<number>(n).fill(w);
    const lines: number[] = Array.from({ length: n }, (_v, i) => i + 1);
    const eligible: boolean[] = new Array<boolean>(n).fill(true);
    const fullSize = n * w; // 600_000
    const netMin = Math.ceil(0.28 * fullSize);
    const netMax = Math.floor(0.32 * fullSize);

    // Shrunken ceilings → progressively larger g. Each is far below the exact g=1 table
    // (lower bound (n+1)·STATES·⌈netMax/32⌉ ≈ 9.15M words), so each forces scaling.
    const budgets = [4_000_000, 2_000_000, 1_000_000, 500_000, 250_000];
    const exactLB = exactTableLowerBound(n, netMax);

    const rows: string[] = [];
    for (const budget of budgets) {
      expect(exactLB, `budget ${budget} must force scaling (exact LB ${exactLB})`).toBeGreaterThan(budget);
      const sel = selectDropsToBand(weights, lines, eligible, netMin, netMax, budget);
      const dropped = sel.drop.filter((d) => d === true).length;

      // Universal guarantee (holds at EVERY scale): reported net == independent accounting…
      expect(netOf(sel.drop, weights, lines), `budget=${budget}: netRemoved must equal independent accounting`).toBe(sel.netRemoved);
      // …and a shipped cut is structurally valid AND truly in band (never out-of-band).
      if (dropped > 0) {
        expect(runsValid(sel.drop, eligible), `budget=${budget}: shipped cut must be valid`).toBe(true);
        expect(sel.netRemoved, `budget=${budget}: shipped cut must be ≥ netMin`).toBeGreaterThanOrEqual(netMin);
        expect(sel.netRemoved, `budget=${budget}: shipped cut must be ≤ netMax`).toBeLessThanOrEqual(netMax);
        expect(sel.bandSatisfied, `budget=${budget}: in-band cut ⇒ bandSatisfied`).toBe(true);
      } else {
        expect(sel.netRemoved, `budget=${budget}: raw fallback net is 0`).toBe(0);
        expect(sel.bandSatisfied, `budget=${budget}: raw fallback is out-of-band`).toBe(false);
      }
      rows.push(`  budget=${pad(budget, 9)} dropped=${pad(dropped, 3)} netRemoved=${pad(sel.netRemoved, 7)} band=${sel.bandSatisfied}`);
    }
    console.log(`\nPROOF S5 — scale sweep (band=[${netMin},${netMax}]):\n` + rows.join('\n'));

    // This input has many valid in-band cuts; with the (n+1)·g drift margin staying far under
    // the band width, every sweep point must actually COMPRESS (proving feasibility survives
    // quantization, not just that out-of-band is avoided).
    for (const budget of budgets) {
      const sel = selectDropsToBand(weights, lines, eligible, netMin, netMax, budget);
      expect(sel.bandSatisfied, `budget=${budget}: feasible input must stay feasible under scaling`).toBe(true);
    }
  }, PROOF_TIMEOUT_MS);
});

function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + ' '.repeat(w - str.length);
}
