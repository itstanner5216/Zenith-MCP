// resolve-edges.test.js
//
// Tests for indexing/resolve.ts — cross-file edge resolution via resolveEdgeTargets().
//
// All tests use openMemoryDb() + initSymbolSchema() for a zero-I/O in-process
// SQLite instance. DB setup follows the same pattern as db-adapter-v1-tables.test.js.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    openMemoryDb,
    closeDb,
    initSymbolSchema,
    insertSymbol,
    upsertFile,
    insertEdge,
    getUnresolvedEdges,
    findSymbolByNameUnique,
    updateSymbolExtras,
} from '../dist/core/db-adapter.js';
import { resolveEdgeTargets } from '../dist/core/indexing/resolve.js';

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

// ---------------------------------------------------------------------------
// resolveEdgeTargets — no-op when no unresolved edges
// ---------------------------------------------------------------------------

describe('resolveEdgeTargets — no-op cases', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('returns cleanly when file has no symbols at all', () => {
        addFile(db, 'src/empty.ts');
        expect(() => resolveEdgeTargets(db, 'src/empty.ts')).not.toThrow();
    });

    it('returns cleanly when there are no unresolved edges', () => {
        addFile(db, 'src/noedges.ts');
        addSymbol(db, { name: 'foo', filePath: 'src/noedges.ts' });
        expect(() => resolveEdgeTargets(db, 'src/noedges.ts')).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// resolveEdgeTargets — full-name unique resolution
// ---------------------------------------------------------------------------

describe('resolveEdgeTargets — full-name unique resolution', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('resolves an unambiguous edge to the single matching callee def', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/callee.ts');

        // Callee: unique def named 'helper' in a different file
        addSymbol(db, { name: 'helper', kind: 'def', filePath: 'src/callee.ts', line: 1, endLine: 5 });

        // Caller: def in caller.ts that references 'helper'
        const callerId = addSymbol(db, { name: 'main', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'helper');

        // Verify unresolved before
        const before = getUnresolvedEdges(db, 'src/caller.ts');
        expect(before.some(e => e.referenced_name === 'helper')).toBe(true);

        resolveEdgeTargets(db, 'src/caller.ts');

        // After resolution: no longer unresolved
        const after = getUnresolvedEdges(db, 'src/caller.ts');
        expect(after.some(e => e.referenced_name === 'helper')).toBe(false);
    });

    it('resolves multiple distinct edges in one call', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/lib.ts');

        addSymbol(db, { name: 'alpha', kind: 'def', filePath: 'src/lib.ts', line: 1, endLine: 5 });
        addSymbol(db, { name: 'beta', kind: 'def', filePath: 'src/lib.ts', line: 10, endLine: 15 });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 30 });
        insertEdge(db, callerId, 'alpha');
        insertEdge(db, callerId, 'beta');

        resolveEdgeTargets(db, 'src/caller.ts');

        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        expect(unresolved.some(e => e.referenced_name === 'alpha')).toBe(false);
        expect(unresolved.some(e => e.referenced_name === 'beta')).toBe(false);
    });

    it('leaves ambiguous edges unresolved', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/a.ts');
        addFile(db, 'src/b.ts');

        // Two defs with the same name → ambiguous
        addSymbol(db, { name: 'compute', kind: 'def', filePath: 'src/a.ts', line: 1, endLine: 5 });
        addSymbol(db, { name: 'compute', kind: 'def', filePath: 'src/b.ts', line: 1, endLine: 5 });

        const callerId = addSymbol(db, { name: 'handler', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'compute');

        resolveEdgeTargets(db, 'src/caller.ts');

        // Edge remains unresolved
        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        expect(unresolved.some(e => e.referenced_name === 'compute')).toBe(true);
    });

    it('leaves edges with unknown callee names unresolved', () => {
        addFile(db, 'src/caller.ts');
        const callerId = addSymbol(db, { name: 'fn', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 10 });
        insertEdge(db, callerId, 'unknownExternal');

        resolveEdgeTargets(db, 'src/caller.ts');

        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        expect(unresolved.some(e => e.referenced_name === 'unknownExternal')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// resolveEdgeTargets — dot-qualified resolution
// ---------------------------------------------------------------------------

describe('resolveEdgeTargets — dot-qualified (Foo.bar) resolution', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('resolves Foo.bar when bar has exactly one def and its parent is named Foo', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/class.ts');

        // Parent class
        const parentId = addSymbol(db, { name: 'Foo', kind: 'def', type: 'class', filePath: 'src/class.ts', line: 1, endLine: 50, column: 0 });
        // Child method (one def, parent = Foo)
        const methodId = addSymbol(db, { name: 'bar', kind: 'def', type: 'method', filePath: 'src/class.ts', line: 5, endLine: 10, column: 4 });
        updateSymbolExtras(db, methodId, { parentSymbolId: parentId });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Foo.bar');

        resolveEdgeTargets(db, 'src/caller.ts');

        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        expect(unresolved.some(e => e.referenced_name === 'Foo.bar')).toBe(false);
    });

    it('leaves Foo.bar unresolved when bar has no parent (parent_symbol_id is null)', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/class.ts');

        // 'bar' has no parent
        addSymbol(db, { name: 'bar', kind: 'def', type: 'function', filePath: 'src/class.ts', line: 5, endLine: 10 });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Foo.bar');

        resolveEdgeTargets(db, 'src/caller.ts');

        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        expect(unresolved.some(e => e.referenced_name === 'Foo.bar')).toBe(true);
    });

    it('leaves Foo.bar unresolved when parent name does not match qualifier', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/class.ts');

        const parentId = addSymbol(db, { name: 'Baz', kind: 'def', type: 'class', filePath: 'src/class.ts', line: 1, endLine: 50 });
        const methodId = addSymbol(db, { name: 'bar', kind: 'def', type: 'method', filePath: 'src/class.ts', line: 5, endLine: 10 });
        updateSymbolExtras(db, methodId, { parentSymbolId: parentId });

        const callerId = addSymbol(db, { name: 'runner', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 20 });
        insertEdge(db, callerId, 'Foo.bar'); // qualifier is Foo, not Baz

        resolveEdgeTargets(db, 'src/caller.ts');

        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        expect(unresolved.some(e => e.referenced_name === 'Foo.bar')).toBe(true);
    });

    it('leaves Foo.bar unresolved when bar itself is ambiguous', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/a.ts');
        addFile(db, 'src/b.ts');

        // Two defs named 'bar'
        addSymbol(db, { name: 'bar', kind: 'def', filePath: 'src/a.ts', line: 1, endLine: 5 });
        addSymbol(db, { name: 'bar', kind: 'def', filePath: 'src/b.ts', line: 1, endLine: 5 });

        const callerId = addSymbol(db, { name: 'fn', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 10 });
        insertEdge(db, callerId, 'Foo.bar');

        resolveEdgeTargets(db, 'src/caller.ts');

        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        expect(unresolved.some(e => e.referenced_name === 'Foo.bar')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// resolveEdgeTargets — regression: leading dot is not dot-qualified
// ---------------------------------------------------------------------------

describe('resolveEdgeTargets — edge cases', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('ignores names starting with a dot (dotIdx <= 0) — leaves them unresolved', () => {
        addFile(db, 'src/caller.ts');
        const callerId = addSymbol(db, { name: 'fn', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 10 });
        insertEdge(db, callerId, '.startsWithDot');

        resolveEdgeTargets(db, 'src/caller.ts');

        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        expect(unresolved.some(e => e.referenced_name === '.startsWithDot')).toBe(true);
    });

    it('resolving the same file twice does not create duplicate edges or throw', () => {
        addFile(db, 'src/caller.ts');
        addFile(db, 'src/callee.ts');
        addSymbol(db, { name: 'util', kind: 'def', filePath: 'src/callee.ts', line: 1, endLine: 5 });
        const callerId = addSymbol(db, { name: 'fn', kind: 'def', filePath: 'src/caller.ts', line: 1, endLine: 10 });
        insertEdge(db, callerId, 'util');

        expect(() => {
            resolveEdgeTargets(db, 'src/caller.ts');
            resolveEdgeTargets(db, 'src/caller.ts'); // second call — idempotent
        }).not.toThrow();
    });
});