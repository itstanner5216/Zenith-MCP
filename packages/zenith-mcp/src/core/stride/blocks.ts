// ---------------------------------------------------------------------------
// core/stride/blocks.ts — the full-recall block index
//
// The document is cut into fixed SEARCH_BLOCK_BYTES blocks and the index
// records, for each term, WHICH BLOCKS contain it. Not offsets, not records —
// blocks. A 600 MB document is ~9,600 blocks, so a posting list is a handful of
// 32-bit integers however many times the term occurs, and the index costs a
// fraction of a percent of the document instead of a multiple of it (I6).
// Search then reads at most one 64 KiB block per candidate to turn a posting
// back into exact positions.
//
// ── INVARIANT I7, and the one thing this file must not get wrong ────────────
//
// `candidates()` returns EVERY block naming any query term. It does not rank
// them, cap them, sample them or return a "top N", and there is no parameter
// through which a caller could ask it to. Truncating the candidate set is the
// single largest silent-recall failure in this class of index — measured at
// 8-24% of exhaustive result mass lost — and it is silent precisely because the
// results that come back still look plausible. So the API does not offer it.
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
// `Buffer.indexOf` is a SIMD memmem in C++, so that fallback sweep runs at
// several GB/s on a sparse needle and a whole-document scan of 600 MB costs a
// fraction of a second — measured on this machine at ~11 GB/s for a
// digit-anchored needle and ~1.3 GB/s for an all-letters needle, which is what
// makes "just scan it" an honest answer rather than a shrug.
//
// Indexed reads below use `?? 0` only where the index is provably inside the
// array — a loop bound, or a term id taken from the same table being read.
// ---------------------------------------------------------------------------

import { SEARCH_BLOCK_BYTES, TERM_DICT_LIMIT } from './types.js';
import type { StrideSource } from './source.js';
import { tokenizeBytes, TOKEN_MAX_BYTES } from './terms.js';

/**
 * Bytes of the previous block re-tokenised at the head of the next one, so a
 * term cut in half by a block boundary is attributed to BOTH blocks.
 *
 * Twice the token cap is exactly enough, and the proof matters more than the
 * number: let an atom start at `s` before boundary `B`. If `B - s >= 128` the
 * earlier block already emitted the whole capped term. Otherwise `s > B - 128`,
 * so the window `[B - 256, ...)` contains the atom from its true first byte and
 * the later block emits the whole capped term. No term of the document-wide
 * tokenisation can fall between the two.
 */
const OVERLAP_BYTES = 2 * TOKEN_MAX_BYTES;

/**
 * Fixed heap cost of one dictionary entry, excluding the characters.
 * Measured on node 22 with 200,000 flat Buffer-derived keys: ~61 B/entry for a
 * 6-character term, ~93 B for a 36-character one, i.e. a ~16-byte string header
 * rounded to 8, a ~29-byte Map entry (3 compressed slots plus bucket table and
 * capacity overshoot), and one byte per character. Characters are charged
 * separately because a term outside latin1 is stored two bytes per character.
 */
const DICT_ENTRY_BYTES = 56;

/** Heap cost of a term's characters: two bytes each once it leaves latin1. */
function stringBytes(term: string): number {
    for (let i = 0; i < term.length; i++) {
        if (term.charCodeAt(i) > 0xff) return term.length * 2;
    }
    return term.length;
}

function growU32(a: Uint32Array, need: number): Uint32Array {
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
    private readonly dfArr: Uint32Array;
    /** Postings for term `t` are `postBlocks[postOff[t] .. postOff[t+1])`. */
    private readonly postOff: Uint32Array;
    private readonly postBlocks: Uint32Array;
    private readonly blockTok: Uint32Array;
    private readonly size: number;

    private constructor(
        size: number,
        blockCount: number,
        totalTokens: number,
        dict: Map<string, number>,
        dfArr: Uint32Array,
        postOff: Uint32Array,
        postBlocks: Uint32Array,
        blockTok: Uint32Array,
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
                    dfArr[id] = 0;
                }
                const df = (dfArr[id] ?? 0) + 1;
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
            const df = dfArr[t] ?? 0;
            if (df > dropAbove) droppedTerms += 1;
            else run += df;
        }
        postOff[termCount] = run;

        const postBlocks = new Uint32Array(run);
        const cursor = postOff.slice(0, termCount);
        for (let i = 0; i < pairCount; i++) {
            const t = pairTerm[i] ?? 0;
            if ((dfArr[t] ?? 0) > dropAbove) continue;
            const c = cursor[t] ?? 0;
            postBlocks[c] = pairBlock[i] ?? 0;
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
            const from = id === undefined ? 0 : this.postOff[id] ?? 0;
            const to = id === undefined ? 0 : this.postOff[id + 1] ?? 0;
            if (id === undefined || to <= from) {
                if (!missing.includes(term)) missing.push(term);
                continue;
            }
            for (let i = from; i < to; i++) {
                const b = this.postBlocks[i] ?? 0;
                if (b < mark.length && mark[b] === 0) { mark[b] = 1; found += 1; }
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
     * which other terms shared the query.
     */
    df(term: string): number {
        const id = this.dict.get(term);
        if (id === undefined) return 0;
        return this.dfArr[id] ?? 0;
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
        return (this.postOff[id + 1] ?? 0) > (this.postOff[id] ?? 0);
    }

    /**
     * Tokens attributed to one block, its overlap window included — the length
     * a length-normalising ranker needs. A term straddling a boundary is
     * counted in both blocks, exactly as it is posted to both.
     */
    blockTokens(id: number): number {
        if (id < 0 || id >= this.blockCount) return 0;
        return this.blockTok[id] ?? 0;
    }

    /** Half-open byte span of a block, or an empty span when `id` is not one. */
    blockRange(id: number): [number, number] {
        if (id < 0 || id >= this.blockCount) return [0, 0];
        const start = id * SEARCH_BLOCK_BYTES;
        const end = start + SEARCH_BLOCK_BYTES;
        return [start, end > this.size ? this.size : end];
    }
}

/** ASCII-only lowercase. Folding the rest would change bytes the document has not. */
function foldAscii(buf: Buffer): Buffer {
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i] ?? 0;
        out[i] = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
    }
    return out;
}

/**
 * ASCII letters ordered most to least frequent in English text. Used only when
 * a needle is all letters and there is no case-free byte to anchor on: the
 * anchor byte decides how many times the verify loop runs, and anchoring
 * `error` on `r` instead of `e` is roughly a 2x difference on prose.
 */
const LETTER_RARITY = 'etaoinsrhldcumfpgwybvkxjqz';

/**
 * Every block containing the literal `term`, ascending — the exhaustive
 * fallback that makes a missing posting list harmless (I7).
 *
 * Case-insensitive on the ASCII range and substring-exact: it will name blocks
 * where the term occurs inside a longer word, which only ever ADDS candidates
 * for the verify pass to reject. Missing one would be the failure that matters.
 *
 * The sweep is driven by `Buffer.indexOf`, which is a SIMD memmem in C++ rather
 * than a JavaScript loop. It anchors on the longest run of the needle that
 * contains no ASCII letter — `716-446655440000` inside a UUID, the whole of
 * `192.168.1.1` — because such a run has no case variants and can be matched
 * exactly; only an all-letters needle falls back to a two-case byte search.
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
        const b = needle[i] ?? 0;
        if (b >= 0x61 && b <= 0x7a) { curLen = 0; continue; }
        if (curLen === 0) curStart = i;
        curLen += 1;
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    }
    let anchorAt = bestStart;
    let run: Buffer | null = bestLen >= 2 ? needle.subarray(bestStart, bestStart + bestLen) : null;
    if (bestLen === 0) {
        // All letters: anchor on the rarest one and search both cases.
        let bestRank = -1;
        for (let i = 0; i < n; i++) {
            const rank = LETTER_RARITY.indexOf(String.fromCharCode(needle[i] ?? 0));
            if (rank > bestRank) { bestRank = rank; anchorAt = i; }
        }
        run = null;
    }
    const anchorLo = needle[anchorAt] ?? 0;
    const anchorUp = anchorLo >= 0x61 && anchorLo <= 0x7a ? anchorLo - 0x20 : anchorLo;

    const mark = new Uint8Array(blockCount);
    let found = 0;
    const hit = (at: number): void => {
        // A term straddling a boundary lives in both blocks; naming only the
        // first would send the verify pass to a block holding half of it.
        const last = Math.floor((at + n - 1) / SEARCH_BLOCK_BYTES);
        for (let b = Math.floor(at / SEARCH_BLOCK_BYTES); b <= last && b < blockCount; b++) {
            if (mark[b] === 0) { mark[b] = 1; found += 1; }
        }
    };

    const matchAt = (hay: Buffer, at: number): boolean => {
        for (let i = 0; i < n; i++) {
            let h = hay[at + i] ?? 0;
            if (h >= 0x41 && h <= 0x5a) h += 0x20;
            if (h !== (needle[i] ?? 0)) return false;
        }
        return true;
    };

    const sweep = (hay: Buffer, base: number, startBelow: number): void => {
        let from = 0;
        for (;;) {
            let p: number;
            if (run !== null) {
                p = hay.indexOf(run, from);
            } else {
                p = hay.indexOf(anchorLo, from);
                if (anchorUp !== anchorLo) {
                    const q = hay.indexOf(anchorUp, from);
                    if (q >= 0 && (p < 0 || q < p)) p = q;
                }
            }
            if (p < 0) return;
            const start = p - anchorAt;
            if (start >= 0 && start < startBelow && start + n <= hay.length && matchAt(hay, start)) {
                hit(base + start);
            }
            from = p + 1;
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
