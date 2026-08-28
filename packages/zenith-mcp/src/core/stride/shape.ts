// ---------------------------------------------------------------------------
// core/stride/shape.ts — the shape of a container, and what breaks it
//
// A 600 MB document is usually one array of a million structurally identical
// records. Two facts follow, and this module produces both.
//
//   1. THE SHAPE FITS IN A FEW HUNDRED CHARACTERS. One schema, the members that
//      never vary, the members that do, with cardinalities. An agent told this
//      does not have to page through the array to learn what is in it, so the
//      census is deliberately cheap: it is bounded by the SAMPLE, never by the
//      container. A million-element array and a thousand-element array cost the
//      same census.
//
//   2. THE INTERESTING RECORD IS THE ONE THAT BREAKS THE SHAPE. Among a million
//      boilerplate records the one worth surfacing has an unexpected member, an
//      unexpected type at a known member, or a never-seen value at an otherwise
//      low-cardinality member. `noveltyOf` scores exactly those three things and
//      deliberately refuses to score a fourth that looks like them: a unique
//      value in a high-cardinality member such as an id.
//
// Three design choices here are load-bearing and each is written up where it is
// made, because each has an obvious alternative that quietly does nothing:
//
//   - PRIME STRIDE, not a round one. Machine-generated data is periodic. A
//     stride of 100 over records that rotate through 10 shard ids samples one
//     shard forever and reports a 10-valued member as constant.
//   - softBound, not Math.min(1, x). Clamping flattens everything above the
//     clamp onto one plateau, which destroys precisely the top-end variance a
//     cutoff detector needs to find a cutoff.
//   - PERCENTILE calibration, not min-max. One pathological record — a 40 MB
//     embedded blob — compresses every other score toward zero under min-max,
//     and the cutoff then finds nothing.
//
// Nothing in this module deletes, hides, or drops anything. `redundancyOf`
// marks a member as PREDICTED BY another member; it stays addressable by
// pointer and retrievable by span, exactly like every other member. This is a
// navigator (I1, I4): omission is always addressed, never silent.
// ---------------------------------------------------------------------------

import {
    StrideError, STRIDE_KEY, SHAPE_SAMPLE, DISTINCT_CAP, FIELD_SAMPLES,
    type StrideField, type StrideKind, type StrideNode, type StrideShape,
} from './types.js';
import type { StrideSource } from './source.js';
import { scanStructure, KIND_NAMES, K_OBJECT } from './scan.js';
import { decodeJsonString } from './index.js';
import type { Member, Resolver } from './resolve.js';

// ── Tuning constants ──────────────────────────────────────────────────────
// Each value is stated with the arithmetic behind it. A constant whose reason
// is unwritten is a constant nobody can safely retune.

/**
 * The reserved field name for a member that HAS no name: an array element, or
 * any member that is not an object and therefore contributes no member names of
 * its own. Built from `STRIDE_KEY` so the reservation is structural rather than
 * a magic string — I1 already reserves that prefix, so this can never be
 * confused with a member name the document actually carries.
 */
export const ELEMENT_FIELD = `${STRIDE_KEY}:element`;

/**
 * The sample is split head / interior / tail as 1:2:1. Head and tail get a
 * quarter each because that is where malformed and late-appended records live —
 * the first records were written by a different code path than the millionth,
 * and the last were appended after the schema changed. The interior gets the
 * remaining half because it is the overwhelming majority of the population and
 * a census that under-weights it describes the edges of the collection rather
 * than the collection.
 */
const HEAD_TAIL_DIVISOR = 4;

/**
 * A key-set must cover this fraction of the sample for the container to be
 * called homogeneous. At SHAPE_SAMPLE = 256 the standard error on a proportion
 * is sqrt(p(1-p)/256) = 0.029 at p = 0.7, so 0.7 sits more than six standard
 * errors above an even 50/50 split: sampling noise cannot trip it. It is also
 * loose enough to tolerate a realistic minority variant — an optional member
 * present in up to 30% of records — without declaring the collection
 * irregular, which is the judgement an agent actually needs.
 */
const HOMOGENEITY_DOMINANCE = 0.7;

/**
 * A value longer than this is never read in full. 4 KiB is the largest value
 * that can be compared byte-for-byte without the comparison becoming the cost
 * of the census: at SHAPE_SAMPLE = 256 members and ~10 members per record it
 * bounds one census at ~10 MiB of reads, and it keeps a 40 MB embedded blob
 * from being pulled into the heap to be used as a Set key. A field holding any
 * such value reports `exact: false`, because a cardinality over values we
 * refused to read is a cardinality we did not measure.
 */
const VALUE_READ_BYTES = 4096;

/**
 * Characters of a value kept as a census sample. FIELD_SAMPLES = 3 samples at
 * 64 characters is 192 characters of a census that is supposed to be a few
 * hundred characters in total; and a value longer than 64 characters tells an
 * agent nothing that a length marker does not. Longer values are replaced by a
 * `[TRUNCATED: n bytes]` marker string, which is the one sanctioned form for
 * STRIDE metadata appearing in a payload position (I1, I4).
 */
const SAMPLE_TEXT_CHARS = 64;

/**
 * A member is an ENUMERATION — and therefore a member where a never-before-seen
 * value is real evidence — only up to this measured cardinality.
 *
 * The arithmetic: with a 256-member sample and d distinct values, each value is
 * expected 256/d times. At d = 16 a genuine value is missed by the sample with
 * probability (1 - 1/16)^256 = 6.8e-8, so "unseen" means "absent". At d = 64,
 * the DISTINCT_CAP, that probability is (1 - 1/64)^256 = 1.8% — which over a
 * million records is roughly 18,000 records flagged for holding a value that
 * was simply unlucky in the sample. 16 is where the signal stops being noise.
 */
const VALUE_GRAM_MAX_DISTINCT = 16;

/**
 * Surprisal is measured in nats and divided by this, so a gram carried by fewer
 * than one sibling in a thousand contributes at least 1.0 to the accumulator.
 * softBound(1) = 0.63, softBound(2) = 0.86, softBound(3) = 0.95 — so a record
 * with two independent one-in-a-thousand grams still outranks a record with
 * one, which is exactly the ordering `Math.min(1, raw)` would throw away.
 */
const SURPRISAL_SCALE = Math.log(1000);

/**
 * Structure and value are weighted 0.6 / 0.4. Structure leads because an
 * unexpected member or an unexpected type is a fact about the record that
 * cannot be a data-entry variation, while an unexpected value is sometimes just
 * a new enum arm; both catch things the other cannot, so neither is dropped.
 */
const W_STRUCTURAL = 0.6;
const W_VALUE = 0.4;

/**
 * Size buckets per octave in a redundancy signature. Quarter-octave steps are
 * 2^(1/4) = 19% apart, which separates a 100-byte record from a 130-byte one
 * (buckets 26 and 28) while keeping a 100-byte and a 105-byte record together
 * (both bucket 26). A coarser bucket over-collapses; a raw byte count
 * under-collapses on nothing more than a digit's difference in an id.
 */
const SIZE_BUCKETS_PER_OCTAVE = 4;

/**
 * At most this fraction of a population is protected from collapse by novelty.
 * Without a ceiling a flat novelty curve would veto everything and redundancy
 * detection would silently do nothing at all.
 */
const NOVELTY_VETO_FRACTION = 0.10;

/**
 * The rare-value veto's rarity test: a value carried by at most
 * `max(2, min(RARE_DF_CAP, floor(n * RARE_DF_FRACTION)))` of n members is rare
 * enough that the member holding it must survive collapse.
 *
 * The two-sided form is load-bearing in both directions. Without the FRACTION a
 * value carried by 10 of 20 members would count as rare and the veto would keep
 * everything. Without the CAP the threshold scales with the corpus, which is the
 * measured failure the mechanism this was extracted from had to fix: at 5,000
 * candidates a `floor(n * 0.1)` threshold called anything under 500 occurrences
 * rare, the rare set flooded, "every line looks maximally unique", and the
 * variance the signal exists to contribute vanished. A value carried by 10 of a
 * million records is rare; one carried by 10 of 20 is the population.
 *
 * Note what this is NOT: `df === 1`. A gram unique to one member makes that
 * member's SIGNATURE unique, so the keep-first rule already keeps it and a veto
 * on uniqueness can never change an outcome. The reachable case — and the one
 * worth vetoing — is a handful of members sharing one rare value, which share a
 * signature and would otherwise collapse into each other.
 */
const RARE_DF_FRACTION = 0.02;
const RARE_DF_CAP = 10;

/**
 * Above this length a score list is a CORPUS CURVE, not a candidate list, and
 * the chord branch runs. 512 is one doubling above SHAPE_SAMPLE: a list a
 * caller assembled by hand, by paging, or from a search result page falls
 * inside it, while anything produced by scanning a collection falls outside.
 * The distinction is semantic, not just numerical — see `knee`.
 */
const CLIFF_MAX_N = 512;

/**
 * A single adjacent gap must cross this fraction of the whole score range to
 * count as a cliff. On a smooth curve of n points the mean adjacent gap is
 * range/(n-1): at n = 512 that is 0.2% of the range, so 25% is 128x the mean
 * and unreachable without a genuine discontinuity.
 */
const CLIFF_MIN_FRACTION = 0.25;

/**
 * Weighted-gap firing floor: `relGap * (absGap / range) >= 0.05`.
 *
 * The floor is only meaningful because `relGap` is measured against the score
 * ABOVE the gap, which bounds the whole product into [0, 1]: on the reference
 * cliff [9.2, 9.1, 8.9, 0.4, 0.3] the winning gap scores relGap 8.5/8.9 = 0.955
 * times absGap/range 8.5/8.9 = 0.955, i.e. 0.91, and 0.05 is a twentieth of a
 * perfect cliff. Measured against the score BELOW the gap instead, a drop toward
 * zero drives relGap unbounded — the same cliff scores 8.5/0.4 = 21.25 times
 * 0.955 = 20.3 — and 0.05 stops being a twentieth of anything.
 */
const GAP_FIRE = 0.05;

/**
 * Chord-deviation firing floor. On a perfectly linear descent the deviation is
 * 0 everywhere; the noise floor for an empirical curve of n points is the
 * Kolmogorov-Smirnov statistic, whose 99.9% bound is 1.95/sqrt(n) — 1.95% at
 * the ten-thousand-point scale this branch exists for. 0.02 is that bound.
 */
const CHORD_FIRE = 0.02;

/** Below this, two doubles are the same number for our purposes. */
const EPS = 1e-12;

// ── censusOf ──────────────────────────────────────────────────────────────

/** Options for `censusOf`. */
export interface CensusOptions {
    /**
     * Ceiling on members inspected. Clamped INTO [1, SHAPE_SAMPLE] — a caller
     * can ask for a cheaper census, never a more expensive one, because the
     * bound is what makes the census affordable on a million-element array.
     */
    readonly sample?: number;
}

/** Everything accumulated about one member name while sampling. */
interface Tally {
    readonly kinds: Map<StrideKind, number>;
    /** Members carrying this name at least once. */
    present: number;
    /** Distinct value identities, never grown past DISTINCT_CAP. */
    readonly distinct: Set<string>;
    /** The cap was reached: more distinct values exist than were counted. */
    overflow: boolean;
    /** Some value was too large to read, so its identity was never measured. */
    inexact: boolean;
    readonly samples: string[];
    readonly sampleSeen: Set<string>;
    /** First value identity seen, and whether every later one matched it. */
    first: string | null;
    constantHolds: boolean;
    /** Display form of the constant, clipped to SAMPLE_TEXT_CHARS. */
    constantText: string | null;
}

/**
 * Sample a container's members and describe it.
 *
 * Sampling is head + tail + prime-strided interior, capped at SHAPE_SAMPLE
 * members. The cost is bounded by the sample and not by the container: this
 * function requests exactly `shape.sampled` members from the resolver however
 * large the container is. (The resolver's own checkpoint re-scan behind each
 * request is bounded separately, by the index stride — see index.ts.)
 *
 * `fields` describes the shape of the container's VALUES, one level down, not
 * the container's own key-set. That is the reading the collections STRIDE exists
 * for need: a 600 MB array of records, or a 600 MB object keyed by id, both have
 * one answer worth a few hundred characters and it is the shape of a record. A
 * consequence worth knowing: a small flat object of scalars reports one field
 * per member at presence 1/n and `homogeneous: false`, because no key-set
 * dominates when every member has a key-set of its own. That is a true statement
 * about `{"a":1,"b":2}` and not a useful one — a container that small is read
 * directly rather than censused.
 */
export function censusOf(resolver: Resolver, node: StrideNode, opts?: CensusOptions): StrideShape {
    if (node.kind !== 'object' && node.kind !== 'array') {
        throw new StrideError(
            'not_a_container',
            `${node.pointer === '' ? 'The document' : node.pointer} is a ${node.kind}; a shape census describes a container.`,
            'Census the parent container instead, or read this value directly with mode "scalar".',
        );
    }

    const asked = opts?.sample;
    const budget = typeof asked === 'number' && Number.isFinite(asked)
        ? Math.max(1, Math.min(SHAPE_SAMPLE, Math.floor(asked)))
        : SHAPE_SAMPLE;

    const total = node.count;
    const picks = samplePositions(resolver, node, total, budget);

    const source = resolver.source;
    const tallies = new Map<string, Tally>();
    const keySets = new Map<string, number>();
    let sampled = 0;
    let byteSum = 0;

    for (const member of picks) {
        sampled++;
        byteSum += member.end - member.start;
        const names = new Set<string>();
        // The census must read every value: distinct counts and sample values
        // are the whole point of it, so there is no cheaper predicate here.
        for (const obs of observe(source, member, alwaysWanted)) {
            const tally = tallyFor(tallies, obs.name);
            tally.kinds.set(obs.kind, (tally.kinds.get(obs.kind) ?? 0) + 1);
            // Presence counts MEMBERS, not observations: a document may repeat a
            // member name inside one object, and that must not read as 200%.
            if (!names.has(obs.name)) { names.add(obs.name); tally.present++; }
            absorbValue(tally, obs);
        }
        const keySet = [...names].sort().join('\u0000');
        keySets.set(keySet, (keySets.get(keySet) ?? 0) + 1);
    }

    let dominant = 0;
    for (const count of keySets.values()) if (count > dominant) dominant = count;

    const fields: StrideField[] = [];
    for (const [key, tally] of tallies) fields.push(finishField(key, tally, sampled));
    // Most-present first: the members that define the schema come before the
    // optional ones. Array#sort is stable, so ties keep first-seen document
    // order, which is itself information about the record layout.
    fields.sort((a, b) => b.presence - a.presence);

    return {
        pointer: node.pointer,
        kind: node.kind,
        total,
        sampled,
        // An empty container is trivially homogeneous: there is no variation to
        // report, and `false` would tell the caller the collection is irregular
        // when it is merely empty.
        homogeneous: sampled === 0 ? true : dominant / sampled >= HOMOGENEITY_DOMINANCE,
        fields,
        meanBytes: sampled === 0 ? 0 : Math.round((byteSum / sampled) * 10) / 10,
    };
}

/**
 * The sampled members: head, tail, and a prime-strided walk of the interior.
 *
 * The stride is the smallest PRIME at or above the ideal spacing, never the
 * ideal spacing itself. Machine-generated records are periodic — a shard id
 * rotating every 10 records, a batch marker every 100 — and a round stride that
 * shares a factor with the period samples the same phase forever, which reports
 * a varying member as constant. A prime p and a period q have gcd(p, q) = 1
 * unless q is a multiple of p, so the sampled positions sweep every residue
 * class mod q instead of locking onto one.
 */
function samplePositions(resolver: Resolver, node: StrideNode, total: number, budget: number): Member[] {
    if (total <= 0) return [];
    if (total <= budget) {
        // Small enough to census exactly. No sampling error at all, so there is
        // nothing for a stride to get wrong.
        return resolver.members(node, 0, total);
    }

    // The head is rounded UP to one member — a census that samples no head is
    // blind to exactly the records the head exists to catch. The tail then takes
    // what is left of the budget rather than matching the head unconditionally:
    // at budget 1, head 1 plus tail 1 would inspect two members for a caller who
    // asked for one, and `sampled` would report a budget that was overrun.
    const head = Math.max(1, Math.floor(budget / HEAD_TAIL_DIVISOR));
    const tail = Math.min(head, budget - head);
    const interiorWant = budget - head - tail;
    const out: Member[] = resolver.members(node, 0, head);

    if (interiorWant > 0) {
        const from = head;
        const to = total - tail;
        const span = to - from;
        const ideal = Math.floor(span / interiorWant);
        // At ideal <= 1 the interior is barely wider than the budget, so a
        // contiguous walk already covers every residue class; introducing a
        // stride of 2 there would be the very aliasing the prime avoids.
        const stride = ideal <= 1 ? 1 : nextPrimeAtLeast(Math.max(3, ideal));
        let taken = 0;
        for (let pos = from; pos < to && taken < interiorWant; pos += stride) {
            // One request per position: `members` seeks the checkpoint at or
            // before it, so a strided read costs a bounded re-scan, not a walk
            // from element zero.
            for (const m of resolver.members(node, pos, 1)) out.push(m);
            taken++;
        }
        // Rounding the ideal spacing UP to a prime can leave a few of the
        // interior budget unspent. Spending the remainder would need a second
        // stride, and a second stride's alignment with the first is exactly the
        // periodicity the prime was chosen to avoid. `sampled` reports the truth.
    }

    if (tail > 0) for (const m of resolver.members(node, total - tail, tail)) out.push(m);
    return out;
}

function tallyFor(tallies: Map<string, Tally>, name: string): Tally {
    const found = tallies.get(name);
    if (found !== undefined) return found;
    const fresh: Tally = {
        kinds: new Map<StrideKind, number>(),
        present: 0,
        distinct: new Set<string>(),
        overflow: false,
        inexact: false,
        samples: [],
        sampleSeen: new Set<string>(),
        first: null,
        constantHolds: true,
        constantText: null,
    };
    tallies.set(name, fresh);
    return fresh;
}

/** Fold one observed value into a member name's tally. */
function absorbValue(tally: Tally, obs: Observation): void {
    const display = obs.text !== null && obs.text.length <= SAMPLE_TEXT_CHARS
        ? obs.text
        : JSON.stringify(`[TRUNCATED: ${obs.bytes} bytes]`);

    if (obs.text === null) {
        // We declined to read it, so we cannot claim to know whether it equals
        // anything else. Both the cardinality and the constancy claim lose their
        // footing here, and saying so is the whole point of `exact`.
        tally.inexact = true;
        tally.constantHolds = false;
    } else {
        if (!tally.distinct.has(obs.text)) {
            if (tally.distinct.size < DISTINCT_CAP) tally.distinct.add(obs.text);
            else tally.overflow = true;
        }
        if (tally.first === null) { tally.first = obs.text; tally.constantText = display; }
        else if (tally.first !== obs.text) tally.constantHolds = false;
    }

    if (tally.samples.length < FIELD_SAMPLES && !tally.sampleSeen.has(display)) {
        tally.sampleSeen.add(display);
        tally.samples.push(display);
    }
}

function finishField(key: string, tally: Tally, sampled: number): StrideField {
    const kinds = [...tally.kinds.entries()]
        .sort((a, b) => b[1] - a[1])
        .map((entry) => entry[0]);
    // Presence is rounded to three decimals: 1/256 = 0.0039 is the finest
    // resolution the sample can carry, so 0.0005 rounding discards nothing that
    // was ever measured, and it keeps the serialised census short.
    const presence = sampled === 0 ? 0 : Math.round((tally.present / sampled) * 1000) / 1000;
    const exact = !tally.overflow && !tally.inexact;
    const base = {
        key,
        kinds,
        presence,
        distinct: tally.distinct.size,
        exact,
        samples: tally.samples,
    };
    // `exactOptionalPropertyTypes` is on: an absent constant is an absent
    // property, never a property holding undefined.
    return tally.constantHolds && tally.constantText !== null
        ? { ...base, constant: tally.constantText }
        : base;
}

// ── reading one member ────────────────────────────────────────────────────

/** One (member name, value) pair observed inside one member of the container. */
interface Observation {
    readonly name: string;
    readonly kind: StrideKind;
    /** Byte length of the value. */
    readonly bytes: number;
    /**
     * Verbatim JSON text of the value, or null when it was longer than
     * VALUE_READ_BYTES or the caller did not ask for it.
     */
    readonly text: string | null;
}

const alwaysWanted = (): boolean => true;

/**
 * The (member name, value) pairs one member contributes to the census.
 *
 * Descends EXACTLY one level, and only into an object. An array member has no
 * member names to contribute, so it is reported as one value of kind 'array'
 * under its own name — which is right for `tags: ["a","b","c"]` and also right
 * for an array-of-arrays, where the rows are the values.
 *
 * The record's own span is scanned directly rather than routed back through
 * `Resolver.members`. resolve.ts calls this the INTERIOR route and notes it is
 * the cheap case: a record is a few hundred bytes. Going through the resolver
 * would additionally allocate a pointer per record and push it through the
 * resolver's bounded caches, evicting the pointers an agent is actually
 * navigating with, to learn nothing the span scan does not already give us.
 */
function observe(source: StrideSource, member: Member, wantText: (name: string) => boolean): Observation[] {
    const out: Observation[] = [];
    if (member.kind !== 'object') {
        const name = member.key ?? ELEMENT_FIELD;
        out.push(read(source, name, member.kind, member.start, member.end, wantText(name)));
        return out;
    }

    let keyStart = -1;
    let keyEnd = -1;
    const take = (kind: StrideKind, start: number, end: number): void => {
        // A value with no preceding member name cannot occur in a well-formed
        // object; if the scanner hands us one the document is malformed there
        // and inventing a name for it would be inventing structure (I1).
        if (keyStart < 0) return;
        const name = decodeJsonString(source.slice(keyStart, keyEnd));
        keyStart = -1;
        out.push(read(source, name, kind, start, end, wantText(name)));
    };

    scanStructure(source, member.start + 1, member.end, {
        enter() { /* the span is taken on exit, when the end is known */ },
        exit(kind, start, end, d) { if (d === 1) take(kind === K_OBJECT ? 'object' : 'array', start, end); },
        key(start, end, d) { if (d === 1) { keyStart = start; keyEnd = end; } },
        scalar(kind, start, end, d) { if (d === 1) take(KIND_NAMES[kind] ?? 'null', start, end); },
    }, 0);

    return out;
}

function read(
    source: StrideSource, name: string, kind: StrideKind,
    start: number, end: number, wantText: boolean,
): Observation {
    const bytes = end - start;
    const text = wantText && bytes <= VALUE_READ_BYTES ? source.slice(start, end).toString('utf8') : null;
    return { name, kind, bytes, text };
}

// ── grams ─────────────────────────────────────────────────────────────────
//
// Every gram is length-prefixed on its first component. A member name can
// legally contain any character including the separators used here, so without
// the length prefix a crafted document could make two different grams collide
// and hide a record by making it look like its neighbour. The prefix makes the
// encoding injective for the cost of a few characters.

function structuralGram(name: string, kind: StrideKind): string {
    return `${name.length}\u0000${name}\u0000k\u0000${kind}`;
}

function valueGram(name: string, text: string): string {
    return `${name.length}\u0000${name}\u0000v\u0000${text}`;
}

function keySetGram(names: readonly string[]): string {
    return names.map((n) => `${n.length}\u0000${n}`).join('\u0000');
}

/** Everything one member contributes to scoring, read once and reused. */
interface Profile {
    /** Sorted, de-duplicated (name, kind) grams. */
    readonly structural: readonly string[];
    /** Sorted, de-duplicated (name, value) grams, low-cardinality members only. */
    readonly values: readonly string[];
    readonly keySet: string;
    readonly fieldCount: number;
    readonly bytes: number;
}

function profileOf(source: StrideSource, member: Member, eligible: ReadonlySet<string>): Profile {
    const structural = new Set<string>();
    const values = new Set<string>();
    const names = new Set<string>();
    // Value text is read ONLY for members the census certified as enumerations.
    // On a ten-member record with three enumerated members that is three slices
    // instead of ten, and it is what keeps scoring a large page affordable.
    for (const obs of observe(source, member, (name) => eligible.has(name))) {
        names.add(obs.name);
        structural.add(structuralGram(obs.name, obs.kind));
        if (obs.text !== null) values.add(valueGram(obs.name, obs.text));
    }
    return {
        structural: [...structural].sort(),
        values: [...values].sort(),
        keySet: keySetGram([...names].sort()),
        fieldCount: names.size,
        bytes: member.end - member.start,
    };
}

/** Document frequency of every gram across a population of profiles. */
interface Population {
    readonly df: Map<string, number>;
    readonly n: number;
}

function tally(profiles: readonly Profile[]): Population {
    const df = new Map<string, number>();
    const bump = (g: string): void => { df.set(g, (df.get(g) ?? 0) + 1); };
    for (const p of profiles) {
        for (const g of p.structural) bump(g);
        for (const g of p.values) bump(g);
        bump(p.keySet);
    }
    return { df, n: profiles.length };
}

/** The census fields whose measured cardinality makes value grams meaningful. */
function eligibleFields(census: StrideShape | null): ReadonlySet<string> {
    const out = new Set<string>();
    if (census === null) return out;
    for (const f of census.fields) {
        // `exact` is not optional here: a cardinality that hit DISTINCT_CAP is a
        // cardinality we did not measure, and gating on an unmeasured number is
        // how an id member ends up scoring every record in the document.
        if (f.exact && f.distinct <= VALUE_GRAM_MAX_DISTINCT) out.add(f.key);
    }
    return out;
}

/**
 * Surprisal of a gram carried by `hits` of `pop` members, in units where 1.0 is
 * one-in-a-thousand. `-ln(p)` is self-scaling in the population: a gram unique
 * among 5 supplied members scores ln(5)/ln(1000) = 0.23, while a gram unique
 * among 20,000 scores 1.44. A small candidate page therefore cannot manufacture
 * a confident anomaly out of having few siblings, which is the failure mode a
 * fixed rarity threshold would have.
 */
function surprisal(hits: number, pop: number): number {
    if (pop <= 0) return 0;
    // `hits` is at least 1 for any gram taken from a member of this population,
    // since that member's own contribution is in `df`. The guard is for a caller
    // that hands in a support count from elsewhere; -ln(0) is not a score.
    const p = Math.min(1, (hits <= 0 ? 1 : hits) / pop);
    return -Math.log(p) / SURPRISAL_SCALE;
}

/**
 * Bound an unbounded accumulator into [0, 1) without a plateau.
 * `Math.min(1, raw)` maps every raw >= 1 onto the single value 1, so a record
 * with four unique members and a record with one become indistinguishable — and
 * the top of the distribution is exactly where a cutoff detector has to find
 * its structure. `1 - e^-raw` is strictly increasing everywhere.
 */
function softBound(raw: number): number {
    return 1 - Math.exp(-raw);
}

// ── noveltyOf ─────────────────────────────────────────────────────────────

/**
 * Score each supplied member in [0,1] by how much it departs from its siblings.
 *
 * Two levels, because they catch different things:
 *
 *   STRUCTURAL (0.6) — (member name, value kind) pairs plus the member-name set.
 *   A record whose every structural gram is shared by its siblings scores near
 *   zero. A record with an unexpected member, or a known member holding an
 *   unexpected type, scores high.
 *
 *   VALUE (0.4) — (member name, exact value) pairs, but ONLY for members the
 *   census measured as low-cardinality. A never-seen value in an otherwise
 *   3-valued member is an anomaly; a unique value in an id member is not, and
 *   scoring it would make every record in the document equally novel, which is
 *   the same as scoring nothing.
 *
 * The census is the prior and the supplied members are the evidence, combined
 * additively — which is what lets this score a page of five search hits against
 * what a 256-member census knows about the whole collection. The two levels use
 * the prior differently, and the asymmetry is deliberate: the census measured
 * presence and kind over its whole sample, so its silence about a member name is
 * evidence; it kept only FIELD_SAMPLES values per member, so its silence about a
 * VALUE is not evidence and is not used.
 */
export function noveltyOf(
    resolver: Resolver,
    node: StrideNode,
    members: readonly Member[],
    census: StrideShape,
): Float64Array {
    // A census taken over a different container is not evidence about these
    // members. Applying it anyway would silently score against the wrong
    // schema, so it is dropped and only local evidence is used.
    const prior = census.pointer === node.pointer ? census : null;
    const eligible = eligibleFields(prior);
    const profiles = members.map((m) => profileOf(resolver.source, m, eligible));
    return scoreProfiles(profiles, tally(profiles), prior);
}

function scoreProfiles(
    profiles: readonly Profile[],
    pop: Population,
    census: StrideShape | null,
): Float64Array {
    const n = pop.n;
    const censusN = census === null ? 0 : census.sampled;
    const byKey = new Map<string, StrideField>();
    if (census !== null) for (const f of census.fields) byKey.set(f.key, f);

    // The census records member names and kinds but not key-SETS. It can still
    // certify one: when it says a single key-set dominates, the members present
    // in at least that share of the sample ARE that key-set. When it does not,
    // the census has nothing to say here and its population is left out rather
    // than counted as silence.
    let dominantKeySet: string | null = null;
    if (census !== null && census.homogeneous) {
        const names = census.fields
            .filter((f) => f.presence >= HOMOGENEITY_DOMINANCE)
            .map((f) => f.key)
            .sort();
        dominantKeySet = keySetGram(names);
    }
    const keySetPop = dominantKeySet === null ? n : n + censusN;
    const keySetSupport = Math.round(HOMOGENEITY_DOMINANCE * censusN);

    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const p = profiles[i];
        if (p === undefined) continue;          // unreachable: i indexes profiles

        let structuralRaw = 0;
        for (const g of p.structural) {
            structuralRaw += surprisal((pop.df.get(g) ?? 0) + censusSupport(g, byKey, censusN), n + censusN);
        }
        structuralRaw += surprisal(
            (pop.df.get(p.keySet) ?? 0) + (p.keySet === dominantKeySet ? keySetSupport : 0),
            keySetPop,
        );

        let valueRaw = 0;
        for (const g of p.values) valueRaw += surprisal(pop.df.get(g) ?? 0, n);

        raw[i] = W_STRUCTURAL * softBound(structuralRaw) + W_VALUE * softBound(valueRaw);
    }

    return percentile(raw);
}

/**
 * How many of the census's sampled members support a (name, kind) gram.
 *
 * StrideField keeps kinds ordered by frequency but not the counts, so this is a
 * bound rather than a count, and it is chosen to err in the safe direction at
 * each branch:
 *   - name absent from the census: 0. The census inspected `sampled` members and
 *     never saw this name, which is real evidence of rarity.
 *   - dominant kind: presence x sampled. An over-estimate when the member holds
 *     several kinds, which SUPPRESSES novelty for the ordinary case.
 *   - a non-dominant kind the census did see: 1, the only number we can prove.
 *     This inflates novelty for a minority kind — which is the requirement, "a
 *     known member holding an unexpected type scores high" — and the local
 *     document frequency corrects it as soon as there is enough local evidence.
 *   - a kind the census never saw at this name: 0.
 */
function censusSupport(gram: string, byKey: Map<string, StrideField>, censusN: number): number {
    if (censusN === 0) return 0;
    const cut = gram.indexOf('\u0000');
    if (cut < 0) return 0;
    const nameLen = Number(gram.slice(0, cut));
    if (!Number.isFinite(nameLen)) return 0;
    const name = gram.slice(cut + 1, cut + 1 + nameLen);
    const field = byKey.get(name);
    if (field === undefined) return 0;
    const kind = gram.slice(cut + 1 + nameLen + 3);
    const dominant = field.kinds[0];
    if (dominant === kind) return Math.round(field.presence * censusN);
    // `some` rather than `includes`: the gram's kind arrives as a string sliced
    // out of the gram, and asserting it into StrideKind to satisfy `includes`
    // would be claiming a type nothing checked.
    return field.kinds.some((k) => k === kind) ? 1 : 0;
}

/**
 * Percentile (rank) calibration onto [0,1].
 *
 * NOT min-max and NOT divide-by-max. One pathological record — a 40 MB embedded
 * blob, a value repeated a million times — takes the maximum on its own, and
 * under either of those every other score is divided by it and compressed
 * toward zero, so the cutoff detector downstream finds nothing and the second,
 * third and fourth genuinely interesting records are lost behind the first.
 * Rank calibration is invariant to any monotone distortion of the raw scale, so
 * one outlier moves one rank and nothing else.
 *
 * Ties share the rank of the first member of their group, which is the part
 * that makes this work rather than backfire: 19,998 identical boilerplate
 * records must all calibrate to 0, not spread out across [0,1] in the order the
 * scanner happened to reach them.
 */
function percentile(raw: Float64Array): Float64Array {
    const n = raw.length;
    const out = new Float64Array(n);
    if (n <= 1) return out;                     // nothing to be unusual against

    // +Infinity for an out-of-range read: it sorts above every real score and
    // cannot be produced here, since `order` is built from 0..n-1.
    const rawAt = (i: number): number => raw[i] ?? Number.POSITIVE_INFINITY;

    const order: number[] = new Array<number>(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => rawAt(a) - rawAt(b));

    let rank = 0;
    let prev = Number.NaN;
    let prevShare = 0;
    for (const idx of order) {
        const v = rawAt(idx);
        const share = v === prev ? prevShare : rank / (n - 1);
        out[idx] = share;
        prev = v;
        prevShare = share;
        rank++;
    }
    return out;
}

// ── redundancyOf ──────────────────────────────────────────────────────────

/** What `redundancyOf` returns. Indices are positions in the `members` array. */
export interface RedundancyReport {
    /** Members to show, in descending novelty order. */
    readonly representative: number[];
    /**
     * Members whose content is PREDICTED by an already-listed representative,
     * in the same walk order. Never dropped, never deleted — see below.
     */
    readonly redundant: number[];
    /** The signature of each member, index-aligned with `members`. */
    readonly signatures: string[];
}

/**
 * Collapse boilerplate honestly.
 *
 * `redundant` NEVER MEANS DROPPED. This is a navigator: a redundant member is
 * one whose content is predicted by a member already shown, and it keeps its
 * pointer, its span, its cursor and its retrievability, exactly like every
 * other member. Nothing here deletes anything, and a caller that renders a
 * collapse must address it (I4) rather than let it vanish.
 *
 * The signature has four channels because a coarse signature over-collapses,
 * and over-collapsing is how the one record worth reading disappears into a
 * count: the structural grams (the schema), the member count, a size bucket,
 * and the member's RAREST value as a de-collision channel. The rarest-value
 * channel is measured only over enumerated members for the same reason value
 * grams are: with an id member included every record would carry a unique rare
 * value and nothing would ever collapse. The measured failure this guards
 * against is 90% of a population flagged redundant by a signature that carried
 * the schema and nothing else.
 *
 * Two vetoes then override the keep-first rule, and each covers a case the other
 * cannot:
 *   - RARE VALUE. A member whose rarest value is carried by at most
 *     `rareCeiling` siblings is kept even when an earlier member already claimed
 *     its signature. This is the only rule that can keep the SECOND member of a
 *     rare pair: members sharing one rare value share a signature by
 *     construction, so keep-first would show one of them and predict the other.
 *   - HIGHEST NOVELTY. The top of the novelty order is kept whatever its
 *     signature, cut by this module's own `knee` rather than a magic number and
 *     capped at NOVELTY_VETO_FRACTION so a flat curve cannot veto everything and
 *     turn collapse into a no-op.
 */
export function redundancyOf(
    resolver: Resolver,
    node: StrideNode,
    members: readonly Member[],
    census: StrideShape,
): RedundancyReport {
    const prior = census.pointer === node.pointer ? census : null;
    const eligible = eligibleFields(prior);
    const profiles = members.map((m) => profileOf(resolver.source, m, eligible));
    const pop = tally(profiles);
    const novelty = scoreProfiles(profiles, pop, prior);
    const n = profiles.length;

    // The rarity ceiling is measured over the population actually supplied, so a
    // page of 20 candidates and a corpus of a million get thresholds that mean
    // the same thing. See RARE_DF_FRACTION for why it is two-sided.
    const rareCeiling = Math.max(2, Math.min(RARE_DF_CAP, Math.floor(n * RARE_DF_FRACTION)));

    const signatures: string[] = new Array<string>(n);
    const rare: boolean[] = new Array<boolean>(n);
    for (let i = 0; i < n; i++) {
        const p = profiles[i];
        if (p === undefined) { signatures[i] = ''; rare[i] = false; continue; }
        let rarest: string | null = null;
        let rarestDf = Number.POSITIVE_INFINITY;
        for (const g of p.values) {
            const df = pop.df.get(g);
            // Every gram here was contributed to `df` by this member, so a miss
            // is impossible. Were one to happen, treating the absent count as 0
            // would read as "rarer than everything" and manufacture a veto out
            // of a bookkeeping failure; skipping it can only suppress one.
            if (df === undefined) continue;
            // Ties broken lexicographically so the signature is deterministic
            // regardless of the order the scanner produced the members in.
            if (df < rarestDf || (df === rarestDf && rarest !== null && g < rarest)) {
                rarestDf = df;
                rarest = g;
            }
        }
        const bucket = p.bytes <= 0 ? 0 : Math.floor(Math.log2(p.bytes) * SIZE_BUCKETS_PER_OCTAVE);
        signatures[i] = `${p.structural.join('\u0001')}\u0002${p.fieldCount}\u0002${bucket}\u0002${rarest ?? ''}`;
        // A value carried by no more than a handful of siblings, in a member
        // whose values are otherwise an enumeration, IS the interesting record —
        // and the members sharing it share a signature, which is exactly the
        // case where the keep-first rule alone would keep only the first of them.
        rare[i] = rarestDf <= rareCeiling;
    }

    const noveltyAt = (i: number): number => novelty[i] ?? Number.NEGATIVE_INFINITY;
    const order: number[] = new Array<number>(n);
    for (let i = 0; i < n; i++) order[i] = i;
    // Descending novelty, ties by ordinal, so the FIRST member of a signature is
    // both the most novel and — among equals — the earliest in the document.
    order.sort((a, b) => (noveltyAt(b) - noveltyAt(a)) || (a - b));

    // The highest-novelty members are protected from collapse, and the count is
    // the module's own adaptive cutoff rather than a magic number. The cap keeps
    // a flat curve from vetoing the whole population and making this a no-op.
    const descending: number[] = new Array<number>(n);
    for (let i = 0; i < n; i++) {
        const at = order[i];
        // `order` holds 0..n-1, so this cannot miss. Reading a miss as member 0's
        // score would splice one member's novelty into another's slot and bend
        // the curve the cutoff is measured from; -Infinity sorts to the bottom
        // of a descending list and can only shrink the protected set.
        descending[i] = at === undefined ? Number.NEGATIVE_INFINITY : noveltyAt(at);
    }
    const protect = n === 0 ? 0 : knee(descending, Math.max(1, Math.ceil(n * NOVELTY_VETO_FRACTION)));

    const seen = new Map<string, number>();
    const representative: number[] = [];
    const redundant: number[] = [];
    for (let pos = 0; pos < n; pos++) {
        const i = order[pos];
        if (i === undefined) continue;          // unreachable: order holds 0..n-1
        const sig = signatures[i] ?? '';
        const first = seen.get(sig);
        const keep = first === undefined || pos < protect || (rare[i] ?? false);
        if (keep) {
            if (first === undefined) seen.set(sig, i);
            representative.push(i);
        } else {
            redundant.push(i);
        }
    }

    return { representative, redundant, signatures };
}

// ── knee ──────────────────────────────────────────────────────────────────

/**
 * The adaptive cutoff: how many of a descending score list are worth returning.
 *
 * TWO detectors, because one detector is silently wrong on half the inputs.
 *
 * WEIGHTED GAP — `relGap * (absGap / range)`, fired at 0.05 — is the right
 * detector for a BOUNDED CANDIDATE LIST WITH A REAL CLIFF: a few hundred search
 * results where matched and unmatched separate cleanly. On [9.2, 9.1, 8.9, 0.4,
 * 0.3, 0.2] the gap at index 2 scores (8.5/8.9) * (8.5/9.0) = 0.90 against
 * 4.9e-4 for its neighbour, and it returns 3.
 *
 * It CANNOT WORK on a dense corpus curve, and the arithmetic says why. On n
 * near-identical records the adjacent gaps are on the order of range/n, so
 * `absGap / range` is about 1/n; at n = 10,000 the whole product is ~1e-4
 * against a 0.05 floor, and mass ties drive `range` itself toward 0. It never
 * fires. What it does instead is fall through to `ceil(sqrt(n))` on every
 * input, which LOOKS like an adaptive cutoff and is a constant.
 *
 * CHORD DEVIATION is the detector for that curve: normalise rank to x in [0,1]
 * and score to y in [0,1] descending, and take the maximum of `(1-x) - y`, the
 * vertical distance from the straight chord between the ends. It measures the
 * BEND of the whole curve rather than any single step, so mass ties and tiny
 * adjacent gaps are exactly what it is built to read.
 *
 * WHICH BRANCH RUNS: the weighted gap, when the list is at most CLIFF_MAX_N
 * (512) long AND its largest single adjacent gap crosses at least
 * CLIFF_MIN_FRACTION (25%) of the total range. Both conditions matter, and the
 * length one is semantic, not just numeric: on a curated candidate list a cliff
 * is a decision boundary ("these matched, those did not"), while on a corpus
 * curve a cliff is one outlier, and answering "1" for a million records because
 * one of them holds a 40 MB blob is not a cutoff, it is a miss.
 *
 * In both branches `ceil(sqrt(n))` is a FLOOR — `max(detected, floor)` — never
 * a fallback masquerading as a detection. `cap` clamps the result from above.
 */
export function knee(sortedDescending: readonly number[], cap: number): number {
    const n = sortedDescending.length;
    if (n === 0) return 0;
    const ceiling = Math.max(1, Math.min(n, Math.floor(cap)));
    const floor = Math.min(ceiling, Math.max(1, Math.ceil(Math.sqrt(n))));
    if (n < 3) return floor;

    // NaN for an out-of-range read. It propagates into every comparison as
    // false, so an impossible read can only SUPPRESS a detection — it can never
    // invent one, and never produces a cutoff that was not measured.
    const s = (i: number): number => sortedDescending[i] ?? Number.NaN;

    const range = s(0) - s(n - 1);
    if (!(range > EPS)) {
        // Every score is the same number. No cutoff exists anywhere in this
        // list, and claiming one would be inventing structure.
        return floor;
    }

    let maxGap = 0;
    for (let i = 0; i + 1 < n; i++) {
        const gap = s(i) - s(i + 1);
        if (gap > maxGap) maxGap = gap;
    }

    const detected = n <= CLIFF_MAX_N && maxGap / range >= CLIFF_MIN_FRACTION
        ? weightedGap(s, n, range)
        : chordDeviation(s, n, range);

    return Math.min(ceiling, Math.max(floor, detected));
}

/** The weighted-gap cutoff, or 0 when nothing clears the firing floor. */
function weightedGap(s: (i: number) => number, n: number, range: number): number {
    // Skip the first gap when there is more than a handful of scores: a single
    // dominant top score is one outlier, and cutting at 1 answers "the corpus
    // has exactly one interesting record" whenever a corpus has a leader.
    const start = n > 3 ? 1 : 0;
    let best = 0;
    let bestScore = 0;
    for (let i = start; i + 1 < n; i++) {
        const left = s(i);
        const absGap = left - s(i + 1);
        // Relative to the score ABOVE the gap, so relGap lands in [0,1] and the
        // 0.05 floor keeps the meaning it is documented with. A left score at or
        // below EPS cannot carry a meaningful relative gap — the list descends,
        // so everything below it is smaller still — and 0 is the honest reading.
        const relGap = left > EPS ? absGap / left : 0;
        const score = relGap * (absGap / range);
        if (score > bestScore) { bestScore = score; best = i + 1; }
    }
    return bestScore >= GAP_FIRE ? best : 0;
}

/** The chord-deviation cutoff, or 0 when the curve is within the noise floor. */
function chordDeviation(s: (i: number) => number, n: number, range: number): number {
    const base = s(n - 1);
    let best = 0;
    let bestDev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
        const x = i / (n - 1);
        const y = (s(i) - base) / range;
        const dev = (1 - x) - y;
        if (dev > bestDev) { bestDev = dev; best = i; }
    }
    return bestDev > CHORD_FIRE ? best + 1 : 0;
}

// ── primes ────────────────────────────────────────────────────────────────

function isPrime(n: number): boolean {
    if (n < 2) return false;
    if (n % 2 === 0) return n === 2;
    for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
    return true;
}

/**
 * The smallest odd prime at or above `n`. Trial division is the right algorithm
 * at this size: the largest stride a census can produce is span/interiorWant,
 * so even a billion-element array asks for a prime near 8 million, and the
 * divisor loop stops at sqrt of that — under 3,000 iterations, once per census.
 */
function nextPrimeAtLeast(n: number): number {
    let p = n % 2 === 0 ? n + 1 : n;
    while (!isPrime(p)) p += 2;
    return p;
}
