// A18 pin: range reads must not let SQL's three-valued comparisons hide
// malformed persisted spans. Raw SQL is the independent store oracle.

import { afterEach, describe, expect, it } from 'vitest';
import {
    closeDb,
    initSymbolSchema,
    openMemoryDb,
    queryRaw,
    readV4FactsIntersectingRange,
} from '../dist/core/db-adapter.js';

const connections = [];

function freshDb() {
    const conn = openMemoryDb();
    connections.push(conn);
    initSymbolSchema(conn);
    return conn;
}

function insertSymbol(conn, filePath, name, line, endLine) {
    const rows = queryRaw(conn, `
        INSERT INTO symbols (
            name, kind, type, file_path, line, end_line, column,
            capture_tag, body_hash, parent_symbol_id, visibility
        ) VALUES (?, 'def', 'function', ?, ?, ?, 0,
                  'definition.function', NULL, NULL, 'public')
        RETURNING id
    `, name, filePath, line, endLine);
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]?.id).toBe('number');
    return rows[0].id;
}

function seedFile(conn, filePath) {
    queryRaw(conn, `
        INSERT INTO files (path, hash, last_indexed)
        VALUES (?, ?, 1)
        RETURNING path
    `, filePath, `hash:${filePath}`);
}

function malformedSpanOracle(conn, filePath) {
    return queryRaw(conn, `
        SELECT 'symbol' AS family, s.id AS internalId
        FROM symbols s
        WHERE s.file_path = ? AND (s.line IS NULL OR s.end_line IS NULL)
        UNION ALL
        SELECT 'scope' AS family, ls.id AS internalId
        FROM local_scopes ls
        JOIN symbols owner ON owner.id = ls.symbol_id
        WHERE owner.file_path = ?
          AND (ls.start_line IS NULL OR ls.end_line IS NULL)
        UNION ALL
        SELECT 'injection' AS family, inj.id AS internalId
        FROM injections inj
        WHERE inj.file_path = ?
          AND (inj.start_line IS NULL OR inj.end_line IS NULL)
        ORDER BY family, internalId
    `, filePath, filePath, filePath);
}

function seedMalformedFamilies(conn, filePath) {
    seedFile(conn, filePath);
    const validOwner = insertSymbol(conn, filePath, 'validOwner', 5, 8);
    insertSymbol(conn, filePath, 'nullSymbolStart', null, 8);
    queryRaw(conn, `
        INSERT INTO local_scopes (
            symbol_id, scope_kind, start_line, end_line, parameters_json, locals_json
        ) VALUES (?, 'function', NULL, 8, '[]', '[]')
        RETURNING id
    `, validOwner);
    queryRaw(conn, `
        INSERT INTO injections (
            file_path, host_lang, injected_lang,
            start_line, end_line, start_byte, end_byte
        ) VALUES (?, 'typescript', 'sql', NULL, 8, 0, 1)
        RETURNING id
    `, filePath);
}

afterEach(() => {
    for (const conn of connections.splice(0)) closeDb(conn);
});

describe('A18 nullable range-span corruption', () => {
    it('surfaces NULL symbol, scope, and injection spans as STORE_CORRUPT', () => {
        const conn = freshDb();
        seedMalformedFamilies(conn, 'target.ts');
        seedMalformedFamilies(conn, 'other.ts');

        const targetCorruption = malformedSpanOracle(conn, 'target.ts');
        expect(targetCorruption.map((row) => row.family)).toEqual([
            'injection',
            'scope',
            'symbol',
        ]);
        expect(new Set(
            targetCorruption.map((row) => `${row.family}:${row.internalId}`),
        ).size).toBe(3);
        expect(malformedSpanOracle(conn, 'other.ts')).toHaveLength(3);

        // Before the fix, every malformed row is discarded by a NULL overlap
        // predicate and the valid owner is returned instead of corruption.
        expect(() => readV4FactsIntersectingRange(conn, 'target.ts', 5, 5))
            .toThrow(/^STORE_CORRUPT: readV4FactsIntersectingRange:/);
    });

    it.each(['symbol', 'scope', 'injection'])(
        'detects an isolated out-of-range malformed %s span before overlap filtering',
        (family) => {
            const conn = freshDb();
            seedFile(conn, 'isolated.ts');
            const validOwner = insertSymbol(conn, 'isolated.ts', 'validOwner', 5, 5);
            let malformedId;
            let hiddenByOldOverlap;
            if (family === 'symbol') {
                malformedId = insertSymbol(conn, 'isolated.ts', 'malformedSymbol', null, 99);
                hiddenByOldOverlap = queryRaw(conn, `
                    SELECT id FROM symbols
                    WHERE file_path = 'isolated.ts'
                      AND line <= 5 AND end_line >= 5
                      AND id = ?
                `, malformedId);
            } else if (family === 'scope') {
                const inserted = queryRaw(conn, `
                    INSERT INTO local_scopes (
                        symbol_id, scope_kind, start_line, end_line,
                        parameters_json, locals_json
                    ) VALUES (?, 'function', NULL, 99, '[]', '[]')
                    RETURNING id
                `, validOwner);
                malformedId = inserted[0]?.id;
                hiddenByOldOverlap = queryRaw(conn, `
                    SELECT id FROM local_scopes
                    WHERE start_line <= 5 AND end_line >= 5 AND id = ?
                `, malformedId);
            } else {
                const inserted = queryRaw(conn, `
                    INSERT INTO injections (
                        file_path, host_lang, injected_lang,
                        start_line, end_line, start_byte, end_byte
                    ) VALUES ('isolated.ts', 'typescript', 'sql', NULL, 99, 0, 1)
                    RETURNING id
                `);
                malformedId = inserted[0]?.id;
                hiddenByOldOverlap = queryRaw(conn, `
                    SELECT id FROM injections
                    WHERE file_path = 'isolated.ts'
                      AND start_line <= 5 AND end_line >= 5
                      AND id = ?
                `, malformedId);
            }
            expect(typeof malformedId).toBe('number');
            expect(hiddenByOldOverlap).toEqual([]);
            expect(malformedSpanOracle(conn, 'isolated.ts').map((row) => row.family))
                .toEqual([family]);

            expect(() => readV4FactsIntersectingRange(conn, 'isolated.ts', 5, 5))
                .toThrow(new RegExp(
                    `^STORE_CORRUPT: readV4FactsIntersectingRange: ${family} has a null line span$`,
                ));

            if (family === 'symbol') {
                queryRaw(conn, 'DELETE FROM symbols WHERE id = ? RETURNING id', malformedId);
            } else if (family === 'scope') {
                queryRaw(conn, 'DELETE FROM local_scopes WHERE id = ? RETURNING id', malformedId);
            } else {
                queryRaw(conn, 'DELETE FROM injections WHERE id = ? RETURNING id', malformedId);
            }
            expect(readV4FactsIntersectingRange(conn, 'isolated.ts', 5, 5))
                .toEqual([
                    expect.objectContaining({
                        factFamily: 'symbol',
                        fact: expect.objectContaining({ internalId: validOwner, name: 'validOwner' }),
                    }),
                ]);
        },
    );

    it.each([
        ['anchor', 'start'],
        ['import', 'start'],
        ['import', 'end'],
    ])(
        'detects an isolated out-of-range malformed %s effective %s endpoint',
        (family, endpoint) => {
            const conn = freshDb();
            seedFile(conn, 'effective.ts');
            const validOwner = insertSymbol(conn, 'effective.ts', 'validOwner', 5, 5);
            let malformedId;
            let malformedRows;
            let hiddenByOldOverlap;

            if (family === 'anchor') {
                queryRaw(conn, `
                    INSERT INTO anchors (symbol_id, kind, line, end_line, text)
                    VALUES (?, 'body', 5, NULL, 'valid fallback')
                    RETURNING id
                `, validOwner);
                const inserted = queryRaw(conn, `
                    INSERT INTO anchors (symbol_id, kind, line, end_line, text)
                    VALUES (?, 'body', NULL, 99, 'malformed')
                    RETURNING id
                `, validOwner);
                malformedId = inserted[0]?.id;
                malformedRows = queryRaw(conn, `
                    SELECT id, line AS startLine, end_line AS endLine
                    FROM anchors
                    WHERE id = ? AND line IS NULL
                `, malformedId);
                hiddenByOldOverlap = queryRaw(conn, `
                    SELECT id FROM anchors
                    WHERE line <= 5 AND COALESCE(end_line, line) >= 5 AND id = ?
                `, malformedId);
            } else {
                queryRaw(conn, `
                    INSERT INTO imports (
                        file_path, module, imported_names_json,
                        line, start_line, end_line
                    ) VALUES ('effective.ts', './valid.js', '[]', 5, NULL, NULL)
                    RETURNING id
                `);
                const startLine = endpoint === 'start' ? null : 99;
                const endLine = endpoint === 'end' ? null : 99;
                const inserted = queryRaw(conn, `
                    INSERT INTO imports (
                        file_path, module, imported_names_json,
                        line, start_line, end_line
                    ) VALUES ('effective.ts', './malformed.js', '[]', NULL, ?, ?)
                    RETURNING id
                `, startLine, endLine);
                malformedId = inserted[0]?.id;
                malformedRows = queryRaw(conn, `
                    SELECT id,
                           COALESCE(start_line, line) AS startLine,
                           COALESCE(end_line, line) AS endLine
                    FROM imports
                    WHERE id = ?
                      AND (COALESCE(start_line, line) IS NULL
                           OR COALESCE(end_line, line) IS NULL)
                `, malformedId);
                hiddenByOldOverlap = queryRaw(conn, `
                    SELECT id FROM imports
                    WHERE COALESCE(start_line, line) <= 5
                      AND COALESCE(end_line, line) >= 5
                      AND id = ?
                `, malformedId);
            }

            expect(typeof malformedId).toBe('number');
            expect(malformedRows).toHaveLength(1);
            expect(malformedRows[0]?.[endpoint === 'start' ? 'startLine' : 'endLine'])
                .toBeNull();
            expect(hiddenByOldOverlap).toEqual([]);
            expect(() => readV4FactsIntersectingRange(conn, 'effective.ts', 5, 5))
                .toThrow(new RegExp(
                    `^STORE_CORRUPT: readV4FactsIntersectingRange: ${family} has a null line span$`,
                ));

            queryRaw(
                conn,
                `DELETE FROM ${family === 'anchor' ? 'anchors' : 'imports'} WHERE id = ? RETURNING id`,
                malformedId,
            );
            const repaired = readV4FactsIntersectingRange(conn, 'effective.ts', 5, 5);
            expect(repaired).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    factFamily: family,
                    fact: expect.objectContaining(
                        family === 'anchor'
                            ? { line: 5, endLine: 5, text: 'valid fallback' }
                            : { line: 5, startLine: 5, endLine: 5, module: './valid.js' },
                    ),
                }),
            ]));
        },
    );

    it('does not let another file\'s malformed spans poison a clean range', () => {
        const conn = freshDb();
        seedMalformedFamilies(conn, 'other.ts');
        seedFile(conn, 'clean.ts');
        const cleanId = insertSymbol(conn, 'clean.ts', 'clean', 5, 5);

        expect(malformedSpanOracle(conn, 'clean.ts')).toEqual([]);
        expect(malformedSpanOracle(conn, 'other.ts')).toHaveLength(3);
        expect(readV4FactsIntersectingRange(conn, 'clean.ts', 5, 5))
            .toEqual([
                expect.objectContaining({
                    factFamily: 'symbol',
                    fact: expect.objectContaining({ internalId: cleanId, name: 'clean' }),
                }),
            ]);
    });
});
