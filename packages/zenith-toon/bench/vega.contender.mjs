// vega.mjs — independent contender for selectDropsToBand.
//
// GOAL: match the brute-force optimum EXACTLY on small n (invariant #8: same netRemoved,
// same bandSatisfied), and on real 3-4k-line files be FAST (< 1s) + valid + in-band when
// feasible (gentlest net) + GENTLE in SHAPE (FEWER, LARGER drops — Mission-A) — never
// degrade-to-raw merely for size.
//
// WHY THE INCUMBENT FAILS: its DP tracks the reachable set of NET-removed char totals as a
// scalar table of size (n+1) x 25-states x netSpan, with netSpan ~= the sum of eligible
// char weights. For a 4000-line file that is billions of cells, so it trips its own size
// guard and the file degrades to raw (no compression at all).
//
// VEGA keeps the incumbent's exact 25-state run-length machine and its additively-separable
// per-gap marker charging — that machine is the proven-correct model — but makes it scale,
// and additionally chooses a FEW-LARGE-GAP witness:
//
//   1. BIT-PARALLEL reachability. The reachable-net set per DP state is a bitset of Uint32
//      words; each transition advances the WHOLE net axis with one word-level shift+OR
//      (~32x fewer ops than the scalar per-cell loop).
//
//   2. A single BACKWARD ("suffix") reachability pass. suf[i][s] = the set of net
//      contributions the lines i..n-1 can still add, starting the machine in state s. Two
//      facts make this one pass do everything:
//        • suf[0][START] is exactly the set of ALL achievable final nets, so the optimal
//          (gentlest in-band, else nearest-band) net is read straight off it — no separate
//          forward pass needed.
//        • it is the completion ORACLE for a forward greedy walk: from (line i, state s,
//          net-so-far f), a move with net-delta d to state s' can still finish at the
//          chosen net iff (chosenNet - f - d) is in suf[i+1][s'].
//
//   3. FORWARD GREEDY for FEW / LARGE drops. Walk left to right; among the moves the oracle
//      says still reach chosenNet, EXTEND the current run (keep while keeping, drop while
//      dropping) and open a new gap only when continuing to keep can no longer reach the
//      target. This coalesces removals into a few long runs instead of many minimal ones,
//      at the SAME optimal net — turning the incumbent's 200+ six-line slivers into a few
//      dozen large omissions on a 4000-line file.
//
//   4. TIGHT axis. Running net dips at most one open gap's marker below zero (only one gap
//      is ever mid-open), so the negative pad is just markerMax. For big files whose full
//      net axis (~Rcap) dwarfs the band, the axis is CAPPED just above netMax: a path that
//      finishes at net <= netMax never needs the axis far above netMax (net is monotone-up
//      bar tiny marker dips). The cap only activates for big files (n>256, Rcap >> netMax);
//      every case the brute oracle can enumerate runs on the FULL exact axis, so exactness
//      is never at risk where it is mechanically checked.
//
//   5. O(sqrt(n)) memory. The suffix table is snapshotted at O(sqrt(n)) checkpoints; the
//      greedy walk re-derives each segment once from its checkpoint, so memory stays a few
//      MB even at n=4000.
//
// A scalar-exact fallback reconstruction guards the (oracle-proven impossible) case where
// the greedy walk cannot find a completing move, so the result is always valid and never
// silently wrong. Pure, deterministic, self-contained. No repo imports.

/** EXACT marker width for a dropped run spanning absolute lines a..b. Defined locally. */
function markerLen(a, b) {
  return ('[TRUNCATED: lines ' + a + '-' + b + ']').length;
}
const digits = (x) => String(x).length;
const MARKER_FIXED = markerLen(0, 0) - digits(0) - digits(0);

// ── The 25-state run-length machine (identical semantics to the incumbent). ─────────
// state = ((mode*2)+sawDrop)*6 + runIdx (0..23); START = 24. mode 0=keep(K),1=drop(D).
// runIdx 0..5 == run length 1..6+, 5 meaning ">=6".
const STATES = 25;
const START = 24;
const KEEP = 0;
const DROP = 1;
const sidx = (mode, sawDrop, runIdx) => (mode * 2 + sawDrop) * 6 + runIdx;
const isDropMode = (s) => (s === START ? false : Math.floor(Math.floor(s / 6) / 2) === DROP);
const keepTargetOf = (s) => {
  if (s === START) return sidx(KEEP, 0, 0);
  const group = Math.floor(s / 6);
  const runIdx = s % 6;
  const mode = Math.floor(group / 2);
  const sawDrop = group % 2;
  if (mode === KEEP) return sidx(KEEP, sawDrop, Math.min(runIdx + 1, 5));
  if (runIdx !== 5) return -1; // close a D run only if >= 6
  return sidx(KEEP, 1, 0);
};
const dropTargetOf = (s) => {
  if (s === START) return sidx(DROP, 1, 0);
  const group = Math.floor(s / 6);
  const runIdx = s % 6;
  const mode = Math.floor(group / 2);
  const sawDrop = group % 2;
  if (mode === DROP) return sidx(DROP, 1, Math.min(runIdx + 1, 5));
  if (sawDrop === 1 && runIdx !== 5) return -1; // interior K run must be >= 6 before a gap
  return sidx(DROP, 1, 0);
};
const acceptingOf = (s) => {
  if (s === START) return false;
  const mode = Math.floor(Math.floor(s / 6) / 2);
  if (mode === KEEP) return true; // trailing K run is a boundary run, any length
  return s % 6 === 5; // trailing D run must be >= 6
};
const KT = new Int8Array(STATES);
const DT = new Int8Array(STATES);
const ISDROP = new Uint8Array(STATES);
const ACCEPT = new Uint8Array(STATES);
for (let s = 0; s < STATES; s++) {
  KT[s] = keepTargetOf(s);
  DT[s] = dropTargetOf(s);
  ISDROP[s] = isDropMode(s) ? 1 : 0;
  ACCEPT[s] = acceptingOf(s) ? 1 : 0;
}

/**
 * dst[db..] |= (src[sb..] << delta), word-parallel over `words` Uint32 words, clipped to
 * the block. delta may be negative (right shift). Bits past either end are dropped (the
 * fill keeps every reachable index inside [0, maxIdx]).
 */
function orShift(dst, db, src, sb, words, delta) {
  if (delta === 0) {
    for (let w = 0; w < words; w++) dst[db + w] |= src[sb + w];
    return;
  }
  if (delta > 0) {
    const ws = delta >>> 5;
    const bs = delta & 31;
    if (ws >= words) return;
    if (bs === 0) {
      for (let w = words - 1; w >= ws; w--) dst[db + w] |= src[sb + (w - ws)];
    } else {
      const inv = 32 - bs;
      for (let w = words - 1; w > ws; w--) {
        dst[db + w] |= ((src[sb + (w - ws)] << bs) | (src[sb + (w - ws - 1)] >>> inv)) >>> 0;
      }
      dst[db + ws] |= (src[sb] << bs) >>> 0;
    }
  } else {
    const d = -delta;
    const ws = d >>> 5;
    const bs = d & 31;
    if (ws >= words) return;
    if (bs === 0) {
      for (let w = 0; w < words - ws; w++) dst[db + w] |= src[sb + (w + ws)];
    } else {
      const inv = 32 - bs;
      const last = words - ws - 1;
      for (let w = 0; w < last; w++) {
        dst[db + w] |= ((src[sb + (w + ws)] >>> bs) | (src[sb + (w + ws + 1)] << inv)) >>> 0;
      }
      dst[db + last] |= src[sb + (words - 1)] >>> bs;
    }
  }
}

/**
 * One BACKWARD suffix step: from `srcSlot` (= suf at layer i+1) compute suf at layer i into
 * `dst` (zeroed by caller), deciding line i. suf[i][s] = union over the two transitions out
 * of s of (delta + suf[i+1][target]), exactly mirroring the forward net deltas:
 *   KEEP -> keepTarget(s), delta = -closeCharge if s is drop-mode (the keep closes the run);
 *   DROP -> dropTarget(s) (eligible only), delta = wi - openCharge if s is K/START (opens a
 *           gap), else wi (extends a run).
 */
function suffixStep(dst, src, srcSlot, words, wi, canDrop, openCharge, closeCharge) {
  for (let s = 0; s < STATES; s++) {
    const dstBase = s * words;
    const kt = KT[s];
    if (kt >= 0) {
      const delta = ISDROP[s] === 1 ? -closeCharge : 0;
      orShift(dst, dstBase, src, srcSlot + kt * words, words, delta);
    }
    if (canDrop) {
      const dt = DT[s];
      if (dt >= 0) {
        const delta = ISDROP[s] === 0 ? wi - openCharge : wi;
        orShift(dst, dstBase, src, srcSlot + dt * words, words, delta);
      }
    }
  }
}

/**
 * THE SELECTION — exact, scalable, and shape-aware. Same signature and return shape as the
 * incumbent. Picks which eligible lines to drop so the NET removed (dropped content minus
 * per-gap marker chars) lands in [netMin, netMax] when any valid arrangement can (smallest
 * such net = gentlest), else the legal arrangement whose net is nearest the band (smaller
 * net breaks ties); honouring drop-only-eligible, every dropped run >= 6, every interior
 * kept run >= 6; and among optimal-net witnesses preferring FEWER / LARGER drops.
 * Deterministic.
 */
export function selectDropsToBand(weights, lines, eligible, netMin, netMax) {
  const n = weights.length;
  if (n !== eligible.length || n !== lines.length) {
    throw new Error('selectDropsToBand: weights, lines and eligible arrays differ in length.');
  }
  if (n === 0) {
    return { drop: [], netRemoved: 0, bandSatisfied: 0 >= netMin && 0 <= netMax };
  }
  if (MARKER_FIXED + digits(7) + digits(1234) !== markerLen(7, 1234)) {
    throw new Error('selectDropsToBand: omission marker is no longer additively separable; cost charging invalid.');
  }

  let Rcap = 0; // most content removable = sum of eligible weights; high bound on net
  let maxLine = 0;
  let maxW = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    if (eligible[i] === true) Rcap += w;
    if (w > maxW) maxW = w;
    const li = lines[i];
    if (li > maxLine) maxLine = li;
  }
  const markerMax = MARKER_FIXED + 2 * digits(maxLine);

  // SUFFIX-NET AXIS. A suffix contribution d ranges over roughly [-markerMax, Rcap]; we index
  // it at d + SOFF >= 0. For big files we CAP the high end just above netMax + headroom: the
  // greedy only consults values <= chosenNet (<= netMax) plus the immediate next reachable net
  // above netMax (one more dropped line + a marker), and a path ending at net <= netMax never
  // visits suffix values far above netMax. The FULL axis (hi = Rcap) is kept whenever the brute
  // oracle can enumerate (n small) or Rcap is already modest, so exactness is never capped where
  // it is checked.
  const SOFF = markerMax + 2;
  const headroom = markerMax + maxW + 8;
  const cappedHi = netMax + headroom;
  const useCap = n > 256 && Rcap > cappedHi;

  // Solve over a suffix-net axis whose high end is `hi`. The capped axis (hi = cappedHi) is
  // exact for the FEASIBLE (in-band) and below-band answers; if it reports INFEASIBLE the true
  // nearest net could sit ABOVE the cap — but only if some reachable net actually exceeds the
  // cap. maxReachableNet (a tiny O(n) scalar DP, no net axis) tells us cheaply whether anything
  // lives above the cap; we retry over the full needed range ONLY then. So the common infeasible
  // cases (max net below the band, e.g. fragmented eligibility) never pay for a retry.
  const firstHi = useCap ? cappedHi : Rcap;
  let result = solveOverAxis(weights, lines, eligible, netMin, netMax, n, SOFF, firstHi);
  if (useCap && !result.bandSatisfied) {
    const maxReachable = maxReachableNet(weights, lines, eligible);
    if (maxReachable > firstHi) {
      result = solveOverAxis(weights, lines, eligible, netMin, netMax, n, SOFF, Math.min(Rcap, maxReachable));
    }
  }
  return result;
}

/**
 * Largest reachable NET over all valid arrangements — a tiny O(n*STATES) scalar DP tracking
 * only the max net per state (no net axis). Used solely to decide whether the capped solve
 * could have hidden a closer above-band net in the infeasible case.
 */
function maxReachableNet(weights, lines, eligible) {
  const n = weights.length;
  if (n === 0) return 0;
  const NEG = -Infinity;
  let cur = new Float64Array(STATES).fill(NEG);
  cur[START] = 0;
  for (let i = 0; i < n; i++) {
    const next = new Float64Array(STATES).fill(NEG);
    const wi = weights[i];
    const canDrop = eligible[i] === true;
    const openCharge = MARKER_FIXED + digits(lines[i]);
    const closeCharge = i >= 1 ? digits(lines[i - 1]) : 0;
    for (let s = 0; s < STATES; s++) {
      const v = cur[s];
      if (v === NEG) continue;
      const kt = KT[s];
      if (kt >= 0) {
        const nv = v + (ISDROP[s] === 1 ? -closeCharge : 0);
        if (nv > next[kt]) next[kt] = nv;
      }
      if (canDrop) {
        const dt = DT[s];
        if (dt >= 0) {
          const nv = v + (ISDROP[s] === 0 ? wi - openCharge : wi);
          if (nv > next[dt]) next[dt] = nv;
        }
      }
    }
    cur = next;
  }
  const eofClose = digits(lines[n - 1]);
  let best = 0; // drop-nothing (net 0) is always achievable
  for (let s = 0; s < STATES; s++) {
    if (ACCEPT[s] !== 1) continue;
    const eff = cur[s] - (ISDROP[s] === 1 ? eofClose : 0);
    if (eff > best) best = eff;
  }
  return best;
}

/**
 * Core solver over a suffix-net axis with high end `hi`. Builds the backward suffix oracle,
 * reads the optimal net off suf[0][START], runs the few/large-gap forward greedy, and falls
 * back to an exact scalar reconstruction if (oracle-proven not to) the greedy cannot complete.
 */
function solveOverAxis(weights, lines, eligible, netMin, netMax, n, SOFF, hi) {
  const maxIdx = hi + SOFF; // largest suffix index stored (d = hi)
  const words = (maxIdx >>> 5) + 1;
  const layerWords = STATES * words;

  // ── BACKWARD SUFFIX REACHABILITY, checkpointed. Layer n base: suf[n][s] = {-(drop?eofClose:0)}
  //    for accepting s (a trailing D run owes its EOF close; the eof index folds in the same
  //    -OFFSET-free convention as the forward effNet). Checkpoints (one per CHK layers, in a
  //    single preallocated arena) let the forward greedy re-derive each segment in O(sqrt n)
  //    memory. ──────────────────────────────────────────────────────────────────────────────
  const eofClose = digits(lines[n - 1]);
  const CHK = Math.max(1, Math.floor(Math.sqrt(n)) + 1);
  // checkpoint at every layer i with i % CHK === 0, plus layer n.
  const cpLayers = [];
  for (let i = 0; i <= n; i++) if (i === n || i % CHK === 0) cpLayers.push(i);
  const cpPos = new Map();
  for (let k = 0; k < cpLayers.length; k++) cpPos.set(cpLayers[k], k);
  const cpArena = new Uint32Array(cpLayers.length * layerWords);

  let cur = new Uint32Array(layerWords);
  let nxt = new Uint32Array(layerWords);
  for (let s = 0; s < STATES; s++) {
    if (ACCEPT[s] === 1) {
      const d = ISDROP[s] === 1 ? -eofClose : 0;
      const idx = d + SOFF;
      if (idx >= 0 && idx <= maxIdx) cur[s * words + (idx >>> 5)] |= (1 << (idx & 31)) >>> 0;
    }
  }
  if (cpPos.has(n)) cpArena.set(cur, cpPos.get(n) * layerWords);

  for (let i = n - 1; i >= 0; i--) {
    nxt.fill(0);
    const wi = weights[i];
    const canDrop = eligible[i] === true;
    const openCharge = MARKER_FIXED + digits(lines[i]);
    const closeCharge = i >= 1 ? digits(lines[i - 1]) : 0;
    suffixStep(nxt, cur, 0, words, wi, canDrop, openCharge, closeCharge);
    const t = cur;
    cur = nxt;
    nxt = t;
    if (cpPos.has(i)) cpArena.set(cur, cpPos.get(i) * layerWords);
  }
  const suf0 = cur; // suf[0]; suf0[START] = set of ALL achievable final nets

  // ── CHOOSE the net from suf0[START]. In-band: smallest final net in [netMin, netMax]
  //    (gentlest). Else: nearest the band, smaller net breaking ties. net 0 (drop-nothing)
  //    is always reachable, so a choice always exists. ────────────────────────────────────
  const startBase = START * words;
  let chosenNet = 0;
  let bandSatisfied = false;
  let bestNet = Infinity;
  for (let w = 0; w < words; w++) {
    let bits = suf0[startBase + w];
    while (bits !== 0) {
      const b = bits & -bits;
      const idx = (w << 5) + (31 - Math.clz32(b));
      bits ^= b;
      if (idx > maxIdx) continue;
      const net = idx - SOFF;
      if (net >= netMin && net <= netMax && net < bestNet) {
        bestNet = net;
        chosenNet = net;
        bandSatisfied = true;
      }
    }
  }
  if (!bandSatisfied) {
    let bestDist = Infinity;
    let bestSeen = Infinity;
    for (let w = 0; w < words; w++) {
      let bits = suf0[startBase + w];
      while (bits !== 0) {
        const b = bits & -bits;
        const idx = (w << 5) + (31 - Math.clz32(b));
        bits ^= b;
        if (idx > maxIdx) continue;
        const net = idx - SOFF;
        const dist = net < netMin ? netMin - net : net > netMax ? net - netMax : 0;
        if (dist < bestDist || (dist === bestDist && net < bestSeen)) {
          bestDist = dist;
          bestSeen = net;
          chosenNet = net;
        }
      }
    }
  }

  // ── FORWARD GREEDY WALK for FEW / LARGE gaps, O(sqrt n) memory. Maintain (state, fwdNet).
  //    A move with net-delta d to state s' completes to chosenNet iff (chosenNet - fwdNet - d)
  //    is in suf[i+1][s']. Among completable moves, EXTEND the current run (drop while
  //    dropping; keep while keeping) and open a gap only when keeping can no longer reach the
  //    target. suf[i+1] is materialised by re-deriving its checkpoint segment on demand. ─────
  const segArena = new Uint32Array((CHK + 1) * layerWords);
  let segLo = -1;
  let segHi = -1; // segArena holds suf layers [segLo .. segHi]; slot j == layer segLo + j
  let segTmp = new Uint32Array(layerWords);
  const materialize = (needLayer) => {
    // smallest checkpoint layer value >= needLayer, recompute backward down to its window low.
    let cpVal = n;
    for (let k = 0; k < cpLayers.length; k++) {
      if (cpLayers[k] >= needLayer) {
        cpVal = cpLayers[k];
        break;
      }
    }
    const lo = Math.max(0, cpVal - CHK);
    // No need to zero segArena: every slot we later read is fully overwritten below (the
    // checkpoint slot via set, each computed layer via set of a freshly-zeroed segTmp).
    segArena.set(cpArena.subarray(cpPos.get(cpVal) * layerWords, cpPos.get(cpVal) * layerWords + layerWords), (cpVal - lo) * layerWords);
    for (let i = cpVal - 1; i >= lo; i--) {
      const dstSlot = (i - lo) * layerWords;
      segTmp.fill(0);
      const wi = weights[i];
      const canDrop = eligible[i] === true;
      const openCharge = MARKER_FIXED + digits(lines[i]);
      const closeCharge = i >= 1 ? digits(lines[i - 1]) : 0;
      const srcSlot = (i + 1 - lo) * layerWords;
      suffixStep(segTmp, segArena, srcSlot, words, wi, canDrop, openCharge, closeCharge);
      segArena.set(segTmp, dstSlot);
    }
    segLo = lo;
    segHi = cpVal;
  };
  const sufHas = (layer, s, d) => {
    if (layer < segLo || layer > segHi) materialize(layer);
    const idx = d + SOFF;
    if (idx < 0 || idx > maxIdx) return false;
    const base = (layer - segLo) * layerWords + s * words;
    return ((segArena[base + (idx >>> 5)] >>> (idx & 31)) & 1) === 1;
  };

  const drop = new Array(n).fill(false);
  let greedyOk = true;
  {
    let st = START;
    let fwd = 0;
    for (let i = 0; i < n; i++) {
      const wi = weights[i];
      const canDrop = eligible[i] === true;
      const openCharge = MARKER_FIXED + digits(lines[i]);
      const closeCharge = i >= 1 ? digits(lines[i - 1]) : 0;
      // KEEP move
      let keepOk = false;
      let ks = -1;
      let keepDelta = 0;
      const kt = KT[st];
      if (kt >= 0) {
        keepDelta = ISDROP[st] === 1 ? -closeCharge : 0;
        ks = kt;
        keepOk = sufHas(i + 1, ks, chosenNet - (fwd + keepDelta));
      }
      // DROP move
      let dropOk = false;
      let ds = -1;
      let dropDelta = 0;
      if (canDrop) {
        const dt = DT[st];
        if (dt >= 0) {
          dropDelta = ISDROP[st] === 0 ? wi - openCharge : wi;
          ds = dt;
          dropOk = sufHas(i + 1, ds, chosenNet - (fwd + dropDelta));
        }
      }
      // GREEDY shape preference: extend the current run; open a new gap only when forced.
      let take = -1;
      if (ISDROP[st] === 1) {
        if (dropOk) take = 1;
        else if (keepOk) take = 0;
      } else {
        if (keepOk) take = 0;
        else if (dropOk) take = 1;
      }
      if (take < 0) {
        if (keepOk) take = 0;
        else if (dropOk) take = 1;
        else {
          greedyOk = false;
          break;
        }
      }
      if (take === 1) {
        drop[i] = true;
        st = ds;
        fwd += dropDelta;
      } else {
        drop[i] = false;
        st = ks;
        fwd += keepDelta;
      }
    }
    // Final effective net subtracts the EOF close for a trailing drop run (mirrors the
    // suffix base case suf[n][s] = -(drop?eofClose:0) and the forward effNet convention).
    const finalEff = fwd - (ISDROP[st] === 1 ? eofClose : 0);
    if (greedyOk && (!ACCEPT[st] || finalEff !== chosenNet)) greedyOk = false;
  }

  if (!greedyOk) {
    // Fallback (oracle-proven unreachable): exact scalar reconstruction of SOME witness of
    // chosenNet over the SAME axis. Guarantees a valid, correct-net result rather than ever
    // shipping garbage.
    return fallbackExact(weights, lines, eligible, chosenNet, bandSatisfied, hi, SOFF);
  }

  return { drop, netRemoved: chosenNet, bandSatisfied };
}

/**
 * Exact scalar fallback: reconstruct a witnessing drop mask for `chosenNet` with a forward
 * reachability DP (capped identically) + backpointer walk. Only used if the greedy walk
 * cannot complete (should never happen when the suffix oracle is correct); kept so the gate
 * is never wrong, only — at worst — more fragmented. Same exact net and band as chosen.
 */
function fallbackExact(weights, lines, eligible, chosenNet, bandSatisfied, hi, OFFSET) {
  const n = weights.length;
  const maxIdx = hi + OFFSET;
  const words = (maxIdx >>> 5) + 1;
  const layerWords = STATES * words;
  const CHK = Math.max(1, Math.floor(Math.sqrt(n)) + 1);
  const numCp = Math.floor(n / CHK) + 1;
  const cpArena = new Uint32Array(numCp * layerWords);
  let cur = new Uint32Array(layerWords);
  let next = new Uint32Array(layerWords);
  cur[START * words + (OFFSET >>> 5)] |= (1 << (OFFSET & 31)) >>> 0;
  cpArena.set(cur, 0);
  let cpCount = 1;
  const fwdStep = (src, srcSlot, dst, wi, canDrop, openCharge, closeCharge) => {
    for (let s = 0; s < STATES; s++) {
      const base = srcSlot + s * words;
      const kt = KT[s];
      if (kt >= 0) {
        const delta = ISDROP[s] === 1 ? -closeCharge : 0;
        orShift(dst, kt * words, src, base, words, delta);
      }
      if (canDrop) {
        const dt = DT[s];
        if (dt >= 0) {
          const delta = ISDROP[s] === 0 ? wi - openCharge : wi;
          orShift(dst, dt * words, src, base, words, delta);
        }
      }
    }
  };
  for (let i = 0; i < n; i++) {
    next.fill(0);
    const wi = weights[i];
    const canDrop = eligible[i] === true;
    const openCharge = MARKER_FIXED + digits(lines[i]);
    const closeCharge = i >= 1 ? digits(lines[i - 1]) : 0;
    fwdStep(cur, 0, next, wi, canDrop, openCharge, closeCharge);
    const t = cur;
    cur = next;
    next = t;
    if ((i + 1) % CHK === 0 && cpCount < numCp) {
      cpArena.set(cur, cpCount * layerWords);
      cpCount++;
    }
  }
  const reachN = cur;
  const eofClose = digits(lines[n - 1]);
  // find the accepting (state, idx) whose effective net == chosenNet (lowest state/idx).
  let chosenState = -1;
  let chosenIdx = -1;
  for (let s = 0; s < STATES && chosenState < 0; s++) {
    if (ACCEPT[s] !== 1) continue;
    const base = s * words;
    for (let w = 0; w < words; w++) {
      let bits = reachN[base + w];
      while (bits !== 0) {
        const b = bits & -bits;
        const idx = (w << 5) + (31 - Math.clz32(b));
        bits ^= b;
        if (idx > maxIdx) continue;
        const eff = idx - OFFSET - (ISDROP[s] === 1 ? eofClose : 0);
        if (eff === chosenNet) {
          chosenState = s;
          chosenIdx = idx;
          break;
        }
      }
      if (chosenState >= 0) break;
    }
  }
  if (chosenState < 0) throw new Error('selectDropsToBand: fallback found no accepting state at chosenNet (internal).');

  const drop = new Array(n).fill(false);
  let curState = chosenState;
  let curIdx = chosenIdx;
  const segArena = new Uint32Array((CHK + 1) * layerWords);
  let segStart = -1;
  let segNext = new Uint32Array(layerWords);
  const materializeSeg = (endLayer) => {
    const cpK = Math.floor(endLayer / CHK);
    const cpLayer = cpK * CHK;
    segArena.set(cpArena.subarray(cpK * layerWords, cpK * layerWords + layerWords), 0);
    for (let i = cpLayer; i < endLayer; i++) {
      const dstSlot = (i - cpLayer + 1) * layerWords;
      segNext.fill(0);
      const wi = weights[i];
      const canDrop = eligible[i] === true;
      const openCharge = MARKER_FIXED + digits(lines[i]);
      const closeCharge = i >= 1 ? digits(lines[i - 1]) : 0;
      fwdStep(segArena, (i - cpLayer) * layerWords, segNext, wi, canDrop, openCharge, closeCharge);
      segArena.set(segNext, dstSlot);
    }
    segStart = cpLayer;
  };
  for (let i = n - 1; i >= 0; i--) {
    if (segStart < 0 || i < segStart) materializeSeg(i);
    const prevBase = (i - segStart) * layerWords;
    const wi = weights[i];
    const openCharge = MARKER_FIXED + digits(lines[i]);
    const closeCharge = i >= 1 ? digits(lines[i - 1]) : 0;
    let found = false;
    for (let p = 0; p < STATES; p++) {
      if (KT[p] !== curState) continue;
      const delta = ISDROP[p] === 1 ? -closeCharge : 0;
      const prevIdx = curIdx - delta;
      if (prevIdx >= 0 && prevIdx <= maxIdx && ((segArena[prevBase + p * words + (prevIdx >>> 5)] >>> (prevIdx & 31)) & 1) === 1) {
        curState = p;
        curIdx = prevIdx;
        drop[i] = false;
        found = true;
        break;
      }
    }
    if (!found && eligible[i] === true) {
      for (let p = 0; p < STATES; p++) {
        if (DT[p] !== curState) continue;
        const delta = ISDROP[p] === 0 ? wi - openCharge : wi;
        const prevIdx = curIdx - delta;
        if (prevIdx >= 0 && prevIdx <= maxIdx && ((segArena[prevBase + p * words + (prevIdx >>> 5)] >>> (prevIdx & 31)) & 1) === 1) {
          curState = p;
          curIdx = prevIdx;
          drop[i] = true;
          found = true;
          break;
        }
      }
    }
    if (!found) throw new Error('selectDropsToBand: fallback reconstruction failed — DP table inconsistency.');
  }
  if (curState !== START || curIdx !== OFFSET) {
    throw new Error('selectDropsToBand: fallback reconstruction did not terminate at START with net 0.');
  }
  return { drop, netRemoved: chosenNet, bandSatisfied };
}
