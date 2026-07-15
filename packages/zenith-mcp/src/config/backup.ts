import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { expandTilde } from './schema.js';
import {
    DbConnection,
    initBackupSchema,
    insertBackup,
    getBackup,
    pruneExpiredBackups
} from '../core/db-adapter.js';
import { getGlobalDbConnection, closeGlobalDb } from '../core/project-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZENITH_HOME = join(homedir(), '.zenith-mcp');
const DEFAULT_BACKUP_DIR = join(ZENITH_HOME, 'mcp_backups');  // used as fallback when backup_dir is empty
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Shared global connection (POLARIS Task 1.4): exactly ONE production code
// path opens the global database — ProjectContext's private opener. This
// module rides that connection and only ensures its own table exists.
// ---------------------------------------------------------------------------

let _schemaReady = false;

function getDb(): DbConnection {
    const conn = getGlobalDbConnection();
    if (!_schemaReady) {
        initBackupSchema(conn);
        _schemaReady = true;
    }
    return conn;
}

/** Exported for test teardown / clean shutdown — closes the SHARED global
 * connection via its owner so no stale handle survives anywhere. */
export function closeDb(): void {
    _schemaReady = false;
    closeGlobalDb();
}

// withDb signature preserved so callers are unchanged.
function withDb<T>(work: (conn: DbConnection) => T): T {
    return work(getDb());
}

// ---------------------------------------------------------------------------
// backupFile — create a backup using the chosen strategy
// ---------------------------------------------------------------------------

export function backupFile(
    originalPath: string,
    mode: 'file' | 'sqlite' | 'none',
    backupDir?: string,
): { backupId: string; message: string } {
    if (mode === 'none') {
        return { backupId: 'none', message: 'No backup stored' };
    }

    if (!existsSync(originalPath)) {
        throw new Error(`Cannot backup: file does not exist at ${originalPath}`);
    }

    if (mode === 'file') {
        const dir = expandTilde(backupDir || DEFAULT_BACKUP_DIR);
        mkdirSync(dir, { recursive: true });

        // Produce a timestamp like 2026-05-07T120000 from ISO string
        const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
        const name = basename(originalPath);
        const backupPath = join(dir, `${name}.${ts}.bak`);

        copyFileSync(originalPath, backupPath);

        return {
            backupId: backupPath,
            message: `Backup saved to ${backupPath}`,
        };
    }

    // mode === 'sqlite'
    return withDb((conn) => {
        const content = readFileSync(originalPath, 'utf-8');
        const now = new Date();
        const createdAt = now.toISOString();
        const expiresAt = new Date(now.getTime() + TTL_MS).toISOString();

        const lastInsertId = insertBackup(conn, {
            originalPath,
            content,
            createdAt,
            expiresAt
        });

        const rowId = String(lastInsertId);

        return {
            backupId: rowId,
            message: `Backup stored in SQLite (row ${rowId}). Expires in 24 hours.`,
        };
    });
}

// ---------------------------------------------------------------------------
// restoreBackup — retrieve backup content by ID
// ---------------------------------------------------------------------------

export function restoreBackup(backupId: string, mode: 'file' | 'sqlite'): string {
    if (mode === 'file') {
        if (!existsSync(backupId)) {
            throw new Error(`Backup file not found at ${backupId}`);
        }
        return readFileSync(backupId, 'utf-8');
    }

    // mode === 'sqlite'
    return withDb((conn) => {
        const row = getBackup(conn, Number(backupId));

        if (!row) {
            throw new Error(`No SQLite backup found for row ID ${backupId}`);
        }

        return row.backup_content;
    });
}

// ---------------------------------------------------------------------------
// cleanupExpiredBackups — purge rows past their TTL
// ---------------------------------------------------------------------------

export function cleanupExpiredBackups(): number {
    return withDb((conn) => {
        const now = new Date().toISOString();
        return pruneExpiredBackups(conn, now);
    });
}
