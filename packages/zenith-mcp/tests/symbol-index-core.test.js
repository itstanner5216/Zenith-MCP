import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';

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
        db = new Database(':memory:');
        db.exec(`
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
        try { db.close(); } catch {}
    });

    it('snapshotSymbol inserts a version row', async () => {
        const { snapshotSymbol } = await importSymbolIndex();
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'function myFunc() {}', 'sess1', 10);
        const rows = db.prepare('SELECT * FROM versions WHERE symbol_name = ?').all('myFunc');
        expect(rows).toHaveLength(1);
        expect(rows[0].original_text).toBe('function myFunc() {}');
        expect(rows[0].session_id).toBe('sess1');
        expect(rows[0].line).toBe(10);
    });

    it('snapshotSymbol deduplicates via unique index when present', async () => {
        const { snapshotSymbol } = await importSymbolIndex();
        // Create the unique index that getDb() normally creates
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'same content', 'sess1', 1);
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'same content', 'sess1', 1);
        const rows = db.prepare('SELECT * FROM versions WHERE symbol_name = ?').all('myFunc');
        expect(rows).toHaveLength(1);
    });

    // BUG: snapshotSymbol uses INSERT OR IGNORE but the unique index idx_versions_dedup
    // is only created by getDb(). If called on a DB without that index, dedup fails silently.
    it('snapshotSymbol does NOT deduplicate without the unique index', async () => {
        const { snapshotSymbol } = await importSymbolIndex();
        // No unique index — INSERT OR IGNORE has no effect
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'same content', 'sess1', 1);
        snapshotSymbol(db, 'myFunc', 'src/main.js', 'same content', 'sess1', 1);
        const rows = db.prepare('SELECT * FROM versions WHERE symbol_name = ?').all('myFunc');
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
        db = new Database(':memory:');
        db.exec(`
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
        try { db.close(); } catch {}
    });

    it('returns original text for existing version', async () => {
        const { snapshotSymbol, getVersionText } = await importSymbolIndex();
        snapshotSymbol(db, 'fn', 'f.js', 'the original text', 's1', 1);
        const versions = db.prepare('SELECT id FROM versions').all();
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
        db = new Database(':memory:');
        db.exec(`
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
        try { db.close(); } catch {}
    });

    it('restores original text from version', async () => {
        const { snapshotSymbol, restoreVersion } = await importSymbolIndex();
        snapshotSymbol(db, 'myFn', 'f.js', 'original body', 'sess1', 5);
        const version = db.prepare('SELECT id FROM versions').all();
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
        const version = db.prepare('SELECT id FROM versions').all();
        expect(() => restoreVersion(db, 'wrong', version[0].id, 'sess1'))
            .toThrow('belongs to');
    });

    it('throws when session id does not match', async () => {
        const { snapshotSymbol, restoreVersion } = await importSymbolIndex();
        snapshotSymbol(db, 'myFn', 'f.js', 'text', 'sess1', 1);
        const version = db.prepare('SELECT id FROM versions').all();
        expect(() => restoreVersion(db, 'myFn', version[0].id, 'different-session'))
            .toThrow('different session');
    });

    it('snapshots current text before restoring when provided', async () => {
        const { snapshotSymbol, restoreVersion } = await importSymbolIndex();
        snapshotSymbol(db, 'fn', 'f.js', 'old text', 'sess1', 1);
        const version = db.prepare('SELECT id FROM versions').all();
        restoreVersion(db, 'fn', version[0].id, 'sess1', 'current content');
        const all = db.prepare('SELECT * FROM versions').all();
        expect(all.length).toBe(2);
    });
});

describe('symbol-index — pruneOldSessions', () => {
    let db;

    beforeEach(() => {
        db = new Database(':memory:');
        db.exec(`
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
        try { db.close(); } catch {}
    });

    it('deletes versions from other sessions', async () => {
        const { snapshotSymbol, pruneOldSessions } = await importSymbolIndex();
        snapshotSymbol(db, 'fn', 'f.js', 'keep', 'session-A', 1);
        snapshotSymbol(db, 'fn', 'f.js', 'remove', 'session-B', 2);

        pruneOldSessions(db, 'session-A');
        const remaining = db.prepare('SELECT * FROM versions').all();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].session_id).toBe('session-A');
    });
});
