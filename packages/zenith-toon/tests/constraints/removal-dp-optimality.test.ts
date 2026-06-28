// removal-dp-optimality.test.ts — Phase 7 (sub-stage 5B) proof: the SELECTION DP is
// PROVABLY OPTIMAL. This is the anti-cheat keystone.
//
// The removal gate's DP (selectDropsToBand) chooses which ELIGIBLE lines to drop so
// the kept output lands in the retention band, honouring two hard run rules (every
// maximal dropped run >= 6 lines; every interior kept run >= 6 lines) and removing
// the LEAST it can (gentlest legal compression). "Provably optimal" is not asserted
// by inspection — it is proven by brute force: on hundreds of small random inputs we
// EXHAUSTIVELY enumerate every keep/drop arrangement, find the true optimum under the
// exact same rule, and assert the DP reproduces it. A greedy approximation would fail
// at least one trial.
//
// The brute force below is the GROUND TRUTH: dead-simple, obviously correct, and the
// arbiter of what "valid" and "optimal" mean. The DP must agree with it on the chosen
// removed-char total R (and its own selection must itself be valid), feasible and
// infeasible inputs alike.

import { describe, it, expect } from 'vitest';

import { removalEngine, selectDropsToBand } from '../../src/removal.js';
import type { Payload, SourceBlock } from '../../src/compress-source.js';

// ── Reproducible randomness ─────────────────────────────────────────────────────
// mulberry32: a tiny seeded PRNG so every trial is deterministic and any failure is
// reproducible (a Math.random suite would make a failing seed unrecoverable).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Ground-truth validity (the exact rules the DP must enforce) ──────────────────
// Drop only eligible lines; every maximal dropped run >= 6; every INTERIOR kept run
// (a maximal kept run with a gap on BOTH sides) >= 6. Runs are maximal, so a kept
// run [i,j) is interior iff i>0 (line i-1 is dropped) AND j<n (line j is dropped).
function runsValid(drop: readonly boolean[], eligible: readonly boolean[]): boolean {
  const n = drop.length;
  for (let i = 0; i < n; i++) {
    if (drop[i] === true && eligible[i] !== true) return false; // eligibility
  }
  let i = 0;
  while (i < n) {
    if (drop[i] === true) {
      let j = i;
      while (j < n && drop[j] === true) j++;
      if (j - i < 6) return false; // dropped run too short
      i = j;
    } else i++;
  }
  i = 0;
  while (i < n) {
    if (drop[i] !== true) {
      let j = i;
      while (j < n && drop[j] !== true) j++;
      if (i > 0 && j < n && j - i < 6) return false; // interior kept run too short
      i = j;
    } else i++;
  }
  return true;
}

function droppedRunsAllGE6(drop: readonly boolean[]): boolean {
  const n = drop.length;
  let i = 0;
  while (i < n) {
    if (drop[i] === true) {
      let j = i;
      while (j < n && drop[j] === true) j++;
      if (j - i < 6) return false;
      i = j;
    } else i++;
  }
  return true;
}

function interiorKeptRunsAllGE6(drop: readonly boolean[]): boolean {
  const n = drop.length;
  let i = 0;
  while (i < n) {
    if (drop[i] !== true) {
      let j = i;
      while (j < n && drop[j] !== true) j++;
      if (i > 0 && j < n && j - i < 6) return false;
      i = j;
    } else i++;
  }
  return true;
}

// ── The selection rule (identical for ground truth and DP) ───────────────────────
// In-band: the SMALLEST reachable R in [rMin,rMax] (gentlest). Infeasible: the R
// NEAREST the band, smaller R breaking ties. r=0 (drop-nothing) is always reachable.
function chooseR(reachable: readonly number[], rMin: number, rMax: number): { R: number; bandSatisfied: boolean } {
  const inBand = reachable.filter((r) => r >= rMin && r <= rMax);
  if (inBand.length > 0) return { R: Math.min(...inBand), bandSatisfied: true };
  let bestR = Infinity;
  let bestDist = Infinity;
  for (const r of [...reachable].sort((a, b) => a - b)) {
    const dist = r < rMin ? rMin - r : r > rMax ? r - rMax : 0;
    if (dist < bestDist) {
      bestDist = dist;
      bestR = r;
    }
  }
  return { R: bestR, bandSatisfied: false };
}

// Exhaustively enumerate all 2^n arrangements, keep the structurally valid ones, and
// return the sorted set of achievable removed-char totals. The ground-truth reachable
// set (always includes 0 — drop-nothing is always valid).
function enumerateReachable(weights: readonly number[], eligible: readonly boolean[]): number[] {
  const n = weights.length;
  const reachable = new Set<number>();
  for (let mask = 0; mask < 1 << n; mask++) {
    const drop: boolean[] = new Array(n);
    for (let i = 0; i < n; i++) drop[i] = (mask & (1 << i)) !== 0;
    if (!runsValid(drop, eligible)) continue;
    let R = 0;
    for (let i = 0; i < n; i++) if (drop[i] === true) R += weights[i] ?? 0;
    reachable.add(R);
  }
  return [...reachable].sort((a, b) => a - b);
}

describe('Phase 7 (5B) — the selection DP is provably optimal', () => {
  it('matches the brute-force optimum on every random trial, and respects every rule', () => {
    const rng = mulberry32(0x5b_0001);
    const TRIALS = 600; // >= 500 required
    let matches = 0;
    let feasibleTrials = 0;
    let infeasibleTrials = 0;

    // Property accumulators — start true, falsified by any counterexample.
    let deterministic = true;
    let eligibilityRespected = true;
    let droppedRuns6 = true;
    let interiorKept6 = true;
    let landsInBandWhenFeasible = true;

    for (let t = 0; t < TRIALS; t++) {
      // n small enough for exhaustive 2^n enumeration; spans below and above the
      // 6-line run thresholds (so both "can form a run" and "cannot" arise).
      const n = 1 + Math.floor(rng() * 14); // 1..14
      const weights: number[] = new Array(n);
      const eligible: boolean[] = new Array(n);
      let total = 0;
      for (let i = 0; i < n; i++) {
        const w = 1 + Math.floor(rng() * 9); // 1..9
        weights[i] = w;
        total += w;
        eligible[i] = rng() < 0.6;
      }
      // Build the ground-truth reachable set once, then choose a band. ~60% of the
      // time bias it to be FEASIBLE (a band straddling a real reachable R — often
      // several, so the gentlest-min-R choice is genuinely tested); the rest are
      // fully random (frequently infeasible, exercising forced-nearest).
      const reachable = enumerateReachable(weights, eligible);
      let rMin: number;
      let rMax: number;
      if (rng() < 0.6 && reachable.length > 0) {
        const target = reachable[Math.floor(rng() * reachable.length)] ?? 0;
        rMin = Math.max(0, target - Math.floor(rng() * 4)); // target itself is in-band -> feasible
        rMax = target + Math.floor(rng() * 4);
      } else {
        const a = Math.floor(rng() * (total + 1));
        const b = Math.floor(rng() * (total + 1));
        rMin = Math.min(a, b);
        rMax = Math.max(a, b);
      }

      const brute = chooseR(reachable, rMin, rMax);
      const dp = selectDropsToBand(weights, eligible, rMin, rMax);

      // (1) The DP's own selection must be structurally valid.
      const dpValid = runsValid(dp.drop, eligible);
      // (2) Same chosen removed-char total and same band verdict as the optimum.
      const sameR = dp.removed === brute.R;
      const sameBand = dp.bandSatisfied === brute.bandSatisfied;
      if (dpValid && sameR && sameBand) matches++;

      // Determinism: identical inputs -> identical selection.
      const dp2 = selectDropsToBand(weights, eligible, rMin, rMax);
      if (dp2.drop.length !== dp.drop.length || dp2.removed !== dp.removed) deterministic = false;
      else for (let i = 0; i < n; i++) if (dp2.drop[i] !== dp.drop[i]) deterministic = false;

      // Eligibility: no dropped line was ineligible.
      for (let i = 0; i < n; i++) if (dp.drop[i] === true && eligible[i] !== true) eligibilityRespected = false;

      // Run rules.
      if (!droppedRunsAllGE6(dp.drop)) droppedRuns6 = false;
      if (!interiorKeptRunsAllGE6(dp.drop)) interiorKept6 = false;

      // Lands in band whenever a valid in-band arrangement exists.
      if (brute.bandSatisfied) {
        feasibleTrials++;
        if (!dp.bandSatisfied || dp.removed < rMin || dp.removed > rMax) landsInBandWhenFeasible = false;
      } else {
        infeasibleTrials++;
      }
    }

    console.log(`DP matches brute-force optimum: ${matches === TRIALS} (over ${TRIALS} trials)`);
    console.log(`  (feasible trials: ${feasibleTrials}, infeasible trials: ${infeasibleTrials})`);
    console.log(`deterministic: ${deterministic}`);
    console.log(`eligibility respected: ${eligibilityRespected}`);
    console.log(`dropped runs >= 6: ${droppedRuns6}`);
    console.log(`interior kept runs >= 6: ${interiorKept6}`);
    console.log(`lands in band when feasible: ${landsInBandWhenFeasible}`);

    expect(matches, 'DP reproduces the brute-force optimum on every trial').toBe(TRIALS);
    expect(deterministic, 'identical input yields identical selection').toBe(true);
    expect(eligibilityRespected, 'only eligible lines are ever dropped').toBe(true);
    expect(droppedRuns6, 'every maximal dropped run is >= 6 lines').toBe(true);
    expect(interiorKept6, 'every interior kept run is >= 6 lines').toBe(true);
    expect(landsInBandWhenFeasible, 'lands in band whenever a valid in-band arrangement exists').toBe(true);
    // Sanity: the random bands actually exercised BOTH paths, not just one.
    expect(feasibleTrials, 'some trials were feasible').toBeGreaterThan(0);
    expect(infeasibleTrials, 'some trials were infeasible (forced-nearest exercised)').toBeGreaterThan(0);
  });

  it('gently compresses a real-ish file into the retention band (end-to-end sample)', () => {
    // A 40-line "file": block 0 (lines 1-4) is SageRank-core (a signature/exports
    // region); BMX+ protects the tail (lines 38-40). That leaves a long contiguous
    // eligible stretch (lines 5-37) the DP can thin to reach the band — gently, with
    // a single gap, never touching a protected line.
    const lineText = (n: number): string => {
      const bodies = [
        'const resolved = resolveCandidate(input, options, context);',
        'if (!resolved) return fallback;',
        'const scored = candidates.map((c) => scoreCandidate(c, weights));',
        'total += scored.reduce((a, b) => a + b.value, 0);',
        'for (const entry of entries) { acc.push(transform(entry)); }',
        'logger.debug(`processed ${entry.id} -> ${entry.state}`);',
      ];
      return `${n}. ${bodies[n % bodies.length] ?? 'noop();'}`;
    };
    const all: string[] = [];
    for (let n = 1; n <= 40; n++) all.push(lineText(n));
    const block0: SourceBlock = { startLine: 1, endLine: 4, text: all.slice(0, 4).join('\n') };
    const block1: SourceBlock = { startLine: 5, endLine: 40, text: all.slice(4).join('\n') };

    const payload: Payload = {
      source: { blocks: [block0, block1], query: null, charBudget: 100_000 }, // budget loose -> band-driven
      metadata: {
        sagerank: { scores: [], rankedIndices: [], coverageOrder: [], coreIndices: [0] }, // block 0 protected
        bmx: { scores: new Map<number, number>(), core: new Set<number>([38, 39, 40]) }, // tail protected
      },
    };

    const out = removalEngine(payload);
    const removal = out.metadata.removal as {
      eligible: ReadonlyMap<number, boolean>;
      dropped: ReadonlySet<number>;
      keptSize: number;
      bandSatisfied: boolean;
    };

    // Recompute the band the same way the gate does, for display + assertion.
    let fullSize = 0;
    for (const s of all) fullSize += s.replace(/^\s*\d+[.:]\s?/, '').length;
    const LO = Math.ceil(0.68 * fullSize);
    const HI = Math.floor(0.72 * fullSize);
    const keptCeiling = Math.min(HI, 100_000);
    const rMin = fullSize - keptCeiling;
    const rMax = fullSize - LO;
    const R = fullSize - removal.keptSize;

    console.log(
      `sample: fullSize=${fullSize}, band kept=[${LO}..${keptCeiling}] (removed=[${rMin}..${rMax}]), ` +
        `chosen R=${R}, keptSize=${removal.keptSize}, dropped ${removal.dropped.size} lines, ` +
        `bandSatisfied=${removal.bandSatisfied}`,
    );

    // Gentle + in band: kept size inside [LO, keptCeiling], and never a protected line dropped.
    expect(removal.bandSatisfied, 'sample lands inside the retention band').toBe(true);
    expect(removal.keptSize).toBeGreaterThanOrEqual(LO);
    expect(removal.keptSize).toBeLessThanOrEqual(keptCeiling);
    for (const ln of [1, 2, 3, 4, 38, 39, 40]) {
      expect(removal.dropped.has(ln), `protected line ${ln} must never be dropped`).toBe(false);
    }
    // Output carries the truncation token and keeps protected lines verbatim.
    expect(out.output?.includes('[TRUNCATED]'), 'output shows a truncation token').toBe(true);
    expect(out.output?.includes(all[0] ?? ''), 'a protected line survives verbatim').toBe(true);
  });
});
