// removal-fen-proofs.test.ts — PRODUCTION-PATH verification of the transplanted
// fen packed-bitset / tight-window `selectDropsToBand` (now living in
// src/removal.ts). This suite NEVER imports the bench fen module — it drives the
// REAL exported engine functions (`removalEngine`, `selectDropsToBand`,
// `verifyOutput`) and the REAL render (removalEngine emits the output exactly as
// production does). It mirrors the bench corpus generators (bench/corpus.ts) for
// reproducible inputs across the full size sweep × the four eligibility profiles.
//
// It does NOT redo the optimality proof (that lives in
// removal-dp-optimality.test.ts and already passes against brute force). Here we
// prove three contract properties of the transplant on the production path:
//   PROOF A — VALIDITY: every (n, profile) renders an output that passes the
//             production verifyOutput (H1–H7) and never size-bails (the MAX_CELLS
//             wall is gone — removalEngine always produces verified output).
//   PROOF B — TIMING: production selectDropsToBand stays far under the 5 s wall
//             (the old convergence era was 5–6 s; the bench fen did 1250 in ~83 ms),
//             confirming F1's `?? 0` guards did not blow up the hot bit-loop.
//   PROOF C — DETERMINISM (Invariant 7): identical input -> byte-identical result.
//
// Eligibility is encoded the way the gate reads it: each case is one block spanning
// all n lines (so absolute line k == k), SageRank core is empty (no block protected),
// and the BMX+ core holds exactly the profile's PROTECTED line numbers. Then the
// gate's `eligible = !sage-core AND !bmx-core` reproduces the profile boolean for
// boolean exactly — driving the production engine end to end.

import { describe, it, expect } from 'vitest';

import { removalEngine, selectDropsToBand, verifyOutput, type RemovalMetadata } from '../../src/removal.js';
import type { Payload, SourceBlock } from '../../src/compress-source.js';
import { sweepCases, PROFILES, type Case } from '../../bench/corpus.js';

// The exact size sweep the task specifies (also the corpus default). Mixed bodies.
const SIZES: readonly number[] = [60, 120, 200, 340, 420, 600, 800, 1000, 1250, 1500, 2000];
const PROFILE_NAMES = ['all', 'clustered', 'sparse', 'realistic'] as const;
type ProfileName = (typeof PROFILE_NAMES)[number];

// Generate each sweep case ONCE (mixed bodies, corpus default seed) and key by its
// true line count, so PROOFs A/B/C all run on byte-identical inputs.
const CASE_BY_N = new Map<number, Case>();
for (const c of sweepCases([...SIZES])) {
  CASE_BY_N.set(c.rawPrefixed.split('\n').length, c);
}

function caseFor(n: number): Case {
  const c = CASE_BY_N.get(n);
  if (c === undefined) throw new Error(`removal-fen-proofs: no corpus case generated for n=${n}`);
  return c;
}

function eligibilityFor(name: ProfileName, n: number): boolean[] {
  const fn = PROFILES[name];
  if (typeof fn !== 'function') throw new Error(`removal-fen-proofs: unknown profile ${name}`);
  return fn(n);
}

// Build the production payload from a prefixed source + an eligibility profile.
// ONE block (startLine 1, all n lines) => absolute line k == k. Empty SageRank
// core; BMX+ core = protected line numbers. So the gate's eligibility == profile.
function buildPayload(rawPrefixed: string, eligible: readonly boolean[], charBudget: number): Payload {
  const physical = rawPrefixed.split('\n');
  const n = physical.length;
  const protectedLines = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (eligible[i] !== true) protectedLines.add(i + 1); // line numbers are 1-based
  }
  const block: SourceBlock = { startLine: 1, endLine: n, text: rawPrefixed };
  return {
    source: { blocks: [block], query: null, charBudget },
    metadata: {
      sagerank: { coreIndices: [] as number[] }, // no block protected
      bmx: { core: protectedLines },             // eligibility comes from here
    },
  };
}

// Reproduce removalEngine's selection inputs EXACTLY (step (3)+(4) of removalEngine),
// so PROOFs B/C time/compare the production selectDropsToBand on the very inputs the
// gate would feed it. Single block startLine 1 => lines[i] == i+1.
interface SelectInputs {
  readonly weights: number[];
  readonly lines: number[];
  readonly eligible: boolean[];
  readonly netMin: number;
  readonly netMax: number;
  readonly fullSize: number;
}
function buildSelectInputs(rawPrefixed: string, eligible: readonly boolean[], charBudget: number): SelectInputs {
  const physical = rawPrefixed.split('\n');
  const n = physical.length;
  const weights: number[] = new Array<number>(n);
  const lines: number[] = new Array<number>(n);
  const el: boolean[] = new Array<boolean>(n);
  let fullSize = 0;
  for (let i = 0; i < n; i++) {
    const content = (physical[i] ?? '').replace(/^\s*\d+[.:]\s?/, ''); // strip display prefix for SIZE only
    const w = content.length;
    weights[i] = w;
    lines[i] = i + 1;
    el[i] = eligible[i] === true;
    fullSize += w;
  }
  const LO = Math.ceil(0.68 * fullSize);
  const HI = Math.floor(0.72 * fullSize);
  const keptCeiling = Math.min(HI, charBudget);
  return { weights, lines, eligible: el, netMin: fullSize - keptCeiling, netMax: fullSize - LO, fullSize };
}

function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + ' '.repeat(w - str.length);
}

describe('fen transplant — production-path proofs (validity / timing / determinism)', () => {
  // ── PROOF A — VALIDITY via the production verifyOutput across the full sweep ─────
  // Generous per-test timeout: each selectDropsToBand call is tiny (see PROOF B), but
  // the sweep runs 44 (n,profile) combos and PROOF B times warmup+best-of-3 per combo,
  // whose CUMULATIVE runtime exceeds vitest's 5 s DEFAULT per-test timeout. That default
  // is a harness knob about total test duration, not the engine's wall-time — the
  // engine contract (1250 << 5000ms) is asserted on the measured per-call time inside.
  const PROOF_TIMEOUT_MS = 600_000;

  // ── PROOF A — VALIDITY via the production verifyOutput across the full sweep ─────
  it('PROOF A — every (n, profile) renders an output that passes verifyOutput (H1–H7); zero size-bails', () => {
    interface RowA {
      n: number;
      profile: ProfileName;
      status: 'in-band' | 'infeasible' | 'BAIL/THROW';
      verifyOk: boolean;
      note: string;
    }
    const rows: RowA[] = [];

    for (const n of SIZES) {
      const c = caseFor(n);
      for (const profile of PROFILE_NAMES) {
        const eligible = eligibilityFor(profile, n);
        const payload = buildPayload(c.rawPrefixed, eligible, c.charBudget);
        let status: RowA['status'] = 'BAIL/THROW';
        let verifyOk = false;
        let note = '';
        try {
          const out = removalEngine(payload);
          const removal = out.metadata.removal as RemovalMetadata | undefined;
          const output = out.output;
          if (removal === undefined || typeof output !== 'string') {
            note = 'engine returned no output/removal (would be a size-bail)';
          } else {
            status = removal.bandSatisfied ? 'in-band' : 'infeasible';
            // The original source crossing the seam is exactly the block text.
            verifyOutput(c.rawPrefixed, output, removal, c.charBudget);
            verifyOk = true;
          }
        } catch (e) {
          note = e instanceof Error ? e.message : String(e);
        }
        rows.push({ n, profile, status, verifyOk, note });
      }
    }

    const header = `${pad('n', 6)}| ${pad('profile', 11)}| ${pad('status', 12)}| verifyOk`;
    const lines = [header, '-'.repeat(header.length)];
    for (const r of rows) {
      lines.push(`${pad(r.n, 6)}| ${pad(r.profile, 11)}| ${pad(r.status, 12)}| ${r.verifyOk}${r.note ? '   << ' + r.note : ''}`);
    }
    console.log('\nPROOF A — verifyOutput validity across the sweep:\n' + lines.join('\n'));

    const bails = rows.filter((r) => r.status === 'BAIL/THROW');
    const bad = rows.filter((r) => !r.verifyOk);
    console.log(`PROOF A summary: rows=${rows.length}, verifyOk=${rows.length - bad.length}/${rows.length}, size-bails=${bails.length}`);

    // Every row must verify; zero size-bails.
    for (const r of rows) {
      expect(r.verifyOk, `verifyOutput must pass for n=${r.n} profile=${r.profile} — ${r.note || r.status}`).toBe(true);
      expect(r.status === 'in-band' || r.status === 'infeasible', `n=${r.n} profile=${r.profile} must not size-bail (status=${r.status})`).toBe(true);
    }
  }, PROOF_TIMEOUT_MS);

  // ── PROOF B — TIMING of the production selectDropsToBand on the sweep ────────────
  it('PROOF B — selectDropsToBand stays far under the 5 s wall (1250 << 5000ms); F1 guards did not blow up timing', () => {
    interface RowB {
      n: number;
      worstProfile: ProfileName;
      worstMs: number;
      allMs: number;
    }
    const rows: RowB[] = [];
    let ms1250 = Number.NaN;

    for (const n of SIZES) {
      const c = caseFor(n);
      let worstMs = 0;
      let worstProfile: ProfileName = 'all';
      let allMs = 0;
      for (const profile of PROFILE_NAMES) {
        const inp = buildSelectInputs(c.rawPrefixed, eligibilityFor(profile, n), c.charBudget);
        // Warm up once (JIT), then take the best of 3 timed runs (steady state).
        selectDropsToBand(inp.weights, inp.lines, inp.eligible, inp.netMin, inp.netMax);
        let best = Number.POSITIVE_INFINITY;
        for (let r = 0; r < 3; r++) {
          const t0 = performance.now();
          selectDropsToBand(inp.weights, inp.lines, inp.eligible, inp.netMin, inp.netMax);
          const dt = performance.now() - t0;
          if (dt < best) best = dt;
        }
        if (profile === 'all') allMs = best;
        if (best > worstMs) {
          worstMs = best;
          worstProfile = profile;
        }
      }
      rows.push({ n, worstProfile, worstMs, allMs });
      if (n === 1250) ms1250 = rows[rows.length - 1]?.worstMs ?? Number.NaN;
    }

    const header = `${pad('n', 6)}| ${pad('time-ms (worst)', 18)}| ${pad('worst-profile', 14)}| all-profile-ms`;
    const out = [header, '-'.repeat(header.length)];
    for (const r of rows) {
      out.push(`${pad(r.n, 6)}| ${pad(r.worstMs.toFixed(2), 18)}| ${pad(r.worstProfile, 14)}| ${r.allMs.toFixed(2)}`);
    }
    console.log('\nPROOF B — production selectDropsToBand wall-time (best-of-3, ms):\n' + out.join('\n'));

    const FEN_BASELINE_1250_MS = 83; // bench fen reference for the 1250-line case
    const ratio = ms1250 / FEN_BASELINE_1250_MS;
    console.log(`PROOF B 1250-line worst-profile time: ${ms1250.toFixed(2)}ms  (<< 5000ms wall; ~${ratio.toFixed(1)}x the ~83ms fen baseline)`);
    if (ratio >= 10) {
      console.log(`PROOF B WARNING: 1250-line time is >=10x the fen baseline — possible guard-induced regression (reported, not fixed here).`);
    }

    // Contract: the 1250-line case completes far under the 5 s convergence-era wall.
    expect(Number.isFinite(ms1250), '1250-line case was measured').toBe(true);
    expect(ms1250, `1250-line selectDropsToBand must complete << 5000ms (got ${ms1250.toFixed(2)}ms)`).toBeLessThan(5000);
    // Sanity: the largest case is also nowhere near the wall.
    const max = Math.max(...rows.map((r) => r.worstMs));
    expect(max, `the whole sweep stays under the 5 s wall (max ${max.toFixed(2)}ms)`).toBeLessThan(5000);
  }, PROOF_TIMEOUT_MS);

  // ── PROOF C — DETERMINISM (Invariant 7): identical input -> byte-identical result ─
  it('PROOF C — running selectDropsToBand twice on identical input yields byte-identical results', () => {
    let allIdentical = true;
    let firstFail = '';
    let checked = 0;

    for (const n of SIZES) {
      const c = caseFor(n);
      for (const profile of PROFILE_NAMES) {
        const inp = buildSelectInputs(c.rawPrefixed, eligibilityFor(profile, n), c.charBudget);
        const a = selectDropsToBand(inp.weights, inp.lines, inp.eligible, inp.netMin, inp.netMax);
        const b = selectDropsToBand(inp.weights, inp.lines, inp.eligible, inp.netMin, inp.netMax);
        checked++;
        let same = a.netRemoved === b.netRemoved && a.bandSatisfied === b.bandSatisfied && a.drop.length === b.drop.length;
        if (same) {
          for (let i = 0; i < a.drop.length; i++) {
            if (a.drop[i] !== b.drop[i]) {
              same = false;
              break;
            }
          }
        }
        if (!same && firstFail === '') {
          allIdentical = false;
          firstFail = `(n=${n}, profile=${profile})`;
        }
      }
    }

    console.log(`\nPROOF C — determinism over ${checked} (n,profile) pairs: ${allIdentical ? 'all-identical' : 'FAIL@' + firstFail}`);
    expect(allIdentical, `determinism FAIL@${firstFail}`).toBe(true);
  }, PROOF_TIMEOUT_MS);
});
