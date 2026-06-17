// review-edge-resolution.test.js
//
// Wave B regression tests for the resolution-quality + performance cluster:
//   #18 batch pass        — resolveAllEdgeTargets(conn) resolves the WHOLE DB in
//                            one pass (replaces the per-file N+1 loop).
//   #16 dot-qualified     — "Foo.bar" links when `bar` has multiple defs but
//                            exactly one lives under a parent named "Foo".
//                            (The pre-Wave-B code required `bar` to be GLOBALLY
//                            unique, so this case FAILED — see proof.)
//   #17 scope-aware       — a plain name with multiple global defs links to the
//                            same-file def when exactly one exists; with no
//                            same-file def and >1 global it stays unresolved
//                            (precision preserved). (The pre-Wave-B code only
//                            had the global-unique rule, so the same-file case
//                            FAILED — see proof.)
//
// Drives the built dist (same pattern as resolve-edges.test.js). Zero I/O via
// openMemoryDb(). Asserts the concrete callee_symbol_id target — not merely
// "no longer unresolved" — because (b)/(c) are about WHICH def is chosen.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    openMemoryDb,
    closeDb,
    initSymbolSchema,
    insertSymbol,
    upsertFile,
    insertEdge,
    updateSymbolExtras,
    getUnresolvedEdges,
    queryRaw,
} from '../dist/core/db-adapter.js';
import { resolveAllEdgeTargets, resolveEdgeTargets } from '../dist/core/indexing/resolve.js';

// ---------------------------------------------------------------------------
// Helpers
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

/** Insert an edge and return its row id (insertEdge itself is void). */
function addEdge(db, callerId, referencedName) {
    insertEdge(db, callerId, referencedName);
    const row = queryRaw(
        db,
        'SELECT id FROM edges WHERE container_def_id = ? AND referenced_name = ? ORDER BY id DESC LIMIT 1',
        callerId,
        referencedName,
    )[0];
    return row.id;
}

/** Read an edge's resolved callee_symbol_id (null if unresolved). */
function calleeOf(db, edgeId) {
    const row = queryRaw(db, 'SELECT callee_symbol_id FROM edges WHERE id = ?', edgeId)[0];
    return row ? row.callee_symbol_id : undefined;
}

// ---------------------------------------------------------------------------
// (a) plain unique name resolves via the batch pass
// ---------------------------------------------------------------------------

describe('resolveAllEdgeTargets — (a) plain unique name', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('resolves a globally-unique callee def in one batch pass', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/callee.ts');

        const helperId = addSymbol(db, { name: 'helper', kind: 'def', filePath: 'src/callee.ts', line: 1, endLine: 5 });
        const callerId = addSymbol(db, { name: 'main', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        const edgeId = addEdge(db, callerId, 'helper');

        // Unresolved before.
        expect(calleeOf(db, edgeId)).toBeNull();

        resolveAllEdgeTargets(db);

        // Linked to the unique def.
        expect(calleeOf(db, edgeId)).toBe(helperId);
        expect(getUnresolvedEdges(db, 'src/caller.ts').some(e => e.referenced_name === 'helper')).toBe(false);
    });

    it('leaves a name with two global defs and no same-file def unresolved (still ambiguous)', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/a.ts');
        addFile(db, 'src/b.ts');

        addSymbol(db, { name: 'compute', kind: 'def', filePath: 'src/a.ts' });
        addSymbol(db, { name: 'compute', kind: 'def', filePath: 'src/b.ts' });
        const callerId = addSymbol(db, { name: 'handler', kind: 'def', filePath: 'src/caller.ts' });
        const edgeId = addEdge(db, callerId, 'compute');

        resolveAllEdgeTargets(db);

        expect(calleeOf(db, edgeId)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (b) #16 dot-qualified: bar ambiguous globally, unique under parent Foo
// ---------------------------------------------------------------------------

describe('resolveAllEdgeTargets — (b) #16 dot-qualified under ambiguous short name', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('links Foo.bar to the bar whose parent is Foo, even though bar has multiple defs', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/foo.ts');
        addFile(db, 'src/baz.ts');

        // Two classes, each with a method named `bar`. `bar` is NOT globally
        // unique — the pre-Wave-B gate (shortName must be globally unique)
        // bails here and leaves the edge null. This is the load-bearing case.
        const fooId = addSymbol(db, { name: 'Foo', kind: 'def', type: 'class', filePath: 'src/foo.ts', line: 1, endLine: 50 });
        const fooBarId = addSymbol(db, { name: 'bar', kind: 'def', type: 'method', filePath: 'src/foo.ts', line: 5, endLine: 10 });
        updateSymbolExtras(db, fooBarId, { parentSymbolId: fooId });

        const bazId = addSymbol(db, { name: 'Baz', kind: 'def', type: 'class', filePath: 'src/baz.ts', line: 1, endLine: 50 });
        const bazBarId = addSymbol(db, { name: 'bar', kind: 'def', type: 'method', filePath: 'src/baz.ts', line: 5, endLine: 10 });
        updateSymbolExtras(db, bazBarId, { parentSymbolId: bazId });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts' });
        const edgeId = addEdge(db, callerId, 'Foo.bar');

        resolveAllEdgeTargets(db);

        // Resolves to Foo's bar specifically — NOT Baz's bar, NOT null.
        expect(calleeOf(db, edgeId)).toBe(fooBarId);
    });

    it('still leaves Foo.bar null when two bars BOTH have parent Foo (ambiguous under qualifier)', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/a.ts');
        addFile(db, 'src/b.ts');

        // Two distinct classes both named Foo (a partial-class / duplicate-name
        // situation), each with a bar → the qualifier no longer disambiguates.
        const fooA = addSymbol(db, { name: 'Foo', kind: 'def', type: 'class', filePath: 'src/a.ts', line: 1, endLine: 50 });
        const barA = addSymbol(db, { name: 'bar', kind: 'def', type: 'method', filePath: 'src/a.ts', line: 5, endLine: 10 });
        updateSymbolExtras(db, barA, { parentSymbolId: fooA });
        const fooB = addSymbol(db, { name: 'Foo', kind: 'def', type: 'class', filePath: 'src/b.ts', line: 1, endLine: 50 });
        const barB = addSymbol(db, { name: 'bar', kind: 'def', type: 'method', filePath: 'src/b.ts', line: 5, endLine: 10 });
        updateSymbolExtras(db, barB, { parentSymbolId: fooB });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts' });
        const edgeId = addEdge(db, callerId, 'Foo.bar');

        resolveAllEdgeTargets(db);

        expect(calleeOf(db, edgeId)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (c) #17 scope-aware: same-file preference among multiple global defs
// ---------------------------------------------------------------------------

describe('resolveAllEdgeTargets — (c) #17 same-file preference', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('links to the same-file def when a name has two global defs, one in the caller file', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/other.ts');

        // `log` is defined twice globally: once in the caller's own file, once
        // elsewhere. The pre-Wave-B global-unique rule sees 2 defs → ambiguous →
        // leaves it null. Scope-aware resolution prefers the local def.
        const localLog = addSymbol(db, { name: 'log', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 3 });
        addSymbol(db, { name: 'log', kind: 'def', filePath: 'src/other.ts', line: 1, endLine: 3 });

        const callerId = addSymbol(db, { name: 'run', kind: 'def', filePath: 'src/caller.ts', line: 10, endLine: 20 });
        const edgeId = addEdge(db, callerId, 'log');

        resolveAllEdgeTargets(db);

        // Resolves to the SAME-FILE def, not the other one and not null.
        expect(calleeOf(db, edgeId)).toBe(localLog);
    });

    it('does NOT regress global-unique: a single global def in another file still links', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/lib.ts');

        const onlyDef = addSymbol(db, { name: 'util', kind: 'def', filePath: 'src/lib.ts' });
        const callerId = addSymbol(db, { name: 'run', kind: 'def', filePath: 'src/caller.ts' });
        const edgeId = addEdge(db, callerId, 'util');

        resolveAllEdgeTargets(db);

        expect(calleeOf(db, edgeId)).toBe(onlyDef);
    });
});

// ---------------------------------------------------------------------------
// (d) precision preserved: >1 global, 0 same-file → unresolved
// ---------------------------------------------------------------------------

describe('resolveAllEdgeTargets — (d) precision preserved', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('leaves a name with >1 global def and 0 same-file def unresolved', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/x.ts');
        addFile(db, 'src/y.ts');

        // Two global defs of `parse`, NEITHER in the caller's file.
        addSymbol(db, { name: 'parse', kind: 'def', filePath: 'src/x.ts' });
        addSymbol(db, { name: 'parse', kind: 'def', filePath: 'src/y.ts' });

        const callerId = addSymbol(db, { name: 'main', kind: 'def', filePath: 'src/caller.ts' });
        const edgeId = addEdge(db, callerId, 'parse');

        resolveAllEdgeTargets(db);

        // No same-file def + ambiguous global → stays null (same as old rule).
        expect(calleeOf(db, edgeId)).toBeNull();
    });

    it('leaves a name with TWO same-file defs unresolved (no unique local pick)', () => {
        addFile(db, 'src/caller.ts');

        // Two defs of `dup` in the SAME caller file (e.g. overloads/duplicates).
        // sameFile.length === 2 → not a unique local pick; total candidates === 2
        // → not globally unique either → stays null.
        addSymbol(db, { name: 'dup', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 3 });
        addSymbol(db, { name: 'dup', kind: 'def', filePath: 'src/caller.ts', line: 5, endLine: 7 });

        const callerId = addSymbol(db, { name: 'caller', kind: 'def', filePath: 'src/caller.ts', line: 10, endLine: 20 });
        const edgeId = addEdge(db, callerId, 'dup');

        resolveAllEdgeTargets(db);

        expect(calleeOf(db, edgeId)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (e) batch resolves across multiple files in ONE pass
// ---------------------------------------------------------------------------

describe('resolveAllEdgeTargets — (e) whole-DB single pass', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('resolves edges whose callers live in DIFFERENT files in one call', () => {
        addFile(db, 'src/callerA.ts');
        addFile(db, 'src/callerB.ts');
        addFile(db, 'src/lib.ts');

        const alphaId = addSymbol(db, { name: 'alpha', kind: 'def', filePath: 'src/lib.ts', line: 1, endLine: 5 });
        const betaId = addSymbol(db, { name: 'beta', kind: 'def', filePath: 'src/lib.ts', line: 10, endLine: 15 });

        // Caller A references alpha; caller B references beta — two DIFFERENT
        // caller files. The old code needed one resolveEdgeTargets call per file;
        // resolveAllEdgeTargets handles both in a single sweep.
        const callerAId = addSymbol(db, { name: 'fnA', kind: 'def', filePath: 'src/callerA.ts' });
        const callerBId = addSymbol(db, { name: 'fnB', kind: 'def', filePath: 'src/callerB.ts' });
        const edgeA = addEdge(db, callerAId, 'alpha');
        const edgeB = addEdge(db, callerBId, 'beta');

        resolveAllEdgeTargets(db);

        expect(calleeOf(db, edgeA)).toBe(alphaId);
        expect(calleeOf(db, edgeB)).toBe(betaId);
    });

    it('heals nulls on a fresh pass (ON DELETE SET NULL semantics preserved)', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/callee.ts');
        const helperId = addSymbol(db, { name: 'helper', kind: 'def', filePath: 'src/callee.ts' });
        const callerId = addSymbol(db, { name: 'main', kind: 'def', filePath: 'src/caller.ts' });
        const edgeId = addEdge(db, callerId, 'helper');

        resolveAllEdgeTargets(db);
        expect(calleeOf(db, edgeId)).toBe(helperId);

        // Simulate the callee file being re-indexed: the FK ON DELETE SET NULL
        // nulls the edge. A fresh batch pass must re-resolve it.
        queryRaw(db, 'UPDATE edges SET callee_symbol_id = NULL WHERE id = ?', edgeId);
        expect(calleeOf(db, edgeId)).toBeNull();

        resolveAllEdgeTargets(db);
        expect(calleeOf(db, edgeId)).toBe(helperId);
    });

    it('single-file resolveEdgeTargets agrees with the batch pass for same-file preference', () => {
        // Cross-check that the shared per-name resolver behaves identically when
        // invoked through the single-file entry point used by resolve-edges.test.js.
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/other.ts');
        const localId = addSymbol(db, { name: 'fmt', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 3 });
        addSymbol(db, { name: 'fmt', kind: 'def', filePath: 'src/other.ts', line: 1, endLine: 3 });
        const callerId = addSymbol(db, { name: 'run', kind: 'def', filePath: 'src/caller.ts', line: 10, endLine: 20 });
        const edgeId = addEdge(db, callerId, 'fmt');

        resolveEdgeTargets(db, 'src/caller.ts');

        expect(calleeOf(db, edgeId)).toBe(localId);
    });
});
