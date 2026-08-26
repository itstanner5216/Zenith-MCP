// ---------------------------------------------------------------------------
// tests/stride/index.test.ts
//
// Two properties of the structural index, both of them invariants rather than
// behaviours, and neither of them observable from the shape of the output.
//
// CHECKPOINT MEANING (I7 FULL RECALL). A checkpoint is a promise: resume a scan
// here and you will see exactly the members a scan from the container's first
// byte would have seen from this ordinal onward. For an object that promise is
// only kept if the offset names the first byte of the member NAME. An offset one
// name-token late still scans, still returns members, and still looks entirely
// plausible — it just pairs every name with the previous member's value and
// loses one member per checkpoint. So the test below resumes at EVERY
// checkpoint the index recorded, not a sample, and compares keys and spans
// against ground truth accumulated while the fixture text was assembled.
//
// BOUNDED MEMORY (I6). Index memory has to be a small fraction of document
// size, and the way it stops being one is descent: a bulk collection whose
// records keep being given index nodes of their own turns a 25 MB document into
// a 53 MB index. The nodes are not merely wasteful, they are unreachable —
// resolve.ts reads a member's node id out of its parent's dense table and has
// no other route to it — so the test asserts both the footprint and the thing
// the footprint pays for: that members(), memberByIndex() and locate() still
// answer correctly on the very document whose records were never indexed.
//
// Every fixture is generated in code and every expectation is arithmetic over
// the pieces the generator emitted, so no assertion here shares code with the
// index, the resolver or the scanner.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { StrideIndex, decodeJsonString } from '../../src/core/stride/index.js';
import { Resolver } from '../../src/core/stride/resolve.js';
import { BufferSource } from '../../src/core/stride/source.js';
import { scanStructure, K_ARRAY, K_OBJECT } from '../../src/core/stride/scan.js';
import { DENSE_CHILD_LIMIT } from '../../src/core/stride/types.js';

/**
 * Ceiling on index footprint for a bulk document, as a fraction of document
 * size.
 *
 * types.ts states the measured design point as 0.031% of document size at the
 * default stride, and a nested-record document is precisely that case: one
 * checkpointed root, one 8-byte offset per stride members, and nothing at all
 * per record. 0.5% leaves sixteen times that headroom for a fixture whose
 * records happen to be small, and is still two orders of magnitude below any
 * figure that could be described as other than a small fraction of the
 * document. It does not need to be tight to be useful: the regression it exists
 * to catch measured 213%.
 */
const BULK_INDEX_RATIO_MAX = 0.005;

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
    /** Byte offset of the member VALUE's first byte. */
    readonly start: number;
    /** Byte offset one past the value's last byte. */
    readonly end: number;
}

interface Fixture {
    readonly text: string;
    /**
     * Length in BYTES, which is not the string's length: the names below carry
     * multi-byte characters on purpose, and every offset STRIDE deals in is a
     * byte offset.
     */
    readonly bytes: number;
    readonly members: readonly Expected[];
}

/**
 * An object of `count` members whose values are about `valueBytes` bytes each,
 * so the stride the build settles on is a property of the fixture rather than an
 * accident. Every 97th name carries a `~`, a `/`, an escaped quote and a
 * multi-byte character: a byte offset that was quietly computed in characters,
 * or a name read without unescaping, cannot survive those.
 */
function wideObject(count: number, valueBytes: number): Fixture {
    const doc = assemble();
    doc.emit('{');
    const members: Expected[] = [];
    for (let i = 0; i < count; i++) {
        if (i > 0) doc.emit(',');
        const key = i % 97 === 0 ? `k~/${i}"é` : `key-${i}`;
        doc.emit(`${JSON.stringify(key)}:`);
        const value = JSON.stringify(`${i}-${'x'.repeat(Math.max(1, valueBytes))}`);
        const start = doc.emit(value);
        members.push({ ordinal: i, key, start, end: doc.at() });
    }
    doc.emit('}');
    return { text: doc.text(), bytes: doc.at(), members };
}

/** One record of the nested-record document, with the spans worth addressing. */
interface RecordSpans {
    readonly ordinal: number;
    readonly start: number;
    readonly end: number;
    readonly email: string;
    readonly emailStart: number;
    readonly emailEnd: number;
    readonly tagsStart: number;
    readonly tagsEnd: number;
    readonly tags: readonly string[];
    readonly tagSpans: readonly (readonly [number, number])[];
}

/**
 * An array of records, each holding an inner array — the shape that made the
 * index outgrow its document, because every record and every inner array was
 * given a node of its own. Grows until the document passes `targetBytes`.
 */
function nestedRecords(targetBytes: number): { text: string; bytes: number; records: readonly RecordSpans[] } {
    const doc = assemble();
    doc.emit('[');
    const records: RecordSpans[] = [];
    let i = 0;
    while (doc.at() < targetBytes) {
        if (i > 0) doc.emit(',');
        const start = doc.emit(`{"id":${1_000_000 + i},"name":"record-${String(i).padStart(7, '0')}","email":`);
        const email = `user${i}@example.com`;
        const emailStart = doc.emit(JSON.stringify(email));
        const emailEnd = doc.at();
        doc.emit(',"tags":');
        const tagsStart = doc.emit('[');
        const tags: readonly string[] = [`alpha-${i}`, `beta-${i % 7}`, `gamma-${i % 13}`];
        const tagSpans: (readonly [number, number])[] = [];
        let t = 0;
        for (const tag of tags) {
            if (t > 0) doc.emit(',');
            const from = doc.emit(JSON.stringify(tag));
            tagSpans.push([from, doc.at()]);
            t++;
        }
        doc.emit(']');
        const tagsEnd = doc.at();
        doc.emit(`,"score":${(i % 1000) / 10},"active":${i % 2 === 0}}`);
        records.push({
            ordinal: i, start, end: doc.at(),
            email, emailStart, emailEnd,
            tagsStart, tagsEnd, tags, tagSpans,
        });
        i++;
    }
    doc.emit(']');
    return { text: doc.text(), bytes: doc.at(), records };
}

/**
 * Every distinct checkpoint the index holds for `id`.
 *
 * The index does not publish its checkpoint count, so this probes
 * `checkpointBefore` at every stride step and keeps each new boundary it is
 * handed. Sampling would not be a proof: one bad checkpoint loses one member,
 * and a sample that skipped it would pass.
 */
function everyCheckpoint(idx: StrideIndex, id: number, count: number): { offset: number; ordinal: number }[] {
    const stride = idx.strideOf(id);
    const out: { offset: number; ordinal: number }[] = [];
    let previous = -1;
    for (let ordinal = 0; ordinal < count; ordinal += stride) {
        const cp = idx.checkpointBefore(id, ordinal);
        if (cp === null) break;
        // Past the last slot the lookup clamps and repeats itself.
        if (cp.ordinal === previous) continue;
        previous = cp.ordinal;
        out.push(cp);
    }
    return out;
}

/**
 * Enumerate an object's members by resuming a scan at `fromByte`, which is what
 * every checkpoint route in resolve.ts does with the offset it is given.
 */
function enumerateObjectFrom(
    source: BufferSource,
    fromByte: number,
    containerEnd: number,
): { key: string | null; start: number; end: number }[] {
    const out: { key: string | null; start: number; end: number }[] = [];
    let nameStart = -1;
    let nameEnd = -1;
    const take = (start: number, end: number): void => {
        const key = nameStart < 0 ? null : decodeJsonString(source.slice(nameStart, nameEnd));
        nameStart = -1;
        out.push({ key, start, end });
    };
    scanStructure(source, fromByte, containerEnd, {
        enter() { /* the span is only known at exit */ },
        exit(_kind, start, end, depth) { if (depth === 1) take(start, end); },
        key(start, end, depth) { if (depth === 1) { nameStart = start; nameEnd = end; } },
        scalar(_kind, start, end, depth) { if (depth === 1) take(start, end); },
    }, K_OBJECT);
    return out;
}

/** One line per member, so a mismatch shows which member and which field. */
function encode(members: readonly { key: string | null; start: number; end: number }[]): string[] {
    return members.map((m) => `${m.key ?? '<none>'}@${m.start}..${m.end}`);
}

function sourceOf(text: string, id: string): BufferSource {
    return new BufferSource(Buffer.from(text, 'utf8'), id);
}

/**
 * Resume at every checkpoint of a checkpointed object and require the exact
 * ground-truth member sequence from that ordinal onward.
 */
function assertEveryCheckpointResumesExactly(fixture: Fixture, label: string, minCheckpoints: number): void {
    const source = sourceOf(fixture.text, label);
    const idx = StrideIndex.build(source);
    const root = idx.rootId;

    expect(idx.stats.errorAt, `${label}: the generated fixture must be well-formed JSON`).toBe(-1);
    expect(
        idx.isCheckpointed(root),
        `${label}: an object of ${fixture.members.length} members must be on the checkpoint route, or this proves nothing`,
    ).toBe(true);

    const checkpoints = everyCheckpoint(idx, root, fixture.members.length);
    expect(
        checkpoints.length,
        `${label}: expected at least ${minCheckpoints} recorded checkpoints to resume from, got ${checkpoints.length}`,
    ).toBeGreaterThanOrEqual(minCheckpoints);

    for (const cp of checkpoints) {
        const expected = fixture.members.slice(cp.ordinal);
        const got = enumerateObjectFrom(source, cp.offset, fixture.bytes);
        const seen = new Set(got.map((m) => m.key));
        const dropped = expected.filter((m) => !seen.has(m.key)).map((m) => m.key);

        expect(
            dropped,
            `${label}: resuming at checkpoint ordinal ${cp.ordinal} (byte ${cp.offset}) lost these members entirely`,
        ).toEqual([]);
        expect(
            got.length,
            `${label}: resuming at checkpoint ordinal ${cp.ordinal} (byte ${cp.offset}) enumerated ${got.length} members where ground truth from that ordinal holds ${expected.length}`,
        ).toBe(expected.length);
        expect(
            new Set(got.map((m) => m.start)).size,
            `${label}: resuming at checkpoint ordinal ${cp.ordinal} reported the same member span twice`,
        ).toBe(got.length);
        expect(
            encode(got),
            `${label}: resuming at checkpoint ordinal ${cp.ordinal} (byte ${cp.offset}) did not reproduce the ground-truth key and span sequence`,
        ).toEqual(encode(expected));
    }
}

describe('checkpoints of a wide object', () => {
    it('enumerates exactly the ground-truth member sequence when resumed at every checkpoint it recorded', () => {
        // ~200 bytes per member keeps the byte-tuned stride at its default, so
        // the object carries checkpoints in the tens rather than a handful.
        assertEveryCheckpointResumesExactly(wideObject(2000, 180), 'object of 2,000 x ~200 B members', 24);
    }, 60_000);

    it('enumerates exactly the ground-truth member sequence when the stride has been coarsened', () => {
        // Small members drive the byte-tuned stride far above its default, which
        // exercises the halving path that rebuilds the checkpoint table.
        assertEveryCheckpointResumesExactly(wideObject(2000, 4), 'object of 2,000 x ~16 B members', 2);
    }, 60_000);

    it('maps a raw byte offset inside a wide object back to the member that contains it', () => {
        const fixture = wideObject(2000, 180);
        const source = sourceOf(fixture.text, 'locate-object');
        const resolver = new Resolver(StrideIndex.build(source));
        for (const ordinal of [0, 1, 63, 64, 1023, 1500, 1999]) {
            const member = fixture.members[ordinal];
            expect(member, `fixture must hold member ${ordinal}`).toBeDefined();
            if (member === undefined) continue;
            const at = member.start + Math.floor((member.end - member.start) / 2);
            const node = resolver.locate(at);
            expect(
                [node.pointer, node.start, node.end],
                `byte ${at} lies inside member ${ordinal} (${JSON.stringify(member.key)}, span ${member.start}..${member.end})`,
            ).toEqual([`/${member.key === null ? '' : member.key.replace(/~/g, '~0').replace(/\//g, '~1')}`, member.start, member.end]);
        }
    }, 60_000);
});

describe('the dense limit', () => {
    it('records a container at the dense limit member by member and one past it by checkpoint', () => {
        const dense = wideObject(DENSE_CHILD_LIMIT, 4);
        const bulk = wideObject(DENSE_CHILD_LIMIT + 1, 4);

        const denseIdx = StrideIndex.build(sourceOf(dense.text, 'at-limit'));
        expect(
            denseIdx.isDense(denseIdx.rootId),
            `an object of exactly DENSE_CHILD_LIMIT (${DENSE_CHILD_LIMIT}) members must be indexed child by child`,
        ).toBe(true);
        expect(
            encode(denseIdx.denseChildren(denseIdx.rootId)),
            'the dense table must hold every member with its exact name and span',
        ).toEqual(encode(dense.members));

        const bulkIdx = StrideIndex.build(sourceOf(bulk.text, 'past-limit'));
        expect(
            bulkIdx.isDense(bulkIdx.rootId),
            `an object of DENSE_CHILD_LIMIT + 1 (${DENSE_CHILD_LIMIT + 1}) members must stop recording members one by one`,
        ).toBe(false);
        expect(
            bulkIdx.isCheckpointed(bulkIdx.rootId),
            'a container that stopped recording densely must be reachable by checkpoint instead',
        ).toBe(true);

        const resolver = new Resolver(bulkIdx);
        expect(
            encode(resolver.members(resolver.root(), 0, DENSE_CHILD_LIMIT + 1)),
            'dropping the dense table must not drop a member: every one is still enumerable',
        ).toEqual(encode(bulk.members));
    });

    it('gives index nodes to the members of a structural container and none to the members of a bulk one', () => {
        const doc = assemble();
        doc.emit('{"structure":[');
        for (let i = 0; i < 3; i++) {
            if (i > 0) doc.emit(',');
            doc.emit(`{"a":${i}}`);
        }
        doc.emit('],"bulk":[');
        const bulkCount = DENSE_CHILD_LIMIT + 8;
        for (let i = 0; i < bulkCount; i++) {
            if (i > 0) doc.emit(',');
            doc.emit(`{"a":${i}}`);
        }
        doc.emit(']}');

        const idx = StrideIndex.build(sourceOf(doc.text(), 'skeleton'));
        // Root, "structure", its three records, "bulk". The records inside
        // "bulk" get nothing: the first DENSE_CHILD_LIMIT + 1 of them are
        // entered before it proves itself bulk and are given back when it does.
        expect(
            idx.stats.nodes,
            `the skeleton is root + "structure" + its 3 records + "bulk" = 6 nodes; ${bulkCount} bulk records must contribute none`,
        ).toBe(6);

        const rootChildren = idx.denseChildren(idx.rootId);
        expect(rootChildren.map((c) => c.key), 'the root object must still name both of its members').toEqual(['structure', 'bulk']);

        const structure = rootChildren[0];
        const bulk = rootChildren[1];
        expect(structure, 'the root dense table must hold "structure"').toBeDefined();
        expect(bulk, 'the root dense table must hold "bulk"').toBeDefined();
        if (structure === undefined || bulk === undefined) return;

        expect(
            idx.denseChildren(structure.node).map((c) => c.node >= 0),
            'every member of a structural array must carry its own node id',
        ).toEqual([true, true, true]);
        expect(
            idx.isCheckpointed(bulk.node),
            'a bulk array must be represented by checkpoints',
        ).toBe(true);
        expect(
            idx.denseChildren(bulk.node),
            'a bulk array must hold no per-member rows at all',
        ).toEqual([]);
    });
});

describe('a nested-record document of tens of megabytes', () => {
    it('indexes in a small fraction of its own size, completely, and still answers every random access', () => {
        const { text, bytes, records } = nestedRecords(20_000_000);
        const source = sourceOf(text, 'nested-records');
        const idx = StrideIndex.build(source);
        const stats = idx.stats;
        const ratio = stats.bytes / bytes;

        // The scale test's measurement is its output, not a side effect.
        console.log(
            `[I6] documentBytes=${bytes} records=${records.length} nodes=${stats.nodes}`
            + ` denseChildren=${stats.denseChildren} checkpoints=${stats.checkpoints}`
            + ` indexBytes=${stats.bytes} indexPct=${(100 * ratio).toFixed(4)}%`
            + ` truncatedIndex=${stats.truncatedIndex} buildMs=${stats.buildMs}`,
        );

        expect(stats.errorAt, 'the generated fixture must be well-formed JSON').toBe(-1);
        expect(bytes, 'the fixture must be the tens of megabytes the bound is about').toBeGreaterThan(20_000_000);
        expect(
            stats.truncatedIndex,
            `the structural index must be complete: a capped index is an incomplete one (I7), and this one used ${stats.nodes} nodes`,
        ).toBe(false);
        expect(
            ratio,
            `index is ${stats.bytes} B for a ${bytes} B document = ${(100 * ratio).toFixed(4)}%, over the ${100 * BULK_INDEX_RATIO_MAX}% bound (I6)`,
        ).toBeLessThan(BULK_INDEX_RATIO_MAX);

        // What the footprint pays for: none of these records has an index entry,
        // so every answer below comes from a bounded re-scan.
        const resolver = new Resolver(idx);
        const root = resolver.root();
        expect(root.count, `the root array must report all ${records.length} records`).toBe(records.length);

        const probes = [0, 1, 63, 64, 65, 1023, 5000, records.length - 2, records.length - 1];

        for (const ordinal of probes) {
            const record = records[ordinal];
            expect(record, `fixture must hold record ${ordinal}`).toBeDefined();
            if (record === undefined) continue;

            const byIndex = resolver.memberByIndex(root, ordinal);
            expect(
                byIndex === null ? null : [byIndex.start, byIndex.end, byIndex.kind],
                `memberByIndex(${ordinal}) must return the record spanning ${record.start}..${record.end}`,
            ).toEqual([record.start, record.end, 'object']);

            const window = resolver.members(root, ordinal, 3);
            const expectedWindow = records.slice(ordinal, ordinal + 3);
            expect(
                window.map((m) => `${m.ordinal}@${m.start}..${m.end}`),
                `members(${ordinal}, 3) must equal the ground-truth window`,
            ).toEqual(expectedWindow.map((r) => `${r.ordinal}@${r.start}..${r.end}`));

            const email = resolver.resolve(`/${ordinal}/email`);
            expect(
                [email.start, email.end, email.kind],
                `/${ordinal}/email must resolve to the span holding ${JSON.stringify(record.email)}`,
            ).toEqual([record.emailStart, record.emailEnd, 'string']);

            const tags = resolver.resolve(`/${ordinal}/tags`);
            expect(
                [tags.start, tags.end, tags.kind, tags.count],
                `/${ordinal}/tags must resolve to the inner array with its true element count`,
            ).toEqual([record.tagsStart, record.tagsEnd, 'array', record.tags.length]);

            // locate() descends the checkpointed root by byte, then the record by
            // interior scan, then the inner array: three routes in one call.
            const tagSpan = record.tagSpans[1];
            expect(tagSpan, `fixture must hold a second tag for record ${ordinal}`).toBeDefined();
            if (tagSpan === undefined) continue;
            const inside = tagSpan[0] + 1;
            const located = resolver.locate(inside);
            expect(
                [located.pointer, located.start, located.end],
                `byte ${inside} lies in record ${ordinal}'s tags[1], span ${tagSpan[0]}..${tagSpan[1]}`,
            ).toEqual([`/${ordinal}/tags/1`, tagSpan[0], tagSpan[1]]);
        }

        // A window that straddles a checkpoint boundary, and one that runs off
        // the end: both are places an off-by-one hides.
        const straddle = resolver.members(root, 62, 6);
        expect(
            straddle.map((m) => `${m.ordinal}@${m.start}..${m.end}`),
            'a window straddling a checkpoint boundary must be contiguous ground truth',
        ).toEqual(records.slice(62, 68).map((r) => `${r.ordinal}@${r.start}..${r.end}`));
        expect(
            resolver.members(root, records.length, 4),
            'a window starting past the last member must be empty, not the tail again',
        ).toEqual([]);
        expect(
            resolver.memberByIndex(root, records.length),
            'there is no member one past the last one',
        ).toBeNull();
    }, 300_000);
});

describe('containers that are not bulk collections', () => {
    it('indexes an array of scalars by checkpoint and an array of records by node when it is narrow', () => {
        const doc = assemble();
        doc.emit('[');
        const spans: (readonly [number, number])[] = [];
        for (let i = 0; i < 4; i++) {
            if (i > 0) doc.emit(',');
            const from = doc.emit(`[${i},${i + 1}]`);
            spans.push([from, doc.at()]);
        }
        doc.emit(']');

        const idx = StrideIndex.build(sourceOf(doc.text(), 'narrow-nesting'));
        expect(idx.isDense(idx.rootId), 'a four-element array is structure, not bulk').toBe(true);
        const kids = idx.denseChildren(idx.rootId);
        expect(
            kids.map((k) => [k.start, k.end]),
            'every member of a narrow array must keep its exact span',
        ).toEqual(spans.map((s) => [s[0], s[1]]));
        expect(
            kids.every((k) => k.node >= 0),
            'each inner array of a narrow parent must carry its own node id',
        ).toBe(true);
        expect(
            kids.map((k) => idx.node(k.node)?.kind),
            'those node ids must resolve to the inner arrays themselves',
        ).toEqual(['array', 'array', 'array', 'array']);
    });

    it('reports the true member count of a bulk container even though it indexed no member of it', () => {
        const doc = assemble();
        doc.emit('[');
        const count = 5000;
        for (let i = 0; i < count; i++) {
            if (i > 0) doc.emit(',');
            doc.emit(String(i));
        }
        doc.emit(']');

        const idx = StrideIndex.build(sourceOf(doc.text(), 'true-count'));
        const node = idx.node(idx.rootId);
        expect(node, 'the root must be indexed').not.toBeNull();
        expect(
            node?.count,
            `the count must be the document's ${count} elements, not the number the index retained`,
        ).toBe(count);
        expect(idx.strideOf(idx.rootId), 'a bulk array must carry a stride wider than one').toBeGreaterThan(1);
    });

    it('indexes a document whose root is a bare scalar', () => {
        const source = sourceOf('"just a string"', 'bare-scalar');
        const idx = StrideIndex.build(source);
        const node = idx.node(idx.rootId);
        expect(
            node === null ? null : [node.kind, node.start, node.end, node.count],
            'a bare scalar document is one node spanning the whole document',
        ).toEqual(['string', 0, source.size, 0]);
    });

    it('indexes empty containers without claiming members they do not have', () => {
        const text = '{"a":{},"b":[],"c":[{}]}';
        const idx = StrideIndex.build(sourceOf(text, 'empty-containers'));
        const resolver = new Resolver(idx);
        expect(resolver.resolve('/a').count, 'an empty object has no members').toBe(0);
        expect(resolver.resolve('/b').count, 'an empty array has no elements').toBe(0);
        expect(resolver.members(resolver.resolve('/a'), 0, 8), 'an empty object enumerates to nothing').toEqual([]);
        expect(resolver.resolve('/c').count, 'an array holding one empty object has one element').toBe(1);
    });
});

describe('the scanner contract the index depends on', () => {
    it('reads an object interior correctly from a name boundary and incorrectly from a value boundary', () => {
        // The asymmetry that defect 2 turned on, stated as a property rather
        // than left implicit in the index: this is why a checkpoint into an
        // object may only ever name the first byte of a member NAME.
        const text = '{"k0":"v0","k1":"v1","k2":"v2"}';
        const source = sourceOf(text, 'boundary-asymmetry');
        const nameBoundary = text.indexOf('"k1"');
        const valueBoundary = text.indexOf('"v1"');

        expect(
            encode(enumerateObjectFrom(source, nameBoundary, source.size)).length,
            'resuming at a member name must yield that member and every one after it',
        ).toBe(2);
        expect(
            encode(enumerateObjectFrom(source, valueBoundary, source.size)).length,
            'resuming at a member value silently loses a member, which is why the index may never record one',
        ).toBe(1);
    });

    it('scans an array interior from an element boundary, where value and member start coincide', () => {
        const text = '[10,20,30,40]';
        const source = sourceOf(text, 'array-interior');
        const from = text.indexOf('20');
        const seen: number[] = [];
        scanStructure(source, from, source.size, {
            enter() { /* no containers in this fixture */ },
            exit() { /* no containers in this fixture */ },
            key() { /* an array has no member names */ },
            scalar(_kind, start, end, depth) { if (depth === 1) seen.push(Number(text.slice(start, end))); },
        }, K_ARRAY);
        expect(seen, 'an array element start is already a resumable boundary').toEqual([20, 30, 40]);
    });
});
