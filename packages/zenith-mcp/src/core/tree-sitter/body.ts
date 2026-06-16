// ---------------------------------------------------------------------------
// tree-sitter/body.ts — Body slice extraction and fingerprinting
//
// Invariant: Pure functions. No tree-sitter dependency. No sibling imports.
// Canonical location for body hashing — no other module may hash def bodies.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/**
 * Normalize line endings to LF so slicing and fingerprinting are
 * newline-style-agnostic. Converts CRLF (\r\n) and any lone CR (\r) to \n,
 * so a body that differs only in line-ending style yields an identical slice
 * (and therefore an identical bodyHash) across Windows / mixed / LF sources.
 *
 * Inlined locally rather than imported from core/lib.ts: this module's
 * invariant is "no sibling imports" (pure, dependency-free), and cross-file
 * coupling here would risk an import cycle. The convention matches lib.ts's
 * normalizeLineEndings for CRLF and additionally collapses a lone CR so the
 * fingerprint is stable for every newline style, not just CRLF.
 */
function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

/**
 * Extract the verbatim body text for a symbol definition.
 * Line endings are normalized to LF before slicing, so the result (and the
 * bodyHash derived from it) is identical for content that differs only in
 * newline style.
 * @param source    Full source text
 * @param startLine 1-based inclusive start
 * @param endLine   1-based inclusive end
 */
export function bodySlice(source: string, startLine: number, endLine: number): string {
    const lines = normalizeLineEndings(source).split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * SHA-256 fingerprint of a body slice. Used for change detection and dedup.
 * The slice is normalized to LF before hashing so the fingerprint is identical
 * for content that differs only in line-ending style (Windows / mixed / LF),
 * keeping change-detection and dedup stable across platforms. Pure-LF input
 * (e.g. a slice already produced by bodySlice) is unchanged by normalization.
 */
export function bodyHash(slice: string): string {
    return createHash('sha256').update(normalizeLineEndings(slice)).digest('hex');
}
