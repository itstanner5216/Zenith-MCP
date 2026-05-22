import { DatabaseSync, StatementSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// DbConnection — opaque handle wrapping the driver
// ---------------------------------------------------------------------------

/**
 * Opaque database connection. Consumers pass this around but cannot access
 * internals directly — all operations go through adapter functions.
 */
export class DbConnection {
    #handle: DatabaseSync;
    #stmtCache: Map<string, StatementSync>;
    #txDepth: number;

    constructor(db: DatabaseSync) {
        this.#handle = db;
        this.#stmtCache = new Map();
        this.#txDepth = 0;
    }

    /** @internal — used only by adapter functions in this file. */
    get _db(): DatabaseSync { return this.#handle; }
    get _cache(): Map<string, StatementSync> { return this.#stmtCache; }
    get _txDepth(): number { return this.#txDepth; }
    set _txDepth(v: number) { this.#txDepth = v; }
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function handle(conn: DbConnection): DatabaseSync {
    return conn._db;
}

/**
 * Get or create a prepared statement from the per-connection cache.
 * This avoids repeated prepare calls for hot-path queries.
 */
function prepareOrCache(conn: DbConnection, sql: string): StatementSync {
    const cache = conn._cache;
    let stmt = cache.get(sql);
    if (!stmt) {
        stmt = conn._db.prepare(sql);
        cache.set(sql, stmt);
    }
    return stmt;
}

// ---------------------------------------------------------------------------
// Connection Management
// ---------------------------------------------------------------------------

/**
 * Opens a SQLite database file. Sets standard pragmas:
 * journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON
 */
export function openDb(filePath: string): DbConnection {
    const db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    return new DbConnection(db);
}

/**
 * Opens an in-memory database (for testing).
 * Skips WAL and busy_timeout since they are no-ops for :memory:.
 */
export function openMemoryDb(): DbConnection {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    return new DbConnection(db);
}

/**
 * Closes a database connection and clears the statement cache.
 */
export function closeDb(conn: DbConnection): void {
    conn._cache.clear();
    handle(conn).close();
}

// ---------------------------------------------------------------------------
// Schema Initialization
// ---------------------------------------------------------------------------

/**
 * Creates tables: files, symbols, edges, versions, patterns + all indexes for the project symbol database.
 * Also executes schema migrations in safe try/catch blocks.
 */
export function initSymbolSchema(conn: DbConnection): void {
    const db = handle(conn);
    db.exec(`
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            hash TEXT,
            last_indexed INTEGER
        );
        CREATE TABLE IF NOT EXISTS symbols (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            kind TEXT,
            type TEXT,
            file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
            line INTEGER,
            end_line INTEGER,
            column INTEGER
        );
        CREATE TABLE IF NOT EXISTS edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            container_def_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
            referenced_name TEXT
        );
        CREATE TABLE IF NOT EXISTS versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol_name TEXT,
            file_path TEXT,
            original_text TEXT,
            session_id TEXT,
            created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            edit_body TEXT,
            symbol_kind TEXT,
            created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
        CREATE INDEX IF NOT EXISTS idx_symbols_kind_name ON symbols(kind, name);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(referenced_name);
        CREATE INDEX IF NOT EXISTS idx_edges_container ON edges(container_def_id);
        CREATE INDEX IF NOT EXISTS idx_versions_session ON versions(session_id);
    `);

    // Schema migrations
    try {
        db.exec('ALTER TABLE versions ADD COLUMN line INTEGER');
    } catch (error: any) {
        // Only tolerate "column already exists" errors
        const msg = error?.message || String(error);
        if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
            console.error('Unexpected error adding column "line" to versions table:', msg);
            console.error('SQL: ALTER TABLE versions ADD COLUMN line INTEGER');
            throw error;
        }
    }

    try {
        db.exec('ALTER TABLE versions ADD COLUMN text_hash TEXT');
    } catch (error: any) {
        // Only tolerate "column already exists" errors
        const msg = error?.message || String(error);
        if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
            console.error('Unexpected error adding column "text_hash" to versions table:', msg);
            console.error('SQL: ALTER TABLE versions ADD COLUMN text_hash TEXT');
            throw error;
        }
    }

    try {
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
    } catch (error: any) {
        // Only tolerate "index already exists" or constraint violation errors
        const msg = error?.message || String(error);
        if (!msg.includes('already exists') && !msg.includes('UNIQUE constraint failed') && !msg.includes('duplicate')) {
            console.error('Unexpected error creating index "idx_versions_dedup":', msg);
            console.error('SQL: CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
            throw error;
        }
    }
}

/**
 * Creates table: project_roots(root_path TEXT PRIMARY KEY, name TEXT, created_at INTEGER)
 */
export function initGlobalSchema(conn: DbConnection): void {
    handle(conn).exec(`
        CREATE TABLE IF NOT EXISTS project_roots (
            root_path TEXT PRIMARY KEY,
            name TEXT,
            created_at INTEGER
        );
    `);
}

/**
 * Creates table: stash(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, file_path TEXT, payload TEXT NOT NULL, attempts INTEGER DEFAULT 0, created_at INTEGER)
 */
export function initStashSchema(conn: DbConnection): void {
    handle(conn).exec(`
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

/**
 * Creates table: config_backups(id INTEGER PRIMARY KEY AUTOINCREMENT, original_path TEXT NOT NULL, backup_content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)
 */
export function initBackupSchema(conn: DbConnection): void {
    handle(conn).exec(`
        CREATE TABLE IF NOT EXISTS config_backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_path TEXT NOT NULL,
            backup_content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
    `);
}

// ---------------------------------------------------------------------------
// Files Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: SELECT hash FROM files WHERE path = ?
 */
export function getFileHash(conn: DbConnection, filePath: string): string | null {
    const row = prepareOrCache(conn, 'SELECT hash FROM files WHERE path = ?')
        .get(filePath) as { hash: string } | undefined;
    return row?.hash ?? null;
}

/**
 * SQL: INSERT OR REPLACE INTO files (path, hash, last_indexed) VALUES (?, ?, ?)
 */
export function upsertFile(conn: DbConnection, filePath: string, hash: string, lastIndexed: number): void {
    prepareOrCache(conn, 'INSERT OR REPLACE INTO files (path, hash, last_indexed) VALUES (?, ?, ?)')
        .run(filePath, hash, lastIndexed);
}

/**
 * SQL: DELETE FROM files WHERE path = ?
 */
export function deleteFile(conn: DbConnection, filePath: string): void {
    prepareOrCache(conn, 'DELETE FROM files WHERE path = ?')
        .run(filePath);
}

/**
 * SQL: SELECT path FROM files WHERE path LIKE ?
 */
export function getFilesByPrefix(conn: DbConnection, prefix: string): { path: string }[] {
    return prepareOrCache(conn, 'SELECT path FROM files WHERE path LIKE ?')
        .all(prefix) as { path: string }[];
}

/**
 * SQL: SELECT * FROM files
 */
export function getAllFiles(conn: DbConnection): { path: string; hash: string; last_indexed: number }[] {
    return prepareOrCache(conn, 'SELECT * FROM files')
        .all() as { path: string; hash: string; last_indexed: number }[];
}

/**
 * SQL: DELETE FROM files
 */
export function deleteAllFiles(conn: DbConnection): void {
    prepareOrCache(conn, 'DELETE FROM files')
        .run();
}

/**
 * SQL: SELECT COUNT(*) AS n FROM files
 */
export function getFileCount(conn: DbConnection): number {
    const row = prepareOrCache(conn, 'SELECT COUNT(*) AS n FROM files')
        .get() as { n: number } | undefined;
    return row?.n ?? 0;
}

/**
 * SQL: SELECT path FROM files
 */
export function getFilePaths(conn: DbConnection): { path: string }[] {
    return prepareOrCache(conn, 'SELECT path FROM files')
        .all() as { path: string }[];
}

/**
 * SQL: SELECT * FROM files WHERE path = ?
 */
export function getFile(conn: DbConnection, filePath: string): { path: string; hash: string; last_indexed: number } | null {
    const row = prepareOrCache(conn, 'SELECT * FROM files WHERE path = ?')
        .get(filePath) as { path: string; hash: string; last_indexed: number } | undefined;
    return row ?? null;
}

// ---------------------------------------------------------------------------
// Symbols Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO symbols (name, kind, type, file_path, line, end_line, column) VALUES (?, ?, ?, ?, ?, ?, ?)
 * Returns the inserted row id.
 */
export function insertSymbol(
    conn: DbConnection,
    symbol: {
        name: string;
        kind: string;
        type: string;
        filePath: string;
        line: number;
        endLine: number;
        column: number;
    }
): number {
    const result = prepareOrCache(conn, 'INSERT INTO symbols (name, kind, type, file_path, line, end_line, column) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(symbol.name, symbol.kind, symbol.type, symbol.filePath, symbol.line, symbol.endLine, symbol.column);
    return Number(result.lastInsertRowid);
}

/**
 * SQL: DELETE FROM symbols WHERE file_path = ?
 */
export function deleteSymbolsByFile(conn: DbConnection, filePath: string): void {
    prepareOrCache(conn, 'DELETE FROM symbols WHERE file_path = ?')
        .run(filePath);
}

/**
 * SQL: DELETE FROM symbols
 */
export function deleteAllSymbols(conn: DbConnection): void {
    prepareOrCache(conn, 'DELETE FROM symbols')
        .run();
}

/**
 * SQL: SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = ?
 */
export function findSymbolFiles(conn: DbConnection, name: string, kind: string): { file_path: string }[] {
    return prepareOrCache(conn, 'SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = ?')
        .all(name, kind) as { file_path: string }[];
}

/**
 * SQL: SELECT s.name, s.file_path, COUNT(e.id) AS refCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.referenced_name = ? AND s.kind = 'def' GROUP BY s.name, s.file_path ORDER BY refCount DESC
 */
export function getCallers(conn: DbConnection, referencedName: string): { name: string; file_path: string; refCount: number }[] {
    return prepareOrCache(conn, `SELECT s.name, s.file_path, COUNT(e.id) AS refCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.referenced_name = ? AND s.kind = 'def' GROUP BY s.name, s.file_path ORDER BY refCount DESC`)
        .all(referencedName) as { name: string; file_path: string; refCount: number }[];
}

/**
 * SQL: SELECT e.referenced_name AS name, COUNT(e.id) AS callCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.name = ? AND s.kind = 'def' GROUP BY e.referenced_name ORDER BY callCount DESC
 */
export function getCallees(conn: DbConnection, symbolName: string): { name: string; callCount: number }[] {
    return prepareOrCache(conn, `SELECT e.referenced_name AS name, COUNT(e.id) AS callCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.name = ? AND s.kind = 'def' GROUP BY e.referenced_name ORDER BY callCount DESC`)
        .all(symbolName) as { name: string; callCount: number }[];
}

/**
 * SQL: SELECT s.name, s.file_path, COUNT(e.id) AS refCount
 *      FROM edges e JOIN symbols s ON s.id = e.container_def_id
 *      WHERE e.referenced_name = ? AND s.kind = 'def'
 *        AND s.file_path NOT IN (SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = 'def' AND file_path != ?)
 *      GROUP BY s.name, s.file_path ORDER BY refCount DESC
 */
export function getCallersFiltered(
    conn: DbConnection,
    referencedName: string,
    originSymbol: string,
    originFile: string
): { name: string; file_path: string; refCount: number }[] {
    return prepareOrCache(conn, `SELECT s.name, s.file_path, COUNT(e.id) AS refCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.referenced_name = ? AND s.kind = 'def' AND s.file_path NOT IN (SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = 'def' AND file_path != ?) GROUP BY s.name, s.file_path ORDER BY refCount DESC`)
        .all(referencedName, originSymbol, originFile) as { name: string; file_path: string; refCount: number }[];
}

/**
 * SQL: SELECT e.referenced_name AS name, COUNT(e.id) AS callCount
 *      FROM edges e JOIN symbols s ON s.id = e.container_def_id
 *      WHERE s.name = ? AND s.kind = 'def' AND s.file_path = ?
 *      GROUP BY e.referenced_name ORDER BY callCount DESC
 */
export function getCalleesFiltered(conn: DbConnection, symbolName: string, filePath: string): { name: string; callCount: number }[] {
    return prepareOrCache(conn, `SELECT e.referenced_name AS name, COUNT(e.id) AS callCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.name = ? AND s.kind = 'def' AND s.file_path = ? GROUP BY e.referenced_name ORDER BY callCount DESC`)
        .all(symbolName, filePath) as { name: string; callCount: number }[];
}

/**
 * SQL: SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ?
 */
export function findSymbolDetails(conn: DbConnection, name: string, kind: string): { file_path: string; line: number; end_line: number; kind: string; type: string }[] {
    return prepareOrCache(conn, 'SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ?')
        .all(name, kind) as { file_path: string; line: number; end_line: number; kind: string; type: string }[];
}

/**
 * SQL: SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ? AND file_path LIKE ?
 */
export function findSymbolDetailsScoped(conn: DbConnection, name: string, kind: string, filePrefix: string): { file_path: string; line: number; end_line: number; kind: string; type: string }[] {
    return prepareOrCache(conn, 'SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ? AND file_path LIKE ?')
        .all(name, kind, filePrefix) as { file_path: string; line: number; end_line: number; kind: string; type: string }[];
}

/**
 * Returns definition symbols for structural comparison.
 * SQL base: SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def'
 * If type is provided: adds AND type = ?
 * If filePrefix is provided: adds AND file_path LIKE ?
 * Always ends with ORDER BY name
 */
export function findStructuralCandidates(
    conn: DbConnection,
    opts?: { type?: string; filePrefix?: string }
): { name: string; file_path: string; line: number; end_line: number }[] {
    let sql = "SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def'";
    const params: any[] = [];
    if (opts?.type !== undefined) {
        sql += " AND type = ?";
        params.push(opts.type);
    }
    if (opts?.filePrefix !== undefined) {
        sql += " AND file_path LIKE ?";
        params.push(opts.filePrefix);
    }
    sql += " ORDER BY name";
    return handle(conn)
        .prepare(sql)
        .all(...params) as { name: string; file_path: string; line: number; end_line: number }[];
}

// ---------------------------------------------------------------------------
// Edges Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO edges (container_def_id, referenced_name) VALUES (?, ?)
 */
export function insertEdge(conn: DbConnection, containerDefId: number, referencedName: string): void {
    prepareOrCache(conn, 'INSERT INTO edges (container_def_id, referenced_name) VALUES (?, ?)')
        .run(containerDefId, referencedName);
}

/**
 * SQL: DELETE FROM edges
 */
export function deleteAllEdges(conn: DbConnection): void {
    prepareOrCache(conn, 'DELETE FROM edges')
        .run();
}

// ---------------------------------------------------------------------------
// Versions Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT OR IGNORE INTO versions (symbol_name, file_path, original_text, session_id, created_at, line, text_hash) VALUES (?, ?, ?, ?, ?, ?, ?)
 */
export function snapshotVersion(
    conn: DbConnection,
    entry: {
        symbolName: string;
        filePath: string | null;
        text: string;
        sessionId: string;
        createdAt: number;
        line: number | null;
        textHash: string;
    }
): void {
    prepareOrCache(conn, 'INSERT OR IGNORE INTO versions (symbol_name, file_path, original_text, session_id, created_at, line, text_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(entry.symbolName, entry.filePath, entry.text, entry.sessionId, entry.createdAt, entry.line, entry.textHash);
}

/**
 * SQL: SELECT id, symbol_name, file_path, created_at, text_hash FROM versions WHERE symbol_name = ? AND session_id = ? [AND file_path = ?] ORDER BY created_at DESC
 */
export function getVersionHistory(
    conn: DbConnection,
    symbolName: string,
    sessionId: string,
    filePath?: string
): { id: number; symbol_name: string; file_path: string | null; created_at: number; text_hash: string | null }[] {
    let sql = 'SELECT id, symbol_name, file_path, created_at, text_hash FROM versions WHERE symbol_name = ? AND session_id = ?';
    const params: any[] = [symbolName, sessionId];
    if (filePath) {
        sql += ' AND file_path = ?';
        params.push(filePath);
    }
    sql += ' ORDER BY created_at DESC';
    return handle(conn)
        .prepare(sql)
        .all(...params) as { id: number; symbol_name: string; file_path: string | null; created_at: number; text_hash: string | null }[];
}

/**
 * SQL: SELECT original_text FROM versions WHERE id = ?
 */
export function getVersionText(conn: DbConnection, id: number): string | null {
    const row = prepareOrCache(conn, 'SELECT original_text FROM versions WHERE id = ?')
        .get(id) as { original_text: string } | undefined;
    return row?.original_text ?? null;
}

/**
 * SQL: SELECT original_text, symbol_name, session_id FROM versions WHERE id = ?
 */
export function getVersionMeta(conn: DbConnection, id: number): { original_text: string; symbol_name: string; session_id: string } | null {
    const row = prepareOrCache(conn, 'SELECT original_text, symbol_name, session_id FROM versions WHERE id = ?')
        .get(id) as { original_text: string; symbol_name: string; session_id: string } | undefined;
    return row ?? null;
}

/**
 * SQL: DELETE FROM versions WHERE created_at < ?
 */
export function pruneOldVersions(conn: DbConnection, beforeTimestamp: number): void {
    prepareOrCache(conn, 'DELETE FROM versions WHERE created_at < ?')
        .run(beforeTimestamp);
}

/**
 * SQL: DELETE FROM versions WHERE session_id != ?
 */
export function pruneOtherSessions(conn: DbConnection, keepSessionId: string): void {
    prepareOrCache(conn, 'DELETE FROM versions WHERE session_id != ?')
        .run(keepSessionId);
}

// ---------------------------------------------------------------------------
// Stash Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO stash (type, file_path, payload, attempts, created_at) VALUES (?, ?, ?, 0, ?)
 * Returns the inserted row id.
 */
export function insertStash(
    conn: DbConnection,
    entry: {
        type: string;
        filePath: string | null;
        payload: string;
        createdAt: number;
    }
): number {
    const result = prepareOrCache(conn, 'INSERT INTO stash (type, file_path, payload, attempts, created_at) VALUES (?, ?, ?, 0, ?)')
        .run(entry.type, entry.filePath, entry.payload, entry.createdAt);
    return Number(result.lastInsertRowid);
}

/**
 * SQL: SELECT * FROM stash WHERE id = ?
 */
export function getStash(
    conn: DbConnection,
    id: number
): { id: number; type: string; file_path: string | null; payload: string; attempts: number; created_at: number } | null {
    const row = prepareOrCache(conn, 'SELECT * FROM stash WHERE id = ?')
        .get(id) as { id: number; type: string; file_path: string | null; payload: string; attempts: number; created_at: number } | undefined;
    return row ?? null;
}

/**
 * SQL: SELECT attempts FROM stash WHERE id = ?
 */
export function getStashAttempts(conn: DbConnection, id: number): number | null {
    const row = prepareOrCache(conn, 'SELECT attempts FROM stash WHERE id = ?')
        .get(id) as { attempts: number } | undefined;
    return row?.attempts ?? null;
}

/**
 * SQL: UPDATE stash SET attempts = ? WHERE id = ?
 */
export function updateStashAttempts(conn: DbConnection, id: number, attempts: number): void {
    prepareOrCache(conn, 'UPDATE stash SET attempts = ? WHERE id = ?')
        .run(attempts, id);
}

/**
 * SQL: DELETE FROM stash WHERE id = ?
 */
export function deleteStash(conn: DbConnection, id: number): void {
    prepareOrCache(conn, 'DELETE FROM stash WHERE id = ?')
        .run(id);
}

/**
 * SQL: SELECT * FROM stash ORDER BY id
 */
export function listStash(conn: DbConnection): { id: number; type: string; file_path: string | null; payload: string; attempts: number; created_at: number }[] {
    return prepareOrCache(conn, 'SELECT * FROM stash ORDER BY id')
        .all() as { id: number; type: string; file_path: string | null; payload: string; attempts: number; created_at: number }[];
}

// ---------------------------------------------------------------------------
// Config Backups Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO config_backups (original_path, backup_content, created_at, expires_at) VALUES (?, ?, ?, ?)
 * Returns inserted row id.
 */
export function insertBackup(
    conn: DbConnection,
    entry: {
        originalPath: string;
        content: string;
        createdAt: string;
        expiresAt: string;
    }
): number {
    const result = prepareOrCache(conn, 'INSERT INTO config_backups (original_path, backup_content, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(entry.originalPath, entry.content, entry.createdAt, entry.expiresAt);
    return Number(result.lastInsertRowid);
}

/**
 * SQL: SELECT * FROM config_backups WHERE id = ?
 */
export function getBackup(
    conn: DbConnection,
    id: number
): { id: number; original_path: string; backup_content: string; created_at: string; expires_at: string } | null {
    const row = prepareOrCache(conn, 'SELECT * FROM config_backups WHERE id = ?')
        .get(id) as { id: number; original_path: string; backup_content: string; created_at: string; expires_at: string } | undefined;
    return row ?? null;
}

/**
 * SQL: DELETE FROM config_backups WHERE expires_at < ?
 */
export function pruneExpiredBackups(conn: DbConnection, now: string): number {
    return Number(prepareOrCache(conn, 'DELETE FROM config_backups WHERE expires_at < ?')
        .run(now).changes);
}

// ---------------------------------------------------------------------------
// Project Roots Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT OR REPLACE INTO project_roots (root_path, name, created_at) VALUES (?, ?, ?)
 */
export function upsertProjectRoot(
    conn: DbConnection,
    entry: {
        rootPath: string;
        name: string;
        createdAt: number;
    }
): void {
    prepareOrCache(conn, 'INSERT OR REPLACE INTO project_roots (root_path, name, created_at) VALUES (?, ?, ?)')
        .run(entry.rootPath, entry.name, entry.createdAt);
}

/**
 * SQL: SELECT * FROM project_roots ORDER BY created_at DESC
 */
export function listProjectRoots(conn: DbConnection): { root_path: string; name: string; created_at: number }[] {
    return prepareOrCache(conn, 'SELECT * FROM project_roots ORDER BY created_at DESC')
        .all() as { root_path: string; name: string; created_at: number }[];
}

/**
 * SQL: SELECT root_path, name FROM project_roots
 */
export function getAllProjectRootPaths(conn: DbConnection): { root_path: string; name: string }[] {
    return prepareOrCache(conn, 'SELECT root_path, name FROM project_roots')
        .all() as { root_path: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Transaction Support
// ---------------------------------------------------------------------------

/**
 * Wraps the provided function in a database transaction.
 * Supports nesting via SAVEPOINTs — inner calls don't start a new top-level transaction.
 * If the function throws, the transaction (or savepoint) is rolled back.
 */
export function runTransaction(conn: DbConnection, fn: () => void): void {
    const db = handle(conn);
    const depth = conn._txDepth;
    let started = false;
    conn._txDepth = depth + 1;
    try {
        if (depth === 0) {
            db.exec('BEGIN');
        } else {
            db.exec(`SAVEPOINT sp_${depth}`);
        }
        started = true;
        fn();
        if (depth === 0) {
            db.exec('COMMIT');
        } else {
            db.exec(`RELEASE sp_${depth}`);
        }
    } catch (e) {
        if (started && depth === 0) {
            db.exec('ROLLBACK');
        } else if (started) {
            db.exec(`ROLLBACK TO sp_${depth}`);
            db.exec(`RELEASE sp_${depth}`);
        }
        throw e;
    } finally {
        conn._txDepth = depth;
    }
}
}

// ---------------------------------------------------------------------------
// Raw Escape Hatch (for migrations or one-off DDL)
// ---------------------------------------------------------------------------

/**
 * Executes raw SQL with no return value. Use sparingly — only for DDL
 * or migrations that don't fit the above functions.
 */
export function execRaw(conn: DbConnection, sql: string): void {
    handle(conn).exec(sql);
}

/**
 * Executes a raw SQL query and returns all result rows.
 * Bypasses the statement cache to avoid pollution from ad-hoc queries.
 * Use ONLY in tests for assertions — production code should use dedicated adapter functions.
 */
export function queryRaw(conn: DbConnection, sql: string, ...params: any[]): any[] {
    return handle(conn).prepare(sql).all(...params);
}
