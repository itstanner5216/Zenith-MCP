import { describe, expect, it } from 'vitest';
import { errorMessage } from '../dist/tools/types.js';

describe('errorMessage', () => {
    it('extracts message from Error instances', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
    });

    it('converts non-Error values to string', () => {
        expect(errorMessage('plain string')).toBe('plain string');
        expect(errorMessage(42)).toBe('42');
        expect(errorMessage(null)).toBe('null');
        expect(errorMessage(undefined)).toBe('undefined');
    });

    it('handles TypeError and other Error subclasses', () => {
        expect(errorMessage(new TypeError('type fail'))).toBe('type fail');
        expect(errorMessage(new RangeError('range fail'))).toBe('range fail');
    });
});
