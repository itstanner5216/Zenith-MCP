// rev2-w2-refactor — focused proof for cubic #39 (reapply N+1 structure queries).
//
// Why this is standalone (not the full refactor_batch handler harness):
// the existing refactor-batch.test.js imports from ../dist/** and stands up a
// real git repo + on-disk SQLite index. That requires `pnpm build` + the full
// indexing pipeline, which is banned during this wave (shared worktree — must
// not run build/full suite). Per the task, "a focused proof of the query-count
// reduction is acceptable". This test reproduces the EXACT dedup algorithm that
// now lives in refactor_batch.ts (reapply path, ~line 993) against a spy-wrapped
// findSymbolStructuresByName, and proves two things:
//   1. query count drops from O(targets) to O(distinct symbol names)
//   2. the selected structs are byte-for-byte identical to the old per-target
//      code (behavior preservation).
//
// The two functions below are copied verbatim from the source so the assertions
// pin the real algorithm shape, not a paraphrase. If the source dedup changes,
// keep BATCHED in sync.
import { describe, expect, it } from 'vitest';

// --- Synthetic symbol-structure DB ------------------------------------------
// findSymbolStructuresByName(db, name) returns ALL def rows for `name` across
// every file (mirrors db-adapter.ts:1095). Two distinct names, several files.
const DB_ROWS = {
    validateCard: [
        { file_path: 'a.ts', line: 10, params: ['card'], returnText: 'void', parentKind: null, decorators: [], modifiers: [] },
        { file_path: 'b.ts', line: 20, params: ['card'], returnText: 'void', parentKind: null, decorators: [], modifiers: [] },
        { file_path: 'c.ts', line: 30, params: ['card', 'opts'], returnText: 'bool', parentKind: 'Class', decorators: ['@x'], modifiers: ['static'] },
    ],
    chargeStripe: [
        { file_path: 'd.ts', line: 40, params: ['amt'], returnText: 'Promise', parentKind: null, decorators: [], modifiers: ['async'] },
    ],
};

function makeSpyDbAdapter() {
    const calls = [];
    const findSymbolStructuresByName = (_db, name) => {
        calls.push(name);
        return DB_ROWS[name] ? DB_ROWS[name].map((r) => ({ ...r })) : [];
    };
    return { findSymbolStructuresByName, calls };
}

// Selection logic shared by both implementations (identical to source).
function selectStruct(matches, t) {
    const match = matches.find((s) => s.file_path === t.relFile && s.line === t.line);
    if (!match) return null;
    return {
        params: match.params,
        returnKind: match.returnText,
        parentKind: match.parentKind,
        decorators: match.decorators,
        modifiers: match.modifiers,
    };
}

// OLD (buggy, N+1): one query per target.
function structsOLD(findSymbolStructuresByName, db, targets) {
    return targets.map((t) => {
        const matches = findSymbolStructuresByName(db, t.symbol);
        return selectStruct(matches, t);
    });
}

// NEW (batched, verbatim from refactor_batch.ts reapply path ~line 993).
function structsBATCHED(findSymbolStructuresByName, db, targets) {
    const structsByName = new Map();
    for (const t of targets) {
        if (!structsByName.has(t.symbol)) {
            structsByName.set(t.symbol, findSymbolStructuresByName(db, t.symbol));
        }
    }
    return targets.map((t) => {
        const matches = structsByName.get(t.symbol) ?? [];
        return selectStruct(matches, t);
    });
}

// A batch of 5 targets that resolve to only 2 distinct symbol names.
const TARGETS = [
    { symbol: 'validateCard', relFile: 'a.ts', line: 10 },
    { symbol: 'validateCard', relFile: 'b.ts', line: 20 },
    { symbol: 'validateCard', relFile: 'c.ts', line: 30 },
    { symbol: 'chargeStripe', relFile: 'd.ts', line: 40 },
    { symbol: 'validateCard', relFile: 'zz.ts', line: 99 }, // no matching row -> null
];

describe('rev2-w2 reapply structure-query batching (cubic #39)', () => {
    it('OLD path issues one query PER target (the N+1 bug)', () => {
        const spy = makeSpyDbAdapter();
        structsOLD(spy.findSymbolStructuresByName, {}, TARGETS);
        // 5 targets -> 5 queries, with validateCard re-fetched 4 times.
        expect(spy.calls.length).toBe(TARGETS.length);
        expect(spy.calls.length).toBe(5);
        const validateCardQueries = spy.calls.filter((n) => n === 'validateCard').length;
        expect(validateCardQueries).toBe(4); // same rows fetched 4x — wasteful
    });

    it('BATCHED path issues one query per DISTINCT symbol name', () => {
        const spy = makeSpyDbAdapter();
        structsBATCHED(spy.findSymbolStructuresByName, {}, TARGETS);
        const distinct = new Set(TARGETS.map((t) => t.symbol));
        // 5 targets, 2 distinct names -> exactly 2 queries.
        expect(spy.calls.length).toBe(distinct.size);
        expect(spy.calls.length).toBe(2);
        // each distinct name queried exactly once
        const counts = spy.calls.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map());
        for (const [, c] of counts) expect(c).toBe(1);
    });

    it('query count is O(distinct names), independent of target count', () => {
        // Scale targets up 50x; query count must stay == distinct names.
        const many = [];
        for (let i = 0; i < 50; i++) many.push(...TARGETS);
        const spy = makeSpyDbAdapter();
        structsBATCHED(spy.findSymbolStructuresByName, {}, many);
        const distinct = new Set(many.map((t) => t.symbol));
        expect(spy.calls.length).toBe(distinct.size); // 2, not 250
    });

    it('BEHAVIOR PRESERVED: selected structs are byte-identical to OLD', () => {
        const oldOut = structsOLD(makeSpyDbAdapter().findSymbolStructuresByName, {}, TARGETS);
        const newOut = structsBATCHED(makeSpyDbAdapter().findSymbolStructuresByName, {}, TARGETS);
        expect(newOut).toStrictEqual(oldOut);
        // Spot-check the actual shape: 3 validateCard hits, 1 chargeStripe, 1 null.
        expect(newOut[0]).toStrictEqual({ params: ['card'], returnKind: 'void', parentKind: null, decorators: [], modifiers: [] });
        expect(newOut[2]).toStrictEqual({ params: ['card', 'opts'], returnKind: 'bool', parentKind: 'Class', decorators: ['@x'], modifiers: ['static'] });
        expect(newOut[3]).toStrictEqual({ params: ['amt'], returnKind: 'Promise', parentKind: null, decorators: [], modifiers: ['async'] });
        expect(newOut[4]).toBeNull(); // no row for zz.ts:99
    });
});
