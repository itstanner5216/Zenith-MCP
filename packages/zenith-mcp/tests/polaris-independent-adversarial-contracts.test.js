// Independent adversarial oracles for POLARIS proof, persistence, paging,
// ordering, and epoch contracts.
//
// The tests intentionally drive compiled dist. Expected values are derived
// from TypeScript diagnostics, a clean database rebuild, raw SQL identity
// sets, UTF-8 byte comparison, and observable committed state. No production
// helper is used as the oracle for the behavior it is testing.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
    closeDb,
    getFactEpoch,
    initSymbolSchema,
    openMemoryDb,
    queryRaw,
    queryV4Occurrences,
    readV4StructuresByInternalIds,
    runTransaction,
} from '../dist/core/db-adapter.js';
import { ensureFreshFromContent } from '../dist/core/symbol-index.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(TESTS_DIR, '..');
const VIRTUAL_FIXTURE = path.join(
    PACKAGE_DIR,
    'dist',
    'core',
    'intelligence',
    '__polaris_independent_adversarial_contract__.ts',
);

const COMPILER_OPTIONS = {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
};

const connections = new Set();
const tempDirs = new Set();

function freshDb() {
    const conn = openMemoryDb();
    connections.add(conn);
    initSymbolSchema(conn);
    return conn;
}

function freshTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.add(dir);
    return dir;
}

function insertId(conn, sql, ...params) {
    const rows = queryRaw(conn, sql, ...params);
    expect(rows, `fixture INSERT must return exactly one id: ${sql}`).toHaveLength(1);
    expect(typeof rows[0]?.id).toBe('number');
    return rows[0].id;
}

function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compileVirtual(source) {
    const baseHost = ts.createCompilerHost(COMPILER_OPTIONS, true);
    const normalizedFixture = path.resolve(VIRTUAL_FIXTURE);
    const host = {
        ...baseHost,
        fileExists(fileName) {
            return path.resolve(fileName) === normalizedFixture || baseHost.fileExists(fileName);
        },
        readFile(fileName) {
            if (path.resolve(fileName) === normalizedFixture) return source;
            return baseHost.readFile(fileName);
        },
        getSourceFile(fileName, languageVersion) {
            const text = host.readFile(fileName);
            if (text === undefined) return undefined;
            return ts.createSourceFile(
                fileName,
                text,
                languageVersion,
                true,
                ts.getScriptKindFromFileName(fileName),
            );
        },
    };
    const program = ts.createProgram({
        rootNames: [VIRTUAL_FIXTURE],
        options: COMPILER_OPTIONS,
        host,
    });
    return ts.getPreEmitDiagnostics(program).filter((diagnostic) => (
        diagnostic.category === ts.DiagnosticCategory.Error
        && diagnostic.file !== undefined
        && path.resolve(diagnostic.file.fileName) === normalizedFixture
    ));
}

function diagnosticDetail(diagnostics) {
    return diagnostics.map((diagnostic) => (
        `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
    )).join('\n');
}

function locatedSymbolSource(candidateBasis, handleKind = 'fact') {
    const handle = handleKind === 'fact'
        ? "{ kind: 'fact', stableKey: 'fact:target', factKey: 'fact:target', snapshot: null, profile: null }"
        : "{ kind: 'text', stableKey: 'text:target', textKey: 'text:target', snapshot: null, profile: null }";
    return [
        "import type { LocatedSymbol, ResolvedLocatedSymbol } from './types.js';",
        'const candidate = {',
        `    handle: ${handle},`,
        "    path: 'src/target.ts',",
        "    name: 'target',",
        "    qualifiedName: 'target',",
        "    kind: 'function',",
        '    range: {',
        "        precision: 'byte',",
        '        startByte: 0,',
        '        endByte: 6,',
        '        startLine: 1,',
        '        startColumn: 0,',
        '        endLine: 1,',
        '        endColumn: 6,',
        '    },',
        `    candidateBasis: '${candidateBasis}',`,
        '    parentChain: [],',
        "    parentChainSource: 'none',",
        '} satisfies LocatedSymbol;',
        'const resolved: ResolvedLocatedSymbol = candidate;',
        'void resolved;',
    ].join('\n');
}

function canonicalEdgeResolution(conn) {
    return queryRaw(conn, `
        SELECT caller.name AS callerName,
               caller.file_path AS callerFile,
               e.referenced_name AS referencedName,
               target.name AS targetName,
               target.file_path AS targetFile
        FROM edges e
        JOIN symbols caller ON caller.id = e.container_def_id
        LEFT JOIN symbols target ON target.id = e.callee_symbol_id
        ORDER BY caller.file_path, caller.name, e.referenced_name
    `);
}

async function putSource(conn, repo, relativePath, source) {
    const absolute = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source, 'utf8');
    return ensureFreshFromContent(conn, repo, absolute, source);
}

afterEach(() => {
    for (const conn of connections) {
        try {
            closeDb(conn);
        } catch {
            // Best-effort cleanup must not mask an oracle failure.
        }
    }
    connections.clear();
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe('POLARIS independent adversarial contracts', () => {
    it('rejects heuristic_name as a ResolvedLocatedSymbol even when its handle is a persisted fact', () => {
        const exactDiagnostics = compileVirtual(locatedSymbolSource('exact_declaration'));
        expect(exactDiagnostics, diagnosticDetail(exactDiagnostics)).toEqual([]);

        // Anti-vacuity: the virtual compiler and dist declaration import must
        // catch a known-invalid text handle at this exact assignment seam.
        const textDiagnostics = compileVirtual(locatedSymbolSource('text_occurrence', 'text'));
        expect(
            textDiagnostics.some((diagnostic) => diagnostic.code === 2322),
            diagnosticDetail(textDiagnostics),
        ).toBe(true);

        // A fact identity proves persistence, not semantic resolution. The
        // heuristic basis therefore cannot inhabit the resolved target type.
        const heuristicDiagnostics = compileVirtual(locatedSymbolSource('heuristic_name'));
        expect(
            heuristicDiagnostics.some((diagnostic) => diagnostic.code === 2322),
            diagnosticDetail(heuristicDiagnostics),
        ).toBe(true);
    });

    it('keeps same-name incoming edge targets equal to a clean rebuild after a target body edit', async () => {
        const incremental = freshDb();
        const clean = freshDb();
        const incrementalRepo = freshTempDir('polaris-edge-incremental-');
        const cleanRepo = freshTempDir('polaris-edge-clean-');
        const caller = [
            'export function callTargetUnique(): number {',
            '    return targetUnique();',
            '}',
            '',
        ].join('\n');
        const targetV1 = [
            'export function targetUnique(): number {',
            '    return 1;',
            '}',
            '',
        ].join('\n');
        const targetV2 = [
            'export function targetUnique(): number {',
            '    return 2;',
            '}',
            '',
        ].join('\n');

        expect(await putSource(incremental, incrementalRepo, 'caller.ts', caller)).toBe(1);
        expect(await putSource(incremental, incrementalRepo, 'target.ts', targetV1)).toBe(1);
        const before = canonicalEdgeResolution(incremental);
        expect(before).toEqual([{
            callerName: 'callTargetUnique',
            callerFile: 'caller.ts',
            referencedName: 'targetUnique',
            targetName: 'targetUnique',
            targetFile: 'target.ts',
        }]);
        const beforeHash = queryRaw(
            incremental,
            "SELECT hash FROM files WHERE path = 'target.ts'",
        )[0]?.hash;

        expect(targetV2).not.toBe(targetV1);
        expect(await putSource(incremental, incrementalRepo, 'target.ts', targetV2)).toBe(1);
        const afterHash = queryRaw(
            incremental,
            "SELECT hash FROM files WHERE path = 'target.ts'",
        )[0]?.hash;
        expect(afterHash, 'anti-vacuity: the target replacement must really persist new bytes')
            .not.toBe(beforeHash);

        expect(await putSource(clean, cleanRepo, 'caller.ts', caller)).toBe(1);
        expect(await putSource(clean, cleanRepo, 'target.ts', targetV2)).toBe(1);
        const cleanState = canonicalEdgeResolution(clean);
        expect(cleanState[0]?.targetFile, 'clean rebuild proves the edited definition remains resolvable')
            .toBe('target.ts');

        const incrementalState = canonicalEdgeResolution(incremental);
        expect(incrementalState[0]?.targetFile, 'incremental replacement must preserve the incoming target')
            .toBe('target.ts');
        expect(incrementalState).toEqual(cleanState);
    });

    it('enumerates keyset-tied occurrence rows exactly once across one-row pages', () => {
        const conn = freshDb();
        queryRaw(conn, `
            INSERT INTO files (path, hash, last_indexed)
            VALUES ('tied.ts', 'tied-hash', 1)
            RETURNING path
        `);
        const classId = insertId(conn, `
            INSERT INTO symbols (
                name, kind, type, file_path, line, end_line, column,
                capture_tag, body_hash, parent_symbol_id, visibility
            ) VALUES (
                'samePosition', 'def', 'class', 'tied.ts', 7, 9, 3,
                'definition.class', 'class-body', NULL, 'public'
            ) RETURNING id
        `);
        const functionId = insertId(conn, `
            INSERT INTO symbols (
                name, kind, type, file_path, line, end_line, column,
                capture_tag, body_hash, parent_symbol_id, visibility
            ) VALUES (
                'samePosition', 'def', 'function', 'tied.ts', 7, 12, 3,
                'definition.function', 'function-body', NULL, 'public'
            ) RETURNING id
        `);
        expect(classId).not.toBe(functionId);

        const filter = {
            scopePrefix: '',
            role: 'declaration',
            name: { mode: 'exact', value: 'samePosition' },
        };
        const oneShot = queryV4Occurrences(conn, filter, { limit: 10 });
        expect(oneShot.total).toBe(2);
        expect(oneShot.rows).toHaveLength(2);
        expect(new Set(oneShot.rows.map((row) => row.kind))).toEqual(new Set(['class', 'function']));
        expect(new Set(oneShot.rows.map((row) => row.endLine))).toEqual(new Set([9, 12]));

        const first = queryV4Occurrences(conn, filter, { limit: 1 });
        expect(first.rows).toHaveLength(1);
        const firstRow = first.rows[0];
        const second = queryV4Occurrences(conn, filter, {
            limit: 1,
            afterKey: {
                path: firstRow.path,
                line: firstRow.line,
                column: firstRow.column,
                endLine: firstRow.endLine,
                kind: firstRow.kind,
                name: firstRow.name,
            },
        });
        const pagedIds = [...first.rows, ...second.rows]
            .map((row) => row.internalId)
            .sort((a, b) => a - b);
        const oracleIds = oneShot.rows
            .map((row) => row.internalId)
            .sort((a, b) => a - b);

        expect(second.total).toBe(2);
        expect(second.rows, 'the cursor must not skip the legal row tied on its exposed key')
            .toHaveLength(1);
        expect(pagedIds).toEqual(oracleIds);
        expect(new Set(pagedIds).size).toBe(2);
    });

    it('keeps occurrence order insertion-invariant and rejects duplicate canonical fact keys', () => {
        const forward = freshDb();
        const reverse = freshDb();
        const facts = [
            { kind: 'call', endLine: 8, captureTag: 'reference.call' },
            { kind: 'property', endLine: 8, captureTag: 'reference.property' },
        ];
        for (const [conn, orderedFacts] of [
            [forward, facts],
            [reverse, [...facts].reverse()],
        ]) {
            queryRaw(conn, `
                INSERT INTO files (path, hash, last_indexed)
                VALUES ('stable.ts', 'stable-hash', 1)
                RETURNING path
            `);
            for (const fact of orderedFacts) {
                insertId(conn, `
                    INSERT INTO symbols (
                        name, kind, type, file_path, line, end_line, column,
                        capture_tag, body_hash, parent_symbol_id, visibility
                    ) VALUES (
                        'samePosition', 'ref', ?, 'stable.ts', 8, ?, 4,
                        ?, NULL, NULL, NULL
                    ) RETURNING id
                `, fact.kind, fact.endLine, fact.captureTag);
            }
        }

        const storageForward = queryRaw(forward, 'SELECT type FROM symbols ORDER BY id')
            .map((row) => row.type);
        const storageReverse = queryRaw(reverse, 'SELECT type FROM symbols ORDER BY id')
            .map((row) => row.type);
        expect(storageForward).not.toEqual(storageReverse);

        const filter = {
            scopePrefix: '',
            role: 'reference',
            name: { mode: 'exact', value: 'samePosition' },
        };
        const walk = (conn) => {
            const rows = [];
            let afterKey;
            for (let guard = 0; guard < 4; guard++) {
                const page = queryV4Occurrences(
                    conn,
                    filter,
                    afterKey === undefined ? { limit: 1 } : { limit: 1, afterKey },
                );
                rows.push(...page.rows);
                if (page.rows.length === 0) break;
                const row = page.rows[0];
                afterKey = {
                    path: row.path,
                    line: row.line,
                    column: row.column,
                    endLine: row.endLine,
                    kind: row.kind,
                    name: row.name,
                };
            }
            return rows.map((row) => ({
                path: row.path,
                line: row.line,
                column: row.column,
                endLine: row.endLine,
                kind: row.kind,
                name: row.name,
            }));
        };
        expect(walk(forward)).toEqual(walk(reverse));
        expect(walk(forward).map((row) => row.kind)).toEqual(['call', 'property']);

        const corrupt = freshDb();
        queryRaw(corrupt, `
            INSERT INTO files (path, hash, last_indexed)
            VALUES ('duplicate.ts', 'duplicate-hash', 1)
            RETURNING path
        `);
        for (const captureTag of ['reference.call.first', 'reference.call.second']) {
            insertId(corrupt, `
                INSERT INTO symbols (
                    name, kind, type, file_path, line, end_line, column,
                    capture_tag, body_hash, parent_symbol_id, visibility
                ) VALUES (
                    'duplicate', 'ref', 'call', 'duplicate.ts', 3, 3, 2,
                    ?, NULL, NULL, NULL
                ) RETURNING id
            `, captureTag);
        }
        expect(queryRaw(
            corrupt,
            "SELECT COUNT(*) AS count FROM symbols WHERE file_path = 'duplicate.ts'",
        )).toEqual([{ count: 2 }]);
        expect(() => queryV4Occurrences(corrupt, {
            scopePrefix: '',
            role: 'reference',
            name: { mode: 'exact', value: 'duplicate' },
        }, { limit: 10 })).toThrow(/^STORE_CORRUPT: queryV4Occurrences: duplicate canonical occurrence key$/);

        queryRaw(corrupt, `
            DELETE FROM symbols
            WHERE id = (SELECT MAX(id) FROM symbols WHERE file_path = 'duplicate.ts')
            RETURNING id
        `);
        expect(queryV4Occurrences(corrupt, {
            scopePrefix: '',
            role: 'reference',
            name: { mode: 'exact', value: 'duplicate' },
        }, { limit: 10 })).toMatchObject({ total: 1, rows: [expect.objectContaining({ name: 'duplicate' })] });
    });

    it('orders adapter rows by SQLite BINARY UTF-8 bytes for adversarial paths and names', () => {
        const conn = freshDb();
        const paths = ['scope/\uE000.ts', 'scope/\u{10000}.ts'];
        const names = ['\uE000Name', '\u{10000}Name'];

        // Anti-vacuity: JavaScript UTF-16 comparison and UTF-8/BINARY order
        // deliberately disagree for BMP U+E000 versus supplementary U+10000.
        const utf8PathOrder = [...paths].sort(compareUtf8);
        const utf16PathOrder = [...paths].sort();
        expect(utf16PathOrder).not.toEqual(utf8PathOrder);
        expect(compareUtf8(names[0], names[1])).toBeLessThan(0);

        const ids = [];
        for (let index = 0; index < paths.length; index += 1) {
            const filePath = paths[index];
            const name = names[index];
            queryRaw(conn, `
                INSERT INTO files (path, hash, last_indexed)
                VALUES (?, ?, 1) RETURNING path
            `, filePath, `hash-${index}`);
            const id = insertId(conn, `
                INSERT INTO symbols (
                    name, kind, type, file_path, line, end_line, column,
                    capture_tag, body_hash, parent_symbol_id, visibility
                ) VALUES (?, 'def', 'function', ?, 1, 1, 0,
                          'definition.function', ?, NULL, 'public')
                RETURNING id
            `, name, filePath, `body-${index}`);
            queryRaw(conn, `
                INSERT INTO symbol_structures (
                    symbol_id, params_json, return_text, decorators_json,
                    modifiers_json, generics_text, parent_kind, parent_name
                ) VALUES (?, '[]', 'void', '[]', '[]', NULL, NULL, NULL)
                RETURNING symbol_id
            `, id);
            ids.push(id);
        }

        const rawBinaryOrder = queryRaw(conn, `
            SELECT s.file_path AS filePath, s.name
            FROM symbol_structures ss
            JOIN symbols s ON s.id = ss.symbol_id
            ORDER BY s.file_path, s.name
        `);
        const independentOracle = paths
            .map((filePath, index) => ({ filePath, name: names[index] }))
            .sort((left, right) => compareUtf8(left.filePath, right.filePath)
                || compareUtf8(left.name, right.name));
        expect(rawBinaryOrder).toEqual(independentOracle);

        const adapterOrder = readV4StructuresByInternalIds(conn, ids)
            .map((row) => ({ filePath: row.filePath, name: row.name }));
        expect(adapterOrder).toEqual(independentOracle);
    });

    it('does not advance the fact commit generation for a rolled-back inner savepoint', () => {
        const conn = freshDb();

        const beforeReadOnly = getFactEpoch(conn);
        runTransaction(conn, () => {
            expect(queryRaw(conn, 'SELECT COUNT(*) AS n FROM patterns')[0]?.n).toBe(0);
        });
        expect(getFactEpoch(conn), 'anti-vacuity: an actually read-only outer transaction is inert')
            .toEqual(beforeReadOnly);

        runTransaction(conn, () => {
            queryRaw(conn, `
                INSERT INTO patterns (name, edit_body, symbol_kind, created_at)
                VALUES ('committed-control', 'body', 'function', 1)
            `);
        });
        const afterCommittedControl = getFactEpoch(conn);
        expect(afterCommittedControl.commitGeneration)
            .toBe(beforeReadOnly.commitGeneration + 1);

        const beforeRolledBackSavepoint = getFactEpoch(conn);
        runTransaction(conn, () => {
            try {
                runTransaction(conn, () => {
                    queryRaw(conn, `
                        INSERT INTO patterns (name, edit_body, symbol_kind, created_at)
                        VALUES ('rolled-back-inner', 'body', 'function', 2)
                    `);
                    throw new Error('abort-inner-savepoint');
                });
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect(error.message).toBe('abort-inner-savepoint');
            }
            expect(queryRaw(conn, 'SELECT COUNT(*) AS n FROM patterns')[0]?.n).toBe(1);
        });

        expect(
            queryRaw(conn, "SELECT name FROM patterns WHERE name = 'rolled-back-inner'"),
            'the attempted inner write must not be committed',
        ).toEqual([]);
        expect(
            getFactEpoch(conn),
            'a rolled-back savepoint is not a fact-changing outer commit',
        ).toEqual(beforeRolledBackSavepoint);
    });
});
