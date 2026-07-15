import { getProjectContext } from './project-context.js';

// ---------------------------------------------------------------------------
// Stash API — all operations go through ProjectContext for DB resolution.
// No repoRoot params needed — context handles it.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

function getDb(ctx, filePath) {
    const pc = getProjectContext(ctx);
    return pc.getStashDb(filePath);
}

export function stashEntry(ctx, type, filePath, payload) {
    const { db } = getDb(ctx, filePath);
    const result = db.prepare(
        'INSERT INTO stash (type, file_path, payload, attempts, created_at) VALUES (?, ?, ?, 0, ?)'
    ).run(type, filePath, JSON.stringify(payload), Date.now());
    return result.lastInsertRowid;
}

export function getStashEntry(ctx, id, filePath) {
    const { db } = getDb(ctx, filePath);
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

export function consumeAttempt(ctx, id, filePath) {
    const { db } = getDb(ctx, filePath);
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

export function clearStash(ctx, id, filePath) {
    const { db } = getDb(ctx, filePath);
    db.prepare('DELETE FROM stash WHERE id = ?').run(id);
}

export function listStash(ctx, filePath) {
    const { db, isGlobal } = getDb(ctx, filePath);
    const rows = db.prepare('SELECT * FROM stash ORDER BY id').all().map(row => ({
        id: row.id,
        type: row.type,
        filePath: row.file_path,
        payload: JSON.parse(row.payload),
        attempts: row.attempts,
        createdAt: row.created_at,
    }));
    return { entries: rows, isGlobal };
}

// Convenience wrappers

export function stashEdits(ctx, filePath, edits, failedIndices) {
    return stashEntry(ctx, 'edit', filePath, { edits, failedIndices });
}

export function stashWrite(ctx, filePath, content, mode) {
    return stashEntry(ctx, 'write', filePath, { content, mode: mode || 'overwrite' });
}
