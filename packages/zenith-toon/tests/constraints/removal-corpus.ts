// removal-corpus.ts — co-located fixtures for the removal-engine production-path
// proofs (removal-fen-proofs / removal-scaling-proofs).
//
// These generators and accounting oracles were previously imported from the
// (now-deleted) `bench/` harness. The proofs they feed exercise the REAL exported
// engine (`removalEngine`, `selectDropsToBand`, `verifyOutput` in src/removal.ts),
// so they must keep running on their own — the bench dependency is gone, the proofs
// are not. The minimal faithful subset those two suites actually use is reproduced
// here verbatim so the inputs stay byte-identical and the determinism proofs remain
// meaningful.
//
// Nothing here reads a score, rank, or importance number. Every quantity is a char
// COUNT (a size) or the `eligible` boolean. `markerLen` is imported from the real
// engine so the marker cost the oracle charges is byte-identical to the one
// removalEngine emits.

import { markerLen } from '../../src/removal.js';

// ── Seeded PRNG ───────────────────────────────────────────────────────────────────────
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

// ── Synthetic corpus ────────────────────────────────────────────────────────────────────
export interface Case {
  readonly name: string;
  readonly rawPrefixed: string; // the `N. `-prefixed source that crosses the seam
  readonly charBudget: number;  // kept loose by default so the band drives, not the budget
}

const DEFAULT_BUDGET = 5_000_000;

/** Prefix raw source with `N. ` line numbers — identical to read_file's authority. */
export function prefixLines(raw: string): string {
  return raw
    .split('\n')
    .map((l, i) => `${i + 1}. ${l}`)
    .join('\n');
}

const BODIES_MIXED = [
  'const resolved = resolveCandidate(input, options, context);',
  'if (!resolved) return fallback;',
  'const scored = candidates.map((c) => scoreCandidate(c, weights));',
  'total += scored.reduce((a, b) => a + b.value, 0);',
  'for (const entry of entries) { acc.push(transform(entry)); }',
  'logger.debug(`processed ${entry.id} -> ${entry.state}`);',
  '// fold the accumulator back into the running window and re-rank',
  'export function step(state: State, input: Input): Result {',
  '  return { ...state, cursor: state.cursor + 1, dirty: true };',
  '}',
];
const BODIES_LIGHT = ['x++;', 'i--;', 'return;', '});', '}', 'else', 'break;', 'continue;', 'acc++;', ';'];
const BODIES_HEAVY = [
  'const merged = Object.assign({}, defaults, overrides, computeDerivedConfiguration(env, flags, profile), runtimePatches);',
  'await Promise.all(batches.map(async (b) => persistChunk(b, { retries: 3, backoffMs: 250, idempotencyKey: b.id })));',
];

function genBody(pool: readonly string[], rng: () => number): string {
  return pool[Math.floor(rng() * pool.length)] ?? 'noop();';
}

/** A synthetic file of `nLines` lines drawn from a body pool ('mixed'|'light'|'heavy'). */
export function syntheticCase(
  name: string,
  nLines: number,
  weight: 'mixed' | 'light' | 'heavy' = 'mixed',
  seed = 0xc0ffee,
  charBudget = DEFAULT_BUDGET,
): Case {
  const rng = mulberry32(seed ^ (nLines * 2654435761));
  const pool = weight === 'light' ? BODIES_LIGHT : weight === 'heavy' ? BODIES_HEAVY : BODIES_MIXED;
  const lines: string[] = [];
  for (let i = 0; i < nLines; i++) lines.push(genBody(pool, rng));
  return { name, rawPrefixed: prefixLines(lines.join('\n')), charBudget };
}

/** The size sweep that crosses the resource wall. baseline-dp BAILs above ~340 lines (mixed). */
export function sweepCases(
  sizes: readonly number[] = [60, 120, 200, 340, 420, 600, 800, 1000, 1250, 1500, 2000],
  weight: 'mixed' | 'light' | 'heavy' = 'mixed',
  charBudget = DEFAULT_BUDGET,
): Case[] {
  return sizes.map((n) => syntheticCase(`sweep:${weight}:${n}`, n, weight, 0xbeef, charBudget));
}

// ── Protection profiles: eligible[i] === true means line i+1 may be dropped ─────────────
export type Profile = (n: number, seed?: number) => boolean[];

/** Everything eligible — worst case for Rcap/netSpan; this is where the wall bites hardest. */
export const profileAll: Profile = (n) => new Array<boolean>(n).fill(true);

/** A few contiguous protected bands totalling ~30% — mimics a SageRank block core + BMX tail. */
export const profileClustered: Profile = (n, seed = 7) => {
  const rng = mulberry32((seed ^ n) >>> 0);
  const eligible = new Array<boolean>(n).fill(true);
  const target = Math.floor(n * 0.3);
  let protectedCount = 0;
  let guard = 0;
  while (protectedCount < target && guard++ < 1000) {
    const len = 4 + Math.floor(rng() * 12); // 4..15-line band
    const start = Math.floor(rng() * Math.max(1, n - len));
    for (let i = start; i < Math.min(n, start + len); i++) {
      if (eligible[i]) {
        eligible[i] = false;
        protectedCount++;
      }
    }
  }
  return eligible;
};

/** ~30% protected as scattered singletons — fragments eligibility so 6-line runs are scarce. */
export const profileSparse: Profile = (n, seed = 11) => {
  const rng = mulberry32((seed ^ n) >>> 0);
  return Array.from({ length: n }, () => rng() >= 0.3);
};

/** Closest to real cores: protected signature head + import block + a couple interior defs + tail. */
export const profileRealistic: Profile = (n) => {
  const eligible = new Array<boolean>(n).fill(true);
  const protect = (a: number, b: number): void => {
    for (let i = Math.max(0, a); i < Math.min(n, b); i++) eligible[i] = false;
  };
  protect(0, Math.min(8, Math.floor(n * 0.05)));         // signature/import head
  protect(Math.floor(n * 0.4), Math.floor(n * 0.45));    // a hot interior def
  protect(Math.floor(n * 0.7), Math.floor(n * 0.74));    // another
  protect(n - Math.max(3, Math.floor(n * 0.04)), n);     // tail (BMX-protected)
  return eligible;
};

export const PROFILES: Record<string, Profile> = {
  all: profileAll,
  clustered: profileClustered,
  sparse: profileSparse,
  realistic: profileRealistic,
};

// ── Independent structural-validity + net accounting (NOT borrowed from any selector) ───
export const STATES = 25; // the selection DP's fixed state count (mode×sawDrop×runIdx + START)

/**
 * Structural validity (the exact run rules the selection must enforce): drop only eligible
 * lines; every maximal dropped run >= 6; every INTERIOR kept run (a maximal kept run with a
 * gap on BOTH sides) >= 6.
 */
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

/**
 * netOf: NET chars an arrangement removes — dropped content MINUS the chars each maximal
 * gap's `[TRUNCATED: lines a-b]` marker adds, charged ONCE per gap from its REAL boundary
 * line numbers via the SAME markerLen the gate emits. Recomputed independently from the
 * candidate's own drop mask so it catches a selector that lies in its return struct
 * (verifyOutput catches lies in the output string).
 */
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
