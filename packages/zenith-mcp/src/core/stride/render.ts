// ---------------------------------------------------------------------------
// core/stride/render.ts — turning a resolved span into a budgeted view
//
// One rule governs this file, and everything else in it is machinery for
// keeping that rule true:
//
//   NEVER MATERIALISE A SPAN LARGER THAN THE BUDGET CURRENTLY ALLOTTED TO IT.
//
// The implementation this replaces broke exactly there. Rendering an object it
// parsed each member's whole subtree in order to decide whether the member
// fitted, then included the first two members unconditionally. Measured on the
// document in the tests — two 5,000-element arrays under one root object — it
// emitted 590,013 characters for a budget of 300. Any post-hoc trim is the same
// bug wearing a hat: the damage is done at the moment the bytes are parsed, not
// at the moment they are serialised.
//
// So the allocator decides from the BYTE LENGTH of a span, which the index
// already knows, before any byte of it is touched:
//
//   fits      byteLen <= allotment  ->  JSON.parse the exact slice, verbatim.
//                                       This is the ONLY place in STRIDE where
//                                       a document value comes into existence,
//                                       which is what makes I1 mechanical.
//   splits    byteLen >  allotment  ->  divide the allotment across members and
//                                       recurse. Members that cannot afford a
//                                       minimal representation are not shown at
//                                       all; they become an addressed omission.
//                                       Fewer members shown completely beats all
//                                       of them shown mutilated.
//   previews  a scalar too big for its allotment -> a leading verbatim excerpt
//                                       of at most SCALAR_PREVIEW_BYTES, cut on
//                                       a codepoint and escape boundary, plus a
//                                       marker.
//
// Byte length is a safe proxy for character cost because JSON's serialised form
// is never longer than its source bytes — whitespace disappears, `é`
// collapses to one character, multi-byte UTF-8 collapses to one or two — with
// exactly one exception: a number can grow (`1e-6` is 4 bytes and stringifies
// to `0.000001`, 8 characters). Numbers are therefore measured exactly after
// parsing, and a parsed value that measures over its allotment is dropped
// rather than emitted. Every accepted value is measured exactly, so the running
// total is exact rather than estimated, at every level.
//
// Two audiences read an omission and they need different things, so both forms
// are always produced from the same numbers: a flush-left `[TRUNCATED: ...]`
// string sitting where the content would have been, for a human reading the
// payload, and a `StrideOmission` in the envelope with the span and the cursor,
// for a model acting on it.
// ---------------------------------------------------------------------------

import {
    MARKER_RE, SCALAR_PREVIEW_BYTES, ENVELOPE_RESERVE, STRIDE_KEY,
    type StrideAddress, type StrideEnvelope, type StrideKind,
    type StrideNode, type StrideOmission, type StrideView,
} from './types.js';
import { MAX_SLICE_BYTES } from './source.js';
import type { Member, Resolver } from './resolve.js';
import { address } from './cursor.js';
import { childPointer, indexPointer, parentPointer, tokenToIndex } from './pointer.js';

// ── Tuning ────────────────────────────────────────────────────────────────
// Every value below is a bound with a reason, because a constant whose reason
// is unwritten is a constant nobody can safely retune.

/**
 * The smallest budget a view can honestly be rendered against. `null` costs 4
 * characters and is the shortest payload STRIDE can emit without inventing a
 * document value; ENVELOPE_RESERVE takes 12% off the top, and 5 is the first
 * integer budget whose usable share still reaches 4. Below it, I2 (valid JSON)
 * and I3 (chars <= budget) are jointly unsatisfiable — there is no valid JSON
 * text shorter than one character — so the view reports the floor it actually
 * used as its budget rather than claiming a bound it did not honour.
 */
export const MIN_VIEW_BUDGET = 5;

/**
 * Members pulled from the resolver per batch. Bounds the transient Member[] for
 * a 100,000-element container while still letting a large budget walk as far as
 * it can pay for: the loop simply asks for another batch. 256 matches the width
 * at which the index stops storing members one by one, so a batch is at most one
 * dense table or one checkpoint re-scan.
 */
const MEMBER_BATCH = 256;

/**
 * Hard ceiling on render recursion. The scanner avoids recursion entirely
 * because a 50,000-level document would blow the JS stack; this walk is bounded
 * by the budget in every realistic case, but a pathological document plus a
 * large budget must not be able to reach the stack limit. 512 levels is far
 * deeper than any authored schema and costs ~1,500 frames at three frames per
 * level, well inside Node's default stack.
 */
const MAX_RENDER_DEPTH = 512;

/**
 * A member slot must be able to afford at least this many characters of value
 * before it is worth showing. Two is the shortest JSON value that carries any
 * information at all (`[]`, `{}`, `""`); below it a member would be a stub, and
 * a stub is worse than an addressed omission because it looks like content.
 */
const MIN_MEMBER_CHARS = 2;

/**
 * Members hoisted ahead of document order because they contain a focus offset.
 * A view stitched from more than a few dozen fragments stops being readable, and
 * each hoisted member costs a `locate()` probe.
 */
const FOCUS_MEMBER_CAP = 32;

/** Characters of member names carried in a marker's `next ...` field. */
const MARKER_NAME_CHARS = 48;

/**
 * `renderWindow`'s split of the budget: the target, its immediate surroundings,
 * and the ancestor chain plus affordances. This is a STARTING ALLOCATION, NOT A
 * LAW — each slice hands its unspent remainder to the next, so a target that
 * fits in a tenth of its share funds more siblings rather than wasting the
 * difference.
 */
const WINDOW_TARGET_SHARE = 0.60;
const WINDOW_SIBLING_SHARE = 0.30;
const WINDOW_ANCESTOR_SHARE = 0.10;

/** Sibling summaries either side of the target, budget permitting. */
const WINDOW_SIBLING_REACH = 8;

// ── Exact character measurement ───────────────────────────────────────────

/**
 * Exact `JSON.stringify(s).length` without building the string. The per-code-
 * unit costs mirror ES2019 well-formed stringify: a lone surrogate is escaped
 * to six characters, a matched pair passes through as its two code units.
 */
function jsonStringChars(s: string): number {
    let n = 2;                                  // the two quotes
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0x22 || c === 0x5c) { n += 2; continue; }
        if (c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) { n += 2; continue; }
        if (c < 0x20) { n += 6; continue; }
        if (c >= 0xd800 && c <= 0xdfff) {
            const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
            if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { n += 2; i++; } else { n += 6; }
            continue;
        }
        n += 1;
    }
    return n;
}

/**
 * Exact serialised character count of a JSON-shaped value — the same number
 * `JSON.stringify(value).length` would give, computed structurally so that
 * measuring a value never allocates a copy of it. Values here are only ever
 * `JSON.parse` output plus STRIDE's own strings, arrays and plain objects.
 */
export function estimateChars(value: unknown): number {
    if (value === null) return 4;
    switch (typeof value) {
        case 'boolean': return value ? 4 : 5;
        case 'number': return Number.isFinite(value) ? String(value).length : 4;
        case 'string': return jsonStringChars(value);
        case 'object': break;
        default: return 4;                      // undefined/function/symbol -> `null`
    }
    if (Array.isArray(value)) {
        let n = 2;
        for (let i = 0; i < value.length; i++) {
            if (i > 0) n += 1;
            n += estimateChars(value[i]);
        }
        return n;
    }
    let n = 2;
    let first = true;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;          // stringify drops these entirely
        if (!first) n += 1;
        first = false;
        n += jsonStringChars(k) + 1 + estimateChars(v);
    }
    return n;
}

// ── Markers ───────────────────────────────────────────────────────────────

/**
 * MARKER_RE forbids `]` inside a marker, and a JSON member name may contain
 * one — a key literally called `a]b` would make its own marker unmatchable and
 * unparseable by field. Free text embedded in a marker is therefore percent-
 * encoded for `]` and for the `|` field separator. The structured
 * `StrideOmission` in the envelope always carries the exact, unescaped pointer,
 * so nothing is lost: the marker is the human's copy, the omission is the
 * model's.
 */
function markerSafe(text: string): string {
    return text.replace(/\]/g, '%5D').replace(/\|/g, '%7C');
}

interface MarkerParts {
    /** `elements 30-4999 of 5000` | `12 of 15 keys` | `bytes 512-1500 of 1500` */
    readonly head: string;
    /** `bytes 1234-987654` | `next id,name,payload` | `4 keys, 8231 bytes` */
    readonly detail: string | null;
    readonly cursor: string;
}

/**
 * Assemble a marker, dropping the optional detail field before the mandatory
 * ones if the reserve is tight. What is dropped here is metadata the envelope
 * still carries in full — never content — so a squeezed marker degrades the
 * human's copy and nothing else.
 */
function buildMarker(parts: MarkerParts, maxChars: number): string {
    const full = parts.detail === null
        ? `[TRUNCATED: ${parts.head} | cursor ${parts.cursor}]`
        : `[TRUNCATED: ${parts.head} | ${parts.detail} | cursor ${parts.cursor}]`;
    if (jsonStringChars(full) <= maxChars || parts.detail === null) return full;
    return `[TRUNCATED: ${parts.head} | cursor ${parts.cursor}]`;
}

/** Member names for a marker's `next ...` field, elided to a fixed width. */
function nameList(keys: readonly string[]): string | null {
    if (keys.length === 0) return null;
    let out = '';
    for (const k of keys) {
        const safe = markerSafe(k);
        const candidate = out === '' ? safe : `${out},${safe}`;
        if (candidate.length > MARKER_NAME_CHARS) { out = out === '' ? safe.slice(0, MARKER_NAME_CHARS) : `${out},…`; break; }
        out = candidate;
    }
    return out === '' ? null : `next ${out}`;
}

// ── The allocator ─────────────────────────────────────────────────────────

/** A span the renderer is asked to produce a value for. */
interface RenderSpan {
    readonly pointer: string;
    readonly kind: StrideKind;
    readonly start: number;
    readonly end: number;
    /** Member count when established, -1 when it has not been. */
    readonly count: number;
}

/** A produced value together with its EXACT serialised cost. */
interface Rendered {
    readonly value: unknown;
    readonly chars: number;
}

/** Mutable state threaded through one render walk. */
interface Ctx {
    readonly resolver: Resolver;
    readonly omissions: StrideOmission[];
    /** Byte offsets that must stay visible — search hits, usually. */
    readonly focus: readonly number[];
}

/** A member that made it into the output, with its exact cost. */
interface Slot {
    readonly ordinal: number;
    readonly key: string | null;
    readonly start: number;
    readonly end: number;
    readonly value: unknown;
    readonly chars: number;
}

function spanOfMember(parent: RenderSpan, m: Member): RenderSpan {
    return {
        pointer: parent.kind === 'array' ? indexPointer(parent.pointer, m.ordinal) : childPointer(parent.pointer, m.key ?? ''),
        kind: m.kind,
        start: m.start,
        end: m.end,
        count: -1,
    };
}

/**
 * A container's member count, established only when an omission has to state a
 * total. `resolve` answers from the index for anything the skeleton reached; a
 * container it did not reach is by construction inside a bulk collection — a
 * record — and a record is small, so the fallback count-scan is bounded by the
 * record, not by the document.
 */
function establishCount(ctx: Ctx, span: RenderSpan): number {
    if (span.count >= 0) return span.count;
    if (span.kind !== 'object' && span.kind !== 'array') return 0;
    try {
        return ctx.resolver.resolve(span.pointer).count;
    } catch {
        // An unresolvable pointer here means the span came from a scan of a
        // region the index disagrees with. The omission falls back to its byte
        // form, which needs no count.
        return -1;
    }
}

/**
 * The verbatim path, and the only place in STRIDE where a document value is
 * produced. Guarded by BYTE LENGTH before the slice is taken, so an oversized
 * span is never materialised; measured exactly afterwards, because a number is
 * the one JSON form whose serialisation can be longer than its source bytes.
 */
function verbatim(ctx: Ctx, span: RenderSpan, allot: number): Rendered | null {
    const bytes = span.end - span.start;
    if (bytes <= 0 || bytes > allot) return null;
    // MAX_SLICE_BYTES is the source's own single-slice ceiling; past it the
    // slice throws rather than returning, so the split path takes over.
    if (bytes > MAX_SLICE_BYTES) return null;
    let value: unknown;
    try {
        value = JSON.parse(ctx.resolver.source.slice(span.start, span.end).toString('utf8'));
    } catch {
        return null;
    }
    const chars = estimateChars(value);
    return chars <= allot ? { value, chars } : null;
}

/** Largest cut of `buf` at or below `limit` that does not split a UTF-8 sequence. */
function safeUtf8End(buf: Buffer, limit: number): number {
    if (limit >= buf.length) return buf.length;
    let end = limit < 0 ? 0 : limit;
    // A continuation byte at the cut means the sequence straddles it. Backing
    // off until the cut lands on a lead or ASCII byte leaves only whole
    // sequences behind, because an incomplete sequence would have put a
    // continuation byte exactly here.
    while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
    return end;
}

/**
 * Decode the leading bytes of a JSON string's interior. The cut may land inside
 * an escape sequence, which no amount of byte arithmetic can detect reliably
 * across `\\\\u` runs — so the parser itself is the oracle: shrink and retry,
 * bounded by the six bytes an escape can occupy. A trailing unpaired high
 * surrogate is dropped, because emitting one would put a lone surrogate in the
 * payload.
 */
function decodeStringPrefix(raw: Buffer, limit: number): string | null {
    let cut = safeUtf8End(raw, limit);
    for (let tries = 0; tries < 8 && cut > 0; tries++) {
        try {
            const parsed: unknown = JSON.parse(`"${raw.toString('utf8', 0, cut)}"`);
            if (typeof parsed !== 'string') return null;
            const n = parsed.length;
            const last = n > 0 ? parsed.charCodeAt(n - 1) : 0;
            return last >= 0xd800 && last <= 0xdbff ? parsed.slice(0, n - 1) : parsed;
        } catch {
            cut = safeUtf8End(raw, cut - 1);
        }
    }
    return null;
}

/**
 * A scalar that does not fit. A string yields a leading verbatim excerpt plus a
 * marker; anything else yields the marker alone, because a truncated number is
 * not a number and emitting one would be a fabricated value.
 *
 * The pair is emitted as `[excerpt, marker]` rather than as one concatenated
 * string on purpose. A shortened string that still LOOKS like a string is the
 * dangerous form — a reader compares it against the source, sees a prefix
 * match, and concludes it has the value. The two-element shape makes the
 * truncation impossible to miss, keeps the marker flush-left so it matches
 * MARKER_RE, and the envelope still reports `kind: "string"`.
 */
function scalarPreview(ctx: Ctx, span: RenderSpan, allot: number): Rendered | null {
    const isString = span.kind === 'string';
    const from = isString ? span.start + 1 : span.start;
    const to = isString ? span.end - 1 : span.end;
    const total = to - from;
    if (total <= 0) return null;

    const markerAt = (shownBytes: number): string => buildMarker({
        head: `bytes ${shownBytes}-${total} of ${total}`,
        detail: null,
        cursor: address('scalar', span.pointer, shownBytes).cursor,
    }, Number.POSITIVE_INFINITY);

    // Reserve against the LONGEST marker this scalar can produce, so the
    // excerpt is sized before either string exists.
    const reserve = jsonStringChars(markerAt(total));
    const record = (shownBytes: number): void => {
        ctx.omissions.push({
            of: 'bytes',
            pointer: span.pointer,
            count: total - shownBytes,
            total,
            span: [from + shownBytes, to],
            cursor: address('scalar', span.pointer, shownBytes).cursor,
            reason: 'budget',
        });
    };

    if (isString) {
        // 2 brackets + 1 comma for the wrapper, then quotes on the excerpt.
        const room = allot - 3 - reserve - 2;
        const rawMax = Math.min(SCALAR_PREVIEW_BYTES, room, MAX_SLICE_BYTES);
        if (rawMax >= 1) {
            const raw = ctx.resolver.source.slice(from, Math.min(to, from + rawMax));
            const text = decodeStringPrefix(raw, rawMax);
            if (text !== null && text.length > 0) {
                // How many source bytes the excerpt actually consumed, so the
                // marker and the omission name the same boundary.
                const usedBytes = Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
                const marker = markerAt(usedBytes);
                const value = [text, marker];
                const chars = estimateChars(value);
                if (chars <= allot) {
                    record(usedBytes);
                    return { value, chars };
                }
            }
        }
    }

    const bare = markerAt(0);
    const chars = jsonStringChars(bare);
    if (chars > allot) return null;
    record(0);
    return { value: bare, chars };
}

/**
 * The whole subtree withheld, as one self-identifying marker in the slot the
 * value would have occupied. Preferred over an empty `[]` or `{}` whenever it
 * fits, because an empty container looks like content and a marker cannot be
 * mistaken for any.
 */
function subtreeMarker(ctx: Ctx, span: RenderSpan, allot: number, reason: 'budget' | 'depth'): Rendered | null {
    const bytes = span.end - span.start;
    const count = span.count >= 0 ? span.count : establishCount(ctx, span);
    const unit = span.kind === 'object' ? 'keys' : 'elements';
    const detail = count >= 0 && (span.kind === 'object' || span.kind === 'array')
        ? `${count} ${unit}, ${bytes} bytes`
        : `${bytes} bytes`;
    const cursor = address('read', span.pointer, 0).cursor;
    const marker = buildMarker({
        head: `subtree at ${markerSafe(span.pointer === '' ? '/' : span.pointer)}`,
        detail,
        cursor,
    }, allot);
    const chars = jsonStringChars(marker);
    if (chars > allot) return null;
    ctx.omissions.push({
        of: reason === 'depth' ? 'depth' : (span.kind === 'object' ? 'keys' : span.kind === 'array' ? 'elements' : 'bytes'),
        pointer: span.pointer,
        count: reason === 'depth' ? Math.max(count, 0) : (span.kind === 'object' || span.kind === 'array' ? Math.max(count, 0) : bytes),
        total: reason === 'depth' ? Math.max(count, 0) : (span.kind === 'object' || span.kind === 'array' ? Math.max(count, 0) : bytes),
        span: [span.start, span.end],
        cursor,
        reason,
    });
    return { value: marker, chars };
}

/** Half-open ordinal ranges of `[0, to)` that no taken ordinal covers. */
function runsOf(taken: readonly number[], to: number): Array<readonly [number, number]> {
    const runs: Array<readonly [number, number]> = [];
    let cur = 0;
    for (const o of taken) {
        if (o >= to) break;
        if (o > cur) runs.push([cur, o] as const);
        cur = o + 1;
    }
    if (cur < to) runs.push([cur, to] as const);
    return runs;
}

/**
 * Members hoisted ahead of document order because they contain a focus byte —
 * a search hit position. `locate` maps the raw offset to the deepest node that
 * contains it; the direct child of THIS container is that pointer's next
 * reference token, which is the ordinal or the member name we need.
 */
function focusOrdinals(ctx: Ctx, span: RenderSpan, node: StrideNode): Member[] {
    if (ctx.focus.length === 0) return [];
    const prefix = `${span.pointer}/`;
    const seen = new Set<string>();
    const out: Member[] = [];
    for (const at of ctx.focus) {
        if (out.length >= FOCUS_MEMBER_CAP) break;
        if (at < span.start || at >= span.end) continue;
        let token: string;
        try {
            const located = ctx.resolver.locate(at);
            if (!located.pointer.startsWith(prefix)) continue;
            const rest = located.pointer.slice(prefix.length);
            const slash = rest.indexOf('/');
            token = slash < 0 ? rest : rest.slice(0, slash);
        } catch {
            continue;
        }
        if (seen.has(token)) continue;
        seen.add(token);
        try {
            const m = span.kind === 'array'
                ? ctx.resolver.memberByIndex(node, tokenToIndex(token))
                : ctx.resolver.memberByKey(node, unescapeToken(token));
            if (m !== null) out.push(m);
        } catch {
            // A focus offset that no longer resolves is a stale hit, not a
            // failure of this render: fall back to document order for it.
            continue;
        }
    }
    out.sort((a, b) => a.ordinal - b.ordinal);
    return out;
}

/** What a container render produced, before it is assembled into a value. */
interface Split {
    readonly value: unknown;
    readonly chars: number;
    readonly shown: readonly [number, number];
}

function renderContainer(
    ctx: Ctx,
    span: RenderSpan,
    allot: number,
    depth: number,
    windowStart: number,
    windowLimit: number,
): Split | null {
    const isObject = span.kind === 'object';
    const count = establishCount(ctx, span);
    // Without a trustworthy total no honest marker can be written, so the
    // container is not split at all; the caller falls back to a whole-subtree
    // marker. Unreachable for any span the resolver produced.
    if (count < 0) return null;

    const node: StrideNode = {
        pointer: span.pointer,
        kind: span.kind,
        start: span.start,
        end: span.end,
        depth,
        parent: parentPointer(span.pointer),
        count,
    };
    const windowEnd = Math.min(count, windowStart + windowLimit);

    // ── marker reserve ────────────────────────────────────────────────────
    // Sized against the LONGEST marker this container can emit, computed from
    // its own bounds before any member is looked at, so the walk below can
    // spend against a reserve that is already paid for.
    const lastOrdinal = Math.max(count - 1, 0);
    const worst = buildMarker({
        head: isObject ? `${count} of ${count} keys` : `elements ${lastOrdinal}-${lastOrdinal} of ${count}`,
        detail: isObject ? `next ${'x'.repeat(MARKER_NAME_CHARS)}` : `bytes ${span.end}-${span.end}`,
        cursor: address('read', span.pointer, lastOrdinal).cursor,
    }, Number.POSITIVE_INFINITY);
    const oneMarker = jsonStringChars(worst);
    const strideKeyChars = jsonStringChars(STRIDE_KEY);
    const markerCost = (runs: number): number => {
        if (runs <= 0) return 0;
        // An object carries every marker under the one reserved key: a single
        // string, or an array of them when focus leaves more than one gap.
        if (isObject) return strideKeyChars + 2 + (runs === 1 ? oneMarker : 2 + runs * oneMarker + (runs - 1));
        return runs * (oneMarker + 1);
    };

    const taken: Slot[] = [];
    const takenOrd: number[] = [];
    let spent = 2;                                  // the two brackets
    let reserve = 0;
    /** Fetched but not shown, keyed by ordinal — the source of marker names. */
    const seenNames = new Map<number, string>();

    const push = (m: Member, value: unknown, chars: number, overhead: number): void => {
        taken.push({ ordinal: m.ordinal, key: m.key, start: m.start, end: m.end, value, chars });
        takenOrd.push(m.ordinal);
        takenOrd.sort((a, b) => a - b);
        spent += overhead + chars;
    };
    const overheadOf = (m: Member): number =>
        (isObject ? jsonStringChars(m.key ?? '') + 1 : 0) + (taken.length > 0 ? 1 : 0);

    // ── stage 1: focus-hoisted members ────────────────────────────────────
    // Taken first so that a record trimmed to fit keeps the parts a search
    // actually matched. Emission stays in document order; only selection
    // priority changes.
    for (const m of focusOrdinals(ctx, span, node)) {
        if (m.ordinal < windowStart || m.ordinal >= windowEnd) continue;
        if (isObject && m.key === STRIDE_KEY) continue;
        const overhead = overheadOf(m);
        const nextReserve = markerCost(runsOf([...takenOrd, m.ordinal].sort((a, b) => a - b), count).length);
        const room = allot - spent - nextReserve - overhead;
        if (room < MIN_MEMBER_CHARS) continue;
        const sub = renderValue(ctx, spanOfMember(span, m), room, depth + 1);
        if (sub === null) continue;
        reserve = nextReserve;
        push(m, sub.value, sub.chars, overhead);
    }
    // Adding members contiguously from the left edge of a gap can only close
    // gaps, never split one, so the reserve fixed here is an upper bound for
    // the whole of stage 2.
    reserve = markerCost(runsOf(takenOrd, count).length);

    // ── stage 2: document order from the window start ─────────────────────
    let cursorOrd = windowStart;
    let fetched = windowStart;
    let batch: Member[] = [];
    let batchAt = 0;
    let exhausted = false;
    let stalled: Member | null = null;

    while (cursorOrd < windowEnd) {
        if (batchAt >= batch.length) {
            if (exhausted) break;
            batch = ctx.resolver.members(node, fetched, Math.min(MEMBER_BATCH, windowEnd - fetched));
            batchAt = 0;
            if (batch.length === 0) break;
            fetched += batch.length;
            if (batch.length < MEMBER_BATCH) exhausted = true;
        }
        const m = batch[batchAt];
        if (m === undefined) { batchAt++; continue; }
        batchAt++;
        cursorOrd = m.ordinal + 1;
        if (m.key !== null) seenNames.set(m.ordinal, m.key);
        if (takenOrd.includes(m.ordinal)) continue;

        // The reserved key is never document content. Showing a member
        // literally named `__stride` would make the payload ambiguous — no
        // reader could tell metadata from content — so it is always reported
        // as an addressed omission instead. Reason 'page' rather than 'budget'
        // because raising the budget will never reveal it; fetching its own
        // pointer will, and that is exactly what the cursor addresses.
        if (isObject && m.key === STRIDE_KEY) {
            ctx.omissions.push({
                of: 'keys',
                pointer: span.pointer,
                count: 1,
                range: [m.ordinal, m.ordinal + 1],
                total: count,
                span: [m.start, m.end],
                cursor: address('read', childPointer(span.pointer, STRIDE_KEY), 0).cursor,
                reason: 'page',
            });
            takenOrd.push(m.ordinal);
            takenOrd.sort((a, b) => a - b);
            reserve = markerCost(runsOf(takenOrd, count).length);
            continue;
        }

        const overhead = overheadOf(m);
        const room = allot - spent - reserve - overhead;
        const fits = verbatim(ctx, spanOfMember(span, m), room);
        if (fits === null) { stalled = m; break; }
        push(m, fits.value, fits.chars, overhead);
    }

    // ── stage 3: spend what is left on the member that stalled the walk ───
    // This is where a giant first member gets opened up instead of skipped:
    // proportional allocation by byte size, with the remainder going to the
    // largest thing that could not be taken whole.
    if (stalled !== null) {
        const m = stalled;
        const overhead = overheadOf(m);
        const room = allot - spent - reserve - overhead;
        if (room >= MIN_MEMBER_CHARS) {
            const sub = renderValue(ctx, spanOfMember(span, m), room, depth + 1);
            if (sub !== null) push(m, sub.value, sub.chars, overhead);
        }
    }

    if (taken.length === 0) return null;
    taken.sort((a, b) => a.ordinal - b.ordinal);
    return assemble(ctx, span, allot, count, taken, takenOrd, seenNames, windowStart, windowEnd, spent, isObject);
}
