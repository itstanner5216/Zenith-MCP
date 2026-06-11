// ---------------------------------------------------------------------------
// tree-sitter/body.ts — Body slice extraction and fingerprinting
//
// Invariant: Pure functions. No tree-sitter dependency. No sibling imports.
// Canonical location for body hashing — no other module may hash def bodies.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/**
 * Extract the verbatim body text for a symbol definition.
 * @param source    Full source text
 * @param startLine 1-based inclusive start
 * @param endLine   1-based inclusive end
 */
export function bodySlice(source: string, startLine: number, endLine: number): string {
    const lines = source.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * SHA-1 fingerprint of a body slice. Used for change detection and dedup.
 */
export function bodyHash(slice: string): string {
    return createHash('sha1').update(slice).digest('hex');
}
