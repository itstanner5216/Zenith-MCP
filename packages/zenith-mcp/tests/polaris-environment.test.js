// polaris-environment.test.js — POLARIS Task 0.3
//
// Environment probes: facts about the platform POLARIS builds on, proven
// executable here so no later wave discovers them mid-implementation.
//
//   1. node:sqlite recursive CTEs terminate under a depth guard even on a
//      CYCLIC parent chain (the ancestry-walk shape Task 2.2 uses, depth<64).
//   2. Symbol, stash, backup, and observation schemas cohabit one database
//      (the global-DB layout Task 1.4 initializes) without data loss in
//      either direction — including rows that predate symbol initialization.
//   3. Worktree root discovery: a `.git` FILE (worktree/submodule pointer)
//      identifies its directory as the repo root.
//   4. WAL isolation: a second connection never observes an uncommitted
//      writer's rows, and observes them exactly after commit.
//   5. Global two-root key isolation: the `g/<rootHash>/<relPath>` addressing
//      scheme (Decision 18) keeps two roots' identical relative paths
//      disjoint under prefix-scoped reads on the CURRENT v4 schema.
//   6. PRAGMA data_version semantics (Decision 16, PATCH 2): on a file-backed
//      database it increments when ANOTHER connection commits, and does NOT
//      change on the same connection's own commits, rollbacks, or savepoint
//      releases — which is exactly why the fact epoch must pair it with a
//      connection-local outer-commit generation.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    initStashSchema,
    initBackupSchema,
    initObservationSchema,
    insertStash,
    getStash,
    listStash,
    execRaw,
    queryRaw,
    runTransaction,
} from '../dist/core/db-adapter.js';
import { findRepoRoot } from '../dist/core/symbol-index.js';
import { makeTempDir, checkDbHealth } from './helpers/polaris-db.js';

const tempDirs = [];
const openConns = new Set();

function newTempDir(prefix = 'polaris-env-') {
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
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

function dataVersion(conn) {
    return queryRaw(conn, 'PRAGMA data_version')[0].data_version;
}

// ---------------------------------------------------------------------------
// 1. Recursive CTE with a cycle guard
// ---------------------------------------------------------------------------

describe('recursive CTE ancestry walk', () => {
    it('terminates on a cyclic parent chain under a depth < 64 guard', () => {
        const conn = tracked(openDb(path.join(newTempDir(), 'cte.db')));
        initSymbolSchema(conn);
        execRaw(conn, `
            INSERT INTO files (path, hash, last_indexed) VALUES ('cyc.ts', 'h', 1);
            INSERT INTO symbols (id, name, kind, type, file_path, line, end_line, column) VALUES
                (1, 'a', 'def', 'function', 'cyc.ts', 1, 2, 0),
                (2, 'b', 'def', 'function', 'cyc.ts', 3, 4, 0);
            UPDATE symbols SET parent_symbol_id = 2 WHERE id = 1;
            UPDATE symbols SET parent_symbol_id = 1 WHERE id = 2; -- cycle: a <-> b
        `);

        const rows = queryRaw(conn, `
            WITH RECURSIVE ancestry(id, parent_id, depth) AS (
                SELECT id, parent_symbol_id, 0 FROM symbols WHERE id = 1
                UNION ALL
                SELECT s.id, s.parent_symbol_id, a.depth + 1
                FROM symbols s JOIN ancestry a ON s.id = a.parent_id
                WHERE a.depth < 64
            )
            SELECT id, depth FROM ancestry ORDER BY depth
        `);

        // The guard, not the data, terminates the walk: depths 0..64 inclusive.
        expect(rows.length).toBe(65);
        expect(rows[rows.length - 1].depth).toBe(64);
    });

    it('walks a legitimate chain to its root without hitting the guard', () => {
        const conn = tracked(openDb(path.join(newTempDir(), 'cte2.db')));
        initSymbolSchema(conn);
        execRaw(conn, `
            INSERT INTO files (path, hash, last_indexed) VALUES ('chain.ts', 'h', 1);
            INSERT INTO symbols (id, name, kind, type, file_path, line, end_line, column) VALUES
                (1, 'root', 'def', 'class', 'chain.ts', 1, 9, 0),
                (2, 'mid', 'def', 'class', 'chain.ts', 2, 8, 0),
                (3, 'leaf', 'def', 'method', 'chain.ts', 3, 4, 0);
            UPDATE symbols SET parent_symbol_id = 1 WHERE id = 2;
            UPDATE symbols SET parent_symbol_id = 2 WHERE id = 3;
        `);
        const rows = queryRaw(conn, `
            WITH RECURSIVE ancestry(id, parent_id, depth) AS (
                SELECT id, parent_symbol_id, 0 FROM symbols WHERE id = 3
                UNION ALL
                SELECT s.id, s.parent_symbol_id, a.depth + 1
                FROM symbols s JOIN ancestry a ON s.id = a.parent_id
                WHERE a.depth < 64
            )
            SELECT id FROM ancestry ORDER BY depth
        `);
        expect(rows.map((r) => r.id)).toEqual([3, 2, 1]);
    });
});

// ---------------------------------------------------------------------------
// 2. Schema cohabitation in one database (the global-DB layout)
// ---------------------------------------------------------------------------

describe('symbol/stash/backup/observation cohabitation', () => {
    it('stash rows written BEFORE symbol initialization survive it untouched', () => {
        const conn = tracked(openDb(path.join(newTempDir(), 'cohabit.db')));
        initStashSchema(conn);
        const id = insertStash(conn, { type: 'edit', filePath: 'x.ts', payload: '{"p":1}', createdAt: 123 });

        initSymbolSchema(conn);
        initBackupSchema(conn);
        initObservationSchema(conn);

        const row = getStash(conn, id);
        expect(row).not.toBeNull();
        expect(row.payload).toBe('{"p":1}');
        expect(row.created_at).toBe(123);

        // And the full stash listing is exactly the one row — nothing was
        // duplicated or re-keyed by the cohabiting initializations.
        expect(listStash(conn).length).toBe(1);

        const health = checkDbHealth(conn);
        expect(health.integrityOk).toBe(true);
        expect(health.foreignKeyViolations).toEqual([]);
    });

    it('symbol rows survive stash/backup/observation initialization', () => {
        const conn = tracked(openDb(path.join(newTempDir(), 'cohabit2.db')));
        initSymbolSchema(conn);
        execRaw(conn, `
            INSERT INTO files (path, hash, last_indexed) VALUES ('s.ts', 'h', 1);
            INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                VALUES ('fn', 'def', 'function', 's.ts', 1, 2, 0);
        `);
        initStashSchema(conn);
        initBackupSchema(conn);
        initObservationSchema(conn);
        expect(queryRaw(conn, 'SELECT COUNT(*) AS n FROM symbols')[0].n).toBe(1);
        expect(checkDbHealth(conn).integrityOk).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 3. Worktree root discovery
// ---------------------------------------------------------------------------

describe('worktree root discovery', () => {
    it('a .git FILE (worktree pointer) marks its directory as the root', () => {
        const dir = newTempDir('polaris-worktree-');
        const inner = path.join(dir, 'src');
        fs.mkdirSync(inner, { recursive: true });
        // A worktree pointer references a gitdir that does not exist here, so
        // `git rev-parse` fails and the pure-fs fallback must still answer.
        fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent/.git/worktrees/probe\n');
        fs.writeFileSync(path.join(inner, 'f.ts'), 'export const x = 1;\n');

        expect(findRepoRoot(path.join(inner, 'f.ts'))).toBe(dir);
    });

    it('this checkout itself resolves to a root containing its .git metadata pointer', () => {
        // The import-extension checkout is a real worktree (.git is a file).
        const here = findRepoRoot(process.cwd());
        expect(here).not.toBeNull();
        const gitPath = path.join(here, '.git');
        expect(fs.existsSync(gitPath)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 4. WAL isolation across connections
// ---------------------------------------------------------------------------

describe('WAL reader visibility', () => {
    it('a reader never sees an uncommitted writer, and sees it exactly after commit', () => {
        const dbPath = path.join(newTempDir(), 'wal.db');
        const writer = tracked(openDb(dbPath));
        initStashSchema(writer);

        const reader = tracked(openDb(dbPath));

        execRaw(writer, 'BEGIN');
        execRaw(writer, "INSERT INTO stash (type, file_path, payload, attempts, created_at) VALUES ('t', null, 'uncommitted', 0, 1)");

        expect(queryRaw(reader, 'SELECT COUNT(*) AS n FROM stash')[0].n).toBe(0);

        execRaw(writer, 'COMMIT');
        expect(queryRaw(reader, 'SELECT COUNT(*) AS n FROM stash')[0].n).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// 5. Global two-root key isolation (the g/<rootHash>/ scheme on v4)
// ---------------------------------------------------------------------------

describe('global two-root isolation', () => {
    it('identical relative paths under two roots stay disjoint under prefix reads', () => {
        const conn = tracked(openDb(path.join(newTempDir(), 'global.db')));
        initSymbolSchema(conn);

        const rootA = 'g/' + crypto.createHash('sha256').update('/allowed/root-a').digest('hex').slice(0, 16);
        const rootB = 'g/' + crypto.createHash('sha256').update('/allowed/root-b').digest('hex').slice(0, 16);

        for (const [prefix, fn] of [[rootA, 'fromA'], [rootB, 'fromB']]) {
            const key = `${prefix}/src/same.ts`;
            execRaw(conn, `INSERT INTO files (path, hash, last_indexed) VALUES ('${key}', 'h', 1)`);
            execRaw(conn, `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                VALUES ('${fn}', 'def', 'function', '${key}', 1, 2, 0)`);
        }

        const scopedA = queryRaw(conn, "SELECT s.name FROM symbols s WHERE s.file_path LIKE ? ESCAPE '\\'", `${rootA}/%`);
        const scopedB = queryRaw(conn, "SELECT s.name FROM symbols s WHERE s.file_path LIKE ? ESCAPE '\\'", `${rootB}/%`);
        expect(scopedA.map((r) => r.name)).toEqual(['fromA']);
        expect(scopedB.map((r) => r.name)).toEqual(['fromB']);

        // The two file keys are distinct rows despite the identical relative path.
        expect(queryRaw(conn, 'SELECT COUNT(*) AS n FROM files')[0].n).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// 6. PRAGMA data_version semantics (Decision 16 / PATCH 2)
// ---------------------------------------------------------------------------

describe('PRAGMA data_version semantics', () => {
    it('increments for a second connection\'s commit; never for our own writes', () => {
        const dbPath = path.join(newTempDir(), 'dv.db');
        const connA = tracked(openDb(dbPath));
        initStashSchema(connA);
        const connB = tracked(openDb(dbPath));

        const v0 = dataVersion(connA);

        // Own committed write: data_version on the SAME connection must not move.
        runTransaction(connA, () => {
            insertStash(connA, { type: 'own', filePath: null, payload: 'a', createdAt: 1 });
        });
        expect(dataVersion(connA), 'own commit must not change our data_version').toBe(v0);

        // Own rollback: no movement.
        try {
            runTransaction(connA, () => {
                insertStash(connA, { type: 'rb', filePath: null, payload: 'b', createdAt: 2 });
                throw new Error('abort');
            });
        } catch { /* expected */ }
        expect(dataVersion(connA), 'own rollback must not change our data_version').toBe(v0);

        // Own nested savepoint release: no movement.
        runTransaction(connA, () => {
            runTransaction(connA, () => {
                insertStash(connA, { type: 'sp', filePath: null, payload: 'c', createdAt: 3 });
            });
        });
        expect(dataVersion(connA), 'savepoint release must not change our data_version').toBe(v0);

        // ANOTHER connection's commit: our data_version must increment.
        runTransaction(connB, () => {
            insertStash(connB, { type: 'other', filePath: null, payload: 'd', createdAt: 4 });
        });
        expect(dataVersion(connA), "a second connection's commit must be visible").toBeGreaterThan(v0);

        // And symmetrically, connB never saw its own commits move its counter,
        // but did see connA's earlier commits when it first read.
        const bNow = dataVersion(connB);
        runTransaction(connB, () => {
            insertStash(connB, { type: 'other2', filePath: null, payload: 'e', createdAt: 5 });
        });
        expect(dataVersion(connB)).toBe(bNow);
    });
});
