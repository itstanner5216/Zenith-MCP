// ---------------------------------------------------------------------------
// tests/stride/map.test.ts
//
// map.ts makes four claims, and for every one of them there is an
// implementation that returns an object of the right shape while doing the
// opposite. These tests are written to separate the two.
//
//   CHEAP        "the whole map is a genuinely cheap first call." A map that
//                walked 5,000,000 elements and then summarised them returns a
//                byte-identical object to one that walked none. Only a counter
//                inside the resolver can tell them apart, so the bound test
//                instruments `members` and `resolve` and asserts the counts are
//                IDENTICAL for a 1,000,000- and a 5,000,000-element root — an
//                implementation whose cost tracks the document cannot produce
//                two equal numbers there.
//
//   DECLARED     "nothing is withheld without being counted." An outline that
//                lists 32 of 200,000 keys and says nothing looks exactly like a
//                complete outline of a 32-key document. The test therefore
//                computes the root's member count while ASSEMBLING the fixture
//                and requires the map to state that number, and it requires the
//                converse too: a complete outline must carry no summary, so a
//                module that emits one unconditionally fails as well.
//
//   ADDRESSED    "an outline the agent cannot descend from is a picture." Every
//                entry's cursor is decoded and every entry's pointer is resolved
//                back through the resolver, and the span, kind and count that
//                come back must equal the ones the entry claimed. The fixtures
//                include member names that RFC 6901 has to escape — "a/b",
//                "c~d", "" — because a pointer built by concatenation passes
//                every test that avoids them.
//
//   HONEST       "an index that is silently incomplete is an I7 failure." One
//                fixture is built specifically to exceed the index's node
//                ceiling, and the map over it must say so; the same assertion is
//                run inverted over a document that does NOT truncate, so a hint
//                that always warns fails too.
//
// Ground truth never comes from the module. Member counts, byte spans and
// character totals are accumulated while the fixture text is assembled, or
// recomputed from `index.stats` and `JSON.stringify`, and the sampled-member
// counts come from a resolver subclass that counts what it hands out.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { decodeCursor } from '../../src/core/stride/cursor.js';
import { StrideIndex } from '../../src/core/stride/index.js';
import { Resolver, type Member } from '../../src/core/stride/resolve.js';
import { BufferSource } from '../../src/core/stride/source.js';
import { SHAPE_SAMPLE, type StrideMap, type StrideNode } from '../../src/core/stride/types.js';
import {
    CENSUS_MIN_TOP_PRESENCE, OUTLINE_MAX, SHAPE_CENSUS_CAP, buildMap,
} from '../../src/core/stride/map.js';

// ── the bounds under test, restated as arithmetic over the module's own ────
// constants rather than as literals, so a retune of either cannot leave a
// stale number here passing.

/** Members the resolver may hand out for one map: the outline plus every census. */
const MEMBER_BOUND = OUTLINE_MAX + (1 + SHAPE_CENSUS_CAP) * SHAPE_SAMPLE;

/** Pointer resolutions one map may perform: one per outlined member container. */
const RESOLVE_BOUND = OUTLINE_MAX;

/**
 * The serialised size a first call has to fit inside. 4,000 characters is the
 * 1K-token condition the orientation research measured — hierarchical
 * table-of-contents navigation reached 81.6% completeness there against 51.4%
 * for fixed-length chunking — so a map that does not fit it is not competing in
 * the regime the claim was made in.
 */
const CHEAP_FIRST_CALL_CHARS = 4_000;

// ── fixtures ──────────────────────────────────────────────────────────────

/** Seeded PRNG, so a failure reproduces exactly. */
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

/** A fixture: the document text plus the ground truth accumulated while writing it. */
interface Fixture {
    readonly name: string;
    readonly text: string;
    /** True member count of the root container; 0 for a scalar document. */
    readonly rootCount: number;
}

/**
 * Concatenate in ~1 MiB blocks. A 20 MB fixture assembled as one array of
 * per-record strings costs more in per-string overhead than the document does
 * in bytes, and that shows up as a slow test rather than as a finding.
 */
class Blocks {
    private readonly done: string[] = [];
    private buf = '';
    add(s: string): void {
        this.buf += s;
        if (this.buf.length >= 1 << 20) { this.done.push(this.buf); this.buf = ''; }
    }
    finish(): string {
        if (this.buf.length > 0) { this.done.push(this.buf); this.buf = ''; }
        return this.done.join('');
    }
}

/** An array of `record(i)` filled until one more element would pass `targetBytes`. */
function arrayToBytes(name: string, targetBytes: number, record: (i: number) => string): Fixture {
    const b = new Blocks();
    b.add('[');
    let size = 2;                    // the two brackets
    let count = 0;
    for (;;) {
        const r = record(count);
        const extra = r.length + (count > 0 ? 1 : 0);
        if (size + extra > targetBytes) break;
        if (count > 0) b.add(',');
        b.add(r);
        size += extra;
        count++;
    }
    b.add(']');
    return { name, text: b.finish(), rootCount: count };
}

/** A root object of `keys` members, each `value(i)`. */
function wideObject(name: string, keys: number, value: (i: number) => string): Fixture {
    const b = new Blocks();
    b.add('{');
    for (let i = 0; i < keys; i++) {
        if (i > 0) b.add(',');
        b.add(`"k${String(i).padStart(7, '0')}":${value(i)}`);
    }
    b.add('}');
    return { name, text: b.finish(), rootCount: keys };
}

/** A spine `depth` levels deep, each level a three-member object. */
function deepSpine(name: string, depth: number): Fixture {
    let inner = '"leaf"';
    for (let d = depth - 1; d >= 0; d--) {
        inner = `{"id":${d},"tag":"level-${d}","child":${inner}}`;
    }
    return { name, text: inner, rootCount: 3 };
}

/** A `branch`-ary array tree `depth` levels deep. Container count is 1 + branch*c(depth-1). */
function arrayTree(depth: number, branch: number): string {
    if (depth === 0) return '[]';
    const inner = arrayTree(depth - 1, branch);
    return `[${new Array<string>(branch).fill(inner).join(',')}]`;
}

/**
 * Containers in `arrayTree(depth, branch)`, computed independently of it, so the
 * fixture that is supposed to exceed the index's node ceiling is known to.
 */
function treeContainers(depth: number, branch: number): number {
    let n = 1;
    for (let d = 1; d <= depth; d++) n = 1 + branch * n;
    return n;
}

/** A root object mixing every value kind, including names RFC 6901 must escape. */
function heterogeneous(name: string): Fixture {
    const rnd = mulberry32(0x5721de);
    const users = new Blocks();
    users.add('[');
    for (let i = 0; i < 2_000; i++) {
        if (i > 0) users.add(',');
        users.add(`{"id":${i},"name":"user-${i}","score":${Math.floor(rnd() * 1000)},"active":${rnd() < 0.5}}`);
    }
    users.add(']');

    const events = new Blocks();
    events.add('[');
    for (let i = 0; i < 1_500; i++) {
        if (i > 0) events.add(',');
        events.add(`{"at":${1_600_000_000 + i},"kind":"click","path":"/p/${i % 37}"}`);
    }
    events.add(']');

    const ids: string[] = [];
    for (let i = 0; i < 5_000; i++) ids.push(String(Math.floor(rnd() * 1e9)));

    const members = [
        `"users":${users.finish()}`,
        `"events":${events.finish()}`,
        `"ids":[${ids.join(',')}]`,
        '"config":{"region":"eu-west-1","retries":3,"nested":{"a":{"b":{"c":1}}}}',
        '"empty":[]',
        '"blank":{}',
        '"version":"1.2.3"',
        '"count":12345',
        '"flag":true',
        '"nothing":null',
        '"a/b":{"x":1,"y":2}',
        '"c~d":[1,2,3]',
        '"":"the member named empty string"',
    ];
    return { name, text: `{${members.join(',')}}`, rootCount: members.length };
}

// Built once and shared: the 20 MB fixtures cost real seconds to assemble, and
// nothing below mutates a document.
const cache = new Map<string, Fixture>();
function fixture(key: string, make: () => Fixture): Fixture {
    const found = cache.get(key);
    if (found !== undefined) return found;
    const made = make();
    cache.set(key, made);
    return made;
}

/** 20 MB of ~19-byte records: the "million-ish structurally identical records" shape. */
const millionRecords = (): Fixture => fixture('million', () => arrayToBytes(
    'array of 1M thin records (20 MB)', 20_000_000,
    (i) => `{"i":${i},"v":${i % 7}}`,
));

/** 20 MB of realistic eight-field records, which is the harder case for map size. */
const richRecords = (): Fixture => fixture('rich', () => {
    const rnd = mulberry32(0x9e3779b9);
    const tiers = ['free', 'pro', 'team', 'enterprise'];
    return arrayToBytes('array of records, 8 fields (20 MB)', 20_000_000, (i) => {
        const tier = tiers[i % tiers.length] ?? 'free';
        return `{"id":${i},"uuid":"${(i * 2654435761 >>> 0).toString(16).padStart(8, '0')}-4f1a-11ee",`
            + `"email":"user${i}@example.com","tier":"${tier}","score":${Math.floor(rnd() * 10_000)},`
            + `"created":${1_600_000_000 + i},"active":${i % 3 !== 0},"region":"eu-west-1"}`;
    });
});

const wideRecords = (): Fixture => fixture('wide120k', () => wideObject(
    'wide object, 120k keys of records', 120_000, (i) => `{"a":${i},"b":${i % 11}}`,
));

const wideScalars = (): Fixture => fixture('wideScalar', () => wideObject(
    'wide object, 120k scalar keys', 120_000, (i) => String(i * 3),
));

// ── instrumentation ───────────────────────────────────────────────────────

/**
 * A resolver that counts what it hands out.
 *
 * Both counters are on the two public routes map.ts can reach the document
 * through, so the bound is measured rather than inferred from a duration — a
 * timing-based bound passes on a fast machine and fails on a loaded one, and
 * neither outcome is about the code.
 */
class CountingResolver extends Resolver {
    memberCalls = 0;
    membersYielded = 0;
    resolveCalls = 0;

    override members(node: StrideNode, offset: number, limit: number): Member[] {
        this.memberCalls++;
        const out = super.members(node, offset, limit);
        this.membersYielded += out.length;
        return out;
    }

    override resolve(pointer: string): StrideNode {
        this.resolveCalls++;
        return super.resolve(pointer);
    }
}

interface Built {
    readonly fixture: Fixture;
    readonly bytes: number;
    readonly index: StrideIndex;
    readonly resolver: CountingResolver;
    readonly map: StrideMap;
    readonly chars: number;
}

function build(f: Fixture): Built {
    const buf = Buffer.from(f.text, 'utf8');
    const index = StrideIndex.build(new BufferSource(buf, f.name));
    const resolver = new CountingResolver(index);
    const map = buildMap(resolver);
    return { fixture: f, bytes: buf.length, index, resolver, map, chars: JSON.stringify(map).length };
}

/** Every span the map hands back must be a real region of the document. */
function assertSpansInRange(b: Built): void {
    for (const e of b.map.outline) {
        expect(
            e.span[0] >= 0 && e.span[1] <= b.bytes && e.span[0] < e.span[1],
            `${b.fixture.name}: outline entry ${JSON.stringify(e.pointer)} claims span `
            + `[${e.span[0]}, ${e.span[1]}) which is not inside [0, ${b.bytes})`,
        ).toBe(true);
        expect(
            e.bytes,
            `${b.fixture.name}: entry ${JSON.stringify(e.pointer)} reports ${e.bytes} bytes but its span is `
            + `${e.span[1] - e.span[0]} bytes wide; the two cannot disagree`,
        ).toBe(e.span[1] - e.span[0]);
    }
}

// ── 1. the orientation claim, measured ────────────────────────────────────

describe('the whole map is small enough to be a first call', () => {
    it('describes 20 MB of a million thin records in under a 1K-token budget', () => {
        const b = build(millionRecords());
        console.log(
            `[cheap] ${b.fixture.name}: ${b.bytes} bytes, ${b.fixture.rootCount} records, `
            + `map serialises to ${b.chars} chars (${(b.chars / b.bytes * 100).toFixed(5)}% of the document), `
            + `${b.map.outline.length} outline entries, ${b.map.shapes.length} censuses`,
        );
        expect(
            b.fixture.rootCount,
            `the brief's shape is "a million-ish records" in 20 MB, which forces ~20 bytes per record; `
            + `this fixture holds ${b.fixture.rootCount}`,
        ).toBeGreaterThan(900_000);
        expect(
            b.chars,
            `a first call over ${b.bytes} bytes serialised to ${b.chars} chars, past the `
            + `${CHEAP_FIRST_CALL_CHARS}-char (1K-token) budget the orientation result was measured at`,
        ).toBeLessThanOrEqual(CHEAP_FIRST_CALL_CHARS);
    }, 120_000);

    it('stays inside the same budget for realistic eight-field records, which cost far more to describe', () => {
        const b = build(richRecords());
        console.log(
            `[cheap] ${b.fixture.name}: ${b.bytes} bytes, ${b.fixture.rootCount} records, `
            + `map serialises to ${b.chars} chars, ${b.map.shapes.length} censuses, `
            + `root census describes ${b.map.shapes[0]?.fields.length ?? 0} fields`,
        );
        expect(
            b.map.shapes.length,
            'a 20 MB array of records with no census is the "empty summary" condition that '
            + 'collapsed skimming to blind sampling; the map must populate it',
        ).toBeGreaterThan(0);
        expect(
            b.map.shapes[0]?.fields.length ?? 0,
            'the root census must name the record\'s fields, which is the whole reason it is here',
        ).toBeGreaterThanOrEqual(8);
        expect(
            b.chars,
            `a first call over ${b.bytes} bytes of eight-field records serialised to ${b.chars} chars, `
            + `past the ${CHEAP_FIRST_CALL_CHARS}-char (1K-token) budget`,
        ).toBeLessThanOrEqual(CHEAP_FIRST_CALL_CHARS);
    }, 120_000);

    it('is valid JSON with hint as its final field, because an instruction read first is an instruction acted past', () => {
        const b = build(heterogeneous('heterogeneous root'));
        const keys = Object.keys(b.map);
        expect(
            keys[keys.length - 1],
            `"hint" must serialise last so the caller reads it after the numbers it is about; got ${keys.join(',')}`,
        ).toBe('hint');
        const round: unknown = JSON.parse(JSON.stringify(b.map));
        expect(
            round,
            'the map has to survive JSON, which a NaN or Infinity in indexRatio would not',
        ).toEqual(JSON.parse(JSON.stringify(b.map)));
        expect(
            Number.isFinite(b.map.indexRatio),
            `indexRatio came back ${b.map.indexRatio}, which does not serialise as a JSON number`,
        ).toBe(true);
    }, 30_000);
});

// ── 2. bounded cost ──────────────────────────────────────────────────────

describe('cost is bounded by the map, not by the document', () => {
    it('builds over a 120,000-key root object without walking past its outline bound', () => {
        const b = build(wideRecords());
        console.log(
            `[bound] ${b.fixture.name}: ${b.resolver.membersYielded} members yielded over `
            + `${b.resolver.memberCalls} calls, ${b.resolver.resolveCalls} resolves, `
            + `${b.map.outline.length} outline entries, ${b.map.shapes.length} censuses`,
        );
        expect(
            b.resolver.membersYielded,
            `a 120,000-key root cost ${b.resolver.membersYielded} members, past the stated bound of `
            + `${MEMBER_BOUND} (OUTLINE_MAX + (1 + SHAPE_CENSUS_CAP) * SHAPE_SAMPLE)`,
        ).toBeLessThanOrEqual(MEMBER_BOUND);
        expect(
            b.resolver.resolveCalls,
            `${b.resolver.resolveCalls} pointer resolutions, past the stated bound of ${RESOLVE_BOUND}`,
        ).toBeLessThanOrEqual(RESOLVE_BOUND);
        expect(
            b.map.outline.length,
            `a 120,000-key root produced ${b.map.outline.length} outline entries; the bound is `
            + `${OUTLINE_MAX} members plus one root summary`,
        ).toBeLessThanOrEqual(OUTLINE_MAX + 1);
        expect(
            b.map.shapes.length,
            `${b.map.shapes.length} censuses, past the bound of 1 + SHAPE_CENSUS_CAP = ${1 + SHAPE_CENSUS_CAP}`,
        ).toBeLessThanOrEqual(1 + SHAPE_CENSUS_CAP);
    }, 120_000);

    it('builds over a root array of a million elements without walking one of them', () => {
        const b = build(millionRecords());
        console.log(
            `[bound] ${b.fixture.name}: ${b.resolver.membersYielded} members yielded over `
            + `${b.resolver.memberCalls} calls, ${b.resolver.resolveCalls} resolves, `
            + `${b.map.outline.length} outline entries`,
        );
        expect(
            b.fixture.rootCount,
            'this test is about a root the map must refuse to enumerate',
        ).toBeGreaterThan(1_000_000);
        expect(
            b.resolver.membersYielded,
            `a ${b.fixture.rootCount}-element root cost ${b.resolver.membersYielded} members, past the `
            + `stated bound of ${MEMBER_BOUND}`,
        ).toBeLessThanOrEqual(MEMBER_BOUND);
        expect(
            b.map.outline.length,
            'a root array past the outline bound is one summary entry, not a sample of elements: '
            + `got ${b.map.outline.length} entries`,
        ).toBe(1);
        expect(
            b.resolver.resolveCalls,
            'no element of a summarised root array needs resolving, so nothing should have been resolved',
        ).toBe(0);
    }, 120_000);

    it('costs the same for a five-million-element root as for a one-million-element one', () => {
        // The discriminating assertion. A map whose cost tracks the document
        // returns the same OBJECT on both of these and cannot return the same
        // two counters.
        const small = build(arrayToBytes('1M elements', 12_000_000, (i) => `[${i},${i % 5}]`));
        const large = build(arrayToBytes('5M elements', 60_000_000, (i) => `[${i},${i % 5}]`));
        console.log(
            `[invariance] ${small.fixture.rootCount} elements: ${small.resolver.membersYielded} members; `
            + `${large.fixture.rootCount} elements: ${large.resolver.membersYielded} members`,
        );
        expect(
            large.fixture.rootCount / small.fixture.rootCount,
            'the two fixtures must differ by enough that a per-element cost could not hide',
        ).toBeGreaterThan(3);
        expect(
            large.resolver.membersYielded,
            `${small.fixture.rootCount} elements cost ${small.resolver.membersYielded} members and `
            + `${large.fixture.rootCount} elements cost ${large.resolver.membersYielded}; a cost that `
            + 'changes with the document is not bounded by the map',
        ).toBe(small.resolver.membersYielded);
        expect(
            large.map.outline.length,
            'outline width must not track element count either',
        ).toBe(small.map.outline.length);
    }, 300_000);

    it('drops a census that only re-lists the members it sampled, so a wide scalar object stays cheap', () => {
        const records = build(wideRecords());
        const scalars = build(wideScalars());
        const topPresence = (m: StrideMap, i: number): number => {
            const shape = m.shapes[i];
            if (shape === undefined) return 0;
            let top = 0;
            for (const f of shape.fields) if (f.presence > top) top = f.presence;
            return top;
        };
        console.log(
            `[gate] 120k keys of records: ${records.map.shapes.length} censuses, ${records.chars} chars; `
            + `120k scalar keys: ${scalars.map.shapes.length} censuses, ${scalars.chars} chars`,
        );
        for (let i = 0; i < scalars.map.shapes.length; i++) {
            expect(
                topPresence(scalars.map, i),
                `census ${i} of the scalar-keyed object was kept with a top field presence of `
                + `${topPresence(scalars.map, i)}, under the ${CENSUS_MIN_TOP_PRESENCE} gate; a census where no `
                + 'field is shared by a majority of members states no schema and costs one field per sample',
            ).toBeGreaterThanOrEqual(CENSUS_MIN_TOP_PRESENCE);
        }
        expect(
            scalars.map.shapes.length,
            'a 120,000-key object of scalars has no schema one level down: censusing it at SHAPE_SAMPLE '
            + 'would emit 256 fields at presence 1/256',
        ).toBe(0);
        expect(
            records.map.shapes.length,
            'the same-width object whose values ARE records must still be censused; the gate must key on '
            + 'what the census found, not on the container\'s width',
        ).toBeGreaterThan(0);
    }, 120_000);
});

// ── 3. declared omission ─────────────────────────────────────────────────

describe('nothing is withheld without being counted', () => {
    it('states the root member total against the number shown, whenever the outline is bounded', () => {
        for (const f of [wideRecords(), wideScalars(), millionRecords()]) {
            const b = build(f);
            const summary = b.map.outline.find((e) => e.pointer === '');
            expect(
                summary,
                `${f.name}: the outline shows at most ${OUTLINE_MAX} of ${f.rootCount} root members, so it `
                + 'must carry a root summary entry; without one the caller cannot tell it from a complete outline',
            ).toBeDefined();
            if (summary === undefined) continue;
            const shown = b.map.outline.length - 1;
            expect(
                summary.count,
                `${f.name}: the summary claims ${summary.count} root members; the fixture was assembled with `
                + `${f.rootCount}`,
            ).toBe(f.rootCount);
            expect(
                b.map.hint.includes(`${f.rootCount}`) && b.map.hint.includes(`${shown}`)
                && b.map.hint.includes(`${f.rootCount - shown}`),
                `${f.name}: the hint must spell out the arithmetic (${shown} of ${f.rootCount} shown, `
                + `${f.rootCount - shown} withheld) so a reader who does not parse the outline still has it. `
                + `Got: ${b.map.hint}`,
            ).toBe(true);
            expect(
                summary.span,
                `${f.name}: the summary must span the whole root, so the withheld region is addressed`,
            ).toEqual([0, b.bytes]);
        }
    }, 300_000);

    it('carries no summary when the outline is complete, so a caller can tell the two apart', () => {
        for (const f of [
            heterogeneous('heterogeneous root'),
            deepSpine('deep spine, 256 levels', 256),
            arrayToBytes('root array of 20 elements', 400, (i) => `{"n":${i}}`),
        ]) {
            const b = build(f);
            const named = b.map.outline.filter((e) => e.pointer !== '');
            expect(
                named.length,
                `${f.name}: the root holds ${f.rootCount} members and all of them fit the outline bound of `
                + `${OUTLINE_MAX}, so all ${f.rootCount} must be listed; got ${named.length}`,
            ).toBe(f.rootCount);
            expect(
                b.map.outline.find((e) => e.pointer === ''),
                `${f.name}: this outline is complete, so a root summary would make "outline[0].pointer === ''" `
                + 'stop meaning "something is missing" — the one test a caller has',
            ).toBeUndefined();
        }
    }, 60_000);

    it('never leaves a root member out of both the listing and the count, over every shape here', () => {
        const shapes = [
            millionRecords(), wideRecords(), wideScalars(),
            heterogeneous('heterogeneous root'), deepSpine('deep spine, 256 levels', 256),
            arrayToBytes('root array of 20 elements', 400, (i) => `{"n":${i}}`),
            { name: 'empty root object', text: '{}', rootCount: 0 },
            { name: 'empty root array', text: '[]', rootCount: 0 },
            { name: 'root array exactly at the bound', text: `[${new Array<string>(OUTLINE_MAX).fill('1').join(',')}]`, rootCount: OUTLINE_MAX },
            { name: 'root array one past the bound', text: `[${new Array<string>(OUTLINE_MAX + 1).fill('1').join(',')}]`, rootCount: OUTLINE_MAX + 1 },
        ];
        for (const f of shapes) {
            const b = build(f);
            const named = b.map.outline.filter((e) => e.pointer !== '');
            const summary = b.map.outline.find((e) => e.pointer === '');
            if (summary === undefined) {
                expect(
                    named.length,
                    `${f.name}: ${named.length} members listed with no summary, but the root holds `
                    + `${f.rootCount}; the difference is a silent omission`,
                ).toBe(f.rootCount);
            } else {
                expect(
                    summary.count,
                    `${f.name}: the summary must state the root's true total of ${f.rootCount}`,
                ).toBe(f.rootCount);
                expect(
                    named.length,
                    `${f.name}: a summary is only honest when something really is missing; ${named.length} of `
                    + `${f.rootCount} members are listed`,
                ).toBeLessThan(f.rootCount);
            }
        }
    }, 300_000);
});

// ── 4. every entry is an address ─────────────────────────────────────────

describe('every outline entry is an address the caller can descend from', () => {
    it('round-trips pointer, cursor, span, kind and count back through the resolver', () => {
        const shapes = [
            heterogeneous('heterogeneous root'),
            deepSpine('deep spine, 256 levels', 256),
            wideRecords(),
            millionRecords(),
            { name: 'names RFC 6901 must escape', text: '{"a/b":[1,2],"c~d":{"e":1},"":"blank","~1":3,"~0":4,"x/y/z":null}', rootCount: 6 },
        ];
        let checked = 0;
        for (const f of shapes) {
            const b = build(f);
            assertSpansInRange(b);
            const verifier = new Resolver(b.index);
            for (const e of b.map.outline) {
                const decoded = decodeCursor(e.cursor);
                expect(
                    decoded.pointer,
                    `${f.name}: the cursor on entry ${JSON.stringify(e.pointer)} decodes to pointer `
                    + `${JSON.stringify(decoded.pointer)}, which addresses a different place`,
                ).toBe(e.pointer);
                const node = verifier.resolve(e.pointer);
                expect(
                    [node.start, node.end],
                    `${f.name}: entry ${JSON.stringify(e.pointer)} claims span [${e.span[0]}, ${e.span[1]}) but `
                    + `resolving that pointer lands on [${node.start}, ${node.end})`,
                ).toEqual([e.span[0], e.span[1]]);
                expect(
                    node.kind,
                    `${f.name}: entry ${JSON.stringify(e.pointer)} claims kind ${e.kind} but resolves to `
                    + `a ${node.kind}`,
                ).toBe(e.kind);
                expect(
                    node.count,
                    `${f.name}: entry ${JSON.stringify(e.pointer)} claims ${e.count} members but the resolver `
                    + `counts ${node.count}`,
                ).toBe(e.count);
                checked++;
            }
        }
        console.log(`[address] ${checked} outline entries round-tripped through decodeCursor and Resolver.resolve`);
        expect(
            checked,
            'the round trip has to have actually run over a useful number of entries',
        ).toBeGreaterThan(50);
    }, 300_000);

    it('keeps `key` as the member name and `pointer` as its escaped address, which are not the same string', () => {
        const b = build({
            name: 'escaped names', rootCount: 3,
            text: '{"a/b":1,"c~d":2,"plain":3}',
        });
        const byKey = new Map(b.map.outline.map((e) => [e.key, e.pointer]));
        expect(
            byKey.get('a/b'),
            'a member named "a/b" is one member, and its pointer must escape the slash as ~1; an unescaped '
            + '"/a/b" addresses member "b" of member "a"',
        ).toBe('/a~1b');
        expect(
            byKey.get('c~d'),
            'a member named "c~d" must escape the tilde as ~0',
        ).toBe('/c~0d');
        expect(
            byKey.get('plain'),
            'a name needing no escape must not be altered',
        ).toBe('/plain');
    }, 30_000);

    it('phrases the hint as a call whose own cursor agrees with the pointer and offset it names', () => {
        for (const f of [
            heterogeneous('heterogeneous root'),
            wideRecords(),
            millionRecords(),
            { name: 'scalar document', text: '"just a long string value"', rootCount: 0 },
        ]) {
            const b = build(f);
            const call = /Call mode "(read|scalar)" with pointer ("(?:[^"\\]|\\.)*"|"") and offset (\d+), or cursor "(s1\.[A-Za-z0-9_-]+)"/
                .exec(b.map.hint);
            expect(
                call,
                `${f.name}: the hint must end in a literal call naming a mode, a pointer, an offset and a `
                + `cursor. Got: ${b.map.hint}`,
            ).not.toBeNull();
            if (call === null) continue;
            const [, op, pointerJson, offsetText, token] = call;
            const decoded = decodeCursor(token ?? '');
            const pointer: unknown = JSON.parse(pointerJson ?? '""');
            expect(
                decoded.pointer,
                `${f.name}: the hint says pointer ${String(pointerJson)} but its cursor decodes to `
                + `${JSON.stringify(decoded.pointer)}; the prose and the token must not disagree`,
            ).toBe(pointer);
            expect(
                decoded.offset,
                `${f.name}: the hint says offset ${String(offsetText)} but its cursor carries `
                + `${decoded.offset}`,
            ).toBe(Number(offsetText));
            expect(
                decoded.op,
                `${f.name}: the hint says mode ${String(op)} but its cursor carries op ${decoded.op}`,
            ).toBe(op);
            const node = new Resolver(b.index).resolve(decoded.pointer);
            expect(
                node.pointer,
                `${f.name}: the hint's call must address something that exists`,
            ).toBe(decoded.pointer);
        }
    }, 300_000);
});

// ── 5. an incomplete index says so ───────────────────────────────────────

describe('an index that is silently incomplete is an I7 failure', () => {
    it('declares incompleteness on a document whose structure exceeds the index node ceiling', () => {
        const DEPTH = 3;
        const BRANCH = 32;               // at or below DENSE_CHILD_LIMIT, so every parent keeps indexing
        const SUBTREES = 8;
        const containers = 1 + SUBTREES * treeContainers(DEPTH, BRANCH);
        const text = `[${new Array<string>(SUBTREES).fill(arrayTree(DEPTH, BRANCH)).join(',')}]`;
        const b = build({ name: 'deep dense tree', text, rootCount: SUBTREES });
        console.log(
            `[truncation] ${b.bytes} bytes hold ${containers} containers, all with <= ${BRANCH} members; `
            + `index kept ${b.map.indexed} nodes, truncatedIndex=${b.index.stats.truncatedIndex}`,
        );
        expect(
            b.index.stats.truncatedIndex,
            `this fixture exists to exceed the index's node ceiling: ${containers} containers every one of `
            + `which qualifies for a node. If truncatedIndex is false the ceiling moved and the fixture `
            + 'needs to grow with it',
        ).toBe(true);
        expect(
            b.map.indexed,
            `the map must report fewer indexed nodes than the document has containers (${containers}); `
            + `reporting ${b.map.indexed} of ${containers} as if complete is the omission I7 forbids`,
        ).toBeLessThan(containers);
        expect(
            b.map.hint.includes('INCOMPLETE INDEX'),
            'a map that reports an index footprint without reporting that the index is incomplete is hiding '
            + `it. Hint was: ${b.map.hint}`,
        ).toBe(true);
        expect(
            b.map.hint.includes(String(b.map.indexed)),
            'the declaration must carry the number, so the caller can do arithmetic on it rather than take '
            + 'a warning on trust',
        ).toBe(true);
    }, 300_000);

    it('does not warn about incompleteness on a document that indexed completely', () => {
        const b = build(heterogeneous('heterogeneous root'));
        expect(
            b.index.stats.truncatedIndex,
            'this fixture is small enough to index completely; the inverted assertion below depends on it',
        ).toBe(false);
        expect(
            b.map.hint.includes('INCOMPLETE INDEX'),
            'an unconditional warning is the same failure as no warning: it stops carrying information. '
            + `Hint was: ${b.map.hint}`,
        ).toBe(false);
        expect(
            b.map.hint.includes('MALFORMED'),
            `nothing is malformed in this fixture. Hint was: ${b.map.hint}`,
        ).toBe(false);
    }, 30_000);

    it('names the byte a malformed document stops being JSON at', () => {
        const b = build({ name: 'truncated mid-record', text: '{"a":[1,2,3],"b":{"c":4', rootCount: 2 });
        expect(
            b.index.stats.errorAt,
            'this fixture is deliberately unterminated, so the scanner must have found the end early',
        ).toBeGreaterThanOrEqual(0);
        expect(
            b.map.hint.includes(`MALFORMED FROM BYTE ${b.index.stats.errorAt}`),
            'a map over a document that stops being JSON must say where, or every count below it reads as '
            + `a total. Hint was: ${b.map.hint}`,
        ).toBe(true);
    }, 30_000);
});

// ── 6. index economics, reported rather than reassured ───────────────────

describe('index economics are reported as measured', () => {
    it('reports indexRatio as the measured quotient, at both ends of a thousandfold range', () => {
        const thin = build(millionRecords());
        const wide = build(wideScalars());
        const quotient = (b: Built): number => b.index.stats.bytes / b.bytes;
        console.log(
            `[ratio] ${thin.fixture.name}: ${thin.index.stats.bytes} index bytes over ${thin.bytes} `
            + `= ${thin.map.indexRatio}; ${wide.fixture.name}: ${wide.index.stats.bytes} over ${wide.bytes} `
            + `= ${wide.map.indexRatio}`,
        );
        for (const b of [thin, wide]) {
            const truth = quotient(b);
            expect(
                Math.abs(b.map.indexRatio - truth) <= Math.abs(truth) * 1e-3,
                `${b.fixture.name}: indexRatio reported ${b.map.indexRatio} where indexBytes/bytes is `
                + `${truth}; four significant figures allows 1e-3 relative, not more`,
            ).toBe(true);
            expect(
                b.map.indexBytes,
                `${b.fixture.name}: indexBytes must be the index's own measurement`,
            ).toBe(b.index.stats.bytes);
        }
        expect(
            wide.map.indexRatio / thin.map.indexRatio,
            'these two shapes are chosen because the same index costs wildly different fractions of them. '
            + `If the ratios are close (${thin.map.indexRatio} vs ${wide.map.indexRatio}) a constant has been `
            + 'folded in somewhere and the field has stopped being a measurement',
        ).toBeGreaterThan(50);
    }, 300_000);

    it('reports the document\'s true maximum depth, not the depth the index happened to reach', () => {
        const DEPTH = 256;
        const b = build(deepSpine('deep spine, 256 levels', DEPTH));
        // Each level is an object holding "child", so the leaf string sits at
        // depth DEPTH: DEPTH containers, then one scalar inside the innermost.
        expect(
            b.map.maxDepth,
            `a spine of ${DEPTH} nested objects with a scalar at the bottom reaches depth ${DEPTH}; `
            + `the map reported ${b.map.maxDepth}`,
        ).toBe(DEPTH);
    }, 30_000);
});

// ── 7. the measured table ────────────────────────────────────────────────

describe('measured across document shapes', () => {
    it('reports document bytes, index economics, outline width and map size for each shape', () => {
        const rows = [
            millionRecords(),
            richRecords(),
            wideRecords(),
            wideScalars(),
            deepSpine('deeply nested, 256 levels', 256),
            heterogeneous('heterogeneous root'),
        ];
        for (const f of rows) {
            const b = build(f);
            console.log(
                `[table] ${f.name} | bytes=${b.bytes} | indexed=${b.map.indexed} | `
                + `indexBytes=${b.map.indexBytes} | indexRatio=${b.map.indexRatio} | `
                + `buildMs=${b.map.buildMs} | maxDepth=${b.map.maxDepth} | outline=${b.map.outline.length} | `
                + `shapes=${b.map.shapes.length} | mapChars=${b.chars} | `
                + `members=${b.resolver.membersYielded} | resolves=${b.resolver.resolveCalls}`,
            );
            expect(
                b.map.bytes,
                `${f.name}: the map must report the document's real size`,
            ).toBe(b.bytes);
            expect(
                b.resolver.membersYielded,
                `${f.name}: ${b.resolver.membersYielded} members, past the bound of ${MEMBER_BOUND}`,
            ).toBeLessThanOrEqual(MEMBER_BOUND);
            expect(
                b.map.shapes.length,
                `${f.name}: ${b.map.shapes.length} censuses, past the bound of ${1 + SHAPE_CENSUS_CAP}`,
            ).toBeLessThanOrEqual(1 + SHAPE_CENSUS_CAP);
        }
    }, 600_000);
});
