// ---------------------------------------------------------------------------
// tests/stride/resolve.test.ts
//
// Three of the four routes in resolve.ts stop a scan by throwing a sentinel out
// of a scanner visitor — `collect` for members(), `walkFrom` for
// memberByIndex()/memberByKey(), `memberContaining` for locate(). A sentinel
// thrown out of a callback the caller did not wrap does not stop a scan, it
// leaves the function altogether: the call never returns a value, and every
// checkpointed container becomes unreachable through the very route the
// checkpoints exist to serve.
//
// So the property here is first "it returns at all", asserted as such, and then
// "what it returned is right", asserted against ground truth that shares no code
// with the resolver. Ground truth is computed twice over: once as arithmetic
// accumulated while the fixture text was assembled, and once as a full walk from
// the container's first byte. The two are required to agree before either is
// used, so the ground truth is itself under test.
//
// Both fixtures are deliberately checkpointed rather than dense, and both mix
// every JSON value kind, because a member whose value is a container is taken on
// the scanner's `exit` event and a scalar on `scalar` — two code paths that an
// all-scalars fixture would only half cover.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The second half of this file is about the id routes instead.
//
// Reaching a member needs the container's index node id first, and resolve.ts
// obtains it three fast ways — resumed from an already-resolved parent, threaded
// out of `Member.node` during a descent, memoised by byte start — with a fourth,
// `deriveIndexId`, that reads the index and nothing else. The fast three share
// state across calls; the fourth shares none. So the property asserted here is
// that they answer identically, over thousands of pointers, in several orders,
// on documents that take every route the resolver has: a `Resolver` built with
// `{ shortcuts: false }` uses only the fourth, and is the control.
//
// Equivalence between two of STRIDE's own routes could still be equivalence
// between two wrong answers, so wherever a fixture is small enough to parse, a
// third opinion comes from `JSON.parse` and a pointer walk written here: the
// bytes at the resolved span must parse to the value at that pointer.
//
// The performance property is asserted as COUNTED INDEX WORK, not elapsed time.
// The defect these tests exist for was cubic in depth — 341,630 dense-table
// reads for one pointer at depth 512, measured — and a count is exact, is the
// same on a loaded machine as an idle one, and names the regression directly
// rather than through a threshold someone will later widen.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { StrideIndex } from '../../src/core/stride/index.js';
import { RESOLVE_ID_CACHE_MAX, Resolver, type Member } from '../../src/core/stride/resolve.js';
import { BufferSource } from '../../src/core/stride/source.js';
import { scanStructure, K_ARRAY, K_OBJECT } from '../../src/core/stride/scan.js';
import {
    DENSE_CHILD_LIMIT, STRIDE_DEFAULT, StrideError,
    type StrideKind, type StrideNode,
} from '../../src/core/stride/types.js';
import { decodeJsonString } from '../../src/core/stride/index.js';

/** Members in the fixtures below, so every window crosses several checkpoints. */
const MEMBER_COUNT = 2000;

/** Byte-accurate text assembly, so ground truth never has to be re-derived. */
interface Assembler {
    /** Append a piece; returns the byte offset it starts at. */
    emit(piece: string): number;
    /** Byte offset one past everything emitted so far. */
    at(): number;
    text(): string;
}

function assemble(): Assembler {
    const parts: string[] = [];
    let cursor = 0;
    return {
        emit(piece: string): number {
            const from = cursor;
            parts.push(piece);
            cursor += Buffer.byteLength(piece, 'utf8');
            return from;
        },
        at(): number { return cursor; },
        text(): string { return parts.join(''); },
    };
}

/** One member of the root container, as the generator knows it. */
interface Expected {
    readonly ordinal: number;
    readonly key: string | null;
    readonly start: number;
    readonly end: number;
    readonly kind: StrideKind;
}

interface Fixture {
    readonly text: string;
    readonly members: readonly Expected[];
}

/**
 * The value for member `i`, cycling through every JSON kind so that both the
 * container path and the scalar path of every walk are covered, and padded so
 * that mean bytes per member keeps the byte-tuned stride in a useful range.
 */
function valueFor(i: number): { text: string; kind: StrideKind } {
    switch (i % 6) {
        case 0: return { text: `{"n":${i},"pad":${JSON.stringify('o'.repeat(140))}}`, kind: 'object' };
        case 1: return { text: `[${i},${JSON.stringify('a'.repeat(140))}]`, kind: 'array' };
        case 2: return { text: JSON.stringify(`s${i}-${'x'.repeat(140)}`), kind: 'string' };
        case 3: return { text: `${i}.${i}e2`, kind: 'number' };
        case 4: return { text: i % 12 === 4 ? 'true' : 'false', kind: 'boolean' };
        default: return { text: 'null', kind: 'null' };
    }
}

/**
 * An object of `count` members. Every 89th name carries a `~`, a `/`, an escaped
 * quote and a multi-byte character, so a name decoded without unescaping, or a
 * byte offset quietly computed in characters, cannot pass.
 */
function checkpointedObject(count: number): Fixture {
    const doc = assemble();
    doc.emit('{');
    const members: Expected[] = [];
    for (let i = 0; i < count; i++) {
        if (i > 0) doc.emit(',');
        const key = i % 89 === 0 ? `k~/${i}"é` : `key-${i}`;
        doc.emit(`${JSON.stringify(key)}:`);
        const value = valueFor(i);
        const start = doc.emit(value.text);
        members.push({ ordinal: i, key, start, end: doc.at(), kind: value.kind });
    }
    doc.emit('}');
    return { text: doc.text(), members };
}

/** An array of `count` elements, same value cycle as the object fixture. */
function checkpointedArray(count: number): Fixture {
    const doc = assemble();
    doc.emit('[');
    const members: Expected[] = [];
    for (let i = 0; i < count; i++) {
        if (i > 0) doc.emit(',');
        const value = valueFor(i);
        const start = doc.emit(value.text);
        members.push({ ordinal: i, key: null, start, end: doc.at(), kind: value.kind });
    }
    doc.emit(']');
    return { text: doc.text(), members };
}

/** Total over the scanner's kind codes, so no lookup can miss and default. */
function kindName(kind: 0 | 1 | 2 | 3 | 4 | 5): StrideKind {
    switch (kind) {
        case 0: return 'object';
        case 1: return 'array';
        case 2: return 'string';
        case 3: return 'number';
        case 4: return 'boolean';
        default: return 'null';
    }
}

/**
 * Ground truth the way the brief specifies it: one full walk from the
 * container's first byte, using no index and no resolver, taking every member at
 * depth 1 in document order.
 */
function walkFromFirstByte(source: BufferSource, node: StrideNode): Expected[] {
    const isObject = node.kind === 'object';
    const out: Expected[] = [];
    let nameStart = -1;
    let nameEnd = -1;
    const take = (start: number, end: number, kind: StrideKind): void => {
        const key = isObject && nameStart >= 0 ? decodeJsonString(source.slice(nameStart, nameEnd)) : null;
        nameStart = -1;
        out.push({ ordinal: out.length, key, start, end, kind });
    };
    scanStructure(source, node.start + 1, node.end, {
        enter() { /* the span is only known at exit */ },
        exit(kind, start, end, depth) { if (depth === 1) take(start, end, kindName(kind)); },
        key(start, end, depth) { if (depth === 1) { nameStart = start; nameEnd = end; } },
        scalar(kind, start, end, depth) { if (depth === 1) take(start, end, kindName(kind)); },
    }, isObject ? K_OBJECT : K_ARRAY);
    return out;
}

/** One line per member, so a mismatch names the member and the field. */
function encode(members: readonly Expected[] | readonly Member[]): string[] {
    return members.map((m) => `${m.ordinal}:${m.key ?? '<none>'}@${m.start}..${m.end}:${m.kind}`);
}

/** A fixture, its index, its resolver and its verified ground truth. */
interface Ready {
    readonly fixture: Fixture;
    readonly source: BufferSource;
    readonly index: StrideIndex;
    readonly resolver: Resolver;
    readonly root: StrideNode;
    /** The full walk from the container's first byte, cross-checked. */
    readonly truth: readonly Expected[];
}

function prepare(fixture: Fixture, id: string): Ready {
    const source = new BufferSource(Buffer.from(fixture.text, 'utf8'), id);
    const index = StrideIndex.build(source);
    const resolver = new Resolver(index);
    const root = resolver.root();

    expect(index.stats.errorAt, `${id}: the generated fixture must be well-formed JSON`).toBe(-1);
    expect(
        index.isCheckpointed(index.rootId),
        `${id}: the container must be on the checkpoint route, or none of these assertions exercise it`,
    ).toBe(true);
    expect(index.strideOf(index.rootId), `${id}: a checkpointed container must stride over more than one member`).toBeGreaterThan(1);

    const truth = walkFromFirstByte(source, root);
    expect(
        encode(truth),
        `${id}: the full walk from the container's first byte must agree with what the generator emitted, or the ground truth itself is wrong`,
    ).toEqual(encode(fixture.members));

    return { fixture, source, index, resolver, root, truth };
}

/** Windows chosen to sit on, just before and just after checkpoint boundaries. */
const WINDOWS: readonly (readonly [number, number])[] = [
    [0, 1], [0, 5], [1, 1], [1, 7], [63, 3], [64, 1], [64, 64], [127, 5],
    [512, 40], [1000, 33], [1023, 2], [1024, 2], [MEMBER_COUNT - 3, 3],
    [MEMBER_COUNT - 1, 1], [MEMBER_COUNT - 5, 50], [0, MEMBER_COUNT],
];

function assertEveryWindowMatchesGroundTruth(ready: Ready, label: string): void {
    for (const [offset, limit] of WINDOWS) {
        const call = (): Member[] => ready.resolver.members(ready.root, offset, limit);
        expect(
            call,
            `${label}: members(${offset}, ${limit}) must return rather than let the scan's stop sentinel escape the call`,
        ).not.toThrow();
        expect(
            encode(call()),
            `${label}: members(${offset}, ${limit}) must equal the ground-truth window`,
        ).toEqual(encode(ready.truth.slice(offset, offset + limit)));
    }
}

describe('members() on a checkpointed container', () => {
    it('returns every requested window of a 2,000-member object and each equals ground truth', () => {
        assertEveryWindowMatchesGroundTruth(prepare(checkpointedObject(MEMBER_COUNT), 'object'), 'object');
    }, 60_000);

    it('returns every requested window of a 2,000-member array and each equals ground truth', () => {
        assertEveryWindowMatchesGroundTruth(prepare(checkpointedArray(MEMBER_COUNT), 'array'), 'array');
    }, 60_000);

    it('returns nothing rather than the tail again for a window past the last member', () => {
        for (const ready of [prepare(checkpointedObject(MEMBER_COUNT), 'object'), prepare(checkpointedArray(MEMBER_COUNT), 'array')]) {
            expect(
                ready.resolver.members(ready.root, MEMBER_COUNT, 10),
                `${ready.root.kind}: a window starting at the member count must be empty`,
            ).toEqual([]);
            expect(
                ready.resolver.members(ready.root, MEMBER_COUNT + 500, 10),
                `${ready.root.kind}: a window starting well past the end must be empty`,
            ).toEqual([]);
            expect(
                ready.resolver.members(ready.root, 0, 0),
                `${ready.root.kind}: a zero-length window must be empty`,
            ).toEqual([]);
        }
    }, 60_000);

    it('enumerates the whole container without dropping or repeating a member', () => {
        for (const ready of [prepare(checkpointedObject(MEMBER_COUNT), 'object'), prepare(checkpointedArray(MEMBER_COUNT), 'array')]) {
            const all = ready.resolver.members(ready.root, 0, MEMBER_COUNT);
            expect(all.length, `${ready.root.kind}: every one of ${MEMBER_COUNT} members must be enumerable (I7)`).toBe(MEMBER_COUNT);
            expect(
                new Set(all.map((m) => m.start)).size,
                `${ready.root.kind}: no member may be reported twice`,
            ).toBe(MEMBER_COUNT);
            expect(encode(all), `${ready.root.kind}: the full enumeration must equal ground truth`).toEqual(encode(ready.truth));
        }
    }, 60_000);

    it('refuses a container operation on a scalar instead of returning an empty answer', () => {
        const ready = prepare(checkpointedObject(MEMBER_COUNT), 'object');
        const scalar = ready.resolver.resolve('/key-3');
        expect(scalar.kind, 'member 3 of the fixture is a number').toBe('number');
        expect(
            () => ready.resolver.members(scalar, 0, 4),
            'a genuine failure must still reach the caller through the same try that absorbs the stop sentinel',
        ).toThrow(StrideError);
    }, 60_000);
});

describe('memberByIndex() on a checkpointed array', () => {
    it('returns the element at every probed ordinal and each equals ground truth', () => {
        const ready = prepare(checkpointedArray(MEMBER_COUNT), 'array');
        for (const ordinal of [0, 1, 5, 63, 64, 65, 127, 128, 999, 1024, MEMBER_COUNT - 1]) {
            const call = (): Member | null => ready.resolver.memberByIndex(ready.root, ordinal);
            expect(
                call,
                `memberByIndex(${ordinal}) must return rather than let the scan's stop sentinel escape the call`,
            ).not.toThrow();
            const got = call();
            const want = ready.truth[ordinal];
            expect(want, `ground truth must hold element ${ordinal}`).toBeDefined();
            if (want === undefined) continue;
            expect(
                got === null ? null : encode([got]),
                `memberByIndex(${ordinal}) must be the element spanning ${want.start}..${want.end}`,
            ).toEqual(encode([want]));
        }
        expect(ready.resolver.memberByIndex(ready.root, MEMBER_COUNT), 'there is no element one past the last').toBeNull();
        expect(ready.resolver.memberByIndex(ready.root, -1), 'there is no element at a negative ordinal').toBeNull();
    }, 60_000);
});

describe('memberByKey() on a checkpointed object', () => {
    it('finds a member by name whether the key hash table covers it or not', () => {
        const ready = prepare(checkpointedObject(MEMBER_COUNT), 'object');
        // Early ordinals lie within one bounded walk of the container's first
        // byte and carry no hash entry by design, so these two groups take
        // different routes to the same answer.
        for (const ordinal of [0, 1, 2, 3, 4, 5, 31, 32, 89, 500, 1000, 1780, MEMBER_COUNT - 1]) {
            const want = ready.truth[ordinal];
            expect(want, `ground truth must hold member ${ordinal}`).toBeDefined();
            if (want === undefined || want.key === null) continue;
            const call = (): Member | null => ready.resolver.memberByKey(ready.root, want.key ?? '');
            expect(
                call,
                `memberByKey(${JSON.stringify(want.key)}) must return rather than let the scan's stop sentinel escape the call`,
            ).not.toThrow();
            const got = call();
            expect(
                got === null ? null : encode([got]),
                `memberByKey(${JSON.stringify(want.key)}) must be member ${ordinal}, spanning ${want.start}..${want.end}`,
            ).toEqual(encode([want]));
        }
    }, 60_000);

    it('returns null for a name the object does not hold, having proved its absence', () => {
        const ready = prepare(checkpointedObject(MEMBER_COUNT), 'object');
        for (const absent of ['key--1', 'key-2000', 'KEY-500', '', 'key-500 ']) {
            expect(
                ready.resolver.memberByKey(ready.root, absent),
                `${JSON.stringify(absent)} is not a member of the fixture and must not resolve to one`,
            ).toBeNull();
        }
    }, 60_000);

    it('resolves a pointer through a member of a checkpointed object', () => {
        const ready = prepare(checkpointedObject(MEMBER_COUNT), 'object');
        // Member 1002 is `{"n":1002,"pad":"ooo..."}`; its own members were never
        // indexed, so this is the interior route underneath the checkpoint route.
        const node = ready.resolver.resolve('/key-1002/n');
        expect(
            ready.source.slice(node.start, node.end).toString('utf8'),
            '/key-1002/n must resolve to the bytes of that record field',
        ).toBe('1002');
        expect(
            () => ready.resolver.resolve('/key-1002/absent'),
            'a pointer naming a member that does not exist must fail rather than resolve to a neighbour',
        ).toThrow(StrideError);
    }, 60_000);
});

describe('locate() on a checkpointed container', () => {
    it('maps a byte offset inside any element of a 2,000-member array back to that element', () => {
        const ready = prepare(checkpointedArray(MEMBER_COUNT), 'array');
        for (const ordinal of [0, 1, 63, 64, 65, 700, 1024, MEMBER_COUNT - 1]) {
            const want = ready.truth[ordinal];
            expect(want, `ground truth must hold element ${ordinal}`).toBeDefined();
            if (want === undefined) continue;
            const at = want.start + Math.floor((want.end - want.start) / 2);
            const call = (): StrideNode => ready.resolver.locate(at);
            expect(
                call,
                `locate(${at}) must return rather than let the scan's stop sentinel escape the call`,
            ).not.toThrow();
            const node = call();
            expect(
                node.pointer.startsWith(`/${ordinal}`),
                `byte ${at} lies inside element ${ordinal} (span ${want.start}..${want.end}) but locate said ${node.pointer}`,
            ).toBe(true);
            expect(
                at >= node.start && at < node.end,
                `locate(${at}) returned span ${node.start}..${node.end}, which does not contain the byte it was asked about`,
            ).toBe(true);
        }
    }, 60_000);

    it('maps a byte offset inside any member of a 2,000-member object back to that member', () => {
        const ready = prepare(checkpointedObject(MEMBER_COUNT), 'object');
        for (const ordinal of [0, 1, 63, 64, 65, 700, 1024, MEMBER_COUNT - 1]) {
            const want = ready.truth[ordinal];
            expect(want, `ground truth must hold member ${ordinal}`).toBeDefined();
            if (want === undefined || want.key === null) continue;
            const at = want.start + Math.floor((want.end - want.start) / 2);
            const node = ready.resolver.locate(at);
            const escaped = want.key.replace(/~/g, '~0').replace(/\//g, '~1');
            expect(
                node.pointer.startsWith(`/${escaped}`),
                `byte ${at} lies inside member ${ordinal} (${JSON.stringify(want.key)}, span ${want.start}..${want.end}) but locate said ${node.pointer}`,
            ).toBe(true);
            expect(
                at >= node.start && at < node.end,
                `locate(${at}) returned span ${node.start}..${node.end}, which does not contain the byte it was asked about`,
            ).toBe(true);
        }
    }, 60_000);

    it('returns the enclosing container for a byte that lies between members', () => {
        const ready = prepare(checkpointedArray(MEMBER_COUNT), 'array');
        const first = ready.truth[0];
        expect(first, 'ground truth must hold the first element').toBeDefined();
        if (first === undefined) return;
        // The comma after element 0 belongs to no member.
        const node = ready.resolver.locate(first.end);
        expect(
            node.pointer,
            'a byte between two members belongs to the container, not to either neighbour',
        ).toBe('');
    }, 60_000);
});

// ── the id routes: equivalence, cost and bound ────────────────────────────

/** Deterministic PRNG, so a shuffled pointer order is the same run to run. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return (): number => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** `items` in a reproducible shuffled order. */
function shuffled(items: readonly string[], seed: number): string[] {
    const out = items.slice();
    const random = mulberry32(seed);
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const high = out[i];
        const low = out[j];
        // Both indices are inside the array; the guard is what
        // `noUncheckedIndexedAccess` needs rather than a case that can occur.
        if (high === undefined || low === undefined) continue;
        out[i] = low;
        out[j] = high;
    }
    return out;
}

/** One document plus every pointer worth comparing over it. */
interface Subject {
    readonly label: string;
    readonly text: string;
    /** Pointers to compare — resolvable, unresolvable, and not pointers at all. */
    readonly pointers: readonly string[];
    /** True when the document is also small enough to check against `JSON.parse`. */
    readonly parseable: boolean;
}

/**
 * Everything `resolve` decided about one pointer, as a single line: node
 * identity, span, kind, depth, parent and count for a success, and the closed
 * failure code plus both strings a caller acts on for a failure. A line rather
 * than an object so a mismatch prints as the field that moved.
 */
function describeResolution(resolver: Resolver, pointer: string): string {
    try {
        const node = resolver.resolve(pointer);
        return `ok pointer=${JSON.stringify(node.pointer)} span=${node.start}..${node.end}`
            + ` kind=${node.kind} depth=${node.depth}`
            + ` parent=${node.parent === null ? '<root>' : JSON.stringify(node.parent)}`
            + ` count=${node.count}`;
    } catch (e) {
        if (e instanceof StrideError) {
            return `fail ${e.failure} at=${e.at === null ? '-' : e.at}`
                + ` message=${e.message} recovery=${e.recovery}`;
        }
        return `threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    }
}

/**
 * Reference-token split, written here rather than imported from pointer.ts: an
 * oracle that borrows the parser it is checking is not an oracle. Null for
 * anything that is not a JSON Pointer at all.
 */
function splitPointer(pointer: string): string[] | null {
    if (pointer === '') return [];
    if (!pointer.startsWith('/')) return null;
    return pointer.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** RFC 6901 array index, or -1. Leading zeros, signs and `-` are not indices. */
function arrayIndexOf(token: string): number {
    return /^(?:0|[1-9][0-9]*)$/.test(token) ? Number(token) : -1;
}

/** Escape one member name into a reference token, for building fixture pointers. */
function pointerToken(key: string): string {
    return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** The kind STRIDE gives a value, derived from the parsed value instead. */
function kindOfValue(value: unknown): StrideKind {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    switch (typeof value) {
        case 'object': return 'object';
        case 'string': return 'string';
        case 'number': return 'number';
        case 'boolean': return 'boolean';
        default: return 'null';
    }
}

/** The member/element count STRIDE reports, derived from the parsed value. */
function countOfValue(value: unknown): number {
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'object' && value !== null) return Object.keys(value).length;
    return 0;
}

/** The value a token list names inside a parsed document, or a miss. */
function valueAtTokens(root: unknown, tokens: readonly string[]): { found: boolean; value: unknown } {
    let at: unknown = root;
    for (const token of tokens) {
        if (Array.isArray(at)) {
            const i = arrayIndexOf(token);
            if (i < 0 || i >= at.length) return { found: false, value: undefined };
            const next: unknown = at[i];
            at = next;
            continue;
        }
        if (typeof at === 'object' && at !== null) {
            if (!Object.prototype.hasOwnProperty.call(at, token)) return { found: false, value: undefined };
            const next: unknown = Reflect.get(at, token);
            at = next;
            continue;
        }
        return { found: false, value: undefined };
    }
    return { found: true, value: at };
}

/**
 * The index, wrapped so that every read of a dense child table is counted.
 *
 * `denseChildren` is the accessor every id route has to go through — the
 * threaded route reads one per level of a whole descent, the derivation reads
 * one per level on every single call — so its call count IS the shape of the
 * cost, exactly and with no clock in it. Counting the property access rather
 * than the invocation is the same number here: every call site in resolve.ts
 * reads the method and calls it immediately.
 */
function countingIndex(index: StrideIndex): { readonly index: StrideIndex; reads: () => number } {
    let reads = 0;
    const counted = new Proxy(index, {
        get(target, property, receiver) {
            if (property === 'denseChildren') reads++;
            return Reflect.get(target, property, receiver);
        },
    });
    return { index: counted, reads: (): number => reads };
}

/**
 * Size of a resolver's byte-start memo.
 *
 * Reached by reflection because the memo is private and has to stay private,
 * while I6 is a claim about this map's size specifically: a bound nothing can
 * observe is a bound nothing can be held to. -1 when the field is not a Map,
 * which fails the assertions below rather than passing them quietly.
 */
function memoSize(resolver: Resolver): number {
    const memo: unknown = Reflect.get(resolver, 'ids');
    return memo instanceof Map ? memo.size : -1;
}

function buildSubject(subject: Subject, tag: string): { source: BufferSource; index: StrideIndex } {
    const source = new BufferSource(Buffer.from(subject.text, 'utf8'), `${tag}:${subject.label}`);
    const index = StrideIndex.build(source);
    expect(index.stats.errorAt, `${subject.label}: the generated fixture must be well-formed JSON`).toBe(-1);
    return { source, index };
}

// ── subjects ──────────────────────────────────────────────────────────────

/**
 * A spine that alternates object and array levels, so a descent alternates
 * between the by-name and the by-ordinal route, and every level carries a second
 * member so a pointer can leave the spine as well as follow it. Each level is
 * two members wide — inside DENSE_CHILD_LIMIT — so every level is dense and the
 * derivation has a full dense chain to descend, which is the case the threading
 * replaces and therefore the case that has to agree.
 */
function alternatingSpine(depth: number): Subject {
    let text = '"leaf"';
    for (let i = depth - 1; i >= 0; i--) {
        text = i % 2 === 0 ? `{"a":${text},"sib":${i}}` : `[${text},${i}]`;
    }
    const pointers: string[] = ['', '/', '/x', 'not-a-pointer', '/a/'];
    let at = '';
    for (let i = 0; i < depth; i++) {
        const isObject = i % 2 === 0;
        pointers.push(isObject ? `${at}/sib` : `${at}/1`);
        pointers.push(`${at}/nope`, `${at}/01`, `${at}/-`, `${at}/2`);
        at = isObject ? `${at}/a` : `${at}/0`;
        pointers.push(at);
    }
    pointers.push(`${at}/past-the-leaf`);
    return { label: `alternating spine of ${depth} levels`, text, pointers, parseable: true };
}

/**
 * An object far past DENSE_CHILD_LIMIT and far past STRIDE_RESCAN_BYTES, so it
 * is checkpointed AND covered by the member-name hash table for everything
 * except its first 12 KiB — the two by-name routes at once. Member 0 is named
 * the empty string, which is what `"/"` addresses; every 89th name carries a
 * `~`, a `/`, an escaped quote and a multi-byte character.
 */
function wideObjectSubject(count: number): Subject {
    const keyFor = (i: number): string => (i === 0 ? '' : i % 89 === 0 ? `k~/${i}"é` : `key-${i}`);
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
        parts.push(`${JSON.stringify(keyFor(i))}:{"n":${i},"pad":${JSON.stringify('p'.repeat(24))}}`);
    }
    const pointers: string[] = ['', '/', '/absent', '/KEY-1', `/key-${count}`, '/key--1', '/~2'];
    // Early ordinals sit inside the walk the stride is tuned for and carry no
    // hash entry by design; later ones are reached by the hash probe. Both
    // groups are sampled, because they are different routes to the same answer.
    for (const i of [0, 1, 2, 31, 32, 33, 89, 178, 500, 1000, 1500, count - 89, count - 1]) {
        const token = pointerToken(keyFor(i));
        pointers.push(`/${token}`, `/${token}/n`, `/${token}/pad`, `/${token}/absent`, `/${token}/0`);
    }
    return { label: `wide object of ${count} members`, text: `{${parts.join(',')}}`, pointers, parseable: true };
}

/**
 * A bulk array: past DENSE_CHILD_LIMIT, so it is checkpointed and NO element has
 * an index node of its own. Every interior pointer here is reached by the
 * bounded re-scan rather than by node id, which is exactly the coverage a memo
 * must not turn into "not found".
 */
function bulkArraySubject(count: number): Subject {
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
        parts.push(`{"n":${i},"tags":[${i},${i + 1}],"pad":${JSON.stringify('q'.repeat(16))}}`);
    }
    const pointers: string[] = ['', `/${count}`, '/-', '/01', '/007', '/n', '/1e3'];
    for (const i of [0, 1, 31, 32, 33, 63, 64, 512, 1000, count - 2, count - 1]) {
        pointers.push(`/${i}`, `/${i}/n`, `/${i}/tags`, `/${i}/tags/0`, `/${i}/tags/1`, `/${i}/tags/2`, `/${i}/absent`, `/${i}/n/0`);
    }
    return { label: `bulk array of ${count} records`, text: `[${parts.join(',')}]`, pointers, parseable: true };
}

/**
 * One document that takes every route at once: a dense root, dense sub-objects,
 * a bulk array whose records are not indexed, a wide object, a short spine, a
 * member of every scalar kind, both empty containers, and names that exercise
 * RFC 6901 escaping — the empty name, `~`, `/`, the literal texts `~0` and `~1`,
 * and a multi-byte character. `/~` is included on purpose: it is a pointer whose
 * token carries an escape RFC 6901 does not define, so it addresses the member
 * named `~` while the node reports the canonical `/~0`, and any shortcut that
 * confused the two would show up here.
 */
function heterogeneousSubject(): Subject {
    const bulk = Array.from({ length: 70 }, (_v, i) => `{"i":${i},"tag":"t${i}"}`).join(',');
    const wide = Array.from({ length: 90 }, (_v, i) => `"w${i}":${i}`).join(',');
    const text = '{'
        + '"":"empty name",'
        + '"~":"tilde","a/b":"slash","~0":"literal tilde-zero","~1":"literal tilde-one","é":"multi-byte",'
        + '"obj":{"one":1,"two":{"three":[1,2,3]}},'
        + '"arr":[10,[20,21],{"k":30}],'
        + `"bulk":[${bulk}],`
        + `"wide":{${wide}},`
        + '"deep":{"a":{"a":{"a":{"a":"bottom"}}}},'
        + '"str":"text","num":12345,"neg":-0.5,"exp":1e21,"t":true,"f":false,"nil":null,'
        + '"emptyObj":{},"emptyArr":[]'
        + '}';
    const pointers: string[] = [
        '', '/', '/~0', '/a~1b', '/~00', '/~01', '/é', '/~', '/~/x', '/~2', '/a/b',
        '/obj', '/obj/one', '/obj/two', '/obj/two/three', '/obj/two/three/0', '/obj/two/three/2',
        '/obj/two/three/3', '/obj/two/three/-', '/obj/two/three/01', '/obj/absent',
        '/arr', '/arr/0', '/arr/1', '/arr/1/0', '/arr/1/1', '/arr/2', '/arr/2/k', '/arr/3', '/arr/-', '/arr/01',
        '/bulk', '/bulk/0', '/bulk/0/i', '/bulk/0/tag', '/bulk/35', '/bulk/35/i', '/bulk/69',
        '/bulk/69/tag', '/bulk/70', '/bulk/0/absent', '/bulk/0/i/0',
        '/wide', '/wide/w0', '/wide/w45', '/wide/w89', '/wide/w90',
        '/deep', '/deep/a', '/deep/a/a', '/deep/a/a/a', '/deep/a/a/a/a', '/deep/a/a/a/a/a',
        '/str', '/str/0', '/num', '/neg', '/exp', '/t', '/f', '/nil',
        '/emptyObj', '/emptyObj/x', '/emptyArr', '/emptyArr/0',
        '/absent', 'nope', '/obj/two/three/0/deeper',
    ];
    // The root is 20 members wide, so it is indexed densely: this subject is
    // where the DENSE route's `"/"` is put to the oracle, and
    // `wideObjectSubject` is where the checkpointed route's is.
    return { label: 'heterogeneous document', text, pointers, parseable: true };
}

/**
 * Containers reached through pointers that carry an escape RFC 6901 does not
 * define, several levels deep.
 *
 * `~2` decodes to itself, so `"/~"` addresses the member named `~` while the
 * node that comes back reports the canonical `"/~0"`. The resolution cache is
 * keyed by the pointer the CALLER asked for, so after `"/~"` it holds an entry
 * whose key and whose node's pointer differ — and `resolve` resumes from cached
 * parents. Every mixture of canonical and aliased segments is here, with real
 * members under each, because "the answer must not depend on which spelling
 * happened to be cached" is the property the resume has to keep.
 */
function aliasSubject(): Subject {
    const text = '{"~":{"~":{"x":1},"y":2},"a/b":{"c":3},"~0":{"d":4},"~1":{"e":5}}';
    const pointers: string[] = [
        '',
        '/~0', '/~', '/~0/~0', '/~/~', '/~0/~', '/~/~0',
        '/~0/~0/x', '/~/~/x', '/~0/~/x', '/~/~0/x', '/~/~/y',
        '/~0/y', '/~/y', '/~0/absent', '/~/absent',
        '/a~1b', '/a~1b/c', '/a/b', '/a/b/c', '/a~1b/absent',
        '/~00', '/~00/d', '/~0/d', '/~01', '/~01/e', '/~1', '/~1/e',
        '/~2', '/~2/x', '/~/~/x/deeper',
    ];
    return { label: 'members behind non-canonical escapes', text, pointers, parseable: true };
}

/** The documents that are nothing but edges: empty, scalar, and empty-named. */
function edgeSubjects(): Subject[] {
    const edgePointers = [
        '', '/', '//', '///', '/0', '/1', '/-', '/01', '/x', '/~0', '/~1', '/~00', '/~01',
        '/~2', 'x', '/0/0', '/x/y/z',
    ];
    const docs: ReadonlyArray<readonly [string, string]> = [
        ['empty object', '{}'],
        ['empty array', '[]'],
        ['bare null', 'null'],
        ['bare string', '"just a string"'],
        ['bare number', '1e-6'],
        ['bare true', 'true'],
        ['empty names all the way down', '{"":{"":{"":1}}}'],
        ['names that look like escapes', '{"~":1,"a/b":2,"~0":3,"~1":4,"~01":5}'],
        ['nested empty arrays', '[[[[]]]]'],
        ['one element', '[42]'],
    ];
    return docs.map(([label, text]) => ({
        label,
        text,
        pointers: edgePointers,
        parseable: true,
    }));
}

/**
 * A tree every level of which is at most DENSE_CHILD_LIMIT wide, so every node
 * is indexed, dense, and reached by a distinct byte start — one memo entry each.
 * Pointers come out in pre-order, so a parent is always resolved before its
 * children and the resume path is the one under load.
 */
function denseTree(fanout: readonly number[]): { text: string; pointers: string[] } {
    const pointers: string[] = [''];
    const build = (level: number, at: string): string => {
        const width = fanout[level];
        if (width === undefined) return '0';
        const parts: string[] = [];
        for (let i = 0; i < width; i++) {
            const child = `${at}/k${i}`;
            pointers.push(child);
            parts.push(`"k${i}":${build(level + 1, child)}`);
        }
        return `{${parts.join(',')}}`;
    };
    const text = build(0, '');
    return { text, pointers };
}

// ── equivalence ───────────────────────────────────────────────────────────

/**
 * Resolve every pointer of a subject twice over — once through the id shortcuts
 * and once through the derivation alone — and require the two to agree on every
 * field, in four orders, on a resolver that has just been built and on one that
 * has already been through all four. Returns the number of comparisons made.
 */
function assertRoutesAgree(subject: Subject): number {
    const { index } = buildSubject(subject, 'equiv');
    const pointers = subject.pointers;

    // The control. `shortcuts: false` takes every index node id from
    // `deriveIndexId`, which reads the index and shares nothing at all with the
    // resume, the threading or the memo.
    const control = new Resolver(index, { shortcuts: false });
    const expected = new Map<string, string>();
    for (const pointer of pointers) expected.set(pointer, describeResolution(control, pointer));

    // A control with no accumulated state, over a sample, so a disagreement
    // cannot be hiding inside the control's own pointer cache.
    for (let i = 0; i < pointers.length; i += 5) {
        const pointer = pointers[i];
        if (pointer === undefined) continue;
        const want = expected.get(pointer);
        if (want === undefined) continue;
        expect(
            describeResolution(new Resolver(index, { shortcuts: false }), pointer),
            `${subject.label}: the control must not depend on its own cache to resolve ${JSON.stringify(pointer)}`,
        ).toBe(want);
    }

    const orders: ReadonlyArray<readonly [string, readonly string[]]> = [
        ['top-down, as generated', pointers],
        ['bottom-up', pointers.slice().reverse()],
        ['shuffled', shuffled(pointers, 0x5771de)],
        ['each pointer twice in a row', pointers.flatMap((p) => [p, p])],
    ];

    let comparisons = 0;
    // One resolver carried through every order as well as a fresh one per
    // order, because the shortcuts are the parts of this module that depend on
    // what happened before, and the cold and the loaded cases are different.
    const carried = new Resolver(index);
    for (const [order, sequence] of orders) {
        const fresh = new Resolver(index);
        for (const pointer of sequence) {
            const want = expected.get(pointer);
            if (want === undefined) continue;
            expect(
                describeResolution(fresh, pointer),
                `${subject.label} [${order}, fresh resolver]: ${JSON.stringify(pointer)} must resolve identically with the id shortcuts on and off`,
            ).toBe(want);
            expect(
                describeResolution(carried, pointer),
                `${subject.label} [${order}, resolver carried through every order]: ${JSON.stringify(pointer)} must resolve identically with the id shortcuts on and off`,
            ).toBe(want);
            comparisons += 2;
        }
    }
    return comparisons;
}

/**
 * Check the same pointers against a third opinion that shares no code with
 * STRIDE: `JSON.parse` of the whole document, walked by the token splitter
 * above. The bytes at the span STRIDE returns must parse to the value that walk
 * arrives at, and a pointer must resolve exactly when that walk finds something.
 */
function assertAgreesWithJsonParse(subject: Subject): number {
    if (!subject.parseable) return 0;
    const { source, index } = buildSubject(subject, 'oracle');
    const parsed: unknown = JSON.parse(subject.text);
    const resolver = new Resolver(index);
    let checked = 0;
    for (const pointer of subject.pointers) {
        const tokens = splitPointer(pointer);
        if (tokens === null) continue;              // not a pointer; nothing to compare
        const truth = valueAtTokens(parsed, tokens);
        let node: StrideNode | null = null;
        try {
            node = resolver.resolve(pointer);
        } catch (e) {
            expect(e, `${subject.label}: ${JSON.stringify(pointer)} must fail as a StrideError, not as a bare throw`).toBeInstanceOf(StrideError);
        }
        expect(
            node !== null,
            `${subject.label}: ${JSON.stringify(pointer)} must resolve exactly when JSON.parse has a value there`,
        ).toBe(truth.found);
        checked++;
        if (node === null || !truth.found) continue;
        expect(
            JSON.parse(source.slice(node.start, node.end).toString('utf8')),
            `${subject.label}: the bytes STRIDE spanned for ${JSON.stringify(pointer)} are not the value JSON.parse holds there`,
        ).toEqual(truth.value);
        expect(
            node.kind,
            `${subject.label}: kind of ${JSON.stringify(pointer)} disagrees with the parsed value`,
        ).toBe(kindOfValue(truth.value));
        expect(
            node.count,
            `${subject.label}: count of ${JSON.stringify(pointer)} disagrees with the parsed value`,
        ).toBe(countOfValue(truth.value));
    }
    return checked;
}

function allSubjects(): Subject[] {
    return [
        alternatingSpine(128),
        wideObjectSubject(2000),
        bulkArraySubject(3000),
        heterogeneousSubject(),
        aliasSubject(),
        ...edgeSubjects(),
    ];
}

describe('the fast id routes answer what the derivation answers', () => {
    it('agrees on every field for every pointer, over several documents and several orders', () => {
        let comparisons = 0;
        let pointers = 0;
        const subjects = allSubjects();
        for (const subject of subjects) {
            comparisons += assertRoutesAgree(subject);
            pointers += subject.pointers.length;
        }
        // Reported, because "the two routes agree" is only worth something
        // alongside how much was put to them.
        console.log(`[equivalence] ${subjects.length} documents, ${pointers} distinct pointer requests, ${comparisons} shortcut-vs-derivation comparisons`);
        expect(
            comparisons,
            'the comparison must actually have run over thousands of pointers, or agreement means nothing',
        ).toBeGreaterThan(5000);
    }, 120_000);

    it('agrees with JSON.parse about the span, kind and count at every pointer that resolves', () => {
        let checked = 0;
        for (const subject of allSubjects()) checked += assertAgreesWithJsonParse(subject);
        console.log(`[oracle] ${checked} pointers checked against JSON.parse of the whole document`);
        expect(checked, 'the oracle must have checked the whole pointer set').toBeGreaterThan(500);
    }, 120_000);

    it('resolves the pointers RFC 6901 is most often got wrong identically on both routes', () => {
        // Called out separately from the sweep above because these are the cases
        // I8 names, and a sweep that happened to drop one of them would still be
        // a green sweep.
        const escapes = heterogeneousSubject();
        const { source, index } = buildSubject(escapes, 'i8');
        const fast = new Resolver(index);
        const control = new Resolver(index, { shortcuts: false });
        // This document's root is 20 members wide, so it is indexed DENSELY:
        // these cases put I8 to the dense route, and the checkpointed route gets
        // the same treatment below.
        const cases: ReadonlyArray<readonly [string, string, string]> = [
            ['', 'the whole document', escapes.text],
            ['/', 'the member named "", not the document', '"empty name"'],
            ['/~0', 'the member named "~"', '"tilde"'],
            ['/a~1b', 'the member named "a/b"', '"slash"'],
            ['/~00', 'the member named "~0", not the member named "~"', '"literal tilde-zero"'],
            ['/~01', 'the member named "~1", not the member named "/"', '"literal tilde-one"'],
        ];
        for (const [pointer, what, bytes] of cases) {
            const answer = describeResolution(fast, pointer);
            expect(
                answer,
                `${JSON.stringify(pointer)} is ${what}, and both id routes must say so identically`,
            ).toBe(describeResolution(control, pointer));
            const node = fast.resolve(pointer);
            expect(
                source.slice(node.start, node.end).toString('utf8'),
                `${JSON.stringify(pointer)} is ${what} and must span exactly its bytes`,
            ).toBe(bytes);
        }

        // `"/"` is the member named the empty string and NOT the document, on
        // the CHECKPOINTED route as well as the dense one above. Both are here
        // because the two read the name from different places — the dense table
        // and the document's own bytes — and I8 has to hold on either.
        expect(
            fast.resolve('/').start === fast.resolve('').start,
            '"/" and "" must not span the same bytes: one is a member, the other the document',
        ).toBe(false);
        const wide = wideObjectSubject(2000);
        const built = buildSubject(wide, 'i8-empty-name');
        expect(
            built.index.isCheckpointed(built.index.rootId),
            'the container has to be on the checkpoint route for this to be the case it claims to be',
        ).toBe(true);
        const wideFast = new Resolver(built.index);
        const wideControl = new Resolver(built.index, { shortcuts: false });
        const slash = wideFast.resolve('/');
        expect(
            describeResolution(wideFast, '/'),
            '"/" must resolve identically with the id shortcuts on and off',
        ).toBe(describeResolution(wideControl, '/'));
        expect(
            slash.pointer,
            '"/" is the member named the empty string, not the document',
        ).toBe('/');
        expect(
            built.source.slice(slash.start, slash.end).toString('utf8'),
            '"/" must span the value of the empty-named member, not the document',
        ).toBe('{"n":0,"pad":"pppppppppppppppppppppppp"}');
        expect(
            wideFast.resolve('').pointer,
            '"" is the whole document',
        ).toBe('');
        expect(
            wideFast.resolve('').start === 0 && wideFast.resolve('').end === Buffer.byteLength(wide.text, 'utf8'),
            '"" must span the whole document, which is what distinguishes it from "/"',
        ).toBe(true);
    }, 60_000);

    it('still reaches a member the index never indexed, before and after the memo has churned', () => {
        // A record inside a bulk collection has no index node, so its own
        // members are found by re-scanning its bytes. The memo remembers that
        // absence as -1, and -1 has to keep meaning "re-scan for it" rather than
        // "not there" — including after the memo has been filled and evicted
        // many times over by unrelated pointers.
        const subject = bulkArraySubject(3000);
        const { index } = buildSubject(subject, 'partial');
        const resolver = new Resolver(index);
        const interiors = ['/0/n', '/1/tags/1', '/1500/n', '/2999/tags/0', '/2999/pad'];
        const before = interiors.map((p) => describeResolution(resolver, p));
        for (const [i, answer] of before.entries()) {
            expect(
                answer.startsWith('ok '),
                `${JSON.stringify(interiors[i] ?? '')} names a member of an unindexed record and must resolve`,
            ).toBe(true);
        }
        for (let i = 0; i < 3000; i++) resolver.resolve(`/${i}`);
        for (let i = 0; i < 3000; i += 3) resolver.resolve(`/${i}/tags`);
        for (const [i, answer] of before.entries()) {
            const pointer = interiors[i] ?? '';
            expect(
                describeResolution(resolver, pointer),
                `${JSON.stringify(pointer)} must resolve to the same node after the memo has churned as before it`,
            ).toBe(answer);
        }
    }, 120_000);
});

describe('the cost of resolving along a spine', () => {
    it('costs dense-table reads linear in depth for a whole top-down descent, not cubic', () => {
        // Asserted as counted index work rather than elapsed time: the defect
        // this replaces grew at a measured 2^3.05 per doubling of depth, and a
        // count catches that exactly, on any machine, under any load.
        let previous: { depth: number; reads: number } | null = null;
        for (const depth of [64, 128, 256, 512]) {
            const subject = alternatingSpine(depth);
            const spine = subject.pointers.filter((p) => p === '' || /^(?:\/a|\/0)+$/.test(p));
            const counted = countingIndex(StrideIndex.build(
                new BufferSource(Buffer.from(subject.text, 'utf8'), `scale:${depth}`),
            ));
            const resolver = new Resolver(counted.index);
            for (const pointer of spine) resolver.resolve(pointer);
            const reads = counted.reads();
            expect(
                spine.length,
                `depth ${depth}: the spine must be every prefix of the deepest pointer`,
            ).toBe(depth + 1);
            // One read per level is what threading costs. Four times that is
            // room for a future route that consults a parent's table twice,
            // and is still 300x under the 131,000 a quadratic single resolve
            // would need at depth 512.
            expect(
                reads,
                `depth ${depth}: a top-down descent over ${spine.length} pointers must not read more than 4 dense tables per level, and read ${reads}`,
            ).toBeLessThanOrEqual(4 * depth + 4);
            if (previous !== null) {
                expect(
                    reads / previous.reads,
                    `depth ${previous.depth} -> ${depth}: doubling the depth must at most 2.5x the index work; quadratic would be 4x and the defect measured 8.3x`,
                ).toBeLessThanOrEqual(2.5);
            }
            previous = { depth, reads };
        }
    }, 120_000);

    it('costs dense-table reads linear in depth for one cold pointer at the bottom of a spine', () => {
        for (const depth of [128, 512]) {
            const subject = alternatingSpine(depth);
            const deepest = subject.pointers.filter((p) => /^(?:\/a|\/0)+$/.test(p)).reduce((a, b) => (b.length > a.length ? b : a), '/a');
            const counted = countingIndex(StrideIndex.build(
                new BufferSource(Buffer.from(subject.text, 'utf8'), `cold:${depth}`),
            ));
            const resolver = new Resolver(counted.index);
            const node = resolver.resolve(deepest);
            expect(node.depth, `the deepest spine pointer at depth ${depth} must resolve to depth ${depth}`).toBe(depth);
            expect(
                counted.reads(),
                `depth ${depth}: one cold resolve must not read more than 4 dense tables per level, and read ${counted.reads()}`,
            ).toBeLessThanOrEqual(4 * depth + 4);
        }
    }, 120_000);

    it('does far less index work than the derivation, so the shortcuts are not doing nothing', () => {
        // The equivalence test would pass just as happily if every shortcut
        // quietly fell through to the derivation. This is the assertion that
        // says they did not.
        const depth = 128;
        const subject = alternatingSpine(depth);
        const spine = subject.pointers.filter((p) => p === '' || /^(?:\/a|\/0)+$/.test(p));
        const text = Buffer.from(subject.text, 'utf8');

        const fast = countingIndex(StrideIndex.build(new BufferSource(text, 'ratio:fast')));
        const fastResolver = new Resolver(fast.index);
        for (const pointer of spine) fastResolver.resolve(pointer);

        const slow = countingIndex(StrideIndex.build(new BufferSource(text, 'ratio:slow')));
        const slowResolver = new Resolver(slow.index, { shortcuts: false });
        for (const pointer of spine) slowResolver.resolve(pointer);

        console.log(`[cost] depth ${depth} descent: ${fast.reads()} dense-table reads with the shortcuts, ${slow.reads()} without`);
        expect(
            fast.reads() * 100,
            `a descent of depth ${depth} took ${fast.reads()} dense-table reads with the shortcuts and ${slow.reads()} without; the shortcuts must be worth at least 100x`,
        ).toBeLessThanOrEqual(slow.reads());
    }, 120_000);
});

describe('bounded memory (I6)', () => {
    it('holds the byte-start memo at its stated bound however many distinct nodes it is shown', () => {
        // 32 x 32 x 8 x 8 dense levels: 74,784 nodes, each with a byte start of
        // its own, against a bound of 16,384.
        const { text, pointers } = denseTree([32, 32, 8, 8]);
        expect(
            pointers.length,
            `the fixture must present far more distinct nodes than the ${RESOLVE_ID_CACHE_MAX}-entry bound, or the bound is not under test`,
        ).toBeGreaterThan(RESOLVE_ID_CACHE_MAX * 3);

        const source = new BufferSource(Buffer.from(text, 'utf8'), 'bound');
        const index = StrideIndex.build(source);
        expect(index.stats.errorAt, 'the generated tree must be well-formed JSON').toBe(-1);
        const resolver = new Resolver(index);
        expect(memoSize(resolver), 'the byte-start memo must be reachable and empty to begin with').toBe(0);

        let peak = 0;
        for (const pointer of pointers) {
            resolver.resolve(pointer);
            const size = memoSize(resolver);
            if (size > peak) peak = size;
        }
        expect(
            peak,
            `after ${pointers.length} distinct nodes the memo peaked at ${peak} entries, past its ${RESOLVE_ID_CACHE_MAX} bound`,
        ).toBeLessThanOrEqual(RESOLVE_ID_CACHE_MAX);
        expect(
            peak,
            `the memo must actually fill to its bound, or ${pointers.length} pointers never tested eviction`,
        ).toBe(RESOLVE_ID_CACHE_MAX);

        // Eviction must cost speed and nothing else: the entries evicted first
        // are the ones this asks for again.
        const control = new Resolver(index, { shortcuts: false });
        for (let i = 0; i < pointers.length; i += 977) {
            const pointer = pointers[i];
            if (pointer === undefined) continue;
            expect(
                describeResolution(resolver, pointer),
                `${JSON.stringify(pointer)} must resolve the same after its memo entry was evicted as before`,
            ).toBe(describeResolution(control, pointer));
        }
        console.log(`[bound] ${pointers.length} distinct nodes resolved, memo peaked at ${peak} of ${RESOLVE_ID_CACHE_MAX} entries`);
    }, 300_000);
});

// ---------------------------------------------------------------------------
// A name STRIDE cannot say is a member STRIDE cannot address, and the two
// places a name can be lost are the two places it is stored: the index's dense
// child table, and nowhere at all — a checkpointed container re-reads its names
// out of the document. Those are different code, so a name has to be put to
// BOTH, at every container width where the build switches between them.
//
// The width sweep below is the point. `""` was reachable in a checkpointed
// container and unreachable in a dense one for as long as it was, because a
// hand-written fixture is almost always narrow and a generated one almost
// always wide, so no single fixture ever crossed the boundary. These cross it in
// both directions, and assert which route each width actually took rather than
// assuming it.
// ---------------------------------------------------------------------------

/** Container widths that bracket every threshold the index switches on. */
const NAME_SWEEP_SIZES: readonly number[] = [
    1, 2, DENSE_CHILD_LIMIT - 1, DENSE_CHILD_LIMIT, DENSE_CHILD_LIMIT + 1,
    STRIDE_DEFAULT, STRIDE_DEFAULT + 1, 300,
];

/**
 * Names that share the empty name's code path: they are stored the same way,
 * read back the same way, and each is one a pointer implementation is known to
 * mishandle. `""` is the one this file was changed for; the rest are its
 * neighbours, and a fix that special-cased the empty name would break them.
 */
const NEIGHBOUR_NAMES: readonly string[] = [
    '',                 // the whole reason for this sweep: RFC 6901's "/"
    '/',                // escapes to ~1, and is the byte a pointer splits on
    '~',                // escapes to ~0
    '~0',               // the LITERAL text "~0", which must escape to "~00"
    '~1',               // the LITERAL text "~1", which must escape to "~01"
    ' ',                // a single space: a name a trimming parser loses
    '\u0000',        // a single NUL byte, which JSON escapes and C truncates
    'x'.repeat(10_000), // longer than any name-length field should assume
];

/** Where in the container the name under test sits. */
const NAME_POSITIONS: ReadonlyArray<readonly [string, (size: number) => number]> = [
    ['the head', () => 0],
    ['the interior', (size) => Math.floor(size / 2)],
    ['the tail', (size) => size - 1],
];

/** A name, short enough to print and unambiguous about what it is. */
function describeName(name: string): string {
    if (name.length <= 24) return JSON.stringify(name);
    return `${JSON.stringify(name.slice(0, 12))}... (${name.length} chars)`;
}

/**
 * An object of `size` members, one of them named `name` at ordinal `at` and the
 * rest named `f0`, `f1`, ... — none of which can collide with any name in
 * NEIGHBOUR_NAMES. Values are distinct per ordinal, so landing on the wrong
 * member is a visible failure and not a coincidence.
 */
function objectWithName(size: number, at: number, name: string): { text: string; target: string } {
    const parts: string[] = [];
    for (let i = 0; i < size; i++) {
        const key = i === at ? name : `f${i}`;
        parts.push(`${JSON.stringify(key)}:${JSON.stringify(`v${i}`)}`);
    }
    return { text: `{${parts.join(',')}}`, target: JSON.stringify(`v${at}`) };
}

describe('a member is addressable by its name whatever that name is and however wide its container', () => {
    it('enumerates, resolves, finds by name and round-trips every awkward name at every width', () => {
        let dense = 0;
        let checkpointed = 0;
        let cases = 0;

        for (const name of NEIGHBOUR_NAMES) {
            for (const size of NAME_SWEEP_SIZES) {
                // Deduplicated: at size 1 and 2 the three positions collapse, and
                // running the same document three times would inflate the case
                // count without testing anything more.
                const ats = [...new Set(NAME_POSITIONS.map(([, of]) => of(size)))];
                for (const at of ats) {
                    const where = NAME_POSITIONS.find(([, of]) => of(size) === at)?.[0] ?? 'the head';
                    const subject = `an object of ${size} members with the member named ${describeName(name)} at ${where}`;
                    const { text, target } = objectWithName(size, at, name);
                    const source = new BufferSource(Buffer.from(text, 'utf8'), `names:${size}:${at}`);
                    const index = StrideIndex.build(source);
                    expect(index.stats.errorAt, `${subject}: the fixture must be well-formed JSON`).toBe(-1);

                    const resolver = new Resolver(index);
                    const root = resolver.root();
                    expect(root.count, `${subject}: the root must hold all ${size} members`).toBe(size);

                    // Which route this width took, asserted rather than assumed:
                    // the defect was route-specific, so a sweep that did not know
                    // its own route could pass while covering one route twice.
                    const isDense = index.isDense(index.rootId);
                    if (isDense) dense++; else checkpointed++;
                    expect(
                        isDense,
                        `${subject}: a container of ${size} members must take the ${size <= DENSE_CHILD_LIMIT ? 'dense' : 'checkpointed'} route, and the sweep has to cover both`,
                    ).toBe(size <= DENSE_CHILD_LIMIT);

                    // ── enumerates ────────────────────────────────────────────
                    const members = resolver.members(root, 0, size);
                    expect(
                        members.length,
                        `${subject}: all ${size} members must enumerate, or one is withheld without being counted`,
                    ).toBe(size);
                    const listed = members[at];
                    expect(
                        listed?.key,
                        `${subject}: the member at ordinal ${at} must enumerate WITH its name; null there means "array element, no name" and would hide it from every by-name route`,
                    ).toBe(name);

                    // ── found by name ─────────────────────────────────────────
                    const byKey = resolver.memberByKey(root, name);
                    expect(
                        byKey === null,
                        `${subject}: memberByKey must find it`,
                    ).toBe(false);
                    expect(
                        byKey?.ordinal,
                        `${subject}: memberByKey must find THAT member and not another`,
                    ).toBe(at);

                    // ── resolves by the pointer STRIDE emits for it ────────────
                    // Built with this file's own escaper, so the pointer STRIDE
                    // reports has to agree with an independent one rather than
                    // with itself.
                    const pointer = `/${pointerToken(name)}`;
                    const node = resolver.resolve(pointer);
                    expect(
                        source.slice(node.start, node.end).toString('utf8'),
                        `${subject}: ${JSON.stringify(pointer.slice(0, 40))} must span the value of that member and no other`,
                    ).toBe(target);
                    expect(
                        node.pointer,
                        `${subject}: the resolved node must report the canonical pointer it was reached by`,
                    ).toBe(pointer);

                    // ── round-trips ───────────────────────────────────────────
                    // The emit/accept rule: hand STRIDE's own answer straight
                    // back and require the same span, then check the name that
                    // pointer decodes to against a splitter written here.
                    const again = resolver.resolve(node.pointer);
                    expect(
                        `${again.start}..${again.end}`,
                        `${subject}: re-resolving the pointer STRIDE emitted must land on the same bytes`,
                    ).toBe(`${node.start}..${node.end}`);
                    expect(
                        splitPointer(node.pointer),
                        `${subject}: the emitted pointer must decode back to exactly that one name`,
                    ).toEqual([name]);

                    // ── against JSON.parse ────────────────────────────────────
                    const truth: unknown = JSON.parse(text);
                    expect(
                        JSON.parse(source.slice(node.start, node.end).toString('utf8')),
                        `${subject}: the bytes STRIDE spanned are not the value JSON.parse holds at that name`,
                    ).toEqual(valueAtTokens(truth, [name]).value);
                    cases++;
                }
            }
        }

        console.log(`[names] ${cases} name/width/position cases: ${dense} on the dense route, ${checkpointed} on the checkpoint route`);
        expect(
            dense > 0 && checkpointed > 0,
            `the sweep must cross the dense/checkpoint boundary in both directions; it ran ${dense} dense and ${checkpointed} checkpointed cases`,
        ).toBe(true);
    }, 300_000);

    it('keeps an array element nameless, so the empty name and no name stay different facts', () => {
        // The other half of the distinction, and the half a fix could break by
        // making every row report a name. An element of an array has no name at
        // any width, and `null` is how that is said.
        for (const size of NAME_SWEEP_SIZES) {
            const text = `[${Array.from({ length: size }, (_v, i) => JSON.stringify(`v${i}`)).join(',')}]`;
            const source = new BufferSource(Buffer.from(text, 'utf8'), `elements:${size}`);
            const index = StrideIndex.build(source);
            const resolver = new Resolver(index);
            const members = resolver.members(resolver.root(), 0, size);
            expect(members.length, `an array of ${size} elements must enumerate all of them`).toBe(size);
            for (const m of members) {
                expect(
                    m.key,
                    `an array of ${size} elements: element ${m.ordinal} must report NO name; "" there would make it indistinguishable from a member named the empty string`,
                ).toBeNull();
            }
            expect(
                resolver.memberByKey(resolver.root(), '') === null,
                `an array of ${size} elements has no member named "", so looking one up must find nothing`,
            ).toBe(true);
        }
    }, 120_000);

    it('addresses the empty name at every level of a spine of nothing but empty names', () => {
        // Nesting is where a name lost at one level hides the levels beneath it:
        // the pointer for depth 3 is "///", and it can only be reached if every
        // level above it resolved by the same name first.
        const depth = 6;
        let text = '"bottom"';
        for (let i = 0; i < depth; i++) text = `{"":${text},"sib${i}":${i}}`;
        const source = new BufferSource(Buffer.from(text, 'utf8'), 'empty-name-spine');
        const index = StrideIndex.build(source);
        expect(index.stats.errorAt, 'the generated spine must be well-formed JSON').toBe(-1);
        const resolver = new Resolver(index);
        const control = new Resolver(index, { shortcuts: false });
        for (let level = 1; level <= depth; level++) {
            const pointer = '/'.repeat(level);
            const node = resolver.resolve(pointer);
            expect(
                node.depth,
                `${JSON.stringify(pointer)} is ${level} empty-named levels down and must resolve to depth ${level}`,
            ).toBe(level);
            expect(
                describeResolution(resolver, pointer),
                `${JSON.stringify(pointer)} must resolve identically with the id shortcuts on and off`,
            ).toBe(describeResolution(control, pointer));
        }
        // `depth` empty-named levels put the leaf at `depth` tokens down, so the
        // deepest pointer of the loop above is the one that reaches it.
        const bottom = resolver.resolve('/'.repeat(depth));
        expect(
            source.slice(bottom.start, bottom.end).toString('utf8'),
            `${JSON.stringify('/'.repeat(depth))} must reach the value at the bottom of the spine`,
        ).toBe('"bottom"');
        // One level past the leaf asks a string for a member. The empty name is
        // still a name there, so this must fail as `not_found` and not resolve to
        // the leaf: reaching "" everywhere must not mean reaching it anywhere.
        expect(
            describeResolution(resolver, '/'.repeat(depth + 1)),
            `${JSON.stringify('/'.repeat(depth + 1))} asks the leaf string for a member named "" and must fail as not_found`,
        ).toBe(describeResolution(control, '/'.repeat(depth + 1)));
        expect(
            describeResolution(resolver, '/'.repeat(depth + 1)).startsWith('fail not_found'),
            `${JSON.stringify('/'.repeat(depth + 1))} must fail as not_found, and reported: ${describeResolution(resolver, '/'.repeat(depth + 1))}`,
        ).toBe(true);
    }, 120_000);
});
