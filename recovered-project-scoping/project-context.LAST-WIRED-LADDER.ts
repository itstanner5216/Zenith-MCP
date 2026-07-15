import path from 'path';
import fs from 'fs';
import os from 'os';
import { getDb } from './symbol-index.js';
import { ProjectRegistry } from './project-registry.js';
import { resolveProjectRoot, clearProjectScopeCache } from '../utils/project-scope.js';
import { getProcessTreeCwdsResolved } from '../utils/process-tree.js';
import {
    DbConnection,
    openDb,
    initGlobalSchema,
    initStashSchema,
    upsertProjectRoot,
    listProjectRoots,
    getAllProjectRootPaths
} from './db-adapter.js';

const ZENITH_HOME = path.join(os.homedir(), '.zenith-mcp');
const GLOBAL_DB_PATH = path.join(ZENITH_HOME, 'global-stash.db');

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

let _globalDb: DbConnection | null = null;

function getGlobalDb(): DbConnection {
    if (_globalDb) return _globalDb;
    fs.mkdirSync(ZENITH_HOME, { recursive: true });
    _globalDb = openDb(GLOBAL_DB_PATH);
    initGlobalSchema(_globalDb);
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
    getStashDb(filePath?: string): { db: DbConnection; root: string | null; isGlobal: boolean } {
        const root = this.getRoot(filePath);
        if (root) {
            const conn = getDb(root);
            ensureStashTables(conn);
            return { db: conn, root, isGlobal: false };
        }
        const conn = getGlobalDb();
        ensureStashTables(conn);
        return { db: conn, root: null, isGlobal: true };
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
     * Explicit bindings (set via initProject) are preserved — they are sticky.
     */
    refresh(): void {
        // Don't reset explicit bindings — initProject() is sticky
        if (!this._explicit) {
            this._boundRoot = null;
            this._isGlobal = false;
            this._resolved = false;
        }
        clearProjectScopeCache();
        this._syncRegistry();
        if (!this._explicit) {
            this._resolve();
        }
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
        const conn = getGlobalDb();
        upsertProjectRoot(conn, {
            rootPath: abs,
            name: name || path.basename(abs),
            createdAt: Date.now()
        });

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
    listRegisteredProjects(): { root_path: string; name: string; created_at: number }[] {
        const conn = getGlobalDb();
        return listProjectRoots(conn);
    }

    // --- Private resolution ladder ---

    /**
     * Sync the in-memory ProjectRegistry from the persisted SQLite registry.
     */
    private _syncRegistry(): void {
        try {
            const conn = getGlobalDb();
            const rows = getAllProjectRootPaths(conn);
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

        const allowedDirs = this._ctx.getAllowedDirectories();
        const registryEntries = this._registry.listProjects();
        const resolveOpts = { allowedDirectories: allowedDirs, registryEntries };

        // Priority 1: Try each allowed directory (from MCP roots / CLI args).
        // These are the ACTUAL project dirs the client told us about.
        for (const dir of allowedDirs) {
            const root = resolveProjectRoot(dir, resolveOpts);
            if (root) {
                this._boundRoot = root;
                this._isGlobal = false;
                return;
            }
        }

        // Priority 2: Walk the process tree for candidate CWDs.
        // The parent shell/IDE almost certainly has a CWD in the user's project.
        try {
            const treeCwds = getProcessTreeCwdsResolved();
            for (const { cwd, source } of treeCwds) {
                const root = resolveProjectRoot(cwd, resolveOpts);
                if (root) {
                    console.error(`Project detected via process tree: ${root} (source: ${source})`);
                    this._boundRoot = root;
                    this._isGlobal = false;
                    return;
                }
            }
        } catch {
            // Process tree walk failed entirely — continue to global fallback
        }

        // Global fallback — the server operates without a bound project.
        // Tools will resolve per-file when given file paths.
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

function ensureStashTables(conn: DbConnection): void {
    initStashSchema(conn);
}

// ---------------------------------------------------------------------------
// Singleton + integration hooks
// ---------------------------------------------------------------------------

let _instances = new WeakMap<FsContext, ProjectContext>();

export function getProjectContext(ctx: FsContext): ProjectContext {
    let instance = _instances.get(ctx);
    if (!instance) {
        instance = new ProjectContext(ctx);
        _instances.set(ctx, instance);
    }
    return instance;
}

/**
 * Refresh the ProjectContext for the given session when MCP roots change.
 * ctx is REQUIRED — every roots change happens within a session context.
 * If you're calling this without a ctx, you have a bug upstream.
 */
export function onRootsChanged(ctx: FsContext): void {
    const instance = _instances.get(ctx);
    if (instance) {
        instance.refresh();
    } else {
        // No ProjectContext for this ctx yet — that's fine, it will be
        // created on first tool call and will pick up the new dirs then.
        console.error("onRootsChanged: no ProjectContext for this session yet (will be created on first use)");
    }
}

/** Reset the context — for test isolation only. */
export function resetProjectContext(ctx?: FsContext): void {
    if (ctx) {
        _instances.delete(ctx);
        return;
    }
    _instances = new WeakMap<FsContext, ProjectContext>();
}
