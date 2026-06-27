/**
 * BMX+ — Entropy-Weighted Lexical Search via Term-At-A-Time Evaluation.
 *
 * Successor to BMX (arXiv:2408.06643). Builds on BM25's proven TF saturation
 * curve with three innovations:
 *   1. Term-adaptive entropy-aware IDF (γt = IDFt / IDF_max)
 *   2. Variance-blended informativeness (Shannon ↔ IDF, smooth transition)
 *   3. tanh Soft-AND coverage bonus (RankEvolve-inspired, anti-dominance)
 *
 * All executed within a TAAT posting-list architecture for 3.4–30× speedup.
 *
 * For the source route this is the lexical RELEVANCE engine: build the index
 * once over code blocks (chunk_id = block/line-range id), search once with a
 * scan query, read the ranking. The index is build-once / read-once — the
 * incremental streaming API (updateIndex/removeFromIndex + lazy dirty-term
 * recomputation) and the unused alpha/beta self-tuning knobs were removed;
 * neither ever fed search().
 */

import type { Payload } from './compress-source.js';
import { removalEngine } from './removal.js';

// Module-level word regex
// JS \w is not unicode-aware — use \p{L} and \p{N} for equivalent behavior
// with the 'u' flag to match \w's unicode behavior.
const _WORD_RE = /[\p{L}\p{N}_]+/gu;

/**
 * Padé rational approximation to σ(x) = 1/(1+e^-x). |error| < 0.01.
 */
function _fastSigmoid(x: number): number {
  if (x >= 8.0) return 1.0;
  if (x <= -8.0) return 0.0;
  const x2 = x * x;
  const x3 = x2 * x;
  return (x3 + 6.0 * x + 12.0) / (x3 + 12.0 * x + 48.0);
}

interface Chunk {
  chunk_id: string;
  text: string;
}

export class BMXPlusIndex {
  // ── Public configuration ──
  readonly normalizeScores: boolean;

  // ── Document storage ──
  private _documents: Map<string, string[]>;
  private _docLengths: Map<string, number>;
  private _avgDocLength: number;
  private _totalDocs: number;
  private _isBuilt: boolean;

  // ── Posting lists: term → {chunk_id: tf} ──
  private _postingLists: Map<string, Map<string, number>>;

  // ── Frequencies and IDF ──
  private _docFreqs: Map<string, number>;
  private _idfCache: Map<string, number>;

  // ── Entropy state ──
  private _termTotalFreqs: Map<string, number>;
  private _termEntropy: Map<string, number>;
  private _termInfo: Map<string, number>;

  // ── Term-adaptive scaling ──
  private _idfMax: number;

  constructor(normalizeScores: boolean = false) {
    this.normalizeScores = normalizeScores;

    this._documents = new Map();
    this._docLengths = new Map();
    this._avgDocLength = 0.0;
    this._totalDocs = 0;
    this._isBuilt = false;

    this._postingLists = new Map();
    this._docFreqs = new Map();
    this._idfCache = new Map();

    this._termTotalFreqs = new Map();
    this._termEntropy = new Map();
    this._termInfo = new Map();

    this._idfMax = 1.0;
  }

  // ════════════════════════════════════════════════════════════════════
  //  Tokenisation
  // ════════════════════════════════════════════════════════════════════

  /**
   * JS /g regex is stateful — use String.prototype.match which returns all
   * matches without the statefulness issue of repeated .test()/.exec() calls.
   */
  static _tokenize(text: string): string[] {
    // String.match with /g returns all matches as string[] or null
    // We use the unicode-aware regex defined above
    const lower = text.toLowerCase();
    const matches = lower.match(_WORD_RE);
    return matches !== null ? matches : [];
  }

  // ════════════════════════════════════════════════════════════════════
  //  Term-Adaptive Scaling
  // ════════════════════════════════════════════════════════════════════

  private _computeIdfMax(): void {
    // Compute IDF_max for term-adaptive scaling: γt = IDFt / IDF_max
    // Rare terms get full entropy weight, common terms get none,
    // independent of corpus size.
    if (this._idfCache.size > 0) {
      let max = -Infinity;
      for (const v of this._idfCache.values()) {
        if (v > max) max = v;
      }
      this._idfMax = max;
    } else {
      this._idfMax = 1.0;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Entropy Computation
  // ════════════════════════════════════════════════════════════════════

  /** Lucene-variant BM25 IDF (always non-negative). */
  private _computeIdf(term: string): number {
    const df = this._docFreqs.get(term) ?? 0;
    const N = this._totalDocs;
    if (df > 0 && N > 0) {
      return Math.log((N - df + 0.5) / (df + 0.5) + 1.0);
    }
    return 0.0;
  }

  /**
   * Compute term informativeness via smoothly blended entropy.
   *
   * Blends Shannon entropy (when TFs vary across documents) with
   * IDF-derived informativeness (1 - df/N) using TF variance as
   * the interpolation weight. This avoids a hard discontinuity
   * when a single document with tf=2 flips the computation regime.
   */
  private _computeTermEntropies(terms?: Set<string>): void {
    const target: Set<string> =
      terms !== undefined ? terms : new Set(this._docFreqs.keys());
    const N = this._totalDocs;

    for (const term of target) {
      const df = this._docFreqs.get(term) ?? 0;
      this._idfCache.set(term, this._computeIdf(term));

      if (df < 2) {
        this._termEntropy.set(term, 0.0);
        this._termInfo.set(term, 1.0);
        continue;
      }

      const posting = this._postingLists.get(term);
      if (!posting || posting.size === 0) {
        this._termEntropy.set(term, 1.0);
        this._termInfo.set(term, 0.0);
        continue;
      }

      // IDF-derived informativeness (always available)
      const idfInfo = N > 0 ? 1.0 - df / N : 0.0;

      // Compute TF variance to determine blend weight
      const tfVals: number[] = [...posting.values()];
      const nPost = tfVals.length;
      const meanTf = tfVals.reduce((a, b) => a + b, 0) / nPost;
      const variance =
        tfVals.reduce((acc, v) => acc + (v - meanTf) ** 2, 0) / nPost;

      // Smooth blend: α→0 when uniform, α→1 when varied
      // epsilon=1.0 gives a gentle sigmoid-like transition
      const blendAlpha = variance / (variance + 1.0);

      if (blendAlpha < 0.001) {
        // Essentially uniform — pure IDF-derived info
        this._termInfo.set(term, idfInfo);
        this._termEntropy.set(term, 1.0 - idfInfo);
      } else {
        // Compute Shannon entropy of sigmoid-mapped distribution
        const mapped: number[] = tfVals.map((tf) => _fastSigmoid(tf));
        const totalMapped = mapped.reduce((a, b) => a + b, 0);

        if (totalMapped === 0.0) {
          this._termInfo.set(term, idfInfo);
          this._termEntropy.set(term, 1.0 - idfInfo);
          continue;
        }

        let entropy = 0.0;
        const invTotal = 1.0 / totalMapped;
        for (const mVal of mapped) {
          const p = mVal * invTotal;
          if (p > 0.0) {
            entropy -= p * Math.log(p);
          }
        }

        const maxEnt = Math.log(df);
        const normEnt = maxEnt > 0.0 ? Math.min(entropy / maxEnt, 1.0) : 0.0;
        const shannonInfo = Math.max(1.0 - normEnt, 0.0);

        // Blend: Shannon when TFs vary, IDF-derived when uniform
        const blended = blendAlpha * shannonInfo + (1.0 - blendAlpha) * idfInfo;
        this._termInfo.set(term, blended);
        this._termEntropy.set(term, 1.0 - blended);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Build Index
  // ════════════════════════════════════════════════════════════════════

  /** Clear all index state. */
  _reset(): void {
    this._documents.clear();
    this._docLengths.clear();
    this._postingLists.clear();
    this._docFreqs.clear();
    this._idfCache.clear();
    this._termTotalFreqs.clear();
    this._termEntropy.clear();
    this._termInfo.clear();
    this._avgDocLength = 0.0;
    this._totalDocs = 0;
    this._isBuilt = false;
  }

  /** Build from [{chunk_id: string, text: string}, ...]. */
  buildIndex(chunks?: Chunk[]): void {
    if (chunks && chunks.length > 0) {
      this._reset();
      for (const chunk of chunks) {
        const tokens = BMXPlusIndex._tokenize(chunk.text);
        const cid = chunk.chunk_id;
        this._documents.set(cid, tokens);
        this._docLengths.set(cid, tokens.length);
      }
    }

    const N = this._documents.size;
    if (N === 0) {
      this._isBuilt = true;
      return;
    }

    this._totalDocs = N;
    let totalLen = 0;
    for (const l of this._docLengths.values()) totalLen += l;
    this._avgDocLength = totalLen / N;

    // Build posting lists, document frequencies, total term frequencies
    for (const [cid, tokens] of this._documents.entries()) {
      // Counter equivalent
      const termCounts = new Map<string, number>();
      for (const token of tokens) {
        termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
      }

      for (const [term, count] of termCounts.entries()) {
        if (!this._postingLists.has(term)) {
          this._postingLists.set(term, new Map());
        }
        this._postingLists.get(term)!.set(cid, count);

        this._docFreqs.set(term, (this._docFreqs.get(term) ?? 0) + 1);
        this._termTotalFreqs.set(
          term,
          (this._termTotalFreqs.get(term) ?? 0) + count
        );
      }
    }

    this._computeTermEntropies(); // also populates _idfCache
    this._computeIdfMax();        // uses _idfCache for _idfMax
    this._isBuilt = true;
  }

  // ════════════════════════════════════════════════════════════════════
  //  TAAT Search
  // ════════════════════════════════════════════════════════════════════

  /**
   * Search via Term-At-A-Time posting list traversal.
   *
   * Uses BM25's proven TF saturation curve inside the TAAT architecture,
   * with term-adaptive entropy-aware IDF and tanh Soft-AND coverage bonus.
   */
  search(query: string, topK: number = 10): Array<[string, number]> {
    if (!this._isBuilt || this._documents.size === 0) return [];

    const queryTokens = BMXPlusIndex._tokenize(query);
    if (queryTokens.length === 0) return [];

    // Counter equivalent for query tokens
    const queryTf = new Map<string, number>();
    for (const token of queryTokens) {
      queryTf.set(token, (queryTf.get(token) ?? 0) + 1);
    }
    const uniqueQuery = new Set(queryTokens);
    const m = uniqueQuery.size;

    // Cache locals for the hot loop
    const k1 = 1.5;
    const b = 0.75;
    const idfMax = this._idfMax;
    const avgdl = this._avgDocLength;
    const invIdfMax = idfMax > 0.0 ? 1.0 / idfMax : 1.0;
    const docLengths = this._docLengths;
    const postingLists = this._postingLists;
    const idfCache = this._idfCache;
    const termInfo = this._termInfo;
    const invM = 1.0 / m;

    // Per-query informativeness weights
    const infoWeights = new Map<string, number>();
    let infoTotal = 0.0;
    for (const t of uniqueQuery) {
      const v = termInfo.get(t) ?? 0.0;
      infoWeights.set(t, v);
      infoTotal += v;
    }
    const scores = new Map<string, number>();
    const infoAccum = new Map<string, number>();
    const tanhCoverage = new Map<string, number>();

    for (const [term, qTf] of queryTf.entries()) {
      const posting = postingLists.get(term);
      if (!posting || posting.size === 0) continue;

      const idf = idfCache.get(term) ?? 0.0;
      const infoQi = infoWeights.get(term) ?? 0.0;

      // Term-adaptive γt: rare terms get full entropy weight,
      // common terms get none — corpus-size independent
      const gammaT = idf * invIdfMax;
      const infoXQ = gammaT * infoQi * qTf;

      if (idf <= 0.0) {
        for (const cid of posting.keys()) {
          tanhCoverage.set(cid, (tanhCoverage.get(cid) ?? 0.0) + 1.0);
          infoAccum.set(cid, (infoAccum.get(cid) ?? 0.0) + infoXQ);
        }
        continue;
      }

      // Entropy-aware IDF with term-adaptive scaling
      const eidf = idf * (1.0 + gammaT * infoQi);

      for (const [cid, tf] of posting.entries()) {
        // BM25 TF saturation — proven, well-calibrated
        const dl = docLengths.get(cid)!;
        const tfSat = (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * dl / avgdl));

        const termScore = eidf * tfSat * qTf;
        scores.set(cid, (scores.get(cid) ?? 0.0) + termScore);
        infoAccum.set(cid, (infoAccum.get(cid) ?? 0.0) + infoXQ);
        tanhCoverage.set(cid, (tanhCoverage.get(cid) ?? 0.0) + Math.tanh(termScore));
      }
    }

    if (scores.size === 0) return [];

    // Final: Soft-AND coverage bonus
    const finalScores: Array<[string, number]> = [];
    for (const [cid, base] of scores.entries()) {
      const softAnd = (tanhCoverage.get(cid) ?? 0.0) * invM;
      finalScores.push([cid, base + softAnd * (infoAccum.get(cid) ?? 0.0)]);
    }

    // Sort descending by score
    finalScores.sort((a, b_) => b_[1] - a[1]);

    if (this.normalizeScores && finalScores.length > 0) {
      const maxScore = finalScores[0]![1];
      if (maxScore > 0.0) {
        for (let i = 0; i < finalScores.length; i++) {
          finalScores[i] = [finalScores[i]![0], finalScores[i]![1] / maxScore];
        }
      }
    }

    return finalScores.slice(0, topK);
  }
}

// ════════════════════════════════════════════════════════════════════════
//  Line-level relevance — BMX+'s lane in the source route.
//
//  SageRank values a BLOCK / line-range; BMX+ values an individual LINE. This
//  is BMX+'s OWN logic, kept inside the engine: BMX+ builds its query from the
//  structural facts it is handed and scores every line with the SAME TAAT
//  algorithm above (untouched — these are additive entry points, not edits to
//  buildIndex/search). Nothing outside BMX+ constructs its query or shapes its
//  scores. Lane-pure: the query is derived from structural FACTS, never from
//  another engine's output. It SCORES lines; it never drops them.
// ════════════════════════════════════════════════════════════════════════

/** A single source line to score, carrying its stable absolute line number. */
export interface LineUnit {
  readonly line: number; // 1-based absolute line number — identity, never recomputed
  readonly text: string; // line content (no line-number prefix)
}

/**
 * The structural facts BMX+ builds its query from. The route's `SourceFacts`
 * satisfies this structurally, so facts pipe straight in untransformed.
 */
export interface BmxScoringFacts {
  readonly defs: ReadonlyArray<{ readonly name: string; readonly startLine: number }>;
  readonly edges: ReadonlyArray<{ readonly calleeLine: number; readonly callCount: number }>;
}

/** Split an identifier into lowercase word tokens (camelCase / snake / kebab). */
function _splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-.]/g, " ")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Build BMX+'s line-scoring query from structural facts (+ optional scan focus).
 * Symbol names dominate; a name's weight grows with how often it is CALLED
 * (log2 of inbound call-degree, keyed by the callee's stable start line) so
 * heavily-used symbols pull harder. Repetition is the only "weighting" — it
 * rides BMX+'s own query-term-frequency, no external scoring.
 */
function _buildLineQuery(
  facts?: BmxScoringFacts,
  scanQuery?: string | null,
): string {
  const parts: string[] = [];

  if (scanQuery && scanQuery.trim().length > 0) {
    // Caller intent leads — repeated for qtf emphasis.
    parts.push(scanQuery, scanQuery, scanQuery);
  }

  if (facts && facts.defs.length > 0) {
    const inboundDegree = new Map<number, number>();
    for (const e of facts.edges) {
      if (!Number.isFinite(e.callCount) || e.callCount <= 0) continue;
      inboundDegree.set(
        e.calleeLine,
        (inboundDegree.get(e.calleeLine) ?? 0) + e.callCount,
      );
    }
    for (const d of facts.defs) {
      // Emit BOTH the whole identifier (as BMX+'s tokeniser sees it on the code
      // line, e.g. `computeBudget` -> `computebudget`) AND its split word tokens
      // (`compute budget`, to match prose / separate uses). Weighted by inbound
      // call-degree via repetition (rides BMX+'s own qtf — no external scoring).
      const whole = d.name.toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.join(" ") ?? "";
      const split = _splitIdentifier(d.name).join(" ");
      if (whole.length === 0 && split.length === 0) continue;
      const deg = inboundDegree.get(d.startLine) ?? 0;
      const weight = 1 + Math.floor(Math.log2(1 + deg));
      for (let r = 0; r < weight; r++) {
        if (whole.length > 0) parts.push(whole);
        if (split.length > 0 && split !== whole) parts.push(split);
      }
    }
  }

  return parts.join(" ").trim();
}

/**
 * Score every line by lexical relevance to the structural query. Indexes ALL
 * lines in ONE BMX+ index (global IDF → scores are comparable across the whole
 * file), searches once, and returns a score per ABSOLUTE line number in [0,1].
 *
 * Blank lines carry no information and score 0. Every other line is valued on
 * ONE blended query: the structural facts (symbol names weighted by call-degree
 * — lines naming important structure score highest) PLUS the corpus's own terms
 * (so each line carries a graduated intrinsic value via BMX+'s entropy-aware IDF,
 * rather than every non-symbol line tying at 0). With no facts/scan focus this
 * reduces to a pure informativeness ranking — a per-line signal is NEVER denied.
 *
 * This SCORES; it does not drop. Removal is the gate's lane.
 */
export function scoreLines(
  lines: ReadonlyArray<LineUnit>,
  facts?: BmxScoringFacts,
  scanQuery?: string | null,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const u of lines) out.set(u.line, 0.0); // every line present; blanks stay 0
  if (lines.length === 0) return out;

  const chunks: Chunk[] = [];
  for (const u of lines) {
    const content = u.text.trim();
    if (content.length > 0) chunks.push({ chunk_id: String(u.line), text: content });
  }
  if (chunks.length === 0) return out;

  // BMX+ values every line on ONE blended query: the structural facts (symbol
  // names, repeated/weighted by call-degree, so lines naming important structure
  // dominate) PLUS the corpus's own terms (so every line carries a graduated
  // intrinsic-informativeness value — rare-token lines outrank boilerplate,
  // instead of every non-symbol line tying at 0). Symbol material leads because
  // it is repeated; corpus terms only break ties below it. Lines with no word
  // tokens (braces, blanks) match nothing and stay 0. When no facts/scan focus
  // exist this naturally reduces to a pure informativeness ranking (never denied).
  const corpusTerms = chunks.map((c) => c.text).join(" ");
  const factsQuery = _buildLineQuery(facts, scanQuery);
  const query = factsQuery.length > 0 ? factsQuery + " " + corpusTerms : corpusTerms;

  const index = new BMXPlusIndex(true); // normalize → globally comparable [0,1]
  index.buildIndex(chunks);
  for (const [cid, score] of index.search(query, chunks.length)) {
    const ln = Number(cid);
    if (Number.isInteger(ln) && out.has(ln)) out.set(ln, score);
  }
  return out;
}

/**
 * BMX+'s determination — the `bmx` metadata key it owns. A relevance value in
 * [0,1] for every ABSOLUTE source line number. Defined and owned HERE; only
 * later engines (removal) consume it.
 */
export type BMXMetadata = ReadonlyMap<number, number>;

/**
 * BMX+'s core process, operating on the payload: flatten the source blocks into
 * their individual lines (line identity comes straight from each block's range
 * — `startLine + offset` — never re-parsed), score every line via `scoreLines`,
 * drop that per-line determination onto the payload's `bmx` key, and hand the
 * payload to the next engine ITSELF. The flattening below is part of BMX+'s own
 * core (the LINE is its unit); nothing outside the engine shapes its input.
 */
export function bmxEngine(payload: Payload): Payload {
  const lines: LineUnit[] = [];
  for (const b of payload.source.blocks) {
    const physical = b.text.split("\n");
    for (let i = 0; i < physical.length; i++) {
      // Strip the visual "N. " prefix from the SCORED text ONLY — line-number
      // digits must never enter BMX+'s tokeniser. The source text and its line
      // numbers themselves are never altered or recomputed.
      const content = (physical[i] ?? "").replace(/^\s*\d+[.:]\s?/, "");
      lines.push({ line: b.startLine + i, text: content });
    }
  }

  // Drop the stone in the backpack: BMX+'s own per-line determination.
  const determination: BMXMetadata = scoreLines(
    lines,
    payload.source.facts,
    payload.source.query,
  );
  payload.metadata.bmx = determination;

  // Hand the payload forward to the removal engine itself. (The removal engine
  // is still being built — this is the live handoff into it. The forward flow
  // ends here for now; the build does not resolve `./removal.js` yet, by design.)
  return removalEngine(payload);
}
