// quill.mjs — an EXACT, FAST, LOW-FRAGMENTATION drop-in for selectDropsToBand.
//
// Same problem and same exactness contract as the incumbent DP in
// packages/zenith-toon/src/removal.ts, but it (1) scales to 3,000–4,000+ line
// files in well under a second instead of tripping the incumbent's 60M-cell guard
// and degrading the whole file to raw, and (2) among the optimal-net solutions it
// emits FEWER, LARGER omissions — directly serving Mission-A — instead of the
// incumbent's many minimal 6-line slivers.
//
// ── WHY THE INCUMBENT BLOWS UP ───────────────────────────────────────────────
// The incumbent is a reachability DP whose table is (n+1) × 25 states × netSpan,
// one Uint8 *byte* per reachable net value (netSpan ≈ Σ eligible weights, ~90k for
// a 4k-line file). At n=4000 that is ~10.9 BILLION bytes → it throws → compressFile
// degrades to raw. Real files never compress.
//
// ── THE CORE IDEA: BITSET REACHABILITY ───────────────────────────────────────
// The DP's per-(line,state) "set of achievable net totals" is a SET OF INTEGERS.
// Represent each such set as a BITSET (one BIT per net value, not a byte). Every DP
// transition — extend a run / open a gap / close a gap, each shifting the achievable
// nets by a per-line constant (the dropped weight and the marker-cost charges) —
// becomes a word-parallel SHIFT-AND-OR over that bitset. That is a 32× constant
// win in time and memory and turns the pseudo-polynomial table into a few hundred
// million cheap word ops: sub-second at n=4000.
//
// Exactness is UNCHANGED: a bitset reachability DP enumerates EXACTLY the same
// achievable-net set the incumbent (and the brute-force oracle) do — same 25-state
// machine, same per-gap marker charging (open charge markerFixed+digits(start) when
// a gap opens, close charge digits(end) when it closes / at EOF), same selection
// rule (gentlest in-band net; else nearest the band, smaller net breaking ties). No
// rounding, no approximation — it MUST match brute force bit for bit.
//
// ── ONE BACKWARD PASS, THEN A GAP-MINIMISING FORWARD WALK ────────────────────
// We run the reachability BACKWARD: bsuf[i][s] = the set of net deltas achievable
// over lines i..n-1 starting in state s and ending in an accepting state. Two payoffs:
//   • bsuf[0][START] is the FULL set of achievable total nets — so we pick the
//     winning net (the selection rule) straight off it, no separate forward pass.
//   • bsuf is an exact feasibility oracle for the rest of the file, so we can then
//     walk FORWARD greedily and, at every line, take the move that AVOIDS opening a
//     new gap (and, once dropping, EXTENDS the gap) whenever bsuf proves the chosen
//     target net is still reachable. That yields few, large omissions while landing
//     on the exact optimal net — strictly better than the incumbent on Mission-A,
//     with identical net/band (so the exactness oracle still passes).
//
// Storing every bsuf layer would be ~1GB, so we CHECKPOINT it every √n lines (a few
// MB) and recompute each block's interior layers on demand as the forward walk
// crosses it — total work stays ~2 passes, memory O(√n) layers. Deterministic
// throughout (pure function, all ties resolved by fixed order). A defensive
// phase-1-style forward reconstruction is kept as a fallback that can never change
// the net, only the witness.
//
// Pure, self-contained, no imports. markerLen is defined locally and is the SINGLE
// source of marker cost, identical to the repo's exported markerLen.

/**
 * EXACT char width the `[TRUNCATED: lines a-b]` marker contributes — identical to
 * the repo's exported markerLen. Depends on the digit counts of a and b, so it is
 * always computed from the gap's REAL boundary line numbers.
 */
function markerLen(a, b) {
  return ('[TRUNCATED: lines ' + a + '-' + b + ']').length;
}

/**
 * The selection over a flat line array. Returns { drop, netRemoved, bandSatisfied }
 * exactly as the incumbent does. `drop[i]` true iff flat line i is removed;
 * `netRemoved` = dropped content − Σ markerLen(gap) (= fullSize − renderedSize);
 * `bandSatisfied` true iff that net landed in [netMin, netMax].
 */
export function selectDropsToBand(weights, lines, eligible, netMin, netMax) {
  const n = weights.length;
  if (n !== eligible.length || n !== lines.length) {
    throw new Error('selectDropsToBand: weights, lines and eligible arrays differ in length.');
  }
  // Drop-nothing (net = 0) is always valid, so a selection always exists.
  if (n === 0) {
    return { drop: [], netRemoved: 0, bandSatisfied: 0 >= netMin && 0 <= netMax };
  }

  // ── Marker cost decomposition (must stay additively separable). ──────────────
  const digits = (x) => String(x).length;
  const markerFixed = markerLen(0, 0) - digits(0) - digits(0);
  if (markerFixed + digits(7) + digits(1234) !== markerLen(7, 1234)) {
    throw new Error(
      'selectDropsToBand: omission marker is no longer additively separable into ' +
        'markerFixed + digits(start) + digits(end); marker-cost charging invalid.',
    );
  }

  // ── Rcap (max removable content), maxLine, lightest eligible line. ───────────
  let Rcap = 0;
  let maxLine = 0;
  let minEligW = Infinity;
  for (let i = 0; i < n; i++) {
    if (eligible[i] === true) {
      const w = weights[i] | 0;
      Rcap += w;
      if (w < minEligW) minEligW = w;
    }
    const li = lines[i] | 0;
    if (li > maxLine) maxLine = li;
  }
  if (!isFinite(minEligW)) minEligW = 0; // no eligible lines → nothing droppable
  const maxGaps = Math.floor(n / 6) + 1;
  const markerMax = markerFixed + 2 * digits(maxLine);

  // ── OFFSET: how far the running (mid-pass) net can dip BELOW zero, so indexing
  //    net at (net + OFFSET) stays ≥ 0. A gap opens with an up-front marker charge
  //    (≤ markerMax) and only then accrues its ≥6 dropped lines, so a single
  //    minimal gap can drag net down by at most perGapDeficit = max(0, markerMax −
  //    6·minEligibleWeight) below the running baseline; chaining at most maxGaps of
  //    them, plus one in-flight markerMax for the gap currently opening, bounds the
  //    deepest dip at markerMax + maxGaps·perGapDeficit. For ordinary code weights
  //    (≥ ~5 chars/line) 6·minW ≥ markerMax, so perGapDeficit = 0 and OFFSET
  //    collapses to a single markerMax — roughly HALVING the bitset width versus a
  //    blanket maxGaps·markerMax bound, while staying provably safe for tiny-weight
  //    inputs (where it grows back to the safe magnitude). ───────────────────────
  const perGapDeficit = Math.max(0, markerMax - 6 * minEligW);
  const OFFSET = markerMax + maxGaps * perGapDeficit;
  const idxMaxFull = Rcap + OFFSET; // highest possible net index (net = Rcap)

  // ── SAFE UPPER CAP on the tracked net range. The answer is always either inside
  //    [netMin, netMax] (feasible) or, when infeasible, the reachable net NEAREST
  //    the band, smaller net breaking ties. net = 0 (drop-nothing) is ALWAYS
  //    reachable, which makes a clean upper cap provable:
  //      • If netMin > 0: 0 is a valid below-band point (pred ≥ 0). Any reachable
  //        net above Hnet = netMax + netMin + OFFSET has above-band distance
  //        (net − netMax) > netMin + OFFSET ≥ netMin − minNet ≥ netMin − pred, so
  //        the nearest-below candidate `pred` is strictly nearer — never the answer.
  //      • If netMin ≤ 0: 0 lies in or above the band, so any reachable net above
  //        max(0, netMax) is dominated by 0 (0's above-band distance is smaller).
  //    Hence tracking net up to capNet = max(Hnet, max(0, netMax)) never loses the
  //    answer for ANY band (including the oracle's small/negative bands). We add
  //    OFFSET + a digit of slack converting net→index so the EOF-close shift stays
  //    in range, and never cap below net 0 (index OFFSET). ────────────────────────
  const capNet = Math.max(netMax + netMin + OFFSET, Math.max(0, netMax));
  const idxCap = capNet + OFFSET + digits(maxLine) + 1;
  const idxMax = Math.min(idxMaxFull, Math.max(idxCap, OFFSET + 1));
  const netSpan = idxMax + 1;

  // ── State encoding (identical to incumbent). mode 0=keep(K) 1=drop(D);
  //    sawDrop 0/1; runIdx 0..5 (5 == ">=6"). sidx = ((mode*2)+sawDrop)*6+runIdx,
  //    0..23. START = 24. ──────────────────────────────────────────────────────
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
    if (runIdx !== 5) return -1; // closing a D run requires it to be >= 6
    return sidx(KEEP, 1, 0);
  };
  const dropTarget = (s) => {
    if (s === START) return sidx(DROP, 1, 0);
    const group = Math.floor(s / 6);
    const runIdx = s % 6;
    const mode = Math.floor(group / 2);
    const sawDrop = group % 2;
    if (mode === DROP) return sidx(DROP, 1, Math.min(runIdx + 1, 5));
    if (sawDrop === 1 && runIdx !== 5) return -1; // interior K run must be >= 6
    return sidx(DROP, 1, 0);
  };
  const accepting = (s) => {
    if (s === START) return false;
    const mode = Math.floor(Math.floor(s / 6) / 2);
    if (mode === KEEP) return true;
    return s % 6 === 5; // trailing D run must be >= 6
  };

  // Precompute per source state its keep/drop targets, used a lot.
  const KT = new Int8Array(STATES);
  const DT = new Int8Array(STATES);
  const DROPM = new Uint8Array(STATES); // isDropMode flag per state
  for (let s = 0; s < STATES; s++) {
    KT[s] = keepTarget(s);
    DT[s] = dropTarget(s);
    DROPM[s] = isDropMode(s) ? 1 : 0;
  }

  // ── Bitset layout: per layer Uint32Array(STATES * W); bit (s, idx) at word
  //    s*W + (idx>>5), bit (idx & 31). ──────────────────────────────────────────
  const W = (netSpan + 31) >>> 5;
  const layerWords = STATES * W;

  // ── RESOURCE GUARD (mine, generous — bitsets are 32× denser than the incumbent's
  //    bytes). We keep O(√n) layers; refuse only the truly impossible, so big real
  //    files COMPRESS rather than degrade to raw. ───────────────────────────────
  const MAX_LAYER_WORDS = 200_000_000; // ~800MB per transient layer
  if (layerWords > MAX_LAYER_WORDS) {
    throw new Error(
      `selectDropsToBand: input exceeds the exact-DP size bound ` +
        `(${n} lines × ${netSpan} net states ⇒ ${layerWords} words/layer). Degrades to raw upstream.`,
    );
  }

  // OR src-row (shifted by signed `delta`) into dst-row; the source carries bits
  // only in words [0, srcHiW], so we iterate just the words those can land in.
  const orShifted = (dst, dBase, src, sBase, delta, srcHiW) => {
    if (delta === 0) {
      for (let w = 0; w <= srcHiW; w++) dst[dBase + w] |= src[sBase + w];
    } else if (delta > 0) {
      const ws = delta >>> 5;
      const bs = delta & 31;
      const hiW = Math.min(W - 1, srcHiW + ws + 1);
      if (bs === 0) {
        for (let w = hiW; w >= ws; w--) dst[dBase + w] |= src[sBase + (w - ws)];
      } else {
        const inv = 32 - bs;
        for (let w = hiW; w >= ws; w--) {
          let v = src[sBase + (w - ws)] << bs;
          if (w - ws - 1 >= 0) v |= src[sBase + (w - ws - 1)] >>> inv;
          dst[dBase + w] |= v >>> 0;
        }
      }
    } else {
      const d = -delta;
      const ws = d >>> 5;
      const bs = d & 31;
      const hiW = Math.min(W - 1, srcHiW);
      if (bs === 0) {
        for (let w = 0; w + ws <= hiW; w++) dst[dBase + w] |= src[sBase + (w + ws)];
      } else {
        const inv = 32 - bs;
        for (let w = 0; w + ws <= hiW; w++) {
          let v = src[sBase + (w + ws)] >>> bs;
          if (w + ws + 1 <= hiW) v |= src[sBase + (w + ws + 1)] << inv;
          dst[dBase + w] |= v >>> 0;
        }
      }
    }
  };
  const topWord = idxMax >>> 5;
  const topBitMask = ((idxMax & 31) === 31 ? 0xffffffff : ((1 << ((idxMax & 31) + 1)) - 1)) >>> 0;
  const maskTop = (buf, base) => {
    if (topWord < W) buf[base + topWord] &= topBitMask;
  };
  const getBit = (buf, base, idx) => (buf[base + (idx >>> 5)] >>> (idx & 31)) & 1;

  // ── BACKWARD occupancy ceiling. Going right→left, the highest reachable net
  //    delta over lines i..n-1 is ≤ Σ eligible weights among those lines, so the
  //    highest reachable INDEX (delta+OFFSET) ≤ OFFSET + that suffix sum, capped at
  //    idxMax. occHiWordB[i] is that index's word; iterating each backward step only
  //    up to it keeps the work a triangle, not the full rectangle. ───────────────
  const occHiWordB = new Int32Array(n + 1);
  {
    let se = 0;
    occHiWordB[n] = Math.min(idxMax, OFFSET) >>> 5; // base: only the eof rem near 0
    for (let i = n - 1; i >= 0; i--) {
      if (eligible[i] === true) se += weights[i] | 0;
      occHiWordB[i] = Math.min(idxMax, OFFSET + se) >>> 5;
    }
  }

  // Compute bsuf[i] from bsuf[i+1] (already in `nextB`) into `cur` (pre-zeroed),
  // deciding line i. bsuf[i][s] holds, at index (rem+OFFSET), reachability of net
  // delta `rem` over lines i..n-1 starting in state s and ending accepting.
  const neActive = new Uint8Array(STATES); // scratch: which nextB rows are nonempty
  const stepBackward = (nextB, cur, i) => {
    const wi = weights[i] | 0;
    const canDrop = eligible[i] === true;
    const openCharge = markerFixed + digits(lines[i] | 0);
    const closeCharge = i >= 1 ? digits(lines[i - 1] | 0) : 0;
    const tgtHiW = occHiWordB[i + 1];
    const keepDeltaClose = -closeCharge;
    const dropDeltaOpen = wi - openCharge;
    // Mark which nextB target rows hold any bits (skip ORs sourced from empty rows).
    for (let t = 0; t < STATES; t++) {
      const tBase = t * W;
      let any = 0;
      for (let w = 0; w <= tgtHiW; w++) { any |= nextB[tBase + w]; if (any) break; }
      neActive[t] = any ? 1 : 0;
    }
    for (let s = 0; s < STATES; s++) {
      const drop = DROPM[s] === 1;
      const kt = KT[s];
      if (kt >= 0 && neActive[kt] === 1) {
        // KEEP from s → target kt; rem(s) = rem(kt) + (keep delta). The delta moves
        // the target's reachable set; we OR target's row (shifted by +delta) into s.
        orShifted(cur, s * W, nextB, kt * W, drop ? keepDeltaClose : 0, tgtHiW);
      }
      if (canDrop) {
        const dt = DT[s];
        if (dt >= 0 && neActive[dt] === 1) {
          orShifted(cur, s * W, nextB, dt * W, drop ? wi : dropDeltaOpen, tgtHiW);
        }
      }
    }
    for (let s = 0; s < STATES; s++) maskTop(cur, s * W);
  };

  // bsuf base case at layer n: from an accepting state with no lines left, the only
  // achievable rem is the EOF-close adjustment (a trailing D run owes one final
  // close charge = digits(last line); a trailing K run owes nothing).
  const eofClose = digits(lines[n - 1] | 0);
  const makeBase = (buf) => {
    for (let s = 0; s < STATES; s++) {
      if (!accepting(s)) continue;
      const rem = DROPM[s] === 1 ? -eofClose : 0;
      const idx = rem + OFFSET;
      if (idx >= 0 && idx <= idxMax) buf[s * W + (idx >>> 5)] |= 1 << (idx & 31);
    }
  };

  // ── BACKWARD PASS with checkpoints. checkpoint[c] holds bsuf at layer c*K (and we
  //    always keep layer 0 and layer n). ───────────────────────────────────────
  const K = Math.max(1, Math.floor(Math.sqrt(n)) | 0);
  const numCk = Math.floor(n / K) + 1; // layers 0, K, ..., <= n
  const ckLayers = []; // sorted list of checkpoint layer indices
  for (let c = 0; c < numCk; c++) ckLayers.push(c * K);
  if (ckLayers[ckLayers.length - 1] !== n) ckLayers.push(n);
  const ckBuf = new Map(); // layer → Uint32Array
  for (const L of ckLayers) ckBuf.set(L, new Uint32Array(layerWords));

  let curB = new Uint32Array(layerWords);
  let nxtB = new Uint32Array(layerWords);
  makeBase(curB); // bsuf[n]
  {
    const dst = ckBuf.get(n);
    if (dst === undefined) throw new Error('selectDropsToBand: checkpoint(n) missing.');
    dst.set(curB);
  }
  for (let i = n - 1; i >= 0; i--) {
    nxtB.fill(0);
    stepBackward(curB, nxtB, i);
    const tmp = curB; curB = nxtB; nxtB = tmp;
    // curB is now bsuf[i]
    const dst = ckBuf.get(i);
    if (dst !== undefined) dst.set(curB);
  }
  const bsuf0 = curB; // bsuf[0]

  // ── CHOOSE the winning net from bsuf[0][START] = the full reachable total-net set.
  //    Feasible: smallest net in [netMin, netMax]. Else: nearest the band, smaller
  //    net breaking ties. Index → net is direct here (from START, accum 0, the
  //    EOF-close is already folded into bsuf's base case). Deterministic (lowest
  //    index first). ─────────────────────────────────────────────────────────────
  const startBase = START * W;
  let chosenNet = 0;
  let bandSatisfied = false;
  {
    let bestNet = Infinity;
    for (let idx = 0; idx <= idxMax; idx++) {
      if (getBit(bsuf0, startBase, idx) !== 1) continue;
      const net = idx - OFFSET;
      if (net >= netMin && net <= netMax) {
        if (net < bestNet) {
          bestNet = net;
          chosenNet = net;
          bandSatisfied = true;
        }
      }
    }
    if (!bandSatisfied) {
      let bestDist = Infinity;
      let bestSeen = Infinity;
      for (let idx = 0; idx <= idxMax; idx++) {
        if (getBit(bsuf0, startBase, idx) !== 1) continue;
        const net = idx - OFFSET;
        const dist = net < netMin ? netMin - net : net > netMax ? net - netMax : 0;
        if (dist < bestDist || (dist === bestDist && net < bestSeen)) {
          bestDist = dist;
          bestSeen = net;
          chosenNet = net;
        }
      }
    }
  }
  // The target index at the start (state START, accum 0): we must finish with total
  // net delta exactly chosenNet, i.e. reach rem == chosenNet (index chosenNet+OFFSET).
  const chosenIdx0 = chosenNet + OFFSET;
  if (chosenIdx0 < 0 || chosenIdx0 > idxMax || getBit(bsuf0, startBase, chosenIdx0) !== 1) {
    throw new Error('selectDropsToBand: chosen net is not reachable from the root (internal error).');
  }

  // ── GAP-MINIMISING FORWARD WALK. We descend from (layer 0, START, remNeeded =
  //    chosenNet). At each line i, for the KEEP and DROP options we compute the
  //    target (state, delta) and check, via bsuf[i+1], whether the residual net is
  //    still reachable from there. Among feasible options we prefer the one that
  //    keeps omissions FEW and LARGE:
  //      • if currently dropping  → CONTINUE dropping when feasible (extend the gap);
  //      • if currently keeping   → KEEP when feasible (don't open a new gap),
  //    falling back to the other move only when the preferred one is infeasible.
  //    This lands on the exact chosenNet (bsuf guarantees completability) while
  //    collapsing the incumbent's many minimal gaps into a handful of large ones.
  //    bsuf[i+1] is recomputed block by block from the checkpoints as we advance. ─
  // recomputed block buffers: layers [blockStart .. blockEnd] for the current block.
  const blockBuf = new Array(K + 1);
  for (let k = 0; k <= K; k++) blockBuf[k] = new Uint32Array(layerWords);
  let blockStart = -1; // layer index this block begins at
  let blockEnd = -1; // layer index this block ends at (= min(blockStart+K, n))
  // Returns bsuf at layer L (L in [blockStart, blockEnd]); recomputes the block if L
  // falls outside the currently-loaded one.
  const bsufAt = (L) => {
    if (L < blockStart || L > blockEnd) {
      // load the block whose left edge is the checkpoint at floor(L/K)*K
      const bs = Math.floor(L / K) * K;
      const be = Math.min(bs + K, n);
      const right = ckBuf.get(be);
      if (right === undefined) throw new Error('selectDropsToBand: backward checkpoint missing at ' + be);
      // blockBuf[be-bs] = bsuf[be] (the checkpoint); recompute down to bsuf[bs]
      const top = be - bs;
      blockBuf[top].set(right);
      for (let j = be - 1; j >= bs; j--) {
        const slot = j - bs;
        const nb = blockBuf[slot + 1];
        const cb = blockBuf[slot];
        cb.fill(0);
        stepBackward(nb, cb, j);
      }
      blockStart = bs;
      blockEnd = be;
    }
    const idx = L - blockStart;
    const buf = blockBuf[idx];
    if (buf === undefined) throw new Error('selectDropsToBand: block buffer missing at ' + L);
    return buf;
  };

  const drop = new Array(n).fill(false);
  let walkOk = true;
  try {
    let s = START;
    let remNeeded = chosenNet; // net delta still required over lines i..n-1
    for (let i = 0; i < n; i++) {
      const wi = weights[i] | 0;
      const canDrop = eligible[i] === true;
      const openCharge = markerFixed + digits(lines[i] | 0);
      const closeCharge = i >= 1 ? digits(lines[i - 1] | 0) : 0;
      const dropping = DROPM[s] === 1;
      const kt = KT[s];
      const dt = canDrop ? DT[s] : -1;
      const keepDelta = kt >= 0 && dropping ? -closeCharge : 0; // keep closes a D run
      const dropDelta = dt >= 0 ? (dropping ? wi : wi - openCharge) : 0;
      const nextLayer = i + 1;
      // feasibility of each move: residual = remNeeded - delta must be reachable in
      // bsuf[nextLayer][target].
      const bnext = bsufAt(nextLayer);
      let keepOk = false;
      if (kt >= 0) {
        const rem = remNeeded - keepDelta;
        const idx = rem + OFFSET;
        keepOk = idx >= 0 && idx <= idxMax && getBit(bnext, kt * W, idx) === 1;
      }
      let dropOk = false;
      if (dt >= 0) {
        const rem = remNeeded - dropDelta;
        const idx = rem + OFFSET;
        dropOk = idx >= 0 && idx <= idxMax && getBit(bnext, dt * W, idx) === 1;
      }
      let chooseDrop;
      if (dropping) {
        // extend the gap if we still can; otherwise close it by keeping
        if (dropOk) chooseDrop = true;
        else if (keepOk) chooseDrop = false;
        else { walkOk = false; break; }
      } else {
        // avoid opening a gap; keep if we still can, otherwise open one
        if (keepOk) chooseDrop = false;
        else if (dropOk) chooseDrop = true;
        else { walkOk = false; break; }
      }
      if (chooseDrop) {
        drop[i] = true;
        s = dt;
        remNeeded -= dropDelta;
      } else {
        drop[i] = false;
        s = kt;
        remNeeded -= keepDelta;
      }
    }
    // Terminal check: at layer n the residual must be exactly what bsuf[n] encodes
    // for state s — i.e. the EOF-close adjustment (−eofClose for a trailing D run,
    // 0 for a trailing K run) — and s must be accepting.
    if (walkOk) {
      const want = accepting(s) ? (DROPM[s] === 1 ? -eofClose : 0) : NaN;
      if (remNeeded !== want) walkOk = false;
    }
  } catch (e) {
    walkOk = false;
  }

  if (walkOk) {
    return { drop, netRemoved: chosenNet, bandSatisfied };
  }

  // ── FALLBACK (defensive; should not trigger). A plain forward reachability +
  //    backpointer reconstruction that also lands on chosenNet — only the witness
  //    differs (it may fragment), never the net or the band. Reuses the same state
  //    machine, recomputing forward layers without storing them all. ──────────────
  return fallbackReconstruct();

  // ────────────────────────────────────────────────────────────────────────────
  function fallbackReconstruct() {
    // FORWARD occupancy ceiling (mirror of the backward one).
    const occHiWordF = new Int32Array(n + 1);
    {
      let pe = 0;
      occHiWordF[0] = Math.min(idxMax, OFFSET) >>> 5;
      for (let i = 0; i < n; i++) {
        if (eligible[i] === true) pe += weights[i] | 0;
        occHiWordF[i + 1] = Math.min(idxMax, OFFSET + pe) >>> 5;
      }
    }
    const stepForward = (cur, next, i) => {
      const wi = weights[i] | 0;
      const canDrop = eligible[i] === true;
      const openCharge = markerFixed + digits(lines[i] | 0);
      const closeCharge = i >= 1 ? digits(lines[i - 1] | 0) : 0;
      const srcHiW = occHiWordF[i];
      const keepDeltaClose = -closeCharge;
      const dropDeltaOpen = wi - openCharge;
      for (let s = 0; s < STATES; s++) {
        const sBase = s * W;
        let any = 0;
        for (let w = 0; w <= srcHiW; w++) { any |= cur[sBase + w]; if (any) break; }
        if (!any) continue;
        const dpm = DROPM[s] === 1;
        const kt = KT[s];
        if (kt >= 0) orShifted(next, kt * W, cur, sBase, dpm ? keepDeltaClose : 0, srcHiW);
        if (canDrop) {
          const dt = DT[s];
          if (dt >= 0) orShifted(next, dt * W, cur, sBase, dpm ? wi : dropDeltaOpen, srcHiW);
        }
      }
      for (let s = 0; s < STATES; s++) maskTop(next, s * W);
    };
    // forward checkpoints
    const fCk = new Map();
    for (const L of ckLayers) fCk.set(L, new Uint32Array(layerWords));
    let cf = new Uint32Array(layerWords);
    let nf = new Uint32Array(layerWords);
    cf[START * W + (OFFSET >>> 5)] |= 1 << (OFFSET & 31);
    {
      const d0 = fCk.get(0);
      if (d0 !== undefined) d0.set(cf);
    }
    for (let i = 0; i < n; i++) {
      nf.fill(0);
      stepForward(cf, nf, i);
      const tmp = cf; cf = nf; nf = tmp;
      const dst = fCk.get(i + 1);
      if (dst !== undefined) dst.set(cf);
    }
    const reachN = cf;
    // choose terminal (state, idx) matching chosenNet/band
    let chosenState = -1;
    let chosenIdx = -1;
    for (let s = 0; s < STATES; s++) {
      if (!accepting(s)) continue;
      const base = s * W;
      const dshift = DROPM[s] === 1 ? eofClose : 0;
      for (let idx = 0; idx <= idxMax; idx++) {
        if (getBit(reachN, base, idx) !== 1) continue;
        if (idx - OFFSET - dshift === chosenNet) { chosenState = s; chosenIdx = idx; break; }
      }
      if (chosenState >= 0) break;
    }
    if (chosenState < 0) throw new Error('selectDropsToBand: fallback could not match chosen net.');
    const fdrop = new Array(n).fill(false);
    const pool = new Array(K);
    for (let k = 0; k < K; k++) pool[k] = new Uint32Array(layerWords);
    let tgtState = chosenState;
    let tgtIdx = chosenIdx;
    let bEnd = n;
    while (bEnd > 0) {
      const startLayer = Math.floor((bEnd - 1) / K) * K;
      const cp = fCk.get(startLayer);
      if (cp === undefined) throw new Error('selectDropsToBand: fallback checkpoint missing.');
      const span = bEnd - startLayer;
      const layers = new Array(span + 1);
      layers[0] = cp;
      let c2 = cp;
      for (let k = 0; k < span; k++) {
        const nl = pool[k];
        if (nl === undefined) throw new Error('selectDropsToBand: fallback pool underflow.');
        nl.fill(0);
        stepForward(c2, nl, startLayer + k);
        layers[k + 1] = nl;
        c2 = nl;
      }
      let curState = tgtState;
      let curIdx = tgtIdx;
      for (let k = span - 1; k >= 0; k--) {
        const i = startLayer + k;
        const li = layers[k];
        if (li === undefined) throw new Error('selectDropsToBand: fallback layer missing.');
        const wi = weights[i] | 0;
        const openCharge = markerFixed + digits(lines[i] | 0);
        const closeCharge = i >= 1 ? digits(lines[i - 1] | 0) : 0;
        let found = false;
        for (let p = 0; p < STATES; p++) {
          if (KT[p] !== curState) continue;
          const keepDelta = DROPM[p] === 1 ? -closeCharge : 0;
          const prevIdx = curIdx - keepDelta;
          if (prevIdx >= 0 && prevIdx <= idxMax && getBit(li, p * W, prevIdx) === 1) {
            fdrop[i] = false; curState = p; curIdx = prevIdx; found = true; break;
          }
        }
        if (!found && eligible[i] === true) {
          for (let p = 0; p < STATES; p++) {
            if (DT[p] !== curState) continue;
            const dropDelta = DROPM[p] === 1 ? wi : wi - (markerFixed + digits(lines[i] | 0));
            const prevIdx = curIdx - dropDelta;
            if (prevIdx >= 0 && prevIdx <= idxMax && getBit(li, p * W, prevIdx) === 1) {
              fdrop[i] = true; curState = p; curIdx = prevIdx; found = true; break;
            }
          }
        }
        if (!found) throw new Error('selectDropsToBand: fallback reconstruction inconsistency.');
      }
      tgtState = curState;
      tgtIdx = curIdx;
      bEnd = startLayer;
    }
    if (tgtState !== START || tgtIdx !== OFFSET) {
      throw new Error('selectDropsToBand: fallback did not terminate at START with net 0.');
    }
    return { drop: fdrop, netRemoved: chosenNet, bandSatisfied };
  }
}
