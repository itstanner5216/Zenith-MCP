// bench/corpus.ts — the fixed, reproducible inputs every selector is run against.
//
// Two kinds of input:
//   • REAL source files (default: this package's own src/), prefixed `N. ` exactly as
//     read_file does, so weights/markers/verbatim checks see real-world line shapes.
//   • SYNTHETIC files for the size sweep and edge cases — the controlled inputs that expose
//     the resource wall (400–1250+ lines) and the nasty corners (tiny files, light lines whose
//     6-line marker costs more than the content it removes, files right at the ~340 cutoff).
//
// ELIGIBILITY IS A PROFILE, not a real ranking. The missions live at the selection seam, which
// sits AFTER the value-blind gate. Rather than run the real SageRank/BMX (which need the indexer
// and tiling), the harness feeds eligibility from a named, seeded profile that stands in for the
// gate's output. This is both reproducible and MORE rigorous: it tests selection under several
// protection distributions (all-eligible — where the wall is worst; clustered/realistic — like
// real cores; sparse — fragmenting eligibility so 6-line runs are hard to form). End-to-end
// validation through compressFile with real facts is a separate, final check (Round 7).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { mulberry32 } from './invariants.js';

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

// ── Real files ───────────────────────────────────────────────────────────────────────
/** Load every `.ts` file under the given dirs as a Case. Defaults to this package's src/. */
export function realCases(
  dirs: readonly string[] = [join(process.cwd(), 'src')],
  charBudget = DEFAULT_BUDGET,
): Case[] {
  const out: Case[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // dir absent — skip quietly
    }
    for (const ent of entries) {
      const p = join(dir, ent);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else if (ent.endsWith('.ts') && !ent.endsWith('.d.ts')) {
        const raw = readFileSync(p, 'utf8');
        if (raw.split('\n').length < 8) continue; // too tiny to be interesting
        out.push({ name: `real:${p}`, rawPrefixed: prefixLines(raw), charBudget });
      }
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

// ── Synthetic generators ───────────────────────────────────────────────────────────────
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
  seed = 0xC0FFEE,
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
  return sizes.map((n) => syntheticCase(`sweep:${weight}:${n}`, n, weight, 0xBEEF, charBudget));
}

/** Edge cases that break naive selectors. */
export function edgeCases(charBudget = DEFAULT_BUDGET): Case[] {
  return [
    syntheticCase('edge:tiny-3', 3, 'mixed', 1, charBudget), // < 6 lines: nothing can be dropped
    syntheticCase('edge:tiny-7', 7, 'mixed', 2, charBudget), // barely a single 6-run possible
    syntheticCase('edge:light-500', 500, 'light', 3, charBudget), // markers can cost > content (negative net)
    syntheticCase('edge:heavy-800', 800, 'heavy', 4, charBudget), // long lines, big Rcap -> big netSpan
    syntheticCase('edge:cutoff-340', 340, 'mixed', 5, charBudget), // right at the exact-DP cutoff
    syntheticCase('edge:cutoff-360', 360, 'mixed', 6, charBudget), // just over it
  ];
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
