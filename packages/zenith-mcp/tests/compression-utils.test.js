import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import {
    DEFAULT_COMPRESSION_KEEP_RATIO,
    computeCompressionBudget,
    isCompressionUseful,
    truncateToBudget,
} from '../dist/core/compression.js';

describe('compression DEFAULT_COMPRESSION_KEEP_RATIO', () => {
    it('defaults to 0.70', () => {
        expect(DEFAULT_COMPRESSION_KEEP_RATIO).toBe(0.70);
    });
});

describe('compression computeCompressionBudget', () => {
    it('returns 0 for non-finite rawLength', () => {
        expect(computeCompressionBudget(NaN, 1000)).toBe(0);
        expect(computeCompressionBudget(Infinity, 1000)).toBe(0);
    });

    it('returns 0 for non-positive rawLength', () => {
        expect(computeCompressionBudget(0, 1000)).toBe(0);
        expect(computeCompressionBudget(-1, 1000)).toBe(0);
    });

    it('uses default ratio 0.70', () => {
        const budget = computeCompressionBudget(1000, 10000);
        expect(budget).toBe(700);
    });

    it('respects custom keepRatio', () => {
        const budget = computeCompressionBudget(1000, 10000, 0.5);
        expect(budget).toBe(500);
    });

    it('caps budget to maxChars', () => {
        const budget = computeCompressionBudget(1000, 500, 0.7);
        expect(budget).toBe(500);
    });

    it('returns at least 1 when ratio allows it', () => {
        const budget = computeCompressionBudget(2, 10000, 0.5);
        expect(budget).toBeGreaterThanOrEqual(1);
    });

    it('handles zero maxChars', () => {
        const budget = computeCompressionBudget(1000, 0);
        expect(budget).toBe(0);
    });

    it('handles negative maxChars', () => {
        const budget = computeCompressionBudget(1000, -100);
        expect(budget).toBe(0);
    });

    it('floors maxChars', () => {
        const budget = computeCompressionBudget(1000, 100.7);
        expect(budget).toBeLessThanOrEqual(100);
    });

    it('handles very large inputs', () => {
        const largeLength = 10_000_000;
        const largeMax = 1_000_000;
        const budget = computeCompressionBudget(largeLength, largeMax);
        expect(budget).toBe(largeMax);
    });
});

describe('compression isCompressionUseful', () => {
    it('returns false for non-string inputs', () => {
        expect(isCompressionUseful(null, 'test', 1000)).toBe(false);
        expect(isCompressionUseful('test', null, 1000)).toBe(false);
        expect(isCompressionUseful(123, 'test', 1000)).toBe(false);
    });

    it('returns false for empty compressedText', () => {
        expect(isCompressionUseful('hello world', '', 1000)).toBe(false);
    });

    it('returns false for empty rawText', () => {
        expect(isCompressionUseful('', 'test', 1000)).toBe(false);
    });

    it('returns false when compressed is not smaller', () => {
        expect(isCompressionUseful('abc', 'abcd', 1000)).toBe(false);
    });

    it('returns false when compressed exceeds target budget', () => {
        expect(isCompressionUseful('hello world hello world', 'hello', 5)).toBe(false);
    });

    it('returns true when compression is effective', () => {
        expect(isCompressionUseful('hello world hello world hello world', 'hello', 10000)).toBe(true);
    });

    it('respects custom keepRatio', () => {
        // keepRatio scales the target budget (budget = raw.length * keepRatio when below maxChars).
        // Same compressed/raw values flip useful vs. not-useful based on whether keepRatio
        // produces a budget the compressed text fits inside.
        const raw = 'a'.repeat(1000);
        const compressed = 'a'.repeat(600);
        expect(isCompressionUseful(raw, compressed, 10000, 0.5)).toBe(false); // budget=500, 600 > 500
        expect(isCompressionUseful(raw, compressed, 10000, 0.7)).toBe(true);  // budget=700, 600 <= 700
    });

    it('returns false when raw length equals target budget', () => {
        const raw = 'test';
        const compressed = 't';
        expect(isCompressionUseful(raw, compressed, 4)).toBe(false);
    });
});

describe('compression truncateToBudget', () => {
    it('returns empty for non-string input', () => {
        expect(truncateToBudget(null, 100)).toEqual({ text: '', truncated: false });
        expect(truncateToBudget(undefined, 100)).toEqual({ text: '', truncated: false });
        expect(truncateToBudget(123, 100)).toEqual({ text: '', truncated: false });
    });

    it('returns text unchanged when within budget', () => {
        const result = truncateToBudget('hello', 100);
        expect(result).toEqual({ text: 'hello', truncated: false });
    });

    it('returns text unchanged when exactly at budget', () => {
        const result = truncateToBudget('hello', 5);
        expect(result).toEqual({ text: 'hello', truncated: false });
    });

    it('truncates at last newline before budget', () => {
        const text = 'line1\nline2\nline3';
        const result = truncateToBudget(text, 7);
        expect(result.truncated).toBe(true);
        expect(result.text).toBe('line1');
    });

    it('truncates at budget if no newline found', () => {
        const text = 'hello world';
        const result = truncateToBudget(text, 5);
        expect(result.truncated).toBe(true);
        expect(result.text).toBe('hello');
    });

    it('handles zero budget', () => {
        const result = truncateToBudget('hello', 0);
        expect(result.truncated).toBe(true);
        expect(result.text).toBe('');
    });

    it('handles text with no newlines', () => {
        const result = truncateToBudget('nospace', 4);
        expect(result.truncated).toBe(true);
        expect(result.text).toBe('nosp');
    });

    it('handles text with only newlines', () => {
        const result = truncateToBudget('\n\n\n', 10);
        expect(result.truncated).toBe(true);
        expect(result.text).toBe('\n\n\n');
    });

    it('handles very long text', () => {
        const text = 'a'.repeat(10000) + '\nend';
        const result = truncateToBudget(text, 100);
        expect(result.truncated).toBe(true);
        expect(result.text.length).toBeLessThanOrEqual(100);
    });
});