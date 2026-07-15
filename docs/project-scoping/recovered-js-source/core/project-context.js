import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { findRepoRoot, getDb } from './symbol-index.js';

const ZENITH_HOME = path.join(os.homedir(), '.zenith-mcp');
const GLOBAL_DB_PATH = path.join(ZENITH_HOME, 'global-stash.db');

// ---------------------------------------------------------------------------
// Project root registry — persists manually-init'd project roots so they
// survive reconnects without requiring git.
// ---------------------------------------------------------------------------

let _globalDb = null;

function getGlobalDb() {
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

// ---------------------------------------------------------------------------
// ProjectContext — the single authority on "what project am I in?"
//
// Resolution ladder:
//   1. MCP roots from client (bound on init + refreshed on roots_changed)
//   2. Git repo detection from the bound root
//   3. Refresh/rebind on roots change notification
//   4. Fallback to cwd
//   5. If 1-4 fail: check manually registered project_roots table,
//      or allow stashInit to register a new project root
//   6. Global catch-all (~/.zenith-mcp/global-stash.db)
// ---------------------------------------------------------------------------

export class ProjectContext {
    constructor(ctx) {
        this._ctx = ctx;          // filesystem context (getAllowedDirectories, validatePath, etc.)
        this._boundRoot = null;   // resolved project root (git or manual)
        this._isGlobal = false;   // true if we fell through to global
        this._resolved = false;   // true if we've done initial resolution
        this._explicit = false;   // true if root was set explicitly via initProject (sticky)
    }

    // --- Public API ---

    /**
     * Get the project root. This is the main entry point.
     * Pass an optional filePath to scope resolution to that file's location.
     */
    getRoot(filePath) {
        // If a specific file is given, try its repo first
        if (filePath) {
            const fileRoot = this._resolveFromPath(filePath);
            if (fileRoot) {
                // Auto-promote the first-touched repo as the bound root, but only
                // when nothing has been explicitly bound via initProject. This lets
                // session-wide tools (e.g. refactor_batch query with no fileScope)
                // inherit the project the agent has been working in.
                if (!this._explicit && (!this._resolved || !this._boundRoot)) {
                    this._boundRoot = fileRoot;
                    this._isGlobal = false;
                    this._resolved = true;
                }
                return fileRoot;
            }
        }

        // Return cached bound root if already resolved
        if (this._resolved) {
            return this._boundRoot; // null means global
        }

        // Run the full ladder
        this._resolve();
        return this._boundRoot; // null means global
    }

    /**
     * Get the stash DB for the current project context.
     */
    getStashDb(filePath) {
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

    /**
     * Is the current context using the global fallback?
     */
    get isGlobal() {
        if (!this._resolved) this._resolve();
        return this._isGlobal;
    }

    /**
     * Force re-resolution. Called when MCP roots change.
     */
    refresh() {
        this._boundRoot = null;
        this._isGlobal = false;
        this._resolved = false;
        this._explicit = false;
        this._resolve();
    }

    /**
     * Manually register a project root (stashInit).
     * Persists to global DB so it survives reconnects.
     */
    initProject(rootPath, name) {
        const abs = path.resolve(rootPath);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            throw new Error(`Not a directory: ${abs}`);
        }
        const db = getGlobalDb();
        db.prepare(
            'INSERT OR REPLACE INTO project_roots (root_path, name, created_at) VALUES (?, ?, ?)'
        ).run(abs, name || path.basename(abs), Date.now());

        // Bind to this project immediately (sticky — overrides any auto-promote)
        this._boundRoot = abs;
        this._isGlobal = false;
        this._resolved = true;
        this._explicit = true;
        return abs;
    }

    /**
     * List all manually registered project roots.
     */
    listRegisteredProjects() {
        const db = getGlobalDb();
        return db.prepare('SELECT * FROM project_roots ORDER BY created_at DESC').all();
    }

    // --- Private resolution ladder ---

    _resolve() {
        this._resolved = true;

        // Step 1: MCP roots from client
        const root = this._resolveFromMcpRoots();
        if (root) {
            this._boundRoot = root;
            this._isGlobal = false;
            return;
        }

        // Step 4: Fallback to cwd
        const cwdRoot = this._resolveFromPath(process.cwd());
        if (cwdRoot) {
            this._boundRoot = cwdRoot;
            this._isGlobal = false;
            return;
        }

        // Step 5: Check manually registered project roots
        const registeredRoot = this._resolveFromRegistry();
        if (registeredRoot) {
            this._boundRoot = registeredRoot;
            this._isGlobal = false;
            return;
        }

        // Step 6: Global fallback
        this._boundRoot = null;
        this._isGlobal = true;
    }

    // Step 1+2: MCP roots → git repo detection
    _resolveFromMcpRoots() {
        let dirs;
        try { dirs = this._ctx.getAllowedDirectories(); } catch { return null; }
        if (!dirs || !dirs.length) return null;

        // If there's exactly one allowed dir, use it directly
        // If multiple, try to find a git repo among them
        for (const dir of dirs) {
            const gitRoot = findRepoRoot(dir);
            if (gitRoot) return gitRoot;
        }
        // If no git root found but we have exactly one allowed dir, use it
        if (dirs.length === 1) return dirs[0];
        return null;
    }

    // Step 2: Git repo detection from a given path
    _resolveFromPath(p) {
        if (!p) return null;
        try {
            const gitRoot = findRepoRoot(p);
            if (gitRoot) return gitRoot;
        } catch {}
        return null;
    }

    // Step 5: Check the project_roots registry
    _resolveFromRegistry() {
        try {
            const db = getGlobalDb();
            const rows = db.prepare('SELECT root_path FROM project_roots ORDER BY created_at DESC').all();
            const cwd = process.cwd();
            // Check if cwd is inside any registered project
            for (const row of rows) {
                if (cwd.startsWith(row.root_path)) return row.root_path;
            }
            return null;
        } catch { return null; }
    }
}

// ---------------------------------------------------------------------------
// Stash table setup — reused by both project DBs and the global DB
// ---------------------------------------------------------------------------

function ensureStashTables(db) {
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

// ---------------------------------------------------------------------------
// Singleton + integration hooks
// ---------------------------------------------------------------------------

let _instance = null;

export function getProjectContext(ctx) {
    if (!_instance) {
        _instance = new ProjectContext(ctx);
    }
    return _instance;
}

/**
 * Hook into server.js — call this when roots change to refresh context.
 */
export function onRootsChanged(ctx) {
    if (_instance) {
        _instance.refresh();
    }
}
