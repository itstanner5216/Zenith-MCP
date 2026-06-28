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
// per gap. The Phase-H line-fidelity verification and wiring `compressFile` to RETURN
// this output remain sub-stage 5D (it still returns null for now — this proves the
// rendered selection on the payload, it does not yet surface it to the caller).

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

  // Rcap = the most CONTENT we could ever remove = Σ weight over ELIGIBLE lines (only
  // eligible lines may be dropped); it bounds net on the high side (net <= dropped
  // content <= Rcap). Every number this DP touches is either a char COUNT (a size) or
  // the eligible boolean — never an importance score.
  let Rcap = 0;
  let maxLine = 0;
  for (let i = 0; i < n; i++) {
    if (eligible[i] === true) Rcap += weights[i] ?? 0; // Rule 6: guard the index, no '!'
    const li = lines[i] ?? 0;
    if (li > maxLine) maxLine = li;
  }

  // OFFSET bounds how negative net can get mid-pass: net >= −(total marker cost ever
  // charged). A valid path opens at most ⌊n/6⌋+1 gaps (each closed run is >= 6 lines,
  // plus one possibly-open trailing run), and each marker costs at most
  // markerFixed + 2·digits(maxLine). Indexing net at (net + OFFSET) keeps it >= 0. ──
  const maxGaps = Math.floor(n / 6) + 1;
  const markerMax = markerFixed + 2 * digits(maxLine);
  const OFFSET = maxGaps * markerMax;
  const maxIdx = Rcap + OFFSET; // largest net index (net = Rcap)
  const netSpan = maxIdx + 1;

  // State encoding. mode 0 = keeping (K), 1 = dropping (D). sawDrop 0/1. runIdx 0..5.
  //   sidx(mode, sawDrop, runIdx) = ((mode*2)+sawDrop)*6 + runIdx, range 0..23.
  //   START (no run decided yet) = 24.
  const STATES = 25;
  const START = 24;
  const KEEP = 0;
  const DROP = 1;
  const sidx = (mode: number, sawDrop: number, runIdx: number): number => (mode * 2 + sawDrop) * 6 + runIdx;
  const isDropMode = (s: number): boolean => {
    if (s === START) return false;
    return Math.floor(Math.floor(s / 6) / 2) === DROP;
  };

  // ── RESOURCE GUARD ────────────────────────────────────────────────────────────
  // The exact band-targeting DP is pseudo-polynomial: its reachability table is
  // (n+1) × STATES × netSpan cells, where netSpan ≈ Rcap (removable content chars)
  // plus the small marker OFFSET. For typical source files that is small; for a
  // pathologically large file it would exhaust memory (or hang) on its way to a
  // result the caller currently discards. Refuse such an input LOUDLY rather than
  // crash — compressFile's catch boundary turns this throw into the "use raw"
  // signal, identical to today's behaviour for those files (no regression) and never
  // a wrong answer or a relaxed rule. AGENTS.md wants bounded operations; this is
  // the bound. (Large-file PERFORMANCE — making such files compress rather than fall
  // back — is a separate, deliberate concern, not this sub-stage's.)
  const MAX_CELLS = 60_000_000; // ~60MB as Uint8Array, transient and freed per call
  if ((n + 1) * STATES * netSpan > MAX_CELLS) {
    throw new Error(
      `selectDropsToBand: input exceeds the exact-DP size bound ` +
        `(${n} lines × ${netSpan} net-char states > ${MAX_CELLS} cells). ` +
        `Degrades to raw upstream.`,
    );
  }

  // The DP's transition relation — the SINGLE source of truth for VALIDITY, used by
  // both the forward fill and the backward reconstruction so they can never diverge.
  // (The net DELTA for each transition is computed alongside, from the per-line
  // marker charges below.) keepTarget(s): state after KEEPING a line from s, or -1.
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

  // ── FORWARD FILL. reach[i] is a Uint8Array of STATES*netSpan flags;
  //    reach[i][s*netSpan + (net + OFFSET)] === 1 iff, after deciding lines 0..i-1,
  //    we can be in state s having NET-removed exactly `net` chars. (Typed-array
  //    reads return a number, so only the outer Array<Uint8Array> needs a guard.) ───
  const reach: Array<Uint8Array> = new Array(n + 1);
  for (let i = 0; i <= n; i++) reach[i] = new Uint8Array(STATES * netSpan);
  const layer0 = reach[0];
  if (layer0 === undefined) throw new Error('selectDropsToBand: layer allocation failed.');
  layer0[START * netSpan + OFFSET] = 1; // before any line: at START, net 0 (index OFFSET)

  for (let i = 0; i < n; i++) {
    const cur = reach[i];
    const next = reach[i + 1];
    if (cur === undefined || next === undefined) continue; // Rule 6 guard (i is in range)
    const wi = weights[i] ?? 0;
    const canDrop = eligible[i] === true;
    // Per-line marker charges (computed once per line, not per cell):
    //   openCharge — charged when a gap OPENS at line i (start line = lines[i]);
    //   closeCharge — charged when a gap CLOSES at line i (end line = lines[i-1]).
    const openCharge = markerFixed + digits(lines[i] ?? 0);
    const closeCharge = i >= 1 ? digits(lines[i - 1] ?? 0) : 0;
    for (let s = 0; s < STATES; s++) {
      const kt = keepTarget(s);
      const dt = canDrop ? dropTarget(s) : -1;
      if (kt < 0 && dt < 0) continue;
      const keepCloses = kt >= 0 && isDropMode(s); // keeping after a D run closes it
      const dropOpens = dt >= 0 && !isDropMode(s); // dropping from K/START opens a run
      const keepDelta = keepCloses ? -closeCharge : 0;
      const dropDelta = dropOpens ? wi - openCharge : wi;
      const base = s * netSpan;
      for (let r = 0; r <= maxIdx; r++) {
        if (cur[base + r] !== 1) continue;
        if (kt >= 0) {
          const nr = r + keepDelta;
          if (nr >= 0 && nr <= maxIdx) next[kt * netSpan + nr] = 1;
        }
        if (dt >= 0) {
          const nr = r + dropDelta;
          if (nr >= 0 && nr <= maxIdx) next[dt * netSpan + nr] = 1;
        }
      }
    }
  }

  const reachN = reach[n];
  if (reachN === undefined) throw new Error('selectDropsToBand: final layer missing.');

  // A D-run that runs to end-of-file closes THERE (its end line is the last line),
  // so accepting D-states owe one final close charge that no transition applied.
  const eofClose = digits(lines[n - 1] ?? 0);
  const effectiveNet = (s: number, idx: number): number =>
    idx - OFFSET - (isDropMode(s) ? eofClose : 0);

  // ── CHOOSE the net. In-band: the SMALLEST effective net in [netMin, netMax]
  //    (gentlest). Otherwise (infeasible): the effective net NEAREST the band,
  //    smaller net breaking ties. net=0 (drop-nothing) is always reachable, so a
  //    choice always exists. Iterating states then indices ascending makes the
  //    representative for any chosen net deterministic (lowest state, lowest index). ─
  let chosenIdx = -1; // the TRACKED reachability index (pre EOF-close) to reconstruct from
  let chosenState = -1;
  let chosenNet = 0; // the EFFECTIVE net removed (what we return / band-check)
  let bandSatisfied = false;
  let bestNet = Infinity;
  for (let s = 0; s < STATES; s++) {
    if (!accepting(s)) continue;
    const base = s * netSpan;
    for (let idx = 0; idx <= maxIdx; idx++) {
      if (reachN[base + idx] !== 1) continue;
      const eff = effectiveNet(s, idx);
      if (eff >= netMin && eff <= netMax && eff < bestNet) {
        bestNet = eff;
        chosenIdx = idx;
        chosenState = s;
        chosenNet = eff;
        bandSatisfied = true;
      }
    }
  }
  if (!bandSatisfied) {
    let bestDist = Infinity;
    let bestNetSeen = Infinity;
    for (let s = 0; s < STATES; s++) {
      if (!accepting(s)) continue;
      const base = s * netSpan;
      for (let idx = 0; idx <= maxIdx; idx++) {
        if (reachN[base + idx] !== 1) continue;
        const eff = effectiveNet(s, idx);
        const dist = eff < netMin ? netMin - eff : eff > netMax ? eff - netMax : 0;
        if (dist < bestDist || (dist === bestDist && eff < bestNetSeen)) {
          bestDist = dist;
          bestNetSeen = eff;
          chosenIdx = idx;
          chosenState = s;
          chosenNet = eff;
        }
      }
    }
  }
  if (chosenState < 0) throw new Error('selectDropsToBand: no reachable terminal state (internal error).');

  // ── RECONSTRUCT. Walk backward from (n, chosenState, chosenIdx), at each line
  //    finding a predecessor consistent with the forward table — mirroring the SAME
  //    transitions and net deltas. KEEP is tried first (deterministic, and the
  //    gentlest move at the margin); a reachable predecessor always exists, so the
  //    walk never stalls and ends at START with net 0 (index OFFSET). ───────────────
  const drop: boolean[] = new Array(n).fill(false);
  let curState = chosenState;
  let curIdx = chosenIdx;
  for (let i = n - 1; i >= 0; i--) {
    const li = reach[i];
    if (li === undefined) throw new Error('selectDropsToBand: layer missing during reconstruction.');
    const wi = weights[i] ?? 0;
    const openCharge = markerFixed + digits(lines[i] ?? 0);
    const closeCharge = i >= 1 ? digits(lines[i - 1] ?? 0) : 0;
    let found = false;
    // KEEP predecessor: keepTarget(p) === curState; its net delta is -closeCharge if
    // p was dropping (the keep closes that run), else 0.
    for (let p = 0; p < STATES; p++) {
      if (keepTarget(p) !== curState) continue;
      const keepDelta = isDropMode(p) ? -closeCharge : 0;
      const prevIdx = curIdx - keepDelta;
      if (prevIdx >= 0 && prevIdx <= maxIdx && li[p * netSpan + prevIdx] === 1) {
        drop[i] = false;
        curState = p;
        curIdx = prevIdx;
        found = true;
        break;
      }
    }
    if (!found && eligible[i] === true) {
      // DROP predecessor: dropTarget(p) === curState; its net delta is wi - openCharge
      // if p was keeping/START (the drop opens a run), else wi (extends a run).
      for (let p = 0; p < STATES; p++) {
        if (dropTarget(p) !== curState) continue;
        const dropDelta = !isDropMode(p) ? wi - openCharge : wi;
        const prevIdx = curIdx - dropDelta;
        if (prevIdx >= 0 && prevIdx <= maxIdx && li[p * netSpan + prevIdx] === 1) {
          drop[i] = true;
          curState = p;
          curIdx = prevIdx;
          found = true;
          break;
        }
      }
    }
    if (!found) throw new Error('selectDropsToBand: reconstruction failed — DP table inconsistency.');
  }
  if (curState !== START || curIdx !== OFFSET) {
    throw new Error('selectDropsToBand: reconstruction did not terminate at START with net 0.');
  }

  return { drop, netRemoved: chosenNet, bandSatisfied };
}
