import { getProjectContext } from './project-context.js';
import type { FsContext } from './project-context.js';
import type { Edit } from './edit-engine.js';
import {
    DbConnection,
    insertStash,
    getStash,
    getStashAttempts,
    updateStashAttempts,
    deleteStash,
    listStash as adapterListStash
} from './db-adapter.js';

const MAX_ATTEMPTS = 2;

type StashPayload =
    | { edits: Edit[]; failedIndices: number[] }
    | { content: string; mode: string };

function getDb(ctx: FsContext, filePath?: string): { conn: DbConnection; isGlobal: boolean } {
    const pc = getProjectContext(ctx);
    const { db, isGlobal } = pc.getStashDb(filePath);
    return { conn: db, isGlobal };
}

export function stashEntry(ctx: FsContext, type: string, filePath: string, payload: StashPayload) {
    const { conn } = getDb(ctx, filePath);
    return insertStash(conn, {
        type,
        filePath,
        payload: JSON.stringify(payload),
        createdAt: Date.now()
    });
}

export function getStashEntry(ctx: FsContext, id: number, filePath?: string) {
    const { conn } = getDb(ctx, filePath);
    const row = getStash(conn, id);
    if (!row) return null;
    return {
        id: row.id,
        type: row.type,
        filePath: row.file_path ?? null,
        payload: JSON.parse(row.payload),
        attempts: row.attempts,
        createdAt: row.created_at,
    };
}

export function consumeAttempt(ctx: FsContext, id: number, filePath: string) {
    const { conn } = getDb(ctx, filePath);
    const attempts = getStashAttempts(conn, id);
    if (attempts === null) return false;
    const next = attempts + 1;
    updateStashAttempts(conn, id, next);
    if (next > MAX_ATTEMPTS) {
        deleteStash(conn, id);
        return false;
    }
    return true;
}

export function clearStash(ctx: FsContext, id: number, filePath?: string) {
    const { conn } = getDb(ctx, filePath);
    deleteStash(conn, id);
}

export function listStash(ctx: FsContext, filePath?: string) {
    const { conn, isGlobal } = getDb(ctx, filePath);
    const rows = adapterListStash(conn).map((row) => ({
        id: row.id,
        type: row.type,
        filePath: row.file_path ?? null,
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
