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
//   • the RENDERED output — the kept content PLUS the truncation-marker chars the
//     gaps add — lands in the retention band [68%, 72%] of the file's content size
//     (also never exceeding the hard char budget);
//   • only eligible lines are ever dropped (protected lines are ALWAYS kept);
//   • every maximal dropped run is >= 6 lines (no marker is worth < 6 lines);
//   • every interior kept run (between two gaps) is >= 6 lines (no noise slivers);
//   • the compression is the GENTLEST legal one — it removes the LEAST it can while
//     still landing in the band.
// The DP is provably optimal (proven against brute force on small inputs); it reads
// ONLY the eligible booleans and the char counts (and markerLen, which is itself a
// char count of a fixed-shape string) — no score, weight, rank, or importance number
// ever enters it. Char COUNT is a size, not a ranking.
//
// FAIL LOUD, DEGRADE OUTSIDE: if either engine's verdict is missing or malformed
// the gate THROWS — it must never improvise a selection from half the evidence.
// That throw is contained at toon's own public boundary (index.ts `compressFile`),
// which degrades to "use raw content," so a real-time caller is never interrupted
// by a compression failure. Loud to the operator, invisible to the caller.
//
// SUB-STAGE 5B.1 SCOPE: this fixes two defects in 5B. (P1) Each maximal dropped run
// now emits the REAL `[TRUNCATED: lines X-Y]` marker — flush-left, no prefix, no
// `#`, the run's true first/last absolute line numbers (the unified marker format
// the whole contract mandates), in place of 5B's bare `[TRUNCATED]` placeholder.
// (P2) The marker lines cost characters, so the band now constrains the RENDERED
// size (kept content + marker chars), not kept content alone — the DP's objective is
// NET removal (dropped content minus the marker chars its gaps add), charged exactly
// per gap.
//
// SUB-STAGE 5D SCOPE: the lights come on. `verifyOutput` (below) is the Phase-H
// line-fidelity gate — it re-parses the FINAL output and THROWS on any trust-contract
// violation (H1-H7; H2 the verbatim keystone), so `compressFile` (index.ts) can now
// RETURN genuinely-compressed output, verified, and degrade to raw on any failure.
// The source crossing the seam is already `N. `-prefixed (read_file is the one
// authority that places line numbers); the gate strips that prefix only to weigh
// lines and emits every kept line verbatim, so a number never lies about its content.

import type { Payload } from './compress-source.js';

/**
 * The EXACT character length the omission marker for a dropped run spanning absolute
 * lines `a`..`b` contributes to the rendered output. This is the SINGLE source of
 * marker cost: the selection DP charges it, the brute-force probe charges it, and the
 * gate's inline marker emission is asserted against it at the point of emission — so
 * the costed marker and the emitted marker can never drift apart. Counted the same
 * way line content is (the trailing `\n` that `join('\n')` adds between lines is NOT
 * included). It is a SIZE in characters — a count of a fixed-shape string, never an
 * importance score. The cost depends on the DIGIT COUNT of `a` and `b`, so it is
 * computed from the run's REAL boundary line numbers, never a constant or an average.
 */
export function markerLen(a: number, b: number): number {
  return `[TRUNCATED: lines ${a}-${b}]`.length;
}

/**
 * The hard ceiling on the selection DP's reachability table, in Uint32 WORDS
 * (×4 bytes ⇒ 500 MiB). The table is `(n+1)·STATES·WORDS` words, and WORDS scales with
 * the net WINDOW WIDTH — which is pseudo-polynomial in the file's TOTAL character
 * weight, not its line count. An ordinary file (even the n=2000 stress case) sits near
 * ~50M words (~200 MiB); only files with megabyte-scale lines push the table toward the
 * gigabytes. When the EXACT (g = 1) table would exceed this ceiling, the controller in
 * `selectDropsToBand` divides the net axis by the smallest integer scale `g` that brings
 * it back under, runs the SAME exact multi-gap `solve` on the coarsened copy, and
 * recomputes the true net from the ORIGINAL integer weights — so memory is bounded WITHOUT
 * risking a process OOM and WITHOUT changing behaviour for any normal file (g = 1,
 * byte-identical to the verified engine).
 *
 * It is a `const`: an immutable structural bound, never a runtime-tunable knob. Exported
 * only so a test can prove the exact (g = 1) table for a given input would exceed it (and
 * thus that scaling necessarily engaged) — reading it cannot change it.
 */
export const MAX_REACH_WORDS = 125_000_000;

/**
 * The removal gate's determination — the `removal` metadata key it owns.
 *
 * `eligible` is the ELIGIBILITY PARTITION (5A): a strict boolean per ABSOLUTE line
 * number — `true` when BOTH ranking engines judged the line non-core (a removal
 * candidate), `false` when at least one engine protected it. Deliberately NOT a
 * number: no per-line importance, no blend, no ordering.
 *
 * The rest is the SELECTION (5B / 5B.1): `dropped` is the set of absolute line
 * numbers the DP actually removed. `keptContent` is the surviving content size in
 * characters (display prefixes excluded). `renderedSize` is what the caller actually
 * receives: `keptContent` PLUS the chars the `[TRUNCATED: lines X-Y]` markers add —
 * this is the size the retention band constrains. `bandSatisfied` is true iff the
 * rendered size landed inside the band (false when the input was infeasible and the
 * gate fell back to the legal selection nearest the band — never by relaxing a rule).
 * Defined and owned HERE; the render engine consumes it.
 */
export interface RemovalMetadata {
  readonly eligible: ReadonlyMap<number, boolean>;
  readonly dropped: ReadonlySet<number>;
  readonly keptContent: number;
  readonly renderedSize: number;
  readonly bandSatisfied: boolean;
}

/**
 * The selection DP's result over a flat line array. `drop[i]` is true iff flat line
 * `i` is removed; `netRemoved` is the NET chars removed — dropped content MINUS the
 * marker chars the gaps add (`droppedContent − Σ markerLen(run)`) — which is exactly
 * `fullSize − renderedSize`; `bandSatisfied` is true iff that net landed in the
 * requested band. Returned by `selectDropsToBand` and consumed inline by the gate to
 * build its output and determination.
 */
export interface DropSelection {
  readonly drop: readonly boolean[];
  readonly netRemoved: number;
  readonly bandSatisfied: boolean;
}

/**
 * The removal gate's core process. It (1) FAILS LOUD if either ranking engine's
 * verdict is missing/malformed — it cannot and must not gate on half the evidence;
 * (2) flattens blocks to absolute lines (IDENTICALLY to bmxEngine), projecting the
 * SageRank BLOCK core onto lines and reading the BMX+ LINE core; (3) computes the
 * boolean eligibility partition (protected = sage-core OR bmx-core; eligible =
 * neither), each line's char weight, and each line's absolute number; (4) computes
 * the retention band on RENDERED size and runs the SELECTION DP to choose the
 * gentlest legal set of eligible lines to drop; (5) emits the kept lines verbatim
 * with each dropped run collapsed to a single `[TRUNCATED: lines X-Y]` marker, and
 * records the selection (with rendered accounting) as its own determination.
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

  // ── (3) ELIGIBILITY PARTITION + per-line CHAR WEIGHT + per-line ABSOLUTE NUMBER,
  //    in one pass over the flat lines. Eligibility: a line is eligible ONLY if
  //    NEITHER engine protected it (equal co-vetoes, ANDed — no blend; the value is a
  //    strict boolean). Weight: the content char length with the display "N. " prefix
  //    stripped (the prefix is presentation, not content) — a SIZE COUNT, never an
  //    importance score. The absolute line number feeds the DP's marker-cost math
  //    (the `[TRUNCATED: lines X-Y]` width depends on the boundary line digits).
  //    `eligible` (line-keyed, the gate's published partition) and the parallel
  //    flat-order arrays `weights`/`eligibleArr`/`linesArr` (the DP's inputs) are
  //    built together so they can never drift. fullSize = Σ weight over ALL lines. ──
  const eligible = new Map<number, boolean>();
  const weights: number[] = new Array(flat.length);
  const eligibleArr: boolean[] = new Array(flat.length);
  const linesArr: number[] = new Array(flat.length);
  let fullSize = 0;
  for (let fi = 0; fi < flat.length; fi++) {
    const f = flat[fi];
    if (f === undefined) {
      // Rule 6 guard; flat is densely populated so this never trips in practice.
      weights[fi] = 0;
      eligibleArr[fi] = false;
      linesArr[fi] = 0;
      continue;
    }
    const content = f.text.replace(/^\s*\d+[.:]\s?/, ''); // strip display prefix for SIZE only
    const w = content.length;
    weights[fi] = w;
    linesArr[fi] = f.line;
    fullSize += w;
    const protectedBySage = sageCoreBlocks.has(f.blockIndex); // its block is core
    const protectedByBmx = bmxCoreLines.has(f.line);          // its line is core
    const isEligible = !protectedBySage && !protectedByBmx;
    eligibleArr[fi] = isEligible;
    eligible.set(f.line, isEligible);
  }

  // ── (4) RETENTION BAND, on RENDERED size. The rendered output is kept content PLUS
  //    the marker chars the gaps add; it must land in [68%, 72%] of fullSize and
  //    never exceed the hard char budget. Work in NET removed chars (rendered =
  //    fullSize − netRemoved, where netRemoved = dropped content − marker chars):
  //      keptCeiling = min(HI, charBudget)   // tighter of the band top and budget
  //      netMin = fullSize - keptCeiling     // remove at least this much NET
  //      netMax = fullSize - LO              // remove at most this much NET
  //    (LO <= HI <= fullSize, so netMin/netMax are >= 0. For a non-trivial file
  //    netMin > 0: keeping 100% is far above the 72% ceiling, so the gate must drop
  //    to enter the band — "drop nothing" is in-band only for an empty file.) Because
  //    each gap's marker eats into net removal, opening many small gaps is penalised
  //    automatically — nudging toward fewer, larger gaps (better ratio AND clarity). ─
  const LO = Math.ceil(0.68 * fullSize);
  const HI = Math.floor(0.72 * fullSize);
  const keptCeiling = Math.min(HI, payload.source.charBudget);
  const netMin = fullSize - keptCeiling;
  const netMax = fullSize - LO;

  // ── (5) SELECTION — the gentlest legal set of eligible lines to drop. ──────────
  const sel = selectDropsToBand(weights, linesArr, eligibleArr, netMin, netMax);

  // ── (6) OUTPUT + the gate's determination. Walk the lines in order: a kept line
  //    emits its ORIGINAL prefixed text verbatim; each MAXIMAL dropped run emits a
  //    single `[TRUNCATED: lines a-b]` marker — flush-left (column 0, no prefix, no
  //    `#`, no indentation), with the run's REAL first/last absolute line numbers.
  //    Marker emission is INLINE by design (Rule 11): the literal marker string is
  //    built right here, and asserted to match markerLen at the point of emission so
  //    the costed and emitted marker can never diverge. keptContent and the marker
  //    chars are summed independently and cross-checked against the DP's net. ───────
  const droppedLines = new Set<number>();
  let keptContent = 0;
  let markerTotal = 0;
  const parts: string[] = [];
  let idx = 0;
  while (idx < flat.length) {
    const f = flat[idx];
    if (f === undefined) {
      idx++;
      continue;
    }
    if (sel.drop[idx] === true) {
      // Collapse the whole maximal dropped run into one ranged marker.
      const runStart = idx;
      let runEnd = idx;
      while (idx < flat.length && sel.drop[idx] === true) {
        const g = flat[idx];
        if (g !== undefined) {
          droppedLines.add(g.line);
          runEnd = idx;
        }
        idx++;
      }
      const sLine = flat[runStart];
      const eLine = flat[runEnd];
      if (sLine === undefined || eLine === undefined) {
        throw new Error('removalEngine: dropped-run boundary lookup failed (internal).');
      }
      const a = sLine.line;
      const b = eLine.line;
      const marker = `[TRUNCATED: lines ${a}-${b}]`; // flush-left, no prefix, no '#'
      if (marker.length !== markerLen(a, b)) {
        throw new Error(
          'removalEngine: emitted marker length disagrees with markerLen — marker format drift.',
        );
      }
      parts.push(marker);
      markerTotal += marker.length;
    } else {
      parts.push(f.text); // verbatim, prefix intact — never altered, never renumbered
      keptContent += weights[idx] ?? 0;
      idx++;
    }
  }

  // Rendered size is what the caller pays for: kept content + the marker chars. It is
  // computed here independently of the DP and MUST equal fullSize − netRemoved (the
  // DP's objective). A mismatch means the DP cost and the emission disagree — fail
  // loud (caught at compressFile -> degrade to raw); never ship an inconsistent cut.
  const renderedSize = keptContent + markerTotal;
  if (renderedSize !== fullSize - sel.netRemoved) {
    throw new Error(
      `removalEngine: rendered size (${renderedSize}) disagrees with fullSize - netRemoved ` +
        `(${fullSize - sel.netRemoved}) — DP marker cost and emission are inconsistent.`,
    );
  }

  const determination: RemovalMetadata = {
    eligible,
    dropped: droppedLines,
    keptContent,
    renderedSize,
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
 * WEIGHT, its ABSOLUTE line number, and its ELIGIBLE boolean, and the NET-removed
 * band [netMin, netMax], it picks which lines to drop to MINIMISE net removal
 * (= dropped content − marker chars; equivalently to MAXIMISE rendered size up to the
 * ceiling) subject to:
 *   (a) drop only where eligible[i] === true;
 *   (b) every maximal dropped run is >= 6 lines;
 *   (c) every interior kept run (one with a gap on BOTH sides) is >= 6 lines;
 *   (d) netRemoved lands in [netMin, netMax] (the band) when any valid arrangement can;
 *   (e) among in-band arrangements, the SMALLEST netRemoved (the gentlest compression).
 * If no arrangement lands in band (genuinely infeasible — e.g. eligible lines too
 * fragmented to form a 6-run), it returns the legal arrangement whose net is NEAREST
 * the band (smaller net breaks ties) with bandSatisfied=false. It NEVER relaxes the
 * run rules and NEVER drops a protected line to force the band.
 *
 * MARKER COST, CHARGED PER GAP WITHOUT EXPLODING THE STATE. Each gap adds
 * markerLen(a,b) = markerFixed + digits(a) + digits(b) chars, where a/b are the run's
 * first/last absolute line numbers. That cost is additively SEPARABLE across the two
 * boundaries, so it is charged in two pieces at the two transitions where each
 * boundary line is known: `markerFixed + digits(a)` when the gap OPENS (the start
 * line is the current line) and `digits(b)` when the gap CLOSES (the end line is the
 * line just left — a D->K keep, or end-of-file while dropping). Charging it this way
 * means the DP NEVER has to carry the run's start line in its state — the state stays
 * exactly the 25 states of 5B; only the per-transition net delta changed.
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
 * D run must be >= 6. Drop-nothing (all-K) is always accepting with net=0.
 *
 * Because net (a char sum) is large, the table is NOT keyed on net as a continuous
 * objective; instead it tracks, per (line, state), the SET of achievable net totals
 * (reachability), then reads off the optimal net and reconstructs a witnessing
 * selection via backpointer re-derivation. Net can dip slightly negative mid-pass (a
 * just-opened gap is charged its marker before its content accumulates), so the
 * reachability index is offset to keep it non-negative. Determinism: the whole
 * routine is a pure function of its inputs and resolves every choice by lowest index,
 * so identical inputs yield an identical selection.
 */
export function selectDropsToBand(
  weights: readonly number[],
  lines: readonly number[],
  eligible: readonly boolean[],
  netMin: number,
  netMax: number,
  // Immutable production ceiling by default (see MAX_REACH_WORDS). Optional ONLY so a
  // test can force the g > 1 quantization branch with small inputs without allocating
  // the real 500 MiB table; production callers never pass it. Never a mutable knob.
  maxReachWords: number = MAX_REACH_WORDS,
): DropSelection {
  const n = weights.length;
  if (n !== eligible.length || n !== lines.length) {
    throw new Error('selectDropsToBand: weights, lines and eligible arrays differ in length.');
  }
  // Drop-nothing (net = 0) is always a valid arrangement, so the reachable set is
  // never empty and a selection always exists.
  if (n === 0) {
    return { drop: [], netRemoved: 0, bandSatisfied: 0 >= netMin && 0 <= netMax };
  }

  // markerFixed: the marker's char width MINUS its two line numbers, derived FROM
  // markerLen so a change to the marker text propagates here. The self-check fails
  // loud (caught at compressFile -> degrade to raw) if the marker ever stops being
  // additively separable, which would invalidate the per-boundary charging below.
  const digits = (x: number): number => String(x).length;
  const markerFixed = markerLen(0, 0) - digits(0) - digits(0);
  if (markerFixed + digits(7) + digits(1234) !== markerLen(7, 1234)) {
    throw new Error(
      'selectDropsToBand: the omission marker is no longer additively separable into ' +
        'markerFixed + digits(start) + digits(end); the DP marker-cost charging is invalid. ' +
        'Fix the marker format and the cost decomposition together.',
    );
  }

  // Per-line marker charges, precomputed once. openCharge[i] is subtracted when a gap
  // OPENS at line i (start line = lines[i]); closeCharge[i] is owed when a gap CLOSES
  // at line i (end line = lines[i-1], the line just left). Under noUncheckedIndexedAccess
  // even typed-array reads are number|undefined, so every consuming read below is guarded
  // with `?? <inert default>` (Rule 6 — never a non-null `!`); the arrays are densely
  // filled, so each guard branch is dead and behaviour is exactly the proven engine's.
  const openCharge = new Int32Array(n);
  const closeCharge = new Int32Array(n);
  const wArr = new Int32Array(n);
  let Rcap = 0;
  let maxWeight = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i] ?? 0;
    wArr[i] = w;
    if (w > maxWeight) maxWeight = w;
    if (eligible[i] === true) Rcap += w;
    openCharge[i] = markerFixed + digits(lines[i] ?? 0);
    closeCharge[i] = i >= 1 ? digits(lines[i - 1] ?? 0) : 0;
  }

  // ── State encoding (identical to the incumbent). mode 0=keep(K),1=drop(D);
  //    sawDrop 0/1; runIdx 0..5 (length 1..6+, 5 == "≥6"). sidx∈0..23; START=24.
  //    Built once into typed transition tables so the hot loop is pure array reads. ────
  const STATES = 25;
  const START = 24;
  const KEEP = 0;
  const DROP = 1;
  const sidx = (mode: number, sawDrop: number, runIdx: number): number => (mode * 2 + sawDrop) * 6 + runIdx;
  const keepTgt = new Int32Array(STATES);
  const dropTgt = new Int32Array(STATES);
  const dropMode = new Uint8Array(STATES);
  const acceptOK = new Uint8Array(STATES);
  for (let s = 0; s < STATES; s++) {
    if (s === START) {
      keepTgt[s] = sidx(KEEP, 0, 0);
      dropTgt[s] = sidx(DROP, 1, 0);
      dropMode[s] = 0;
      acceptOK[s] = 0;
      continue;
    }
    const group = Math.floor(s / 6);
    const runIdx = s % 6;
    const mode = Math.floor(group / 2);
    const sawDrop = group % 2;
    dropMode[s] = mode === DROP ? 1 : 0;
    if (mode === KEEP) keepTgt[s] = sidx(KEEP, sawDrop, Math.min(runIdx + 1, 5));
    else if (runIdx === 5) keepTgt[s] = sidx(KEEP, 1, 0);
    else keepTgt[s] = -1;
    if (mode === DROP) dropTgt[s] = sidx(DROP, 1, Math.min(runIdx + 1, 5));
    else if (sawDrop === 1 && runIdx !== 5) dropTgt[s] = -1;
    else dropTgt[s] = sidx(DROP, 1, 0);
    acceptOK[s] = mode === KEEP ? 1 : runIdx === 5 ? 1 : 0;
  }

  // ── CHEAP SCALAR PRE-PASSES: exact minimum and maximum reachable net. Same
  //    recurrence as the bit DP, tracking only the best net per state. The global
  //    extrema bound the window without inflating it. O(n·STATES), no net axis. ────────
  const INF = 0x3fffffff;
  let curMin = new Int32Array(STATES).fill(INF);
  let nxtMin = new Int32Array(STATES);
  let curMax = new Int32Array(STATES).fill(-INF);
  let nxtMax = new Int32Array(STATES);
  curMin[START] = 0;
  curMax[START] = 0;
  let trueMinNet = 0; // minimum RAW reachable net over all states/layers (≤ 0)
  let trueMaxRaw = 0; // maximum RAW reachable net over all states/layers (transients included)
  let trueMaxNet = 0; // maximum EFFECTIVE reachable net over accepting end states
  for (let i = 0; i < n; i++) {
    nxtMin.fill(INF);
    nxtMax.fill(-INF);
    const wi = wArr[i] ?? 0;
    const canDrop = eligible[i] === true;
    const oc = openCharge[i] ?? 0;
    const cc = closeCharge[i] ?? 0;
    for (let s = 0; s < STATES; s++) {
      const vMin = curMin[s] ?? INF;
      const vMax = curMax[s] ?? -INF;
      if (vMin === INF && vMax === -INF) continue;
      const kt = keepTgt[s] ?? -1;
      const keepDelta = dropMode[s] === 1 ? -cc : 0;
      if (kt >= 0) {
        if (vMin !== INF && vMin + keepDelta < (nxtMin[kt] ?? INF)) nxtMin[kt] = vMin + keepDelta;
        if (vMax !== -INF && vMax + keepDelta > (nxtMax[kt] ?? -INF)) nxtMax[kt] = vMax + keepDelta;
      }
      if (canDrop) {
        const dt = dropTgt[s] ?? -1;
        if (dt >= 0) {
          const dropDelta = dropMode[s] === 0 ? wi - oc : wi;
          if (vMin !== INF && vMin + dropDelta < (nxtMin[dt] ?? INF)) nxtMin[dt] = vMin + dropDelta;
          if (vMax !== -INF && vMax + dropDelta > (nxtMax[dt] ?? -INF)) nxtMax[dt] = vMax + dropDelta;
        }
      }
    }
    let tm = curMin; curMin = nxtMin; nxtMin = tm;
    tm = curMax; curMax = nxtMax; nxtMax = tm;
    for (let s = 0; s < STATES; s++) {
      const cm = curMin[s] ?? INF;
      const cx = curMax[s] ?? -INF;
      if (cm < trueMinNet) trueMinNet = cm;
      if (cx !== -INF && cx > trueMaxRaw) trueMaxRaw = cx; // RAW peak (transients)
    }
  }
  // trueMaxNet (effective) over ACCEPTING states only (the EOF-close adjustment applies there).
  const eofClose = digits(lines[n - 1] ?? 0);
  for (let s = 0; s < STATES; s++) {
    if (acceptOK[s] !== 1) continue;
    const cx = curMax[s] ?? -INF;
    if (cx === -INF) continue;
    const eff = cx - (dropMode[s] === 1 ? eofClose : 0);
    if (eff > trueMaxNet) trueMaxNet = eff;
  }

  const windowLo = trueMinNet - 1;
  const markerMax = markerFixed + 2 * digits(Math.max(1, lines[n - 1] ?? 1));
  // The window high bound is in RAW net terms. An in-band EFFECTIVE net e (≤ netMax)
  // can sit at RAW net up to e + eofClose (a drop-to-EOF state), and a run's transient
  // RAW peak can exceed its final net by a close charge — so the slack covers a marker
  // and a max line weight on top of eofClose. Capped by the true RAW maximum so we
  // never over-allocate on sparse inputs.
  const highSlack = markerMax + maxWeight + eofClose + 1;

  // Count trailing zeros of a non-zero 32-bit word — used to enumerate the set net-bits
  // when reading the reachability rows. (Local counter `z`, never the outer `n`.)
  const ctz32 = (b: number): number => {
    b = b >>> 0;
    if (b === 0) return 32;
    let z = 0;
    if ((b & 0x0000ffff) === 0) { z += 16; b >>>= 16; }
    if ((b & 0x000000ff) === 0) { z += 8; b >>>= 8; }
    if ((b & 0x0000000f) === 0) { z += 4; b >>>= 4; }
    if ((b & 0x00000003) === 0) { z += 2; b >>>= 2; }
    if ((b & 0x00000001) === 0) { z += 1; }
    return z;
  };

  // ── The actual band-targeting solve over a window [windowLo, windowHiTarget].
  //    windowHi is padded up to a 32-bit boundary so every tracked bit is a valid,
  //    in-window net. Returns the chosen drop mask + net + band flag, plus the smallest
  //    effective net it observed strictly ABOVE netMax (or +Inf), so the controller can
  //    decide whether a wider pass is needed. ───────────────────────────────────────────
  // `solve` runs the exact multi-gap band-targeting DP over a working net axis supplied
  // ENTIRELY through its parameters. The hot fill/choose/reconstruct loop bodies are
  // byte-identical to the verified fen engine — they simply read their inputs (the weight
  // array, the two marker-charge arrays, the EOF close charge, the window floor, and the
  // band [netMin, netMax]) from these parameters instead of the enclosing closure. The
  // controller passes the ORIGINAL char-domain arrays for the normal g = 1 case (so the
  // result is provably byte-identical) and coarsened copies for the g > 1 case. `solve`
  // is a local closure, so widening its signature has zero external blast radius; the
  // public `selectDropsToBand` signature is unchanged.
  const solve = (
    windowHiTarget: number,
    wArr: Int32Array,
    openCharge: Int32Array,
    closeCharge: Int32Array,
    eofClose: number,
    windowLo: number,
    netMin: number,
    netMax: number,
  ) => {
    const WORDS = Math.max(1, ((windowHiTarget - windowLo + 1) + 31) >>> 5);
    const windowHi = windowLo + WORDS * 32 - 1; // real top after word padding
    const layerWords = STATES * WORDS;
    const bitForNet = (net: number): number => net - windowLo;
    const inWindow = (net: number): boolean => net >= windowLo && net <= windowHi;

    const reach = new Uint32Array((n + 1) * layerWords);
    {
      const z0 = bitForNet(0);
      const z0i = START * WORDS + (z0 >>> 5);
      reach[z0i] = (reach[z0i] ?? 0) | (1 << (z0 & 31));
    }

    const actLoW = new Int32Array(n + 1);
    const actHiW = new Int32Array(n + 1);
    const liveMask = new Int32Array(n + 1);
    for (let i = 0; i <= n; i++) { actLoW[i] = WORDS; actHiW[i] = -1; liveMask[i] = 0; }
    {
      const z0w = bitForNet(0) >>> 5;
      actLoW[0] = z0w; actHiW[0] = z0w; liveMask[0] = 1 << START;
    }

    // shift-by-bits (net += delta) then OR, restricted to source live words [sLoW,sHiW];
    // writes dstSpan{Lo,Hi} (a safe superset of touched dst words) for active-range bookkeeping.
    // `reach[x] |= y` is written as `reach[x] = (reach[x] ?? 0) | y` so the guarded read
    // typechecks; for a densely-filled buffer the two are identical (no '!', Rule 6).
    let dstSpanLo = 0;
    let dstSpanHi = -1;
    const shiftOrRange = (dstOff: number, srcOff: number, delta: number, sLoW: number, sHiW: number): void => {
      if (delta === 0) {
        for (let w = sLoW; w <= sHiW; w++) reach[dstOff + w] = (reach[dstOff + w] ?? 0) | (reach[srcOff + w] ?? 0);
        dstSpanLo = sLoW; dstSpanHi = sHiW;
        return;
      }
      if (delta > 0) {
        const wordShift = delta >>> 5;
        const bitShift = delta & 31;
        let lo = sLoW + wordShift;
        let hi = sHiW + wordShift + (bitShift === 0 ? 0 : 1);
        if (hi > WORDS - 1) hi = WORDS - 1;
        if (bitShift === 0) {
          for (let w = hi; w >= lo; w--) reach[dstOff + w] = (reach[dstOff + w] ?? 0) | (reach[srcOff + w - wordShift] ?? 0);
        } else {
          const inv = 32 - bitShift;
          for (let w = hi; w >= lo; w--) {
            const k = srcOff + w - wordShift;
            const a = w - wordShift <= sHiW ? (reach[k] ?? 0) << bitShift : 0;
            const b = w - wordShift - 1 >= sLoW ? (reach[k - 1] ?? 0) >>> inv : 0;
            reach[dstOff + w] = (reach[dstOff + w] ?? 0) | ((a | b) >>> 0);
          }
        }
        dstSpanLo = lo; dstSpanHi = hi;
      } else {
        const d = -delta;
        const wordShift = d >>> 5;
        const bitShift = d & 31;
        let lo = sLoW - wordShift - (bitShift === 0 ? 0 : 1);
        let hi = sHiW - wordShift;
        if (lo < 0) lo = 0;
        if (hi > WORDS - 1) hi = WORDS - 1;
        if (bitShift === 0) {
          for (let w = lo; w <= hi; w++) reach[dstOff + w] = (reach[dstOff + w] ?? 0) | (reach[srcOff + w + wordShift] ?? 0);
        } else {
          const inv = 32 - bitShift;
          for (let w = lo; w <= hi; w++) {
            const k = srcOff + w + wordShift;
            const a = w + wordShift <= sHiW ? (reach[k] ?? 0) >>> bitShift : 0;
            const b = w + wordShift + 1 <= sHiW ? (reach[k + 1] ?? 0) << inv : 0;
            reach[dstOff + w] = (reach[dstOff + w] ?? 0) | ((a | b) >>> 0);
          }
        }
        dstSpanLo = lo; dstSpanHi = hi;
      }
    };

    // ── FORWARD FILL ─────────────────────────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const curLayer = i * layerWords;
      const nextLayer = (i + 1) * layerWords;
      const wi = wArr[i] ?? 0;
      const canDrop = eligible[i] === true;
      const oc = openCharge[i] ?? 0;
      const cc = closeCharge[i] ?? 0;
      const sLoW = actLoW[i] ?? WORDS;
      const sHiW = actHiW[i] ?? -1;
      if (sHiW < sLoW) continue;
      const live = liveMask[i] ?? 0;
      let nLive = 0;
      let nLoW = WORDS;
      let nHiW = -1;
      for (let s = 0; s < STATES; s++) {
        if ((live & (1 << s)) === 0) continue;
        const srcOff = curLayer + s * WORDS;
        const sDrop = dropMode[s] === 1;
        const kt = keepTgt[s] ?? -1;
        if (kt >= 0) {
          shiftOrRange(nextLayer + kt * WORDS, srcOff, sDrop ? -cc : 0, sLoW, sHiW);
          nLive |= 1 << kt;
          if (dstSpanLo < nLoW) nLoW = dstSpanLo;
          if (dstSpanHi > nHiW) nHiW = dstSpanHi;
        }
        if (canDrop) {
          const dt = dropTgt[s] ?? -1;
          if (dt >= 0) {
            shiftOrRange(nextLayer + dt * WORDS, srcOff, sDrop ? wi : wi - oc, sLoW, sHiW);
            nLive |= 1 << dt;
            if (dstSpanLo < nLoW) nLoW = dstSpanLo;
            if (dstSpanHi > nHiW) nHiW = dstSpanHi;
          }
        }
      }
      liveMask[i + 1] = nLive;
      actLoW[i + 1] = nLoW;
      actHiW[i + 1] = nHiW;
    }

    // ── CHOOSE the net. In-band: smallest effective net in [netMin,netMax]. Else:
    //    effective net nearest the band, smaller net breaking ties. Also record the
    //    smallest effective net strictly above netMax that we saw (aboveSeen). ──────────
    const finalLayer = n * layerWords;
    let chosenState = -1;
    let chosenNetRaw = 0;
    let chosenNet = 0;
    let bandSatisfied = false;
    let bestNet = Infinity;
    let aboveSeen = Infinity;
    const aLo0 = actLoW[n] ?? 0;
    const aHi0 = actHiW[n] ?? -1;
    const aLo = aLo0 < 0 ? 0 : aLo0;
    const aHi = aHi0 < 0 ? -1 : aHi0;
    for (let s = 0; s < STATES; s++) {
      if (acceptOK[s] !== 1) continue;
      const base = finalLayer + s * WORDS;
      const eofAdj = dropMode[s] === 1 ? -eofClose : 0;
      for (let w = aLo; w <= aHi; w++) {
        let bits = reach[base + w] ?? 0;
        while (bits !== 0) {
          const b = bits & -bits;
          const bitIdx = (w << 5) + ctz32(b);
          bits ^= b;
          const eff = bitIdx + windowLo + eofAdj;
          if (eff > netMax && eff < aboveSeen) aboveSeen = eff;
          if (eff >= netMin && eff <= netMax && eff < bestNet) {
            bestNet = eff;
            chosenState = s;
            chosenNetRaw = bitIdx + windowLo;
            chosenNet = eff;
            bandSatisfied = true;
          }
        }
      }
    }
    if (!bandSatisfied) {
      let bestDist = Infinity;
      let bestNetSeen = Infinity;
      for (let s = 0; s < STATES; s++) {
        if (acceptOK[s] !== 1) continue;
        const base = finalLayer + s * WORDS;
        const eofAdj = dropMode[s] === 1 ? -eofClose : 0;
        for (let w = aLo; w <= aHi; w++) {
          let bits = reach[base + w] ?? 0;
          while (bits !== 0) {
            const b = bits & -bits;
            const bitIdx = (w << 5) + ctz32(b);
            bits ^= b;
            const eff = bitIdx + windowLo + eofAdj;
            const dist = eff < netMin ? netMin - eff : eff > netMax ? eff - netMax : 0;
            if (dist < bestDist || (dist === bestDist && eff < bestNetSeen)) {
              bestDist = dist;
              bestNetSeen = eff;
              chosenState = s;
              chosenNetRaw = bitIdx + windowLo;
              chosenNet = eff;
            }
          }
        }
      }
    }
    if (chosenState < 0) throw new Error('selectDropsToBand: no reachable terminal state (internal error).');

    // ── RECONSTRUCT backward, mirroring the forward transitions/deltas. KEEP first. ────
    const drop: boolean[] = new Array(n).fill(false);
    let curState = chosenState;
    let curNet = chosenNetRaw;
    for (let i = n - 1; i >= 0; i--) {
      const layerOff = i * layerWords;
      const wi = wArr[i] ?? 0;
      const oc = openCharge[i] ?? 0;
      const cc = closeCharge[i] ?? 0;
      let found = false;
      for (let p = 0; p < STATES; p++) {
        if (keepTgt[p] !== curState) continue;
        const keepDelta = dropMode[p] === 1 ? -cc : 0;
        const prevNet = curNet - keepDelta;
        if (inWindow(prevNet)) {
          const bi = bitForNet(prevNet);
          if (((reach[layerOff + p * WORDS + (bi >>> 5)] ?? 0) >>> (bi & 31)) & 1) {
            drop[i] = false;
            curState = p;
            curNet = prevNet;
            found = true;
            break;
          }
        }
      }
      if (!found && eligible[i] === true) {
        for (let p = 0; p < STATES; p++) {
          if (dropTgt[p] !== curState) continue;
          const dropDelta = dropMode[p] === 0 ? wi - oc : wi;
          const prevNet = curNet - dropDelta;
          if (inWindow(prevNet)) {
            const bi = bitForNet(prevNet);
            if (((reach[layerOff + p * WORDS + (bi >>> 5)] ?? 0) >>> (bi & 31)) & 1) {
              drop[i] = true;
              curState = p;
              curNet = prevNet;
              found = true;
              break;
            }
          }
        }
      }
      if (!found) throw new Error('selectDropsToBand: reconstruction failed — DP table inconsistency.');
    }
    if (curState !== START || curNet !== 0) {
      throw new Error('selectDropsToBand: reconstruction did not terminate at START with net 0.');
    }

    return { drop, netRemoved: chosenNet, bandSatisfied, aboveSeen, windowHi };
  };

  // ── solveScaled: run `solve` at the smallest net-axis scale g ≥ 1 whose reach table
  //    fits maxReachWords for THIS target's window. g === 1 for every normal file — the
  //    ORIGINAL char-domain arrays pass straight through, so the result is provably
  //    byte-identical to the verified engine. g > 1 only for pathological giant-line files:
  //    a coarsened copy of the net axis (weights, the two marker-charge arrays, the EOF
  //    charge, the window floor, the band) is passed in, the SAME solve runs in bounded
  //    memory, and the controller recomputes the TRUE net from the original integer
  //    weights. The scaled band is tightened by (n+1) scaled units on each side: the
  //    per-line/per-marker rounding drift is < 5n/6 scaled units, so any witness solve
  //    places inside the scaled band has a true net inside [netMin, netMax]; the window is
  //    padded by the same (n+1) so no reachable scaled net falls off either edge. ─────────
  const solveScaled = (windowHiTarget: number) => {
    const windowSpan = windowHiTarget - windowLo + 1;
    const maxWords = Math.max(1, Math.floor(maxReachWords / ((n + 1) * STATES)));
    let g = 1;
    if (windowSpan > maxWords * 32) {
      const denom = maxWords * 32 - 2 * (n + 1); // headroom for the ±(n+1) window padding
      g = denom > 0 ? Math.ceil(windowSpan / denom) : windowSpan;
      // Tighten to the SMALLEST g whose exact padded scaled window fits the ceiling.
      for (;;) {
        if (g <= 1) { g = 1; break; }
        const lo = Math.floor(windowLo / g) - (n + 1);
        const hi = Math.ceil(windowHiTarget / g) + (n + 1);
        const words = Math.max(1, ((hi - lo + 1) + 31) >>> 5);
        if ((n + 1) * STATES * words <= maxReachWords) break;
        g++;
      }
    }
    if (g === 1) {
      const r = solve(windowHiTarget, wArr, openCharge, closeCharge, eofClose, windowLo, netMin, netMax);
      return { drop: r.drop, netRemoved: r.netRemoved, bandSatisfied: r.bandSatisfied, aboveSeen: r.aboveSeen, windowHi: r.windowHi, g };
    }
    const sw = new Int32Array(n);
    const so = new Int32Array(n);
    const sc = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      sw[i] = Math.round((wArr[i] ?? 0) / g);
      so[i] = Math.trunc((openCharge[i] ?? 0) / g); // marker charge rounds toward 0
      sc[i] = Math.trunc((closeCharge[i] ?? 0) / g);
    }
    const r = solve(
      Math.ceil(windowHiTarget / g) + (n + 1),
      sw,
      so,
      sc,
      Math.trunc(eofClose / g),
      Math.floor(windowLo / g) - (n + 1),
      Math.ceil(netMin / g) + (n + 1),
      Math.floor(netMax / g) - (n + 1),
    );
    return { drop: r.drop, netRemoved: r.netRemoved, bandSatisfied: r.bandSatisfied, aboveSeen: r.aboveSeen, windowHi: r.windowHi, g };
  };

  // ── CONTROLLER. Phase 1: the tight slack window (cheap). It is EXACT whenever the
  //    band is feasible (in-band needs only nets ≤ netMax, all captured), and whenever
  //    the true nearest legal net is ≤ the window top. The only case it can miss is an
  //    INFEASIBLE band whose nearest legal net is the smallest reachable value strictly
  //    above the window — which requires a reachable "desert" wider than the slack just
  //    above netMax, i.e. a sparse reachable set (few eligible lines ⇒ small Rcap). In
  //    that case Phase 2 widens to the full reachable range (cheap precisely because it
  //    is sparse) and is exact. We never throw for size; we recompute (or, for a giant-
  //    line file forced into the g > 1 regime, finalize the scaled cut below). ───────────
  const phase1Target = Math.min(trueMaxRaw, netMax + highSlack);
  let chosen = solveScaled(phase1Target);
  // The g === 1 flow here is byte-identical to the verified engine. Phase 1 is exact when
  // the band is feasible OR the true nearest legal net is at-or-below the window top; the
  // only gap is an infeasible band whose smallest reachable net sits in a sparse "desert"
  // beyond the window (few eligible lines ⇒ small range ⇒ Phase 2 is cheap). A scaled
  // (g > 1) Phase 1 already spans the whole in-band region, so it never needs Phase 2 —
  // it is finalized in the scaled branch below.
  if (chosen.g === 1 && !chosen.bandSatisfied) {
    const sawEverything = chosen.windowHi >= trueMaxRaw;
    if (!(sawEverything || Number.isFinite(chosen.aboveSeen))) {
      chosen = solveScaled(trueMaxRaw);
    }
  }
  if (chosen.g === 1) {
    return { drop: chosen.drop, netRemoved: chosen.netRemoved, bandSatisfied: chosen.bandSatisfied };
  }
  // ── SCALED REGIME (g > 1). solve picked a STRUCTURALLY valid selection on the coarsened
  //    net axis; eligibility and the run-length rules are scale-invariant, so only the net
  //    is approximate. Recompute the TRUE net from the ORIGINAL integer weights and the
  //    real markerLen over the chosen gaps — exactly mirroring removalEngine's dropped-
  //    content − marker-chars accounting. Ship the cut ONLY if that true net lands in the
  //    real [netMin, netMax]; otherwise drop nothing, so the rendered output equals the
  //    full file, removal's dropped set is empty, and compressFile's usefulness gate serves
  //    the file raw — never a quantization-skewed out-of-band cut. One return contract:
  //    always a DropSelection, never a null or sentinel. ───────────────────────────────────
  let trueNet = 0;
  let i = 0;
  while (i < n) {
    if (chosen.drop[i] === true) {
      const runStart = i;
      let runEnd = i;
      let sum = 0;
      while (i < n && chosen.drop[i] === true) {
        sum += wArr[i] ?? 0;
        runEnd = i;
        i++;
      }
      trueNet += sum - markerLen(lines[runStart] ?? 0, lines[runEnd] ?? 0);
    } else {
      i++;
    }
  }
  if (trueNet >= netMin && trueNet <= netMax) {
    return { drop: chosen.drop, netRemoved: trueNet, bandSatisfied: true };
  }
  return { drop: new Array<boolean>(n).fill(false), netRemoved: 0, bandSatisfied: 0 >= netMin && 0 <= netMax };
}

/**
 * PHASE-H VERIFICATION (sub-stage 5D) — the trust contract made mechanical.
 *
 * Runs over the FINAL compressed output — the exact string `compressFile` is about to
 * return — and THROWS on ANY violation. That throw is caught at toon's public boundary
 * (index.ts `compressFile`), which degrades to "use raw," so a cut that fails
 * verification is NEVER shipped. It re-derives everything from the output string and
 * the original source INDEPENDENTLY of the engine's own bookkeeping (it re-parses the
 * output rather than trusting removalEngine's flat arrays), so a gate bug cannot hide
 * behind self-consistent metadata. The single most important property is H2: a kept
 * line's number can never lie about its content — that is what makes the output safe to
 * edit against. The original source is the SAME prefixed text the chain compressed, so
 * absolute line k is `originalSource.split('\n')[k-1]` (read_file is the one authority
 * that placed the `N. ` prefix; nothing here recomputes or re-prefixes it).
 *
 *   H1 ELIGIBILITY — every dropped (marker-covered) line had eligible=true, and the
 *      marker coverage equals the gate's recorded dropped set (no protected line cut).
 *   H2 VERBATIM + IDENTITY (KEYSTONE) — every non-marker output line is
 *      character-for-character identical to the original line whose number it carries,
 *      the `N. ` prefix included.
 *   H3 ASCENDING + FULLY ACCOUNTED — the output tiles the original range [1..N] exactly
 *      once: kept numbers strictly ascend, every gap is filled by exactly one marker
 *      whose range is the missing span, no unmarked gap, no marker without a gap, no two
 *      markers adjacent.
 *   H4 OMISSION FLOOR — every marker spans >= 6 lines.
 *   H5 INTERIOR-BLOCK FLOOR — every kept run BETWEEN two markers is >= 6 lines.
 *   H6 BAND — the rendered size recomputed from the output equals the gate's recorded
 *      renderedSize, and lands in [LO, keptCeiling] iff bandSatisfied (else the gate
 *      proved the band infeasible and took the nearest legal cut).
 *   H7 MARKER FORMAT — every marker is exactly `[TRUNCATED: lines <int>-<int>]`,
 *      flush-left (column 0, no leading whitespace, no `#`).
 *
 * Inputs are ONLY the output string, the original source, the gate's own determination,
 * and the char budget — char counts and the eligible booleans, never a score or rank.
 */
export function verifyOutput(
  originalSource: string,
  output: string,
  meta: RemovalMetadata,
  charBudget: number,
): void {
  const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
  const PREFIX_RE = /^(\d+)\. /; // the single N. prefix read_file places; never recomputed here
  const stripPrefix = (s: string): string => s.replace(/^\s*\d+[.:]\s?/, ''); // size only, IDENTICAL to the engines

  const originalLines = originalSource.split('\n');
  const n = originalLines.length;
  const outputLines = output.split('\n');

  // ── Parse the output into an ordered segment list (kept lines + markers). A line
  //    that is neither the exact flush-left marker nor an `N. ` numbered line fails
  //    loud. A TRUNCATED-bearing line that is not the exact marker is a malformed
  //    marker (H7). A kept line that merely CONTAINS "TRUNCATED" still carries its
  //    `N. ` prefix, so it classifies as kept first and is never mistaken for a marker. ─
  type Item = { kind: 'kept'; num: number; text: string } | { kind: 'marker'; x: number; y: number };
  const seq: Item[] = [];
  for (let i = 0; i < outputLines.length; i++) {
    const line = outputLines[i] ?? '';
    const mm = MARKER_RE.exec(line);
    if (mm !== null) {
      seq.push({ kind: 'marker', x: Number(mm[1]), y: Number(mm[2]) });
      continue;
    }
    const pm = PREFIX_RE.exec(line);
    if (pm !== null) {
      seq.push({ kind: 'kept', num: Number(pm[1]), text: line });
      continue;
    }
    if (line.includes('TRUNCATED')) {
      throw new Error(
        'verifyOutput[H7]: malformed truncation marker (must be exactly "[TRUNCATED: lines X-Y]", ' +
          `flush-left, no prefix/indent/#): ${JSON.stringify(line)}`,
      );
    }
    throw new Error(
      `verifyOutput: output line ${i} is neither a marker nor an "N. " numbered line: ${JSON.stringify(line)}`,
    );
  }

  // ── H2: VERBATIM + IDENTITY (the keystone) — each kept line equals the original at
  //    the SAME absolute number, prefix and all. ──────────────────────────────────
  for (const it of seq) {
    if (it.kind !== 'kept') continue;
    const orig = originalLines[it.num - 1];
    if (orig === undefined) {
      throw new Error(`verifyOutput[H2]: kept line claims number ${it.num}, outside the original 1..${n} range.`);
    }
    if (it.text !== orig) {
      throw new Error(
        `verifyOutput[H2]: VERBATIM MISMATCH at line ${it.num} — a kept line's number lies about its content. ` +
          `output=${JSON.stringify(it.text)} original=${JSON.stringify(orig)}`,
      );
    }
  }

  // ── H3: ASCENDING + FULLY ACCOUNTED — the output tiles [1..n] exactly once. ─────
  let expected = 1;
  let prevKeptNum = 0;
  let prevWasMarker = false;
  for (const it of seq) {
    if (it.kind === 'kept') {
      if (it.num !== expected) {
        throw new Error(`verifyOutput[H3]: expected line ${expected} next, got kept line ${it.num} (unaccounted gap or overlap).`);
      }
      if (it.num <= prevKeptNum) {
        throw new Error(`verifyOutput[H3]: kept line numbers not strictly ascending (${it.num} after ${prevKeptNum}).`);
      }
      prevKeptNum = it.num;
      expected = it.num + 1;
      prevWasMarker = false;
    } else {
      if (it.x > it.y) {
        throw new Error(`verifyOutput[H3]: marker range start ${it.x} exceeds end ${it.y}.`);
      }
      if (prevWasMarker) {
        throw new Error(`verifyOutput[H3]: two markers adjacent (empty kept run) at lines ${it.x}-${it.y}.`);
      }
      if (it.x !== expected) {
        throw new Error(`verifyOutput[H3]: expected line ${expected} next, got marker starting at ${it.x} (unaccounted gap or overlap).`);
      }
      expected = it.y + 1;
      prevWasMarker = true;
    }
  }
  if (expected !== n + 1) {
    throw new Error(`verifyOutput[H3]: output accounts for lines 1..${expected - 1}, but the original has ${n} lines (tail unaccounted).`);
  }

  // ── H4: OMISSION FLOOR — every marker spans >= 6 lines. ────────────────────────
  for (const it of seq) {
    if (it.kind !== 'marker') continue;
    const span = it.y - it.x + 1;
    if (span < 6) {
      throw new Error(`verifyOutput[H4]: marker lines ${it.x}-${it.y} spans ${span} < 6 (omission floor).`);
    }
  }

  // ── H5: INTERIOR-BLOCK FLOOR — a kept run with a marker on BOTH sides is >= 6. ──
  for (let i = 0; i < seq.length; i++) {
    const it = seq[i];
    if (it === undefined || it.kind !== 'kept') continue;
    const prev = i > 0 ? seq[i - 1] : undefined;
    if (prev !== undefined && prev.kind === 'kept') continue; // not the start of a run
    let j = i;
    while (j < seq.length) {
      const s = seq[j];
      if (s === undefined || s.kind !== 'kept') break;
      j++;
    }
    const before = i > 0 ? seq[i - 1] : undefined;
    const after = j < seq.length ? seq[j] : undefined;
    const interior = before !== undefined && before.kind === 'marker' && after !== undefined && after.kind === 'marker';
    if (interior && j - i < 6) {
      throw new Error(`verifyOutput[H5]: interior kept run of ${j - i} < 6 lines between two markers.`);
    }
  }

  // ── H1: ELIGIBILITY — marker coverage == gate's dropped set, every dropped line
  //    eligible (no protected line removed). ──────────────────────────────────────
  const covered = new Set<number>();
  for (const it of seq) {
    if (it.kind !== 'marker') continue;
    for (let ln = it.x; ln <= it.y; ln++) covered.add(ln);
  }
  if (covered.size !== meta.dropped.size) {
    throw new Error(`verifyOutput[H1]: marker-covered lines (${covered.size}) != gate's dropped set (${meta.dropped.size}).`);
  }
  for (const ln of covered) {
    if (!meta.dropped.has(ln)) {
      throw new Error(`verifyOutput[H1]: line ${ln} is marker-covered but absent from the gate's dropped set.`);
    }
    if (meta.eligible.get(ln) !== true) {
      throw new Error(`verifyOutput[H1]: dropped line ${ln} was NOT eligible — a protected line was removed.`);
    }
  }

  // ── H6: BAND — rendered recomputed from the output equals the gate's renderedSize,
  //    and lands in [LO, keptCeiling] iff bandSatisfied (else proven-infeasible). ───
  let fullSize = 0;
  for (const l of originalLines) fullSize += stripPrefix(l).length;
  let renderedRecomputed = 0;
  for (const it of seq) {
    if (it.kind === 'kept') renderedRecomputed += stripPrefix(it.text).length;
    else renderedRecomputed += markerLen(it.x, it.y);
  }
  if (renderedRecomputed !== meta.renderedSize) {
    throw new Error(
      `verifyOutput[H6]: rendered size recomputed from the output (${renderedRecomputed}) ` +
        `disagrees with the gate's renderedSize (${meta.renderedSize}).`,
    );
  }
  const LO = Math.ceil(0.68 * fullSize);
  const HI = Math.floor(0.72 * fullSize);
  const keptCeiling = Math.min(HI, charBudget);
  const inBand = meta.renderedSize >= LO && meta.renderedSize <= keptCeiling;
  if (inBand !== meta.bandSatisfied) {
    throw new Error(
      `verifyOutput[H6]: bandSatisfied (${meta.bandSatisfied}) disagrees with whether renderedSize ` +
        `${meta.renderedSize} is inside [${LO}, ${keptCeiling}] (${inBand}).`,
    );
  }
}
