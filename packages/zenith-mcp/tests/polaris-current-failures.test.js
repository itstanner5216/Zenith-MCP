// polaris-current-failures.test.js — POLARIS Task 0.1
//
// Live-defect pins. Every case below is a review-confirmed defect that was
// RERUN AND REPRODUCED LOCALLY in this checkout (2026-07-15) — nothing here
// is inherited on faith from the 2026-07-14 review harnesses. (The only
// review evidence this plan inherits without a local rerun is its Node-26
// performance figures, which are not defect repros and are re-measured by
// polaris-performance.test.js.)
//
// Encoding: `it.fails` bodies assert the DESIRED truth and therefore fail
// today at exactly one named assertion (marked FAILS_AT in each body). When a
// Wave 1 task fixes the defect, the body starts passing, `it.fails` turns
// red, and that task converts the case to a plain `it` — the designed
// conversion moment:
//   G5  (same-line reference dedup loss)        -> FIXED by Task 1.2 (converted below)
//   G8  (capped walk purges unvisited rows)     -> FIXED by Task 1.2 (converted below)
//   G7  (stale-positive resolution never reconsidered) -> FIXED by Task 1.3 (converted below)
//   G12 (INSERT OR REPLACE INTO files cascade)  -> FIXED by Task 1.1 (converted below)
//   FUTURE_SCHEMA (newer DB silently accepted)  -> FIXED by Task 1.1 (converted below)
//
// All five review defects are now fixed and pinned as plain tests — this file
// is the living record that each one reproduced, was repaired by its named
// task, and can never silently return.
//
// Per the task contract, the v4 ground preconditions (schema v4,
// edges.reference_kind, anchors.end_line, parent_symbol_id, import_bindings)
// are asserted BEFORE any it.fails case, so a failing pin can never be
// mistaken for a missing-schema artifact.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    getSchemaVersion,
    upsertFile,
    getFileCount,
    execRaw,
    queryRaw,
} from '../dist/core/db-adapter.js';
import { indexDirectory, ensureIndexFresh } from '../dist/core/symbol-index.js';
import { makeTempDir, columnNames, tableExists } from './helpers/polaris-db.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(TESTS_DIR, 'fixtures', 'polaris-workspace');

// Second-occurrence truth for the same-line repeated calls, per language,
// from fixtures/polaris-expected.json (truth.resolutions[].columns): the
// FIRST column is persisted today; the SECOND is dropped by the
// `name:kind:line` dedup key (extract.ts) — defect G5.
const SAME_LINE_TRUTH = [
    { file: 'typescript/same-line.ts', name: 'slAdd', line: 6, columns: [11, 22], caller: 'slDouble' },
    { file: 'javascript/app.js', name: 'jsGreet', line: 6, columns: [11, 27], caller: 'jsShout' },
    { file: 'python/app.py', name: 'py_greet', line: 10, columns: [11, 28], caller: 'py_call_twice' },
    { file: 'go/app.go', name: 'goHelper', line: 9, columns: [8, 22], caller: 'GoCompute' },
    { file: 'rust/app.rs', name: 'rs_helper', line: 5, columns: [4, 19], caller: 'rs_compute' },
    { file: 'java/App.java', name: 'javaHelper', line: 6, columns: [15, 31], caller: 'javaCompute' },
];

const tempDirs = [];
const openConns = new Set();

function newTempDir(prefix) {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
}

function tracked(conn) {
    openConns.add(conn);
    return conn;
}

afterEach(() => {
    for (const conn of openConns) {
        try { closeDb(conn); } catch { /* ignore */ }
    }
    openConns.clear();
});

afterAll(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// ---------------------------------------------------------------------------
// v4 ground preconditions — MUST hold before any it.fails case is meaningful
// ---------------------------------------------------------------------------

describe('v4 ground preconditions', () => {
    it('schema v4 with reference_kind, end_line, parent_symbol_id, and import_bindings', () => {
        const conn = tracked(openDb(path.join(newTempDir('polaris-pre-'), 'pre.db')));
        initSymbolSchema(conn);
        expect(getSchemaVersion(conn)).toBe(4);
        expect(columnNames(conn, 'edges')).toContain('reference_kind');
        expect(columnNames(conn, 'anchors')).toContain('end_line');
        expect(columnNames(conn, 'symbols')).toContain('parent_symbol_id');
        expect(tableExists(conn, 'import_bindings')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// G5 — FIXED by Task 1.2: the reference dedup key includes the column, so
// same-line repeated occurrences persist as distinct facts. Converted from
// it.fails on 2026-07-15.
// ---------------------------------------------------------------------------

describe('G5: same-line repeated references are distinct facts', () => {
    let db;

    beforeAll(async () => {
        db = openDb(path.join(newTempDir('polaris-g5-'), 'g5.db'));
        initSymbolSchema(db);
        await indexDirectory(db, WORKSPACE, WORKSPACE);
    }, 60_000);

    afterAll(() => {
        try { closeDb(db); } catch { /* ignore */ }
    });

    for (const truth of SAME_LINE_TRUTH) {
        it(`${truth.file}: both ${truth.name} occurrences on line ${truth.line} persist`, () => {
            const rows = queryRaw(
                db,
                'SELECT "column" AS col FROM symbols WHERE file_path = ? AND name = ? AND kind = \'ref\' AND line = ? ORDER BY col',
                truth.file, truth.name, truth.line
            );
            expect(rows.map((r) => r.col), 'both same-line occurrences persist').toEqual(truth.columns);
        });
    }

    it('the same-line call pair produces two edge rows (typescript/same-line.ts)', () => {
        const edges = queryRaw(
            db,
            `SELECT e.id FROM edges e JOIN symbols caller ON caller.id = e.container_def_id
             WHERE caller.file_path = ? AND caller.name = ? AND e.referenced_name = ?`,
            'typescript/same-line.ts', 'slDouble', 'slAdd'
        );
        expect(edges.length, 'two call edges persist').toBe(2);
    });
});

// ---------------------------------------------------------------------------
// G7 — FIXED by Task 1.3: persistParsedFile clears every stale target touching
// the changed definition names and re-resolves the affected names inside its
// own transaction. Converted from it.fails on 2026-07-15.
// ---------------------------------------------------------------------------

describe('G7: a resolved edge is reconsidered when a competitor appears', () => {
    it('adding a competing definition demotes the previously unique resolution', async () => {
        const repo = newTempDir('polaris-g7-');
        const db = tracked(openDb(path.join(newTempDir('polaris-g7-db-'), 'g7.db')));
        initSymbolSchema(db);

        fs.writeFileSync(path.join(repo, 'target-a.ts'), 'export function fooUniq(): number {\n    return 1;\n}\n');
        fs.writeFileSync(path.join(repo, 'caller.ts'), 'export function callFoo(): number {\n    return fooUniq();\n}\n');
        await indexDirectory(db, repo, repo);

        const resolvedBefore = queryRaw(
            db,
            `SELECT callee.file_path AS calleePath FROM edges e
             JOIN symbols caller ON caller.id = e.container_def_id
             JOIN symbols callee ON callee.id = e.callee_symbol_id
             WHERE caller.name = 'callFoo' AND e.referenced_name = 'fooUniq'`
        );
        // Precondition (true today): the globally unique name resolves.
        expect(resolvedBefore.length).toBe(1);
        expect(resolvedBefore[0].calleePath).toBe('target-a.ts');

        // A competitor appears; the resolver runs again over the whole DB.
        fs.writeFileSync(path.join(repo, 'target-b.ts'), 'export function fooUniq(): number {\n    return 2;\n}\n');
        await indexDirectory(db, repo, repo);

        const calleeAfter = queryRaw(
            db,
            `SELECT e.callee_symbol_id AS callee FROM edges e
             JOIN symbols caller ON caller.id = e.container_def_id
             WHERE caller.name = 'callFoo' AND e.referenced_name = 'fooUniq'`
        );
        expect(calleeAfter.length).toBe(1);
        // Fixed by Task 1.3: target-b's persist carries fooUniq in its new
        // definition names, so the stale resolution is cleared and the
        // re-resolution correctly refuses the now-ambiguous name.
        expect(calleeAfter[0].callee, 'an ambiguous name must not stay resolved').toBeNull();
    });
});

// ---------------------------------------------------------------------------
// G8 — FIXED by Task 1.2: discovery is exhaustive-then-capped; purging runs
// only on complete walks. Converted from it.fails on 2026-07-15.
// ---------------------------------------------------------------------------

describe('G8: an incomplete walk never purges unvisited rows', () => {
    it('indexDirectory with maxFiles=1 preserves the other file\'s rows and reports incomplete', async () => {
        const repo = newTempDir('polaris-g8-');
        const db = tracked(openDb(path.join(newTempDir('polaris-g8-db-'), 'g8.db')));
        initSymbolSchema(db);

        fs.writeFileSync(path.join(repo, 'one.ts'), 'export function oneFn(): number {\n    return 1;\n}\n');
        fs.writeFileSync(path.join(repo, 'two.ts'), 'export function twoFn(): number {\n    return 2;\n}\n');
        const full = await indexDirectory(db, repo, repo);
        expect(full).toEqual({ visited: 2, complete: true, stopReason: null });
        expect(getFileCount(db)).toBe(2); // precondition: both indexed

        const capped = await indexDirectory(db, repo, repo, { maxFiles: 1 });
        expect(capped).toEqual({ visited: 1, complete: false, stopReason: 'max_files' });
        expect(getFileCount(db), 'unvisited rows survive a capped walk').toBe(2);
    });
});

// ---------------------------------------------------------------------------
// G12 — FIXED by Task 1.1: upsertFile is ON CONFLICT DO UPDATE; child rows
// survive a bare file upsert. Converted from it.fails on 2026-07-15.
// ---------------------------------------------------------------------------

describe('G12: a bare file upsert preserves child symbol rows', () => {
    it('re-upserting a file row keeps its symbols', async () => {
        const repo = newTempDir('polaris-g12-');
        const db = tracked(openDb(path.join(newTempDir('polaris-g12-db-'), 'g12.db')));
        initSymbolSchema(db);

        const abs = path.join(repo, 'kept.ts');
        fs.writeFileSync(abs, 'export function keptFn(): number {\n    return 7;\n}\n');
        await ensureIndexFresh(db, repo, [abs]);
        const before = queryRaw(db, "SELECT COUNT(*) AS n FROM symbols WHERE file_path = 'kept.ts'")[0].n;
        expect(before).toBeGreaterThan(0); // precondition: children exist

        upsertFile(db, 'kept.ts', 'refreshed-hash', Date.now());

        const after = queryRaw(db, "SELECT COUNT(*) AS n FROM symbols WHERE file_path = 'kept.ts'")[0].n;
        // Fixed by Task 1.1: ON CONFLICT DO UPDATE mutates the row in place,
        // so the FK cascade never fires and children survive.
        expect(after, 'child rows survive a file upsert').toBe(before);
        // And the upsert really happened: the hash was updated in place.
        expect(queryRaw(db, "SELECT hash FROM files WHERE path = 'kept.ts'")[0].hash).toBe('refreshed-hash');
    });
});

// ---------------------------------------------------------------------------
// FUTURE_SCHEMA — FIXED by Task 1.1: the stored version is inspected
// read-only before any DDL and a newer version is refused with zero physical
// change. Converted from it.fails on 2026-07-15. Byte-level no-mutation is
// additionally proven in polaris-schema-migration.test.js.
// ---------------------------------------------------------------------------

describe('FUTURE_SCHEMA: a newer schema version is refused', () => {
    it('initSymbolSchema rejects a version-99 database', () => {
        const dbPath = path.join(newTempDir('polaris-future-'), 'future.db');
        const seed = openDb(dbPath);
        execRaw(seed, `
            CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
            INSERT INTO schema_version (id, version) VALUES (1, 99);
        `);
        closeDb(seed);

        const conn = tracked(openDb(dbPath));
        expect(() => initSymbolSchema(conn), 'a newer schema version must be refused').toThrow(/FUTURE_SCHEMA/);
    });
});
