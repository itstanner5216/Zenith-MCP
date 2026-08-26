// ---------------------------------------------------------------------------
// core/stride/cursor.ts — continuation addresses, in both forms
//
// Every continuation STRIDE emits is BOTH an opaque token and an explicit
// coordinate, and STRIDE accepts either on input. That is deliberate, not
// belt-and-braces: an opaque token stops a model inventing a plausible-looking
// offset, but a model that has lost the token — dropped by context compaction,
// paraphrased, truncated mid-string — has no route back unless the coordinate
// is also on the page. Emitting only one of the two picks which failure mode
// you get. Emitting both costs about forty characters.
//
// Cursors are stateless. They encode where to resume, never a server-side
// handle, so nothing expires and nothing has to be kept alive between calls.
// ---------------------------------------------------------------------------

import { StrideError, type StrideAddress, type StrideCursor } from './types.js';

const VERSION = 1;

// Field separator. Safe because the two free-text fields are percent-encoded,
// and encodeURIComponent escapes a pipe.
const SEP = '|';

/** Encode a continuation cursor as a URL-safe opaque token. */
export function encodeCursor(c: StrideCursor): string {
    // Positional, not keyed: a JSON object here would triple the token length
    // for no benefit, and these appear many times in one response.
    const parts = [
        String(VERSION),
        c.op,
        encodeURIComponent(c.pointer),
        String(c.offset),
        c.limit === null ? '' : String(c.limit),
        c.query === null ? '' : encodeURIComponent(c.query),
    ];
    return `s1.${Buffer.from(parts.join(SEP), 'utf8').toString('base64url')}`;
}

/** Decode a cursor. Throws a `bad_cursor` failure that names the recovery. */
export function decodeCursor(token: string): StrideCursor {
    const bad = (why: string): StrideError => new StrideError(
        'bad_cursor',
        `Cursor could not be read: ${why}.`,
        'Cursors come from a previous response under "next", "parent" or "omitted". '
        + 'If you no longer have one, address the same place directly by its JSON Pointer.',
    );
    if (!token.startsWith('s1.')) throw bad('wrong prefix');
    let parts: string[];
    try {
        parts = Buffer.from(token.slice(3), 'base64url').toString('utf8').split(SEP);
    } catch {
        throw bad('not valid base64url');
    }
    if (parts.length !== 6) throw bad(`expected 6 fields, found ${parts.length}`);
    const [v, op, ptr, off, lim, query] = parts;
    if (v !== String(VERSION)) throw bad(`unsupported version ${String(v)}`);
    if (op !== 'read' && op !== 'window' && op !== 'page' && op !== 'scalar' && op !== 'search') {
        throw bad(`unknown operation ${String(op)}`);
    }
    const offset = Number(off);
    if (!Number.isInteger(offset) || offset < 0) throw bad('offset is not a non-negative integer');
    let limit: number | null = null;
    if (lim !== undefined && lim !== '') {
        const parsed = Number(lim);
        if (!Number.isInteger(parsed) || parsed < 0) throw bad('limit is not a non-negative integer');
        limit = parsed;
    }
    return {
        v: VERSION,
        op,
        pointer: decodeURIComponent(ptr ?? ''),
        offset,
        limit,
        query: query === undefined || query === '' ? null : decodeURIComponent(query),
    };
}

/** Build an address carrying both the explicit coordinate and the token. */
export function address(
    op: StrideCursor['op'],
    pointer: string,
    offset = 0,
    limit: number | null = null,
    query: string | null = null,
): StrideAddress {
    const cursor = encodeCursor({ v: VERSION, op, pointer, offset, limit, query });
    return offset > 0 ? { pointer, offset, cursor } : { pointer, cursor };
}

/**
 * Accept whatever the caller had to hand: a JSON Pointer, a cursor, or a
 * `stride://` URI. A caller that mixes the forms across turns is the normal
 * case, not an error case.
 */
export function resolveAddress(input: string): { pointer: string; offset: number; limit: number | null } {
    if (input.startsWith('s1.')) {
        const c = decodeCursor(input);
        return { pointer: c.pointer, offset: c.offset, limit: c.limit };
    }
    if (input.startsWith('stride://')) {
        const rest = input.slice('stride://'.length);
        const q = rest.indexOf('?');
        const path = q < 0 ? rest : rest.slice(0, q);
        const params = new URLSearchParams(q < 0 ? '' : rest.slice(q + 1));
        const pointerParam = params.get('pointer');
        const pointer = pointerParam !== null ? pointerParam : (path === '' ? '' : `/${path}`);
        const offsetRaw = Number(params.get('offset') ?? '0');
        const limitRaw = params.get('limit');
        const limit = limitRaw === null ? null : Number(limitRaw);
        return {
            pointer,
            offset: Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
            limit: limit !== null && Number.isInteger(limit) && limit >= 0 ? limit : null,
        };
    }
    return { pointer: input, offset: 0, limit: null };
}
