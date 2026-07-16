// Independent POLARIS v4 correctness oracles.
//
// Oracle policy for this file:
// - expected adapter rows come from hand-authored v4 facts or direct raw SQL,
//   never from another adapter helper;
// - text ordering uses UTF-8 bytes (Buffer.compare), matching SQLite BINARY;
// - range expectations use an independent inclusive-overlap predicate;
// - incremental persistence is checked against both a clean build and an
//   add-then-remove metamorphic restoration;
// - every test carries a positive/negative control or a fault/mutation control.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    closeDb,
    execRaw,
    initSymbolSchema,
    namePrefixUpperBound,
    openDb,
    queryRaw,
    queryV4Occurrences,
    readV4AnchorsByFileKeys,
    readV4CompleteFileFactBundle,
    readV4EdgeFrontier,
    readV4EdgeResolutionStats,
    readV4FactsIntersectingRange,
    readV4ImportBindingsByFileKeys,
    readV4ImportsByFileKeys,
    readV4InjectionsByFileKeys,
    readV4ScopesByFileKeys,
} from '../dist/core/db-adapter.js';
import {
    ensureFreshFromContent,
    ensureIndexFresh,
} from '../dist/core/symbol-index.js';

const trackedConnections = new Set();
let tempRoot;
let db;
let seeded;

function openTracked(fileName) {
    const conn = openDb(path.join(tempRoot, fileName));
    trackedConnections.add(conn);
    initSymbolSchema(conn);
    return conn;
}

function insertReturningId(conn, sql, ...params) {
    const rows = queryRaw(conn, sql, ...params);
    if (rows.length !== 1 || typeof rows[0].id !== 'number') {
        throw new Error(`independent fixture insert did not return one id: ${sql}`);
    }
    return rows[0].id;
}

function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareNullableUtf8(left, right) {
    if (left === right) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    return compareUtf8(left, right);
}

function seedRawV4Fixture(conn) {
    queryRaw(conn, `
        INSERT INTO files (path, hash, last_indexed) VALUES
            ('src/alpha.ts', 'hash-alpha', 101),
            ('src/beta.ts', 'hash-beta', 102),
            ('src0/leak.ts', 'hash-leak', 103)
        RETURNING path
    `);

    const outer = insertReturningId(conn, `
        INSERT INTO symbols (
            name, kind, type, file_path, line, end_line, column,
            capture_tag, body_hash, parent_symbol_id, visibility
        ) VALUES ('Outer', 'def', 'class', 'src/alpha.ts', 1, 10, 0,
                  'definition.class', 'body-outer', NULL, 'public')
        RETURNING id
    `);
    const run = insertReturningId(conn, `
        INSERT INTO symbols (
            name, kind, type, file_path, line, end_line, column,
            capture_tag, body_hash, parent_symbol_id, visibility
        ) VALUES ('run', 'def', 'method', 'src/alpha.ts', 2, 6, 2,
                  'definition.method', 'body-run', ?, 'public')
        RETURNING id
    `, outer);
    const needleRefA = insertReturningId(conn, `
        INSERT INTO symbols (
            name, kind, type, file_path, line, end_line, column,
            capture_tag, body_hash, parent_symbol_id, visibility
        ) VALUES ('needle', 'ref', 'call', 'src/alpha.ts', 3, 3, 4,
                  'reference.call', NULL, NULL, NULL)
        RETURNING id
    `);
    const needleRefB = insertReturningId(conn, `
        INSERT INTO symbols (
            name, kind, type, file_path, line, end_line, column,
            capture_tag, body_hash, parent_symbol_id, visibility
        ) VALUES ('needle', 'ref', 'call', 'src/alpha.ts', 3, 3, 20,
                  'reference.call', NULL, NULL, NULL)
        RETURNING id
    `);
    const zetaRef = insertReturningId(conn, `
        INSERT INTO symbols (
            name, kind, type, file_path, line, end_line, column,
            capture_tag, body_hash, parent_symbol_id, visibility
        ) VALUES ('zeta', 'ref', 'call', 'src/alpha.ts', 8, 8, 1,
                  'reference.call', NULL, NULL, NULL)
        RETURNING id
    `);
    const needleDef = insertReturningId(conn, `
        INSERT INTO symbols (
            name, kind, type, file_path, line, end_line, column,
            capture_tag, body_hash, parent_symbol_id, visibility
        ) VALUES ('needle', 'def', 'function', 'src/beta.ts', 1, 2, 0,
                  'definition.function', 'body-needle', NULL, 'public')
        RETURNING id
    `);
    const leak = insertReturningId(conn, `
        INSERT INTO symbols (
            name, kind, type, file_path, line, end_line, column,
            capture_tag, body_hash, parent_symbol_id, visibility
        ) VALUES ('scopeLeak', 'def', 'function', 'src0/leak.ts', 1, 2, 0,
                  'definition.function', 'body-leak', NULL, 'public')
        RETURNING id
    `);

    const edgeNeedleA = insertReturningId(conn, `
        INSERT INTO edges (container_def_id, referenced_name, callee_symbol_id, reference_kind)
        VALUES (?, 'needle', ?, 'call') RETURNING id
    `, run, needleDef);
    const edgeNeedleB = insertReturningId(conn, `
        INSERT INTO edges (container_def_id, referenced_name, callee_symbol_id, reference_kind)
        VALUES (?, 'needle', ?, 'call') RETURNING id
    `, run, needleDef);
    const edgeZeta = insertReturningId(conn, `
        INSERT INTO edges (container_def_id, referenced_name, callee_symbol_id, reference_kind)
        VALUES (?, 'zeta', NULL, 'call') RETURNING id
    `, run);
    insertReturningId(conn, `
        INSERT INTO edges (container_def_id, referenced_name, callee_symbol_id, reference_kind)
        VALUES (?, 'scopeSentinel', NULL, 'call') RETURNING id
    `, leak);

    queryRaw(conn, `
        INSERT INTO symbol_structures (
            symbol_id, params_json, return_text, decorators_json,
            modifiers_json, generics_text, parent_kind, parent_name
        ) VALUES (?, '["value"]', 'number', '["memo"]',
                  '["public"]', '<T>', 'class', 'Outer')
        RETURNING symbol_id
    `, run);
    queryRaw(conn, `
        INSERT INTO symbol_structures (
            symbol_id, params_json, return_text, decorators_json,
            modifiers_json, generics_text, parent_kind, parent_name
        ) VALUES (?, '[]', 'void', '[]', '[]', NULL, NULL, NULL)
        RETURNING symbol_id
    `, leak);

    const anchor = insertReturningId(conn, `
        INSERT INTO anchors (symbol_id, kind, line, end_line, text)
        VALUES (?, 'if', 3, 5, 'if (needle)') RETURNING id
    `, run);
    insertReturningId(conn, `
        INSERT INTO anchors (symbol_id, kind, line, end_line, text)
        VALUES (?, 'return', 2, 2, 'return 1') RETURNING id
    `, leak);

    const importId = insertReturningId(conn, `
        INSERT INTO imports (
            file_path, module, imported_names_json, line, start_line, end_line
        ) VALUES ('src/alpha.ts', './beta', '["needle"]', 1, 1, 2)
        RETURNING id
    `);
    insertReturningId(conn, `
        INSERT INTO imports (
            file_path, module, imported_names_json, line, start_line, end_line
        ) VALUES ('src0/leak.ts', './sentinel', '["scopeSentinel"]', 1, 1, 1)
        RETURNING id
    `);

    const binding = insertReturningId(conn, `
        INSERT INTO import_bindings (
            file_path, source, local_name, imported_name,
            import_kind, is_type_only, line, column
        ) VALUES ('src/alpha.ts', './beta', 'needle', 'needle',
                  'named', 0, 1, 9)
        RETURNING id
    `);
    insertReturningId(conn, `
        INSERT INTO import_bindings (
            file_path, source, local_name, imported_name,
            import_kind, is_type_only, line, column
        ) VALUES ('src0/leak.ts', './sentinel', 'scopeSentinel', 'scopeSentinel',
                  'named', 0, 1, 9)
        RETURNING id
    `);

    const injection = insertReturningId(conn, `
        INSERT INTO injections (
            file_path, host_lang, injected_lang,
            start_line, end_line, start_byte, end_byte
        ) VALUES ('src/alpha.ts', 'typescript', 'sql', 4, 6, 40, 90)
        RETURNING id
    `);
    insertReturningId(conn, `
        INSERT INTO injections (
            file_path, host_lang, injected_lang,
            start_line, end_line, start_byte, end_byte
        ) VALUES ('src0/leak.ts', 'typescript', 'html', 1, 1, 0, 5)
        RETURNING id
    `);

    const scope = insertReturningId(conn, `
        INSERT INTO local_scopes (
            symbol_id, scope_kind, start_line, end_line,
            parameters_json, locals_json
        ) VALUES (?, 'function', 2, 6, '["value"]', '["local"]')
        RETURNING id
    `, run);
    insertReturningId(conn, `
        INSERT INTO local_scopes (
            symbol_id, scope_kind, start_line, end_line,
            parameters_json, locals_json
        ) VALUES (?, 'function', 1, 2, '[]', '[]')
        RETURNING id
    `, leak);

    return {
        outer,
        run,
        needleRefA,
        needleRefB,
        zetaRef,
        needleDef,
        leak,
        edgeNeedleA,
        edgeNeedleB,
        edgeZeta,
        anchor,
        importId,
        binding,
        injection,
        scope,
    };
}

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-independent-v4-'));
    db = openTracked('fixture.db');
    seeded = seedRawV4Fixture(db);
});

afterEach(() => {
    for (const conn of trackedConnections) {
        try { closeDb(conn); } catch { /* already closed or intentionally faulted */ }
    }
    trackedConnections.clear();
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('complete v4 bundle: hand-authored SQLite oracle', () => {
    it('projects every requested v4 family exactly and excludes a prefix-adjacent file', () => {
        const bundle = readV4CompleteFileFactBundle(
            db,
            ['src/alpha.ts', 'missing.ts', 'src/alpha.ts'],
        );

        // Edge rows intentionally contain a duplicate semantic name edge.
        // Their adapter-only row IDs are not a canonical public ordering key,
        // so normalize that one internal-only tie before comparing fields.
        const normalizedBundle = {
            ...bundle,
            edges: [...bundle.edges].sort((a, b) => a.internalId - b.internalId),
        };
        expect(normalizedBundle).toEqual({
            files: [
                { filePath: 'missing.ts', present: false, hash: null, lastIndexed: null },
                { filePath: 'src/alpha.ts', present: true, hash: 'hash-alpha', lastIndexed: 101 },
            ],
            symbols: [
                {
                    internalId: seeded.outer,
                    name: 'Outer', role: 'declaration', kind: 'class', filePath: 'src/alpha.ts',
                    line: 1, endLine: 10, column: 0, captureTag: 'definition.class',
                    bodyHash: 'body-outer', parentInternalId: null, visibility: 'public',
                },
                {
                    internalId: seeded.run,
                    name: 'run', role: 'declaration', kind: 'method', filePath: 'src/alpha.ts',
                    line: 2, endLine: 6, column: 2, captureTag: 'definition.method',
                    bodyHash: 'body-run', parentInternalId: seeded.outer, visibility: 'public',
                },
                {
                    internalId: seeded.needleRefA,
                    name: 'needle', role: 'reference', kind: 'call', filePath: 'src/alpha.ts',
                    line: 3, endLine: 3, column: 4, captureTag: 'reference.call',
                    bodyHash: null, parentInternalId: null, visibility: null,
                },
                {
                    internalId: seeded.needleRefB,
                    name: 'needle', role: 'reference', kind: 'call', filePath: 'src/alpha.ts',
                    line: 3, endLine: 3, column: 20, captureTag: 'reference.call',
                    bodyHash: null, parentInternalId: null, visibility: null,
                },
                {
                    internalId: seeded.zetaRef,
                    name: 'zeta', role: 'reference', kind: 'call', filePath: 'src/alpha.ts',
                    line: 8, endLine: 8, column: 1, captureTag: 'reference.call',
                    bodyHash: null, parentInternalId: null, visibility: null,
                },
            ],
            edges: [
                {
                    internalId: seeded.edgeNeedleA,
                    containerInternalId: seeded.run,
                    referencedName: 'needle',
                    referenceKind: 'call',
                    legacyHeuristicTargetInternalId: seeded.needleDef,
                    sourceFilePath: 'src/alpha.ts',
                },
                {
                    internalId: seeded.edgeNeedleB,
                    containerInternalId: seeded.run,
                    referencedName: 'needle',
                    referenceKind: 'call',
                    legacyHeuristicTargetInternalId: seeded.needleDef,
                    sourceFilePath: 'src/alpha.ts',
                },
                {
                    internalId: seeded.edgeZeta,
                    containerInternalId: seeded.run,
                    referencedName: 'zeta',
                    referenceKind: 'call',
                    legacyHeuristicTargetInternalId: null,
                    sourceFilePath: 'src/alpha.ts',
                },
            ],
            structures: [{
                symbolInternalId: seeded.run,
                filePath: 'src/alpha.ts',
                name: 'run',
                line: 2,
                column: 2,
                paramsJson: '["value"]',
                returnText: 'number',
                decoratorsJson: '["memo"]',
                modifiersJson: '["public"]',
                genericsText: '<T>',
                parentKind: 'class',
                parentName: 'Outer',
            }],
            anchors: [{
                internalId: seeded.anchor,
                symbolInternalId: seeded.run,
                filePath: 'src/alpha.ts',
                symbolName: 'run',
                kind: 'if',
                line: 3,
                endLine: 5,
                text: 'if (needle)',
            }],
            imports: [{
                internalId: seeded.importId,
                filePath: 'src/alpha.ts',
                module: './beta',
                importedNamesJson: '["needle"]',
                line: 1,
                startLine: 1,
                endLine: 2,
            }],
            importBindings: [{
                internalId: seeded.binding,
                filePath: 'src/alpha.ts',
                source: './beta',
                localName: 'needle',
                importedName: 'needle',
                importKind: 'named',
                isTypeOnly: false,
                line: 1,
                column: 9,
            }],
            injections: [{
                internalId: seeded.injection,
                filePath: 'src/alpha.ts',
                hostLanguage: 'typescript',
                injectedLanguage: 'sql',
                startLine: 4,
                endLine: 6,
                startByte: 40,
                endByte: 90,
            }],
            scopes: [{
                internalId: seeded.scope,
                symbolInternalId: seeded.run,
                filePath: 'src/alpha.ts',
                symbolName: 'run',
                scopeKind: 'function',
                startLine: 2,
                endLine: 6,
                parametersJson: '["value"]',
                localsJson: '["local"]',
            }],
        });

        // Negative control: the raw store has one row from every family under
        // src0/, but exact src/alpha selection must never leak any of them.
        const rawLeakCount = queryRaw(db, `
            SELECT
                (SELECT COUNT(*) FROM symbols WHERE file_path = 'src0/leak.ts') +
                (SELECT COUNT(*) FROM imports WHERE file_path = 'src0/leak.ts') +
                (SELECT COUNT(*) FROM import_bindings WHERE file_path = 'src0/leak.ts') +
                (SELECT COUNT(*) FROM injections WHERE file_path = 'src0/leak.ts') AS count
        `)[0].count;
        expect(rawLeakCount).toBeGreaterThan(0);
        expect(JSON.stringify(bundle)).not.toContain('scopeLeak');
        expect(JSON.stringify(bundle)).not.toContain('scopeSentinel');
    });
});

describe('inclusive range reads: naive full-scan and metamorphic oracles', () => {
    function rangeToken(row) {
        const fact = row.fact;
        switch (row.factFamily) {
            case 'symbol':
                return `symbol:${fact.internalId}:${fact.name}:${fact.line}:${fact.endLine}:${fact.column}`;
            case 'anchor':
                return `anchor:${fact.internalId}:${fact.kind}:${fact.line}:${fact.endLine}`;
            case 'scope':
                return `scope:${fact.internalId}:${fact.scopeKind}:${fact.startLine}:${fact.endLine}`;
            case 'import':
                return `import:${fact.internalId}:${fact.module}:${fact.startLine}:${fact.endLine}`;
            case 'injection':
                return `injection:${fact.internalId}:${fact.injectedLanguage}:${fact.startLine}:${fact.endLine}`;
        }
    }

    function naiveIntersectingTokens(startLine, endLine) {
        const tokens = [];
        const intersects = (start, end) => start <= endLine && end >= startLine;

        for (const row of queryRaw(db, `
            SELECT id, name, line, end_line AS endLine, column
            FROM symbols WHERE file_path = 'src/alpha.ts'
        `)) {
            if (intersects(row.line, row.endLine)) {
                tokens.push(`symbol:${row.id}:${row.name}:${row.line}:${row.endLine}:${row.column}`);
            }
        }
        for (const row of queryRaw(db, `
            SELECT a.id, a.kind, a.line, COALESCE(a.end_line, a.line) AS endLine
            FROM anchors a JOIN symbols s ON s.id = a.symbol_id
            WHERE s.file_path = 'src/alpha.ts'
        `)) {
            if (intersects(row.line, row.endLine)) {
                tokens.push(`anchor:${row.id}:${row.kind}:${row.line}:${row.endLine}`);
            }
        }
        for (const row of queryRaw(db, `
            SELECT ls.id, ls.scope_kind AS scopeKind,
                   ls.start_line AS startLine, ls.end_line AS endLine
            FROM local_scopes ls JOIN symbols s ON s.id = ls.symbol_id
            WHERE s.file_path = 'src/alpha.ts'
        `)) {
            if (intersects(row.startLine, row.endLine)) {
                tokens.push(`scope:${row.id}:${row.scopeKind}:${row.startLine}:${row.endLine}`);
            }
        }
        for (const row of queryRaw(db, `
            SELECT id, module, COALESCE(start_line, line) AS startLine,
                   COALESCE(end_line, line) AS endLine
            FROM imports WHERE file_path = 'src/alpha.ts'
        `)) {
            if (intersects(row.startLine, row.endLine)) {
                tokens.push(`import:${row.id}:${row.module}:${row.startLine}:${row.endLine}`);
            }
        }
        for (const row of queryRaw(db, `
            SELECT id, injected_lang AS injectedLanguage,
                   start_line AS startLine, end_line AS endLine
            FROM injections WHERE file_path = 'src/alpha.ts'
        `)) {
            if (intersects(row.startLine, row.endLine)) {
                tokens.push(`injection:${row.id}:${row.injectedLanguage}:${row.startLine}:${row.endLine}`);
            }
        }
        return tokens.sort(compareUtf8);
    }

    it('equals a naive five-table inclusive-overlap filter at exact boundaries', () => {
        const actual = readV4FactsIntersectingRange(db, 'src/alpha.ts', 3, 4);
        expect(actual.map(rangeToken).sort(compareUtf8)).toEqual(naiveIntersectingTokens(3, 4));

        // Hand-worked order is a second oracle and exercises containment plus
        // exact start/end boundary inclusion. The line-8 ref and line-1..2
        // import are the negative controls.
        expect(actual.map(rangeToken)).toEqual([
            `symbol:${seeded.outer}:Outer:1:10:0`,
            `scope:${seeded.scope}:function:2:6`,
            `symbol:${seeded.run}:run:2:6:2`,
            `anchor:${seeded.anchor}:if:3:5`,
            `symbol:${seeded.needleRefA}:needle:3:3:4`,
            `symbol:${seeded.needleRefB}:needle:3:3:20`,
            `injection:${seeded.injection}:sql:4:6`,
        ]);
        expect(actual.map(rangeToken).join('\n')).not.toContain(`symbol:${seeded.zetaRef}:`);
        expect(actual.map(rangeToken).join('\n')).not.toContain(`import:${seeded.importId}:`);
    });

    it('a two-line query equals the set union of its two point queries', () => {
        const combined = new Set(
            readV4FactsIntersectingRange(db, 'src/alpha.ts', 3, 4).map(rangeToken),
        );
        const pointUnion = new Set([
            ...readV4FactsIntersectingRange(db, 'src/alpha.ts', 3, 3).map(rangeToken),
            ...readV4FactsIntersectingRange(db, 'src/alpha.ts', 4, 4).map(rangeToken),
        ]);
        expect([...combined].sort(compareUtf8)).toEqual([...pointUnion].sort(compareUtf8));

        // Mutation control: using only the first point loses the injection
        // that starts exactly at line 4, so the union assertion is non-vacuous.
        const firstPoint = new Set(
            readV4FactsIntersectingRange(db, 'src/alpha.ts', 3, 3).map(rangeToken),
        );
        expect(firstPoint.has(`injection:${seeded.injection}:sql:4:6`)).toBe(false);
        expect(combined.has(`injection:${seeded.injection}:sql:4:6`)).toBe(true);
    });
});

describe('occurrence discovery: raw-row, UTF-8, and keyset oracles', () => {
    const unicodeNames = [
        'ascii',
        'éclair',
        '\uD7FFtail',
        '\uE000tail',
        '\uFFFFtail',
        '\u{10000}tail',
        '😀tail',
        '𝌆tail',
        '\u{10FFFF}',
        '\u{10FFFF}tail',
        '\uD800tail', // node:sqlite persists this as U+FFFD + "tail"
    ];

    function rawOccurrenceOracle({ scopePrefix, role, name, kinds }) {
        const storageKind = role === 'declaration' ? 'def' : 'ref';
        const normalizedName = name === undefined
            ? undefined
            : { ...name, value: Buffer.from(name.value, 'utf8').toString('utf8') };
        const raw = queryRaw(db, `
            SELECT id AS internalId, file_path AS path, line,
                   end_line AS endLine, column, name, type AS kind,
                   capture_tag AS captureTag,
                   parent_symbol_id AS parentInternalId, visibility
            FROM symbols
            WHERE kind = ?
        `, storageKind);
        return raw
            .filter((row) => scopePrefix === '' || row.path.startsWith(scopePrefix))
            .filter((row) => {
                if (normalizedName === undefined) return true;
                if (normalizedName.mode === 'exact') return row.name === normalizedName.value;
                return row.name.startsWith(normalizedName.value);
            })
            .filter((row) => kinds === undefined || kinds.includes(row.kind))
            .map((row) => ({ ...row, role }))
            .sort((left, right) => (
                compareUtf8(left.path, right.path)
                || left.line - right.line
                || left.column - right.column
                || left.endLine - right.endLine
                || compareUtf8(left.kind, right.kind)
                || compareUtf8(left.name, right.name)
            ));
    }

    function pageKey(row) {
        return {
            path: row.path,
            line: row.line,
            column: row.column,
            endLine: row.endLine,
            kind: row.kind,
            name: row.name,
        };
    }

    it('concatenated pages equal a raw full scan in SQLite UTF-8 byte order', () => {
        queryRaw(
            db,
            "INSERT INTO files (path, hash, last_indexed) VALUES ('unicode/corpus.ts', 'unicode', 200) RETURNING path",
        );
        for (const [index, name] of unicodeNames.entries()) {
            queryRaw(db, `
                INSERT INTO symbols (
                    name, kind, type, file_path, line, end_line, column,
                    capture_tag, body_hash, parent_symbol_id, visibility
                ) VALUES (?, 'def', ?, 'unicode/corpus.ts', 20, 20, 5,
                          'definition.synthetic', NULL, NULL, NULL)
                RETURNING id
            `, name, 'function');
        }

        const filter = { scopePrefix: 'unicode/', role: 'declaration' };
        const oracle = rawOccurrenceOracle(filter);
        expect(oracle).toHaveLength(unicodeNames.length);
        expect(oracle.some((row) => row.name === '\uFFFDtail')).toBe(true);

        // Anti-vacuity: JS UTF-16 ordering disagrees with SQLite BINARY for
        // this corpus (notably supplementary characters versus U+E000).
        const jsOrderedNames = [...oracle]
            .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
            .map((row) => row.name);
        expect(jsOrderedNames).not.toEqual(oracle.map((row) => row.name));

        const oneShot = queryV4Occurrences(db, filter, { limit: 100 });
        expect(oneShot.total).toBe(oracle.length);
        expect(oneShot.rows).toEqual(oracle);

        const concatenated = [];
        let afterKey;
        while (true) {
            const page = queryV4Occurrences(
                db,
                filter,
                afterKey === undefined ? { limit: 3 } : { limit: 3, afterKey },
            );
            expect(page.total).toBe(oracle.length);
            concatenated.push(...page.rows);
            if (page.rows.length < 3) break;
            afterKey = pageKey(page.rows[page.rows.length - 1]);
        }
        expect(concatenated).toEqual(oracle);

        const emptyTail = queryV4Occurrences(db, filter, {
            limit: 3,
            afterKey: pageKey(oracle[oracle.length - 1]),
        });
        expect(emptyTail).toEqual({ rows: [], total: oracle.length });

        const prefixes = [
            'ascii', 'é', '\uD7FF', '\uE000', '\uFFFF', '\u{10000}',
            '😀', '𝌆', '\u{10FFFF}', '\uD800', 'not-present',
        ];
        for (const prefix of prefixes) {
            const prefixFilter = {
                ...filter,
                name: { mode: 'prefix', value: prefix },
            };
            const expected = rawOccurrenceOracle(prefixFilter);
            const actual = queryV4Occurrences(db, prefixFilter, { limit: 100 });
            expect(actual.total, `prefix total ${JSON.stringify(prefix)}`).toBe(expected.length);
            expect(actual.rows, `prefix rows ${JSON.stringify(prefix)}`).toEqual(expected);

            // Independent bound property: every stored name inside the UTF-8
            // interval has the prefix and every stored name outside does not.
            const normalizedPrefix = Buffer.from(prefix, 'utf8').toString('utf8');
            const upper = namePrefixUpperBound(normalizedPrefix);
            for (const row of oracle) {
                const inByteRange = compareUtf8(row.name, normalizedPrefix) >= 0
                    && (upper === null || compareUtf8(row.name, upper) < 0);
                expect(
                    inByteRange,
                    `byte-bound mismatch name=${JSON.stringify(row.name)} prefix=${JSON.stringify(prefix)}`,
                ).toBe(row.name.startsWith(normalizedPrefix));
            }
        }

        // Conjunctive positive/negative controls on role, exact name, kind,
        // and the src/ versus src0/ scope boundary.
        const refsFilter = {
            scopePrefix: 'src/',
            role: 'reference',
            name: { mode: 'exact', value: 'needle' },
            kinds: ['call'],
        };
        expect(queryV4Occurrences(db, refsFilter, { limit: 10 }).rows)
            .toEqual(rawOccurrenceOracle(refsFilter));
        expect(queryV4Occurrences(
            db,
            { ...refsFilter, kinds: ['type'] },
            { limit: 10 },
        )).toEqual({ rows: [], total: 0 });
    });
});

describe('UTF-16 source columns versus UTF-8 storage bytes', () => {
    it('persists declaration and repeated-call columns as JS UTF-16 code units', async () => {
        const repo = path.join(tempRoot, 'utf16-repo');
        const absolute = path.join(repo, 'src', 'columns.ts');
        fs.mkdirSync(path.dirname(absolute), { recursive: true });

        const prefix = 'const marker = "ASCII-é-\uE000-😀-𝌆-\uD800"; ';
        const source = `${prefix}export function target() { return target(); }\n`;
        fs.writeFileSync(absolute, source, 'utf8');

        expect(await ensureFreshFromContent(db, repo, absolute, source)).toBe(1);

        const declarationColumn = source.indexOf('target');
        const referenceColumn = source.lastIndexOf('target');
        const declarationByteOffset = Buffer.byteLength(source.slice(0, declarationColumn), 'utf8');
        const referenceByteOffset = Buffer.byteLength(source.slice(0, referenceColumn), 'utf8');

        // Positive mutation control: a byte-column implementation would
        // produce different numbers for both occurrences in this fixture.
        expect(declarationByteOffset).not.toBe(declarationColumn);
        expect(referenceByteOffset).not.toBe(referenceColumn);

        const declaration = queryV4Occurrences(
            db,
            {
                scopePrefix: 'src/',
                role: 'declaration',
                name: { mode: 'exact', value: 'target' },
            },
            { limit: 10 },
        );
        const reference = queryV4Occurrences(
            db,
            {
                scopePrefix: 'src/',
                role: 'reference',
                name: { mode: 'exact', value: 'target' },
            },
            { limit: 10 },
        );
        expect(declaration.rows.map((row) => row.column)).toEqual([declarationColumn]);
        expect(reference.rows.map((row) => row.column)).toEqual([referenceColumn]);

        // Raw-SQL differential: the adapter columns are the exact persisted
        // substrate columns, not a composer-side reconstruction.
        expect(queryRaw(db, `
            SELECT kind, column FROM symbols
            WHERE file_path = 'src/columns.ts' AND name = 'target'
            ORDER BY kind, column
        `)).toEqual([
            { kind: 'def', column: declarationColumn },
            { kind: 'ref', column: referenceColumn },
        ]);
    });
});

describe('targeted family reads and frontier honesty: raw-SQL differential', () => {
    it('deduplicates requested keys and returns only rows from the exact key set', () => {
        const requested = ['src/alpha.ts', 'src/alpha.ts'];

        expect(readV4ImportsByFileKeys(db, requested)).toEqual([{
            internalId: seeded.importId,
            filePath: 'src/alpha.ts',
            module: './beta',
            importedNamesJson: '["needle"]',
            line: 1,
            startLine: 1,
            endLine: 2,
        }]);
        expect(readV4ImportBindingsByFileKeys(db, requested)).toEqual([{
            internalId: seeded.binding,
            filePath: 'src/alpha.ts',
            source: './beta',
            localName: 'needle',
            importedName: 'needle',
            importKind: 'named',
            isTypeOnly: false,
            line: 1,
            column: 9,
        }]);
        expect(readV4AnchorsByFileKeys(db, requested)).toEqual([{
            internalId: seeded.anchor,
            symbolInternalId: seeded.run,
            filePath: 'src/alpha.ts',
            symbolName: 'run',
            kind: 'if',
            line: 3,
            endLine: 5,
            text: 'if (needle)',
        }]);
        expect(readV4InjectionsByFileKeys(db, requested)).toEqual([{
            internalId: seeded.injection,
            filePath: 'src/alpha.ts',
            hostLanguage: 'typescript',
            injectedLanguage: 'sql',
            startLine: 4,
            endLine: 6,
            startByte: 40,
            endByte: 90,
        }]);
        expect(readV4ScopesByFileKeys(db, requested)).toEqual([{
            internalId: seeded.scope,
            symbolInternalId: seeded.run,
            filePath: 'src/alpha.ts',
            symbolName: 'run',
            scopeKind: 'function',
            startLine: 2,
            endLine: 6,
            parametersJson: '["value"]',
            localsJson: '["local"]',
        }]);

        // Negative control: every underlying table also contains a src0 row,
        // so an accidental prefix/whole-table read would make this fail.
        for (const table of ['imports', 'import_bindings', 'anchors', 'injections', 'local_scopes']) {
            expect(queryRaw(db, `SELECT COUNT(*) AS count FROM ${table}`)[0].count).toBe(2);
        }
    });

    it('raw edge grouping agrees on exact counts, scope, and legacy-only targets', () => {
        const raw = queryRaw(db, `
            SELECT e.id,
                   caller.id AS sourceInternalId,
                   caller.file_path AS sourceFilePath,
                   caller.name AS sourceName,
                   caller.type AS sourceKind,
                   caller.line AS sourceLine,
                   caller.end_line AS sourceEndLine,
                   caller.column AS sourceColumn,
                   e.referenced_name AS referencedName,
                   e.reference_kind AS referenceKind,
                   target.id AS targetInternalId,
                   target.file_path AS targetFilePath,
                   target.name AS targetName,
                   target.kind AS targetStorageKind,
                   target.type AS targetType,
                   target.line AS targetLine,
                   target.end_line AS targetEndLine,
                   target.column AS targetColumn
            FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            LEFT JOIN symbols target ON target.id = e.callee_symbol_id
        `);
        const scoped = raw.filter((row) => row.sourceFilePath.startsWith('src/'));
        expect(raw.some((row) => row.sourceFilePath === 'src0/leak.ts')).toBe(true);
        expect(raw.filter((row) => row.sourceFilePath.startsWith('src')).length)
            .toBeGreaterThan(scoped.length);

        const statCounts = new Map();
        for (const row of scoped) {
            const state = row.targetInternalId === null ? 'unresolved' : 'resolved';
            const key = `${state}\u0000${row.referenceKind}`;
            statCounts.set(key, (statCounts.get(key) ?? 0) + 1);
        }
        const expectedStats = [...statCounts.entries()]
            .map(([key, count]) => {
                const [legacyStorageState, referenceKind] = key.split('\u0000');
                return { legacyStorageState, referenceKind, count };
            })
            .sort((a, b) => (
                compareUtf8(a.legacyStorageState, b.legacyStorageState)
                || compareUtf8(a.referenceKind, b.referenceKind)
            ));
        expect(readV4EdgeResolutionStats(db, 'src/')).toEqual(expectedStats);

        const grouped = new Map();
        for (const row of scoped) {
            const key = JSON.stringify([
                row.sourceInternalId,
                row.referencedName,
                row.referenceKind,
                row.targetInternalId,
            ]);
            const existing = grouped.get(key);
            if (existing) {
                existing.count += 1;
                continue;
            }
            grouped.set(key, { ...row, count: 1 });
        }
        const expectedFrontier = [...grouped.values()]
            .sort((left, right) => (
                compareNullableUtf8(left.sourceFilePath, right.sourceFilePath)
                || (left.sourceLine ?? -1) - (right.sourceLine ?? -1)
                || (left.sourceColumn ?? -1) - (right.sourceColumn ?? -1)
                || compareNullableUtf8(left.sourceName, right.sourceName)
                || compareNullableUtf8(left.referencedName, right.referencedName)
                || compareUtf8(left.referenceKind, right.referenceKind)
                || compareNullableUtf8(left.targetFilePath, right.targetFilePath)
                || (left.targetLine ?? -1) - (right.targetLine ?? -1)
                || (left.targetColumn ?? -1) - (right.targetColumn ?? -1)
                || compareNullableUtf8(left.targetName, right.targetName)
            ))
            .map((row) => ({
                sourceInternalId: row.sourceInternalId,
                sourceFilePath: row.sourceFilePath,
                sourceName: row.sourceName,
                sourceKind: row.sourceKind,
                sourceLine: row.sourceLine,
                sourceEndLine: row.sourceEndLine,
                sourceColumn: row.sourceColumn,
                referencedName: row.referencedName,
                referenceKind: row.referenceKind,
                count: row.count,
                reason: row.targetInternalId === null ? 'name_only' : 'legacy_heuristic',
                legacyHeuristicTarget: row.targetInternalId === null ? null : {
                    internalId: row.targetInternalId,
                    filePath: row.targetFilePath,
                    name: row.targetName,
                    kind: row.targetStorageKind,
                    type: row.targetType,
                    line: row.targetLine,
                    endLine: row.targetEndLine,
                    column: row.targetColumn,
                },
            }));
        const actualFrontier = readV4EdgeFrontier(db, 'src/');
        expect(actualFrontier).toEqual(expectedFrontier);
        expect(actualFrontier.map((row) => [row.referencedName, row.count, row.reason])).toEqual([
            ['needle', 2, 'legacy_heuristic'],
            ['zeta', 1, 'name_only'],
        ]);
        expect(JSON.stringify(actualFrontier)).not.toContain('proven');
        expect(JSON.stringify(actualFrontier)).not.toContain('scopeSentinel');
    });
});

describe('incremental persistence: clean-build, rollback, and restoration oracles', () => {
    function canonicalResolutionState(conn) {
        const files = queryRaw(conn, 'SELECT path, hash FROM files')
            .sort((a, b) => compareUtf8(a.path, b.path));
        const symbols = queryRaw(conn, `
            SELECT s.name, s.kind, s.type, s.file_path AS filePath,
                   s.line, s.end_line AS endLine, s.column,
                   p.name AS parentName, p.file_path AS parentFile,
                   p.line AS parentLine, p.column AS parentColumn
            FROM symbols s
            LEFT JOIN symbols p ON p.id = s.parent_symbol_id
        `).sort((a, b) => (
            compareUtf8(a.filePath, b.filePath)
            || a.line - b.line
            || a.column - b.column
            || compareUtf8(a.kind, b.kind)
            || compareUtf8(a.name, b.name)
        ));
        const edges = queryRaw(conn, `
            SELECT caller.name AS callerName,
                   caller.file_path AS callerFile,
                   caller.line AS callerLine,
                   e.referenced_name AS referencedName,
                   e.reference_kind AS referenceKind,
                   target.name AS targetName,
                   target.file_path AS targetFile,
                   target.line AS targetLine
            FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            LEFT JOIN symbols target ON target.id = e.callee_symbol_id
        `).sort((a, b) => (
            compareUtf8(a.callerFile, b.callerFile)
            || a.callerLine - b.callerLine
            || compareUtf8(a.callerName, b.callerName)
            || compareUtf8(a.referencedName, b.referencedName)
            || compareUtf8(a.referenceKind, b.referenceKind)
            || compareNullableUtf8(a.targetFile, b.targetFile)
            || (a.targetLine ?? -1) - (b.targetLine ?? -1)
        ));
        const structures = queryRaw(conn, `
            SELECT s.name AS symbolName, s.file_path AS symbolFile,
                   s.line AS symbolLine, s.column AS symbolColumn,
                   ss.params_json AS paramsJson, ss.return_text AS returnText,
                   ss.decorators_json AS decoratorsJson,
                   ss.modifiers_json AS modifiersJson,
                   ss.generics_text AS genericsText,
                   ss.parent_kind AS parentKind, ss.parent_name AS parentName
            FROM symbol_structures ss JOIN symbols s ON s.id = ss.symbol_id
        `).sort((a, b) => compareUtf8(JSON.stringify(a), JSON.stringify(b)));
        const anchors = queryRaw(conn, `
            SELECT s.name AS symbolName, s.file_path AS symbolFile,
                   a.kind, a.line, a.end_line AS endLine, a.text
            FROM anchors a JOIN symbols s ON s.id = a.symbol_id
        `).sort((a, b) => compareUtf8(JSON.stringify(a), JSON.stringify(b)));
        const scopes = queryRaw(conn, `
            SELECT s.name AS symbolName, s.file_path AS symbolFile,
                   ls.scope_kind AS scopeKind, ls.start_line AS startLine,
                   ls.end_line AS endLine, ls.parameters_json AS parametersJson,
                   ls.locals_json AS localsJson
            FROM local_scopes ls JOIN symbols s ON s.id = ls.symbol_id
        `).sort((a, b) => compareUtf8(JSON.stringify(a), JSON.stringify(b)));
        const imports = queryRaw(conn, `
            SELECT file_path AS filePath, module, imported_names_json AS importedNamesJson,
                   line, start_line AS startLine, end_line AS endLine
            FROM imports
        `).sort((a, b) => compareUtf8(JSON.stringify(a), JSON.stringify(b)));
        const bindings = queryRaw(conn, `
            SELECT file_path AS filePath, source, local_name AS localName,
                   imported_name AS importedName, import_kind AS importKind,
                   is_type_only AS isTypeOnly, line, column
            FROM import_bindings
        `).sort((a, b) => compareUtf8(JSON.stringify(a), JSON.stringify(b)));
        const injections = queryRaw(conn, `
            SELECT file_path AS filePath, host_lang AS hostLanguage,
                   injected_lang AS injectedLanguage, start_line AS startLine,
                   end_line AS endLine, start_byte AS startByte, end_byte AS endByte
            FROM injections
        `).sort((a, b) => compareUtf8(JSON.stringify(a), JSON.stringify(b)));
        return JSON.stringify({
            files,
            symbols,
            edges,
            structures,
            anchors,
            scopes,
            imports,
            bindings,
            injections,
        });
    }

    function targetFile(conn) {
        const rows = queryRaw(conn, `
            SELECT target.file_path AS targetFile
            FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            LEFT JOIN symbols target ON target.id = e.callee_symbol_id
            WHERE caller.name = 'callChosen' AND e.referenced_name = 'chosen'
        `);
        expect(rows).toHaveLength(1);
        return rows[0].targetFile;
    }

    async function put(conn, repo, fileName, content) {
        const absolute = path.join(repo, fileName);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content, 'utf8');
        expect(await ensureFreshFromContent(conn, repo, absolute, content)).toBe(1);
        return absolute;
    }

    it('a fault leaves the old commit; retry equals clean; add-then-remove restores baseline', async () => {
        const repo = path.join(tempRoot, 'atomic-repo');
        const callerSource = 'export function callChosen() { return chosen(); }\n';
        const aSource = 'export function chosen() { return 1; }\n';
        const bSource = 'export function chosen() { return 2; }\n';

        const incremental = openTracked('incremental.db');
        const cleanCompetitor = openTracked('clean-competitor.db');

        await put(incremental, repo, 'caller.ts', callerSource);
        await put(incremental, repo, 'a.ts', aSource);
        expect(targetFile(incremental)).toBe('a.ts');
        const baseline = canonicalResolutionState(incremental);

        // Fault exactly after the stale-target clear. If the replacement,
        // clear, and re-resolution are not one transaction, this exposes a
        // third committed state instead of the old/new binary.
        execRaw(incremental, `
            CREATE TEMP TRIGGER independent_abort_after_clear
            AFTER UPDATE OF callee_symbol_id ON edges
            WHEN OLD.callee_symbol_id IS NOT NULL AND NEW.callee_symbol_id IS NULL
            BEGIN
                SELECT RAISE(ABORT, 'independent-oracle-fault');
            END
        `);
        const bAbsolute = path.join(repo, 'b.ts');
        fs.writeFileSync(bAbsolute, bSource, 'utf8');
        await expect(
            ensureFreshFromContent(incremental, repo, bAbsolute, bSource),
        ).rejects.toThrow('independent-oracle-fault');
        expect(canonicalResolutionState(incremental)).toBe(baseline);
        expect(queryRaw(incremental, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        expect(queryRaw(incremental, 'PRAGMA foreign_key_check')).toEqual([]);

        execRaw(incremental, 'DROP TRIGGER independent_abort_after_clear');
        expect(await ensureFreshFromContent(incremental, repo, bAbsolute, bSource)).toBe(1);
        expect(targetFile(incremental)).toBeNull();
        const incrementalWithCompetitor = canonicalResolutionState(incremental);
        expect(incrementalWithCompetitor).not.toBe(baseline);

        await put(cleanCompetitor, repo, 'caller.ts', callerSource);
        await put(cleanCompetitor, repo, 'a.ts', aSource);
        await put(cleanCompetitor, repo, 'b.ts', bSource);
        expect(targetFile(cleanCompetitor)).toBeNull();
        expect(incrementalWithCompetitor).toBe(canonicalResolutionState(cleanCompetitor));

        fs.rmSync(bAbsolute);
        expect(await ensureIndexFresh(incremental, repo, [bAbsolute])).toBe(0);
        expect(targetFile(incremental)).toBe('a.ts');
        expect(canonicalResolutionState(incremental)).toBe(baseline);
    });
});
