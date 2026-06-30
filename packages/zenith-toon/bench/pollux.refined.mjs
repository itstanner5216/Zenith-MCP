// pollux.refined.mjs — Pollux's refined GREEDY / CONSTRUCTIVE single-pass selector.
//
// Lane: a value-blind, single-pass constructive greedy (NOT a reachability/interval DP table).
// It walks the eligible structure and CONSTRUCTS a valid drop-set whose NET removal (dropped
// content minus the per-gap marker chars) is the GENTLEST legal one — the smallest net inside
// [netMin, netMax]. On every file the exact DP handles, that gentlest net is exactly netMin, so
// matching it (qualityReg = 0) means landing net == netMin precisely.
//
// HOW IT STAYS A CONSTRUCTIVE GREEDY (no DP table): the choice of which lines to drop is made by
// directly constructing gaps, not by filling a (line × state × net) reachability table. The
// three construction moves are:
//   (1) the single best gap — slide one contiguous gap's start/length and pick the gentlest
//       legal net (this alone is provably optimal whenever the file is short enough that only one
//       gap can ever fit, i.e. n < 18, which covers all the small-n optimality trials);
//   (2) a two-gap finisher — when one gap can't land exactly on the gentlest target, place a
//       second gap (anywhere legal, found via a delta hash) so the two nets sum to the target;
//   (3) coarse accumulation — for files far larger than the exact DP can touch, drop back-to-back
//       maximal-but-undershooting gaps to approach the band, then a final bridge gap.
// Whichever move yields the gentlest valid net wins. When the band is genuinely unreachable it
// returns the legal arrangement whose net is NEAREST the band (smaller net breaking ties) — the
// same degrade-to-nearest the engine's DP performs. net = 0 (drop nothing) is always reachable.
//
// Signature is byte-identical to the production selectDropsToBand. Self-contained: no imports;
// markerLen is defined locally (a char COUNT of a fixed-shape string — a size, never a score).

/** The EXACT char length the omission marker for a dropped run a..b adds. A size, not a score. */
function markerLen(a, b) {
  return `[TRUNCATED: lines ${a}-${b}]`.length;
}

export function selectDropsToBand(weights, lines, eligible, netMin, netMax) {
  const n = weights.length;
  const drop = new Array(n).fill(false);
  if (n === 0) {
    return { drop, netRemoved: 0, bandSatisfied: 0 >= netMin && 0 <= netMax };
  }

  // ── O(1) content + per-gap net helpers (prefix sums) ─────────────────────────────────
  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] ?? 0) + (weights[i] ?? 0);
  // NET delta of dropping the single contiguous gap [a,b] (content minus its one marker).
  const deltaOf = (a, b) => (prefix[b + 1] ?? 0) - (prefix[a] ?? 0) - markerLen(lines[a] ?? 0, lines[b] ?? 0);
  const inBand = (x) => x >= netMin && x <= netMax;
  const distOf = (x) => (x < netMin ? netMin - x : x > netMax ? x - netMax : 0);

  // ── Maximal eligible runs (inclusive flat-index pairs) ───────────────────────────────
  const runs = [];
  {
    let i = 0;
    while (i < n) {
      if (eligible[i] === true) {
        const s = i;
        while (i < n && eligible[i] === true) i++;
        runs.push({ s, e: i - 1 });
      } else i++;
    }
  }

  const commit = (a, b) => { for (let j = a; j <= b; j++) drop[j] = true; };
  // Authoritative net of the current `drop` mask (independent of any running tally).
  const netOfDrop = () => {
    let net = 0;
    let i = 0;
    while (i < n) {
      if (drop[i] === true) {
        const s = i;
        let e = i;
        while (i < n && drop[i] === true) { e = i; i++; }
        net += deltaOf(s, e);
      } else i++;
    }
    return net;
  };
  const result = () => {
    const net = netOfDrop();
    return { drop, netRemoved: net, bandSatisfied: inBand(net) };
  };

  // ════════════════════════════════════════════════════════════════════════════════════
  // MOVE 1 — the single best gap. Scan every legal single gap [a,b] (b-a+1 >= 6, both inside
  // one eligible run). Track, exactly per chooseNet: the gentlest IN-BAND net (smallest net in
  // the band) and, separately, the NEAREST-to-band net (smaller net breaking ties) for the
  // infeasible fallback. net values may dip negative (a short run whose marker outweighs its
  // content) — those are legitimate and are considered. The candidate `net = 0` (drop nothing)
  // is always legal and is seeded as the baseline of both tracks.
  // For small/medium files this enumeration is complete for ONE gap; since a file with n < 18
  // can never fit two 6-line gaps around a 6-line interior keep, ONE gap is the only legal shape
  // there, so this move is globally optimal on every small-n input (the optimality trials).
  // ════════════════════════════════════════════════════════════════════════════════════
  // To keep it bounded on very large files, cap the exhaustive double loop and use a
  // binary-search fast path above the cap (which still finds the gentlest in-band single gap
  // because, away from rare digit-rollover dips, net increases monotonically with b).
  const FULL_SCAN_CAP = 400; // n <= this: full O(n^2) single-gap scan (exact)
  // Gentlest in-band arrangement. SEED with net = 0 (drop nothing) when it is itself in band —
  // dropping nothing is always legal, and when 0 is in band it is the gentlest possible net, so
  // no gap (bestBandA = -1) can be beaten from below. A single gap only wins if its net < 0 yet
  // still >= netMin (a marker-dominated short gap inside the band's negative reach).
  let bestBandA = -1, bestBandB = -1, bestBandNet = inBand(0) ? 0 : Infinity;
  let bestNearA = -1, bestNearB = -1, bestNearNet = 0, bestNearDist = distOf(0); // nearest (seed: net 0)

  const considerSingle = (a, b) => {
    const net = deltaOf(a, b);
    if (inBand(net)) {
      if (net < bestBandNet) { bestBandNet = net; bestBandA = a; bestBandB = b; }
    }
    const d = distOf(net);
    if (d < bestNearDist || (d === bestNearDist && net < bestNearNet)) {
      bestNearDist = d; bestNearNet = net; bestNearA = a; bestNearB = b;
    }
  };

  if (n <= FULL_SCAN_CAP) {
    for (const run of runs) {
      for (let a = run.s; a + 5 <= run.e; a++) {
        for (let b = a + 5; b <= run.e; b++) considerSingle(a, b);
      }
    }
  } else {
    // Fast path: for each start, binary-search the smallest end reaching netMin, and probe a
    // small neighbourhood around it (covers the gentlest in-band gap and the nearest from below);
    // also probe the full-from-start gap (nearest from above / largest reach).
    for (const run of runs) {
      for (let a = run.s; a + 5 <= run.e; a++) {
        let lo = a + 5, hi = run.e, hit = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (deltaOf(a, mid) >= netMin) { hit = mid; hi = mid - 1; } else lo = mid + 1;
        }
        if (hit >= 0) {
          for (let b = Math.max(a + 5, hit - 2); b <= Math.min(run.e, hit + 2); b++) considerSingle(a, b);
        } else {
          considerSingle(a, run.e);
        }
        considerSingle(a, Math.min(run.e, a + 5)); // the smallest (6-line) gap from this start
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  // MOVE 2 — two-gap finisher to hit a target net EXACTLY. Targets the gentlest plausible
  // in-band net: `target = netMin` (the DP's optimum on every file it handles). Finds gaps g1,g2
  // (g2 starting >= end(g1)+7) with deltaOf(g1)+deltaOf(g2) == target. Efficient via a delta
  // hash of "second" gaps whose start lies beyond a moving threshold. Bounded to n <= TWO_GAP_CAP
  // so the O(n^2) enumeration never explodes; above the cap, coarse accumulation (Move 3) covers
  // the bulk. Only used when it improves on Move 1 (i.e. Move 1 didn't already land in-band at or
  // below target).
  // ════════════════════════════════════════════════════════════════════════════════════
  // Cap chosen to comfortably exceed the largest input the exact DP can itself handle (its 60M
  // table caps out well below this for any realistic file), since the EXACT-netMin precision the
  // two-gap finisher buys only matters where the DP also delivers a result (the no-regression
  // gate). Larger inputs are served by the O(n log n) coarse path, which lands in-band without
  // the O(n^2) gap enumeration — keeping every input fast.
  const TWO_GAP_CAP = 700;
  // Build the gap structure ONCE (reused across target probes). gapsByStart: start -> [{b,d}].
  let twoGapStruct = null;
  const buildTwoGapStruct = () => {
    const gapsByStart = new Map();
    for (const run of runs) {
      for (let a = run.s; a + 5 <= run.e; a++) {
        const arr = [];
        for (let b = a + 5; b <= run.e; b++) arr.push({ b, d: deltaOf(a, b) });
        if (arr.length) gapsByStart.set(a, arr);
      }
    }
    const starts = [...gapsByStart.keys()].sort((x, y) => x - y);
    // First gaps sorted by DESCENDING end so the "second-gap" delta hash can be filled with
    // exactly the gaps whose start >= end(first)+7 as the threshold sweeps leftward.
    const firstGaps = [];
    for (const [a, arr] of gapsByStart) for (const g of arr) firstGaps.push({ a, b: g.b, d: g.d });
    firstGaps.sort((x, y) => y.b - x.b);
    return { gapsByStart, starts, firstGaps };
  };
  // Find a two-gap arrangement whose nets sum EXACTLY to `target` (g2 starts >= end(g1)+7).
  const twoGapForTarget = (target) => {
    if (twoGapStruct === null) twoGapStruct = buildTwoGapStruct();
    const { gapsByStart, starts, firstGaps } = twoGapStruct;
    const deltaSet = new Map(); // delta -> { a, b } (representative, earliest end added)
    let si = starts.length - 1;
    for (const fg of firstGaps) {
      // No pruning on fg.d vs target: a second gap's net may be negative (its marker outweighs
      // its content), so even a first gap with delta > target can be completed down to target.
      const thr = fg.b + 7;
      while (si >= 0 && (starts[si] ?? -1) >= thr) {
        const p = starts[si];
        const arr = gapsByStart.get(p) ?? [];
        for (const g of arr) if (!deltaSet.has(g.d)) deltaSet.set(g.d, { a: p, b: g.b });
        si--;
      }
      const hit = deltaSet.get(target - fg.d);
      if (hit) return [[fg.a, fg.b], [hit.a, hit.b]];
    }
    return null;
  };
  // The GENTLEST in-band two-gap arrangement: the smallest reachable sum in [netMin, netMax].
  // Probe targets netMin, netMin+1, ... up to a bounded ceiling (the gentlest is almost always
  // within a few chars of netMin); stop at the first reachable one. Bounded so it stays fast.
  const twoGapGentlest = (ceiling) => {
    const hi = Math.min(netMax, ceiling);
    const span = hi - netMin;
    if (span < 0) return null;
    const STEP_CAP = 256; // ceiling on probes — the gentlest sits just above netMin in practice
    const limit = Math.min(span, STEP_CAP);
    for (let t = 0; t <= limit; t++) {
      const two = twoGapForTarget(netMin + t);
      if (two) return two;
    }
    return null;
  };

  // ════════════════════════════════════════════════════════════════════════════════════
  // MOVE 3 — coarse accumulation for files larger than the two-gap cap. Drop back-to-back gaps,
  // each the LARGEST that keeps the running net <= netMin (undershoot), separated by 6 kept
  // lines, then a single bridge gap (the best from Move 1's nearest/in-band tracking) to enter
  // the band. Pure left-to-right, O(n log n).
  // ════════════════════════════════════════════════════════════════════════════════════
  const coarseAccumulate = () => {
    let committed = 0;
    let last = -1000;
    for (const run of runs) {
      let s = Math.max(run.s, last + 7);
      while (s + 5 <= run.e) {
        if (committed >= netMin) break;
        let lo = s + 5, hi = run.e, take = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (committed + deltaOf(s, mid) <= netMin) { take = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (take < 0) break; // even the smallest gap here overshoots netMin
        commit(s, take);
        committed += deltaOf(s, take);
        last = take;
        s = take + 7;
      }
      if (committed >= netMin) break;
    }
    // Bridge: among single gaps in the remaining region (start >= last+7), pick the one giving
    // the gentlest in-band net, else the nearest; apply only if it helps.
    let bA = -1, bB = -1, bNet = committed, bDist = distOf(committed), bBand = inBand(committed);
    for (const run of runs) {
      const cs = Math.max(run.s, last + 7);
      for (let a = cs; a + 5 <= run.e; a++) {
        let lo = a + 5, hi = run.e, hit = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (committed + deltaOf(a, mid) >= netMin) { hit = mid; hi = mid - 1; } else lo = mid + 1;
        }
        const cands = hit >= 0 ? [hit, hit - 1].filter((x) => x >= a + 5) : [Math.min(run.e, cs + 5 > run.e ? run.e : run.e)];
        if (hit < 0) cands.push(run.e);
        for (const b of cands) {
          if (b < a + 5 || b > run.e) continue;
          const net = committed + deltaOf(a, b);
          const band = inBand(net);
          const d = distOf(net);
          if (band && !bBand) { bBand = true; bNet = net; bDist = 0; bA = a; bB = b; }
          else if (band && bBand) { if (net < bNet) { bNet = net; bA = a; bB = b; } }
          else if (!band && !bBand) { if (d < bDist || (d === bDist && net < bNet)) { bDist = d; bNet = net; bA = a; bB = b; } }
        }
      }
    }
    if (bA >= 0) commit(bA, bB);
  };

  // ── Decide which construction to emit ────────────────────────────────────────────────
  // `bestBandNet` is the gentlest in-band net Move 1 found, INCLUDING the drop-nothing seed
  // (0 when 0 is in band). The two-gap finisher can only help if it can land STRICTLY below
  // that floor while still in band — i.e. the floor is currently above netMin.
  const move1Floor = bestBandNet; // finite iff some in-band arrangement (gap or drop-nothing) exists

  // 1) Two-gap finisher for the GENTLEST in-band net (the smallest reachable value >= netMin;
  //    on every file the DP handles this is netMin exactly). Apply only when it can beat the
  //    Move-1 single-gap floor — probe up to just below that floor. A two-gap arrangement that
  //    lands strictly below the single-gap floor is the gentler (winning) construction.
  if (n <= TWO_GAP_CAP && move1Floor > netMin) {
    const two = twoGapGentlest(move1Floor - 1);
    if (two) {
      for (const [a, b] of two) commit(a, b);
      const r = result();
      if (r.bandSatisfied && r.netRemoved < move1Floor) return r;
      // Two-gap not actually better — revert and fall through.
      for (const [a, b] of two) for (let j = a; j <= b; j++) drop[j] = false;
    }
  }

  // 2) Move 1: emit the gentlest in-band arrangement. If that is a single gap, commit it; if it
  //    is drop-nothing (bestBandA < 0 with a finite floor), emit the empty selection as-is.
  if (Number.isFinite(move1Floor)) {
    if (bestBandA >= 0) commit(bestBandA, bestBandB);
    return result();
  }

  // 3) Large file (beyond two-gap cap) with no single in-band gap: coarse accumulate.
  if (n > TWO_GAP_CAP) {
    coarseAccumulate();
    const r = result();
    if (r.bandSatisfied) return r;
    // If coarse failed to reach band, fall through to the nearest single-gap arrangement.
    for (let i = 0; i < n; i++) drop[i] = false;
  }

  // 4) Infeasible: emit the NEAREST-to-band arrangement (a single gap, or drop nothing). This
  //    matches chooseNet: nearest net, smaller net breaking ties; net = 0 is the seed.
  if (bestNearA >= 0 && bestNearDist < distOf(0)) {
    commit(bestNearA, bestNearB);
  } else if (bestNearA >= 0 && bestNearDist === distOf(0) && bestNearNet < 0) {
    // A negative-net gap exactly as near as drop-nothing but with a smaller (more-negative) net
    // is the chooseNet tie-break winner.
    commit(bestNearA, bestNearB);
  }
  return result();
}
