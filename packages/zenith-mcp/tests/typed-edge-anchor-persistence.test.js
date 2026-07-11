import { describe, expect, it, afterEach } from 'vitest';
import { extractParsedFile } from '../dist/core/indexing/extract.js';
import { persistParsedFile } from '../dist/core/indexing/persist.js';
import { resolveAllEdgeTargets } from '../dist/core/indexing/resolve.js';
import {
    closeDb,
    execRaw,
    getFileFacts,
    getSchemaVersion,
    initSymbolSchema,
    openMemoryDb,
    queryRaw,
} from '../dist/core/db-adapter.js';

const FIRST_SOURCE = [
    'class Widget {}',
    'function target(): Widget {',
    '  return new Widget();',
    '}',
    'function caller(value: Widget): Widget {',
    '  if (value) {',
    '    return target();',
    '  }',
    '  return value;',
    '}',
    '',
].join('\n');

describe('typed edge and anchor span persistence', () => {
    let db;
    afterEach(() => {
        if (db) {
            closeDb(db);
            db = undefined;
        }
    });

    it('persists exact typed edges and complete anchor ranges in the real database', async () => {
        db = openMemoryDb();
        initSymbolSchema(db);

        const record = await extractParsedFile(FIRST_SOURCE, 'typescript', 'src/facts.ts', 'hash-one');
        expect(record).not.toBeNull();
        if (!record) return;
        persistParsedFile(db, record);
        resolveAllEdgeTargets(db);

        expect(queryRaw(db, `
            SELECT caller.name AS callerName,
                   e.referenced_name AS referencedName,
                   e.reference_kind AS referenceKind,
                   callee.name AS calleeName
            FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            LEFT JOIN symbols callee ON callee.id = e.callee_symbol_id
            ORDER BY caller.line, e.referenced_name, e.reference_kind
        `)).toEqual([
            { callerName: 'target', referencedName: 'Widget', referenceKind: 'class', calleeName: 'Widget' },
            { callerName: 'target', referencedName: 'Widget', referenceKind: 'type', calleeName: 'Widget' },
            { callerName: 'caller', referencedName: 'Widget', referenceKind: 'type', calleeName: 'Widget' },
            { callerName: 'caller', referencedName: 'target', referenceKind: 'call', calleeName: 'target' },
        ]);

        expect(queryRaw(db, `
            SELECT s.name AS symbolName, a.kind, a.line,
                   a.end_line AS endLine, a.text
            FROM anchors a
            JOIN symbols s ON s.id = a.symbol_id
            ORDER BY a.line, a.kind
        `)).toEqual([
            { symbolName: 'target', kind: 'return', line: 3, endLine: 3, text: '  return new Widget();' },
            { symbolName: 'caller', kind: 'if', line: 6, endLine: 8, text: '  if (value) {' },
            { symbolName: 'caller', kind: 'call', line: 7, endLine: 7, text: '    return target();' },
            { symbolName: 'caller', kind: 'return', line: 7, endLine: 7, text: '    return target();' },
            { symbolName: 'caller', kind: 'return', line: 9, endLine: 9, text: '  return value;' },
        ]);

        const facts = getFileFacts(db, 'src/facts.ts');
        expect(facts.referenceEdges.map(edge => ({
            callerLine: edge.callerLine,
            referencedName: edge.referencedName,
            referenceKind: edge.referenceKind,
            referenceCount: edge.referenceCount,
        })).sort((a, b) =>
            (a.callerLine - b.callerLine)
            || a.referencedName.localeCompare(b.referencedName)
            || a.referenceKind.localeCompare(b.referenceKind)
        )).toEqual([
            { callerLine: 2, referencedName: 'Widget', referenceKind: 'class', referenceCount: 1 },
            { callerLine: 2, referencedName: 'Widget', referenceKind: 'type', referenceCount: 1 },
            { callerLine: 5, referencedName: 'target', referenceKind: 'call', referenceCount: 1 },
            { callerLine: 5, referencedName: 'Widget', referenceKind: 'type', referenceCount: 1 },
        ]);
        expect(facts.anchors.map(anchor => ({
            symbolName: anchor.symbol_name,
            kind: anchor.kind,
            line: anchor.line,
            endLine: anchor.endLine,
        }))).toEqual([
            { symbolName: 'target', kind: 'return', line: 3, endLine: 3 },
            { symbolName: 'caller', kind: 'if', line: 6, endLine: 8 },
            { symbolName: 'caller', kind: 'return', line: 7, endLine: 7 },
            { symbolName: 'caller', kind: 'call', line: 7, endLine: 7 },
            { symbolName: 'caller', kind: 'return', line: 9, endLine: 9 },
        ]);
    });

    it('re-index replacement removes every stale typed edge and anchor range', async () => {
        db = openMemoryDb();
        initSymbolSchema(db);

        const first = await extractParsedFile(FIRST_SOURCE, 'typescript', 'src/facts.ts', 'hash-one');
        expect(first).not.toBeNull();
        if (!first) return;
        persistParsedFile(db, first);

        const replacementSource = [
            'function caller() {',
            '  return 0;',
            '}',
            '',
        ].join('\n');
        const replacement = await extractParsedFile(replacementSource, 'typescript', 'src/facts.ts', 'hash-two');
        expect(replacement).not.toBeNull();
        if (!replacement) return;
        persistParsedFile(db, replacement);
        resolveAllEdgeTargets(db);

        expect(queryRaw(db, 'SELECT referenced_name, reference_kind FROM edges')).toEqual([]);
        expect(queryRaw(db, `
            SELECT s.name AS symbolName, a.kind, a.line, a.end_line AS endLine
            FROM anchors a
            JOIN symbols s ON s.id = a.symbol_id
            ORDER BY a.line, a.kind
        `)).toEqual([
            { symbolName: 'caller', kind: 'return', line: 2, endLine: 2 },
        ]);
        expect(queryRaw(db, 'SELECT name, kind FROM symbols ORDER BY line, column')).toEqual([
            { name: 'caller', kind: 'def' },
        ]);
    });

    it('migrates a real v3 database with safe backfills and forces fact repopulation', () => {
        db = openMemoryDb();
        execRaw(db, `
            CREATE TABLE schema_version (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                version INTEGER NOT NULL
            );
            INSERT INTO schema_version (id, version) VALUES (1, 3);
            CREATE TABLE files (
                path TEXT PRIMARY KEY,
                hash TEXT,
                last_indexed INTEGER
            );
            CREATE TABLE symbols (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                kind TEXT,
                type TEXT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                line INTEGER,
                end_line INTEGER,
                column INTEGER,
                capture_tag TEXT,
                body_hash TEXT,
                parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
                visibility TEXT
            );
            CREATE TABLE edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                container_def_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
                referenced_name TEXT,
                callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
            );
            CREATE TABLE anchors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
                kind TEXT,
                line INTEGER,
                text TEXT
            );
            INSERT INTO files (path, hash, last_indexed) VALUES ('src/legacy.ts', 'legacy-hash', 1);
            INSERT INTO symbols (id, name, kind, type, file_path, line, end_line, column)
                VALUES (1, 'legacy', 'def', 'function', 'src/legacy.ts', 1, 3, 0);
            INSERT INTO edges (container_def_id, referenced_name) VALUES (1, 'unknownTarget');
            INSERT INTO anchors (symbol_id, kind, line, text) VALUES (1, 'return', 2, 'return 1;');
        `);

        initSymbolSchema(db);

        expect(getSchemaVersion(db)).toBe(4);
        expect(queryRaw(db, 'PRAGMA table_info(edges)').map(column => column.name)).toContain('reference_kind');
        expect(queryRaw(db, 'PRAGMA table_info(anchors)').map(column => column.name)).toContain('end_line');
        expect(queryRaw(db, 'SELECT reference_kind AS referenceKind FROM edges')).toEqual([
            { referenceKind: 'unknown' },
        ]);
        expect(queryRaw(db, 'SELECT line, end_line AS endLine FROM anchors')).toEqual([
            { line: 2, endLine: 2 },
        ]);
        expect(queryRaw(db, 'SELECT hash FROM files')).toEqual([{ hash: null }]);
    });

    it('never persists a same-line parent cycle for nested definition facts', async () => {
        db = openMemoryDb();
        initSymbolSchema(db);

        const source = 'type ResultType = { ok: boolean };\n';
        const record = await extractParsedFile(source, 'typescript', 'src/types.ts', 'hash-types');
        expect(record).not.toBeNull();
        if (!record) return;
        persistParsedFile(db, record);

        expect(queryRaw(db, `
            SELECT child.name AS childName, parent.name AS parentName
            FROM symbols child
            LEFT JOIN symbols parent ON parent.id = child.parent_symbol_id
            WHERE child.file_path = 'src/types.ts'
            ORDER BY child.column
        `)).toEqual([
            { childName: 'ResultType', parentName: null },
            { childName: 'ok', parentName: 'ResultType' },
        ]);
        expect(queryRaw(db, `
            WITH RECURSIVE ancestry(start_id, current_id, depth) AS (
                SELECT id, parent_symbol_id, 1 FROM symbols WHERE parent_symbol_id IS NOT NULL
                UNION ALL
                SELECT ancestry.start_id, symbols.parent_symbol_id, ancestry.depth + 1
                FROM ancestry
                JOIN symbols ON symbols.id = ancestry.current_id
                WHERE ancestry.current_id IS NOT NULL AND ancestry.depth <= 10
            )
            SELECT start_id FROM ancestry WHERE start_id = current_id
        `)).toEqual([]);
    });
});
