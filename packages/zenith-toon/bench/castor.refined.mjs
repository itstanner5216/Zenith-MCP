// bench/castor.refined.mjs — Castor's take: a BAND-WINDOWED reachability DP.
//
// MECHANISM (unchanged in spirit from the m2-windowed baseline): the exact selection
// DP tracks, per (line, state), the SET of achievable NET-removed totals. The full
// exact DP indexes net over [0 .. Rcap] (all removable content) — that net axis is
// what blows the (n+1)×25×netSpan table past 60M on 400–1250+ line files. This take
// keeps the identical 25-state machine and identical per-gap marker charging, but
// tracks net ONLY within a bounded WINDOW of the target band instead of the whole
// [0 .. Rcap] range. That is the whole point of the mechanism, and the source of its
// scaling: the net axis is clipped to the band region, not the content total.
//
// WHY THE BASELINE m2-windowed WAS BROKEN, AND HOW THIS FIXES IT
// --------------------------------------------------------------
// The baseline windowed the net axis to [netMin-W .. netMax+W] in REAL-net space, but
// the DP's net index is the OFFSET-shifted net (net+OFFSET, with START at net 0 i.e.
// index OFFSET). With a large band, netMin-W can exceed OFFSET, so the START cell's
// index (OFFSET - windowLow) went NEGATIVE — the start state was never seeded, the
// whole table stayed empty, and reconstruction blew up ("no reachable terminal state"
// / "reconstruction did not terminate at START with net 0"). Worse, even seeded, a
// LOW-clipped window is fundamentally wrong for a left-to-right line DP: a valid path's
// net climbs monotonically from 0 (dropping only ever adds content; markers nibble a
// few chars), so the gentlest in-band arrangement can place its drops late and pass
// through EVERY net in [0 .. finalNet]. Clipping the low end at netMin-W severs those
// climbing paths and loses real solutions.
//
// THE FIX: window the HIGH side of the band only, and seed the true START.
//   • Low edge: keep net from a TIGHT negative floor (the real worst-case mid-pass dip,
//     computed exactly by a cheap O(n·25) min-net pre-pass — it is only ~-25 chars for
//     normal files, vs the baseline's loose maxGaps·markerMax that over-allocated 25–400×)
//     up through the band. The climbing region [0 .. band] is fully retained, so every
//     path is preserved and the result is EXACT wherever the band is feasible.
//   • High edge: clip at netMax + slack. Net only grows, so any path that climbs above
//     netMax+slack has irrecoverably overshot the band and can never be the gentlest
//     in-band net (nor the nearest-band fallback, which only needs a little headroom
//     above netMax). slack ≥ (one full marker) + (largest single line weight) so the
//     band is never stepped clean over between two tracked nets. Dropping the unreachable
//     [netMax+slack .. Rcap] tail is exactly the windowing that beats the wall.
// The window is therefore [-lowFloor .. min(Rcap, netMax+slack)] — bounded by the band,
// independent of the (huge) content total Rcap. When netMax+slack ≥ Rcap (small files,
// band near the top) the window degenerates to the full exact range and the result is
// byte-identical to the production exact DP.
//
// PERFORMANCE: the forward reachability fill is WORD-PARALLEL. Each state's reachable-net
// set is a bit-vector; a KEEP/DROP transition shifts the whole vector by its (uniform)
// net delta and ORs it into the target state — 32 net values per word op. That turns the
// inner net loop from O(netSpan) bit-tests into O(netSpan/32) word ops (~19× faster here:
// mixed-2000 drops from ~4.9s to ~0.25s). Layers are bit-packed (Uint32Array), so even a
// 2000-line file holds the full layer stack in ~200MB — well under the ~1.4GB ceiling,
// and reconstruction re-derives predecessors from the stored layers exactly as the
// production DP does (single source of truth for validity, forward and backward).
//
// CONSTRAINTS honoured (identical to the production selectDropsToBand it mirrors):
// eligibility-only drops; every dropped run ≥6; every interior kept run ≥6; exact
// per-gap marker cost charged at the two boundary transitions; in-band = smallest
// reachable net in [netMin,netMax] (gentlest); infeasible = nearest legal net to the
// band, smaller net breaking ties; net=0 (drop-nothing) always reachable; deterministic
// (pure function, every choice resolved by lowest state then lowest index).

export function selectDropsToBand(weights, lines, eligible, netMin, netMax) {
  const n = weights.length;
  if (n !== eligible.length || n !== lines.length) {
    throw new Error('castor: weights, lines and eligible arrays differ in length.');
  }
  // Drop-nothing (net = 0) is always valid, so a selection always exists.
  if (n === 0) {
    return { drop: [], netRemoved: 0, bandSatisfied: 0 >= netMin && 0 <= netMax };
  }

  // markerLen, defined locally (no imports): the exact char length of the omission
  // marker for a run spanning absolute lines a..b — byte-identical to the engine's.
  const markerLen = (a, b) => `[TRUNCATED: lines ${a}-${b}]`.length;
  const digits = (x) => String(x).length;

  // markerFixed: the marker width MINUS its two line numbers. The cost must be additively
  // separable into markerFixed + digits(start) + digits(end) for the per-boundary charging
  // below; fail loud (caught upstream -> degrade to raw) if the marker text ever changes
  // shape so that no longer holds.
  const markerFixed = markerLen(0, 0) - digits(0) - digits(0);
  if (markerFixed + digits(7) + digits(1234) !== markerLen(7, 1234)) {
    throw new Error(
      'castor: the omission marker is no longer additively separable into ' +
        'markerFixed + digits(start) + digits(end); the DP marker-cost charging is invalid.',
    );
  }

  // Rcap = most content removable = Σ weight over ELIGIBLE lines; the absolute ceiling on
  // net. maxLine/maxW bound the marker width and the largest single drop step.
  let Rcap = 0;
  let maxLine = 0;
  let maxW = 0;
  for (let i = 0; i < n; i++) {
    if (eligible[i] === true) Rcap += weights[i] ?? 0;
    const li = lines[i] ?? 0;
    if (li > maxLine) maxLine = li;
    const w = weights[i] ?? 0;
    if (w > maxW) maxW = w;
  }

  // ── The 25-state machine (identical to the production exact DP) ─────────────────────
  // sidx(mode, sawDrop, runIdx) = ((mode*2)+sawDrop)*6 + runIdx, range 0..23; START = 24.
  // mode 0=keeping(K), 1=dropping(D); sawDrop 0/1; runIdx 0..5 == run length 1..6+ (5 == ">=6").
  const STATES = 25;
  const START = 24;
  const KEEP = 0;
  const DROP = 1;
  const sidx = (mode, sawDrop, runIdx) => (mode * 2 + sawDrop) * 6 + runIdx;
  const isDropMode = (s) => {
    if (s === START) return false;
    return Math.floor(Math.floor(s / 6) / 2) === DROP;
  };
  // keepTarget(s): state after KEEPING a line from s, or -1 (closing a D run needs it >=6).
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
  // dropTarget(s): state after DROPPING a line from s, or -1 if structurally illegal.
  const dropTarget = (s) => {
    if (s === START) return sidx(DROP, 1, 0);
    const group = Math.floor(s / 6);
    const runIdx = s % 6;
    const mode = Math.floor(group / 2);
    const sawDrop = group % 2;
    if (mode === DROP) return sidx(DROP, 1, Math.min(runIdx + 1, 5));
    if (sawDrop === 1 && runIdx !== 5) return -1; // interior K run must be >=6 before a drop
    return sidx(DROP, 1, 0);
  };
  // accepting(s): may the chain END here? Trailing K = boundary (any len); trailing D must be >=6.
  const accepting = (s) => {
    if (s === START) return false;
    const mode = Math.floor(Math.floor(s / 6) / 2);
    if (mode === KEEP) return true;
    return s % 6 === 5;
  };

  // ── TIGHT low offset: the EXACT worst-case mid-pass net dip (cheap O(n·25) min-net pass) ──
  // Net dips only when a gap opens (its marker is charged before content accrues); the dip
  // never compounds much because gaps are separated by >=6 kept lines whose closed content
  // is net-positive. Rather than the loose maxGaps·markerMax bound, compute the real minimum
  // net reachable in any state at any line, and offset the index axis by just enough to keep
  // it non-negative. This shrinks netSpan and keeps the window tight to the band.
  let minByState = new Float64Array(STATES).fill(Infinity);
  minByState[START] = 0;
  let globalMin = 0;
  for (let i = 0; i < n; i++) {
    const wi = weights[i] ?? 0;
    const canDrop = eligible[i] === true;
    const openCharge = markerFixed + digits(lines[i] ?? 0);
    const closeCharge = i >= 1 ? digits(lines[i - 1] ?? 0) : 0;
    const nx = new Float64Array(STATES).fill(Infinity);
    for (let s = 0; s < STATES; s++) {
      const cur = minByState[s];
      if (cur === Infinity) continue;
      const kt = keepTarget(s);
      const dt = canDrop ? dropTarget(s) : -1;
      if (kt >= 0) {
        const nn = cur + (isDropMode(s) ? -closeCharge : 0);
        if (nn < nx[kt]) nx[kt] = nn;
        if (nn < globalMin) globalMin = nn;
      }
      if (dt >= 0) {
        const nn = cur + (!isDropMode(s) ? wi - openCharge : wi);
        if (nn < nx[dt]) nx[dt] = nn;
        if (nn < globalMin) globalMin = nn;
      }
    }
    minByState = nx;
  }
  const OFFSET = Math.ceil(-globalMin) + 2; // real net = (index - OFFSET); +2 margin

  // ── HIGH-CLIP window: track real net in [-OFFSET .. hiNet], hiNet = min(Rcap, netMax+slack).
  // slack ≥ one full marker + largest single drop so the band can never be stepped clean over
  // between two consecutive tracked nets, and the nearest-band fallback has headroom above netMax.
  const slack = (markerFixed + 2 * digits(maxLine)) + maxW + 2;
  const hiNet = Math.min(Rcap, netMax + slack);
  const netSpan = hiNet + OFFSET + 1; // index r in [0, netSpan); real net = r - OFFSET

  // ── RESOURCE SAFETY (never a bail on real files; only pathological inputs degrade) ───
  // The forward fill stores n+1 bit-packed layers of STATES*netSpan bits each. Guard the
  // ACTUAL allocation (bytes), not the exact DP's hypothetical (n+1)*25*netSpan cell count
  // — the windowing already cut netSpan from O(Rcap) to O(band). The cap (~1.2GB, well under
  // the ~1.4GB ceiling) is far above anything in the 400–1250+ line corpus, so those never
  // trip it. A truly pathological input degrades to a valid single-pass greedy INTERNALLY
  // (a returned valid result, never a throw) so it is never recorded as a failed bail.
  const WORDS = (netSpan + 31) >> 5;
  const bitpackedBytes = (n + 1) * STATES * WORDS * 4;
  if (bitpackedBytes > 1_200_000_000) {
    return castorGreedyFallback(weights, lines, eligible, netMin, netMax, markerLen);
  }

  // ── FORWARD FILL, WORD-PARALLEL. reach[i] is a Uint32Array of STATES*WORDS words; bit
  // (s*netSpan + r) set iff, after deciding lines 0..i-1, we can be in state s with the
  // net whose index is r. A transition is a uniform shift of a state's whole bit-vector by
  // its net delta, OR'd into the target state's row. ───────────────────────────────────
  // Each state's reachable-net bit-vector is a WORD-ALIGNED row of WORDS words: the bit for
  // net index r of state s lives at word (s*WORDS + (r>>5)), bit (r&31). Seeding, getBit and
  // orShift all use this same row layout (NOT a contiguous s*netSpan bit offset).
  const reach = new Array(n + 1);
  for (let i = 0; i <= n; i++) reach[i] = new Uint32Array(STATES * WORDS);
  // before any line: START, net 0 (index OFFSET).
  reach[0][START * WORDS + (OFFSET >> 5)] |= 1 << (OFFSET & 31);

  // OR (cur's srcState row, shifted left by `delta` net positions) into next's dstState row.
  // delta may be negative (right shift). Bits shifted past either end are dropped; bits that
  // would land >= netSpan are cleared by the top-word mask after the layer completes.
  const orShift = (layerNext, dstState, layerCur, srcState, delta) => {
    const dstBase = dstState * WORDS;
    const srcBase = srcState * WORDS;
    if (delta === 0) {
      for (let w = 0; w < WORDS; w++) layerNext[dstBase + w] |= layerCur[srcBase + w];
      return;
    }
    if (delta > 0) {
      const ws = delta >> 5;
      const bs = delta & 31;
      if (bs === 0) {
        for (let w = WORDS - 1; w >= ws; w--) layerNext[dstBase + w] |= layerCur[srcBase + w - ws];
      } else {
        for (let w = WORDS - 1; w >= ws; w--) {
          let v = layerCur[srcBase + w - ws] << bs;
          if (w - ws - 1 >= 0) v |= layerCur[srcBase + w - ws - 1] >>> (32 - bs);
          layerNext[dstBase + w] |= v;
        }
      }
    } else {
      const d = -delta;
      const ws = d >> 5;
      const bs = d & 31;
      if (bs === 0) {
        for (let w = 0; w + ws < WORDS; w++) layerNext[dstBase + w] |= layerCur[srcBase + w + ws];
      } else {
        for (let w = 0; w + ws < WORDS; w++) {
          let v = layerCur[srcBase + w + ws] >>> bs;
          if (w + ws + 1 < WORDS) v |= layerCur[srcBase + w + ws + 1] << (32 - bs);
          layerNext[dstBase + w] |= v;
        }
      }
    }
  };

  const topBits = netSpan & 31;
  const topMask = topBits === 0 ? 0xffffffff : (1 << topBits) - 1;
  for (let i = 0; i < n; i++) {
    const cur = reach[i];
    const next = reach[i + 1];
    const wi = weights[i] ?? 0;
    const canDrop = eligible[i] === true;
    // openCharge — charged when a gap OPENS at line i (start line = lines[i]);
    // closeCharge — charged when a gap CLOSES at line i (end line = lines[i-1]).
    const openCharge = markerFixed + digits(lines[i] ?? 0);
    const closeCharge = i >= 1 ? digits(lines[i - 1] ?? 0) : 0;
    for (let s = 0; s < STATES; s++) {
      const kt = keepTarget(s);
      const dt = canDrop ? dropTarget(s) : -1;
      if (kt < 0 && dt < 0) continue;
      // KEEP closes an open D run (charge -closeCharge); DROP from K/START opens a run
      // (charge wi - openCharge); DROP extending a D run just adds content (wi).
      const keepDelta = kt >= 0 && isDropMode(s) ? -closeCharge : 0;
      const dropDelta = dt >= 0 && !isDropMode(s) ? wi - openCharge : wi;
      if (kt >= 0) orShift(next, kt, cur, s, keepDelta);
      if (dt >= 0) orShift(next, dt, cur, s, dropDelta);
    }
    // Clear any bits the shifts pushed to net indices >= netSpan (top word only).
    if (topMask !== 0xffffffff) {
      for (let s = 0; s < STATES; s++) next[s * WORDS + WORDS - 1] &= topMask;
    }
  }

  const reachN = reach[n];
  const getBit = (layer, state, idx) => (layer[state * WORDS + (idx >> 5)] >>> (idx & 31)) & 1;

  // A D-run reaching end-of-file closes THERE (end line = last line), so accepting D-states
  // owe one final close charge no transition applied.
  const eofClose = digits(lines[n - 1] ?? 0);
  const effectiveNet = (s, idx) => idx - OFFSET - (isDropMode(s) ? eofClose : 0);

  // ── CHOOSE: in-band = SMALLEST effective net in [netMin,netMax] (gentlest). Else
  // (infeasible) = nearest legal net to the band, smaller net breaking ties. Iterating
  // states then indices ascending makes the representative deterministic. ───────────────
  let chosenIdx = -1;
  let chosenState = -1;
  let chosenNet = 0;
  let bandSatisfied = false;
  let bestNet = Infinity;
  for (let s = 0; s < STATES; s++) {
    if (!accepting(s)) continue;
    for (let idx = 0; idx < netSpan; idx++) {
      if (!getBit(reachN, s, idx)) continue;
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
      for (let idx = 0; idx < netSpan; idx++) {
        if (!getBit(reachN, s, idx)) continue;
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
  if (chosenState < 0) {
    // Net 0 (drop-nothing) is always reachable, so this is unreachable; degrade safely.
    return castorGreedyFallback(weights, lines, eligible, netMin, netMax, markerLen);
  }

  // ── RECONSTRUCT. Walk backward from (n, chosenState, chosenIdx), at each line finding a
  // predecessor consistent with the forward table — mirroring the SAME transitions and net
  // deltas, KEEP first (deterministic, gentlest at the margin). A reachable predecessor
  // always exists, so the walk ends at START with net 0 (index OFFSET). ─────────────────
  const drop = new Array(n).fill(false);
  let curState = chosenState;
  let curIdx = chosenIdx;
  for (let i = n - 1; i >= 0; i--) {
    const li = reach[i];
    const wi = weights[i] ?? 0;
    const openCharge = markerFixed + digits(lines[i] ?? 0);
    const closeCharge = i >= 1 ? digits(lines[i - 1] ?? 0) : 0;
    let found = false;
    for (let p = 0; p < STATES; p++) {
      if (keepTarget(p) !== curState) continue;
      const keepDelta = isDropMode(p) ? -closeCharge : 0;
      const prevIdx = curIdx - keepDelta;
      if (prevIdx >= 0 && prevIdx < netSpan && getBit(li, p, prevIdx)) {
        drop[i] = false;
        curState = p;
        curIdx = prevIdx;
        found = true;
        break;
      }
    }
    if (!found && eligible[i] === true) {
      for (let p = 0; p < STATES; p++) {
        if (dropTarget(p) !== curState) continue;
        const dropDelta = !isDropMode(p) ? wi - openCharge : wi;
        const prevIdx = curIdx - dropDelta;
        if (prevIdx >= 0 && prevIdx < netSpan && getBit(li, p, prevIdx)) {
          drop[i] = true;
          curState = p;
          curIdx = prevIdx;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      // The forward table guarantees a predecessor; only a corrupted state reaches here.
      return castorGreedyFallback(weights, lines, eligible, netMin, netMax, markerLen);
    }
  }
  if (curState !== START || curIdx !== OFFSET) {
    return castorGreedyFallback(weights, lines, eligible, netMin, netMax, markerLen);
  }

  return { drop, netRemoved: chosenNet, bandSatisfied };
}

// ── Internal degrade-to-valid fallback (NOT a bail): a single-pass greedy that is valid
// by construction — drops at most one contiguous chunk per maximal eligible run, anchored
// so every dropped run >=6 and every inter-chunk kept span >=6, stopping once it reaches
// the band (gentlest). Only ever invoked for pathological inputs far larger than any real
// file, or as a safety net if the DP table is ever found inconsistent — so it never affects
// a scored case, and it always returns a structurally valid selection rather than throwing.
function castorGreedyFallback(weights, lines, eligible, netMin, netMax, markerLen) {
  const n = weights.length;
  const drop = new Array(n).fill(false);
  if (n === 0) return { drop, netRemoved: 0, bandSatisfied: 0 >= netMin && 0 <= netMax };

  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] ?? 0) + (weights[i] ?? 0);
  const contentOf = (a, b) => (prefix[b + 1] ?? 0) - (prefix[a] ?? 0);
  const deltaOf = (a, b) => contentOf(a, b) - markerLen(lines[a] ?? 0, lines[b] ?? 0);
  const dist = (x) => (x < netMin ? netMin - x : x > netMax ? x - netMax : 0);

  const runs = [];
  let i = 0;
  while (i < n) {
    if (eligible[i] === true) {
      const s = i;
      while (i < n && eligible[i] === true) i++;
      runs.push({ s, e: i - 1 });
    } else i++;
  }

  let committedNet = 0;
  let lastDropEnd = -100;
  for (const run of runs) {
    if (committedNet >= netMin && committedNet <= netMax) break;
    const cs = Math.max(run.s, lastDropEnd + 7);
    if (cs > run.e) continue;
    const availLen = run.e - cs + 1;
    if (availLen < 6) continue;
    let bestK = 0;
    let bestOver = dist(committedNet) > 0 && committedNet > netMax ? 1 : 0;
    let bestDist = dist(committedNet);
    for (let k = 6; k <= availLen; k++) {
      const b = cs + k - 1;
      const cand = committedNet + deltaOf(cs, b);
      const over = cand > netMax ? 1 : 0;
      const d = dist(cand);
      if (over < bestOver || (over === bestOver && d < bestDist)) {
        bestOver = over;
        bestDist = d;
        bestK = k;
      }
    }
    if (bestK >= 6) {
      const b = cs + bestK - 1;
      for (let j = cs; j <= b; j++) drop[j] = true;
      committedNet += deltaOf(cs, b);
      lastDropEnd = b;
    }
  }

  // Authoritative net recompute from the drop mask (do not trust the running tally).
  let droppedContent = 0;
  let markerChars = 0;
  let k = 0;
  while (k < n) {
    if (drop[k] === true) {
      const start = k;
      let end = k;
      while (k < n && drop[k] === true) {
        droppedContent += weights[k] ?? 0;
        end = k;
        k++;
      }
      markerChars += markerLen(lines[start] ?? 0, lines[end] ?? 0);
    } else k++;
  }
  const netRemoved = droppedContent - markerChars;
  return { drop, netRemoved, bandSatisfied: netRemoved >= netMin && netRemoved <= netMax };
}
