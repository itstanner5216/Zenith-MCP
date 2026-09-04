// ---------------------------------------------------------------------------
// tests/stride/search.test.ts
//
// I7 FULL RECALL is what this file exists to hold down, and the reason it needs
// holding down is that it fails SILENTLY: a candidate set short by a few blocks,
// or a verify pass that quietly accepts or rejects the wrong records, still
// returns a ranked page of plausible hits. Nothing in the output shape says the
// answer was incomplete. So the central test does not check that the hits it
// planted came back — it checks SET EQUALITY against a match set computed from
// the raw bytes, and names the records on both sides of the difference when it
// fails.
//
// The ground truth is built from two things the search does not supply: a
// `Buffer.indexOf` sweep over an ASCII-folded copy of the whole document, and
// the record spans the fixture generator recorded as it laid the document out.
// A record belongs in the truth set exactly when a folded literal occurrence of
// a query needle lies inside its span AND `tokenizeBytes` over that record's own
// bytes emits the term — the tokeniser being, by blocks.ts's contract, the sole
// authority on whether a term occurs. Nothing here reads a posting list, a `df`,
// or a candidate set to decide what the answer should be.
//
// The plants are adversarial rather than convenient. The recall fixture is 5.2
// MiB over 84 blocks and 88,005 records, and it is built so that all four of the
// hard cases are live in ONE document:
//
//   - a matching record in the FIRST block,
//   - a matching record in the LAST block,
//   - a term whose bytes STRADDLE a SEARCH_BLOCK_BYTES boundary, which the index
//     posts to the later block only, so a verify pass reading `blockRange`
//     instead of `blockScanRange` loses it,
//   - a term the dictionary NEVER ADMITTED, because the document saturates
//     TERM_DICT_LIMIT before it appears, so the only route to it is `missing`
//     plus `scanTermBlocks`,
//   - and a term whose posting list was DROPPED for naming more than
//     max(64, blockCount/4) blocks, spread one occurrence per 400 records across
//     every block, so a candidate set that ranked or capped blocks would come
//     back with a fraction of the answer and no sign of it.
//
// Every one of those preconditions is asserted before the recall claim is made.
// A fixture that quietly stopped saturating the dictionary would otherwise turn
// the most important test in this file into a test of nothing.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { BlockIndex, scanTermBlocks } from '../../src/core/stride/blocks.js';
import { decodeCursor } from '../../src/core/stride/cursor.js';
import { StrideIndex } from '../../src/core/stride/index.js';
import { Resolver } from '../../src/core/stride/resolve.js';
import { BufferSource } from '../../src/core/stride/source.js';
import type { StrideSource } from '../../src/core/stride/source.js';
import {
    BM25_B, BM25_K1, DEFAULT_SEARCH_LIMIT, HIT_OFFSETS_MAX, LEXICAL_WEIGHT,
    MIN_NOVELTY_POPULATION, MIN_RESULT_CHARS, NOVELTY_POOL_CAP, RANK_DEPTH_MAX, RECORD_VERIFY_BYTES,
    SEARCH_STOPWORDS, search, searchTerms,
} from '../../src/core/stride/search.js';
import type { StrideSearchOptions } from '../../src/core/stride/search.js';
import { tokenizeBytes } from '../../src/core/stride/terms.js';
import {
    MIN_BUDGET_CHARS, SEARCH_BLOCK_BYTES, SHAPE_SAMPLE, StrideError, TERM_DICT_LIMIT,
} from '../../src/core/stride/types.js';
import type { StrideHit, StrideSearchResult } from '../../src/core/stride/types.js';

// ── helpers ───────────────────────────────────────────────────────────────

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
 * An indexed read that states what it wanted when it is not there.
 *
 * `noUncheckedIndexedAccess` makes every index read `T | undefined`, and the two
 * ways to spend that are a non-null assertion — which asserts rather than checks
 * — or this, which turns an impossible read into a named failure.
 */
function at<T>(xs: ArrayLike<T>, i: number, what: string): T {
    const v = xs[i];
    if (v === undefined) throw new Error(`${what}: nothing at index ${i} of ${xs.length}`);
    return v;
}

/** The whole pipeline over one document's bytes. */
interface Wired {
    readonly bytes: Buffer;
    readonly source: StrideSource;
    readonly resolver: Resolver;
    readonly blocks: BlockIndex;
}

function wire(text: string | Buffer, id = 'test'): Wired {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    const source = new BufferSource(bytes, id);
    const index = StrideIndex.build(source);
    return { bytes, source, resolver: new Resolver(index), blocks: BlockIndex.build(source) };
}

/** ASCII-only lowercase, as a copy. The same fold the search applies. */
function foldAscii(buf: Buffer): Buffer {
    const out = Buffer.from(buf);
    for (let i = 0; i < out.length; i++) {
        const b = at(out, i, 'fold');
        if (b >= 0x41 && b <= 0x5a) out[i] = b + 0x20;
    }
    return out;
}

/** Every byte offset in `buf` where the folded `needle` literally occurs. */
function literalOccurrences(buf: Buffer, needle: string): number[] {
    const folded = foldAscii(buf);
    const n = foldAscii(Buffer.from(needle, 'utf8'));
    const out: number[] = [];
    for (let p = folded.indexOf(n); p >= 0; p = folded.indexOf(n, p + 1)) out.push(p);
    return out;
}

/** Does `tokenizeBytes` emit `term` from `buf[from..to)`? */
function tokenisesTo(buf: Buffer, from: number, to: number, term: string): boolean {
    const out: string[] = [];
    tokenizeBytes(buf, from, to, out);
    return out.includes(term);
}

/** A document laid out record by record, with every record's span recorded. */
interface Fixture {
    readonly bytes: Buffer;
    /** Span of element `k` of the root container, index-aligned. */
    readonly spans: ReadonlyArray<readonly [number, number]>;
    /** Pointer prefix the elements live under, e.g. `/log`. */
    readonly under: string;
}

/**
 * The match set, computed from the raw bytes and the recorded spans alone.
 *
 * This is the definition search.ts is held to: a record matched when a folded
 * literal occurrence of a query needle falls inside its span and the tokeniser
 * agrees the term is there. The literal sweep is only a locator — exactly the
 * division of labour blocks.ts states — so the tokeniser check is what rejects
 * `shipped` inside `preshippedx`.
 */
function trueMatches(fixture: Fixture, terms: readonly string[]): Set<string> {
    const found = new Set<string>();
    for (const term of terms) {
        for (const at2 of literalOccurrences(fixture.bytes, term)) {
            for (let k = 0; k < fixture.spans.length; k++) {
                const [from, to] = at(fixture.spans, k, 'span');
                if (at2 < from || at2 >= to) continue;
                if (tokenisesTo(fixture.bytes, from, to, term)) found.add(`${fixture.under}/${k}`);
                break;
            }
        }
    }
    return found;
}

/** `a \ b`, sorted, for a failure message that names records rather than counts. */
function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
    return [...a].filter((v) => !b.has(v)).sort();
}

/** Every hit for `query`, paged until the document is exhausted. */
function allHits(w: Wired, query: string, opts: Omit<StrideSearchOptions, 'offset'>): StrideHit[] {
    const out: StrideHit[] = [];
    let offset = 0;
    for (let guard = 0; guard < 10_000; guard++) {
        const r: StrideSearchResult = search(w.resolver, w.blocks, query, { ...opts, offset });
        if (r.returned === 0) return out;
        out.push(...r.hits);
        offset += r.returned;
        if (offset >= r.totalMatches) return out;
    }
    throw new Error(`paging did not terminate for ${JSON.stringify(query)}`);
}

// ── the recall fixture ────────────────────────────────────────────────────

const RARE = 'zulufoxtrot';          // indexed, planted at three known positions
const UNADMITTED = 'quebecyankee';   // appears only after TERM_DICT_LIMIT saturates
const SPREAD = 'deltaquebec';        // in every block, so its postings are dropped
const RECALL_FILLERS = 88_000;
const SPREAD_EVERY = 400;

interface RecallFixture extends Fixture {
    readonly planted: {
        readonly first: number;
        readonly straddle: number;
        readonly unadmitted: number;
        readonly last: number;
    };
    readonly spreadCount: number;
}

/**
 * The 5.2 MiB / 84-block / 88,005-record recall document.
 *
 * Everything is ASCII so a byte offset and a string index are the same number,
 * which is what lets the straddle be placed exactly rather than approximately.
 * The filler carries four unique identifiers per record specifically to saturate
 * TERM_DICT_LIMIT part way through: the dictionary stops admitting new terms, and
 * `quebecyankee` — planted after that point — becomes a term the index has no
 * entry for at all. That is the case the `missing` contract exists for and the
 * one a convenient fixture never reaches.
 */
function buildRecallFixture(): RecallFixture {
    const head = '{"log":[';
    const parts: string[] = [];
    const spans: Array<readonly [number, number]> = [];
    let len = head.length;
    const push = (record: string): number => {
        spans.push([len, len + record.length] as const);
        parts.push(record);
        len += record.length + 1;                 // the separating comma
        return spans.length - 1;
    };
    const filler = (i: number): string => {
        const n = String(i).padStart(6, '0');
        const spread = i % SPREAD_EVERY === 0 ? `,"m":"${SPREAD}"` : '';
        return `{"a":"aa${n}","b":"bb${n}","c":"cc${n}","d":"dd${n}"${spread}}`;
    };

    const first = push(`{"a":"${RARE}","w":"first block"}`);

    // Pad to the byte where a record's `a` value starts five bytes short of the
    // first block boundary, so RARE's eleven bytes cross it.
    const recordStart = SEARCH_BLOCK_BYTES - 5 - '{"a":"'.length;
    let i = 0;
    while (len + filler(i).length + 1 + 400 < recordStart) { push(filler(i)); i += 1; }
    const padTo = recordStart - len;
    if (padTo < 9) throw new Error(`cannot pad to the straddle: ${padTo} bytes of room`);
    push(`{"z":"${'p'.repeat(padTo - 9)}"}`);
    if (len !== recordStart) throw new Error(`pad landed at ${len}, wanted ${recordStart}`);
    const straddle = push(`{"a":"${RARE}","w":"straddles a block boundary"}`);

    let spreadCount = 0;
    for (let k = 0; k < i; k++) if (k % SPREAD_EVERY === 0) spreadCount += 1;
    while (i < RECALL_FILLERS) {
        if (i % SPREAD_EVERY === 0) spreadCount += 1;
        push(filler(i));
        i += 1;
    }
    const unadmitted = push(`{"a":"${UNADMITTED}","w":"after dictionary saturation"}`);
    const last = push(`{"a":"${RARE}","w":"last block"}`);

    return {
        bytes: Buffer.from(`${head}${parts.join(',')}]}`, 'utf8'),
        spans,
        under: '/log',
        planted: { first, straddle, unadmitted, last },
        spreadCount,
    };
}

/** Built once: it costs about a second to lay out and index. */
let recallCache: { readonly fixture: RecallFixture; readonly wired: Wired } | null = null;
function recall(): { readonly fixture: RecallFixture; readonly wired: Wired } {
    if (recallCache === null) {
        const fixture = buildRecallFixture();
        recallCache = { fixture, wired: wire(fixture.bytes, 'recall') };
    }
    return recallCache;
}

// ── smaller fixtures ──────────────────────────────────────────────────────

/** A flat array of records under `/rows`, with every span recorded. */
function rowsFixture(records: readonly string[]): Fixture {
    const head = '{"rows":[';
    const spans: Array<readonly [number, number]> = [];
    let len = head.length;
    for (const r of records) {
        spans.push([len, len + r.length] as const);
        len += r.length + 1;
    }
    return { bytes: Buffer.from(`${head}${records.join(',')}]}`, 'utf8'), spans, under: '/rows' };
}

const BIG_BUDGET = 4_000_000;

// ── I7: full recall, by set equality ──────────────────────────────────────

describe('search enumerates every candidate region (I7 FULL RECALL)', () => {
    it('the recall fixture reaches every state the recall claim depends on', () => {
        const { fixture, wired } = recall();
        const { blocks, bytes } = wired;

        expect(blocks.blockCount, 'the fixture must span many blocks or nothing here is tested')
            .toBeGreaterThan(64);
        expect(blocks.stats.saturated, `the dictionary must reach TERM_DICT_LIMIT (${TERM_DICT_LIMIT}) or `
            + '`quebecyankee` would be indexed and the `missing` path never runs').toBe(true);
        expect(blocks.has(UNADMITTED), `${UNADMITTED} must have NO posting list, so the only route to it is `
            + 'missing + scanTermBlocks').toBe(false);
        expect(blocks.df(UNADMITTED), `${UNADMITTED} must be absent from the dictionary entirely`).toBe(0);

        const dropAbove = Math.max(64, Math.floor(blocks.blockCount / 4));
        expect(blocks.df(SPREAD), `${SPREAD} must name more than ${dropAbove} blocks so its postings are dropped`)
            .toBeGreaterThan(dropAbove);
        expect(blocks.has(SPREAD), `${SPREAD} must have lost its posting list while keeping its exact df`)
            .toBe(false);

        expect(blocks.has(RARE), `${RARE} must be indexed, so the index path is exercised too`).toBe(true);

        const occurrences = literalOccurrences(bytes, RARE);
        expect(occurrences.length, `${RARE} must be planted exactly three times`).toBe(3);
        const firstBlock = Math.floor(at(occurrences, 0, 'occurrence') / SEARCH_BLOCK_BYTES);
        expect(firstBlock, 'one plant must sit in the FIRST block').toBe(0);
        const lastAt = at(occurrences, 2, 'occurrence');
        expect(Math.floor(lastAt / SEARCH_BLOCK_BYTES), 'one plant must sit in the LAST block')
            .toBe(blocks.blockCount - 1);
        const strAt = at(occurrences, 1, 'occurrence');
        expect(Math.floor(strAt / SEARCH_BLOCK_BYTES), 'the straddling plant must START before a boundary')
            .toBeLessThan(Math.floor((strAt + RARE.length - 1) / SEARCH_BLOCK_BYTES));

        expect(searchTerms(`${RARE} ${UNADMITTED}`), 'the query must reduce to exactly the two planted terms')
            .toEqual([RARE, UNADMITTED]);
        expect(fixture.spans.length, 'every record must have a recorded span').toBe(RECALL_FILLERS + 5);
    }, 120_000);

    it('returns exactly the records an exhaustive byte sweep says matched, by set equality', () => {
        const { fixture, wired } = recall();
        const query = `${RARE} ${UNADMITTED}`;
        const expected = trueMatches(fixture, searchTerms(query));

        const planted = new Set([
            `/log/${fixture.planted.first}`,
            `/log/${fixture.planted.straddle}`,
            `/log/${fixture.planted.unadmitted}`,
            `/log/${fixture.planted.last}`,
        ]);
        expect([...expected].sort(), 'the independent sweep must find the four plants and nothing else')
            .toEqual([...planted].sort());

        const r = search(wired.resolver, wired.blocks, query, { budget: BIG_BUDGET, limit: 500 });
        const returned = new Set(r.hits.map((h) => h.pointer));

        const missed = difference(expected, returned);
        const invented = difference(returned, expected);
        expect(missed, `records the byte sweep found and search did not return: ${missed.join(', ') || '(none)'} `
            + `— a dropped candidate block, a verify window read as blockRange instead of blockScanRange, or a `
            + `missing term whose scanTermBlocks result was not unioned in`).toEqual([]);
        expect(invented, `records search returned that hold no query term: ${invented.join(', ') || '(none)'}`)
            .toEqual([]);
        expect(r.totalMatches, `totalMatches must be the true count over the whole document, not the count of `
            + `what an index retained (I7). Expected ${expected.size} from the byte sweep.`).toBe(expected.size);
        expect(r.returned, 'every match must fit in this page at this budget').toBe(expected.size);
    }, 120_000);

    it('recovers a term the dictionary never admitted, through missing plus scanTermBlocks', () => {
        const { fixture, wired } = recall();
        const expected = trueMatches(fixture, [UNADMITTED]);
        expect(expected.size, 'the unadmitted term must match exactly one planted record').toBe(1);

        const r = search(wired.resolver, wired.blocks, UNADMITTED, { budget: BIG_BUDGET, limit: 50 });
        expect(r.totalMatches, `a term absent from a saturated dictionary must still be found exhaustively: `
            + `expected ${expected.size}, and 0 means the missing -> scanTermBlocks union did not run`)
            .toBe(expected.size);
        expect(new Set(r.hits.map((h) => h.pointer)), 'the fallback must return the record itself')
            .toEqual(expected);
        expect(r.path, 'a query answered by a literal sweep must say so, not claim the index answered')
            .toBe('scan');
    }, 120_000);

    it('recovers a term whose postings were dropped for naming too many blocks', () => {
        const { fixture, wired } = recall();
        const expected = trueMatches(fixture, [SPREAD]);
        expect(expected.size, 'the spread term must match one record per SPREAD_EVERY fillers')
            .toBe(fixture.spreadCount);

        const r = search(wired.resolver, wired.blocks, SPREAD, { budget: BIG_BUDGET, limit: 400 });
        const returned = new Set(r.hits.map((h) => h.pointer));
        const missed = difference(expected, returned);
        expect(r.totalMatches, `a dropped posting list must cost nothing in recall: expected ${expected.size} `
            + `records spread across all ${wired.blocks.blockCount} blocks`).toBe(expected.size);
        expect(missed, `records missed by the dropped-postings fallback: ${missed.slice(0, 20).join(', ') || '(none)'}`)
            .toEqual([]);
        expect(r.path, 'the answer came from the exhaustive route').toBe('scan');
    }, 120_000);

    it('visits every block naming a term rather than a scored prefix of them (T1)', () => {
        const { fixture, wired } = recall();
        // The spread term occupies every block of the document. A candidate set
        // that ranked, capped or sampled blocks would come back with a fraction
        // of these records, ranked and plausible, and say nothing about it.
        const blocksTouched = new Set<number>();
        for (const at2 of literalOccurrences(fixture.bytes, SPREAD)) {
            blocksTouched.add(Math.floor(at2 / SEARCH_BLOCK_BYTES));
        }
        expect(blocksTouched.size, 'the spread term must genuinely occupy nearly every block')
            .toBeGreaterThanOrEqual(wired.blocks.blockCount - 1);

        const expected = trueMatches(fixture, [SPREAD]);
        const r = search(wired.resolver, wired.blocks, SPREAD, { budget: BIG_BUDGET, limit: 400 });
        expect(r.totalMatches / expected.size, `visiting a top-N prefix of candidate blocks loses 8-24% of `
            + `exhaustive result mass and does it silently; the recovered fraction must be exactly 1`).toBe(1);

        // And the two ends specifically: a cap that took blocks in ascending or
        // descending order would keep one end and lose the other.
        const rareExpected = trueMatches(fixture, [RARE]);
        const rareHits = new Set(search(wired.resolver, wired.blocks, RARE,
            { budget: BIG_BUDGET, limit: 50 }).hits.map((h) => h.pointer));
        expect(difference(rareExpected, rareHits), 'both the first-block and last-block plants must come back')
            .toEqual([]);
    }, 120_000);

    it('counts a boundary-straddling term, which lives outside blockRange', () => {
        const { fixture, wired } = recall();
        const pointer = `/log/${fixture.planted.straddle}`;
        const r = search(wired.resolver, wired.blocks, RARE, { budget: BIG_BUDGET, limit: 50 });
        expect(r.hits.map((h) => h.pointer), 'the straddling record must be in the page; reading blockRange '
            + 'instead of blockScanRange finds only the tail of the term and scores it as no match')
            .toContain(pointer);
    }, 120_000);
});

// ── the record unit, and what is NOT a record ─────────────────────────────

describe('the record is the enclosing structural node', () => {
    it('expands to the enclosing record unconditionally, not gated on the neighbour\'s relevance', () => {
        // The matched value carries no relevance to the member that names it. A
        // relevance-gated expansion skips exactly this evidence; dumb expansion
        // to the enclosing node recovers it.
        const f = rowsFixture([
            '{"unitname":"celsius","reading":"deadbeefvalue"}',
            '{"unitname":"fahrenheit","reading":"cafebabevalue"}',
        ]);
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'deadbeefvalue', { budget: 20_000, limit: 5 });
        expect(r.totalMatches, 'the planted value must match exactly one record').toBe(1);
        const hit = at(r.hits, 0, 'hit');
        expect(hit.span, 'the hit span must be the whole enclosing record, not the matched scalar')
            .toEqual(at(f.spans, 0, 'span'));
        const preview: unknown = hit.preview;
        expect(typeof preview === 'object' && preview !== null && 'unitname' in preview,
            'the preview must carry the member that makes the value interpretable').toBe(true);
    });

    it('never answers with the document root, whose span is the whole document', () => {
        const records = Array.from({ length: 200 }, (_, i) => `{"n":${i},"f":"${'y'.repeat(200)}"}`);
        const f = rowsFixture(records);
        const w = wire(f.bytes);
        // `rows` occurs literally only in the root's own key. Attributing that
        // byte to the object holding the key would return the whole document.
        const r = search(w.resolver, w.blocks, 'rows', { budget: 20_000, limit: 5 });
        for (const h of r.hits) {
            expect(h.pointer, 'no hit may be the document root').not.toBe('');
            expect(h.span[1] - h.span[0], 'no hit may span the whole document')
                .toBeLessThan(w.bytes.length);
        }
        expect(r.totalMatches, 'a byte in the root\'s own bytes belongs to no record')
            .toBe(trueMatches(f, ['rows']).size);
    });

    it('still attributes a member NAME hit to the object that holds the name', () => {
        const records = Array.from({ length: 40 }, (_, i) => `{"widgetkey":${i}}`);
        const f = rowsFixture(records);
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'widgetkey', { budget: BIG_BUDGET, limit: 60 });
        const expected = trueMatches(f, ['widgetkey']);
        expect(r.totalMatches, 'every record whose key holds the term is a match').toBe(expected.size);
        expect(new Set(r.hits.map((h) => h.pointer)), 'each key hit belongs to its own record, not to the root')
            .toEqual(expected);
    });

    it('treats a root scalar and a root array of scalars as records in their own right', () => {
        const w1 = wire('["error alphaterm","error betaterm"]');
        const r1 = search(w1.resolver, w1.blocks, 'alphaterm', { budget: 20_000 });
        expect(r1.totalMatches, 'the element is the record when its container is the root').toBe(1);
        expect(at(r1.hits, 0, 'hit').pointer, 'the element, not the root').toBe('/0');

        const w2 = wire('"one alphaterm string document"');
        const r2 = search(w2.resolver, w2.blocks, 'alphaterm', { budget: 20_000 });
        expect(r2.totalMatches, 'a root scalar document is its own record').toBe(1);
        expect(at(r2.hits, 0, 'hit').pointer, 'the root scalar addresses as ""').toBe('');
    });

    it('does not let a path term create a match or appear in `matched`', () => {
        // `shipped` occurs only inside `preshippedx`, which the tokeniser refuses
        // to split, so no record holds a query term. `orders` is a path term of
        // every record. A match gate that counted path terms would report all of
        // them, and only the ones in a candidate block — recall that depends on
        // block membership is exactly what I7 forbids.
        const records = Array.from({ length: 6 }, (_, i) => `{"tag":"preshippedx","n":${i}}`);
        const bytes = Buffer.from(`{"orders":[${records.join(',')}]}`, 'utf8');
        const w = wire(bytes);
        const withPath = search(w.resolver, w.blocks, 'orders shipped', { budget: BIG_BUDGET, limit: 20 });
        const alone = search(w.resolver, w.blocks, 'shipped', { budget: BIG_BUDGET, limit: 20 });
        expect(alone.totalMatches, 'a substring inside a longer word is not a match').toBe(0);
        expect(withPath.totalMatches, 'adding a term that matches only the PATH must not manufacture matches; '
            + `searching 'shipped' alone finds ${alone.totalMatches}`).toBe(alone.totalMatches);
    });
});

// ── every hit is addressable and verifiable ───────────────────────────────

describe('every StrideHit is addressed, spanned and offset correctly', () => {
    const records = [
        '{"id":"ord-1001","status":"shippedalpha","warehouse":"whzero"}',
        '{"id":"ord-1002","status":"pendingbeta","warehouse":"whone"}',
        '{"id":"ord-1003","status":"shippedalpha","warehouse":"whtwo","extra":{"nested":"shippedalpha"}}',
        '{"id":"ord-1004","status":"shippedalpha","warehouse":"whzero"}',
    ];

    it('decodes both cursors, matches resolve on the span, and puts every offset on a real occurrence', () => {
        const f = rowsFixture(records);
        const w = wire(f.bytes);
        const query = 'shippedalpha whzero';
        const terms = searchTerms(query);
        const r = search(w.resolver, w.blocks, query, { budget: BIG_BUDGET, limit: 20 });
        expect(r.returned, 'the fixture must produce hits to check').toBeGreaterThan(0);

        const folded = foldAscii(w.bytes);
        for (const h of r.hits) {
            const c = decodeCursor(h.cursor);
            expect(c.pointer, `cursor for ${h.pointer} must address the same record`).toBe(h.pointer);
            expect(c.op, `cursor for ${h.pointer} must be a read cursor`).toBe('read');
            const wc = decodeCursor(h.windowCursor);
            expect(wc.pointer, `windowCursor for ${h.pointer} must address the same record`).toBe(h.pointer);
            expect(wc.op, `windowCursor for ${h.pointer} must be a window cursor`).toBe('window');
            expect(wc.query, `windowCursor for ${h.pointer} must carry the query`).toBe(query);

            const node = w.resolver.resolve(h.pointer);
            expect([node.start, node.end], `span of ${h.pointer} must be the span resolve reports`)
                .toEqual([h.span[0], h.span[1]]);

            expect(h.offsets.length, `offsets for ${h.pointer} must not exceed HIT_OFFSETS_MAX`)
                .toBeLessThanOrEqual(HIT_OFFSETS_MAX);
            for (let i = 0; i < h.offsets.length; i++) {
                const off = at(h.offsets, i, 'offset');
                expect(off >= h.span[0] && off < h.span[1],
                    `offset ${off} of ${h.pointer} must lie inside its span ${JSON.stringify(h.span)}`).toBe(true);
                if (i > 0) {
                    expect(off, `offsets of ${h.pointer} must be ascending and unique`)
                        .toBeGreaterThan(at(h.offsets, i - 1, 'offset'));
                }
                const hitsHere = terms.some((t) => {
                    const nd = foldAscii(Buffer.from(t, 'utf8'));
                    return folded.subarray(off, off + nd.length).equals(nd);
                });
                expect(hitsHere, `offset ${off} of ${h.pointer} must be a byte position where a query term `
                    + `literally occurs; the bytes there are `
                    + `${JSON.stringify(w.bytes.subarray(off, off + 16).toString('latin1'))}`).toBe(true);
            }

            for (const term of h.matched) {
                expect(terms, `matched term ${JSON.stringify(term)} of ${h.pointer} must be a query term`)
                    .toContain(term);
                expect(tokenisesTo(w.bytes, h.span[0], h.span[1], term),
                    `matched term ${JSON.stringify(term)} of ${h.pointer} must actually occur in the record's `
                    + `own bytes — a path term is a ranking signal, not a match`).toBe(true);
            }
            expect(h.matched.length, `${h.pointer} would not be a hit with nothing matched`).toBeGreaterThan(0);
        }
    });

    it('caps offsets at HIT_OFFSETS_MAX without dropping the record', () => {
        const many = Array.from({ length: 50 }, () => 'alphaterm').join(' ');
        const f = rowsFixture([`{"v":"${many}"}`, '{"v":"nothing here"}']);
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 5 });
        expect(r.totalMatches, 'the record with fifty occurrences is one match').toBe(1);
        expect(at(r.hits, 0, 'hit').offsets.length,
            `50 occurrences must report exactly HIT_OFFSETS_MAX (${HIT_OFFSETS_MAX}) offsets`)
            .toBe(HIT_OFFSETS_MAX);
    });

    it('enumerates, counts and returns a record wider than RECORD_VERIFY_BYTES', () => {
        const wide = `{"pad":"${'q'.repeat(RECORD_VERIFY_BYTES * 2)}","key":"alphaterm"}`;
        const f = rowsFixture(['{"key":"nothing"}', wide, '{"key":"nothing"}']);
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'alphaterm', { budget: 200_000, limit: 5 });
        expect(r.totalMatches, 'a record larger than the verify window is still enumerated and counted').toBe(1);
        const hit = at(r.hits, 0, 'hit');
        expect(hit.span, 'its span is the whole record, not the verify window')
            .toEqual(at(f.spans, 1, 'span'));
        expect(hit.span[1] - hit.span[0], 'the record must genuinely exceed RECORD_VERIFY_BYTES')
            .toBeGreaterThan(RECORD_VERIFY_BYTES);
        for (const off of hit.offsets) {
            expect(off >= hit.span[0] && off < hit.span[1], `offset ${off} must lie inside the record`).toBe(true);
        }
    });
});

// ── I3: the budget ────────────────────────────────────────────────────────

describe('the budget bounds the result (I3 BUDGET BOUND)', () => {
    const f = rowsFixture(Array.from({ length: 40 }, (_, i) => `{"s":"alphaterm","i":${i}}`));

    it('honours chars <= budget at 0, 1, MIN_BUDGET_CHARS and across the range', () => {
        const w = wire(f.bytes);
        const budgets = [0, 1, 2, 3, 5, MIN_BUDGET_CHARS - 1, MIN_BUDGET_CHARS, MIN_BUDGET_CHARS + 1,
            300, 500, 1_000, 4_000, 40_000];
        for (const budget of budgets) {
            const r = search(w.resolver, w.blocks, 'alphaterm', { budget });
            expect(r.chars, `chars must not exceed the reported budget at budget ${budget}`)
                .toBeLessThanOrEqual(r.budget);
            expect(r.budget, `budget ${budget} must be reported at the MIN_RESULT_CHARS floor or above`)
                .toBeGreaterThanOrEqual(MIN_RESULT_CHARS);
            expect(r.totalMatches, `the true count must survive any budget (budget ${budget})`)
                .toBe(trueMatches(f, ['alphaterm']).size);
            for (const h of r.hits) {
                const text = JSON.stringify(h.preview);
                expect(typeof text, `preview of ${h.pointer} at budget ${budget} must serialise`).toBe('string');
                expect(() => JSON.parse(text === undefined ? 'null' : text),
                    `preview of ${h.pointer} at budget ${budget} must parse as JSON (I2)`).not.toThrow();
            }
        }
    });

    it('reports budget 0 and 1 at the MIN_RESULT_CHARS floor rather than as asked', () => {
        const w = wire(f.bytes);
        for (const budget of [0, 1]) {
            const r = search(w.resolver, w.blocks, 'alphaterm', { budget });
            expect(r.budget, `a budget of ${budget} cannot hold any JSON payload, so the floor is reported`)
                .toBe(MIN_RESULT_CHARS);
            expect(r.chars, 'an empty hits array costs exactly MIN_RESULT_CHARS').toBe(MIN_RESULT_CHARS);
        }
    });

    it('returns a reduced answer rather than an empty one whenever one hit can be afforded', () => {
        const w = wire(f.bytes);
        // The knee wants several hits; an equal share of a small budget is
        // smaller than one hit's fixed metadata cost. Dividing the budget that
        // way returns nothing at every budget below ~2000, which is the empty
        // result the contract rules out.
        const one = search(w.resolver, w.blocks, 'alphaterm', { budget: 40_000, limit: 1 });
        expect(one.returned, 'a limit of one must return one hit').toBe(1);
        const fixedCost = one.chars;
        const r = search(w.resolver, w.blocks, 'alphaterm', { budget: Math.ceil(fixedCost / (1 - 0.12)) + 64 });
        expect(r.returned, `a budget that can pay for one hit (${fixedCost} characters of payload) must return `
            + 'at least one, whatever the knee asked for').toBeGreaterThan(0);
    });

    it('names a budget in the hint that actually works', () => {
        const w = wire(f.bytes);
        const small = search(w.resolver, w.blocks, 'alphaterm', { budget: 100 });
        expect(small.returned, 'a 100-character budget fits no hit').toBe(0);
        const named = /needs (\d+)/.exec(small.hint);
        expect(named, `the hint must name the budget that would work: ${JSON.stringify(small.hint)}`)
            .not.toBeNull();
        const needed = Number(at(named ?? [], 1, 'hint capture'));
        const retry = search(w.resolver, w.blocks, 'alphaterm', { budget: needed });
        expect(retry.returned, `following the hint's own budget of ${needed} must return a hit; a recovery `
            + 'instruction that comes back empty a second time is worse than none').toBeGreaterThan(0);
        const below = search(w.resolver, w.blocks, 'alphaterm', { budget: needed - 1 });
        expect(below.returned, `${needed} must be the SMALLEST budget that works, so ${needed - 1} returns none`)
            .toBe(0);
    });

    it('spends more of a growing budget on more hits, monotonically', () => {
        const w = wire(f.bytes);
        let previous = 0;
        for (const budget of [300, 600, 1_200, 2_400, 4_800]) {
            const r = search(w.resolver, w.blocks, 'alphaterm', { budget });
            expect(r.returned, `budget ${budget} must not return fewer hits than a smaller budget did`)
                .toBeGreaterThanOrEqual(previous);
            previous = r.returned;
        }
        expect(previous, 'a large budget must reach the default page size').toBeGreaterThan(1);
    });
});

// ── ranking, as properties ────────────────────────────────────────────────

describe('ranking is a property of the scorer, not of the order records were found', () => {
    it('ranks a record matching more distinct terms above one matching fewer at equal total frequency', () => {
        const filler = Array.from({ length: 30 }, (_, i) => `{"t":"fillerword${i}"}`);
        const f = rowsFixture([
            '{"v":"alphaone betatwo gammathree"}',
            '{"v":"alphaone alphaone alphaone"}',
            ...filler,
        ]);
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'alphaone betatwo gammathree', { budget: BIG_BUDGET, limit: 20 });
        const hits = r.hits;
        expect(hits.length, 'both records must be returned').toBeGreaterThanOrEqual(2);
        const broad = hits.findIndex((h) => h.pointer === '/rows/0');
        const deep = hits.findIndex((h) => h.pointer === '/rows/1');
        expect(broad >= 0 && deep >= 0, 'both records must be in the page').toBe(true);
        expect(broad, 'three distinct terms at total frequency 3 must outrank one term repeated 3 times — that '
            + 'is what the tanh SoftAND coordination bonus is for').toBeLessThan(deep);
    });

    it('does not let 200 repetitions of one term bury the record that matched every term', () => {
        const shout = Array.from({ length: 200 }, () => 'alphaone').join(' ');
        const filler = Array.from({ length: 30 }, (_, i) => `{"t":"fillerword${i}"}`);
        const f = rowsFixture([
            '{"a":"alphaone","b":"betatwo","c":"gammathree"}',
            `{"a":"${shout}"}`,
            ...filler,
        ]);
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'alphaone betatwo gammathree', { budget: BIG_BUDGET, limit: 20 });
        const all = at(r.hits, 0, 'top hit');
        expect(all.pointer, 'the record matching all three terms must rank first; tanh saturates each term\'s '
            + 'contribution so the bonus counts HOW MANY terms fired, not how hard one did').toBe('/rows/0');
        expect(all.matched.length, 'and it must be credited with all three').toBe(3);
    });

    it('scores two identical records identically wherever they sit, because df is global (T2)', () => {
        // Block-local idf put two documents with identical term frequencies 1.6x
        // apart in score purely by block membership.
        const filler = (i: number) => `{"a":"aa${String(i).padStart(6, '0')}","p":"${'z'.repeat(220)}"}`;
        const target = '{"a":"alphaterm","p":"identical payload for both copies"}';
        const records: string[] = [target];
        for (let i = 0; i < 900; i++) records.push(filler(i));
        records.push(target);
        const f = rowsFixture(records);
        const w = wire(f.bytes);
        expect(w.blocks.blockCount, 'the two copies must land in different blocks').toBeGreaterThan(2);
        const firstBlock = Math.floor(at(f.spans, 0, 'span')[0] / SEARCH_BLOCK_BYTES);
        const lastBlock = Math.floor(at(f.spans, records.length - 1, 'span')[0] / SEARCH_BLOCK_BYTES);
        expect(lastBlock, 'the copies must be in different blocks or the test proves nothing')
            .toBeGreaterThan(firstBlock);

        const r = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 10 });
        expect(r.totalMatches, 'both copies must match').toBe(2);
        const a = at(r.hits, 0, 'hit');
        const b = at(r.hits, 1, 'hit');
        expect(b.relevance, `identical records must calibrate identically: ${a.pointer} scored ${a.relevance} `
            + `and ${b.pointer} scored ${b.relevance}; a gap here means a block-local statistic entered the score`)
            .toBe(a.relevance);
        expect(b.score, 'and their fused scores must match too').toBe(a.score);
    });

    it('does not make every record novel because one member holds a unique id', () => {
        const records = Array.from({ length: 60 }, (_, i) =>
            `{"uuid":"${String(i).padStart(4, '0')}-aaaa-bbbb-cccc-dddddddddddd","s":"alphaterm"}`);
        const f = rowsFixture(records);
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 60 });
        expect(r.totalMatches, 'every record matches').toBe(60);
        const novel = r.hits.filter((h) => h.novelty > 0);
        expect(novel.length, `a high-cardinality id member must not lift novelty: ${novel.length} of `
            + `${r.returned} records scored above 0, and scoring them all equally novel is the same as `
            + 'scoring nothing').toBe(0);
    });

    it('reports novelty 0 below MIN_NOVELTY_POPULATION rather than a rank the sample cannot support', () => {
        // Structurally distinct records: if the channel ran, they would not tie.
        const shapes = [
            '{"a":"alphaterm"}',
            '{"a":"alphaterm","b":1}',
            '{"a":"alphaterm","c":true}',
            '{"a":"alphaterm","d":null,"e":2}',
            '{"a":"alphaterm","f":"x","g":"y","h":"z"}',
        ];
        const small = wire(rowsFixture(shapes).bytes);
        const rs = search(small.resolver, small.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 20 });
        expect(rs.totalMatches, `${shapes.length} records must all match`).toBe(shapes.length);
        expect(rs.totalMatches, 'the population must sit below MIN_NOVELTY_POPULATION')
            .toBeLessThan(MIN_NOVELTY_POPULATION);
        expect(rs.hits.every((h) => h.novelty === 0), 'the top of any population calibrates to 1.0, so a '
            + `population under ${MIN_NOVELTY_POPULATION} must report 0 rather than declare one of a handful `
            + 'maximally unusual').toBe(true);

        const many = [...shapes];
        for (let i = 0; i < 8; i++) many.push(`{"a":"alphaterm","k${i}":${i}}`);
        const big = wire(rowsFixture(many).bytes);
        const rb = search(big.resolver, big.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 40 });
        expect(rb.totalMatches, 'the larger population must clear the floor')
            .toBeGreaterThanOrEqual(MIN_NOVELTY_POPULATION);
        expect(rb.hits.some((h) => h.novelty > 0), 'above the floor the structural channel must actually score '
            + 'a population that is genuinely irregular').toBe(true);
    });

    it('weights the fused score lexical-dominant at LEXICAL_WEIGHT', () => {
        const records = Array.from({ length: 30 }, (_, i) => `{"s":"alphaterm","n":${i},"k${i % 3}":${i}}`);
        const f = rowsFixture(records);
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 30 });
        for (const h of r.hits) {
            const fused = LEXICAL_WEIGHT * h.relevance + (1 - LEXICAL_WEIGHT) * h.novelty;
            expect(Math.abs(h.score - fused), `score of ${h.pointer} must be ${LEXICAL_WEIGHT} lexical plus `
                + `${(1 - LEXICAL_WEIGHT).toFixed(1)} novelty: reported ${h.score}, computed ${fused}`)
                .toBeLessThan(0.002);
        }
    });

    it('orders hits by descending score with a deterministic tiebreak', () => {
        const rng = mulberry32(0x51de);
        const records = Array.from({ length: 80 }, (_, i) => {
            const reps = 1 + Math.floor(rng() * 4);
            return `{"n":${i},"v":"${Array.from({ length: reps }, () => 'alphaterm').join(' ')}"}`;
        });
        const f = rowsFixture(records);
        const w = wire(f.bytes);
        const first = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 40 });
        const again = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 40 });
        expect(again.hits.map((h) => h.pointer), 'two identical searches must return the same order (seed 0x51de)')
            .toEqual(first.hits.map((h) => h.pointer));
        for (let i = 1; i < first.hits.length; i++) {
            expect(at(first.hits, i, 'hit').score, `hit ${i} must not outscore hit ${i - 1}`)
                .toBeLessThanOrEqual(at(first.hits, i - 1, 'hit').score);
        }
        for (let i = 0; i < first.hits.length; i++) {
            expect(at(first.hits, i, 'hit').rank, 'rank must be the one-based position in the page').toBe(i + 1);
        }
    });
});

// ── T4: percentile calibration before fusion ──────────────────────────────

describe('relevance and novelty are percentile-calibrated, not min-max normalised', () => {
    /**
     * A population whose raw lexical scores are all distinct: record i carries
     * i+1 copies of the term, and BM25 is strictly increasing in tf at fixed
     * length. Percentile rank over n distinct values is exactly {i/(n-1)},
     * evenly spaced by 1/(n-1). Min-max over BM25's saturating curve is not:
     * `tf(k1+1)/(tf + k1(...))` is concave, so its normalised values bunch
     * toward the top.
     */
    function gradedFixture(n: number): Fixture {
        return rowsFixture(Array.from({ length: n }, (_, i) =>
            `{"n":${i},"v":"${Array.from({ length: i + 1 }, () => 'alphaterm').join(' ')}"}`));
    }

    it('spaces relevance evenly over a population of distinct scores', () => {
        const n = 40;
        const f = gradedFixture(n);
        const w = wire(f.bytes);
        const hits = allHits(w, 'alphaterm', { budget: BIG_BUDGET, limit: 10 });
        expect(hits.length, 'paging must reach every record').toBe(n);

        const rels = [...new Set(hits.map((h) => h.relevance))].sort((a, b) => a - b);
        expect(rels.length, `all ${n} scores are distinct, so all ${n} percentile ranks must be`).toBe(n);
        const step = 1 / (n - 1);
        for (let i = 0; i < rels.length; i++) {
            expect(Math.abs(at(rels, i, 'relevance') - i * step),
                `percentile rank ${i} of ${n} must be ${(i * step).toFixed(3)}, not `
                + `${at(rels, i, 'relevance')}; min-max normalisation of a saturating BM25 curve bunches these `
                + 'toward the top instead of spacing them evenly').toBeLessThan(0.001);
        }
        expect(at(rels, rels.length - 1, 'top relevance'), 'the top of the population calibrates to 1').toBe(1);
        expect(at(rels, 0, 'bottom relevance'), 'the bottom calibrates to 0').toBe(0);
    }, 60_000);

    it('is approximately uniform over a large hit set rather than clustered', () => {
        const n = 60;
        const f = gradedFixture(n);
        const w = wire(f.bytes);
        const rels = allHits(w, 'alphaterm', { budget: BIG_BUDGET, limit: 12 })
            .map((h) => h.relevance).sort((a, b) => a - b);
        expect(rels.length, 'paging must reach every record').toBe(n);
        // Kolmogorov-Smirnov style: the largest gap between the empirical CDF and
        // the uniform CDF. Percentile rank IS the uniform CDF by construction, so
        // this is small; min-max leaves a visible bulge.
        let worst = 0;
        for (let i = 0; i < n; i++) {
            worst = Math.max(worst, Math.abs(at(rels, i, 'relevance') - i / (n - 1)));
        }
        expect(worst, `the relevance distribution must track uniform to within a rank; worst deviation ${worst}`)
            .toBeLessThan(2 / (n - 1));
    }, 60_000);

    it('collapses a large group of identical records onto one rank instead of spreading them', () => {
        const boilerplate = Array.from({ length: 40 }, (_, i) => `{"n":${i},"v":"alphaterm"}`);
        const standout = '{"v":"alphaterm alphaterm alphaterm alphaterm alphaterm"}';
        const f = rowsFixture([...boilerplate, standout]);
        const w = wire(f.bytes);
        const hits = allHits(w, 'alphaterm', { budget: BIG_BUDGET, limit: 50 });
        expect(hits.length, 'every record must match').toBe(41);
        const tail = hits.filter((h) => h.pointer !== `/rows/${boilerplate.length}`);
        expect(new Set(tail.map((h) => h.relevance)).size,
            'ties must share the rank of the first member of their group, so identical boilerplate calibrates to '
            + 'one value rather than spreading across [0,1] in scan order').toBe(1);
        expect(at(tail, 0, 'boilerplate hit').relevance, '40 identical records at the bottom calibrate to 0')
            .toBe(0);
    }, 60_000);

    it('leaves both channels inside [0,1]', () => {
        const f = gradedFixture(50);
        const w = wire(f.bytes);
        for (const h of allHits(w, 'alphaterm', { budget: BIG_BUDGET, limit: 15 })) {
            expect(h.relevance >= 0 && h.relevance <= 1, `relevance of ${h.pointer} is ${h.relevance}`).toBe(true);
            expect(h.novelty >= 0 && h.novelty <= 1, `novelty of ${h.pointer} is ${h.novelty}`).toBe(true);
            expect(h.score >= 0 && h.score <= 1, `score of ${h.pointer} is ${h.score}`).toBe(true);
        }
    }, 60_000);
});

// ── the query side ────────────────────────────────────────────────────────

describe('the query the pipeline sees is the caller\'s query and nothing else', () => {
    it('names in the hint exactly the terms it searched, never the corpus vocabulary', () => {
        // Building the query as `factsQuery + " " + corpusTerms` drives the
        // coordination bonus's 1/m to zero. The hint enumerates what was
        // searched, so a corpus-augmented query would be visible in it.
        const records = Array.from({ length: 40 }, (_, i) => `{"a":"alphaterm","n":${i},"z":"uniqueword${i}"}`);
        const f = rowsFixture(records);
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'alphaterm betaterm', { budget: BIG_BUDGET, limit: 5 });
        const named = /Terms searched: "([^"]*)"/.exec(r.hint);
        expect(named, `the hint must name the terms searched: ${JSON.stringify(r.hint)}`).not.toBeNull();
        const listed = at(named ?? [], 1, 'hint capture').split(' ').filter((s) => s.length > 0);
        expect(listed, 'the term list must be the query\'s own terms, in query order')
            .toEqual(searchTerms('alphaterm betaterm'));
        expect(listed.length, 'a corpus-augmented query would make m the size of the vocabulary and neuter the '
            + `coordination bonus; the document holds ${records.length} unique words`).toBe(2);
    });

    it('drops stopwords only when a discriminating term survives, and says so', () => {
        const f = rowsFixture(Array.from({ length: 20 }, (_, i) => `{"v":"the alphaterm ${i}"}`));
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'the alphaterm', { budget: BIG_BUDGET, limit: 5 });
        expect(r.totalMatches, 'the discriminating term still answers').toBe(20);
        expect(r.hint, 'the hint must say which words were dropped').toContain('dropped');
        for (const h of r.hits) {
            expect(h.matched, 'a dropped stopword must not appear as a matched term').not.toContain('the');
        }
        expect(searchTerms('the alphaterm'), 'searchTerms must show the same reduction the search used')
            .toEqual(['alphaterm']);
    });

    it('keeps SEARCH_STOPWORDS a query-side list the index never sees', () => {
        const f = rowsFixture(['{"v":"the and of alphaterm"}']);
        const w = wire(f.bytes);
        for (const word of ['the', 'and', 'of']) {
            expect(SEARCH_STOPWORDS.has(word), `${word} must be a stopword`).toBe(true);
            expect(w.blocks.df(word), `the index must still hold ${word}: an analyser mismatch between the two `
                + 'sides is what a query-side-only list avoids').toBeGreaterThan(0);
        }
    });

    it('weights a repeated query term more heavily than a single mention', () => {
        const f = rowsFixture([
            '{"v":"alphaterm alphaterm betaterm"}',
            '{"v":"betaterm betaterm alphaterm"}',
            ...Array.from({ length: 20 }, (_, i) => `{"t":"fillerword${i}"}`),
        ]);
        const w = wire(f.bytes);
        const plain = search(w.resolver, w.blocks, 'alphaterm betaterm', { budget: BIG_BUDGET, limit: 10 });
        const leaning = search(w.resolver, w.blocks, 'alphaterm alphaterm betaterm', { budget: BIG_BUDGET, limit: 10 });
        expect(plain.totalMatches, 'both records match either way').toBe(2);
        expect(leaning.totalMatches, 'repetition is a weight, not a filter').toBe(2);
        expect(at(leaning.hits, 0, 'top hit').pointer,
            'repeating a term in the query must move the record that carries it more to the top')
            .toBe('/rows/0');
    });
});

// ── the failure taxonomy ──────────────────────────────────────────────────

describe('unanswerable queries fail inside the closed StrideFailure set', () => {
    const w = wire(rowsFixture(['{"v":"alphaterm"}']).bytes);

    function failureOf(query: string): StrideError {
        try {
            const r = search(w.resolver, w.blocks, query, { budget: 4_000 });
            throw new Error(`search(${JSON.stringify(query)}) returned instead of failing: `
                + `${r.totalMatches} matches, ${r.returned} returned`);
        } catch (e) {
            if (e instanceof StrideError) return e;
            throw new Error(`search(${JSON.stringify(query)}) threw a bare Error, not a StrideError: ${String(e)}`);
        }
    }

    it('answers an empty query with empty_query and a populated recovery', () => {
        for (const query of ['', '   ', '\t\n']) {
            const e = failureOf(query);
            expect(e.failure, `${JSON.stringify(query)} must fail as empty_query`).toBe('empty_query');
            expect(e.recovery.length, `${JSON.stringify(query)} must name a recovery`).toBeGreaterThan(0);
            expect(e.name, 'the error must identify itself as a StrideError').toBe('StrideError');
        }
    });

    it('answers an all-stopword query with empty_query naming the words it refused', () => {
        const e = failureOf('the and of that with');
        expect(e.failure, 'a query of nothing but stopwords is empty_query, not a full document scan')
            .toBe('empty_query');
        expect(e.message, 'the message must name the words that made it unanswerable').toContain('the');
        expect(e.recovery.length, 'and it must name a recovery').toBeGreaterThan(0);
    });

    it('answers a punctuation-only query with empty_query rather than a bare Error', () => {
        for (const query of ['...', '!!! ???', '@@@', '- - -', '/', '{}[],:']) {
            const e = failureOf(query);
            expect(e.failure, `${JSON.stringify(query)} produces no terms, so it is empty_query`)
                .toBe('empty_query');
            expect(e.recovery.length, `${JSON.stringify(query)} must name a recovery`).toBeGreaterThan(0);
        }
    });

    it('answers a term that matches nothing with a complete result, not a failure', () => {
        const r = search(w.resolver, w.blocks, 'nosuchtermanywhere', { budget: 4_000 });
        expect(r.totalMatches, 'a term with no occurrences is zero matches, not an error').toBe(0);
        expect(r.hits.length, 'and no hits').toBe(0);
        expect(r.hint, 'the hint must say the answer was exhaustive rather than a shortcut')
            .toContain('exhaustive');
    });
});

// ── paging and the pool ───────────────────────────────────────────────────

describe('paging covers every rank the query answers, exactly once', () => {
    it('pages through every match without a gap or a repeat at the default page size', () => {
        const n = 120;
        const f = rowsFixture(Array.from({ length: n }, (_, i) =>
            `{"n":${i},"v":"${Array.from({ length: (i % 7) + 1 }, () => 'alphaterm').join(' ')}"}`));
        const w = wire(f.bytes);
        const expected = trueMatches(f, ['alphaterm']);
        expect(expected.size, 'every record must match').toBe(n);

        const seen: string[] = [];
        let offset = 0;
        for (let page = 0; page < 100 && offset < n; page++) {
            const r = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 10, offset });
            expect(r.totalMatches, `totalMatches must be stable across pages (page ${page})`).toBe(n);
            expect(r.returned, `page ${page} at offset ${offset} must return hits while matches remain; `
                + `${n} is inside RANK_DEPTH_MAX (${RANK_DEPTH_MAX}) so every match is addressable by rank`)
                .toBeGreaterThan(0);
            for (const h of r.hits) seen.push(h.pointer);
            offset += r.returned;
        }
        expect(new Set(seen).size, `paging must cover all ${n} matches; it saw ${seen.length} hits over `
            + `${new Set(seen).size} distinct records`).toBe(n);
        expect(seen.length, 'and must not repeat a record across pages').toBe(n);
    }, 120_000);

    /**
     * A document whose match count is large enough for the ranking to drift.
     *
     * 800 is not decoration. The pool used to be `max(256, 4 * (offset+limit))`,
     * so it only started changing between pages once `4 * (offset+limit)` passed
     * 256 AND stayed under the match count — which at limit 10 means offsets
     * from 55 up, and needs the match count to be well past 256 before the
     * changing pool changes the ranking. At 120 matches, the count the test
     * above uses, the pool covers everything from the second page onward and no
     * drift is possible. At 800 the walk returned 800 hits over 752 distinct
     * records: 48 shown twice, 48 never shown.
     */
    const DRIFT_N = 800;

    function driftFixture(count: number): Fixture {
        return rowsFixture(Array.from({ length: count }, (_, i) =>
            `{"n":${i},"v":"${Array.from({ length: (i % 7) + 1 }, () => 'alphaterm').join(' ')}"}`));
    }

    /** Every pointer the walk delivered, in the order the pages delivered them. */
    function walkPages(w: Wired, query: string, limit: number, cap: number): string[] {
        const seen: string[] = [];
        let offset = 0;
        for (let page = 0; page < cap; page++) {
            const r = search(w.resolver, w.blocks, query, { budget: BIG_BUDGET, limit, offset });
            if (r.returned === 0) break;
            for (const h of r.hits) seen.push(h.pointer);
            offset += r.returned;
            if (offset >= r.totalMatches) break;
        }
        return seen;
    }

    it('pages through a match count large enough for the ranking to drift', () => {
        const f = driftFixture(DRIFT_N);
        const w = wire(f.bytes);
        expect(DRIFT_N, 'the fixture must exceed the novelty pool or the old sizing could not drift')
            .toBeGreaterThan(NOVELTY_POOL_CAP);
        expect(DRIFT_N, 'and must sit inside the addressable depth, or a gap here would be the stated limit')
            .toBeLessThanOrEqual(RANK_DEPTH_MAX);

        const seen = walkPages(w, 'alphaterm', 10, 200);
        const distinct = new Set(seen);
        expect(distinct.size, `paging must cover all ${DRIFT_N} matches; the walk saw ${seen.length} hits over `
            + `${distinct.size} distinct records, so ${DRIFT_N - distinct.size} were never shown`).toBe(DRIFT_N);
        expect(seen.length, `and must not repeat a record: ${seen.length - distinct.size} came back twice`)
            .toBe(DRIFT_N);
    }, 300_000);

    it('delivers the same order however the pages are cut', () => {
        // The direct statement of the defect: if the ranking depends on the
        // offset that asked for it, two page sizes walk the records in
        // different orders, and either order is missing some of them.
        const f = driftFixture(DRIFT_N);
        const w = wire(f.bytes);
        const byTen = walkPages(w, 'alphaterm', 10, 200);
        const byThirty = walkPages(w, 'alphaterm', 30, 200);
        expect(byThirty.length, 'the two walks covered different numbers of records').toBe(byTen.length);
        const firstDiff = byTen.findIndex((p, i) => p !== byThirty[i]);
        expect(firstDiff, `the two walks disagree from rank ${firstDiff}: at limit 10 it is `
            + `${JSON.stringify(byTen[firstDiff])}, at limit 30 ${JSON.stringify(byThirty[firstDiff])}`).toBe(-1);
    }, 300_000);

    it('still fuses the novelty channel when the match set is larger than the pool', () => {
        // Past NOVELTY_POOL_CAP the page comes from a longer lexical list than
        // the pool, and the fused pool has to REPLACE the head of it. Computing
        // the fusion and then paging the unfused list would leave every hit on
        // the first page scored 0 and the structural channel dead for any query
        // matching more than NOVELTY_POOL_CAP records.
        //
        // Key names are the same length in both shapes on purpose. BM25
        // normalises by record length, so an unusual record that is also longer
        // scores lower lexically, falls out of the top of the pool, and never
        // reaches the channel that would have lifted it — which is what a first
        // attempt at this fixture measured: novelty 0 across the whole page.
        const pad = (i: number): string => String(i).padStart(6, '0');
        const n = 600;
        const f = rowsFixture(Array.from({ length: n }, (_, i) =>
            i % 37 === 0 ? `{"a":"alphaterm","z":"${pad(i)}"}` : `{"a":"alphaterm","n":"${pad(i)}"}`));
        const w = wire(f.bytes);
        expect(n, 'the fixture must exceed the pool or the head and the page are the same list')
            .toBeGreaterThan(NOVELTY_POOL_CAP);

        const r = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 20 });
        expect(r.totalMatches, 'every record must match').toBe(n);
        const top = r.hits[0];
        expect(top, 'the first page returned no hits at all').toBeDefined();
        if (top === undefined) return;
        expect(top.novelty, 'the highest-ranked hit carries no novelty, so the fused pool never reached the page')
            .toBeGreaterThan(0);
        expect(top.score, 'the score is the lexical channel alone, so the fusion was discarded')
            .toBeGreaterThan(LEXICAL_WEIGHT * top.relevance);
        // The `z`-shaped records are the rare key-set, so they are the ones the
        // structural channel is supposed to lift.
        const lifted = r.hits.filter((h) => h.novelty > 0).map((h) => h.pointer);
        expect(lifted.length, 'no hit on the page was scored for novelty').toBeGreaterThan(0);
        for (const p of lifted) {
            const ordinal = Number(p.slice(p.lastIndexOf('/') + 1));
            expect(ordinal % 37, `${p} was lifted for novelty but it is one of the regular records`).toBe(0);
        }
    }, 120_000);

    it('states the addressable depth instead of offering a page that comes back empty', () => {
        const f = driftFixture(40);
        const w = wire(f.bytes);
        const full = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 40 });
        expect(full.returned, 'the whole match set must fit one page here').toBe(40);

        // Past the end. The recovery is a smaller offset, not a larger budget:
        // the old wording named a budget, and the budget was never the problem.
        const past = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 10, offset: 40 });
        expect(past.returned, 'an offset past the last rank must return nothing').toBe(0);
        expect(past.totalMatches, 'and must still report the true count').toBe(40);
        expect(past.hint, 'the hint blames the budget for an offset past the end')
            .not.toContain('budget 0 or more');
        expect(past.hint, 'the hint does not say the offset is past the last rank').toContain('past the last rank');
        expect(past.hint, 'the hint does not name the last rank to go back to').toContain('offset 39');
    }, 120_000);

    it('never offers a next page past the depth it can rank, and says what is left', () => {
        // The one case where `totalMatches` and the addressable depth differ.
        // Offering `offset + returned` here would name a page that comes back
        // empty, so the hint has to switch from "next page" to "this is the
        // bottom, and this many matched below it".
        const extra = 40;
        const n = RANK_DEPTH_MAX + extra;
        const f = rowsFixture(Array.from({ length: n }, (_, i) =>
            `{"a":"alphaterm","n":"${String(i).padStart(6, '0')}"}`));
        const w = wire(f.bytes);

        const last = search(w.resolver, w.blocks, 'alphaterm',
            { budget: BIG_BUDGET, limit: 10, offset: RANK_DEPTH_MAX - 10 });
        expect(last.totalMatches, 'the count must cover the whole document, not the rankable part').toBe(n);
        expect(last.returned, 'the last addressable page must still deliver its hits').toBe(10);
        expect(last.hint, 'the hint offers a next page that would come back empty')
            .not.toContain('to fetch the next page');
        expect(last.hint, 'the hint does not say how deep ranking goes').toContain(`${RANK_DEPTH_MAX} highest-ranked`);
        expect(last.hint, 'the hint does not say how many matched below the addressable depth')
            .toContain(`remaining ${extra} matched`);

        const past = search(w.resolver, w.blocks, 'alphaterm',
            { budget: BIG_BUDGET, limit: 10, offset: RANK_DEPTH_MAX });
        expect(past.returned, 'an offset at the depth bound must return nothing').toBe(0);
        expect(past.hint, 'the hint does not say the offset is past the last rank').toContain('past the last rank');
        expect(past.hint, 'the hint does not name the last rank to go back to')
            .toContain(`offset ${RANK_DEPTH_MAX - 1}`);
    }, 300_000);

    it('holds the novelty pool at SHAPE_SAMPLE, and holds it independent of the page asked for', () => {
        expect(NOVELTY_POOL_CAP, 'the pool and the census sample must be the same order of size')
            .toBe(SHAPE_SAMPLE);
        // A pool that grows with the request is how the ranking became a
        // function of the offset. The cap is the fix, so the cap has to be a
        // constant — and the depth bound has to leave room to page past it.
        expect(RANK_DEPTH_MAX, 'paging must reach past the novelty pool or the pool is a page limit')
            .toBeGreaterThan(NOVELTY_POOL_CAP);
    });

    it('reports truncated exactly when matches remain beyond the page', () => {
        const f = rowsFixture(Array.from({ length: 30 }, (_, i) => `{"n":${i},"v":"alphaterm"}`));
        const w = wire(f.bytes);
        const short = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 5 });
        expect(short.truncated, `5 of ${short.totalMatches} shown must report truncated`).toBe(true);
        expect(short.hint, 'and the hint must name the next page').toContain('offset');
        const full = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET, limit: 100 });
        expect(full.returned, 'a limit above the match count must return every match').toBe(full.totalMatches);
        expect(full.truncated, 'nothing remains, so nothing is truncated').toBe(false);
        expect(full.hint, 'and the hint must say no further call is needed').toContain('No further call');
    });

    it('caps a page at DEFAULT_SEARCH_LIMIT when the caller does not ask', () => {
        const f = rowsFixture(Array.from({ length: 200 }, (_, i) => `{"n":${i},"v":"alphaterm"}`));
        const w = wire(f.bytes);
        const r = search(w.resolver, w.blocks, 'alphaterm', { budget: BIG_BUDGET });
        expect(r.totalMatches, 'every record matches').toBe(200);
        expect(r.returned, `an unstated limit must not exceed DEFAULT_SEARCH_LIMIT (${DEFAULT_SEARCH_LIMIT})`)
            .toBeLessThanOrEqual(DEFAULT_SEARCH_LIMIT);
        expect(r.returned, 'and must still return something').toBeGreaterThan(0);
    });
});

// ── the route taken ───────────────────────────────────────────────────────

describe('the result says which route answered', () => {
    it('reports index when every term had a posting list and scan when one did not', () => {
        const { wired } = recall();
        expect(search(wired.resolver, wired.blocks, RARE, { budget: 20_000 }).path,
            'a fully indexed query is answered from postings').toBe('index');
        expect(search(wired.resolver, wired.blocks, UNADMITTED, { budget: 20_000 }).path,
            'a term with no posting list is answered by an exhaustive sweep, and the result must say so')
            .toBe('scan');
        expect(search(wired.resolver, wired.blocks, SPREAD, { budget: 20_000 }).path,
            'a dropped posting list is answered by the same sweep').toBe('scan');
    }, 120_000);

    it('answers a URL, which the byte indexer cannot produce, through the sweep', () => {
        const records = Array.from({ length: 30 }, (_, i) => `{"u":"https://ex.dev/page${i}","n":${i}}`);
        const f = rowsFixture(records);
        const w = wire(f.bytes);
        const url = 'https://ex.dev/page7';
        expect(w.blocks.has(url), 'the index never emits a scheme-qualified URL as one term').toBe(false);
        const r = search(w.resolver, w.blocks, url, { budget: BIG_BUDGET, limit: 40 });
        expect(r.path, 'so the query reaches the exhaustive route').toBe('scan');
        expect(new Set(r.hits.map((h) => h.pointer)).has('/rows/7'),
            'and the record holding the URL must come back').toBe(true);
    });
});

// ── the constants are what they claim ─────────────────────────────────────

describe('the tuning constants hold the values their reasons are written for', () => {
    it('uses the unmodified Lucene BM25 defaults', () => {
        expect(BM25_K1, 'k1 is the Lucene default').toBe(1.5);
        expect(BM25_B, 'b is the Lucene default').toBe(0.75);
    });

    it('keeps the verify window at one search block', () => {
        expect(RECORD_VERIFY_BYTES, 'the verify window is the span the index already tokenises in one pass')
            .toBe(SEARCH_BLOCK_BYTES);
    });

    it('holds the lexical channel dominant', () => {
        expect(LEXICAL_WEIGHT, 'lexical-dominant fusion restored 16W/5L where graph-dominant measured 36W/81L')
            .toBe(0.7);
        expect(LEXICAL_WEIGHT, 'and it must genuinely dominate').toBeGreaterThan(0.5);
    });

    it('reproduces the arithmetic the stopword list is justified by', () => {
        // A term naming every one of N blocks has df = N, so its Lucene idf is
        // ln(1 + 0.5/(N + 0.5)); a term naming 1% of them has df = N/100.
        const n = 9_600;
        const idf = (df: number): number => Math.log((n - df + 0.5) / (df + 0.5) + 1);
        expect(idf(n), 'a term naming every block scores 5.2e-5 of idf').toBeCloseTo(5.2e-5, 6);
        expect(idf(n / 100), 'a term naming 1% of blocks scores 4.6').toBeCloseTo(4.6, 1);
        expect(Math.log10(idf(n / 100) / idf(n)), 'the gap is about five orders of magnitude')
            .toBeGreaterThan(4.5);
    });

    it('reproduces the arithmetic MIN_NOVELTY_POPULATION is justified by', () => {
        expect(Math.log(2) / Math.log(1000), 'a gram unique among two siblings scores 0.10 of raw surprisal')
            .toBeCloseTo(0.10, 2);
        expect(MIN_NOVELTY_POPULATION, 'so the floor sits well above two').toBeGreaterThan(2);
    });

    it('costs about 120 characters for a full offsets list', () => {
        const offsets = Array.from({ length: HIT_OFFSETS_MAX }, (_, i) => 100_000 + i * 37);
        const cost = JSON.stringify({ offsets }).length;
        expect(cost, `HIT_OFFSETS_MAX six-digit offsets serialise to ${cost} characters, claimed ~120`)
            .toBeGreaterThan(100);
        expect(cost, `HIT_OFFSETS_MAX six-digit offsets serialise to ${cost} characters, claimed ~120`)
            .toBeLessThan(150);
    });

    it('reports an empty hits array at exactly MIN_RESULT_CHARS', () => {
        expect(JSON.stringify([]).length, 'no JSON payload is shorter than the two characters of an empty array')
            .toBe(MIN_RESULT_CHARS);
    });
});

// ── the rates the module's comments quote ─────────────────────────────────

describe('the rates this module\'s cost is made of', () => {
    function median(xs: readonly number[]): number {
        const s = [...xs].sort((a, b) => a - b);
        return at(s, Math.floor(s.length / 2), 'median');
    }

    /** GB/s, median of five after warm-up. */
    function gigabytesPerSecond(reps: number, bytes: number, work: () => void): number {
        for (let i = 0; i < Math.min(reps, 500); i++) work();
        const rates: number[] = [];
        for (let r = 0; r < 5; r++) {
            const t = process.hrtime.bigint();
            for (let i = 0; i < reps; i++) work();
            rates.push((reps * bytes) / Number(process.hrtime.bigint() - t));
        }
        return median(rates);
    }

    // This loop is a local copy of the fold in search.ts, so its rate measures the
    // HOST, not the module. The header above quotes 0.42 GB/s on node v22.23.2;
    // the machine this was last run on folds the same loop at 1.62-1.69 GB/s idle
    // and 1.51 under a full-suite load — 3.9x the reference, from clock and codegen
    // alone. A band drawn around one machine's figure therefore fails on faster
    // hardware while proving nothing about search.ts.
    //
    // What survives a change of host is that the body actually touched all `size`
    // bytes. The rate is computed from `bytes`, not from anything the body did, so
    // an elided body still reports one: measured on this host, an empty body reads
    // 2,906 GB/s and a body touching a single byte 1,509 GB/s, against 1.5 for the
    // real fold. The 10 GB/s ceiling sits ~150x under the cheaper of those two
    // elisions and ~6x over the fastest honest reading; a scalar per-byte loop
    // carrying a bounds check and two comparisons cannot reach it (10 GB/s is
    // ~0.1 ns/byte, about 3 bytes per cycle at 3.5 GHz). Crossing it means the
    // measurement stopped measuring. The 0.15 floor is the same guard downward.
    it('folds ASCII over 64 KiB chunks at a rate that proves it touched every byte', () => {
        const size = SEARCH_BLOCK_BYTES;
        const src = Buffer.allocUnsafe(size);
        for (let i = 0; i < size; i++) src[i] = 0x41 + (i % 58);
        const dst = Buffer.allocUnsafe(size);
        const rate = gigabytesPerSecond(1_000, size, () => {
            for (let i = 0; i < size; i++) {
                const b = src[i];
                dst[i] = b === undefined ? 0 : (b >= 0x41 && b <= 0x5a ? b + 0x20 : b);
            }
        });
        expect(rate, `the ASCII fold loop measured ${rate.toFixed(3)} GB/s (reference: 0.42 on the machine `
            + 'the header was written on); below 0.15 the loop is not folding at a rate any host explains')
            .toBeGreaterThan(0.15);
        expect(rate, `the ASCII fold loop measured ${rate.toFixed(3)} GB/s; above 10 the body cannot have `
            + 'touched all 65,536 bytes, so the harness is measuring an elided loop rather than a fold')
            .toBeLessThan(10);
    }, 120_000);

    it('searches a folded 64 KiB JSON window far faster than it folds it, and by a wide margin', () => {
        const records: string[] = [];
        let built = 0;
        for (let i = 0; built < SEARCH_BLOCK_BYTES + 400; i++) {
            const r = `{"id":"ord-${i}","status":"shipped","note":"routine record with filler text here"},`;
            records.push(r);
            built += r.length;
        }
        const window = Buffer.from(records.join('').slice(0, SEARCH_BLOCK_BYTES), 'utf8');
        const needle = Buffer.from('qzqzqzqzqzqzqz', 'utf8');
        expect(window.indexOf(needle), 'the needle must be absent for the no-hit rate').toBe(-1);
        const rate = gigabytesPerSecond(5_000, window.length, () => { window.indexOf(needle); });
        expect(rate, `Buffer.indexOf over a folded 64 KiB JSON window measured ${rate.toFixed(1)} GB/s; it is a `
            + 'skip search, so the per-haystack-byte rate exceeds memory bandwidth').toBeGreaterThan(10);

        // The pathological haystack the skip table cannot skip, for the spread.
        const cycling = Buffer.allocUnsafe(SEARCH_BLOCK_BYTES);
        for (let i = 0; i < cycling.length; i++) cycling[i] = 0x61 + (i % 26);
        const slow = gigabytesPerSecond(5_000, cycling.length, () => { cycling.indexOf(needle); });
        expect(slow, `the same call over an a-z cycling haystack measured ${slow.toFixed(1)} GB/s, so the rate is `
            + 'a property of the haystack and must be quoted with its condition').toBeLessThan(rate);
    }, 120_000);

    it('tokenises a record two orders of magnitude slower per byte than it searches one', () => {
        const record = Buffer.from(JSON.stringify({
            id: 'ord-1839201', status: 'shipped', warehouse: 'wh-7',
            note: 'routine record with filler text to reach about two hundred bytes of json payload here now',
        }), 'utf8');
        expect(record.length, 'the record must be about two hundred bytes').toBeGreaterThan(150);
        const scratch: string[] = [];
        const rate = gigabytesPerSecond(20_000, record.length, () => {
            scratch.length = 0;
            tokenizeBytes(record, 0, record.length, scratch);
        });
        const mib = rate * 1e9 / 1_048_576;
        expect(mib, `tokenizeBytes over a ${record.length} B record measured ${mib.toFixed(1)} MiB/s against a `
            + 'documented 42').toBeGreaterThan(15);
        expect(mib, `tokenizeBytes over a ${record.length} B record measured ${mib.toFixed(1)} MiB/s against a `
            + 'documented 42').toBeLessThan(150);
    }, 120_000);
});

// ── measured cost of the fixture this file is built on ────────────────────

describe('the recall fixture states its own cost', () => {
    it('builds, indexes and searches inside a bound worth writing down', () => {
        const { fixture, wired } = recall();
        const megabytes = fixture.bytes.length / 1_048_576;

        const stats = wired.blocks.stats;
        expect(stats.buildMs, 'the block index must build in seconds, not minutes').toBeLessThan(60_000);
        expect(stats.terms, 'a saturated dictionary holds exactly TERM_DICT_LIMIT terms').toBe(TERM_DICT_LIMIT);

        const sweep = ((): number => {
            for (let i = 0; i < 2; i++) scanTermBlocks(wired.source, UNADMITTED);
            const rates: number[] = [];
            for (let r = 0; r < 5; r++) {
                const t = process.hrtime.bigint();
                scanTermBlocks(wired.source, UNADMITTED);
                rates.push(fixture.bytes.length / Number(process.hrtime.bigint() - t));
            }
            return at([...rates].sort((a, b) => a - b), 2, 'sweep rate');
        })();
        expect(sweep, `the fallback sweep over ${megabytes.toFixed(2)} MiB measured ${sweep.toFixed(2)} GB/s; the `
            + 'exhaustive route has to be affordable or the missing contract is theoretical')
            .toBeGreaterThan(0.2);

        const latency = (query: string): number => {
            const rates: number[] = [];
            for (let r = 0; r < 5; r++) {
                const t = process.hrtime.bigint();
                search(wired.resolver, wired.blocks, query, { budget: 60_000, limit: 10 });
                rates.push(Number(process.hrtime.bigint() - t) / 1e6);
            }
            return at([...rates].sort((a, b) => a - b), 2, 'latency');
        };
        const indexed = latency(RARE);
        const missing = latency(UNADMITTED);
        expect(indexed, `an indexed term over ${megabytes.toFixed(2)} MiB took ${indexed.toFixed(1)} ms`)
            .toBeLessThan(2_000);
        expect(missing, `a dictionary-missing term over ${megabytes.toFixed(2)} MiB took ${missing.toFixed(1)} ms, `
            + 'which is the sweep plus the same verify pass').toBeLessThan(5_000);
    }, 300_000);
});

describe('a record\'s SIZE never changes whether it matches (I7 FULL RECALL)', () => {
    // Records above RECORD_VERIFY_BYTES are verified over a window centred on
    // their first LITERAL hit, and the literal sweep matches substrings. So a
    // record whose first hit is `error` inside `errors` is opened at a position
    // the tokeniser will correctly reject, and if the record's genuine token
    // occurrence lies more than half a window away it used to fall outside the
    // only bytes ever tokenised -- `matched` came back 0 and the record was
    // dropped from totalMatches, from every page, and from the hint's claim of
    // exhaustiveness.
    //
    // THE FIXTURE'S KEY ORDER IS LOAD-BEARING, and a first draft of these tests
    // got it wrong in a way worth recording. Building records with
    // `JSON.stringify({...payload, pad})` puts the pad LAST, which leaves the
    // rejected substring and the genuine token 28 bytes apart -- both inside any
    // window -- so every test passed with the fallback disabled. The pad has to
    // sit BETWEEN them. Each record below is therefore assembled by hand, in
    // order: the substring that opens the record, the pad that carries the
    // genuine token out of reach, then the term itself.

    /** `{"id":I,"msg":"<lead>","pad":"y…","level":"<tail>"}`, in that byte order. */
    function spread(id: number, lead: string, tail: string, padBytes: number): string {
        return `{"id":${id},"msg":${JSON.stringify(lead)},`
            + `"pad":"${'y'.repeat(padBytes)}","level":${JSON.stringify(tail)}}`;
    }

    const UNDER = 100;
    const OVER = RECORD_VERIFY_BYTES * 2;

    function answer(padBytes: number, query: string): {
        got: Set<string>; truth: Set<string>; matched: Map<string, string[]>; hits: StrideHit[];
    } {
        const fixture = rowsFixture([
            JSON.stringify({ id: 0, msg: 'error' }),
            spread(1, 'errors observed', 'error', padBytes),
            spread(2, 'zulu here', 'foxtrot', padBytes),
            JSON.stringify({ id: 3, msg: 'zulu only' }),
        ]);
        const w = wire(fixture.bytes, `pad-${padBytes}`);
        const hits = allHits(w, query, { budget: BIG_BUDGET, limit: 100 });
        return {
            got: new Set(hits.map((h) => h.pointer)),
            // `trueMatches` is the independent route: it tokenises each record's
            // whole span in ONE slice, sharing no code with the piecewise walk.
            truth: trueMatches(fixture, searchTerms(query)),
            matched: new Map(hits.map((h) => [h.pointer, [...h.matched].sort()])),
            hits,
        };
    }

    it('the paired fixture really does straddle the verify cap', () => {
        // Without this, a fixture that quietly sat under the cap would make every
        // assertion below vacuous -- which is exactly what a first draft did.
        const small = rowsFixture([spread(1, 'errors observed', 'error', UNDER)]);
        const big = rowsFixture([spread(1, 'errors observed', 'error', OVER)]);
        const smallSpan = at(small.spans, 0, 'span')[1] - at(small.spans, 0, 'span')[0];
        const bigSpan = at(big.spans, 0, 'span')[1] - at(big.spans, 0, 'span')[0];
        expect(smallSpan, `the small record is ${smallSpan} B and must be under ${RECORD_VERIFY_BYTES}`)
            .toBeLessThan(RECORD_VERIFY_BYTES);
        expect(bigSpan, `the big record is ${bigSpan} B and must be over ${RECORD_VERIFY_BYTES}`)
            .toBeGreaterThan(RECORD_VERIFY_BYTES);
        // And the genuine token must be further from the first literal hit than
        // half a window, or the window would contain it anyway.
        const firstHit = at(literalOccurrences(big.bytes, 'error'), 0, 'first literal hit');
        const occurrences = literalOccurrences(big.bytes, 'error');
        const genuine = at(occurrences, occurrences.length - 1, 'last literal hit');
        expect(
            genuine - firstHit,
            `the two occurrences are ${genuine - firstHit} B apart and the half-window is `
            + `${Math.floor(RECORD_VERIFY_BYTES / 2)}`,
        ).toBeGreaterThan(Math.floor(RECORD_VERIFY_BYTES / 2));
    });

    it('returns the same records whether the record is under or over the verify cap', () => {
        for (const query of ['error', 'zulu foxtrot', 'error zulu', 'observed']) {
            const under = answer(UNDER, query);
            const over = answer(OVER, query);
            expect(
                difference(under.truth, under.got),
                `under the cap, query ${JSON.stringify(query)} lost records`,
            ).toEqual([]);
            expect(
                difference(over.truth, over.got),
                `over the cap, query ${JSON.stringify(query)} lost ${difference(over.truth, over.got).length} `
                + 'records the same document under the cap returns; record size is not allowed to '
                + 'change the match set',
            ).toEqual([]);
            expect(
                difference(over.got, over.truth),
                `over the cap, query ${JSON.stringify(query)} invented records`,
            ).toEqual([]);
            expect(
                [...over.got].sort(),
                `the two sizes disagree: under ${JSON.stringify([...under.got].sort())} `
                + `over ${JSON.stringify([...over.got].sort())}`,
            ).toEqual([...under.got].sort());
        }
    });

    it('reports every query term the oversized record holds, however far apart they sit', () => {
        // `matched` is what the SoftAND coordination bonus is computed from, so a
        // record holding the whole query and reporting one term is not only
        // mislabelled -- it loses the bonus to records that hold less.
        const over = answer(OVER, 'zulu foxtrot');
        const under = answer(UNDER, 'zulu foxtrot');
        expect(
            over.matched.get('/rows/2'),
            'the oversized record holds both query terms, with the pad between them',
        ).toEqual(['foxtrot', 'zulu']);
        expect(
            over.matched.get('/rows/2'),
            'a term is reported for the oversized record exactly when it is for the small one',
        ).toEqual(under.matched.get('/rows/2'));
    });

    it('ranks the record holding the whole query above one holding part of it, at either size', () => {
        for (const [label, pad] of [['under', UNDER], ['over', OVER]] as const) {
            const { hits } = answer(pad, 'zulu foxtrot');
            const first = hits[0];
            expect(
                first === undefined ? 'no hits' : first.pointer,
                `${label} the cap, the record holding both terms must outrank the one holding `
                + `only "zulu"; got ${JSON.stringify(hits.map((h) => h.pointer))}`,
            ).toBe('/rows/2');
        }
    });

    it('crosses a run of word bytes wider than one verify piece without losing what follows', () => {
        // Two things at once, and both are needed to reach the walk at all. The
        // decoy is a LONGER word, so the first literal hit is one the tokeniser
        // rejects and the window settles nothing -- that is what makes the walk
        // run. The run is then wider than the piece the walk reads, so no piece
        // contains a byte an atom cannot span: the walk has to carry "still
        // inside a run" across pieces and resume at the run's end. Restarting
        // mid-run instead would emit a truncated atom and lose the real term.
        const run = 'y'.repeat(RECORD_VERIFY_BYTES * 3);
        const fixture = rowsFixture([
            `{"id":0,"decoy":"zulufoxtrotx","run":"${run}","after":"zulufoxtrot"}`,
        ]);
        const w = wire(fixture.bytes, 'long-run');
        const got = new Set(allHits(w, 'zulufoxtrot', { budget: BIG_BUDGET, limit: 100 }).map((h) => h.pointer));
        expect(
            [...got],
            `the term sits after a ${run.length}-byte unbroken run, past a decoy that opens the `
            + `record ${RECORD_VERIFY_BYTES} bytes earlier`,
        ).toEqual(['/rows/0']);
        expect(
            trueMatches(fixture, searchTerms('zulufoxtrot')),
            'and the independent whole-span tokenisation agrees the record holds the term',
        ).toEqual(new Set(['/rows/0']));
    });

    it('does not emit a term a fixed-stride cut would land exactly on top of', () => {
        // THE ALIGNMENT CASE, and the only one that shows why the cut has to be
        // boundary-aligned rather than merely tidy. A cut inside a run of word
        // bytes usually emits a harmless truncated atom, because the run
        // continues past the query term. Place the term so a fixed stride lands
        // exactly on its first byte AND the run ends immediately after it, and
        // the truncated atom is the query term itself -- a match the document
        // does not contain.
        //
        // Arithmetic, so the fixture cannot drift: `rowsFixture` opens with
        // `{"rows":[` and the record opens with `{"id":0,"run":"`, so the run's
        // z-bytes must be RECORD_VERIFY_BYTES minus that 15-byte prefix for
        // `error` to begin at record-relative offset RECORD_VERIFY_BYTES.
        const PREFIX = '{"id":0,"run":"';
        const filler = 'z'.repeat(RECORD_VERIFY_BYTES - PREFIX.length);
        const record = `${PREFIX}${filler}error"}`;
        const fixture = rowsFixture([record]);
        const recStart = at(fixture.spans, 0, 'span')[0];
        const errorAt = at(literalOccurrences(fixture.bytes, 'error'), 0, 'the planted occurrence');
        expect(
            errorAt - recStart,
            'the term must begin exactly one verify piece into the record, or a fixed-stride cut '
            + 'would not land on it and this fixture would prove nothing',
        ).toBe(RECORD_VERIFY_BYTES);
        expect(
            at(fixture.spans, 0, 'span')[1] - recStart,
            'and the record must be over the cap, so the windowed path is the one taken',
        ).toBeGreaterThan(RECORD_VERIFY_BYTES);

        const w = wire(fixture.bytes, 'aligned-cut');
        const got = new Set(allHits(w, 'error', { budget: BIG_BUDGET, limit: 100 }).map((h) => h.pointer));
        expect(
            trueMatches(fixture, searchTerms('error')),
            `"${filler.slice(0, 3)}...error" is one atom, so the independent whole-span `
            + 'tokenisation finds no match here',
        ).toEqual(new Set());
        expect(
            [...got],
            'the term sits inside a longer run and is not a token there; returning it would be a '
            + 'false positive manufactured by where the walk cut the record',
        ).toEqual([]);
    });

    it('does not match a term glued onto a long run, where it is not a token', () => {
        // The walk must not tokenise from a seam: an atom starting at a seam
        // rather than at a real token start can equal a query term the document
        // does not hold. `yyy...yerror` is ONE atom, so `error` is not in this
        // record and no cut may make it appear.
        const run = 'y'.repeat(RECORD_VERIFY_BYTES * 3);
        const fixture = rowsFixture([
            `{"id":0,"glued":"${run}error"}`,
            JSON.stringify({ id: 1, msg: 'error' }),
        ]);
        const w = wire(fixture.bytes, 'glued');
        const got = new Set(allHits(w, 'error', { budget: BIG_BUDGET, limit: 100 }).map((h) => h.pointer));
        expect(
            difference(got, trueMatches(fixture, searchTerms('error'))),
            `a term glued to a ${run.length}-byte run is not a token there, so matching it would be `
            + 'a false positive introduced by where the walk cut the record',
        ).toEqual([]);
        expect(got.has('/rows/1'), 'the record that does hold the term still matches').toBe(true);
    });
});
