// ---------------------------------------------------------------------------
// core/stride/scan.ts — the structural byte scanner
//
// One forward pass over the document bytes, emitting structural events with
// absolute byte offsets. This is the only hot loop in STRIDE; everything else
// is built on the spans it produces.
//
// It is a byte scanner, not a parser. It never allocates a JavaScript value
// for a document value, never decodes a string it is not asked to, and never
// recurses — depth is an explicit stack, so a 50,000-level document costs an
// array grow, not a stack overflow.
//
// `JSON.parse` is not an option at this scale and it is worth stating why: V8
// caps a string at 536,870,888 characters, and `JSON.parse` on a Buffer
// stringifies first, so any document past ~512 MiB throws before it starts.
// The scanner has no such ceiling — it works in bytes throughout.
//
// Chunking: the scanner carries its state across chunk boundaries, so a token,
// a string, or an escape sequence may straddle any number of chunks. The one
// subtlety that bites every chunked JSON scanner is a chunk boundary landing
// immediately after a backslash; that is why escape state is carried
// explicitly in `esc` rather than re-derived per chunk.
// ---------------------------------------------------------------------------

import type { StrideKind } from './types.js';
import type { StrideSource } from './source.js';

export const K_OBJECT = 0;
export const K_ARRAY = 1;
export const K_STRING = 2;
export const K_NUMBER = 3;
export const K_BOOLEAN = 4;
export const K_NULL = 5;

export const KIND_NAMES: readonly StrideKind[] = ['object', 'array', 'string', 'number', 'boolean', 'null'];

/**
 * Events the scanner emits, in document order. Offsets are absolute.
 *
 * `depth` counts open containers, including the enclosing one that an interior
 * scan names through `scanStructure`'s `inside` argument. So the root of a
 * whole-document scan is at depth 0, and a direct member of the container an
 * interior scan was pointed inside is at depth 1 whether that container is an
 * object or an array.
 */
export interface ScanVisitor {
    /** A container opened. `start` is the offset of `{` or `[`. */
    enter(kind: 0 | 1, start: number, depth: number): void;
    /** A container closed. `end` is one past the `}` or `]`. */
    exit(kind: 0 | 1, start: number, end: number, depth: number, childCount: number): void;
    /** An object member name. `start`..`end` spans the quoted key, quotes included. */
    key(start: number, end: number, depth: number): void;
    /** A scalar value. `start`..`end` spans it exactly, quotes included for strings. */
    scalar(kind: 2 | 3 | 4 | 5, start: number, end: number, depth: number): void;
}

export interface ScanResult {
    readonly maxDepth: number;
    /** Offset of the first structural problem, or -1 when the document is clean. */
    readonly errorAt: number;
    readonly errorMessage: string;
    /** Offset one past the last byte the scanner accepted. */
    readonly consumed: number;
    /** True when at least one object contained the same key twice. */
    readonly duplicateKeys: boolean;
}

// Byte classification. A 256-entry table beats a chain of comparisons here:
// the loop is memory-bound on the document, and the table stays in L1.
const CLS = new Uint8Array(256);
const C_OTHER = 0;
const C_WS = 1;
const C_STRUCT = 2;      // { } [ ] : ,
const C_QUOTE = 3;
{
    CLS[0x20] = C_WS; CLS[0x09] = C_WS; CLS[0x0a] = C_WS; CLS[0x0d] = C_WS;
    CLS[0x7b] = C_STRUCT; CLS[0x7d] = C_STRUCT; CLS[0x5b] = C_STRUCT;
    CLS[0x5d] = C_STRUCT; CLS[0x3a] = C_STRUCT; CLS[0x2c] = C_STRUCT;
    CLS[0x22] = C_QUOTE;
}

const B_LBRACE = 0x7b, B_RBRACE = 0x7d, B_LBRACK = 0x5b, B_RBRACK = 0x5d;
const B_COLON = 0x3a, B_COMMA = 0x2c, B_QUOTE = 0x22, B_BACKSLASH = 0x5c;
const B_t = 0x74, B_f = 0x66, B_n = 0x6e, B_MINUS = 0x2d;
const B_0 = 0x30, B_9 = 0x39;

/** Scanner phases that can straddle a chunk boundary. */
const P_VALUE = 0;
const P_STRING = 1;
const P_TOKEN = 2;

/**
 * `starts` entry for the one level an interior scan is told it begins inside.
 * That container's opening bracket lies before `from`, so the scan holds no
 * offset for it and must never emit one. Negative on purpose: were it ever to
 * reach a span it would be an obvious impossibility rather than a plausible
 * byte 0.
 */
const START_BEFORE_RANGE = -1;

/**
 * Scan [from, to) of `source`, emitting structural events to `visitor`.
 *
 * The scanner accepts the JSON grammar and additionally tolerates trailing
 * bytes after a complete root value, reporting them as an error offset rather
 * than throwing — a truncated or concatenated document is still worth
 * navigating up to the point it stops making sense, and I1 is preserved
 * because everything emitted before that point is real.
 *
 * `inside` names the kind of the container the range begins INSIDE — `K_OBJECT`
 * or `K_ARRAY` — for the interior scans resolve.ts and shape.ts run across a
 * container's own span from `container.start + 1`. That range excludes the
 * opening bracket, so with an empty stack the scanner has no container at all:
 * an object's member names arrive as string scalars instead of `key` events
 * (classifying a string as a name needs a known-object level beneath it), the
 * second member is rejected as a trailing value (the first completed a root),
 * and the container's own closing brace is a mismatched bracket. `inside`
 * supplies that one level, and supplies its objectness, which no byte at
 * `from - 1` can reveal — the checkpoint routes in resolve.ts begin part-way
 * into a container, where the preceding byte is a comma or a colon rather than
 * a bracket.
 *
 * Omitted — the default — the range begins at a value's first byte, the stack
 * starts empty, and the first value is the root at depth 0. That is the
 * whole-document scan index.ts runs, unchanged in every respect.
 */
export function scanStructure(
    source: StrideSource,
    from: number,
    to: number,
    visitor: ScanVisitor,
    inside?: 0 | 1,
): ScanResult {
    // Container stack. Parallel typed arrays, grown geometrically; one object
    // per nesting level would make deep documents allocate per level.
    let cap = 64;
    let isObj = new Uint8Array(cap);        // 1 object, 0 array
    let awaitKey = new Uint8Array(cap);     // 1 when the next string is a member name
    let starts = new Float64Array(cap);     // offset of the opening bracket
    let counts = new Float64Array(cap);     // children seen so far
    let keySeen: Array<Set<string> | null> = new Array<Set<string> | null>(cap).fill(null);

    // The stack level the range opens at: one when `inside` handed us an
    // enclosing container, zero when the range begins at a value's first byte.
    // It is a floor rather than only a starting count, because no level below it
    // was opened by this scan and so no level below it may be reported. Named in
    // full because the chunk callback below binds `base` to a byte offset, and a
    // depth compared against a byte offset would typecheck perfectly.
    const baseDepth = inside === undefined ? 0 : 1;
    if (inside !== undefined) {
        const obj = inside === K_OBJECT;
        isObj[0] = obj ? 1 : 0;
        // At `container.start + 1` an object's interior begins where a member
        // name begins, so the first string at this level is a key. That makes a
        // member-name boundary the precondition for scanning an object
        // interior: entered at a value boundary instead, every name would pair
        // with the preceding member's value.
        awaitKey[0] = obj ? 1 : 0;
        starts[0] = START_BEFORE_RANGE;
        // No duplicate-key set for this level: the check needs every key of the
        // object, and an interior scan may begin part-way in, so a clean result
        // here would be a claim the scan cannot support.
        keySeen[0] = null;
    }

    let depth = baseDepth;
    let maxDepth = baseDepth;
    let duplicateKeys = false;

    let phase = P_VALUE;
    let esc = false;                        // previous byte inside a string was an unconsumed backslash
    let tokenStart = -1;                    // start offset of an in-flight string or scalar token
    let tokenIsKey = false;
    let errorAt = -1;
    let errorMessage = '';
    let consumed = from;
    let rootDone = false;

    const grow = (): void => {
        const next = cap * 2;
        const nIsObj = new Uint8Array(next); nIsObj.set(isObj);
        const nAwait = new Uint8Array(next); nAwait.set(awaitKey);
        const nStarts = new Float64Array(next); nStarts.set(starts);
        const nCounts = new Float64Array(next); nCounts.set(counts);
        const nSeen = new Array<Set<string> | null>(next).fill(null);
        for (let i = 0; i < cap; i++) nSeen[i] = keySeen[i] ?? null;
        isObj = nIsObj; awaitKey = nAwait; starts = nStarts; counts = nCounts; keySeen = nSeen;
        cap = next;
    };

    const fail = (at: number, msg: string): void => {
        if (errorAt < 0) { errorAt = at; errorMessage = msg; }
    };

    source.sequential(from, to, (chunk, base) => {
        if (errorAt >= 0) return;
        const len = chunk.length;
        let i = 0;

        while (i < len) {
            // ── inside a string ────────────────────────────────────────────
            if (phase === P_STRING) {
                while (i < len) {
                    const b = chunk[i] ?? 0;
                    if (esc) { esc = false; i++; continue; }
                    if (b === B_BACKSLASH) { esc = true; i++; continue; }
                    if (b === B_QUOTE) {
                        i++;
                        const end = base + i;
                        if (tokenIsKey) {
                            visitor.key(tokenStart, end, depth);
                            if (depth > 0) {
                                // Duplicate-key detection is bounded: only
                                // objects small enough to be worth tracking get
                                // a set, so a 5-million-key object cannot turn
                                // this into a memory leak.
                                const d = depth - 1;
                                const seen = keySeen[d];
                                if (seen !== null && seen !== undefined) {
                                    const text = source.slice(tokenStart, end).toString('utf8');
                                    if (seen.has(text)) duplicateKeys = true;
                                    else if (seen.size < 4096) seen.add(text);
                                }
                                awaitKey[d] = 0;
                            }
                        } else {
                            visitor.scalar(K_STRING, tokenStart, end, depth);
                            if (depth > 0) counts[depth - 1] = (counts[depth - 1] ?? 0) + 1;
                            else rootDone = true;
                        }
                        phase = P_VALUE;
                        tokenStart = -1;
                        break;
                    }
                    i++;
                }
                if (phase === P_STRING) break;   // ran out of chunk mid-string
                continue;
            }

            // ── inside a number or literal ─────────────────────────────────
            if (phase === P_TOKEN) {
                let b = 0;
                while (i < len) {
                    b = chunk[i] ?? 0;
                    const c = CLS[b] ?? C_OTHER;
                    if (c === C_WS || c === C_STRUCT) break;
                    i++;
                }
                if (i >= len) break;             // token may continue in the next chunk
                const end = base + i;
                const kind = classifyToken(source, tokenStart, end);
                if (kind < 0) {
                    fail(tokenStart, `Malformed JSON literal at byte ${tokenStart}.`);
                    return;
                }
                visitor.scalar(kind as 3 | 4 | 5, tokenStart, end, depth);
                if (depth > 0) counts[depth - 1] = (counts[depth - 1] ?? 0) + 1;
                else rootDone = true;
                phase = P_VALUE;
                tokenStart = -1;
                continue;
            }

            // ── between tokens ─────────────────────────────────────────────
            const b = chunk[i] ?? 0;
            const cls = CLS[b] ?? C_OTHER;

            if (cls === C_WS) { i++; continue; }

            if (cls === C_QUOTE) {
                tokenStart = base + i;
                tokenIsKey = depth > 0 && isObj[depth - 1] === 1 && awaitKey[depth - 1] === 1;
                phase = P_STRING;
                esc = false;
                i++;
                continue;
            }

            if (cls === C_STRUCT) {
                const at = base + i;
                if (b === B_LBRACE || b === B_LBRACK) {
                    if (rootDone && depth === 0) { fail(at, `Trailing value at byte ${at}.`); return; }
                    if (depth >= cap) grow();
                    const obj = b === B_LBRACE;
                    isObj[depth] = obj ? 1 : 0;
                    awaitKey[depth] = obj ? 1 : 0;
                    starts[depth] = at;
                    counts[depth] = 0;
                    keySeen[depth] = obj ? new Set<string>() : null;
                    depth++;
                    if (depth > maxDepth) maxDepth = depth;
                    visitor.enter(obj ? 0 : 1, at, depth - 1);
                    i++;
                    continue;
                }
                if (b === B_RBRACE || b === B_RBRACK) {
                    if (depth === 0) { fail(at, `Unmatched '${String.fromCharCode(b)}' at byte ${at}.`); return; }
                    const d = depth - 1;
                    const wantObj = b === B_RBRACE;
                    if ((isObj[d] === 1) !== wantObj) {
                        fail(at, `Mismatched bracket at byte ${at}.`);
                        return;
                    }
                    depth--;
                    keySeen[d] = null;
                    // A level below `baseDepth` was opened before `from`. The
                    // scan holds no start offset for it, so it closes silently
                    // rather than emit a span it would have to invent (I1).
                    if (d >= baseDepth) {
                        visitor.exit(wantObj ? 0 : 1, starts[d] ?? at, at + 1, d, counts[d] ?? 0);
                    }
                    if (depth > 0) counts[depth - 1] = (counts[depth - 1] ?? 0) + 1;
                    else rootDone = true;
                    i++;
                    continue;
                }
                if (b === B_COLON) {
                    if (depth > 0 && isObj[depth - 1] === 1) awaitKey[depth - 1] = 0;
                    i++;
                    continue;
                }
                if (b === B_COMMA) {
                    if (depth > 0 && isObj[depth - 1] === 1) awaitKey[depth - 1] = 1;
                    i++;
                    continue;
                }
            }

            // A bare literal or number.
            if (b === B_t || b === B_f || b === B_n || b === B_MINUS || (b >= B_0 && b <= B_9)) {
                if (rootDone && depth === 0) { fail(base + i, `Trailing value at byte ${base + i}.`); return; }
                tokenStart = base + i;
                phase = P_TOKEN;
                i++;
                continue;
            }

            fail(base + i, `Unexpected byte 0x${b.toString(16)} at byte ${base + i}.`);
            return;
        }
        consumed = base + len;
    });

    // A token or string still open when the bytes ran out means the document
    // is truncated. Emit what we can prove and mark where trust ends.
    if (errorAt < 0 && phase === P_TOKEN && tokenStart >= 0) {
        const kind = classifyToken(source, tokenStart, to);
        if (kind >= 0) {
            visitor.scalar(kind as 3 | 4 | 5, tokenStart, to, depth);
            if (depth > 0) counts[depth - 1] = (counts[depth - 1] ?? 0) + 1;
        } else {
            errorAt = tokenStart;
            errorMessage = `Truncated literal at byte ${tokenStart}.`;
        }
    } else if (errorAt < 0 && phase === P_STRING) {
        errorAt = tokenStart;
        errorMessage = `Unterminated string starting at byte ${tokenStart}.`;
    }

    // Unclosed containers: close them at the end of input so their children
    // stay addressable, and record the truncation honestly. The floor is
    // `baseDepth` rather than 0 because an interior scan's own enclosing level
    // being open at `to` is that scan's premise, not a truncation it found.
    if (depth > baseDepth && errorAt < 0) {
        errorAt = starts[depth - 1] ?? consumed;
        errorMessage = `Unclosed container opened at byte ${errorAt}; document ends at ${consumed}.`;
    }
    while (depth > baseDepth) {
        const d = depth - 1;
        depth--;
        visitor.exit(isObj[d] === 1 ? 0 : 1, starts[d] ?? 0, consumed, d, counts[d] ?? 0);
    }

    return { maxDepth, errorAt, errorMessage, consumed, duplicateKeys };
}

/**
 * Validate a non-string scalar token and return its kind, or -1.
 *
 * This is where `{"a": 012}` is caught. A regex-based scanner splits that into
 * `0` and `12` and silently invents a phantom value; the JSON grammar forbids
 * a leading zero, so the honest answer is that the document is malformed.
 */
function classifyToken(source: StrideSource, start: number, end: number): number {
    const n = end - start;
    if (n <= 0) return -1;
    const bytes = source.slice(start, end);
    const b0 = bytes[0] ?? 0;

    if (b0 === B_t) return n === 4 && bytes.toString('latin1') === 'true' ? K_BOOLEAN : -1;
    if (b0 === B_f) return n === 5 && bytes.toString('latin1') === 'false' ? K_BOOLEAN : -1;
    if (b0 === B_n) return n === 4 && bytes.toString('latin1') === 'null' ? K_NULL : -1;

    // number = [-] int [frac] [exp]  with int = 0 | [1-9] digits
    let i = 0;
    if ((bytes[i] ?? 0) === B_MINUS) i++;
    if (i >= n) return -1;
    const d0 = bytes[i] ?? 0;
    if (d0 === B_0) {
        i++;
    } else if (d0 > B_0 && d0 <= B_9) {
        while (i < n) { const d = bytes[i] ?? 0; if (d < B_0 || d > B_9) break; i++; }
    } else {
        return -1;
    }
    if (i < n && (bytes[i] ?? 0) === 0x2e) {          // '.'
        i++;
        let digits = 0;
        while (i < n) { const d = bytes[i] ?? 0; if (d < B_0 || d > B_9) break; i++; digits++; }
        if (digits === 0) return -1;
    }
    if (i < n) {
        const e = bytes[i] ?? 0;
        if (e === 0x65 || e === 0x45) {               // 'e' | 'E'
            i++;
            const sign = bytes[i] ?? 0;
            if (sign === 0x2b || sign === B_MINUS) i++;
            let digits = 0;
            while (i < n) { const d = bytes[i] ?? 0; if (d < B_0 || d > B_9) break; i++; digits++; }
            if (digits === 0) return -1;
        }
    }
    return i === n ? K_NUMBER : -1;
}
