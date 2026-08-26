// ---------------------------------------------------------------------------
// core/stride/terms.ts — value-aware tokenisation
//
// The tokeniser is the vocabulary the whole search shares. A query only ever
// meets the document through terms both sides produced, so the failure mode
// that matters is not "the tokeniser is imperfect", it is "the two sides
// disagree". That is why `tokenize` runs the SAME byte scanner as
// `tokenizeBytes` over the query's UTF-8 rather than a parallel regex
// implementation that would drift from it the first time either is touched.
//
// The default choice — one `/[\p{L}\p{N}_]+/gu` word split — is wrong here, and
// concretely so. It shreds exactly the strings a person pastes into a search
// box:
//
//   2024-01-15T10:30:00Z                 ->  2024 · 01 · 15t10 · 30 · 00z
//   550e8400-e29b-41d4-a716-446655440000 ->  five fragments
//   192.168.1.1                          ->  four integers
//   1.5                                  ->  1 · 5
//   a@b.com                              ->  a · b · com
//
// None of those five searches would ever match again, and none of them would
// report an error either — they would return nothing, which is the worst
// possible way for a search to be wrong.
//
// The fix is one rule rather than eight pattern matchers. An ATOM is a maximal
// run of word bytes, where the joiners `. - : @ / +` count as word bytes when
// they are flanked by word bytes on BOTH sides. That single rule keeps every
// named form on the list whole: ISO-8601 timestamps, UUIDs, dotted-quad IPv4,
// decimals, emails, dotted and slashed paths, and hex digests. It cannot keep
// a URL whole, because `://` puts a joiner next to a non-word byte — so a URL
// gets a dedicated recogniser in `tokenize`, and the byte scanner keeps the
// `host/path` remainder, which is what the index actually stores.
//
// Recall comes first everywhere in this file: an atom is emitted alongside its
// sub-atoms and its plain word pieces, so `error` finds `error_timeout_failure`
// and `192.168.1.1` finds `192.168.1.1:8080`. Emitting more terms costs index
// bytes; emitting fewer costs answers.
//
// Indexed reads below use `?? 0` where the index is provably inside the array —
// a loop bound, or a 0..255 byte value used against the 256-entry class table.
// Zero is also the fail-safe value in both roles: byte 0x00 and class 0 both
// mean "not part of a token", so an impossible read would end a token rather
// than silently extend it into neighbouring bytes. No read here carries a
// count, an offset or a frequency, so there is no arithmetic for a fallback to
// corrupt.
// ---------------------------------------------------------------------------

import { unescapeToken, tokenToIndex } from './pointer.js';

/**
 * Longest term retained, in UTF-8 bytes. Longer atoms are truncated at a
 * codepoint boundary rather than dropped, so a query for a long identifier
 * truncates to the same prefix the index stored and still matches. 128 bytes
 * holds every named form whole — the longest is a 128-hex-char SHA-512 digest,
 * and a UUID is 36.
 */
export const TOKEN_MAX_BYTES = 128;

// Byte classes. One 256-entry table serves the atom scanner, the sub-atom
// splitter and the word splitter; a table lookup stays in L1 while a chain of
// range comparisons does not, and this loop runs over every byte of the
// document.
const CL_NONE = 0;      // ends a token: whitespace, quotes, brackets, commas
const CL_LOWER = 1;     // a-z
const CL_UPPER = 2;     // A-Z
const CL_DIGIT = 3;     // 0-9
const CL_HIGH = 4;      // >= 0x80: any UTF-8 continuation or lead byte
const CL_USCORE = 5;    // _   word byte, but a word-piece boundary
const CL_JOIN = 6;      // . - +   joiner, and a word-piece boundary
const CL_SUB = 7;       // : / @   joiner, word-piece boundary, and a sub-atom cut

const CT = new Uint8Array(256);
{
    for (let b = 0x61; b <= 0x7a; b++) CT[b] = CL_LOWER;
    for (let b = 0x41; b <= 0x5a; b++) CT[b] = CL_UPPER;
    for (let b = 0x30; b <= 0x39; b++) CT[b] = CL_DIGIT;
    for (let b = 0x80; b <= 0xff; b++) CT[b] = CL_HIGH;
    CT[0x5f] = CL_USCORE;
    CT[0x2e] = CL_JOIN; CT[0x2d] = CL_JOIN; CT[0x2b] = CL_JOIN;
    CT[0x3a] = CL_SUB; CT[0x2f] = CL_SUB; CT[0x40] = CL_SUB;
}

/** Classes 1..5 are word bytes; 6..7 are joiners that need flanking. */
function isWordClass(c: number): boolean { return c >= CL_LOWER && c <= CL_USCORE; }

/**
 * Atoms made only of these classes are already their own single word piece and
 * have no sub-atom cut, so the two extra splitting passes can be skipped. This
 * is the overwhelmingly common case — ordinary lowercase words and CJK runs.
 */
const SIMPLE_MASK = (1 << CL_LOWER) | (1 << CL_HIGH);
const DIGIT_MASK = 1 << CL_DIGIT;

/** Reused for lowercasing a token; a token never exceeds TOKEN_MAX_BYTES. */
const scratch = Buffer.allocUnsafe(TOKEN_MAX_BYTES);

/**
 * Lowercased term for `buf[from..to)`, capped at TOKEN_MAX_BYTES on a codepoint
 * boundary. ASCII is folded inline; a token containing any byte >= 0x80 also
 * gets a `toLowerCase()` pass so Cyrillic, Greek and accented Latin fold the
 * same way on the query side and the document side. Folding one side only
 * would guarantee a miss, which is worse than not folding at all.
 */
function sliceTerm(buf: Buffer, from: number, to: number): string {
    let end = to;
    if (end - from > TOKEN_MAX_BYTES) {
        end = from + TOKEN_MAX_BYTES;
        // 10xxxxxx is a UTF-8 continuation byte: back off until the cut lands
        // between codepoints, never inside one.
        while (end > from && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
    }
    let upper = false;
    let high = false;
    for (let i = from; i < end; i++) {
        const b = buf[i] ?? 0;
        if (b >= 0x41 && b <= 0x5a) upper = true;
        else if (b >= 0x80) high = true;
    }
    if (!upper) {
        // latin1 and utf8 agree byte-for-byte on pure ASCII, and latin1 skips
        // the UTF-8 validation pass.
        const s = buf.toString(high ? 'utf8' : 'latin1', from, end);
        return high ? s.toLowerCase() : s;
    }
    const n = end - from;
    for (let i = 0; i < n; i++) {
        const b = buf[from + i] ?? 0;
        scratch[i] = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
    }
    const s = scratch.toString(high ? 'utf8' : 'latin1', 0, n);
    return high ? s.toLowerCase() : s;
}

/**
 * Append `term` unless an identical term was already emitted for this atom.
 * `mark` is `out.length` from before the atom started, so the scan is over a
 * handful of entries and no per-atom Set is allocated on the hot path.
 */
function emitUnique(out: string[], mark: number, term: string): void {
    for (let i = mark; i < out.length; i++) if (out[i] === term) return;
    out.push(term);
}

/** A derived piece is dropped at one character; a whole atom never is. */
function emitPiece(buf: Buffer, from: number, to: number, out: string[], mark: number): void {
    if (to - from < 2) return;                      // 1 byte cannot decode to 2 chars
    const term = sliceTerm(buf, from, to);
    if (term.length < 2) return;                    // e.g. a single 3-byte CJK char
    emitUnique(out, mark, term);
}

/**
 * Word pieces of `buf[from..to)`: `_` and every joiner are boundaries, and so
 * are camelCase and letter/digit transitions. Splitting camel case here — not
 * only in `splitIdentifier` — is what lets `error` find `errorTimeout` in
 * document TEXT, not just in a member name; the three functions in this file
 * have to agree on what a word is or the query and the index disagree.
 */
function emitWordPieces(buf: Buffer, from: number, to: number, out: string[], mark: number): void {
    let start = -1;
    let prev = CL_NONE;
    for (let i = from; i < to; i++) {
        const c = CT[buf[i] ?? 0] ?? CL_NONE;
        // `_ . - + : / @` all break a word, and so does anything that is not a
        // word byte at all — this splitter is reached from `splitIdentifier`
        // with arbitrary member names, which may contain spaces or punctuation
        // that never appears inside an atom.
        if (c === CL_NONE || c >= CL_USCORE) {
            if (start >= 0) { emitPiece(buf, start, i, out, mark); start = -1; }
            prev = CL_NONE;
            continue;
        }
        if (start < 0) { start = i; prev = c; continue; }
        let brk = false;
        if (c === CL_UPPER) {
            // fooBar -> foo|Bar, and HTTPServer -> HTTP|Server: inside a run of
            // capitals the break goes before the LAST one when a lowercase
            // letter follows it.
            if (prev !== CL_UPPER) brk = true;
            else if (i + 1 < to && (CT[buf[i + 1] ?? 0] ?? CL_NONE) === CL_LOWER) brk = true;
        } else if (c === CL_DIGIT) {
            if (prev !== CL_DIGIT) brk = true;       // iso8601 -> iso|8601
        } else if (prev === CL_DIGIT) {
            brk = true;                              // 8601iso -> 8601|iso
        }
        if (brk) { emitPiece(buf, start, i, out, mark); start = i; }
        prev = c;
    }
    if (start >= 0) emitPiece(buf, start, to, out, mark);
}

/** Emit one atom and everything derived from it, deduplicated within the atom. */
function emitAtom(buf: Buffer, from: number, to: number, out: string[], mask: number): void {
    const mark = out.length;
    // The atom itself, whatever its length: a 1-character atom is a real term,
    // it is only 1-character *pieces* of a longer atom that are noise.
    out.push(sliceTerm(buf, from, to));

    if ((mask & (1 << CL_SUB)) !== 0) {
        // Cut on `:` `/` `@` only, so `192.168.1.1:8080` yields the address and
        // the port while the address itself stays whole.
        let start = from;
        for (let i = from; i < to; i++) {
            if ((CT[buf[i] ?? 0] ?? CL_NONE) === CL_SUB) {
                emitPiece(buf, start, i, out, mark);
                start = i + 1;
            }
        }
        emitPiece(buf, start, to, out, mark);
    }

    if ((mask & ~SIMPLE_MASK) !== 0 && mask !== DIGIT_MASK) emitWordPieces(buf, from, to, out, mark);
}

/**
 * Tokenise `buf[from..to)` straight from the bytes, appending to `out`.
 *
 * This is the hot path: it runs over every block of the document, so there is
 * no regex here and no intermediate string per line or per value. A regex pass
 * over hundreds of megabytes is the wrong order of magnitude — this scanner
 * touches each byte once through a 256-entry class table and only allocates the
 * strings it actually emits.
 *
 * A token straddling `to` is cut short; that is the caller's problem to solve,
 * and `BlockIndex` solves it by re-tokenising an overlap window so the term is
 * attributed to both blocks.
 */
export function tokenizeBytes(buf: Buffer, from: number, to: number, out: string[]): void {
    const end = to > buf.length ? buf.length : to;
    let i = from < 0 ? 0 : from;
    while (i < end) {
        let c = CT[buf[i] ?? 0] ?? CL_NONE;
        if (!isWordClass(c)) { i++; continue; }      // a joiner can never start an atom
        const start = i;
        let mask = 1 << c;
        i++;
        while (i < end) {
            c = CT[buf[i] ?? 0] ?? CL_NONE;
            if (isWordClass(c)) { mask |= 1 << c; i++; continue; }
            if (c !== CL_NONE && i + 1 < end) {
                // A joiner joins only when a word byte follows it as well; the
                // byte before it is a word byte by construction. This is what
                // keeps `1.5` whole and still ends the atom at the `.` in
                // `{"a":1.5}, ` or at the `//` of a URL.
                const c2 = CT[buf[i + 1] ?? 0] ?? CL_NONE;
                if (isWordClass(c2)) { mask |= (1 << c) | (1 << c2); i += 2; continue; }
            }
            break;
        }
        emitAtom(buf, start, i, out, mask);
    }
}

/**
 * A scheme-qualified URL, which is the one named form the atom rule cannot keep
 * whole: `://` sets a joiner next to a non-word byte. The trailing class
 * excludes the punctuation that ends a sentence or closes a JSON string so
 * `"see https://x.dev/a."` does not index a term with a full stop on the end.
 */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>\\^{|}]*[^\s"'`<>\\^{|}.,;:!?)\]}]/g;

/**
 * Tokenise text into lowercased terms — the query side of the same vocabulary
 * `tokenizeBytes` builds the index from.
 *
 * Emits, in addition to plain word tokens, whole-atom tokens for ISO-8601
 * timestamps, UUIDs, dotted-quad IPv4, decimal numbers, email addresses, URLs,
 * dotted and slashed paths, and hex digests — the first seven of those fall out
 * of the shared atom rule, and URLs get the recogniser above.
 *
 * A full URL is a term the byte indexer cannot produce, so a URL query reaches
 * `BlockIndex.candidates` as a missing term and is answered by the exhaustive
 * literal scan. That is the designed path, not a gap: the scan finds the URL
 * exactly, while the atom rule's `host/path` remainder still narrows the
 * candidate blocks in the same query.
 */
export function tokenize(text: string): string[] {
    const out: string[] = [];
    if (text.length === 0) return out;
    const buf = Buffer.from(text, 'utf8');
    tokenizeBytes(buf, 0, buf.length, out);
    if (text.includes('://')) {
        const lowered = text.toLowerCase();
        for (const m of lowered.matchAll(URL_RE)) {
            const url = Buffer.from(m[0], 'utf8');
            out.push(sliceTerm(url, 0, url.length));
        }
    }
    return out;
}

/**
 * Split an identifier into its lowercased parts: camelCase, snake_case,
 * kebab-case and dotted names, plus letter/digit transitions. Pieces shorter
 * than 2 characters are dropped, because a stray `a` or `1` matches everything
 * and discriminates nothing.
 *
 * This is what makes a JSON member name searchable by its parts — `userId`
 * answers to `user` and to `id`.
 */
export function splitIdentifier(name: string): string[] {
    const out: string[] = [];
    if (name.length === 0) return out;
    const buf = Buffer.from(name, 'utf8');
    emitWordPieces(buf, 0, buf.length, out, 0);
    return out;
}

/**
 * The member names along a JSON Pointer, unescaped, split with
 * `splitIdentifier` and deduplicated. Records are indexed with their path
 * prefix folded into their text, which measurably improves retrieval on
 * structured documents: `/orders/9182/shippingAddress/city` contributes
 * `orders`, `shipping`, `address` and `city` to the record that lives there.
 *
 * Array indices are NOT member names and are skipped. Indexing them would mint
 * one term per element of every large array — millions of terms that match
 * nothing a person would type — and it is exactly the ordinal a pointer already
 * carries. A token with a leading zero is not a valid array index per RFC 6901,
 * so `/007` is treated as the member name it is.
 *
 * A pointer that is not RFC 6901 contributes no terms rather than throwing: this
 * is a term extractor feeding an index build, and a bad address is not a reason
 * to fail a document.
 */
export function pathTerms(pointer: string): string[] {
    const out: string[] = [];
    if (pointer.length === 0 || pointer.charCodeAt(0) !== 0x2f) return out;
    for (const raw of pointer.slice(1).split('/')) {
        if (raw.length === 0) continue;
        if (tokenToIndex(raw) >= 0) continue;
        for (const piece of splitIdentifier(unescapeToken(raw))) {
            if (!out.includes(piece)) out.push(piece);
        }
    }
    return out;
}
