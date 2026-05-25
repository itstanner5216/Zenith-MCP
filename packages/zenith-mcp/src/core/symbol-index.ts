import fs from 'fs/promises';
import { mkdirSync, existsSync, writeFileSync, statSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { getSymbols, getLangForFile, isSupported } from './tree-sitter.js';
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
    getFilesByPrefix,
    insertSymbol,
    deleteSymbolsByFile,
    getCallers,
    getCallees,
    getCallersFiltered,
    getCalleesFiltered,
    insertEdge,
    snapshotVersion,
    getVersionHistory as adapterGetVersionHistory,
    getVersionText as adapterGetVersionText,
    getVersionMeta,
    pruneOldVersions,
    pruneOtherSessions,
    runTransaction,
    findSymbolFiles
} from './db-adapter.js';

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
    if (_dbCache.has(repoRoot)) return _dbCache.get(repoRoot)!;

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
// Indexing
// ---------------------------------------------------------------------------

interface SymbolLike {
    kind: string;
    name: string;
    type: string;
    line: number;
    endLine: number;
    column: number;
}

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
        deleteSymbolsByFile(db, relPath);
        deleteFile(db, relPath);
    });
}

export async function indexFile(db: DbConnection, repoRoot: string, absFilePath: string): Promise<void> {
    const relPath = path.relative(repoRoot, absFilePath);

    // Guard: reject paths that escape repoRoot
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) return;

    if (!shouldIndexFile(repoRoot, absFilePath)) {
        purgeIndexedPath(db, relPath);
        return;
    }

    let source: string;
    try {
        source = await fs.readFile(absFilePath, 'utf-8'); // nosemgrep
    } catch {
        purgeIndexedPath(db, relPath);
        return;
    }

    const hash = hashFileContent(source);
    const existingHash = getFileHash(db, relPath);
    if (existingHash && existingHash === hash) return;

    const langName = getLangForFile(absFilePath);
    if (!langName) {
        purgeIndexedPath(db, relPath);
        return;
    }

    const symbols = await getSymbols(source, langName);
    if (!symbols) {
        purgeIndexedPath(db, relPath);
        return;
    }

    const defs = symbols.filter((s: SymbolLike) => s.kind === 'def');
    const refs = symbols.filter((s: SymbolLike) => s.kind === 'ref');

    runTransaction(db, () => {
        deleteSymbolsByFile(db, relPath);
        upsertFile(db, relPath, hash, Date.now());

        const defIds: Array<{ id: number; line: number; endLine: number }> = [];
        for (const sym of defs) {
            const rowId = insertSymbol(db, {
                name: sym.name,
                kind: sym.kind,
                type: sym.type,
                filePath: relPath,
                line: sym.line,
                endLine: sym.endLine,
                column: sym.column
            });
            defIds.push({ id: rowId, line: sym.line, endLine: sym.endLine });
        }

        for (const ref of refs) {
            insertSymbol(db, {
                name: ref.name,
                kind: ref.kind,
                type: ref.type,
                filePath: relPath,
                line: ref.line,
                endLine: ref.endLine,
                column: ref.column
            });

            // Find innermost containing def (smallest span that contains this ref)
            let bestDef: { id: number; line: number; endLine: number } | null = null;
            let bestSpan = Infinity;
            for (const def of defIds) {
                if (ref.line >= def.line && ref.line <= def.endLine) {
                    const span = def.endLine - def.line;
                    if (span < bestSpan) {
                        bestSpan = span;
                        bestDef = def;
                    }
                }
            }
            if (bestDef) {
                insertEdge(db, bestDef.id, ref.name);
            }
        }
    });
}

interface IndexDirectoryOpts {
    maxFiles?: number;
}

export async function indexDirectory(db: DbConnection, repoRoot: string, dirPath: string, opts: IndexDirectoryOpts = {}): Promise<void> {
    const maxFiles = opts.maxFiles || 5000;
    const filePaths: string[] = [];
    const excludes = getDefaultExcludes();

    async function walk(dir: string): Promise<void> {
        if (filePaths.length >= maxFiles) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; } // nosemgrep
        for (const entry of entries) {
            if (filePaths.length >= maxFiles) return;
            const fullPath = path.join(dir, entry.name); // nosemgrep
            if (entry.isDirectory()) {
                const relDir = path.relative(repoRoot, fullPath);
                if (excludes.some(pattern =>
                    entry.name === pattern ||
                    minimatch(relDir, pattern, { dot: true, nocase: true }) ||
                    minimatch(relDir, `**/${pattern}`, { dot: true, nocase: true })
                )) {
                    continue;
                }
                await walk(fullPath);
            } else if (entry.isFile() && shouldIndexFile(repoRoot, fullPath)) {
                filePaths.push(fullPath);
            }
        }
    }

    await walk(dirPath);

    // Purge stale DB rows for files under this directory that were not visited
    // (e.g. files under now-excluded directories or deleted files)
    const dirRelPath = path.relative(repoRoot, dirPath);
    const prefix = dirRelPath ? dirRelPath + path.sep : '';
    const indexedFiles = getFilesByPrefix(db, `${prefix}%`);
    const visitedRelPaths = new Set(filePaths.map(f => path.relative(repoRoot, f)));
    for (const row of indexedFiles) {
        if (!visitedRelPaths.has(row.path)) {
            purgeIndexedPath(db, row.path);
        }
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
        const batch = filePaths.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(f => indexFile(db, repoRoot, f)));
    }
}

export async function ensureIndexFresh(db: DbConnection, repoRoot: string, absFilePaths: string[]): Promise<number> {
    let reindexed = 0;
    for (const absPath of absFilePaths) {
        const relPath = path.relative(repoRoot, absPath);
        if (!shouldIndexFile(repoRoot, absPath)) {
            purgeIndexedPath(db, relPath);
            continue;
        }
        let source: string;
        try { source = await fs.readFile(absPath, 'utf-8'); } catch { // nosemgrep
            // File is unreadable or deleted — purge stale index rows
            purgeIndexedPath(db, relPath);
            continue;
        }
        const hash = hashFileContent(source);
        const existingHash = getFileHash(db, relPath);
        if (!existingHash || existingHash !== hash) {
            await indexFile(db, repoRoot, absPath);
            reindexed++;
        }
    }
    return reindexed;
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
