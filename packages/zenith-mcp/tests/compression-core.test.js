import { describe, expect, it } from 'vitest';

import {
    computeCompressionBudget,
    isCompressionUseful,
    truncateToBudget,
} from '../dist/core/compression.js';

describe('compression core', () => {
    it('targets 70 percent of the original content by default', () => {
        expect(computeCompressionBudget(1000, 5000)).toBe(700);
        expect(computeCompressionBudget(1000, 600)).toBe(600);
        expect(computeCompressionBudget(0, 5000)).toBe(0);
    });

    it('rejects outputs that are not actually compressed enough', () => {
        const raw = 'a'.repeat(1000);
        expect(isCompressionUseful(raw, 'b'.repeat(700), 5000)).toBe(true);
        expect(isCompressionUseful(raw, 'b'.repeat(701), 5000)).toBe(false);
        expect(isCompressionUseful(raw, 'b'.repeat(1000), 5000)).toBe(false);
        expect(isCompressionUseful(raw, '', 5000)).toBe(false);
    });

    it('truncates cleanly on a newline when possible', () => {
        const text = 'alpha\nbeta\ngamma\ndelta';
        expect(truncateToBudget(text, 10)).toEqual({
            text: 'alpha\nbeta',
            truncated: true,
        });
        expect(truncateToBudget(text, 100)).toEqual({
            text,
            truncated: false,
        });
    });
});
