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
import { childPointer, indexPointer, lastToken, parentPointer, tokenToIndex, unescapeToken } from './pointer.js';

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
 *
 * Iterative, over an explicit stack, for the same reason the scanner is: V8's
 * `JSON.parse` accepts nesting far deeper than a recursive walk of the result
 * survives. Measured on this Node — `JSON.parse` succeeds at 30,000 levels
 * while a recursive measure of the same value throws `RangeError` by 12,000 —
 * so a recursive version turns a document that fits the budget into a stack
 * overflow, past the reach of every guard in this file.
 */
export function estimateChars(value: unknown): number {
    let total = 0;
    const pending: unknown[] = [value];
    while (pending.length > 0) {
        const v = pending.pop();
        if (v === null) { total += 4; continue; }
        switch (typeof v) {
            case 'boolean': total += v ? 4 : 5; continue;
            case 'number': total += Number.isFinite(v) ? String(v).length : 4; continue;
            case 'string': total += jsonStringChars(v); continue;
            case 'object': break;
            default: total += 4; continue;      // undefined/function/symbol -> `null`
        }
        if (Array.isArray(v)) {
            // Brackets plus one comma between each pair of elements. An element
            // stringify would drop still occupies a slot, as `null`.
            total += 2 + (v.length > 0 ? v.length - 1 : 0);
            for (const item of v) pending.push(item);
            continue;
        }
        total += 2;
        let members = 0;
        for (const [k, member] of Object.entries(v as Record<string, unknown>)) {
            // Exactly what stringify omits from an object: no slot, no comma.
            if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue;
            members++;
            total += jsonStringChars(k) + 1;
            pending.push(member);
        }
        total += members > 0 ? members - 1 : 0;
    }
    return total;
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
    // markerSafe is idempotent — it produces no `]` and no `|` — so applying it
    // here as well as at the call sites that build free text costs nothing and
    // makes the escape unskippable.
    const head = markerSafe(parts.head);
    const detail = parts.detail === null ? null : markerSafe(parts.detail);
    const full = detail === null
        ? `[TRUNCATED: ${head} | cursor ${parts.cursor}]`
        : `[TRUNCATED: ${head} | ${detail} | cursor ${parts.cursor}]`;
    const short = `[TRUNCATED: ${head} | cursor ${parts.cursor}]`;
    // MARKER_RE is how the rest of the repository recognises an omission, so a
    // marker is CHECKED against it rather than assumed to match. A failure here
    // means some field escaped markerSafe, and a marker nothing can parse is
    // strictly worse than a coarser one that parses; the last form is built
    // only from a base64url cursor, so it matches by construction.
    if (jsonStringChars(full) <= maxChars && MARKER_RE.test(full)) return full;
    if (MARKER_RE.test(short)) return short;
    return `[TRUNCATED: cursor ${parts.cursor}]`;
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
    /**
     * Ceiling on what a single focus-hoisted member may spend. `renderNode`
     * sets it to the whole allotment, because there nothing competes with the
     * hit. `renderWindow` sets it to the target's share, because there the
     * siblings have a claim the target must not be allowed to eat.
     */
    readonly focusAllot: number;
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
 * Whether a parsed value may be emitted as it stands. Two things disqualify it,
 * and both are refusals rather than repairs: the container is split instead, and
 * the walk deals with what a single slice could not.
 *
 * THE RESERVED KEY. The payload's `__stride` member is STRIDE's own,
 * unconditionally — a payload in which it might be either metadata or content is
 * a payload no reader can interpret. Splitting lets the walk withhold the
 * colliding member and address it at its own pointer. Without this gate the
 * collision is handled correctly only when the budget forces a split, which
 * means the more budget a caller gives, the more ambiguous the answer gets.
 *
 * NESTING DEPTH. `JSON.parse` accepts far deeper nesting than `JSON.stringify`
 * can then write: measured on this runtime, parse succeeds at 20,000 levels
 * while stringify throws RangeError somewhere between 4,000 and 6,000. Every
 * caller has to serialise the payload to send it, so a value STRIDE cannot
 * stringify is worse than one that is merely too large — the caller crashes
 * instead of receiving a bounded answer. MAX_RENDER_DEPTH is the bound the walk
 * already honours, and this is what makes the verbatim path honour it too: it is
 * the one path that can reach a depth the walk never entered, because it emits a
 * whole subtree without descending it.
 *
 * The scan is over a value the byte-length guard has already bounded by the
 * allotment, so it costs at most the budget, never the document. Iterative for
 * the same reason as `estimateChars`.
 */
function emittable(root: unknown, allowedDepth: number): boolean {
    if (allowedDepth < 0) return false;
    const values: unknown[] = [root];
    const depths: number[] = [0];
    while (values.length > 0) {
        const value = values.pop();
        const depth = depths.pop();
        // The two stacks are pushed and popped in step, so a missing depth
        // cannot happen; refusing is the safe answer if it ever did.
        if (depth === undefined) return false;
        if (value === null || typeof value !== 'object') continue;
        if (depth >= allowedDepth) return false;
        if (Array.isArray(value)) {
            for (const item of value) { values.push(item); depths.push(depth + 1); }
            continue;
        }
        const record = value as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(record, STRIDE_KEY)) return false;
        for (const member of Object.values(record)) { values.push(member); depths.push(depth + 1); }
    }
    return true;
}

/**
 * The verbatim path, and the only place in STRIDE where a document value is
 * produced. Guarded by BYTE LENGTH before the slice is taken, so an oversized
 * span is never materialised; measured exactly afterwards, because a number is
 * the one JSON form whose serialisation can be longer than its source bytes.
 */
function verbatim(ctx: Ctx, span: RenderSpan, allot: number, depth: number): Rendered | null {
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
    if (!emittable(value, MAX_RENDER_DEPTH - depth)) return null;
    const chars = estimateChars(value);
    return chars <= allot ? { value, chars } : null;
}

/** Largest cut of `buf` at or below `limit` that does not split a UTF-8 sequence. */
function safeUtf8End(buf: Buffer, limit: number): number {
    const end = limit < 0 ? 0 : (limit > buf.length ? buf.length : limit);
    if (end === 0) return 0;
    // Walk back to the last sequence LEAD byte at or before the cut, then keep
    // that sequence only if every one of its bytes is inside the cut.
    //
    // Inspecting the byte AT the cut is not enough, and that is the whole bug
    // this guards: when `buf` is itself a slice taken out of a longer string,
    // the cut lands on the end of the buffer, so there is no continuation byte
    // sitting there to reveal a split — and `toString('utf8')` then turns the
    // half sequence into U+FFFD, putting a character in the payload that is not
    // in the document.
    let i = end - 1;
    let back = 0;
    while (i > 0 && ((buf[i] ?? 0) & 0xc0) === 0x80 && back < 3) { i--; back++; }
    const lead = buf[i] ?? 0;
    // Still a continuation byte after backing off the longest run UTF-8 allows:
    // the bytes are malformed, so none of the run can be trusted.
    if ((lead & 0xc0) === 0x80) return i;
    const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    return i + need <= end ? end : i;
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
 * Byte range of a scalar's VALUE: inside the quotes for a string, the whole span
 * otherwise.
 *
 * Computed in one place because four things have to agree about where the value
 * starts — the excerpt's first byte, the marker's range, the omission's span and
 * the envelope's continuation — and for a string that start is one byte past the
 * node's own span. Four separate `kind === 'string' ? start + 1 : start` sites
 * are four chances for one of them to drift by that quote.
 */
function scalarValueRange(span: RenderSpan): readonly [number, number] {
    return span.kind === 'string' ? [span.start + 1, span.end - 1] : [span.start, span.end];
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
function scalarPreview(ctx: Ctx, span: RenderSpan, allot: number, fromByte = 0): Rendered | null {
    const isString = span.kind === 'string';
    const [base, to] = scalarValueRange(span);
    const total = to - base;
    if (total <= 0) return null;

    // Every byte count here is absolute — measured from the start of the VALUE,
    // never from this excerpt. `fromByte` is what makes the `scalar` cursor an
    // address instead of a label: without it a truncated scalar handed back its
    // own continuation and was served the same head bytes again. Measured on a
    // 1,750-byte string at budget 600: the omission declared 1,305 bytes
    // withheld from span [451,1756] and its cursor resumed at 445, but the view
    // at offset 445 was byte-identical to the view at 0 and its cursor pointed
    // at 445 once more. The walk could not terminate and those 1,305 bytes were
    // unreachable while an omission claimed they were addressed, which is I4
    // failing in the one direction a caller cannot detect.
    const consumed = Math.min(Math.max(0, Math.floor(fromByte)), total);
    const start = base + consumed;

    const markerAt = (shownBytes: number): string => buildMarker({
        head: `bytes ${shownBytes}-${total} of ${total}`,
        detail: null,
        cursor: address('scalar', span.pointer, shownBytes).cursor,
    }, Number.POSITIVE_INFINITY);

    // Reserve against the LONGEST marker this scalar can produce, so the
    // excerpt is sized before either string exists.
    const reserve = jsonStringChars(markerAt(total));
    const record = (shownBytes: number): void => {
        // An omission of zero bytes addresses nothing, and recording one would
        // put a `next` on a view with no tail left — the same non-terminating
        // walk from the other end.
        if (shownBytes >= total) return;
        ctx.omissions.push({
            of: 'bytes',
            pointer: span.pointer,
            count: total - shownBytes,
            total,
            span: [base + shownBytes, to],
            cursor: address('scalar', span.pointer, shownBytes).cursor,
            reason: 'budget',
        });
    };

    // A caller resuming at or past the end has already been given every byte.
    // The marker says so and carries no omission, which ends the walk; an empty
    // string here would read as a value that is empty.
    if (consumed >= total) {
        const done = markerAt(total);
        const doneChars = jsonStringChars(done);
        return doneChars > allot ? null : { value: done, chars: doneChars };
    }

    if (isString) {
        // 2 brackets + 1 comma for the wrapper, then quotes on the excerpt.
        const room = allot - 3 - reserve - 2;
        // Capped at what is left of the value, so `usedBytes` can never count
        // the closing quote as content.
        const rawMax = Math.min(SCALAR_PREVIEW_BYTES, room, MAX_SLICE_BYTES, total - consumed);
        if (rawMax >= 1) {
            const raw = ctx.resolver.source.slice(start, Math.min(to, start + rawMax));
            const text = decodeStringPrefix(raw, rawMax);
            if (text !== null && text.length > 0) {
                // How many source bytes the excerpt actually consumed, so the
                // marker and the omission name the same boundary. Added to what
                // earlier views consumed, because the marker's range is absolute.
                const usedBytes = Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
                const shownEnd = consumed + usedBytes;
                const marker = markerAt(shownEnd);
                const value = [text, marker];
                const chars = estimateChars(value);
                if (chars <= allot) {
                    record(shownEnd);
                    return { value, chars };
                }
            }
        }
    }

    const bare = markerAt(consumed);
    const chars = jsonStringChars(bare);
    if (chars > allot) return null;
    record(consumed);
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
        // The pointer goes in bare, as the marker form specifies — except at
        // the document root, where the pointer IS the empty string and printing
        // it bare would leave the field blank. RFC 6901 writes that pointer as
        // `""`, and `/` (which this used to print) is not a synonym for it: `/`
        // is the member NAMED the empty string, a different node entirely.
        head: `subtree at ${markerSafe(span.pointer === '' ? '""' : span.pointer)}`,
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

/** Index of the first entry of the ascending `taken` at or after `ordinal`. */
function lowerBound(taken: readonly number[], ordinal: number): number {
    let lo = 0;
    let hi = taken.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const at = taken[mid];
        // A hole below `taken.length` cannot occur; treating one as +infinity
        // keeps the search inside [lo, hi) rather than reading past the end.
        if (at === undefined || at >= ordinal) hi = mid; else lo = mid + 1;
    }
    return lo;
}

/**
 * What the omitted-run count over `[0, count)` becomes once `ordinal` joins the
 * ascending `taken` set. The marker reserve has to be re-derived before EVERY
 * tentative spend, and re-deriving it with `runsOf` is O(taken) — which would
 * make the bookkeeping alone O(members squared) on a wide container.
 */
function runsIfAdded(taken: readonly number[], runs: number, ordinal: number, count: number): number {
    if (ordinal < 0 || ordinal >= count) return runs;
    const i = lowerBound(taken, ordinal);
    const below = taken[i - 1];
    const above = taken[i];
    if (above === ordinal) return runs;
    // The gap `ordinal` falls in runs from one past the nearest shown member
    // below it to the nearest shown member above it. Where there is none, 0 and
    // `count` are not conveniences — they ARE the ends of the ordinal range.
    const gapFrom = below === undefined ? 0 : below + 1;
    const gapTo = above === undefined ? count : above;
    const atLeft = ordinal === gapFrom;
    const atRight = ordinal + 1 === gapTo;
    if (atLeft && atRight) return runs - 1;             // the gap closes
    if (atLeft || atRight) return runs;                 // the gap shrinks
    return runs + 1;                                    // the gap splits in two
}

/** Insert into an ascending array, keeping it ascending. */
function insertTaken(taken: number[], ordinal: number): void {
    const i = lowerBound(taken, ordinal);
    if (i === taken.length) { taken.push(ordinal); return; }
    // Only focus-hoisted ordinals — at most FOCUS_MEMBER_CAP of them — can sit
    // above an insertion point, because the document-order walk that follows
    // them ascends. So this splice moves a bounded number of entries however
    // wide the container is.
    taken.splice(i, 0, ordinal);
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
    // A member literally named `__stride` is withheld at any budget (see the
    // walk below), and its marker addresses the member's OWN pointer — which is
    // longer than this container's, so its cursor is longer than `worst`'s. One
    // reserved slot has to cover whichever of the two forms is larger.
    const worstReserved = isObject
        ? buildMarker({
            head: `${count} of ${count} keys`,
            detail: `next ${STRIDE_KEY}`,
            cursor: address('read', childPointer(span.pointer, STRIDE_KEY), 0).cursor,
        }, Number.POSITIVE_INFINITY)
        : '';
    const oneMarker = Math.max(jsonStringChars(worst), isObject ? jsonStringChars(worstReserved) : 0);
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
    /**
     * Omitted runs over `[0, count)`, maintained incrementally. An empty
     * container has nothing to omit; anything else starts as one whole gap.
     */
    let runs = count > 0 ? 1 : 0;
    let spent = 2;                                  // the two brackets
    /** Fetched but not shown, keyed by ordinal — the source of marker names. */
    const seenNames = new Map<number, string>();

    const push = (m: Member, value: unknown, chars: number, overhead: number, nextRuns: number): void => {
        taken.push({ ordinal: m.ordinal, key: m.key, start: m.start, end: m.end, value, chars });
        insertTaken(takenOrd, m.ordinal);
        runs = nextRuns;
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
        const nextRuns = runsIfAdded(takenOrd, runs, m.ordinal, count);
        const room = Math.min(allot - spent - markerCost(nextRuns) - overhead, ctx.focusAllot);
        if (room < MIN_MEMBER_CHARS) continue;
        const sub = renderValue(ctx, spanOfMember(span, m), room, depth + 1);
        if (sub === null) continue;
        push(m, sub.value, sub.chars, overhead, nextRuns);
    }

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
            // Names are harvested for the WHOLE batch, not member by member as
            // the loop consumes it. The batch is already in memory, so this is
            // free — and without it the walk stalls before reading the name of
            // the very member its marker then has to announce, which is how a
            // `next id,name,payload` field silently degrades to nothing.
            for (const seen of batch) {
                if (seen.key !== null) seenNames.set(seen.ordinal, seen.key);
            }
            fetched += batch.length;
            if (batch.length < MEMBER_BATCH) exhausted = true;
        }
        const m = batch[batchAt];
        if (m === undefined) { batchAt++; continue; }
        batchAt++;
        cursorOrd = m.ordinal + 1;
        if (takenOrd[lowerBound(takenOrd, m.ordinal)] === m.ordinal) continue;

        // The reserved key is never document content. Showing a member
        // literally named `__stride` would make the payload ambiguous — no
        // reader could tell metadata from content — so it is skipped, which
        // leaves it in the omitted runs. `assemble` recognises a run made only
        // of such members and gives it a marker and a cursor addressing the
        // member's OWN pointer, which is the only address that can ever
        // retrieve it. Leaving it in the runs rather than recording a separate
        // omission is what keeps the withheld-key arithmetic single-counted:
        // one region, one marker, one omission.
        if (isObject && m.key === STRIDE_KEY) continue;

        const overhead = overheadOf(m);
        const nextRuns = runsIfAdded(takenOrd, runs, m.ordinal, count);
        const room = allot - spent - markerCost(nextRuns) - overhead;
        const fits = room < MIN_MEMBER_CHARS ? null : verbatim(ctx, spanOfMember(span, m), room, depth + 1);
        if (fits === null) { stalled = m; break; }
        push(m, fits.value, fits.chars, overhead, nextRuns);
    }

    // ── stage 3: spend what is left on the member that stalled the walk ───
    // This is where a giant first member gets opened up instead of skipped:
    // stage 2 only ever takes a member WHOLE, so the one that stalled the walk
    // is by definition the largest thing left, and it gets the remainder to
    // split internally rather than being dropped for being too big.
    if (stalled !== null) {
        const m = stalled;
        const overhead = overheadOf(m);
        const nextRuns = runsIfAdded(takenOrd, runs, m.ordinal, count);
        const room = allot - spent - markerCost(nextRuns) - overhead;
        if (room >= MIN_MEMBER_CHARS) {
            const sub = renderValue(ctx, spanOfMember(span, m), room, depth + 1);
            if (sub !== null) push(m, sub.value, sub.chars, overhead, nextRuns);
        }
    }

    if (taken.length === 0) return null;
    taken.sort((a, b) => a.ordinal - b.ordinal);
    return assemble(ctx, span, allot, count, taken, takenOrd, seenNames, windowStart, windowEnd, spent, isObject);
}

/**
 * Turn the members a walk took, plus the gaps it left, into the container value
 * and its exact cost.
 *
 * Every gap produces BOTH forms of the same numbers, because two audiences read
 * an omission and need different things: a flush-left `[TRUNCATED: ...]` string
 * standing where the content would have been, for whoever reads the payload,
 * and a `StrideOmission` carrying the span and the cursor, for whoever acts on
 * it. Neither is derived from the other — both are derived from the run.
 */
function assemble(
    ctx: Ctx,
    span: RenderSpan,
    allot: number,
    count: number,
    taken: readonly Slot[],
    takenOrd: readonly number[],
    seenNames: ReadonlyMap<number, string>,
    windowStart: number,
    windowEnd: number,
    spent: number,
    isObject: boolean,
): Split | null {
    const first = taken[0];
    const last = taken[taken.length - 1];
    if (first === undefined || last === undefined) return null;

    const gaps = runsOf(takenOrd, count);

    /**
     * Byte bounds of an omitted run: from the end of the last shown member
     * below it to the start of the first shown member above it, falling back to
     * the container's own brackets at the ends. That is exactly the stretch of
     * source this payload does not carry, which is what the marker's `bytes a-b`
     * field and the omission's `span` both have to name.
     */
    const runBytes = (from: number, to: number): readonly [number, number] => {
        let lo = span.start + 1;
        let hi = span.end - 1;
        for (const s of taken) {
            if (s.ordinal < from) { lo = s.end; continue; }
            if (s.ordinal >= to) { hi = s.start; break; }
        }
        return [lo, hi < lo ? lo : hi];
    };

    const markers: string[] = [];
    for (const [from, to] of gaps) {
        const width = to - from;
        const [lo, hi] = runBytes(from, to);

        // Names for the marker's `next ...` field, and the test for a run made
        // only of the reserved name. A run wider than the number of names the
        // walk actually fetched cannot be all-`__stride`, so this never walks a
        // hundred-thousand-element gap to find out.
        let reserved = isObject && width <= seenNames.size;
        const names: string[] = [];
        // Once the run is known not to be all-reserved, only the first few
        // ordinals matter — nameList elides past MARKER_NAME_CHARS anyway — so
        // the probe stops there rather than reading a 100,000-wide gap it has
        // no use for. While it is still a candidate the run must be scanned in
        // full, which the width test above already bounded by the number of
        // names the walk actually fetched.
        const probe = from + MARKER_NAME_CHARS;
        for (let o = from; o < to; o++) {
            if (!reserved && o >= probe) break;
            const name = seenNames.get(o);
            if (name === undefined) { reserved = false; continue; }
            if (name !== STRIDE_KEY) reserved = false;
            if (names.length < MARKER_NAME_CHARS) names.push(name);
        }

        const cursor = reserved
            ? address('read', childPointer(span.pointer, STRIDE_KEY), 0).cursor
            : address('read', span.pointer, from).cursor;
        // The reserve was already sized against the longest marker this
        // container can emit, so there is nothing here to squeeze.
        markers.push(buildMarker({
            head: isObject ? `${width} of ${count} keys` : `elements ${from}-${to - 1} of ${count}`,
            detail: isObject ? (reserved ? `next ${STRIDE_KEY}` : nameList(names)) : `bytes ${lo}-${hi}`,
            cursor,
        }, Number.POSITIVE_INFINITY));

        // 'page' means a larger budget will not reveal it. True of a run the
        // caller's own offset/limit put out of reach, and true of the reserved
        // name, which is reachable only at its own pointer.
        const outOfPage = to <= windowStart || from >= windowEnd;
        ctx.omissions.push({
            of: isObject ? 'keys' : 'elements',
            pointer: span.pointer,
            count: width,
            range: [from, to],
            total: count,
            span: [lo, hi],
            cursor,
            reason: reserved || outOfPage ? 'page' : 'budget',
        });
    }

    // Mirrors markerCost with the real marker lengths instead of the worst case.
    let markerChars = 0;
    if (markers.length > 0) {
        let inner = 0;
        for (const m of markers) inner += jsonStringChars(m);
        markerChars = isObject
            ? jsonStringChars(STRIDE_KEY) + 2 + (markers.length === 1 ? inner : 2 + inner + (markers.length - 1))
            : inner + markers.length;
    }

    let value: unknown;
    if (isObject) {
        const out: Record<string, unknown> = {};
        // The scanner always hands an object member its name, so the fallback
        // is unreachable; `''` is nonetheless the only name that costs exactly
        // what the walk already charged for this slot.
        for (const s of taken) out[s.key ?? ''] = s.value;
        const only = markers[0];
        if (markers.length === 1 && only !== undefined) out[STRIDE_KEY] = only;
        else if (markers.length > 1) out[STRIDE_KEY] = markers;
        value = out;
    } else {
        // Runs and shown members partition [0, count), so walking the two in
        // lockstep puts every marker at the ordinal its elements occupied —
        // which is what stops a truncated array from reading as a complete one.
        const out: unknown[] = [];
        let gi = 0;
        let ti = 0;
        let at = 0;
        while (at < count) {
            const gap = gaps[gi];
            if (gap !== undefined && gap[0] === at) {
                const marker = markers[gi];
                if (marker !== undefined) out.push(marker);
                at = gap[1];
                gi++;
                continue;
            }
            const slot = taken[ti];
            if (slot === undefined || slot.ordinal !== at) break;
            out.push(slot.value);
            ti++;
            at++;
        }
        value = out;
    }

    // `spent` is the walk's exact running cost of what it took, so
    // `spent + markerChars` is this container's cost before duplicate member
    // names are folded away — which an object literal and `JSON.parse` both do,
    // identically. The measured value can therefore only be smaller, and it is
    // the number reported. The bound is what makes I3 arithmetic rather than
    // hopeful: every spend was checked against `allot` minus a reserve that
    // was itself sized against the worst-case markers, so neither test below
    // can fire. They are here so that if one ever did, the container would fail
    // closed to its caller's whole-subtree marker instead of overrunning.
    const chars = estimateChars(value);
    if (chars > allot || spent + markerChars > allot) return null;
    return { value, chars, shown: [first.ordinal, last.ordinal + 1] };
}

/**
 * The allocator's dispatcher, and the single decision point for I3: a span is
 * either small enough to emit whole, or it is split, or it is named by a marker.
 * Nothing else can happen to it, and the choice is made from the span's byte
 * length before any of its bytes are touched.
 */
function renderValue(ctx: Ctx, span: RenderSpan, allot: number, depth: number): Rendered | null {
    if (allot < MIN_MEMBER_CHARS) return null;
    // Depth is checked before the budget, because a budget large enough to pay
    // for 50,000 levels of nesting would otherwise let this recursive walk
    // reach the stack limit. A marker costs one frame; the subtree costs many.
    if (depth >= MAX_RENDER_DEPTH) return subtreeMarker(ctx, span, allot, 'depth');

    const whole = verbatim(ctx, span, allot, depth);
    if (whole !== null) return whole;

    if (span.kind === 'object' || span.kind === 'array') {
        const split = renderContainer(ctx, span, allot, depth, 0, Number.MAX_SAFE_INTEGER);
        if (split !== null) return { value: split.value, chars: split.chars };
        return subtreeMarker(ctx, span, allot, 'budget');
    }
    const preview = scalarPreview(ctx, span, allot);
    if (preview !== null) return preview;
    return subtreeMarker(ctx, span, allot, 'budget');
}

// ── the exported renders ──────────────────────────────────────────────────

/** What a caller asks a render for. */
export interface RenderOptions {
    /** Characters the whole view may occupy, envelope reserve included. */
    readonly budget: number;
    /** First member index to show, for a container. Defaults to 0. */
    readonly offset?: number;
    /** Members to show from `offset`. Absent means as many as the budget buys. */
    readonly limit?: number;
    /**
     * Byte offsets that must stay visible — search hit positions, usually. When
     * a record has to be trimmed, the parts holding the hits are the parts to
     * keep: byte-exact windows at the hit are what measurably lifted downstream
     * success, and a paraphrase of the same region measurably lowered it.
     */
    readonly focus?: readonly number[];
}

/**
 * The budget a view will actually honour. A request below MIN_VIEW_BUDGET is
 * reported back at the floor rather than as the number asked for, because
 * claiming a bound that no valid JSON text can meet would make `chars <= budget`
 * a lie in exactly the case a caller is least able to check.
 */
function viewBudget(requested: number): number {
    if (!Number.isFinite(requested)) return MIN_VIEW_BUDGET;
    const floored = Math.floor(requested);
    return floored < MIN_VIEW_BUDGET ? MIN_VIEW_BUDGET : floored;
}

/**
 * The share of a budget the payload may spend. ENVELOPE_RESERVE is held back
 * because the envelope's own pointers, cursors and hint cost real characters,
 * and a budget that does not reserve for them cannot honour I3 at the boundary.
 */
function payloadAllot(budget: number): number {
    return budget - Math.ceil(budget * ENVELOPE_RESERVE);
}

/**
 * The last resort, when not even a marker fits: record that the whole span was
 * withheld. The payload is then `null` — the one place in STRIDE where a value
 * is not a byte slice, because below one marker's width I2 (valid JSON) and I3
 * (chars <= budget) leave no other option. The omission recorded here is what
 * keeps that a CUED loss rather than a silent one, which is the whole
 * difference: a probe across three models scored 46.7 / 44.4 / 23.3 out of 100
 * at noticing silent mid-task content loss, and mostly caught it when cued.
 */
function recordWholeSpan(ctx: Ctx, span: RenderSpan, count: number): void {
    const isContainer = span.kind === 'object' || span.kind === 'array';
    const bytes = span.end - span.start;
    const size = isContainer ? Math.max(count, 0) : bytes;
    ctx.omissions.push({
        of: isContainer ? (span.kind === 'object' ? 'keys' : 'elements') : 'bytes',
        pointer: span.pointer,
        count: size,
        ...(isContainer ? { range: [0, size] as readonly [number, number] } : {}),
        total: size,
        span: [span.start, span.end],
        cursor: address(isContainer ? 'read' : 'scalar', span.pointer, 0).cursor,
        reason: 'budget',
    });
}

/**
 * The literal next call, phrased as an instruction and placed at the very end
 * of the envelope. Both properties are load-bearing: moving an instruction
 * checklist to the end of a prompt took tool adoption from 0% to 100% in one
 * measured condition, and an elision written as prose in the middle of a
 * payload is documented to be read as decoration — `[..., ... +7 more]` once
 * produced validation code that rejected the seven.
 */
function hintFor(node: StrideNode, omitted: readonly StrideOmission[], next: StrideAddress | null): string {
    const here = JSON.stringify(node.pointer);
    const complete = node.parent === null
        ? `Nothing is withheld: this view is all of ${here}. No further call is needed for this pointer.`
        : `Nothing is withheld: this view is all of ${here}. Call mode "read" with pointer ${JSON.stringify(node.parent)} to see it in context.`;
    if (omitted.length === 0) return complete;

    // The widest withheld BYTE range is the one worth naming. Bytes are the one
    // unit every omission kind shares, so they compare honestly where `count`
    // — keys against elements against bytes — does not.
    let widest: StrideOmission | undefined;
    for (const o of omitted) {
        if (widest === undefined || o.span[1] - o.span[0] > widest.span[1] - widest.span[0]) widest = o;
    }
    if (widest === undefined) return complete;

    const op = widest.of === 'bytes' ? 'scalar' : 'read';
    // For a byte omission the resume point is the count already shown, not a
    // member index; for a member omission it is the first ordinal withheld.
    const resume = widest.of === 'bytes'
        ? widest.total - widest.count
        : (widest.range === undefined ? 0 : widest.range[0]);
    const target = next !== null ? next : { pointer: widest.pointer, offset: resume, cursor: widest.cursor };
    const unit = widest.of === 'depth' ? 'ancestor levels' : widest.of;
    const regions = omitted.length === 1 ? '1 withheld region' : `${omitted.length} withheld regions`;
    return `${widest.count} of ${widest.total} ${unit} under ${JSON.stringify(widest.pointer)} are not in this view `
        + `(${regions} in total). Call mode ${JSON.stringify(op)} with pointer ${JSON.stringify(target.pointer)} `
        + `and offset ${target.offset ?? resume}, or cursor ${JSON.stringify(target.cursor)}, to fetch it.`;
}

/**
 * Render one node into a view that fits `opts.budget`, states its own location,
 * and names every region it did not show.
 *
 * The budget is spent top-down: the node is emitted whole if its byte span fits,
 * otherwise the allotment is divided across its members and the walk recurses.
 * A member that cannot afford a minimal representation becomes an addressed
 * omission rather than a stub, because fewer members shown completely beats all
 * of them shown mutilated — a stub looks like content and an omission cannot.
 */
export function renderNode(resolver: Resolver, node: StrideNode, opts: RenderOptions): StrideView {
    const budget = viewBudget(opts.budget);
    const allot = payloadAllot(budget);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    // No limit means every member the budget can buy, so the ordinal range is
    // unbounded rather than zero.
    const limit = opts.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor(opts.limit));
    const ctx: Ctx = {
        resolver,
        omissions: [],
        focus: opts.focus ?? [],
        focusAllot: allot,
    };
    const span: RenderSpan = {
        pointer: node.pointer,
        kind: node.kind,
        start: node.start,
        end: node.end,
        count: node.count,
    };
    const isContainer = node.kind === 'object' || node.kind === 'array';

    let value: unknown = null;
    let chars = estimateChars(null);
    let shown: readonly [number, number] | null = null;

    // A paged request must never take the verbatim shortcut: the caller asked
    // for a window, and answering with the whole container would ignore it.
    const wholeWindow = offset === 0 && (!isContainer || limit >= node.count);
    const whole = wholeWindow ? verbatim(ctx, span, allot, node.depth) : null;
    if (whole !== null) {
        value = whole.value;
        chars = whole.chars;
        if (isContainer) shown = [0, node.count];
    } else {
        const rendered = isContainer
            ? renderContainer(ctx, span, allot, node.depth, offset, limit)
            : null;
        if (rendered !== null) {
            value = rendered.value;
            chars = rendered.chars;
            shown = rendered.shown;
        } else {
            const fallback = isContainer
                ? subtreeMarker(ctx, span, allot, 'budget')
                : (scalarPreview(ctx, span, allot, offset) ?? subtreeMarker(ctx, span, allot, 'budget'));
            if (fallback !== null) {
                value = fallback.value;
                chars = fallback.chars;
            } else {
                recordWholeSpan(ctx, span, node.count);
            }
        }
    }

    let next: StrideAddress | null = null;
    let prev: StrideAddress | null = null;
    if (shown !== null) {
        const [from, to] = shown;
        if (to < node.count) next = address('read', node.pointer, to);
        // Page backwards by the width this view achieved, so a caller walking
        // back covers the same ground it walked forward.
        if (from > 0) prev = address('read', node.pointer, Math.max(0, from - Math.max(1, to - from)));
    } else if (!isContainer) {
        const [base, valueEnd] = scalarValueRange(span);
        // With no byte omission the view reached the end of the value, so the
        // bytes shown run to the value's own length.
        let shownEnd = valueEnd - base;
        for (const o of ctx.omissions) {
            if (o.of === 'bytes' && o.pointer === node.pointer) {
                shownEnd = o.total - o.count;
                next = address('scalar', node.pointer, shownEnd);
                break;
            }
        }
        // Page backwards by the width this view achieved, mirroring the
        // container arm above, so a caller walking a long scalar back covers
        // the same ground it walked forward. Measured from the position that
        // was actually read rather than the one asked for: an offset past the
        // end is clamped for the read, and a `prev` derived from the raw
        // request would address a byte the value does not have.
        const here = Math.min(offset, valueEnd - base);
        if (here > 0) {
            const width = Math.max(1, shownEnd - here);
            prev = address('scalar', node.pointer, Math.max(0, here - width));
        }
    }
    const parent = node.parent === null ? null : address('read', node.parent, 0);

    const envelope: StrideEnvelope = {
        pointer: node.pointer,
        kind: node.kind,
        span: [node.start, node.end],
        ...(isContainer ? { total: node.count } : {}),
        ...(shown === null ? {} : { shown }),
        omitted: ctx.omissions,
        ...(next === null ? {} : { next }),
        ...(prev === null ? {} : { prev }),
        ...(parent === null ? {} : { parent }),
        hint: hintFor(node, ctx.omissions, next),
    };
    return { data: value, envelope, chars, budget };
}

/** One ancestor of a windowed target, with the address that returns to it. */
interface WindowAncestor {
    readonly pointer: string;
    readonly kind: StrideKind;
    /** Members the ancestor holds, so the caller can see how wide the branch is. */
    readonly total: number;
    readonly cursor: string;
}

/**
 * The ancestor chain, presented root-first because a path reads top-down.
 *
 * Paid for in a different order than it is presented. The document root goes in
 * first however tight the budget: it is the cheapest entry in the chain — the
 * shortest pointer, and therefore the shortest cursor — and it is the one
 * address from which every other is reachable, so a chain that dropped it would
 * leave a caller with no way back to the top. Then nearest-first, because the
 * nearest ancestor is the one that actually locates the target. Levels that do
 * not fit become one `depth` omission rather than a shorter chain nobody was
 * told about; the kept pointers themselves reveal where the gap is, since
 * consecutive entries in a complete chain are always parent and child.
 */
function ancestorChain(ctx: Ctx, node: StrideNode, allot: number): WindowAncestor[] {
    /** Ancestor pointers, nearest first. Ends at `''` for any node with a parent. */
    const pointers: string[] = [];
    let at: string | null = node.parent;
    while (at !== null) {
        pointers.push(at);
        at = parentPointer(at);
    }

    const order: string[] = [];
    const root = pointers[pointers.length - 1];
    if (root !== undefined) order.push(root);
    for (let i = 0; i < pointers.length - 1; i++) {
        const pointer = pointers[i];
        if (pointer !== undefined) order.push(pointer);
    }

    const kept = new Map<string, WindowAncestor>();
    let chars = 2;                                  // the array brackets
    let dropped = 0;
    for (const pointer of order) {
        let resolved: StrideNode;
        try {
            resolved = ctx.resolver.resolve(pointer);
        } catch {
            // An ancestor the resolver cannot reach is not a render failure:
            // the chain is context, and the target has already been located.
            continue;
        }
        const entry: WindowAncestor = {
            pointer,
            kind: resolved.kind,
            total: resolved.count,
            cursor: address('read', pointer, 0).cursor,
        };
        const cost = estimateChars(entry) + (kept.size > 0 ? 1 : 0);
        if (chars + cost > allot) { dropped++; continue; }
        kept.set(pointer, entry);
        chars += cost;
    }
    if (dropped > 0) {
        ctx.omissions.push({
            of: 'depth',
            pointer: node.pointer,
            count: dropped,
            total: dropped + kept.size,
            span: [node.start, node.end],
            cursor: address('window', node.pointer, 0).cursor,
            reason: 'budget',
        });
    }

    const entries: WindowAncestor[] = [];
    for (let i = pointers.length - 1; i >= 0; i--) {
        const pointer = pointers[i];
        if (pointer === undefined) continue;
        const entry = kept.get(pointer);
        if (entry !== undefined) entries.push(entry);
    }
    return entries;
}

/**
 * The target's ordinal within its parent, or -1 when it cannot be established.
 * An array index comes free out of the pointer; an object member costs a name
 * lookup, which for a container too wide to have a dense index is a walk of the
 * parent's own bytes. That is the price of the operation — a window is a request
 * for the surroundings — and it is bounded by the parent, never by the document.
 */
function ordinalWithin(resolver: Resolver, parent: StrideNode, node: StrideNode): number {
    const token = lastToken(node.pointer);
    if (token === null) return -1;
    if (parent.kind === 'array') return tokenToIndex(token);
    try {
        const member = resolver.memberByKey(parent, token);
        return member === null ? -1 : member.ordinal;
    } catch {
        return -1;
    }
}

/**
 * Render a node together with its surroundings: the node itself, its immediate
 * siblings, and the ancestor chain with addresses.
 *
 * The siblings are VERBATIM neighbours rather than a paraphrase of them. That is
 * a deliberate reading of "a compact summary": byte-exact windows around the hit
 * lifted downstream patch-apply rates from 76% to 90% raw and 31% to 83%
 * compressed, and compression that corrupted the verbatim anchors cut patch
 * application from 27/40 to 15/40. Summarising the neighbours would spend the
 * budget on the one thing measured to hurt.
 *
 * The payload is a two-key object because the parent may be an array, and STRIDE
 * metadata cannot sit as a sibling of array elements. `__stride.of` declares
 * what `window` holds, so the single invented key is self-describing rather than
 * ambiguous.
 */
export function renderWindow(resolver: Resolver, node: StrideNode, opts: RenderOptions): StrideView {
    const budget = viewBudget(opts.budget);
    const usable = payloadAllot(budget);
    // A STARTING ALLOCATION, NOT A LAW. Each slice hands its unspent remainder
    // to the next: the ancestor slice also pays for the wrapper and the
    // affordances, and whatever it leaves funds the content; the target's
    // leftovers fund more siblings, because stage 1 of the walk below claims
    // the target first and stage 2 spends what survives on its neighbours.
    const ancestorShare = Math.floor(usable * WINDOW_ANCESTOR_SHARE);
    const targetShare = Math.floor(usable * WINDOW_TARGET_SHARE);
    const siblingShare = Math.floor(usable * WINDOW_SIBLING_SHARE);

    const ctx: Ctx = {
        resolver,
        omissions: [],
        // The target's own first byte is a focus offset, so the walk over the
        // parent hoists the target ahead of document order and it is in the
        // output before any sibling competes for room.
        focus: [node.start, ...(opts.focus ?? [])],
        focusAllot: Math.max(MIN_MEMBER_CHARS, Math.min(targetShare, usable)),
    };

    let parentNode: StrideNode | null = null;
    if (node.parent !== null) {
        try {
            parentNode = resolver.resolve(node.parent);
        } catch {
            // Unreachable for a node the resolver produced; a window over the
            // target alone is the honest degradation if it ever happens.
            parentNode = null;
        }
    }
    const ordinal = parentNode === null ? -1 : ordinalWithin(resolver, parentNode, node);
    const reachFrom = ordinal < 0 ? 0 : Math.max(0, ordinal - WINDOW_SIBLING_REACH);
    const reachTo = parentNode === null
        ? 0
        : Math.min(parentNode.count, reachFrom + WINDOW_SIBLING_REACH * 2 + 1);
    const siblings = {
        before: ordinal < 0 ? 0 : ordinal,
        after: parentNode === null || ordinal < 0 ? 0 : Math.max(0, parentNode.count - ordinal - 1),
        // Sized against the target's own pointer, the longer of the two `of`
        // candidates, so every shell measured from this block is an upper bound
        // whichever branch the content render takes.
        reach: [reachFrom, reachTo] as readonly [number, number],
    };

    const targetSpan: RenderSpan = {
        pointer: node.pointer,
        kind: node.kind,
        start: node.start,
        end: node.end,
        count: node.count,
    };

    // The wrapper has a floor cost of its own — the metadata block runs to well
    // over a hundred characters before a single ancestor or document byte is
    // added — so a small budget cannot express a window at all. Measured with an
    // EMPTY chain, before the chain is built, so that the branch below is chosen
    // without first spending on ancestors it may have to throw away.
    const floorShell = estimateChars({
        [STRIDE_KEY]: { at: node.pointer, of: node.pointer, ancestors: [] as WindowAncestor[], siblings },
        window: null,
    }) - estimateChars(null);

    let data: unknown;
    /** Whether the parent was actually reached for, so `shown` means something. */
    let reached = false;
    if (floorShell + MIN_MEMBER_CHARS > usable) {
        // Degrade to the target alone, which is exactly what `renderNode` would
        // have produced, and say so: the surroundings are the thing that was
        // withheld, and a window silently missing its context is the failure
        // mode this whole module exists to avoid.
        ctx.omissions.push({
            of: 'depth',
            pointer: node.pointer,
            count: 1 + siblings.before + siblings.after,
            total: 1 + siblings.before + siblings.after,
            span: [node.start, node.end],
            cursor: address('window', node.pointer, 0).cursor,
            reason: 'budget',
        });
        const bare = renderValue(ctx, targetSpan, usable, node.depth);
        if (bare === null) recordWholeSpan(ctx, targetSpan, node.count);
        data = bare === null ? null : bare.value;
    } else {
        const meta = {
            at: node.pointer,
            of: node.pointer,
            ancestors: ancestorChain(ctx, node, ancestorShare),
            siblings,
        };
        const shellChars = estimateChars({ [STRIDE_KEY]: meta, window: null }) - estimateChars(null);
        // Two bounds, and the smaller wins. The first is what is physically left
        // once the shell and the ancestor chain are paid for; the second is the
        // target's and the siblings' shares, which is the allocation the shares
        // above describe. Either way the content cannot spend the affordances.
        const contentAllot = Math.min(usable - shellChars, targetShare + siblingShare);

        let content: Rendered | null = null;
        let of = node.pointer;
        if (parentNode !== null && contentAllot >= MIN_MEMBER_CHARS) {
            const split = renderContainer(
                ctx,
                {
                    pointer: parentNode.pointer,
                    kind: parentNode.kind,
                    start: parentNode.start,
                    end: parentNode.end,
                    count: parentNode.count,
                },
                contentAllot,
                parentNode.depth,
                reachFrom,
                WINDOW_SIBLING_REACH * 2 + 1,
            );
            if (split !== null) {
                content = { value: split.value, chars: split.chars };
                of = parentNode.pointer;
                reached = true;
            }
        }
        if (content === null && contentAllot >= MIN_MEMBER_CHARS) {
            content = renderValue(ctx, targetSpan, contentAllot, node.depth);
        }
        if (content === null) recordWholeSpan(ctx, targetSpan, node.count);
        data = { [STRIDE_KEY]: { ...meta, of }, window: content === null ? null : content.value };
    }

    let chars = estimateChars(data);
    // Construction backstop. The wrapper was sized before it was built and the
    // content was rendered against what the sizing left, so neither branch can
    // exceed the allotment. If one ever did, the view falls back to the floor
    // payload rather than breaking I3 — the same trade the allocator makes
    // everywhere else: less shown, never more claimed.
    if (chars > usable) {
        recordWholeSpan(ctx, targetSpan, node.count);
        data = null;
        chars = estimateChars(null);
        reached = false;
    }

    const isContainer = node.kind === 'object' || node.kind === 'array';
    const parentAddress = node.parent === null ? null : address('read', node.parent, 0);
    // Sibling navigation, which is what a window's caller reaches for next:
    // page the PARENT past what this window reached, or back before it.
    const next = parentNode !== null && reachTo < parentNode.count
        ? address('read', parentNode.pointer, reachTo)
        : null;
    const prev = parentNode !== null && reachFrom > 0
        ? address('read', parentNode.pointer, Math.max(0, reachFrom - (WINDOW_SIBLING_REACH * 2 + 1)))
        : null;

    const envelope: StrideEnvelope = {
        pointer: node.pointer,
        kind: node.kind,
        span: [node.start, node.end],
        ...(isContainer ? { total: node.count } : {}),
        // Only when the parent was actually rendered: a `shown` range on a view
        // that degraded to the target alone would claim siblings it never had.
        ...(reached ? { shown: [reachFrom, reachTo] as readonly [number, number] } : {}),
        omitted: ctx.omissions,
        ...(next === null ? {} : { next }),
        ...(prev === null ? {} : { prev }),
        ...(parentAddress === null ? {} : { parent: parentAddress }),
        hint: hintFor(node, ctx.omissions, next),
    };
    return { data, envelope, chars, budget };
}
