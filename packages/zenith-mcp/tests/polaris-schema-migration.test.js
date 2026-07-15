// polaris-schema-migration.test.js — POLARIS Task 0.2
//
// Migration oracles over the REAL initSymbolSchema ladder:
//
//   1. Fixture ⇄ ladder equivalence: the seeded polaris-v1/v4 SQL fixtures
//      replay the ladder's DDL verbatim; if db-adapter.ts's ladder drifts,
//      the physical-schema deep-equal here fails loudly. This is what makes
//      the fixtures trustworthy migration INPUTS rather than parallel truth.
//   2. v1 → v4 migration preserves every canonical intelligence fact (the
//      canonical snapshot collapses version-gap columns to exactly the
//      backfill values the ladder writes — see helpers/polaris-db.js).
//   3. Initialization is idempotent (three inits, physically identical).
//   4. Every intermediate ladder version is reachable and completable.
//   5. Statement-level fault injection at each version write leaves the
//      database EXACTLY old-committed (never a torn rung), and a re-init
//      completes cleanly with facts intact.
//   6. FUTURE SCHEMA (live defect, review-confirmed): a version-99 database
//      is silently accepted and physically mutated today. The desired truth
//      (typed rejection, byte-for-byte no-mutation) is encoded as `it.fails`
//      and is converted to a plain `it` by Task 1.1.
//   7. The real-DB rehearsal release gate is DEFINED, never faked: it runs
//      only against a user-supplied copy (POLARIS_REAL_DB_COPY); absent that,
//      it is reported UNEXECUTED, and the live-DB refusal guard is proven.
//
// All databases here are file-backed through the real openDb (WAL,
// foreign_keys=ON) — never :memory: — because migration atomicity claims are
// only meaningful on the journaled file path.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    getSchemaVersion,
    execRaw,
    queryRaw,
} from '../dist/core/db-adapter.js';
import {
    physicalSnapshot,
    canonicalIntelligenceSnapshot,
    checkDbHealth,
    stableStringify,
    armFault,
    disarmAllFaults,
    seedV1Db,
    seedV4Db,
    buildLadderDbAtVersion,
    rehearseRealDbMigration,
    sha256File,
    makeTempDir,
    FAULT_MESSAGE,
    REAL_DB_ENV_VAR,
} from './helpers/polaris-db.js';

/** Track every opened connection/tempdir so a failing test never leaks. */
const openConns = new Set();
const tempDirs = [];

function tracked(conn) {
    openConns.add(conn);
    return conn;
}

function newDbPath(name) {
    const dir = makeTempDir('polaris-migration-');
    tempDirs.push(dir);
    return path.join(dir, name);
}

function close(conn) {
    if (openConns.has(conn)) {
        openConns.delete(conn);
        closeDb(conn);
    }
}

afterEach(() => {
    for (const conn of openConns) {
        try { disarmAllFaults(conn); } catch { /* connection may be broken */ }
        try { closeDb(conn); } catch { /* ignore */ }
    }
    openConns.clear();
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// ---------------------------------------------------------------------------
// 1. Fixture ⇄ real-ladder schema equivalence (the drift alarm)
// ---------------------------------------------------------------------------

describe('fixture ⇄ ladder schema equivalence', () => {
    it('polaris-v1-schema.sql produces exactly the schema the real ladder leaves at v1', () => {
        const fixtureConn = tracked(seedV1Db(newDbPath('fixture-v1.db')));
        const ladderConn = tracked(buildLadderDbAtVersion(newDbPath('ladder-v1.db'), 1));

        expect(getSchemaVersion(fixtureConn)).toBe(1);
        expect(getSchemaVersion(ladderConn)).toBe(1);

        const fixtureSchema = physicalSnapshot(fixtureConn).schema;
        const ladderSchema = physicalSnapshot(ladderConn).schema;
        expect(fixtureSchema).toEqual(ladderSchema);
    });

    it('polaris-v4-schema.sql produces exactly the schema a fresh initSymbolSchema creates', () => {
        const fixtureConn = tracked(seedV4Db(newDbPath('fixture-v4.db')));
        const freshConn = tracked(openDb(newDbPath('fresh-v4.db')));
        initSymbolSchema(freshConn);

        expect(getSchemaVersion(fixtureConn)).toBe(4);
        expect(getSchemaVersion(freshConn)).toBe(4);

        const fixtureSchema = physicalSnapshot(fixtureConn).schema;
        const freshSchema = physicalSnapshot(freshConn).schema;
        expect(fixtureSchema).toEqual(freshSchema);
    });

    it('the seeded fixtures are healthy and FK-consistent as written', () => {
        for (const seed of [seedV1Db, seedV4Db]) {
            const conn = tracked(seed(newDbPath('health.db')));
            const health = checkDbHealth(conn);
            expect(health.integrityOk).toBe(true);
            expect(health.foreignKeyViolations).toEqual([]);
            close(conn);
        }
    });
});

// ---------------------------------------------------------------------------
// 2. v1 → v4 migration preserves canonical intelligence facts
// ---------------------------------------------------------------------------

describe('v1 → v4 migration', () => {
    it('migrates the seeded v1 database to v4 preserving every canonical fact', () => {
        const conn = tracked(seedV1Db(newDbPath('migrate.db')));
        const before = canonicalIntelligenceSnapshot(conn);
        expect(getSchemaVersion(conn)).toBe(1);

        initSymbolSchema(conn);

        expect(getSchemaVersion(conn)).toBe(4);
        const after = canonicalIntelligenceSnapshot(conn);
        expect(stableStringify(after)).toBe(stableStringify(before));

        const health = checkDbHealth(conn);
        expect(health.integrityOk).toBe(true);
        expect(health.foreignKeyViolations).toEqual([]);
    });

    it('writes exactly the documented backfills for version-gap columns', () => {
        const conn = tracked(seedV1Db(newDbPath('backfill.db')));
        initSymbolSchema(conn);

        // v3→v4: every pre-existing edge backfills reference_kind = 'unknown'.
        const kinds = queryRaw(conn, 'SELECT DISTINCT reference_kind FROM edges');
        expect(kinds).toEqual([{ reference_kind: 'unknown' }]);

        // v3→v4: every pre-existing anchor backfills end_line = line.
        const anchorGap = queryRaw(conn, 'SELECT COUNT(*) AS n FROM anchors WHERE end_line IS NULL OR end_line != line');
        expect(anchorGap[0].n).toBe(0);

        // v2→v3: every pre-existing import backfills start_line = end_line = line.
        const importGap = queryRaw(conn, 'SELECT COUNT(*) AS n FROM imports WHERE start_line != line OR end_line != line');
        expect(importGap[0].n).toBe(0);

        // v1→v2 and v3→v4 both invalidate stored content hashes so normal
        // freshness re-parses every file into the new fact shape.
        const hashes = queryRaw(conn, 'SELECT COUNT(*) AS n FROM files WHERE hash IS NOT NULL');
        expect(hashes[0].n).toBe(0);

        // v1→v2: import_bindings exists and is empty until files re-index.
        const bindings = queryRaw(conn, 'SELECT COUNT(*) AS n FROM import_bindings');
        expect(bindings[0].n).toBe(0);
    });

    it('lands on a schema physically identical to a fresh v4 initialization', () => {
        const migrated = tracked(seedV1Db(newDbPath('migrated.db')));
        initSymbolSchema(migrated);
        const fresh = tracked(openDb(newDbPath('fresh.db')));
        initSymbolSchema(fresh);
        expect(physicalSnapshot(migrated).schema).toEqual(physicalSnapshot(fresh).schema);
    });
});

// ---------------------------------------------------------------------------
// 3. Idempotency
// ---------------------------------------------------------------------------

describe('initialization idempotency', () => {
    it('three consecutive initializations are physically identical', () => {
        const conn = tracked(seedV1Db(newDbPath('idempotent.db')));
        initSymbolSchema(conn);
        const first = physicalSnapshot(conn);
        initSymbolSchema(conn);
        const second = physicalSnapshot(conn);
        initSymbolSchema(conn);
        const third = physicalSnapshot(conn);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(getSchemaVersion(conn)).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// 4. Intermediate ladder versions are reachable and completable
// ---------------------------------------------------------------------------

describe('intermediate ladder versions', () => {
    for (const stopVersion of [0, 1, 2, 3]) {
        it(`a database halted at v${stopVersion} completes to v4 on the next init`, () => {
            const conn = tracked(buildLadderDbAtVersion(newDbPath(`halt-${stopVersion}.db`), stopVersion));
            expect(getSchemaVersion(conn)).toBe(stopVersion);

            initSymbolSchema(conn);

            expect(getSchemaVersion(conn)).toBe(4);
            const health = checkDbHealth(conn);
            expect(health.integrityOk).toBe(true);
            expect(health.foreignKeyViolations).toEqual([]);
        });
    }
});

// ---------------------------------------------------------------------------
// 5. Fault injection at every version write: old-committed or new-committed
// ---------------------------------------------------------------------------

describe('migration fault injection', () => {
    // Each ladder rung commits in its own transaction and writes its version
    // row LAST. Faulting that write must roll the entire rung back: the
    // acceptable observable states are exactly "previous rung committed" or
    // "this rung committed" — never a torn mixture.
    for (const targetVersion of [2, 3, 4]) {
        it(`fault at the v${targetVersion} version write leaves the v${targetVersion - 1} state exactly, then heals`, () => {
            const conn = tracked(seedV1Db(newDbPath(`fault-${targetVersion}.db`)));
            const before = canonicalIntelligenceSnapshot(conn);

            armFault(conn, { table: 'schema_version', op: 'INSERT', when: `NEW.version = ${targetVersion}`, timing: 'BEFORE' });
            armFault(conn, { table: 'schema_version', op: 'UPDATE', when: `NEW.version = ${targetVersion}`, timing: 'BEFORE' });

            let thrown = null;
            try {
                initSymbolSchema(conn);
            } catch (e) {
                thrown = e;
            }
            expect(thrown, 'the armed fault must fire').not.toBeNull();
            expect(String(thrown && thrown.message)).toContain(FAULT_MESSAGE);

            // Old-committed exactly: version is the previous rung, canonical
            // facts are untouched, integrity holds.
            expect(getSchemaVersion(conn)).toBe(targetVersion - 1);
            expect(stableStringify(canonicalIntelligenceSnapshot(conn))).toBe(stableStringify(before));
            const health = checkDbHealth(conn);
            expect(health.integrityOk).toBe(true);
            expect(health.foreignKeyViolations).toEqual([]);

            // Disarm and heal: the next init completes the ladder with the
            // same preserved facts.
            disarmAllFaults(conn);
            initSymbolSchema(conn);
            expect(getSchemaVersion(conn)).toBe(4);
            expect(stableStringify(canonicalIntelligenceSnapshot(conn))).toBe(stableStringify(before));
        });
    }

    it('a faulted migration survives close/reopen and still heals', () => {
        const dbPath = newDbPath('fault-reopen.db');
        const conn = tracked(seedV1Db(dbPath));
        const before = canonicalIntelligenceSnapshot(conn);
        armFault(conn, { table: 'schema_version', op: 'INSERT', when: 'NEW.version = 3', timing: 'BEFORE' });
        armFault(conn, { table: 'schema_version', op: 'UPDATE', when: 'NEW.version = 3', timing: 'BEFORE' });
        expect(() => initSymbolSchema(conn)).toThrow(FAULT_MESSAGE);
        // TEMP triggers die with the connection — close and reopen cold.
        close(conn);

        const reopened = tracked(openDb(dbPath));
        expect(getSchemaVersion(reopened)).toBe(2);
        initSymbolSchema(reopened);
        expect(getSchemaVersion(reopened)).toBe(4);
        expect(stableStringify(canonicalIntelligenceSnapshot(reopened))).toBe(stableStringify(before));
        const health = checkDbHealth(reopened);
        expect(health.integrityOk).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 6. Future schema — live defect, desired truth encoded as it.fails
// ---------------------------------------------------------------------------

/** Build a plausible schema-v99 database and return its path (closed). */
function buildFutureSchemaDb() {
    const dbPath = newDbPath('future-v99.db');
    const conn = openDb(dbPath);
    execRaw(conn, `
        CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
        INSERT INTO schema_version (id, version) VALUES (1, 99);
        CREATE TABLE intelligence_units_future (unit_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
        INSERT INTO intelligence_units_future (unit_key, payload) VALUES ('u-1', '{"from":"the-future"}');
    `);
    closeDb(conn);
    return dbPath;
}

describe('future-schema handling', () => {
    // Converted from it.fails on 2026-07-15 (Task 1.1): initSymbolSchema now
    // inspects the stored version READ-ONLY before any DDL and refuses a
    // newer database with zero physical mutation.
    it('rejects a v99 database with zero physical mutation', () => {
        const dbPath = buildFutureSchemaDb();
        const bytesBefore = sha256File(dbPath);

        const conn = tracked(openDb(dbPath));
        expect(() => initSymbolSchema(conn), 'initSymbolSchema must reject a newer schema version').toThrow(/FUTURE_SCHEMA/);
        // The refusal names both versions so the operator knows which build owns the DB.
        expect(() => initSymbolSchema(conn)).toThrow(/99/);
        // Nothing was created: the future DB still has only its own tables.
        const tables = queryRaw(conn, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'");
        expect(tables.length, 'base DDL must not run against a future database').toBe(0);
        close(conn);

        expect(sha256File(dbPath), 'a rejected future database must be byte-for-byte untouched').toBe(bytesBefore);
    });
});

// ---------------------------------------------------------------------------
// 7. Real-DB rehearsal — defined, gated on a user-supplied copy, never faked
// ---------------------------------------------------------------------------

describe('real-DB migration rehearsal (release gate)', () => {
    const suppliedCopy = process.env[REAL_DB_ENV_VAR];

    it.skipIf(!suppliedCopy)('rehearses the migration against the supplied copy', () => {
        const report = rehearseRealDbMigration(suppliedCopy);
        expect(report.executed).toBe(true);
        expect(report.afterVersion).toBe(4);
        expect(report.canonicalPreserved).toBe(true);
        expect(report.integrityOk).toBe(true);
        expect(report.foreignKeyViolations).toEqual([]);
    });

    it('reports the gate UNEXECUTED when no copy is supplied, and proves the live-home refusal guard', () => {
        if (!suppliedCopy) {
            // Explicit, honest gate state — this is release evidence, not a pass.
            console.warn(`[POLARIS] real-DB migration rehearsal UNEXECUTED: set ${REAL_DB_ENV_VAR}=<path-to-disposable-copy> to run it.`);
        }
        // The helper must refuse to touch the live database home even when
        // handed a path inside it — provable without any real database.
        const livePath = path.join(os.homedir(), '.zenith-mcp', 'global-stash.db');
        expect(() => rehearseRealDbMigration(livePath)).toThrow(/refusing to touch the live database home/);
        expect(() => rehearseRealDbMigration('')).toThrow(/explicit path/);
    });
});
