import { getProjectContext } from './project-context.js';
import type { FsContext } from './project-context.js';
import type { Edit } from './edit-engine.js';

const MAX_ATTEMPTS = 2;

interface StashRow {
    id: number;
    type: string;
    file_path: string;
    payload: string;
    attempts: number;
    created_at: number;
}

interface AttemptsRow {
    attempts: number;
}

type StashPayload =
    | { edits: Edit[]; failedIndices: number[] }
    | { content: string; mode: string };

function getDb(ctx: FsContext, filePath?: string) {
    const pc = getProjectContext(ctx);
    return pc.getStashDb(filePath);
}

export function stashEntry(ctx: FsContext, type: string, filePath: string, payload: StashPayload) {
    const { db } = getDb(ctx, filePath);
    const result = db.prepare(
        'INSERT INTO stash (type, file_path, payload, attempts, created_at) VALUES (?, ?, ?, 0, ?)'
    ).run(type, filePath, JSON.stringify(payload), Date.now());
    return result.lastInsertRowid;
}

export function getStashEntry(ctx: FsContext, id: number, filePath?: string) {
    const { db } = getDb(ctx, filePath);
    const row = db.prepare<unknown[], StashRow>('SELECT * FROM stash WHERE id = ?').get(id);
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

export function consumeAttempt(ctx: FsContext, id: number, filePath: string) {
    const { db } = getDb(ctx, filePath);
    const row = db.prepare<unknown[], AttemptsRow>('SELECT attempts FROM stash WHERE id = ?').get(id);
    if (!row) return false;
    const next = row.attempts + 1;
    db.prepare('UPDATE stash SET attempts = ? WHERE id = ?').run(next, id);
    if (next > MAX_ATTEMPTS) {
        db.prepare('DELETE FROM stash WHERE id = ?').run(id);
        return false;
    }
    return true;
}

export function clearStash(ctx: FsContext, id: number, filePath?: string) {
    const { db } = getDb(ctx, filePath);
    db.prepare('DELETE FROM stash WHERE id = ?').run(id);
}

export function listStash(ctx: FsContext, filePath?: string) {
    const { db, isGlobal } = getDb(ctx, filePath);
    const rows = db.prepare<unknown[], StashRow>('SELECT * FROM stash ORDER BY id').all().map((row: StashRow) => ({
        id: row.id,
        type: row.type,
        filePath: row.file_path,
        payload: JSON.parse(row.payload),
        attempts: row.attempts,
        createdAt: row.created_at,
    }));
    return { entries: rows, isGlobal };
}

export function stashEdits(ctx: FsContext, filePath: string, edits: Edit[], failedIndices: number[]) {
    return stashEntry(ctx, 'edit', filePath, { edits, failedIndices });
}

export function stashWrite(ctx: FsContext, filePath: string, content: string, mode: string) {
    return stashEntry(ctx, 'write', filePath, { content, mode: mode || 'overwrite' });
}
