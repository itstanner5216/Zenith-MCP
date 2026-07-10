// rev2-persist-orphan-locals.test.js
//
// Regression for review2 disposition [Y] (cubic #42 P2): persistParsedFile must
// NOT persist local scopes whose resolved owning symbolId is null.
//
// local_scopes.symbol_id REFERENCES symbols(id) ON DELETE CASCADE, and the only
// consumer (getLocalScopesForSymbol) queries `WHERE symbol_id = ?`. A row with a
// NULL symbol_id is therefore (a) unreachable by any consumer and (b) never
// reached by the cascade — deleteSymbolsByFile cascades only through deleted
// symbols, so owner-less rows survive every re-index and accumulate without
// bound. The fix skips scopes whose parentSymbolKey does not resolve.
//
// In-memory DB pattern mirrors tests/db-adapter-v1-tables.test.js
// (openMemoryDb + initSymbolSchema, zero I/O).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    openMemoryDb,
    closeDb,
    initSymbolSchema,
    findSymbolByNameUnique,
    getLocalScopesForSymbol,
} from '../dist/core/db-adapter.js';
import { persistParsedFile } from '../dist/core/indexing/persist.js';

// Count local_scopes rows by raw query. db-adapter has no generic exec export and
// `WHERE symbol_id = NULL` matches nothing in SQLite, so reach the underlying
// node:sqlite handle (DbConnection._db) for the NULL-owner / total counts.
function countScopes(conn) {
    const raw = conn._db;
    return {
        nullOwner: Number(raw.prepare('SELECT COUNT(*) AS c FROM local_scopes WHERE symbol_id IS NULL').get().c),
        total: Number(raw.prepare('SELECT COUNT(*) AS c FROM local_scopes').get().c),
    };
}

// Minimal ParsedFileRecord. Symbol key format = `${name}:${line}:${column}`.
function makeRecord(locals) {
    return {
        relPath: 'src/scoped.ts',
        hash: 'deadbeef',
        lang: 'typescript',
        symbols: [
            {
                name: 'owner', kind: 'def', type: 'function', captureTag: 'definition.function',
                line: 1, endLine: 20, column: 0, bodyHash: null, parentSymbolKey: null, visibility: 'public',
            },
        ],
        structures: [],
        anchors: [],
        imports: [],
        importBindings: [],
        injections: [],
        edges: [],
        locals,
    };
}

const OWNER_KEY = 'owner:1:0'; // resolves to the single inserted symbol above

describe('persistParsedFile — orphan local scopes [rev2 Y]', () => {
    let db;
    beforeEach(() => { db = openMemoryDb(); initSymbolSchema(db); });
    afterEach(() => closeDb(db));

    it('does NOT persist a scope whose parentSymbolKey does not resolve', () => {
        // parentSymbolKey points at a key absent from the symbol set -> resolves null.
        persistParsedFile(db, makeRecord([
            { parentSymbolKey: 'ghost:99:0', scopeKind: 'block', startLine: 5, endLine: 8,
              parameters: [], locals: [{ name: 'orphanA', line: 6, column: 4 }] },
        ]));

        const counts = countScopes(db);
        expect(counts.nullOwner).toBe(0); // no orphan row
        expect(counts.total).toBe(0);     // nothing persisted at all for this case
    });

    it('does NOT persist a scope whose parentSymbolKey is explicitly null', () => {
        persistParsedFile(db, makeRecord([
            { parentSymbolKey: null, scopeKind: 'module', startLine: 1, endLine: 100,
              parameters: [], locals: [{ name: 'orphanB', line: 2, column: 0 }] },
        ]));

        const counts = countScopes(db);
        expect(counts.nullOwner).toBe(0);
        expect(counts.total).toBe(0);
    });

    it('DOES persist a scope whose parentSymbolKey resolves to a real symbol', () => {
        persistParsedFile(db, makeRecord([
            { parentSymbolKey: OWNER_KEY, scopeKind: 'function_declaration', startLine: 1, endLine: 20,
              parameters: [{ name: 'x', line: 1, column: 9 }], locals: [{ name: 'y', line: 3, column: 8 }] },
        ]));

        const owner = findSymbolByNameUnique(db, 'owner', 'def');
        expect(owner).not.toBeNull();
        const scopes = getLocalScopesForSymbol(db, owner.id);
        expect(scopes).toHaveLength(1);
        expect(scopes[0].scope_kind).toBe('function_declaration');
        expect(scopes[0].parameters).toEqual([{ name: 'x', line: 1, column: 9 }]);
        expect(scopes[0].locals).toEqual([{ name: 'y', line: 3, column: 8 }]);

        // No orphan slipped in alongside the valid scope.
        const counts = countScopes(db);
        expect(counts.nullOwner).toBe(0);
        expect(counts.total).toBe(1);
    });

    it('persists only the resolvable scope when valid + orphan scopes are mixed', () => {
        persistParsedFile(db, makeRecord([
            { parentSymbolKey: 'ghost:99:0', scopeKind: 'block', startLine: 5, endLine: 8, parameters: [], locals: [] },
            { parentSymbolKey: null, scopeKind: 'module', startLine: 1, endLine: 100, parameters: [], locals: [] },
            { parentSymbolKey: OWNER_KEY, scopeKind: 'function_declaration', startLine: 1, endLine: 20, parameters: [], locals: [] },
        ]));

        const counts = countScopes(db);
        expect(counts.nullOwner).toBe(0); // both owner-less scopes skipped
        expect(counts.total).toBe(1);     // only the resolvable scope persisted
    });

    it('does not accumulate orphan rows across re-indexes of the same file', () => {
        const record = makeRecord([
            { parentSymbolKey: 'ghost:99:0', scopeKind: 'block', startLine: 5, endLine: 8, parameters: [], locals: [] },
            { parentSymbolKey: null, scopeKind: 'module', startLine: 1, endLine: 100, parameters: [], locals: [] },
            { parentSymbolKey: OWNER_KEY, scopeKind: 'function_declaration', startLine: 1, endLine: 20, parameters: [], locals: [] },
        ]);

        persistParsedFile(db, record); // index #1
        persistParsedFile(db, record); // re-index #2 (same relPath)

        const counts = countScopes(db);
        // Owner-less scopes never persisted -> 0 regardless of re-index count.
        // The single valid scope is cascade-cleaned then re-inserted -> stays 1, never doubles.
        expect(counts.nullOwner).toBe(0);
        expect(counts.total).toBe(1);
    });
});
