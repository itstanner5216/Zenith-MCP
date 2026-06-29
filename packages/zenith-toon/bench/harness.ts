// bench/harness.ts — evaluate ONE selector on ONE (case × profile). The trust core.
//
// Flow, mirroring the production gate exactly where it matters:
//   1. Derive weights / lines / eligibility from the case + profile.
//   2. Compute the band the SAME way removalEngine does (LO/HI/keptCeiling/netMin/netMax).
//   3. Time the candidate. A throw is classified: the 60M resource-guard message => 'bailed'
//      (the real degrade-to-raw path); anything else => 'error'.
//   4. Render the candidate's drop[] into output EXACTLY like removalEngine step (6).
//   5. Hand (originalSource, output, meta, budget) to the PRODUCTION verifyOutput. Any throw =>
//      'invalid' with the H-code reason. The candidate cannot pass by lying in its output.
//   6. Independently recompute net (vs the candidate's reported net), validity, retention,
//      determinism, and the would-be exact-DP cell count.
//
// The candidate returns only drop[] + a self-report; the harness derives every headline number
// itself. That is the whole point: "beats the DP" is measured here, not asserted by an agent.

import { performance } from 'node:perf_hooks';

import { verifyOutput, markerLen, type RemovalMetadata } from '../src/removal.js';
import {
  netOf,
  runsValid,
  droppedRunsAllGE6,
  interiorKeptRunsAllGE6,
  exactDpCells,
} from './invariants.js';
import type { Selector } from './selectors.js';
import type { Case, Profile } from './corpus.js';

export type Status = 'in-band' | 'infeasible' | 'invalid' | 'bailed' | 'error';

export interface Row {
  selector: string;
  case: string;
  profile: string;
  n: number;
  fullSize: number;
  status: Status;
  verifyOk: boolean;
  verifyError: string | null;
  valid: boolean;             // independent structural check (redundant with verifyOutput, kept explicit)
  droppedRuns6: boolean;
  interiorKept6: boolean;
  selfReportConsistent: boolean; // candidate's reported net & bandSatisfied match the harness recompute
  deterministic: boolean;
  bandSatisfied: boolean;
  retentionPct: number;       // renderedSize / fullSize × 100
  netRemoved: number;
  droppedLines: number;
  gapCount: number;
  timeMs: number;
  exactDpCells: number;       // (n+1)×25×netSpan the exact DP WOULD allocate — the wall, for every input
  exactDpNetSpan: number;
  overWall: boolean;          // exactDpCells > 60M (why baseline-dp bails here)
  output: string;             // rendered output, used for no-regression diffing (stripped from the JSON)
}

const stripPrefix = (s: string): string => s.replace(/^\s*\d+[.:]\s?/, '');
const GUARD_MSG = 'exceeds the exact-DP size bound';

export function evaluate(selectorName: string, selector: Selector, c: Case, profileName: string, profile: Profile): Row {
  const texts = c.rawPrefixed.split('\n');
  const n = texts.length;
  const lines: number[] = new Array(n);
  const weights: number[] = new Array(n);
  let fullSize = 0;
  for (let i = 0; i < n; i++) {
    lines[i] = i + 1;
    const w = stripPrefix(texts[i] ?? '').length;
    weights[i] = w;
    fullSize += w;
  }
  const eligibleArr = profile(n);

  // Band — identical arithmetic to removalEngine.
  const LO = Math.ceil(0.68 * fullSize);
  const HI = Math.floor(0.72 * fullSize);
  const keptCeiling = Math.min(HI, c.charBudget);
  const netMin = fullSize - keptCeiling;
  const netMax = fullSize - LO;

  const cells = exactDpCells(weights, lines, eligibleArr);
  const baseRow = {
    selector: selectorName,
    case: c.name,
    profile: profileName,
    n,
    fullSize,
    exactDpCells: cells.cells,
    exactDpNetSpan: cells.netSpan,
    overWall: cells.cells > 60_000_000,
  };

  // ── Run the candidate (timed, guarded) ──────────────────────────────────────────────
  const t0 = performance.now();
  let sel;
  try {
    sel = selector(weights, lines, eligibleArr, netMin, netMax);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status: Status = msg.includes(GUARD_MSG) ? 'bailed' : 'error';
    return {
      ...baseRow,
      status,
      verifyOk: false,
      verifyError: msg,
      valid: false,
      droppedRuns6: false,
      interiorKept6: false,
      selfReportConsistent: false,
      deterministic: false,
      bandSatisfied: false,
      retentionPct: 100,
      netRemoved: 0,
      droppedLines: 0,
      gapCount: 0,
      timeMs: performance.now() - t0,
      output: '',
    };
  }
  const timeMs = performance.now() - t0;
  const drop = sel.drop;

  // ── Render exactly like removalEngine step (6) ──────────────────────────────────────
  const dropped = new Set<number>();
  let keptContent = 0;
  let markerTotal = 0;
  let gapCount = 0;
  const parts: string[] = [];
  let idx = 0;
  while (idx < n) {
    if (drop[idx] === true) {
      const runStart = idx;
      let runEnd = idx;
      while (idx < n && drop[idx] === true) {
        dropped.add(lines[idx] ?? 0);
        runEnd = idx;
        idx++;
      }
      const a = lines[runStart] ?? 0;
      const b = lines[runEnd] ?? 0;
      parts.push(`[TRUNCATED: lines ${a}-${b}]`);
      markerTotal += markerLen(a, b);
      gapCount++;
    } else {
      parts.push(texts[idx] ?? '');
      keptContent += weights[idx] ?? 0;
      idx++;
    }
  }
  const output = parts.join('\n');
  const renderedSize = keptContent + markerTotal;
  const inBand = renderedSize >= LO && renderedSize <= keptCeiling;

  // Eligibility map keyed by absolute line, as the gate publishes it.
  const eligibleMap = new Map<number, boolean>();
  for (let i = 0; i < n; i++) eligibleMap.set(i + 1, eligibleArr[i] === true);

  const meta: RemovalMetadata = {
    eligible: eligibleMap,
    dropped,
    keptContent,
    renderedSize,
    bandSatisfied: inBand, // set to the truth so verifyOutput H6 validates structure, not a mis-flag
  };

  // ── Production trust oracle ──────────────────────────────────────────────────────────
  let verifyOk = true;
  let verifyError: string | null = null;
  try {
    verifyOutput(c.rawPrefixed, output, meta, c.charBudget);
  } catch (err) {
    verifyOk = false;
    verifyError = err instanceof Error ? err.message : String(err);
  }

  // ── Independent recomputation & cross-checks ────────────────────────────────────────
  const valid = runsValid(drop, eligibleArr);
  const droppedRuns6 = droppedRunsAllGE6(drop);
  const interiorKept6 = interiorKeptRunsAllGE6(drop);
  const harnessNet = netOf(drop, weights, lines);
  const selfReportConsistent = harnessNet === sel.netRemoved && sel.bandSatisfied === inBand;

  // Determinism: identical inputs -> identical selection.
  let deterministic = true;
  try {
    const sel2 = selector(weights, lines, eligibleArr, netMin, netMax);
    if (sel2.drop.length !== drop.length || sel2.netRemoved !== sel.netRemoved) deterministic = false;
    else for (let i = 0; i < n; i++) if (sel2.drop[i] !== drop[i]) { deterministic = false; break; }
  } catch {
    deterministic = false;
  }

  const status: Status = !verifyOk || !valid ? 'invalid' : inBand ? 'in-band' : 'infeasible';

  return {
    ...baseRow,
    status,
    verifyOk,
    verifyError,
    valid,
    droppedRuns6,
    interiorKept6,
    selfReportConsistent,
    deterministic,
    bandSatisfied: inBand,
    retentionPct: fullSize > 0 ? (renderedSize / fullSize) * 100 : 100,
    netRemoved: harnessNet,
    droppedLines: dropped.size,
    gapCount,
    timeMs,
    output,
  };
}
