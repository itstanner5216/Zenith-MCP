// removal.ts — the REMOVAL GATE. The value-blind engine at the forward end of the
// chain (entry -> SageRank -> BMX+ -> Removal -> Render). It is the first engine
// that CAN drop lines, but it has NO ranking of its own and never invents one: it
// reads the two ranking engines' verdicts off the payload and decides exactly TWO
// things — which lines are even ELIGIBLE to be dropped, and (among the eligible)
// which to actually drop so the kept output lands in the retention band.
//
// THE GATE'S ONE RANKING RULE (eligibility):
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
// THE SELECTION (sub-stage 5B): given the eligibility partition and each line's
// CHARACTER WEIGHT (a size measurement — never an importance score), a dynamic
// program picks WHICH eligible lines to drop so that:
//   • kept content lands in the retention band [68%, 72%] of the file's content
//     size (also never exceeding the hard char budget);
//   • only eligible lines are ever dropped (protected lines are ALWAYS kept);
//   • every maximal dropped run is >= 6 lines (no marker is worth < 6 lines);
//   • every interior kept run (between two gaps) is >= 6 lines (no noise slivers);
//   • the compression is the GENTLEST legal one — it removes the LEAST it can while
//     still landing in the band.
// The DP is provably optimal (proven against brute force on small inputs); it reads
// ONLY the eligible booleans and the char counts — no score, weight, rank, or
// importance number ever enters it. Char COUNT is a size, not a ranking.
//
// FAIL LOUD, DEGRADE OUTSIDE: if either engine's verdict is missing or malformed
// the gate THROWS — it must never improvise a selection from half the evidence.
// That throw is contained at toon's own public boundary (index.ts `compressFile`),
// which degrades to "use raw content," so a real-time caller is never interrupted
// by a compression failure. Loud to the operator, invisible to the caller.
//
// SUB-STAGE 5B SCOPE: this builds the data contract, the eligibility partition, and
// the SELECTION DP. It replaces 5A's placeholder (full source) output with the kept
// lines in order, each maximal dropped run collapsed to a single minimal
// `[TRUNCATED]` token. The REAL `[TRUNCATED: X-Y]` marker formatting and the
// Phase-H line-fidelity verification are sub-stage 5D, as is wiring `compressFile`
// to actually RETURN this output (it still returns null for now — 5B proves the
// selection on the payload, it does not yet surface it to the caller).

import type { Payload } from './compress-source.js';

/**
 * The removal gate's determination — the `removal` metadata key it owns.
 *
 * `eligible` is the ELIGIBILITY PARTITION (5A): a strict boolean per ABSOLUTE line
 * number — `true` when BOTH ranking engines judged the line non-core (a removal
 * candidate), `false` when at least one engine protected it. Deliberately NOT a
 * number: no per-line importance, no blend, no ordering.
 *
 * The rest is the SELECTION (5B): `dropped` is the set of absolute line numbers the
 * DP actually removed; `keptSize` is the surviving content size in characters
 * (display prefixes excluded); `bandSatisfied` is true iff the kept size landed
 * inside the retention band (false when the input was infeasible and the gate fell
 * back to the legal selection nearest the band — never by relaxing a rule).
 * Defined and owned HERE; the render engine consumes it.
 */
export interface RemovalMetadata {
  readonly eligible: ReadonlyMap<number, boolean>;
  readonly dropped: ReadonlySet<number>;
  readonly keptSize: number;
  readonly bandSatisfied: boolean;
}

/**
 * The selection DP's result over a flat line array. `drop[i]` is true iff flat line
 * `i` is removed; `removed` is the total dropped char weight (R); `bandSatisfied`
 * is true iff R landed in the requested band. Returned by `selectDropsToBand` and
 * consumed inline by the gate to build its output and determination.
 */
export interface DropSelection {
  readonly drop: readonly boolean[];
  readonly removed: number;
  readonly bandSatisfied: boolean;
}

/**
 * The removal gate's core process. It (1) FAILS LOUD if either ranking engine's
 * verdict is missing/malformed — it cannot and must not gate on half the evidence;
 * (2) flattens blocks to absolute lines (IDENTICALLY to bmxEngine), projecting the
 * SageRank BLOCK core onto lines and reading the BMX+ LINE core; (3) computes the
 * boolean eligibility partition (protected = sage-core OR bmx-core; eligible =
 * neither) and each line's char weight; (4) computes the retention band and runs
 * the SELECTION DP to choose the gentlest legal set of eligible lines to drop;
 * (5) emits the kept lines verbatim with each dropped run collapsed to a single
 * `[TRUNCATED]` token, and records the selection as its own determination.
 *
 * It is the forward end of the chain: render is not built, so it calls no successor
 * and simply returns the payload. Line identity is always block.startLine + offset,
 * carried verbatim — never recomputed, and a kept line's text is never altered.
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
  //    for output — never mutated, never recomputed). ─────────────────────────────
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

  // ── (3) ELIGIBILITY PARTITION + per-line CHAR WEIGHT, in one pass over the flat
  //    lines. Eligibility: a line is eligible ONLY if NEITHER engine protected it
  //    (equal co-vetoes, ANDed — no blend; the value is a strict boolean). Weight:
  //    the content char length with the display "N. " prefix stripped (the prefix
  //    is presentation, not content) — a SIZE COUNT, never an importance score.
  //    `eligible` (line-keyed, the gate's published partition) and the parallel
  //    flat-order arrays `weights`/`eligibleArr` (the DP's inputs) are built
  //    together so they can never drift. fullSize = Σ weight over ALL lines. ───────
  const eligible = new Map<number, boolean>();
  const weights: number[] = new Array(flat.length);
  const eligibleArr: boolean[] = new Array(flat.length);
  let fullSize = 0;
  for (let fi = 0; fi < flat.length; fi++) {
    const f = flat[fi];
    if (f === undefined) {
      // Rule 6 guard; flat is densely populated so this never trips in practice.
      weights[fi] = 0;
      eligibleArr[fi] = false;
      continue;
    }
    const content = f.text.replace(/^\s*\d+[.:]\s?/, ''); // strip display prefix for SIZE only
    const w = content.length;
    weights[fi] = w;
    fullSize += w;
    const protectedBySage = sageCoreBlocks.has(f.blockIndex); // its block is core
    const protectedByBmx = bmxCoreLines.has(f.line);          // its line is core
    const isEligible = !protectedBySage && !protectedByBmx;
    eligibleArr[fi] = isEligible;
    eligible.set(f.line, isEligible);
  }

  // ── (4) RETENTION BAND. Kept content must land in [68%, 72%] of fullSize, and
  //    must also never exceed the hard char budget. Work in REMOVED chars:
  //      keptCeiling = min(HI, charBudget)   // tighter of the band top and budget
  //      R_min = fullSize - keptCeiling      // remove at least this much
  //      R_max = fullSize - LO               // remove at most this much
  //    (LO <= HI <= fullSize, so R_min/R_max are >= 0. For a non-trivial file
  //    R_min > 0: keeping 100% is far above the 72% ceiling, so the gate must drop
  //    to enter the band — "drop nothing" is in-band only for an empty file.) ───────
  const LO = Math.ceil(0.68 * fullSize);
  const HI = Math.floor(0.72 * fullSize);
  const keptCeiling = Math.min(HI, payload.source.charBudget);
  const rMin = fullSize - keptCeiling;
  const rMax = fullSize - LO;

  // ── (5) SELECTION — the gentlest legal set of eligible lines to drop. ──────────
  const sel = selectDropsToBand(weights, eligibleArr, rMin, rMax);

  // ── (6) OUTPUT (5B-level) + the gate's determination. Walk the lines in order:
  //    a kept line emits its ORIGINAL prefixed text verbatim; each MAXIMAL dropped
  //    run emits a single `[TRUNCATED]` token (the real `[TRUNCATED: X-Y]` marker
  //    is sub-stage 5D). Marker emission is INLINE here by design (Rule 11). ───────
  const droppedLines = new Set<number>();
  let removed = 0;
  const parts: string[] = [];
  let idx = 0;
  while (idx < flat.length) {
    const f = flat[idx];
    if (f === undefined) {
      idx++;
      continue;
    }
    if (sel.drop[idx] === true) {
      // Collapse the whole maximal dropped run into one token.
      while (idx < flat.length && sel.drop[idx] === true) {
        const g = flat[idx];
        if (g !== undefined) {
          droppedLines.add(g.line);
          removed += weights[idx] ?? 0;
        }
        idx++;
      }
      parts.push('[TRUNCATED]');
    } else {
      parts.push(f.text); // verbatim, prefix intact — never altered, never renumbered
      idx++;
    }
  }

  const determination: RemovalMetadata = {
    eligible,
    dropped: droppedLines,
    keptSize: fullSize - removed,
    bandSatisfied: sel.bandSatisfied,
  };
  payload.metadata.removal = determination;
  payload.output = parts.join('\n');

  // Forward end of the chain: render is not built yet, so call no successor.
  return payload;
}

/**
 * THE SELECTION DP — provably optimal (proven against brute force in
 * tests/constraints/removal-dp-optimality.test.ts). Given each flat line's char
 * WEIGHT and its ELIGIBLE boolean, and the removed-char band [rMin, rMax], it picks
 * which lines to drop to MINIMISE removed chars R subject to:
 *   (a) drop only where eligible[i] === true;
 *   (b) every maximal dropped run is >= 6 lines;
 *   (c) every interior kept run (one with a gap on BOTH sides) is >= 6 lines;
 *   (d) R lands in [rMin, rMax] (the band) when any valid arrangement can;
 *   (e) among in-band arrangements, the SMALLEST R (the gentlest compression).
 * If no arrangement lands in band (genuinely infeasible — e.g. eligible lines too
 * fragmented to form a 6-run), it returns the legal arrangement whose R is NEAREST
 * the band (smaller R breaks ties) with bandSatisfied=false. It NEVER relaxes the
 * run rules and NEVER drops a protected line to force the band.
 *
 * THE STATE MACHINE (left-to-right, one line at a time). A run is a maximal stretch
 * of the same decision. State after deciding lines 0..i-1:
 *   • mode    — K (last line kept) or D (last line dropped);
 *   • runLen  — length of that trailing run, capped at 6 (the only threshold that
 *               matters): runIdx 0..5 == length 1..6+, where 5 means ">= 6";
 *   • sawDrop — has ANY line been dropped before the current run.
 * Transitions deciding line i:
 *   • KEEP extends a K run; CLOSES a D run only if that D run was >= 6.
 *   • DROP (eligible only) extends a D run; CLOSES a K run only if that K run is a
 *     leading run (sawDrop=0, any length) OR was >= 6 (an interior run).
 * Acceptance at the end: a trailing K run is a boundary run (any length); a trailing
 * D run must be >= 6. Drop-nothing (all-K) is always accepting with R=0.
 *
 * Because R (a char sum) is large, the table is NOT keyed on R as a continuous
 * objective; instead it tracks, per (line, state), the SET of achievable R totals
 * (reachability), then reads off the optimal R and reconstructs a witnessing
 * selection via backpointer re-derivation. Determinism: the whole routine is a pure
 * function of its inputs and resolves every choice by lowest index, so identical
 * inputs yield an identical selection.
 */
export function selectDropsToBand(
  weights: readonly number[],
  eligible: readonly boolean[],
  rMin: number,
  rMax: number,
): DropSelection {
  const n = weights.length;
  if (n !== eligible.length) {
    throw new Error('selectDropsToBand: weights and eligible arrays differ in length.');
  }
  // Drop-nothing (R = 0) is always a valid arrangement, so the reachable set is
  // never empty and a selection always exists.
  if (n === 0) {
    return { drop: [], removed: 0, bandSatisfied: 0 >= rMin && 0 <= rMax };
  }

  // Rcap = the most we could ever remove = Σ weight over ELIGIBLE lines (only
  // eligible lines may be dropped). Every number this DP touches is either a char
  // COUNT (a size) or the eligible boolean — never an importance score.
  let Rcap = 0;
  for (let i = 0; i < n; i++) {
    if (eligible[i] === true) Rcap += weights[i] ?? 0; // Rule 6: guard the index, no '!'
  }
  const Rspan = Rcap + 1;

  // State encoding. mode 0 = keeping (K), 1 = dropping (D). sawDrop 0/1. runIdx 0..5.
  //   sidx(mode, sawDrop, runIdx) = ((mode*2)+sawDrop)*6 + runIdx, range 0..23.
  //   START (no run decided yet) = 24.
  const STATES = 25;
  const START = 24;
  const KEEP = 0;
  const DROP = 1;
  const sidx = (mode: number, sawDrop: number, runIdx: number): number => (mode * 2 + sawDrop) * 6 + runIdx;

  // ── RESOURCE GUARD ────────────────────────────────────────────────────────────
  // The exact band-targeting DP is pseudo-polynomial: its reachability table is
  // (n+1) × STATES × Rspan cells. For typical source files that is small; for a
  // pathologically large file it would exhaust memory (or hang) on its way to a
  // result the caller currently discards. Refuse such an input LOUDLY rather than
  // crash — compressFile's catch boundary turns this throw into the "use raw"
  // signal, identical to today's behaviour for those files (no regression) and never
  // a wrong answer or a relaxed rule. AGENTS.md wants bounded operations; this is
  // the bound. (Large-file PERFORMANCE — making such files compress rather than fall
  // back — is a separate, deliberate concern, not this sub-stage's.)
  const MAX_CELLS = 60_000_000; // ~60MB as Uint8Array, transient and freed per call
  if ((n + 1) * STATES * Rspan > MAX_CELLS) {
    throw new Error(
      `selectDropsToBand: input exceeds the exact-DP size bound ` +
        `(${n} lines × ${Rspan} removable-char states > ${MAX_CELLS} cells). ` +
        `Degrades to raw upstream.`,
    );
  }

  // The DP's transition relation — the SINGLE source of truth, used by both the
  // forward fill and the backward reconstruction so they can never diverge.
  // keepTarget(s): state after KEEPING a line from s, or -1 if keeping is illegal.
  const keepTarget = (s: number): number => {
    if (s === START) return sidx(KEEP, 0, 0); // first line kept: K run len 1, no drop yet
    const group = Math.floor(s / 6);
    const runIdx = s % 6;
    const mode = Math.floor(group / 2);
    const sawDrop = group % 2;
    if (mode === KEEP) return sidx(KEEP, sawDrop, Math.min(runIdx + 1, 5)); // extend K run
    if (runIdx !== 5) return -1; // closing a D run requires it to be >= 6
    return sidx(KEEP, 1, 0); // a drop has now occurred before this new K run
  };
  // dropTarget(s): state after DROPPING a line from s, or -1 if dropping is illegal.
  // (The caller checks the specific line's eligibility; this is purely structural.)
  const dropTarget = (s: number): number => {
    if (s === START) return sidx(DROP, 1, 0); // first line dropped: D run len 1
    const group = Math.floor(s / 6);
    const runIdx = s % 6;
    const mode = Math.floor(group / 2);
    const sawDrop = group % 2;
    if (mode === DROP) return sidx(DROP, 1, Math.min(runIdx + 1, 5)); // extend D run
    // mode === KEEP: closing a K run to open a D run. An interior K run (a drop came
    // before it, sawDrop=1) must be >= 6; a leading K run (sawDrop=0) has no minimum.
    if (sawDrop === 1 && runIdx !== 5) return -1;
    return sidx(DROP, 1, 0);
  };
  // accepting(s): may the chain END in state s? Trailing K run = boundary (any len);
  // trailing D run must be >= 6.
  const accepting = (s: number): boolean => {
    if (s === START) return false; // n >= 1 here, so START is never terminal
    const mode = Math.floor(Math.floor(s / 6) / 2);
    if (mode === KEEP) return true;
    return s % 6 === 5; // D run must be >= 6
  };

  // ── FORWARD FILL. reach[i] is a Uint8Array of STATES*Rspan flags;
  //    reach[i][s*Rspan + r] === 1 iff, after deciding lines 0..i-1, we can be in
  //    state s having removed exactly r chars. (Typed-array reads return a number,
  //    so only the outer Array<Uint8Array> needs an undefined guard.) ──────────────
  const reach: Array<Uint8Array> = new Array(n + 1);
  for (let i = 0; i <= n; i++) reach[i] = new Uint8Array(STATES * Rspan);
  const layer0 = reach[0];
  if (layer0 === undefined) throw new Error('selectDropsToBand: layer allocation failed.');
  layer0[START * Rspan + 0] = 1; // before any line: at START, nothing removed

  for (let i = 0; i < n; i++) {
    const cur = reach[i];
    const next = reach[i + 1];
    if (cur === undefined || next === undefined) continue; // Rule 6 guard (i is in range)
    const wi = weights[i] ?? 0;
    const canDrop = eligible[i] === true;
    for (let s = 0; s < STATES; s++) {
      const kt = keepTarget(s);
      const dt = canDrop ? dropTarget(s) : -1;
      if (kt < 0 && dt < 0) continue;
      const base = s * Rspan;
      for (let r = 0; r <= Rcap; r++) {
        if (cur[base + r] !== 1) continue;
        if (kt >= 0) next[kt * Rspan + r] = 1; // keep: R unchanged
        if (dt >= 0) {
          const nr = r + wi;
          if (nr <= Rcap) next[dt * Rspan + nr] = 1; // drop: R += wi
        }
      }
    }
  }

  const reachN = reach[n];
  if (reachN === undefined) throw new Error('selectDropsToBand: final layer missing.');

  // findAccepting(r): the lowest-index accepting state reachable with exactly r
  // removed chars, or -1. Lowest index keeps reconstruction deterministic.
  const findAccepting = (r: number): number => {
    for (let s = 0; s < STATES; s++) {
      if (accepting(s) && reachN[s * Rspan + r] === 1) return s;
    }
    return -1;
  };

  // ── CHOOSE R. In-band: the SMALLEST reachable r in [rMin, rMax] (gentlest).
  //    Otherwise (infeasible): the reachable r NEAREST the band, smaller r breaking
  //    ties. Scanning r ascending realises both (first in-band hit = min; strict <
  //    on distance keeps the smallest r at the minimum distance). r = 0 is always
  //    reachable (drop-nothing), so a choice always exists. ─────────────────────────
  let chosenR = -1;
  let chosenState = -1;
  let bandSatisfied = false;
  for (let r = 0; r <= Rcap; r++) {
    if (r < rMin || r > rMax) continue;
    const s = findAccepting(r);
    if (s >= 0) {
      chosenR = r;
      chosenState = s;
      bandSatisfied = true;
      break; // smallest in-band r
    }
  }
  if (!bandSatisfied) {
    let bestDist = Infinity;
    for (let r = 0; r <= Rcap; r++) {
      const s = findAccepting(r);
      if (s < 0) continue;
      const dist = r < rMin ? rMin - r : r > rMax ? r - rMax : 0;
      if (dist < bestDist) {
        bestDist = dist;
        chosenR = r;
        chosenState = s;
      }
    }
  }
  if (chosenState < 0) throw new Error('selectDropsToBand: no reachable terminal state (internal error).');

  // ── RECONSTRUCT. Walk backward from (n, chosenState, chosenR), at each line
  //    finding a predecessor consistent with the forward table. KEEP is tried first
  //    (deterministic, and the gentlest move at the margin); a reachable predecessor
  //    always exists, so the walk never stalls and ends at START with R = 0. ────────
  const drop: boolean[] = new Array(n).fill(false);
  let curState = chosenState;
  let curR = chosenR;
  for (let i = n - 1; i >= 0; i--) {
    const li = reach[i];
    if (li === undefined) throw new Error('selectDropsToBand: layer missing during reconstruction.');
    let found = false;
    // KEEP predecessor: same R, keepTarget(p) === curState.
    for (let p = 0; p < STATES; p++) {
      if (li[p * Rspan + curR] === 1 && keepTarget(p) === curState) {
        drop[i] = false;
        curState = p;
        found = true;
        break;
      }
    }
    if (!found && eligible[i] === true) {
      const wi = weights[i] ?? 0;
      const pr = curR - wi;
      if (pr >= 0) {
        for (let p = 0; p < STATES; p++) {
          if (li[p * Rspan + pr] === 1 && dropTarget(p) === curState) {
            drop[i] = true;
            curState = p;
            curR = pr;
            found = true;
            break;
          }
        }
      }
    }
    if (!found) throw new Error('selectDropsToBand: reconstruction failed — DP table inconsistency.');
  }
  if (curState !== START || curR !== 0) {
    throw new Error('selectDropsToBand: reconstruction did not terminate at START with R=0.');
  }

  return { drop, removed: chosenR, bandSatisfied };
}
