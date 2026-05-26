import path from 'path';
import fs from 'fs';
import os from 'os';
import { getDb } from './symbol-index.js';
import { ProjectRegistry } from './project-registry.js';
import type { ProjectManifest } from './project-registry.js';
import { normalizePath } from './path-utils.js';
import { clearProjectScopeCache } from '../utils/project-scope.js';
import {
    DbConnection,
    openDb,
    initStashSchema,
} from './db-adapter.js';
import type { ProjectEntry } from '../config/schema.js';
import { expandTilde, CONFIG_PATH } from '../config/schema.js';
import { loadConfig } from '../config/loader.js';

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
    private _notifiedRoots: Set<string> = new Set();
    private _notifyFn: ((message: string) => void) | null = null;
    private _lastConfigMtimeMs: number = 0;

    constructor(ctx: FsContext) {
        this._ctx = ctx;
        this._boundRoot = null;
        this._isGlobal = false;
        this._resolved = false;
        this._explicit = false;
        this._registry = new ProjectRegistry();
    }

    // --- Public API ---

    /**
     * Get the project root. Registry is the SOLE authority for DB routing.
     * Pass an optional filePath to trigger registry-based auto-switch.
     */
    getRoot(filePath?: string): string | null {
        if (filePath) {
            // Registry-first auto-switch — the registry IS the answer
            this._handlePathAccess(filePath);
            return this._boundRoot;
        }

        // No file path — return current binding (may be null/global)
        if (this._resolved) return this._boundRoot;
        this._resolveNoFile();
        return this._boundRoot;
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
        if (!this._resolved) this._resolveNoFile();
        return this._isGlobal;
    }

    /**
     * Force re-resolution. Called when MCP roots change.
     * Explicit bindings (set via initProject) are preserved — they are sticky.
     */
    refresh(): void {
        if (!this._explicit) {
            this._boundRoot = null;
            this._isGlobal = false;
            this._resolved = false;
        }
        clearProjectScopeCache();
        // Don't re-sync from SQLite on refresh — config registry is authoritative
        if (!this._explicit) {
            this._resolveNoFile();
        }
    }

    /**
     * Manually register a project root (stashInit).
     * In-memory only — config file is the persistent source of truth.
     */
    initProject(rootPath: string, name?: string): string {
        const abs = path.resolve(rootPath);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            throw new Error(`Not a directory: ${abs}`);
        }

        // Register in-memory for immediate use
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
     * Register an MCP root as a session hint. Does NOT set _explicit,
     * does NOT persist to SQLite, does NOT block auto-switching.
     * Only binds if it matches a registered project.
     */
    registerSessionRoot(rootPath: string, _name?: string): void {
        const normalizedRoot = normalizePath(path.resolve(rootPath));

        // Only bind if it matches a registered project
        const manifest = this._registry.findProject(normalizedRoot);
        if (manifest && !this._explicit) {
            this._boundRoot = normalizePath(path.resolve(manifest.project_root));
            this._isGlobal = false;
            this._resolved = true;
            console.error(
                `[ProjectContext] Session root matched project: ${manifest.project_id}`
            );
        }
    }

    /**
     * Reload the registry from config entries. Atomic replacement.
     * Config file is authoritative — SQLite-persisted entries are NOT merged.
     */
    reloadRegistry(entries: ProjectEntry[]): void {
        const manifests: ProjectManifest[] = [];
        for (const e of entries) {
            if (!e.project_id || !e.project_root) continue;

            let resolvedRoot = normalizePath(path.resolve(expandTilde(e.project_root)));
            // Canonicalize symlinks so registry matches realpath'd tool paths
            try { resolvedRoot = fs.realpathSync(resolvedRoot); } catch { /* dir may not exist yet */ }

            const m: ProjectManifest = {
                project_id: e.project_id,
                project_name: e.project_name,
                project_root: resolvedRoot,
            };
            if (e.description != null) m.description = e.description;
            if (e.language != null) m.language = e.language;
            if (e.tags !== undefined) m.tags = e.tags;
            if (e.include !== undefined) m.include = e.include;
            if (e.exclude !== undefined) m.exclude = e.exclude;
            if (e.entry_point != null) m.entry_point = e.entry_point;

            manifests.push(m);
        }

        // Replace entirely — old registry is GC'd, no _syncRegistry
        this._registry = new ProjectRegistry(manifests);

        // Re-evaluate current binding against new registry
        if (this._boundRoot && !this._explicit) {
            const match = this._registry.findProject(this._boundRoot);
            if (!match) {
                this._boundRoot = null;
                this._isGlobal = true;
            }
        }

        // Clear notification dedup so new paths can be notified fresh
        this._notifiedRoots.clear();

        console.error(`[ProjectContext] Registry reloaded: ${manifests.length} projects`);
    }

    /**
     * Set the notification function (fires sendLoggingMessage).
     */
    setNotifyFn(fn: (message: string) => void): void {
        this._notifyFn = fn;
    }

    // --- Private resolution ---

    /**
     * Registry-based auto-switch. Called from getRoot() on every file access.
     * Fast-path: if path is inside current bound root, no-op (one string check).
     * Only hits the registry when path is OUTSIDE current root.
     * Lazy reload: on miss, re-reads config if file changed since last load.
     */
    private _handlePathAccess(resolvedPath: string): void {
        // Fast path — same project, free string comparison
        if (this._boundRoot !== null) {
            if (this._isPathInside(resolvedPath, this._boundRoot)) {
                return;
            }
        }

        // Path is outside current root — check registry
        let manifest = this._registry.findProject(resolvedPath);

        // Lazy reload: if miss, check if config file changed and retry once
        if (!manifest) {
            if (this._tryLazyReload()) {
                manifest = this._registry.findProject(resolvedPath);
            }
        }

        if (manifest) {
            // Matched a registered project — switch
            const newRoot = normalizePath(path.resolve(manifest.project_root));
            if (newRoot !== this._boundRoot) {
                this._boundRoot = newRoot;
                this._isGlobal = false;
                this._resolved = true;
                console.error(
                    `[ProjectContext] Switched to project: ${manifest.project_id} (${newRoot})`
                );
            }
        } else if (!this._explicit) {
            // No match — switch to global if not explicitly bound
            if (!this._isGlobal) {
                this._boundRoot = null;
                this._isGlobal = true;
                this._resolved = true;
            }
            // Notify once per unique unrecognized root (gated on allowed dirs)
            this._notifyGlobalFallback(resolvedPath);
        }
        // If _explicit, ignore — explicit bindings are sticky
    }

    /**
     * No-file resolution. Only uses registry + allowed dirs that match registry.
     * Never promotes unregistered paths to projects via git/markers.
     */
    private _resolveNoFile(): void {
        this._resolved = true;

        // Check if any allowed directory matches a registered project
        const allowedDirs = this._ctx.getAllowedDirectories();
        for (const dir of allowedDirs) {
            const manifest = this._registry.findProject(dir);
            if (manifest) {
                this._boundRoot = normalizePath(path.resolve(manifest.project_root));
                this._isGlobal = false;
                return;
            }
        }

        // No registry match — global mode
        this._boundRoot = null;
        this._isGlobal = true;
    }

    /**
     * Only notify for paths under allowed directories — suppress system/temp paths.
     * Deduplicate by finding the nearest project-ish root.
     */
    private _notifyGlobalFallback(resolvedPath: string): void {
        if (!this._notifyFn) return;

        // Only notify for paths under allowed directories
        const allowedDirs = this._ctx.getAllowedDirectories();
        if (allowedDirs.length > 0) {
            const isUnderAllowed = allowedDirs.some(
                dir => resolvedPath === dir || resolvedPath.startsWith(dir + path.sep)
            );
            if (!isUnderAllowed) return;
        }

        // Deduplicate by the probable project root of this unregistered path
        const rootGuess = this._findNearestProjectishRoot(resolvedPath);
        if (this._notifiedRoots.has(rootGuess)) return;
        this._notifiedRoots.add(rootGuess);

        this._notifyFn(
            `Path "${rootGuess}" is not a registered project. Using global DB. ` +
            `Add it to ~/.zenith-mcp/config under ### Projects to enable project-scoped features.`
        );
    }

    /**
     * Walk up from resolvedPath looking for .git or common markers.
     * Capped at allowed-directory boundaries to avoid unbounded filesystem traversal.
     * Used ONLY for notification dedup keys — NOT for project resolution.
     */
    private _findNearestProjectishRoot(resolvedPath: string): string {
        const markers = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'];
        const allowedDirs = this._ctx.getAllowedDirectories();
        let dir = path.dirname(resolvedPath);
        const root = path.parse(dir).root;

        while (dir !== root) {
            for (const marker of markers) {
                try {
                    fs.statSync(path.join(dir, marker));
                    return dir;
                } catch { /* not found, keep walking */ }
            }
            // Stop at the allowed-dir boundary — don't walk above it
            if (allowedDirs.some(ad => dir === ad)) break;
            dir = path.dirname(dir);
        }

        return path.dirname(resolvedPath);
    }

    /**
     * Check if a path is inside (or equal to) a root directory.
     * Uses case-insensitive comparison on Windows/macOS where filesystems are
     * typically case-insensitive.
     */
    private _isPathInside(filePath: string, root: string): boolean {
        if (process.platform === 'win32' || process.platform === 'darwin') {
            const fp = filePath.toLowerCase();
            const rt = root.toLowerCase();
            return fp === rt || fp.startsWith(rt + path.sep);
        }
        return filePath === root || filePath.startsWith(root + path.sep);
    }

    /**
     * Lazy reload: re-read config file only if its mtime changed since last load.
     * Returns true if the registry was actually refreshed (caller should retry lookup).
     */
    private _tryLazyReload(): boolean {
        try {
            const stat = fs.statSync(CONFIG_PATH);
            if (stat.mtimeMs === this._lastConfigMtimeMs) return false;
            this._lastConfigMtimeMs = stat.mtimeMs;
        } catch {
            // Config file doesn't exist — nothing to reload
            return false;
        }

        try {
            const config = loadConfig();
            this.reloadRegistry(config.projects);
            return true;
        } catch {
            return false;
        }
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
