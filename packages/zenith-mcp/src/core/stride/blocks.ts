// ---------------------------------------------------------------------------
// core/stride/blocks.ts — the full-recall block index
//
// The document is cut into fixed SEARCH_BLOCK_BYTES blocks and the index
// records, for each term, WHICH BLOCKS contain it. Not offsets, not records —
// blocks. A 600 MB document is ~9,600 blocks, so a posting list is a handful of
// 32-bit integers however many times the term occurs. Search then reads at most
// one 64 KiB block per candidate to turn a posting back into exact positions.
//
// ── INVARIANT I7, and the one thing this file must not get wrong ────────────
//
// `candidates()` returns EVERY block naming any query term. It does not rank
// them, cap them, sample them or return a "top N", and there is no parameter
// through which a caller could ask it to. Truncating the candidate set is the
// single largest silent-recall failure in this class of index — measured at
// 8-24% of exhaustive result mass lost (visiting 1% of clusters recovers
// 0.76-0.83 of the exhaustive score, 5% recovers 0.83-0.91, 10% recovers
// 0.85-0.92) — and it is silent precisely because the results that come back
// still look plausible. So the API does not offer it.
//
// Two measures bound memory, and NEITHER is allowed to cost recall:
//
//   TERM_DICT_LIMIT stops NEW terms being admitted once the dictionary is full.
//   A term in more than max(64, blockCount/4) blocks keeps its exact df but
//   loses its posting list, because a term that names a quarter of the document
//   cannot discriminate between blocks and its postings are pure cost.
//
// In both cases the term comes back in `missing` from `candidates()`, and THIS
// IS THE CRUX OF I7: a missing term is not a term the index has given up on, it
// is a term the caller must resolve by an exhaustive literal byte scan —
// `scanTermBlocks` — whose hit blocks are unioned into the candidate set before
// verification. Recall is preserved by the fallback actually running, never by
// the index pretending it had the answer. An index that answered `missing` with
// silence would be wrong in exactly the way this design exists to prevent.
//
// ── What the index actually costs, measured ─────────────────────────────────
//
// `stats.bytes` tracks TERM CARDINALITY, not document size, and the spread is
// three orders of magnitude wide. Measured on node 22, both documents 40.0 MiB:
//
//   repetitive log records, 71 distinct terms
//     postings 695 x 4 B, dictionary 4.2 KB, stats.bytes 10,142  =  0.024%
//   order records with a unique id, sku and timestamp each
//     postings 751,320 x 4 B = 2.87 MiB (7.2%), dictionary 11.9 MiB (29.8%),
//     stats.bytes 17,090,980  =  40.7%, saturated, 1,048 terms dropped
//
// The two halves scale differently and both are bounded. The dictionary is
// bounded in ABSOLUTE terms by TERM_DICT_LIMIT — ~13.5 MiB at saturation with
// the offset and df tables, whatever the document size — so it is 30% of 40 MB
// and 2.2% of 600 MB. The postings are bounded per BLOCK: a block holds at most
// SEARCH_BLOCK_BYTES of text, so it can name only so many distinct terms, and
// the high-cardinality document above measured 1,172 postings per block, i.e.
// 4.7 KB of postings per 64 KiB block = 7.2% of the document however large it
// grows. So the honest figure for a 600 MB high-cardinality document is ~9%
// (postings linear at 7.2% plus the fixed dictionary), and for a repetitive one
// a small fraction of a percent. `stats.bytes` reports whichever it is, and a
// mid-size high-cardinality document is the worst case for the ratio because
// the fixed dictionary has nothing to amortise against.
//
// ── What the literal-scan fallback actually costs, measured ─────────────────
//
// `Buffer.indexOf` is a SIMD memmem in C++, and the research this design was
// built against explicitly notes that no verified 2025+ measurement of its
// throughput exists. Measured here on node 22, `scanTermBlocks` over a 40.0 MiB
// resident buffer, median of 7 after warm-up:
//
//   sku-99999                (letter-free run `-99999`)   5.17 GB/s
//   550e8400-...-446655440000 (letter-free run, 16 B)     3.77 GB/s
//   zqxjvomegatail           (letters, anchor z/Z: 312,953)  3.23 GB/s
//   192.168.1.1              (letter-free, whole needle)  2.83 GB/s
//   2024-05-15t10:30:05z     (letter-free run)            2.49 GB/s
//   error                    (letters, anchor r: 719,813) 1.59 GB/s
//   warehouse                (letters, anchor w: 312,953) 1.28 GB/s
//   shipment                 (letters, anchor p: 688,537) 0.69 GB/s
//
// A needle holding any byte that is not an ASCII letter has a case-invariant
// substring and is matched by memmem directly: 2.5-5.2 GB/s. An all-letters
// needle has none, so it costs one memchr pass per case plus one verify per
// anchor-byte occurrence, and the 0.69-3.23 GB/s spread tracks that occurrence
// count almost exactly — which is what the LETTER_RARITY table below is for.
// For reference on the same buffer, a bare `Buffer.indexOf` loop runs at
// 7.68 GB/s for a sparse 14-byte needle with one hit and 0.63 GB/s for
// `warehouse` with 312,953 hits, so the anchor-plus-verify sweep is FASTER than
// restarting memmem at every match. The slowest shape measured is 3.4x the
// ~200 MB/s the research gives as the pure-JS byte-scanning planning number for
// this runtime, so a 600 MB fallback sweep costs 0.12-0.87 s — an honest answer
// rather than a shrug. What is NOT affordable is folding the haystack: the same
// research measures naive fold-then-scan at 100-300 MB/s, so the needle is
// folded once and the haystack is never touched.
//
// Build is the expensive pass, not search: 13.1 MiB/s on the high-cardinality
// 40 MiB document (3.06 s, 8.44 M tokens) and 40.9 MiB/s on the repetitive one,
// dominated by one JS string plus one Map probe per token. A 600 MB build is
// therefore tens of seconds and belongs behind a cache, which is what the
// document-level index above it provides.
// ---------------------------------------------------------------------------

import { SEARCH_BLOCK_BYTES, TERM_DICT_LIMIT } from './types.js';
import type { StrideSource } from './source.js';
import { tokenizeBytes, TOKEN_MAX_BYTES } from './terms.js';

/**
 * Bytes of the previous block re-tokenised at the head of the next one, so a
 * term cut in half by a block boundary is still emitted WHOLE by one of them.
 *
 * Twice the token cap is exactly enough, and the proof matters more than the
 * number: let an atom start at `s` before boundary `B`. If `B - s >= 128` the
 * earlier block already emitted the whole capped term. Otherwise `s > B - 128`,
 * so the window `[B - 256, ...)` contains the atom from its true first byte and
 * the later block emits the whole capped term. No term of the document-wide
 * tokenisation can fall between the two.
 *
 * Note what that proof does and does not say. It does NOT say a straddling term
 * is posted to both blocks — in the second case the earlier block saw only a
 * truncated prefix and posts that prefix instead. It says every occurrence of
 * every term lies ENTIRELY INSIDE the re-tokenised window of at least one block
 * that names it, which is the property a verify pass needs; `blockScanRange`
 * hands that window back.
 */
const OVERLAP_BYTES = 2 * TOKEN_MAX_BYTES;

/**
 * Fixed heap cost of one dictionary entry, excluding the characters.
 * Measured on node 22 with 200,000 distinct Buffer-derived latin1 keys: a Map
 * entry is a flat 28.7 B (three compressed slots plus bucket table and capacity
 * overshoot) and a flat string header is ~24 B, giving 61.0 B/entry at 6
 * characters, 68.8 B at 12, 76.8 B at 21 and 92.8 B at 36 — a fixed 53-57 B
 * once the characters are subtracted. Characters are charged separately because
 * a term outside latin1 is stored two bytes per character, and because V8
 * rounds the character block to 8 bytes, which is why the fixed part measures
 * as a range rather than a single number.
 */
const DICT_ENTRY_BYTES = 56;

/** Heap cost of a term's characters: two bytes each once it leaves latin1. */
function stringBytes(term: string): number {
    for (let i = 0; i < term.length; i++) {
        if (term.charCodeAt(i) > 0xff) return term.length * 2;
    }
    return term.length;
}

/**
 * Double a build-time array until it holds `need` entries.
 *
 * The parameter and return are `Uint32Array<ArrayBuffer>` rather than a bare
 * `Uint32Array` because every array this module grows was allocated here with
 * `new Uint32Array(n)` and is therefore backed by a private, non-shared
 * `ArrayBuffer`. Bare `Uint32Array` widens to `ArrayBufferLike`, which claims
 * the buffer might be a `SharedArrayBuffer` — a claim that is not true of any
 * of this module's storage and that the assignment back to the caller's own
 * `let` then correctly rejects.
 */
function growU32(a: Uint32Array<ArrayBuffer>, need: number): Uint32Array<ArrayBuffer> {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 1024 : a.length;
    while (n < need) n *= 2;
    const out = new Uint32Array(n);
    out.set(a);
    return out;
}

/** What the build cost and what it had to give up to stay bounded. */
export interface BlockIndexStats {
    /** Distinct terms in the dictionary. */
    readonly terms: number;
    /** Retained (term, block) postings. Dropped terms contribute none. */
    readonly postings: number;
    /** Finalised heap footprint: typed arrays plus the term dictionary. */
    readonly bytes: number;
    readonly buildMs: number;
    /** True once TERM_DICT_LIMIT was reached and new terms stopped being admitted. */
    readonly saturated: boolean;
    /** Terms whose posting list was dropped for being too common to discriminate. */
    readonly droppedTerms: number;
}

/** The union of candidate blocks, and the terms the caller must scan for. */
export interface BlockCandidates {
    /** Every block naming any indexed query term, ascending. Never truncated. */
    readonly blocks: Uint32Array;
    /**
     * Query terms with no posting list — unknown, or too common to keep one.
     * The caller resolves each with `scanTermBlocks` and unions the result into
     * `blocks`. Skipping this step is what breaks I7.
     */
    readonly missing: string[];
}

/**
 * Term -> block postings for one document, built in a single sequential pass.
 *
 * Postings are held as one flat `Uint32Array` of block ids plus a per-term
 * offset table, not as a Map of JavaScript arrays: 200,000 small arrays cost
 * more in object headers than the block ids they hold.
 */
export class BlockIndex {
    /** Blocks the document divides into. The last one is usually short. */
    readonly blockCount: number;
    /** Tokens emitted across every block, overlap windows included. */
    readonly totalTokens: number;
    readonly stats: BlockIndexStats;

    private readonly dict: Map<string, number>;
    private readonly dfArr: Uint32Array<ArrayBuffer>;
    /** Postings for term `t` are `postBlocks[postOff[t] .. postOff[t+1])`. */
    private readonly postOff: Uint32Array<ArrayBuffer>;
    private readonly postBlocks: Uint32Array<ArrayBuffer>;
    private readonly blockTok: Uint32Array<ArrayBuffer>;
    private readonly size: number;

    private constructor(
        size: number,
        blockCount: number,
        totalTokens: number,
        dict: Map<string, number>,
        dfArr: Uint32Array<ArrayBuffer>,
        postOff: Uint32Array<ArrayBuffer>,
        postBlocks: Uint32Array<ArrayBuffer>,
        blockTok: Uint32Array<ArrayBuffer>,
        stats: BlockIndexStats,
    ) {
        this.size = size;
        this.blockCount = blockCount;
        this.totalTokens = totalTokens;
        this.dict = dict;
        this.dfArr = dfArr;
        this.postOff = postOff;
        this.postBlocks = postBlocks;
        this.blockTok = blockTok;
        this.stats = stats;
    }

    /**
     * Build the index in one sequential pass over the document.
     *
     * Bytes are staged a block at a time behind an overlap window rather than
     * tokenised straight out of the source's chunks, because the source hands
     * out chunks of whatever size suits it and a term must never fall into the
     * seam between two of them. The staging copy is one memcpy of the document
     * — a few percent of a build that is dominated by term hashing.
     */
    static build(source: StrideSource): BlockIndex {
        const t0 = Date.now();
        const size = source.size;
        const blockCount = size === 0 ? 0 : Math.ceil(size / SEARCH_BLOCK_BYTES);
        // A term in more than a quarter of the blocks selects most of the
        // document and discriminates nothing; below 64 blocks the fraction is
        // too small to be meaningful, so the floor keeps small documents fully
        // indexed.
        const dropAbove = Math.max(64, Math.floor(blockCount / 4));

        const dict = new Map<string, number>();
        let dfArr = new Uint32Array(1024);
        let termCount = 0;
        let dictBytes = 0;
        let saturated = false;

        // (term, block) pairs in block order. Finalised by counting sort, which
        // leaves every term's postings ascending because they were appended
        // ascending.
        let pairTerm = new Uint32Array(1 << 16);
        let pairBlock = new Uint32Array(1 << 16);
        let pairCount = 0;

        const blockTok = new Uint32Array(blockCount);
        let totalTokens = 0;

        const stage = Buffer.allocUnsafe(OVERLAP_BYTES + SEARCH_BLOCK_BYTES);
        let filled = 0;
        let carry = 0;
        let blockId = 0;
        const terms: string[] = [];
        const seen = new Set<string>();

        const flush = (): void => {
            terms.length = 0;
            tokenizeBytes(stage, OVERLAP_BYTES - carry, OVERLAP_BYTES + filled, terms);
            seen.clear();
            for (const term of terms) {
                if (seen.has(term)) continue;
                seen.add(term);
                let id = dict.get(term);
                if (id === undefined) {
                    if (dict.size >= TERM_DICT_LIMIT) { saturated = true; continue; }
                    id = termCount;
                    termCount += 1;
                    dfArr = growU32(dfArr, termCount);
                    dict.set(term, id);
                    dictBytes += DICT_ENTRY_BYTES + stringBytes(term);
                }
                // `id` is either the slot just grown for or one handed back by
                // `dict`, so it is always < termCount <= dfArr.length. A fresh
                // Uint32Array slot reads 0 and 0 is this term's block count
                // before this block, so the unreachable branch carries the same
                // value the reachable one does and cannot deflate a df.
                const prior = dfArr[id];
                const df = (prior === undefined ? 0 : prior) + 1;
                dfArr[id] = df;
                // Stop staging postings the moment the term passes the drop
                // threshold: the df stays exact, and the pairs already staged
                // are skipped at finalise rather than written out.
                if (df <= dropAbove) {
                    if (pairCount === pairTerm.length) {
                        pairTerm = growU32(pairTerm, pairCount + 1);
                        pairBlock = growU32(pairBlock, pairCount + 1);
                    }
                    pairTerm[pairCount] = id;
                    pairBlock[pairCount] = blockId;
                    pairCount += 1;
                }
            }
            if (blockId < blockTok.length) blockTok[blockId] = terms.length;
            totalTokens += terms.length;
            // Carry this block's tail forward as the next block's overlap.
            const tail = filled < OVERLAP_BYTES ? filled : OVERLAP_BYTES;
            stage.copy(stage, OVERLAP_BYTES - tail, OVERLAP_BYTES + filled - tail, OVERLAP_BYTES + filled);
            carry = tail;
            filled = 0;
            blockId += 1;
        };

        source.sequential(0, size, (chunk) => {
            let p = 0;
            const n = chunk.length;
            while (p < n) {
                let want = SEARCH_BLOCK_BYTES - filled;
                if (want > n - p) want = n - p;
                chunk.copy(stage, OVERLAP_BYTES + filled, p, p + want);
                filled += want;
                p += want;
                if (filled === SEARCH_BLOCK_BYTES) flush();
            }
        });
        if (filled > 0) flush();

        // Finalise into flat arrays. A term over the threshold keeps its df and
        // gets a zero-length posting range, which is what puts it in `missing`.
        const postOff = new Uint32Array(termCount + 1);
        let droppedTerms = 0;
        let run = 0;
        for (let t = 0; t < termCount; t++) {
            postOff[t] = run;
            // `t < termCount <= dfArr.length`, so the undefined branch is
            // unreachable; it is grouped with "over the threshold" because that
            // gives the term an empty posting range and routes it to `missing`
            // and the exhaustive scan, where a df read that went wrong cannot
            // cost an answer. Grouping it with "keep" would reserve a range the
            // fill loop below then refuses to fill.
            const df = dfArr[t];
            if (df === undefined || df > dropAbove) droppedTerms += 1;
            else run += df;
        }
        postOff[termCount] = run;

        const postBlocks = new Uint32Array(run);
        const cursor = postOff.slice(0, termCount);
        for (let i = 0; i < pairCount; i++) {
            // Every index here is inside its array by construction:
            // `i < pairCount <= pairTerm.length === pairBlock.length`, and a
            // staged term id is < termCount === cursor.length === dfArr.length.
            // Each undefined branch is therefore unreachable, and skipping the
            // posting is the safe way to be wrong: a candidate block that never
            // gets written is still reachable through `scanTermBlocks`, while a
            // `?? 0` here would write this block id into term 0's posting list
            // and invent a candidate that nothing can retract.
            const t = pairTerm[i];
            const b = pairBlock[i];
            if (t === undefined || b === undefined) continue;
            const df = dfArr[t];
            if (df === undefined || df > dropAbove) continue;
            const c = cursor[t];
            if (c === undefined) continue;
            postBlocks[c] = b;
            cursor[t] = c + 1;
        }

        // Release the staging arrays and hand back exactly what is retained.
        const dfFinal = dfArr.length === termCount ? dfArr : dfArr.slice(0, termCount);
        const stats: BlockIndexStats = {
            terms: termCount,
            postings: run,
            bytes: postBlocks.byteLength + postOff.byteLength + dfFinal.byteLength
                + blockTok.byteLength + dictBytes,
            buildMs: Date.now() - t0,
            saturated,
            droppedTerms,
        };
        return new BlockIndex(size, blockCount, totalTokens, dict, dfFinal, postOff, postBlocks, blockTok, stats);
    }

    /**
     * Every block naming any of `terms`, ascending, together with the terms the
     * index cannot answer for.
     *
     * The result is the complete union — no ranking, no cap, no sampling. A
     * caller that wants fewer blocks to verify must earn that by intersecting
     * or by verifying, never by taking a prefix of this list.
     *
     * Verify each returned block over `blockScanRange(b)`, not `blockRange(b)`:
     * a term is posted to the block whose re-tokenised window holds all of it,
     * which for a boundary-straddling term is the window and not the block.
     */
    candidates(terms: readonly string[]): BlockCandidates {
        const missing: string[] = [];
        // One byte per block is the cheapest correct union: block ids are dense
        // and few by construction (~9,600 for 600 MB), so this is a ~10 KB
        // scratch array, not a set of hashes.
        const mark = new Uint8Array(this.blockCount);
        let found = 0;
        for (const term of terms) {
            const id = this.dict.get(term);
            // `postOff` holds termCount+1 entries and a dictionary id is
            // < termCount, so both reads are in range. Reading them together
            // and failing to `missing` means that if either ever did come back
            // undefined the term is answered by the exhaustive literal scan
            // instead of by a posting range built from a fallback offset.
            const from = id === undefined ? undefined : this.postOff[id];
            const to = id === undefined ? undefined : this.postOff[id + 1];
            if (from === undefined || to === undefined || to <= from) {
                if (!missing.includes(term)) missing.push(term);
                continue;
            }
            for (let i = from; i < to; i++) {
                const b = this.postBlocks[i];
                if (b !== undefined && b < mark.length && mark[b] === 0) { mark[b] = 1; found += 1; }
            }
        }
        const blocks = new Uint32Array(found);
        let k = 0;
        for (let b = 0; b < mark.length; b++) {
            if (mark[b] === 1) { blocks[k] = b; k += 1; }
        }
        return { blocks, missing };
    }

    /**
     * Blocks containing `term` — the GLOBAL document frequency the ranker
     * scores with, exact even for a term whose posting list was dropped.
     *
     * Scoring must never use a block-local statistic: idf computed over the
     * candidate blocks alone rewards a term for being rare *among the blocks it
     * was found in*, which is a tautology, and it reorders results depending on
     * which other terms shared the query. Measured, block-local idf put two
     * documents with identical term frequencies 1.6x apart in score purely by
     * block membership.
     */
    df(term: string): number {
        const id = this.dict.get(term);
        if (id === undefined) return 0;
        // 0 is the answer this method already gives for a term the dictionary
        // does not hold, so an unreachable failed read reports "unknown term"
        // rather than a frequency that was never counted.
        const d = this.dfArr[id];
        return d === undefined ? 0 : d;
    }

    /**
     * True when the index can answer for `term` from postings alone.
     *
     * A term with an exact `df` but a dropped posting list returns false, on
     * purpose: `has(t) === false` is exactly the set of terms `candidates()`
     * reports as missing and the caller must scan for.
     */
    has(term: string): boolean {
        const id = this.dict.get(term);
        if (id === undefined) return false;
        const from = this.postOff[id];
        const to = this.postOff[id + 1];
        // Same in-range argument as `candidates`, and the same fail direction:
        // "the index cannot answer" routes the term to the exhaustive scan,
        // which is always correct, only slower.
        if (from === undefined || to === undefined) return false;
        return to > from;
    }

    /**
     * Tokens attributed to one block, its overlap window included — the length
     * a length-normalising ranker needs. A term straddling a boundary is
     * counted in both blocks, because both blocks tokenised the bytes it
     * occupies even though only one of them emitted it whole.
     */
    blockTokens(id: number): number {
        if (id < 0 || id >= this.blockCount) return 0;
        // `blockTok` was allocated with exactly blockCount entries, so the
        // bounds check above already proves this read is in range; 0 is the
        // same answer the out-of-range branch gives.
        const n = this.blockTok[id];
        return n === undefined ? 0 : n;
    }

    /** Half-open byte span of a block, or an empty span when `id` is not one. */
    blockRange(id: number): [number, number] {
        if (id < 0 || id >= this.blockCount) return [0, 0];
        const start = id * SEARCH_BLOCK_BYTES;
        const end = start + SEARCH_BLOCK_BYTES;
        return [start, end > this.size ? this.size : end];
    }

    /**
     * The span a verify pass must read to find every occurrence of every term
     * posted to block `id`: the block plus the OVERLAP_BYTES re-tokenised in
     * front of it.
     *
     * This is wider than `blockRange` on purpose, and the extra 256 bytes are
     * exactly where a boundary-straddling term lives. Such a term is emitted
     * whole by the LATER block only — the earlier one saw a truncated prefix
     * and posted that instead — and its first byte is at most TOKEN_MAX_BYTES
     * before the boundary, so it sits inside this span and outside
     * `blockRange(id)`. A verify pass reading `blockRange` would find the tail
     * of the term, score it as no match, and lose the hit silently, which is
     * the failure I7 exists to prevent. The cost is that adjacent candidate
     * blocks overlap by 256 bytes, so a caller unioning spans should dedupe
     * hits by offset.
     */
    blockScanRange(id: number): [number, number] {
        if (id < 0 || id >= this.blockCount) return [0, 0];
        const start = id * SEARCH_BLOCK_BYTES;
        const end = start + SEARCH_BLOCK_BYTES;
        const from = start - OVERLAP_BYTES;
        return [from < 0 ? 0 : from, end > this.size ? this.size : end];
    }
}

/**
 * ASCII-only lowercase, as a copy. Folding the rest would change bytes the
 * document has not, and the haystack is never folded at all: the research this
 * design follows measures naive fold-then-scan at 100-300 MB/s against memmem's
 * multiple GB/s, so normalisation belongs on the needle and at index time.
 */
function foldAscii(buf: Buffer): Buffer {
    const out = Buffer.from(buf);
    for (let i = 0; i < out.length; i++) {
        // An unreachable undefined read leaves the byte exactly as the caller
        // supplied it, which still matches an unfolded haystack byte; a `?? 0`
        // would replace a needle byte with NUL and make the needle unfindable.
        const b = out[i];
        if (b !== undefined && b >= 0x41 && b <= 0x5a) out[i] = b + 0x20;
    }
    return out;
}

/**
 * ASCII letters ordered most to least frequent in English text, rarest last.
 * Used only when a needle is all letters and there is no case-free byte to
 * anchor on, because the anchor byte alone decides how many times the verify
 * loop runs. Measured over the same 40.0 MiB document, all-letters needles span
 * 3.23 GB/s when the anchored byte occurs 312,953 times down to 0.69 GB/s when
 * it occurs 688,537 — a 4.7x spread from the choice of letter and nothing else.
 * On that document `warehouse` anchors on `w` (312,953 occurrences) rather than
 * on its `e` (1,658,822), which is a 5.3x reduction in verify calls.
 */
const LETTER_RARITY = 'etaoinsrhldcumfpgwybvkxjqz';

/**
 * Every block containing the literal `term`, ascending — the exhaustive
 * fallback that makes a missing posting list harmless (I7).
 *
 * Case-insensitive on the ASCII range and substring-exact: it will name blocks
 * where the term occurs inside a longer word, which only ever ADDS candidates
 * for the verify pass to reject. Missing one would be the failure that matters.
 * Every block an occurrence touches is named, so a caller that merges adjacent
 * candidate ranges before verifying always has the occurrence's bytes in full,
 * however long the needle.
 *
 * The sweep is driven by `Buffer.indexOf`, which is a SIMD memmem in C++ rather
 * than a JavaScript loop. It anchors on the longest run of the needle that
 * contains no ASCII letter — `716-446655440000` inside a UUID, the whole of
 * `192.168.1.1` — because such a run has no case variants and can be matched
 * exactly, which is what buys the 9-11 GB/s measured at the top of this file.
 * Only an all-letters needle falls back to a two-case single-byte search.
 */
export function scanTermBlocks(source: StrideSource, term: string): Uint32Array {
    const size = source.size;
    const blockCount = size === 0 ? 0 : Math.ceil(size / SEARCH_BLOCK_BYTES);
    const needle = foldAscii(Buffer.from(term, 'utf8'));
    const n = needle.length;
    if (blockCount === 0 || n === 0 || n > size) return new Uint32Array(0);

    // Longest letter-free run: the best anchor, because it is case-invariant.
    let bestStart = 0;
    let bestLen = 0;
    let curStart = 0;
    let curLen = 0;
    for (let i = 0; i < n; i++) {
        const b = needle[i];
        // `i < n === needle.length`, so undefined is unreachable; treating it
        // as a letter only ends the current run, which can cost a slower anchor
        // but never a wrong one.
        if (b === undefined || (b >= 0x61 && b <= 0x7a)) { curLen = 0; continue; }
        if (curLen === 0) curStart = i;
        curLen += 1;
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    }
    let anchorAt = bestStart;
    const anchorRun: Buffer | null = bestLen >= 2 ? needle.subarray(bestStart, bestStart + bestLen) : null;
    if (bestLen === 0) {
        // Every byte is a lowercase letter: anchor on the rarest and search
        // both cases.
        let bestRank = -1;
        for (let i = 0; i < n; i++) {
            const b = needle[i];
            if (b === undefined) continue;
            const rank = LETTER_RARITY.indexOf(String.fromCharCode(b));
            if (rank > bestRank) { bestRank = rank; anchorAt = i; }
        }
    }
    const at = needle[anchorAt];
    const anchorLo = at === undefined ? 0 : at;
    const anchorUp = anchorLo >= 0x61 && anchorLo <= 0x7a ? anchorLo - 0x20 : anchorLo;

    const mark = new Uint8Array(blockCount);
    let found = 0;
    const hit = (start: number): void => {
        // A term straddling a boundary lives in both blocks; naming only the
        // first would send the verify pass to a block holding half of it.
        const last = Math.floor((start + n - 1) / SEARCH_BLOCK_BYTES);
        for (let b = Math.floor(start / SEARCH_BLOCK_BYTES); b <= last && b < blockCount; b++) {
            if (mark[b] === 0) { mark[b] = 1; found += 1; }
        }
    };

    const matchAt = (hay: Buffer, at2: number): boolean => {
        for (let i = 0; i < n; i++) {
            const h = hay[at2 + i];
            const want = needle[i];
            // The caller has already proved `at2 + n <= hay.length`, so both
            // reads are in range. An unreachable undefined is treated as a
            // MISMATCH rather than a match: a candidate the caller can still
            // reach another way is recoverable, a hit reported at an offset
            // that does not hold one is not.
            if (h === undefined || want === undefined) return false;
            if ((h >= 0x41 && h <= 0x5a ? h + 0x20 : h) !== want) return false;
        }
        return true;
    };

    /**
     * One cursor per case, each advancing strictly forward, so each case costs
     * a single left-to-right pass over the haystack however many times its
     * anchor byte occurs.
     *
     * Re-searching from the same offset for the case that did NOT match is
     * quadratic instead, and catastrophically so: measured at 20.3 s over a
     * 4 MiB buffer (0.21 MB/s) for the needle `error` in a haystack holding
     * 361,580 lowercase `r` and no uppercase `R`, because each of those 361,580
     * iterations rescanned every remaining byte looking for the `R` that was
     * not there. Extrapolated to 600 MB that is roughly an hour, for the one
     * path whose whole purpose is to be the affordable exhaustive answer. The
     * same call with two monotonic cursors measures 14.9 ms — 1,361x faster.
     */
    const sweep = (hay: Buffer, base: number, startBelow: number): void => {
        let pA = anchorRun === null ? hay.indexOf(anchorLo, 0) : hay.indexOf(anchorRun, 0);
        let pB = anchorUp === anchorLo ? -1 : hay.indexOf(anchorUp, 0);
        for (;;) {
            let p: number;
            if (pA < 0) {
                if (pB < 0) return;
                p = pB;
            } else if (pB < 0 || pA <= pB) {
                p = pA;
            } else {
                p = pB;
            }
            const start = p - anchorAt;
            if (start >= 0 && start < startBelow && start + n <= hay.length && matchAt(hay, start)) {
                hit(base + start);
            }
            if (pA === p) pA = anchorRun === null ? hay.indexOf(anchorLo, p + 1) : hay.indexOf(anchorRun, p + 1);
            if (pB === p) pB = hay.indexOf(anchorUp, p + 1);
        }
    };

    // A match may straddle two chunks, so each chunk is preceded by a seam
    // buffer holding the previous chunk's last n-1 bytes; only matches STARTING
    // in that tail are taken from the seam, so nothing is counted twice.
    const keep = n - 1;
    let carryBuf = Buffer.alloc(0);
    let carryAbs = 0;
    source.sequential(0, size, (chunk, absolute) => {
        if (carryBuf.length > 0) {
            const take = chunk.length < keep ? chunk.length : keep;
            const seam = Buffer.allocUnsafe(carryBuf.length + take);
            carryBuf.copy(seam, 0);
            chunk.copy(seam, carryBuf.length, 0, take);
            sweep(seam, carryAbs, carryBuf.length);
        }
        sweep(chunk, absolute, chunk.length);
        if (keep > 0) {
            // The source may reuse the chunk buffer, so the carry is a copy.
            if (chunk.length >= keep) {
                carryBuf = Buffer.from(chunk.subarray(chunk.length - keep));
            } else {
                const joined = Buffer.concat([carryBuf, chunk]);
                carryBuf = joined.length > keep
                    ? Buffer.from(joined.subarray(joined.length - keep))
                    : joined;
            }
            carryAbs = absolute + chunk.length - carryBuf.length;
        }
    });

    const out = new Uint32Array(found);
    let k = 0;
    for (let b = 0; b < blockCount; b++) {
        if (mark[b] === 1) { out[k] = b; k += 1; }
    }
    return out;
}
