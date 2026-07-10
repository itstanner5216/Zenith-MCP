// review-schema-resolution.test.js
//
// Wave A1 regression tests for the three db-adapter.ts review fixes:
//   #5  schema_version single-row determinism (id INTEGER PRIMARY KEY CHECK(id=1))
//   #6  schema migrations are transactional (version advances only after all DDL)
//   #16/#17 helper  findDefsByName(conn, name, kind='def') returns ALL matches
//
// Named distinctly from db-adapter-v1-tables.test.js to avoid colliding with the
// parallel agents sharing this worktree. Uses openMemoryDb() — zero I/O.

import { describe, expect, it, afterEach } from 'vitest';
import {
    openMemoryDb,
    closeDb,
    initSymbolSchema,
    getSchemaVersion,
    insertSymbol,
    upsertFile,
    findDefsByName,
    findSymbolByNameUnique,
    queryRaw,
    execRaw,
} from '../dist/core/db-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count rows currently in schema_version. */
function schemaVersionRowCount(db) {
    return queryRaw(db, 'SELECT COUNT(*) AS n FROM schema_version')[0].n;
}

/** Read the live column names of schema_version. */
function schemaVersionColumns(db) {
    return queryRaw(db, 'PRAGMA table_info(schema_version)').map((c) => c.name);
}

function addFile(db, filePath) {
    upsertFile(db, filePath, 'hash', 1);
}

function addDef(db, name, filePath, kind = 'def') {
    return insertSymbol(db, {
        name,
        kind,
        type: 'function',
        filePath,
        line: 1,
        endLine: 5,
        column: 0,
    });
}

/**
 * Forcibly downgrade an already-initialized DB's schema_version table back to
 * the OLD shape `schema_version(version INTEGER NOT NULL)` (no id column),
 * optionally with multiple rows. This reproduces a database that was migrated
 * under the pre-fix code, so re-running initSymbolSchema must detect + migrate
 * it in place (CREATE IF NOT EXISTS would otherwise leave it untouched).
 */
function downgradeToOldShape(db, versions) {
    execRaw(db, 'DROP TABLE schema_version');
    execRaw(db, 'CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const v of versions) {
        // Direct DDL/DML through the raw escape hatch — mirrors the legacy writer.
        queryRaw(db, 'INSERT INTO schema_version (version) VALUES (?)', v);
    }
}

// ---------------------------------------------------------------------------
// #5 — schema_version single-row determinism
// ---------------------------------------------------------------------------

describe('review #5: schema_version single-row determinism', () => {
    let db;
    afterEach(() => { if (db) { closeDb(db); db = undefined; } });

    it('initSymbolSchema yields exactly one row with id=1, version=3', () => {
        db = openMemoryDb();
        initSymbolSchema(db);

        expect(schemaVersionRowCount(db)).toBe(1);
        const rows = queryRaw(db, 'SELECT id, version FROM schema_version');
        expect(rows).toEqual([{ id: 1, version: 3 }]);
        expect(getSchemaVersion(db)).toBe(3);
    });

    it('calling initSymbolSchema twice keeps exactly one row (no accumulation)', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        initSymbolSchema(db);

        expect(schemaVersionRowCount(db)).toBe(1);
        expect(getSchemaVersion(db)).toBe(3);
        const rows = queryRaw(db, 'SELECT id, version FROM schema_version');
        expect(rows).toEqual([{ id: 1, version: 3 }]);
    });

    it('table carries the id PRIMARY KEY + CHECK(id=1) so a second identity is impossible', () => {
        db = openMemoryDb();
        initSymbolSchema(db);

        expect(schemaVersionColumns(db)).toContain('id');

        // CHECK(id=1) rejects any row that is not the singleton.
        expect(() => execRaw(db, 'INSERT INTO schema_version (id, version) VALUES (2, 9)')).toThrow();
        // PRIMARY KEY rejects a duplicate id=1.
        expect(() => execRaw(db, 'INSERT INTO schema_version (id, version) VALUES (1, 9)')).toThrow();
        // Still exactly one row, untouched.
        expect(schemaVersionRowCount(db)).toBe(1);
        expect(getSchemaVersion(db)).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// #5 — in-place upgrade of a pre-existing OLD-shape table
// ---------------------------------------------------------------------------

describe('review #5: old-shape schema_version upgrade', () => {
    let db;
    afterEach(() => { if (db) { closeDb(db); db = undefined; } });

    it('migrates an old-shape (no id column) table to single-row, then advances to version=3', () => {
        db = openMemoryDb();
        initSymbolSchema(db);              // fully migrated, new-shape, v3
        downgradeToOldShape(db, [1]);      // simulate a DB migrated under the old code

        // Sanity: the downgraded table really is old-shape.
        expect(schemaVersionColumns(db)).not.toContain('id');

        initSymbolSchema(db);              // must detect old shape + normalize

        expect(schemaVersionColumns(db)).toContain('id');
        expect(schemaVersionRowCount(db)).toBe(1);
        expect(queryRaw(db, 'SELECT id, version FROM schema_version')).toEqual([{ id: 1, version: 3 }]);
        expect(getSchemaVersion(db)).toBe(3);
    });

    it('collapses multiple legacy rows into the single id=1 row (the #5 bug)', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        // The old shape had no PK/UNIQUE, so duplicate rows could accumulate.
        downgradeToOldShape(db, [1, 1, 1]);
        expect(schemaVersionRowCount(db)).toBe(3);

        initSymbolSchema(db);

        expect(schemaVersionRowCount(db)).toBe(1);
        expect(getSchemaVersion(db)).toBe(3);
    });

    it('re-runs the v0->v1 ladder when an old-shape table reports version 0', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        downgradeToOldShape(db, [0]);      // legacy DB that never reached v1

        initSymbolSchema(db);              // ladders should run and advance to 3

        expect(schemaVersionColumns(db)).toContain('id');
        expect(schemaVersionRowCount(db)).toBe(1);
        expect(getSchemaVersion(db)).toBe(3);
        // v1/v2/v3 child tables are present after the ladder.
        const tables = queryRaw(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
        for (const t of ['symbol_structures', 'anchors', 'imports', 'import_bindings', 'injections', 'local_scopes', 'project_roots']) {
            expect(tables).toContain(t);
        }
        const importCols = queryRaw(db, 'PRAGMA table_info(imports)').map((c) => c.name);
        expect(importCols).toContain('start_line');
        expect(importCols).toContain('end_line');
    });

    it('upgrades an existing v1 database to v3 by adding import_bindings and import spans', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        execRaw(db, 'DROP TABLE import_bindings');
        execRaw(db, 'DROP TABLE imports');
        execRaw(db, 'CREATE TABLE imports (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT REFERENCES files(path) ON DELETE CASCADE, module TEXT, imported_names_json TEXT, line INTEGER)');
        execRaw(db, 'CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path)');
        execRaw(db, 'CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module)');
        execRaw(db, 'UPDATE schema_version SET version = 1 WHERE id = 1');

        initSymbolSchema(db);

        expect(getSchemaVersion(db)).toBe(3);
        const tables = queryRaw(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
        expect(tables).toContain('import_bindings');
        const importCols = queryRaw(db, 'PRAGMA table_info(imports)').map((c) => c.name);
        expect(importCols).toContain('start_line');
        expect(importCols).toContain('end_line');
    });

    it('invalidates stored file hashes during the v2 migration so bindings repopulate', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        // Simulate a pre-v2 database that had already indexed a file: without
        // hash invalidation, indexFile skips unchanged files on hash match and
        // import_bindings stays empty for them indefinitely.
        execRaw(db, 'DROP TABLE import_bindings');
        execRaw(db, "INSERT INTO files (path, hash, last_indexed) VALUES ('src/a.ts', 'stale-hash', 1)");
        execRaw(db, 'UPDATE schema_version SET version = 1 WHERE id = 1');

        initSymbolSchema(db);

        expect(getSchemaVersion(db)).toBe(3);
        const rows = queryRaw(db, 'SELECT hash FROM files');
        expect(rows).toHaveLength(1);
        expect(rows[0].hash).toBeNull();
    });

    it('upgrades an existing v2 database to v3 by adding import span columns', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        execRaw(db, 'DROP TABLE imports');
        execRaw(db, 'CREATE TABLE imports (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT REFERENCES files(path) ON DELETE CASCADE, module TEXT, imported_names_json TEXT, line INTEGER)');
        execRaw(db, 'CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path)');
        execRaw(db, 'CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module)');
        execRaw(db, 'UPDATE schema_version SET version = 2 WHERE id = 1');

        initSymbolSchema(db);

        expect(getSchemaVersion(db)).toBe(3);
        const importCols = queryRaw(db, 'PRAGMA table_info(imports)').map((c) => c.name);
        expect(importCols).toContain('start_line');
        expect(importCols).toContain('end_line');
    });
});

// ---------------------------------------------------------------------------
// #6 — transactional v0 -> v1 migration
// ---------------------------------------------------------------------------

describe('review #6: transactional migration', () => {
    let db;
    afterEach(() => { if (db) { closeDb(db); db = undefined; } });

    it('initSymbolSchema commits atomically: version=3 and all v1/v2/v3 columns/tables exist', () => {
        db = openMemoryDb();
        initSymbolSchema(db);

        expect(getSchemaVersion(db)).toBe(3);

        // v1 columns added to existing tables.
        const symbolCols = queryRaw(db, 'PRAGMA table_info(symbols)').map((c) => c.name);
        for (const c of ['capture_tag', 'body_hash', 'parent_symbol_id', 'visibility']) {
            expect(symbolCols).toContain(c);
        }
        const edgeCols = queryRaw(db, 'PRAGMA table_info(edges)').map((c) => c.name);
        expect(edgeCols).toContain('callee_symbol_id');

        // v1/v2/v3 child tables created.
        const tables = queryRaw(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
        for (const t of ['symbol_structures', 'anchors', 'imports', 'import_bindings', 'injections', 'local_scopes', 'project_roots']) {
            expect(tables).toContain(t);
        }
        const importCols = queryRaw(db, 'PRAGMA table_info(imports)').map((c) => c.name);
        expect(importCols).toContain('start_line');
        expect(importCols).toContain('end_line');
    });

    it('version stays 3 across repeated inits (ladder does not re-advance or duplicate)', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        initSymbolSchema(db);
        initSymbolSchema(db);
        expect(getSchemaVersion(db)).toBe(3);
        expect(schemaVersionRowCount(db)).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// #16/#17 helper — findDefsByName (non-unique counterpart)
// ---------------------------------------------------------------------------

describe('review #16/#17: findDefsByName', () => {
    let db;
    afterEach(() => { if (db) { closeDb(db); db = undefined; } });

    it('returns ALL matching defs (no LIMIT), each as { id, filePath }', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        addFile(db, 'a.ts');
        addFile(db, 'b.ts');
        const idA = addDef(db, 'handler', 'a.ts');
        const idB = addDef(db, 'handler', 'b.ts');

        const rows = findDefsByName(db, 'handler');
        expect(rows).toHaveLength(2);
        const byId = new Map(rows.map((r) => [r.id, r.filePath]));
        expect(byId.get(idA)).toBe('a.ts');
        expect(byId.get(idB)).toBe('b.ts');
        // Exactly the documented shape — no extra columns leak through.
        for (const r of rows) {
            expect(Object.keys(r).sort()).toEqual(['filePath', 'id']);
        }

        // It is the non-unique counterpart: where unique returns null (ambiguous),
        // findDefsByName still returns the full candidate set.
        expect(findSymbolByNameUnique(db, 'handler', 'def')).toBeNull();
    });

    it('defaults kind to "def" and honours an explicit kind filter', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        addFile(db, 'a.ts');
        addDef(db, 'thing', 'a.ts', 'def');
        addDef(db, 'thing', 'a.ts', 'ref');

        // Default kind = 'def' excludes the ref row.
        const defs = findDefsByName(db, 'thing');
        expect(defs).toHaveLength(1);

        // Explicit kind reaches the ref row.
        const refs = findDefsByName(db, 'thing', 'ref');
        expect(refs).toHaveLength(1);
    });

    it('returns an empty array when nothing matches', () => {
        db = openMemoryDb();
        initSymbolSchema(db);
        addFile(db, 'a.ts');
        expect(findDefsByName(db, 'missing')).toEqual([]);
    });
});
