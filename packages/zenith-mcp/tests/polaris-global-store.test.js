// polaris-global-store.test.js — POLARIS Task 1.4
//
// The ingestion-wide address codec and global store initialization:
//
//   - Two allowed roots' identical relative paths coexist in the global store
//     under distinct `g/<sha256(root)>/` prefixes; scoped reads never cross.
//   - Stash rows survive symbol-schema initialization on the shared DB.
//   - Project-mode keys remain repo-relative (byte-identical to the legacy
//     `path.relative` keys) — project-mode visible paths do not change.
//   - A DETECTED-but-unpromoted root routes to the GLOBAL store and the
//     intelligence path materializes no project `.mcp` (anti-litter).
//   - Legacy unprefixed global rows take exactly one of three explicit paths:
//     none / provable-single-root transactional rewrite / preserved-but-
//     quarantined — including atomic refusal on target collision (file-backed
//     rollback).
//   - Exactly one production code path opens the global database.
//
// Every test stubs $HOME to an isolated directory BEFORE dynamically
// importing the dist modules (vi.resetModules), because ZENITH_HOME /
// GLOBAL_DB_PATH / CONFIG_PATH are module-load constants.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(TESTS_DIR, '..', 'src');

// Detection fixtures must live under the REAL home (tmp is junk to the
// boundary walk); everything else lives under the fake home in tmp.
const REAL_HOME_BASE = fs.mkdtempSync(path.join(os.homedir(), '.polaris-global-'));

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const SAVED_HOME = HOME_KEYS.map((k) => [k, process.env[k]]);

let fakeHome;
let mods; // { pc: project-context module, si: symbol-index, db: db-adapter }

function globalDbPath() {
    return path.join(fakeHome, '.zenith-mcp', 'global-stash.db');
}

async function importFresh() {
    vi.resetModules();
    const pc = await import('../dist/core/project-context.js');
    const si = await import('../dist/core/symbol-index.js');
    const db = await import('../dist/core/db-adapter.js');
    return { pc, si, db };
}

function mkCtx(allowedDirs) {
    return {
        getAllowedDirectories: () => allowedDirs,
        validatePath: async (p) => p,
    };
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-fakehome-'));
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

afterAll(() => {
    try { fs.rmSync(REAL_HOME_BASE, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Two-root isolation through the real ingestion path
// ---------------------------------------------------------------------------

describe('global two-root isolation', () => {
    it("two roots' src/same.ts coexist; each scoped read sees only its row", async () => {
        const rootA = fs.mkdtempSync(path.join(fakeHome, 'root-a-'));
        const rootB = fs.mkdtempSync(path.join(fakeHome, 'root-b-'));
        for (const [root, fn] of [[rootA, 'fromA'], [rootB, 'fromB']]) {
            fs.mkdirSync(path.join(root, 'src'), { recursive: true });
            fs.writeFileSync(path.join(root, 'src', 'same.ts'),
                `export function ${fn}(): number {\n    return 1;\n}\n`);
        }

        const ctx = mkCtx([rootA, rootB]);
        const pc = mods.pc.getProjectContext(ctx);

        const storeA = pc.getIntelligenceStore(path.join(rootA, 'src', 'same.ts'));
        const storeB = pc.getIntelligenceStore(path.join(rootB, 'src', 'same.ts'));
        expect(storeA.address.mode).toBe('global');
        expect(storeB.address.mode).toBe('global');
        expect(storeA.address.scopeKey).not.toBe(storeB.address.scopeKey);

        // The scope key is the documented content: g/<sha256(canonical root)>.
        const expectA = 'g/' + crypto.createHash('sha256').update(path.resolve(rootA)).digest('hex');
        expect(storeA.address.scopeKey).toBe(expectA);

        expect(await mods.si.indexFileAt(storeA.address, path.join(rootA, 'src', 'same.ts'))).toBe('indexed');
        expect(await mods.si.indexFileAt(storeB.address, path.join(rootB, 'src', 'same.ts'))).toBe('indexed');

        const conn = mods.pc.getGlobalDbConnection();
        const rows = mods.db.queryRaw(conn, 'SELECT path FROM files ORDER BY path');
        expect(rows.length).toBe(2);
        expect(rows.every((r) => r.path.startsWith('g/'))).toBe(true);

        const scopedA = mods.db.queryRaw(conn,
            'SELECT s.name FROM symbols s WHERE s.file_path LIKE ? AND s.kind = \'def\'',
            `${storeA.address.scopeKey}/%`);
        expect(scopedA.map((r) => r.name)).toEqual(['fromA']);
        const scopedB = mods.db.queryRaw(conn,
            'SELECT s.name FROM symbols s WHERE s.file_path LIKE ? AND s.kind = \'def\'',
            `${storeB.address.scopeKey}/%`);
        expect(scopedB.map((r) => r.name)).toEqual(['fromB']);

        // Codec round-trip: store key back to scope-relative path.
        expect(storeA.address.fromStoreKey(`${storeA.address.scopeKey}/src/same.ts`)).toBe('src/same.ts');
        // Cross-scope keys do not decode.
        expect(storeA.address.fromStoreKey(`${storeB.address.scopeKey}/src/same.ts`)).toBeNull();
        // The codec refuses paths outside its root.
        expect(storeA.address.toStoreKey(path.join(rootB, 'src', 'same.ts'))).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Cohabitation: stash rows survive symbol initialization on the global DB
// ---------------------------------------------------------------------------

describe('global schema cohabitation', () => {
    it('stash rows written before symbol initialization survive it', async () => {
        const anyDir = fs.mkdtempSync(path.join(fakeHome, 'plain-'));
        const ctx = mkCtx([anyDir]);
        const pc = mods.pc.getProjectContext(ctx);

        // Stash first (global route — unregistered dir), then intelligence.
        const stash = pc.getStashDb(path.join(anyDir, 'note.txt'));
        expect(stash.isGlobal).toBe(true);
        const stashId = mods.db.insertStash(stash.db, { type: 'edit', filePath: 'x', payload: '{"k":1}', createdAt: 42 });

        const store = pc.getIntelligenceStore(path.join(anyDir, 'note.txt'));
        expect(store.address.mode).toBe('global');
        expect(store.legacyGlobalRows).toBe('none');

        const row = mods.db.getStash(mods.pc.getGlobalDbConnection(), stashId);
        expect(row).not.toBeNull();
        expect(row.payload).toBe('{"k":1}');
    });
});

// ---------------------------------------------------------------------------
// Project mode: keys unchanged, registry tier may materialize
// ---------------------------------------------------------------------------

describe('project-mode addressing', () => {
    it('registry-bound anchors get repo-relative keys, byte-identical to legacy', async () => {
        const repo = fs.mkdtempSync(path.join(fakeHome, 'proj-'));
        fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'src', 'mod.ts'), 'export function projFn(): number {\n    return 1;\n}\n');

        const ctx = mkCtx([repo]);
        const pc = mods.pc.getProjectContext(ctx);
        pc.reloadRegistry([{ project_id: 'p', project_name: 'p', project_root: repo }]);

        const store = pc.getIntelligenceStore(path.join(repo, 'src', 'mod.ts'));
        expect(store.address.mode).toBe('project');
        expect(store.legacyGlobalRows).toBe('none');
        expect(store.issue).toBeNull();

        expect(await mods.si.indexFileAt(store.address, path.join(repo, 'src', 'mod.ts'))).toBe('indexed');
        const rows = mods.db.queryRaw(store.address.db, 'SELECT path FROM files');
        expect(rows.map((r) => r.path)).toEqual(['src/mod.ts']); // repo-relative, no prefix
        // Registry tier is consented — the project DB exists in the repo.
        expect(fs.existsSync(path.join(fs.realpathSync(repo), '.mcp', 'symbols.db'))).toBe(true);
    });

    it('a DETECTED-but-unpromoted root routes global and materializes no .mcp', async () => {
        // Detection needs a non-junk location: a git repo under the REAL home.
        const repo = fs.mkdtempSync(path.join(REAL_HOME_BASE, 'detected-'));
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'file.ts'), 'export const detectedX = 1;\n');

        const ctx = mkCtx([repo]);
        const pc = mods.pc.getProjectContext(ctx);
        pc.getRoot(path.join(repo, 'file.ts'));
        expect(pc.bindingTier).toBe('detected'); // precondition

        const store = pc.getIntelligenceStore(path.join(repo, 'file.ts'));
        expect(store.address.mode, 'detected roots must not open a project store').toBe('global');
        // Scoped to the longest containing allowed root — the repo itself.
        expect(store.address.scopeRoot).toBe(path.resolve(repo));

        expect(await mods.si.indexFileAt(store.address, path.join(repo, 'file.ts'))).toBe('indexed');
        expect(fs.existsSync(path.join(repo, '.mcp')), 'anti-litter: no .mcp for detected roots').toBe(false);
        // The facts landed in the GLOBAL db under the g/ prefix.
        const rows = mods.db.queryRaw(mods.pc.getGlobalDbConnection(), 'SELECT path FROM files');
        expect(rows.length).toBe(1);
        expect(rows[0].path.startsWith('g/')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Legacy unprefixed rows: none / migrated / quarantined (three-way branch)
// ---------------------------------------------------------------------------

/** Seed the (closed) global DB file with legacy unprefixed rows. */
function seedLegacyGlobalDb(db, opts) {
    fs.mkdirSync(path.dirname(globalDbPath()), { recursive: true });
    const conn = db.openDb(globalDbPath());
    db.initSymbolSchema(conn);
    db.execRaw(conn, `
        INSERT INTO files (path, hash, last_indexed) VALUES ('src/legacy.ts', 'h-legacy', 1);
        INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
            VALUES ('legacyFn', 'def', 'function', 'src/legacy.ts', 1, 3, 0);
        INSERT INTO imports (file_path, module, imported_names_json, line, start_line, end_line)
            VALUES ('src/legacy.ts', './dep', '["depFn"]', 1, 1, 1);
    `);
    for (const root of opts.projectRoots) {
        db.upsertProjectRoot(conn, { rootPath: root, name: path.basename(root), createdAt: 1 });
    }
    if (opts.collisionKey) {
        db.execRaw(conn, `INSERT INTO files (path, hash, last_indexed) VALUES ('${opts.collisionKey}', 'h-existing', 2)`);
    }
    db.closeDb(conn);
}

describe('legacy global rows', () => {
    it('exactly one provable allowed root: rows are transactionally rewritten', async () => {
        const root = fs.mkdtempSync(path.join(fakeHome, 'legacy-root-'));
        seedLegacyGlobalDb(mods.db, { projectRoots: [fs.realpathSync(root)] });
        mods = await importFresh(); // fresh module state after seeding

        const ctx = mkCtx([root]);
        const pc = mods.pc.getProjectContext(ctx);
        const store = pc.getIntelligenceStore(path.join(root, 'anything.ts'));
        expect(store.legacyGlobalRows).toBe('migrated');
        expect(store.issue).toBeNull();

        const conn = mods.pc.getGlobalDbConnection();
        const keys = mods.db.queryRaw(conn, 'SELECT path FROM files ORDER BY path').map((r) => r.path);
        expect(keys.length).toBe(1);
        const expectedKey = 'g/' + crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex') + '/src/legacy.ts';
        expect(keys[0]).toBe(expectedKey);
        // Children moved with the parent.
        expect(mods.db.queryRaw(conn, 'SELECT file_path FROM symbols')[0].file_path).toBe(expectedKey);
        expect(mods.db.queryRaw(conn, 'SELECT file_path FROM imports')[0].file_path).toBe(expectedKey);
    });

    it('ambiguous roots: rows are preserved, quarantined, and reported', async () => {
        const rootX = fs.mkdtempSync(path.join(fakeHome, 'legacy-x-'));
        const rootY = fs.mkdtempSync(path.join(fakeHome, 'legacy-y-'));
        seedLegacyGlobalDb(mods.db, { projectRoots: [fs.realpathSync(rootX), fs.realpathSync(rootY)] });
        mods = await importFresh();

        const ctx = mkCtx([rootX, rootY]);
        const pc = mods.pc.getProjectContext(ctx);
        const store = pc.getIntelligenceStore(path.join(rootX, 'anything.ts'));
        expect(store.legacyGlobalRows).toBe('quarantined');
        expect(store.issue).toBe('legacy_global_scope_ambiguous');

        // Untouched: the unprefixed key is physically present and unmodified.
        const conn = mods.pc.getGlobalDbConnection();
        const keys = mods.db.queryRaw(conn, 'SELECT path FROM files ORDER BY path').map((r) => r.path);
        expect(keys).toEqual(['src/legacy.ts']);
        // And invisible to scoped (g/-prefixed) reads.
        const scoped = mods.db.queryRaw(conn, "SELECT path FROM files WHERE path LIKE 'g/%'");
        expect(scoped).toEqual([]);
    });

    it('a target collision aborts the rewrite atomically (file-backed rollback)', async () => {
        const root = fs.mkdtempSync(path.join(fakeHome, 'legacy-col-'));
        const canonical = fs.realpathSync(root);
        const collisionKey = 'g/' + crypto.createHash('sha256').update(canonical).digest('hex') + '/src/legacy.ts';
        seedLegacyGlobalDb(mods.db, { projectRoots: [canonical], collisionKey });
        mods = await importFresh();

        const ctx = mkCtx([root]);
        const pc = mods.pc.getProjectContext(ctx);
        const store = pc.getIntelligenceStore(path.join(root, 'anything.ts'));
        expect(store.legacyGlobalRows).toBe('quarantined');
        expect(store.issue).toBe('legacy_global_scope_ambiguous');

        const conn = mods.pc.getGlobalDbConnection();
        const keys = mods.db.queryRaw(conn, 'SELECT path FROM files ORDER BY path').map((r) => r.path);
        // Both the legacy row and the pre-existing target survive, unmerged.
        expect(keys).toEqual([collisionKey, 'src/legacy.ts'].sort());
        // The legacy child rows still point at the unprefixed key — no torn rewrite.
        expect(mods.db.queryRaw(conn, 'SELECT file_path FROM symbols')[0].file_path).toBe('src/legacy.ts');
    });

    it('a fresh global store reports none', async () => {
        const anyDir = fs.mkdtempSync(path.join(fakeHome, 'fresh-'));
        const pc = mods.pc.getProjectContext(mkCtx([anyDir]));
        const store = pc.getIntelligenceStore(path.join(anyDir, 'f.ts'));
        expect(store.legacyGlobalRows).toBe('none');
        expect(store.issue).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Exactly one production opener for the global database
// ---------------------------------------------------------------------------

describe('single global-DB opener', () => {
    it('only core/project-context.ts names the global database file', () => {
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const p = path.join(dir, e.name);
            return e.isDirectory() ? walk(p) : (p.endsWith('.ts') ? [p] : []);
        });
        const offenders = walk(SRC_DIR)
            .filter((f) => fs.readFileSync(f, 'utf8').includes('global-stash.db'))
            .map((f) => path.relative(SRC_DIR, f).split(path.sep).join('/'));
        expect(offenders).toEqual(['core/project-context.ts']);
    });
});
