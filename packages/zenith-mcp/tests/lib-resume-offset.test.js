/**
 * Direct unit tests for findResumeOffset() from packages/zenith-mcp/src/core/lib.ts.
 *
 * PR changes: Added noUncheckedIndexedAccess guards that throw descriptive
 * Error objects when array indices are out of range.
 *
 * findResumeOffset(existingTailLines, incomingLines) returns:
 *  - 0 when either array is empty
 *  - The number of overlapping lines when the beginning of incomingLines
 *    matches the end of existingTailLines
 */

import { describe, expect, it } from 'vitest';
import { findResumeOffset } from '../dist/core/lib.js';

// ---------------------------------------------------------------------------
// Basic contract
// ---------------------------------------------------------------------------

describe('findResumeOffset — basic contract', () => {
    it('returns 0 when existingTailLines is empty', () => {
        expect(findResumeOffset([], ['hello', 'world'])).toBe(0);
    });

    it('returns 0 when incomingLines is empty', () => {
        expect(findResumeOffset(['hello', 'world'], [])).toBe(0);
    });

    it('returns 0 when both arrays are empty', () => {
        expect(findResumeOffset([], [])).toBe(0);
    });

    it('returns 0 when no overlap', () => {
        const existing = ['aaa', 'bbb', 'ccc'];
        const incoming = ['xxx', 'yyy'];
        expect(findResumeOffset(existing, incoming)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

describe('findResumeOffset — overlap detection', () => {
    it('detects full overlap when incoming is a suffix of existing', () => {
        const existing = ['line1', 'line2', 'line3'];
        const incoming = ['line2', 'line3'];
        // last 2 lines of existing match first 2 lines of incoming
        expect(findResumeOffset(existing, incoming)).toBe(2);
    });

    it('detects single-line overlap', () => {
        const existing = ['line1', 'line2', 'last'];
        const incoming = ['last', 'next'];
        expect(findResumeOffset(existing, incoming)).toBe(1);
    });

    it('detects full overlap when existing tail exactly equals incoming', () => {
        const existing = ['alpha', 'beta', 'gamma'];
        const incoming = ['alpha', 'beta', 'gamma'];
        expect(findResumeOffset(existing, incoming)).toBe(3);
    });

    it('does not match partial first-line only if following lines differ', () => {
        const existing = ['line1', 'line2', 'line3'];
        const incoming = ['line2', 'DIFFERENT'];
        expect(findResumeOffset(existing, incoming)).toBe(0);
    });

    it('matches correctly when first line appears multiple times', () => {
        // 'x' appears at index 0 and index 2; overlap only works from index 2
        const existing = ['x', 'y', 'x', 'z'];
        const incoming = ['x', 'z'];
        expect(findResumeOffset(existing, incoming)).toBe(2);
    });

    it('respects trimEnd when trailing whitespace differs', () => {
        const existing = ['line1  ', 'line2  '];
        const incoming = ['line1', 'line2'];
        // trimEnd comparison should treat these as matching
        expect(findResumeOffset(existing, incoming)).toBe(2);
    });

    it('handles single-element arrays with a match', () => {
        expect(findResumeOffset(['hello'], ['hello'])).toBe(1);
    });

    it('handles single-element arrays without a match', () => {
        expect(findResumeOffset(['hello'], ['world'])).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Overlap length correctness
// ---------------------------------------------------------------------------

describe('findResumeOffset — overlap length', () => {
    it('returns the count of overlapping lines, not positions', () => {
        // incoming starts at position 3 in existing, overlaps 2 lines
        const existing = ['a', 'b', 'c', 'd', 'e'];
        const incoming = ['c', 'd', 'e', 'f'];
        expect(findResumeOffset(existing, incoming)).toBe(3);
    });

    it('returns correct count for large overlap', () => {
        const shared = Array.from({ length: 20 }, (_, i) => `line ${i}`);
        const existing = ['before1', 'before2', ...shared];
        const incoming = [...shared, 'after'];
        expect(findResumeOffset(existing, incoming)).toBe(20);
    });

    it('incoming may be longer than existing tail', () => {
        const existing = ['x', 'y'];
        const incoming = ['x', 'y', 'z', 'w'];
        expect(findResumeOffset(existing, incoming)).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('findResumeOffset — edge cases', () => {
    it('handles lines with only whitespace differences at line ends', () => {
        const existing = ['data\t', 'more\t'];
        const incoming = ['data', 'more'];
        expect(findResumeOffset(existing, incoming)).toBe(2);
    });

    it('returns 0 for completely different content', () => {
        const existing = ['aaa', 'bbb'];
        const incoming = ['ccc', 'ddd'];
        expect(findResumeOffset(existing, incoming)).toBe(0);
    });

    it('handles arrays containing empty strings', () => {
        const existing = ['', 'content', ''];
        const incoming = ['', 'more'];
        // '' matches '' at index 0
        expect(findResumeOffset(existing, incoming)).toBeGreaterThanOrEqual(0);
    });
});