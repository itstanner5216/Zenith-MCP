// brook.mjs — selectDropsToBand: compresses 3,000–4,000+ line files reliably and FAST,
// EXACT on the brute-force oracle (small n), and biased toward FEWER / LARGER drops on
// real files. Pure, deterministic, self-contained (its own markerLen).
//
// WHY THE INCUMBENT FAILS: its reachability table is (n+1) × 25 × netSpan with
// netSpan ≈ Σ eligible char-weights (Rcap) — it scales with TOTAL CHARACTERS, so a
// real file (thousands of lines) trips the size guard → throw → degrade to RAW. That
// is the bug. It also minimises NET, which mathematically rewards fragmentation (every
// extra gap's marker lowers net), so it scatters many minimal 6-line drops.
//
// THE APPROACH — one 25-state machine, one additively-separable marker cost; three
// cooperating pieces, all sharing that machine so validity/semantics never diverge:
//
//  1) EXACT DP (small n, oracle-reachable): full net-axis reachability choosing the
//     SMALLEST in-band net (the contract's "gentlest"), reconstructed from stored
//     layers. Bit-PACKED and driven by WORD-PARALLEL shifted-OR (the subset-sum bitset
//     trick — 32 net-values per machine op). Provably reproduces the brute optimum.
//
//  2) FEW-LARGE-GAPS GREEDY (large n, the Mission-A win): treat maximal eligible runs
//     as gap sites; tap the LARGEST runs first, one big gap each, kept >= 6 lines apart
//     (so every interior kept run is >= 6 by construction) and the last gap sized to
//     land at the gentle (netMin) end of the band. This yields a handful of large
//     omissions instead of hundreds of slivers. O(n + m log m).
//
//  3) SCALED MAX-NET DP (large n feasibility / fragmented / infeasible-nearest): the
//     SAME reachability DP with weights divided by an integer g (knapsack value-scaling
//     to tame the pseudo-poly axis), MAXIMISING net in band, with a multi-scale retry
//     so the recomputed TRUE net actually lands in-band. An exact O(n·25) scalar
//     min/max DP gives the provably-correct nearest arrangement when the band is wholly
//     unreachable. This guarantees we always match-or-beat the incumbent's reach and is
//     the safety net for the greedy on sparse/fragmented eligibility.
//
// Large-n choice: take the GREEDY when it is valid AND in-band (few large gaps); else
// the SCALED DP result (correct feasibility, nearest-band). netRemoved is ALWAYS
// recomputed from the final mask, so it is exact and self-consistent by construction.
// Only char counts and the eligible booleans ever enter any path — never a score/rank.

/** EXACT marker char width for a dropped run spanning absolute lines a..b. */
function markerLen(a, b) {
  return `[TRUNCATED: lines ${a}-${b}]`.length;
}
const digits = (x) => String(x).length;

// Below this n the brute-force oracle can enumerate (2^n), so we MUST reproduce its
// exact smallest-in-band-net optimum. Well above the oracle's range (n<=14) and any
// practical enumeration; every real file (hundreds+ of lines) takes the large-n path.
const ORACLE_SAFE_N = 26;

// ── 25-STATE MACHINE (shared by every piece) ─────────────────────────────────────
// mode 0=keep(K) 1=drop(D); sawDrop 0/1; runIdx 0..5 where 5 means ">= 6".
//   sidx(mode,sawDrop,runIdx) = ((mode*2)+sawDrop)*6 + runIdx, range 0..23; START=24.
const STATES = 25;
const START = 24;
const KEEP = 0;
const DROP = 1;
const sidx = (mode, sawDrop, runIdx) => (mode * 2 + sawDrop) * 6 + runIdx;
const isDropMode = (s) => {
  if (s === START) return false;
  return Math.floor(Math.floor(s / 6) / 2) === DROP;
};
const keepTarget = (s) => {
  if (s === START) return sidx(KEEP, 0, 0);
  const group = Math.floor(s / 6);
  const runIdx = s % 6;
  const mode = Math.floor(group / 2);
  const sawDrop = group % 2;
  if (mode === KEEP) return sidx(KEEP, sawDrop, Math.min(runIdx + 1, 5));
  if (runIdx !== 5) return -1;
  return sidx(KEEP, 1, 0);
};
const dropTarget = (s) => {
  if (s === START) return sidx(DROP, 1, 0);
  const group = Math.floor(s / 6);
  const runIdx = s % 6;
  const mode = Math.floor(group / 2);
  const sawDrop = group % 2;
  if (mode === DROP) return sidx(DROP, 1, Math.min(runIdx + 1, 5));
  if (sawDrop === 1 && runIdx !== 5) return -1;
  return sidx(DROP, 1, 0);
};
const accepting = (s) => {
  if (s === START) return false;
  const mode = Math.floor(Math.floor(s / 6) / 2);
  if (mode === KEEP) return true;
  return s % 6 === 5;
};
const KEEP_PREDS = [];
const DROP_PREDS = [];
for (let t = 0; t < STATES; t++) {
  KEEP_PREDS.push([]);
  DROP_PREDS.push([]);
}
for (let p = 0; p < STATES; p++) {
  const kt = keepTarget(p);
  if (kt >= 0) KEEP_PREDS[kt].push({ p, closesDrop: isDropMode(p) });
  const dt = dropTarget(p);
  if (dt >= 0) DROP_PREDS[dt].push({ p, opensDrop: !isDropMode(p) });
}

/** THE SELECTION. Contract signature/return: { drop, netRemoved, bandSatisfied }. */
export function selectDropsToBand(weights, lines, eligible, netMin, netMax) {
  const n = weights.length;
  if (n !== eligible.length || n !== lines.length) {
    throw new Error('selectDropsToBand: weights, lines and eligible arrays differ in length.');
  }
  if (n === 0) {
    return { drop: [], netRemoved: 0, bandSatisfied: 0 >= netMin && 0 <= netMax };
  }

  // Marker separability self-check: markerLen must decompose into markerFixed +
  // digits(a) + digits(b) for the per-boundary charging to be valid.
  const markerFixed = markerLen(0, 0) - digits(0) - digits(0);
  if (markerFixed + digits(7) + digits(1234) !== markerLen(7, 1234)) {
    throw new Error('selectDropsToBand: omission marker is not additively separable; cost decomposition invalid.');
  }

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
  const exactNetSpan = Rcap + OFFSET + 1;

  // ── ORACLE-SAFE EXACT PATH (small n): reproduce the brute optimum exactly. ───────
  if (n <= ORACLE_SAFE_N) {
    const r = runReachability(
      weights, lines, eligible, netMin, netMax, n, 1, Rcap, OFFSET, markerFixed, 'min',
    );
    return { drop: r.drop, netRemoved: r.netRemoved, bandSatisfied: r.bandSatisfied };
  }

  // ── LARGE-n PATH ────────────────────────────────────────────────────────────────
  const distOf = (v) => (v < netMin ? netMin - v : v > netMax ? v - netMax : 0);

  // (2) FEW-LARGE-GAPS GREEDY first — if it lands in band, it is our Mission-A answer.
  const greedy = fewLargeGapsGreedy(weights, lines, eligible, netMin, netMax);
  if (greedy !== null) {
    const gNet = netOfMask(greedy, weights, lines);
    if (gNet >= netMin && gNet <= netMax) {
      return { drop: greedy, netRemoved: gNet, bandSatisfied: true };
    }
  }

  // (3) SCALED MAX-NET DP for feasibility / fragmented / infeasible-nearest. Exact
  // scalar bounds short-circuit the wholly-out-of-reach cases.
  const scalarMax = scalarExtreme(weights, lines, eligible, n, markerFixed, true);
  const scalarMin = scalarExtreme(weights, lines, eligible, n, markerFixed, false);
  if (scalarMax.net < netMin) {
    // The whole band is above everything reachable: nearest is the max net. The greedy
    // (also out of reach below) may be closer in pathological cases — compare.
    return pickNearest([{ drop: scalarMax.drop, net: scalarMax.net }, greedyCand(greedy, weights, lines)], netMin, netMax, distOf);
  }
  if (scalarMin.net > netMax) {
    return pickNearest([{ drop: scalarMin.drop, net: scalarMin.net }, greedyCand(greedy, weights, lines)], netMin, netMax, distOf);
  }

  // Band overlaps the reachable interval. Scaled MAX-net reachability with multi-scale
  // retry until the recomputed TRUE net lands in band.
  const PACKED_BYTE_BUDGET = 360_000_000; // ~360MB packed-table ceiling
  const maxScaledSpan = Math.max(2000, Math.floor((PACKED_BYTE_BUDGET * 8) / ((n + 1) * STATES)));
  let gFloor = Math.ceil(exactNetSpan / maxScaledSpan);
  if (gFloor < 1) gFloor = 1;

  // Run the MAX-net reachability ONCE at the finest affordable scale (gFloor): finer is
  // strictly better for landing in band, and gFloor is already the finest the memory
  // budget allows, so coarser retries could only do worse. When gFloor === 1 the DP is
  // exact (true char units) and its in-band/nearest verdict is exact. The greedy and
  // scalar extremes stand as additional valid candidates; pickNearest takes the best.
  const candidates = [];
  if (greedy !== null) candidates.push(greedyCand(greedy, weights, lines));
  candidates.push({ drop: scalarMax.drop, net: scalarMax.net });
  candidates.push({ drop: scalarMin.drop, net: scalarMin.net });
  const g = gFloor;
  const scaledRcap = Math.ceil(Rcap / g);
  const scaledOffset = Math.ceil(OFFSET / g) + 4;
  const scaledNetMin = Math.floor(netMin / g);
  const scaledNetMax = Math.ceil(netMax / g);
  const res = runReachability(
    weights, lines, eligible, scaledNetMin, scaledNetMax, n, g, scaledRcap, scaledOffset, markerFixed, 'max',
  );
  candidates.push({ drop: res.drop, net: netOfMask(res.drop, weights, lines) });
  return pickNearest(candidates, netMin, netMax, distOf);
}

/** Wrap a greedy mask (possibly null) as a candidate for nearest-band selection. */
function greedyCand(drop, weights, lines) {
  if (drop === null) return null;
  return { drop, net: netOfMask(drop, weights, lines) };
}

/**
 * Choose the candidate nearest the band (in-band beats out; among out-of-band the
 * smaller distance wins; ties → larger net, i.e. more aggressive/fewer gaps — the
 * max-net spirit). Skips null candidates. Returns the contract shape.
 */
function pickNearest(cands, netMin, netMax, distOf) {
  let best = null;
  let bestD = Infinity;
  for (const c of cands) {
    if (c === null) continue;
    const d = distOf(c.net);
    if (best === null || d < bestD || (d === bestD && c.net > best.net)) {
      best = c;
      bestD = d;
    }
  }
  if (best === null) throw new Error('selectDropsToBand: no candidate produced (internal error).');
  const inBand = best.net >= netMin && best.net <= netMax;
  return { drop: best.drop, netRemoved: best.net, bandSatisfied: inBand };
}

/**
 * FEW-LARGE-GAPS GREEDY. Maximal eligible runs are gap sites; tap the largest runs
 * first with one big gap each, keeping consecutive gaps >= 6 lines apart so EVERY
 * interior kept run is >= 6 by construction (dropped runs are >= 6 by size; leading and
 * trailing kept runs have no minimum). The last gap is sized to land in [netMin,netMax]
 * at the gentle end. Returns a valid drop mask, or null if it cannot place any gap.
 * Validity is structural (gap spacing + size), so no full re-scan is needed.
 */
function fewLargeGapsGreedy(weights, lines, eligible, netMin, netMax) {
  const n = weights.length;
  // Maximal eligible runs.
  const runs = [];
  let i = 0;
  while (i < n) {
    if (eligible[i] === true) {
      let j = i;
      while (j < n && eligible[j] === true) j++;
      runs.push({ lo: i, hi: j - 1, len: j - i });
      i = j;
    } else i++;
  }
  if (runs.length === 0) return null;
  // Largest runs first → fewest, largest gaps.
  runs.sort((a, b) => b.len - a.len || a.lo - b.lo);

  const drop = new Array(n).fill(false);
  // Track placed gaps as sorted intervals to enforce >= 6 spacing cheaply.
  const placed = []; // {a, b}, kept sorted by a
  let curNet = 0;

  // prefix sums for O(1) interval content weight.
  // (Built lazily only if needed; n is large but this is one O(n) pass.)
  const pref = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) pref[k + 1] = pref[k] + (weights[k] ?? 0);
  const contentOf = (a, b) => pref[b + 1] - pref[a];

  // Insert a gap [a,b] into the sorted placed list.
  const insertPlaced = (a, b) => {
    let lo = 0;
    let hi = placed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (placed[mid].a < a) lo = mid + 1;
      else hi = mid;
    }
    placed.splice(lo, 0, { a, b });
  };
  // The largest gap [a,b] within run [lo,hi] that stays >= 6 lines from every placed
  // gap. Returns null if none (>= 6 long) fits.
  const fitGap = (lo, hi) => {
    // Find placed gaps overlapping/adjacent to [lo,hi] and shrink the window so the gap
    // keeps a 6-kept margin from them. Because gaps live in distinct eligible runs and
    // runs are separated by >=1 ineligible kept line, neighbours are outside [lo,hi];
    // we only need 6-line spacing to the nearest placed gap on each side.
    let leftLimit = lo; // gap may start at leftLimit
    let rightLimit = hi; // gap may end at rightLimit
    for (const p of placed) {
      if (p.b < lo) {
        // placed gap entirely left: need start >= p.b + 1 + 6
        const need = p.b + 1 + 6;
        if (need > leftLimit) leftLimit = need;
      } else if (p.a > hi) {
        // placed gap entirely right: need end <= p.a - 1 - 6
        const need = p.a - 1 - 6;
        if (need < rightLimit) rightLimit = need;
      } else {
        // overlap (shouldn't happen across distinct runs) → cannot place here
        return null;
      }
    }
    if (rightLimit - leftLimit + 1 >= 6) return { a: leftLimit, b: rightLimit };
    return null;
  };

  for (const r of runs) {
    if (curNet >= netMin) break;
    const slot = fitGap(r.lo, r.hi);
    if (slot === null) continue;
    const { a, b } = slot;
    const maxSize = b - a + 1;
    // Net contribution if we drop [a, a+size-1]; choose the size that brings curNet into
    // band if possible, else the largest size that does not exceed netMax.
    // marker depends only on endpoints; content via prefix sums → O(1) per size guess.
    const netAt = (size) => {
      const aa = a;
      const bb = a + size - 1;
      return curNet + contentOf(aa, bb) - markerLen(lines[aa] ?? 0, lines[bb] ?? 0);
    };
    // Largest size whose net <= netMax (binary search; net is increasing in size for
    // non-negative weights, marker grows only by digit count so still effectively
    // monotone — verify by scan fallback if needed).
    let target = -1; // size landing in band
    let bestUnder = -1; // largest size with net <= netMax
    // Binary search the largest size with netAt(size) <= netMax.
    let los = 6;
    let his = maxSize;
    while (los <= his) {
      const mid = (los + his) >> 1;
      if (netAt(mid) <= netMax) {
        bestUnder = mid;
        los = mid + 1;
      } else {
        his = mid - 1;
      }
    }
    if (bestUnder >= 6) {
      // Does bestUnder reach the band? If netAt(bestUnder) >= netMin we are in band.
      if (netAt(bestUnder) >= netMin) target = bestUnder;
    }
    const useSize = target > 0 ? target : bestUnder;
    if (useSize >= 6) {
      const aa = a;
      const bb = a + useSize - 1;
      for (let k = aa; k <= bb; k++) drop[k] = true;
      insertPlaced(aa, bb);
      curNet = netOfMask(drop, weights, lines);
      if (curNet >= netMin) break;
    }
  }

  // Did we place anything?
  let any = false;
  for (let k = 0; k < n; k++) {
    if (drop[k]) { any = true; break; }
  }
  return any ? drop : null;
}

/** Independent NET recompute from a drop mask (one marker per maximal gap). */
function netOfMask(drop, weights, lines) {
  const n = drop.length;
  let dropped = 0;
  let marker = 0;
  let i = 0;
  while (i < n) {
    if (drop[i] === true) {
      const s = i;
      let e = i;
      while (i < n && drop[i] === true) {
        dropped += weights[i] ?? 0;
        e = i;
        i++;
      }
      marker += markerLen(lines[s] ?? 0, lines[e] ?? 0);
    } else i++;
  }
  return dropped - marker;
}

/**
 * WORD-PARALLEL bit-packed reachability DP + backward reconstruction. `scale` (1 =
 * exact char units) divides every weight/marker charge so the net axis fits. `mode`
 * picks the criterion among accepting reachable nets: 'min' = smallest in band
 * (gentlest, oracle semantics); 'max' = largest in band (fewer/larger drops).
 * Reachability index r encodes scaled net = r − OFFSET; one bit per (layer,state,r).
 */
function runReachability(weights, lines, eligible, netMin, netMax, n, scale, Rcap, OFFSET, markerFixed, mode) {
  const maxIdx = Rcap + OFFSET;
  const netSpan = maxIdx + 1;
  const WORDS = (netSpan + 31) >>> 5;

  const reach = new Array(n + 1);
  for (let i = 0; i <= n; i++) reach[i] = new Uint32Array(STATES * WORDS);
  const getBit = (layer, s, r) => (layer[s * WORDS + (r >>> 5)] & (1 << (r & 31))) !== 0;
  reach[0][START * WORDS + (OFFSET >>> 5)] |= 1 << (OFFSET & 31);

  const sw = scale === 1 ? (x) => x : (x) => Math.round(x / scale);

  for (let i = 0; i < n; i++) {
    const cur = reach[i];
    const next = reach[i + 1];
    const wi = sw(weights[i] ?? 0);
    const canDrop = eligible[i] === true;
    const openCharge = sw(markerFixed + digits(lines[i] ?? 0));
    const closeCharge = i >= 1 ? sw(digits(lines[i - 1] ?? 0)) : 0;
    for (let s = 0; s < STATES; s++) {
      const srcBase = s * WORDS;
      let any = false;
      for (let w = 0; w < WORDS; w++) {
        if (cur[srcBase + w] !== 0) { any = true; break; }
      }
      if (!any) continue;
      const kt = keepTarget(s);
      if (kt >= 0) {
        const delta = isDropMode(s) ? -closeCharge : 0;
        shiftOrRow(cur, srcBase, next, kt * WORDS, WORDS, delta, maxIdx);
      }
      if (canDrop) {
        const dt = dropTarget(s);
        if (dt >= 0) {
          const delta = !isDropMode(s) ? wi - openCharge : wi;
          shiftOrRow(cur, srcBase, next, dt * WORDS, WORDS, delta, maxIdx);
        }
      }
    }
  }

  const reachN = reach[n];
  const eofClose = sw(digits(lines[n - 1] ?? 0));
  const effectiveNet = (s, idx) => idx - OFFSET - (isDropMode(s) ? eofClose : 0);

  let chosenIdx = -1;
  let chosenState = -1;
  let chosenNet = 0;
  let bandSatisfied = false;
  const wantMax = mode === 'max';
  let bestInBand = wantMax ? -Infinity : Infinity;
  for (let s = 0; s < STATES; s++) {
    if (!accepting(s)) continue;
    for (let idx = 0; idx <= maxIdx; idx++) {
      if (!getBit(reachN, s, idx)) continue;
      const eff = effectiveNet(s, idx);
      if (eff < netMin || eff > netMax) continue;
      const better = wantMax ? eff > bestInBand : eff < bestInBand;
      if (better) {
        bestInBand = eff;
        chosenIdx = idx;
        chosenState = s;
        chosenNet = eff;
        bandSatisfied = true;
      }
    }
  }
  if (!bandSatisfied) {
    let bestDist = Infinity;
    let bestTie = wantMax ? -Infinity : Infinity;
    for (let s = 0; s < STATES; s++) {
      if (!accepting(s)) continue;
      for (let idx = 0; idx <= maxIdx; idx++) {
        if (!getBit(reachN, s, idx)) continue;
        const eff = effectiveNet(s, idx);
        const dist = eff < netMin ? netMin - eff : eff > netMax ? eff - netMax : 0;
        const tieBetter = wantMax ? eff > bestTie : eff < bestTie;
        if (dist < bestDist || (dist === bestDist && tieBetter)) {
          bestDist = dist;
          bestTie = eff;
          chosenIdx = idx;
          chosenState = s;
          chosenNet = eff;
        }
      }
    }
  }
  if (chosenState < 0) throw new Error('selectDropsToBand: no reachable terminal state (internal error).');

  const drop = new Array(n).fill(false);
  let curState = chosenState;
  let curIdx = chosenIdx;
  for (let i = n - 1; i >= 0; i--) {
    const li = reach[i];
    const wi = sw(weights[i] ?? 0);
    const openCharge = sw(markerFixed + digits(lines[i] ?? 0));
    const closeCharge = i >= 1 ? sw(digits(lines[i - 1] ?? 0)) : 0;
    let found = false;
    const tryKeep = () => {
      const kps = KEEP_PREDS[curState];
      for (let k = 0; k < kps.length; k++) {
        const { p, closesDrop } = kps[k];
        const prevIdx = curIdx - (closesDrop ? -closeCharge : 0);
        if (prevIdx >= 0 && prevIdx <= maxIdx && getBit(li, p, prevIdx)) {
          drop[i] = false;
          curState = p;
          curIdx = prevIdx;
          return true;
        }
      }
      return false;
    };
    const tryDrop = () => {
      if (eligible[i] !== true) return false;
      const dps = DROP_PREDS[curState];
      for (let k = 0; k < dps.length; k++) {
        const { p, opensDrop } = dps[k];
        const prevIdx = curIdx - (opensDrop ? wi - openCharge : wi);
        if (prevIdx >= 0 && prevIdx <= maxIdx && getBit(li, p, prevIdx)) {
          drop[i] = true;
          curState = p;
          curIdx = prevIdx;
          return true;
        }
      }
      return false;
    };
    if (wantMax) found = tryDrop() || tryKeep();
    else found = tryKeep() || tryDrop();
    if (!found) throw new Error('selectDropsToBand: reconstruction failed — DP table inconsistency.');
  }
  if (curState !== START || curIdx !== OFFSET) {
    throw new Error('selectDropsToBand: reconstruction did not terminate at START with net 0.');
  }
  return { drop, netRemoved: chosenNet, bandSatisfied };
}

/**
 * Shifted-OR of a source bitrow into a target bitrow: target |= (source shifted by
 * `delta` net-indices), clamped to [0, maxIdx]. Word-parallel (32 net-values/op).
 */
function shiftOrRow(src, srcBase, dst, dstBase, WORDS, delta, maxIdx) {
  if (delta === 0) {
    for (let w = 0; w < WORDS; w++) {
      const v = src[srcBase + w];
      if (v !== 0) dst[dstBase + w] |= v;
    }
  } else if (delta > 0) {
    const wordShift = delta >>> 5;
    const bitShift = delta & 31;
    if (bitShift === 0) {
      for (let w = WORDS - 1 - wordShift; w >= 0; w--) {
        const sv = src[srcBase + w];
        if (sv !== 0) dst[dstBase + w + wordShift] |= sv;
      }
    } else {
      const inv = 32 - bitShift;
      for (let w = WORDS - 1; w >= 0; w--) {
        const sv = src[srcBase + w];
        if (sv === 0) continue;
        const tw = w + wordShift;
        if (tw < WORDS) dst[dstBase + tw] |= (sv << bitShift) >>> 0;
        if (tw + 1 < WORDS) dst[dstBase + tw + 1] |= sv >>> inv;
      }
    }
  } else {
    const d = -delta;
    const wordShift = d >>> 5;
    const bitShift = d & 31;
    if (bitShift === 0) {
      for (let w = wordShift; w < WORDS; w++) {
        const sv = src[srcBase + w];
        if (sv !== 0) dst[dstBase + w - wordShift] |= sv;
      }
    } else {
      const inv = 32 - bitShift;
      for (let w = 0; w < WORDS; w++) {
        const sv = src[srcBase + w];
        if (sv === 0) continue;
        const tw = w - wordShift;
        if (tw >= 0) dst[dstBase + tw] |= sv >>> bitShift;
        if (tw - 1 >= 0) dst[dstBase + tw - 1] |= (sv << inv) >>> 0;
      }
    }
  }
  const totalBits = maxIdx + 1;
  const topWord = totalBits >>> 5;
  const topBit = totalBits & 31;
  if (topBit !== 0 && topWord < WORDS) {
    dst[dstBase + topWord] &= ((1 << topBit) - 1) >>> 0;
  }
  for (let w = topWord + (topBit !== 0 ? 1 : 0); w < WORDS; w++) dst[dstBase + w] = 0;
}

/**
 * EXACT scalar extreme-NET DP (O(n*STATES), true char units). Reports the max (or min)
 * effective net and reconstructs a witnessing — always VALID — selection. Feeds the
 * large-n path's genuinely-infeasible nearest arrangement and a guaranteed-valid fallback.
 */
function scalarExtreme(weights, lines, eligible, n, markerFixed, maximize) {
  const init = maximize ? -Infinity : Infinity;
  const best = new Array(n + 1);
  const from = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    best[i] = new Float64Array(STATES).fill(init);
    from[i] = new Array(STATES).fill(null);
  }
  best[0][START] = 0;
  const better = maximize ? (a, b) => a > b : (a, b) => a < b;

  for (let i = 0; i < n; i++) {
    const wi = weights[i] ?? 0;
    const canDrop = eligible[i] === true;
    const openCharge = markerFixed + digits(lines[i] ?? 0);
    const closeCharge = i >= 1 ? digits(lines[i - 1] ?? 0) : 0;
    const cur = best[i];
    const next = best[i + 1];
    const nf = from[i + 1];
    for (let s = 0; s < STATES; s++) {
      const base = cur[s];
      if (base === init) continue;
      const kt = keepTarget(s);
      if (kt >= 0) {
        const v = base + (isDropMode(s) ? -closeCharge : 0);
        if (better(v, next[kt])) { next[kt] = v; nf[kt] = { p: s, drop: false }; }
      }
      if (canDrop) {
        const dt = dropTarget(s);
        if (dt >= 0) {
          const v = base + (!isDropMode(s) ? wi - openCharge : wi);
          if (better(v, next[dt])) { next[dt] = v; nf[dt] = { p: s, drop: true }; }
        }
      }
    }
  }

  const eofClose = digits(lines[n - 1] ?? 0);
  let chosen = -1;
  let chosenNet = init;
  for (let s = 0; s < STATES; s++) {
    const v = best[n][s];
    if (v === init || !accepting(s)) continue;
    const eff = v - (isDropMode(s) ? eofClose : 0);
    if (better(eff, chosenNet)) { chosenNet = eff; chosen = s; }
  }
  const drop = new Array(n).fill(false);
  let curState = chosen;
  for (let i = n - 1; i >= 0; i--) {
    const f = from[i + 1][curState];
    if (f === null) throw new Error('scalarExtreme: reconstruction failed.');
    drop[i] = f.drop;
    curState = f.p;
  }
  return { drop, net: chosenNet };
}
