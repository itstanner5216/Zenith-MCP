// polaris-v4-reads.test.js — POLARIS Task 2.2
//
// Real schema-v4, file-backed coverage for the dedicated intelligence read
// set: exact rows, canonical keyset pagination, guarded ancestry, fixed
// statement bounds, and query-plan index evidence.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    execRaw,
    queryRaw,
    getScopeFileHashView,
    readV4CompleteFileFactBundle,
    readV4ParentAncestry,
    readV4FactsIntersectingRange,
    namePrefixUpperBound,
    queryV4Occurrences,
    readV4StructuresByInternalIds,
    readV4ImportsByFileKeys,
    readV4ImportBindingsByFileKeys,
    readV4AnchorsByFileKeys,
    readV4InjectionsByFileKeys,
    readV4ScopesByFileKeys,
    readV4EdgeResolutionStats,
    readV4EdgeFrontier,
    readV4DirectoryProjectAggregates,
    readV4FileHashesByKeys,
} from '../dist/core/db-adapter.js';
import { indexDirectory } from '../dist/core/symbol-index.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_SOURCE = path.join(TESTS_DIR, '..', 'src', 'core', 'db-adapter.ts');

const SOURCES = {
    'src/main.js': `import { target } from './target.js';

export function alphaOne(value) {
    if (value > 0) {
        missing(value);
        return target(value);
    }
    return 0;
}
export function alphaTwo(value) {
    sql\`SELECT id FROM items\`;
    return target(value) + target(value + 1);
}
`,
    'src/target.js': `export function target(value) {
    return value + 1;
}

export class Box {
    run(value) {
        return target(value);
    }
}

export function beta(value) {
    return target(value);
}
`,
    'test/sample.js': `import { target } from '../src/target.js';

export function testUse(value) {
    return target(value);
}
`,
    'lib/gamma.ts': `export function gamma(value: number): number {
    return value * 2;
}
`,
    'src0/leak.js': `export function leak() {
    return 1;
}
`,
};

const FILE_KEYS = Object.keys(SOURCES).sort();
const MAIN_AND_SAMPLE = ['src/main.js', 'test/sample.js'];
const MAX_CODE_POINT = '\u{10FFFF}';
const NAME_PREFIX_CORPUS = [
    'a', 'alpha', 'alphabet', 'alphb', 'b',
    'é', 'éclair', 'ê',
    '\uD7FE', '\uD7FF', '\uD7FFtail',
    '\uE000', '\uE000tail', '\uF8FF', '\uFFFF',
    '😀', '😀tail', '😁',
    '𝌆', '𝌆tail', '𝌇',
    MAX_CODE_POINT, `${MAX_CODE_POINT}tail`, `${MAX_CODE_POINT}${MAX_CODE_POINT}`,
    `a${MAX_CODE_POINT}`, `a${MAX_CODE_POINT}tail`,
];

let tempDir;
let repoRoot;
let db;
let symbolIds;

function md5(text) {
    return crypto.createHash('md5').update(text).digest('hex');
}

function occurrenceKey(row) {
    return {
        path: row.path,
        line: row.line,
        column: row.column,
        endLine: row.endLine,
        kind: row.kind,
        name: row.name,
    };
}

function traceStatementExecutions(conn, invoke) {
    conn._cache.clear();
    const sqlite = conn._db;
    const hadOwnPrepare = Object.hasOwn(sqlite, 'prepare');
    const originalPrepare = sqlite.prepare;
    const calls = [];

    sqlite.prepare = new Proxy(originalPrepare, {
        apply(target, _thisArg, args) {
            const sql = String(args[0]);
            const statement = Reflect.apply(target, sqlite, args);
            return new Proxy(statement, {
                get(statementTarget, property) {
                    const value = Reflect.get(statementTarget, property, statementTarget);
                    if (typeof value !== 'function') return value;
                    const method = String(property);
                    if (method === 'all' || method === 'get' || method === 'run' || method === 'iterate') {
                        return (...params) => {
                            calls.push({ sql, params, method });
                            return Reflect.apply(value, statementTarget, params);
                        };
                    }
                    return value.bind(statementTarget);
                },
            });
        },
    });

    try {
        const result = invoke();
        return { result, calls };
    } finally {
        conn._cache.clear();
        if (hadOwnPrepare) sqlite.prepare = originalPrepare;
        else delete sqlite.prepare;
    }
}

function explainCalls(calls) {
    return calls.map((call) => {
        const rows = queryRaw(db, `EXPLAIN QUERY PLAN ${call.sql}`, ...call.params);
        return rows.map((row) => row.detail).join('\n');
    }).join('\n');
}

beforeAll(async () => {
    expect(process.versions.node.split('.')[0]).toBe('26');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-v4-reads-'));
    repoRoot = path.join(tempDir, 'repo');
    for (const [relativePath, source] of Object.entries(SOURCES)) {
        const absolutePath = path.join(repoRoot, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, source);
    }

    db = openDb(path.join(tempDir, 'facts.db'));
    initSymbolSchema(db);
    await indexDirectory(db, repoRoot, repoRoot);

    symbolIds = Object.fromEntries(
        queryRaw(db, "SELECT id, name FROM symbols WHERE kind = 'def' ORDER BY id")
            .map((row) => [row.name, row.id]),
    );
}, 60_000);

afterAll(() => {
    try { closeDb(db); } catch { /* ignore */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('v4 intelligence rows', () => {
    it('returns one complete set-oriented bundle and preserves a missing requested key', () => {
        const result = readV4CompleteFileFactBundle(
            db,
            ['src/main.js', 'src/target.js', 'missing.js'],
        );

        expect(result.files).toEqual([
            { filePath: 'missing.js', present: false, hash: null, lastIndexed: null },
            expect.objectContaining({
                filePath: 'src/main.js',
                present: true,
                hash: md5(SOURCES['src/main.js']),
            }),
            expect.objectContaining({
                filePath: 'src/target.js',
                present: true,
                hash: md5(SOURCES['src/target.js']),
            }),
        ]);
        expect({
            symbols: result.symbols.length,
            edges: result.edges.length,
            structures: result.structures.length,
            anchors: result.anchors.length,
            imports: result.imports.length,
            bindings: result.importBindings.length,
            injections: result.injections.length,
            scopes: result.scopes.length,
        }).toEqual({
            symbols: 14,
            edges: 7,
            structures: 6,
            anchors: 14,
            imports: 1,
            bindings: 1,
            injections: 2,
            scopes: 11,
        });
        expect(result.symbols.filter((row) => row.role === 'declaration').map((row) => row.name))
            .toEqual(['alphaOne', 'alphaTwo', 'target', 'Box', 'run', 'beta']);
        expect(result.edges.every((row) => 'legacyHeuristicTargetInternalId' in row)).toBe(true);
    });

    it('walks batched parent ancestry and terminates a self-cycle at depth 64', () => {
        expect(readV4ParentAncestry(db, [symbolIds.run, symbolIds.beta]).map((row) => ({
            seed: row.seedInternalId,
            name: row.name,
            depth: row.depth,
        }))).toEqual([
            { seed: symbolIds.run, name: 'run', depth: 0 },
            { seed: symbolIds.run, name: 'Box', depth: 1 },
            { seed: symbolIds.beta, name: 'beta', depth: 0 },
        ]);

        execRaw(db, 'SAVEPOINT polaris_cycle_guard');
        try {
            queryRaw(
                db,
                'UPDATE symbols SET parent_symbol_id = ? WHERE id = ? RETURNING id',
                symbolIds.Box,
                symbolIds.Box,
            );
            const cycle = readV4ParentAncestry(db, [symbolIds.Box]);
            expect(cycle).toHaveLength(65);
            expect(cycle[0].depth).toBe(0);
            expect(cycle[64].depth).toBe(64);
            expect(cycle.every((row) => row.name === 'Box')).toBe(true);
        } finally {
            execRaw(db, 'ROLLBACK TO polaris_cycle_guard');
            execRaw(db, 'RELEASE polaris_cycle_guard');
        }
    });

    it('returns every intersecting v4 fact family and no facts for a blank line', () => {
        const intersecting = readV4FactsIntersectingRange(db, 'src/main.js', 1, 11);
        const counts = Object.fromEntries(
            ['symbol', 'anchor', 'scope', 'import', 'injection']
                .map((family) => [family, intersecting.filter((row) => row.factFamily === family).length]),
        );
        expect(counts).toEqual({ symbol: 6, anchor: 6, scope: 5, import: 1, injection: 2 });
        expect(
            intersecting.filter((row) => row.factFamily === 'injection')
                .map((row) => row.fact.injectedLanguage)
                .sort(),
        ).toEqual(['html', 'sql']);
        expect(readV4FactsIntersectingRange(db, 'src/main.js', 14, 14)).toEqual([]);
    });

    it('orders same-line symbols by column and injections by exact byte span', () => {
        expect(
            readV4FactsIntersectingRange(db, 'src/main.js', 12, 12)
                .filter((row) => row.factFamily === 'symbol')
                .filter((row) => row.fact.line === 12)
                .map((row) => [row.fact.name, row.fact.column]),
        ).toEqual([
            ['target', 11],
            ['target', 27],
        ]);

        execRaw(db, 'SAVEPOINT polaris_range_order');
        try {
            execRaw(db, `
                INSERT INTO injections (
                    file_path, host_lang, injected_lang,
                    start_line, end_line, start_byte, end_byte
                ) VALUES
                    ('src/main.js', 'javascript', 'z-early', 11, 12, 1, 2),
                    ('src/main.js', 'javascript', 'a-late', 11, 11, 999, 1000)
            `);
            const expected = ['z-early', 'a-late'];
            const injectedLanguage = (rows) => rows
                .filter((row) => row.injectedLanguage === 'z-early'
                    || row.injectedLanguage === 'a-late')
                .map((row) => row.injectedLanguage);
            expect(injectedLanguage(
                readV4FactsIntersectingRange(db, 'src/main.js', 11, 11)
                    .filter((row) => row.factFamily === 'injection')
                    .map((row) => row.fact),
            )).toEqual(expected);
            expect(injectedLanguage(
                readV4CompleteFileFactBundle(db, ['src/main.js']).injections,
            )).toEqual(expected);
            expect(injectedLanguage(
                readV4InjectionsByFileKeys(db, ['src/main.js']),
            )).toEqual(expected);
        } finally {
            execRaw(db, 'ROLLBACK TO polaris_range_order');
            execRaw(db, 'RELEASE polaris_range_order');
        }
    });

    it('preserves nullable raw v4 facts and types malformed occurrence keys as store corruption', () => {
        execRaw(db, 'SAVEPOINT polaris_nullable_rows');
        try {
            queryRaw(
                db,
                "INSERT INTO files (path, hash, last_indexed) VALUES ('corrupt.js', 'h', 1) RETURNING path",
            );
            const corruptRows = queryRaw(
                db,
                `INSERT INTO symbols (
                    name, kind, type, file_path, line, end_line, column,
                    capture_tag, body_hash, parent_symbol_id, visibility
                ) VALUES
                    (NULL, 'def', NULL, 'corrupt.js', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
                    ('mystery', NULL, NULL, 'corrupt.js', 1, 1, 0, NULL, NULL, NULL, NULL)
                RETURNING id, name`,
            );
            expect(corruptRows).toHaveLength(2);

            const bundle = readV4CompleteFileFactBundle(db, ['corrupt.js']);
            expect(bundle.symbols).toEqual([
                {
                    internalId: corruptRows[0].id,
                    name: null,
                    role: 'declaration',
                    kind: null,
                    filePath: 'corrupt.js',
                    line: null,
                    endLine: null,
                    column: null,
                    captureTag: null,
                    bodyHash: null,
                    parentInternalId: null,
                    visibility: null,
                },
                expect.objectContaining({
                    internalId: corruptRows[1].id,
                    name: 'mystery',
                    role: null,
                    kind: null,
                }),
            ]);
            expect(() => queryV4Occurrences(
                db,
                { scopePrefix: '', role: 'declaration' },
                { limit: 100 },
            )).toThrow(/^STORE_CORRUPT:/);
        } finally {
            execRaw(db, 'ROLLBACK TO polaris_nullable_rows');
            execRaw(db, 'RELEASE polaris_nullable_rows');
        }
    });
});

describe('occurrence paging and exact totals', () => {
    it('concatenates limit-2 pages to the one-shot canonical declaration result', () => {
        const expected = [
            ['lib/gamma.ts', 1, 16, 'gamma'],
            ['src/main.js', 3, 16, 'alphaOne'],
            ['src/main.js', 10, 16, 'alphaTwo'],
            ['src/target.js', 1, 16, 'target'],
            ['src/target.js', 5, 13, 'Box'],
            ['src/target.js', 6, 4, 'run'],
            ['src/target.js', 11, 16, 'beta'],
            ['src0/leak.js', 1, 16, 'leak'],
            ['test/sample.js', 3, 16, 'testUse'],
        ];
        const oneShot = queryV4Occurrences(
            db,
            { scopePrefix: '', role: 'declaration' },
            { limit: 100 },
        );
        expect(oneShot.total).toBe(9);
        expect(oneShot.rows.map((row) => [row.path, row.line, row.column, row.name])).toEqual(expected);

        const concatenated = [];
        const pageSizes = [];
        let afterKey;
        while (true) {
            const request = afterKey === undefined
                ? { limit: 2 }
                : { afterKey, limit: 2 };
            const page = queryV4Occurrences(
                db,
                { scopePrefix: '', role: 'declaration' },
                request,
            );
            expect(page.total).toBe(9);
            pageSizes.push(page.rows.length);
            concatenated.push(...page.rows);
            if (page.rows.length < 2) break;
            afterKey = occurrenceKey(page.rows[page.rows.length - 1]);
        }

        expect(pageSizes).toEqual([2, 2, 2, 2, 1]);
        expect(concatenated).toEqual(oneShot.rows);
        expect(new Set(concatenated.map((row) => JSON.stringify(occurrenceKey(row)))).size).toBe(9);

        const emptyTail = queryV4Occurrences(
            db,
            { scopePrefix: '', role: 'declaration' },
            { afterKey: occurrenceKey(oneShot.rows[oneShot.rows.length - 1]), limit: 2 },
        );
        expect(emptyTail).toEqual({ rows: [], total: 9 });
    });

    it('applies scope, role, exact/prefix name, and kind filters conjunctively', () => {
        expect(queryV4Occurrences(
            db,
            {
                scopePrefix: 'src/',
                role: 'declaration',
                name: { mode: 'exact', value: 'target' },
                kinds: ['function'],
            },
            { limit: 10 },
        ).rows.map((row) => row.name)).toEqual(['target']);

        expect(queryV4Occurrences(
            db,
            {
                scopePrefix: 'src/',
                role: 'declaration',
                name: { mode: 'prefix', value: 'alpha' },
                kinds: ['function'],
            },
            { limit: 10 },
        ).rows.map((row) => row.name)).toEqual(['alphaOne', 'alphaTwo']);

        expect(queryV4Occurrences(
            db,
            {
                scopePrefix: 'src/',
                role: 'reference',
                name: { mode: 'exact', value: 'target' },
                kinds: ['call'],
            },
            { limit: 10 },
        )).toMatchObject({ total: 5, rows: expect.arrayContaining([expect.objectContaining({ name: 'target' })]) });

        expect(queryV4Occurrences(
            db,
            {
                scopePrefix: 'src/',
                role: 'declaration',
                name: { mode: 'prefix', value: 'ALPHA' },
                kinds: ['function'],
            },
            { limit: 10 },
        )).toEqual({ rows: [], total: 0 });

        expect(queryV4Occurrences(
            db,
            {
                scopePrefix: 'src/',
                role: 'declaration',
                name: { mode: 'exact', value: 'target' },
                kinds: ['method'],
            },
            { limit: 10 },
        )).toEqual({ rows: [], total: 0 });
    });
});

describe('name-prefix byte bounds', () => {
    it('matches a UTF-8 byte oracle across adversarial Unicode prefixes and names', () => {
        expect(() => namePrefixUpperBound('')).toThrow(
            'namePrefixUpperBound: prefix must not be empty',
        );
        expect(namePrefixUpperBound('alpha')).toBe('alphb');
        expect(namePrefixUpperBound('é')).toBe('ê');
        expect(namePrefixUpperBound('\uD7FF')).toBe('\uE000');
        expect(namePrefixUpperBound('\uFFFF')).toBe('\u{10000}');
        expect(namePrefixUpperBound('😀')).toBe('😁');
        expect(namePrefixUpperBound('𝌆')).toBe('𝌇');
        expect(namePrefixUpperBound(`a${MAX_CODE_POINT}`)).toBe('b');
        expect(namePrefixUpperBound(MAX_CODE_POINT)).toBeNull();
        expect(namePrefixUpperBound(`${MAX_CODE_POINT}${MAX_CODE_POINT}`)).toBeNull();
        expect(queryV4Occurrences(
            db,
            { scopePrefix: 'src/', role: 'declaration', name: { mode: 'prefix', value: '' } },
            { limit: 100 },
        )).toEqual(queryV4Occurrences(
            db,
            { scopePrefix: 'src/', role: 'declaration' },
            { limit: 100 },
        ));

        for (const prefix of NAME_PREFIX_CORPUS) {
            const prefixBytes = Buffer.from(prefix, 'utf8');
            const upperBound = namePrefixUpperBound(prefix);
            const upperBoundBytes = upperBound === null ? null : Buffer.from(upperBound, 'utf8');
            for (const name of NAME_PREFIX_CORPUS) {
                const nameBytes = Buffer.from(name, 'utf8');
                const isInsideByteRange = Buffer.compare(nameBytes, prefixBytes) >= 0
                    && (upperBoundBytes === null || Buffer.compare(nameBytes, upperBoundBytes) < 0);
                expect(
                    isInsideByteRange,
                    `UTF-8 range mismatch for name=${JSON.stringify(name)}, prefix=${JSON.stringify(prefix)}`,
                ).toBe(name.startsWith(prefix));
            }
        }
    });

    it('matches substr-only SQLite results byte-for-byte for every adversarial prefix', () => {
        execRaw(db, 'SAVEPOINT polaris_unicode_prefix');
        try {
            const filePath = 'unicode/corpus.js';
            queryRaw(
                db,
                "INSERT INTO files (path, hash, last_indexed) VALUES (?, 'unicode', 1) RETURNING path",
                filePath,
            );
            for (const [index, name] of NAME_PREFIX_CORPUS.entries()) {
                queryRaw(
                    db,
                    `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                     VALUES (?, 'def', 'function', ?, ?, ?, 0)
                     RETURNING id`,
                    name,
                    filePath,
                    index + 1,
                    index + 1,
                );
            }

            for (const prefix of NAME_PREFIX_CORPUS) {
                const substrOnly = queryRaw(
                    db,
                    `SELECT name FROM symbols
                     WHERE file_path = ? AND substr(name, 1, length(?)) = ?
                     ORDER BY name COLLATE BINARY`,
                    filePath,
                    prefix,
                    prefix,
                );
                const upperBound = namePrefixUpperBound(prefix);
                const rangeAndSubstr = upperBound === null
                    ? queryRaw(
                        db,
                        `SELECT name FROM symbols
                         WHERE file_path = ? AND name >= ?
                           AND substr(name, 1, length(?)) = ?
                         ORDER BY name COLLATE BINARY`,
                        filePath,
                        prefix,
                        prefix,
                        prefix,
                    )
                    : queryRaw(
                        db,
                        `SELECT name FROM symbols
                         WHERE file_path = ? AND name >= ? AND name < ?
                           AND substr(name, 1, length(?)) = ?
                         ORDER BY name COLLATE BINARY`,
                        filePath,
                        prefix,
                        upperBound,
                        prefix,
                        prefix,
                    );
                const asUtf8Hex = (rows) => rows.map((row) => Buffer.from(row.name, 'utf8').toString('hex'));
                expect(
                    asUtf8Hex(rangeAndSubstr),
                    `SQLite result mismatch for prefix=${JSON.stringify(prefix)}`,
                ).toEqual(asUtf8Hex(substrOnly));
            }
            expect(queryV4Occurrences(
                db,
                {
                    scopePrefix: 'unicode/',
                    role: 'declaration',
                    name: { mode: 'prefix', value: MAX_CODE_POINT },
                    kinds: ['function'],
                },
                { limit: 100 },
            )).toMatchObject({
                total: 3,
                rows: [
                    expect.objectContaining({ name: MAX_CODE_POINT }),
                    expect.objectContaining({ name: `${MAX_CODE_POINT}tail` }),
                    expect.objectContaining({ name: `${MAX_CODE_POINT}${MAX_CODE_POINT}` }),
                ],
            });
        } finally {
            execRaw(db, 'ROLLBACK TO polaris_unicode_prefix');
            execRaw(db, 'RELEASE polaris_unicode_prefix');
        }
    });

    it('keeps exact prefix results when node:sqlite normalizes a lone surrogate to U+FFFD', () => {
        execRaw(db, 'SAVEPOINT polaris_lone_surrogate');
        try {
            const filePath = 'unicode/lone.js';
            queryRaw(
                db,
                "INSERT INTO files (path, hash, last_indexed) VALUES (?, 'lone', 1) RETURNING path",
                filePath,
            );
            const stored = queryRaw(
                db,
                `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                 VALUES (?, 'def', 'function', ?, 1, 1, 0)
                 RETURNING name, hex(CAST(name AS BLOB)) AS utf8Hex`,
                '\uD800',
                filePath,
            );
            expect(stored).toEqual([{ name: '\uFFFD', utf8Hex: 'EFBFBD' }]);
            expect(queryV4Occurrences(
                db,
                {
                    scopePrefix: 'unicode/',
                    role: 'declaration',
                    name: { mode: 'prefix', value: '\uD800' },
                    kinds: ['function'],
                },
                { limit: 10 },
            )).toMatchObject({
                total: 1,
                rows: [expect.objectContaining({ path: filePath, name: '\uFFFD' })],
            });
        } finally {
            execRaw(db, 'ROLLBACK TO polaris_lone_surrogate');
            execRaw(db, 'RELEASE polaris_lone_surrogate');
        }
    });
});

describe('targeted set reads and frontier honesty', () => {
    it('reads structures in locked chunks without losing raw v4 structure fields', () => {
        const ids = Array.from({ length: 201 }, (_, index) => index + 1);
        const rows = readV4StructuresByInternalIds(db, ids);
        expect(rows).toHaveLength(9);
        expect(rows.map((row) => row.name)).toEqual([
            'gamma', 'alphaOne', 'alphaTwo', 'target', 'Box', 'run', 'beta', 'leak', 'testUse',
        ]);
        expect(rows.find((row) => row.name === 'gamma')).toMatchObject({
            paramsJson: '["required_parameter"]',
            returnText: 'type_annotation',
        });
    });

    it('reads imports, bindings, anchors, injections, and scopes for a file-key set', () => {
        const imports = readV4ImportsByFileKeys(db, MAIN_AND_SAMPLE);
        const bindings = readV4ImportBindingsByFileKeys(db, MAIN_AND_SAMPLE);
        const anchors = readV4AnchorsByFileKeys(db, MAIN_AND_SAMPLE);
        const injections = readV4InjectionsByFileKeys(db, MAIN_AND_SAMPLE);
        const scopes = readV4ScopesByFileKeys(db, MAIN_AND_SAMPLE);

        expect(imports.map((row) => [row.filePath, row.module])).toEqual([
            ['src/main.js', './target.js'],
            ['test/sample.js', '../src/target.js'],
        ]);
        expect(bindings.map((row) => [row.filePath, row.localName, row.importedName, row.isTypeOnly]))
            .toEqual([
                ['src/main.js', 'target', 'target', false],
                ['test/sample.js', 'target', 'target', false],
            ]);
        expect(anchors).toHaveLength(11);
        expect(injections.map((row) => row.injectedLanguage).sort()).toEqual(['html', 'sql']);
        expect(scopes).toHaveLength(7);
        expect(scopes.every((row) => MAIN_AND_SAMPLE.includes(row.filePath))).toBe(true);
    });

    it('reports exact edge storage statistics without turning legacy IDs into proof', () => {
        expect(readV4EdgeResolutionStats(db, '')).toEqual([
            { legacyStorageState: 'resolved', referenceKind: 'call', count: 6 },
            { legacyStorageState: 'unresolved', referenceKind: 'call', count: 2 },
        ]);
        expect(readV4EdgeResolutionStats(db, 'src/')).toEqual([
            { legacyStorageState: 'resolved', referenceKind: 'call', count: 5 },
            { legacyStorageState: 'unresolved', referenceKind: 'call', count: 2 },
        ]);
    });

    it('surfaces resolved IDs only as legacy_heuristic frontier candidates', () => {
        const rows = readV4EdgeFrontier(db, 'src/');
        expect(rows).toHaveLength(6);
        expect(rows.map((row) => [row.sourceName, row.referencedName, row.count, row.reason])).toEqual([
            ['alphaOne', 'missing', 1, 'name_only'],
            ['alphaOne', 'target', 1, 'legacy_heuristic'],
            ['alphaTwo', 'sql', 1, 'name_only'],
            ['alphaTwo', 'target', 2, 'legacy_heuristic'],
            ['run', 'target', 1, 'legacy_heuristic'],
            ['beta', 'target', 1, 'legacy_heuristic'],
        ]);
        for (const row of rows) {
            if (row.reason === 'name_only') {
                expect(row.legacyHeuristicTarget).toBeNull();
            } else {
                expect(row.legacyHeuristicTarget).toMatchObject({
                    name: 'target',
                    kind: 'def',
                    type: 'function',
                    filePath: 'src/target.js',
                });
            }
        }
        expect(JSON.stringify(rows)).not.toContain('proven');
    });
});

describe('scope aggregates and exact file coverage', () => {
    it('aggregates project/directory counts and derives the v4 language histogram from paths', () => {
        expect(readV4DirectoryProjectAggregates(db, '')).toEqual({
            scope: {
                key: '',
                fileCount: 5,
                declarationCount: 9,
                referenceCount: 10,
                languages: [
                    { language: 'javascript', fileCount: 4 },
                    { language: 'typescript', fileCount: 1 },
                ],
            },
            directories: [
                {
                    key: 'lib', fileCount: 1, declarationCount: 1, referenceCount: 0,
                    languages: [{ language: 'typescript', fileCount: 1 }],
                },
                {
                    key: 'src', fileCount: 2, declarationCount: 6, referenceCount: 8,
                    languages: [{ language: 'javascript', fileCount: 2 }],
                },
                {
                    key: 'src0', fileCount: 1, declarationCount: 1, referenceCount: 0,
                    languages: [{ language: 'javascript', fileCount: 1 }],
                },
                {
                    key: 'test', fileCount: 1, declarationCount: 1, referenceCount: 2,
                    languages: [{ language: 'javascript', fileCount: 1 }],
                },
            ],
        });

        expect(readV4DirectoryProjectAggregates(db, 'src/')).toEqual({
            scope: {
                key: 'src',
                fileCount: 2,
                declarationCount: 6,
                referenceCount: 8,
                languages: [{ language: 'javascript', fileCount: 2 }],
            },
            directories: [{
                key: 'src',
                fileCount: 2,
                declarationCount: 6,
                referenceCount: 8,
                languages: [{ language: 'javascript', fileCount: 2 }],
            }],
        });
    });

    it('returns one exact present/missing hash row per requested key and reuses the canonical scope view', () => {
        const requested = [...FILE_KEYS, 'missing/a.js', 'missing/b.js'];
        const rows = readV4FileHashesByKeys(db, requested);
        expect(rows).toHaveLength(7);
        for (const key of FILE_KEYS) {
            expect(rows.find((row) => row.filePath === key)).toMatchObject({
                filePath: key,
                present: true,
                hash: md5(SOURCES[key]),
            });
        }
        expect(rows.filter((row) => !row.present)).toEqual([
            { filePath: 'missing/a.js', present: false, hash: null, lastIndexed: null },
            { filePath: 'missing/b.js', present: false, hash: null, lastIndexed: null },
        ]);
        expect(getScopeFileHashView(db, '')).toEqual(
            FILE_KEYS.map((key) => ({ path: key, hash: md5(SOURCES[key]) })),
        );
    });
});

describe('statement-count and query-plan gates', () => {
    it('keeps every set read within its documented fixed or chunked statement bound', () => {
        const exactlyOne = [
            ['complete bundle', () => readV4CompleteFileFactBundle(db, ['src/main.js', 'src/target.js'])],
            ['ancestry', () => readV4ParentAncestry(db, [symbolIds.run, symbolIds.beta])],
            ['range', () => readV4FactsIntersectingRange(db, 'src/main.js', 1, 11)],
            ['occurrences', () => queryV4Occurrences(db, { scopePrefix: '', role: 'declaration' }, { limit: 2 })],
            ['imports', () => readV4ImportsByFileKeys(db, MAIN_AND_SAMPLE)],
            ['bindings', () => readV4ImportBindingsByFileKeys(db, MAIN_AND_SAMPLE)],
            ['anchors', () => readV4AnchorsByFileKeys(db, MAIN_AND_SAMPLE)],
            ['injections', () => readV4InjectionsByFileKeys(db, MAIN_AND_SAMPLE)],
            ['scopes', () => readV4ScopesByFileKeys(db, MAIN_AND_SAMPLE)],
            ['edge stats', () => readV4EdgeResolutionStats(db, 'src/')],
            ['frontier', () => readV4EdgeFrontier(db, 'src/')],
            ['aggregates', () => readV4DirectoryProjectAggregates(db, '')],
        ];
        for (const [name, invoke] of exactlyOne) {
            const traced = traceStatementExecutions(db, invoke);
            expect(traced.calls, `${name} must execute exactly one SQL statement`).toHaveLength(1);
        }

        const ids = Array.from({ length: 201 }, (_, index) => index + 1);
        const structures = traceStatementExecutions(
            db,
            () => readV4StructuresByInternalIds(db, ids),
        );
        expect(structures.calls).toHaveLength(3);
        expect(structures.result).toHaveLength(9);

        const hashKeys = [
            ...FILE_KEYS,
            ...Array.from({ length: 196 }, (_, index) => `missing/${index}.js`),
        ];
        const hashes = traceStatementExecutions(db, () => readV4FileHashesByKeys(db, hashKeys));
        expect(hashes.calls).toHaveLength(3);
        expect(hashes.result).toHaveLength(201);

        const emptySetReads = [
            () => readV4CompleteFileFactBundle(db, []),
            () => readV4ParentAncestry(db, []),
            () => readV4StructuresByInternalIds(db, []),
            () => readV4ImportsByFileKeys(db, []),
            () => readV4ImportBindingsByFileKeys(db, []),
            () => readV4AnchorsByFileKeys(db, []),
            () => readV4InjectionsByFileKeys(db, []),
            () => readV4ScopesByFileKeys(db, []),
            () => readV4FileHashesByKeys(db, []),
        ];
        for (const invoke of emptySetReads) {
            expect(traceStatementExecutions(db, invoke).calls).toHaveLength(0);
        }
    });

    it('uses the intended indexes for every hot read SQL shape', () => {
        const cases = [
            {
                name: 'complete bundle',
                invoke: () => readV4CompleteFileFactBundle(db, ['src/main.js', 'src/target.js']),
                required: [
                    /sqlite_autoindex_files_1/,
                    /idx_symbols_file/,
                    /idx_edges_container/,
                    /idx_anchors_symbol/,
                    /idx_imports_file/,
                    /idx_import_bindings_(?:file|local)/,
                    /idx_injections_file/,
                    /idx_local_scopes_symbol/,
                ],
            },
            {
                name: 'ancestry',
                invoke: () => readV4ParentAncestry(db, [symbolIds.run, symbolIds.beta]),
                required: [/INTEGER PRIMARY KEY/],
            },
            {
                name: 'range intersections',
                invoke: () => readV4FactsIntersectingRange(db, 'src/main.js', 1, 11),
                required: [
                    /idx_symbols_file/,
                    /idx_anchors_symbol/,
                    /idx_local_scopes_symbol/,
                    /idx_imports_file/,
                    /idx_injections_file/,
                ],
            },
            {
                name: 'occurrences',
                invoke: () => queryV4Occurrences(
                    db,
                    { scopePrefix: 'src/', role: 'declaration', name: { mode: 'prefix', value: 'alpha' } },
                    { limit: 2 },
                ),
                required: [
                    /SEARCH s USING INDEX idx_symbols_kind_name \(kind=\? AND name>\? AND name<\?\)/,
                ],
                requiredSql: [
                    /s\.name >= \? AND s\.name < \? AND substr\(s\.name, 1, length\(\?\)\) = \?/,
                ],
            },
            {
                name: 'structures',
                invoke: () => readV4StructuresByInternalIds(db, [symbolIds.run, symbolIds.beta]),
                required: [/INTEGER PRIMARY KEY/],
            },
            {
                name: 'imports',
                invoke: () => readV4ImportsByFileKeys(db, MAIN_AND_SAMPLE),
                required: [/idx_imports_file/],
            },
            {
                name: 'bindings',
                invoke: () => readV4ImportBindingsByFileKeys(db, MAIN_AND_SAMPLE),
                required: [/idx_import_bindings_(?:file|local)/],
            },
            {
                name: 'anchors',
                invoke: () => readV4AnchorsByFileKeys(db, MAIN_AND_SAMPLE),
                required: [/idx_anchors_symbol|idx_symbols_file/],
            },
            {
                name: 'injections',
                invoke: () => readV4InjectionsByFileKeys(db, MAIN_AND_SAMPLE),
                required: [/idx_injections_file/],
            },
            {
                name: 'scopes',
                invoke: () => readV4ScopesByFileKeys(db, MAIN_AND_SAMPLE),
                required: [/idx_local_scopes_symbol|idx_symbols_file/],
            },
            {
                name: 'edge stats',
                invoke: () => readV4EdgeResolutionStats(db, 'src/'),
                required: [/idx_edges_container/, /idx_symbols_(?:file|kind_name)/],
            },
            {
                name: 'frontier',
                invoke: () => readV4EdgeFrontier(db, 'src/'),
                required: [/idx_edges_container/, /INTEGER PRIMARY KEY/],
            },
            {
                name: 'directory/project aggregates',
                invoke: () => readV4DirectoryProjectAggregates(db, ''),
                required: [/sqlite_autoindex_files_1/, /idx_symbols_file/],
            },
            {
                name: 'file hash coverage',
                invoke: () => readV4FileHashesByKeys(db, ['src/main.js', 'missing.js']),
                required: [/sqlite_autoindex_files_1/],
            },
        ];

        for (const entry of cases) {
            const traced = traceStatementExecutions(db, entry.invoke);
            expect(traced.calls.length, `${entry.name} must execute SQL`).toBeGreaterThan(0);
            const details = explainCalls(traced.calls);
            console.log(`[POLARIS Task 2.2 EQP] ${entry.name}\n${details}\n`);
            if (entry.requiredSql) {
                const executedSql = traced.calls.map((call) => call.sql).join('\n');
                for (const requiredSql of entry.requiredSql) {
                    expect(executedSql, `${entry.name} must probe ${requiredSql}`).toMatch(requiredSql);
                }
            }
            for (const required of entry.required) {
                expect(details, `${entry.name} must use ${required}`).toMatch(required);
            }
        }
    });

    it('contains no forbidden displacement pagination in the adapter source', () => {
        const source = fs.readFileSync(ADAPTER_SOURCE, 'utf8');
        expect(/\bOFFSET\b/i.test(source)).toBe(false);
    });
});
