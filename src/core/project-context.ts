import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { getDb } from './symbol-index.js';
import { ProjectRegistry } from './project-registry.js';
import { resolveProjectRoot, clearProjectScopeCache } from '../utils/project-scope.js';

const ZENITH_HOME = path.join(os.homedir(), '.zenith-mcp');
const GLOBAL_DB_PATH = path.join(ZENITH_HOME, 'global-stash.db');

// ---------------------------------------------------------------------------
// Row shape interfaces for typed DB queries
// ---------------------------------------------------------------------------

interface ProjectRootRow {
    root_path: string;
    name: string;
    created_at: number;
}

// ---------------------------------------------------------------------------
// Filesystem context interface
// ---------------------------------------------------------------------------

export interface FsContext {
    getAllowedDirectories(): string[];
    validatePath?: (p: string) => string | Promise<string>;
}

// ---------------------------------------------------------------------------
// Project root registry — persists manually-init'd project roots so they
// survive reconnects without requiring git.
// ---------------------------------------------------------------------------

let _globalDb: Database.Database | null = null;

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

// ---------------------------------------------------------------------------
// ProjectContext — the single authority on "what project am I in?"
//
// Resolution ladder (delegated to ../utils/project-scope.ts):
//   1. Git repo detection
//   2. Marker-based detection
//   3. Registry matching (SQLite + allowed directories)
//   4. Global fallback
// ---------------------------------------------------------------------------

export class ProjectContext {
    private _ctx: FsContext;
    private _boundRoot: string | null;
    private _isGlobal: boolean;
    private _resolved: boolean;
    private _explicit: boolean;
    private _registry: ProjectRegistry;

    constructor(ctx: FsContext) {
        this._ctx = ctx;
        this._boundRoot = null;
        this._isGlobal = false;
        this._resolved = false;
        this._explicit = false;
        this._registry = new ProjectRegistry();
        this._syncRegistry();
    }

    // --- Public API ---

    /**
     * Get the project root. This is the main entry point.
     * Pass an optional filePath to scope resolution to that file's location.
     */
    getRoot(filePath?: string): string | null {
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

    /**
     * Is the current context using the global fallback?
     */
    get isGlobal(): boolean {
        if (!this._resolved) this._resolve();
        return this._isGlobal;
    }

    /**
     * Force re-resolution. Called when MCP roots change.
     */
    refresh(): void {
        this._boundRoot = null;
        this._isGlobal = false;
        this._resolved = false;
        this._explicit = false;
        clearProjectScopeCache();
        this._syncRegistry();
        this._resolve();
    }

    /**
     * Manually register a project root (stashInit).
     * Persists to global DB so it survives reconnects.
     */
    initProject(rootPath: string, name?: string): string {
        const abs = path.resolve(rootPath);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            throw new Error(`Not a directory: ${abs}`);
        }
        const db = getGlobalDb();
        db.prepare(
            'INSERT OR REPLACE INTO project_roots (root_path, name, created_at) VALUES (?, ?, ?)'
        ).run(abs, name || path.basename(abs), Date.now());

        // Also register in-memory for immediate use
        this._registry.register({
            project_id: path.basename(abs),
            project_name: name || path.basename(abs),
            project_root: abs,
        });

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
    listRegisteredProjects(): ProjectRootRow[] {
        const db = getGlobalDb();
        return db.prepare<unknown[], ProjectRootRow>('SELECT * FROM project_roots ORDER BY created_at DESC').all();
    }

    // --- Private resolution ladder ---

    /**
     * Sync the in-memory ProjectRegistry from the persisted SQLite registry.
     */
    private _syncRegistry(): void {
        try {
            const db = getGlobalDb();
            const rows = db.prepare<unknown[], ProjectRootRow>('SELECT root_path, name FROM project_roots').all();
            for (const row of rows) {
                this._registry.register({
                    project_id: row.name || path.basename(row.root_path),
                    project_name: row.name,
                    project_root: row.root_path,
                });
            }
        } catch {
            // Registry might be empty or DB not ready yet
        }
    }

    _resolve(): void {
        this._resolved = true;

        // Delegate to shared utility with this context's allowed directories and registry
        const root = resolveProjectRoot(process.cwd(), {
            allowedDirectories: this._ctx.getAllowedDirectories(),
            registryEntries: this._registry.listProjects(),
        });

        if (root) {
            this._boundRoot = root;
            this._isGlobal = false;
            return;
        }

        // Global fallback
        this._boundRoot = null;
        this._isGlobal = true;
    }

    // Step 1+2: Resolve from a specific file path (git → markers → registry)
    _resolveFromPath(filePath: string): string | null {
        return resolveProjectRoot(filePath, {
            allowedDirectories: this._ctx.getAllowedDirectories(),
            registryEntries: this._registry.listProjects(),
        });
    }
}

// ---------------------------------------------------------------------------
// Stash table setup — reused by both project DBs and the global DB
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Singleton + integration hooks
// ---------------------------------------------------------------------------

let _instance: ProjectContext | null = null;

export function getProjectContext(ctx: FsContext): ProjectContext {
    if (!_instance) {
        _instance = new ProjectContext(ctx);
    }
    return _instance;
}

/**
 * Hook into server.js — call this when roots change to refresh context.
 */
export function onRootsChanged(): void {
    if (_instance) {
        _instance.refresh();
    }
}
