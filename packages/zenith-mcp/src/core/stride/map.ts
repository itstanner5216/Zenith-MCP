// ---------------------------------------------------------------------------
// core/stride/map.ts — document orientation, the cheapest first call
//
// This is the call an agent makes before it knows anything, and the research is
// unusually specific about what it must return. Hierarchical, table-of-contents
// first navigation reached 81.6% task completeness at a 1K-token budget against
// 51.4% for fixed-length chunking of the same documents, and 98.2% of the
// full-document ceiling at 8K tokens — where fixed-length chunking needed 128K
// to match it. Separately: per-chunk summaries that were POPULATED "enabled
// selective exclusion", while empty ones "collapsed skimming to blind sampling."
//
// So a map is not a convenience endpoint. It is the mechanism that stops an
// agent paging blindly through a 600 MB array, and it earns that only if it is
// (a) a structural table of contents rather than a window of bytes, (b) cheap
// enough to be affordable before anything is known, and (c) explicit about what
// it left out.
//
// (c) is the part that is easy to get wrong quietly. Everything this module
// withholds is withheld as a COUNT the caller can do arithmetic on, never as a
// shorter list that looks complete. The failure mode being avoided is measured:
// three models scored 46.7 / 44.4 / 23.3 out of 100 at noticing silent mid-task
// content loss, and the finding was that when the loss came with a cue they
// mostly caught it and when it was silent they almost never did.
//
// THREE BOUNDS, and all three are constants rather than fractions of the
// document, because a map whose cost tracks the document is not a first call:
//
//   1. OUTLINE ENTRIES are capped at OUTLINE_MAX. A root object of 200,000 keys
//      produces 32 entries and a root summary naming all 200,000; a root array
//      of 5,000,000 elements produces the summary alone and no element is
//      walked to build it.
//   2. CENSUSES are capped at 1 + SHAPE_CENSUS_CAP = 7. Which containers get
//      one is decided by `knee` over their byte sizes — the document's own size
//      cliff — not by a threshold this module invents.
//   3. MEMBERS TOUCHED are therefore capped at
//      OUTLINE_MAX + (1 + SHAPE_CENSUS_CAP) * SHAPE_SAMPLE = 32 + 7*256 = 1824,
//      plus at most OUTLINE_MAX resolves for member counts. Both numbers are
//      independent of document size and asserted as such (tests: map-bounded).
//
// One cost this module cannot bound, and does not claim to: a member's span can
// only be learned by scanning to its end, so walking the first 32 members of a
// container the index did NOT store densely costs those members' bytes. That is
// inherited from the index's structure/bulk split, it is the same unit shape.ts
// bounds itself in ("bounded by the sample and not by the container"), and the
// member count — not the byte count — is what this module bounds.
// ---------------------------------------------------------------------------

import { address } from './cursor.js';
import type { IndexStats } from './index.js';
import { childPointer, indexPointer } from './pointer.js';
import type { Member, Resolver } from './resolve.js';
import { censusOf, knee } from './shape.js';
import {
    DENSE_CHILD_LIMIT,
    type StrideKind,
    type StrideMap,
    type StrideNode,
    type StrideOutlineEntry,
    type StrideShape,
} from './types.js';

/**
 * Outline entries emitted for a root object, and the widest root array still
 * enumerated element by element rather than summarised.
 *
 * It is DENSE_CHILD_LIMIT because that is the index's OWN boundary between
 * structure and bulk. A container at or below this width is indexed member by
 * member, so listing all of it is one dense-table read and no re-scan; above it
 * the index has already decided the container is a collection rather than a
 * shape and reduced its members to checkpoints. Borrowing that line keeps the
 * map's notion of "top-level structure" identical to the index's instead of
 * drawing a second one somewhere else.
 */
export const OUTLINE_MAX = DENSE_CHILD_LIMIT;

/**
 * Ceiling on member containers censused beyond the root — handed to `knee` as
 * its cap, so the document's size curve chooses and this only bounds it.
 *
 * 6 is `ceil(sqrt(OUTLINE_MAX))`, which is `knee`'s own intrinsic floor for the
 * longest candidate list an outline can ever hand it (32 entries). That is the
 * lowest cap that is not itself the decision: below 6 the cap would sit under
 * knee's floor and would therefore govern every wide root regardless of what
 * the sizes actually do, and at 6 it can only ever clip a detection knee really
 * made. It bounds the map at 7 censuses including the root's.
 */
export const SHAPE_CENSUS_CAP = 6;

/**
 * A census is kept only when some field is carried by at least this fraction of
 * the members that were sampled.
 *
 * `censusOf` describes a container's members ONE LEVEL DOWN, and for an object
 * whose members are scalars or arrays that means one field per sampled member,
 * named after the member itself. At SHAPE_SAMPLE that is up to 256 fields at
 * presence 1/256 — a restatement of the outline at several times its cost, and
 * no schema at all. shape.ts says the same of its own output there: such a
 * container "is read directly rather than censused". A majority is the line
 * because a schema is by definition what most members share, and below it there
 * is nothing to report that the outline's entries do not already address by
 * cursor. Nothing is withheld by this gate: it drops a claim the census could
 * not make, never a region of the document.
 */
export const CENSUS_MIN_TOP_PRESENCE = 0.5;

/**
 * Significant figures kept in `indexRatio`.
 *
 * A fixed number of DECIMAL places cannot serve this field: measured on the
 * four document shapes in tests/stride/map.test.ts the same index costs
 * 0.04234% of a 20 MB array of records and 15.03% of a 3.2 MB wide object,
 * where the member hash table dominates — three orders of magnitude apart. A
 * relative precision holds at both ends and caps the field at a dozen
 * characters instead of the twenty-two a raw double prints.
 */
const RATIO_FIGURES = 4;

/** True for the two kinds that have members. */
function isContainerKind(kind: StrideKind): boolean {
    return kind === 'object' || kind === 'array';
}

/**
 * `x` rounded to `digits` significant figures.
 *
 * Safe over this field's whole domain without a finiteness guard: a non-zero
 * `indexBytes` is an integer of at least 1 and `docBytes` is at most 2^53, so
 * the ratio never goes below ~1e-16 and the scaling exponent stays far inside
 * double range.
 */
function significant(x: number, digits: number): number {
    if (x === 0) return 0;
    const magnitude = Math.ceil(Math.log10(Math.abs(x)));
    const factor = 10 ** (digits - magnitude);
    return Math.round(x * factor) / factor;
}

/**
 * Index footprint as a fraction of the document.
 *
 * Reported as measured. There is no floor, no cap and no reassuring constant
 * folded in: the same index is a rounding error on a nested-record document and
 * a double-digit percentage on a compact wide object, and both are true of the
 * shapes they were measured on. A caller deciding whether to index a document
 * needs the number for ITS document, not an average.
 */
function ratioOf(indexBytes: number, docBytes: number): number {
    if (docBytes <= 0) return 0;
    return significant(indexBytes / docBytes, RATIO_FIGURES);
}

/** The outline, with the resolved member nodes a census will need. */
interface Outlined {
    readonly entries: StrideOutlineEntry[];
    /** Root member containers holding at least one member, in document order. */
    readonly containers: StrideNode[];
}

/** The censuses kept, and the member container the hint should point at. */
interface Censused {
    readonly shapes: StrideShape[];
    /** Largest member container whose census survived the gate, else null. */
    readonly focus: StrideNode | null;
}

/**
 * One outline entry for one root member, or null when the member cannot be
 * addressed.
 *
 * Null happens only for an object member the scanner produced no name for,
 * which cannot occur in well-formed JSON. An entry for it would have to carry a
 * pointer naming some OTHER member, and an outline entry whose cursor lands
 * somewhere else is worse than an absent one. The absence is not silent: the
 * entry count then falls short of the root's true member count, which is what
 * makes `outlineOf` emit the root summary, and `stats.errorAt` names the byte
 * where the document stopped being JSON.
 */
function memberEntry(resolver: Resolver, root: StrideNode, m: Member, into: StrideNode[]): StrideOutlineEntry | null {
    let key: string;
    let pointer: string;
    if (root.kind === 'object') {
        if (m.key === null) return null;
        key = m.key;
        // Escaped by `childPointer`, so `key` stays the member's real name and
        // `pointer` stays a valid RFC 6901 address for it (I8). For an array
        // the two coincide: the ordinal IS the reference token.
        pointer = childPointer('', key);
    } else {
        key = String(m.ordinal);
        pointer = indexPointer('', m.ordinal);
    }

    const container = isContainerKind(m.kind);
    let count = 0;
    if (container) {
        // Resolved rather than defaulted. `Member` carries no count, and the
        // index has one only for a member its parent stored densely — a root
        // wider than DENSE_CHILD_LIMIT has none. `0` would be a corrupted count
        // on exactly the containers this outline exists to point at, so the
        // count is derived instead: bounded by one member's own span, at most
        // OUTLINE_MAX times per map.
        const node = resolver.resolve(pointer);
        count = node.count;
        if (count > 0) into.push(node);
    }

    return {
        pointer,
        key,
        kind: m.kind,
        count,
        bytes: m.end - m.start,
        span: [m.start, m.end],
        // The op render.ts uses for "here is a whole value, go and get it":
        // "read" for a container, "scalar" for everything else.
        cursor: address(container ? 'read' : 'scalar', pointer, 0).cursor,
    };
}

/**
 * The root as a single outline entry.
 *
 * Emitted whenever the entries do not enumerate every root member, and it is
 * what makes the outline's own omission ADDRESSED rather than implied (I4): it
 * names what was withheld (root members), how many (`count`, the true total,
 * against `outline.length - 1` shown), its byte span, and a cursor that
 * retrieves it. `outline[0].pointer === ''` is therefore the caller's exact
 * test for "this outline is not the whole root".
 */
function rootSummary(root: StrideNode): StrideOutlineEntry {
    return {
        pointer: '',
        key: '',
        kind: root.kind,
        count: root.count,
        bytes: root.end - root.start,
        span: [root.start, root.end],
        cursor: address('read', '', 0).cursor,
    };
}

/** Top-level structure: up to OUTLINE_MAX member entries, plus a root summary when they do not cover the root. */
function outlineOf(resolver: Resolver, root: StrideNode): Outlined {
    const entries: StrideOutlineEntry[] = [];
    const containers: StrideNode[] = [];
    // A scalar document has no members to outline. The hint carries the one
    // call worth making on it, which is to read the value.
    if (!isContainerKind(root.kind)) return { entries, containers };

    // A root array wider than the bound is summarised, not sampled. Elements 0
    // to 31 of a five-million-element array carry nothing a caller can navigate
    // by — their ordinals were already known — whereas an object's member names
    // ARE the table of contents. That asymmetry is why types.ts specifies "one
    // entry per root member or a root array summary" and names only the array
    // case, and it is what keeps a 5,000,000-element root from being walked.
    const enumerate = root.kind === 'object' || root.count <= OUTLINE_MAX;
    const want = enumerate ? Math.min(root.count, OUTLINE_MAX) : 0;
    if (want > 0) {
        for (const m of resolver.members(root, 0, want)) {
            const entry = memberEntry(resolver, root, m, containers);
            if (entry !== null) entries.push(entry);
        }
    }

    // Compared against the root's TRUE member count, not against the number
    // asked for, so a member dropped for being unaddressable is declared too.
    if (entries.length < root.count) entries.unshift(rootSummary(root));
    return { entries, containers };
}

/** True when a census found a schema rather than re-listing the members it sampled. */
function informative(shape: StrideShape): boolean {
    if (shape.sampled === 0) return false;
    let top = 0;
    for (const field of shape.fields) if (field.presence > top) top = field.presence;
    return top >= CENSUS_MIN_TOP_PRESENCE;
}

/**
 * Shape censuses for the large containers worth knowing about up front.
 *
 * The root is always a candidate and is never ranked against its own members —
 * it contains all of them, so its byte size is the maximum by construction and
 * including it in the curve would put a cliff between the root and everything
 * else on every document that exists. `knee` then reads the MEMBERS' size curve
 * and answers how many of them are above the document's own size cliff, capped
 * at SHAPE_CENSUS_CAP.
 */
function shapesOf(resolver: Resolver, root: StrideNode, containers: readonly StrideNode[]): Censused {
    const shapes: StrideShape[] = [];
    if (!isContainerKind(root.kind)) return { shapes, focus: null };

    const ranked = [...containers].sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const keep = knee(ranked.map((n) => n.end - n.start), SHAPE_CENSUS_CAP);

    let focus: StrideNode | null = null;
    // The root first, so `shapes[0]` is the document's own shape whenever it has
    // one, and the member containers in descending size after it.
    for (const node of [root, ...ranked.slice(0, keep)]) {
        const shape = censusOf(resolver, node);
        if (!informative(shape)) continue;
        shapes.push(shape);
        // `ranked` is descending and the root is not a member, so the first
        // surviving member census is the largest one.
        if (focus === null && node !== root) focus = node;
    }
    return { shapes, focus };
}

/**
 * The literal next call, last in the map and phrased as an instruction.
 *
 * Both properties are load-bearing rather than stylistic: moving an instruction
 * checklist to the END of a prompt took tool adoption from 0% to 100% in one
 * measured condition, and the non-adopters scored at the no-tool baseline. What
 * comes BEFORE the call is every reason the numbers above it are not the whole
 * truth — index incompleteness first, then the outline's declared omission —
 * because a caveat after the instruction is a caveat the reader has already
 * acted past.
 *
 * The call itself is the largest member container the map censused, when there
 * is one: the map has just stated that container's schema, so it is the one
 * place the caller can act on immediately. When no census survived, the only
 * useful move left is to keep listing, so the call continues the root from the
 * first ordinal the outline did not show.
 */
function hintFor(
    root: StrideNode,
    outline: readonly StrideOutlineEntry[],
    focus: StrideNode | null,
    stats: IndexStats,
): string {
    const parts: string[] = [];

    if (stats.truncatedIndex) {
        // An index that hit its ceiling is an incomplete index, and a map that
        // reports a footprint without reporting that is hiding it (I7). What the
        // ceiling costs is fast addressing below it, not correctness: a member
        // with no index node is still reached by scanning its container, and
        // every count and span in this map is still derived from the document.
        parts.push(
            `INCOMPLETE INDEX: the build hit its node ceiling, so "indexed" (${stats.nodes}) `
            + 'covers only the top of this document\'s structure and containers below the ceiling '
            + 'are reached by scanning rather than by index lookup. Every count and span in this '
            + 'map is still exact; what is missing is fast addressing, not coverage.',
        );
    }
    if (stats.errorAt >= 0) {
        parts.push(
            `MALFORMED FROM BYTE ${stats.errorAt}: ${stats.errorMessage}. `
            + 'Nothing at or after that byte is indexed or counted here.',
        );
    }

    // Indexed read, guarded: the first entry is the root summary only when one
    // was emitted, and an empty outline has no first entry at all.
    const first = outline.length > 0 ? outline[0] : undefined;
    const summary = first !== undefined && first.pointer === '' ? first : undefined;
    const shown = summary === undefined ? outline.length : outline.length - 1;
    if (summary !== undefined) {
        const unit = summary.kind === 'object' ? 'keys' : 'elements';
        parts.push(
            `The root holds ${summary.count} ${unit}; this outline names ${shown} of them, `
            + `so ${summary.count - shown} are not listed above.`,
        );
    }

    if (!isContainerKind(root.kind)) {
        const cursor = address('scalar', '', 0).cursor;
        parts.push(
            `This document is a single ${root.kind} of ${root.end - root.start} bytes. `
            + `Call mode "scalar" with pointer "" and offset 0, or cursor ${JSON.stringify(cursor)}, to read it.`,
        );
        return parts.join(' ');
    }

    const target = focus ?? root;
    // Continuing the root is the only case with a non-zero offset: descending
    // into a member starts at that member's first element, not at the root's.
    const offset = target === root ? shown : 0;
    const cursor = address('read', target.pointer, offset).cursor;
    const where = target === root ? '""' : JSON.stringify(target.pointer);
    const unit = target.kind === 'object' ? 'keys' : 'elements';
    const purpose = target === root
        ? (shown > 0
            ? `continue this outline from root member ${shown}`
            : `read the ${target.count} ${unit} under the root`)
        : `read the ${target.count} ${unit} under ${where}`;
    parts.push(
        `Call mode "read" with pointer ${where} and offset ${offset}, `
        + `or cursor ${JSON.stringify(cursor)}, to ${purpose}.`,
    );
    return parts.join(' ');
}

/**
 * Build the document-level orientation view: the cheapest first call.
 *
 * Cost is bounded by the map and not by the document — at most
 * `OUTLINE_MAX + (1 + SHAPE_CENSUS_CAP) * SHAPE_SAMPLE` members handed out by
 * the resolver and at most `OUTLINE_MAX` pointer resolutions, whatever the
 * document's size or width. Nothing this returns is withheld without being
 * counted: an outline that does not enumerate every root member carries a root
 * summary stating the true total, and `outline[0].pointer === ''` is the test
 * for it.
 *
 * Throws `malformed_json` (from `Resolver.root`) when the source holds no JSON
 * value at all. Every other document shape produces a map, including one whose
 * index is incomplete — that is declared in `hint` rather than hidden.
 */
export function buildMap(resolver: Resolver): StrideMap {
    const stats = resolver.index.stats;
    const bytes = resolver.source.size;
    const root = resolver.root();

    const { entries, containers } = outlineOf(resolver, root);
    const { shapes, focus } = shapesOf(resolver, root, containers);

    return {
        bytes,
        kind: root.kind,
        // The scanner walks the whole document whatever the index chose to keep,
        // so this is the document's true maximum nesting depth and not a depth
        // the skeleton happens to reach.
        maxDepth: stats.maxDepth,
        indexed: stats.nodes,
        indexBytes: stats.bytes,
        indexRatio: ratioOf(stats.bytes, bytes),
        buildMs: stats.buildMs,
        outline: entries,
        shapes,
        hint: hintFor(root, entries, focus, stats),
    };
}
