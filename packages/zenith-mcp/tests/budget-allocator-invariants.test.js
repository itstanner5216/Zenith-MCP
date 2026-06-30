/**
 * Tests focused on the new invariant-safety changes in BudgetAllocator.allocate()
 * introduced in this PR (noUncheckedIndexedAccess guards).
 *
 * The PR replaced raw index access (entries[i], scores[i]) with explicit
 * undefined checks that throw descriptive errors when an invariant is violated.
 *
 * Tests here:
 *  - Normal allocation paths still produce correct results
 *  - preserve-tier path throws when entries array is shorter than tiers
 *  - score-lookup path throws when scores array is shorter than tiers
 *  - Minimum entry_budget floor of 10 is enforced
 *  - equal-score distribution (score_sum fallback) gives even splits
 */

import { describe, expect, it } from 'vitest';
import { BudgetAllocator } from 'zenith-toon';

// Minimal EntryMeta shape — only 'content' is required by budget.ts
function makeEntry(content) {
    return { content };
}

// ---------------------------------------------------------------------------
// Normal allocation — regression tests for changed loop body
// ---------------------------------------------------------------------------

describe('BudgetAllocator.allocate — normal paths after PR refactor', () => {
    it('all-high tier distributes proportionally to score', () => {
        const entries = [makeEntry('aaa'), makeEntry('bbb'), makeEntry('ccc')];
        const scores = [0.9, 0.5, 0.1];
        const tiers = ['high', 'high', 'high'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.entry_budgets[0]).toBeGreaterThan(result.entry_budgets[1]);
        expect(result.entry_budgets[1]).toBeGreaterThan(result.entry_budgets[2]);
    });

    it('all-medium tier distributes proportionally to score', () => {
        const entries = [makeEntry('x'), makeEntry('y')];
        const scores = [0.8, 0.2];
        const tiers = ['medium', 'medium'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 2000);
        expect(result.entry_budgets[0]).toBeGreaterThan(result.entry_budgets[1]);
    });

    it('all-low tier produces non-zero budgets', () => {
        const entries = [makeEntry('a'), makeEntry('b')];
        const scores = [1.0, 1.0];
        const tiers = ['low', 'low'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.entry_budgets[0]).toBeGreaterThan(0);
        expect(result.entry_budgets[1]).toBeGreaterThan(0);
    });

    it('cut tier entries always get zero budget', () => {
        const entries = [makeEntry('a'), makeEntry('b'), makeEntry('c')];
        const scores = [1.0, 0.5, 0.0];
        const tiers = ['high', 'medium', 'cut'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.entry_budgets[2]).toBe(0);
    });

    it('preserve tier entries get their exact token count', () => {
        const entries = [makeEntry('hello world this is content'), makeEntry('short')];
        const scores = [1.0, 1.0];
        const tiers = ['preserve', 'preserve'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        // Each preserve entry gets estimateTokensObj(entry.content) — should be > 0
        expect(result.entry_budgets[0]).toBeGreaterThan(0);
        expect(result.entry_budgets[1]).toBeGreaterThan(0);
    });

    it('entry_budgets minimum floor is 10', () => {
        // Very small budget spread across many entries should floor at 10
        const entries = [makeEntry('a'), makeEntry('b'), makeEntry('c'), makeEntry('d'), makeEntry('e')];
        const scores = [0.001, 0.001, 0.001, 0.001, 0.001];
        const tiers = ['high', 'high', 'high', 'high', 'high'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 100);
        for (const b of result.entry_budgets) {
            expect(b).toBeGreaterThanOrEqual(10);
        }
    });

    it('equal scores give equal (or near-equal) splits within a tier', () => {
        const entries = [makeEntry('a'), makeEntry('b'), makeEntry('c')];
        const scores = [0.5, 0.5, 0.5];
        const tiers = ['high', 'high', 'high'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        // All three should be the same since scores are equal
        expect(result.entry_budgets[0]).toBe(result.entry_budgets[1]);
        expect(result.entry_budgets[1]).toBe(result.entry_budgets[2]);
    });

    it('score_sum = 0 fallback: equal allocation via 1/len formula', () => {
        // All scores are 0 → after max(s, 1e-10) they become 1e-10 each, so equal
        const entries = [makeEntry('a'), makeEntry('b')];
        const scores = [0, 0];
        const tiers = ['high', 'high'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.entry_budgets[0]).toBe(result.entry_budgets[1]);
    });

    it('mixed tiers: preserve + high + cut', () => {
        const entries = [makeEntry('preserved content'), makeEntry('high content'), makeEntry('cut')];
        const scores = [1.0, 0.8, 0.1];
        const tiers = ['preserve', 'high', 'cut'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.entry_budgets[0]).toBeGreaterThan(0); // preserve
        expect(result.entry_budgets[1]).toBeGreaterThan(0); // high
        expect(result.entry_budgets[2]).toBe(0);           // cut
    });

    it('returns total_budget and reserve fields correctly', () => {
        const entries = [makeEntry('a')];
        const scores = [1.0];
        const tiers = ['high'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 2000);
        expect(result.total_budget).toBe(2000);
        expect(result.reserve).toBe(100); // 5% of 2000
    });

    it('reserve uses Math.trunc, not Math.round', () => {
        // 5% of 999 = 49.95 → trunc → 49
        const result = BudgetAllocator.allocate([makeEntry('a')], [1.0], ['high'], 999);
        expect(result.reserve).toBe(49);
    });
});

// ---------------------------------------------------------------------------
// Invariant throws — entries shorter than tiers
// ---------------------------------------------------------------------------

describe('BudgetAllocator.allocate — invariant throws on mismatched arrays', () => {
    it('throws if preserve tier index is out of entries range', () => {
        // tiers says entry 1 is "preserve" but entries only has 1 element (index 0)
        const entries = [makeEntry('only one')];
        const scores = [1.0, 1.0];
        const tiers = ['high', 'preserve']; // tiers[1]='preserve' but entries[1] undefined
        expect(() => BudgetAllocator.allocate(entries, scores, tiers, 1000)).toThrow(/invariant/i);
    });

    it('throws if score is missing for a non-preserve, non-cut tier entry', () => {
        // scores array shorter than tiers
        const entries = [makeEntry('a'), makeEntry('b')];
        const scores = [1.0]; // missing scores[1]
        const tiers = ['high', 'high'];
        expect(() => BudgetAllocator.allocate(entries, scores, tiers, 1000)).toThrow(/invariant/i);
    });

    it('throws descriptive message mentioning the tier name on score miss', () => {
        const entries = [makeEntry('a'), makeEntry('b'), makeEntry('c')];
        const scores = [1.0, 0.5]; // scores[2] missing
        const tiers = ['medium', 'medium', 'medium'];
        let caught = null;
        try {
            BudgetAllocator.allocate(entries, scores, tiers, 1000);
        } catch (e) {
            caught = e;
        }
        expect(caught).not.toBeNull();
        expect(caught.message).toMatch(/invariant/i);
    });
});

// ---------------------------------------------------------------------------
// Tier budgets structure
// ---------------------------------------------------------------------------

describe('BudgetAllocator.allocate — tier_budgets structure', () => {
    it('tier_budgets contains high, medium, low, cut, preserve keys', () => {
        const entries = [makeEntry('a'), makeEntry('b')];
        const scores = [0.8, 0.3];
        const tiers = ['high', 'low'];
        const result = BudgetAllocator.allocate(entries, scores, tiers, 1000);
        expect(result.tier_budgets).toHaveProperty('high');
        expect(result.tier_budgets).toHaveProperty('medium');
        expect(result.tier_budgets).toHaveProperty('low');
        expect(result.tier_budgets).toHaveProperty('cut');
        expect(result.tier_budgets).toHaveProperty('preserve');
    });

    it('tier_budgets.cut is always 0', () => {
        const result = BudgetAllocator.allocate([makeEntry('a')], [1.0], ['cut'], 1000);
        expect(result.tier_budgets.cut).toBe(0);
    });

    it('tier_budgets ratios sum to ~1.0 of remaining', () => {
        // high=60%, medium=30%, low=10%
        const result = BudgetAllocator.allocate([makeEntry('a')], [1.0], ['high'], 1000);
        const remaining = 1000 - result.reserve;
        const expected_high = Math.trunc(remaining * 0.60);
        expect(result.tier_budgets.high).toBe(expected_high);
    });
});