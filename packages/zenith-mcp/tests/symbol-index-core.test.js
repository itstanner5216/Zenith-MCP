import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { openMemoryDb, closeDb, execRaw, queryRaw, initSymbolSchema } from '../dist/core/db-adapter.js';

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symidx-test-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    return dir;
}

async function importSymbolIndex() {
    return await import('../dist/core/symbol-index.js');
}

describe('symbol-index — findRepoRoot', () => {
    it('returns root for a git repo directory', async () => {
        const { findRepoRoot } = await importSymbolIndex();
        const dir = mkTmpGitRepo();
        const root = findRepoRoot(dir);
        expect(root).toBeTruthy();
        expect(root).toBe(path.resolve(dir));
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('returns root for a file inside a git repo', async () => {
        const { findRepoRoot } = await importSymbolIndex();
        const dir = mkTmpGitRepo();
        const filePath = path.join(dir, 'test.js');
        fs.writeFileSync(filePath, 'const x = 1;');
        const root = findRepoRoot(filePath);
        expect(root).toBe(path.resolve(dir));
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('returns null for non-git directory', async () => {
        const { findRepoRoot } = await importSymbolIndex();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
        const root = findRepoRoot(dir);
        expect(root).toBeNull();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });
});

describe('symbol-index — getSessionId', () => {
    it('returns provided session id', async () => {
        const { getSessionId } = await importSymbolIndex();
        expect(getSessionId('my-session')).toBe('my-session');
    });

    it('returns fallback when no id provided', async () => {
        const { getSessionId } = await importSymbolIndex();
        const result = getSessionId();
        expect(result).toContain(String(process.pid));
    });
});

describe('symbol-index — snapshotSymbol & getVersionHistory', () => {
    let db;

    beforeEach(() => {
        db = openMemoryDb();
        execRaw(db, `
            CREATE TABLE IF NOT EXISTS versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_name TEXT,
                file_path TEXT,
                original_text TEXT,
                session_id TEXT,
                created_at INTEGER,
                line INTEGER,
                text_hash TEXT
            );
        `);
    });

    afterEach(() => {
        try { closeDb(db); } catch {}
    });

    it('snapshotSymbol inserts a version row', async () => {
        const { snapshotSymbol } = await importSymbolIndex();
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'function myFunc() {}', 'sess1', 10);
        const rows = queryRaw(db, 'SELECT * FROM versions WHERE symbol_name = ?', 'myFunc');
        expect(rows).toHaveLength(1);
        expect(rows[0].original_text).toBe('function myFunc() {}');
        expect(rows[0].session_id).toBe('sess1');
        expect(rows[0].line).toBe(10);
    });

    it('snapshotSymbol deduplicates via unique index when present', async () => {
        const { snapshotSymbol } = await importSymbolIndex();
        // Create the unique index that getDb() normally creates
        execRaw(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'same content', 'sess1', 1);
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'same content', 'sess1', 1);
        const rows = queryRaw(db, 'SELECT * FROM versions WHERE symbol_name = ?', 'myFunc');
        expect(rows).toHaveLength(1);
    });

    // BUG: snapshotSymbol uses INSERT OR IGNORE but the unique index idx_versions_dedup
    // is only created by getDb(). If called on a DB without that index, dedup fails silently.
    it('snapshotSymbol does NOT deduplicate without the unique index', async () => {
        const { snapshotSymbol } = await importSymbolIndex();
        // No unique index — INSERT OR IGNORE has no effect
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'same content', 'sess1', 1);
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'same content', 'sess1', 1);
        const rows = queryRaw(db, 'SELECT * FROM versions WHERE symbol_name = ?', 'myFunc');
        expect(rows).toHaveLength(2);
    });

    it('getVersionHistory returns versions for a symbol', async () => {
        const { snapshotSymbol, getVersionHistory } = await importSymbolIndex();
        snapshotSymbol(db, 'alpha', 'a.js', 'v1', 'sess1', 1);
        snapshotSymbol(db, 'alpha', 'a.js', 'v2', 'sess1', 2);
        snapshotSymbol(db, 'beta', 'b.js', 'v3', 'sess1', 3);

        const history = getVersionHistory(db, 'alpha', 'sess1');
        expect(history).toHaveLength(2);
    });

    it('getVersionHistory filters by filePath when provided', async () => {
        const { snapshotSymbol, getVersionHistory } = await importSymbolIndex();
        snapshotSymbol(db, 'alpha', 'a.js', 'v1', 'sess1', 1);
        snapshotSymbol(db, 'alpha', 'b.js', 'v2', 'sess1', 2);

        const history = getVersionHistory(db, 'alpha', 'sess1', 'a.js');
        expect(history).toHaveLength(1);
        expect(history[0].file_path).toBe('a.js');
    });

    it('getVersionHistory returns empty for unknown symbol', async () => {
        const { getVersionHistory } = await importSymbolIndex();
        const history = getVersionHistory(db, 'nonexistent', 'sess1');
        expect(history).toHaveLength(0);
    });
});

describe('symbol-index — getVersionText', () => {
    let db;

    beforeEach(() => {
        db = openMemoryDb();
        execRaw(db, `
            CREATE TABLE IF NOT EXISTS versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_name TEXT,
                file_path TEXT,
                original_text TEXT,
                session_id TEXT,
                created_at INTEGER,
                line INTEGER,
                text_hash TEXT
            );
        `);
    });

    afterEach(() => {
        try { closeDb(db); } catch {}
    });

    it('returns original text for existing version', async () => {
        const { snapshotSymbol, getVersionText } = await importSymbolIndex();
        snapshotSymbol(db, 'fn', 'f.js', 'the original text', 's1', 1);
        const versions = queryRaw(db, 'SELECT id FROM versions');
        const text = getVersionText(db, versions[0].id);
        expect(text).toBe('the original text');
    });

    it('returns null for nonexistent version id', async () => {
        const { getVersionText } = await importSymbolIndex();
        expect(getVersionText(db, 99999)).toBeNull();
    });
});

describe('symbol-index — restoreVersion', () => {
    let db;

    beforeEach(() => {
        db = openMemoryDb();
        execRaw(db, `
            CREATE TABLE IF NOT EXISTS versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_name TEXT,
                file_path TEXT,
                original_text TEXT,
                session_id TEXT,
                created_at INTEGER,
                line INTEGER,
                text_hash TEXT
            );
        `);
    });

    afterEach(() => {
        try { closeDb(db); } catch {}
    });

    it('restores original text from version', async () => {
        const { snapshotSymbol, restoreVersion } = await importSymbolIndex();
        snapshotSymbol(db, 'myFn', 'f.js', 'original body', 'sess1', 5);
        const version = queryRaw(db, 'SELECT id FROM versions');
        const text = restoreVersion(db, 'myFn', version[0].id, 'sess1');
        expect(text).toBe('original body');
    });

    it('throws for nonexistent version', async () => {
        const { restoreVersion } = await importSymbolIndex();
        expect(() => restoreVersion(db, 'fn', 99999, 'sess1'))
            .toThrow('Version not found');
    });

    it('throws when symbol name does not match', async () => {
        const { snapshotSymbol, restoreVersion } = await importSymbolIndex();
        snapshotSymbol(db, 'correct', 'f.js', 'text', 'sess1', 1);
        const version = queryRaw(db, 'SELECT id FROM versions');
        expect(() => restoreVersion(db, 'wrong', version[0].id, 'sess1'))
            .toThrow('belongs to');
    });

    it('throws when session id does not match', async () => {
        const { snapshotSymbol, restoreVersion } = await importSymbolIndex();
        snapshotSymbol(db, 'myFn', 'f.js', 'text', 'sess1', 1);
        const version = queryRaw(db, 'SELECT id FROM versions');
        expect(() => restoreVersion(db, 'myFn', version[0].id, 'different-session'))
            .toThrow('different session');
    });

    it('snapshots current text before restoring when provided', async () => {
        const { snapshotSymbol, restoreVersion } = await importSymbolIndex();
        snapshotSymbol(db, 'fn', 'f.js', 'old text', 'sess1', 1);
        const version = queryRaw(db, 'SELECT id FROM versions');
        restoreVersion(db, 'fn', version[0].id, 'sess1', 'current content');
        const all = queryRaw(db, 'SELECT * FROM versions');
        expect(all.length).toBe(2);
    });
});

describe('symbol-index — ensureIndexFresh stale purge', () => {
    let repoDir;
    let db;

    beforeEach(() => {
        repoDir = mkTmpGitRepo();
        db = openMemoryDb();
        initSymbolSchema(db);
    });

    afterEach(() => {
        try { closeDb(db); } catch {}
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    // Covers edge case missing from symbol-index tests: freshness checks must
    // remove stale rows when a previously indexed file has been deleted.
    it('purges stale file and symbol rows when an indexed file has been deleted', async () => {
        const { indexFile, ensureIndexFresh } = await importSymbolIndex();
        const filePath = path.join(repoDir, 'stale.js');
        fs.writeFileSync(filePath, 'function staleSymbol() { return 1; }\n');
        await indexFile(db, repoDir, filePath);

        expect(queryRaw(db, 'SELECT path FROM files WHERE path = ?', 'stale.js')[0]).toBeTruthy();
        expect(queryRaw(db, 'SELECT name FROM symbols WHERE name = ?', 'staleSymbol')[0]).toBeTruthy();

        fs.unlinkSync(filePath);
        const reindexed = await ensureIndexFresh(db, repoDir, [filePath]);

        expect(reindexed).toBe(0);
        expect(queryRaw(db, 'SELECT path FROM files WHERE path = ?', 'stale.js')[0]).toBeUndefined();
        expect(queryRaw(db, 'SELECT name FROM symbols WHERE name = ?', 'staleSymbol')[0]).toBeUndefined();
    });
});

describe('symbol-index — pruneOldSessions', () => {
    let db;

    beforeEach(() => {
        db = openMemoryDb();
        execRaw(db, `
            CREATE TABLE IF NOT EXISTS versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_name TEXT,
                file_path TEXT,
                original_text TEXT,
                session_id TEXT,
                created_at INTEGER,
                line INTEGER,
                text_hash TEXT
            );
        `);
    });

    afterEach(() => {
        try { closeDb(db); } catch {}
    });

    it('deletes versions from other sessions', async () => {
        const { snapshotSymbol, pruneOldSessions } = await importSymbolIndex();
        snapshotSymbol(db, 'fn', 'f.js', 'keep', 'session-A', 1);
        snapshotSymbol(db, 'fn', 'f.js', 'remove', 'session-B', 2);

        pruneOldSessions(db, 'session-A');
        const remaining = queryRaw(db, 'SELECT * FROM versions');
        expect(remaining).toHaveLength(1);
        expect(remaining[0].session_id).toBe('session-A');
    });
});

// -----------------------------------------------------------------------------
// POLARIS Task 1.2 — honest capped walks, complete-walk deletion purge,
// deterministic cap membership, and the source-byte safety bound.
// -----------------------------------------------------------------------------

describe('indexDirectory coverage (POLARIS Task 1.2)', () => {
    let dir;
    let db;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symidx-cov-'));
        db = openMemoryDb();
        initSymbolSchema(db);
    });

    afterEach(() => {
        try { closeDb(db); } catch {}
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('a complete scan reports complete and still purges truly deleted files', async () => {
        const { indexDirectory } = await importSymbolIndex();
        fs.writeFileSync(path.join(dir, 'stay.ts'), 'export function stayFn(): number {\n    return 1;\n}\n');
        fs.writeFileSync(path.join(dir, 'gone.ts'), 'export function goneFn(): number {\n    return 2;\n}\n');

        const first = await indexDirectory(db, dir, dir);
        expect(first).toEqual({ visited: 2, complete: true, stopReason: null });
        expect(queryRaw(db, 'SELECT COUNT(*) AS n FROM files')[0].n).toBe(2);

        fs.rmSync(path.join(dir, 'gone.ts'));
        const second = await indexDirectory(db, dir, dir);
        expect(second).toEqual({ visited: 1, complete: true, stopReason: null });
        // Genuine deletion purge is preserved on complete walks.
        expect(queryRaw(db, 'SELECT path FROM files ORDER BY path').map(r => r.path)).toEqual(['stay.ts']);
        expect(queryRaw(db, "SELECT COUNT(*) AS n FROM symbols WHERE file_path = 'gone.ts'")[0].n).toBe(0);
    });

    it('cap membership is deterministic: the sorted-first files are indexed regardless of creation order', async () => {
        const { indexDirectory } = await importSymbolIndex();
        // Create in reverse-alphabetical order so readdir/creation order and
        // sorted order disagree.
        for (const name of ['zeta.ts', 'midd.ts', 'alfa.ts']) {
            fs.writeFileSync(path.join(dir, name), `export function fn_${name.slice(0, 4)}(): number {\n    return 1;\n}\n`);
        }
        const coverage = await indexDirectory(db, dir, dir, { maxFiles: 2 });
        expect(coverage).toEqual({ visited: 2, complete: false, stopReason: 'max_files' });
        expect(queryRaw(db, 'SELECT path FROM files ORDER BY path').map(r => r.path)).toEqual(['alfa.ts', 'midd.ts']);
    });

    it('an exactly-at-cap walk is complete, not truncated', async () => {
        const { indexDirectory } = await importSymbolIndex();
        fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
        fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
        const coverage = await indexDirectory(db, dir, dir, { maxFiles: 2 });
        expect(coverage).toEqual({ visited: 2, complete: true, stopReason: null });
    });
});

describe('source-byte safety bound (POLARIS Task 1.2)', () => {
    let dir;
    let db;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symidx-big-'));
        db = openMemoryDb();
        initSymbolSchema(db);
    });

    afterEach(() => {
        try { closeDb(db); } catch {}
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('an over-limit file is typed too_large: sentinel recorded, never parsed, prior facts kept', async () => {
        const { indexFile, ensureFreshFromContent, PROVISIONAL_MAX_SOURCE_BYTES, TOO_LARGE_SENTINEL_PREFIX } = await importSymbolIndex();

        // Start with a small, real version so prior facts exist.
        const abs = path.join(dir, 'grown.ts');
        const smallContent = 'export function grownFn(): number {\n    return 1;\n}\n';
        fs.writeFileSync(abs, smallContent);
        expect(await indexFile(db, dir, abs)).toBe('indexed');
        const factsBefore = queryRaw(db, "SELECT COUNT(*) AS n FROM symbols WHERE file_path = 'grown.ts'")[0].n;
        expect(factsBefore).toBeGreaterThan(0);

        // Grow it past the bound via the content-addressed path (no giant
        // disk write needed) — one valid statement plus filler comments.
        const filler = '// ' + 'x'.repeat(1024) + '\n';
        const bigContent = smallContent + filler.repeat(Math.ceil(PROVISIONAL_MAX_SOURCE_BYTES / filler.length) + 1);
        expect(Buffer.byteLength(bigContent, 'utf8')).toBeGreaterThan(PROVISIONAL_MAX_SOURCE_BYTES);

        const result = await ensureFreshFromContent(db, dir, abs, bigContent);
        expect(result).toBe(0); // no facts were (re)indexed

        // Typed sentinel recorded in files.hash; versioned; carries the content hash.
        const hash = queryRaw(db, "SELECT hash FROM files WHERE path = 'grown.ts'")[0].hash;
        expect(hash.startsWith(TOO_LARGE_SENTINEL_PREFIX)).toBe(true);

        // Prior facts were NOT purged — a skip is not evidence of emptiness.
        const factsAfter = queryRaw(db, "SELECT COUNT(*) AS n FROM symbols WHERE file_path = 'grown.ts'")[0].n;
        expect(factsAfter).toBe(factsBefore);

        // Shrinking back under the bound heals through the normal path.
        const healed = await ensureFreshFromContent(db, dir, abs, smallContent + '// changed\n');
        expect(healed).toBe(1);
        const healedHash = queryRaw(db, "SELECT hash FROM files WHERE path = 'grown.ts'")[0].hash;
        expect(healedHash.startsWith(TOO_LARGE_SENTINEL_PREFIX)).toBe(false);
    });

    it('a brand-new over-limit file records the sentinel with zero fact rows', async () => {
        const { indexFile, PROVISIONAL_MAX_SOURCE_BYTES, TOO_LARGE_SENTINEL_PREFIX } = await importSymbolIndex();
        const abs = path.join(dir, 'huge.ts');
        const filler = '// ' + 'y'.repeat(1024) + '\n';
        const bigContent = filler.repeat(Math.ceil(PROVISIONAL_MAX_SOURCE_BYTES / filler.length) + 1);

        expect(await indexFile(db, dir, abs, bigContent)).toBe('too_large');
        const hash = queryRaw(db, "SELECT hash FROM files WHERE path = 'huge.ts'")[0].hash;
        expect(hash.startsWith(TOO_LARGE_SENTINEL_PREFIX)).toBe(true);
        expect(queryRaw(db, "SELECT COUNT(*) AS n FROM symbols WHERE file_path = 'huge.ts'")[0].n).toBe(0);
    });
});
