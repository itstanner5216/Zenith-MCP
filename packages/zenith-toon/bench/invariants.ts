// bench/invariants.ts — the GROUND TRUTH the harness judges candidates against.
//
// These are lifted, near-verbatim, from tests/constraints/removal-dp-optimality.test.ts
// ON PURPOSE: that brute force is the project's own definition of "valid" and "optimal".
// Reusing it means the harness and the existing optimality proof agree by construction —
// a candidate the harness blesses is optimal under the EXACT rule the repo already trusts.
//
// Nothing here reads a score, rank, or importance number. Every quantity is a char COUNT
// (a size) or the `eligible` boolean. `markerLen` is imported from the real engine so the
// marker cost the harness charges is byte-identical to the one removalEngine emits.

import { markerLen } from '../src/removal.js';

export const STATES = 25; // the selection DP's fixed state count (mode×sawDrop×runIdx + START)

/** Digit count of an absolute line number — drives marker width, exactly as the engine does. */
export function digits(x: number): number {
  return String(x).length;
}

// ── Structural validity (the exact run rules the selection must enforce) ─────────────
// Drop only eligible lines; every maximal dropped run >= 6; every INTERIOR kept run
// (a maximal kept run with a gap on BOTH sides) >= 6.
export function runsValid(drop: readonly boolean[], eligible: readonly boolean[]): boolean {
  const n = drop.length;
  for (let i = 0; i < n; i++) {
    if (drop[i] === true && eligible[i] !== true) return false; // eligibility
  }
  return droppedRunsAllGE6(drop) && interiorKeptRunsAllGE6(drop);
}

export function droppedRunsAllGE6(drop: readonly boolean[]): boolean {
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

export function interiorKeptRunsAllGE6(drop: readonly boolean[]): boolean {
  const n = drop.length;
  let i = 0;
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

// ── Independent rendered/net accounting (NOT borrowed from any selector) ─────────────
// netOf: NET chars an arrangement removes — dropped content MINUS the chars each maximal
// gap's `[TRUNCATED: lines a-b]` marker adds, charged ONCE per gap from its REAL boundary
// line numbers via the SAME markerLen the gate emits. The harness recomputes this from the
// candidate's own drop mask and compares it to what the candidate REPORTED — catching a
// selector that lies in its return struct (verifyOutput catches lies in the output string).
export function netOf(
  drop: readonly boolean[],
  weights: readonly number[],
  lines: readonly number[],
): number {
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

// ── The selection rule (identical for ground truth and every candidate) ──────────────
// In-band: the SMALLEST reachable net in [netMin,netMax] (gentlest). Infeasible: the net
// NEAREST the band, smaller net breaking ties. net=0 (drop-nothing) is always reachable.
export function chooseNet(
  reachable: readonly number[],
  netMin: number,
  netMax: number,
): { net: number; bandSatisfied: boolean } {
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

// Exhaustively enumerate all 2^n arrangements (small n only), keep the structurally valid
// ones, return the sorted set of achievable NET-removed totals (always includes 0). This is
// the optimality oracle: the true optimum for a band is chooseNet(enumerate(...), ...).
export function enumerateReachableNets(
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

// ── The analytic memory signal that MOTIVATES Mission 2 ──────────────────────────────
// Replicates selectDropsToBand's exact table size: (n+1) × 25 × netSpan, with
// netSpan = Rcap + OFFSET + 1. This is what the 60M guard checks. The harness prints it for
// EVERY input so you can see exactly how far over the wall the exact DP would be on each file
// (and why the baseline BAILs past ~340 lines) — independent of what any candidate allocates.
export function exactDpCells(
  weights: readonly number[],
  lines: readonly number[],
  eligible: readonly boolean[],
): { cells: number; netSpan: number; Rcap: number } {
  const n = weights.length;
  if (n === 0) return { cells: 0, netSpan: 1, Rcap: 0 };
  const markerFixed = markerLen(0, 0) - digits(0) - digits(0);
  let Rcap = 0;
  let maxLine = 0;
  for (let i = 0; i < n; i++) {
    if (eligible[i] === true) Rcap += weights[i] ?? 0;
    const li = lines[i] ?? 0;
    if (li > maxLine) maxLine = li;
  }
  const maxGaps = Math.floor(n / 6) + 1;
  const markerMax = markerFixed + 2 * digits(maxLine);
  const OFFSET = maxGaps * markerMax;
  const netSpan = Rcap + OFFSET + 1;
  return { cells: (n + 1) * STATES * netSpan, netSpan, Rcap };
}

export const MAX_CELLS = 60_000_000; // the production resource-guard threshold

/** A tiny seeded PRNG so every corpus + trial is reproducible (a failing seed stays recoverable). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
