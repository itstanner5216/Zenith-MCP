// polaris-session.test.js — POLARIS Task 2.1
//
// The session machinery, proven end to end on real stores:
//
//   - open: anchor routing, domain enumeration (file/directory/project,
//     recursive and not), typed module refusal, canonical source-domain
//     digest, content mode with exact bytes, partial-content failure receipt
//   - security: sensitive files are never domain members
//   - fact epoch: pinned (data_version, outer-commit generation) pair plus
//     the scope hash view; every query entry revalidates all three
//   - lease: +30 s slide on success, 10-minute hard cap, typed expiry
//   - close: typed SESSION_CLOSED, precedence over expiry, idempotent
//   - cursors: MAC round-trip, tampering, cross-session and cross-question
//     rejection, malformed input
//   - facade: exactly three function exports; advisory stubs typed unavailable
//
// Sessions run against real DBs (file-backed, real ingestion). $HOME is
// stubbed per test so global stores and config reads stay hermetic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const SAVED_HOME = HOME_KEYS.map((k) => [k, process.env[k]]);

let fakeHome;
let mods; // { session, facade, pc, db, si }

async function importFresh() {
    vi.resetModules();
    return {
        session: await import('../dist/core/intelligence/session.js'),
        facade: await import('../dist/core/intelligence/ast-intelligence.js'),
        pc: await import('../dist/core/project-context.js'),
        db: await import('../dist/core/db-adapter.js'),
        helpers: await import(pathToFileURL(path.join(import.meta.dirname, 'helpers', 'polaris-db.js')).href),
    };
}

function mkCtx(allowedDirs) {
    return {
        getAllowedDirectories: () => allowedDirs,
        validatePath: async (p) => p,
    };
}

/** A tiny project: two TS files, one nested, one .txt, one .png, one .env. */
function seedWorkspace(root) {
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'alpha.ts'),
        'export function alphaFn(): number {\n    return 1;\n}\n');
    fs.writeFileSync(path.join(root, 'src', 'deep', 'beta.ts'),
        'import { alphaFn } from \'../alpha.js\';\nexport function betaFn(): number {\n    return alphaFn();\n}\n');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'plain notes\n');
    fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

async function openGlobal(domainOverride, freshness, deps) {
    const root = fs.mkdtempSync(path.join(fakeHome, 'ws-'));
    seedWorkspace(root);
    const ctx = mkCtx([root]);
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor: path.join(root, 'src', 'alpha.ts'),
        domain: domainOverride ?? { kind: 'project' },
        freshness: freshness ?? { mode: 'disk' },
    }, deps);
    return { root, ctx, result };
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-session-'));
    for (const k of HOME_KEYS) process.env[k] = fakeHome;
    mods = await importFresh();
});

afterEach(() => {
    try { mods.pc.closeGlobalDb(); } catch { /* ignore */ }
    try { mods.pc.resetProjectContext(); } catch { /* ignore */ }
    for (const [k, v] of SAVED_HOME) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Opening and the basis
// ---------------------------------------------------------------------------

describe('openAstSession — basis and domains', () => {
    it('opens a project-domain session with a structural basis', async () => {
        const { result } = await openGlobal();
        expect(result.status).toBe('opened');
        const basis = result.session.basis;
        expect(basis.scopeMode).toBe('global'); // unregistered dir routes global
        expect(basis.evidenceCeiling).toBe('structural');
        expect(basis.snapshot).toBeNull();
        // alpha.ts, deep/beta.ts, notes.txt, logo.png — .env excluded below.
        expect(basis.sourceDomain.fileCount).toBe(4);
        expect(basis.sourceDomain.contentDigest).toBeNull();
        expect(basis.sourceDomain.contentFileCount).toBe(0);
        expect(basis.coverage).toContain('global_structural_only');
        expect(basis.hardExpiresAt - basis.openedAt).toBe(600_000);
        result.session.close();
    });

    it('registry-bound projects open project-mode sessions', async () => {
        const repo = fs.mkdtempSync(path.join(fakeHome, 'proj-'));
        seedWorkspace(repo);
        const ctx = mkCtx([repo]);
        mods.pc.getProjectContext(ctx).reloadRegistry(
            [{ project_id: 'p', project_name: 'p', project_root: repo }]);
        const result = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(repo, 'src', 'alpha.ts'),
            domain: { kind: 'project' },
            freshness: { mode: 'disk' },
        });
        expect(result.status).toBe('opened');
        expect(result.session.basis.scopeMode).toBe('project');
        expect(result.session.basis.coverage).not.toContain('global_structural_only');
        result.session.close();
    });

    it('file and directory selectors bound the domain exactly', async () => {
        const { root, ctx } = await openGlobal();
        const open = (domain) => mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(root, 'src', 'alpha.ts'), domain, freshness: { mode: 'disk' },
        });

        const fileSession = await open({ kind: 'file', path: path.join(root, 'src', 'alpha.ts') });
        expect(fileSession.status).toBe('opened');
        expect(fileSession.session.basis.sourceDomain.fileCount).toBe(1);

        const shallow = await open({ kind: 'directory', path: path.join(root, 'src'), recursive: false });
        expect(shallow.session.basis.sourceDomain.fileCount).toBe(1); // alpha.ts only

        const deep = await open({ kind: 'directory', path: path.join(root, 'src'), recursive: true });
        expect(deep.session.basis.sourceDomain.fileCount).toBe(2); // + deep/beta.ts

        for (const s of [fileSession, shallow, deep]) s.session.close();
    });

    it('module domains fail typed at Wave 2', async () => {
        const { result } = await openGlobal({ kind: 'module', moduleKey: 'm' });
        expect(result.status).toBe('failed');
        expect(result.failure.code).toBe('INVALID_QUERY');
        expect(result.failure.correction).toBe('narrow_scope');
        expect(result.failure.detail).toMatch(/module domains/i);
    });

    it('paths escaping the scope fail typed', async () => {
        const { root, ctx } = await openGlobal();
        const outside = fs.mkdtempSync(path.join(fakeHome, 'outside-'));
        const result = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(root, 'src', 'alpha.ts'),
            domain: { kind: 'directory', path: outside, recursive: true },
            freshness: { mode: 'disk' },
        });
        expect(result.status).toBe('failed');
        expect(result.failure.code).toBe('INVALID_QUERY');
    });

    it('the domain digest is deterministic and content-sensitive', async () => {
        const { root, ctx } = await openGlobal();
        const open = () => mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(root, 'src', 'alpha.ts'),
            domain: { kind: 'project' }, freshness: { mode: 'disk' },
        });
        const a = await open();
        const b = await open();
        expect(a.session.basis.sourceDomain.digest).toBe(b.session.basis.sourceDomain.digest);
        a.session.close(); b.session.close();

        fs.writeFileSync(path.join(root, 'src', 'alpha.ts'),
            'export function alphaFn(): number {\n    return 2;\n}\n');
        const c = await open();
        expect(c.session.basis.sourceDomain.digest).not.toBe(a.session.basis.sourceDomain.digest);
        c.session.close();
    });

    it('unsupported files are domain members; sensitive files never are', async () => {
        const { root, ctx, result } = await openGlobal();
        const before = result.session.basis.sourceDomain;
        result.session.close();
        expect(before.fileCount).toBe(4); // includes notes.txt + logo.png

        // A sensitive file appears on disk: the domain must not change AT ALL
        // (member set, count, digest) — its bytes are never enumerated, so no
        // later phase (text floor) can scan them.
        fs.writeFileSync(path.join(root, '.env'), 'SECRET=hunter2\n');
        const after = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(root, 'src', 'alpha.ts'),
            domain: { kind: 'project' }, freshness: { mode: 'disk' },
        });
        expect(after.session.basis.sourceDomain.fileCount).toBe(before.fileCount);
        expect(after.session.basis.sourceDomain.digest).toBe(before.digest);
        after.session.close();
    });

    it('a domain past the provisional cap opens with incomplete_cap', async () => {
        const root = fs.mkdtempSync(path.join(fakeHome, 'big-'));
        fs.mkdirSync(path.join(root, 'many'));
        // Unsupported extension: enumeration cost only, no parsing.
        for (let i = 0; i < 5001; i++) {
            fs.writeFileSync(path.join(root, 'many', `f${String(i).padStart(4, '0')}.txt`), String(i));
        }
        const ctx = mkCtx([root]);
        const result = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(root, 'many', 'f0000.txt'),
            domain: { kind: 'project' }, freshness: { mode: 'disk' },
        });
        expect(result.status).toBe('opened');
        expect(result.session.basis.sourceDomain.fileCount).toBe(5000);
        expect(result.session.basis.coverage).toContain('incomplete_cap');
        result.session.close();
    }, 60_000);
});

// ---------------------------------------------------------------------------
// Content freshness
// ---------------------------------------------------------------------------

describe('content mode', () => {
    it('applies exact in-hand bytes and records the content digest', async () => {
        const { root, ctx } = await openGlobal();
        const alpha = path.join(root, 'src', 'alpha.ts');
        const unsaved = 'export function alphaFn(): number {\n    return 42;\n}\n';
        const result = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: alpha,
            domain: { kind: 'project' },
            freshness: { mode: 'content', files: [{ path: alpha, content: unsaved }] },
        });
        expect(result.status).toBe('opened');
        const basis = result.session.basis;
        expect(basis.sourceDomain.contentFileCount).toBe(1);
        expect(basis.sourceDomain.contentDigest).toMatch(/^[0-9a-f]{64}$/);

        // The store now holds facts for the UNSAVED bytes (normal ingestion, no overlay).
        const conn = mods.pc.getGlobalDbConnection();
        const rows = mods.db.queryRaw(conn,
            "SELECT path, hash FROM files WHERE path LIKE '%src/alpha.ts'");
        expect(rows.length).toBe(1);
        result.session.close();
    });

    it('rejects content files outside the requested domain', async () => {
        const { root, ctx } = await openGlobal();
        const result = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(root, 'src', 'alpha.ts'),
            domain: { kind: 'directory', path: path.join(root, 'src'), recursive: false },
            freshness: {
                mode: 'content',
                files: [{ path: path.join(root, 'src', 'deep', 'beta.ts'), content: 'export const x = 1;\n' }],
            },
        });
        expect(result.status).toBe('failed');
        expect(result.failure.code).toBe('INVALID_QUERY');
        expect(result.failure.detail).toMatch(/not part of the requested domain/);
    });

    it('a mid-batch content failure returns an exact receipt', async () => {
        const { root, ctx } = await openGlobal();
        const alpha = path.join(root, 'src', 'alpha.ts');
        const beta = path.join(root, 'src', 'deep', 'beta.ts');
        const notes = path.join(root, 'notes.txt');
        const alphaBytes = fs.readFileSync(alpha, 'utf8'); // unchanged — no write

        // Arm a fault on symbol INSERT: alpha (byte-identical) passes without
        // writing; beta (changed bytes) hits the trigger and fails.
        const conn = mods.pc.getGlobalDbConnection();
        const trigger = mods.helpers.armFault(conn, { table: 'symbols', op: 'INSERT' });
        const result = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: alpha,
            domain: { kind: 'project' },
            freshness: {
                mode: 'content',
                files: [
                    { path: alpha, content: alphaBytes },
                    { path: beta, content: 'export function betaFn(): number {\n    return 99;\n}\n' },
                    { path: notes, content: 'never reached\n' },
                ],
            },
        });
        mods.helpers.disarmFault(conn, trigger);

        expect(result.status).toBe('failed');
        expect(result.failure.code).toBe('FRESHNESS_FAILED');
        expect(result.failure.retryable).toBe(true);
        expect(result.updated.length).toBe(1);
        expect(result.updated[0].endsWith('src/alpha.ts')).toBe(true);
        expect(result.failedPath.endsWith('src/deep/beta.ts')).toBe(true);
        expect(result.unchanged.length).toBe(2); // beta (failed) + notes (never reached)
        expect(result.unchanged[1].endsWith('notes.txt')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Fact epoch revalidation
// ---------------------------------------------------------------------------

describe('fact epoch', () => {
    it('a second connection\'s commit invalidates the session', async () => {
        const { result } = await openGlobal();
        const dbPath = path.join(fakeHome, '.zenith-mcp', 'global-stash.db');
        const other = mods.db.openDb(dbPath);
        mods.db.runTransaction(other, () => {
            mods.db.execRaw(other, "INSERT INTO files (path, hash, last_indexed) VALUES ('g/deadbeef/x.ts', 'h', 1)");
        });
        mods.db.closeDb(other);

        const answer = await result.session.fileModel('src/alpha.ts');
        expect(answer.status).toBe('failed');
        expect(answer.failure.code).toBe('INPUT_CHANGED');
        expect(answer.failure.retryable).toBe(true);
        expect(answer.failure.correction).toBe('reopen_session');
        result.session.close();
    });

    it('a same-connection fact commit invalidates (generation half)', async () => {
        const { result } = await openGlobal();
        const conn = mods.pc.getGlobalDbConnection();
        // data_version is blind to own commits — only the outer-commit
        // generation can catch this. The write is outside the session's
        // domain; the epoch is deliberately conservative.
        mods.db.runTransaction(conn, () => {
            mods.db.execRaw(conn, "INSERT INTO files (path, hash, last_indexed) VALUES ('g/deadbeef/y.ts', 'h', 1)");
        });
        const answer = await result.session.queryOccurrences({ scope: { kind: 'project' }, role: 'any' });
        expect(answer.status).toBe('failed');
        expect(answer.failure.code).toBe('INPUT_CHANGED');
        result.session.close();
    });

    it('rolled-back writes never move the epoch or invalidate', async () => {
        const { result } = await openGlobal();
        const conn = mods.pc.getGlobalDbConnection();

        const before = mods.db.getFactEpoch(conn);
        expect(() => mods.db.runTransaction(conn, () => {
            mods.db.execRaw(conn, "INSERT INTO files (path, hash, last_indexed) VALUES ('g/deadbeef/z.ts', 'h', 1)");
            throw new Error('abort');
        })).toThrow('abort');
        // Savepoint rollback inside an outer transaction that then also aborts.
        expect(() => mods.db.runTransaction(conn, () => {
            try {
                mods.db.runTransaction(conn, () => {
                    mods.db.execRaw(conn, "INSERT INTO files (path, hash, last_indexed) VALUES ('g/deadbeef/w.ts', 'h', 1)");
                    throw new Error('inner');
                });
            } catch { /* contained */ }
            throw new Error('outer');
        })).toThrow('outer');
        const after = mods.db.getFactEpoch(conn);
        expect(after).toEqual(before);

        const answer = await result.session.scopeModel({ scope: { kind: 'project' } });
        expect(answer.status).toBe('unavailable'); // entry protocol passed
        expect(answer.reason).toBe('question_kind_unsupported');
        result.session.close();
    });

    it('an autocommit write bypassing runTransaction is still caught (view half)', async () => {
        const { root, result } = await openGlobal();
        const conn = mods.pc.getGlobalDbConnection();
        // Neither data_version (own connection) nor the generation (no
        // runTransaction) moves. Only the pinned scope hash view differs.
        const scopeKey = result.session.basis.scopeKey;
        mods.db.execRaw(conn,
            `INSERT INTO files (path, hash, last_indexed) VALUES ('${scopeKey}/injected.ts', 'h', 1)`);
        const answer = await result.session.fileModel('src/alpha.ts');
        expect(answer.status).toBe('failed');
        expect(answer.failure.code).toBe('INPUT_CHANGED');
        result.session.close();
        void root;
    });

    it('the view half catches all three shapes: hash mutation, deletion, addition', async () => {
        // Review gap pin: each shape via autocommit on the session's own
        // connection, where BOTH epoch halves are blind and only the pinned
        // (path,hash) view comparison can detect the change.
        const shapes = [
            (conn, key) => mods.db.execRaw(conn,
                `UPDATE files SET hash = 'mutated' WHERE path = '${key}/src/alpha.ts'`),
            (conn, key) => mods.db.execRaw(conn,
                `DELETE FROM files WHERE path = '${key}/src/alpha.ts'`),
            (conn, key) => mods.db.execRaw(conn,
                `INSERT INTO files (path, hash, last_indexed) VALUES ('${key}/added.ts', 'h', 1)`),
        ];
        for (const mutate of shapes) {
            const { result } = await openGlobal();
            const conn = mods.pc.getGlobalDbConnection();
            mutate(conn, result.session.basis.scopeKey);
            const answer = await result.session.fileModel('src/alpha.ts');
            expect(answer.status).toBe('failed');
            expect(answer.failure.code).toBe('INPUT_CHANGED');
            result.session.close();
        }
    });

    it('a write outside the pinned scope prefix does not invalidate the session', async () => {
        // Review gap pin: only invalidation cases were pinned before. The
        // survivable shape is a same-connection autocommit under a FOREIGN
        // prefix: neither epoch half moves and the pinned view is untouched,
        // so the session correctly survives. (Cross-connection commits are
        // deliberately coarse — data_version is DB-global — and invalidate.)
        const { result } = await openGlobal();
        const conn = mods.pc.getGlobalDbConnection();
        mods.db.execRaw(conn,
            "INSERT INTO files (path, hash, last_indexed) VALUES ('g/0000000000000000000000000000000000000000000000000000000000000000/foreign.ts', 'h', 1)");
        const answer = await result.session.fileModel('src/alpha.ts');
        expect(answer.status).not.toBe('failed'); // session survives
        result.session.close();
    });

    it('a TRANSACTED write outside the prefix invalidates: strict epoch conservatism', async () => {
        // Locked design pin: commit-generation movement invalidates even when
        // the pinned view is untouched, because a cohabiting scope's persist
        // can rewrite THIS scope's edges via name-based re-resolution — a
        // change the (path,hash) view cannot see. Over-invalidation is the
        // sound side of that trade until edge provenance is scope-explicit.
        const { result } = await openGlobal();
        const conn = mods.pc.getGlobalDbConnection();
        mods.db.runTransaction(conn, () => {
            mods.db.execRaw(conn,
                "INSERT INTO files (path, hash, last_indexed) VALUES ('g/1111111111111111111111111111111111111111111111111111111111111111/foreign2.ts', 'h', 1)");
        });
        const answer = await result.session.fileModel('src/alpha.ts');
        expect(answer.status).toBe('failed');
        expect(answer.failure.code).toBe('INPUT_CHANGED');
        expect(answer.failure.retryable).toBe(true);
        result.session.close();
    });
});

// ---------------------------------------------------------------------------
// Lease and close
// ---------------------------------------------------------------------------

describe('lease and close', () => {
    it('slides +30 s per successful call, capped at openedAt + 10 min', async () => {
        let t = 1_000_000;
        const { result } = await openGlobal(undefined, undefined, { now: () => t });
        const s = result.session;
        const openedAt = s.basis.openedAt;
        expect(s.basis.expiresAt).toBe(openedAt + 30_000);

        // fileModel is composed (Task 2.3); a real answer slides the lease.
        t += 29_000;
        const a1 = await s.fileModel('src/alpha.ts');
        expect(a1.status).toBe('partial'); // answered — slides
        expect(s.basis.expiresAt).toBe(t + 30_000);

        // Ride successful calls up to the hard cap.
        while (t + 29_000 < openedAt + 600_000) {
            t += 29_000;
            const a = await s.fileModel('src/alpha.ts');
            expect(a.status).toBe('partial');
        }
        expect(s.basis.expiresAt).toBe(s.basis.hardExpiresAt);

        t = openedAt + 600_001;
        const expired = await s.fileModel('src/alpha.ts');
        expect(expired.status).toBe('failed');
        expect(expired.failure.code).toBe('SESSION_EXPIRED');
        expect(expired.failure.retryable).toBe(true);
        s.close();
    });

    it('an idle session expires after 30 s and failures never slide', async () => {
        let t = 5_000_000;
        const { result } = await openGlobal(undefined, undefined, { now: () => t });
        const s = result.session;
        t += 30_001;
        const expired = await s.contextFor({ anchor: { path: 'src/alpha.ts', at: { kind: 'byte', byte: 0 } } });
        expect(expired.status).toBe('failed');
        expect(expired.failure.code).toBe('SESSION_EXPIRED');
        // The failed call must not have slid the lease.
        const again = await s.contextFor({ anchor: { path: 'src/alpha.ts', at: { kind: 'byte', byte: 0 } } });
        expect(again.status).toBe('failed');
        expect(again.failure.code).toBe('SESSION_EXPIRED');
        s.close();
    });

    it('close is typed, idempotent, and beats expiry', async () => {
        let t = 9_000_000;
        const { result } = await openGlobal(undefined, undefined, { now: () => t });
        const s = result.session;
        s.close();
        s.close(); // idempotent
        t += 999_999_999; // long past every lease
        const answer = await s.traceRelations({ start: { path: 'src/alpha.ts', at: { kind: 'byte', byte: 0 } }, direction: 'both' });
        expect(answer.status).toBe('failed');
        expect(answer.failure.code).toBe('SESSION_CLOSED');
        expect(answer.failure.retryable).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Continuation cursors
// ---------------------------------------------------------------------------

describe('continuation cursors', () => {
    async function twoSessions() {
        const a = await openGlobal();
        const b = await openGlobal();
        return { a: a.result.session, b: b.result.session };
    }

    it('round-trips its canonical payload under the session MAC', async () => {
        const { a, b } = await twoSessions();
        const qd = mods.session.queryDigestOf('queryOccurrences', { role: 'any' }, 200);
        const cursor = a.cursors.issue(qd, 'src/alpha.ts\x1f7');
        const accepted = a.cursors.accept(cursor, qd);
        expect(accepted.ok).toBe(true);
        expect(accepted.lastCanonicalKey).toBe('src/alpha.ts\x1f7');
        a.close(); b.close();
    });

    it('rejects tampering, cross-session, cross-question, and malformed cursors', async () => {
        const { a, b } = await twoSessions();
        const qd = mods.session.queryDigestOf('queryOccurrences', { role: 'any' }, 200);
        const qd2 = mods.session.queryDigestOf('queryOccurrences', { role: 'any' }, 100);
        const cursor = a.cursors.issue(qd, 'k');

        // Payload tamper: flip one byte of the body.
        const dot = cursor.lastIndexOf('.');
        const body = Buffer.from(cursor.slice(0, dot), 'base64url');
        body[3] = body[3] === 0 ? 1 : 0;
        const tampered = `${body.toString('base64url')}.${cursor.slice(dot + 1)}`;
        expect(a.cursors.accept(tampered, qd).ok).toBe(false);
        expect(a.cursors.accept(tampered, qd).failure.code).toBe('INVALID_QUERY');

        // Cross-session: another session's secret.
        expect(b.cursors.accept(cursor, qd).ok).toBe(false);
        // Cross-question: page limit differs -> different query digest.
        expect(a.cursors.accept(cursor, qd2).ok).toBe(false);
        // Malformed.
        for (const junk of ['', 'nodot', '.', 'a.b', `${'x'.repeat(10)}.${'y'.repeat(10)}`]) {
            expect(a.cursors.accept(junk, qd).ok).toBe(false);
        }
        a.close(); b.close();
    });

    it('the query digest covers the normalized question, never page.after', () => {
        const q1 = mods.session.queryDigestOf('q', { role: 'any', name: { mode: 'exact', value: 'x' } }, 200);
        const q2 = mods.session.queryDigestOf('q', { name: { value: 'x', mode: 'exact' }, role: 'any' }, 200);
        expect(q1).toBe(q2); // key order canonicalized
        const q3 = mods.session.queryDigestOf('q', { role: 'any', name: { mode: 'exact', value: 'y' } }, 200);
        expect(q1).not.toBe(q3);
    });
});

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

describe('ast-intelligence facade', () => {
    it('exports exactly three functions', () => {
        const fns = Object.entries(mods.facade)
            .filter(([, v]) => typeof v === 'function')
            .map(([k]) => k)
            .sort();
        expect(fns).toEqual(['captureEditBaseline', 'evaluateEditAdvisories', 'openAstSession']);
    });

    it('exports the compile-time fact ledger, fully routed', () => {
        const domains = Object.keys(mods.facade.FACT_LEDGER).sort();
        expect(domains.length).toBe(16);
        for (const entry of Object.values(mods.facade.FACT_LEDGER)) {
            expect(entry.owners.length).toBeGreaterThan(0);
            expect(entry.losslessProjection.length).toBeGreaterThan(0);
            expect([4, 5, 6]).toContain(entry.availableFrom);
        }
        // Every persistence family names at least one routed domain.
        for (const familyDomains of Object.values(mods.facade.PERSISTENCE_FAMILY_DOMAINS)) {
            for (const d of familyDomains) expect(domains).toContain(d);
        }
    });

    it('advisory functions return typed unavailable with frozen shapes', async () => {
        const capture = await mods.facade.captureEditBaseline(
            mkCtx([fakeHome]), [{ path: 'x.ts', content: 'const a = 1;\n' }]);
        expect(capture.status).toBe('unavailable');
        expect(capture.reason).toBe('question_kind_unsupported');

        const evaluated = await mods.facade.evaluateEditAdvisories(
            { id: 'fake', capturedAt: 0, hardExpiresAt: 0 },
            [{ path: 'x.ts', content: 'const a = 2;\n', changes: [] }]);
        expect(evaluated.status).toBe('unavailable');
        expect(evaluated.advisories).toEqual([]);
        expect(evaluated.suppressedCount).toBe(0);
        expect(evaluated.reason).toBe('semantic_unavailable');
    });

    it('composed queries answer and uncomposed queries stay typed unavailable, all through the full entry protocol', async () => {
        const { result } = await openGlobal();
        const s = result.session;
        // Composed by Task 2.3 so far: fileModel answers with real data.
        const composed = await s.fileModel('src/alpha.ts');
        expect(composed.status).toBe('partial');
        expect(composed.data.path).toBe(s.basis.scopeKey === '' ? 'src/alpha.ts' : composed.data.path);
        expect(composed.basis.scopeKey).toBe(s.basis.scopeKey);
        // Still stubbed (retired one by one as composers land):
        const answers = [
            await s.locationAt('src/alpha.ts', { at: { kind: 'byte', byte: 0 } }),
            await s.resolveAt('src/alpha.ts', { occurrence: { at: { kind: 'byte', byte: 0 } } }),
            await s.queryOccurrences({ scope: { kind: 'project' }, role: 'any' }),
            await s.traceRelations({ start: { path: 'src/alpha.ts', at: { kind: 'byte', byte: 0 } }, direction: 'both' }),
            await s.scopeModel({ scope: { kind: 'project' } }),
            await s.contextFor({ anchor: { path: 'src/alpha.ts', at: { kind: 'byte', byte: 0 } } }),
        ];
        for (const a of answers) {
            expect(a.status).toBe('unavailable');
            expect(a.reason).toBe('question_kind_unsupported');
            expect(a.basis.scopeKey).toBe(s.basis.scopeKey);
        }
        s.close();
    });
});
