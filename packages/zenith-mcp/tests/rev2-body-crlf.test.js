// rev2-body-crlf.test.js
//
// Regression test for review-2 finding [U] (cubic P2): bodySlice did
// `source.split('\n')`, which on CRLF (\r\n) or mixed-ending source left a
// trailing `\r` on every line. That produced incorrect body slices AND — since
// bodyHash fingerprints the slice for change-detection/dedup — divergent hashes
// between Windows/mixed and LF systems for identical logical content.
//
// The fix normalizes line endings to LF (stripping \r) before slicing and
// before hashing, so a body that differs ONLY in newline style yields an
// identical slice and an identical bodyHash on every platform. The 1-based
// inclusive line semantics are preserved.
//
// Fail-before / pass-after:
//   - Before the fix, bodySlice(crlf, ...) returned "...{\r\n...\r\n}" (CR kept),
//     bodySlice(crlf, 2, 2) returned "  return 1;\r", and bodyHash over the LF
//     vs CRLF vs mixed slices produced three different digests.
//   - After the fix, the slices are CR-free and the three digests are equal.

import { describe, expect, it } from 'vitest';
import { bodySlice, bodyHash } from '../dist/core/tree-sitter/body.js';

// Same logical content, three newline styles.
const LF    = 'function foo() {\n  return 1;\n}';
const CRLF  = 'function foo() {\r\n  return 1;\r\n}';
const MIXED = 'function foo() {\r\n  return 1;\n}'; // CRLF then LF
const CR    = 'function foo() {\r  return 1;\r}';   // lone CR (old-Mac style)

describe('bodySlice / bodyHash are newline-style-agnostic (finding [U])', () => {
    it('full-range slice is identical across LF / CRLF / mixed / CR', () => {
        const lf = bodySlice(LF, 1, 3);
        expect(bodySlice(CRLF, 1, 3)).toBe(lf);
        expect(bodySlice(MIXED, 1, 3)).toBe(lf);
        expect(bodySlice(CR, 1, 3)).toBe(lf);
        // And the canonical LF form is exactly what we expect.
        expect(lf).toBe('function foo() {\n  return 1;\n}');
    });

    it('no slice carries a trailing \\r (full or single-line)', () => {
        // Full range.
        expect(bodySlice(CRLF, 1, 3)).not.toMatch(/\r/);
        expect(bodySlice(MIXED, 1, 3)).not.toMatch(/\r/);
        expect(bodySlice(CR, 1, 3)).not.toMatch(/\r/);
        // Single interior line — this is where the trailing \r was most visible.
        expect(bodySlice(CRLF, 2, 2)).toBe('  return 1;');
        expect(bodySlice(CRLF, 2, 2)).not.toMatch(/\r/);
        expect(bodySlice(MIXED, 2, 2)).toBe('  return 1;');
        expect(bodySlice(CR, 2, 2)).toBe('  return 1;');
    });

    it('bodyHash of the slice is identical across LF / CRLF / mixed / CR', () => {
        const hLf = bodyHash(bodySlice(LF, 1, 3));
        expect(bodyHash(bodySlice(CRLF, 1, 3))).toBe(hLf);
        expect(bodyHash(bodySlice(MIXED, 1, 3))).toBe(hLf);
        expect(bodyHash(bodySlice(CR, 1, 3))).toBe(hLf);
    });

    it('bodyHash normalizes raw (un-sliced) input too — fingerprint stable at the hashing boundary', () => {
        // Defense in depth: even if a caller hands bodyHash CR-bearing text
        // directly, the fingerprint must match its LF form.
        expect(bodyHash(CRLF)).toBe(bodyHash(LF));
        expect(bodyHash(MIXED)).toBe(bodyHash(LF));
        expect(bodyHash(CR)).toBe(bodyHash(LF));
    });

    it('preserves 1-based inclusive line semantics on CRLF source', () => {
        // Line 1 only, line 1..2, and clamp-to-end all behave as on LF.
        expect(bodySlice(CRLF, 1, 1)).toBe('function foo() {');
        expect(bodySlice(CRLF, 1, 2)).toBe('function foo() {\n  return 1;');
        expect(bodySlice(CRLF, 3, 99)).toBe('}');
    });

    it('still distinguishes genuinely different content (no over-normalization)', () => {
        // Stripping \r must not collapse real differences such as indentation.
        expect(bodyHash(bodySlice('a\r\n  b', 1, 2)))
            .not.toBe(bodyHash(bodySlice('a\r\nb', 1, 2)));
    });
});
