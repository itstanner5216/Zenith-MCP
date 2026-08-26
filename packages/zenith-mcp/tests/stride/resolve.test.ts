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

import { describe, expect, it } from 'vitest';
import { StrideIndex } from '../../src/core/stride/index.js';
import { Resolver, type Member } from '../../src/core/stride/resolve.js';
import { BufferSource } from '../../src/core/stride/source.js';
import { scanStructure, K_ARRAY, K_OBJECT } from '../../src/core/stride/scan.js';
import { StrideError, type StrideKind, type StrideNode } from '../../src/core/stride/types.js';
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
