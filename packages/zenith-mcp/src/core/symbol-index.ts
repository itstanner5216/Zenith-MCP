import fs from 'fs/promises';
import { mkdirSync, existsSync, writeFileSync, statSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { getLangForFile, isSupported } from './tree-sitter.js';
import { getDefaultExcludes, isSensitive, getRefactorVersionTtlMs } from './shared.js';
import { minimatch } from 'minimatch';
import {
    DbConnection,
    openDb,
    closeDb,
    initSymbolSchema,
    getFileHash,
    upsertFile,
    deleteFile,
    getDefinitionNamesByFile,
    clearEdgeTargetsByNames,
    getFilesByPrefix,
    deleteSymbolsByFile,
    getCallers,
    getCallees,
    getCallersFiltered,
    getCalleesFiltered,
    snapshotVersion,
    getVersionHistory as adapterGetVersionHistory,
    getVersionText as adapterGetVersionText,
    getVersionMeta,
    pruneOldVersions,
    pruneOtherSessions,
    runTransaction,
    findSymbolFiles,
    upsertProjectRoot,
} from './db-adapter.js';
import { extractParsedFile } from './indexing/extract.js';
import { persistParsedFile } from './indexing/persist.js';
import { resolveEdgesForNames } from './indexing/resolve.js';

// ---------------------------------------------------------------------------
// Repo root detection
// ---------------------------------------------------------------------------

/**
 * Find the git repository root for a given file or directory path.
 *
 * Strategy:
 * 1. Walk up from the path looking for a `.git` directory (pure filesystem, no CLI needed)
 * 2. If found, optionally verify with `git rev-parse` for worktree/submodule accuracy
 * 3. Falls back to the .git directory's parent if git CLI is unavailable
 */
export function findRepoRoot(filePath: string): string | null {
    try {
        const stat = statSync(filePath);
        let dir = stat.isDirectory() ? filePath : path.dirname(filePath);

        // Walk up looking for .git — this ALWAYS works, no external dependency
        while (true) {
            try {
                const gitPath = path.join(dir, '.git');
                const gitStat = statSync(gitPath);
                if (gitStat.isDirectory() || gitStat.isFile()) {
                    // Found .git — try git CLI for accuracy (handles worktrees,
                    // submodules), but fall back to this dir if git isn't available
                    try {
                        const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
                            cwd: dir,
                            encoding: 'utf-8',
                            timeout: 5000,
                            stdio: ['ignore', 'pipe', 'ignore'],
                        });
                        return result.trim();
                    } catch {
                        // git CLI unavailable or failed — the .git parent IS the root
                        return dir;
                    }
                }
            } catch {
                // No .git here — continue walking up
            }

            const parent = path.dirname(dir);
            if (parent === dir) break; // reached filesystem root
            dir = parent;
        }

        return null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Database provisioning
// ---------------------------------------------------------------------------

const _dbCache = new Map<string, DbConnection>();
let _exitHandlerRegistered = false;

export function getDb(repoRoot: string): DbConnection {
    // Explicit guard instead of a non-null assertion (POLARIS Task 1.5 /
    // AGENTS.md Rule 6): the has/get pair is a TOCTOU-free single read.
    const cached = _dbCache.get(repoRoot);
    if (cached) return cached;

    const mcpDir = path.join(repoRoot, '.mcp'); // nosemgrep
    mkdirSync(mcpDir, { recursive: true }); // nosemgrep

    const gitignorePath = path.join(mcpDir, '.gitignore'); // nosemgrep
    if (!existsSync(gitignorePath)) { // nosemgrep
        writeFileSync(gitignorePath, '*\n'); // nosemgrep
    }

    const conn = openDb(path.join(mcpDir, 'symbols.db'));
    initSymbolSchema(conn);

    if (!_exitHandlerRegistered) {
        _exitHandlerRegistered = true;
        process.on('exit', () => {
            for (const cachedConn of _dbCache.values()) {
                try { closeDb(cachedConn); } catch { /* ignore */ }
            }
        });
    }

    try {
        pruneOldVersions(conn, Date.now() - getRefactorVersionTtlMs());
    } catch {
        /* table may be mid-migration */
    }

    _dbCache.set(repoRoot, conn);
    try {
        upsertProjectRoot(conn, { rootPath: repoRoot, name: path.basename(repoRoot), createdAt: Date.now() });
    } catch { /* registry upsert is best-effort; must not break getDb */ }
    return conn;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export function getSessionId(clientSessionId?: string): string {
    if (clientSessionId) return clientSessionId;
    return `${process.pid}:${process.cwd()}`;
}

export function pruneOldSessions(db: DbConnection, currentSessionId: string): void {
    pruneOtherSessions(db, currentSessionId);
}


// ---------------------------------------------------------------------------
// File hashing
// ---------------------------------------------------------------------------

function hashFileContent(content: string): string {
    return createHash('md5').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// IndexAddress — the one store-addressing contract (POLARIS Task 1.4)
// ---------------------------------------------------------------------------

/**
 * The single addressing object every ingestion and read path shares
 * (POLARIS Decision 19): one database handle, one scope identity, one codec.
 * Code never derives a DB key with an ad-hoc `path.relative` after routing —
 * the codec IS the key derivation, and persistence receives keys already
 * encoded.
 *
 * Construction is restricted by convention to `ProjectContext`
 * (getIntelligenceStore) and the factories below (the project factory doubles
 * as the test-only entry). Store keys are slash-normalized:
 *   project mode:  `src/lib/a.ts`
 *   global mode:   `g/<sha256(canonicalAllowedRoot)>/<root-relative path>`
 */
export interface IndexAddress {
    db: DbConnection;
    mode: 'project' | 'global';
    scopeRoot: string;
    scopeKey: string;
    toStoreKey(absPath: string): string | null;
    fromStoreKey(storeKey: string): string | null;
}

function slashNormalize(relPath: string): string {
    return relPath.split(path.sep).join('/');
}

/**
 * Project-mode address: keys are repo-relative slash-normalized paths —
 * byte-identical to the historical `path.relative` keys on POSIX, so
 * project-mode visible paths do not change. Also the test-only factory.
 */
export function createProjectIndexAddress(db: DbConnection, repoRoot: string): IndexAddress {
    const scopeRoot = path.resolve(repoRoot);
    return {
        db,
        mode: 'project',
        scopeRoot,
        scopeKey: scopeRoot,
        toStoreKey(absPath: string): string | null {
            const rel = path.relative(scopeRoot, absPath);
            if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
            return slashNormalize(rel);
        },
        fromStoreKey(storeKey: string): string | null {
            if (storeKey.startsWith('g/')) return null;
            return storeKey;
        },
    };
}

/**
 * Global-mode address for one allowed root (POLARIS Decision 18/20): keys are
 * `g/<sha256(canonicalAllowedRoot)>/<root-relative slash path>`. The codec
 * accepts only descendants of its root — a global anchor can never sweep
 * another allowed root's namespace, and two roots' identical relative paths
 * can never collide.
 */
export function createGlobalIndexAddress(db: DbConnection, allowedRoot: string): IndexAddress {
    const scopeRoot = path.resolve(allowedRoot);
    const rootHash = createHash('sha256').update(scopeRoot).digest('hex');
    const scopeKey = `g/${rootHash}`;
    return {
        db,
        mode: 'global',
        scopeRoot,
        scopeKey,
        toStoreKey(absPath: string): string | null {
            const rel = path.relative(scopeRoot, absPath);
            if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
            return `${scopeKey}/${slashNormalize(rel)}`;
        },
        fromStoreKey(storeKey: string): string | null {
            const prefix = `${scopeKey}/`;
            if (!storeKey.startsWith(prefix)) return null;
            return storeKey.slice(prefix.length);
        },
    };
}

/** Internal: bridge the legacy `(db, repoRoot)` call shape onto an address. */
function toProjectAddress(db: DbConnection, repoRoot: string): IndexAddress {
    return createProjectIndexAddress(db, repoRoot);
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Provisional source-size safety bound (POLARIS Decision 23: source file
 * bytes 16 MiB; settled at Wave 7 from measured p99 with 4x headroom — the
 * constant moves to core/intelligence/limits.ts when Wave 2 creates it).
 * Files over the bound are never parsed; they receive the versioned
 * too-large sentinel below instead, and their previously persisted facts are
 * never purged by the skip.
 */
export const PROVISIONAL_MAX_SOURCE_BYTES = 16 * 1024 * 1024;

/**
 * Versioned sentinel stored in files.hash for over-limit files:
 * `toolarge@1:<md5-of-content>`. The embedded content hash keeps freshness
 * honest — when the file changes (and possibly shrinks under the bound), the
 * hash mismatch routes it back through indexFile, which parses it normally.
 */
export const TOO_LARGE_SENTINEL_PREFIX = 'toolarge@1:';

/** Typed per-file indexing outcome (POLARIS Task 1.2). */
export type IndexFileOutcome =
    | 'indexed'            // parsed and persisted
    | 'fresh'              // stored hash matched; nothing to do
    | 'too_large'          // over the source-byte bound; sentinel recorded, no parse, no purge
    | 'purged_unindexable' // unsupported/sensitive/excluded path; stale rows purged
    | 'purged_unreadable'  // disk read failed; stale rows purged
    | 'skipped_outside_root'; // path escapes repoRoot; untouched

function shouldIndexFile(repoRoot: string, absPath: string): boolean {
    if (!isSupported(absPath)) return false;
    if (isSensitive(absPath)) return false;
    const relPath = path.relative(repoRoot, absPath);
    const base = path.basename(absPath);
    const excludes = getDefaultExcludes();
    // Reject files whose path passes through an excluded directory (e.g. node_modules/, .git/).
    // The base-name and pattern checks below only catch exact filename matches and glob patterns,
    // not files nested inside an excluded directory when indexFile() is called directly.
    const dirSegments = relPath.split(path.sep).slice(0, -1);
    if (dirSegments.some(seg => excludes.some(pattern =>
        seg === pattern || minimatch(seg, pattern, { dot: true, nocase: true })
    ))) return false;
    return !excludes.some(pattern =>
        base === pattern ||
        minimatch(relPath, pattern, { dot: true, nocase: true }) ||
        minimatch(relPath, `**/${pattern}`, { dot: true, nocase: true })
    );
}

function purgeIndexedPath(db: DbConnection, relPath: string): void {
    runTransaction(db, () => {
        // Deletion-side affected-name resolution (POLARIS Task 1.3): removing
        // this file's definitions can make a previously ambiguous name unique
        // elsewhere. Capture the names, purge (the symbols cascade SET-NULLs
        // any edges resolved to them), then re-resolve those names in the
        // SAME transaction — a purge never commits owing resolution work.
        const oldDefinitionNames = getDefinitionNamesByFile(db, relPath);
        deleteSymbolsByFile(db, relPath);
        deleteFile(db, relPath);
        if (oldDefinitionNames.length > 0) {
            const cleared = clearEdgeTargetsByNames(db, oldDefinitionNames);
            resolveEdgesForNames(db, [...new Set([...oldDefinitionNames, ...cleared])]);
        }
    });
}

/**
 * Index a single file's symbols into the store named by `address`
 * (POLARIS Task 1.4 — the address-cored primitive; the legacy `(db, repoRoot)`
 * wrapper below builds a project-mode address, so existing callers are
 * unchanged and project-mode visible paths stay byte-identical).
 *
 * `content` (optional, content-addressed path): when provided, the file's bytes
 * are taken directly from `content` — NO disk read occurs and `absFilePath` is
 * used only for path math (store key / language detection by extension). The
 * stored file hash is computed from the SAME `content` that is indexed, so a
 * later content-addressed freshness check (ensureFreshFromContentAt) matches
 * exactly. When `content` is omitted, behaviour is unchanged: the source is read
 * from disk and an unreadable file purges its stale index rows.
 *
 * Returns the typed {@link IndexFileOutcome} for the file (POLARIS Task 1.2).
 * Over-limit sources (PROVISIONAL_MAX_SOURCE_BYTES) are never parsed: the
 * versioned too-large sentinel is recorded in files.hash and any previously
 * persisted facts for the path are left untouched — a skip is not evidence of
 * emptiness.
 */
export async function indexFileAt(address: IndexAddress, absFilePath: string, content?: string): Promise<IndexFileOutcome> {
    const db = address.db;
    const storeKey = address.toStoreKey(absFilePath);
    if (storeKey === null) return 'skipped_outside_root';

    if (!shouldIndexFile(address.scopeRoot, absFilePath)) {
        purgeIndexedPath(db, storeKey);
        return 'purged_unindexable';
    }

    let source: string;
    if (content !== undefined) {
        // Content-addressed: the caller already holds the exact bytes. Skip the
        // disk read entirely (closes the read-vs-reindex race) and index these.
        source = content;
    } else {
        try {
            source = await fs.readFile(absFilePath, 'utf-8'); // nosemgrep
        } catch {
            purgeIndexedPath(db, storeKey);
            return 'purged_unreadable';
        }
    }

    // Hash the SAME content that is indexed so a content-addressed freshness
    // check (ensureFreshFromContentAt) compares like-for-like.
    const hash = hashFileContent(source);
    const existingHash = getFileHash(db, storeKey);
    if (existingHash && existingHash === hash) return 'fresh';

    // Source-byte safety bound — checked BEFORE any parse, for both disk and
    // supplied content (POLARIS Task 1.2). Record the versioned sentinel so
    // the skip is typed and re-checkable, keep every previously persisted
    // fact (never replace real facts with an empty parse), and do not parse.
    if (Buffer.byteLength(source, 'utf8') > PROVISIONAL_MAX_SOURCE_BYTES) {
        const sentinel = TOO_LARGE_SENTINEL_PREFIX + hash;
        if (existingHash !== sentinel) {
            upsertFile(db, storeKey, sentinel, Date.now());
        }
        return 'too_large';
    }

    const langName = getLangForFile(absFilePath);
    if (!langName) {
        purgeIndexedPath(db, storeKey);
        return 'purged_unindexable';
    }

    // The record's relPath field carries the STORE KEY — persistence receives
    // it already encoded and never calls path.relative (Decision 19).
    const parsed = await extractParsedFile(source, langName, storeKey, hash);
    if (!parsed) {
        purgeIndexedPath(db, storeKey);
        return 'purged_unindexable';
    }
    persistParsedFile(db, parsed);
    return 'indexed';
}

/** Legacy call shape — builds a project-mode address (keys unchanged). */
export async function indexFile(db: DbConnection, repoRoot: string, absFilePath: string, content?: string): Promise<IndexFileOutcome> {
    return indexFileAt(toProjectAddress(db, repoRoot), absFilePath, content);
}

interface IndexDirectoryOpts {
    maxFiles?: number;
}

/**
 * Honest walk coverage (POLARIS Task 1.2). `complete` is true only when every
 * indexable file under the directory was visited; `stopReason` names the cap
 * that truncated an incomplete walk ('max_files') or why nothing was walked
 * at all ('outside_scope'). Purging of unvisited rows happens ONLY on
 * complete walks — an incomplete walk is not evidence of deletion.
 */
export interface IndexCoverage {
    visited: number;
    complete: boolean;
    stopReason: 'max_files' | 'outside_scope' | null;
}

export async function indexDirectoryAt(address: IndexAddress, dirPath: string, opts: IndexDirectoryOpts = {}): Promise<IndexCoverage> {
    const db = address.db;
    const maxFiles = opts.maxFiles || 5000;
    const dirKey = address.toStoreKey(dirPath);
    if (dirKey === null) {
        return { visited: 0, complete: false, stopReason: 'outside_scope' };
    }
    const discovered: string[] = [];
    const excludes = getDefaultExcludes();

    // Discovery is exhaustive (directory metadata only — cheap relative to
    // parsing) so that (a) `complete` is a fact, not a guess, and (b) cap
    // membership is deterministic: the discovered set is sorted before the
    // cap is applied, so WHICH files a truncated walk indexes never depends
    // on readdir order (POLARIS Task 1.2).
    async function walk(dir: string): Promise<void> {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; } // nosemgrep
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name); // nosemgrep
            if (entry.isDirectory()) {
                const relDir = path.relative(address.scopeRoot, fullPath);
                if (excludes.some(pattern =>
                    entry.name === pattern ||
                    minimatch(relDir, pattern, { dot: true, nocase: true }) ||
                    minimatch(relDir, `**/${pattern}`, { dot: true, nocase: true })
                )) {
                    continue;
                }
                await walk(fullPath);
            } else if (entry.isFile() && shouldIndexFile(address.scopeRoot, fullPath)) {
                discovered.push(fullPath);
            }
        }
    }

    await walk(dirPath);

    discovered.sort();
    const complete = discovered.length <= maxFiles;
    const filePaths = complete ? discovered : discovered.slice(0, maxFiles);

    // Purge stale DB rows for files under this directory that were not visited
    // (deleted files, files under now-excluded directories) — but ONLY when
    // the walk was complete. On a truncated walk, "not visited" says nothing
    // about existence, and purging on it destroyed live rows (defect G8).
    if (complete) {
        const prefix = dirKey === '' ? '' : (dirKey.endsWith('/') ? dirKey : `${dirKey}/`);
        const indexedFiles = getFilesByPrefix(db, `${prefix}%`);
        const visitedKeys = new Set(filePaths.map(f => address.toStoreKey(f)));
        for (const row of indexedFiles) {
            if (!visitedKeys.has(row.path)) {
                purgeIndexedPath(db, row.path);
            }
        }
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
        const batch = filePaths.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(f => indexFileAt(address, f)));
    }

    // No trailing whole-DB resolve pass (POLARIS Task 1.3): every persist
    // resolves its own affected names inside its own transaction, and a file
    // indexed EARLIER in this batch whose references point at a file indexed
    // LATER is healed by the later persist (the later file's definitions are
    // new names, so the clear-and-re-resolve covers the earlier edges).
    // Resolution therefore converges per-file with no end-of-batch sweep owed.

    return {
        visited: filePaths.length,
        complete,
        stopReason: complete ? null : 'max_files',
    };
}

/** Legacy call shape — builds a project-mode address (keys unchanged). */
export async function indexDirectory(db: DbConnection, repoRoot: string, dirPath: string, opts: IndexDirectoryOpts = {}): Promise<IndexCoverage> {
    return indexDirectoryAt(toProjectAddress(db, repoRoot), dirPath, opts);
}

export async function ensureIndexFreshAt(address: IndexAddress, absFilePaths: string[]): Promise<number> {
    const db = address.db;
    let reindexed = 0;
    for (const absPath of absFilePaths) {
        const storeKey = address.toStoreKey(absPath);
        if (storeKey === null) continue;
        if (!shouldIndexFile(address.scopeRoot, absPath)) {
            purgeIndexedPath(db, storeKey);
            continue;
        }
        let source: string;
        try { source = await fs.readFile(absPath, 'utf-8'); } catch { // nosemgrep
            // File is unreadable or deleted — purge stale index rows
            purgeIndexedPath(db, storeKey);
            continue;
        }
        const hash = hashFileContent(source);
        const existingHash = getFileHash(db, storeKey);
        if (!existingHash || existingHash !== hash) {
            // Only a real (re)parse counts as reindexed: a too-large skip
            // records its sentinel without changing any fact rows (Task 1.2).
            const outcome = await indexFileAt(address, absPath);
            if (outcome === 'indexed') reindexed++;
        }
    }
    // No batch-level resolve pass (POLARIS Task 1.3): each reindexed file's
    // persist transaction cleared and re-resolved its own affected names
    // before committing. There is nothing owed here — and nothing for a
    // same-byte freshness pass to "heal" later.
    return reindexed;
}

/** Legacy call shape — builds a project-mode address (keys unchanged). */
export async function ensureIndexFresh(db: DbConnection, repoRoot: string, absFilePaths: string[]): Promise<number> {
    return ensureIndexFreshAt(toProjectAddress(db, repoRoot), absFilePaths);
}

/**
 * Content-addressed freshness for a SINGLE file whose exact bytes the caller
 * already holds (e.g. read-tool rawText, or post-edit content). Mirrors the
 * per-file body of {@link ensureIndexFreshAt} — same shouldIndexFile / purge
 * guard, same hash-compare-reindex logic, same `number` return (count
 * reindexed: 0 or 1) — but asks the content-addressed question "do the DB facts
 * describe THESE bytes?" instead of re-reading disk.
 *
 * Why content-addressed (review [#64] → C+): the caller holds the file's exact
 * bytes already, so re-reading disk to check freshness is both redundant work
 * and a race — the bytes on disk at check time may differ from the bytes the
 * caller is about to compress/persist. Hashing the in-hand `content` and, on a
 * miss, reindexing FROM that same `content` (no disk read) guarantees the
 * indexed facts describe exactly the bytes the caller will consume.
 *
 * Note vs ensureIndexFreshAt: there is no unreadable-file branch — the bytes
 * are in-hand by construction, so the only purge path is the shouldIndexFile
 * guard (unsupported / sensitive / excluded path).
 *
 * @returns 1 if the file was (re)indexed from `content`, 0 if facts were
 *          already fresh (stored hash matched) or the path is not indexable.
 */
export async function ensureFreshFromContentAt(address: IndexAddress, absFilePath: string, content: string): Promise<number> {
    const db = address.db;
    const storeKey = address.toStoreKey(absFilePath);
    if (storeKey === null) return 0;

    if (!shouldIndexFile(address.scopeRoot, absFilePath)) {
        purgeIndexedPath(db, storeKey);
        return 0;
    }

    const hash = hashFileContent(content);
    const existingHash = getFileHash(db, storeKey);
    if (!existingHash || existingHash !== hash) {
        const outcome = await indexFileAt(address, absFilePath, content);
        if (outcome !== 'indexed') return 0; // too-large sentinel or purge — no new facts
        // Resolution already happened inside the persist transaction
        // (POLARIS Task 1.3) — nothing further is owed here.
        return 1;
    }
    return 0;
}

/** Legacy call shape — builds a project-mode address (keys unchanged). */
export async function ensureFreshFromContent(db: DbConnection, repoRoot: string, absFilePath: string, content: string): Promise<number> {
    return ensureFreshFromContentAt(toProjectAddress(db, repoRoot), absFilePath, content);
}

// ---------------------------------------------------------------------------
// Impact queries
// ---------------------------------------------------------------------------

interface ImpactQueryOpts {
    file?: string | null;
    depth?: number;
    direction?: string;
}

interface ImpactResult {
    name: string;
    filePath?: string;
    refCount?: number;
    callCount?: number;
}

interface ImpactDisambiguate {
    disambiguate: true;
    definitions: string[];
}

interface ImpactSuccess {
    results: ImpactResult[];
    total: number;
}

export function impactQuery(db: DbConnection, symbolName: string, opts: ImpactQueryOpts = {}): ImpactDisambiguate | ImpactSuccess {
    const { file, depth = 1, direction = 'forward' } = opts;

    // Disambiguation: check for multiple definitions
    const defFiles = findSymbolFiles(db, symbolName, 'def');

    if (defFiles.length > 1 && !file) {
        return { disambiguate: true, definitions: defFiles.map((r: { file_path: string }) => r.file_path) };
    }

    const visited = new Set([symbolName]);
    const results: ImpactResult[] = [];

    // fileConstraint: only honoured on the first hop (the named symbol's definition site).
    function queryLevel(names: string[], fileConstraint: string | null | undefined): ImpactResult[] {
        const out: ImpactResult[] = [];
        for (const name of names) {
            if (direction === 'forward') {
                // Who calls `name`? When fileConstraint is set, exclude callers from files
                // that define their own competing `name` (they likely call their local version).
                const rows = fileConstraint
                    ? getCallersFiltered(db, name, name, fileConstraint)
                    : getCallers(db, name);
                for (const row of rows) {
                    out.push({ name: row.name, filePath: row.file_path, refCount: row.refCount });
                }
            } else {
                // What does `name` call? When fileConstraint is set, scope to that definition file.
                const rows = fileConstraint
                    ? getCalleesFiltered(db, name, fileConstraint)
                    : getCallees(db, name);
                for (const row of rows) {
                    out.push({ name: row.name, callCount: row.callCount });
                }
            }
        }
        return out;
    }

    let currentNames = [symbolName];
    for (let d = 0; d < depth; d++) {
        // Pass file constraint only on the first hop; deeper hops explore the graph freely.
        const levelResults = queryLevel(currentNames, d === 0 ? file : null);
        const newNames: string[] = [];
        for (const r of levelResults) {
            if (!visited.has(r.name)) {
                visited.add(r.name);
                newNames.push(r.name);
                results.push(r);
            }
        }
        if (newNames.length === 0) break;
        currentNames = newNames;
    }

    return { results, total: results.length };
}

// ---------------------------------------------------------------------------
// Version management
// ---------------------------------------------------------------------------

export function snapshotSymbol(db: DbConnection, symbolName: string, filePath: string | null, originalText: string, sessionId: string, line: number | null = null): void {
    const textHash = createHash('md5').update(originalText || '').digest('hex');
    snapshotVersion(db, {
        symbolName,
        filePath,
        text: originalText,
        sessionId,
        createdAt: Date.now(),
        line: line ?? null,
        textHash
    });
}

export function getVersionHistory(db: DbConnection, symbolName: string, sessionId: string, filePath?: string): ReturnType<typeof adapterGetVersionHistory> {
    return adapterGetVersionHistory(db, symbolName, sessionId, filePath);
}

export function getVersionText(db: DbConnection, versionId: number): string | null {
    return adapterGetVersionText(db, versionId);
}

export function restoreVersion(db: DbConnection, symbolName: string, versionId: number, sessionId: string, currentText?: string): string {
    const row = getVersionMeta(db, versionId);
    if (!row) throw new Error('Version not found.');
    if (row.symbol_name !== symbolName) {
        throw new Error(`Version ${versionId} belongs to "${row.symbol_name}", not "${symbolName}".`);
    }
    if (row.session_id !== sessionId) {
        throw new Error('Version belongs to a different session.');
    }
    if (currentText !== undefined) {
        snapshotSymbol(db, symbolName, null, currentText, sessionId);
    }
    return row.original_text;
}
