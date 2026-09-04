// ---------------------------------------------------------------------------
// tests/stride/shape.test.ts
//
// shape.ts makes four claims, and each of them has an implementation that looks
// identical from the outside while doing nothing. These tests are written to
// separate the two.
//
//   CENSUS      "the shape of a million records fits in a few hundred
//               characters, and costs the sample rather than the container."
//               A census that walked the container would return the same object;
//               only an instrumented resolver can tell them apart. So the
//               sampling test counts members handed out, and asserts the count
//               is identical for a 50,000- and a 400,000-element array.
//
//   NOVELTY     "the interesting record is the one that breaks the shape."
//               A scorer that ranks by nothing at all still produces a ranking.
//               So the needle test asserts not just that the two anomalies are
//               near the top but that they are the ONLY two members separated
//               from the population at all — the other 20,000 must be provably
//               indistinguishable from each other.
//
//   CALIBRATION percentile, not min-max. Both map into [0,1] and both put the
//               anomaly first, so no ordering test can tell them apart. The test
//               that can is an exact one: rank calibration has closed-form
//               output — the k-th lowest of n distinct scores is k/(n-1) — and
//               min-max does not reproduce those numbers.
//
//   KNEE        two detectors. A single-detector implementation that silently
//               falls back to ceil(sqrt(n)) passes any test whose expected value
//               happens to equal ceil(sqrt(n)) — which the brief's own reference
//               cliff does (n = 6, floor 3, answer 3). So every knee assertion
//               here either lands a long way from the floor or is checked
//               against the detector's arithmetic recomputed in the test.
//
// Ground truth is computed in the test, from the fixture, without calling the
// module: distinct-value sets accumulated while the document text is assembled,
// the chord-deviation argmax recomputed by hand, the sampled ordinals recorded
// by an instrumented resolver. Fixtures are fully deterministic — no RNG — so a
// failure reproduces exactly.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { StrideIndex } from '../../src/core/stride/index.js';
import { Resolver, type Member } from '../../src/core/stride/resolve.js';
import { BufferSource } from '../../src/core/stride/source.js';
import {
    DISTINCT_CAP, FIELD_SAMPLES, SHAPE_SAMPLE, CENSUS_FIELD_CAP, CENSUS_SCAN_CAP,
    CENSUS_NAME_BYTES, MARKER_RE,
    type StrideNode, type StrideShape,
} from '../../src/core/stride/types.js';
import { censusOf, knee, noveltyOf, redundancyOf, ELEMENT_FIELD } from '../../src/core/stride/shape.js';

// ── instrumentation ───────────────────────────────────────────────────────

/**
 * A resolver that records every member it hands out. `touched` is the count the
 * sampling bound is about: members the census actually received and read.
 */
class CountingResolver extends Resolver {
    readonly calls: Array<{ offset: number; limit: number; got: number }> = [];
    touched = 0;

    override members(node: StrideNode, offset: number, limit: number): Member[] {
        const out = super.members(node, offset, limit);
        this.calls.push({ offset, limit, got: out.length });
        this.touched += out.length;
        return out;
    }

    /** Ordinals the census inspected, in the order it asked for them. */
    sampledOrdinals(): number[] {
        const out: number[] = [];
        for (const c of this.calls) for (let k = 0; k < c.got; k++) out.push(c.offset + k);
        return out;
    }

    reset(): void {
        this.calls.length = 0;
        this.touched = 0;
    }
}

function build(text: string, id: string): CountingResolver {
    return new CountingResolver(StrideIndex.build(new BufferSource(Buffer.from(text, 'utf8'), id)));
}

/** Assert a possibly-absent indexed read is present, and narrow it. */
function req<T>(v: T | undefined, what: string): T {
    expect(v, `${what} must be present`).not.toBeUndefined();
    if (v === undefined) throw new Error(`${what} absent`);
    return v;
}

function score(a: Float64Array, i: number): number {
    const v = a[i];
    expect(v, `novelty[${i}] must be inside the returned array`).not.toBeUndefined();
    return v === undefined ? Number.NaN : v;
}

/** Member indices in descending novelty, ties by ascending index. */
function ranking(novelty: Float64Array): number[] {
    const order: number[] = [];
    for (let i = 0; i < novelty.length; i++) order.push(i);
    order.sort((a, b) => (score(novelty, b) - score(novelty, a)) || (a - b));
    return order;
}

function gcd(a: number, b: number): number {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y !== 0) { const t = x % y; x = y; y = t; }
    return x;
}

// ── fixtures ──────────────────────────────────────────────────────────────

interface BigFixture {
    readonly resolver: CountingResolver;
    readonly node: StrideNode;
    /** True distinct values per member name over the WHOLE array, not a sample. */
    readonly truth: Map<string, Set<string>>;
    readonly count: number;
}

/**
 * 50,000 records under `/records`, six members chosen so the census has all four
 * honesty cases to get right: two members constant over the whole array
 * (`region`, `schema`), two with a true cardinality below DISTINCT_CAP (`role` 3,
 * `active` 2), and two above it (`id` 50,000, `qty` 100).
 *
 * Built once and shared: the document is 4.6 MB of text and indexing it is the
 * expensive part of this file.
 */
let bigFixture: BigFixture | null = null;
function big(): BigFixture {
    const cached = bigFixture;
    if (cached !== null) return cached;

    const count = 50_000;
    const truth = new Map<string, Set<string>>();
    const note = (key: string, jsonValue: string): void => {
        const set = truth.get(key) ?? new Set<string>();
        set.add(jsonValue);
        truth.set(key, set);
    };
    const roles = ['admin', 'editor', 'viewer'];
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
        const record = {
            id: `u-${String(i).padStart(6, '0')}`,
            role: req(roles[i % roles.length], `role ${i}`),
            region: 'us-east-1',
            active: i % 7 !== 0,
            qty: i % 100,
            schema: 'v3',
        };
        for (const [k, v] of Object.entries(record)) note(k, JSON.stringify(v));
        parts.push(JSON.stringify(record));
    }
    const resolver = build(`{"records":[${parts.join(',')}]}`, 'big-50k');
    const node = resolver.resolve('/records');
    resolver.reset();
    bigFixture = { resolver, node, truth, count };
    return bigFixture;
}

/**
 * 20,000 byte-identical records plus two needles: one carrying an extra member,
 * one holding a string where every sibling holds a number.
 *
 * `where` places the needles. 'interior' puts them where the prime stride does
 * not land, so the census never sees them; 'tail' puts them in the last two
 * positions, which the head/tail sampler always reads — the case where the
 * census absorbs the anomaly into its own prior and could hide it.
 */
function needleDoc(where: 'interior' | 'tail'): { text: string; extra: number; wrongType: number } {
    const plain = JSON.stringify({ role: 'viewer', qty: 1, tag: 'ok' });
    const parts: string[] = [];
    for (let i = 0; i < 20_002; i++) parts.push(plain);
    const extra = where === 'interior' ? 5_000 : 20_000;
    const wrongType = where === 'interior' ? 9_000 : 20_001;
    parts[extra] = JSON.stringify({ role: 'viewer', qty: 1, tag: 'ok', debug: true });
    parts[wrongType] = JSON.stringify({ role: 'viewer', qty: 'seven', tag: 'ok' });
    return { text: `[${parts.join(',')}]`, extra, wrongType };
}

/**
 * 1,000 byte-identical six-member records plus four anomalies carrying one, two,
 * three and four unique extra members. Every member's value is shared by the
 * whole population, so the value level contributes exactly zero and the four
 * anomalies differ only in how many independent structural surprises they hold —
 * which is the one thing `Math.min(1, raw)` cannot represent, since all four
 * accumulate past 1.0.
 *
 * The anomalies sit at 500..503. At n = 1004 the interior stride is 7 and the
 * sampled interior ordinals are ≡ 1 (mod 7); 500..503 are ≡ 3..6, so the census
 * does not see them and their extra members never become census fields.
 */
function laddersDoc(): { text: string; anomalies: number[]; count: number } {
    const members: Record<string, string> = {};
    for (let k = 0; k < 6; k++) members[`k${k}`] = 'x';
    const plain = JSON.stringify(members);
    const count = 1_004;
    const parts: string[] = [];
    for (let i = 0; i < count; i++) parts.push(plain);
    const anomalies: number[] = [];
    for (let j = 1; j <= 4; j++) {
        const record: Record<string, string | number> = { ...members };
        for (let e = 0; e < j; e++) record[`x${j}_${e}`] = e;
        const at = 499 + j;
        parts[at] = JSON.stringify(record);
        anomalies.push(at);
    }
    return { text: `[${parts.join(',')}]`, anomalies, count };
}

// ── censusOf ──────────────────────────────────────────────────────────────

describe('censusOf describes a container from a bounded sample', () => {
    it('names which members of a 50,000-record array are constant and which vary, in under 1,200 characters', () => {
        const { resolver, node, truth, count } = big();
        const shape = censusOf(resolver, node);
        const serialised = JSON.stringify(shape);

        console.log(`[census] 50,000-record census serialises to ${serialised.length} characters`);
        console.log(serialised);

        expect(shape.total, 'the census must report the container\'s TRUE size, not the sampled size').toBe(count);
        expect(shape.sampled, 'a container this large must be censused from exactly SHAPE_SAMPLE members').toBe(SHAPE_SAMPLE);
        expect(shape.homogeneous, 'every record carries the same six members, so one key-set dominates').toBe(true);
        expect(shape.fields.map((f) => f.key).sort(), 'the census must find every member name and invent none')
            .toEqual([...truth.keys()].sort());

        for (const field of shape.fields) {
            const observed = req(truth.get(field.key), `ground truth for ${field.key}`);
            const trueCardinality = observed.size;
            const isConstant = trueCardinality === 1;

            expect(field.presence, `${field.key} is on every record, so presence must be 1`).toBe(1);
            expect(Object.prototype.hasOwnProperty.call(field, 'constant'),
                `${field.key} has ${trueCardinality} distinct values across the array, so 'constant' must be ${isConstant ? 'present' : 'absent'}`)
                .toBe(isConstant);
            if (isConstant) {
                expect(field.constant, `${field.key}'s constant must be the verbatim JSON value`)
                    .toBe([...observed][0]);
            }

            if (trueCardinality <= DISTINCT_CAP) {
                // Reachable cardinality: the census saw every value, so it may
                // claim the number, and the number must be the real one.
                expect(field.exact, `${field.key} has only ${trueCardinality} values; the cap was never hit, so exact must be true`).toBe(true);
                expect(field.distinct, `${field.key}'s measured cardinality must equal its true cardinality`).toBe(trueCardinality);
            } else {
                // Unreachable cardinality: the ONLY honest answers are `exact:
                // false` and a count no larger than what was actually counted.
                expect(field.exact, `${field.key} has ${trueCardinality} values, past DISTINCT_CAP=${DISTINCT_CAP}; exact must be false rather than report a cardinality nobody measured`).toBe(false);
                expect(field.distinct, `${field.key}'s reported count must be the number of values actually held, never the true cardinality it never reached`).toBe(DISTINCT_CAP);
            }

            expect(field.samples.length, `${field.key} must carry at most FIELD_SAMPLES verbatim samples`)
                .toBeLessThanOrEqual(FIELD_SAMPLES);
            for (const sample of field.samples) {
                expect(observed.has(sample), `${field.key}'s sample ${sample} must be a value the document really holds (I1)`).toBe(true);
            }
        }

        expect(serialised.length, `the whole census must fit in 1,200 characters; it is ${serialised.length}`)
            .toBeLessThan(1_200);
    }, 120_000);

    it('reports the mean member size and the honest sampled count for a container smaller than the sample', () => {
        const parts: string[] = [];
        for (let i = 0; i < 40; i++) parts.push(JSON.stringify({ a: i, b: 'z' }));
        const resolver = build(`[${parts.join(',')}]`, 'small-40');
        const node = resolver.resolve('');
        const shape = censusOf(resolver, node);

        expect(shape.sampled, 'a 40-element container is censused exactly, with no sampling error to report').toBe(40);
        expect(resolver.touched, 'and it must cost exactly those 40 members').toBe(40);
        expect(shape.fields.every((f) => f.exact),
            'every cardinality here was measured over the whole container, so nothing may be reported as inexact').toBe(true);
    });

    it('honours a caller-supplied sample ceiling exactly, including a ceiling of one', () => {
        const parts: string[] = [];
        for (let i = 0; i < 100; i++) parts.push(JSON.stringify({ a: i }));
        const resolver = build(`[${parts.join(',')}]`, 'budget-100');
        const node = resolver.resolve('');

        // `sample` is a CEILING, and the only hard claims are that it is never
        // exceeded and that `sampled` reports what was really inspected. A head
        // and a tail are both rounded up to one member, so a ceiling of 1 is
        // where the two halves of the split can overrun the budget between them
        // and report a `sampled` the caller never authorised.
        const observed: Array<[number, number]> = [];
        for (const ask of [1, 2, 3, 4, 8, 64]) {
            resolver.reset();
            const shape = censusOf(resolver, node, { sample: ask });
            observed.push([ask, shape.sampled]);
            expect(shape.sampled, `sample:${ask} must inspect at most ${ask} members`).toBeLessThanOrEqual(ask);
            expect(resolver.touched, `sample:${ask} must REQUEST at most ${ask} members, not just report that many`)
                .toBeLessThanOrEqual(ask);
            expect(shape.sampled, `sample:${ask} must report the members actually requested, not the number asked for`)
                .toBe(resolver.touched);
            if (ask <= 4) {
                // Below five the head/tail split alone consumes the budget, so
                // the whole ceiling is spent and the boundary is exact.
                expect(shape.sampled, `sample:${ask} splits into head and tail with nothing left over, so it must spend the ceiling exactly`).toBe(ask);
            }
            // Rounding the interior spacing UP to a prime can leave part of the
            // interior budget unspent — worst case a third of it, when the ideal
            // spacing is 2 and the stride becomes 3 — so the floor is
            // 0.25 + 0.25 + (2/3 x 0.5) = 0.83 of the ceiling.
            expect(shape.sampled, `sample:${ask} inspected ${shape.sampled}; the prime round-up may cost part of the interior budget but never a sixth of the whole sample`)
                .toBeGreaterThanOrEqual(Math.floor(ask * 0.83));
        }
        console.log(`[budget] ask -> sampled: ${observed.map(([a, s]) => `${a}->${s}`).join(', ')} over a 100-element array`);

        resolver.reset();
        const beyond = censusOf(resolver, node, { sample: SHAPE_SAMPLE * 10 });
        expect(beyond.sampled, 'a caller may ask for a cheaper census, never a more expensive one')
            .toBeLessThanOrEqual(SHAPE_SAMPLE);
    });

    it('costs at most SHAPE_SAMPLE members however large the array', () => {
        const measured: Array<{ n: number; touched: number; sampled: number; total: number }> = [];
        for (const n of [50_000, 400_000]) {
            const parts: string[] = [];
            for (let i = 0; i < n; i++) parts.push(String(i % 10));
            const resolver = build(`[${parts.join(',')}]`, `scalars-${n}`);
            const node = resolver.resolve('');
            resolver.reset();
            const shape = censusOf(resolver, node);
            measured.push({ n, touched: resolver.touched, sampled: shape.sampled, total: shape.total });
        }

        const first = req(measured[0], 'the 50,000-element measurement');
        const second = req(measured[1], 'the 400,000-element measurement');
        console.log(`[sampling] 50,000 elements -> ${first.touched} members touched; 400,000 elements -> ${second.touched}`);

        for (const m of measured) {
            expect(m.touched, `a ${m.n}-element census touched ${m.touched} members; the bound is SHAPE_SAMPLE=${SHAPE_SAMPLE}`)
                .toBeLessThanOrEqual(SHAPE_SAMPLE);
            expect(m.sampled, `the census must report the number of members it really inspected (${m.touched})`).toBe(m.touched);
            expect(m.total, `and it must still know the container's true size while touching only ${m.touched} of it`).toBe(m.n);
        }
        expect(second.touched, 'an eight-fold larger array must cost the census exactly the same; a cost that grows with the container is a walk wearing a sample\'s name')
            .toBe(first.touched);
    }, 120_000);

    it('describes an array of scalars under the reserved element name', () => {
        const resolver = build('[1,2,"x",true,null]', 'scalars-mixed');
        const shape = censusOf(resolver, resolver.resolve(''));
        const field = req(shape.fields[0], 'the element field');

        expect(shape.fields.length, 'array elements have no member names, so they census as one field').toBe(1);
        expect(field.key, 'and that field is named under the reserved STRIDE prefix so it cannot collide with a document key (I1)')
            .toBe(ELEMENT_FIELD);
        expect(field.kinds, 'kinds must be ordered most-frequent-first: two numbers, then one each of the rest')
            .toEqual(['number', 'string', 'boolean', 'null']);
        expect(field.distinct, 'five elements, five distinct values, all measured').toBe(5);
    });
});

// ── the prime-strided sampler ─────────────────────────────────────────────

describe('the sampler does not lock onto a period in the data', () => {
    // 5,248 records is the adversarial size: the interior span is 5,120 and the
    // interior budget 128, so the IDEAL spacing is exactly 40 — a multiple of the
    // fixture's period of 10. A sampler that used the ideal spacing would read
    // one residue class mod 10 forever and report a member present on a tenth of
    // the records as either absent or universal.
    const count = 5_248;
    const period = 10;

    function periodicDoc(): string {
        const parts: string[] = [];
        for (let i = 0; i < count; i++) {
            parts.push(i % period === 0
                ? JSON.stringify({ id: i, kind: 'a', marker: true })
                : JSON.stringify({ id: i, kind: 'a' }));
        }
        return `[${parts.join(',')}]`;
    }

    it('sees a member that appears on every tenth record, and reports its presence at the measured rate', () => {
        const resolver = build(periodicDoc(), 'periodic-5248');
        const node = resolver.resolve('');
        resolver.reset();
        const shape = censusOf(resolver, node);

        const ordinals = resolver.sampledOrdinals();
        const carriers = ordinals.filter((o) => o % period === 0).length;
        const expected = Math.round((carriers / ordinals.length) * 1000) / 1000;

        const marker = req(shape.fields.find((f) => f.key === 'marker'), 'the marker field');
        expect(ordinals.length, 'the recorded ordinals must be the census sample itself').toBe(shape.sampled);
        expect(marker.presence, `presence must equal the measured rate over the sampled ordinals (${carriers}/${ordinals.length})`)
            .toBe(expected);
        expect(marker.presence, 'a sampler locked onto the period would report the varying member as absent').toBeGreaterThan(0);
        expect(marker.presence, 'or as universal').toBeLessThan(1);
        expect(shape.fields.map((f) => f.key), 'and the two members every record carries must still be there')
            .toEqual(expect.arrayContaining(['id', 'kind']));
    }, 60_000);

    it('walks the interior on a prime stride coprime to the period, sweeping every residue class', () => {
        const resolver = build(periodicDoc(), 'periodic-5248-b');
        const node = resolver.resolve('');
        resolver.reset();
        censusOf(resolver, node);

        // Interior positions are the single-member requests; head and tail are
        // the two ranged ones.
        const interior = resolver.calls.filter((c) => c.limit === 1).map((c) => c.offset);
        expect(interior.length, 'the interior must be sampled at all').toBeGreaterThan(period);
        const stride = req(interior[1], 'the second interior ordinal') - req(interior[0], 'the first interior ordinal');

        for (let k = 1; k < interior.length; k++) {
            expect(req(interior[k], `interior ordinal ${k}`) - req(interior[k - 1], `interior ordinal ${k - 1}`),
                'the interior walk must be a constant stride, so its coprimality is a property of one number')
                .toBe(stride);
        }
        console.log(`[stride] interior stride ${stride} over a period of ${period}; ideal spacing was 40`);

        expect(gcd(stride, period), `stride ${stride} shares a factor with the period ${period}: the sampled ordinals cannot leave one residue class`)
            .toBe(1);
        const residues = new Set(interior.map((o) => o % period));
        expect(residues.size, `the interior sample must reach all ${period} residue classes mod ${period}; it reached ${residues.size}`)
            .toBe(period);
    }, 60_000);
});

// ── noveltyOf ─────────────────────────────────────────────────────────────

describe('noveltyOf finds the record that breaks the shape', () => {
    for (const where of ['interior', 'tail'] as const) {
        it(`ranks an extra member and a wrong type in the top 5 of 20,002 records, with the needles ${where === 'tail' ? 'inside the census sample' : 'outside it'}`, () => {
            const { text, extra, wrongType } = needleDoc(where);
            const resolver = build(text, `needle-${where}`);
            const node = resolver.resolve('');
            const shape = censusOf(resolver, node);
            const members = resolver.members(node, 0, node.count);
            const novelty = noveltyOf(resolver, node, members, shape);

            expect(members.length, 'the whole population must be scored').toBe(20_002);
            const order = ranking(novelty);
            const top5 = order.slice(0, 5);
            expect(top5, `the record with an extra member must be in the top 5; it ranked ${order.indexOf(extra) + 1} of ${members.length}`)
                .toContain(extra);
            expect(top5, `the record with a wrong type at a known member must be in the top 5; it ranked ${order.indexOf(wrongType) + 1} of ${members.length}`)
                .toContain(wrongType);

            // The strict form of the claim. The 20,000 boilerplate records are
            // byte-identical, so a scorer that measures structure must give them
            // one shared score; anything that separates them is separating on
            // position in the array, which is not a property of a record.
            const floorScore = Math.min(...novelty);
            const separated: number[] = [];
            for (let i = 0; i < novelty.length; i++) if (score(novelty, i) > floorScore) separated.push(i);
            expect(separated.sort((a, b) => a - b), 'exactly two members may be separated from the population: the two anomalies, and nothing else')
                .toEqual([extra, wrongType].sort((a, b) => a - b));

            // Rank calibration puts the top member at exactly 1 and the runner-up
            // at exactly (n-2)/(n-1).
            const n = members.length;
            expect(score(novelty, req(order[0], 'the top-ranked member')), 'the most unusual record must calibrate to exactly 1').toBe(1);
            expect(score(novelty, req(order[1], 'the second-ranked member')), 'and the second must calibrate to the rank below it')
                .toBeCloseTo((n - 2) / (n - 1), 12);
        }, 120_000);
    }

    it('does not let a high-cardinality id member make every record novel', () => {
        // 20,000 records whose only varying member is a session id. 500 of the ids
        // are carried by two records each, so an id-blind scorer and an id-scoring
        // scorer produce visibly different populations: scoring the id splits the
        // corpus into "shares an id" and "does not", which is a fact about id
        // collisions and not about any record.
        const parts: string[] = [];
        for (let i = 0; i < 20_000; i++) {
            const sid = i < 1_000 ? `s-${Math.floor(i / 2)}` : `s-uniq-${i}`;
            parts.push(JSON.stringify({ sid, tag: 'ok', qty: 1 }));
        }
        const needle = 7_777;
        parts[needle] = JSON.stringify({ sid: 's-uniq-7777', tag: 'ok', qty: 'x' });
        const resolver = build(`[${parts.join(',')}]`, 'high-card-id');
        const node = resolver.resolve('');
        const shape = censusOf(resolver, node);

        const sid = req(shape.fields.find((f) => f.key === 'sid'), 'the sid field');
        expect(sid.exact, 'sid must be reported as an unmeasured cardinality: it is the only signal that stops it feeding value grams').toBe(false);
        expect(sid.distinct, 'and the count it reports must be the number of values it actually held').toBe(DISTINCT_CAP);

        const members = resolver.members(node, 0, node.count);
        const novelty = noveltyOf(resolver, node, members, shape);
        const floorScore = Math.min(...novelty);
        let atFloor = 0;
        for (const v of novelty) if (v === floorScore) atFloor++;
        const distinct = new Set<number>();
        for (const v of novelty) distinct.add(v);

        console.log(`[saturation] ${atFloor} of ${novelty.length} members at the novelty floor; ${distinct.size} distinct novelty values`);

        expect(atFloor / novelty.length, `${atFloor} of ${novelty.length} members sit at the novelty floor; a unique id is not an anomaly and at least 99% of the corpus must read as ordinary`)
            .toBeGreaterThan(0.99);
        expect(distinct.size, `the population must collapse into a handful of novelty levels, not fragment into one per id; it produced ${distinct.size}`)
            .toBeLessThanOrEqual(4);
        expect(ranking(novelty)[0], 'and the one record with a wrong type must still be the single most novel').toBe(needle);
        expect(score(novelty, needle), 'alone at the top').toBe(1);
    }, 120_000);

    it('ranks a record with more independent anomalies above one with fewer', () => {
        // Four anomalies carrying 1, 2, 3 and 4 unique extra members. Their raw
        // structural accumulators are about 2.07, 3.10, 4.13 and 5.17 nats-scaled
        // — all past 1.0, which is where `Math.min(1, raw)` maps them onto a
        // single plateau and destroys the ordering entirely.
        const { text, anomalies, count } = laddersDoc();
        const resolver = build(text, 'ladders');
        const node = resolver.resolve('');
        const shape = censusOf(resolver, node);
        const members = resolver.members(node, 0, node.count);
        const novelty = noveltyOf(resolver, node, members, shape);

        expect(members.length, 'the whole population must be scored').toBe(count);
        expect(shape.fields.map((f) => f.key).sort(), 'the anomalies sit off the sampled stride, so the census must see only the six shared members')
            .toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);

        for (let j = 1; j < anomalies.length; j++) {
            const fewer = req(anomalies[j - 1], `anomaly ${j}`);
            const more = req(anomalies[j], `anomaly ${j + 1}`);
            expect(score(novelty, more), `the record with ${j + 1} unexpected members must outrank the one with ${j}; a clamped accumulator flattens both onto one value and loses exactly this ordering`)
                .toBeGreaterThan(score(novelty, fewer));
        }
    }, 60_000);

    it('calibrates novelty by rank, so a runner-up reads as a runner-up and not as a rounding error', () => {
        // Rank calibration has closed-form output: with one tie group of 1,000 at
        // the bottom and four distinct scores above it, the four must land on
        // 1000/1003, 1001/1003, 1002/1003 and 1. Min-max would instead place them
        // at their raw scores' positions on the value scale — about 0.877, 0.961,
        // 0.990 and 1 for this fixture — which reports the runner-up as 12%
        // short of the leader when it is one rank behind it out of 1,004.
        const { text, anomalies, count } = laddersDoc();
        const resolver = build(text, 'ladders-calibration');
        const node = resolver.resolve('');
        const shape = censusOf(resolver, node);
        const members = resolver.members(node, 0, node.count);
        const novelty = noveltyOf(resolver, node, members, shape);

        const boilerplate = count - anomalies.length;
        for (let j = 0; j < anomalies.length; j++) {
            const at = req(anomalies[j], `anomaly ${j + 1}`);
            const expected = (boilerplate + j) / (count - 1);
            expect(score(novelty, at), `anomaly ${j + 1} is the ${boilerplate + j + 1}th lowest of ${count} scores, so rank calibration must report exactly ${expected}; a value-scale normaliser reports where its raw score sits between the min and the max instead`)
                .toBeCloseTo(expected, 12);
        }

        let atFloor = 0;
        for (const v of novelty) if (v === 0) atFloor++;
        expect(atFloor, `all ${boilerplate} identical records must share the bottom rank; spreading a tie group across [0,1] would rank ${boilerplate - 1} boilerplate records above the floor for no reason but scan order`)
            .toBe(boilerplate);
    }, 60_000);

    it('scores nothing against a census taken over a different container', () => {
        const resolver = build('{"a":[{"p":1},{"p":2},{"q":3}],"b":[{"p":1},{"p":2},{"p":3}]}', 'two-arrays');
        const a = resolver.resolve('/a');
        const b = resolver.resolve('/b');
        const censusB = censusOf(resolver, b);
        const membersA = resolver.members(a, 0, a.count);

        const withForeign = noveltyOf(resolver, a, membersA, censusB);
        const withOwn = noveltyOf(resolver, a, membersA, censusOf(resolver, a));
        expect(withForeign.length, 'a foreign census must not change the shape of the result').toBe(membersA.length);
        expect(ranking(withForeign)[0], 'the odd member of /a is still the odd member when the prior is discarded').toBe(2);
        expect(ranking(withOwn)[0], 'and with its own census too').toBe(2);
    });
});

// ── redundancyOf ──────────────────────────────────────────────────────────

describe('redundancyOf collapses boilerplate without losing anything', () => {
    it('marks near-identical records redundant while every one of them stays addressable and retrievable', () => {
        const count = 5_000;
        const written: string[] = [];
        for (let i = 0; i < count; i++) written.push(JSON.stringify({ id: `r-${String(i).padStart(5, '0')}`, role: 'viewer', note: 'n' }));
        const resolver = build(`[${written.join(',')}]`, 'boilerplate-5k');
        const node = resolver.resolve('');
        const shape = censusOf(resolver, node);
        const members = resolver.members(node, 0, node.count);
        const report = redundancyOf(resolver, node, members, shape);

        const seen = new Set<number>([...report.representative, ...report.redundant]);
        expect(report.representative.length + report.redundant.length,
            'every member must land in exactly one of the two lists; a member in neither has been dropped, and this is a navigator')
            .toBe(count);
        expect(seen.size, 'and no member may land in both').toBe(count);
        for (let i = 0; i < count; i++) {
            expect(seen.has(i), `member ${i} must appear in the report; nothing is ever deleted`).toBe(true);
        }
        expect(report.signatures.length, 'and every member must carry a signature').toBe(count);
        expect(report.redundant.length, `${report.redundant.length} of ${count} identical records were collapsed; boilerplate that does not collapse makes the report useless`)
            .toBeGreaterThan(count * 0.9);

        console.log(`[redundancy] ${report.representative.length} representatives, ${report.redundant.length} redundant of ${count}`);

        // Addressability, checked the only way that means anything: go and get
        // the bytes back through the resolver, by pointer, and compare them to
        // what was written.
        for (let k = 0; k < report.redundant.length; k += Math.ceil(report.redundant.length / 25)) {
            const i = req(report.redundant[k], `redundant entry ${k}`);
            const member = req(members[i], `member ${i}`);
            const reResolved = resolver.resolve(`/${i}`);
            expect(reResolved.start, `redundant member ${i} must still resolve to its own span`).toBe(member.start);
            expect(reResolved.end, `redundant member ${i}'s span must still end where it ended`).toBe(member.end);
            expect(resolver.source.slice(reResolved.start, reResolved.end).toString('utf8'),
                `redundant member ${i} must still return its verbatim bytes (I1)`)
                .toBe(req(written[i], `written record ${i}`));
        }
    }, 120_000);

    it('keeps a record whose schema is shared but whose size is not', () => {
        // Same members, same kinds, same key-set, a `note` ten times longer. The
        // structural grams cannot tell it apart; the size bucket can. It also has
        // the population's floor novelty and sits near the end of the walk, so
        // the highest-novelty veto provably is not what saves it.
        const count = 1_000;
        const parts: string[] = [];
        for (let i = 0; i < count; i++) parts.push(JSON.stringify({ id: `r-${i}`, role: 'viewer', note: `note-${i}` }));
        const bulky = count - 5;
        parts[bulky] = JSON.stringify({ id: `r-${bulky}`, role: 'viewer', note: `note-${'x'.repeat(400)}` });
        const resolver = build(`[${parts.join(',')}]`, 'size-channel');
        const node = resolver.resolve('');
        const shape = censusOf(resolver, node);
        const members = resolver.members(node, 0, node.count);
        const novelty = noveltyOf(resolver, node, members, shape);
        const report = redundancyOf(resolver, node, members, shape);

        expect(score(novelty, bulky), 'the bulky record must sit at the novelty floor: its schema is identical, so novelty has nothing to see')
            .toBe(Math.min(...novelty));
        expect(ranking(novelty).indexOf(bulky), 'and it must sit far past the 10% ceiling on the highest-novelty veto, so that veto cannot be what keeps it')
            .toBeGreaterThan(count * 0.5);
        expect(report.representative, `the record ten times the size of its siblings must survive collapse; a signature carrying only the structural grams would predict it from any of them`)
            .toContain(bulky);
        expect(req(report.signatures[bulky], 'the bulky record\'s signature'), 'and its signature must differ from its siblings\'')
            .not.toBe(req(report.signatures[0], 'a sibling\'s signature'));
    }, 60_000);

    it('keeps the second member of a rare-value pair, which the keep-first rule alone cannot', () => {
        // Two records share one rare value of an enumerated member. Sharing it
        // gives them the SAME signature, so keep-first shows one and predicts the
        // other — and the rare-value veto is the only rule that can prevent that.
        //
        // 150 records carrying a unique extra member each occupy the top of the
        // novelty order, pushing the rare pair past position 100, which is the
        // hard 10% ceiling on the highest-novelty veto. So neither the keep-first
        // rule nor the novelty veto can account for the second one surviving.
        const count = 1_000;
        const parts: string[] = [];
        for (let i = 0; i < count; i++) parts.push(JSON.stringify({ id: `r-${String(i).padStart(4, '0')}`, role: 'viewer', note: 'n' }));
        for (let i = 0; i < 150; i++) {
            parts[i] = JSON.stringify({ id: `r-${String(i).padStart(4, '0')}`, role: 'viewer', note: 'n', [`x${i}`]: i });
        }
        const firstRare = 400;
        const secondRare = 401;
        parts[firstRare] = JSON.stringify({ id: 'r-0400', role: 'ghost', note: 'n' });
        parts[secondRare] = JSON.stringify({ id: 'r-0401', role: 'ghost', note: 'n' });
        const resolver = build(`[${parts.join(',')}]`, 'rare-veto');
        const node = resolver.resolve('');
        const shape = censusOf(resolver, node);
        const members = resolver.members(node, 0, node.count);
        const novelty = noveltyOf(resolver, node, members, shape);
        const report = redundancyOf(resolver, node, members, shape);

        const role = req(shape.fields.find((f) => f.key === 'role'), 'the role field');
        expect(role.exact, 'role must be a measured enumeration, or its values never become value grams and there is no rare value to veto on').toBe(true);
        expect(req(report.signatures[secondRare], 'the second rare record\'s signature'),
            'the two records sharing the rare value must share a signature: that is what makes this the case keep-first cannot handle')
            .toBe(req(report.signatures[firstRare], 'the first rare record\'s signature'));

        const order = ranking(novelty);
        expect(order.indexOf(secondRare), 'the second rare record must rank past the 10% (100 of 1,000) ceiling on the highest-novelty veto, so that veto cannot be keeping it')
            .toBeGreaterThanOrEqual(150);
        expect(report.representative, 'the first member of a signature is always kept').toContain(firstRare);
        expect(report.representative, 'and the SECOND member of the rare pair must be kept too, by the rare-value veto and nothing else')
            .toContain(secondRare);
        expect(report.redundant.length, 'while the boilerplate still collapses, or the vetoes have simply disabled collapse')
            .toBeGreaterThan(count * 0.5);
    }, 60_000);
});

// ── knee ──────────────────────────────────────────────────────────────────

describe('knee is two detectors, and both of them fire', () => {
    it('cuts a bounded candidate list exactly at the cliff', () => {
        const list = [9.2, 9.1, 8.9, 0.4, 0.3, 0.2];
        expect(knee(list, 100), 'the reference cliff must cut at 3').toBe(3);

        // Recomputed here, independently: relGap measured against the score above
        // the gap, times the gap's share of the range. The winner must be the
        // cliff and it must clear the 0.05 firing floor by a wide margin, or the
        // 3 above is ceil(sqrt(6)) wearing a detection's clothes.
        const range = req(list[0], 'top score') - req(list[list.length - 1], 'bottom score');
        let bestCut = 0;
        let bestScore = 0;
        const scores: number[] = [];
        for (let i = 1; i + 1 < list.length; i++) {
            const left = req(list[i], `score ${i}`);
            const absGap = left - req(list[i + 1], `score ${i + 1}`);
            const weighted = (absGap / left) * (absGap / range);
            scores.push(weighted);
            if (weighted > bestScore) { bestScore = weighted; bestCut = i + 1; }
        }
        expect(bestCut, 'the weighted-gap argmax must be the cliff itself').toBe(3);
        expect(bestScore, `the winning weighted gap is ${bestScore.toFixed(4)} and must clear the 0.05 floor`).toBeGreaterThan(0.05);
        expect(Math.max(...scores.filter((s) => s !== bestScore)), 'and every other gap must be nowhere near it').toBeLessThan(0.01);
    });

    it('cuts a cliff that lies well below the sqrt floor, which is the only way to prove the detector ran', () => {
        // Sixteen scores with the cliff after the eighth. ceil(sqrt(16)) = 4, so a
        // detector that never fires answers 4 and a detector that fires answers 8.
        const list = [9.2, 9.15, 9.1, 9.05, 9.0, 8.95, 8.9, 8.85, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05];
        const floor = Math.ceil(Math.sqrt(list.length));
        expect(floor, 'the floor for this list').toBe(4);
        expect(knee(list, 100), 'the cut must be the cliff at 8, not the sqrt floor of 4').toBe(8);
    });

    it('measures the relative gap against the score above it, not the one below', () => {
        // The two readings of relGap agree on almost every input, which is why
        // this list is constructed: fifteen scores whose only real cliff is the
        // 100 -> 70 drop at position 6, followed by an ordinary decay into a
        // near-zero floor. Dividing by the score BELOW the gap makes the final
        // 1.01 -> 0.01 step score 0.9996 — a hundred times the cliff's 0.09 —
        // and reads a tail collapse as the decision boundary. Dividing by the
        // score ABOVE bounds the product into [0,1], which is the scale the 0.05
        // firing floor is defined on.
        const list = [100.05, 100.04, 100.03, 100.02, 100.01, 100.0, 70, 60, 50, 40, 30, 20, 10, 1.01, 0.01];
        const n = list.length;
        const range = req(list[0], 'top score') - req(list[n - 1], 'bottom score');

        let leftCut = 0;
        let leftBest = 0;
        let rightCut = 0;
        let rightBest = 0;
        for (let i = 1; i + 1 < n; i++) {
            const above = req(list[i], `score ${i}`);
            const below = req(list[i + 1], `score ${i + 1}`);
            const absGap = above - below;
            const asSpecified = (absGap / above) * (absGap / range);
            const invertedRef = (absGap / below) * (absGap / range);
            if (asSpecified > leftBest) { leftBest = asSpecified; leftCut = i + 1; }
            if (invertedRef > rightBest) { rightBest = invertedRef; rightCut = i + 1; }
        }

        const floor = Math.ceil(Math.sqrt(n));
        expect(leftCut, 'the specified reading must pick the cliff at 6').toBe(6);
        expect(leftCut, 'and that cut must lie above the sqrt floor, so the answer is a detection rather than a floor').toBeGreaterThan(floor);
        expect(rightCut, 'while the inverted reading picks the tail collapse at 14').toBe(14);
        expect(leftBest, 'the specified reading keeps the product inside [0,1], where a 0.05 floor means a twentieth of a perfect cliff').toBeLessThanOrEqual(1);
        expect(knee(list, 100), `the cut must be the cliff at ${leftCut}, not the tail collapse at ${rightCut}`).toBe(leftCut);
    });

    it('returns the sqrt floor when a bounded list has no cliff worth the name', () => {
        // A 4% dip from 100 is the largest gap here, so the branch is entered, but
        // relGap is 0.04 and the product falls under the 0.05 floor. The floor is
        // then the answer BECAUSE nothing was detected, which is what a floor is
        // for, and the assertion says so.
        const list = [100, 100, 96, 95.5, 95];
        expect(knee(list, 100), 'no gap clears the firing floor, so the answer is ceil(sqrt(5)) = 3, reported as a floor rather than a detection')
            .toBe(Math.ceil(Math.sqrt(list.length)));
    });

    it('reads the bend of a 10,000-point smooth curve instead of collapsing to sqrt(n)', () => {
        const n = 10_000;
        const curve: number[] = [];
        for (let i = 0; i < n; i++) curve.push(Math.exp(-i / 1_000));

        // Ground truth, recomputed: the chord deviation (1-x) - y in normalised
        // coordinates. For exp(-i/1000) over 10,000 points the maximum is where
        // the curve's normalised slope is -1, i.e. i = 1000*ln(9999/1000) = 2302.5.
        const base = req(curve[n - 1], 'bottom score');
        const range = req(curve[0], 'top score') - base;
        let argmax = 0;
        let bestDev = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < n; i++) {
            const dev = (1 - i / (n - 1)) - (req(curve[i], `score ${i}`) - base) / range;
            if (dev > bestDev) { bestDev = dev; argmax = i; }
        }
        const floor = Math.ceil(Math.sqrt(n));
        const answer = knee(curve, n);
        console.log(`[knee] 10,000-point exponential: chord branch returns ${answer} (argmax ${argmax}, deviation ${bestDev.toFixed(4)}); the sqrt floor is ${floor}`);

        expect(bestDev, 'the curve must bend well past the 0.02 chord firing floor, or there is nothing here to detect').toBeGreaterThan(0.02);
        expect(answer, `the chord branch must return the bend at ${argmax + 1}`).toBe(argmax + 1);
        expect(answer, `${answer} must be nowhere near the sqrt floor of ${floor}; a detector that collapses to the floor answers ${floor} and calls it adaptive`)
            .toBeGreaterThan(floor * 10);
        expect(Math.abs(answer - (1 + 1_000 * Math.log((n - 1) / 1_000))), 'and it must land on the analytic knee of exp(-i/1000), 1000*ln(9999/1000)')
            .toBeLessThan(2);
    });

    it('returns the sqrt floor on a straight descent, because a straight line has no knee', () => {
        const n = 10_000;
        const line: number[] = [];
        for (let i = 0; i < n; i++) line.push(1 - i / (n - 1));
        expect(knee(line, n), 'chord deviation is 0 everywhere on a straight line, so nothing fires and the floor is the honest answer')
            .toBe(Math.ceil(Math.sqrt(n)));
    });

    it('returns the sqrt floor when every score is the same number', () => {
        const flat = new Array<number>(1_000).fill(0.5);
        expect(knee(flat, 500), 'no cutoff exists in a list with no variation; claiming one would be inventing structure')
            .toBe(Math.ceil(Math.sqrt(1_000)));
    });

    it('clamps to the cap from above and to one member from below', () => {
        expect(knee([9.2, 9.1, 8.9, 0.4, 0.3, 0.2], 2), 'the cap bounds the answer even when the detector wants more').toBe(2);
        expect(knee([9.2, 9.1, 8.9, 0.4, 0.3, 0.2], 0), 'a cap of zero still has to name at least one member').toBe(1);
        expect(knee([], 10), 'an empty list has nothing to cut').toBe(0);
        expect(knee([1], 10), 'a single score is its own answer').toBe(1);
    });
});

// ── cost ──────────────────────────────────────────────────────────────────

/**
 * A census's cost has to be a function of the request, not of the document
 * (I6). The failure this guards was not subtle: the census allocated one tally
 * per grandchild, so ONE wide record decided the memory. A 3.03 MiB array
 * holding a single 200,000-key record retained 207.34 MiB, 68.4x the document,
 * and buildMap on a 4.76 MiB document died with FATAL heap under
 * --max-old-space-size=256 — four orders of magnitude below the size this
 * navigator exists to read.
 *
 * Heap is not asserted here, because a heap assertion inside a shared suite
 * measures the suite. What is asserted is the mechanism that made it grow: how
 * many members a census describes, whether it says that it stopped, and whether
 * its output stops changing once the document outgrows the cap. Those are
 * deterministic, and a regression cannot pass them.
 */
describe('a census is bounded by its cap, not by the width of a record', () => {
    /** One array of `records` records, each with `keys` distinct members. */
    function wide(records: number, keys: number, id: string): { resolver: CountingResolver; node: StrideNode } {
        const rec = (r: number): string => '{' + Array.from(
            { length: keys },
            (_, i) => `"f${String(records === 1 ? i : r * keys + i).padStart(7, '0')}":${i}`,
        ).join(',') + '}';
        const doc = '[' + Array.from({ length: records }, (_, r) => rec(r)).join(',') + ']';
        const resolver = build(doc, id);
        return { resolver, node: resolver.root() };
    }

    it('describes at most CENSUS_FIELD_CAP members however wide one record is', () => {
        for (const keys of [CENSUS_FIELD_CAP - 1, CENSUS_FIELD_CAP, CENSUS_FIELD_CAP + 1, 20_000]) {
            const { resolver, node } = wide(1, keys, `wide-${keys}`);
            const shape = censusOf(resolver, node);
            expect(
                shape.fields.length,
                `a record with ${keys} members produced ${shape.fields.length} fields. The census keeps one tally `
                + `per described name, so an uncapped count is the memory bound being set by the document.`,
            ).toBeLessThanOrEqual(CENSUS_FIELD_CAP);
            expect(
                shape.widestMember,
                `the census must count the record's true width even where it stops describing it, or a caller `
                + 'cannot tell a 64-member record from a 20,000-member one (I4).',
            ).toBe(keys);
            expect(
                shape.fieldsCapped,
                `a ${keys}-member record with a cap of ${CENSUS_FIELD_CAP} reported fieldsCapped=${shape.fieldsCapped}. `
                + 'Withholding members without saying so is silent truncation.',
            ).toBe(keys > CENSUS_FIELD_CAP);
        }
    }, 120_000);

    it('caps distinct names across the sample, not only inside one record', () => {
        // No single record is wide, but the sample's union is: 200 records of 250
        // members each carry 50,000 distinct names between them. A per-record cap
        // alone leaves the tally map unbounded.
        const { resolver, node } = wide(200, 250, 'wide-union');
        const shape = censusOf(resolver, node);
        expect(
            shape.fields.length,
            `250 members per record across 200 records produced ${shape.fields.length} fields from a union of `
            + '50,000 distinct names.',
        ).toBeLessThanOrEqual(CENSUS_FIELD_CAP);
        expect(shape.fieldsCapped, 'the union overflowed the cap, so the census has to say so').toBe(true);
        expect(shape.widestMember, 'each record holds 250 members').toBe(250);
    }, 120_000);

    it('stops changing once the document outgrows the cap', () => {
        // The census of a 16x larger document must describe the same members in
        // the same way. A field list that keeps growing with the input is the
        // defect restated, whatever the constant in front of it.
        const small = censusOf(...(() => { const w = wide(1, 50_000, 'flat-small'); return [w.resolver, w.node] as const; })());
        const large = censusOf(...(() => { const w = wide(1, 800_000, 'flat-large'); return [w.resolver, w.node] as const; })());
        expect(
            JSON.stringify(large.fields),
            `the census of an 800,000-member record described ${large.fields.length} fields against `
            + `${small.fields.length} for a 50,000-member one. Same cap, same first members, so the same output.`,
        ).toBe(JSON.stringify(small.fields));
        expect(small.widestMember, 'the true width is still reported exactly').toBe(50_000);
        expect(large.widestMember, 'the true width is still reported exactly').toBe(800_000);
    }, 300_000);

    it('describes an oversized member name by its length instead of its text', () => {
        // A member name is bytes the document chose. Reading it in full puts the
        // document's own scale back into the census's memory: measured at 60.66
        // MiB retained on a 31.26 MiB document of 40-KiB names, held twice over
        // in the tally keys and the key-set signatures.
        const long = 'k'.repeat(40_960);
        const doc = `[{"${long}":1,"ok":2},{"${long}":3,"ok":4}]`;
        const resolver = build(doc, 'long-names');
        const shape = censusOf(resolver, resolver.root());
        const oversized = shape.fields.filter((f) => f.key !== 'ok');
        expect(oversized.length, 'the oversized member still has to appear; dropping it would be a silent omission').toBe(1);
        const [only] = oversized;
        expect(only, 'the oversized field is missing').toBeTruthy();
        if (only === undefined) return;
        expect(
            only.key.includes('kkkk'),
            `the census emitted ${only.key.length} characters of a ${long.length}-byte member name. A name longer `
            + `than CENSUS_NAME_BYTES (${CENSUS_NAME_BYTES}) is described, not copied.`,
        ).toBe(false);
        expect(
            MARKER_RE.test(only.key),
            `an abbreviated member name must be in the one sanctioned marker form so no reader takes it for a `
            + `document key; got ${JSON.stringify(only.key)}.`,
        ).toBe(true);
        expect(
            only.key,
            'the marker has to carry the name\'s true byte length, which is the only thing left of it',
        ).toContain(String(long.length));
    }, 60_000);

    it('keeps a name at exactly the bound verbatim, and the next byte abbreviated', () => {
        // The boundary itself: CENSUS_NAME_BYTES is inclusive, so a name of
        // exactly that many bytes is a real key and one byte more is not.
        const at = 'a'.repeat(CENSUS_NAME_BYTES);
        const over = 'b'.repeat(CENSUS_NAME_BYTES + 1);
        const resolver = build(`[{"${at}":1,"${over}":2}]`, 'name-boundary');
        const keys = censusOf(resolver, resolver.root()).fields.map((f) => f.key);
        expect(keys, `a ${CENSUS_NAME_BYTES}-byte name is inside the bound and must be reported verbatim`).toContain(at);
        expect(keys, `a ${CENSUS_NAME_BYTES + 1}-byte name is past the bound and must not be reported verbatim`).not.toContain(over);
    });

    it('scans a record past the field cap, and says where it stopped', () => {
        // The two caps bound different costs and must not be confused: a record
        // of 300 members is fully scanned, and only its DESCRIPTION is capped at
        // 64. Collapsing the scan onto the field cap is what made novelty blind
        // past the 64th member.
        const mid = censusOf(...(() => {
            const rec = '{' + Array.from({ length: 300 }, (_, i) => `"f${String(i).padStart(4, '0')}":${i}`).join(',') + '}';
            const r = build(`[${rec},${rec}]`, 'scan-mid');
            return [r, r.root()] as const;
        })());
        expect(mid.widestMember, 'a 300-member record is scanned in full').toBe(300);
        expect(mid.fields.length, 'and described only up to the field cap').toBe(CENSUS_FIELD_CAP);

        const over = censusOf(...(() => {
            const rec = '{' + Array.from({ length: CENSUS_SCAN_CAP + 500 }, (_, i) => `"f${String(i).padStart(5, '0')}":${i}`).join(',') + '}';
            const r = build(`[${rec},${rec}]`, 'scan-over');
            return [r, r.root()] as const;
        })());
        expect(
            over.widestMember,
            'a record past the scan cap is still COUNTED in full, or the caller cannot tell how much of the record '
            + 'it is looking at (I4).',
        ).toBe(CENSUS_SCAN_CAP + 500);
        expect(over.fieldsCapped, 'and the census has to say that it stopped').toBe(true);
    }, 120_000);

    it('reports the scan cap on a record the field cap cannot reach', () => {
        // Every assertion above survives deleting the scan cap, because on those
        // fixtures the FIELD cap sets `fieldsCapped` on its own — 1,524 distinct
        // names would cap the description whatever the scan did. A memory bound
        // whose removal changes no output is a bound one silent edit away from
        // being gone, so it needs a fixture only it can explain.
        //
        // Duplicate keys give one: a record of N members carrying a single
        // distinct name never fills the field cap, so `fieldsCapped` can only mean
        // the scan stopped. Legal JSON text, and not a contrivance — documents
        // that repeat a key are exactly the ones this navigator meets in the wild.
        const dup = (members: number): StrideShape => {
            const rec = '{' + new Array(members).fill('"a":1').join(',') + '}';
            const resolver = build(`[${rec}]`, `dup-${members}`);
            return censusOf(resolver, resolver.root());
        };

        const under = dup(CENSUS_SCAN_CAP);
        expect(under.fields.length, 'one distinct name is one field, however often it repeats').toBe(1);
        expect(under.widestMember, 'and every repeat is counted').toBe(CENSUS_SCAN_CAP);
        expect(
            under.fieldsCapped,
            `a record of exactly CENSUS_SCAN_CAP members is scanned whole, so nothing is withheld and the census `
            + 'must not claim otherwise.',
        ).toBe(false);

        const over = dup(CENSUS_SCAN_CAP + 1);
        expect(over.fields.length, 'still one field').toBe(1);
        expect(over.widestMember, 'still counted in full past the cap').toBe(CENSUS_SCAN_CAP + 1);
        expect(
            over.fieldsCapped,
            'one member more and the scan stopped short, which the census must report. False here means the scan '
            + 'read the whole record and the memory bound on CENSUS_SCAN_CAP is not in force.',
        ).toBe(true);
    }, 120_000);

    it('still scores novelty over records wider than the field cap', () => {
        // noveltyOf reaches the same per-member scan through profileOf, so the
        // cap has to leave scoring working rather than merely bounded.
        const shared = Array.from({ length: 200 }, (_, f) => `"s${f}":${f}`).join(',');
        const rows = Array.from({ length: 40 }, () => `{${shared},"tag":"routine"}`);
        rows[17] = `{${shared},"tag":"anomaly","extra":[1,2,3]}`;
        const resolver = build(`[${rows.join(',')}]`, 'wide-novelty');
        const node = resolver.root();
        const shape = censusOf(resolver, node);
        const members = resolver.members(node, 0, node.count);
        const novelty = noveltyOf(resolver, node, members, shape);
        expect(novelty.length, 'every member must still be scored').toBe(rows.length);
        for (const v of novelty) {
            expect(Number.isFinite(v) && v >= 0 && v <= 1, `every novelty score must be finite and in [0,1]; found ${v}`).toBe(true);
        }
        expect(
            ranking(novelty)[0],
            'the one record with a different shape must still rank first for novelty; a cap that truncated the '
            + 'scan into uniformity would score every record alike.',
        ).toBe(17);
    }, 120_000);

    it('does not narrow the width over which novelty can still discriminate', () => {
        // The regression this exists to catch was introduced by the field cap and
        // found by measurement, not by reading: `censusSupport` answers 0 for a
        // name the census does not describe, meaning "inspected the sample and
        // never saw it" — real evidence of rarity. Once the census stops
        // describing names at CENSUS_FIELD_CAP that inference is invalid, and
        // charging the census's population against a gram it never voted on made
        // every member past the 64th score as evidence of its own rarity. It was
        // the same charge in every record, so it discriminated nothing and only
        // grew `structuralRaw` with width, until softBound saturated at 1 and all
        // scores collapsed to equal.
        //
        // Measured on this fixture: the widest record whose one differing member
        // still scored was 1,022 members before the cap existed, 419 with the cap
        // and the old censusSupport, and 1,022 again once an abstaining census
        // stopped being counted as a silent one. The widths below straddle that:
        // 65 is the first past the field cap, 419 is where it broke, 1000 is
        // inside the ceiling that predates all of this.
        //
        // The difference is one of KIND, not of value. `profileOf` grams every
        // member it scans structurally but reads value text only for names the
        // census certified as enumerations, and a name past CENSUS_FIELD_CAP is
        // never certified — so a value-only difference out here would be invisible
        // for a reason that has nothing to do with either cap. Both values are
        // nine bytes, so the records are identical in length too: `Profile.bytes`
        // is a scoring input, and a shorter value would discriminate them by size
        // whatever the scan did.
        for (const width of [65, 419, 1000]) {
            const filler = Array.from({ length: width - 1 }, (_, f) => `"s${String(f).padStart(6, '0')}":${f}`).join(',');
            // Zero-padded names, so the odd member lands last in document order and
            // stays there: the scan reads the document, not a sorted view of it.
            const rows = Array.from({ length: 12 }, () => `{${filler},"tag":"routine"}`);
            rows[5] = `{${filler},"tag":123456789}`;
            const resolver = build(`[${rows.join(',')}]`, `kind-odd-${width}`);
            const node = resolver.root();
            const members = resolver.members(node, 0, node.count);
            const shape = censusOf(resolver, node);
            const novelty = noveltyOf(resolver, node, members, shape);

            expect(shape.fields.length, `a ${width}-member record must still cap at CENSUS_FIELD_CAP fields`)
                .toBe(Math.min(width, CENSUS_FIELD_CAP));
            expect(
                new Set(novelty).size,
                `in ${width}-member records, the one holding a number where its eleven siblings hold a string must `
                + 'score differently. A single distinct score means width alone saturated the scorer.',
            ).toBeGreaterThan(1);
            expect(
                ranking(novelty)[0],
                `and in ${width}-member records that record must be the novel one`,
            ).toBe(5);
        }
    }, 300_000);
});

describe('cost', () => {
    it('censuses and scores a 50,000-record array', () => {
        const { resolver, node, count } = big();
        resolver.reset();

        const t0 = performance.now();
        const shape: StrideShape = censusOf(resolver, node);
        const t1 = performance.now();
        const censusTouched = resolver.touched;
        const members = resolver.members(node, 0, node.count);
        const t2 = performance.now();
        const novelty = noveltyOf(resolver, node, members, shape);
        const t3 = performance.now();

        console.log(`[timing] ${count} records: census ${(t1 - t0).toFixed(1)} ms (${censusTouched} members touched), `
            + `members() ${(t2 - t1).toFixed(1)} ms, novelty over all ${count} ${(t3 - t2).toFixed(1)} ms, `
            + `census+novelty ${((t1 - t0) + (t3 - t2)).toFixed(1)} ms`);

        expect(novelty.length, 'every member must be scored').toBe(count);
        for (const v of novelty) {
            expect(v >= 0 && v <= 1, `every novelty score must land in [0,1]; found ${v}`).toBe(true);
        }
    }, 300_000);
});
