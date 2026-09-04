// ---------------------------------------------------------------------------
// core/stride/search.ts — the recall-safe retrieval orchestrator
//
// This is the module invariant I7 FULL RECALL is made real in. Everything below
// is arranged so that recall is a property of the CONTROL FLOW, not of a tuning
// constant somebody could later move:
//
//   1. QUERY      `tokenize` the user's query, once, into the same vocabulary
//                 `BlockIndex` was built from. Nothing else is added to it — see
//                 the SoftAND note below for why the corpus must never be.
//   2. CANDIDATES `blocks.candidates(terms)` returns EVERY block naming an
//                 indexed term. Every term it could not answer for comes back in
//                 `missing`, and each of those is resolved by `scanTermBlocks`,
//                 an exhaustive literal sweep, whose blocks are UNIONED IN. No
//                 ranking, no cap, no sampling, no top-N anywhere on this path.
//   3. LOCATE     Every candidate block window is read once and searched for the
//                 query's literal bytes. Each matching byte is turned into a
//                 record by `resolver.locate`, and the record — the enclosing
//                 structural node — is the unit that gets scored.
//   4. VERIFY     Each candidate record is re-tokenised with the SAME
//                 `tokenizeBytes` the index was built with, which is what makes
//                 a match a match. The literal sweep is only ever a LOCATOR; the
//                 tokeniser is the sole authority on whether a term occurs, so a
//                 substring hit inside a longer word is rejected here, exactly as
//                 blocks.ts says a verify pass must reject it.
//   5. SCORE      BM25 over records, global df, tanh SoftAND coordination bonus.
//   6. CALIBRATE  Percentile-rank both channels, fuse lexical-dominant, cut with
//                 `shape.knee`, spend the budget top-down.
//
// ── Why the candidate set is never pruned ───────────────────────────────────
//
// Selecting the top-N candidate blocks by score instead of visiting all of them
// is the largest silent-recall failure in this class of index: measured at 8-24%
// of exhaustive result mass lost (visiting 1% of clusters recovers 0.76-0.83 of
// the exhaustive score, 5% recovers 0.83-0.91, 10% recovers 0.85-0.92), and it
// worsens with result depth. It is silent because the query still returns,
// ranked, with plausible results. `BlockIndex.candidates` deliberately offers no
// parameter for it and this file adds none upstream of it.
//
// The `missing` contract is where recall is actually preserved. A term with no
// posting list — never admitted because the dictionary reached TERM_DICT_LIMIT,
// or dropped for naming more than max(64, blockCount/4) blocks — is answered by
// `scanTermBlocks`, whose cost blocks.ts measures at 0.69-5.17 GB/s across eight
// needle shapes. Skipping that union is the one edit to this file that would
// break I7 while leaving every test that only looks at output shape green.
//
// ── Why the statistics are global ───────────────────────────────────────────
//
// `blocks.df(term)` is the document-wide block frequency and is exact even for a
// term whose postings were dropped. Block-local idf measured two documents with
// identical term frequencies 1.6x apart in score purely by block membership, so
// nothing here recomputes a frequency over the candidate set.
//
// ── Why calibration comes before fusion ─────────────────────────────────────
//
// The lexical channel is a long-tailed sum of BM25 term scores; the novelty
// channel is a bounded surprisal score. Fusing them raw lets the wider-scaled
// signal dominate regardless of the mixing weight, and min-max normalisation
// does not fix it because it PRESERVES the outlier spike that caused it —
// percentile rank does. So `relevance` is the record's rank among every matched
// record and `novelty` arrives already rank-calibrated from shape.ts, exactly as
// types.ts documents both fields.
//
// Weighting is lexical-dominant (0.7) with novelty as a tiebreaker, and the
// novelty pool is CAPPED. A graph-dominant weighting over an uncapped structural
// pool measured net-negative — 36 wins against 81 losses, LastHop@10 58.1 ->
// 51.0, R@5 88.0 -> 78.8, driven by a pool that grew from ~200 to 2,000+
// candidates — while capping the pool and moving the weight to 0.7 lexical
// restored 16W/5L. The cap is the guard, and it costs no recall: every match is
// still enumerated and counted, the cap only bounds how many of the top
// candidates the tiebreaker may reorder.
//
// ── What this file measured on the machine it was written on ────────────────
//
// node v22.23.2, median of 5 after warm-up (tests: search, "the rates this
// module's cost is made of"). These are the rates the pipeline's cost is made
// of, and they are why the work is split the way it is:
//
//   ASCII fold loop, 64 KiB chunks                 0.42 GB/s
//   Buffer.indexOf over a folded 64 KiB window     83 GB/s (14 B needle, no hit)
//   tokenizeBytes, called per ~200 B record        42 MiB/s
//   tokenizeBytes, one call over 3.4 MB            28 MiB/s
//
// The indexOf figure needs its condition stated or it is meaningless, because it
// is not a memory-bandwidth number: node's multi-byte `Buffer.indexOf` is a
// Boyer-Moore-Horspool skip search, so on a haystack whose bytes rarely collide
// with the needle's last byte it examines roughly one byte in `needle.length` and
// the per-haystack-byte rate exceeds memory bandwidth. Over a folded 64 KiB JSON
// window it measures 81-85 GB/s for 5-14 byte absent needles; over a synthetic
// haystack cycling `a`..`z`, where the skip table cannot skip, the same call
// measures 3.9 GB/s. The 20x spread is the haystack, not the needle.
//
// The tokeniser is ~1,900x slower than memmem per byte on JSON (~90x on the
// pathological haystack), which is the whole reason the literal sweep is the
// locator and the tokeniser only ever sees the bytes of records that already
// hold a literal hit. Tokenising every candidate BLOCK instead would cost ~21 s
// on a 600 MB document; tokenising only candidate RECORDS costs time
// proportional to how much of the document actually matched.
// ---------------------------------------------------------------------------

import { scanTermBlocks, type BlockIndex } from './blocks.js';
import { address } from './cursor.js';
import { tokenToIndex, unescapeToken } from './pointer.js';
import { MIN_VIEW_BUDGET, estimateChars, renderNode } from './render.js';
import type { Member, Resolver } from './resolve.js';
import { censusOf, knee, noveltyOf } from './shape.js';
import type { StrideSource } from './source.js';
import { isTokenBoundaryByte, pathTerms, tokenize, tokenizeBytes } from './terms.js';
import {
    ENVELOPE_RESERVE, SEARCH_BLOCK_BYTES, StrideError,
    type StrideHit, type StrideKind, type StrideNode, type StrideSearchResult, type StrideShape,
} from './types.js';

// ── Tuning constants ──────────────────────────────────────────────────────
// Each one states the reason it holds. A constant whose reason is unwritten is
// a constant nobody can safely retune, and in a ranker a wrong constant is a
// silent reordering rather than a failure.

/**
 * BM25 saturation parameters, the Lucene defaults, unmodified.
 *
 * `tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))` with k1 = 1.5 and
 * b = 0.75. Length normalisation matters MORE here than it does over source
 * text because record sizes vary wildly inside one document, and it is the term
 * that stops a 40 KB record outscoring the 200 B record that answers the query.
 *
 * The scoring kernel is deliberately not "improved". The one measured 2025+
 * audit of a single-tweak lexical variant, pooled over 75 tasks across six
 * suites, found nDCG@10 -0.8 with 95% CI [-1.4, -0.2] at p = 0.005 — a
 * statistically significant DROP — while the reliable win came from fusion.
 */
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

/**
 * Lexical share of the fused score; novelty takes the remaining 0.3.
 *
 * Measured: shifting weight to the structural channel was net-negative (36W/81L,
 * LastHop@10 58.1 -> 51.0, R@5 88.0 -> 78.8); a lexical-dominant 0.7 with a
 * capped structural pool restored 16W/5L. And where the primary retriever was
 * already strong the structural channel contributed literally nothing — 0 wins,
 * 0 losses — which is the argument for a tiebreaker rather than a co-equal
 * channel, not for a second retrieval path.
 */
export const LEXICAL_WEIGHT = 0.7;

/**
 * Cap on the candidate pool the novelty channel may reorder.
 *
 * A CAP, and fixed. This was a floor under `4 * (offset + limit)`, which made
 * the pool — and therefore the novelty percentile calibrated over it, and
 * therefore the fused order a page is sliced from — a function of the offset
 * that asked. Two pages then disagreed about the ranking: measured on 800
 * matching records at limit 10, walking every page returned 800 hits covering
 * 752 distinct records, so 48 came back twice and 48 were never shown at all.
 * At 1,200 records it was 90 and 90. Under 800 the drift was invisible, which
 * is why a 120-record test could not see it.
 *
 * 256 is SHAPE_SAMPLE, the census's own sample bound, so a pool and the prior it
 * is scored against are the same order of size; it also sits inside shape.knee's
 * CLIFF_MAX_N, which keeps the cutoff on its bounded-candidate-list branch. The
 * cap exists because an uncapped structural pool is the documented mechanism by
 * which fusion goes net-negative (2,000+ candidates instead of ~200) — which is
 * the reason it stays 256 rather than growing to cover a deep page. Ranks below
 * it are answered from the lexical order the pool was selected out of, bounded
 * by RANK_DEPTH_MAX.
 */
export const NOVELTY_POOL_CAP = 256;

/**
 * The deepest rank a page can address.
 *
 * Paging past the novelty pool continues in pure lexical order, and that order
 * has to be materialised as far as the page reaches: one `Scored` per rank, at
 * a measured 104 B retained each on this host, so this bound is what keeps a
 * query matching a million records from building a million objects to answer a
 * request for rank 999,990. 4,096 is 410 pages at the default page size — past
 * any walk a caller makes — and costs 416 KiB at full depth. Only the pool's
 * own members and the page's carry a resolved record; the rest of the depth is
 * three numbers and a null.
 *
 * Ranks beyond it are still COUNTED: `totalMatches` is the whole document's
 * count, and the hint says how many of them rank is addressable for, so the
 * limit is stated rather than silently applied.
 */
export const RANK_DEPTH_MAX = 4096;

/**
 * Members a novelty population needs before its ranks mean anything.
 *
 * shape.ts's `percentile` gives the top member of any population a rank of 1.0,
 * so a two-record population would report one of the two as maximally unusual.
 * The raw surprisal it is calibrating says the opposite: a gram unique among two
 * siblings scores ln(2)/ln(1000) = 0.10. Below this population the novelty
 * channel therefore reports 0 rather than a rank the sample cannot support.
 */
export const MIN_NOVELTY_POPULATION = 8;

/**
 * Bytes of a record the verify pass will tokenise.
 *
 * One SEARCH_BLOCK_BYTES, because that is already the span the index tokenises
 * in one pass, and a "record" larger than a whole block is a collection rather
 * than a record. A record above the cap is FIRST verified over that many bytes
 * around its first hit, as a fast path — and that window is kept only when it
 * confirms every query term. Otherwise the record is re-verified over all of its
 * own bytes, in boundary-aligned pieces.
 *
 * THIS NUMBER GOVERNS COST, NEVER RECALL, and it took a correction to make that
 * true. The window used to be the whole of the verify, and the window is centred
 * on the record's first LITERAL hit, which the literal sweep will happily place
 * inside a longer word. When the tokeniser then correctly refused to count the
 * substring and the record's genuine token occurrence lay more than half a window
 * away, `matched` came back 0 and the record was dropped: not counted in
 * totalMatches, on no page, while the hint asserted exhaustiveness. Measured on
 * the two-record fixture in tests/stride/search.test.ts, padding one record past
 * this cap took totalMatches from 2 to 1 with nothing else changed.
 */
export const RECORD_VERIFY_BYTES = SEARCH_BLOCK_BYTES;

/**
 * Bytes read and searched in one pass. Candidate blocks that are adjacent are
 * merged up to this width, which turns 64 one-block reads into a single 4 MiB
 * read — the same 4 MiB chunk `FileSource.sequential` already uses, so a merged
 * window is one sequential read of the file rather than 64 page-cache probes.
 */
const WINDOW_MAX_BYTES = 4 << 20;

/**
 * Byte offsets carried per hit. They exist to keep the matching bytes visible
 * inside a trimmed preview (`renderNode`'s `focus`), and render.ts hoists at
 * most FOCUS_MEMBER_CAP members for them, so a longer list cannot buy more
 * visibility — it only spends the caller's budget. 16 offsets cost ~120
 * characters of a hit.
 */
export const HIT_OFFSETS_MAX = 16;

/**
 * Hits per page when the caller does not say. The measured evidence for
 * adaptive cutoffs sits at depths 5-20 (ΔF1 1.98-2.89 from the oracle against
 * 10.8-24.2 for fixed-k), and the knee is applied on top of this anyway, so this
 * is a ceiling on the page rather than the page size.
 */
export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Member reads the novelty prior may spend in total, across every parent the
 * pool touches. Four censuses at the full SHAPE_SAMPLE. The novelty channel
 * carries 0.3 of the score, so its prior must not cost more than the lexical
 * pass it tiebreaks; when the pool spans many parents each census is asked for a
 * proportionally smaller sample instead of the budget being multiplied.
 */
const CENSUS_TOTAL_SAMPLE = 1024;

/**
 * The two characters of an empty hits array. No JSON payload is shorter, so a
 * smaller budget is reported back AT this floor rather than as the number asked
 * for — the same rule render.ts applies with MIN_VIEW_BUDGET, and for the same
 * reason: claiming a bound no valid payload can meet would make `chars <= budget`
 * a lie in the one case a caller is least able to check.
 */
export const MIN_RESULT_CHARS = 2;

/**
 * Query words dropped when a discriminating term survives beside them.
 *
 * This is a query-side list only — the index never sees it, so there is no
 * analyser mismatch between the two sides. The arithmetic is what justifies it:
 * a term naming every block has df = N, so its Lucene idf is
 * ln(1 + 0.5 / (N + 0.5)), which at N = 9,600 blocks (a 600 MB document) is
 * 5.2e-5, against 4.6 for a term naming 1% of blocks — five orders of magnitude
 * of scoring weight. Keeping it would cost a full-document literal sweep (its
 * postings are dropped by the index's own quarter-of-the-document rule), union
 * every block into the candidate set, and inflate `m` in the coordination
 * bonus's `1/m`, damping the one signal that rewards matching several terms.
 *
 * A query with nothing but these is `empty_query`, not a scan of the document.
 */
export const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
    'have', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'she', 'that', 'the',
    'their', 'them', 'then', 'there', 'they', 'this', 'to', 'was', 'were', 'what',
    'when', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

// ── Options and the query side ────────────────────────────────────────────

/** What a caller asks a search for. */
export interface StrideSearchOptions {
    /** Characters the hits may occupy. Reported back at MIN_RESULT_CHARS floor. */
    readonly budget: number;
    /** Ceiling on hits returned. The knee may return fewer. */
    readonly limit?: number;
    /** Rank to resume from, for paging. */
    readonly offset?: number;
}

/** One query term, with every global statistic it will be scored with. */
interface QueryTerm {
    readonly term: string;
    /**
     * Times the term appears in the query. Repetition IS the weight — it lets a
     * caller emphasise a term without touching the scorer.
     */
    readonly qtf: number;
    /** Global block frequency. Never recomputed over the candidate set. */
    readonly df: number;
    /** Lucene idf: `ln((N - df + 0.5) / (df + 0.5) + 1)`, always positive. */
    readonly idf: number;
    /**
     * Informativeness, `1 - df/N`.
     *
     * This is the limit the entropy-blended form collapses to on record data,
     * and the reason is arithmetic rather than aesthetic: that form blends
     * Shannon entropy over a term's posting list with `1 - df/N` at
     * `variance / (variance + 1)`, and with a token occurring 0 or 1 times in
     * almost every record the variance across the posting list is small, the
     * blend weight goes to 0, and the whole apparatus becomes a second copy of
     * this number. Implementing the limit is honest; implementing thirty lines
     * that compute it the long way is not.
     */
    readonly info: number;
    /** `idf / max(idf)`, filled in once every term's idf is known. */
    gamma: number;
    /** `idf * (1 + gamma * info)` — the eIDF the term is scored with. */
    eidf: number;
    /**
     * Folded byte forms searched for in the document. More than one only when
     * the term carries a byte outside ASCII (see `needlesFor`).
     */
    readonly needles: readonly Buffer[];
}

/** The query, as the whole pipeline will see it. */
interface PreparedQuery {
    readonly terms: readonly QueryTerm[];
    /** Terms dropped as non-discriminating, named in the hint. */
    readonly dropped: readonly string[];
    /** Distinct term count — the `m` of the coordination bonus's `1/m`. */
    readonly m: number;
}

/** ASCII-only lowercase of one byte. The document's bytes are never rewritten. */
function foldByte(b: number): number {
    return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

/** ASCII-fold `[from, to)` of `src` into the front of `dst`. */
function foldInto(src: Buffer, dst: Buffer, from: number, to: number): void {
    for (let i = from; i < to; i++) {
        const b = src[i];
        // `i < to <= src.length` by the caller's contract, so undefined is
        // unreachable. Copying the byte through unchanged is the fail-safe
        // reading: an unfolded byte still matches an unfolded haystack byte,
        // where a `?? 0` would write a NUL into the middle of the haystack and
        // hide every occurrence that straddled it.
        dst[i - from] = b === undefined ? 0 : foldByte(b);
    }
}

/** ASCII-fold a whole buffer into a new one. */
function foldCopy(src: Buffer): Buffer {
    const out = Buffer.allocUnsafe(src.length);
    foldInto(src, out, 0, src.length);
    return out;
}

/**
 * The byte forms of a term to search a folded haystack for.
 *
 * A term arrives lowercased: `sliceTerm` folds ASCII inline and runs
 * `toLowerCase()` over anything outside it. The haystack is folded on ASCII only
 * — folding it fully would mean decoding UTF-8 at the 100-300 MB/s measured for
 * naive fold-then-scan instead of memmem's multiple GB/s, and it would change
 * bytes the document has not — so a term holding a byte >= 0x80 also gets its
 * upper-cased form, which recovers ALL-CAPS non-ASCII text (`ÄPFEL` folds to
 * `Äpfel`, and so does the term). What neither form recovers is non-ASCII text
 * whose case varies within the term; that is the same ASCII-range bound
 * `scanTermBlocks` and `foldAscii` state in blocks.ts, inherited rather than
 * introduced here.
 */
function needlesFor(term: string): Buffer[] {
    const lower = Buffer.from(term, 'utf8');
    let high = false;
    for (const b of lower) if (b >= 0x80) { high = true; break; }
    if (!high) return [lower];
    const upper = foldCopy(Buffer.from(term.toUpperCase(), 'utf8'));
    return upper.equals(lower) ? [lower] : [lower, upper];
}

/**
 * The terms a query will actually be searched for: the tokeniser's view of it,
 * de-duplicated with a count, minus stopwords when a discriminating term
 * survives.
 *
 * Exported because a caller that wants to explain a result — or a test that
 * wants ground truth — must be able to see the same term list the search used,
 * and re-deriving it elsewhere is how the two sides drift apart.
 */
export function searchTerms(query: string): string[] {
    const counted = countTerms(query);
    const kept: string[] = [];
    for (const [term] of counted) if (!SEARCH_STOPWORDS.has(term)) kept.push(term);
    if (kept.length > 0) return kept;
    return [...counted.keys()];
}

/** Distinct query terms in first-seen order, with their query frequencies. */
function countTerms(query: string): Map<string, number> {
    const counted = new Map<string, number>();
    for (const term of tokenize(query)) {
        const seen = counted.get(term);
        counted.set(term, seen === undefined ? 1 : seen + 1);
    }
    return counted;
}

/**
 * `scanTermBlocks` for one term, memoised for the life of one query.
 *
 * A dictionary-missing term is needed twice on this path — once for its exact
 * `df` and once for its candidate blocks — and each sweep is a pass over the
 * WHOLE document. Sweeping twice would double the cost of exactly the route the
 * `missing` contract exists to make affordable, so the two callers share one
 * result. The memo lives for one query and is discarded with it.
 */
function sweptBlocks(source: StrideSource, term: string, memo: Map<string, Uint32Array>): Uint32Array {
    const cached = memo.get(term);
    if (cached !== undefined) return cached;
    const found = scanTermBlocks(source, term);
    memo.set(term, found);
    return found;
}

/** Prepare the query, or fail with `empty_query` naming the recovery. */
function prepareQuery(
    query: string,
    blocks: BlockIndex,
    source: StrideSource,
    sweeps: Map<string, Uint32Array>,
): PreparedQuery {
    const counted = countTerms(query);
    if (counted.size === 0) {
        throw new StrideError(
            'empty_query',
            query.trim().length === 0
                ? 'Search was given an empty query.'
                : `Nothing in ${JSON.stringify(query)} is searchable: it produced no terms.`,
            'Search for a value or a member name that appears in the document — an id, a status, '
            + 'a timestamp, a key. Call mode "shape" on a collection first to see which fields exist.',
        );
    }
    const dropped: string[] = [];
    const keep: string[] = [];
    for (const term of counted.keys()) {
        if (SEARCH_STOPWORDS.has(term)) dropped.push(term);
        else keep.push(term);
    }
    if (keep.length === 0) {
        throw new StrideError(
            'empty_query',
            `Every term in ${JSON.stringify(query)} is a word that names most of any document `
            + `(${dropped.join(', ')}), so there is nothing in it to search for.`,
            'Add a term that discriminates — an id, a status value, a member name, a timestamp. '
            + 'Call mode "shape" on a collection to see which fields and values exist.',
        );
    }

    // N is the BLOCK count, because `df` is a block frequency. Mixing a
    // record-scale N with a block-scale df would put idf on a scale neither
    // statistic was measured at.
    const n = blocks.blockCount;
    const terms: QueryTerm[] = [];
    let idfMax = 0;
    for (const term of keep) {
        const qtf = counted.get(term);
        // `term` came out of `counted.keys()`, so the lookup cannot miss; 1 is
        // also the only honest fallback, since a term present in the query
        // occurs at least once in it.
        const weight = qtf === undefined ? 1 : qtf;
        // A term the dictionary never admitted has df 0, which would read as
        // "maximally rare" and let a saturation artefact dominate the ranking.
        // The exhaustive sweep the same term is about to be resolved by returns
        // the exact set of blocks holding it, so the sweep's own length is the
        // df — measured, not assumed. `blocks.df` is preferred whenever it is
        // non-zero because it is exact even for a dropped posting list.
        const indexed = blocks.df(term);
        const df = indexed > 0 ? indexed : sweptBlocks(source, term, sweeps).length;
        const idf = n > 0 ? Math.log((n - df + 0.5) / (df + 0.5) + 1) : 0;
        if (idf > idfMax) idfMax = idf;
        terms.push({
            term,
            qtf: weight,
            df,
            idf,
            info: n > 0 ? 1 - df / n : 1,
            gamma: 0,
            eidf: 0,
            needles: needlesFor(term),
        });
    }
    for (const t of terms) {
        // gamma is term-adaptive and corpus-size independent: it says how
        // informative this term is RELATIVE to the most informative term in the
        // query, which is what keeps the coordination bonus on the same scale
        // whatever the document. An all-equal-idf query gives every term 1.
        t.gamma = idfMax > 0 ? t.idf / idfMax : 1;
        t.eidf = t.idf * (1 + t.gamma * t.info);
    }
    return { terms, dropped, m: terms.length };
}

// ── Growable typed storage ────────────────────────────────────────────────
//
// Phase 1 keeps NUMBERS ONLY for every matched record: 16 bytes, plus 4 per query
// term for the frequencies, plus 4 per 32 query terms for the bit per term that
// says the term occurred in the record's own BYTES rather than only in its path.
// A pointer per record would be tens of bytes of string header on a query that
// matched a million records, and every pointer except the pool's is re-derivable
// from the one byte offset that found the record (I6).

/**
 * Double a growable array until it holds `need` entries.
 *
 * Typed as `<ArrayBuffer>` rather than as a bare view for the reason blocks.ts
 * gives: every array grown here was allocated here, so its buffer is private and
 * non-shared, and the bare form widens to `ArrayBufferLike` — a claim the
 * assignment back into the caller's own binding then correctly rejects.
 */
function growF64(a: Float64Array<ArrayBuffer>, need: number): Float64Array<ArrayBuffer> {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 256 : a.length;
    while (n < need) n *= 2;
    const out = new Float64Array(n);
    out.set(a);
    return out;
}

function growU32(a: Uint32Array<ArrayBuffer>, need: number): Uint32Array<ArrayBuffer> {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 256 : a.length;
    while (n < need) n *= 2;
    const out = new Uint32Array(n);
    out.set(a);
    return out;
}

/** 32-bit words needed to hold one bit per query term. */
function maskWords(m: number): number {
    return m <= 0 ? 1 : Math.ceil(m / 32);
}

/** Everything phase 1 retains about the records that matched. */
interface Matches {
    /** Token length of each record, the `dl` of BM25. */
    dl: Float64Array<ArrayBuffer>;
    /** One matching byte offset per record — the seed for re-deriving it. */
    seed: Float64Array<ArrayBuffer>;
    /** `m` term frequencies per record, row-major. */
    tf: Uint32Array<ArrayBuffer>;
    /**
     * One bit per query term per record, row-major, set when the term occurred
     * in the record's OWN BYTES. This is what `matched` is reported from and
     * what decides whether a record is a match at all — a path term is a
     * ranking signal and must not be able to manufacture either.
     */
    mask: Uint32Array<ArrayBuffer>;
    /** Records that matched. This is `totalMatches`. */
    n: number;
}

/** An empty `Matches`, for the paths that never reach phase 1. */
function noMatches(): Matches {
    return {
        dl: new Float64Array(0),
        seed: new Float64Array(0),
        tf: new Uint32Array(0),
        mask: new Uint32Array(0),
        n: 0,
    };
}

// ── The record: the unit that gets scored ─────────────────────────────────

/** A record, as located from a matching byte. */
interface RecordRef {
    readonly pointer: string;
    readonly kind: StrideKind;
    readonly start: number;
    readonly end: number;
    readonly depth: number;
    readonly parent: string | null;
}

/**
 * The record a matching byte belongs to: the deepest enclosing structural node.
 *
 * Expansion to the enclosing node is UNCONDITIONAL, never gated on the
 * neighbour's own relevance. The gated form's stated limitation is precisely
 * this domain's hazard — it "assumes a needed adjacent chunk retains enough
 * standalone query relevance to pass the expansion gate" — and for a value
 * separated from the header that names it, the gate skips evidence that dumb
 * windowing recovers. Measured, a chunk carrying its own governing header went
 * from 67.4% missing at 800 characters to 0.3% with a structure-aware unit, and
 * that context is the difference between a value that answers the question and a
 * number ambiguous by two orders of magnitude.
 *
 * A scalar's record is its container, because the container is what makes the
 * scalar interpretable. The one exception is a scalar whose container is the
 * document root: in `["error a", "error b"]` the element IS the record, and
 * answering with the root would answer with the whole document.
 *
 * THE DOCUMENT ROOT IS NEVER A RECORD, and `null` says so. A byte that lies in a
 * container's own bytes rather than in any member's — a member NAME, a bracket, a
 * comma — is located as that container, and for every container but one that is
 * the right record: a hit in the key `"tag"` of `{"tag":"x"}` is a hit on that
 * object. At the root there is no such object, so the same rule would return a
 * "record" whose span is the whole document and whose preview is the document
 * trimmed to a page of one hit — the single answer STRIDE exists to avoid, and
 * the same hazard the scalar exception above was written for. Such a hit is
 * therefore attributed to no record; a query naming a root member name is
 * answered by mode "map" or "shape", which the hint says. Nothing under the root
 * is lost: every record that holds the term in its own bytes is enumerated on its
 * own account, wherever it sits.
 *
 * `located` is passed in rather than re-derived, because the caller already has
 * it and `locate` is the most expensive call on this path.
 */
function recordFor(resolver: Resolver, located: StrideNode): RecordRef | null {
    if (located.kind === 'object' || located.kind === 'array') {
        return located.parent === null ? null : refOf(located);
    }
    const parent = located.parent;
    if (parent === null || parent === '') return refOf(located);
    try {
        return refOf(resolver.resolve(parent));
    } catch (e) {
        // A parent pointer that will not resolve must not cost the caller the
        // hit: the located value's own span is correct and addressable, so the
        // hit is reported one level in rather than dropped. Only STRIDE's own
        // failures are absorbed — anything else is a real fault and must travel.
        if (!(e instanceof StrideError)) throw e;
        return refOf(located);
    }
}

function refOf(node: StrideNode): RecordRef {
    return {
        pointer: node.pointer,
        kind: node.kind,
        start: node.start,
        end: node.end,
        depth: node.depth,
        parent: node.parent,
    };
}

/** A record currently accumulating hits, plus the byte that opened it. */
interface OpenRecord {
    readonly start: number;
    readonly end: number;
    /** First matching byte, the anchor of a capped verify window. */
    readonly seed: number;
}

// ── Phase 1: locate and verify ────────────────────────────────────────────

/**
 * Verify one record and return its term frequencies and token length.
 *
 * The record's bytes are re-tokenised with `tokenizeBytes` — the same function,
 * over the same bytes, that `BlockIndex.build` posted its terms from. That is
 * what makes this the authority on whether a term occurs: the literal sweep that
 * found the record matches substrings, and blocks.ts says so explicitly, naming
 * only blocks "where the term occurs inside a longer word, which only ever ADDS
 * candidates for the verify pass to reject". Rejecting them here, uniformly, is
 * what keeps the answer independent of which block a record happened to land in.
 *
 * The record's path terms are counted as occurrences too, which is what indexing
 * a record with its own path prefix means: measured, a structural prefix moved
 * MRR@5 from 0.374 to 0.463 (+23.8%) and changed the top-1 result for 86.9% of
 * queries.
 *
 * IT IS A RANKING SIGNAL ONLY, and `mask` is what makes that structural rather
 * than argued. `mask` carries a bit per term set only from the record's own
 * tokens, `matched` counts only those bits, and the caller's match gate reads
 * `matched` — so a path term can move a score and can never create a match or
 * appear in `matched`. Arguing it from "a record only reaches this function by
 * holding a literal hit in its own bytes" is NOT enough, and the gap is
 * reachable: the literal sweep matches substrings, so a record holding
 * `preshippedx` is opened by a query for `shipped`, and while the tokeniser
 * correctly refuses to count `shipped` there, a path term matching a SECOND
 * query term would satisfy a gate that counted path terms and turn the rejected
 * substring into a match. Measured on a 600-record fixture before the mask, the
 * query `orders shipped zulufoxtrot` reported 601 matches where one record holds
 * a query term; and because only candidate blocks are verified, which of those
 * false matches appeared depended on block membership — the inconsistent recall
 * I7 forbids.
 */
function verifyRecord(
    source: StrideSource,
    index: ReadonlyMap<string, number>,
    m: number,
    rec: OpenRecord,
    pointer: string,
    scratch: string[],
    mask: Uint32Array,
): { readonly tf: Uint32Array; readonly dl: number; readonly matched: number } {
    const tf = new Uint32Array(m);
    mask.fill(0);
    let matched = 0;
    const bump = (term: string, ofBytes: boolean): void => {
        const i = index.get(term);
        if (i === undefined) return;
        // `i` came from the query index, so `i < m === tf.length` and the
        // undefined branch is unreachable; 0 is this term's count before this
        // occurrence, so the unreachable branch carries the same value the
        // reachable one does and cannot deflate a frequency.
        const prior = tf[i];
        tf[i] = (prior === undefined ? 0 : prior) + 1;
        if (!ofBytes) return;
        // `i >>> 5 < maskWords(m) === mask.length`, so this read is in range too;
        // 0 is an unset bit, which can only cost this occurrence its place in
        // `matched` — it can never mark a term the record does not hold.
        const w = i >>> 5;
        const bit = 1 << (i & 31);
        const held = mask[w];
        const now = held === undefined ? 0 : held;
        if ((now & bit) === 0) { mask[w] = now | bit; matched += 1; }
    };
    /** Tokenise one already-boundary-aligned span and return its token count. */
    const absorb = (from: number, to: number): number => {
        const buf = source.slice(from, to);
        scratch.length = 0;
        tokenizeBytes(buf, 0, buf.length, scratch);
        for (const token of scratch) bump(token, true);
        return scratch.length;
    };

    let dl: number;
    if (rec.end - rec.start <= RECORD_VERIFY_BYTES) {
        dl = absorb(rec.start, rec.end);
    } else {
        // Fast path: the window around the first literal hit. Centred, so the
        // whole term is inside it — a term is at most TOKEN_MAX_BYTES long and
        // the half-window is 32 KiB.
        const half = Math.floor(RECORD_VERIFY_BYTES / 2);
        const from = Math.max(rec.start, rec.seed - half);
        dl = absorb(from, Math.min(rec.end, from + RECORD_VERIFY_BYTES));
        if (matched < m) {
            // The window did not settle the record. It cannot be trusted for the
            // gate, because the hit it is centred on may be a substring inside a
            // longer word, and it cannot be trusted for coordination, because a
            // term it never saw scores tf 0 and keeps the SoftAND bonus from
            // firing on the record that holds the whole query. Start over across
            // all of the record's own bytes; the window's counts are discarded
            // rather than added so tf and dl stay measured over exactly one
            // region.
            tf.fill(0);
            mask.fill(0);
            matched = 0;
            dl = absorbWholeRecord(source, rec, absorb);
        }
    }

    const path = pathTerms(pointer);
    for (const term of path) bump(term, false);

    return { tf, dl: dl + path.length, matched };
}

/**
 * Tokenise every byte of a record in pieces, and return the total token count.
 *
 * The pieces are cut at CL_NONE bytes, never at a fixed stride, so no atom is
 * ever cut in half: `tokenizeBytes` says a token straddling its `to` is cut
 * short and names the caller as the one who must solve it, and this is the
 * solution that keeps the pieces a PARTITION of the record. Overlapping the
 * pieces instead would double-count the overlap in `tf` and `dl`, and worse,
 * would tokenise from the overlap's edge — emitting an atom that starts where no
 * token starts, which can equal a query term the document does not hold.
 *
 * Cost is the record's own bytes at the tokeniser's rate, and it is paid only by
 * a record that is both larger than RECORD_VERIFY_BYTES and unsettled by its
 * window. Summed over a query that is bounded by the candidate records' bytes —
 * the same order as the literal sweep that produced the candidates, and never
 * the document more than once.
 *
 * Measured on this host: `tokenizeBytes` folds 23.7 MiB/s, and a query over 24
 * records of 128 KiB each, every one of them driven down this path by a rejected
 * substring, took 130 ms for 3.0 MiB — the records' own bytes at that rate, which
 * is the bound above and not a multiple of it.
 */
function absorbWholeRecord(
    source: StrideSource,
    rec: OpenRecord,
    absorb: (from: number, to: number) => number,
): number {
    let dl = 0;
    let pos = rec.start;
    // The previous piece ran out of boundary bytes, so it ended inside a run of
    // word bytes. Everything up to that run's end was already tokenised as one
    // (truncated) atom, so this piece must skip to the run's end rather than
    // emit a second atom starting mid-run.
    let insideRun = false;
    while (pos < rec.end) {
        const end = Math.min(pos + RECORD_VERIFY_BYTES, rec.end);
        let lo = pos;
        if (insideRun) {
            while (lo < end && !isTokenBoundaryByte(source.byteAt(lo))) lo++;
            if (lo >= end) { pos = end; continue; }
            insideRun = false;
        }
        let hi = end;
        if (end < rec.end) {
            // Retreat to the last byte no atom can span. The bytes given up are
            // read again as the head of the next piece, so none are skipped.
            while (hi > lo && !isTokenBoundaryByte(source.byteAt(hi - 1))) hi--;
            if (hi === lo) { hi = end; insideRun = true; }
        }
        dl += absorb(lo, hi);
        pos = hi;
    }
    return dl;
}

/**
 * One probe: a needle and the term it belongs to, with its cursor into the
 * window. Several probes share a term when the term needs more than one byte
 * form.
 */
interface Probe {
    readonly needle: Buffer;
    readonly termIndex: number;
    /** Position of the next occurrence in the folded window, or -1. */
    pos: number;
}

/** The union of candidate blocks, and whether a literal sweep was needed. */
interface Candidates {
    /** One byte per block: 1 when the block must be verified. */
    readonly mark: Uint8Array;
    readonly count: number;
    /** True when at least one term could only be answered by a sweep. */
    readonly swept: boolean;
}

/**
 * Every block that must be verified, and nothing less.
 *
 * `candidates()` gives the complete union of blocks naming an indexed term.
 * Every term it reports as `missing` is then resolved by `scanTermBlocks` and
 * UNIONED IN — not intersected, not ranked, not sampled. This union is the whole
 * of I7's enumeration guarantee, and it is why `path` reports 'scan' whenever a
 * sweep ran: the answer came from the exhaustive route, not from postings.
 */
function candidateBlocks(
    blocks: BlockIndex,
    source: StrideSource,
    terms: readonly QueryTerm[],
    sweeps: Map<string, Uint32Array>,
): Candidates {
    const mark = new Uint8Array(blocks.blockCount);
    let count = 0;
    const set = (b: number): void => {
        if (b < mark.length && mark[b] === 0) { mark[b] = 1; count += 1; }
    };
    const found = blocks.candidates(terms.map((t) => t.term));
    for (const b of found.blocks) set(b);
    for (const term of found.missing) {
        for (const b of sweptBlocks(source, term, sweeps)) set(b);
    }
    return { mark, count, swept: found.missing.length > 0 };
}

/** Half-open windows to read, each covering a run of adjacent candidate blocks. */
function windowsOf(blocks: BlockIndex, cand: Candidates): Array<readonly [number, number]> {
    const out: Array<readonly [number, number]> = [];
    let runFrom = -1;
    let runTo = -1;
    const flush = (): void => {
        if (runFrom >= 0) out.push([runFrom, runTo] as const);
        runFrom = -1;
    };
    for (let b = 0; b < cand.mark.length; b++) {
        if (cand.mark[b] !== 1) continue;
        // The SCAN range, not the block range: a term straddling a block
        // boundary is emitted whole by the later block only, and its first byte
        // lies up to TOKEN_MAX_BYTES before that boundary — inside this span and
        // outside `blockRange`. Reading the narrower one would find the tail of
        // the term, score it as no match, and lose the hit silently.
        const [from, to] = blocks.blockScanRange(b);
        if (runFrom >= 0 && from <= runTo && to - runFrom <= WINDOW_MAX_BYTES) {
            runTo = to;
            continue;
        }
        flush();
        runFrom = from;
        runTo = to;
    }
    flush();
    return out;
}

/**
 * Walk every candidate block, turn each matching byte into a record, and verify
 * every record the same way.
 *
 * Records are closed off a STACK rather than collected in a map, which is what
 * keeps this pass bounded in memory and exact at the same time. Matching bytes
 * arrive in ascending document order, and JSON nodes nest properly, so a record
 * stays open until a byte past its end arrives; a hit inside a nested container
 * pushes that container and pops back to the outer record afterwards. Nothing is
 * counted twice and nothing is closed early, however the hits are distributed.
 */
function collectMatches(
    resolver: Resolver,
    blocks: BlockIndex,
    query: PreparedQuery,
    cand: Candidates,
): Matches {
    const source = resolver.source;
    const m = query.m;
    const index = new Map<string, number>();
    for (let i = 0; i < query.terms.length; i++) {
        const t = query.terms[i];
        if (t !== undefined) index.set(t.term, i);
    }

    const out: Matches = noMatches();
    const scratch: string[] = [];
    const words = maskWords(m);
    const mask = new Uint32Array(words);
    const stack: OpenRecord[] = [];
    /** Pointer of each open record, index-aligned with `stack`. */
    const pointers: string[] = [];

    const close = (): void => {
        const rec = stack.pop();
        const pointer = pointers.pop();
        if (rec === undefined || pointer === undefined) return;
        const v = verifyRecord(source, index, m, rec, pointer, scratch, mask);
        // A record whose every literal hit was a substring inside a longer word
        // is not a match. This is the rejection blocks.ts's `scanTermBlocks`
        // documents, applied uniformly so the answer cannot depend on which
        // block a record landed in. `v.matched` counts only terms found in the
        // record's own bytes, which is what makes the rejection hold even when a
        // path term happens to name another query term.
        if (v.matched === 0) return;
        const slot = out.n;
        out.dl = growF64(out.dl, slot + 1);
        out.seed = growF64(out.seed, slot + 1);
        out.tf = growU32(out.tf, (slot + 1) * m);
        out.mask = growU32(out.mask, (slot + 1) * words);
        out.dl[slot] = v.dl;
        out.seed[slot] = rec.seed;
        for (let i = 0; i < m; i++) {
            const c = v.tf[i];
            // `i < m === v.tf.length`; 0 is the count a fresh row would hold
            // anyway, so an unreachable failed read cannot invent a frequency.
            out.tf[slot * m + i] = c === undefined ? 0 : c;
        }
        for (let w = 0; w < words; w++) {
            const bits = mask[w];
            // `w < words === mask.length`; 0 is "no term of this word occurred in
            // the bytes", which can only omit a term from `matched` and can never
            // claim one the record does not hold.
            out.mask[slot * words + w] = bits === undefined ? 0 : bits;
        }
        out.n = slot + 1;
    };

    // Memo for `locate`, valid only over a SCALAR's span: a scalar has no
    // children, so every byte inside it resolves to the same record whatever
    // order the offsets arrive in. A container's span carries no such guarantee
    // and is never memoised.
    let memoFrom = -1;
    let memoTo = -1;
    let memoRec: RecordRef | null = null;

    const windows = windowsOf(blocks, cand);
    const widest = windows.reduce((w, [from, to]) => Math.max(w, to - from), 0);
    const folded = widest > 0 ? Buffer.allocUnsafe(widest) : Buffer.alloc(0);
    const probes: Probe[] = [];
    for (let i = 0; i < query.terms.length; i++) {
        const t = query.terms[i];
        if (t === undefined) continue;
        for (const needle of t.needles) probes.push({ needle, termIndex: i, pos: -1 });
    }

    let prevTo = -1;
    for (const [from, to] of windows) {
        const raw = source.slice(from, to);
        const span = raw.length;
        foldInto(raw, folded, 0, span);
        const hay = folded.subarray(0, span);
        for (const p of probes) p.pos = hay.indexOf(p.needle, 0);

        for (;;) {
            // k-way merge over the probes, so occurrences are processed in
            // ascending document order without materialising or sorting them.
            let best = -1;
            let bestPos = Number.MAX_SAFE_INTEGER;
            for (let i = 0; i < probes.length; i++) {
                const p = probes[i];
                if (p === undefined || p.pos < 0) continue;
                if (p.pos < bestPos) { bestPos = p.pos; best = i; }
            }
            const probe = best < 0 ? undefined : probes[best];
            if (probe === undefined) break;
            const at = from + probe.pos;
            const endsAt = at + probe.needle.length;
            probe.pos = hay.indexOf(probe.needle, probe.pos + 1);

            // Adjacent windows overlap by the scan margin. An occurrence that
            // lay ENTIRELY inside the previous window was already processed
            // there; one that straddled its end was not — the previous window
            // held only part of the needle — so the test is on the occurrence's
            // end, not its start.
            if (at < prevTo && endsAt <= prevTo) continue;

            while (stack.length > 0) {
                const top = stack[stack.length - 1];
                if (top === undefined || at < top.end) break;
                close();
            }
            let rec: RecordRef | null;
            if (memoRec !== null && at >= memoFrom && at < memoTo) {
                rec = memoRec;
            } else {
                const located = resolver.locate(at);
                rec = recordFor(resolver, located);
                if (rec !== null && located.kind !== 'object' && located.kind !== 'array') {
                    memoFrom = located.start;
                    memoTo = located.end;
                    memoRec = rec;
                } else {
                    memoRec = null;
                }
            }
            // A byte belonging to no record — the document root's own bytes — is
            // not a match anywhere. The stack has already been unwound past it,
            // which is the whole of the bookkeeping this hit owed.
            if (rec === null) continue;
            const top = stack[stack.length - 1];
            if (top === undefined || top.start !== rec.start || top.end !== rec.end) {
                if (top !== undefined && (rec.start < top.start || rec.end > top.end)) {
                    // Not nested inside the open record: close everything before
                    // opening it, so no two open records can overlap.
                    while (stack.length > 0) close();
                }
                stack.push({ start: rec.start, end: rec.end, seed: at });
                pointers.push(rec.pointer);
            }
        }
        prevTo = to;
    }
    while (stack.length > 0) close();
    return out;
}

// ── Phase 2: score, calibrate, fuse, cut ──────────────────────────────────

/** BM25 term-frequency saturation. */
function saturate(tf: number, dl: number, avgdl: number): number {
    const norm = avgdl > 0 ? dl / avgdl : 1;
    return (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * norm));
}

/**
 * One record's lexical score: BM25 plus the tanh SoftAND coordination bonus.
 *
 * `base + (Σ tanh(termScore) / m) * (Σ γ_t · info_t · qtf)`. The tanh saturates
 * each term's contribution to the coverage sum at ~1, so the bonus measures HOW
 * MANY distinct query terms fired rather than how hard one of them fired. That
 * anti-dominance property is the point: it stops one record with 200 repetitions
 * of a single term burying the record that matched every term.
 *
 * `m` is the number of terms in the USER'S query. The engine this mechanism came
 * from built its query as `factsQuery + " " + corpusTerms`, which makes
 * `m ≈ |vocabulary|`, drives `1/m` to zero and neuters the bonus entirely. That
 * construction exists to give every candidate a non-zero intrinsic score and it
 * is not copied here.
 */
function lexicalScore(terms: readonly QueryTerm[], tf: Uint32Array, base: number, dl: number, avgdl: number, m: number): number {
    let sum = 0;
    let coverage = 0;
    let info = 0;
    for (let i = 0; i < terms.length; i++) {
        const t = terms[i];
        if (t === undefined) continue;
        const count = tf[base + i];
        // `base + i` is inside the row this record owns; 0 means "this term does
        // not occur here", which is the same thing an unwritten slot means, so
        // an unreachable failed read cannot invent a match.
        const n = count === undefined ? 0 : count;
        if (n === 0) continue;
        const termScore = t.eidf * saturate(n, dl, avgdl) * t.qtf;
        sum += termScore;
        coverage += Math.tanh(termScore);
        info += t.gamma * t.info * t.qtf;
    }
    if (sum === 0) return 0;
    return sum + (coverage / m) * info;
}

/**
 * Percentile rank of `value` in an ascending array, matching shape.ts's
 * calibration exactly: ties share the rank of the FIRST member of their group,
 * so 19,998 identical boilerplate records all calibrate to 0 instead of
 * spreading across [0,1] in the order the scanner happened to reach them.
 *
 * NOT min-max and NOT divide-by-max. One pathological record takes the maximum
 * on its own, and under either of those every other score is compressed toward
 * zero — which is also why the two channels are calibrated BEFORE they are
 * fused: with one signal long-tailed and the other bounded, a direct weighted
 * combination is dominated by the wider-scaled one regardless of the weight, and
 * min-max preserves the spike that does it.
 */
function percentileOf(sorted: Float64Array, n: number, value: number): number {
    if (n <= 1) return 0;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const v = sorted[mid];
        // +Infinity for an out-of-range read: it compares above every real
        // score, so the search moves left and the rank can only come out lower.
        // An unreachable failed read therefore understates a rank; it cannot
        // promote a record.
        if ((v === undefined ? Number.POSITIVE_INFINITY : v) < value) lo = mid + 1;
        else hi = mid;
    }
    return lo / (n - 1);
}

/** A pool candidate, before novelty and the budget are applied. */
interface Scored {
    readonly slot: number;
    readonly raw: number;
    readonly seed: number;
    relevance: number;
    novelty: number;
    score: number;
    record: RecordRef | null;
}

/**
 * The bounded pool the novelty channel may reorder: the highest-scoring
 * candidates by lexical relevance.
 *
 * Selected against a threshold read out of the sorted score array rather than by
 * sorting every candidate, so a query matching a million records pays one typed
 * sort and one pass instead of a comparison sort over a million objects. Ties at
 * the threshold are kept and trimmed after ordering, which is what makes the
 * selection deterministic on a population of identical records.
 */
function poolOf(raws: Float64Array, sorted: Float64Array, n: number, seeds: Float64Array, want: number): Scored[] {
    const pool: Scored[] = [];
    if (n === 0 || want <= 0) return pool;
    const cutIndex = Math.max(0, n - want);
    const cut = sorted[cutIndex];
    // An unreachable failed read admits everything rather than nothing: a pool
    // that is too large is trimmed two lines below, one that is too small has
    // silently dropped the caller's answer.
    const threshold = cut === undefined ? Number.NEGATIVE_INFINITY : cut;
    for (let i = 0; i < n; i++) {
        const raw = raws[i];
        if (raw === undefined || raw < threshold) continue;
        const seed = seeds[i];
        pool.push({
            slot: i,
            raw,
            seed: seed === undefined ? 0 : seed,
            relevance: 0,
            novelty: 0,
            score: 0,
            record: null,
        });
    }
    pool.sort((a, b) => b.raw - a.raw || a.seed - b.seed);
    return pool.length > want ? pool.slice(0, want) : pool;
}

/**
 * Fill in each pool member's `novelty`, in place.
 *
 * Grouped by parent, because `noveltyOf` scores members against their siblings
 * and a census taken over one container is not evidence about another — shape.ts
 * drops a census whose pointer does not match, and silently scoring against the
 * wrong schema is worse than scoring without a prior.
 *
 * The census sample is divided across the parents the pool touches rather than
 * spent per parent, so the structural channel's cost is bounded by
 * CENSUS_TOTAL_SAMPLE however the hits are distributed. `censusOf` clamps a
 * request INTO [1, SHAPE_SAMPLE], so asking for a smaller sample is always
 * honoured and asking for a larger one never is.
 */
function applyNovelty(resolver: Resolver, pool: readonly Scored[]): void {
    const groups = new Map<string, Scored[]>();
    for (const c of pool) {
        const rec = c.record;
        if (rec === null) continue;
        const parent = rec.parent;
        if (parent === null) continue;              // the document root has no siblings
        const group = groups.get(parent);
        if (group === undefined) groups.set(parent, [c]);
        else group.push(c);
    }
    if (groups.size === 0) return;
    const share = Math.max(1, Math.floor(CENSUS_TOTAL_SAMPLE / groups.size));

    for (const [parent, group] of groups) {
        // Below this population a rank is a statement the sample cannot support:
        // the top of any population calibrates to 1.0, and a population of two
        // would declare one of the two maximally unusual.
        if (group.length < MIN_NOVELTY_POPULATION) continue;
        let node: StrideNode;
        let census: StrideShape;
        try {
            node = resolver.resolve(parent);
            census = censusOf(resolver, node, { sample: share });
        } catch (e) {
            // No prior and no population means no novelty, not a failed search:
            // the lexical channel carries 0.7 of the score and answers alone.
            if (!(e instanceof StrideError)) throw e;
            continue;
        }
        const members: Member[] = group.map((c, i) => memberOf(c, i));
        const scores = noveltyOf(resolver, node, members, census);
        for (let i = 0; i < group.length; i++) {
            const c = group[i];
            const s = scores[i];
            // `scores` is index-aligned with `members`, so both reads are in
            // range; 0 is "not unusual", the reading that leaves the lexical
            // channel in charge rather than promoting a record on a score that
            // was never computed.
            if (c !== undefined) c.novelty = s === undefined ? 0 : s;
        }
    }
}

/**
 * A pool candidate as a `Member` of its parent.
 *
 * `noveltyOf` reads a member's bytes and its key; the ordinal and the index node
 * id are not consulted, so the honest value for the id is -1 ("not indexed")
 * rather than a number invented to look like one. The key is recovered from the
 * pointer's last reference token, and an array index is NOT a key — passing one
 * as a member name would make every element of an array share a name that
 * nothing in the document holds.
 */
function memberOf(c: Scored, ordinal: number): Member {
    const rec = c.record;
    if (rec === null) return { ordinal, key: null, start: 0, end: 0, kind: 'null', node: -1 };
    const slash = rec.pointer.lastIndexOf('/');
    const token = slash < 0 ? '' : rec.pointer.slice(slash + 1);
    const key = slash < 0 || tokenToIndex(token) >= 0 ? null : unescapeToken(token);
    return { ordinal, key, start: rec.start, end: rec.end, kind: rec.kind, node: -1 };
}

// ── Assembly ──────────────────────────────────────────────────────────────

/**
 * Byte offsets inside a record where a query term literally occurs, ascending.
 *
 * Recomputed for the returned hits only — the phase-1 pass keeps numbers, not
 * offsets, because a query matching a million records would otherwise hold a
 * million small arrays for a page of ten hits (I6).
 */
function offsetsOf(source: StrideSource, terms: readonly QueryTerm[], rec: RecordRef, seed: number): number[] {
    let from = rec.start;
    let to = rec.end;
    if (to - from > RECORD_VERIFY_BYTES) {
        const half = Math.floor(RECORD_VERIFY_BYTES / 2);
        from = Math.max(rec.start, seed - half);
        to = Math.min(rec.end, from + RECORD_VERIFY_BYTES);
    }
    const hay = foldCopy(source.slice(from, to));
    const out: number[] = [];
    for (const t of terms) {
        for (const needle of t.needles) {
            let p = hay.indexOf(needle, 0);
            while (p >= 0) {
                out.push(from + p);
                p = hay.indexOf(needle, p + 1);
            }
        }
    }
    out.sort((a, b) => a - b);
    const unique: number[] = [];
    for (const at of out) {
        if (unique.length >= HIT_OFFSETS_MAX) break;
        if (unique[unique.length - 1] !== at) unique.push(at);
    }
    return unique;
}

/**
 * The query terms a record actually matched, in query order.
 *
 * Read from the byte mask, not from `tf`. `tf` also carries the record's path
 * terms, which are a ranking signal — a record at `/orders/9182` whose bytes
 * hold none of the query would otherwise be reported as having matched `orders`,
 * with no `offsets` to show for it, and types.ts says this field names the terms
 * the record actually matched.
 */
function matchedTerms(terms: readonly QueryTerm[], mask: Uint32Array, base: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < terms.length; i++) {
        const t = terms[i];
        const bits = mask[base + (i >>> 5)];
        // 0 for an unreachable failed read omits the term rather than claiming
        // it, which is the fail direction this field's contract needs.
        if (t !== undefined && bits !== undefined && (bits & (1 << (i & 31))) !== 0) out.push(t.term);
    }
    return out;
}

/**
 * The record as a node the renderer can spend a budget on.
 *
 * Resolved by pointer when possible, because `locate` reports `count: 0` for the
 * nodes it descends through and render.ts trusts a non-negative count. A count
 * of -1 is render.ts's own "ask me later" value, so the fallback stays honest
 * rather than claiming an empty container.
 */
function nodeForRender(resolver: Resolver, rec: RecordRef): StrideNode {
    try {
        return resolver.resolve(rec.pointer);
    } catch (e) {
        if (!(e instanceof StrideError)) throw e;
        return {
            pointer: rec.pointer,
            kind: rec.kind,
            start: rec.start,
            end: rec.end,
            depth: rec.depth,
            parent: rec.parent,
            count: -1,
        };
    }
}

/** The literal next call, phrased as an instruction, at the end of the result. */
function hintFor(
    query: string,
    prepared: PreparedQuery,
    totalMatches: number,
    offset: number,
    returned: number,
    path: 'index' | 'scan',
    needed: number,
    budget: number,
    /** How many of `totalMatches` a rank can address; see RANK_DEPTH_MAX. */
    ranked: number,
): string {
    const searched = prepared.terms.map((t) => t.term);
    const dropNote = prepared.dropped.length === 0
        ? ''
        : ` The words ${JSON.stringify(prepared.dropped.join(' '))} were dropped from the query: they name `
        + `most of any document and cost a full scan without changing the ranking.`;
    const termNote = ` Terms searched: ${JSON.stringify(searched.join(' '))}.`;

    if (totalMatches === 0) {
        const route = path === 'scan'
            ? 'Every block of the document was swept literally, so this is exhaustive, not a shortcut.'
            : 'Every block naming any of these terms was verified, so this is exhaustive, not a shortcut.';
        return `No record matched ${JSON.stringify(query)}.${termNote} ${route}`
            + ` Call mode "shape" on the collection to see which fields and values exist, then search a`
            + ` value it reports.${dropNote}`;
    }
    // Two unrelated failures return nothing, and their recoveries are opposite.
    // An offset past the last rank the query answers is not a budget problem,
    // and telling that caller to raise the budget sends it round the same empty
    // page: measured with 30 matches at offset 30, the old wording named a
    // budget of 0 as the fix.
    if (returned === 0 && offset >= ranked) {
        const last = Math.max(0, ranked - 1);
        const back = address('search', '', last, null, query);
        const window = ranked < totalMatches
            ? `, of which the ${ranked} highest-ranked are addressable by rank`
            : '';
        return `Offset ${offset} is past the last rank this query answers. ${totalMatches} records matched`
            + `${window}, so the last rank is ${last}. Call mode "search" with query ${JSON.stringify(query)}`
            + ` and offset ${last}, or cursor ${JSON.stringify(back.cursor)}. A larger budget does not change`
            + ` this.${termNote}${dropNote}`;
    }
    if (returned === 0) {
        return `${totalMatches} records matched ${JSON.stringify(query)} but a budget of ${budget} characters`
            + ` fits none of them: the highest-ranked hit needs ${needed}. Call mode "search" again with`
            + ` budget ${needed} or more.${termNote}${dropNote}`;
    }
    if (offset + returned < ranked) {
        const next = address('search', '', offset + returned, null, query);
        return `${returned} of ${totalMatches} matching records are in this view, highest score first.`
            + ` Call mode "search" with query ${JSON.stringify(query)} and offset ${offset + returned},`
            + ` or cursor ${JSON.stringify(next.cursor)}, to fetch the next page.${termNote}${dropNote}`;
    }
    // Every rank this query can address has been walked. Offering another page
    // here would name an offset that comes back empty, so when the count runs
    // past the addressable depth the instruction is to narrow the query — the
    // count itself stays exact, and this is where the difference is stated.
    if (ranked < totalMatches) {
        return `The ${ranked} highest-ranked of ${totalMatches} matching records are addressable by rank, and`
            + ` this view holds the last ${returned} of them. The remaining ${totalMatches - ranked} matched and`
            + ` are counted, but ranking past ${ranked} is not answered: add a term to narrow the query, or call`
            + ` mode "map" on the collection to walk the records by position instead.${termNote}${dropNote}`;
    }
    return `All ${totalMatches} matching records are in this view, highest score first. No further call is`
        + ` needed for this query.${termNote}${dropNote}`;
}

/**
 * Search the document for `query` and return the records that matched, ranked,
 * addressed, and inside `opts.budget`.
 *
 * Every candidate block is visited and every record that holds a query term is
 * counted, so `totalMatches` is a true count over the whole document rather than
 * a count of what an index happened to retain (I7). What the budget bounds is
 * how many of those records are SHOWN — `truncated` says when it did, and the
 * hint names the call that fetches the rest.
 *
 * Throws `StrideError('empty_query')` when the query has nothing searchable in
 * it, naming the recovery. Nothing else in this function throws on a query it
 * can partly answer: a reduced response measured +8 to +38% better than an
 * excluded one across 15 models, so a budget too small for one hit still returns
 * the true count, the route taken, and the budget that would work.
 */
export function search(
    resolver: Resolver,
    blocks: BlockIndex,
    query: string,
    opts: StrideSearchOptions,
): StrideSearchResult {
    const source = resolver.source;
    const budget = Number.isFinite(opts.budget)
        ? Math.max(MIN_RESULT_CHARS, Math.floor(opts.budget))
        : MIN_RESULT_CHARS;
    const limit = opts.limit === undefined || !Number.isFinite(opts.limit)
        ? DEFAULT_SEARCH_LIMIT
        : Math.max(0, Math.floor(opts.limit));
    const offset = opts.offset === undefined || !Number.isFinite(opts.offset)
        ? 0
        : Math.max(0, Math.floor(opts.offset));

    // One sweep per dictionary-missing term, shared between the `df` it needs and
    // the candidate blocks it names. Discarded with the query.
    const sweeps = new Map<string, Uint32Array>();
    const prepared = prepareQuery(query, blocks, source, sweeps);
    const cand = candidateBlocks(blocks, source, prepared.terms, sweeps);
    const path: 'index' | 'scan' = cand.swept ? 'scan' : 'index';
    const matches = cand.count === 0 ? noMatches() : collectMatches(resolver, blocks, prepared, cand);
    const n = matches.n;

    // avgdl is measured over the records that matched, and it is the one
    // statistic here that is not document-wide, because a document-wide record
    // count does not exist without a second full pass. It is a single per-query
    // constant entering only through `dl / avgdl`; `df`, which is the statistic
    // whose localisation measured a 1.6x score distortion, is global.
    let dlSum = 0;
    for (let i = 0; i < n; i++) {
        const dl = matches.dl[i];
        if (dl !== undefined) dlSum += dl;
    }
    const avgdl = n > 0 ? dlSum / n : 1;

    const raws = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const dl = matches.dl[i];
        raws[i] = lexicalScore(
            prepared.terms,
            matches.tf,
            i * prepared.m,
            dl === undefined ? avgdl : dl,
            avgdl,
            prepared.m,
        );
    }
    const sorted = raws.slice().sort();

    // The order a page slices MUST NOT depend on the offset that asked for it,
    // or two pages disagree and the walk both repeats and skips records (I7).
    // `poolOf(k)` is the first k of one global order — lexical score
    // descending, ties by document position — so `head` is always the same 256
    // records and `ordered`'s first 256 are the same 256 in the same order.
    const head = poolOf(raws, sorted, n, matches.seed, NOVELTY_POOL_CAP);
    const depth = Math.min(n, RANK_DEPTH_MAX);
    const ordered = depth > head.length
        ? poolOf(raws, sorted, n, matches.seed, depth)
        : head;

    for (const c of head) {
        c.record = recordFor(resolver, resolver.locate(c.seed));
        c.relevance = percentileOf(sorted, n, c.raw);
    }
    applyNovelty(resolver, head);
    for (const c of head) {
        c.score = LEXICAL_WEIGHT * c.relevance + (1 - LEXICAL_WEIGHT) * c.novelty;
    }
    // Deterministic to the last key: score, then the lexical channel that
    // carries most of it, then document order.
    head.sort((a, b) => b.score - a.score || b.relevance - a.relevance || a.seed - b.seed);

    if (ordered !== head) {
        // The fused head replaces the lexical prefix it was selected from —
        // same records, reordered. Below it the novelty channel does not run,
        // so `novelty` stays 0 and the score is the lexical channel alone. That
        // cannot invert the boundary: relevance is a percentile of the same raw
        // score the selection ranked by, so every head member's relevance is at
        // least every tail member's, and 0.7 * r + 0.3 * nov >= 0.7 * r'.
        for (let i = 0; i < head.length; i++) {
            const c = head[i];
            if (c !== undefined) ordered[i] = c;
        }
        for (let i = head.length; i < ordered.length; i++) {
            const c = ordered[i];
            if (c === undefined) continue;
            c.relevance = percentileOf(sorted, n, c.raw);
            c.score = LEXICAL_WEIGHT * c.relevance;
        }
    }

    const page = ordered.slice(Math.min(offset, ordered.length));
    // `cut` is clamped to `limit` by `knee`, so only the first `limit` entries
    // of the page can be emitted and only those need a record resolved. The
    // head already has its records — `applyNovelty` groups hits by parent.
    for (let i = 0; i < Math.min(limit, page.length); i++) {
        const c = page[i];
        if (c !== undefined && c.record === null) c.record = recordFor(resolver, resolver.locate(c.seed));
    }
    // The knee is applied to a BOUNDED candidate list, which is the shape its
    // weighted-gap branch is the right detector for; shape.knee picks the branch
    // from the input itself. It is not consulted when every match already fits
    // in the page, because there is no tail to cut there and withholding a match
    // the caller asked for and the budget can afford is a loss they cannot see.
    const cut = page.length <= limit
        ? page.length
        : knee(page.map((c) => c.score), limit);

    const hits: StrideHit[] = [];
    const allot = payloadAllot(budget);
    const words = maskWords(prepared.m);
    let spent = MIN_RESULT_CHARS;
    let needed = 0;
    for (let i = 0; i < cut; i++) {
        const c = page[i];
        if (c === undefined) continue;
        const rec = c.record;
        if (rec === null) continue;
        const offsets = offsetsOf(source, prepared.terms, rec, c.seed);
        const matched = matchedTerms(prepared.terms, matches.mask, c.slot * words);
        const skeleton: StrideHit = {
            rank: offset + i + 1,
            pointer: rec.pointer,
            span: [rec.start, rec.end],
            score: round(c.score),
            relevance: round(c.relevance),
            novelty: round(c.novelty),
            matched,
            offsets,
            cursor: address('read', rec.pointer, 0).cursor,
            windowCursor: address('window', rec.pointer, 0, null, query).cursor,
            preview: null,
        };
        // The floor is measured, not assumed: the hit's own metadata is
        // serialised and the preview gets what is left of this hit's share.
        const fixed = estimateChars(skeleton) + 1;
        if (needed === 0) needed = budgetFor(fixed);
        // What is LEFT, divided across the hits still to come — the same rule
        // render.ts spends a container's budget by, and for the same reason: a
        // slice that fits in a tenth of its share funds the next one rather than
        // wasting the difference. The floor under the share is what stops the
        // division starving every hit at once: a hit's metadata costs a couple of
        // hundred characters whatever the budget, so an equal 1/cut share of a
        // small budget is smaller than one hit's fixed cost and NO hit is emitted
        // — an empty result where a reduced one was possible, which is the one
        // outcome this function's contract rules out.
        const remaining = allot - spent;
        const share = Math.floor(remaining / Math.max(1, cut - i));
        const room = Math.min(remaining, Math.max(share, fixed + MIN_VIEW_BUDGET)) - fixed;
        if (room < MIN_VIEW_BUDGET) break;
        const view = renderNode(resolver, nodeForRender(resolver, rec), { budget: room, focus: offsets });
        const hit: StrideHit = { ...skeleton, preview: view.data };
        const cost = estimateChars(hit) + 1;
        if (spent + cost > allot) break;
        spent += cost;
        hits.push(hit);
    }

    const chars = estimateChars(hits);
    return {
        query,
        hits,
        totalMatches: n,
        returned: hits.length,
        path,
        truncated: offset + hits.length < n,
        chars,
        budget,
        hint: hintFor(query, prepared, n, offset, hits.length, path, needed, budget, ordered.length),
    };
}

/**
 * The share of the budget the hits may spend. ENVELOPE_RESERVE is held back for
 * the query, the totals and the hint, which cost real characters — the same
 * reserve render.ts holds back for its own envelope.
 */
function payloadAllot(budget: number): number {
    return budget - Math.ceil(budget * ENVELOPE_RESERVE);
}

/**
 * The smallest budget that fits one hit whose own metadata costs `fixed`
 * characters: its payload share must still cover MIN_RESULT_CHARS, that
 * metadata, and one minimal view.
 *
 * Solved rather than approximated, and the difference is the whole point of the
 * number: it is a recovery instruction, and a hint naming a budget that comes
 * back empty a second time is worse than a hint naming none. The closed form
 * inverts `payloadAllot` and the loop absorbs its ceiling, which cannot run more
 * than a couple of steps because `payloadAllot` is non-decreasing in `budget`.
 */
function budgetFor(fixed: number): number {
    const need = MIN_RESULT_CHARS + fixed + MIN_VIEW_BUDGET;
    let b = Math.max(MIN_RESULT_CHARS, Math.ceil(need / (1 - ENVELOPE_RESERVE)));
    while (payloadAllot(b) - MIN_RESULT_CHARS < fixed + MIN_VIEW_BUDGET) b += 1;
    return b;
}

/**
 * Scores are reported to three decimals. A score is a rank calibration, so
 * digits past the third describe the population's size rather than the record,
 * and they cost budget on every hit.
 */
function round(v: number): number {
    return Math.round(v * 1000) / 1000;
}
