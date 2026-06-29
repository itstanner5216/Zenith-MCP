// bench/run.ts — orchestrate the matrix, print the scoreboards, write JSON for the ledger.
//
//   npx tsx bench/run.ts            (run from packages/zenith-toon)
//   BENCH_EXTRA_DIRS=/abs/dir1:/abs/dir2 npx tsx bench/run.ts   (add bigger real files)
//
// Prints three things and writes them all to bench/results/<timestamp>.json:
//   1. OPTIMALITY scoreboard (Mission 1 axis) — % of small inputs where each selector matches
//      the brute-force optimum, mean net gap, band-miss rate, determinism. baseline-dp is 100%/0
//      by construction; that is the bar a single-pass M1 must match.
//   2. SCALING / WALL table (Mission 2 axis) — per selector × file size: status, time, and the
//      exact-DP cell count (the 60M wall). baseline-dp BAILs above ~340 lines; an M2 winner must
//      stay in-band with bounded time across the whole sweep.
//   3. CORPUS rollup — validity %, in-band %, mean retention, mean time, bail count, over the
//      real + synthetic corpus, with every INVALID row dumped loudly (with its verify H-code).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  enumerateReachableNets,
  chooseNet,
  netOf,
  runsValid,
  mulberry32,
} from './invariants.js';
import { REGISTRY, type Selector } from './selectors.js';
import { realCases, sweepCases, edgeCases, PROFILES, type Case } from './corpus.js';
import { evaluate, type Row } from './harness.js';

// ── 1. Optimality micro-trials (parameterised copy of removal-dp-optimality.test.ts) ──
interface OptSummary {
  selector: string;
  validPct: number;
  matchedOptimumPct: number;
  bandMissWhenFeasiblePct: number;
  meanNetGap: number;
  deterministicPct: number;
}

function optimalityTrials(selectors: Record<string, Selector>, trials = 600): OptSummary[] {
  const summaries: OptSummary[] = [];
  for (const [name, selector] of Object.entries(selectors)) {
    const rng = mulberry32(0x5b_1001);
    let valid = 0;
    let matched = 0;
    let feasible = 0;
    let bandMiss = 0;
    let gapSum = 0;
    let gapCount = 0;
    let deterministic = 0;

    for (let t = 0; t < trials; t++) {
      const n = 1 + Math.floor(rng() * 14);
      const weights: number[] = new Array(n);
      const eligible: boolean[] = new Array(n);
      const lines: number[] = new Array(n);
      const base = t % 3 === 0 ? 1 : t % 3 === 1 ? 95 : 1180;
      for (let i = 0; i < n; i++) {
        weights[i] = 1 + Math.floor(rng() * 9);
        eligible[i] = rng() < 0.6;
        lines[i] = base + i;
      }
      const reachable = enumerateReachableNets(weights, lines, eligible);
      let netMin: number;
      let netMax: number;
      if (rng() < 0.6 && reachable.length > 0) {
        const target = reachable[Math.floor(rng() * reachable.length)] ?? 0;
        netMin = target - Math.floor(rng() * 4);
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
      let sel;
      try {
        sel = selector(weights, lines, eligible, netMin, netMax);
      } catch {
        continue; // a throw on a 14-line input is a real failure; counts against valid%
      }
      const isValid = runsValid(sel.drop, eligible);
      const selNet = netOf(sel.drop, weights, lines);
      if (isValid) valid++;
      if (isValid && selNet === brute.net && sel.bandSatisfied === brute.bandSatisfied) matched++;
      if (brute.bandSatisfied) {
        feasible++;
        if (isValid && !sel.bandSatisfied) bandMiss++;
        if (isValid && sel.bandSatisfied) {
          gapSum += selNet - brute.net; // >= 0; how much less gentle than optimal
          gapCount++;
        }
      }
      try {
        const sel2 = selector(weights, lines, eligible, netMin, netMax);
        let same = sel2.drop.length === sel.drop.length && sel2.netRemoved === sel.netRemoved;
        if (same) for (let i = 0; i < n; i++) if (sel2.drop[i] !== sel.drop[i]) { same = false; break; }
        if (same) deterministic++;
      } catch { /* not deterministic */ }
    }

    summaries.push({
      selector: name,
      validPct: (valid / trials) * 100,
      matchedOptimumPct: (matched / trials) * 100,
      bandMissWhenFeasiblePct: feasible > 0 ? (bandMiss / feasible) * 100 : 0,
      meanNetGap: gapCount > 0 ? gapSum / gapCount : 0,
      deterministicPct: (deterministic / trials) * 100,
    });
  }
  return summaries;
}

// ── Printing helpers ─────────────────────────────────────────────────────────────────
const pad = (s: unknown, w: number): string => String(s).padEnd(w);
const padL = (s: unknown, w: number): string => String(s).padStart(w);
const f1 = (x: number): string => x.toFixed(1);

function printOptimality(rows: OptSummary[]): void {
  console.log('\n=== MISSION 1 — OPTIMALITY (small inputs, vs brute-force optimum) ===');
  console.log(
    pad('selector', 22) + padL('valid%', 8) + padL('matchOpt%', 11) +
    padL('bandMiss%', 11) + padL('meanGap', 9) + padL('determ%', 9),
  );
  for (const r of rows) {
    console.log(
      pad(r.selector, 22) + padL(f1(r.validPct), 8) + padL(f1(r.matchedOptimumPct), 11) +
      padL(f1(r.bandMissWhenFeasiblePct), 11) + padL(f1(r.meanNetGap), 9) + padL(f1(r.deterministicPct), 9),
    );
  }
  console.log('  matchOpt% = exact gentlest-optimal selection. baseline-dp should be 100.0.');
  console.log('  meanGap   = avg extra net removed vs optimal when both land in band (0 = optimal).');
}

function printScaling(rows: Row[]): void {
  console.log('\n=== MISSION 2 — SCALING / RESOURCE WALL (profile=all) ===');
  const sizes = [...new Set(rows.map((r) => r.n))].sort((a, b) => a - b);
  const selectors = [...new Set(rows.map((r) => r.selector))];
  console.log(pad('lines', 8) + padL('exactDP-cells', 16) + padL('overWall', 10) + '   ' +
    selectors.map((s) => padL(s.slice(0, 18), 20)).join(''));
  for (const n of sizes) {
    const any = rows.find((r) => r.n === n);
    const cellsStr = any ? any.exactDpCells.toLocaleString() : '?';
    const wallStr = any ? (any.overWall ? 'YES' : 'no') : '?';
    let line = pad(n, 8) + padL(cellsStr, 16) + padL(wallStr, 10) + '   ';
    for (const s of selectors) {
      const r = rows.find((x) => x.n === n && x.selector === s);
      const cell = r ? `${r.status}/${f1(r.timeMs)}ms` : '-';
      line += padL(cell, 20);
    }
    console.log(line);
  }
  console.log('  cell = status/time. baseline-dp FAILS (bails → no compression) once exactDP-cells > 60M — that is the wall to break.');
}

function printRollup(rows: Row[]): void {
  console.log('\n=== CORPUS ROLLUP (real + synthetic, all profiles) ===');
  const selectors = [...new Set(rows.map((r) => r.selector))];
  console.log(
    pad('selector', 22) + padL('cases', 7) + padL('attempt', 9) + padL('valid%', 8) + padL('solved%', 9) +
    padL('meanRet%', 10) + padL('meanMs', 9) + padL('bailed', 8) + padL('badSelf', 9),
  );
  for (const s of selectors) {
    const rs = rows.filter((r) => r.selector === s);
    const considered = rs.filter((r) => r.status !== 'bailed' && r.status !== 'error'); // cases it actually attempted
    const valid = considered.filter((r) => r.valid && r.verifyOk).length;               // correct WHEN it ran
    const solved = rs.filter((r) => r.bandSatisfied).length;                             // in-band over ALL = delivery rate
    const bailed = rs.filter((r) => r.status === 'bailed').length;
    const badSelf = considered.filter((r) => !r.selfReportConsistent).length;
    const meanRet = considered.length ? considered.reduce((a, r) => a + r.retentionPct, 0) / considered.length : 0;
    const meanMs = rs.length ? rs.reduce((a, r) => a + r.timeMs, 0) / rs.length : 0;
    console.log(
      pad(s, 22) + padL(rs.length, 7) + padL(considered.length, 9) +
      padL(f1(considered.length ? (valid / considered.length) * 100 : 0), 8) +
      padL(f1((solved / rs.length) * 100), 9) + padL(f1(meanRet), 10) +
      padL(f1(meanMs), 9) + padL(bailed, 8) + padL(badSelf, 9),
    );
  }
  console.log('  solved% = in-band over ALL cases — THE bar. A bailed case is a FAILURE: the file gets no');
  console.log('  compression and degrades to raw — that is the Mission 2 disease, not acceptable. baseline-dp\'s');
  console.log('  bailed count is the number to drive to ZERO. valid% = correct when it ran (of attempted).');

  const invalid = rows.filter((r) => r.status === 'invalid' || r.status === 'error');
  if (invalid.length > 0) {
    console.log('\n--- INVALID / ERROR rows (loud) ---');
    for (const r of invalid.slice(0, 40)) {
      console.log(`  [${r.selector}] ${r.case} (${r.profile}, n=${r.n}): ${r.status} :: ${r.verifyError ?? 'structural'}`);
    }
    if (invalid.length > 40) console.log(`  ...and ${invalid.length - 40} more (see JSON).`);
  }
}

// ── No-regression vs baseline-dp ────────────────────────────────────────────────────
// On every case the current DP actually handles (status in-band), a shippable replacement must be at
// least as good: it must also land in band, and remove no MORE than the DP (net no larger = no less
// gentle). This is a correctness bar, not a direction — it says nothing about HOW to solve the
// problem, only that you may not regress files that already work.
function printRegression(rows: Row[]): void {
  const byKey = new Map<string, Row>();
  for (const r of rows) byKey.set(`${r.selector}|${r.case}|${r.profile}`, r);
  const selectors = [...new Set(rows.map((r) => r.selector))].filter((s) => s !== 'baseline-dp');
  if (selectors.length === 0) return;
  console.log('\n=== NO-REGRESSION vs baseline-dp (only on cases the DP already handles) ===');
  console.log(pad('selector', 22) + padL('handled', 9) + padL('qualityReg', 12) + padL('outputDiff', 12));
  for (const s of selectors) {
    let handled = 0;
    let qualityReg = 0;
    let outputDiff = 0;
    const examples: string[] = [];
    for (const r of rows) {
      if (r.selector !== s) continue;
      const base = byKey.get(`baseline-dp|${r.case}|${r.profile}`);
      if (!base || base.status !== 'in-band') continue; // only where the DP delivers a result
      handled++;
      const worse = !r.bandSatisfied || r.netRemoved > base.netRemoved; // missed band, or removed more
      if (worse) {
        qualityReg++;
        if (examples.length < 5) examples.push(`${r.case}(${r.profile})`);
      }
      if (r.output !== base.output) outputDiff++;
    }
    console.log(pad(s, 22) + padL(handled, 9) + padL(qualityReg, 12) + padL(outputDiff, 12));
    if (examples.length) console.log(`    quality regressions e.g.: ${examples.join(', ')}`);
  }
  console.log('  qualityReg = MUST be 0 to ship: on a file the DP handles, the candidate missed the band or removed more.');
  console.log('  outputDiff = informational: differs from the DP byte-for-byte (benign alt-optimum, or a real change).');
}

// ── Build the matrix ───────────────────────────────────────────────────────────────────
function main(): void {
  const selectors = REGISTRY;

  const extra = (process.env.BENCH_EXTRA_DIRS ?? '').split(':').filter(Boolean);
  const real = realCases([join(process.cwd(), 'src'), ...extra]);
  const sweepAll = sweepCases(); // mixed body, the canonical wall sweep
  const edges = edgeCases();

  // Matrix: real × {all, realistic}; sweep × {all}; edges × {all, realistic}.
  const matrix: Array<{ c: Case; profiles: string[] }> = [
    ...real.map((c) => ({ c, profiles: ['all', 'realistic'] })),
    ...sweepAll.map((c) => ({ c, profiles: ['all'] })),
    ...edges.map((c) => ({ c, profiles: ['all', 'realistic'] })),
  ];

  const rows: Row[] = [];
  for (const [name, selector] of Object.entries(selectors)) {
    for (const { c, profiles } of matrix) {
      for (const pName of profiles) {
        const profile = PROFILES[pName];
        if (!profile) continue;
        rows.push(evaluate(name, selector, c, pName, profile));
      }
    }
  }

  const optimality = optimalityTrials(selectors);
  const scalingRows = rows.filter((r) => r.case.startsWith('sweep:') && r.profile === 'all');

  printOptimality(optimality);
  printScaling(scalingRows);
  printRollup(rows);
  printRegression(rows);

  const outDir = join(process.cwd(), 'bench', 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(outDir, `${stamp}.json`);
  const slim = rows.map(({ output, ...rest }) => rest); // drop output bodies from the JSON
  writeFileSync(outPath, JSON.stringify({ optimality, rows: slim }, null, 2));
  console.log(`\nWrote ${rows.length} rows + optimality to ${outPath}`);
}

main();
