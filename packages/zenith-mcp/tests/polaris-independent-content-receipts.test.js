// polaris-independent-content-receipts.test.js
//
// Independent-oracle audit of the POLARIS Task 2.1 content-freshness phase
// (plan Decision 14: canonical store-key order; a partial commit names
// updated[]/unchanged[]/failed exactly). These tests avoid deriving expected
// values from session helpers:
//
//   - hand-authored source fixtures are the oracle for persisted declarations;
//   - raw SQL is the independent read path for committed/aborted facts;
//   - a TEMP TRIGGER that aborts one file's INSERT is the fault injector;
//   - request-order permutation is the metamorphic oracle for canonical order.
//
// Each test carries an explicit positive/negative control so a plausible
// mutation (ignore the reindex return, process in request order, leave the
// failed/unattempted file in unchanged, skip dedup) cannot leave it green.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const SAVED_HOME = HOME_KEYS.map((key) => [key, process.env[key]]);

let fakeHome;
let mods;
const liveSessions = [];

async function importFresh() {
    vi.resetModules();
    return {
        session: await import('../dist/core/intelligence/session.js'),
        pc: await import('../dist/core/project-context.js'),
        db: await import('../dist/core/db-adapter.js'),
        si: await import('../dist/core/symbol-index.js'),
    };
}

function mkCtx(root) {
    return {
        getAllowedDirectories: () => [root],
        validatePath: async (candidate) => candidate,
    };
}

function registerProject(ctx, root) {
    mods.pc.getProjectContext(ctx).reloadRegistry([{
        project_id: `independent-${path.basename(root)}`,
        project_name: path.basename(root),
        project_root: root,
    }]);
}

function makeProject(files) {
    const root = fs.mkdtempSync(path.join(fakeHome, 'project-'));
    for (const [relative, content] of Object.entries(files)) {
        const absolute = path.join(root, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
    }
    return root;
}

async function openContent(ctx, root, anchor, files) {
    registerProject(ctx, root);
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor,
        domain: { kind: 'project' },
        freshness: { mode: 'content', files },
    });
    if (result.status === 'opened') liveSessions.push(result.session);
    return result;
}

async function warmDisk(ctx, root, anchor) {
    registerProject(ctx, root);
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor,
        domain: { kind: 'project' },
        freshness: { mode: 'disk' },
    });
    expect(result.status).toBe('opened');
    if (result.status === 'opened') result.session.close();
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-content-receipts-'));
    for (const key of HOME_KEYS) process.env[key] = fakeHome;
    mods = await importFresh();
});

afterEach(() => {
    for (const session of liveSessions.splice(0)) {
        try { session.close(); } catch { /* already closed */ }
    }
    try { mods.pc.closeGlobalDb(); } catch { /* not opened */ }
    try { mods.pc.resetProjectContext(); } catch { /* not initialized */ }
    for (const [key, value] of SAVED_HOME) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('independent content-freshness receipt and ordering oracles', () => {
    it('processes content in canonical store-key order regardless of request order', async () => {
        const oldA = 'export function alphaOld(): number { return 1; }\n';
        const oldM = 'export function midOld(): number { return 2; }\n';
        const oldZ = 'export function zetaOld(): number { return 3; }\n';
        const newA = 'export function alphaNew(): number { return 10; }\n';
        const newM = 'export function midNew(): number { return 20; }\n';
        const newZ = 'export function zetaNew(): number { return 30; }\n';
        const root = makeProject({ 'a.ts': oldA, 'm.ts': oldM, 'z.ts': oldZ });
        const ctx = mkCtx(root);
        await warmDisk(ctx, root, path.join(root, 'a.ts'));

        // Abort the middle file (canonical order a < m < z) at INSERT time.
        const conn = mods.si.getDb(root);
        mods.db.execRaw(conn, `
            CREATE TEMP TRIGGER polaris_receipts_fail_mid
            BEFORE INSERT ON symbols
            WHEN NEW.file_path = 'm.ts'
            BEGIN
                SELECT RAISE(ABORT, 'POLARIS_RECEIPTS_FAIL_MID');
            END
        `);

        let result;
        try {
            // Request order is REVERSED (z, m, a); a correct engine still
            // processes a -> m -> z, so a commits and z is never attempted.
            result = await openContent(ctx, root, path.join(root, 'a.ts'), [
                { path: path.join(root, 'z.ts'), content: newZ },
                { path: path.join(root, 'm.ts'), content: newM },
                { path: path.join(root, 'a.ts'), content: newA },
            ]);
        } finally {
            mods.db.execRaw(conn, 'DROP TRIGGER IF EXISTS polaris_receipts_fail_mid');
        }

        expect(result.status).toBe('failed');
        if (result.status !== 'failed') return;
        // Receipt: only the canonically-earlier file committed; the failed file
        // is named solely in failedPath; the unattempted tail is omitted.
        expect(result.updated).toEqual(['a.ts']);
        expect(result.unchanged).toEqual([]);
        expect(result.failedPath).toBe('m.ts');

        // Independent raw-SQL oracle. Positive control: 'a.ts' committed its new
        // program. Negative controls: 'm.ts' rolled back to disk facts, and
        // 'z.ts' — which a request-ordered engine would have committed FIRST —
        // was never touched.
        const defs = (filePath) => mods.db.queryRaw(conn,
            "SELECT name FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY name",
            filePath).map((row) => row.name);
        expect(defs('a.ts')).toContain('alphaNew');
        expect(defs('a.ts')).not.toContain('alphaOld');
        expect(defs('m.ts')).toContain('midOld');
        expect(defs('m.ts')).not.toContain('midNew');
        expect(defs('z.ts')).toContain('zetaOld');
        expect(defs('z.ts')).not.toContain('zetaNew');
    });

    it('separates already-fresh files (unchanged) from reindexed files (updated) in the receipt', async () => {
        const diskP = 'export function peerFresh(): number { return 1; }\n';
        const diskQ = 'export function queryOld(): number { return 2; }\n';
        const diskR = 'export function radioOld(): number { return 3; }\n';
        const newQ = 'export function queryNew(): number { return 20; }\n';
        const newR = 'export function radioNew(): number { return 30; }\n';
        const root = makeProject({ 'p.ts': diskP, 'q.ts': diskQ, 'r.ts': diskR });
        const ctx = mkCtx(root);
        await warmDisk(ctx, root, path.join(root, 'p.ts'));

        // Abort the canonically-last file so the receipt is exposed on failure.
        const conn = mods.si.getDb(root);
        mods.db.execRaw(conn, `
            CREATE TEMP TRIGGER polaris_receipts_fail_radio
            BEFORE INSERT ON symbols
            WHEN NEW.file_path = 'r.ts'
            BEGIN
                SELECT RAISE(ABORT, 'POLARIS_RECEIPTS_FAIL_RADIO');
            END
        `);

        let result;
        try {
            // p.ts is handed its EXACT disk bytes (already fresh -> unchanged);
            // q.ts is handed new bytes (reindexed -> updated); r.ts aborts.
            result = await openContent(ctx, root, path.join(root, 'p.ts'), [
                { path: path.join(root, 'p.ts'), content: diskP },
                { path: path.join(root, 'q.ts'), content: newQ },
                { path: path.join(root, 'r.ts'), content: newR },
            ]);
        } finally {
            mods.db.execRaw(conn, 'DROP TRIGGER IF EXISTS polaris_receipts_fail_radio');
        }

        expect(result.status).toBe('failed');
        if (result.status !== 'failed') return;
        // The reindex return value drives the split: an engine that pushes every
        // attempted file to updated would report ['p.ts','q.ts'] here.
        expect(result.updated).toEqual(['q.ts']);
        expect(result.unchanged).toEqual(['p.ts']);
        expect(result.failedPath).toBe('r.ts');

        // Independent oracle: the already-fresh file kept its single disk-authored
        // declaration, and the reindexed file adopted its new one.
        const defs = (filePath) => mods.db.queryRaw(conn,
            "SELECT name FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY name",
            filePath).map((row) => row.name);
        expect(defs('p.ts')).toEqual(['peerFresh']);
        expect(defs('q.ts')).toContain('queryNew');
        expect(defs('q.ts')).not.toContain('queryOld');
    });

    it('rejects a store-key-duplicated content file (canonical, not literal) as INVALID_QUERY', async () => {
        const disk = 'export function dupTarget(): number { return 1; }\n';
        const one = 'export function dupTargetOne(): number { return 10; }\n';
        const two = 'export function dupTargetTwo(): number { return 20; }\n';
        const root = makeProject({ 'dup.ts': disk });
        const ctx = mkCtx(root);
        const target = path.join(root, 'dup.ts');

        // Negative control: an absolute spelling and a relative spelling of the
        // SAME file collapse to one canonical store key, so the second entry is
        // an ambiguous request even though the two path strings differ. The
        // detail assertion proves the rejection is dedupe, not domain membership.
        const duplicated = await openContent(ctx, root, target, [
            { path: target, content: one },
            { path: 'dup.ts', content: two },
        ]);
        expect(duplicated.status).toBe('failed');
        if (duplicated.status === 'failed') {
            expect(duplicated.failure.code).toBe('INVALID_QUERY');
            expect(duplicated.failure.detail).toMatch(/duplicate content file/);
        }

        // Positive control: a single entry for the same file opens cleanly.
        const single = await openContent(ctx, root, target, [
            { path: target, content: one },
        ]);
        expect(single.status).toBe('opened');
    });
});

describe('canonical order is UTF-8 byte order, not UTF-16 (A9 × A11 merge seam, ledger N8)', () => {
    it('processes content keys in SQLite BINARY order when UTF-16 ordering disagrees', async () => {
        // 'a\uFF61.ts' encodes EF BD A1 (UTF-8) but sorts AFTER the astral
        // 'a\u{10000}.ts' under UTF-16 (FF61 > D800 lead surrogate), while
        // UTF-8 bytes order it FIRST (EF < F0). A UTF-16-ordered engine
        // attempts the astral file first and fails with updated=[]; the
        // byte-ordered engine commits the BMP file before failing.
        const bmpName = 'a\uFF61.ts';
        const astralName = 'a\u{10000}.ts';
        const root = makeProject({
            [bmpName]: 'export function bmpOld(): number { return 1; }\n',
            [astralName]: 'export function astralOld(): number { return 2; }\n',
        });
        const ctx = mkCtx(root);
        await warmDisk(ctx, root, path.join(root, bmpName));

        const conn = mods.si.getDb(root);
        mods.db.execRaw(conn, `
            CREATE TEMP TRIGGER polaris_receipts_fail_astral
            BEFORE INSERT ON symbols
            WHEN NEW.file_path = '${astralName}'
            BEGIN
                SELECT RAISE(ABORT, 'POLARIS_RECEIPTS_FAIL_ASTRAL');
            END
        `);

        let result;
        try {
            // Request order deliberately UTF-16-ascending (astral first) so a
            // request-ordered engine ALSO fails the discriminator.
            result = await openContent(ctx, root, path.join(root, bmpName), [
                { path: path.join(root, astralName), content: 'export function astralNew(): number { return 20; }\n' },
                { path: path.join(root, bmpName), content: 'export function bmpNew(): number { return 10; }\n' },
            ]);
        } finally {
            mods.db.execRaw(conn, 'DROP TRIGGER IF EXISTS polaris_receipts_fail_astral');
        }

        expect(result.status).toBe('failed');
        if (result.status !== 'failed') return;
        // Discriminator: byte order commits the BMP file first.
        expect(result.updated).toEqual([bmpName]);
        expect(result.unchanged).toEqual([]);
        expect(result.failedPath).toBe(astralName);

        // Independent raw-SQL controls: BMP file committed its new program,
        // astral file rolled back to disk facts.
        const defs = (filePath) => mods.db.queryRaw(conn,
            "SELECT name FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY name",
            filePath).map((row) => row.name);
        expect(defs(bmpName)).toContain('bmpNew');
        expect(defs(astralName)).toContain('astralOld');
        expect(defs(astralName)).not.toContain('astralNew');
    });
});
