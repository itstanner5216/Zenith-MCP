// removal-dp-optimality.test.ts — Phase 8 (sub-stage 5B.1) proof: the SELECTION DP is
// PROVABLY OPTIMAL on RENDERED size, with real `[TRUNCATED: lines X-Y]` markers. This
// is the anti-cheat keystone.
//
// The removal gate's DP (selectDropsToBand) chooses which ELIGIBLE lines to drop so
// the RENDERED output — kept content PLUS the chars each gap's marker adds — lands in
// the retention band, honouring two hard run rules (every maximal dropped run >= 6
// lines; every interior kept run >= 6 lines) and removing the LEAST it can NET of the
// marker cost (gentlest legal compression). "Provably optimal" is not asserted by
// inspection — it is proven by brute force: on hundreds of small random inputs we
// EXHAUSTIVELY enumerate every keep/drop arrangement, INDEPENDENTLY compute its
// rendered size with exact per-gap markers, find the true optimum under the exact same
// rule, and assert the DP reproduces it. A greedy approximation — or one that ignored
// the marker cost, or charged it per line instead of per gap — would fail a trial.
//
// The brute force below is the GROUND TRUTH: dead-simple, obviously correct, and the
// arbiter of what "valid" and "optimal" mean. It charges the marker with the SAME
// exported markerLen the gate emits, on synthetic-but-real absolute line numbers (so
// digit counts, and therefore marker widths, vary across trials). The DP must agree
// with it on the chosen NET removed (= fullSize − rendered) and the band verdict, and
// its own selection must itself be valid — feasible and infeasible inputs alike.

import { describe, it, expect } from 'vitest';

import { removalEngine, selectDropsToBand, markerLen } from '../../src/removal.js';
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

// ── Independent rendered/net accounting (NOT borrowed from the DP) ────────────────
// netOf: the NET chars an arrangement removes — dropped content MINUS the chars each
// maximal gap's `[TRUNCATED: lines a-b]` marker adds, charged ONCE per gap from its
// REAL boundary line numbers via the SAME exported markerLen the gate emits. This is
// the brute force's own arithmetic; the DP must reproduce its result, not be asked.
function netOf(drop: readonly boolean[], weights: readonly number[], lines: readonly number[]): number {
  const n = drop.length;
  let droppedContent = 0;
  let markerChars = 0;
  let i = 0;
  while (i < n) {
    if (drop[i] === true) {
      const start = i;
      let end = i;
      while (i < n && drop[i] === true) {
        droppedContent += weights[i] ?? 0;
        end = i;
        i++;
      }
      markerChars += markerLen(lines[start] ?? 0, lines[end] ?? 0); // one marker per gap
    } else i++;
  }
  return droppedContent - markerChars;
}

// ── The selection rule (identical for ground truth and DP) ───────────────────────
// In-band: the SMALLEST reachable net in [netMin,netMax] (gentlest). Infeasible: the
// net NEAREST the band, smaller net breaking ties. net=0 (drop-nothing) is always
// reachable. Net can be negative (a 6-line run of light lines can cost more marker
// than the content it removes) — the rule handles that uniformly.
function chooseNet(reachable: readonly number[], netMin: number, netMax: number): { net: number; bandSatisfied: boolean } {
  const inBand = reachable.filter((r) => r >= netMin && r <= netMax);
  if (inBand.length > 0) return { net: Math.min(...inBand), bandSatisfied: true };
  let bestNet = Infinity;
  let bestDist = Infinity;
  for (const r of [...reachable].sort((a, b) => a - b)) {
    const dist = r < netMin ? netMin - r : r > netMax ? r - netMax : 0;
    if (dist < bestDist) {
      bestDist = dist;
      bestNet = r;
    }
  }
  return { net: bestNet, bandSatisfied: false };
}

// Exhaustively enumerate all 2^n arrangements, keep the structurally valid ones, and
// return the sorted set of achievable NET-removed totals (always includes 0 —
// drop-nothing is always valid).
function enumerateReachableNets(
  weights: readonly number[],
  lines: readonly number[],
  eligible: readonly boolean[],
): number[] {
  const n = weights.length;
  const reachable = new Set<number>();
  for (let mask = 0; mask < 1 << n; mask++) {
    const drop: boolean[] = new Array(n);
    for (let i = 0; i < n; i++) drop[i] = (mask & (1 << i)) !== 0;
    if (!runsValid(drop, eligible)) continue;
    reachable.add(netOf(drop, weights, lines));
  }
  return [...reachable].sort((a, b) => a - b);
}

describe('Phase 8 (5B.1) — the selection DP is provably optimal on rendered size (with markers)', () => {
  it('matches the brute-force optimum on every random trial, and respects every rule', () => {
    const rng = mulberry32(0x5b_1001);
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
    let markerOncePerGap = true;

    for (let t = 0; t < TRIALS; t++) {
      // n small enough for exhaustive 2^n enumeration; spans below and above the
      // 6-line run thresholds (so both "can form a run" and "cannot" arise).
      const n = 1 + Math.floor(rng() * 14); // 1..14
      const weights: number[] = new Array(n);
      const eligible: boolean[] = new Array(n);
      const lines: number[] = new Array(n);
      // Vary the absolute line numbers per trial so marker WIDTHS vary: 1-digit,
      // 2->3-digit (crossing 99->100), and 4-digit line numbers all get exercised,
      // proving the per-boundary digit charging is correct for any digit count.
      const base = t % 3 === 0 ? 1 : t % 3 === 1 ? 95 : 1180;
      for (let i = 0; i < n; i++) {
        weights[i] = 1 + Math.floor(rng() * 9); // 1..9
        eligible[i] = rng() < 0.6;
        lines[i] = base + i;
      }
      // Build the ground-truth reachable NET set once, then choose a band. ~60% of
      // the time bias it to be FEASIBLE (a band straddling a real reachable net —
      // often several, so the gentlest-min-net choice is genuinely tested); the rest
      // are fully random (frequently infeasible, exercising forced-nearest).
      const reachable = enumerateReachableNets(weights, lines, eligible);
      let netMin: number;
      let netMax: number;
      if (rng() < 0.6 && reachable.length > 0) {
        const target = reachable[Math.floor(rng() * reachable.length)] ?? 0;
        netMin = target - Math.floor(rng() * 4); // target itself is in-band -> feasible
        netMax = target + Math.floor(rng() * 4);
      } else {
        const lo = (reachable[0] ?? 0) - 3;
        const hi = (reachable[reachable.length - 1] ?? 0) + 3;
        const a = lo + Math.floor(rng() * (hi - lo + 1));
        const b = lo + Math.floor(rng() * (hi - lo + 1));
        netMin = Math.min(a, b);
        netMax = Math.max(a, b);
      }

      const brute = chooseNet(reachable, netMin, netMax);
      const dp = selectDropsToBand(weights, lines, eligible, netMin, netMax);

      // (1) The DP's own selection must be structurally valid.
      const dpValid = runsValid(dp.drop, eligible);
      // (2) Same chosen NET removed and same band verdict as the optimum.
      const sameNet = dp.netRemoved === brute.net;
      const sameBand = dp.bandSatisfied === brute.bandSatisfied;
      // (3) The DP's reported net equals the net independently recomputed from its own
      //     mask (markers charged once per gap, from real boundary lines).
      const dpNetIndependent = netOf(dp.drop, weights, lines);
      const consistentNet = dpNetIndependent === dp.netRemoved;
      if (dpValid && sameNet && sameBand && consistentNet) matches++;
      if (!consistentNet) markerOncePerGap = false;

      // Determinism: identical inputs -> identical selection.
      const dp2 = selectDropsToBand(weights, lines, eligible, netMin, netMax);
      if (dp2.drop.length !== dp.drop.length || dp2.netRemoved !== dp.netRemoved) deterministic = false;
      else for (let i = 0; i < n; i++) if (dp2.drop[i] !== dp.drop[i]) deterministic = false;

      // Eligibility: no dropped line was ineligible.
      for (let i = 0; i < n; i++) if (dp.drop[i] === true && eligible[i] !== true) eligibilityRespected = false;

      // Run rules.
      if (!droppedRunsAllGE6(dp.drop)) droppedRuns6 = false;
      if (!interiorKeptRunsAllGE6(dp.drop)) interiorKept6 = false;

      // Lands in band (net in [netMin,netMax] <=> rendered in [LO,keptCeiling])
      // whenever a valid in-band arrangement exists.
      if (brute.bandSatisfied) {
        feasibleTrials++;
        if (!dp.bandSatisfied || dp.netRemoved < netMin || dp.netRemoved > netMax) landsInBandWhenFeasible = false;
      } else {
        infeasibleTrials++;
      }
    }

    console.log(`DP matches brute-force optimum (rendered, with markers): ${matches === TRIALS} (over ${TRIALS} trials)`);
    console.log(`  (feasible trials: ${feasibleTrials}, infeasible trials: ${infeasibleTrials})`);
    console.log(`deterministic: ${deterministic}`);
    console.log(`eligibility respected: ${eligibilityRespected}`);
    console.log(`dropped runs >= 6: ${droppedRuns6}`);
    console.log(`interior kept runs >= 6: ${interiorKept6}`);
    console.log(`rendered lands in band when feasible: ${landsInBandWhenFeasible}`);
    console.log(`marker cost charged once per gap (not per line): ${markerOncePerGap}`);

    expect(matches, 'DP reproduces the brute-force optimum on every trial').toBe(TRIALS);
    expect(deterministic, 'identical input yields identical selection').toBe(true);
    expect(eligibilityRespected, 'only eligible lines are ever dropped').toBe(true);
    expect(droppedRuns6, 'every maximal dropped run is >= 6 lines').toBe(true);
    expect(interiorKept6, 'every interior kept run is >= 6 lines').toBe(true);
    expect(landsInBandWhenFeasible, 'lands in band whenever a valid in-band arrangement exists').toBe(true);
    expect(markerOncePerGap, 'marker cost is charged once per gap, not per line').toBe(true);
    // Sanity: the random bands actually exercised BOTH paths, not just one.
    expect(feasibleTrials, 'some trials were feasible').toBeGreaterThan(0);
    expect(infeasibleTrials, 'some trials were infeasible (forced-nearest exercised)').toBeGreaterThan(0);
  });

  it('gently compresses a real-ish file into the retention band, emitting a ranged marker (end-to-end sample)', () => {
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
      keptContent: number;
      renderedSize: number;
      bandSatisfied: boolean;
    };

    // Recompute the band the same way the gate does, for display + assertion.
    let fullSize = 0;
    for (const s of all) fullSize += s.replace(/^\s*\d+[.:]\s?/, '').length;
    const LO = Math.ceil(0.68 * fullSize);
    const HI = Math.floor(0.72 * fullSize);
    const keptCeiling = Math.min(HI, 100_000);

    console.log(
      `sample: fullSize=${fullSize}, band rendered=[${LO}..${keptCeiling}], ` +
        `renderedSize=${removal.renderedSize}, keptContent=${removal.keptContent}, ` +
        `dropped ${removal.dropped.size} lines, bandSatisfied=${removal.bandSatisfied}`,
    );

    // Gentle + in band: RENDERED size (kept content + markers) inside [LO, keptCeiling].
    expect(removal.bandSatisfied, 'sample lands inside the retention band').toBe(true);
    expect(removal.renderedSize).toBeGreaterThanOrEqual(LO);
    expect(removal.renderedSize).toBeLessThanOrEqual(keptCeiling);
    for (const ln of [1, 2, 3, 4, 38, 39, 40]) {
      expect(removal.dropped.has(ln), `protected line ${ln} must never be dropped`).toBe(false);
    }

    // Output carries a REAL ranged marker, FLUSH-LEFT (its own line, column 0, no
    // prefix, no '#'), and keeps protected lines verbatim.
    const output = out.output ?? '';
    const outLines = output.split('\n');
    const markerLines = outLines.filter((l) => /^\[TRUNCATED: lines \d+-\d+\]$/.test(l));
    console.log(`  marker line(s): ${JSON.stringify(markerLines)}`);
    expect(markerLines.length, 'output shows at least one ranged, flush-left marker').toBeGreaterThan(0);
    // No marker is the old bare placeholder, and none is indented.
    expect(output.includes('[TRUNCATED]'), 'no bare [TRUNCATED] placeholder remains').toBe(false);
    expect(/^[ \t]+\[TRUNCATED/m.test(output), 'no marker is indented').toBe(false);
    // Each marker reports a real range whose endpoints were actually dropped, and the
    // marker char count matches markerLen exactly (costed == emitted).
    for (const m of markerLines) {
      const match = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/.exec(m);
      expect(match, `marker "${m}" parses`).not.toBeNull();
      if (match) {
        const a = Number(match[1]);
        const b = Number(match[2]);
        expect(removal.dropped.has(a), `marker start line ${a} was dropped`).toBe(true);
        expect(removal.dropped.has(b), `marker end line ${b} was dropped`).toBe(true);
        expect(m.length, 'emitted marker length equals markerLen').toBe(markerLen(a, b));
      }
    }
    expect(output.includes(all[0] ?? ''), 'a protected line survives verbatim').toBe(true);
  });
});
