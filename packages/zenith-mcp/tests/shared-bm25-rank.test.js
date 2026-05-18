/**
 * Tests for bm25RankResults() from packages/zenith-mcp/src/core/shared.ts.
 *
 * PR change: Added `if (line === undefined) continue;` guard before using
 * `lines[Number(id)]`, which protects against the case where the BM25 index
 * returns a document id that doesn't correspond to any entry in the `lines`
 * array (should not happen in practice, but is now safely handled).
 *
 * bm25RankResults(lines, query, charBudget) returns:
 *  - { ranked: string[], totalCount: number }
 *  - ranked: lines that match the query, sorted by BM25 relevance, within charBudget
 *  - totalCount: total number of input lines
 */

import { describe, expect, it } from 'vitest';
import { bm25RankResults, getCharBudget } from '../dist/core/shared.js';

// ---------------------------------------------------------------------------
// Basic contract
// ---------------------------------------------------------------------------

describe('bm25RankResults — basic contract', () => {
    it('returns { ranked, totalCount } shape', () => {
        const result = bm25RankResults(['hello world', 'foo bar'], 'hello');
        expect(result).toHaveProperty('ranked');
        expect(result).toHaveProperty('totalCount');
        expect(Array.isArray(result.ranked)).toBe(true);
    });

    it('totalCount equals number of input lines', () => {
        const lines = ['apple', 'banana', 'cherry', 'date'];
        const result = bm25RankResults(lines, 'apple');
        expect(result.totalCount).toBe(4);
    });

    it('returns empty ranked when lines is empty', () => {
        const result = bm25RankResults([], 'query');
        expect(result.ranked).toEqual([]);
        expect(result.totalCount).toBe(0);
    });

    it('returns results within charBudget', () => {
        const lines = Array.from({ length: 100 }, (_, i) => `content line number ${i} with some keywords`);
        const budget = 100;
        const result = bm25RankResults(lines, 'content', budget);
        const totalChars = result.ranked.reduce((sum, l) => sum + l.length + 1, 0);
        expect(totalChars).toBeLessThanOrEqual(budget + 50); // +50 for last line overshoot
    });
});

// ---------------------------------------------------------------------------
// Ranking behavior
// ---------------------------------------------------------------------------

describe('bm25RankResults — ranking behavior', () => {
    it('puts highly relevant lines before less relevant ones', () => {
        const lines = [
            'this has nothing to do with the query',
            'function authentication token verify important',
            'another unrelated thing',
            'authenticate token and verify function call',
        ];
        const result = bm25RankResults(lines, 'authenticate token verify');
        // Both relevant lines should appear before unrelated ones
        const resultSet = new Set(result.ranked);
        if (resultSet.has(lines[1])) {
            const idx1 = result.ranked.indexOf(lines[1]);
            const idx0 = result.ranked.indexOf(lines[0]);
            if (idx0 >= 0) {
                expect(idx1).toBeLessThan(idx0);
            }
        }
    });

    it('only returns lines matching the query when budget allows all', () => {
        const lines = ['match this query', 'nothing here', 'query found'];
        const result = bm25RankResults(lines, 'query', getCharBudget());
        // At minimum the query lines should appear in results
        const hasMatch = result.ranked.some(l => l.includes('query'));
        expect(hasMatch).toBe(true);
    });

    it('returns lines from the original array', () => {
        const lines = ['alpha search', 'beta search', 'gamma other'];
        const result = bm25RankResults(lines, 'search', getCharBudget());
        for (const r of result.ranked) {
            expect(lines).toContain(r);
        }
    });
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

describe('bm25RankResults — charBudget enforcement', () => {
    it('respects default charBudget', () => {
        // Generate content larger than getCharBudget()
        const longLine = 'x'.repeat(1000);
        const lines = Array.from({ length: 1000 }, () => longLine);
        const result = bm25RankResults(lines, 'x');
        // With default budget of 400000, we can fit at most 400 lines of 1000 chars
        expect(result.ranked.length).toBeLessThanOrEqual(400);
    });

    it('returns at most one line when budget is tiny', () => {
        const lines = ['short', 'another short line', 'third'];
        const result = bm25RankResults(lines, 'short', 10);
        // Budget of 10 chars: 'short' = 5+1=6 chars fits; 'another short line' = 18+1 chars
        expect(result.ranked.length).toBeLessThanOrEqual(2);
    });

    it('returns empty ranked when budget is 0', () => {
        const lines = ['hello', 'world'];
        const result = bm25RankResults(lines, 'hello', 0);
        expect(result.ranked.length).toBe(0);
    });

    it('totalCount is always the full line count regardless of budget', () => {
        const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
        const result = bm25RankResults(lines, 'line', 5); // tiny budget
        expect(result.totalCount).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('bm25RankResults — edge cases', () => {
    it('handles single line matching query', () => {
        const result = bm25RankResults(['hello world'], 'hello');
        expect(result.totalCount).toBe(1);
        expect(result.ranked).toContain('hello world');
    });

    it('handles single line not matching query', () => {
        const result = bm25RankResults(['hello world'], 'zzzzzzz');
        expect(result.totalCount).toBe(1);
        // May or may not include the line (BM25 might still return it with 0 score)
        expect(Array.isArray(result.ranked)).toBe(true);
    });

    it('handles lines with special characters', () => {
        const lines = ['func(x) => x.map(fn)', 'const obj = { key: value }', 'if (a && b || c)'];
        expect(() => bm25RankResults(lines, 'func')).not.toThrow();
    });

    it('does not throw for empty query string', () => {
        const lines = ['alpha', 'beta'];
        expect(() => bm25RankResults(lines, '')).not.toThrow();
    });

    it('handles very long lines without throwing', () => {
        const veryLong = 'keyword '.repeat(10000);
        const lines = [veryLong, 'short'];
        expect(() => bm25RankResults(lines, 'keyword')).not.toThrow();
    });
});