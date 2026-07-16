// A19 — persisted JSON string-lists must reject non-string members as STORE_CORRUPT,
// never coerce them into facts. Oracle: hand-authored expectations, independent of impl.
import { describe, it, expect } from 'vitest';
import { parseJsonStringArray } from '../dist/core/intelligence/questions/file.js';

describe('A19: JSON string-array parsing', () => {
    it('returns a clean string array for a valid list', () => {
        expect(parseJsonStringArray('["a","b"]', 'ctx')).toEqual(['a', 'b']);
    });
    it('treats NULL/empty as a legitimate absent list', () => {
        expect(parseJsonStringArray(null, 'ctx')).toEqual([]);
        expect(parseJsonStringArray('', 'ctx')).toEqual([]);
    });
    it('anti-vacuity: unparseable JSON and non-array JSON are already STORE_CORRUPT', () => {
        expect(() => parseJsonStringArray('{oops', 'ctx')).toThrow(/^STORE_CORRUPT:/);
        expect(() => parseJsonStringArray('{"a":1}', 'ctx')).toThrow(/^STORE_CORRUPT:/);
    });
    it('rejects a non-string-member array [1,null,{}] as STORE_CORRUPT (A19)', () => {
        expect(() => parseJsonStringArray('[1, null, {}]', 'ctx')).toThrow(/^STORE_CORRUPT:/);
    });
    it('rejects a mixed array with one non-string member', () => {
        expect(() => parseJsonStringArray('["a", 2]', 'ctx')).toThrow(/^STORE_CORRUPT:/);
    });
});
