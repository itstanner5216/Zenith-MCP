import Database from 'better-sqlite3';
import fs from 'fs/promises';
import { mkdirSync, existsSync, writeFileSync, statSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { getSymbols, getLangForFile, isSupported } from './tree-sitter.js';
import { getDefaultExcludes, isSensitive, getRefactorVersionTtlMs } from './shared.js';
import { minimatch } from 'minimatch';

// ---------------------------------------------------------------------------
// Row shape interfaces for typed DB queries
// ---------------------------------------------------------------------------

interface FileHashRow {
    hash: string;
}

interface DefFileRow {
    file_path: string;
}

interface ImpactForwardRow {
    name: string;
    file_path: string;
    refCount: number;
}

interface ImpactBackwardRow {
    name: string;
    callCount: number;
}

interface VersionHistoryRow {
    id: number;
    symbol_name: string;
    file_path: string;
    created_at: number;
    text_hash: string;
}

interface VersionTextRow {
    original_text: string;
}

interface VersionRestoreRow {
    original_text: string;
    symbol_name: string;
    session_id: string;
}

// ---------------------------------------------------------------------------
// Repo root detection
// ---------------------------------------------------------------------------

export function findRepoRoot(filePath: string): string | null {
    try {
        const stat = statSync(filePath);
        const cwd = stat.isDirectory() ? filePath : path.dirname(filePath);
        const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd,
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return result.trim();
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Database provisioning
// ---------------------------------------------------------------------------

const _dbCache = new Map<string, Database.Database>();
let _exitHandlerRegistered = false;

export function getDb(repoRoot: string): Database.Database {
    if (_dbCache.has(repoRoot)) return _dbCache.get(repoRoot)!;

    const mcpDir = path.join(repoRoot, '.mcp'); // nosemgrep
    mkdirSync(mcpDir, { recursive: true }); // nosemgrep

    const gitignorePath = path.join(mcpDir, '.gitignore'); // nosemgrep
    if (!existsSync(gitignorePath)) { // nosemgrep
        writeFileSync(gitignorePath, '*\n'); // nosemgrep
    }

    const db = new Database(path.join(mcpDir, 'symbols.db')); // nosemgrep
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

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

    // Schema migration: add line column to versions for accurate symbol disambiguation on restore
    try { db.exec('ALTER TABLE versions ADD COLUMN line INTEGER'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE versions ADD COLUMN text_hash TEXT'); } catch { /* already exists */ }
    try {
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
    } catch { /* tolerate pre-existing duplicates */ }

    if (!_exitHandlerRegistered) {
        _exitHandlerRegistered = true;
        process.on('exit', () => {
            for (const openDb of _dbCache.values()) {
                try { openDb.close(); } catch { /* ignore */ }
            }
        });
    }

    try { db.prepare('DELETE FROM versions WHERE created_at < ?').run(Date.now() - getRefactorVersionTtlMs()); } catch { /* table may be mid-migration */ }

    _dbCache.set(repoRoot, db);
    return db;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export function getSessionId(clientSessionId?: string): string {
    if (clientSessionId) return clientSessionId;
    return `${process.pid}:${process.cwd()}`;
}

export function pruneOldSessions(db: Database.Database, currentSessionId: string): void {
    db.prepare('DELETE FROM versions WHERE session_id != ?').run(currentSessionId);
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

function purgeIndexedPath(db: Database.Database, relPath: string): void {
    db.transaction(() => {
        db.prepare('DELETE FROM symbols WHERE file_path = ?').run(relPath);
        db.prepare('DELETE FROM files WHERE path = ?').run(relPath);
    })();
}

export async function indexFile(db: Database.Database, repoRoot: string, absFilePath: string): Promise<void> {
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
    const existing = db.prepare<unknown[], FileHashRow>('SELECT hash FROM files WHERE path = ?').get(relPath);
    if (existing && existing.hash === hash) return;

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

    const deleteSymbols = db.prepare('DELETE FROM symbols WHERE file_path = ?');
    const upsertFile = db.prepare(
        'INSERT OR REPLACE INTO files (path, hash, last_indexed) VALUES (?, ?, ?)'
    );
    const insertSymbol = db.prepare(
        'INSERT INTO symbols (name, kind, type, file_path, line, end_line, column) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insertEdge = db.prepare(
        'INSERT INTO edges (container_def_id, referenced_name) VALUES (?, ?)'
    );

    const doTransaction = db.transaction(() => {
        deleteSymbols.run(relPath);
        upsertFile.run(relPath, hash, Date.now());

        const defIds: Array<{ id: number; line: number; endLine: number }> = [];
        for (const sym of defs) {
            const info = insertSymbol.run(sym.name, sym.kind, sym.type, relPath, sym.line, sym.endLine, sym.column);
            defIds.push({ id: Number(info.lastInsertRowid), line: sym.line, endLine: sym.endLine });
        }

        for (const ref of refs) {
            insertSymbol.run(ref.name, ref.kind, ref.type, relPath, ref.line, ref.endLine, ref.column);

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
                insertEdge.run(bestDef.id, ref.name);
            }
        }
    });

    doTransaction();
}

interface IndexDirectoryOpts {
    maxFiles?: number;
}

export async function indexDirectory(db: Database.Database, repoRoot: string, dirPath: string, opts: IndexDirectoryOpts = {}): Promise<void> {
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
    const indexedFiles = db.prepare<unknown[], { path: string }>(
        'SELECT path FROM files WHERE path LIKE ?'
    ).all(`${prefix}%`);
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

export async function ensureIndexFresh(db: Database.Database, repoRoot: string, absFilePaths: string[]): Promise<number> {
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
        const existing = db.prepare<unknown[], FileHashRow>('SELECT hash FROM files WHERE path = ?').get(relPath);
        if (!existing || existing.hash !== hash) {
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

export function impactQuery(db: Database.Database, symbolName: string, opts: ImpactQueryOpts = {}): ImpactDisambiguate | ImpactSuccess {
    const { file, depth = 1, direction = 'forward' } = opts;

    // Disambiguation: check for multiple definitions
    const defFiles = db.prepare<unknown[], DefFileRow>(
        'SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = ?'
    ).all(symbolName, 'def');

    if (defFiles.length > 1 && !file) {
        return { disambiguate: true, definitions: defFiles.map((r: DefFileRow) => r.file_path) };
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
                let sql: string, params: unknown[];
                if (fileConstraint) {
                    sql = `
                        SELECT s.name, s.file_path, COUNT(e.id) AS refCount
                        FROM edges e
                        JOIN symbols s ON s.id = e.container_def_id
                        WHERE e.referenced_name = ? AND s.kind = 'def'
                          AND s.file_path NOT IN (
                            SELECT DISTINCT file_path FROM symbols
                            WHERE name = ? AND kind = 'def' AND file_path != ?
                          )
                        GROUP BY s.name, s.file_path
                        ORDER BY refCount DESC
                    `;
                    params = [name, name, fileConstraint];
                } else {
                    sql = `
                        SELECT s.name, s.file_path, COUNT(e.id) AS refCount
                        FROM edges e
                        JOIN symbols s ON s.id = e.container_def_id
                        WHERE e.referenced_name = ? AND s.kind = 'def'
                        GROUP BY s.name, s.file_path
                        ORDER BY refCount DESC
                    `;
                    params = [name];
                }
                for (const row of db.prepare<unknown[], ImpactForwardRow>(sql).all(...params)) {
                    out.push({ name: row.name, filePath: row.file_path, refCount: row.refCount });
                }
            } else {
                // What does `name` call? When fileConstraint is set, scope to that definition file.
                let sql: string, params: unknown[];
                if (fileConstraint) {
                    sql = `
                        SELECT e.referenced_name AS name, COUNT(e.id) AS callCount
                        FROM edges e
                        JOIN symbols s ON s.id = e.container_def_id
                        WHERE s.name = ? AND s.kind = 'def' AND s.file_path = ?
                        GROUP BY e.referenced_name
                        ORDER BY callCount DESC
                    `;
                    params = [name, fileConstraint];
                } else {
                    sql = `
                        SELECT e.referenced_name AS name, COUNT(e.id) AS callCount
                        FROM edges e
                        JOIN symbols s ON s.id = e.container_def_id
                        WHERE s.name = ? AND s.kind = 'def'
                        GROUP BY e.referenced_name
                        ORDER BY callCount DESC
                    `;
                    params = [name];
                }
                for (const row of db.prepare<unknown[], ImpactBackwardRow>(sql).all(...params)) {
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

export function snapshotSymbol(db: Database.Database, symbolName: string, filePath: string | null, originalText: string, sessionId: string, line: number | null = null): void {
    const textHash = createHash('md5').update(originalText || '').digest('hex');
    db.prepare(
        'INSERT OR IGNORE INTO versions (symbol_name, file_path, original_text, session_id, created_at, line, text_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(symbolName, filePath, originalText, sessionId, Date.now(), line ?? null, textHash);
}

export function getVersionHistory(db: Database.Database, symbolName: string, sessionId: string, filePath?: string): VersionHistoryRow[] {
    const params: unknown[] = [symbolName, sessionId];
    let query = 'SELECT id, symbol_name, file_path, created_at, text_hash FROM versions WHERE symbol_name = ? AND session_id = ?';
    if (filePath) {
        query += ' AND file_path = ?';
        params.push(filePath);
    }
    query += ' ORDER BY created_at DESC';
    return db.prepare<unknown[], VersionHistoryRow>(query).all(...params);
}

export function getVersionText(db: Database.Database, versionId: number): string | null {
    const row = db.prepare<unknown[], VersionTextRow>('SELECT original_text FROM versions WHERE id = ?').get(versionId);
    return row ? row.original_text : null;
}

export function restoreVersion(db: Database.Database, symbolName: string, versionId: number, sessionId: string, currentText?: string): string {
    const row = db.prepare<unknown[], VersionRestoreRow>('SELECT original_text, symbol_name, session_id FROM versions WHERE id = ?').get(versionId);
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
