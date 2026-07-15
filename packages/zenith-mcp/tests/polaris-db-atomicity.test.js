// polaris-db-atomicity.test.js — POLARIS Task 0.2
//
// Transaction-boundary oracles for the ONE sanctioned persistence path
// (extract → persistParsedFile inside a single transaction), driven through
// the real pipeline (ensureFreshFromContent → indexFile → extract → persist)
// against file-backed databases (WAL, foreign_keys=ON — never :memory:,
// because atomicity claims are only meaningful on the journaled file path).
//
// The invariant proved here, table by table: a fault injected AFTER any write
// boundary inside the persist transaction leaves the database in EXACTLY the
// old-committed state (canonical facts, physical rows, integrity), and a
// healed retry lands in EXACTLY the new-committed state — byte-equivalent to
// a never-faulted oracle build. There is no third state.
//
// Also proved: nested SAVEPOINT semantics of runTransaction, close/reopen
// durability, and the delete-children-first re-persist path that keeps the
// G12 `INSERT OR REPLACE INTO files` cascade latent today (the cascade itself
// is pinned as a live defect in polaris-current-failures.test.js).
//
// The fixture is JavaScript on purpose: the javascript grammar ships an
// injections.scm, so the sql`…` tagged template below produces real
// `injections` rows — every table persistParsedFile writes appears in the
// fault matrix with real rows, and a guard test proves none of the faults is
// vacuous.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    queryRaw,
    runTransaction,
} from '../dist/core/db-adapter.js';
import { ensureFreshFromContent } from '../dist/core/symbol-index.js';
import {
    physicalSnapshot,
    canonicalIntelligenceSnapshot,
    checkDbHealth,
    stableStringify,
    armFault,
    disarmAllFaults,
    seedV4Db,
    makeTempDir,
    FAULT_MESSAGE,
} from './helpers/polaris-db.js';

// ---------------------------------------------------------------------------
// Fixture content — V1 (baseline) and V2 (touches every persisted table)
// ---------------------------------------------------------------------------

const FILE_NAME = 'app.js';
const OTHER_FILE_NAME = 'other.js';

// A second file whose edge references app.js's `coreFn`: it makes the
// affected-name protocol's cross-file work REAL in this fixture — V2's
// re-persist of app.js must clear other.js's resolved edge (coreFn is a
// changed definition name) and re-resolve it to the new coreFn, exercising
// both new fault boundaries (step 10a clear, step 10b re-resolve).
const OTHER_CONTENT = [
    "import { coreFn } from './app';",
    '',
    'function useCore(c) {',
    '    return coreFn(c);',
    '}',
    '',
].join('\n');

const CONTENT_V1 = [
    "import { helperOne } from './helper';",
    '',
    'function coreFn(x) {',
    '    return helperOne(x) + 1;',
    '}',
    '',
    'function callerFn(y) {',
    '    if (y > 0) {',
    '        return coreFn(y);',
    '    }',
    '    return 0;',
    '}',
    '',
    'function schemaFn(gql) {',
    '    const s = gql`query { polaris }`;',
    '    return s;',
    '}',
    '',
].join('\n');

const CONTENT_V2 = [
    "import { helperOne, helperTwo } from './helper';",
    '',
    'function coreFn(x) {',
    '    return helperOne(x) + helperTwo(x);',
    '}',
    '',
    'function callerTwo(y) {',
    '    if (y > 0) {',
    '        return coreFn(y);',
    '    }',
    '    return 0;',
    '}',
    '',
    'function queryFn(sql) {',
    '    const q = sql`SELECT id FROM widgets WHERE size > 1`;',
    '    return q;',
    '}',
    '',
].join('\n');

// Every table persistParsedFile writes, with the operation faulted at that
// boundary. symbols appears three times: the step-1 clear (DELETE), the
// insert pass (INSERT), and the extras pass (UPDATE) are distinct boundaries.
const FAULT_MATRIX = [
    { table: 'symbols', op: 'DELETE', boundary: 'step 1a: clear old symbol rows' },
    // File-FK'd children are cleared EXPLICITLY since Task 1.1 made the file
    // upsert non-destructive (the OR-REPLACE cascade used to clear them).
    { table: 'imports', op: 'DELETE', boundary: 'step 1b: clear old statement imports' },
    { table: 'import_bindings', op: 'DELETE', boundary: 'step 1c: clear old import bindings' },
    { table: 'injections', op: 'DELETE', boundary: 'step 1d: clear old injections' },
    // The file upsert is ON CONFLICT DO UPDATE (Task 1.1): on a re-persist the
    // existing row takes the conflict path, which fires UPDATE triggers.
    { table: 'files', op: 'UPDATE', boundary: 'step 2: file upsert (conflict path)' },
    { table: 'symbols', op: 'INSERT', boundary: 'step 3a: symbol insert pass' },
    { table: 'symbols', op: 'UPDATE', boundary: 'step 3b: symbol extras pass' },
    { table: 'edges', op: 'INSERT', boundary: 'step 4: edges' },
    { table: 'symbol_structures', op: 'INSERT', boundary: 'step 5: structures' },
    { table: 'anchors', op: 'INSERT', boundary: 'step 6: anchors' },
    { table: 'imports', op: 'INSERT', boundary: 'step 7a: statement imports' },
    { table: 'import_bindings', op: 'INSERT', boundary: 'step 7b: import bindings' },
    { table: 'injections', op: 'INSERT', boundary: 'step 8: injections' },
    { table: 'local_scopes', op: 'INSERT', boundary: 'step 9: local scopes' },
    // POLARIS Task 1.3 — the affected-name protocol's two edge writes, split
    // by direction so each boundary faults independently: the stale-target
    // CLEAR sets callee_symbol_id to NULL; the re-RESOLUTION sets it non-NULL.
    { table: 'edges', op: 'UPDATE', when: 'NEW.callee_symbol_id IS NULL', boundary: 'step 10a: affected-name clear' },
    { table: 'edges', op: 'UPDATE', when: 'NEW.callee_symbol_id IS NOT NULL', boundary: 'step 10b: affected-name re-resolution' },
];

const PERSIST_TABLES = [...new Set(FAULT_MATRIX.map((f) => f.table))];

// ---------------------------------------------------------------------------
// Shared state — one fixture repo, one V2 oracle canonical, per-test DBs
// ---------------------------------------------------------------------------

let repoDir;
let absFile;
let absOtherFile;
/** Canonical facts of a NEVER-FAULTED straight-V2 build (the oracle). */
let oracleV2Canonical;
/** Per-table row counts of the oracle build (guards against vacuous faults). */
let oracleV2RowCounts;

const tempDirs = [];
const openConns = new Set();

function newDbPath(name) {
    const dir = makeTempDir('polaris-atomicity-');
    tempDirs.push(dir);
    return path.join(dir, name);
}

function tracked(conn) {
    openConns.add(conn);
    return conn;
}

function close(conn) {
    if (openConns.has(conn)) {
        openConns.delete(conn);
        closeDb(conn);
    }
}

async function freshDbWithV1(name) {
    const conn = tracked(openDb(newDbPath(name)));
    initSymbolSchema(conn);
    const indexed = await ensureFreshFromContent(conn, repoDir, absFile, CONTENT_V1);
    expect(indexed).toBe(1);
    const indexedOther = await ensureFreshFromContent(conn, repoDir, absOtherFile, OTHER_CONTENT);
    expect(indexedOther).toBe(1);
    return conn;
}

beforeAll(async () => {
    repoDir = makeTempDir('polaris-atomicity-repo-');
    tempDirs.push(repoDir);
    absFile = path.join(repoDir, FILE_NAME);
    absOtherFile = path.join(repoDir, OTHER_FILE_NAME);
    // The content-addressed path never reads disk, but the files existing keeps
    // path semantics honest (language detection is extension-based either way).
    fs.writeFileSync(absFile, CONTENT_V1);
    fs.writeFileSync(absOtherFile, OTHER_CONTENT);

    // Build the V2 oracle once: a pristine database, straight to V2, no fault.
    const oracle = openDb(newDbPath('oracle-v2.db'));
    initSymbolSchema(oracle);
    await ensureFreshFromContent(oracle, repoDir, absFile, CONTENT_V2);
    await ensureFreshFromContent(oracle, repoDir, absOtherFile, OTHER_CONTENT);
    oracleV2Canonical = canonicalIntelligenceSnapshot(oracle);
    oracleV2RowCounts = {};
    for (const table of PERSIST_TABLES) {
        oracleV2RowCounts[table] = queryRaw(oracle, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;
    }
    closeDb(oracle);
});

afterEach(() => {
    for (const conn of openConns) {
        try { disarmAllFaults(conn); } catch { /* connection may be broken */ }
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
// Guard: no vacuous faults — the V2 fixture writes every matrix table
// ---------------------------------------------------------------------------

describe('fault-matrix coverage guard', () => {
    it('the V2 fixture persists at least one row into every fault-matrix table', () => {
        for (const table of PERSIST_TABLES) {
            expect(
                oracleV2RowCounts[table],
                `table ${table} must receive rows from the V2 fixture or its fault test is vacuous`
            ).toBeGreaterThan(0);
        }
    });

    it('the V1 baseline holds rows in every DELETE-faulted table (the clears are real)', async () => {
        const conn = await freshDbWithV1('delete-guard.db');
        for (const spec of FAULT_MATRIX) {
            if (spec.op !== 'DELETE') continue;
            const n = queryRaw(conn, `SELECT COUNT(*) AS n FROM ${spec.table}`)[0].n;
            expect(n, `V1 must persist rows into ${spec.table} or its DELETE fault is vacuous`).toBeGreaterThan(0);
        }
    });
});

// ---------------------------------------------------------------------------
// The fault matrix: old-committed or new-committed, never a third state
// ---------------------------------------------------------------------------

describe('persistParsedFile fault matrix', () => {
    for (const spec of FAULT_MATRIX) {
        it(`fault after ${spec.op} on ${spec.table} (${spec.boundary}): exact old state, then exact heal`, async () => {
            const conn = await freshDbWithV1(`fault-${spec.table}-${spec.op}.db`);
            const baselineCanonical = stableStringify(canonicalIntelligenceSnapshot(conn));
            const baselinePhysical = physicalSnapshot(conn);

            // AFTER timing: the row write crosses the boundary, then the abort
            // fires — a true post-write-boundary fault inside the transaction.
            // Direction-split edge faults carry a WHEN clause (see FAULT_MATRIX).
            armFault(conn, spec.when === undefined
                ? { table: spec.table, op: spec.op }
                : { table: spec.table, op: spec.op, when: spec.when });

            await expect(
                ensureFreshFromContent(conn, repoDir, absFile, CONTENT_V2)
            ).rejects.toThrow(FAULT_MESSAGE);

            // Old-committed EXACTLY: canonical facts, physical rows, sequence,
            // schema — all unchanged; integrity and FKs clean.
            expect(stableStringify(canonicalIntelligenceSnapshot(conn))).toBe(baselineCanonical);
            expect(physicalSnapshot(conn)).toEqual(baselinePhysical);
            const health = checkDbHealth(conn);
            expect(health.integrityOk).toBe(true);
            expect(health.foreignKeyViolations).toEqual([]);

            // Heal: disarm, retry the same write, land in EXACTLY the oracle
            // (never-faulted) V2 state.
            disarmAllFaults(conn);
            const indexed = await ensureFreshFromContent(conn, repoDir, absFile, CONTENT_V2);
            expect(indexed).toBe(1);
            expect(stableStringify(canonicalIntelligenceSnapshot(conn))).toBe(stableStringify(oracleV2Canonical));
            const healedHealth = checkDbHealth(conn);
            expect(healedHealth.integrityOk).toBe(true);
            expect(healedHealth.foreignKeyViolations).toEqual([]);
        });
    }

    it('an unfaulted V1 → V2 transition equals the straight-V2 oracle exactly', async () => {
        const conn = await freshDbWithV1('transition.db');

        // Precondition proving the cross-file protocol is REAL here: other.js's
        // edge to coreFn resolved against V1's app.js.
        const before = queryRaw(conn, `SELECT callee.file_path AS f FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            JOIN symbols callee ON callee.id = e.callee_symbol_id
            WHERE caller.name = 'useCore' AND e.referenced_name = 'coreFn'`);
        expect(before.length, 'cross-file edge must be resolved pre-transition').toBe(1);

        await ensureFreshFromContent(conn, repoDir, absFile, CONTENT_V2);
        expect(stableStringify(canonicalIntelligenceSnapshot(conn))).toBe(stableStringify(oracleV2Canonical));

        // And it re-resolved to the NEW coreFn during the same persist — the
        // clear (10a) and re-resolution (10b) both fired for real.
        const after = queryRaw(conn, `SELECT callee.line AS line FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            JOIN symbols callee ON callee.id = e.callee_symbol_id
            WHERE caller.name = 'useCore' AND e.referenced_name = 'coreFn'`);
        expect(after.length, 'cross-file edge must be resolved post-transition').toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Durability: committed state survives close/reopen bit-for-bit (canonically)
// ---------------------------------------------------------------------------

describe('close/reopen durability', () => {
    it('the committed V2 state reads back identically after a cold reopen', async () => {
        const dbPath = newDbPath('reopen.db');
        const conn = tracked(openDb(dbPath));
        initSymbolSchema(conn);
        await ensureFreshFromContent(conn, repoDir, absFile, CONTENT_V2);
        const before = stableStringify(canonicalIntelligenceSnapshot(conn));
        close(conn);

        const reopened = tracked(openDb(dbPath));
        expect(stableStringify(canonicalIntelligenceSnapshot(reopened))).toBe(before);
        const health = checkDbHealth(reopened);
        expect(health.integrityOk).toBe(true);
        expect(health.foreignKeyViolations).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Nested SAVEPOINT semantics of runTransaction
// ---------------------------------------------------------------------------

describe('nested savepoint semantics', () => {
    it('an inner rollback is contained; the outer transaction commits its own writes', () => {
        const conn = tracked(seedV4Db(newDbPath('savepoint-inner.db')));
        runTransaction(conn, () => {
            queryRaw(conn, "INSERT INTO patterns (name, edit_body, symbol_kind, created_at) VALUES ('sp-a', 'a', 'function', 1)");
            try {
                runTransaction(conn, () => {
                    queryRaw(conn, "INSERT INTO patterns (name, edit_body, symbol_kind, created_at) VALUES ('sp-b', 'b', 'function', 2)");
                    throw new Error('inner-abort');
                });
            } catch (e) {
                expect(String(e.message)).toBe('inner-abort');
            }
            queryRaw(conn, "INSERT INTO patterns (name, edit_body, symbol_kind, created_at) VALUES ('sp-c', 'c', 'function', 3)");
        });
        const names = queryRaw(conn, "SELECT name FROM patterns WHERE name LIKE 'sp-%' ORDER BY name").map((r) => r.name);
        expect(names).toEqual(['sp-a', 'sp-c']);
        expect(checkDbHealth(conn).integrityOk).toBe(true);
    });

    it('an outer abort rolls back released inner savepoints too', () => {
        const conn = tracked(seedV4Db(newDbPath('savepoint-outer.db')));
        expect(() => {
            runTransaction(conn, () => {
                queryRaw(conn, "INSERT INTO patterns (name, edit_body, symbol_kind, created_at) VALUES ('sp-d', 'd', 'function', 4)");
                runTransaction(conn, () => {
                    queryRaw(conn, "INSERT INTO patterns (name, edit_body, symbol_kind, created_at) VALUES ('sp-e', 'e', 'function', 5)");
                });
                throw new Error('outer-abort');
            });
        }).toThrow('outer-abort');
        const count = queryRaw(conn, "SELECT COUNT(*) AS n FROM patterns WHERE name LIKE 'sp-%'")[0].n;
        expect(count).toBe(0);
        expect(checkDbHealth(conn).integrityOk).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// The safe re-persist path (why the G12 upsert cascade is latent today)
// ---------------------------------------------------------------------------

describe('re-persist through the sanctioned path', () => {
    it('re-indexing changed bytes with identical facts preserves every canonical fact', async () => {
        const conn = await freshDbWithV1('repersist.db');
        const before = stableStringify(canonicalIntelligenceSnapshot(conn));

        // Append a trailing comment line: new content hash (forces a real
        // re-persist through delete-children-first + upsert) with zero
        // structural fact changes above it.
        const v1Prime = CONTENT_V1 + '// trailing note\n';
        const indexed = await ensureFreshFromContent(conn, repoDir, absFile, v1Prime);
        expect(indexed).toBe(1);

        expect(stableStringify(canonicalIntelligenceSnapshot(conn))).toBe(before);
        const health = checkDbHealth(conn);
        expect(health.integrityOk).toBe(true);
        expect(health.foreignKeyViolations).toEqual([]);
    });
});
