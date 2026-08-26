// ---------------------------------------------------------------------------
// core/stride/types.ts — STRIDE public contracts
//
// STRIDE is a read-only navigator for JSON documents that are too large to
// parse: hundreds of megabytes, often on a single physical line, frequently
// millions of structurally similar records. It never materialises the document
// as a JavaScript value graph. Everything it returns is either bytes copied
// verbatim out of the source or a namespaced STRIDE metadata field.
//
// The coordinate system is two numbers and one string:
//   - `pointer`  RFC 6901 JSON Pointer   — conceptual location
//   - `span`     [byteStart, byteEnd)    — physical location
// Every value STRIDE emits can be re-derived from the source by its span, and
// every location STRIDE emits can be handed back to STRIDE as an address.
//
// The invariants below are the contract. They are enforced by construction in
// the modules that can violate them, and re-checked mechanically in the tests
// named beside each one.
//
//   I1 SOURCE TRUTH     Every rendered document value is a verbatim byte slice
//                       of the source. STRIDE metadata only ever appears under
//                       the reserved `__stride` key or inside a marker string
//                       matching MARKER_RE. (tests: source-truth)
//   I2 VALID JSON       Every payload STRIDE returns parses as JSON.
//                       (tests: render-budget, render-shapes)
//   I3 BUDGET BOUND     `chars <= budget` for every view, at every nesting
//                       depth, for every document. Enforced top-down during
//                       the render walk, never as a post-hoc trim.
//                       (tests: render-budget)
//   I4 ADDRESSED        Every omission carries a marker naming what was
//      OMISSION         withheld, how much, its byte span, and a cursor that
//                       retrieves it. No silent truncation, anywhere.
//                       (tests: omission)
//   I5 SELF-LOCATION    Every view states its own pointer, span, totals and
//                       the addresses of what comes next and before.
//                       (tests: navigation)
//   I6 BOUNDED MEMORY   Index memory is a small fraction of document size and
//                       file-backed documents are never fully copied into the
//                       heap. (tests: scale)
//   I7 FULL RECALL      Search enumerates every candidate region; it never
//                       drops coverage to bound work. (tests: recall)
//   I8 STRICT POINTERS  RFC 6901 exactly: "" is the document, "/" is the
//                       member named "", ~0/~1 round-trip, leading-zero array
//                       indices are rejected. (tests: pointer)
// ---------------------------------------------------------------------------

/** The eight JSON value kinds STRIDE distinguishes. */
export type StrideKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** Reserved envelope key. Nothing else STRIDE emits may collide with it. */
export const STRIDE_KEY = '__stride';

/**
 * The single omission marker form, flush-left, mirroring the repo-wide
 * `[TRUNCATED: ...]` marker. A giant JSON document has no meaningful line
 * geometry, so the detail after the colon names elements, keys or bytes
 * instead of lines. Everything else about the shape is unchanged.
 */
export const MARKER_RE = /^\[TRUNCATED: [^\]]+\]$/;

/**
 * A resolved node handle. This is a VIEW over the index's typed-array storage,
 * materialised on demand — the index never holds one object per JSON value.
 */
export interface StrideNode {
    /** RFC 6901 pointer to this node. */
    readonly pointer: string;
    readonly kind: StrideKind;
    /** Inclusive byte offset of the value's first byte. */
    readonly start: number;
    /** Exclusive byte offset one past the value's last byte. */
    readonly end: number;
    /** 0 for the document root. */
    readonly depth: number;
    /** Pointer of the containing node, or null at the root. */
    readonly parent: string | null;
    /**
     * Members for an object, elements for an array, 0 for a scalar. This is
     * the TRUE count, not the indexed count — large containers are indexed by
     * checkpoint, not per child.
     */
    readonly count: number;
}

/** One withheld region, addressed so the caller can go and get it. */
export interface StrideOmission {
    /** What was withheld. */
    readonly of: 'elements' | 'keys' | 'bytes' | 'depth';
    /** Pointer of the container the omission is inside. */
    readonly pointer: string;
    /** Number of elements / keys / bytes withheld. */
    readonly count: number;
    /** Half-open index range withheld, for elements and keys. */
    readonly range?: readonly [number, number];
    /** Total elements / keys / bytes the container holds. */
    readonly total: number;
    /** Byte span of the withheld region. */
    readonly span: readonly [number, number];
    /** Opaque continuation token that retrieves exactly this region. */
    readonly cursor: string;
    /** Why it was withheld. */
    readonly reason: 'budget' | 'depth' | 'page';
}

/** The self-locating envelope every STRIDE view carries. */
export interface StrideEnvelope {
    readonly pointer: string;
    readonly kind: StrideKind;
    readonly span: readonly [number, number];
    /** Total members/elements at this pointer, when it is a container. */
    readonly total?: number;
    /** Half-open index range of what this view actually shows. */
    readonly shown?: readonly [number, number];
    /** Every region withheld from this view. Empty when the view is complete. */
    readonly omitted: readonly StrideOmission[];
    /** Continuation addresses. Explicit coordinates AND opaque cursors. */
    readonly next?: StrideAddress;
    readonly prev?: StrideAddress;
    readonly parent?: StrideAddress;
    /** The literal next call to make, phrased as an instruction. */
    readonly hint?: string;
}

/** An address the caller can hand straight back, in both forms. */
export interface StrideAddress {
    readonly pointer: string;
    readonly offset?: number;
    readonly cursor: string;
}

/** What every read-shaped operation returns. */
export interface StrideView {
    /** The payload: verbatim document values plus markers. Always valid JSON. */
    readonly data: unknown;
    readonly envelope: StrideEnvelope;
    /** Characters the serialised payload occupies. Never exceeds the budget. */
    readonly chars: number;
    readonly budget: number;
}

/** One search hit, located and addressed. */
export interface StrideHit {
    readonly rank: number;
    readonly pointer: string;
    readonly span: readonly [number, number];
    /** Fused score in [0,1]. */
    readonly score: number;
    /** Lexical relevance component, percentile-calibrated to [0,1]. */
    readonly relevance: number;
    /** Structural novelty component, percentile-calibrated to [0,1]. */
    readonly novelty: number;
    /** Query terms this record actually matched. */
    readonly matched: readonly string[];
    /** Byte offsets inside `span` where a query term literally occurs. */
    readonly offsets: readonly number[];
    readonly cursor: string;
    readonly windowCursor: string;
    /** A budget-bounded excerpt of the record. */
    readonly preview: unknown;
}

/** What `search` returns. */
export interface StrideSearchResult {
    readonly query: string;
    readonly hits: readonly StrideHit[];
    /**
     * Records that matched, in total. This is a true count over the whole
     * document — never a count of what an index happened to retain (I7).
     */
    readonly totalMatches: number;
    readonly returned: number;
    /** Which retrieval path answered: the term index, or a full literal scan. */
    readonly path: 'index' | 'scan';
    readonly truncated: boolean;
    readonly chars: number;
    readonly budget: number;
    readonly hint: string;
}

/** A field observed inside a homogeneous container. */
export interface StrideField {
    readonly key: string;
    /** Observed kinds, most frequent first. */
    readonly kinds: readonly StrideKind[];
    /** Fraction of sampled members that carry this key, in [0,1]. */
    readonly presence: number;
    /**
     * Distinct values observed, capped. `exact` is false once the cap is hit,
     * so the caller is never told a cardinality that was not measured.
     */
    readonly distinct: number;
    readonly exact: boolean;
    /** Present only when the field holds one value across every sample. */
    readonly constant?: string;
    /** Up to a few verbatim sample values, JSON-encoded. */
    readonly samples: readonly string[];
}

/** The shape census of a container. */
export interface StrideShape {
    readonly pointer: string;
    readonly kind: StrideKind;
    readonly total: number;
    /** Members actually inspected to build this census. */
    readonly sampled: number;
    /** True when one key-set dominates the sample. */
    readonly homogeneous: boolean;
    readonly fields: readonly StrideField[];
    /** Mean bytes per member across the sample. */
    readonly meanBytes: number;
}

/** Document-level orientation — the cheapest first call. */
export interface StrideMap {
    readonly bytes: number;
    readonly kind: StrideKind;
    readonly maxDepth: number;
    /** Indexed structural nodes. Not the number of JSON values. */
    readonly indexed: number;
    /** Index footprint in bytes, and as a fraction of the document. */
    readonly indexBytes: number;
    readonly indexRatio: number;
    readonly buildMs: number;
    /** Top-level structure, one entry per root member or a root array summary. */
    readonly outline: readonly StrideOutlineEntry[];
    /** Shape censuses for the large containers worth knowing about up front. */
    readonly shapes: readonly StrideShape[];
    readonly hint: string;
}

export interface StrideOutlineEntry {
    readonly pointer: string;
    readonly key: string;
    readonly kind: StrideKind;
    readonly count: number;
    readonly bytes: number;
    readonly span: readonly [number, number];
    readonly cursor: string;
}

/** Decoded continuation cursor. */
export interface StrideCursor {
    readonly v: 1;
    readonly op: 'read' | 'window' | 'page' | 'scalar' | 'search';
    readonly pointer: string;
    readonly offset: number;
    readonly limit: number | null;
    readonly query: string | null;
}

/**
 * Every failure STRIDE can produce, as a closed set. A tool converts these
 * into a message that names the recovery, never a bare throw.
 */
export type StrideFailure =
    | 'not_found'          // the pointer resolves to nothing in this document
    | 'bad_pointer'        // the pointer is not valid RFC 6901
    | 'bad_cursor'         // the cursor is malformed, or for another document
    | 'malformed_json'     // the source is not well-formed JSON
    | 'not_a_container'    // the operation needs an object or array
    | 'not_a_scalar'       // the operation needs a scalar
    | 'empty_query'        // search was given nothing to look for
    | 'too_large';         // the request exceeds a hard structural limit

export class StrideError extends Error {
    readonly failure: StrideFailure;
    /** What the caller should do instead. Always populated. */
    readonly recovery: string;
    /** Byte offset the failure refers to, when the failure is positional. */
    readonly at: number | null;

    constructor(failure: StrideFailure, message: string, recovery: string, at: number | null = null) {
        super(message);
        this.name = 'StrideError';
        this.failure = failure;
        this.recovery = recovery;
        this.at = at;
    }
}

// ── Tuning constants ──────────────────────────────────────────────────────
// Every one of these is a measured or reasoned bound, not a decoration. The
// value is stated with the reason it holds, because a constant whose reason is
// unwritten is a constant nobody can safely retune.

/**
 * Offsets are stored every STRIDE_DEFAULT children rather than per child, and
 * a random child is reached by seeking the checkpoint below it and re-scanning
 * forward at most this many members. Measured trade-off on a 256 MiB / 1.3 M
 * element document: K=1 costs 1.96% of document size for 235 ns access; K=64
 * costs 0.031% for ~12 us; K=1024 costs 0.002% for ~174 us. K=64 is the knee —
 * past it, latency grows faster than the memory saved is worth.
 */
export const STRIDE_DEFAULT = 64;

/**
 * The stride is retuned per container by BYTES per member, not member count:
 * forward re-scan rate is roughly constant, so latency tracks
 * `stride x bytesPerMember`. This is the byte-distance a single re-scan should
 * cover — 12 KiB, i.e. ~64 members at the 200 B/member the tuning was measured
 * against.
 */
export const STRIDE_RESCAN_BYTES = 12_288;

/** Never stride wider than this, however small the members. */
export const STRIDE_MAX = 4096;

/**
 * Containers at or below this many children are indexed child-by-child, so
 * the overwhelmingly common small-object case pays no re-scan at all.
 */
export const DENSE_CHILD_LIMIT = 32;

/**
 * Block size for the search index. Term postings name blocks, not offsets, so
 * index size scales with document/BLOCK rather than with token count. At 64 KiB
 * a 600 MB document is ~9,600 blocks — a posting list is a handful of bytes and
 * the verify scan reads at most 64 KiB per candidate.
 */
export const SEARCH_BLOCK_BYTES = 65_536;

/**
 * The term dictionary is capped so a pathological document cannot grow it
 * without bound. Terms evicted past the cap are NOT lost to search: the block
 * is flagged, and any query naming an unindexed term falls back to a full
 * literal scan, which is exhaustive. The cap bounds memory, never recall (I7).
 */
export const TERM_DICT_LIMIT = 200_000;

/** Members sampled to build a shape census. Head, tail and prime-strided interior. */
export const SHAPE_SAMPLE = 256;

/** Distinct values tracked per field before `exact` goes false. */
export const DISTINCT_CAP = 64;

/** Verbatim sample values kept per field. */
export const FIELD_SAMPLES = 3;

/** Bytes of a scalar shown before it is truncated with a marker. */
export const SCALAR_PREVIEW_BYTES = 512;

/**
 * Characters reserved out of every budget for the envelope and markers, as a
 * fraction. An elision costs real characters; a budget that does not reserve
 * for them cannot honour I3 at the boundary.
 */
export const ENVELOPE_RESERVE = 0.12;

/** Absolute floor on a usable budget. Below this, only the envelope fits. */
export const MIN_BUDGET_CHARS = 256;
