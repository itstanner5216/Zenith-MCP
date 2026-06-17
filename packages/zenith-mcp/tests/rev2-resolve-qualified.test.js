// rev2-resolve-qualified.test.js
//
// Regression tests for review-2 findings [M] (gemini #6) and [N] (cubic #61)
// in indexing/resolve.ts — multi-level dot-qualified edge resolution + the
// parent-lookup N+1 mitigation (the per-pass parent memo).
//
// [M] MULTI-LEVEL qualifiers: for `Outer.Inner.method` the OLD code compared
//     the immediate parent's name (`Inner`) against the WHOLE qualifier string
//     (`Outer.Inner`), so it NEVER matched. The fix splits the qualifier on '.'
//     and walks the candidate's ancestor chain innermost-first, requiring
//     parent===Inner, grandparent===Outer. Link iff exactly one candidate's
//     full chain matches. The single-level `Foo.bar` case is the chain-length-1
//     instance and must still work (no regression).
//
// [N] N+1: the per-candidate findSymbolParent calls (now multiplied by [M]'s
//     chain walk) are memoized for the duration of a resolve pass. Test (d)
//     pins parent-linkage correctness: the parent rows the memo serves are
//     observationally identical to direct findSymbolParent() lookups.
//
// All tests use openMemoryDb() + initSymbolSchema() for a zero-I/O in-process
// SQLite instance, mirroring resolve-edges.test.js.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    openMemoryDb,
    closeDb,
    initSymbolSchema,
    insertSymbol,
    upsertFile,
    insertEdge,
    getUnresolvedEdges,
    updateSymbolExtras,
    findSymbolParent,
    queryRaw,
} from '../dist/core/db-adapter.js';
import { resolveEdgeTargets } from '../dist/core/indexing/resolve.js';

// ---------------------------------------------------------------------------
// Helpers (same shape as resolve-edges.test.js)
// ---------------------------------------------------------------------------

function makeDb() {
    const db = openMemoryDb();
    initSymbolSchema(db);
    return db;
}

function addFile(db, filePath) {
    upsertFile(db, filePath, 'hash', Date.now());
}

function addSymbol(db, opts = {}) {
    return insertSymbol(db, {
        name: opts.name ?? 'func',
        kind: opts.kind ?? 'def',
        type: opts.type ?? 'function',
        filePath: opts.filePath ?? 'src/file.ts',
        line: opts.line ?? 1,
        endLine: opts.endLine ?? 10,
        column: opts.column ?? 0,
    });
}

/** Returns true iff the edge named `name` (from caller in filePath) is unresolved. */
function isUnresolved(db, filePath, name) {
    return getUnresolvedEdges(db, filePath).some((e) => e.referenced_name === name);
}

/** Read the linked callee_symbol_id for a referenced name (null if unresolved). */
function calleeIdFor(db, name) {
    const rows = queryRaw(db, 'SELECT callee_symbol_id FROM edges WHERE referenced_name = ?', name);
    return rows.length === 1 ? rows[0].callee_symbol_id : undefined;
}

// ---------------------------------------------------------------------------
// [M] (a) multi-level qualifier resolves when the chain is unique
// ---------------------------------------------------------------------------

describe('resolve [M] — multi-level dot-qualified (Outer.Inner.method)', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('(a) links Outer.Inner.method to the method nested under Inner under Outer when that chain is unique', () => {
        // Structure:
        //   class Outer            (outerId)
        //     class Inner          (innerId, parent=Outer)
        //       method method()    (methodId, parent=Inner)
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/nested.ts');

        const outerId = addSymbol(db, { name: 'Outer', kind: 'def', type: 'class', filePath: 'src/nested.ts', line: 1, endLine: 50 });
        const innerId = addSymbol(db, { name: 'Inner', kind: 'def', type: 'class', filePath: 'src/nested.ts', line: 5, endLine: 40, column: 2 });
        updateSymbolExtras(db, innerId, { parentSymbolId: outerId });
        const methodId = addSymbol(db, { name: 'method', kind: 'def', type: 'method', filePath: 'src/nested.ts', line: 8, endLine: 12, column: 4 });
        updateSymbolExtras(db, methodId, { parentSymbolId: innerId });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Outer.Inner.method');

        // FAIL-BEFORE: the old single-level check compared parent(method).name
        // (== 'Inner') against the whole qualifier 'Outer.Inner' → never matched
        // → edge stayed unresolved. We assert it IS unresolved beforehand, then
        // PASS-AFTER it links to methodId.
        expect(isUnresolved(db, 'src/caller.ts', 'Outer.Inner.method')).toBe(true);

        resolveEdgeTargets(db, 'src/caller.ts');

        expect(isUnresolved(db, 'src/caller.ts', 'Outer.Inner.method')).toBe(false);
        // And it links to the EXACT nested method, not some other symbol.
        expect(calleeIdFor(db, 'Outer.Inner.method')).toBe(methodId);
    });

    it('leaves Outer.Inner.method unresolved when the grandparent name does not match (partial chain)', () => {
        // method's parent is Inner, but Inner's parent is `Wrong`, not `Outer`.
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/nested.ts');

        const wrongId = addSymbol(db, { name: 'Wrong', kind: 'def', type: 'class', filePath: 'src/nested.ts', line: 1, endLine: 50 });
        const innerId = addSymbol(db, { name: 'Inner', kind: 'def', type: 'class', filePath: 'src/nested.ts', line: 5, endLine: 40, column: 2 });
        updateSymbolExtras(db, innerId, { parentSymbolId: wrongId });
        const methodId = addSymbol(db, { name: 'method', kind: 'def', type: 'method', filePath: 'src/nested.ts', line: 8, endLine: 12, column: 4 });
        updateSymbolExtras(db, methodId, { parentSymbolId: innerId });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Outer.Inner.method');

        resolveEdgeTargets(db, 'src/caller.ts');

        // Innermost segment (Inner) matches, but the next segment (Outer) does
        // not (it's Wrong) → chain mismatch → unresolved. Precision preserved.
        expect(isUnresolved(db, 'src/caller.ts', 'Outer.Inner.method')).toBe(true);
    });

    it('leaves Outer.Inner.method unresolved when the chain is too short (method directly under Outer)', () => {
        // method's parent is Outer directly (no Inner level). The qualifier has
        // two segments but the chain only offers one ancestor before null.
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/nested.ts');

        const outerId = addSymbol(db, { name: 'Outer', kind: 'def', type: 'class', filePath: 'src/nested.ts', line: 1, endLine: 50 });
        const methodId = addSymbol(db, { name: 'method', kind: 'def', type: 'method', filePath: 'src/nested.ts', line: 8, endLine: 12, column: 2 });
        updateSymbolExtras(db, methodId, { parentSymbolId: outerId });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Outer.Inner.method');

        resolveEdgeTargets(db, 'src/caller.ts');

        // Innermost segment expects parent==='Inner' but parent is 'Outer' →
        // mismatch on the first comparison → unresolved.
        expect(isUnresolved(db, 'src/caller.ts', 'Outer.Inner.method')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// [M] (b) single-level still links (no regression)
// ---------------------------------------------------------------------------

describe('resolve [M] — single-level (Foo.bar) no-regression', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('(b) still links Foo.bar to the lone bar whose parent is Foo (chain-length-1)', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/class.ts');

        const fooId = addSymbol(db, { name: 'Foo', kind: 'def', type: 'class', filePath: 'src/class.ts', line: 1, endLine: 50 });
        const barId = addSymbol(db, { name: 'bar', kind: 'def', type: 'method', filePath: 'src/class.ts', line: 5, endLine: 10, column: 2 });
        updateSymbolExtras(db, barId, { parentSymbolId: fooId });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Foo.bar');

        resolveEdgeTargets(db, 'src/caller.ts');

        expect(isUnresolved(db, 'src/caller.ts', 'Foo.bar')).toBe(false);
        expect(calleeIdFor(db, 'Foo.bar')).toBe(barId);
    });

    it('still leaves single-level Foo.bar unresolved when the parent name mismatches', () => {
        // Mirrors the existing precision contract: parent is Baz, qualifier Foo.
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/class.ts');

        const bazId = addSymbol(db, { name: 'Baz', kind: 'def', type: 'class', filePath: 'src/class.ts', line: 1, endLine: 50 });
        const barId = addSymbol(db, { name: 'bar', kind: 'def', type: 'method', filePath: 'src/class.ts', line: 5, endLine: 10, column: 2 });
        updateSymbolExtras(db, barId, { parentSymbolId: bazId });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Foo.bar');

        resolveEdgeTargets(db, 'src/caller.ts');

        expect(isUnresolved(db, 'src/caller.ts', 'Foo.bar')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// [M] (c) ambiguous multi-level (two matching chains) stays unresolved
// ---------------------------------------------------------------------------

describe('resolve [M] — ambiguous multi-level chain stays unresolved (precision contract)', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('(c) leaves Outer.Inner.method unresolved when TWO distinct chains match', () => {
        // Two independent Outer→Inner→method chains in two files. Both fully
        // match the qualifier → underQualifier.length === 2 → leave null (we
        // never create an ambiguous link).
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/a.ts');
        addFile(db, 'src/b.ts');

        const outerA = addSymbol(db, { name: 'Outer', kind: 'def', type: 'class', filePath: 'src/a.ts', line: 1, endLine: 50 });
        const innerA = addSymbol(db, { name: 'Inner', kind: 'def', type: 'class', filePath: 'src/a.ts', line: 5, endLine: 40, column: 2 });
        updateSymbolExtras(db, innerA, { parentSymbolId: outerA });
        const methodA = addSymbol(db, { name: 'method', kind: 'def', type: 'method', filePath: 'src/a.ts', line: 8, endLine: 12, column: 4 });
        updateSymbolExtras(db, methodA, { parentSymbolId: innerA });

        const outerB = addSymbol(db, { name: 'Outer', kind: 'def', type: 'class', filePath: 'src/b.ts', line: 1, endLine: 50 });
        const innerB = addSymbol(db, { name: 'Inner', kind: 'def', type: 'class', filePath: 'src/b.ts', line: 5, endLine: 40, column: 2 });
        updateSymbolExtras(db, innerB, { parentSymbolId: outerB });
        const methodB = addSymbol(db, { name: 'method', kind: 'def', type: 'method', filePath: 'src/b.ts', line: 8, endLine: 12, column: 4 });
        updateSymbolExtras(db, methodB, { parentSymbolId: innerB });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Outer.Inner.method');

        resolveEdgeTargets(db, 'src/caller.ts');

        expect(isUnresolved(db, 'src/caller.ts', 'Outer.Inner.method')).toBe(true);
        expect(calleeIdFor(db, 'Outer.Inner.method')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// [N] (d) parent memo == direct lookups (parent-linkage correctness preserved)
// ---------------------------------------------------------------------------

describe('resolve [N] — parent memo equals direct findSymbolParent lookups', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('(d) the memoized chain walk yields the SAME result direct findSymbolParent lookups would', () => {
        // One Outer→Inner with TWO methods sharing Inner as parent, plus a third
        // `method` under a non-matching chain. The shared parent (Inner, Outer)
        // is what the memo de-duplicates across the candidate set; we prove the
        // memo answers identically to direct lookups by:
        //   1. asserting findSymbolParent returns the exact expected rows, and
        //   2. asserting the resolver's link decision is exactly what walking
        //      those same parents by hand implies.
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/nested.ts');
        addFile(db, 'src/other.ts');

        const outerId = addSymbol(db, { name: 'Outer', kind: 'def', type: 'class', filePath: 'src/nested.ts', line: 1, endLine: 60 });
        const innerId = addSymbol(db, { name: 'Inner', kind: 'def', type: 'class', filePath: 'src/nested.ts', line: 5, endLine: 50, column: 2 });
        updateSymbolExtras(db, innerId, { parentSymbolId: outerId });
        // Two candidates named `method`, BOTH parented by the same Inner row.
        const methodOne = addSymbol(db, { name: 'method', kind: 'def', type: 'method', filePath: 'src/nested.ts', line: 8, endLine: 12, column: 4 });
        updateSymbolExtras(db, methodOne, { parentSymbolId: innerId });
        const methodTwo = addSymbol(db, { name: 'method', kind: 'def', type: 'method', filePath: 'src/nested.ts', line: 20, endLine: 24, column: 4 });
        updateSymbolExtras(db, methodTwo, { parentSymbolId: innerId });
        // A third `method` under a different (non-matching) chain.
        const elseId = addSymbol(db, { name: 'Else', kind: 'def', type: 'class', filePath: 'src/other.ts', line: 1, endLine: 30 });
        const methodThree = addSymbol(db, { name: 'method', kind: 'def', type: 'method', filePath: 'src/other.ts', line: 4, endLine: 8, column: 2 });
        updateSymbolExtras(db, methodThree, { parentSymbolId: elseId });

        // --- (1) Direct findSymbolParent lookups (the ground truth the memo must match) ---
        expect(findSymbolParent(db, methodOne)).toEqual({ id: innerId, name: 'Inner' });
        expect(findSymbolParent(db, methodTwo)).toEqual({ id: innerId, name: 'Inner' });
        expect(findSymbolParent(db, methodThree)).toEqual({ id: elseId, name: 'Else' });
        expect(findSymbolParent(db, innerId)).toEqual({ id: outerId, name: 'Outer' });
        expect(findSymbolParent(db, outerId)).toBeNull(); // Outer has no parent
        expect(findSymbolParent(db, elseId)).toBeNull();

        // --- (2) Resolver decision must equal what those direct lookups imply ---
        // Walking by hand: methodOne and methodTwo BOTH match Outer.Inner.method
        // (parent Inner, grandparent Outer); methodThree does not (parent Else).
        // Two matches → ambiguous → unresolved. The memo cannot change that.
        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Outer.Inner.method');

        resolveEdgeTargets(db, 'src/caller.ts');

        expect(isUnresolved(db, 'src/caller.ts', 'Outer.Inner.method')).toBe(true);

        // Now make the chain UNIQUE by removing methodTwo's qualifying parent
        // linkage (re-point it under Else). Direct lookup must reflect that, and
        // the resolver — re-reading parents via a FRESH memo on the next pass —
        // must now link to the single remaining match (methodOne).
        updateSymbolExtras(db, methodTwo, { parentSymbolId: elseId });
        expect(findSymbolParent(db, methodTwo)).toEqual({ id: elseId, name: 'Else' });

        resolveEdgeTargets(db, 'src/caller.ts');

        expect(isUnresolved(db, 'src/caller.ts', 'Outer.Inner.method')).toBe(false);
        expect(calleeIdFor(db, 'Outer.Inner.method')).toBe(methodOne);
    });
});

// ---------------------------------------------------------------------------
// Regression guard: plain-name (#17) scope-aware logic unchanged
// ---------------------------------------------------------------------------

describe('resolve — plain-name (#17) scope-aware logic unchanged', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('still prefers a same-file def over a global one for a plain (non-dotted) name', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/other.ts');

        // Two defs named 'helper': one in the caller's own file, one elsewhere.
        const sameFileId = addSymbol(db, { name: 'helper', kind: 'def', filePath: 'src/caller.ts', line: 30, endLine: 35 });
        addSymbol(db, { name: 'helper', kind: 'def', filePath: 'src/other.ts', line: 1, endLine: 5 });

        const callerId = addSymbol(db, { name: 'main', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'helper');

        resolveEdgeTargets(db, 'src/caller.ts');

        // Same-file preference links to the local def (#17), unchanged by [M]/[N].
        expect(isUnresolved(db, 'src/caller.ts', 'helper')).toBe(false);
        expect(calleeIdFor(db, 'helper')).toBe(sameFileId);
    });
});
