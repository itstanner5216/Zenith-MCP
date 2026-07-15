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
 * The newest symbol-schema version this build understands. A database
 * reporting a HIGHER version was written by a newer build; touching it could
 * corrupt facts that build depends on, so initialization refuses it with
 * zero physical change (POLARIS Task 1.1, FUTURE_SCHEMA).
 */
export const LATEST_SYMBOL_SCHEMA_VERSION = 4;

/**
 * Read the stored schema version WITHOUT creating, normalizing, or mutating
 * anything — safe to call before any DDL. Handles all three on-disk states:
 * no schema_version table (fresh/pre-ladder DB -> 0), the legacy shape with
 * no `id` column (-> highest stored version), and the single-row shape
 * (-> the id=1 row, 0 if absent).
 */
function inspectSchemaVersionReadOnly(db: DatabaseSync): number {
    const columns = db.prepare('PRAGMA table_info(schema_version)').all() as Array<{ name: string }>;
    if (columns.length === 0) return 0; // table absent — nothing to read
    const hasIdColumn = columns.some((c) => c.name === 'id');
    if (!hasIdColumn) {
        const legacyRow = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null } | undefined;
        return legacyRow && legacyRow.version !== null ? legacyRow.version : 0;
    }
    const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number } | undefined;
    return row ? row.version : 0;
}

/**
 * Creates tables: files, symbols, edges, versions, patterns + all indexes for the project symbol database.
 * Also executes schema migrations in safe try/catch blocks.
 *
 * FUTURE_SCHEMA contract (POLARIS Task 1.1): the stored schema version is
 * inspected READ-ONLY before any DDL, normalization, or ad-hoc ALTER runs.
 * A version newer than {@link LATEST_SYMBOL_SCHEMA_VERSION} throws
 * `FUTURE_SCHEMA: …` and leaves the database byte-for-byte untouched.
 */
export function initSymbolSchema(conn: DbConnection): void {
    const db = handle(conn);

    const preVersion = inspectSchemaVersionReadOnly(db);
    if (preVersion > LATEST_SYMBOL_SCHEMA_VERSION) {
        throw new Error(
            `FUTURE_SCHEMA: this database reports symbol-schema version ${preVersion}, ` +
            `newer than this build's ${LATEST_SYMBOL_SCHEMA_VERSION}. Refusing to touch it — ` +
            `open it with the newer build that created it (database left unmodified).`
        );
    }

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

    // --- Schema version + migration ladder ---
    //
    // schema_version is a single-row table keyed on id=1 (review #5). The CHECK
    // constraint + ON CONFLICT(id) write make the version strictly deterministic:
    // there is exactly one row, ever. A pre-existing database may still carry the
    // OLD shape `schema_version(version INTEGER NOT NULL)` with no `id` column —
    // `CREATE TABLE IF NOT EXISTS` will NOT alter that existing table, so we detect
    // the old shape explicitly and migrate it in place before reading the version.
    const currentVersion = normalizeSchemaVersionTable(db);

    if (currentVersion < 1) {
        // v0 → v1: extended symbol columns + new child tables.
        //
        // Review #6: the entire v0→v1 ladder (column ALTERs + child-table DDL +
        // the schema_version write) runs inside one transaction. SQLite DDL is
        // transactional, so a crash mid-migration rolls the whole ladder back and
        // the version is NOT advanced — leaving currentVersion at 0 so the next
        // init re-runs the migration cleanly. The id=1 row is only written after
        // every statement below has succeeded.
        runTransaction(conn, () => {
            const columnMigrations = [
                'ALTER TABLE symbols ADD COLUMN capture_tag TEXT',
                'ALTER TABLE symbols ADD COLUMN body_hash TEXT',
                'ALTER TABLE symbols ADD COLUMN parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE',
                'ALTER TABLE symbols ADD COLUMN visibility TEXT',
                'ALTER TABLE edges ADD COLUMN callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL',
            ];
            for (const sql of columnMigrations) {
                try {
                    db.exec(sql);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
                }
            }
            db.exec(`
            CREATE TABLE IF NOT EXISTS symbol_structures (
                symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
                params_json TEXT, return_text TEXT, decorators_json TEXT,
                modifiers_json TEXT, generics_text TEXT, parent_kind TEXT, parent_name TEXT
            );
            CREATE TABLE IF NOT EXISTS anchors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
                kind TEXT, line INTEGER, text TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_anchors_symbol ON anchors(symbol_id);
            CREATE TABLE IF NOT EXISTS imports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                module TEXT, imported_names_json TEXT, line INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);
            CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module);
            CREATE TABLE IF NOT EXISTS local_scopes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
                scope_kind TEXT, start_line INTEGER, end_line INTEGER,
                parameters_json TEXT, locals_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_local_scopes_symbol ON local_scopes(symbol_id);
            CREATE TABLE IF NOT EXISTS injections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                host_lang TEXT, injected_lang TEXT,
                start_line INTEGER, end_line INTEGER, start_byte INTEGER, end_byte INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_injections_file ON injections(file_path);
            CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_symbol_id);
            -- v3 remediation: project_roots is also a v1 addition (project-DB registry,
            -- not the dormant initGlobalSchema variant). Idempotent CREATE; safe if a
            -- prior partial run already added it.
            CREATE TABLE IF NOT EXISTS project_roots (
                root_path TEXT PRIMARY KEY,
                name TEXT,
                created_at INTEGER
            );
            `);
            // Advance to v1 idempotently against the single-row table. ON CONFLICT(id)
            // upserts the lone id=1 row, so re-running this never accumulates rows and
            // never needs a separate INSERT-vs-UPDATE branch.
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(1);
        });
    }

    if (currentVersion < 2) {
        // v1 → v2: binding-level import facts. The existing `imports` table stays
        // statement-level; this table records each local binding for semantic consumers.
        runTransaction(conn, () => {
            db.exec(`
            CREATE TABLE IF NOT EXISTS import_bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                source TEXT NOT NULL,
                local_name TEXT NOT NULL,
                imported_name TEXT,
                import_kind TEXT NOT NULL,
                is_type_only INTEGER NOT NULL,
                line INTEGER NOT NULL,
                column INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_import_bindings_file ON import_bindings(file_path);
            CREATE INDEX IF NOT EXISTS idx_import_bindings_local ON import_bindings(file_path, local_name);
            `);
            // Invalidate stored content hashes so the next indexing pass re-parses
            // every already-indexed file and populates import_bindings. Without
            // this, unchanged files skip on hash match (indexFile) and keep empty
            // binding facts indefinitely. Fresh databases have no rows; no-op.
            db.exec('UPDATE files SET hash = NULL');
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(2);
        });
    }

    if (currentVersion < 3) {
        // v2 → v3: statement-level imports carry spans for multiline import
        // clusters. Existing rows backfill to their original single-line hint.
        runTransaction(conn, () => {
            const columnMigrations = [
                'ALTER TABLE imports ADD COLUMN start_line INTEGER',
                'ALTER TABLE imports ADD COLUMN end_line INTEGER',
            ];
            for (const sql of columnMigrations) {
                try {
                    db.exec(sql);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
                }
            }
            db.exec('UPDATE imports SET start_line = COALESCE(start_line, line), end_line = COALESCE(end_line, line)');
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(3);
        });
    }

    if (currentVersion < 4) {
        // v3 → v4: preserve the reference kind already emitted by the tag queries,
        // plus the full source range already computed for every control-flow anchor.
        // Existing rows receive honest neutral backfills, and stored hashes are
        // invalidated so normal freshness checks repopulate exact facts.
        runTransaction(conn, () => {
            const columnMigrations = [
                "ALTER TABLE edges ADD COLUMN reference_kind TEXT NOT NULL DEFAULT 'unknown'",
                'ALTER TABLE anchors ADD COLUMN end_line INTEGER',
            ];
            for (const sql of columnMigrations) {
                try {
                    db.exec(sql);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
                }
            }
            db.exec("UPDATE edges SET reference_kind = COALESCE(reference_kind, 'unknown')");
            db.exec('UPDATE anchors SET end_line = COALESCE(end_line, line)');
            db.exec('UPDATE files SET hash = NULL');
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(4);
        });
    }
}

/**
 * Normalizes the `schema_version` table to its single-row shape and returns the
 * current schema version (0 if the table was just created or held no row).
 *
 * Single-row shape (review #5):
 *   schema_version(id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)
 *
 * Old shape that may already exist on disk:
 *   schema_version(version INTEGER NOT NULL)   -- no `id` column, no PK/UNIQUE
 *
 * Because `CREATE TABLE IF NOT EXISTS` is a no-op when a table already exists, an
 * old-shape table would silently survive. We therefore inspect the live columns
 * via PRAGMA table_info: if an `id` column is absent we read the highest stored
 * version (collapsing any duplicate rows the old shape allowed), drop the table,
 * recreate it single-row, and reinsert that version on the id=1 row. The whole
 * normalization is wrapped in a transaction so a crash cannot leave the table
 * dropped-but-not-recreated.
 */
function normalizeSchemaVersionTable(db: DatabaseSync): number {
    const columns = db.prepare('PRAGMA table_info(schema_version)').all() as Array<{ name: string }>;
    const tableExists = columns.length > 0;
    const hasIdColumn = columns.some((c) => c.name === 'id');

    if (tableExists && !hasIdColumn) {
        // Old shape detected: migrate in place, preserving the recorded version.
        const legacyRow = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null } | undefined;
        const legacyVersion = legacyRow && legacyRow.version !== null ? legacyRow.version : 0;
        db.exec('BEGIN');
        try {
            db.exec('DROP TABLE schema_version');
            db.exec('CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)');
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?)').run(legacyVersion);
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
        return legacyVersion;
    }

    // Fresh table (or already single-row): create-if-missing then read id=1.
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)');
    const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number } | undefined;
    return row ? row.version : 0;
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
 * SQL: INSERT INTO files (path, hash, last_indexed) VALUES (?, ?, ?)
 *      ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, last_indexed = excluded.last_indexed
 *
 * Update-style conflict handling on purpose (POLARIS Task 1.1, G12): the old
 * `INSERT OR REPLACE` implemented conflict as DELETE + INSERT, and with
 * foreign_keys=ON the delete CASCADEd through symbols (and from there through
 * every symbol-child table) — re-upserting a file's row silently destroyed
 * its children. Benign only while every caller happened to delete children
 * first; fatal for any file-keyed state that expects the row to be stable.
 * DO UPDATE mutates the existing row in place: child rows survive until the
 * explicit replacement transaction deletes them.
 */
export function upsertFile(conn: DbConnection, filePath: string, hash: string, lastIndexed: number): void {
    prepareOrCache(conn, 'INSERT INTO files (path, hash, last_indexed) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, last_indexed = excluded.last_indexed')
        .run(filePath, hash, lastIndexed);
}

/**
 * SQL: DELETE FROM imports WHERE file_path = ?
 *
 * Explicit replacement-clear for a file-FK'd fact table (POLARIS Task 1.1).
 * Before the non-destructive file upsert, `INSERT OR REPLACE INTO files`
 * implicitly cascade-cleared this table on every re-persist; the explicit
 * replacement transaction now owns that clear.
 */
export function deleteImportsByFile(conn: DbConnection, filePath: string): void {
    prepareOrCache(conn, 'DELETE FROM imports WHERE file_path = ?').run(filePath);
}

/**
 * SQL: DELETE FROM import_bindings WHERE file_path = ?
 * See {@link deleteImportsByFile} — same replacement-clear contract.
 */
export function deleteImportBindingsByFile(conn: DbConnection, filePath: string): void {
    prepareOrCache(conn, 'DELETE FROM import_bindings WHERE file_path = ?').run(filePath);
}

/**
 * SQL: DELETE FROM injections WHERE file_path = ?
 * See {@link deleteImportsByFile} — same replacement-clear contract.
 */
export function deleteInjectionsByFile(conn: DbConnection, filePath: string): void {
    prepareOrCache(conn, 'DELETE FROM injections WHERE file_path = ?').run(filePath);
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
export function findSymbolDetails(conn: DbConnection, name: string, kind: string): { file_path: string; line: number; end_line: number; kind: string; type: string | null }[] {
    return prepareOrCache(conn, 'SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ?')
        .all(name, kind) as { file_path: string; line: number; end_line: number; kind: string; type: string | null }[];
}

/**
 * SQL: SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ? AND file_path LIKE ?
 */
export function findSymbolDetailsScoped(conn: DbConnection, name: string, kind: string, filePrefix: string): { file_path: string; line: number; end_line: number; kind: string; type: string | null }[] {
    return prepareOrCache(conn, 'SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ? AND file_path LIKE ?')
        .all(name, kind, filePrefix) as { file_path: string; line: number; end_line: number; kind: string; type: string | null }[];
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

/**
 * Get all symbols (defs and refs) for a single file with the full
 * tree-sitter symbol shape: name, kind, type, line, endLine, column.
 *
 * SQL: SELECT name, kind, type, line, end_line AS endLine, column FROM
 *      symbols WHERE file_path = ? ORDER BY line
 *
 * This is the DB-backed counterpart to the tree-sitter `getSymbols()`
 * extractor — consumers should call `ensureIndexFresh()` first to
 * guarantee the rows reflect the current file content.
 */
export function getSymbolsInFile(
    conn: DbConnection,
    filePath: string
): Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }> {
    return prepareOrCache(
        conn,
        `SELECT name, kind, type, line, end_line AS endLine, column FROM symbols WHERE file_path = ? ORDER BY line`
    ).all(filePath) as Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }>;
}

/**
 * Find symbols by exact name within a single file, optionally filtered
 * by kind. Used by consumers that previously called the tree-sitter
 * `findSymbol()` extractor for single-file symbol lookup.
 *
 * SQL: SELECT name, kind, type, line, end_line AS endLine, column FROM
 *      symbols WHERE file_path = ? AND name = ? [AND kind = ?] ORDER BY line
 */
export function findSymbolsByNameInFile(
    conn: DbConnection,
    filePath: string,
    name: string,
    kindFilter?: string
): Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }> {
    let sql = `SELECT name, kind, type, line, end_line AS endLine, column FROM symbols WHERE file_path = ? AND name = ?`;
    const params: string[] = [filePath, name];
    if (kindFilter !== undefined) {
        sql += ' AND kind = ?';
        params.push(kindFilter);
    }
    sql += ' ORDER BY line';
    return prepareOrCache(conn, sql).all(...params) as Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }>;
}

// ---------------------------------------------------------------------------
// Edges Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO edges (container_def_id, referenced_name, reference_kind) VALUES (?, ?, ?)
 */
export function insertEdge(conn: DbConnection, containerDefId: number, referencedName: string, referenceKind: string = 'unknown'): void {
    prepareOrCache(conn, 'INSERT INTO edges (container_def_id, referenced_name, reference_kind) VALUES (?, ?, ?)')
        .run(containerDefId, referencedName, referenceKind);
}

/**
 * Get call graph edges between blocks in a single file.
 * Returns edges suitable for SageRank AST-aware ranking.
 * 
 * For each definition in the file that calls another definition in the same file,
 * returns an edge with:
 *   - from: index of caller in blockNames array
 *   - to: index of callee in blockNames array  
 *   - weight: 1.0 (or call count if multiple calls)
 *   - kind: 'call' | 'reference'
 * 
 * Also tracks external references (symbols called but not defined in this file).
 * 
 * SQL: 
 *   SELECT caller.name AS caller_name, e.referenced_name AS callee_name, COUNT(e.id) AS call_count
 *   FROM edges e
 *   JOIN symbols caller ON caller.id = e.container_def_id
 *   WHERE caller.file_path = ? AND caller.kind = 'def'
 *   GROUP BY caller.name, e.referenced_name
 */
export function getFileBlockEdges(
    conn: DbConnection,
    filePath: string,
    blockNames: string[]
): {
    edges: Array<{ from: number; to: number; weight: number; kind: 'call' | 'reference' }>;
    externalRefs: Array<{ from: number; name: string; count: number }>;
    stats: { internalEdges: number; externalRefs: number; totalCalls: number };
} {
    // Build name → index lookup
    const nameToIndex = new Map<string, number>();
    for (let i = 0; i < blockNames.length; i++) {
        const blockName = blockNames[i];
        if (blockName !== undefined) nameToIndex.set(blockName, i);
    }

    // Query all edges where the caller is a definition in this file
    const rows = prepareOrCache(
        conn,
        `SELECT caller.name AS caller_name, e.referenced_name AS callee_name, COUNT(e.id) AS call_count
         FROM edges e
         JOIN symbols caller ON caller.id = e.container_def_id
         WHERE caller.file_path = ? AND caller.kind = 'def'
         GROUP BY caller.name, e.referenced_name`
    ).all(filePath) as { caller_name: string; callee_name: string; call_count: number }[];

    const edges: Array<{ from: number; to: number; weight: number; kind: 'call' | 'reference' }> = [];
    const externalRefs: Array<{ from: number; name: string; count: number }> = [];
    let totalCalls = 0;

    for (const row of rows) {
        const fromIdx = nameToIndex.get(row.caller_name);
        const toIdx = nameToIndex.get(row.callee_name);
        totalCalls += row.call_count;

        if (fromIdx === undefined) {
            // Caller not in our block list (shouldn't happen but be defensive)
            continue;
        }

        if (toIdx !== undefined) {
            // Internal edge: both caller and callee are in our blocks
            edges.push({
                from: fromIdx,
                to: toIdx,
                weight: row.call_count, // Raw call count; sqrt damping is TOON's responsibility
                kind: 'call'
            });
        } else {
            // External reference: callee is not defined in this file
            externalRefs.push({
                from: fromIdx,
                name: row.callee_name,
                count: row.call_count
            });
        }
    }

    return {
        edges,
        externalRefs,
        stats: {
            internalEdges: edges.length,
            externalRefs: externalRefs.length,
            totalCalls
        }
    };
}

/**
 * Get definitions in a file with their line ranges.
 * Used to map tree-sitter blocks to symbol names.
 * 
 * SQL: SELECT id, name, line, end_line, type FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY line
 */
export function getFileDefinitions(
    conn: DbConnection,
    filePath: string
): Array<{ id: number; name: string; line: number; endLine: number; type: string | null }> {
    return prepareOrCache(
        conn,
        `SELECT id, name, line, end_line AS endLine, type FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY line`
    ).all(filePath) as Array<{ id: number; name: string; line: number; endLine: number; type: string | null }>;
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
// Project Observations — detection telemetry for promotion decisions.
// Lives in the GLOBAL DB. Detection records what it saw; promotion policy
// (ProjectContext) reads the distinct-session count. This is the
// instrumentation that justifies (or refutes) each auto-promotion.
// ---------------------------------------------------------------------------

/**
 * Creates table: project_observations(root_path PK, method, first_seen,
 * last_seen, session_count, last_session_id)
 */
export function initObservationSchema(conn: DbConnection): void {
    handle(conn).exec(`
        CREATE TABLE IF NOT EXISTS project_observations (
            root_path TEXT PRIMARY KEY,
            method TEXT NOT NULL,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            session_count INTEGER NOT NULL DEFAULT 1,
            last_session_id TEXT NOT NULL
        );
    `);
}

/**
 * Record a detection of an unregistered project root and return the number
 * of DISTINCT sessions it has now been observed in. The distinct-session
 * approximation: the counter only increments when the recording session
 * differs from the last one recorded — repeat observations within one
 * session are idempotent.
 */
export function recordProjectObservation(
    conn: DbConnection,
    entry: { rootPath: string; method: string; sessionId: string; now?: number }
): number {
    const now = entry.now ?? Date.now();
    const existing = prepareOrCache(
        conn,
        'SELECT session_count, last_session_id FROM project_observations WHERE root_path = ?'
    ).get(entry.rootPath) as { session_count: number; last_session_id: string } | undefined;

    if (!existing) {
        prepareOrCache(
            conn,
            'INSERT INTO project_observations (root_path, method, first_seen, last_seen, session_count, last_session_id) VALUES (?, ?, ?, ?, 1, ?)'
        ).run(entry.rootPath, entry.method, now, now, entry.sessionId);
        return 1;
    }

    const count = existing.last_session_id === entry.sessionId
        ? existing.session_count
        : existing.session_count + 1;
    prepareOrCache(
        conn,
        'UPDATE project_observations SET method = ?, last_seen = ?, session_count = ?, last_session_id = ? WHERE root_path = ?'
    ).run(entry.method, now, count, entry.sessionId, entry.rootPath);
    return count;
}

/**
 * SQL: SELECT * FROM project_observations ORDER BY last_seen DESC
 */
export function listProjectObservations(conn: DbConnection): {
    root_path: string; method: string; first_seen: number;
    last_seen: number; session_count: number; last_session_id: string;
}[] {
    return prepareOrCache(conn, 'SELECT * FROM project_observations ORDER BY last_seen DESC')
        .all() as {
            root_path: string; method: string; first_seen: number;
            last_seen: number; session_count: number; last_session_id: string;
        }[];
}

// ---------------------------------------------------------------------------
// Global legacy-row handling (POLARIS Task 1.4, Decision 21)
// ---------------------------------------------------------------------------

/**
 * SQL: SELECT path FROM files WHERE path NOT LIKE 'g/%'
 *
 * Legacy (unprefixed) rows in the GLOBAL store: rows written before global
 * symbol addressing existed. They take one of three explicit paths — none,
 * provable transactional rewrite, or preserved-but-quarantined — decided by
 * ProjectContext; this is the detection read.
 */
export function getLegacyGlobalFilePaths(conn: DbConnection): string[] {
    return (prepareOrCache(conn, "SELECT path FROM files WHERE path NOT LIKE 'g/%'")
        .all() as { path: string }[]).map((r) => r.path);
}

/**
 * Transactionally rewrite legacy global rows onto their proven `g/<hash>/`
 * keys (POLARIS Task 1.4, Decision 21 step 4). One outer transaction:
 * insert the new files parents, re-point every v4 path-bearing child table
 * (symbols, imports, import_bindings, injections) plus versions, delete the
 * old files rows, then run a foreign-key check — any inconsistency throws
 * and rolls the whole rewrite back. Aborts (without writing) if any target
 * key already exists.
 *
 * Tables added in v5/v6 participate once they exist — this function is the
 * single place that list lives.
 */
export function rewriteLegacyGlobalRows(
    conn: DbConnection,
    mapping: ReadonlyArray<{ oldKey: string; newKey: string }>
): void {
    if (mapping.length === 0) return;
    runTransaction(conn, () => {
        // Abort on any duplicate target BEFORE writing anything.
        for (const { newKey } of mapping) {
            const existing = prepareOrCache(conn, 'SELECT path FROM files WHERE path = ?').get(newKey);
            if (existing) {
                throw new Error(`LEGACY_GLOBAL_COLLISION: target key already exists: ${newKey}`);
            }
        }
        for (const { oldKey, newKey } of mapping) {
            const parent = prepareOrCache(conn, 'SELECT hash, last_indexed FROM files WHERE path = ?')
                .get(oldKey) as { hash: string | null; last_indexed: number | null } | undefined;
            if (!parent) {
                throw new Error(`LEGACY_GLOBAL_MISSING: legacy files row disappeared mid-rewrite: ${oldKey}`);
            }
            prepareOrCache(conn, 'INSERT INTO files (path, hash, last_indexed) VALUES (?, ?, ?)')
                .run(newKey, parent.hash, parent.last_indexed);
            prepareOrCache(conn, 'UPDATE symbols SET file_path = ? WHERE file_path = ?').run(newKey, oldKey);
            prepareOrCache(conn, 'UPDATE imports SET file_path = ? WHERE file_path = ?').run(newKey, oldKey);
            prepareOrCache(conn, 'UPDATE import_bindings SET file_path = ? WHERE file_path = ?').run(newKey, oldKey);
            prepareOrCache(conn, 'UPDATE injections SET file_path = ? WHERE file_path = ?').run(newKey, oldKey);
            prepareOrCache(conn, 'UPDATE versions SET file_path = ? WHERE file_path = ?').run(newKey, oldKey);
            prepareOrCache(conn, 'DELETE FROM files WHERE path = ?').run(oldKey);
        }
        // FK/integrity verification before commit (Decision 21): a violation
        // throws, runTransaction rolls the whole rewrite back.
        const violations = handle(conn).prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
            throw new Error(`LEGACY_GLOBAL_FK_VIOLATION: ${JSON.stringify(violations.slice(0, 3))}`);
        }
    });
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
        let changesBefore = 0;
        if (depth === 0) {
            changesBefore = totalChanges(conn);
            db.exec('BEGIN');
        } else {
            db.exec(`SAVEPOINT sp_${depth}`);
        }
        started = true;
        fn();
        if (depth === 0) {
            db.exec('COMMIT');
            // POLARIS Decision 16: the connection-local outer-commit
            // generation increments only here — after a real outer COMMIT
            // that actually wrote rows (total_changes moved). Read-only
            // transactions, savepoint releases, and rollbacks (both catch
            // arms below) never increment it. Together with PRAGMA
            // data_version (blind to same-connection commits), this pair
            // forms the session fact epoch read by getFactEpoch.
            if (totalChanges(conn) !== changesBefore) {
                _commitGenerations.set(conn, (_commitGenerations.get(conn) ?? 0) + 1);
            }
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

// ---------------------------------------------------------------------------
// POLARIS session fact epoch (Task 2.1, Decision 16)
// ---------------------------------------------------------------------------

const _commitGenerations = new WeakMap<DbConnection, number>();

/** Cumulative rows written by this connection (SQLite total_changes()). */
function totalChanges(conn: DbConnection): number {
    const row = handle(conn).prepare('SELECT total_changes() AS tc').get() as { tc?: number } | undefined;
    return typeof row?.tc === 'number' ? row.tc : 0;
}

export interface FactEpoch {
    /** PRAGMA data_version — moves when ANOTHER connection commits. */
    dataVersion: number;
    /** Row-writing outer commits on THIS connection via runTransaction. */
    commitGeneration: number;
}

/**
 * Read the two-part fact epoch for a connection. Neither half alone is
 * sufficient: data_version never moves for the connection's own commits, and
 * the commit generation never moves for another connection's. Sessions pin
 * the pair at open and revalidate it at every query/page entry.
 *
 * Blind spot (deliberate, documented): a single-statement autocommit write on
 * this connection that bypasses runTransaction moves neither half. Production
 * fact mutations all flow through runTransaction; sessions additionally
 * revalidate their pinned scope hash view (getScopeFileHashView), which
 * catches any such write to the files table.
 */
export function getFactEpoch(conn: DbConnection): FactEpoch {
    const row = handle(conn).prepare('PRAGMA data_version').get() as { data_version?: number } | undefined;
    const dataVersion = typeof row?.data_version === 'number' ? row.data_version : 0;
    return { dataVersion, commitGeneration: _commitGenerations.get(conn) ?? 0 };
}

/**
 * Canonical (path, hash) view of every files row whose store key starts with
 * scopePrefix, in raw binary path order. scopePrefix must be '' (everything —
 * project-mode whole store) or end with '/'. The upper bound replaces the
 * final '/' (0x2F) with '0' (0x30), which is binary-correct for UTF-8 keys.
 * Sessions use this for the pinned source-domain digest and its per-call
 * revalidation; composers never receive it.
 */
export function getScopeFileHashView(
    conn: DbConnection,
    scopePrefix: string,
): { path: string; hash: string }[] {
    if (scopePrefix === '') {
        return queryRaw(conn, 'SELECT path, hash FROM files ORDER BY path') as { path: string; hash: string }[];
    }
    if (!scopePrefix.endsWith('/')) {
        throw new Error(`getScopeFileHashView: scopePrefix must be '' or end with '/', got ${JSON.stringify(scopePrefix)}`);
    }
    const upper = scopePrefix.slice(0, -1) + '0';
    return queryRaw(
        conn,
        'SELECT path, hash FROM files WHERE path >= ? AND path < ? ORDER BY path',
        scopePrefix,
        upper,
    ) as { path: string; hash: string }[];
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

// ---------------------------------------------------------------------------
// Symbol Extended Columns (v0 → v1)
// ---------------------------------------------------------------------------

/**
 * SQL: UPDATE symbols SET capture_tag = ?, body_hash = ?, parent_symbol_id = ?, visibility = ? WHERE id = ?
 */
export function updateSymbolExtras(
    conn: DbConnection,
    symbolId: number,
    extras: { captureTag?: string | null; bodyHash?: string | null; parentSymbolId?: number | null; visibility?: string | null }
): void {
    prepareOrCache(conn,
        'UPDATE symbols SET capture_tag = ?, body_hash = ?, parent_symbol_id = ?, visibility = ? WHERE id = ?'
    ).run(extras.captureTag ?? null, extras.bodyHash ?? null, extras.parentSymbolId ?? null, extras.visibility ?? null, symbolId);
}

// ---------------------------------------------------------------------------
// Symbol Structures Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT OR REPLACE INTO symbol_structures (symbol_id, params_json, return_text, decorators_json, modifiers_json, generics_text, parent_kind, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 */
export function insertSymbolStructure(
    conn: DbConnection,
    row: { symbolId: number; paramsJson: string; returnText: string | null; decoratorsJson: string; modifiersJson: string; genericsText: string | null; parentKind: string | null; parentName: string | null }
): void {
    prepareOrCache(conn,
        'INSERT OR REPLACE INTO symbol_structures (symbol_id, params_json, return_text, decorators_json, modifiers_json, generics_text, parent_kind, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.symbolId, row.paramsJson, row.returnText, row.decoratorsJson, row.modifiersJson, row.genericsText, row.parentKind, row.parentName);
}

export interface SymbolStructureRow {
    symbol_id: number;
    params: string[];
    returnText: string | null;
    decorators: string[];
    modifiers: string[];
    genericsText: string | null;
    parentKind: string | null;
    parentName: string | null;
}

/**
 * A structure row whose persisted JSON is unreadable. Typed so consumers can
 * fail loudly and trigger exactly one reindex correction — corruption must
 * never be observable as an empty shape (POLARIS Task 1.1).
 */
export interface SymbolStructureCorruption {
    rowId: number;           // symbol_structures.symbol_id of the corrupt row
    filePath: string | null; // owning symbol's file, when the join resolves
    line: number | null;     // owning symbol's line, when the join resolves
    detail: string;          // which column failed and why
}

export type StructureReadResult =
    | { status: 'ok'; structure: SymbolStructureRow }
    | { status: 'missing' }
    | { status: 'corrupt'; corruption: SymbolStructureCorruption };

/**
 * Parse one persisted JSON list column. NULL/empty means "no entries" (the
 * writer's legitimate absent value); anything else must parse to an array.
 * Returns null exactly when the stored text is corrupt for this column.
 */
function parseStructureListColumn(raw: string | null): string[] | null {
    if (raw === null || raw === '') return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    return parsed as string[];
}

interface RawStructureJoinRow {
    symbol_id: number;
    params_json: string | null;
    return_text: string | null;
    decorators_json: string | null;
    modifiers_json: string | null;
    generics_text: string | null;
    parent_kind: string | null;
    parent_name: string | null;
    file_path: string | null;
    line: number | null;
}

function decodeStructureRow(row: RawStructureJoinRow):
    | { status: 'ok'; structure: SymbolStructureRow }
    | { status: 'corrupt'; corruption: SymbolStructureCorruption } {
    const columns: Array<['params_json' | 'decorators_json' | 'modifiers_json', string]> = [
        ['params_json', 'params_json'],
        ['decorators_json', 'decorators_json'],
        ['modifiers_json', 'modifiers_json'],
    ];
    const decoded: Record<string, string[]> = {};
    for (const [column] of columns) {
        const parsed = parseStructureListColumn(row[column]);
        if (parsed === null) {
            return {
                status: 'corrupt',
                corruption: {
                    rowId: row.symbol_id,
                    filePath: row.file_path,
                    line: row.line,
                    detail: `${column} is not a JSON array: ${String(row[column]).slice(0, 120)}`,
                },
            };
        }
        decoded[column] = parsed;
    }
    return {
        status: 'ok',
        structure: {
            symbol_id: row.symbol_id,
            params: decoded['params_json'] ?? [],
            returnText: row.return_text,
            decorators: decoded['decorators_json'] ?? [],
            modifiers: decoded['modifiers_json'] ?? [],
            genericsText: row.generics_text,
            parentKind: row.parent_kind,
            parentName: row.parent_name,
        },
    };
}

/**
 * SQL: SELECT ss.*, s.file_path, s.line FROM symbol_structures ss
 *      LEFT JOIN symbols s ON s.id = ss.symbol_id WHERE ss.symbol_id = ?
 *
 * Typed read (POLARIS Task 1.1): `ok | missing | corrupt`. Corrupt JSON is
 * reported with row/file/line/detail — never silently coerced to an empty
 * shape.
 */
export function readSymbolStructure(conn: DbConnection, symbolId: number): StructureReadResult {
    const row = prepareOrCache(conn,
        'SELECT ss.symbol_id, ss.params_json, ss.return_text, ss.decorators_json, ss.modifiers_json, ss.generics_text, ss.parent_kind, ss.parent_name, s.file_path, s.line FROM symbol_structures ss LEFT JOIN symbols s ON s.id = ss.symbol_id WHERE ss.symbol_id = ?'
    ).get(symbolId) as RawStructureJoinRow | undefined;
    if (!row) return { status: 'missing' };
    return decodeStructureRow(row);
}

/**
 * Compatibility surface over {@link readSymbolStructure}: missing -> null.
 * Corrupt rows THROW with full row context — the pre-Task-1.1 behavior was a
 * raw SyntaxError from JSON.parse with no row identity; the defect class
 * ("observed as [] / null") is impossible through either function.
 */
export function getSymbolStructure(conn: DbConnection, symbolId: number): SymbolStructureRow | null {
    const result = readSymbolStructure(conn, symbolId);
    if (result.status === 'missing') return null;
    if (result.status === 'corrupt') {
        const c = result.corruption;
        throw new Error(`STRUCTURE_CORRUPT: symbol_structures row ${c.rowId} (${c.filePath ?? 'unknown file'}:${c.line ?? '?'}): ${c.detail}`);
    }
    return result.structure;
}

/**
 * SQL: SELECT ss.*, s.file_path, s.line, s.end_line FROM symbol_structures ss JOIN symbols s ON s.id = ss.symbol_id WHERE s.name = ? AND s.kind = 'def' [AND s.type = ?]
 *
 * Typed read (POLARIS Task 1.1): readable rows land in `rows`; unreadable
 * rows land in `corrupt` with row/file/line/detail. Callers on refactor
 * paths must treat a non-empty `corrupt` list as a loud condition: reindex
 * the named files once, re-read, and fail if corruption persists — never
 * proceed as if the facts were absent.
 */
export function findSymbolStructuresByName(conn: DbConnection, name: string, kind?: string): {
    rows: Array<SymbolStructureRow & { file_path: string; line: number; end_line: number }>;
    corrupt: SymbolStructureCorruption[];
} {
    let sql = `SELECT ss.symbol_id, ss.params_json, ss.return_text, ss.decorators_json, ss.modifiers_json, ss.generics_text, ss.parent_kind, ss.parent_name, s.file_path, s.line, s.end_line FROM symbol_structures ss JOIN symbols s ON s.id = ss.symbol_id WHERE s.name = ? AND s.kind = 'def'`;
    const params: string[] = [name];
    if (kind) { sql += ' AND s.type = ?'; params.push(kind); }
    // NOTE (v3 remediation): use prepareOrCache for uniformity with every other
    // adapter function in this file. Dynamic SQL is still cached — the cache key is
    // the final SQL string, so the 1-param and 2-param shapes get distinct slots.
    // The INNER JOIN guarantees file_path/line/end_line are present on every row.
    const raw = prepareOrCache(conn, sql).all(...params) as unknown as Array<RawStructureJoinRow & { file_path: string; line: number; end_line: number }>;
    const rows: Array<SymbolStructureRow & { file_path: string; line: number; end_line: number }> = [];
    const corrupt: SymbolStructureCorruption[] = [];
    for (const row of raw) {
        const decoded = decodeStructureRow(row);
        if (decoded.status === 'corrupt') {
            corrupt.push(decoded.corruption);
            continue;
        }
        rows.push({ ...decoded.structure, file_path: row.file_path, line: row.line, end_line: row.end_line });
    }
    return { rows, corrupt };
}

// ---------------------------------------------------------------------------
// Anchors Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO anchors (symbol_id, kind, line, end_line, text) VALUES (?, ?, ?, ?, ?)
 */
export function insertAnchor(conn: DbConnection, row: { symbolId: number; kind: string; line: number; endLine?: number; text: string }): void {
    const endLine = row.endLine ?? row.line;
    prepareOrCache(conn, 'INSERT INTO anchors (symbol_id, kind, line, end_line, text) VALUES (?, ?, ?, ?, ?)').run(row.symbolId, row.kind, row.line, endLine, row.text);
}

/**
 * SQL: SELECT a.symbol_id, s.name AS symbol_name, a.kind, a.line, COALESCE(a.end_line, a.line) AS endLine, a.text FROM anchors a JOIN symbols s ON s.id = a.symbol_id WHERE s.file_path = ? ORDER BY a.line
 */
export function getAnchorsForFile(conn: DbConnection, filePath: string): Array<{ symbol_id: number; symbol_name: string; kind: string; line: number; endLine: number; text: string }> {
    return prepareOrCache(conn, `SELECT a.symbol_id, s.name AS symbol_name, a.kind, a.line, COALESCE(a.end_line, a.line) AS endLine, a.text FROM anchors a JOIN symbols s ON s.id = a.symbol_id WHERE s.file_path = ? ORDER BY a.line`).all(filePath) as Array<{ symbol_id: number; symbol_name: string; kind: string; line: number; endLine: number; text: string }>;
}

// ---------------------------------------------------------------------------
// Imports Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO imports (file_path, module, imported_names_json, line, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)
 */
export function insertImport(conn: DbConnection, row: { filePath: string; module: string; importedNamesJson: string; line: number; startLine?: number; endLine?: number }): void {
    const startLine = row.startLine ?? row.line;
    const endLine = row.endLine ?? row.line;
    prepareOrCache(conn, 'INSERT INTO imports (file_path, module, imported_names_json, line, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.filePath, row.module, row.importedNamesJson, row.line, startLine, endLine);
}

/**
 * SQL: SELECT module, imported_names_json, line, COALESCE(start_line, line) AS startLine, COALESCE(end_line, line) AS endLine FROM imports WHERE file_path = ? ORDER BY startLine, line
 */
export function getImportsForFile(conn: DbConnection, filePath: string): Array<{ module: string; importedNames: string[]; line: number; startLine: number; endLine: number }> {
    const rows = prepareOrCache(conn, 'SELECT module, imported_names_json, line, COALESCE(start_line, line) AS startLine, COALESCE(end_line, line) AS endLine FROM imports WHERE file_path = ? ORDER BY startLine, line').all(filePath) as Array<{ module: string; imported_names_json: string; line: number; startLine: number; endLine: number }>;
    return rows.map(r => ({ module: r.module, importedNames: JSON.parse(r.imported_names_json || '[]'), line: r.line, startLine: r.startLine, endLine: r.endLine }));
}

export type ImportBindingKind = 'named' | 'default' | 'namespace';

/**
 * SQL: INSERT INTO import_bindings (file_path, source, local_name, imported_name, import_kind, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 */
export function insertImportBinding(conn: DbConnection, row: { filePath: string; source: string; localName: string; importedName: string | null; importKind: ImportBindingKind; isTypeOnly: boolean; line: number; column: number }): void {
    prepareOrCache(conn, `INSERT INTO import_bindings
        (file_path, source, local_name, imported_name, import_kind, is_type_only, line, column)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.filePath, row.source, row.localName, row.importedName, row.importKind, row.isTypeOnly ? 1 : 0, row.line, row.column);
}

/**
 * SQL: SELECT source, local_name AS localName, imported_name AS importedName, import_kind AS importKind, is_type_only AS isTypeOnly, line, column FROM import_bindings WHERE file_path = ? ORDER BY line, column
 */
export function getImportBindingsForFile(conn: DbConnection, filePath: string): Array<{ source: string; localName: string; importedName: string | null; importKind: ImportBindingKind; isTypeOnly: boolean; line: number; column: number }> {
    const rows = prepareOrCache(conn,
        `SELECT source, local_name AS localName, imported_name AS importedName,
                import_kind AS importKind, is_type_only AS isTypeOnly, line, column
         FROM import_bindings
         WHERE file_path = ?
         ORDER BY line, column`
    ).all(filePath) as Array<{ source: string; localName: string; importedName: string | null; importKind: ImportBindingKind; isTypeOnly: number; line: number; column: number }>;
    return rows.map(r => ({
        source: r.source,
        localName: r.localName,
        importedName: r.importedName,
        importKind: r.importKind,
        isTypeOnly: r.isTypeOnly !== 0,
        line: r.line,
        column: r.column,
    }));
}

/**
 * SQL: SELECT DISTINCT file_path FROM imports WHERE module = ?
 */
export function getFilesImporting(conn: DbConnection, module: string): { file_path: string }[] {
    return prepareOrCache(conn, 'SELECT DISTINCT file_path FROM imports WHERE module = ?').all(module) as { file_path: string }[];
}

// ---------------------------------------------------------------------------
// Injections Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO injections (file_path, host_lang, injected_lang, start_line, end_line, start_byte, end_byte) VALUES (?, ?, ?, ?, ?, ?, ?)
 */
export function insertInjection(conn: DbConnection, row: { filePath: string; hostLang: string; injectedLang: string; startLine: number; endLine: number; startByte: number; endByte: number }): void {
    prepareOrCache(conn, 'INSERT INTO injections (file_path, host_lang, injected_lang, start_line, end_line, start_byte, end_byte) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.filePath, row.hostLang, row.injectedLang, row.startLine, row.endLine, row.startByte, row.endByte);
}

/**
 * SQL: SELECT host_lang, injected_lang, start_line, end_line, start_byte, end_byte FROM injections WHERE file_path = ?
 */
export function getInjectionsForFile(conn: DbConnection, filePath: string): Array<{ host_lang: string; injected_lang: string; start_line: number; end_line: number; start_byte: number; end_byte: number }> {
    return prepareOrCache(conn, 'SELECT host_lang, injected_lang, start_line, end_line, start_byte, end_byte FROM injections WHERE file_path = ?').all(filePath) as Array<{ host_lang: string; injected_lang: string; start_line: number; end_line: number; start_byte: number; end_byte: number }>;
}

// ---------------------------------------------------------------------------
// Local Scopes Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO local_scopes (symbol_id, scope_kind, start_line, end_line, parameters_json, locals_json) VALUES (?, ?, ?, ?, ?, ?)
 */
export function insertLocalScope(conn: DbConnection, row: { symbolId: number | null; scopeKind: string; startLine: number; endLine: number; parametersJson: string; localsJson: string }): void {
    prepareOrCache(conn, 'INSERT INTO local_scopes (symbol_id, scope_kind, start_line, end_line, parameters_json, locals_json) VALUES (?, ?, ?, ?, ?, ?)').run(row.symbolId, row.scopeKind, row.startLine, row.endLine, row.parametersJson, row.localsJson);
}

/**
 * SQL: SELECT scope_kind, start_line, end_line, parameters_json, locals_json FROM local_scopes WHERE symbol_id = ?
 */
export function getLocalScopesForSymbol(conn: DbConnection, symbolId: number): Array<{ scope_kind: string; start_line: number; end_line: number; parameters: unknown[]; locals: unknown[] }> {
    const rows = prepareOrCache(conn, 'SELECT scope_kind, start_line, end_line, parameters_json, locals_json FROM local_scopes WHERE symbol_id = ?').all(symbolId) as Array<{ scope_kind: string; start_line: number; end_line: number; parameters_json: string; locals_json: string }>;
    return rows.map(r => ({ scope_kind: r.scope_kind, start_line: r.start_line, end_line: r.end_line, parameters: JSON.parse(r.parameters_json || '[]'), locals: JSON.parse(r.locals_json || '[]') }));
}

// ---------------------------------------------------------------------------
// Edge Resolution (callee_symbol_id)
// ---------------------------------------------------------------------------

/** Chunk size for name-list SQL (POLARIS Decision 22: SQL ID chunks 100). */
const NAME_CHUNK_SIZE = 100;

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
    for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size) as T[];
}

/**
 * SQL: SELECT DISTINCT name FROM symbols WHERE file_path = ? AND kind = 'def'
 *
 * The "old definition names" read of the affected-name resolution protocol
 * (POLARIS Task 1.3): captured BEFORE a file's facts are replaced so the
 * union of old and new definition names can drive the stale-target clear.
 */
export function getDefinitionNamesByFile(conn: DbConnection, filePath: string): string[] {
    return (prepareOrCache(conn, "SELECT DISTINCT name FROM symbols WHERE file_path = ? AND kind = 'def'")
        .all(filePath) as { name: string }[]).map((r) => r.name);
}

/**
 * SQL (per 100-name chunk):
 *   UPDATE edges SET callee_symbol_id = NULL
 *   WHERE (referenced_name IN (…)
 *          OR callee_symbol_id IN (SELECT id FROM symbols WHERE kind = 'def' AND name IN (…)))
 *     AND (referenced_name IN (…) OR callee_symbol_id IS NOT NULL)
 *   RETURNING referenced_name
 *
 * The affected-name CLEAR (POLARIS Task 1.3). Two match arms on purpose:
 *   (a) edges that REFERENCE a changed name directly — their resolution (or
 *       lack of one) must be recomputed against the new definition set;
 *   (b) edges currently RESOLVED TO a definition bearing a changed name —
 *       this catches dot-qualified references (`Outer.method`) whose
 *       referenced_name would never equal the bare changed name but whose
 *       target just gained or lost a competitor.
 * Returns the DISTINCT referenced names of every edge it touched so the
 * caller can re-resolve exactly the affected groups — a cleared edge must
 * never be left owed inside the same transaction.
 */
export function clearEdgeTargetsByNames(conn: DbConnection, names: readonly string[]): string[] {
    const touched = new Set<string>();
    for (const chunk of chunks(names, NAME_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = prepareOrCache(
            conn,
            `UPDATE edges SET callee_symbol_id = NULL
             WHERE referenced_name IN (${placeholders})
                OR callee_symbol_id IN (SELECT id FROM symbols WHERE kind = 'def' AND name IN (${placeholders}))
             RETURNING referenced_name`
        ).all(...chunk, ...chunk) as { referenced_name: string }[];
        for (const row of rows) touched.add(row.referenced_name);
    }
    return [...touched];
}

/**
 * SQL (per 100-name chunk):
 *   SELECT e.id, e.referenced_name, s.file_path AS caller_file_path
 *   FROM edges e JOIN symbols s ON s.id = e.container_def_id
 *   WHERE e.callee_symbol_id IS NULL AND e.referenced_name IN (…)
 *
 * Unresolved edges restricted to an affected-name set (POLARIS Task 1.3) —
 * the read behind the affected-name resolver entry, so re-resolution work
 * scales with the edit's blast radius instead of the whole database.
 */
export function getUnresolvedEdgesByNames(
    conn: DbConnection,
    names: readonly string[]
): Array<{ id: number; referenced_name: string; caller_file_path: string }> {
    const out: Array<{ id: number; referenced_name: string; caller_file_path: string }> = [];
    for (const chunk of chunks(names, NAME_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = prepareOrCache(
            conn,
            `SELECT e.id, e.referenced_name, s.file_path AS caller_file_path
             FROM edges e JOIN symbols s ON s.id = e.container_def_id
             WHERE e.callee_symbol_id IS NULL AND e.referenced_name IN (${placeholders})`
        ).all(...chunk) as Array<{ id: number; referenced_name: string; caller_file_path: string }>;
        out.push(...rows);
    }
    return out;
}

/**
 * SQL: SELECT e.id, e.referenced_name FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.file_path = ? AND e.callee_symbol_id IS NULL
 */
export function getUnresolvedEdges(conn: DbConnection, filePath: string): Array<{ id: number; referenced_name: string }> {
    return prepareOrCache(conn, `SELECT e.id, e.referenced_name FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.file_path = ? AND e.callee_symbol_id IS NULL`).all(filePath) as Array<{ id: number; referenced_name: string }>;
}

/**
 * Whole-DB counterpart to getUnresolvedEdges (review #18, "Performance Is
 * Correctness"): returns EVERY unresolved edge in one query so the resolver can
 * sweep the entire database in a single pass instead of re-querying per file
 * (the N+1 the per-file loop caused). The "unresolved" predicate mirrors
 * getUnresolvedEdges exactly — `e.callee_symbol_id IS NULL` — minus the
 * per-file filter. The container symbol's file_path is projected as
 * `caller_file_path` so scope-aware resolution (#17) can prefer same-file
 * callees without a second query per edge.
 *
 * SQL: SELECT e.id, e.referenced_name, s.file_path AS caller_file_path FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.callee_symbol_id IS NULL
 */
export function getAllUnresolvedEdges(conn: DbConnection): Array<{ id: number; referenced_name: string; caller_file_path: string }> {
    return prepareOrCache(conn, `SELECT e.id, e.referenced_name, s.file_path AS caller_file_path FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.callee_symbol_id IS NULL`).all() as Array<{ id: number; referenced_name: string; caller_file_path: string }>;
}

/**
 * SQL: SELECT id FROM symbols WHERE name = ? AND kind = ? LIMIT 2
 * Returns the single matching id, or null if zero or more than one match.
 */
export function findSymbolByNameUnique(conn: DbConnection, name: string, kind: string): { id: number } | null {
    const rows = prepareOrCache(conn, 'SELECT id FROM symbols WHERE name = ? AND kind = ? LIMIT 2').all(name, kind) as { id: number }[];
    if (rows.length !== 1) return null;
    return rows[0] ?? null;
}

/**
 * Non-unique counterpart to findSymbolByNameUnique: returns EVERY def (or
 * other-kind) symbol matching `name`, with its id and file_path. No LIMIT — the
 * full candidate set is intentionally returned so Wave B's resolver (review
 * #16/#17) can do scope-aware and dot-qualified disambiguation in TypeScript
 * (e.g. prefer the same-file/module callee, or filter by parent == qualifier).
 *
 * SQL: SELECT id, file_path AS filePath FROM symbols WHERE name = ? AND kind = ?
 */
export function findDefsByName(conn: DbConnection, name: string, kind = 'def'): { id: number; filePath: string }[] {
    return prepareOrCache(conn, 'SELECT id, file_path AS filePath FROM symbols WHERE name = ? AND kind = ?')
        .all(name, kind) as { id: number; filePath: string }[];
}

/**
 * Look up the parent definition of a symbol via parent_symbol_id.
 * Used by resolve.ts to enforce the strict dot-qualified rule:
 *   "Foo.bar" only links if shortTarget(bar).parent.name === "Foo".
 * Returns null if the symbol has no parent or the parent row is missing.
 */
export function findSymbolParent(conn: DbConnection, symbolId: number): { id: number; name: string } | null {
    const row = prepareOrCache(conn,
        'SELECT p.id AS id, p.name AS name FROM symbols c JOIN symbols p ON p.id = c.parent_symbol_id WHERE c.id = ?'
    ).get(symbolId) as { id: number; name: string } | undefined;
    return row ?? null;
}

/**
 * SQL: UPDATE edges SET callee_symbol_id = ? WHERE id = ?
 */
export function updateEdgeCalleeSymbol(conn: DbConnection, edgeId: number, calleeSymbolId: number): void {
    prepareOrCache(conn, 'UPDATE edges SET callee_symbol_id = ? WHERE id = ?').run(calleeSymbolId, edgeId);
}

// ---------------------------------------------------------------------------
// Aggregate Facts Read (for TOON integration)
// ---------------------------------------------------------------------------

export interface FileFacts {
    // NOTE: defs carries `captureTag` so the compression seam can forward it to
    // zenith-toon without a second query. Sourced from the v0→v1 `capture_tag`
    // column on `symbols`.
    defs: Array<{ id: number; name: string; line: number; endLine: number; type: string | null; visibility: string | null; captureTag: string | null }>;
    references: Array<{ name: string; type: string | null; line: number; endLine: number; column: number }>;
    edges: Array<{ callerLine: number; calleeLine: number; callCount: number }>;
    referenceEdges: Array<{ callerLine: number; referencedName: string; referenceKind: string; referenceCount: number }>;
    anchors: Array<{ symbol_name: string; kind: string; line: number; endLine: number; text: string }>;
    imports: Array<{ module: string; importedNames: string[]; line: number; startLine: number; endLine: number }>;
    importBindings: Array<{ source: string; localName: string; importedName: string | null; importKind: ImportBindingKind; isTypeOnly: boolean; line: number; column: number }>;
    injections: Array<{ injected_lang: string; start_line: number; end_line: number }>;
    // CASING WARNING (C3): these fields are camelCase (scopeKind/startLine/endLine) and MUST stay
    // character-identical to compression.ts's `.map` reads in T4 AND to the SELECT aliases in
    // getFileFacts below. A snake_case alias on the query + a camelCase read = silently empty
    // scopes with NO build error and NO test error. scopes are camelCase end-to-end.
    scopes: Array<{ scopeKind: string; startLine: number; endLine: number }>;
}

export function getFileFacts(conn: DbConnection, filePath: string): FileFacts {
    const defs = prepareOrCache(conn,
        `SELECT id, name, line, end_line AS endLine, type, visibility, capture_tag AS captureTag
         FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY line`
    ).all(filePath) as FileFacts['defs'];
    const references = prepareOrCache(conn,
        `SELECT name, type, line, end_line AS endLine, column
         FROM symbols WHERE file_path = ? AND kind = 'ref' ORDER BY line, column`
    ).all(filePath) as FileFacts['references'];
    // Resolved, line-keyed edges (Phase 4): join BOTH endpoints to symbols — caller
    // via container_def_id, callee via the RESOLVED callee_symbol_id — and return each
    // endpoint's line. The INNER JOIN on callee_symbol_id drops still-unresolved edges
    // (NULL callee); callee.file_path = ? drops cross-file edges. Both exclusions are
    // intended: TOON ranks within-file structure. GROUP BY the two symbol IDENTITIES
    // (not names) so two distinct defs sharing a name can never collapse into one edge.
    const edges = prepareOrCache(conn,
        `SELECT caller.line AS callerLine, callee.line AS calleeLine, COUNT(e.id) AS callCount
         FROM edges e
         JOIN symbols caller ON caller.id = e.container_def_id
         JOIN symbols callee ON callee.id = e.callee_symbol_id
         WHERE caller.file_path = ? AND callee.file_path = ? AND caller.kind = 'def'
         GROUP BY caller.id, callee.id`
    ).all(filePath, filePath) as FileFacts['edges'];
    const referenceEdges = prepareOrCache(conn,
        `SELECT caller.line AS callerLine, e.referenced_name AS referencedName,
                e.reference_kind AS referenceKind, COUNT(e.id) AS referenceCount
         FROM edges e
         JOIN symbols caller ON caller.id = e.container_def_id
         WHERE caller.file_path = ? AND caller.kind = 'def'
         GROUP BY caller.id, e.referenced_name, e.reference_kind
         ORDER BY caller.line, e.referenced_name, e.reference_kind`
    ).all(filePath) as FileFacts['referenceEdges'];
    const anchors = prepareOrCache(conn, `SELECT s.name AS symbol_name, a.kind, a.line, COALESCE(a.end_line, a.line) AS endLine, a.text FROM anchors a JOIN symbols s ON s.id = a.symbol_id WHERE s.file_path = ? ORDER BY a.line`).all(filePath) as FileFacts['anchors'];
    const imports = getImportsForFile(conn, filePath);
    const importBindings = getImportBindingsForFile(conn, filePath);
    const injections = prepareOrCache(conn, `SELECT injected_lang, start_line, end_line FROM injections WHERE file_path = ?`).all(filePath) as FileFacts['injections'];
    // CASING WARNING (C3): the SELECT aliases below are camelCase (scopeKind/startLine/endLine) and
    // MUST match compression.ts's `.map` field reads in T4. A snake_case alias here + a camelCase
    // read there = silently empty scopes, NO build error. Do NOT "match injections' snake_case" —
    // scopes are camelCase end-to-end. Mirrors the anchors JOIN (s.id = a.symbol_id) above.
    // The JOIN symbols s ON s.id = ls.symbol_id intentionally excludes null-owner ("module") scopes:
    // persist.ts:80 never inserts a scope whose owning symbol does not resolve, so such rows do not
    // exist and have no symbol to join — module-level code legitimately gets no scope sub-blocks.
    // ORDER BY start_line, end_line gives deterministic tiling input downstream.
    const scopes = prepareOrCache(conn,
        `SELECT ls.scope_kind AS scopeKind, ls.start_line AS startLine, ls.end_line AS endLine
         FROM local_scopes ls
         JOIN symbols s ON s.id = ls.symbol_id
         WHERE s.file_path = ?
         ORDER BY ls.start_line, ls.end_line`
    ).all(filePath) as FileFacts['scopes'];
    return { defs, references, edges, referenceEdges, anchors, imports, importBindings, injections, scopes };
}

// ---------------------------------------------------------------------------
// Schema Version
// ---------------------------------------------------------------------------

/**
 * Reads the single-row schema_version table (review #5). The id=1 predicate is
 * the deterministic counterpart to the old LIMIT 1; both return the lone row now
 * that the table is single-row by construction.
 *
 * On a fresh, un-migrated database the schema_version table does not exist yet,
 * so the prepare/get below throws "no such table" (review #26, #37). Treat that
 * as version 0 — the un-migrated baseline — while rethrowing every other error
 * so genuine failures are never silently swallowed.
 *
 * SQL: SELECT version FROM schema_version WHERE id = 1
 */
export function getSchemaVersion(conn: DbConnection): number {
    try {
        const row = prepareOrCache(conn, 'SELECT version FROM schema_version WHERE id = 1').get() as { version: number } | undefined;
        return row?.version ?? 0;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('no such table')) return 0;
        throw e;
    }
}

// ---------------------------------------------------------------------------
// POLARIS v4 intelligence read set (Task 2.2)
// ---------------------------------------------------------------------------

// These imports intentionally live with the append-only Task 2.2 slice. The
// shared-file protocol forbids moving or modifying the owner's existing code.
import { LOCKED_BOUNDS } from './intelligence/limits.js';
import { getLangForFile } from './tree-sitter/languages.js';

export interface V4FileCoverageRow {
    filePath: string;
    present: boolean;
    hash: string | null;
    lastIndexed: number | null;
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4SymbolFactRow {
    internalId: number;
    name: string | null;
    role: 'declaration' | 'reference' | null;
    kind: string | null;
    filePath: string;
    line: number | null;
    endLine: number | null;
    column: number | null;
    captureTag: string | null;
    bodyHash: string | null;
    parentInternalId: number | null;
    visibility: string | null;
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4EdgeFactRow {
    internalId: number;
    containerInternalId: number;
    referencedName: string | null;
    referenceKind: string;
    legacyHeuristicTargetInternalId: number | null;
    sourceFilePath: string;
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4StructureFactRow {
    symbolInternalId: number;
    filePath: string | null;
    name: string | null;
    line: number | null;
    column: number | null;
    paramsJson: string | null;
    returnText: string | null;
    decoratorsJson: string | null;
    modifiersJson: string | null;
    genericsText: string | null;
    parentKind: string | null;
    parentName: string | null;
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4AnchorFactRow {
    internalId: number;
    symbolInternalId: number;
    filePath: string;
    symbolName: string | null;
    kind: string | null;
    line: number | null;
    endLine: number | null;
    text: string | null;
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4ImportFactRow {
    internalId: number;
    filePath: string;
    module: string | null;
    importedNamesJson: string | null;
    line: number | null;
    startLine: number | null;
    endLine: number | null;
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4ImportBindingFactRow {
    internalId: number;
    filePath: string;
    source: string;
    localName: string;
    importedName: string | null;
    importKind: string;
    isTypeOnly: boolean;
    line: number;
    column: number;
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4InjectionFactRow {
    internalId: number;
    filePath: string;
    hostLanguage: string | null;
    injectedLanguage: string | null;
    startLine: number | null;
    endLine: number | null;
    startByte: number | null;
    endByte: number | null;
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4ScopeFactRow {
    internalId: number;
    symbolInternalId: number;
    filePath: string;
    symbolName: string | null;
    scopeKind: string | null;
    startLine: number | null;
    endLine: number | null;
    parametersJson: string | null;
    localsJson: string | null;
}

export interface V4CompleteFileFactBundle {
    files: V4FileCoverageRow[];
    symbols: V4SymbolFactRow[];
    edges: V4EdgeFactRow[];
    structures: V4StructureFactRow[];
    anchors: V4AnchorFactRow[];
    imports: V4ImportFactRow[];
    importBindings: V4ImportBindingFactRow[];
    injections: V4InjectionFactRow[];
    scopes: V4ScopeFactRow[];
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4ParentAncestryRow {
    seedInternalId: number;
    internalId: number;
    parentInternalId: number | null;
    name: string | null;
    kind: string | null;
    filePath: string | null;
    line: number | null;
    endLine: number | null;
    column: number | null;
    depth: number;
}

export type V4IntersectingFactRow =
    | { factFamily: 'symbol'; fact: V4SymbolFactRow }
    | { factFamily: 'anchor'; fact: V4AnchorFactRow }
    | { factFamily: 'scope'; fact: V4ScopeFactRow }
    | { factFamily: 'import'; fact: V4ImportFactRow }
    | { factFamily: 'injection'; fact: V4InjectionFactRow };

export interface V4OccurrenceFilter {
    scopePrefix: string;
    role: 'declaration' | 'reference';
    name?: { mode: 'exact' | 'prefix'; value: string };
    kinds?: readonly string[];
}

export interface V4OccurrenceKey {
    path: string;
    line: number;
    column: number;
    name: string;
}

export interface V4OccurrencePageRequest {
    afterKey?: V4OccurrenceKey;
    limit: number;
}

/** Adapter-only SQLite identities in this row never cross the facade. */
export interface V4OccurrenceRow {
    internalId: number;
    path: string;
    line: number;
    endLine: number;
    column: number;
    name: string;
    role: 'declaration' | 'reference';
    kind: string;
    captureTag: string | null;
    parentInternalId: number | null;
    visibility: string | null;
}

export interface V4OccurrencePage {
    rows: V4OccurrenceRow[];
    total: number;
}

export interface V4EdgeResolutionStatRow {
    /** Storage state only; `resolved` here is never semantic proof. */
    legacyStorageState: 'resolved' | 'unresolved';
    referenceKind: string;
    count: number;
}

/** Adapter-only SQLite identity in this row never crosses the facade. */
export interface V4LegacyHeuristicTargetRow {
    internalId: number;
    filePath: string | null;
    name: string | null;
    kind: string | null;
    type: string | null;
    line: number | null;
    endLine: number | null;
    column: number | null;
}

/** Adapter-only SQLite source identity in this row never crosses the facade. */
export interface V4EdgeFrontierRow {
    sourceInternalId: number;
    sourceFilePath: string | null;
    sourceName: string | null;
    sourceKind: string | null;
    sourceLine: number | null;
    sourceEndLine: number | null;
    sourceColumn: number | null;
    referencedName: string | null;
    referenceKind: string;
    count: number;
    reason: 'name_only' | 'legacy_heuristic';
    legacyHeuristicTarget: V4LegacyHeuristicTargetRow | null;
}

export interface V4LanguageAggregateRow {
    language: string;
    fileCount: number;
}

export interface V4ScopeAggregateRow {
    key: string;
    fileCount: number;
    declarationCount: number;
    referenceCount: number;
    languages: V4LanguageAggregateRow[];
}

export interface V4DirectoryProjectAggregates {
    scope: V4ScopeAggregateRow;
    directories: V4ScopeAggregateRow[];
}

/**
 * Read every v4 fact family for a set of store keys in one set-oriented SQL
 * statement. Missing requested keys remain visible as `present:false` file
 * rows. Statement count: 0 for an empty set, otherwise exactly 1.
 *
 * SQL: one requested-key CTE joined to files, symbols, edges,
 * symbol_structures, anchors, imports, import_bindings, injections, and
 * local_scopes, combined with UNION ALL in canonical file/family/position
 * order.
 */
export function readV4CompleteFileFactBundle(
    conn: DbConnection,
    storeKeys: readonly string[],
): V4CompleteFileFactBundle {
    const keys = [...new Set(storeKeys)];
    const bundle: V4CompleteFileFactBundle = {
        files: [],
        symbols: [],
        edges: [],
        structures: [],
        anchors: [],
        imports: [],
        importBindings: [],
        injections: [],
        scopes: [],
    };
    if (keys.length === 0) return bundle;

    const values = keys.map(() => '(?)').join(', ');
    const sql = `
        WITH requested(file_path) AS (VALUES ${values}),
        facts(
            file_path, family_order, sort_line, sort_column,
            sort_start_byte, sort_end_byte, sort_end_line, sort_kind, sort_name,
            fact_family, payload_json
        ) AS (
            SELECT r.file_path, 0, 0, 0, -1, -1, 0, '', r.file_path, 'file',
                   json_object(
                       'filePath', r.file_path,
                       'present', CASE WHEN f.path IS NULL THEN 0 ELSE 1 END,
                       'hash', f.hash,
                       'lastIndexed', f.last_indexed
                   )
            FROM requested r
            LEFT JOIN files f ON f.path = r.file_path

            UNION ALL
            SELECT s.file_path, 1, s.line, s.column, -1, -1, s.end_line, s.type, s.name, 'symbol',
                   json_object(
                       'internalId', s.id,
                       'name', s.name,
                       'role', CASE
                           WHEN s.kind = 'def' THEN 'declaration'
                           WHEN s.kind = 'ref' THEN 'reference'
                           ELSE NULL
                       END,
                       'kind', s.type,
                       'filePath', s.file_path,
                       'line', s.line,
                       'endLine', s.end_line,
                       'column', s.column,
                       'captureTag', s.capture_tag,
                       'bodyHash', s.body_hash,
                       'parentInternalId', s.parent_symbol_id,
                       'visibility', s.visibility
                   )
            FROM symbols s
            JOIN requested r ON r.file_path = s.file_path

            UNION ALL
            SELECT caller.file_path, 2, caller.line, caller.column, -1, -1,
                   caller.end_line, e.reference_kind, e.referenced_name, 'edge',
                   json_object(
                       'internalId', e.id,
                       'containerInternalId', e.container_def_id,
                       'referencedName', e.referenced_name,
                       'referenceKind', e.reference_kind,
                       'legacyHeuristicTargetInternalId', e.callee_symbol_id,
                       'sourceFilePath', caller.file_path
                   )
            FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            JOIN requested r ON r.file_path = caller.file_path

            UNION ALL
            SELECT s.file_path, 3, s.line, s.column, -1, -1, s.end_line, s.type, s.name, 'structure',
                   json_object(
                       'symbolInternalId', ss.symbol_id,
                       'filePath', s.file_path,
                       'name', s.name,
                       'line', s.line,
                       'column', s.column,
                       'paramsJson', ss.params_json,
                       'returnText', ss.return_text,
                       'decoratorsJson', ss.decorators_json,
                       'modifiersJson', ss.modifiers_json,
                       'genericsText', ss.generics_text,
                       'parentKind', ss.parent_kind,
                       'parentName', ss.parent_name
                   )
            FROM symbol_structures ss
            JOIN symbols s ON s.id = ss.symbol_id
            JOIN requested r ON r.file_path = s.file_path

            UNION ALL
            SELECT s.file_path, 4, a.line, 0, -1, -1,
                   COALESCE(a.end_line, a.line), a.kind, s.name, 'anchor',
                   json_object(
                       'internalId', a.id,
                       'symbolInternalId', a.symbol_id,
                       'filePath', s.file_path,
                       'symbolName', s.name,
                       'kind', a.kind,
                       'line', a.line,
                       'endLine', COALESCE(a.end_line, a.line),
                       'text', a.text
                   )
            FROM anchors a
            JOIN symbols s ON s.id = a.symbol_id
            JOIN requested r ON r.file_path = s.file_path

            UNION ALL
            SELECT i.file_path, 5, COALESCE(i.start_line, i.line), 0, -1, -1,
                   COALESCE(i.end_line, i.line), 'import', i.module, 'import',
                   json_object(
                       'internalId', i.id,
                       'filePath', i.file_path,
                       'module', i.module,
                       'importedNamesJson', i.imported_names_json,
                       'line', i.line,
                       'startLine', COALESCE(i.start_line, i.line),
                       'endLine', COALESCE(i.end_line, i.line)
                   )
            FROM imports i
            JOIN requested r ON r.file_path = i.file_path

            UNION ALL
            SELECT ib.file_path, 6, ib.line, ib.column, -1, -1,
                   ib.line, ib.import_kind, ib.local_name, 'import_binding',
                   json_object(
                       'internalId', ib.id,
                       'filePath', ib.file_path,
                       'source', ib.source,
                       'localName', ib.local_name,
                       'importedName', ib.imported_name,
                       'importKind', ib.import_kind,
                       'isTypeOnly', ib.is_type_only,
                       'line', ib.line,
                       'column', ib.column
                   )
            FROM import_bindings ib
            JOIN requested r ON r.file_path = ib.file_path

            UNION ALL
            SELECT inj.file_path, 7, inj.start_line, 0, inj.start_byte, inj.end_byte,
                   inj.end_line, inj.host_lang, inj.injected_lang, 'injection',
                   json_object(
                       'internalId', inj.id,
                       'filePath', inj.file_path,
                       'hostLanguage', inj.host_lang,
                       'injectedLanguage', inj.injected_lang,
                       'startLine', inj.start_line,
                       'endLine', inj.end_line,
                       'startByte', inj.start_byte,
                       'endByte', inj.end_byte
                   )
            FROM injections inj
            JOIN requested r ON r.file_path = inj.file_path

            UNION ALL
            SELECT s.file_path, 8, ls.start_line, 0, -1, -1,
                   ls.end_line, ls.scope_kind, s.name, 'scope',
                   json_object(
                       'internalId', ls.id,
                       'symbolInternalId', ls.symbol_id,
                       'filePath', s.file_path,
                       'symbolName', s.name,
                       'scopeKind', ls.scope_kind,
                       'startLine', ls.start_line,
                       'endLine', ls.end_line,
                       'parametersJson', ls.parameters_json,
                       'localsJson', ls.locals_json
                   )
            FROM local_scopes ls
            JOIN symbols s ON s.id = ls.symbol_id
            JOIN requested r ON r.file_path = s.file_path
        )
        SELECT fact_family AS factFamily, payload_json AS payloadJson
        FROM facts
        ORDER BY file_path, family_order, sort_line, sort_column,
                 sort_start_byte, sort_end_byte, sort_end_line, sort_kind, sort_name
    `;
    const rows = prepareOrCache(conn, sql).all(...keys) as Array<{
        factFamily: 'file' | 'symbol' | 'edge' | 'structure' | 'anchor'
            | 'import' | 'import_binding' | 'injection' | 'scope';
        payloadJson: string;
    }>;
    for (const row of rows) {
        switch (row.factFamily) {
            case 'file': {
                const value = JSON.parse(row.payloadJson) as Omit<V4FileCoverageRow, 'present'> & { present: number };
                bundle.files.push({ ...value, present: value.present !== 0 });
                break;
            }
            case 'symbol':
                bundle.symbols.push(JSON.parse(row.payloadJson) as V4SymbolFactRow);
                break;
            case 'edge':
                bundle.edges.push(JSON.parse(row.payloadJson) as V4EdgeFactRow);
                break;
            case 'structure':
                bundle.structures.push(JSON.parse(row.payloadJson) as V4StructureFactRow);
                break;
            case 'anchor':
                bundle.anchors.push(JSON.parse(row.payloadJson) as V4AnchorFactRow);
                break;
            case 'import':
                bundle.imports.push(JSON.parse(row.payloadJson) as V4ImportFactRow);
                break;
            case 'import_binding': {
                const value = JSON.parse(row.payloadJson) as Omit<V4ImportBindingFactRow, 'isTypeOnly'> & { isTypeOnly: number };
                bundle.importBindings.push({ ...value, isTypeOnly: value.isTypeOnly !== 0 });
                break;
            }
            case 'injection':
                bundle.injections.push(JSON.parse(row.payloadJson) as V4InjectionFactRow);
                break;
            case 'scope':
                bundle.scopes.push(JSON.parse(row.payloadJson) as V4ScopeFactRow);
                break;
        }
    }
    return bundle;
}

/**
 * Batched seed-inclusive parent walk. The recursive arm uses the locked
 * `depth < 64` guard, so a cyclic seed can produce depths 0 through 64 and
 * always terminates. Statement count: 0 for no seeds, otherwise exactly 1.
 *
 * SQL: WITH RECURSIVE requested(seed_internal_id) AS (VALUES ...),
 * ancestry AS (seed rows UNION ALL parent PK joins WHERE depth < ?).
 */
export function readV4ParentAncestry(
    conn: DbConnection,
    symbolInternalIds: readonly number[],
): V4ParentAncestryRow[] {
    const ids = [...new Set(symbolInternalIds)];
    if (ids.length === 0) return [];
    const values = ids.map(() => '(?)').join(', ');
    const sql = `
        WITH RECURSIVE requested(seed_internal_id) AS (VALUES ${values}),
        ancestry(
            seed_internal_id, internal_id, parent_internal_id, name, kind,
            file_path, line, end_line, column, depth
        ) AS (
            SELECT r.seed_internal_id, s.id, s.parent_symbol_id, s.name, s.type,
                   s.file_path, s.line, s.end_line, s.column, 0
            FROM requested r
            JOIN symbols s ON s.id = r.seed_internal_id
            UNION ALL
            SELECT a.seed_internal_id, p.id, p.parent_symbol_id, p.name, p.type,
                   p.file_path, p.line, p.end_line, p.column, a.depth + 1
            FROM ancestry a
            JOIN symbols p ON p.id = a.parent_internal_id
            WHERE a.depth < ?
        )
        SELECT seed_internal_id AS seedInternalId,
               internal_id AS internalId,
               parent_internal_id AS parentInternalId,
               name,
               kind,
               file_path AS filePath,
               line,
               end_line AS endLine,
               column,
               depth
        FROM ancestry
        ORDER BY seed_internal_id, depth
    `;
    return prepareOrCache(conn, sql).all(
        ...ids,
        LOCKED_BOUNDS.ancestryDepth,
    ) as unknown as V4ParentAncestryRow[];
}

/**
 * Read all v4 symbols, anchors, scopes, imports, and injections whose inclusive
 * line spans intersect one validated inclusive query range. Statement count:
 * exactly 1.
 *
 * SQL: one bounds CTE plus five indexed file/range arms combined by UNION ALL.
 */
export function readV4FactsIntersectingRange(
    conn: DbConnection,
    fileKey: string,
    startLine: number,
    endLine: number,
): V4IntersectingFactRow[] {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
        throw new Error('readV4FactsIntersectingRange: expected an inclusive positive line range');
    }
    const sql = `
        WITH bounds(file_path, start_line, end_line) AS (VALUES (?, ?, ?)),
        facts(
            file_path, sort_line, sort_end_line, sort_column,
            sort_start_byte, sort_end_byte, family_order, sort_kind, sort_name,
            fact_family, payload_json
        ) AS (
            SELECT s.file_path, s.line, s.end_line, s.column,
                   -1, -1, 0, s.type, s.name, 'symbol',
                   json_object(
                       'internalId', s.id,
                       'name', s.name,
                       'role', CASE
                           WHEN s.kind = 'def' THEN 'declaration'
                           WHEN s.kind = 'ref' THEN 'reference'
                           ELSE NULL
                       END,
                       'kind', s.type,
                       'filePath', s.file_path,
                       'line', s.line,
                       'endLine', s.end_line,
                       'column', s.column,
                       'captureTag', s.capture_tag,
                       'bodyHash', s.body_hash,
                       'parentInternalId', s.parent_symbol_id,
                       'visibility', s.visibility
                   )
            FROM symbols s
            JOIN bounds b ON b.file_path = s.file_path
            WHERE s.line <= b.end_line AND s.end_line >= b.start_line

            UNION ALL
            SELECT s.file_path, a.line, COALESCE(a.end_line, a.line), 0,
                   -1, -1, 1, a.kind, s.name, 'anchor',
                   json_object(
                       'internalId', a.id,
                       'symbolInternalId', a.symbol_id,
                       'filePath', s.file_path,
                       'symbolName', s.name,
                       'kind', a.kind,
                       'line', a.line,
                       'endLine', COALESCE(a.end_line, a.line),
                       'text', a.text
                   )
            FROM anchors a
            JOIN symbols s ON s.id = a.symbol_id
            JOIN bounds b ON b.file_path = s.file_path
            WHERE a.line <= b.end_line AND COALESCE(a.end_line, a.line) >= b.start_line

            UNION ALL
            SELECT s.file_path, ls.start_line, ls.end_line, 0,
                   -1, -1, 2, ls.scope_kind, s.name, 'scope',
                   json_object(
                       'internalId', ls.id,
                       'symbolInternalId', ls.symbol_id,
                       'filePath', s.file_path,
                       'symbolName', s.name,
                       'scopeKind', ls.scope_kind,
                       'startLine', ls.start_line,
                       'endLine', ls.end_line,
                       'parametersJson', ls.parameters_json,
                       'localsJson', ls.locals_json
                   )
            FROM local_scopes ls
            JOIN symbols s ON s.id = ls.symbol_id
            JOIN bounds b ON b.file_path = s.file_path
            WHERE ls.start_line <= b.end_line AND ls.end_line >= b.start_line

            UNION ALL
            SELECT i.file_path, COALESCE(i.start_line, i.line), COALESCE(i.end_line, i.line),
                   0, -1, -1, 3, i.module, i.module, 'import',
                   json_object(
                       'internalId', i.id,
                       'filePath', i.file_path,
                       'module', i.module,
                       'importedNamesJson', i.imported_names_json,
                       'line', i.line,
                       'startLine', COALESCE(i.start_line, i.line),
                       'endLine', COALESCE(i.end_line, i.line)
                   )
            FROM imports i
            JOIN bounds b ON b.file_path = i.file_path
            WHERE COALESCE(i.start_line, i.line) <= b.end_line
              AND COALESCE(i.end_line, i.line) >= b.start_line

            UNION ALL
            SELECT inj.file_path, inj.start_line, inj.end_line, 0,
                   inj.start_byte, inj.end_byte, 4, inj.host_lang, inj.injected_lang, 'injection',
                   json_object(
                       'internalId', inj.id,
                       'filePath', inj.file_path,
                       'hostLanguage', inj.host_lang,
                       'injectedLanguage', inj.injected_lang,
                       'startLine', inj.start_line,
                       'endLine', inj.end_line,
                       'startByte', inj.start_byte,
                       'endByte', inj.end_byte
                   )
            FROM injections inj
            JOIN bounds b ON b.file_path = inj.file_path
            WHERE inj.start_line <= b.end_line AND inj.end_line >= b.start_line
        )
        SELECT fact_family AS factFamily, payload_json AS payloadJson
        FROM facts
        ORDER BY file_path, sort_line, sort_column, sort_start_byte,
                 sort_end_byte, sort_end_line, family_order, sort_kind, sort_name
    `;
    const rows = prepareOrCache(conn, sql).all(fileKey, startLine, endLine) as Array<{
        factFamily: 'symbol' | 'anchor' | 'scope' | 'import' | 'injection';
        payloadJson: string;
    }>;
    return rows.map((row): V4IntersectingFactRow => {
        switch (row.factFamily) {
            case 'symbol': return { factFamily: 'symbol', fact: JSON.parse(row.payloadJson) as V4SymbolFactRow };
            case 'anchor': return { factFamily: 'anchor', fact: JSON.parse(row.payloadJson) as V4AnchorFactRow };
            case 'scope': return { factFamily: 'scope', fact: JSON.parse(row.payloadJson) as V4ScopeFactRow };
            case 'import': return { factFamily: 'import', fact: JSON.parse(row.payloadJson) as V4ImportFactRow };
            case 'injection': return { factFamily: 'injection', fact: JSON.parse(row.payloadJson) as V4InjectionFactRow };
        }
    });
}

/**
 * Return the exclusive SQLite BINARY-collation bound for a non-empty prefix.
 * UTF-8 preserves Unicode scalar-value order, so advancing the final scalar
 * (with carry over U+10FFFF) produces the smallest finite prefix successor.
 */
export function namePrefixUpperBound(prefix: string): string | null {
    if (prefix === '') {
        throw new Error('namePrefixUpperBound: prefix must not be empty');
    }

    const codePoints = Array.from(prefix).map((character) => {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) {
            throw new Error('namePrefixUpperBound: invalid empty code point');
        }
        return codePoint;
    });
    while (codePoints.length > 0) {
        const lastIndex = codePoints.length - 1;
        const codePoint = codePoints[lastIndex];
        if (codePoint === undefined) {
            throw new Error('namePrefixUpperBound: invalid code-point state');
        }
        codePoints.length = lastIndex;
        if (codePoint === 0x10FFFF) continue;

        let successor = codePoint + 1;
        if (successor >= 0xD800 && successor <= 0xDFFF) successor = 0xE000;
        codePoints.push(successor);
        return codePoints.map((value) => String.fromCodePoint(value)).join('');
    }
    return null;
}

/**
 * Conjunctive declaration/reference discovery with one canonical keyset page
 * and the exact pre-keyset total returned by the same SQL statement. The
 * adapter deliberately has no regex-shaped input. Statement count: 0 for an
 * empty kind set, otherwise exactly 1.
 *
 * SQL: filtered symbols materialized once; metadata counts the full filtered
 * domain; page applies `(file_path,line,column,name) > (?,?,?,?)`, canonical
 * ordering, and LIMIT.
 */
export function queryV4Occurrences(
    conn: DbConnection,
    filter: V4OccurrenceFilter,
    page: V4OccurrencePageRequest,
): V4OccurrencePage {
    if (filter.scopePrefix !== '' && !filter.scopePrefix.endsWith('/')) {
        throw new Error('queryV4Occurrences: scopePrefix must be empty or end with /');
    }
    if (!Number.isInteger(page.limit) || page.limit < 1) {
        throw new Error('queryV4Occurrences: limit must be a positive integer');
    }
    if (filter.kinds?.length === 0) return { rows: [], total: 0 };

    const where: string[] = ['s.kind = ?'];
    const params: Array<string | number> = [filter.role === 'declaration' ? 'def' : 'ref'];
    if (filter.scopePrefix !== '') {
        where.push('s.file_path >= ? AND s.file_path < ?');
        params.push(filter.scopePrefix, filter.scopePrefix.slice(0, -1) + '0');
    }
    if (filter.name?.mode === 'exact') {
        where.push('s.name = ?');
        params.push(filter.name.value);
    } else if (filter.name?.mode === 'prefix' && filter.name.value !== '') {
        // node:sqlite binds lone surrogates as U+FFFD. Derive the range from
        // that same well-formed text so its bounds cannot exclude an exact hit.
        const prefix = Buffer.from(filter.name.value, 'utf8').toString('utf8');
        const upperBound = namePrefixUpperBound(prefix);
        where.push('s.name >= ?');
        params.push(prefix);
        if (upperBound !== null) {
            where.push('s.name < ?');
            params.push(upperBound);
        }
        // substr is the exactness guarantee; the range only enables the
        // (kind, name) index, so successor mistakes can at worst over-scan.
        where.push('substr(s.name, 1, length(?)) = ?');
        params.push(prefix, prefix);
    }
    if (filter.kinds && filter.kinds.length > 0) {
        where.push(`s.type IN (${filter.kinds.map(() => '?').join(', ')})`);
        params.push(...filter.kinds);
    }

    const afterSql = page.afterKey
        ? 'WHERE (path, line, column, name) > (?, ?, ?, ?)'
        : '';
    if (page.afterKey) {
        params.push(page.afterKey.path, page.afterKey.line, page.afterKey.column, page.afterKey.name);
    }
    params.push(page.limit);

    const sql = `
        WITH filtered AS MATERIALIZED (
            SELECT s.id AS internalId,
                   s.file_path AS path,
                   s.line AS line,
                   s.end_line AS endLine,
                   s.column AS column,
                   s.name AS name,
                   CASE WHEN s.kind = 'def' THEN 'declaration' ELSE 'reference' END AS role,
                   s.type AS kind,
                   s.capture_tag AS captureTag,
                   s.parent_symbol_id AS parentInternalId,
                   s.visibility AS visibility
            FROM symbols s
            WHERE ${where.join(' AND ')}
        ),
        metadata AS (
            SELECT COUNT(*) AS total FROM filtered
        ),
        page_rows AS (
            SELECT *
            FROM filtered
            ${afterSql}
            ORDER BY path, line, column, name
            LIMIT ?
        )
        SELECT 0 AS metadataOnly,
               p.internalId, p.path, p.line, p.endLine, p.column, p.name,
               p.role, p.kind, p.captureTag, p.parentInternalId, p.visibility,
               m.total
        FROM page_rows p
        CROSS JOIN metadata m
        UNION ALL
        SELECT 1 AS metadataOnly,
               NULL, NULL, NULL, NULL, NULL, NULL,
               NULL, NULL, NULL, NULL, NULL,
               m.total
        FROM metadata m
        WHERE NOT EXISTS (SELECT 1 FROM page_rows)
        ORDER BY metadataOnly, path, line, column, name
    `;
    const raw = prepareOrCache(conn, sql).all(...params) as unknown as Array<{
        metadataOnly: number;
        internalId: number | null;
        path: string | null;
        line: number | null;
        endLine: number | null;
        column: number | null;
        name: string | null;
        role: 'declaration' | 'reference' | null;
        kind: string | null;
        captureTag: string | null;
        parentInternalId: number | null;
        visibility: string | null;
        total: number;
    }>;
    const total = raw[0]?.total ?? 0;
    const rows: V4OccurrenceRow[] = [];
    for (const row of raw) {
        if (row.metadataOnly !== 0) continue;
        if (
            row.internalId === null || row.path === null || row.line === null
            || row.endLine === null || row.column === null || row.name === null
            || row.role === null || row.kind === null
        ) {
            throw new Error('STORE_CORRUPT: queryV4Occurrences: malformed persisted symbol key');
        }
        rows.push({
            internalId: row.internalId,
            path: row.path,
            line: row.line,
            endLine: row.endLine,
            column: row.column,
            name: row.name,
            role: row.role,
            kind: row.kind,
            captureTag: row.captureTag,
            parentInternalId: row.parentInternalId,
            visibility: row.visibility,
        });
    }
    return { rows, total };
}

/**
 * Read raw v4 structure rows for adapter-only symbol identities in locked
 * 100-ID chunks. Statement count: ceil(distinct IDs / 100), or 0 when empty.
 *
 * SQL per chunk: symbol_structures joined to symbols by PK, restricted by a
 * parameterized symbol_id IN set.
 */
export function readV4StructuresByInternalIds(
    conn: DbConnection,
    symbolInternalIds: readonly number[],
): V4StructureFactRow[] {
    const ids = [...new Set(symbolInternalIds)];
    const rows: V4StructureFactRow[] = [];
    for (const chunk of chunks(ids, LOCKED_BOUNDS.sqlIdNameChunkSize)) {
        const placeholders = chunk.map(() => '?').join(', ');
        const sql = `
            SELECT ss.symbol_id AS symbolInternalId,
                   s.file_path AS filePath,
                   s.name AS name,
                   s.line AS line,
                   s.column AS column,
                   ss.params_json AS paramsJson,
                   ss.return_text AS returnText,
                   ss.decorators_json AS decoratorsJson,
                   ss.modifiers_json AS modifiersJson,
                   ss.generics_text AS genericsText,
                   ss.parent_kind AS parentKind,
                   ss.parent_name AS parentName
            FROM symbol_structures ss
            JOIN symbols s ON s.id = ss.symbol_id
            WHERE ss.symbol_id IN (${placeholders})
            ORDER BY s.file_path, s.line, s.column, s.name
        `;
        rows.push(...prepareOrCache(conn, sql).all(...chunk) as unknown as V4StructureFactRow[]);
    }
    rows.sort((a, b) => {
        const aFilePath = a.filePath ?? '';
        const bFilePath = b.filePath ?? '';
        if (aFilePath !== bFilePath) return aFilePath < bFilePath ? -1 : 1;
        const aLine = a.line ?? -1;
        const bLine = b.line ?? -1;
        if (aLine !== bLine) return aLine - bLine;
        const aColumn = a.column ?? -1;
        const bColumn = b.column ?? -1;
        if (aColumn !== bColumn) return aColumn - bColumn;
        const aName = a.name ?? '';
        const bName = b.name ?? '';
        if (aName !== bName) return aName < bName ? -1 : 1;
        const aFactKey = JSON.stringify([
            a.paramsJson, a.returnText, a.decoratorsJson, a.modifiersJson,
            a.genericsText, a.parentKind, a.parentName,
        ]) ?? '';
        const bFactKey = JSON.stringify([
            b.paramsJson, b.returnText, b.decoratorsJson, b.modifiersJson,
            b.genericsText, b.parentKind, b.parentName,
        ]) ?? '';
        return aFactKey < bFactKey ? -1 : aFactKey > bFactKey ? 1 : 0;
    });
    return rows;
}

/**
 * Statement count: 0 for no keys, otherwise 1.
 * SQL: SELECT imports WHERE file_path IN (...) in canonical position order.
 */
export function readV4ImportsByFileKeys(
    conn: DbConnection,
    fileKeys: readonly string[],
): V4ImportFactRow[] {
    const keys = [...new Set(fileKeys)];
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    const sql = `
        SELECT id AS internalId,
               file_path AS filePath,
               module,
               imported_names_json AS importedNamesJson,
               line,
               COALESCE(start_line, line) AS startLine,
               COALESCE(end_line, line) AS endLine
        FROM imports
        WHERE file_path IN (${placeholders})
        ORDER BY file_path, startLine, endLine, module
    `;
    return prepareOrCache(conn, sql).all(...keys) as unknown as V4ImportFactRow[];
}

/**
 * Statement count: 0 for no keys, otherwise 1.
 * SQL: SELECT import_bindings WHERE file_path IN (...) in canonical order.
 */
export function readV4ImportBindingsByFileKeys(
    conn: DbConnection,
    fileKeys: readonly string[],
): V4ImportBindingFactRow[] {
    const keys = [...new Set(fileKeys)];
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    const sql = `
        SELECT id AS internalId,
               file_path AS filePath,
               source,
               local_name AS localName,
               imported_name AS importedName,
               import_kind AS importKind,
               is_type_only AS isTypeOnly,
               line,
               column
        FROM import_bindings
        WHERE file_path IN (${placeholders})
        ORDER BY file_path, line, column, local_name
    `;
    const raw = prepareOrCache(conn, sql).all(...keys) as unknown as Array<
        Omit<V4ImportBindingFactRow, 'isTypeOnly'> & { isTypeOnly: number }
    >;
    return raw.map((row) => ({ ...row, isTypeOnly: row.isTypeOnly !== 0 }));
}

/**
 * Statement count: 0 for no keys, otherwise 1.
 * SQL: anchors joined through symbols, filtered by symbol file_path IN (...).
 */
export function readV4AnchorsByFileKeys(
    conn: DbConnection,
    fileKeys: readonly string[],
): V4AnchorFactRow[] {
    const keys = [...new Set(fileKeys)];
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    const sql = `
        SELECT a.id AS internalId,
               a.symbol_id AS symbolInternalId,
               s.file_path AS filePath,
               s.name AS symbolName,
               a.kind,
               a.line,
               COALESCE(a.end_line, a.line) AS endLine,
               a.text
        FROM anchors a
        JOIN symbols s ON s.id = a.symbol_id
        WHERE s.file_path IN (${placeholders})
        ORDER BY s.file_path, a.line, endLine, a.kind, s.name
    `;
    return prepareOrCache(conn, sql).all(...keys) as unknown as V4AnchorFactRow[];
}

/**
 * Statement count: 0 for no keys, otherwise 1.
 * SQL: SELECT injections WHERE file_path IN (...) in canonical range order.
 */
export function readV4InjectionsByFileKeys(
    conn: DbConnection,
    fileKeys: readonly string[],
): V4InjectionFactRow[] {
    const keys = [...new Set(fileKeys)];
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    const sql = `
        SELECT id AS internalId,
               file_path AS filePath,
               host_lang AS hostLanguage,
               injected_lang AS injectedLanguage,
               start_line AS startLine,
               end_line AS endLine,
               start_byte AS startByte,
               end_byte AS endByte
        FROM injections
        WHERE file_path IN (${placeholders})
        ORDER BY file_path, start_line, start_byte, end_byte, end_line, host_lang, injected_lang
    `;
    return prepareOrCache(conn, sql).all(...keys) as unknown as V4InjectionFactRow[];
}

/**
 * Statement count: 0 for no keys, otherwise 1.
 * SQL: local_scopes joined through symbols, filtered by file_path IN (...).
 */
export function readV4ScopesByFileKeys(
    conn: DbConnection,
    fileKeys: readonly string[],
): V4ScopeFactRow[] {
    const keys = [...new Set(fileKeys)];
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    const sql = `
        SELECT ls.id AS internalId,
               ls.symbol_id AS symbolInternalId,
               s.file_path AS filePath,
               s.name AS symbolName,
               ls.scope_kind AS scopeKind,
               ls.start_line AS startLine,
               ls.end_line AS endLine,
               ls.parameters_json AS parametersJson,
               ls.locals_json AS localsJson
        FROM local_scopes ls
        JOIN symbols s ON s.id = ls.symbol_id
        WHERE s.file_path IN (${placeholders})
        ORDER BY s.file_path, ls.start_line, ls.end_line, ls.scope_kind, s.name
    `;
    return prepareOrCache(conn, sql).all(...keys) as unknown as V4ScopeFactRow[];
}

/**
 * Count persisted edge target state by reference kind inside a scope prefix.
 * The state is explicitly legacy storage metadata, never proof. Statement
 * count: exactly 1.
 *
 * SQL: scoped caller symbols joined to edges and grouped by null/non-null
 * callee_symbol_id plus reference_kind.
 */
export function readV4EdgeResolutionStats(
    conn: DbConnection,
    scopePrefix: string,
): V4EdgeResolutionStatRow[] {
    if (scopePrefix !== '' && !scopePrefix.endsWith('/')) {
        throw new Error('readV4EdgeResolutionStats: scopePrefix must be empty or end with /');
    }
    const scopeSql = scopePrefix === ''
        ? ''
        : 'AND caller.file_path >= ? AND caller.file_path < ?';
    const params = scopePrefix === ''
        ? []
        : [scopePrefix, scopePrefix.slice(0, -1) + '0'];
    const sql = `
        SELECT CASE WHEN e.callee_symbol_id IS NULL THEN 'unresolved' ELSE 'resolved' END
                   AS legacyStorageState,
               e.reference_kind AS referenceKind,
               COUNT(*) AS count
        FROM symbols caller
        JOIN edges e ON e.container_def_id = caller.id
        WHERE caller.kind = 'def'
          ${scopeSql}
        GROUP BY legacyStorageState, e.reference_kind
        ORDER BY legacyStorageState, e.reference_kind
    `;
    return prepareOrCache(conn, sql).all(...params) as unknown as V4EdgeResolutionStatRow[];
}

/**
 * Surface every v4 name edge as uncertainty. Null targets are `name_only`;
 * non-null legacy IDs are `legacy_heuristic` and carry the target definition
 * row only as a frontier candidate. Statement count: exactly 1.
 *
 * SQL: scoped source symbols joined to edges and LEFT JOINed to legacy target
 * rows, grouped without promoting any target to a relation.
 */
export function readV4EdgeFrontier(
    conn: DbConnection,
    scopePrefix: string,
): V4EdgeFrontierRow[] {
    if (scopePrefix !== '' && !scopePrefix.endsWith('/')) {
        throw new Error('readV4EdgeFrontier: scopePrefix must be empty or end with /');
    }
    const scopeSql = scopePrefix === ''
        ? ''
        : 'AND caller.file_path >= ? AND caller.file_path < ?';
    const params = scopePrefix === ''
        ? []
        : [scopePrefix, scopePrefix.slice(0, -1) + '0'];
    const sql = `
        SELECT caller.id AS sourceInternalId,
               caller.file_path AS sourceFilePath,
               caller.name AS sourceName,
               caller.type AS sourceKind,
               caller.line AS sourceLine,
               caller.end_line AS sourceEndLine,
               caller.column AS sourceColumn,
               e.referenced_name AS referencedName,
               e.reference_kind AS referenceKind,
               COUNT(*) AS count,
               CASE WHEN e.callee_symbol_id IS NULL THEN 'name_only' ELSE 'legacy_heuristic' END AS reason,
               target.id AS legacyHeuristicTargetInternalId,
               target.file_path AS legacyHeuristicTargetFilePath,
               target.name AS legacyHeuristicTargetName,
               target.kind AS legacyHeuristicTargetKind,
               target.type AS legacyHeuristicTargetType,
               target.line AS legacyHeuristicTargetLine,
               target.end_line AS legacyHeuristicTargetEndLine,
               target.column AS legacyHeuristicTargetColumn
        FROM symbols caller
        JOIN edges e ON e.container_def_id = caller.id
        LEFT JOIN symbols target ON target.id = e.callee_symbol_id
        WHERE caller.kind = 'def'
          ${scopeSql}
        GROUP BY caller.id, e.referenced_name, e.reference_kind, e.callee_symbol_id
        ORDER BY caller.file_path, caller.line, caller.column, caller.name,
                 e.referenced_name, e.reference_kind,
                 target.file_path, target.line, target.column, target.name
    `;
    const raw = prepareOrCache(conn, sql).all(...params) as unknown as Array<{
        sourceInternalId: number;
        sourceFilePath: string | null;
        sourceName: string | null;
        sourceKind: string | null;
        sourceLine: number | null;
        sourceEndLine: number | null;
        sourceColumn: number | null;
        referencedName: string | null;
        referenceKind: string;
        count: number;
        reason: 'name_only' | 'legacy_heuristic';
        legacyHeuristicTargetInternalId: number | null;
        legacyHeuristicTargetFilePath: string | null;
        legacyHeuristicTargetName: string | null;
        legacyHeuristicTargetKind: string | null;
        legacyHeuristicTargetType: string | null;
        legacyHeuristicTargetLine: number | null;
        legacyHeuristicTargetEndLine: number | null;
        legacyHeuristicTargetColumn: number | null;
    }>;
    return raw.map((row): V4EdgeFrontierRow => {
        const target = row.legacyHeuristicTargetInternalId === null
            ? null
            : {
                internalId: row.legacyHeuristicTargetInternalId,
                filePath: row.legacyHeuristicTargetFilePath,
                name: row.legacyHeuristicTargetName,
                kind: row.legacyHeuristicTargetKind,
                type: row.legacyHeuristicTargetType,
                line: row.legacyHeuristicTargetLine,
                endLine: row.legacyHeuristicTargetEndLine,
                column: row.legacyHeuristicTargetColumn,
            };
        return {
            sourceInternalId: row.sourceInternalId,
            sourceFilePath: row.sourceFilePath,
            sourceName: row.sourceName,
            sourceKind: row.sourceKind,
            sourceLine: row.sourceLine,
            sourceEndLine: row.sourceEndLine,
            sourceColumn: row.sourceColumn,
            referencedName: row.referencedName,
            referenceKind: row.referenceKind,
            count: row.count,
            reason: row.reason,
            legacyHeuristicTarget: target,
        };
    });
}

/**
 * Produce directory and selected-scope/project aggregates from one SQL
 * statement. Schema v4 has neither persisted language nor module identity:
 * language is derived from each persisted path with the canonical detector,
 * and no module selector or synthetic module group is exposed here.
 * Statement count: exactly 1.
 *
 * SQL: files LEFT JOIN symbols, one row per file with declaration/reference
 * counts; TypeScript folds directory groups and the language histogram.
 */
export function readV4DirectoryProjectAggregates(
    conn: DbConnection,
    scopePrefix: string,
): V4DirectoryProjectAggregates {
    if (scopePrefix !== '' && !scopePrefix.endsWith('/')) {
        throw new Error('readV4DirectoryProjectAggregates: scopePrefix must be empty or end with /');
    }
    const scopeSql = scopePrefix === ''
        ? ''
        : 'WHERE f.path >= ? AND f.path < ?';
    const params = scopePrefix === ''
        ? []
        : [scopePrefix, scopePrefix.slice(0, -1) + '0'];
    const sql = `
        SELECT f.path AS filePath,
               SUM(CASE WHEN s.kind = 'def' THEN 1 ELSE 0 END) AS declarationCount,
               SUM(CASE WHEN s.kind = 'ref' THEN 1 ELSE 0 END) AS referenceCount
        FROM files f
        LEFT JOIN symbols s ON s.file_path = f.path
        ${scopeSql}
        GROUP BY f.path
        ORDER BY f.path
    `;
    const raw = prepareOrCache(conn, sql).all(...params) as unknown as Array<{
        filePath: string | null;
        declarationCount: number;
        referenceCount: number;
    }>;

    interface AggregateAccumulator {
        fileCount: number;
        declarationCount: number;
        referenceCount: number;
        languages: Map<string, number>;
    }
    const scopeAccumulator: AggregateAccumulator = {
        fileCount: 0,
        declarationCount: 0,
        referenceCount: 0,
        languages: new Map(),
    };
    const directoryAccumulators = new Map<string, AggregateAccumulator>();
    for (const row of raw) {
        if (row.filePath === null) {
            throw new Error('STORE_CORRUPT: readV4DirectoryProjectAggregates: null persisted file path');
        }
        const language = getLangForFile(row.filePath) ?? 'unknown';
        scopeAccumulator.fileCount += 1;
        scopeAccumulator.declarationCount += row.declarationCount;
        scopeAccumulator.referenceCount += row.referenceCount;
        scopeAccumulator.languages.set(language, (scopeAccumulator.languages.get(language) ?? 0) + 1);

        const separator = row.filePath.lastIndexOf('/');
        const directory = separator < 0 ? '' : row.filePath.slice(0, separator);
        let accumulator = directoryAccumulators.get(directory);
        if (!accumulator) {
            accumulator = {
                fileCount: 0,
                declarationCount: 0,
                referenceCount: 0,
                languages: new Map(),
            };
            directoryAccumulators.set(directory, accumulator);
        }
        accumulator.fileCount += 1;
        accumulator.declarationCount += row.declarationCount;
        accumulator.referenceCount += row.referenceCount;
        accumulator.languages.set(language, (accumulator.languages.get(language) ?? 0) + 1);
    }

    const scopeLanguages = [...scopeAccumulator.languages.entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([language, fileCount]) => ({ language, fileCount }));
    const directories = [...directoryAccumulators.entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, accumulator]): V4ScopeAggregateRow => ({
            key,
            fileCount: accumulator.fileCount,
            declarationCount: accumulator.declarationCount,
            referenceCount: accumulator.referenceCount,
            languages: [...accumulator.languages.entries()]
                .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
                .map(([language, fileCount]) => ({ language, fileCount })),
        }));
    return {
        scope: {
            key: scopePrefix === '' ? '' : scopePrefix.slice(0, -1),
            fileCount: scopeAccumulator.fileCount,
            declarationCount: scopeAccumulator.declarationCount,
            referenceCount: scopeAccumulator.referenceCount,
            languages: scopeLanguages,
        },
        directories,
    };
}

/**
 * Return one present/missing coverage row for every distinct requested file
 * key in locked 100-key chunks. Statement count: ceil(distinct keys / 100),
 * or 0 for an empty set.
 *
 * SQL per chunk: requested-key CTE LEFT JOIN files by primary key.
 */
export function readV4FileHashesByKeys(
    conn: DbConnection,
    fileKeys: readonly string[],
): V4FileCoverageRow[] {
    const keys = [...new Set(fileKeys)];
    const rows: V4FileCoverageRow[] = [];
    for (const chunk of chunks(keys, LOCKED_BOUNDS.sqlIdNameChunkSize)) {
        const values = chunk.map(() => '(?)').join(', ');
        const sql = `
            WITH requested(file_path) AS (VALUES ${values})
            SELECT r.file_path AS filePath,
                   CASE WHEN f.path IS NULL THEN 0 ELSE 1 END AS present,
                   f.hash AS hash,
                   f.last_indexed AS lastIndexed
            FROM requested r
            LEFT JOIN files f ON f.path = r.file_path
            ORDER BY r.file_path
        `;
        const raw = prepareOrCache(conn, sql).all(...chunk) as unknown as Array<
            Omit<V4FileCoverageRow, 'present'> & { present: number }
        >;
        rows.push(...raw.map((row) => ({ ...row, present: row.present !== 0 })));
    }
    rows.sort((a, b) => a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0);
    return rows;
}
