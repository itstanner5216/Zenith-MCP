// ---------------------------------------------------------------------------
// core/stride/pointer.ts — RFC 6901 JSON Pointer, strictly
//
// Strictly, because every documented JSON Pointer defect in shipping libraries
// is one of five things, and all five are cheap to get right if you decide to:
//
//   ""      is the whole document.
//   "/"     is the member whose name is the EMPTY STRING — not the document.
//           Conflating the two is the most common implementation bug and it
//           silently returns the wrong node on any object with a "" key.
//   "~1"    decodes to "/" and "~0" to "~", in THAT order. Unescaping "~0"
//           first turns "~01" into "/" instead of "~1".
//   "01"    is NOT a valid array index. Leading zeros are rejected, not parsed.
//   "-"     addresses the position past the last element. It exists for JSON
//           Patch; there is nothing to read there, so a read path rejects it
//           rather than silently returning the last element.
//
// Every pointer STRIDE emits is a pointer STRIDE accepts.
// ---------------------------------------------------------------------------

import { StrideError } from './types.js';

/** Escape one member name for use as a pointer reference token. */
export function escapeToken(key: string): string {
    // '~' first: escaping '/' first would then re-escape the '~' it introduced.
    return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Unescape one pointer reference token back to a member name. */
export function unescapeToken(token: string): string {
    // '~1' first, per RFC 6901 section 4: the reverse order corrupts "~01".
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Append a member name to a pointer. */
export function childPointer(parent: string, key: string): string {
    return `${parent}/${escapeToken(key)}`;
}

/** Append an array index to a pointer. */
export function indexPointer(parent: string, index: number): string {
    return `${parent}/${index}`;
}

/**
 * Split a pointer into its reference tokens, unescaped.
 * `""` yields `[]`. `"/"` yields `[""]`. Anything not starting with `/` is an
 * error, which is what makes a stray `"foo"` fail loudly instead of quietly
 * resolving to the root.
 */
export function parsePointer(pointer: string): string[] {
    if (pointer === '') return [];
    if (pointer.charCodeAt(0) !== 0x2f) {
        throw new StrideError(
            'bad_pointer',
            `JSON Pointer must be empty or start with a slash: received ${JSON.stringify(pointer)}.`,
            `Use "" for the whole document, or a pointer like "/records/0/id".`,
        );
    }
    const raw = pointer.slice(1).split('/');
    const out: string[] = new Array<string>(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = unescapeToken(raw[i] ?? '');
    return out;
}

/** The pointer of the parent, or null when `pointer` is the document. */
export function parentPointer(pointer: string): string | null {
    if (pointer === '') return null;
    const cut = pointer.lastIndexOf('/');
    return cut <= 0 ? '' : pointer.slice(0, cut);
}

/** The last reference token, unescaped, or null at the document root. */
export function lastToken(pointer: string): string | null {
    if (pointer === '') return null;
    const cut = pointer.lastIndexOf('/');
    return unescapeToken(pointer.slice(cut + 1));
}

/**
 * Parse an array reference token to an index, or -1 if it is not one.
 * Rejects leading zeros, signs, whitespace and the empty token, all of which
 * some libraries accept and then resolve to element 0.
 */
export function tokenToIndex(token: string): number {
    const n = token.length;
    if (n === 0) return -1;
    if (n > 1 && token.charCodeAt(0) === 0x30) return -1;   // "01", "007"
    let value = 0;
    for (let i = 0; i < n; i++) {
        const c = token.charCodeAt(i);
        if (c < 0x30 || c > 0x39) return -1;
        value = value * 10 + (c - 0x30);
        if (value > Number.MAX_SAFE_INTEGER) return -1;
    }
    return value;
}
