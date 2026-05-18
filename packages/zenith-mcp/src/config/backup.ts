import Database from 'better-sqlite3';
import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { expandTilde } from './schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZENITH_HOME = join(homedir(), '.zenith-mcp');
const GLOBAL_DB_PATH = join(ZENITH_HOME, 'global-stash.db');
const DEFAULT_BACKUP_DIR = join(ZENITH_HOME, 'mcp_backups');  // used as fallback when backup_dir is empty
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Row shape interfaces for typed DB queries
// ---------------------------------------------------------------------------

interface BackupRow {
    id: number;
    original_path: string;
    backup_content: string;
    created_at: string;
    expires_at: string;
}

// ---------------------------------------------------------------------------
// Lazy singleton DB connection — one open per process lifetime
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

function getDb(): Database.Database {
    if (_db !== null) return _db;
    mkdirSync(ZENITH_HOME, { recursive: true });
    const db = new Database(GLOBAL_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS config_backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_path TEXT NOT NULL,
            backup_content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
    `);
    _db = db;
    return db;
}

/** Exported for test teardown / clean shutdown. */
export function closeDb(): void {
    if (_db !== null) {
        _db.close();
        _db = null;
    }
}

// withDb signature preserved so callers are unchanged.
function withDb<T>(work: (db: Database.Database) => T): T {
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
    return withDb((db) => {
        const content = readFileSync(originalPath, 'utf-8');
        const now = new Date();
        const createdAt = now.toISOString();
        const expiresAt = new Date(now.getTime() + TTL_MS).toISOString();

        const result = db
            .prepare(
                'INSERT INTO config_backups (original_path, backup_content, created_at, expires_at) VALUES (?, ?, ?, ?)',
            )
            .run(originalPath, content, createdAt, expiresAt);

        const rowId = String(result.lastInsertRowid);

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
    return withDb((db) => {
        const row = db
            .prepare<unknown[], BackupRow>('SELECT * FROM config_backups WHERE id = ?')
            .get(Number(backupId));

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
    return withDb((db) => {
        const now = new Date().toISOString();
        const result = db
            .prepare('DELETE FROM config_backups WHERE expires_at < ?')
            .run(now);
        return result.changes;
    });
}
