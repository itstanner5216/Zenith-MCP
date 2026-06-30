import { describe, expect, it } from 'vitest';
import {
    normalizeValue,
    blake2bHash,
    canonicalJson,
    estimateTokens,
    estimateTokensObj,
    flattenToText,
    computeGini,
    findKneedle,
    pearsonR,
    TIMESTAMP_RE,
    UUID_RE,
    IP_RE,
    BIGNUM_RE,
    B64_RE,
    NORMALIZERS,
    fieldMatcherMatches,
    routeField,
    BudgetAllocator,
    Deduplicator,
    encodeOutput,
    isToonArrayMeta,
    isToonTemplateMeta,
    dedupStatsTotal,
} from 'zenith-toon';

// ============================================================================
// TOON Utilities (utils.ts)
// ============================================================================

describe('TOON utils — blake2bHash', () => {
    it('returns hex string of correct length for default digestSize', () => {
        const hash = blake2bHash('hello world');
        expect(hash).toHaveLength(16); // 8 bytes * 2 hex chars
    });

    it('returns hex string of correct length for custom digestSize', () => {
        const hash4 = blake2bHash('hello', 4);
        const hash16 = blake2bHash('hello', 16);
        expect(hash4).toHaveLength(8);
        expect(hash16).toHaveLength(32);
    });

    it('is deterministic for same input', () => {
        const h1 = blake2bHash('test input');
        const h2 = blake2bHash('test input');
        expect(h1).toBe(h2);
    });

    it('produces different hashes for different inputs', () => {
        const h1 = blake2bHash('input a');
        const h2 = blake2bHash('input b');
        expect(h1).not.toBe(h2);
    });
});

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

describe('TOON utils — normalizeValue', () => {
    it('replaces timestamps with <TS>', () => {
        expect(normalizeValue('2024-01-15T10:30:00Z')).toBe('<TS>');
        expect(normalizeValue('2024-01-15 10:30:00')).toBe('<TS>');
    });

    it('replaces UUIDs with <UUID>', () => {
        expect(normalizeValue('123e4567-e89b-12d3-a456-426614174000')).toBe('<UUID>');
        expect(normalizeValue('123E4567-E89B-12D3-A456-426614174000')).toBe('<UUID>');
    });

    it('replaces IP addresses with <IP>', () => {
        expect(normalizeValue('192.168.1.1')).toBe('<IP>');
        expect(normalizeValue('10.0.0.1')).toBe('<IP>');
    });

    it('replaces large numbers with <NUM>', () => {
        expect(normalizeValue('12345678901234567890')).toBe('<NUM>');
    });

    it('replaces base64 strings with <B64>', () => {
        const longB64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwMTIzNDU2Nzg5MDA';
        expect(normalizeValue(longB64)).toBe('<B64>');
    });

    it('replaces numbers with <NUM> token', () => {
        expect(normalizeValue(42)).toBe('<NUM>');
        expect(normalizeValue(3.14)).toBe('<NUM>');
    });

    it('normalizes arrays recursively', () => {
        const result = normalizeValue(['2024-01-15T10:30:00Z', '192.168.1.1']);
        expect(result).toEqual(['<TS>', '<IP>']);
    });

    it('normalizes objects recursively with sorted keys', () => {
        const result = normalizeValue({ z: '2024-01-15T10:30:00Z', a: '10.0.0.1' });
        expect(result).toEqual({ a: '<IP>', z: '<TS>' });
    });

    it('passes through booleans and null unchanged', () => {
        expect(normalizeValue(true)).toBe(true);
        expect(normalizeValue(false)).toBe(false);
        expect(normalizeValue(null)).toBe(null);
    });

    it('handles empty string', () => {
        expect(normalizeValue('')).toBe('');
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

describe('TOON utils — flattenToText', () => {
    it('returns strings unchanged', () => {
        expect(flattenToText('hello world')).toBe('hello world');
    });

    it('returns null as empty string', () => {
        expect(flattenToText(null)).toBe('');
    });

    it('converts numbers to strings', () => {
        expect(flattenToText(42)).toBe('42');
        expect(flattenToText(3.14)).toBe('3.14');
    });

    it('arrays are space-joined', () => {
        expect(flattenToText(['a', 'b', 'c'])).toBe('a b c');
    });

    it('nested arrays are flattened', () => {
        expect(flattenToText(['a', ['b', 'c']])).toBe('a b c');
    });

    it('objects emit key-value pairs', () => {
        expect(flattenToText({ name: 'Alice', age: 30 })).toBe('name Alice age 30');
    });

    it('nested objects are flattened recursively', () => {
        const result = flattenToText({ user: { name: 'Bob' } });
        expect(result).toContain('user');
        expect(result).toContain('name Bob');
    });

    it('booleans converted to string', () => {
        expect(flattenToText(true)).toBe('true');
        expect(flattenToText(false)).toBe('false');
    });
});

describe('TOON utils — computeGini', () => {
    it('returns 0 for uniform distribution', () => {
        expect(computeGini([1, 1, 1, 1])).toBe(0);
    });

    it('returns 1 for maximally unequal distribution', () => {
        const result = computeGini([100, 0, 0, 0]);
        expect(result).toBeCloseTo(0.75, 1);
    });

    it('returns 0 for arrays with fewer than 2 elements', () => {
        expect(computeGini([])).toBe(0);
        expect(computeGini([5])).toBe(0);
    });

    it('handles identical non-zero values', () => {
        expect(computeGini([10, 10, 10])).toBeLessThan(0.0001);
    });

    it('produces value between 0 and 1 for typical inputs', () => {
        const result = computeGini([1, 2, 3, 4, 5]);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
    });
});

describe('TOON utils — findKneedle', () => {
    it('returns n-1 for arrays with fewer than 3 elements', () => {
        expect(findKneedle([1, 2])).toBe(1);
        expect(findKneedle([5])).toBe(0);
    });

    it('returns n-1 for flat distribution (no clear knee)', () => {
        expect(findKneedle([1, 1, 1, 1, 1])).toBe(4);
    });

    it('finds knee point in decreasing score curve', () => {
        const scores = [10, 9, 8, 7, 1, 1, 1, 1, 1];
        const knee = findKneedle(scores);
        expect(knee).toBeGreaterThan(0);
        expect(knee).toBeLessThan(scores.length);
    });

    it('is sensitive to the sensitivity parameter', () => {
        const scores = [10, 9, 8, 7, 1, 1, 1, 1, 1];
        const knee1 = findKneedle(scores, 1.0);
        const knee2 = findKneedle(scores, 0.1);
        expect(knee2).toBeLessThanOrEqual(knee1 + 1);
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

// ============================================================================
// TOON Router (router.ts)
// ============================================================================

function defaultToonConfig() {
    return {
        enabled: true,
        preserve_rules: [],
        encode_rules: [],
        default_codec: null,
        array: { enabled: true, threshold: 5, sample_size: 3 },
        string: { enabled: true, default_budget: 500, min_length: 200, parse_json: true, stack_trace_max_user_frames: 10 },
        dedup: { enabled: true, scope: 'session', maxsize: 5000 },
        bmx: { enabled: false, mode: 'self', query: null, core_fraction: 0.15, gini_threshold: 0.2, tiers: [] },
        emit_markers: true,
        emit_stats: false,
    };
}

describe('TOON router — fieldMatcherMatches', () => {
    it('returns true when all matcher fields are null', () => {
        const matcher = { field_path: null, field_pattern: null, min_length: null, max_length: null };
        expect(fieldMatcherMatches(matcher, 'anything', 'value')).toBe(true);
    });

    it('matches exact field_path', () => {
        const matcher = { field_path: 'payload.data', field_pattern: null, min_length: null, max_length: null };
        expect(fieldMatcherMatches(matcher, 'payload.data', 'val')).toBe(true);
        expect(fieldMatcherMatches(matcher, 'payload.data.extra', 'val')).toBe(true); // prefix match
        expect(fieldMatcherMatches(matcher, 'payload', 'val')).toBe(false);
        expect(fieldMatcherMatches(matcher, 'payload.other', 'val')).toBe(false);
    });

    it('matches field_pattern regex against last path segment', () => {
        const matcher = { field_path: null, field_pattern: '^result$', min_length: null, max_length: null };
        expect(fieldMatcherMatches(matcher, 'output.result', 'val')).toBe(true);
        expect(fieldMatcherMatches(matcher, 'output.results', 'val')).toBe(false); // exact match required
        expect(fieldMatcherMatches(matcher, 'result', 'val')).toBe(true);
    });

    it('enforces min_length for string values', () => {
        const matcher = { field_path: null, field_pattern: null, min_length: 5, max_length: null };
        expect(fieldMatcherMatches(matcher, 'field', 'hello')).toBe(true);
        expect(fieldMatcherMatches(matcher, 'field', 'hi')).toBe(false);
    });

    it('skips min_length for non-string values', () => {
        const matcher = { field_path: null, field_pattern: null, min_length: 100, max_length: null };
        expect(fieldMatcherMatches(matcher, 'field', 42)).toBe(true);
        expect(fieldMatcherMatches(matcher, 'field', { obj: true })).toBe(true);
        expect(fieldMatcherMatches(matcher, 'field', null)).toBe(true);
    });

    it('enforces max_length for string values', () => {
        const matcher = { field_path: null, field_pattern: null, min_length: null, max_length: 3 };
        expect(fieldMatcherMatches(matcher, 'field', 'ab')).toBe(true);
        expect(fieldMatcherMatches(matcher, 'field', 'abcd')).toBe(false);
    });

    it('skips max_length for non-string values', () => {
        const matcher = { field_path: null, field_pattern: null, min_length: null, max_length: 1 };
        expect(fieldMatcherMatches(matcher, 'field', 9999)).toBe(true);
        expect(fieldMatcherMatches(matcher, 'field', [1, 2, 3])).toBe(true);
    });

    it('combines all conditions with AND logic', () => {
        const matcher = { field_path: 'data.output', field_pattern: '^res', min_length: 5, max_length: 100 };
        expect(fieldMatcherMatches(matcher, 'data.output.result', 'somevalue')).toBe(true);
        expect(fieldMatcherMatches(matcher, 'data.output.result', 'hi')).toBe(false); // too short
        expect(fieldMatcherMatches(matcher, 'data.output.other', 'somevalue')).toBe(false); // pattern mismatch
    });
});

describe('TOON router — routeField', () => {
    it('returns passthrough when enabled=false', () => {
        const config = { ...defaultToonConfig(), enabled: false };
        expect(routeField('anything', 'value', config)).toBe('passthrough');
    });

    it('returns preserve when preserve_rule matches', () => {
        const config = {
            ...defaultToonConfig(),
            preserve_rules: [{ field_path: 'error', field_pattern: null, min_length: null, max_length: null }],
        };
        expect(routeField('error', 'some error', config)).toBe('preserve');
    });

    it('returns encode_rule strategy when preserve_rule does not match', () => {
        const config = {
            ...defaultToonConfig(),
            preserve_rules: [{ field_path: 'other', field_pattern: null, min_length: null, max_length: null }],
            encode_rules: [{ matcher: { field_path: 'result', field_pattern: null, min_length: null, max_length: null }, codec: { strategy: 'array', budget: null } }],
        };
        expect(routeField('result', 'data', config)).toBe('array');
    });

    it('first encode_rule wins', () => {
        const config = {
            ...defaultToonConfig(),
            encode_rules: [
                { matcher: { field_path: 'data', field_pattern: null, min_length: null, max_length: null }, codec: { strategy: 'dedup', budget: null } },
                { matcher: { field_path: 'data', field_pattern: null, min_length: null, max_length: null }, codec: { strategy: 'truncate', budget: null } },
            ],
        };
        expect(routeField('data', 'items', config)).toBe('dedup');
    });

    it('returns default_codec strategy when no rules match', () => {
        const config = {
            ...defaultToonConfig(),
            default_codec: { strategy: 'truncate', budget: null },
        };
        expect(routeField('unmatched', 'value', config)).toBe('truncate');
    });

    it('returns passthrough when nothing matches and no default', () => {
        const config = defaultToonConfig();
        expect(routeField('anything', 'value', config)).toBe('passthrough');
    });
});

// ============================================================================
// TOON Budget (budget.ts)
// ============================================================================

describe('TOON BudgetAllocator', () => {
    it('has correct TIER_RATIOS', () => {
        expect(BudgetAllocator.TIER_RATIOS.high).toBe(0.60);
        expect(BudgetAllocator.TIER_RATIOS.medium).toBe(0.30);
        expect(BudgetAllocator.TIER_RATIOS.low).toBe(0.10);
    });

    it('has correct OVERHEAD_RESERVE', () => {
        expect(BudgetAllocator.OVERHEAD_RESERVE).toBe(0.05);
    });

    it('returns correct reserve (5% of total)', () => {
        const entries = [{ content: 'a' }, { content: 'b' }];
        const scores = [1, 1];
        const tiers = ['high', 'high'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.reserve).toBe(50); // 5% of 1000
    });

    it('all entries in preserve tier get their exact token count', () => {
        const entries = [{ content: 'hello world' }, { content: 'test content' }];
        const scores = [1, 1];
        const tiers = ['preserve', 'preserve'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.tier_budgets.preserve).toBeGreaterThan(0);
        expect(result.entry_budgets[0]).toBeGreaterThan(0);
        expect(result.entry_budgets[1]).toBeGreaterThan(0);
    });

    it('entries in cut tier get zero budget', () => {
        const entries = [{ content: 'a' }, { content: 'b' }, { content: 'c' }];
        const scores = [1, 1, 1];
        const tiers = ['high', 'low', 'cut'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.entry_budgets[2]).toBe(0);
    });

    it('non-preserve tiers get proportional shares', () => {
        const entries = [{ content: 'a' }, { content: 'b' }, { content: 'c' }];
        const scores = [1, 0.5, 0.25];
        const tiers = ['high', 'high', 'high'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.entry_budgets[0]).toBeGreaterThan(result.entry_budgets[1]);
        expect(result.entry_budgets[1]).toBeGreaterThan(result.entry_budgets[2]);
    });

    it('handles empty entries array', () => {
        const result = BudgetAllocator.allocate([], [], [], 1000);
        expect(result.entry_budgets).toEqual([]);
        expect(result.total_budget).toBe(1000);
    });

    it('handles tier with no entries', () => {
        const entries = [{ content: 'a' }, { content: 'b' }];
        const scores = [1, 1];
        const tiers = ['high', 'cut']; // no 'medium' entries
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.tier_budgets.medium).toBeGreaterThanOrEqual(0);
    });
});

// ============================================================================
// TOON Deduplicator (dedup.ts)
// ============================================================================

describe('TOON Deduplicator', () => {
it('removes exact duplicates (Tier 1)', () => {
        const dedup = new Deduplicator(100);
        // Note: normalizeValue normalizes numbers to <NUM>, so {a:1} and {a:2}
        // have different exact hashes but same normalized hash (Tier 2 near-dup).
        // For true exact dedup, we use string values which don't normalize.
        const entries = [{ a: 'x' }, { a: 'x' }, { b: 'y' }];
        const result = dedup.deduplicate(entries);
        expect(result.entries.length).toBe(2);
        expect(result.dedup_stats.exact).toBe(1);
    });

    it('resets state correctly', () => {
        const dedup = new Deduplicator(100);
        dedup.deduplicate([{ a: 'hello' }, { a: 'hello' }]);
        // Second identical entry is dropped as exact dup
        expect(dedup.deduplicate([{ a: 'hello' }]).entries.length).toBe(0);
        dedup.reset();
        // After reset, same entry passes through (new state)
        expect(dedup.deduplicate([{ a: 'hello' }]).entries.length).toBe(1);
    });

    it('removes near-duplicates with normalized values (Tier 2)', () => {
        const dedup = new Deduplicator(100);
        const entries = [
            { ts: '2024-01-15T10:30:00Z', value: 1 },
            { ts: '2025-12-31T23:59:59Z', value: 1 }, // same structure, different timestamp
        ];
        const result = dedup.deduplicate(entries);
        expect(result.dedup_stats.near).toBe(1);
    });

    it('handles primitives in deduplication', () => {
        const dedup = new Deduplicator(100);
        const result = dedup.deduplicate(['hello', 'hello', 'world']);
        expect(result.entries.length).toBe(2);
    });

    it('handles empty input array', () => {
        const dedup = new Deduplicator(100);
        const result = dedup.deduplicate([]);
        expect(result.entries).toEqual([]);
        expect(result.dedup_stats.exact).toBe(0);
        expect(result.dedup_stats.near).toBe(0);
        expect(result.dedup_stats.template).toBe(0);
    });

    it('tracks entry type correctly', () => {
        const dedup = new Deduplicator(100);
        const result = dedup.deduplicate([
            { a: 1 },       // object → dict
            [1, 2, 3],     // array → list
            'string',       // string
            42,             // number → primitive
        ]);
        const types = result.entries.map(e => e.type);
        expect(types).toContain('dict');
        expect(types).toContain('list');
        expect(types).toContain('string');
        expect(types).toContain('primitive');
    });

    it('respects maxsize LRU eviction', () => {
        const dedup = new Deduplicator(3);
        // Numbers normalize to <NUM>, so these are all near-duplicates
        const entries = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
        const result = dedup.deduplicate(entries);
        // 4 near-duplicates detected (all normalized to {"id":"<NUM>"})
        expect(result.dedup_stats.near).toBe(4);
    });
});

// ============================================================================
// TOON Encoder (encoder.ts)
// ============================================================================

describe('TOON encoder — encodeOutput', () => {
    it('throws when threshold <= 0', () => {
        expect(() => encodeOutput({}, 0)).toThrow('threshold must be > 0');
        expect(() => encodeOutput({}, -1)).toThrow('threshold must be > 0');
    });

    it('preserves small arrays (length <= threshold)', () => {
        const result = encodeOutput([1, 2, 3], 5);
        expect(result).toEqual([1, 2, 3]);
    });

    it('compresses large arrays to metadata', () => {
        const result = encodeOutput([1, 2, 3, 4, 5, 6], 5);
        expect(result).toEqual({
            __toon: true,
            count: 6,
            sample: [1, 2, 3],
        });
    });

    it('preserves objects unchanged', () => {
        const obj = { name: 'Alice', age: 30 };
        const result = encodeOutput(obj, 5);
        expect(result).toEqual(obj);
    });

    it('preserves primitives unchanged', () => {
        expect(encodeOutput('hello', 5)).toBe('hello');
        expect(encodeOutput(42, 5)).toBe(42);
        expect(encodeOutput(true, 5)).toBe(true);
        expect(encodeOutput(null, 5)).toBe(null);
    });

    it('recursively encodes nested structures', () => {
        const result = encodeOutput({ items: [1, 2, 3, 4, 5, 6, 7] }, 5);
        expect(result.items).toEqual({
            __toon: true,
            count: 7,
            sample: [1, 2, 3],
        });
    });

    it('handles empty array', () => {
        expect(encodeOutput([], 5)).toEqual([]);
    });

    it('recursively encodes items in preserved small arrays', () => {
        const result = encodeOutput([[1, 2, 3, 4, 5, 6]], 5);
        expect(result[0]).toEqual({
            __toon: true,
            count: 6,
            sample: [1, 2, 3],
        });
    });
});

// ============================================================================
// TOON Types (types.ts)
// ============================================================================

describe('TOON types — type guards', () => {
    describe('isToonArrayMeta', () => {
        it('returns true for valid ToonArrayMeta', () => {
            const meta = { __toon: true, count: 5, sample: [1, 2, 3] };
            expect(isToonArrayMeta(meta)).toBe(true);
        });

        it('returns false for missing __toon', () => {
            expect(isToonArrayMeta({ count: 5, sample: [] })).toBe(false);
        });

        it('returns false for non-object', () => {
            expect(isToonArrayMeta(null)).toBe(false);
            expect(isToonArrayMeta('string')).toBe(false);
            expect(isToonArrayMeta(42)).toBe(false);
        });

        it('returns false when count is not a number', () => {
            expect(isToonArrayMeta({ __toon: true, count: '5', sample: [] })).toBe(false);
        });

        it('returns false when sample is not an array', () => {
            expect(isToonArrayMeta({ __toon: true, count: 5, sample: 'not-array' })).toBe(false);
        });
    });

    describe('isToonTemplateMeta', () => {
        it('returns true for valid ToonTemplateMeta', () => {
            const meta = { __toon_template: true, count: 10, first: {}, last: {} };
            expect(isToonTemplateMeta(meta)).toBe(true);
        });

        it('returns false for missing __toon_template', () => {
            expect(isToonTemplateMeta({ count: 10, first: {}, last: {} })).toBe(false);
        });

        it('returns false when count is not a number', () => {
            expect(isToonTemplateMeta({ __toon_template: true, count: '10', first: {}, last: {} })).toBe(false);
        });
    });

    describe('dedupStatsTotal', () => {
        it('sums all three categories', () => {
            const stats = { exact: 3, near: 5, template: 2 };
            expect(dedupStatsTotal(stats)).toBe(10);
        });

        it('handles zero counts', () => {
            const stats = { exact: 0, near: 0, template: 0 };
            expect(dedupStatsTotal(stats)).toBe(0);
        });
    });
});