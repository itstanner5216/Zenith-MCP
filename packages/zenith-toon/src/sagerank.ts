import type { Payload, SourceBlock } from './compress-source.js';
import { bmxEngine } from './bmx-plus.js';

// ════════════════════════════════════════════════════════════════════════
//  AST facts — SageRank's structural edge input
// ════════════════════════════════════════════════════════════════════════
//
// The RESOLVED call-graph edges SageRank fuses into its similarity graph. They
// arrive on the payload as `Source.facts.edges`, handed across the seam by the
// consumer (Zenith-MCP) from its symbol DB. Caller and callee are identified by
// their STABLE START LINE (the DB's resolved container_def_id / callee_symbol_id
// -> symbols.line), NEVER by bare name, so duplicate/overloaded symbol names can
// never misroute an edge. SageRank consumes ONLY edges here; defs are BMX+'s input.

interface SourceFactEdge {
  readonly callerLine: number;  // resolved start line of the calling def (stable key)
  readonly calleeLine: number;  // resolved start line of the called def (stable key)
  readonly callCount: number;
}
interface SourceFacts {
  readonly edges: readonly SourceFactEdge[];
}

// ════════════════════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════

function _fastSigmoid(x: number): number {
  // Padé rational approximation to σ(x). |error| < 0.01.
  if (x >= 8.0) return 1.0;
  if (x <= -8.0) return 0.0;
  const x2 = x * x;
  const x3 = x2 * x;
  return (x3 + 6.0 * x + 12.0) / (x3 + 12.0 * x + 48.0);
}

// NOTE: the prose-era text wrappers (_segmentSentences + rank/summarize/
// extractKeywords/rankPassages) were removed. They segmented free prose into
// sentences — log/tool-output heritage that has no meaning for line-numbered
// source. The source route feeds SageRank pre-segmented line-blocks directly
// via rankSentences / rankWithAST; nothing here splits text into "sentences".

// ════════════════════════════════════════════════════════════════════════
//  Result
// ════════════════════════════════════════════════════════════════════════

export interface SageResult {
  readonly sentences: string[];
  /** Per-unit structural importance in [0,1], index-aligned to `sentences`.
   *  Independent of topK, of input position, and of any scan query. */
  readonly scores: number[];
  /** Full importance order over every unit, descending by `scores`. */
  readonly rankedIndices: number[];
  /** Full greedy coverage order over every unit (non-redundant first). The TAIL
   *  is the most marginally-redundant material — the signal the removal gate /
   *  deduplicator uses to drop low-marginal-info ranges (vs `scores`, which is
   *  absolute importance). Length n. */
  readonly coverageOrder: number[];
  /** Bounded representative core: the knee of the score curve, coverage-diverse.
   *  topK is only a CEILING — this is never the whole file. */
  readonly coreIndices: number[];
  /** Bounded representative core. Honest alias of `coreIndices` (legacy name). */
  readonly selectedIndices: number[];
  readonly keywords: [string, number][];
  readonly stats: Record<string, number | boolean | string>;
  readonly summary: string;
  readonly selectedSentences: string[];
  top(k?: number | null): [number, string, number][];
}

function makeSageResult(
  sentences: string[],
  scores: number[],
  selectedIndices: number[],
  keywords: [string, number][],
  stats: Record<string, number | boolean | string>,
  rankedIndices?: number[],
  coreIndices?: number[],
  coverageOrder?: number[],
): SageResult {
  const fullRanking =
    rankedIndices ??
    [...Array(scores.length).keys()].sort((a, b) => scores[b]! - scores[a]!);
  const core = coreIndices ?? selectedIndices;
  const coverage = coverageOrder ?? fullRanking;

  const summary = [...selectedIndices]
    .sort((a, b) => a - b)
    .map((i) => sentences[i]!)
    .join(" ");

  const selectedSentences = [...selectedIndices]
    .sort((a, b) => a - b)
    .map((i) => sentences[i]!);

  function top(k?: number | null): [number, string, number][] {
    const truncated = k != null ? fullRanking.slice(0, k) : fullRanking;
    return truncated.map((i) => [i, sentences[i]!, scores[i]!]);
  }

  return {
    sentences,
    scores,
    rankedIndices: fullRanking,
    coverageOrder: coverage,
    coreIndices: core,
    selectedIndices,
    keywords,
    stats,
    summary,
    selectedSentences,
    top,
  };
}

/**
 * Bounded representative core size from a score-DESCENDING curve. `maxK` is a
 * ceiling only — passing n must NOT turn the "core" into the whole file. Finds
 * the strongest score cliff (relative x absolute gap, normalized by range),
 * skipping the first singleton cliff when it can so one dominant node (a file or
 * class node that towers over the rest) cannot collapse the core to 1. Falls
 * back to a sqrt(n)-sized representative core when there is no clear edge.
 */
function findScoreCoreCount(sortedScores: number[], maxK: number): number {
  const n = sortedScores.length;
  if (n === 0 || maxK <= 0) return 0;
  const limit = Math.max(1, Math.min(maxK, n));
  if (n < 3) return limit;

  let minS = Infinity;
  let maxS = -Infinity;
  for (const s of sortedScores) {
    if (s < minS) minS = s;
    if (s > maxS) maxS = s;
  }
  const range = maxS - minS;
  if (range < 1e-10) {
    return Math.min(limit, Math.max(1, Math.ceil(Math.sqrt(n))));
  }

  let bestCut = 1;
  let bestGap = -Infinity;
  const start = n > 3 ? 1 : 0; // skip the first singleton cliff when we can
  for (let i = start; i < n - 1; i++) {
    const left = sortedScores[i]!;
    const right = sortedScores[i + 1]!;
    const absGap = left - right;
    const relGap = left > 1e-12 ? absGap / left : 0.0;
    const weightedGap = relGap * (absGap / range);
    if (weightedGap > bestGap) {
      bestGap = weightedGap;
      bestCut = i + 1;
    }
  }
  if (bestGap > 0.05) return Math.min(limit, Math.max(1, bestCut));
  return Math.min(limit, Math.max(1, Math.ceil(Math.sqrt(n))));
}

// ════════════════════════════════════════════════════════════════════════
//  SageRank
// ════════════════════════════════════════════════════════════════════════

/**
 * SageRank's determination — the `sagerank` metadata key it owns. Per-block
 * structural importance (`scores`, index-aligned to `source.blocks`), the full
 * descending order, the greedy coverage order (whose tail is the most
 * marginally-redundant material), and the bounded representative core. Defined
 * and owned HERE; only later engines consume it.
 */
export interface SageRankMetadata {
  readonly scores: readonly number[];
  readonly rankedIndices: readonly number[];
  readonly coverageOrder: readonly number[];
  readonly coreIndices: readonly number[];
}

export class SageRank {
  private readonly _k1: number;
  private readonly _b: number;
  private readonly _damping: number;
  private readonly _maxIter: number;
  private readonly _epsilon: number;
  private readonly _coverageWeight: number;
  private readonly _normalize: boolean;
  private readonly _usePositionPrior: boolean;
  private readonly _useQueryBias: boolean;

  constructor(
    k1: number = 1.5,
    b: number = 0.75,
    damping: number = 0.85,
    maxIter: number = 50,
    epsilon: number = 1e-6,
    coverageWeight: number = 0.5,
    normalize: boolean = true,
    // Source defaults: NO prose lead/trail position bias and NO query bias, so
    // `scores` are a pure function of content + graph structure (position- and
    // query-invariant per-range importance). Prose callers can opt back in.
    usePositionPrior: boolean = false,
    useQueryBias: boolean = false,
  ) {
    this._k1 = k1;
    this._b = b;
    this._damping = damping;
    this._maxIter = maxIter;
    this._epsilon = epsilon;
    this._coverageWeight = coverageWeight;
    this._normalize = normalize;
    this._usePositionPrior = usePositionPrior;
    this._useQueryBias = useQueryBias;
  }

  // ────────────────────────────────────────────────────────────────
  //  Engine entry — SageRank's core process on the payload
  // ────────────────────────────────────────────────────────────────

  /**
   * SageRank's core process, operating on the payload: read the source blocks
   * (+ resolved AST facts), score every block by PageRank centrality over its
   * text-similarity graph fused with the call graph, drop that per-range
   * determination onto the payload's `sagerank` key, and hand the payload to
   * the next engine ITSELF. No outside actor shapes the input or carries the
   * result — the projection of facts->edges below is part of this engine's own
   * core, not a route helper.
   */
  run(payload: Payload): Payload {
    const blocks = payload.source.blocks;
    const texts = blocks.map((b) => b.text);
    const n = texts.length;

    // RESOLVED call-graph edges, handed in on the payload as Source.facts.edges
    // (the DB's id/line-keyed container_def_id -> callee_symbol_id, projected to
    // each def's stable start line; never name-keyed). Absent facts -> no edges ->
    // pure text-similarity ranking (rankSentences); the call-graph fusion is
    // opt-in on the presence of data, never fabricated.
    const astEdges = this._factsToASTEdges(payload.source.facts, blocks);
    const result = astEdges.length > 0
      ? this.rankWithAST(texts, n, astEdges, payload.source.query)
      : this.rankSentences(texts, n, payload.source.query);

    // Drop the stone in the backpack: SageRank's own per-range determination.
    const determination: SageRankMetadata = {
      scores: result.scores,
      rankedIndices: result.rankedIndices,
      coverageOrder: result.coverageOrder,
      coreIndices: result.coreIndices,
    };
    payload.metadata.sagerank = determination;

    // Hand the payload forward to the next engine itself.
    return bmxEngine(payload);
  }

  /**
   * Project RESOLVED AST facts into SageRank's index-based edge format. Caller
   * and callee resolve to a block by STABLE START LINE (exact match first, else
   * the smallest enclosing span), so duplicate/overloaded symbol names can never
   * misroute an edge. weight = sqrt(callCount): SageRank's edge tuning lives
   * HERE, inside the engine — not in the DB and not in a route.
   */
  private _factsToASTEdges(
    facts: SourceFacts | undefined,
    blocks: readonly SourceBlock[],
  ): Array<{ from: number; to: number; weight: number }> {
    if (facts === undefined || facts.edges.length === 0) return [];

    const startLineToIndex = new Map<number, number>();
    for (let i = 0; i < blocks.length; i++) {
      startLineToIndex.set(blocks[i]!.startLine, i);
    }
    const resolve = (line: number): number | undefined => {
      const exact = startLineToIndex.get(line);
      if (exact !== undefined) return exact;
      let best: { index: number; span: number } | undefined;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]!;
        if (line >= b.startLine && line <= b.endLine) {
          const span = b.endLine - b.startLine;
          if (best === undefined || span < best.span) best = { index: i, span };
        }
      }
      return best?.index;
    };

    const edges: Array<{ from: number; to: number; weight: number }> = [];
    for (const e of facts.edges) {
      if (!Number.isFinite(e.callCount) || e.callCount <= 0) continue;
      const from = resolve(e.callerLine);
      const to = resolve(e.calleeLine);
      if (from === undefined || to === undefined || from === to) continue;
      edges.push({ from, to, weight: Math.sqrt(e.callCount) });
    }
    return edges;
  }

  // ────────────────────────────────────────────────────────────────
  //  Tokenisation
  // ────────────────────────────────────────────────────────────────

  static _tokenize(text: string): string[] {
    const lower = text.toLowerCase();
    // JS \w is not unicode-aware — use \p{L} and \p{N} for equivalent behavior
    const matches = lower.match(/[\p{L}\p{N}_]+/gu);
    return matches !== null ? matches : [];
  }

  // ────────────────────────────────────────────────────────────────
  //  Index Construction
  // ────────────────────────────────────────────────────────────────

  static _buildPostingLists(
    sentTokens: string[][],
  ): [Map<string, Map<number, number>>, Map<string, number>, Map<number, number>, number] {
    // Returns [postingLists, docFreqs, docLengths, avgDl]
    const postingLists = new Map<string, Map<number, number>>();
    const docFreqs = new Map<string, number>();
    const docLengths = new Map<number, number>();
    let totalLength = 0;

    for (let idx = 0; idx < sentTokens.length; idx++) {
      const tokens = sentTokens[idx]!;
      const dl = tokens.length;
      docLengths.set(idx, dl);
      totalLength += dl;

      // Counter equivalent
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }

      for (const [term, count] of tf.entries()) {
        if (!postingLists.has(term)) postingLists.set(term, new Map<number, number>());
        postingLists.get(term)!.set(idx, count);
        docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
      }
    }

    const n = sentTokens.length;
    const avgDl = n > 0 ? totalLength / n : 0.0;
    return [postingLists, docFreqs, docLengths, avgDl];
  }

  // ────────────────────────────────────────────────────────────────
  //  Entropy-Weighted IDF
  // ────────────────────────────────────────────────────────────────

  static _computeEidf(
    postingLists: Map<string, Map<number, number>>,
    docFreqs: Map<string, number>,
    n: number,
  ): [Map<string, number>, Map<string, number>, Map<string, number>, number] {
    // Returns [idf, eidf, info, idfMax]
    const idf = new Map<string, number>();
    const info = new Map<string, number>();

    // Phase 1: IDF
    for (const [term, df] of docFreqs.entries()) {
      if (df > 0 && n > 0) {
        idf.set(term, Math.log((n - df + 0.5) / (df + 0.5) + 1.0));
      } else {
        idf.set(term, 0.0);
      }
    }

    const idfValues = [...idf.values()];
    const idfMax = idfValues.length > 0 ? Math.max(...idfValues) : 1.0;

    // Phase 2: Term informativeness (entropy-blended)
    for (const [term, df] of docFreqs.entries()) {
      if (df < 2) {
        info.set(term, 1.0); // rare → maximally informative
        continue;
      }

      const posting = postingLists.get(term);
      if (!posting || posting.size === 0) {
        info.set(term, 0.0);
        continue;
      }

      const idfInfo = n > 0 ? 1.0 - df / n : 0.0;

      // TF variance → blend weight
      const tfVals = [...posting.values()];
      const nPost = tfVals.length;
      const meanTf = tfVals.reduce((a, b) => a + b, 0) / nPost;
      const variance = tfVals.reduce((acc, v) => acc + (v - meanTf) ** 2, 0) / nPost;
      const blendAlpha = variance / (variance + 1.0);

      if (blendAlpha < 0.001) {
        info.set(term, idfInfo);
      } else {
        const mapped = tfVals.map((tf) => _fastSigmoid(tf));
        const totalMapped = mapped.reduce((a, b) => a + b, 0);
        if (totalMapped === 0.0) {
          info.set(term, idfInfo);
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
        const normEnt =
          maxEnt > 0.0 ? Math.min(entropy / maxEnt, 1.0) : 0.0;
        const shannonInfo = Math.max(1.0 - normEnt, 0.0);
        info.set(
          term,
          blendAlpha * shannonInfo + (1.0 - blendAlpha) * idfInfo,
        );
      }
    }

    // Phase 3: eIDF = IDF · (1 + γₜ · info)
    const eidf = new Map<string, number>();
    const invIdfMax = idfMax > 0.0 ? 1.0 / idfMax : 1.0;
    for (const term of docFreqs.keys()) {
      const termIdf = idf.get(term) ?? 0.0;
      const gammaT = termIdf * invIdfMax;
      eidf.set(term, termIdf * (1.0 + gammaT * (info.get(term) ?? 0.0)));
    }

    return [idf, eidf, info, idfMax];
  }

  // ────────────────────────────────────────────────────────────────
  //  Similarity Graph (posting-list intersection)
  // ────────────────────────────────────────────────────────────────

  _buildGraph(
    postingLists: Map<string, Map<number, number>>,
    eidf: Map<string, number>,
    docLengths: Map<number, number>,
    avgDl: number,
    n: number,
  ): [Map<number, Map<number, number>>, number] {
    // Returns [adjacency, edgeCount]
    const k1 = this._k1;
    const b = this._b;

    // Adaptive scaling limits for large corpora
    const eidfValues = [...eidf.values()];
    const maxEidf = eidfValues.length > 0 ? Math.max(...eidfValues) : 0.0;
    let minEidf: number;
    let maxPosting: number;
    if (n > 5000) {
      minEidf = maxEidf * 0.05;
      maxPosting = Math.floor(n / 10);
    } else if (n > 1000) {
      minEidf = maxEidf * 0.02;
      maxPosting = Math.floor(n / 5);
    } else {
      minEidf = maxEidf * 0.005;
      maxPosting = Math.max(Math.floor(n / 2), 10);
    }

    const tfSat = (tf: number, dl: number): number => {
      if (avgDl <= 0) return tf;
      return (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * dl / avgDl));
    };

    // Phase 1: Norms for cosine normalisation
    const normSq = new Map<number, number>();
    for (const [term, posting] of postingLists.entries()) {
      const e = eidf.get(term) ?? 0.0;
      if (e <= 0.0) continue;
      for (const [idx, tf] of posting.entries()) {
        const dl = docLengths.get(idx) ?? 0;
        const val = e * tfSat(tf, dl);
        normSq.set(idx, (normSq.get(idx) ?? 0.0) + val * val);
      }
    }

    const norms = new Map<number, number>();
    for (const [i, v] of normSq.entries()) {
      norms.set(i, v > 0.0 ? Math.sqrt(v) : 1.0);
    }

    // Phase 2: Edge weights via posting-list intersection
    // Key encoding: i < j always, encode as i * (n+1) + j for a unique number key
    // Using string key "i,j" is safe and unambiguous
    const raw = new Map<string, number>();

    for (const [term, posting] of postingLists.entries()) {
      const e = eidf.get(term) ?? 0.0;
      if (e < minEidf) continue;
      const items = [...posting.entries()];
      if (items.length < 2 || items.length > maxPosting) continue;

      // Precompute weighted TF for this term
      const weighted: [number, number][] = items.map(([idx, tf]) => {
        const dl = docLengths.get(idx) ?? 0;
        return [idx, e * tfSat(tf, dl)];
      });

      const nItems = weighted.length;
      for (let aPos = 0; aPos < nItems; aPos++) {
        const [idxA, wA] = weighted[aPos]!;
        for (let bPos = aPos + 1; bPos < nItems; bPos++) {
          const [idxB, wB] = weighted[bPos]!;
          // Canonical key ordering so (i,j) and (j,i) merge
          const key = idxA < idxB ? `${idxA},${idxB}` : `${idxB},${idxA}`;
          raw.set(key, (raw.get(key) ?? 0.0) + wA * wB);
        }
      }
    }

    // Phase 3: Normalise + threshold → adjacency
    const adjacency = new Map<number, Map<number, number>>();
    let edgeCount = 0;

    if (raw.size > 0) {
      const normalised = new Map<string, number>();
      for (const [key, w] of raw.entries()) {
        const comma = key.indexOf(",");
        const i = parseInt(key.slice(0, comma), 10);
        const j = parseInt(key.slice(comma + 1), 10);
        const ni = norms.get(i) ?? 1.0;
        const nj = norms.get(j) ?? 1.0;
        const sim = w / (ni * nj);
        if (sim > 0.0) {
          normalised.set(key, sim);
        }
      }

      if (normalised.size > 0) {
        const normValues = [...normalised.values()];
        const maxSim = Math.max(...normValues);
        const threshold = maxSim * 0.01; // self-tuning: 1% of max

        for (const [key, sim] of normalised.entries()) {
          if (sim >= threshold) {
            const comma = key.indexOf(",");
            const i = parseInt(key.slice(0, comma), 10);
            const j = parseInt(key.slice(comma + 1), 10);

            if (!adjacency.has(i)) adjacency.set(i, new Map<number, number>());
            if (!adjacency.has(j)) adjacency.set(j, new Map<number, number>());
            adjacency.get(i)!.set(j, sim);
            adjacency.get(j)!.set(i, sim);
            edgeCount++;
          }
        }
      }
    }

    return [adjacency, edgeCount];
  }

  // ────────────────────────────────────────────────────────────────
  //  Adaptive Position Prior
  // ────────────────────────────────────────────────────────────────

  static _positionPrior(centrality: number[], n: number): number[] {
    // Self-tuning position weights from centrality distribution.
    if (n <= 1) return Array(n).fill(1.0);

    const avgC = n > 0 ? centrality.reduce((a, b) => a + b, 0) / n : 0.0;

    // Lead bias detection
    const leadK = Math.max(3, Math.floor(n / 10));
    const leadC =
      leadK > 0
        ? centrality.slice(0, leadK).reduce((a, b) => a + b, 0) / leadK
        : 0.0;

    let leadStrength: number;
    if (avgC > 0) {
      const leadRatio = leadC / avgC;
      // Linear ramp: 0 at ratio=1.0, 1.0 at ratio=1.4+
      leadStrength = Math.max(0.0, Math.min(1.0, (leadRatio - 1.0) * 2.5));
    } else {
      leadStrength = 0.0;
    }

    const trailStrength = 0.3; // fixed, mild

    const invLeadScale = 1.0 / Math.max(n * 0.1, 1.0);
    const invTrailScale = 1.0 / Math.max(n * 0.05, 1.0);

    const weights: number[] = [];
    for (let i = 0; i < n; i++) {
      const lead = Math.exp(-i * invLeadScale);
      const trail = Math.exp(-(n - 1 - i) * invTrailScale);
      weights.push(1.0 + leadStrength * lead + trailStrength * trail);
    }
    return weights;
  }

  // ────────────────────────────────────────────────────────────────
  //  Query Scoring (optional BMX+ TAAT)
  // ────────────────────────────────────────────────────────────────

  _scoreQuery(
    queryTokens: string[],
    postingLists: Map<string, Map<number, number>>,
    eidf: Map<string, number>,
    docLengths: Map<number, number>,
    avgDl: number,
  ): Map<number, number> {
    // Score all sentences against a query using BMX+ TAAT.
    const k1 = this._k1;
    const b = this._b;

    // Counter equivalent for query tokens
    const queryTf = new Map<string, number>();
    for (const token of queryTokens) {
      queryTf.set(token, (queryTf.get(token) ?? 0) + 1);
    }

    const scores = new Map<number, number>();

    for (const [term, qtf] of queryTf.entries()) {
      const posting = postingLists.get(term);
      if (!posting || posting.size === 0) continue;
      const e = eidf.get(term) ?? 0.0;
      if (e <= 0.0) continue;

      for (const [idx, tf] of posting.entries()) {
        const dl = docLengths.get(idx) ?? 0;
        let tfSat: number;
        if (avgDl > 0) {
          tfSat = (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * dl / avgDl));
        } else {
          tfSat = tf;
        }
        scores.set(idx, (scores.get(idx) ?? 0.0) + e * tfSat * qtf);
      }
    }

    return scores;
  }

  // ────────────────────────────────────────────────────────────────
  //  PageRank
  // ────────────────────────────────────────────────────────────────

  _pagerank(
    adjacency: Map<number, Map<number, number>>,
    personalization: Map<number, number>,
    n: number,
  ): [Map<number, number>, number] {
    // Sparse PageRank with topic-sensitive personalization.
    // Returns [scoresDict, iterations].
    const d = this._damping;

    // Normalise personalization → probability distribution
    let p: number[] = [];
    for (let i = 0; i < n; i++) {
      p.push(personalization.get(i) ?? 1e-10);
    }
    const pSum = p.reduce((a, b) => a + b, 0);
    if (pSum > 0) {
      p = p.map((v) => v / pSum);
    } else {
      p = Array(n).fill(1.0 / n);
    }

    // Precompute outgoing edges (normalised weights)
    const outTotal: number[] = Array(n).fill(0.0);
    const outEdges: [number, number][][] = [];
    for (let i = 0; i < n; i++) {
      outEdges.push([]);
    }

    for (let i = 0; i < n; i++) {
      const neighbours = adjacency.get(i);
      if (!neighbours || neighbours.size === 0) {
        outTotal[i] = 0.0;
        continue;
      }
      let total = 0.0;
      for (const w of neighbours.values()) {
        total += w;
      }
      outTotal[i] = total;
      if (total > 0) {
        for (const [j, w] of neighbours.entries()) {
          outEdges[i]!.push([j, w / total]);
        }
      }
    }

    // Power iteration
    let pr = [...p];
    let iterations = 0;

    for (let it = 0; it < this._maxIter; it++) {
      iterations = it + 1;
      const prNew: number[] = Array(n).fill(0.0);

      // Dangling mass → personalization distribution
      let dangling = 0.0;
      for (let i = 0; i < n; i++) {
        if (outTotal[i] === 0) {
          dangling += pr[i]!;
        }
      }

      for (let i = 0; i < n; i++) {
        prNew[i] = (1.0 - d) * p[i]! + d * dangling * p[i]!;
      }

      // Edge transitions
      for (let i = 0; i < n; i++) {
        if (outEdges[i]!.length > 0) {
          const mass = d * pr[i]!;
          for (const [j, wNorm] of outEdges[i]!) {
            prNew[j] = prNew[j]! + mass * wNorm;
          }
        }
      }

      // Convergence (L1)
      let diff = 0.0;
      for (let i = 0; i < n; i++) {
        diff += Math.abs(prNew[i]! - pr[i]!);
      }
      pr = prNew;
      if (diff < this._epsilon) {
        break;
      }
    }

    const result = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      result.set(i, pr[i]!);
    }
    return [result, iterations];
  }

  // ────────────────────────────────────────────────────────────────
  //  Coverage-Aware Extraction
  // ────────────────────────────────────────────────────────────────

  _extractWithCoverage(
    prScores: Map<number, number>,
    sentTokens: string[][],
    eidf: Map<string, number>,
    topK: number,
    n: number,
  ): number[] {
    // Greedy extraction maximising centrality × information coverage.
    const cw = this._coverageWeight;

    // Precompute per-sentence term weights
    const sentWeights: Map<string, number>[] = [];
    const sentTotals: number[] = [];

    for (let idx = 0; idx < n; idx++) {
      const weights = new Map<string, number>();
      const uniqueTerms = new Set(sentTokens[idx]);
      for (const t of uniqueTerms) {
        const w = eidf.get(t) ?? 0.0;
        if (w > 0.0) {
          weights.set(t, w);
        }
      }
      sentWeights.push(weights);
      let total = 0.0;
      for (const w of weights.values()) total += w;
      sentTotals.push(total);
    }

    const covered = new Set<string>();
    const selected: number[] = [];
    const remaining = new Set<number>();
    for (let i = 0; i < n; i++) remaining.add(i);

    while (selected.length < topK && remaining.size > 0) {
      let bestIdx = -1;
      let bestScore = -1.0;

      for (const idx of remaining) {
        const pr = prScores.get(idx) ?? 0.0;
        const totalW = sentTotals[idx]!;

        let coverage: number;
        if (totalW > 0.0) {
          let novelW = 0.0;
          for (const [t, w] of sentWeights[idx]!.entries()) {
            if (!covered.has(t)) {
              novelW += w;
            }
          }
          coverage = novelW / totalW;
        } else {
          coverage = 0.0;
        }

        const score = pr * (cw + (1.0 - cw) * coverage);

        if (score > bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      }

      if (bestIdx < 0) break;

      selected.push(bestIdx);
      remaining.delete(bestIdx);
      for (const t of sentWeights[bestIdx]!.keys()) {
        covered.add(t);
      }
    }

    return selected;
  }

  // ────────────────────────────────────────────────────────────────
  //  Bounded Core Selection (knee on the score curve)
  // ────────────────────────────────────────────────────────────────

  /**
   * Split per-unit importance into a full descending ranking plus a small,
   * coverage-diverse representative core. The core is sized by the internal
   * knee detector (topK is only a ceiling) and filled from the coverage order
   * so it favors NON-redundant high-importance units; any shortfall is topped
   * up by pure score order. Returns [coreIndices, rankedIndices].
   */
  private _selectCore(
    scores: number[],
    coverageOrder: number[],
    maxK: number,
  ): [number[], number[]] {
    const rankedIndices = [...scores.keys()].sort(
      (a, b) => (scores[b] ?? 0) - (scores[a] ?? 0),
    );
    if (rankedIndices.length === 0) return [[], []];
    const coreSize = findScoreCoreCount(
      rankedIndices.map((i) => scores[i] ?? 0),
      maxK,
    );
    const highImportance = new Set(rankedIndices.slice(0, coreSize));
    const inCore = new Set<number>();
    const core: number[] = [];
    for (const idx of coverageOrder) {
      if (core.length >= coreSize) break;
      if (highImportance.has(idx) && !inCore.has(idx)) {
        core.push(idx);
        inCore.add(idx);
      }
    }
    for (const idx of rankedIndices) {
      if (core.length >= coreSize) break;
      if (!inCore.has(idx)) {
        core.push(idx);
        inCore.add(idx);
      }
    }
    return [core, rankedIndices];
  }

  // ────────────────────────────────────────────────────────────────
  //  Keyword Extraction
  // ────────────────────────────────────────────────────────────────

  static _getKeywords(
    eidf: Map<string, number>,
    docFreqs: Map<string, number>,
    topK: number = 10,
  ): [string, number][] {
    // Top keywords by eIDF · sqrt(df) (informative AND representative).
    const scored: [string, number][] = [];
    for (const term of eidf.keys()) {
      const termEidf = eidf.get(term) ?? 0.0;
      if (termEidf > 0) {
        const df = docFreqs.get(term) ?? 1;
        scored.push([term, termEidf * Math.sqrt(df)]);
      }
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, topK);
  }

  // ════════════════════════════════════════════════════════════════
  //  Public API
  // ════════════════════════════════════════════════════════════════

  // Rank pre-segmented units (for the source route: line-blocks, each carrying
  // its own line range). The caller supplies the units already split; SageRank
  // never re-segments. Returns per-unit centrality scores + a selected core.
  rankSentences(
    sentences: string[],
    topK: number = 5,
    query: string | null = null,
  ): SageResult {
    const n = sentences.length;
    if (n === 0) {
      return makeSageResult([], [], [], [], {});
    }
    if (n === 1) {
      return makeSageResult(sentences, [1.0], [0], [], { sentences: 1 });
    }
    const effectiveTopK = Math.min(topK, n);

    // 1. Tokenise
    const sentTokens = sentences.map((s) => SageRank._tokenize(s));

    // 2. Build inverted index
    const [postingLists, docFreqs, docLengths, avgDl] =
      SageRank._buildPostingLists(sentTokens);

    // 3. Entropy-weighted IDF
    // idf is the first return value; not used directly in rankSentences (idfMax is returned separately)
    const [, eidf, , idfMax] = SageRank._computeEidf(
      postingLists,
      docFreqs,
      n,
    );

    // 4. Similarity graph
    const [adjacency, edgeCount] = this._buildGraph(
      postingLists,
      eidf,
      docLengths,
      avgDl,
      n,
    );

    // 5. Degree centrality (from graph)
    const centrality: number[] = [];
    for (let i = 0; i < n; i++) {
      const nbrs = adjacency.get(i);
      let sum = 0.0;
      if (nbrs) {
        for (const w of nbrs.values()) sum += w;
      }
      centrality.push(sum);
    }

    // 6. Position prior. For SOURCE the prose-era lead/trail bias is OFF by
    //    default (usePositionPrior=false) so a range's score is a pure function
    //    of its content + graph structure — i.e. position-invariant. Prose
    //    callers can opt back in.
    const position = this._usePositionPrior
      ? SageRank._positionPrior(centrality, n)
      : new Array<number>(n).fill(1.0);

    // 7. Optional query scoring. OFF by default (useQueryBias=false): structural
    //    importance must not be silently re-weighted by a scan query — relevance
    //    is BMX+'s engine. Opt-in only; the query param is kept for back-compat.
    let queryScores: Map<number, number> | null = null;
    if (this._useQueryBias && query !== null && query.length > 0) {
      const qt = SageRank._tokenize(query);
      if (qt.length > 0) {
        queryScores = this._scoreQuery(qt, postingLists, eidf, docLengths, avgDl);
      }
    }

    // 8. Personalization vector
    const personalization = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      let pVal = position[i]!;
      if (queryScores !== null && queryScores.size > 0) {
        pVal *= (queryScores.get(i) ?? 0.0) + 0.01;
      }
      personalization.set(i, pVal);
    }

    // 9. PageRank — the full per-unit structural importance curve.
    const [prScores, prIters] = this._pagerank(adjacency, personalization, n);

    // 10. Normalise scores to [0, 1]. THIS is the per-range importance signal.
    let scores: number[] = [];
    for (let i = 0; i < n; i++) {
      scores.push(prScores.get(i) ?? 0.0);
    }
    if (this._normalize && scores.length > 0) {
      const maxS = Math.max(...scores);
      if (maxS > 0) {
        scores = scores.map((s) => s / maxS);
      }
    }

    // 11. De-overload. Full greedy coverage order over ALL n (non-redundant),
    //     then a knee-bounded, coverage-diverse representative core. topK is a
    //     ceiling only — passing n yields all scores without inflating the core.
    const coverageOrder = this._extractWithCoverage(
      prScores,
      sentTokens,
      eidf,
      n,
      n,
    );
    const [coreIndices, rankedIndices] = this._selectCore(
      scores,
      coverageOrder,
      effectiveTopK,
    );

    // 12. Keywords
    const keywords = SageRank._getKeywords(eidf, docFreqs, 10);

    const leadBias =
      this._usePositionPrior && n > 0 ? position[0]! - 1.0 : 0.0;

    const stats: Record<string, number | boolean | string> = {
      sentences: n,
      vocabulary: postingLists.size,
      edges: edgeCount,
      pagerank_iters: prIters,
      idf_max: Math.round(idfMax * 10000) / 10000,
      lead_bias: Math.round(leadBias * 10000) / 10000,
      position_prior: this._usePositionPrior,
      query_biased: this._useQueryBias && query !== null,
      core_size: coreIndices.length,
      selection_mode: "bounded_core",
    };

    return makeSageResult(
      sentences,
      scores,
      coreIndices,
      keywords,
      stats,
      rankedIndices,
      coreIndices,
      coverageOrder,
    );
  }

  // ════════════════════════════════════════════════════════════════
  //  AST-Aware Ranking (Call Graph Integration)
  // ════════════════════════════════════════════════════════════════

  /**
   * Merge AST edges into text-similarity adjacency graph.
   * AST edges represent call/reference relationships from the symbol index.
   *
   * @param textAdjacency - Adjacency from text similarity
   * @param astEdges - Edges from call graph / symbol references
   * @param n - Number of nodes
   * @param astWeight - How much to weight AST edges relative to text (default 2.0)
   */
  private _mergeASTEdges(
    textAdjacency: Map<number, Map<number, number>>,
    astEdges: Array<{ from: number; to: number; weight: number }>,
    n: number,
    astWeight: number = 2.0,
  ): Map<number, Map<number, number>> {
    // Clone the text adjacency
    const merged = new Map<number, Map<number, number>>();
    for (const [i, neighbors] of textAdjacency.entries()) {
      merged.set(i, new Map(neighbors));
    }

    // Ensure all nodes exist
    for (let i = 0; i < n; i++) {
      if (!merged.has(i)) merged.set(i, new Map());
    }

    // Add AST edges (bidirectional for PageRank flow)
    for (const edge of astEdges) {
      if (edge.from < 0 || edge.from >= n) continue;
      if (edge.to < 0 || edge.to >= n) continue;
      if (edge.from === edge.to) continue;

      const w = edge.weight * astWeight;

      // Forward edge (caller → callee)
      const fwdNeighbors = merged.get(edge.from)!;
      fwdNeighbors.set(edge.to, (fwdNeighbors.get(edge.to) ?? 0) + w * 0.5);

      // Backward edge (callee → caller) with reduced weight
      // Callees pointing back to callers helps find "hub" functions
      const bwdNeighbors = merged.get(edge.to)!;
      bwdNeighbors.set(edge.from, (bwdNeighbors.get(edge.from) ?? 0) + w * 2.0);
    }

    return merged;
  }

  /**
   * Rank sentences/blocks with AST call graph awareness.
   *
   * Uses the existing text-similarity graph but augments it with edges
   * from the symbol index call graph. This means:
   * - Functions that call many others have high out-degree → authority
   * - Functions called by many others have high in-degree → hub
   * - Bridge functions connecting clusters have high betweenness
   *
   * @param sentences - Text content of each block/function
   * @param topK - Number of top items to select
   * @param astEdges - Call graph edges from symbol index
   * @param query - Optional query for topic-biased ranking
   */
  rankWithAST(
    sentences: string[],
    topK: number,
    astEdges: Array<{ from: number; to: number; weight: number }>,
    query: string | null = null,
  ): SageResult {
    const n = sentences.length;
    if (n === 0) {
      return makeSageResult([], [], [], [], { ast_aware: true, ast_edges: 0 });
    }
    if (n === 1) {
      return makeSageResult(sentences, [1.0], [0], [], {
        sentences: 1,
        ast_aware: true,
        ast_edges: astEdges.length
      });
    }
    const effectiveTopK = Math.min(topK, n);

    // 1. Tokenise
    const sentTokens = sentences.map((s) => SageRank._tokenize(s));

    // 2. Build inverted index
    const [postingLists, docFreqs, docLengths, avgDl] =
      SageRank._buildPostingLists(sentTokens);

    // 3. Entropy-weighted IDF
    const [, eidf, , idfMax] = SageRank._computeEidf(
      postingLists,
      docFreqs,
      n,
    );

    // 4. Text similarity graph
    const [textAdjacency, textEdgeCount] = this._buildGraph(
      postingLists,
      eidf,
      docLengths,
      avgDl,
      n,
    );

    // 5. Merge AST edges into graph
    const adjacency = this._mergeASTEdges(textAdjacency, astEdges, n);

    // Count merged edges
    let mergedEdgeCount = 0;
    for (const neighbors of adjacency.values()) {
      mergedEdgeCount += neighbors.size;
    }
    mergedEdgeCount = Math.floor(mergedEdgeCount / 2); // Bidirectional

    // 6. Degree centrality (from merged graph)
    const centrality: number[] = [];
    for (let i = 0; i < n; i++) {
      const nbrs = adjacency.get(i);
      let sum = 0.0;
      if (nbrs) {
        for (const w of nbrs.values()) sum += w;
      }
      centrality.push(sum);
    }

    // 7. Position prior — OFF by default for source (see rankSentences).
    const position = this._usePositionPrior
      ? SageRank._positionPrior(centrality, n)
      : new Array<number>(n).fill(1.0);

    // 8. Optional query scoring — OFF by default (relevance is BMX+'s engine).
    let queryScores: Map<number, number> | null = null;
    if (this._useQueryBias && query !== null && query.length > 0) {
      const qt = SageRank._tokenize(query);
      if (qt.length > 0) {
        queryScores = this._scoreQuery(qt, postingLists, eidf, docLengths, avgDl);
      }
    }

    // 9. Personalization vector
    const personalization = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      let pVal = position[i]!;
      if (queryScores !== null && queryScores.size > 0) {
        pVal *= (queryScores.get(i) ?? 0.0) + 0.01;
      }
      personalization.set(i, pVal);
    }

    // 10. PageRank on the text+AST merged graph — full per-unit importance curve.
    const [prScores, prIters] = this._pagerank(adjacency, personalization, n);

    // 11. Normalise scores to [0, 1]. THIS is the per-range importance signal.
    let scores: number[] = [];
    for (let i = 0; i < n; i++) {
      scores.push(prScores.get(i) ?? 0.0);
    }
    if (this._normalize && scores.length > 0) {
      const maxS = Math.max(...scores);
      if (maxS > 0) {
        scores = scores.map((s) => s / maxS);
      }
    }

    // 12. De-overload: full coverage order over all n, then a knee-bounded core.
    const coverageOrder = this._extractWithCoverage(
      prScores,
      sentTokens,
      eidf,
      n,
      n,
    );
    const [coreIndices, rankedIndices] = this._selectCore(
      scores,
      coverageOrder,
      effectiveTopK,
    );

    // 13. Keywords
    const keywords = SageRank._getKeywords(eidf, docFreqs, 10);

    const leadBias =
      this._usePositionPrior && n > 0 ? position[0]! - 1.0 : 0.0;

    const stats: Record<string, number | boolean | string> = {
      sentences: n,
      vocabulary: postingLists.size,
      text_edges: textEdgeCount,
      ast_edges: astEdges.length,
      merged_edges: mergedEdgeCount,
      pagerank_iters: prIters,
      idf_max: Math.round(idfMax * 10000) / 10000,
      lead_bias: Math.round(leadBias * 10000) / 10000,
      position_prior: this._usePositionPrior,
      query_biased: this._useQueryBias && query !== null,
      core_size: coreIndices.length,
      selection_mode: "bounded_core",
      ast_aware: true,
    };

    return makeSageResult(
      sentences,
      scores,
      coreIndices,
      keywords,
      stats,
      rankedIndices,
      coreIndices,
      coverageOrder,
    );
  }
}
