// POLARIS lead candidate fix for audit finding A10 — proof suite.
//
// Defect: runTransaction gated the commit-generation bump on a raw
// total_changes() delta across the outer transaction. SQLite total_changes()
// never decrements on ROLLBACK TO <savepoint>, so an outer COMMIT whose only
// writes were rolled back to an inner savepoint still bumped the generation
// and invalidated every open session on a net-no-op commit.
//
// Fix under test: voided-changes accounting — each savepoint frame snapshots
// (voidedAtEntry, total_changes) at entry; rollback voids the frame's FULL
// span by REPLACEMENT (voidedAtEntry + span). Replacement, not accumulation:
// accumulation double-counts nested rolled-back frames and can push the net
// negative, under-detecting real writes (stale sessions — the unforgivable
// direction). Commit bumps iff net !== 0, so residual accounting error
// over-invalidates, never serves staleness.
//
// Every cell here is adapter-level and self-contained; no session machinery.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    openDb, closeDb, initSymbolSchema, runTransaction, queryRaw, getFactEpoch,
} from '../dist/core/db-adapter.js';

let dir;
let conn;

const gen = () => getFactEpoch(conn).commitGeneration;
const write = (path) => queryRaw(conn,
    'INSERT INTO files (path, hash, last_indexed) VALUES (?, ?, 1) ' +
    'ON CONFLICT(path) DO UPDATE SET last_indexed = last_indexed + 1',
    path, 'h');

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'polaris-a10-'));
    conn = openDb(join(dir, 'a10.db'));
    initSymbolSchema(conn);
});

afterEach(async () => {
    closeDb(conn);
    await rm(dir, { recursive: true, force: true });
});

describe('A10 — savepoint rollbacks and the fact commit generation', () => {
    it('a rolled-back inner savepoint inside an otherwise read-only outer commit does not bump', () => {
        const before = gen();
        runTransaction(conn, () => {
            queryRaw(conn, 'SELECT COUNT(*) FROM files'); // net-read-only outer
            try {
                runTransaction(conn, () => {
                    write('a.ts');
                    throw new Error('inner');
                });
            } catch { /* contained */ }
        });
        expect(gen()).toBe(before);
    });

    it('a rolled-back savepoint followed by a surviving write still bumps (no under-detection)', () => {
        const before = gen();
        runTransaction(conn, () => {
            try {
                runTransaction(conn, () => {
                    write('rolled.ts');
                    throw new Error('inner');
                });
            } catch { /* contained */ }
            write('survives.ts'); // after the rollback, same outer txn
        });
        expect(gen()).toBe(before + 1);
        const rows = queryRaw(conn, 'SELECT path FROM files ORDER BY path');
        expect(rows.map((r) => r.path)).toEqual(['survives.ts']);
    });

    it('nested double-rollback does not double-void: a surviving sibling write bumps', () => {
        // sp2 writes and rolls back inside sp1; sp1 ALSO rolls back. With
        // accumulation the sp2 span would be voided twice and the surviving
        // outer write would be cancelled out (net <= 0, no bump, stale
        // sessions). Replacement voids exactly the sp1 span once.
        const before = gen();
        runTransaction(conn, () => {
            try {
                runTransaction(conn, () => {          // sp1
                    write('sp1.ts');
                    try {
                        runTransaction(conn, () => {  // sp2
                            write('sp2.ts');
                            throw new Error('inner2');
                        });
                    } catch { /* contained */ }
                    throw new Error('inner1');
                });
            } catch { /* contained */ }
            write('outer-survivor.ts');
        });
        expect(gen()).toBe(before + 1);
        const rows = queryRaw(conn, 'SELECT path FROM files ORDER BY path');
        expect(rows.map((r) => r.path)).toEqual(['outer-survivor.ts']);
    });

    it('nested double-rollback with nothing surviving does not bump', () => {
        const before = gen();
        runTransaction(conn, () => {
            try {
                runTransaction(conn, () => {
                    write('sp1.ts');
                    try {
                        runTransaction(conn, () => {
                            write('sp2.ts');
                            throw new Error('inner2');
                        });
                    } catch { /* contained */ }
                    throw new Error('inner1');
                });
            } catch { /* contained */ }
        });
        expect(gen()).toBe(before);
        expect(queryRaw(conn, 'SELECT COUNT(*) AS c FROM files')[0].c).toBe(0);
    });

    it('two disjoint rolled-back savepoints in one outer accumulate voids correctly (no bump)', () => {
        const before = gen();
        runTransaction(conn, () => {
            for (const name of ['first.ts', 'second.ts']) {
                try {
                    runTransaction(conn, () => {
                        write(name);
                        throw new Error('inner');
                    });
                } catch { /* contained */ }
            }
        });
        expect(gen()).toBe(before);
    });

    it('a successfully RELEASEd savepoint write bumps exactly once at the outer commit', () => {
        const before = gen();
        runTransaction(conn, () => {
            runTransaction(conn, () => {
                write('kept.ts');
            });
        });
        expect(gen()).toBe(before + 1);
    });

    it('an outer ROLLBACK never bumps, with or without savepoint activity inside', () => {
        const before = gen();
        expect(() => runTransaction(conn, () => {
            write('doomed.ts');
            try {
                runTransaction(conn, () => {
                    write('doomed2.ts');
                    throw new Error('inner');
                });
            } catch { /* contained */ }
            throw new Error('outer');
        })).toThrow('outer');
        expect(gen()).toBe(before);
    });

    it('voided state resets between outer transactions', () => {
        // A rolled-back savepoint in txn 1 must not discount txn 2's writes.
        const before = gen();
        runTransaction(conn, () => {
            try {
                runTransaction(conn, () => {
                    write('t1.ts');
                    throw new Error('inner');
                });
            } catch { /* contained */ }
        });
        expect(gen()).toBe(before); // txn 1: net zero
        runTransaction(conn, () => {
            write('t2.ts');
        });
        expect(gen()).toBe(before + 1); // txn 2: real write, full bump
    });
});
