import { getDb } from './symbol-index.js';

function ensureTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS stash (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            file_path TEXT,
            payload TEXT NOT NULL,
            attempts INTEGER DEFAULT 0,
            created_at INTEGER
        );
    `);
}

const MAX_ATTEMPTS = 2;

function getStashDb(repoRoot) {
    const db = getDb(repoRoot);
    ensureTables(db);
    return db;
}

// --- Unified stash API ---

export function stashEntry(repoRoot, type, filePath, payload) {
    const db = getStashDb(repoRoot);
    const result = db.prepare(
        'INSERT INTO stash (type, file_path, payload, attempts, created_at) VALUES (?, ?, ?, 0, ?)'
    ).run(type, filePath, JSON.stringify(payload), Date.now());
    return result.lastInsertRowid;
}

export function getStashEntry(repoRoot, id) {
    const db = getStashDb(repoRoot);
    const row = db.prepare('SELECT * FROM stash WHERE id = ?').get(id);
    if (!row) return null;
    return {
        id: row.id,
        type: row.type,
        filePath: row.file_path,
        payload: JSON.parse(row.payload),
        attempts: row.attempts,
        createdAt: row.created_at,
    };
}

export function consumeAttempt(repoRoot, id) {
    const db = getStashDb(repoRoot);
    const row = db.prepare('SELECT attempts FROM stash WHERE id = ?').get(id);
    if (!row) return false;
    const next = row.attempts + 1;
    db.prepare('UPDATE stash SET attempts = ? WHERE id = ?').run(next, id);
    if (next > MAX_ATTEMPTS) {
        db.prepare('DELETE FROM stash WHERE id = ?').run(id);
        return false;
    }
    return true;
}

export function clearStash(repoRoot, id) {
    const db = getStashDb(repoRoot);
    db.prepare('DELETE FROM stash WHERE id = ?').run(id);
}

export function listStash(repoRoot) {
    const db = getStashDb(repoRoot);
    return db.prepare('SELECT * FROM stash ORDER BY id').all().map(row => ({
        id: row.id,
        type: row.type,
        filePath: row.file_path,
        payload: JSON.parse(row.payload),
        attempts: row.attempts,
        createdAt: row.created_at,
    }));
}

// Convenience wrappers matching old API signatures

export function stashEdits(repoRoot, filePath, edits, failedIndices) {
    return stashEntry(repoRoot, 'edit', filePath, { edits, failedIndices });
}

export function stashWrite(repoRoot, filePath, content, mode) {
    return stashEntry(repoRoot, 'write', filePath, { content, mode: mode || 'overwrite' });
}
