// ---------------------------------------------------------------------------
// tests/stride/blocks.test.ts
//
// I7 FULL RECALL is the invariant this file exists to hold down, and the way it
// breaks is silent: a candidate set that is short by a few blocks still returns
// ranked, plausible results. So the central test here does not check that
// `candidates()` contains the blocks we planted — it checks SET EQUALITY against
// an exhaustive literal sweep computed independently of the index, and names the
// missing block ids when it fails.
//
// The ground truth is built from two things the index does not supply: a raw
// `Buffer.indexOf` sweep of the document, and the published verify window
// `blockScanRange(b)`. A block belongs in the truth set exactly when its verify
// window contains a whole occurrence, because that is the only condition under
// which naming the block lets the caller find the hit. Deriving the truth from
// the postings would test the index against itself.
//
// The plant offsets are chosen adversarially rather than conveniently: a block
// start, the last bytes before a boundary, a term cut in half by a boundary, the
// exact first byte of a verify window, one byte BEFORE that first byte, and the
// document's final bytes. The one-byte-off pair is the case that separates a
// correct overlap window from an off-by-one one.
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlockIndex, scanTermBlocks } from '../../src/core/stride/blocks.js';
import { BufferSource, FileSource } from '../../src/core/stride/source.js';
import type { StrideSource } from '../../src/core/stride/source.js';
import { SEARCH_BLOCK_BYTES, TERM_DICT_LIMIT } from '../../src/core/stride/types.js';
import { TOKEN_MAX_BYTES } from '../../src/core/stride/terms.js';

const BS = SEARCH_BLOCK_BYTES;
/** The overlap the index re-tokenises in front of each block. */
const OVERLAP = 2 * TOKEN_MAX_BYTES;

const tempFiles: string[] = [];
afterAll(() => {
    for (const p of tempFiles) {
        try {
            fs.rmSync(p);
        } catch {
            // A fixture that is already gone is not a test failure.
        }
    }
});

/** Seeded so a failing case is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A document of `size` bytes of ordinary JSON filler with `marker` planted at
 * each of `offsets`, space-delimited on both sides so a literal occurrence and
 * a tokenised occurrence are the same thing.
 */
function plantedDocument(marker: string, offsets: readonly number[], size: number): Buffer {
    const unit = Buffer.from('{"seq":12345,"tag":"ordinary filler payload"},', 'utf8');
    const doc = Buffer.alloc(size, 0x20);
    for (let p = 0; p < size; p += unit.length) {
        unit.copy(doc, p, 0, Math.min(unit.length, size - p));
    }
    const m = Buffer.from(marker, 'utf8');
    for (const at of offsets) {
        doc[at - 1] = 0x20;
        m.copy(doc, at);
        doc[at + m.length] = 0x20;
    }
    return doc;
}

/** Every literal occurrence of `marker`, by a raw sweep the index has no part in. */
function literalOccurrences(doc: Buffer, marker: string): number[] {
    const m = Buffer.from(marker, 'utf8');
    const out: number[] = [];
    for (let from = 0; ; ) {
        const p = doc.indexOf(m, from);
        if (p < 0) return out;
        out.push(p);
        from = p + 1;
    }
}

/**
 * The exhaustive candidate set: every block whose published verify window holds
 * a whole occurrence. Computed from the raw sweep and `blockScanRange` only.
 */
function exhaustiveBlocks(index: BlockIndex, doc: Buffer, marker: string): number[] {
    const hits = literalOccurrences(doc, marker);
    const len = Buffer.byteLength(marker, 'utf8');
    const out: number[] = [];
    for (let b = 0; b < index.blockCount; b++) {
        const [from, to] = index.blockScanRange(b);
        for (const at of hits) {
            if (at >= from && at + len <= to) {
                out.push(b);
                break;
            }
        }
    }
    return out;
}

/**
 * 42 blocks, the last one short. The offsets walk every geometric case a term
 * can occupy relative to a block boundary and a verify window.
 */
const PLANTED_SIZE = 41 * BS + 12_345;
const PLANT_OFFSETS: readonly number[] = [
    1_000,                          // deep inside block 0
    BS,                             // exactly the first byte of block 1
    3 * BS - 100,                   // inside block 2, inside block 3's window too
    5 * BS - 5,                     // cut in half by the 4/5 boundary
    8 * BS - OVERLAP,               // exactly the first byte of block 8's window
    12 * BS - OVERLAP - 1,          // ONE BYTE before block 12's window starts
    20 * BS + 12_345,               // mid-document, nowhere near a boundary
    PLANTED_SIZE - 13,              // the document's final bytes
];

const plantedCache = new Map<string, { doc: Buffer; source: StrideSource; index: BlockIndex }>();
function planted(marker: string): { doc: Buffer; source: StrideSource; index: BlockIndex } {
    const hit = plantedCache.get(marker);
    if (hit !== undefined) return hit;
    const doc = plantedDocument(marker, PLANT_OFFSETS, PLANTED_SIZE);
    const source = new BufferSource(doc, `planted:${marker}`);
    const built = { doc, source, index: BlockIndex.build(source) };
    plantedCache.set(marker, built);
    return built;
}

// `zqxjvmarker` is all ASCII letters, so the literal scan must use its two-case
// byte anchor; `zqx7marker9` holds digits, so it takes the letter-free run
// anchor instead. Both paths are exercised on the same geometry.
const MARKERS = ['zqxjvmarker', 'zqx7marker9'] as const;

describe('candidates() returns the exhaustive block set, not a ranked prefix of it', () => {
    for (const marker of MARKERS) {
        it(`names exactly the blocks whose verify window holds an occurrence of ${marker}`, () => {
            const { doc, index } = planted(marker);
            expect(index.blockCount, `the fixture must span well over 40 blocks; got ${index.blockCount}`)
                .toBeGreaterThanOrEqual(40);

            const hits = literalOccurrences(doc, marker);
            expect(hits, `the fixture is unsound: ${JSON.stringify(marker)} occurs ${hits.length} times but ${PLANT_OFFSETS.length} were planted, so the filler contains an accidental copy`)
                .toEqual([...PLANT_OFFSETS].sort((a, b) => a - b));

            const truth = exhaustiveBlocks(index, doc, marker);
            const got = Array.from(index.candidates([marker]).blocks);
            const lost = truth.filter((b) => !got.includes(b));
            const spurious = got.filter((b) => !truth.includes(b));

            expect(lost, `I7 VIOLATION: candidates(${JSON.stringify(marker)}) lost block(s) ${JSON.stringify(lost)}. Each holds an occurrence inside its own verify window that the index will now never look at. exhaustive=${JSON.stringify(truth)} returned=${JSON.stringify(got)}`)
                .toEqual([]);
            expect(spurious, `candidates(${JSON.stringify(marker)}) named block(s) ${JSON.stringify(spurious)} whose verify window holds no whole occurrence. exhaustive=${JSON.stringify(truth)} returned=${JSON.stringify(got)}`)
                .toEqual([]);
            expect(got, `set equality against the exhaustive sweep failed for ${JSON.stringify(marker)}`)
                .toEqual(truth);
        });
    }

    it('offers no parameter through which a caller could ask for fewer blocks', () => {
        // The recall loss this module exists to prevent is 8-24% of exhaustive
        // result mass, and it is silent, so the API must not expose the knob at
        // all rather than default it safely.
        expect(BlockIndex.prototype.candidates.length, 'candidates() must take exactly the query terms — a second parameter is where a cap or a top-N would live')
            .toBe(1);
    });

    it('returns the union ascending and without duplicates when terms overlap', () => {
        const { index } = planted('zqxjvmarker');
        const both = index.candidates(['zqxjvmarker', 'filler', 'zqxjvmarker']);
        const blocks = Array.from(both.blocks);
        expect(blocks, `the union must be strictly ascending; got ${JSON.stringify(blocks.slice(0, 12))}`)
            .toEqual([...blocks].sort((a, b) => a - b));
        expect(new Set(blocks).size, `the union must not repeat a block; got ${blocks.length} entries and ${new Set(blocks).size} distinct`)
            .toBe(blocks.length);
        expect(blocks.length, `a term in the filler of every block must return every one of the ${index.blockCount} blocks, not a sample`)
            .toBe(index.blockCount);
    });

    it('reports an unknown term as missing and returns no blocks for it', () => {
        const { index } = planted('zqxjvmarker');
        const result = index.candidates(['definitelynotinthisdocument']);
        expect(result.missing, 'a term the dictionary has never seen must come back in missing so the caller scans for it')
            .toEqual(['definitelynotinthisdocument']);
        expect(Array.from(result.blocks), 'an unknown term contributes no blocks of its own').toEqual([]);
    });
});

describe('a term at the end of the document and a term across a boundary are both reachable', () => {
    it('returns the last block for a term planted in the document tail', () => {
        const { doc, index } = planted('zqxjvmarker');
        const at = PLANTED_SIZE - 13;
        const lastBlock = Math.floor(at / BS);
        expect(lastBlock, `the tail plant must land in the final block; blockCount=${index.blockCount}`)
            .toBe(index.blockCount - 1);
        expect(doc.indexOf('zqxjvmarker', at), 'the tail plant must actually be at the offset the test assumes')
            .toBe(at);
        const blocks = Array.from(index.candidates(['zqxjvmarker']).blocks);
        expect(blocks, `the tail term's block ${lastBlock} is missing from ${JSON.stringify(blocks)} across a ${index.blockCount}-block document`)
            .toContain(lastBlock);
    });

    it('attributes a term cut in half by a block boundary to the block whose window holds all of it', () => {
        const { doc, index } = planted('zqxjvmarker');
        const at = 5 * BS - 5;
        const len = 'zqxjvmarker'.length;
        expect(doc.indexOf('zqxjvmarker', at - 1), 'the straddling plant must be where the test assumes').toBe(at);
        expect(Math.floor(at / BS), 'the plant must start in block 4').toBe(4);
        expect(Math.floor((at + len - 1) / BS), 'the plant must end in block 5').toBe(5);

        const blocks = Array.from(index.candidates(['zqxjvmarker']).blocks);
        expect(blocks, `a term straddling the 4/5 boundary was attributed to no block at all: ${JSON.stringify(blocks)}`)
            .toContain(5);

        // Why block 5 and not block 4: block 4 only ever saw a truncated
        // prefix, and block 5's verify window is the one that holds the whole
        // occurrence. A caller verifying blockRange instead of blockScanRange
        // would read the tail of the term and score it as no match.
        const [scanFrom, scanTo] = index.blockScanRange(5);
        expect(at >= scanFrom && at + len <= scanTo, `blockScanRange(5) = [${scanFrom}, ${scanTo}) must contain the whole occurrence at [${at}, ${at + len})`)
            .toBe(true);
        const [rangeFrom, rangeTo] = index.blockRange(5);
        expect(at >= rangeFrom && at + len <= rangeTo, `blockRange(5) = [${rangeFrom}, ${rangeTo}) is expected NOT to contain the straddling occurrence at [${at}, ${at + len}) — that is why blockScanRange exists`)
            .toBe(false);
    });

    it('separates a term at the first byte of a verify window from one a single byte earlier', () => {
        const { doc, index } = planted('zqxjvmarker');
        const blocks = Array.from(index.candidates(['zqxjvmarker']).blocks);

        const onWindow = 8 * BS - OVERLAP;
        expect(doc.indexOf('zqxjvmarker', onWindow - 1), 'the on-window plant must be where the test assumes').toBe(onWindow);
        expect(blocks, `a term starting exactly at block 8's window start must be attributed to blocks 7 AND 8; got ${JSON.stringify(blocks)}`)
            .toContain(8);
        expect(blocks, `block 7 holds the same occurrence entirely inside its own range; got ${JSON.stringify(blocks)}`)
            .toContain(7);

        const beforeWindow = 12 * BS - OVERLAP - 1;
        expect(doc.indexOf('zqxjvmarker', beforeWindow - 1), 'the pre-window plant must be where the test assumes').toBe(beforeWindow);
        expect(blocks, `block 11 holds the occurrence one byte before block 12's window; got ${JSON.stringify(blocks)}`)
            .toContain(11);
        expect(blocks, `block 12's window starts one byte AFTER this occurrence, so it can only have tokenised a suffix and must not be named; got ${JSON.stringify(blocks)}`)
            .not.toContain(12);
    });
});

describe('a term with no posting list is answered by the exhaustive literal scan', () => {
    it('keeps an exact global df for a term too common to post, and finds it by scanning', () => {
        // 70 blocks puts the drop threshold at its floor of max(64, 70/4) = 64,
        // so a term in every block is over it. The df must still be exact and
        // global: block-local statistics put two records with identical term
        // frequencies 1.6x apart in score purely by block membership.
        const size = 70 * BS;
        const unit = Buffer.from('{"level":"info","evt":"heartbeat ubiquitousterm"},', 'utf8');
        const doc = Buffer.alloc(size, 0x20);
        for (let p = 0; p < size; p += unit.length) unit.copy(doc, p, 0, Math.min(unit.length, size - p));
        const source = new BufferSource(doc, 'ubiquitous');
        const index = BlockIndex.build(source);

        const dropAbove = Math.max(64, Math.floor(index.blockCount / 4));
        expect(index.blockCount, 'the fixture must have enough blocks to cross the drop floor').toBe(70);
        expect(index.df('ubiquitousterm'), `df must be the exact GLOBAL block count even for a dropped term; drop threshold was ${dropAbove}`)
            .toBe(70);
        expect(index.has('ubiquitousterm'), 'a term whose postings were dropped must report has() === false')
            .toBe(false);
        expect(index.stats.droppedTerms, 'the dropped term must be counted in stats').toBeGreaterThanOrEqual(1);

        const result = index.candidates(['ubiquitousterm']);
        expect(result.missing, 'a dropped term is the caller\'s job to scan for, so it must appear in missing')
            .toContain('ubiquitousterm');
        expect(Array.from(result.blocks), 'a dropped term contributes no postings, by design').toEqual([]);

        const scanned = Array.from(scanTermBlocks(source, 'ubiquitousterm'));
        expect(scanned, `the fallback must recover every block: expected all 70, got ${scanned.length}`)
            .toEqual(Array.from({ length: 70 }, (_v, i) => i));
    });

    it('reports a term rejected by dictionary saturation as missing and still finds it by scanning', () => {
        // TERM_DICT_LIMIT distinct terms are admitted and the rest are refused,
        // so a term appearing only after saturation has no id at all. That is
        // the harder half of I7: the index does not merely lack a posting list,
        // it has never heard of the term.
        const parts: string[] = ['{"vocab":['];
        const letters = 'abcdefghijklmnopqrstuvwxyz';
        const total = TERM_DICT_LIMIT + 10_000;
        for (let i = 0; i < total; i++) {
            let s = 'q';
            let v = i;
            for (let k = 0; k < 5; k++) {
                s += letters[v % 26] ?? 'a';
                v = Math.floor(v / 26);
            }
            parts.push(`"${s}",`);
        }
        parts.push('"zqxjvsaturationtail"]}');
        const doc = Buffer.from(parts.join(''), 'utf8');
        const source = new BufferSource(doc, 'saturated');
        const index = BlockIndex.build(source);

        expect(index.stats.saturated, `the fixture must saturate the dictionary; terms=${index.stats.terms} limit=${TERM_DICT_LIMIT}`)
            .toBe(true);
        expect(index.stats.terms, 'the dictionary must stop at the limit, not overshoot it').toBe(TERM_DICT_LIMIT);
        expect(index.df('zqxjvsaturationtail'), 'a term refused admission has no counted df')
            .toBe(0);
        expect(index.candidates(['zqxjvsaturationtail']).missing, 'a term refused admission must come back in missing, never as silence')
            .toContain('zqxjvsaturationtail');

        const tailBlock = Math.floor(doc.indexOf('zqxjvsaturationtail') / BS);
        expect(Array.from(scanTermBlocks(source, 'zqxjvsaturationtail')), `the literal scan is the only route to this term and must return its block ${tailBlock}`)
            .toEqual([tailBlock]);
    });

    it('finds a needle case-insensitively on the ASCII range and names every block it touches', () => {
        const marker = 'zqxjvmarker';
        const doc = plantedDocument(marker, PLANT_OFFSETS, PLANTED_SIZE);
        // Re-case one occurrence in the document; a query for the lowercase
        // term must still find it.
        doc.write('ZqXjVmArKeR', 20 * BS + 12_345, 'latin1');
        const source = new BufferSource(doc, 'mixedcase');
        const scanned = Array.from(scanTermBlocks(source, marker));
        expect(scanned, `a mixed-case occurrence at block ${Math.floor((20 * BS + 12_345) / BS)} was not found; got ${JSON.stringify(scanned)}`)
            .toContain(20);

        const straddle = 5 * BS - 5;
        expect(scanned, `an occurrence crossing the 4/5 boundary must name BOTH blocks it touches so a merged verify range covers it; got ${JSON.stringify(scanned)}`)
            .toEqual(expect.arrayContaining([Math.floor(straddle / BS), Math.floor((straddle + marker.length - 1) / BS)]));
    });

    it('sweeps a needle whose uppercase form never occurs without going quadratic', () => {
        // This is a regression guard with a specific history. Advancing only the
        // case that matched and re-searching the other from the same offset made
        // this exact call take 20.3 s over 4 MiB (0.21 MB/s), because each of
        // the 361,580 lowercase `r` positions rescanned the whole remaining
        // buffer for an uppercase `R` that was not there. Two monotonic cursors
        // make it 15 ms. The 2 s bar is 130x the fixed cost and 10x below the
        // broken one, so it fails on the bug and not on a slow machine.
        const unit = Buffer.from('{"note":"shipment dispatched from warehouse order ready"},', 'utf8');
        const size = 4 << 20;
        const doc = Buffer.alloc(size, 0x20);
        for (let p = 0; p < size; p += unit.length) unit.copy(doc, p, 0, Math.min(unit.length, size - p));
        let lower = 0;
        let upper = 0;
        for (let i = 0; i < size; i++) {
            if (doc[i] === 0x72) lower += 1;
            if (doc[i] === 0x52) upper += 1;
        }
        expect(upper, 'the guard only bites when one case is absent from the haystack').toBe(0);
        expect(lower, 'the guard needs a haystack dense in the other case').toBeGreaterThan(100_000);

        const source = new BufferSource(doc, 'quadratic');
        const started = process.hrtime.bigint();
        const blocks = scanTermBlocks(source, 'error');
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        expect(blocks.length, '`error` does not occur in this haystack, so the sweep must report nothing').toBe(0);
        expect(ms, `an all-letters needle over ${(size / 1048576).toFixed(0)} MiB took ${ms.toFixed(0)} ms (${(size / 1e6 / (ms / 1000)).toFixed(2)} MB/s) against ${lower} lowercase anchors — the two-cursor sweep has regressed to a per-occurrence rescan`)
            .toBeLessThan(2_000);
    }, 60_000);
});

describe('the index reads the same document the same way however the source chunks it', () => {
    it('agrees between a resident buffer and a file read in chunks, including across seams', () => {
        // Plants sit on every MiB boundary, so whatever chunk size FileSource
        // picks, at least one occurrence crosses a chunk seam. The assertion is
        // chunking-agnostic: the two sources must produce identical answers.
        const size = 9 << 20;
        const offsets: number[] = [];
        for (let mib = 1; mib <= 8; mib++) offsets.push(mib * (1 << 20) - 4);
        offsets.push(1_234, size - 20);
        const marker = 'zqxjvseam';
        const doc = plantedDocument(marker, offsets, size);

        const file = path.join(os.tmpdir(), `stride-blocks-seam-${process.pid}.json`);
        tempFiles.push(file);
        fs.writeFileSync(file, doc);

        const buffered = new BufferSource(doc, 'seam:buffer');
        const filed = new FileSource(file);
        try {
            const bufferIndex = BlockIndex.build(buffered);
            const fileIndex = BlockIndex.build(filed);
            expect(fileIndex.stats.terms, `term counts diverged: buffer ${bufferIndex.stats.terms} vs file ${fileIndex.stats.terms}`)
                .toBe(bufferIndex.stats.terms);
            expect(fileIndex.stats.postings, `posting counts diverged: buffer ${bufferIndex.stats.postings} vs file ${fileIndex.stats.postings}`)
                .toBe(bufferIndex.stats.postings);
            expect(fileIndex.totalTokens, 'a chunk seam must not add or drop a token').toBe(bufferIndex.totalTokens);

            const fromBuffer = Array.from(bufferIndex.candidates([marker]).blocks);
            const fromFile = Array.from(fileIndex.candidates([marker]).blocks);
            expect(fromFile, `candidates diverged across sources: buffer ${JSON.stringify(fromBuffer)} vs file ${JSON.stringify(fromFile)}`)
                .toEqual(fromBuffer);
            expect(fromBuffer, `the exhaustive set must still hold when the document is read in chunks`)
                .toEqual(exhaustiveBlocks(bufferIndex, doc, marker));

            const scanBuffer = Array.from(scanTermBlocks(buffered, marker));
            const scanFile = Array.from(scanTermBlocks(filed, marker));
            expect(scanFile, `the literal sweep lost occurrences at chunk seams: buffer ${JSON.stringify(scanBuffer)} vs file ${JSON.stringify(scanFile)}`)
                .toEqual(scanBuffer);
            expect(scanBuffer.length, `all ${offsets.length} plants must be found; got ${scanBuffer.length} blocks`)
                .toBeGreaterThanOrEqual(offsets.length);
        } finally {
            filed.close();
        }
    }, 120_000);
});

describe('the accessors describe the storage honestly', () => {
    it('bounds a block range by the document and reports an empty span for a block that is not one', () => {
        const { index } = planted('zqxjvmarker');
        expect(index.blockRange(0), 'block 0 starts at byte 0').toEqual([0, BS]);
        const last = index.blockCount - 1;
        expect(index.blockRange(last), `the final block must stop at the document end (${PLANTED_SIZE})`)
            .toEqual([last * BS, PLANTED_SIZE]);
        expect(index.blockScanRange(0), 'block 0 has nothing in front of it to overlap with').toEqual([0, BS]);
        expect(index.blockScanRange(1), 'every later block carries the overlap in front of it')
            .toEqual([BS - OVERLAP, 2 * BS]);
        for (const bad of [-1, index.blockCount, 1e9]) {
            expect(index.blockRange(bad), `blockRange(${bad}) must be an empty span, not a computed one`).toEqual([0, 0]);
            expect(index.blockScanRange(bad), `blockScanRange(${bad}) must be an empty span, not a computed one`).toEqual([0, 0]);
            expect(index.blockTokens(bad), `blockTokens(${bad}) must be 0`).toBe(0);
        }
    });

    it('counts tokens per block and sums them to totalTokens', () => {
        const { index } = planted('zqxjvmarker');
        let sum = 0;
        for (let b = 0; b < index.blockCount; b++) {
            const n = index.blockTokens(b);
            expect(n, `block ${b} of a filler document must have tokens`).toBeGreaterThan(0);
            sum += n;
        }
        expect(sum, `per-block token counts must sum to totalTokens (${index.totalTokens})`).toBe(index.totalTokens);
    });

    it('handles an empty document without inventing a block', () => {
        const source = new BufferSource(Buffer.alloc(0), 'empty');
        const index = BlockIndex.build(source);
        expect(index.blockCount, 'an empty document has no blocks').toBe(0);
        expect(index.stats.terms, 'an empty document has no terms').toBe(0);
        expect(index.stats.postings, 'an empty document has no postings').toBe(0);
        expect(index.totalTokens, 'an empty document has no tokens').toBe(0);
        const result = index.candidates(['anything']);
        expect(Array.from(result.blocks), 'an empty document yields no candidate blocks').toEqual([]);
        expect(result.missing, 'the term is still reported so the caller does not think it was answered')
            .toEqual(['anything']);
        expect(Array.from(scanTermBlocks(source, 'anything')), 'scanning an empty document finds nothing')
            .toEqual([]);
        expect(index.candidates([]), 'an empty query is answered, not thrown at')
            .toEqual({ blocks: new Uint32Array(0), missing: [] });
    });
});

describe('measured cost on a 40 MB document', () => {
    it('reports index footprint and literal-scan throughput as measured numbers', () => {
        const rnd = mulberry32(99);
        const cities = ['london', 'paris', 'berlin', 'tokyo', 'sydney', 'austin', 'lisbon', 'dublin', 'oslo', 'prague'];
        const parts: string[] = ['{"orders":['];
        let bytes = 12;
        let i = 0;
        while (bytes < 40 * 1024 * 1024) {
            const city = cities[Math.floor(rnd() * cities.length)] ?? 'oslo';
            const record = `{"id":${i},"sku":"SKU-${(i * 7919) % 100000}","city":"${city}","ts":"2024-0${1 + (i % 9)}-1${i % 9}T10:30:0${i % 9}Z","total":${(rnd() * 1000).toFixed(2)},"note":"shipment dispatched from warehouse"},`;
            parts.push(record);
            bytes += record.length;
            i += 1;
        }
        parts.push('{"id":-1,"marker":"zqxjvomegatail"}]}');
        const doc = Buffer.from(parts.join(''), 'utf8');
        const source = new BufferSource(doc, 'omega');

        const index = BlockIndex.build(source);
        const pct = (index.stats.bytes / doc.length) * 100;
        const buildMiBs = doc.length / 1048576 / (index.stats.buildMs / 1000);
        console.log(
            `[blocks] ${(doc.length / 1048576).toFixed(2)} MiB / ${i} records: `
            + `blocks=${index.blockCount} terms=${index.stats.terms} postings=${index.stats.postings} `
            + `dropped=${index.stats.droppedTerms} saturated=${index.stats.saturated}\n`
            + `[blocks] stats.bytes=${index.stats.bytes} = ${pct.toFixed(2)}% of document `
            + `(postings ${((index.stats.postings * 4) / doc.length * 100).toFixed(2)}%, remainder is the term dictionary)\n`
            + `[blocks] build ${index.stats.buildMs} ms = ${buildMiBs.toFixed(1)} MiB/s`,
        );

        expect(index.stats.bytes, `the index must be smaller than the document it indexes; ${index.stats.bytes} vs ${doc.length}`)
            .toBeLessThan(doc.length);
        expect(index.stats.postings * 4, `postings alone must stay under 10% of the document; measured ${((index.stats.postings * 4) / doc.length * 100).toFixed(2)}%`)
            .toBeLessThan(doc.length * 0.1);

        const shapes: readonly [string, string][] = [
            ['550e8400-e29b-41d4-a716-446655440000', 'letter-free run anchor, 36 B'],
            ['192.168.1.1', 'letter-free needle'],
            ['zqxjvomegatail', 'all letters, rare anchor'],
            ['warehouse', 'all letters, one hit per record'],
        ];
        const lines: string[] = [];
        for (const [needle, label] of shapes) {
            for (let warm = 0; warm < 3; warm += 1) scanTermBlocks(source, needle);
            const samples: number[] = [];
            let blocks = 0;
            for (let k = 0; k < 5; k += 1) {
                const started = process.hrtime.bigint();
                blocks = scanTermBlocks(source, needle).length;
                samples.push(Number(process.hrtime.bigint() - started) / 1e9);
            }
            samples.sort((a, b) => a - b);
            const median = samples[2] ?? 0;
            const gbs = doc.length / 1e9 / median;
            lines.push(`[blocks] scanTermBlocks ${needle.padEnd(38)} ${label.padEnd(30)} ${(median * 1000).toFixed(1).padStart(6)} ms = ${gbs.toFixed(2)} GB/s (${blocks} blocks)`);
            expect(gbs * 1000, `${needle} swept at ${(gbs * 1000).toFixed(0)} MB/s, below the 50 MB/s floor — the fallback is no longer affordable, which is what makes a missing posting list harmless`)
                .toBeGreaterThan(50);
        }
        console.log(lines.join('\n'));

        const tail = doc.indexOf('zqxjvomegatail');
        expect(Array.from(scanTermBlocks(source, 'zqxjvomegatail')), 'the tail marker of the 40 MB document must be found by the sweep')
            .toEqual([Math.floor(tail / BS)]);
    }, 300_000);
});
