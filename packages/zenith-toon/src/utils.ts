// utils.ts — math + serialization helpers for the source compression route.
//
// Pure, engine-agnostic. Nothing here scores, ranks, weights, or decides.
//
// computeGini and findKneedle were REMOVED: an engine's ranking must be produced
// — final and directly usable by the next engine — INSIDE that engine's own core
// process, never computed, weighted, normalized, or knee-detected by an outside
// helper. SageRank owns its own bounded-core knee detection internally; nothing
// out here touches an engine's output. (blake2bHash / normalizeValue /
// flattenToText log-codec heritage were removed earlier.)
//
// What survives is genuinely mechanical and used: deterministic serialization +
// token estimation (the budget engine calls these), and pearsonR as TELEMETRY
// ONLY (it observes engine agreement; it never feeds a ranking decision).

// ---------------------------------------------------------------------------
// canonicalJson — deterministic serialization (used by estimateTokensObj)
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys at every nesting level so serialization is
 * deterministic regardless of insertion order.
 */
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(sortKeysDeep);
  }
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const sorted = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const k of sorted) {
      result[k] = sortKeysDeep(obj[k]);
    }
    return result;
  }
  return v;
}

/** Deterministic JSON serialization (sorted keys; non-serializable -> String()). */
export function canonicalJson(obj: unknown): string {
  const sorted = sortKeysDeep(obj);
  return JSON.stringify(sorted, (_key: string, value: unknown): unknown => {
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string' ||
      Array.isArray(value) ||
      (typeof value === 'object')
    ) {
      return value;
    }
    // Non-JSON-serializable: use String()
    return String(value);
  });
}

// ---------------------------------------------------------------------------
// estimateTokens / estimateTokensObj
// ---------------------------------------------------------------------------

/**
 * Conservative token estimation. JSON: chars/2, text: chars/4.
 */
export function estimateTokens(text: string): number {
  if (text.startsWith('{') || text.startsWith('[')) {
    return Math.max(1, Math.floor(text.length / 2));
  }
  return Math.max(1, Math.floor(text.length / 4));
}

/** Estimate tokens for an arbitrary value via canonical JSON. */
export function estimateTokensObj(obj: unknown): number {
  return estimateTokens(canonicalJson(obj));
}

// ---------------------------------------------------------------------------
// pearsonR — TELEMETRY ONLY (observes engine agreement; never decides a ranking)
// ---------------------------------------------------------------------------

/**
 * Pearson correlation coefficient between two equal-length lists.
 *
 * Returns 0.0 for degenerate inputs (n < 3 or zero variance). Used ONLY to
 * observe redundancy between two engines' score curves as telemetry — it must
 * never feed back into any engine's ranking or any keep/drop decision.
 */
export function pearsonR(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) {
    return 0.0;
  }
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined || yi === undefined) {
      throw new Error('invariant: x and y must have identical length');
    }
    sumX += xi;
    sumY += yi;
  }
  const mx = sumX / n;
  const my = sumY / n;

  let cov = 0.0;
  let varX = 0.0;
  let varY = 0.0;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined || yi === undefined) {
      throw new Error('invariant: x and y must have identical length');
    }
    const dx = xi - mx;
    const dy = yi - my;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const sx = Math.sqrt(varX);
  const sy = Math.sqrt(varY);
  if (sx < 1e-10 || sy < 1e-10) {
    return 0.0;
  }
  return cov / (sx * sy);
}
