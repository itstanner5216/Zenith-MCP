# Zenith-MCP SQLite & better-sqlite3 Usage Audit Checklist

This document provides a comprehensive, audit-only checklist of every file, line, and code snippet where SQLite or `better-sqlite3` is referenced, used, or configured in the Zenith-MCP codebase.

It is structured to be used as direct input/prompting for a future refactoring agent.

---

## High-Level Architecture Summary
Zenith-MCP utilizes `better-sqlite3` for persistence in three distinct contexts:
1. **Project-Scoped Database (`symbols.db`):** Stored inside each project/repository's `.mcp/` directory. It manages parsed files, symbol definitions/references (`symbols` table), dependency/call graphs (`edges` table), and historical refactoring versions (`versions` table).
2. **Global Database (`global-stash.db`):** Stored in `~/.zenith-mcp/global-stash.db`. It persists:
   - Manually-initialized project roots (`project_roots` table)
   - Configuration file backups (`config_backups` table)
   - Global stash of failed file edits/writes (`stash` table) when outside of a resolved project root
3. **In-Memory Database (`:memory:`):** Used during testing (e.g., in `symbol-index-core.test.js`) to test database methods deterministically.

---

## Checklist of Usages

### 1. Project Configuration & Workspace Files
These files configure `better-sqlite3` dependencies and permissions for the workspace.

- [ ] **`pnpm-workspace.yaml`** (Line 5)
  - **Purpose:** Declares that building the `better-sqlite3` native package is allowed.
  - **Exact Snippet:**
    ```yaml
    allowBuilds:
      better-sqlite3: true
    ```

- [ ] **`package.json`** (Root) (Line 19)
  - **Purpose:** Exposes a root-level script to trigger the Zenith SQLite native binding repair script.
  - **Exact Snippet:**
    ```json
    "repair:sqlite": "pnpm --filter zenith-mcp run repair:sqlite",
    ```

- [ ] **`packages/zenith-mcp/package.json`** (Lines 28, 34, 49)
  - **Purpose:** Declares the `better-sqlite3` runtime dependency, types devDependency, and the repair script.
  - **Exact Snippets:**
    - Script (Line 28):
      ```json
      "repair:sqlite": "bash src/scripts/repair-zenith-sqlite.sh"
      ```
    - Dependency (Line 34):
      ```json
      "better-sqlite3": "^12.10.0",
      ```
    - DevDependency (Line 49):
      ```json
      "@types/better-sqlite3": "^7.6.13",
      ```

- [ ] **`pnpm-lock.yaml`** (Multiple lines)
  - **Purpose:** Locks the exact resolved version of `better-sqlite3` (v12.10.0) and `@types/better-sqlite3` (v7.6.13) along with transitives.
  - **References:**
    - `better-sqlite3: ...`
    - `@types/better-sqlite3: ...`

---

### 2. Maintenance & Native Build Scripts
Handles native compilation setup and loading verification.

- [ ] **`packages/zenith-mcp/src/scripts/repair-zenith-sqlite.sh`** (Entire file)
  - **Purpose:** Rebuilds the native binding for `better-sqlite3` and runs a quick inline test verifying that `better-sqlite3` successfully loads an in-memory database.
  - **Key Snippet:**
    ```bash
    echo "Rebuilding better-sqlite3 native binding"
    pnpm --filter zenith-mcp rebuild better-sqlite3 --pending || pnpm --filter zenith-mcp rebuild better-sqlite3

    echo "Verifying better-sqlite3 loads from zenith-mcp package"
    (
      cd "$ROOT/packages/zenith-mcp"
      "$NODE" -e 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); db.close(); console.log("better-sqlite3 OK")'
    )
    ```

---

### 3. Core Database Operations & SQL Execution (Source)
These files contain the direct database connections, schemas, and SQL query executions.

- [ ] **`packages/zenith-mcp/src/core/symbol-index.ts`**
  - **Purpose:** Primary controller for project symbol indexing and versioning databases (`.mcp/symbols.db`).
  - **Imports & Types (Lines 1, 76, 79):**
    ```typescript
    import Database from 'better-sqlite3';
    // ...
    const _dbCache = new Map<string, Database.Database>();
    // ...
    export function getDb(repoRoot: string): Database.Database {
    ```
  - **Database Instantiation & Pragmas (Lines 90-94):**
    ```typescript
    const db = new Database(path.join(mcpDir, 'symbols.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    ```
  - **Schema Creation (Lines 97-148):**
    Creates `files`, `symbols`, `edges`, `versions`, `patterns` tables and multiple indexes (`idx_symbols_name`, etc.).
  - **Schema Migrations (Lines 144-147):**
    ```typescript
    try { db.exec('ALTER TABLE versions ADD COLUMN line INTEGER'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE versions ADD COLUMN text_hash TEXT'); } catch { /* already exists */ }
    try {
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
    } catch { /* tolerate pre-existing duplicates */ }
    ```
  - **Pruning & Sessions (Lines 156, 171-173):**
    - `db.prepare('DELETE FROM versions WHERE created_at < ?').run(...)`
    - `db.prepare('DELETE FROM versions WHERE session_id != ?').run(...)`
  - **Indexing Queries (Lines 217-300, 346, 377):**
    - `db.prepare('DELETE FROM symbols WHERE file_path = ?').run(...)`
    - `db.prepare('DELETE FROM files WHERE path = ?').run(...)`
    - `db.prepare('SELECT hash FROM files WHERE path = ?').get(...)`
    - `db.prepare('INSERT OR REPLACE INTO files (path, hash, last_indexed) VALUES (?, ?, ?)')`
    - `db.prepare('INSERT INTO symbols (name, kind, type, file_path, line, end_line, column) VALUES (?, ?, ?, ?, ?, ?, ?)')`
    - `db.prepare('INSERT INTO edges (container_def_id, referenced_name) VALUES (?, ?)')`
    - Directory walk pruning check: `db.prepare('SELECT path FROM files WHERE path LIKE ?').all(...)`
  - **Graph/Impact Queries (Lines 418-490):**
    - `db.prepare('SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = ?').all(...)`
    - Multi-hop callers: `SELECT s.name, s.file_path, COUNT(e.id) ... FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.referenced_name = ? ...`
    - Multi-hop callees: `SELECT e.referenced_name AS name, COUNT(e.id) ... FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.name = ? ...`
  - **Version History Snapshots (Lines 519-550):**
    - `db.prepare('INSERT OR IGNORE INTO versions (symbol_name, file_path, original_text, session_id, created_at, line, text_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')`
    - `db.prepare('SELECT id, symbol_name, file_path, created_at, text_hash FROM versions WHERE symbol_name = ? AND session_id = ? ...')`
    - `db.prepare('SELECT original_text FROM versions WHERE id = ?').get(...)`
    - `db.prepare('SELECT original_text, symbol_name, session_id FROM versions WHERE id = ?').get(...)`

- [ ] **`packages/zenith-mcp/src/core/project-context.ts`**
  - **Purpose:** Context orchestrator resolving repository paths, setting up the global registry db (`~/.zenith-mcp/global-stash.db`), and provisioning DB wrappers.
  - **Imports & Initialization (Lines 4, 30):**
    ```typescript
    import Database from 'better-sqlite3';
    // ...
    let _globalDb: Database.Database | null = null;
    ```
  - **Global DB Creation & Table Setup (Lines 32-48):**
    ```typescript
    function getGlobalDb(): Database.Database {
        if (_globalDb) return _globalDb;
        fs.mkdirSync(ZENITH_HOME, { recursive: true });
        _globalDb = new Database(GLOBAL_DB_PATH);
        _globalDb.exec(`
            CREATE TABLE IF NOT EXISTS project_roots (
                root_path TEXT PRIMARY KEY,
                name TEXT,
                created_at INTEGER
            );
        `);
        return _globalDb;
    }
    ```
  - **Project Directory Routing (Lines 117-128):**
    Retrieves project-scoped or fallback global stash database connections.
    ```typescript
    getStashDb(filePath?: string): { db: Database.Database; root: string | null; isGlobal: boolean } {
        const root = this.getRoot(filePath);
        if (root) {
            const db = getDb(root);
            ensureStashTables(db);
            return { db, root, isGlobal: false };
        }
        const db = getGlobalDb();
        ensureStashTables(db);
        return { db, root: null, isGlobal: true };
    }
    ```
  - **Persisting / Loading Registered Projects (Lines 161, 184, 195):**
    - `db.prepare('INSERT OR REPLACE INTO project_roots (root_path, name, created_at) VALUES (?, ?, ?)')`
    - `db.prepare('SELECT * FROM project_roots ORDER BY created_at DESC')`
    - `db.prepare('SELECT root_path, name FROM project_roots')`
  - **Dynamic Stash Table Schema Creation (Lines 243-252):**
    ```typescript
    function ensureStashTables(db: Database.Database): void {
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
    ```

- [ ] **`packages/zenith-mcp/src/core/stash.ts`**
  - **Purpose:** API layer for storing/retrieving failed edit and write actions in the SQLite-backed `stash` table.
  - **Core Queries (Lines 30-75):**
    - `db.prepare('INSERT INTO stash (type, file_path, payload, attempts, created_at) VALUES (?, ?, ?, 0, ?)')`
    - `db.prepare('SELECT * FROM stash WHERE id = ?')`
    - `db.prepare('SELECT attempts FROM stash WHERE id = ?')`
    - `db.prepare('UPDATE stash SET attempts = ? WHERE id = ?')`
    - `db.prepare('DELETE FROM stash WHERE id = ?')`
    - `db.prepare('SELECT * FROM stash ORDER BY id')`

- [ ] **`packages/zenith-mcp/src/config/backup.ts`**
  - **Purpose:** Implements configuration file backups with WAL-enabled SQLite persistence option.
  - **Imports & Configuration (Lines 1, 28):**
    ```typescript
    import Database from 'better-sqlite3';
    // ...
    let _db: Database.Database | null = null;
    ```
  - **DB Initialization (Lines 34-49):**
    ```typescript
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
    ```
  - **Teardown (Lines 55-60):**
    ```typescript
    export function closeDb(): void {
        if (_db !== null) {
            _db.close();
            _db = null;
        }
    }
    ```
  - **CRUD Operations (Lines 109, 138, 157):**
    - `db.prepare('INSERT INTO config_backups (original_path, backup_content, created_at, expires_at) VALUES (?, ?, ?, ?)')`
    - `db.prepare('SELECT * FROM config_backups WHERE id = ?')`
    - `db.prepare('DELETE FROM config_backups WHERE expires_at < ?')`

---

### 4. Configuration & Interface Files (Reference Strings)
These files do not interact with the database directly, but validate or prompt for SQLite configuration strings.

- [ ] **`packages/zenith-mcp/src/config/wizard.ts`** (Lines 150, 159, 270, 279)
  - **Purpose:** First-run wizard, guides setup for backup modes including "sqlite".
  - **Snippets:**
    - Choice declaration: `let backupMode: "file" | "sqlite" | "none"`
    - UI Prompting: `writeLine(io, option("2", "SQLite", "auto-deleted after 24 hours"))`
    - Value mapper: `return { mode: "sqlite", dir: ... }`

- [ ] **`packages/zenith-mcp/src/config/schema.ts`** (Lines 15, 251)
  - **Purpose:** Configuration Schema definitions.
  - **Snippets:**
    - Type schema: `backup_mode: "file" | "sqlite" | "none"`
    - Zod validation checking: `if (raw_val === "file" || raw_val === "sqlite" || raw_val === "none")`

- [ ] **`packages/zenith-mcp/src/config/auto-write.ts`** (Line 269)
  - **Purpose:** Automates external MCP server registrations, passing backup mode parameters.
  - **Snippet:**
    ```typescript
    backupMode: "file" | "sqlite" | "none"
    ```

- [ ] **`packages/zenith-mcp/src/config/index.ts`** (Line 17)
  - **Purpose:** Module entry points documentation.
  - **Snippet:**
    ```typescript
    // Backup — file and SQLite backup/restore
    ```

---

### 5. Testing Suites
Verifies the SQLite-specific functionality during standard Vitest runs.

- [ ] **`packages/zenith-mcp/tests/symbol-index-core.test.js`** (Entire file)
  - **Purpose:** Thoroughly tests version snapshots, history, recovery, context pruning, and stale purging using isolated in-memory Databases.
  - **Key Setup:**
    ```javascript
    import Database from 'better-sqlite3';
    // ...
    describe('symbol-index — ...', () => {
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
        // ...
    });
    ```

- [ ] **`packages/zenith-mcp/tests/robustness-behavioral.test.js`** (Lines 383, 400, 422, 439, 447)
  - **Purpose:** Verifies system robustness by running database indexing, assertion, and purging tests on dynamic mock SQLite databases.
  - **Key Snippets:**
    - `const db = mod.getDb(tmpDir);`
    - `const rows = db.prepare('SELECT * FROM files').all();`
    - `const rows = db.prepare('SELECT * FROM files WHERE path = ?').all('data.xyz');`
    - `const beforeRows = db.prepare('SELECT * FROM files WHERE path = ?').all('temp.js');`
    - `const afterRows = db.prepare('SELECT * FROM files WHERE path = ?').all('temp.js');`

- [ ] **`packages/zenith-mcp/tests/refactor-batch.test.js`** (Lines 138-140, 157)
  - **Purpose:** Verifies that first-run queries correctly build the index, directly purging and counting rows in SQLite tables to test refactoring batch logic.
  - **Key Snippets:**
    - `db.prepare('DELETE FROM files').run();`
    - `db.prepare('DELETE FROM symbols').run();`
    - `db.prepare('DELETE FROM edges').run();`
    - `const count = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;`

- [ ] **`packages/zenith-mcp/test-config-live.mjs`** (Line 6)
  - **Purpose:** Config system test documentation which marks database-dependent files like `backup.ts` to be skipped during dry tests because they depend on native SQLite binaries.
  - **Key Snippet:**
    ```javascript
    // Skips: backup.ts (needs better-sqlite3 native), wizard.ts (interactive readline), auto-write.ts (imports backup.ts which needs native).
    ```

- [ ] **Other Stash/Context Verification Tests**
  - **Description:** These tests verify higher-level features built directly upon SQLite storage (Stash and Project Context), testing them implicitly by instantiating project/global fallback contexts and asserting against records created or retrieved.
  - **Tested Files:**
    - `packages/zenith-mcp/tests/project-context.test.js` (Verifies `getStashDb()` returns a structured project-scoped DB or global fallback DB).
    - `packages/zenith-mcp/tests/stash-core.test.js` (Verifies CRUD wrapper operations on the SQLite stash).
    - `packages/zenith-mcp/tests/stash-restore-tool.test.js` (Verifies tool integration handlers in `stashRestore` tools).
    - `packages/zenith-mcp/tests/stash_restore_task_1_4.test.js` (Verifies stash entry management workflows).

---

### 6. Documentation, Conceptual & Architectural Plans
These reference files design future SQLite patterns or describe historical database migrations/refactor feedback. They provide critical design intent for the SQLite engine.

- [ ] **`docs/pr13-all-comments.md`** (Line 1068)
  - **Purpose:** PR review commentary analyzing connection lifetime models for `better-sqlite3`, recommending a persistent singleton connection model rather than opening/closing handles dynamically on every operation.
  - **Key Snippet:**
    ```markdown
    `withDb` now opens a fresh `better-sqlite3` connection, configures pragmas, runs `CREATE TABLE IF NOT EXISTS`, and closes it on every single call... If the goal was to avoid leaking the handle on shutdown, consider keeping the singleton plus a `close()` exported for tests...
    ```

- [ ] **`docs/concepts/KEYSTONE.md`** (Lines 857, 1051, 1052)
  - **Purpose:** Conceptual architecture detailing the FORGE hybrid storage model and proposed migrations including `canon_versions` table schema and indices.
  - **Key Snippets:**
    - `db.exec(\`CREATE TABLE IF NOT EXISTS canon_versions ( ... )\`);`
    - `db.exec(\`CREATE INDEX IF NOT EXISTS idx_canon_lang_active ON canon_versions(language, status, last_active DESC)\`);`

- [ ] **`docs/concepts/CHIRON.md`** (Multiple lines)
  - **Purpose:** Extensive conceptual design outlining Chiron's telemetry, schema extensions (e.g., adding `chiron_indexed_at` and `chiron_short_hash` columns and indexes), node pools, drift tracking, and idempotency logs in SQLite.
  - **Key Snippets:**
    - Migration DDL:
      ```typescript
      try { db.exec('ALTER TABLE files   ADD COLUMN chiron_indexed_at INTEGER'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE files   ADD COLUMN canon_version_id INTEGER'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE symbols ADD COLUMN chiron_short_hash TEXT'); } catch { /* exists */ }
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_chiron_short ON symbols(chiron_short_hash)'); } catch {}
      ```
    - Table Definitions:
      - `node_occurrence` (`file_path`, etc.)
      - `node_pool` (`refcount`, `last_seen_at`)
      - `atlas_frequency` (`canon_version_id`)
      - `read_registry`
      - `idempotency_log` (`response_blob`, `request_hash`, `idempotency_key`)

- [ ] **`docs/plans/suppression-cleanup-plan.md`** (Line 22) & **`docs/plans/pr12-behavioral-fixes-plan.md`** (Line 29)
  - **Purpose:** Explicitly catalogs `better-sqlite3` as a cornerstone of Zenith-MCP's tech stack for symbol parsing and tracking.

- [ ] **`docs/plans/plan-group-a.md`** (Lines 1183, 1184, 1185, 2004)
  - **Purpose:** Direct implementation plans outlining atomic transactional table purges and TTL database migrations.
  - **Key Snippets:**
    - `db.transaction(() => { db.prepare('DELETE FROM symbols ...') })`
    - `db.prepare('DELETE FROM versions WHERE created_at < ?')`
