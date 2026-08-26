// ---------------------------------------------------------------------------
// tests/stride/render.test.ts
//
// The property under test is never "the output looks reasonable". It is I3:
// `view.chars <= view.budget`, for every document, at every nesting depth,
// always. The implementation this module replaces emitted 196,845 tokens for a
// budget of 100 on a document of two 5,000-element arrays — a 1,968x overrun —
// and it did so while looking entirely reasonable, because it decided whether a
// member fitted by parsing the member. So the budget matrix below is
// exhaustive rather than illustrative: 6 documents x 7 budgets, every one of
// the 42 combinations asserted for both `chars <= budget` and `JSON.parse`,
// with the document and the budget named in the failure message so a red run
// needs no rerun to diagnose.
//
// The other assertions defend the invariants a bounded view can quietly break:
// that no truncation is silent (every marker matches MARKER_RE, every omission
// carries a decodable cursor and a span inside the node's own), that nothing is
// fabricated (a complete view deep-equals `JSON.parse` of the whole document),
// that a cut never lands mid-codepoint, and that raising the budget never
// reveals less.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { BufferSource, type StrideSource } from '../../src/core/stride/source.js';
import { StrideIndex } from '../../src/core/stride/index.js';
import { Resolver } from '../../src/core/stride/resolve.js';
import { decodeCursor } from '../../src/core/stride/cursor.js';
import { MARKER_RE, SCALAR_PREVIEW_BYTES, STRIDE_KEY, type StrideView } from '../../src/core/stride/types.js';
import { estimateChars, renderNode, renderWindow } from '../../src/core/stride/render.js';

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

function open(text: string, id: string): Resolver {
    const source = new BufferSource(Buffer.from(text, 'utf8'), id);
    return new Resolver(StrideIndex.build(source));
}

/**
 * A source that records the largest single `slice` it was asked for.
 *
 * This is how the module's headline rule gets tested rather than asserted:
 * "never materialise a span larger than the budget currently allotted to it".
 * Character assertions cannot see that rule, because the allocator ALSO measures
 * every parsed value exactly and rejects an over-budget one — so a renderer that
 * parsed a 590 KB member and then threw it away would still honour `chars <=
 * budget` while doing exactly the thing this module exists to stop.
 */
class WatchedSource implements StrideSource {
    readonly size: number;
    readonly id: string;
    maxSlice = 0;
    private readonly inner: BufferSource;

    constructor(bytes: Buffer, id: string) {
        this.inner = new BufferSource(bytes, id);
        this.size = this.inner.size;
        this.id = id;
    }

    slice(start: number, end: number): Buffer {
        const got = this.inner.slice(start, end);
        if (got.length > this.maxSlice) this.maxSlice = got.length;
        return got;
    }

    byteAt(i: number): number {
        return this.inner.byteAt(i);
    }

    sequential(from: number, to: number, onChunk: (chunk: Buffer, absolute: number) => void): void {
        // Not counted: `sequential` is the scanner's zero-copy read path over
        // bytes the caller already owns, which is what bounded memory permits.
        this.inner.sequential(from, to, onChunk);
    }

    close(): void {
        this.inner.close();
    }
}

/**
 * The document's size in the coordinate system STRIDE actually uses: UTF-8
 * BYTES. A JS string's `.length` counts UTF-16 code units, which for a document
 * of emoji and CJK is roughly half the byte count — comparing a span against it
 * would flag every correct span in the unicode fixture as out of range.
 */
function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

/** True for a string STRIDE emitted as an omission marker rather than content. */
function isMarker(value: unknown): boolean {
    return typeof value === 'string' && MARKER_RE.test(value);
}

/** Every string in a payload that is shaped like a marker but is not one. */
function malformedMarkers(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') {
        if (value.startsWith('[TRUNCATED') && !MARKER_RE.test(value)) out.push(value);
        return out;
    }
    if (Array.isArray(value)) {
        for (const v of value) malformedMarkers(v, out);
        return out;
    }
    if (value !== null && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) malformedMarkers(v, out);
    }
    return out;
}

/** Every marker string a payload carries, wherever it sits. */
function markersIn(value: unknown, out: string[] = []): string[] {
    if (isMarker(value)) { out.push(value as string); return out; }
    if (Array.isArray(value)) {
        for (const v of value) markersIn(v, out);
        return out;
    }
    if (value !== null && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) markersIn(v, out);
    }
    return out;
}

/**
 * Verbatim scalar leaves — everything in the payload that is NOT a marker. This
 * is the measure of "content shown", and it is what monotonicity is asserted
 * over: a marker is an addressed absence, so counting it as content would let a
 * view that replaced ten values with one marker look like progress.
 */
function contentLeaves(value: unknown, out: unknown[] = []): unknown[] {
    if (isMarker(value)) return out;
    if (Array.isArray(value)) {
        for (const v of value) contentLeaves(v, out);
        return out;
    }
    if (value !== null && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) contentLeaves(v, out);
        return out;
    }
    out.push(value);
    return out;
}

/**
 * Content shown, as a count of verbatim leaves — with the floor payload counted
 * as none.
 *
 * When not even one marker fits the budget, the payload is `null` and the
 * envelope carries an omission covering the whole span. That `null` is an
 * absence, not a document value, so counting it as a leaf would make the
 * smallest budget look like it showed one thing and the next budget up — which
 * can afford a real marker and so has NO verbatim leaves — look like a
 * regression. A document whose root genuinely is `null` renders with no
 * omissions at all and is still counted, which is the distinction that matters.
 */
function contentSize(view: StrideView): number {
    const [start, end] = view.envelope.span;
    const whole = view.envelope.omitted.some((o) => o.span[0] <= start && o.span[1] >= end);
    if (view.data === null && whole) return 0;
    return contentLeaves(view.data).length;
}

/** Every non-marker string in a payload — the bytes claimed to come from source. */
function contentStrings(value: unknown, out: string[] = []): string[] {
    if (isMarker(value)) return out;
    if (typeof value === 'string') { out.push(value); return out; }
    if (Array.isArray(value)) {
        for (const v of value) contentStrings(v, out);
        return out;
    }
    if (value !== null && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) contentStrings(v, out);
    }
    return out;
}

/** Container nesting depth of a payload. Iterative, so it cannot itself overflow. */
function depthOf(root: unknown): number {
    let deepest = 0;
    const values: unknown[] = [root];
    const depths: number[] = [0];
    while (values.length > 0) {
        const value = values.pop();
        const depth = depths.pop() ?? 0;
        if (value === null || typeof value !== 'object') continue;
        if (depth + 1 > deepest) deepest = depth + 1;
        const members = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
        for (const member of members) { values.push(member); depths.push(depth + 1); }
    }
    return deepest;
}

/** The first lone surrogate in `s`, or null. */
function loneSurrogate(s: string): { at: number; code: number } | null {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
            if (next < 0xdc00 || next > 0xdfff) return { at: i, code: c };
            i++;
            continue;
        }
        if (c >= 0xdc00 && c <= 0xdfff) return { at: i, code: c };
    }
    return null;
}

// ── the six matrix documents, generated in code ───────────────────────────

/** 200 levels of `{"n":{...}}`, ending in a scalar. */
function deepDocument(levels: number): string {
    let text = '"floor"';
    for (let i = 0; i < levels; i++) text = `{"n":${text}}`;
    return text;
}

function bigArrayDocument(elements: number): string {
    const parts = new Array<string>(elements);
    for (let i = 0; i < elements; i++) parts[i] = String(i);
    return `[${parts.join(',')}]`;
}

function wideObjectDocument(keys: number): string {
    const parts = new Array<string>(keys);
    for (let i = 0; i < keys; i++) parts[i] = `"k${i}":${i}`;
    return `{${parts.join(',')}}`;
}

/** A document that IS one very long string scalar. */
function bigScalarDocument(bytes: number): string {
    return JSON.stringify('s'.repeat(bytes));
}

/** Every kind, nested unevenly, with reproducible noise. */
function heterogeneousDocument(): string {
    const rnd = mulberry32(0x5731de);
    const rows: unknown[] = [];
    for (let i = 0; i < 400; i++) {
        rows.push({
            id: i,
            name: `row-${Math.floor(rnd() * 1e6)}`,
            ok: rnd() > 0.5,
            score: rnd() * 1e-6,
            tags: Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, j) => `t${j}`),
            nested: { a: { b: { c: rnd() > 0.5 ? null : `deep-${i}` } } },
            blob: 'z'.repeat(1 + Math.floor(rnd() * 300)),
        });
    }
    return JSON.stringify({ meta: { kind: 'mixed', total: rows.length }, rows, trailing: null });
}

const MATRIX_BUDGETS = [0, 1, 64, 256, 1000, 8000, 100000] as const;

interface Fixture {
    readonly name: string;
    readonly text: string;
}

let fixturesCache: Fixture[] | null = null;
function matrixFixtures(): Fixture[] {
    if (fixturesCache !== null) return fixturesCache;
    fixturesCache = [
        { name: 'deep-nesting-200-levels', text: deepDocument(200) },
        { name: 'array-100k-elements', text: bigArrayDocument(100_000) },
        { name: 'object-5000-keys', text: wideObjectDocument(5_000) },
        { name: 'string-scalar-2MB', text: bigScalarDocument(2 * 1024 * 1024) },
        { name: 'heterogeneous-mixed', text: heterogeneousDocument() },
        { name: 'tiny', text: '{"a":1}' },
    ];
    return fixturesCache;
}

/** Checks that must hold of every view, whatever produced it. */
function assertUniversal(view: StrideView, docBytes: number, where: string): void {
    expect(view.chars, `${where}: chars ${view.chars} exceeded the view's own budget ${view.budget}`)
        .toBeLessThanOrEqual(view.budget);

    const text = JSON.stringify(view.data);
    expect(typeof text, `${where}: payload did not serialise to a string`).toBe('string');
    expect(text.length, `${where}: serialised payload is ${text.length} chars, budget ${view.budget}`)
        .toBeLessThanOrEqual(view.budget);
    expect(view.chars, `${where}: reported chars ${view.chars} disagrees with the serialised length ${text.length}`)
        .toBe(text.length);
    expect(() => JSON.parse(text), `${where}: payload did not parse: ${text.slice(0, 200)}`).not.toThrow();

    expect(malformedMarkers(view.data), `${where}: payload carries a marker-shaped string that MARKER_RE rejects`)
        .toEqual([]);

    for (const marker of markersIn(view.data)) {
        expect(MARKER_RE.test(marker), `${where}: in-place marker does not match MARKER_RE: ${marker}`).toBe(true);
    }

    for (const [i, omission] of view.envelope.omitted.entries()) {
        expect(() => decodeCursor(omission.cursor), `${where}: omission ${i} cursor did not decode: ${omission.cursor}`)
            .not.toThrow();
        const [lo, hi] = omission.span;
        expect(lo >= 0 && hi <= docBytes && lo <= hi,
            `${where}: omission ${i} span [${lo},${hi}] is not inside the document span [0,${docBytes}]`).toBe(true);
        expect(omission.count, `${where}: omission ${i} claims a negative count`).toBeGreaterThanOrEqual(0);
        expect(omission.count, `${where}: omission ${i} withholds ${omission.count} of a stated total ${omission.total}`)
            .toBeLessThanOrEqual(omission.total);
    }
    for (const [label, addr] of [['next', view.envelope.next], ['prev', view.envelope.prev], ['parent', view.envelope.parent]] as const) {
        if (addr === undefined) continue;
        expect(() => decodeCursor(addr.cursor), `${where}: ${label} cursor did not decode: ${addr.cursor}`).not.toThrow();
    }
    expect(view.envelope.hint, `${where}: envelope carries no hint`).toBeTruthy();
}

describe('the 1,968x overrun case is bounded at every budget', () => {
    it('keeps a root object of two 5,000-element arrays inside budgets 100, 300, 1000 and 4000', () => {
        const record = JSON.stringify({ v: 'x'.repeat(50) });
        const array = `[${new Array(5000).fill(record).join(',')}]`;
        const doc = `{"a":${array},"b":${array}}`;
        const resolver = open(doc, 'overrun');
        const measured: Array<[number, number]> = [];

        for (const budget of [100, 300, 1000, 4000]) {
            const view = renderNode(resolver, resolver.root(), { budget });
            const where = `1968x case at budget ${budget}`;
            assertUniversal(view, byteLength(doc), where);
            expect(view.budget, `${where}: view reported a budget other than the one requested`).toBe(budget);
            // The bug being regressed emitted 590,013 characters here. A cap
            // that merely "looks small" would still pass `chars <= budget`, so
            // the ratio against the source is asserted too.
            expect(view.chars, `${where}: payload is ${view.chars} chars of a ${doc.length}-byte document`)
                .toBeLessThan(doc.length / 100);
            expect(view.envelope.omitted.length, `${where}: a truncated view recorded no omission`)
                .toBeGreaterThan(0);
            measured.push([budget, view.chars]);
        }

        // Printed because the measured numbers are the point of this case, and
        // because a silent pass is exactly the failure mode under test.
        console.log(`1,968x case (${byteLength(doc)} source bytes): `
            + measured.map(([b, c]) => `budget ${b} -> ${c} chars`).join(', '));
    }, 120_000);

    it('never materialises a span larger than the budget allotted to it', () => {
        const record = JSON.stringify({ v: 'x'.repeat(50) });
        const array = `[${new Array(5000).fill(record).join(',')}]`;
        const doc = `{"a":${array},"b":${array}}`;
        const bytes = Buffer.from(doc, 'utf8');

        for (const budget of [100, 300, 1000, 4000]) {
            const source = new WatchedSource(bytes, `watched:${budget}`);
            const resolver = new Resolver(StrideIndex.build(source));
            // The index build reads the document; only the render is measured.
            source.maxSlice = 0;
            const view = renderNode(resolver, resolver.root(), { budget });
            const where = `materialisation at budget ${budget}`;
            assertUniversal(view, bytes.length, where);
            // A slice may be as large as the allotment (a member that fits is
            // parsed whole) plus the scalar preview window, and no larger. The
            // regressed implementation would have sliced a 295,001-byte member.
            const ceiling = budget + SCALAR_PREVIEW_BYTES;
            expect(source.maxSlice, `${where}: the largest single slice was ${source.maxSlice} bytes `
                + `against a budget of ${budget} — a span bigger than its allotment was materialised`)
                .toBeLessThanOrEqual(ceiling);
        }
    }, 120_000);

    it('never lets a nested container overrun the share its parent handed it', () => {
        const record = JSON.stringify({ v: 'x'.repeat(50) });
        const array = `[${new Array(5000).fill(record).join(',')}]`;
        const doc = `{"a":${array},"b":${array}}`;
        const resolver = open(doc, 'overrun-nested');
        for (const budget of [300, 1000, 4000, 20000]) {
            const view = renderNode(resolver, resolver.root(), { budget });
            const data = view.data;
            expect(data !== null && typeof data === 'object',
                `nested share at budget ${budget}: payload is not a container`).toBe(true);
            if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
            for (const [key, member] of Object.entries(data as Record<string, unknown>)) {
                if (key === STRIDE_KEY) continue;
                expect(estimateChars(member), `nested share at budget ${budget}: member ${key} alone is `
                    + `${estimateChars(member)} chars of a ${budget}-char budget`).toBeLessThanOrEqual(view.chars);
            }
        }
    }, 120_000);
});

describe('the budget bound holds for every document at every budget', () => {
    for (const fixture of matrixFixtures()) {
        for (const budget of MATRIX_BUDGETS) {
            it(`bounds ${fixture.name} at budget ${budget}`, () => {
                const resolver = open(fixture.text, `matrix:${fixture.name}`);
                const view = renderNode(resolver, resolver.root(), { budget });
                assertUniversal(view, byteLength(fixture.text), `document ${fixture.name}, budget ${budget}`);
                // A request below the floor is reported AT the floor, never as
                // the number asked for — otherwise substituting a larger budget
                // would be a way to hide an overrun.
                const expected = budget < 5 ? 5 : budget;
                expect(view.budget, `document ${fixture.name}, budget ${budget}: view reported budget `
                    + `${view.budget}, expected ${expected}`).toBe(expected);
            }, 180_000);
        }
    }
});

describe('raising the budget never shows less', () => {
    for (const fixture of matrixFixtures()) {
        it(`shows monotonically more of ${fixture.name} as the budget rises`, () => {
            const resolver = open(fixture.text, `mono:${fixture.name}`);
            let previousLeaves = -1;
            let previousBudget = -1;
            for (const budget of MATRIX_BUDGETS) {
                const view = renderNode(resolver, resolver.root(), { budget });
                const leaves = contentSize(view);
                expect(leaves, `document ${fixture.name}: budget ${budget} shows ${leaves} verbatim leaves, `
                    + `but the smaller budget ${previousBudget} showed ${previousLeaves}`)
                    .toBeGreaterThanOrEqual(previousLeaves);
                previousLeaves = leaves;
                previousBudget = budget;
            }
        }, 180_000);
    }
});

describe('a complete view is the document itself', () => {
    it('deep-equals JSON.parse of the whole document when nothing is withheld', () => {
        const docs = [
            '{"a":1,"b":[1,2,3],"c":"hi","d":null,"e":true,"f":-0.5,"g":{},"h":[]}',
            '[]',
            '{}',
            'null',
            '"just a string"',
            '{"":"empty name","~":"tilde","a/b":"slash"}',
            '[[[[1]]],[2],{"x":[{"y":"z"}]}]',
        ];
        for (const doc of docs) {
            const resolver = open(doc, `truth:${doc.length}`);
            const view = renderNode(resolver, resolver.root(), { budget: 100_000 });
            expect(view.envelope.omitted, `source truth for ${doc}: something was withheld at budget 100000`)
                .toEqual([]);
            expect(view.data, `source truth for ${doc}: payload is not the parsed document`)
                .toEqual(JSON.parse(doc));
            expect(view.chars, `source truth for ${doc}: chars disagrees with the minified length`)
                .toBe(JSON.stringify(JSON.parse(doc)).length);
        }
    });

    it('emits a payload the caller can still serialise, however deep the document', () => {
        // `JSON.parse` accepts far deeper nesting than `JSON.stringify` can
        // write: measured on this runtime, parse reaches 20,000 levels while
        // stringify throws RangeError between 4,000 and 6,000. A budget large
        // enough to take this document whole would hand the caller a value it
        // cannot send — a crash instead of a bounded answer — so the depth bound
        // has to apply to the verbatim path too, not only to the walk that
        // descends. `assertUniversal` stringifies, which is the assertion.
        const doc = deepDocument(20_000);
        const resolver = open(doc, 'deep-measure');
        const view = renderNode(resolver, resolver.root(), { budget: 400_000 });
        assertUniversal(view, byteLength(doc), 'document nested 20,000 levels at budget 400000');
        expect(depthOf(view.data), `the payload nests ${depthOf(view.data)} levels deep, past MAX_RENDER_DEPTH`)
            .toBeLessThanOrEqual(512);
        expect(view.envelope.omitted.some((o) => o.of === 'depth'),
            'a document truncated for depth did not record a depth omission').toBe(true);
    }, 300_000);

    it('drops a value whose serialisation is longer than the bytes it came from', () => {
        // Byte length is a safe upper bound on character cost for every JSON
        // form but one: `1e-6` is four source bytes and stringifies to
        // `0.000001`, eight characters. So the byte guard alone is not enough,
        // and the allocator measures each parsed value exactly and refuses one
        // that measures over its allotment. These budgets are swept small on
        // purpose — the gap only opens where the allotment falls between a
        // value's byte length and its character length.
        const docs = ['[1e-6]', '[1e-6,1e-6]', '{"a":1e-6,"b":2e-7}', '[1E5,1e21,1e-7,1e-6]'];
        for (const doc of docs) {
            for (let budget = 5; budget <= 48; budget++) {
                const resolver = open(doc, `widen:${doc}:${budget}`);
                const view = renderNode(resolver, resolver.root(), { budget });
                assertUniversal(view, byteLength(doc), `widening number in ${doc} at budget ${budget}`);
            }
        }
    });

    it('measures every value it emits exactly, so chars is never an estimate', () => {
        // A number is the one JSON form whose serialisation can be LONGER than
        // its source bytes (`1e-6` is 4 bytes and 8 characters), which is why
        // byte length alone cannot be the accounting.
        const doc = '{"tiny":1e-6,"big":1E5,"neg":-0,"round":1.0,"exp":1e21}';
        const resolver = open(doc, 'numbers');
        const view = renderNode(resolver, resolver.root(), { budget: 100_000 });
        expect(view.chars, 'number widening: chars disagrees with JSON.stringify').toBe(JSON.stringify(view.data).length);
        expect(estimateChars(view.data), 'estimateChars disagrees with JSON.stringify on widened numbers')
            .toBe(JSON.stringify(view.data).length);
        expect(view.chars, 'the payload did not grow past its source, so the case did not exercise widening')
            .toBeGreaterThan(0);
    });
});

describe('truncation is never silent', () => {
    it('addresses every withheld region with a cursor that resolves back to it', () => {
        const doc = wideObjectDocument(5_000);
        const resolver = open(doc, 'addressed');
        const view = renderNode(resolver, resolver.root(), { budget: 2_000 });
        expect(view.envelope.omitted.length, 'a 5,000-key object at budget 2000 recorded no omission')
            .toBeGreaterThan(0);
        for (const [i, omission] of view.envelope.omitted.entries()) {
            const cursor = decodeCursor(omission.cursor);
            expect(cursor.pointer, `omission ${i}: cursor points somewhere else than the omission`)
                .toBe(omission.pointer === '' ? '' : omission.pointer);
            const [lo, hi] = omission.span;
            expect(lo >= 0 && hi <= byteLength(doc),
                `omission ${i}: span [${lo},${hi}] escapes the document [0,${byteLength(doc)}]`).toBe(true);
            expect(omission.total, `omission ${i}: total does not match the container's true key count`).toBe(5_000);
            // Following the cursor must actually reach the withheld region.
            const follow = renderNode(resolver, resolver.resolve(cursor.pointer), {
                budget: 2_000,
                offset: cursor.offset,
            });
            assertUniversal(follow, byteLength(doc), `following omission ${i}`);
        }
    }, 60_000);

    it('puts the array marker where the elements were, so the shape cannot read as complete', () => {
        const doc = bigArrayDocument(5_000);
        const resolver = open(doc, 'inplace');
        const view = renderNode(resolver, resolver.root(), { budget: 400 });
        const data = view.data;
        expect(Array.isArray(data), 'a truncated 5,000-element array did not render as an array').toBe(true);
        if (!Array.isArray(data)) return;
        const markers = data.filter(isMarker);
        expect(markers.length, 'a truncated array carries no in-place marker').toBeGreaterThan(0);
        const [marker] = markers;
        expect(marker, 'the in-place marker is missing').toBeTruthy();
        expect(typeof marker === 'string' && /^\[TRUNCATED: elements \d+-\d+ of 5000 \| bytes \d+-\d+ \| cursor s1\./.test(marker),
            `the array marker is not in the fixed form: ${String(marker)}`).toBe(true);
        // The declared total is the mechanism: formats that declare a length
        // scored 100% against 0% at detecting a truncated array.
        expect(view.envelope.total, 'the envelope does not declare the true element count').toBe(5_000);
        expect(view.envelope.shown, 'the envelope does not declare what it showed').toBeDefined();
    }, 60_000);

    it('puts the object marker under the reserved key in the fixed form', () => {
        const doc = wideObjectDocument(200);
        const resolver = open(doc, 'inplace-object');
        const view = renderNode(resolver, resolver.root(), { budget: 400 });
        const data = view.data;
        expect(data !== null && typeof data === 'object' && !Array.isArray(data),
            'a truncated object did not render as an object').toBe(true);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
        const marker = (data as Record<string, unknown>)[STRIDE_KEY];
        expect(typeof marker === 'string' && /^\[TRUNCATED: \d+ of 200 keys \| next [^|]+ \| cursor s1\./.test(marker),
            `the object marker is not in the fixed form: ${String(marker)}`).toBe(true);
    });

    it('previews an over-long scalar as a verbatim excerpt beside a byte marker', () => {
        const body = 'abcdefghij'.repeat(200_000);          // 2 MB of a known pattern
        const doc = JSON.stringify(body);
        const resolver = open(doc, 'scalar-preview');
        const view = renderNode(resolver, resolver.root(), { budget: 2_000 });
        const data = view.data;
        expect(Array.isArray(data), 'an over-long scalar did not render as [excerpt, marker]').toBe(true);
        if (!Array.isArray(data)) return;
        const [excerpt, marker] = data;
        expect(typeof excerpt === 'string' && body.startsWith(excerpt),
            'the excerpt is not a verbatim prefix of the source string').toBe(true);
        expect(typeof marker === 'string' && /^\[TRUNCATED: bytes \d+-\d+ of \d+ \| cursor s1\./.test(marker),
            `the scalar marker is not in the fixed form: ${String(marker)}`).toBe(true);
        const bytes = view.envelope.omitted.filter((o) => o.of === 'bytes');
        expect(bytes.length, 'a truncated scalar recorded no byte omission').toBe(1);
        const [only] = bytes;
        expect(only, 'the byte omission is missing').toBeTruthy();
        if (only === undefined) return;
        expect(only.total, 'the byte omission does not declare the string\'s true length').toBe(body.length);
        expect(view.envelope.next, 'a partially shown scalar offers no continuation').toBeDefined();
    }, 60_000);
});

describe('a cut never lands inside a codepoint', () => {
    it('truncates emoji, CJK and combining marks without producing a lone surrogate', () => {
        // Astral emoji (surrogate pairs), CJK (3-byte UTF-8), and base letters
        // carrying combining marks — the three shapes a byte-wise cut breaks.
        const alphabet = ['\u{1f600}', '\u{1f9d1}\u{200d}\u{1f680}', '中文', 'é', 'ǟ', '\u{1f1e6}\u{1f1e8}'];
        let body = '';
        for (let i = 0; i < 40_000; i++) body += alphabet[i % alphabet.length] ?? '';
        const doc = JSON.stringify({ text: body, list: alphabet, nested: { deep: body.slice(0, 5_000) } });
        const resolver = open(doc, 'unicode');

        for (const budget of [0, 1, 64, 120, 256, 700, 1_000, 4_000, 33_333]) {
            const view = renderNode(resolver, resolver.root(), { budget });
            const where = `unicode at budget ${budget}`;
            assertUniversal(view, byteLength(doc), where);
            for (const s of contentStrings(view.data)) {
                const lone = loneSurrogate(s);
                expect(lone, `${where}: payload string carries a lone surrogate `
                    + `U+${lone === null ? '' : lone.code.toString(16)} at index ${lone === null ? -1 : lone.at}`)
                    .toBeNull();
                expect(Buffer.from(s, 'utf8').toString('utf8'), `${where}: payload string does not round-trip `
                    + 'through UTF-8, so a codepoint was broken').toBe(s);
                expect(s.includes('�'), `${where}: payload string carries a replacement character`).toBe(false);
                // Every verbatim string must still be findable in the source.
                expect(doc.includes(JSON.stringify(s).slice(1, -1)),
                    `${where}: payload string is not a verbatim slice of the source`).toBe(true);
            }
        }
    }, 120_000);
});

describe('focus keeps the part that was searched for', () => {
    it('shows a byte offset passed in focus that the same budget otherwise omits', () => {
        const rows: string[] = [];
        for (let i = 0; i < 1_200; i++) {
            rows.push(JSON.stringify({ id: i, note: i === 900 ? 'NEEDLE-8f3a-marker' : `filler-${i}`, pad: 'p'.repeat(40) }));
        }
        const doc = `{"records":[${rows.join(',')}]}`;
        const at = doc.indexOf('NEEDLE-8f3a-marker');
        expect(at, 'the fixture does not contain the needle').toBeGreaterThan(0);
        const resolver = open(doc, 'focus');

        const budget = 600;
        const blind = renderNode(resolver, resolver.root(), { budget });
        assertUniversal(blind, byteLength(doc), `focus control at budget ${budget}`);
        expect(JSON.stringify(blind.data).includes('NEEDLE'),
            'the control case already shows the needle, so the fixture proves nothing').toBe(false);

        const aimed = renderNode(resolver, resolver.root(), { budget, focus: [at] });
        assertUniversal(aimed, byteLength(doc), `focus honoured at budget ${budget}`);
        expect(JSON.stringify(aimed.data).includes('NEEDLE-8f3a-marker'),
            `focus at byte ${at} did not survive into a ${budget}-char view: ${JSON.stringify(aimed.data).slice(0, 400)}`)
            .toBe(true);
        expect(aimed.envelope.omitted.length,
            'a focused view that trimmed the record recorded no omission').toBeGreaterThan(0);
    }, 60_000);
});

describe('a document member literally named __stride stays unambiguous', () => {
    it('never emits the colliding member as content, and addresses it at its own pointer', () => {
        const doc = `{"a":1,"${STRIDE_KEY}":"SECRET-document-value","b":2}`;
        const resolver = open(doc, 'collision');
        const view = renderNode(resolver, resolver.root(), { budget: 100_000 });
        assertUniversal(view, byteLength(doc), 'collision at budget 100000');

        const data = view.data;
        expect(data !== null && typeof data === 'object' && !Array.isArray(data),
            'the colliding document did not render as an object').toBe(true);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
        const record = data as Record<string, unknown>;

        // Even with budget to spare, the reserved key holds STRIDE's marker and
        // never the document's value: a payload where `__stride` might be
        // either is a payload no reader can interpret.
        expect(isMarker(record[STRIDE_KEY]),
            `the reserved key carries document content instead of a marker: ${String(record[STRIDE_KEY])}`).toBe(true);
        expect(JSON.stringify(view.data).includes('SECRET-document-value'),
            'the colliding member leaked into the payload').toBe(false);
        expect(record['a'], 'a sibling of the colliding member was dropped').toBe(1);
        expect(record['b'], 'a sibling of the colliding member was dropped').toBe(2);

        // The omission must address the member's OWN pointer, because no budget
        // and no offset on the container will ever reveal it.
        const pointing = view.envelope.omitted.filter((o) => decodeCursor(o.cursor).pointer === `/${STRIDE_KEY}`);
        expect(pointing.length, `no omission addresses /${STRIDE_KEY}; omissions were `
            + JSON.stringify(view.envelope.omitted)).toBe(1);
        const [only] = pointing;
        expect(only, 'the collision omission is missing').toBeTruthy();
        if (only === undefined) return;
        expect(only.reason, 'the collision was reported as a budget omission, but no budget can reveal it')
            .toBe('page');
        expect(only.count, 'the collision omission does not account for exactly one key').toBe(1);

        // And that address must actually deliver the value.
        const direct = renderNode(resolver, resolver.resolve(`/${STRIDE_KEY}`), { budget: 1_000 });
        expect(direct.data, 'the pointer the collision omission names does not return the value')
            .toBe('SECRET-document-value');

        // The withheld-key arithmetic must not double-count the same key.
        const keysWithheld = view.envelope.omitted
            .filter((o) => o.of === 'keys')
            .reduce((sum, o) => sum + o.count, 0);
        expect(keysWithheld, 'the same withheld key is counted by more than one omission').toBe(1);
    });

    it('keeps the marker unambiguous when the collision is one of many keys', () => {
        const parts = ['"lead":0'];
        for (let i = 0; i < 300; i++) parts.push(`"k${i}":"${'v'.repeat(20)}"`);
        parts.push(`"${STRIDE_KEY}":"SECRET"`);
        const doc = `{${parts.join(',')}}`;
        const resolver = open(doc, 'collision-wide');
        for (const budget of [64, 256, 1_000, 8_000, 100_000]) {
            const view = renderNode(resolver, resolver.root(), { budget });
            assertUniversal(view, byteLength(doc), `wide collision at budget ${budget}`);
            expect(JSON.stringify(view.data).includes('SECRET'),
                `wide collision at budget ${budget}: the colliding member leaked into the payload`).toBe(false);
        }
    }, 60_000);
});

describe('renderWindow places the target in its surroundings', () => {
    it('carries the target, its verbatim neighbours and the ancestor chain inside budget', () => {
        const rows: string[] = [];
        for (let i = 0; i < 500; i++) rows.push(JSON.stringify({ id: i, body: `row-${i}-${'y'.repeat(30)}` }));
        const doc = `{"outer":{"inner":{"records":[${rows.join(',')}]}}}`;
        const resolver = open(doc, 'window');
        const target = resolver.resolve('/outer/inner/records/250');

        for (const budget of [0, 1, 64, 256, 1_000, 8_000, 100_000]) {
            const view = renderWindow(resolver, target, { budget });
            assertUniversal(view, byteLength(doc), `window at budget ${budget}`);
            expect(view.envelope.pointer, `window at budget ${budget}: envelope does not name the target`)
                .toBe('/outer/inner/records/250');
        }

        const view = renderWindow(resolver, target, { budget: 4_000 });
        const data = view.data as Record<string, unknown>;
        const meta = data[STRIDE_KEY] as Record<string, unknown>;
        expect(meta['at'], 'the window does not state which pointer it is centred on')
            .toBe('/outer/inner/records/250');
        expect(meta['of'], 'the window does not declare what its content key holds')
            .toBe('/outer/inner/records');
        const ancestors = meta['ancestors'] as Array<Record<string, unknown>>;
        expect(ancestors.length, 'the window carries no ancestor chain').toBeGreaterThan(0);
        expect(ancestors[0]?.['pointer'], 'the ancestor chain does not start at the document root').toBe('');
        for (const ancestor of ancestors) {
            expect(() => decodeCursor(String(ancestor['cursor'])), 'an ancestor cursor did not decode').not.toThrow();
        }
        // The target itself, verbatim, and neighbours around it — not a summary
        // of them: byte-exact context at the hit is the measured win.
        const content = JSON.stringify(data['window']);
        expect(content.includes('"row-250-'), `the window does not contain the target: ${content.slice(0, 300)}`).toBe(true);
        expect(content.includes('"row-249-') || content.includes('"row-251-'),
            `the window contains no verbatim neighbour: ${content.slice(0, 300)}`).toBe(true);
        expect(view.envelope.parent, 'the window offers no address back up the tree').toBeDefined();
    }, 60_000);

    it('falls back to the target itself when the budget cannot afford the wrapper', () => {
        const rows: string[] = [];
        for (let i = 0; i < 60; i++) rows.push(String(i));
        const doc = `{"outer":{"inner":{"records":[${rows.join(',')}]}}}`;
        const resolver = open(doc, 'window-floor');
        const target = resolver.resolve('/outer/inner/records/30');
        const view = renderWindow(resolver, target, { budget: 64 });
        assertUniversal(view, byteLength(doc), 'window below the wrapper floor');
        // The metadata wrapper alone costs more than this budget, so the window
        // has to degrade — but degrading must not throw away the one thing the
        // caller asked for. Answering `null` here would be inside budget and
        // useless, which is the failure this pins.
        expect(view.data, 'a window too small for its wrapper dropped the target as well').toBe(30);
        expect(view.envelope.omitted.some((o) => o.of === 'depth'),
            'the surroundings were dropped without being recorded as an omission').toBe(true);
    });

    it('degenerates honestly when the target is the document root', () => {
        const doc = '{"a":[1,2,3],"b":"x"}';
        const resolver = open(doc, 'window-root');
        const view = renderWindow(resolver, resolver.root(), { budget: 2_000 });
        assertUniversal(view, byteLength(doc), 'window at the root');
        const data = view.data as Record<string, unknown>;
        const meta = data[STRIDE_KEY] as Record<string, unknown>;
        expect(meta['at'], 'a root window does not name the root').toBe('');
        expect(meta['ancestors'], 'the root has no ancestors, but some were reported').toEqual([]);
        expect(data['window'], 'a root window does not carry the document').toEqual(JSON.parse(doc));
    });
});

describe('paging a container is addressed in both directions', () => {
    it('walks a 5,000-key object by offset with no gap and no overlap', () => {
        const doc = wideObjectDocument(5_000);
        const resolver = open(doc, 'paging');
        const root = resolver.root();
        let offset = 0;
        let pages = 0;
        const seen = new Set<string>();
        while (pages < 40) {
            const view = renderNode(resolver, root, { budget: 4_000, offset });
            assertUniversal(view, byteLength(doc), `page ${pages} from offset ${offset}`);
            const shown = view.envelope.shown;
            expect(shown, `page ${pages}: a paged container view declared no shown range`).toBeDefined();
            if (shown === undefined) break;
            expect(shown[0], `page ${pages}: the page starts before the offset asked for`).toBeGreaterThanOrEqual(offset);
            const data = view.data as Record<string, unknown>;
            for (const key of Object.keys(data)) {
                if (key === STRIDE_KEY) continue;
                expect(seen.has(key), `page ${pages}: key ${key} was already delivered by an earlier page`).toBe(false);
                seen.add(key);
            }
            pages++;
            const next = view.envelope.next;
            if (next === undefined) break;
            const decoded = decodeCursor(next.cursor);
            expect(decoded.offset, `page ${pages}: the next cursor does not advance past ${offset}`)
                .toBeGreaterThan(offset);
            offset = decoded.offset;
        }
        expect(seen.size, 'paging delivered no keys at all').toBeGreaterThan(0);
        expect(pages, 'paging terminated on the first page').toBeGreaterThan(1);
    }, 120_000);
});
