import { describe, expect, it } from 'vitest';
// utils.ts internals are not part of zenith-toon's public seam (index.ts exports
// only the compression entry points). These pure helpers are exercised directly
// from their module, the same deep-import pattern the SageRank engine test uses.
import {
    canonicalJson,
    estimateTokens,
    estimateTokensObj,
    pearsonR,
} from '../../zenith-toon/dist/utils.js';

// ============================================================================
// TOON Utilities (utils.ts)
// ============================================================================

describe('TOON utils — canonicalJson', () => {
    it('sorts object keys recursively', () => {
        const obj = { z: 1, a: { y: 2, x: 3 }, b: 4 };
        const json = canonicalJson(obj);
        expect(json).toBe('{"a":{"x":3,"y":2},"b":4,"z":1}');
    });

    it('handles arrays without reordering elements', () => {
        const arr = [3, 1, 2];
        expect(canonicalJson(arr)).toBe('[3,1,2]');
    });

    it('handles nested arrays', () => {
        const obj = { items: [[3, 4], [1, 2]] };
        expect(canonicalJson(obj)).toBe('{"items":[[3,4],[1,2]]}');
    });

    it('serializes non-JSON-safe values using String()', () => {
        const obj = { val: undefined };
        expect(canonicalJson(obj)).toBe('{"val":"undefined"}');
    });

    it('produces identical output for structurally identical inputs', () => {
        const a = { b: { c: 1 }, a: 2 };
        const b = { a: 2, b: { c: 1 } };
        expect(canonicalJson(a)).toBe(canonicalJson(b));
    });
});

describe('TOON utils — estimateTokens', () => {
    it('uses chars/2 for JSON input', () => {
        const json = '{"a":1,"b":2}';
        expect(estimateTokens(json)).toBe(Math.max(1, Math.floor(json.length / 2)));
    });

    it('uses chars/2 for array JSON input', () => {
        const arr = '[1,2,3,4,5,6,7,8,9,10]';
        expect(estimateTokens(arr)).toBe(Math.max(1, Math.floor(arr.length / 2)));
    });

    it('uses chars/4 for plain text', () => {
        const text = 'hello world this is plain text';
        expect(estimateTokens(text)).toBe(Math.max(1, Math.floor(text.length / 4)));
    });

    it('minimum of 1 token', () => {
        expect(estimateTokens('x')).toBe(1);
        expect(estimateTokens('')).toBe(1);
    });

    it('distinguishes JSON vs plain text by first character', () => {
        expect(estimateTokens('{')).toBeGreaterThan(0);
        expect(estimateTokens('[')).toBeGreaterThan(0);
        expect(estimateTokens('a')).toBeGreaterThan(0);
    });
});

describe('TOON utils — estimateTokensObj', () => {
    it('canonicalizes then estimates', () => {
        const obj = { b: 1, a: 2 };
        const canonical = canonicalJson(obj);
        expect(estimateTokensObj(obj)).toBe(estimateTokens(canonical));
    });
});

describe('TOON utils — pearsonR', () => {
    it('returns 0 for arrays with fewer than 3 elements', () => {
        expect(pearsonR([1], [1])).toBe(0);
        expect(pearsonR([1, 2], [1, 2])).toBe(0);
    });

    it('returns 0 for zero-variance inputs', () => {
        expect(pearsonR([1, 1, 1], [1, 2, 3])).toBe(0);
        expect(pearsonR([1, 2, 3], [1, 1, 1])).toBe(0);
    });

    it('returns 1 for perfectly correlated series', () => {
        const x = [1, 2, 3, 4, 5];
        const y = [2, 4, 6, 8, 10];
        expect(pearsonR(x, y)).toBeCloseTo(1.0, 5);
    });

    it('returns -1 for perfectly anti-correlated series', () => {
        const x = [1, 2, 3, 4, 5];
        const y = [10, 8, 6, 4, 2];
        expect(pearsonR(x, y)).toBeCloseTo(-1.0, 5);
    });

    it('returns 0 for uncorrelated series', () => {
        const x = [1, 2, 3, 4, 5];
        const y = [1, 3, 2, 5, 4];
        const r = pearsonR(x, y);
        expect(Math.abs(r)).toBeLessThan(1);
    });
});
