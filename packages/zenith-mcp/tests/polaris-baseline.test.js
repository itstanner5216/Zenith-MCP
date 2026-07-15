// polaris-baseline.test.js — POLARIS Task 0.1
//
// Executable v4 ground: proves the CURRENT pipeline over the adversarial
// fixture workspace matches the verified corpus in
// fixtures/polaris-expected.json (section `currentV4`), and that the schema
// carries exactly the v4 facts the plan's ground claims name
// (edges.reference_kind, anchors.end_line, symbols.parent_symbol_id,
// import_bindings).
//
// Assertion semantics — deliberate and forward-compatible through Wave 1:
//   - files, defs, imports, bindings: EXACT equality (stable across the
//     Wave 1 repairs).
//   - refs, edges: SUPERSET — every recorded row must exist with its exact
//     recorded fields (including the heuristic resolution outcome), but new
//     rows may appear, because Task 1.2's same-line dedup repair ADDS
//     reference rows that the current extractor drops (defect G5, pinned as
//     it.fails in polaris-current-failures.test.js). Losing or altering a
//     recorded row is a failure; gaining rows is not.
//
// The corpus records callee links under edges[].resolved as they exist today:
// the v4 COMPATIBILITY HEURISTIC (name uniqueness). Recording them is not an
// endorsement — AstIntelligence never treats them as proof (Locked Decision 1)
// — but the baseline must pin them so drift in the heuristic is loud.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    getSchemaVersion,
    queryRaw,
} from '../dist/core/db-adapter.js';
import { indexDirectory } from '../dist/core/symbol-index.js';
import { makeTempDir, columnNames, tableExists } from './helpers/polaris-db.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(TESTS_DIR, 'fixtures', 'polaris-workspace');
const EXPECTED = JSON.parse(
    fs.readFileSync(path.join(TESTS_DIR, 'fixtures', 'polaris-expected.json'), 'utf8')
);

let tmpDir;
let db;

beforeAll(async () => {
    tmpDir = makeTempDir('polaris-baseline-');
    db = openDb(path.join(tmpDir, 'baseline.db'));
    initSymbolSchema(db);
    await indexDirectory(db, WORKSPACE, WORKSPACE);
}, 60_000);

afterAll(() => {
    try { closeDb(db); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Schema ground — asserted before anything interprets indexed rows
// ---------------------------------------------------------------------------

describe('schema v4 ground', () => {
    it('initSymbolSchema lands on schema version 4', () => {
        expect(getSchemaVersion(db)).toBe(4);
    });

    it('edges carry reference_kind', () => {
        expect(columnNames(db, 'edges')).toContain('reference_kind');
    });

    it('anchors carry end_line', () => {
        expect(columnNames(db, 'anchors')).toContain('end_line');
    });

    it('symbols carry parent_symbol_id', () => {
        expect(columnNames(db, 'symbols')).toContain('parent_symbol_id');
    });

    it('import_bindings exists with the v2 shape', () => {
        expect(tableExists(db, 'import_bindings')).toBe(true);
        const cols = columnNames(db, 'import_bindings');
        for (const c of ['file_path', 'source', 'local_name', 'imported_name', 'import_kind', 'is_type_only', 'line', 'column']) {
            expect(cols).toContain(c);
        }
    });
});

// ---------------------------------------------------------------------------
// Corpus integrity — the truth file obeys its own conventions
// ---------------------------------------------------------------------------

describe('corpus conventions', () => {
    it('the corpus contains no absolute paths and no SQLite row IDs', () => {
        const raw = JSON.stringify(EXPECTED);
        expect(raw.includes('"/home/')).toBe(false);
        expect(raw.includes('"C:\\\\')).toBe(false);
        expect(/"(rowId|symbol_id|sqliteId)"/.test(raw)).toBe(false);
        for (const f of EXPECTED.currentV4.files) {
            expect(path.isAbsolute(f)).toBe(false);
            expect(f.includes('\\')).toBe(false);
        }
    });

    it('every corpus file exists in the fixture workspace and vice versa', () => {
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
        );
        const onDisk = walk(WORKSPACE)
            .map((p) => path.relative(WORKSPACE, p).split(path.sep).join('/'))
            .sort();
        expect(onDisk).toEqual([...EXPECTED.currentV4.files].sort());
    });

    it('all fixture paths resolve inside the tests root (no symlink escapes)', () => {
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
        );
        const testsRoot = fs.realpathSync(TESTS_DIR);
        for (const p of walk(WORKSPACE)) {
            expect(fs.realpathSync(p).startsWith(testsRoot + path.sep)).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// Indexed ground equals the verified corpus
// ---------------------------------------------------------------------------

function dumpFile(relPath) {
    return {
        defs: queryRaw(db, `SELECT s.name, s.type, s.line, s.end_line AS endLine, s."column" AS col, s.visibility, p.name AS parentName, p.line AS parentLine
            FROM symbols s LEFT JOIN symbols p ON p.id = s.parent_symbol_id
            WHERE s.file_path = ? AND s.kind = 'def' ORDER BY s.line, s."column", s.name`, relPath),
        refs: queryRaw(db, `SELECT name, type, line, "column" AS col FROM symbols WHERE file_path = ? AND kind = 'ref'`, relPath),
        edges: queryRaw(db, `SELECT caller.name AS caller, caller.line AS callerLine, e.referenced_name AS name, e.reference_kind AS kind,
                callee.file_path AS calleePath, callee.line AS calleeLine, e.callee_symbol_id AS calleeId
            FROM edges e JOIN symbols caller ON caller.id = e.container_def_id
            LEFT JOIN symbols callee ON callee.id = e.callee_symbol_id
            WHERE caller.file_path = ?`, relPath),
        imports: queryRaw(db, `SELECT module, imported_names_json AS names, line, start_line AS startLine, end_line AS endLine
            FROM imports WHERE file_path = ? ORDER BY line`, relPath),
        bindings: queryRaw(db, `SELECT source, local_name AS localName, imported_name AS importedName, import_kind AS kind,
                is_type_only AS typeOnly, line, "column" AS col
            FROM import_bindings WHERE file_path = ? ORDER BY line, "column"`, relPath),
    };
}

describe('indexed facts match the verified corpus', () => {
    it('exactly the corpus file set is indexed', () => {
        const indexed = queryRaw(db, 'SELECT path FROM files ORDER BY path').map((r) => r.path);
        expect(indexed).toEqual([...EXPECTED.currentV4.files].sort());
    });

    for (const [relPath, expected] of Object.entries(EXPECTED.currentV4.perFile)) {
        describe(relPath, () => {
            it('definitions match exactly (names, kinds, spans, columns, parents, visibility)', () => {
                const actual = dumpFile(relPath).defs.map((d) => ({
                    name: d.name, type: d.type, line: d.line, endLine: d.endLine, column: d.col,
                    ...(d.parentName ? { parent: { name: d.parentName, line: d.parentLine } } : {}),
                    ...(d.visibility ? { visibility: d.visibility } : {}),
                }));
                expect(actual).toEqual(expected.defs);
            });

            it('every recorded reference row exists (superset: Wave 1 may add same-line rows)', () => {
                const actual = dumpFile(relPath).refs;
                for (const ref of expected.refs) {
                    const found = actual.some((r) =>
                        r.name === ref.name && r.type === ref.type && r.line === ref.line && r.col === ref.column);
                    expect(found, `missing recorded ref ${ref.name}:${ref.type}@${ref.line}:${ref.column}`).toBe(true);
                }
            });

            it('every recorded edge exists with its recorded resolution outcome', () => {
                const actual = dumpFile(relPath).edges;
                for (const edge of expected.edges) {
                    const matches = actual.filter((e) => e.caller === edge.caller && e.name === edge.name && e.kind === edge.kind);
                    expect(matches.length, `missing recorded edge ${edge.caller} -> ${edge.name} (${edge.kind})`).toBeGreaterThan(0);
                    if (edge.resolved === null) {
                        expect(
                            matches.every((m) => m.calleeId === null),
                            `edge ${edge.caller} -> ${edge.name} must stay unresolved under the v4 heuristic`
                        ).toBe(true);
                    } else {
                        expect(
                            matches.some((m) => m.calleePath === edge.resolved.path && m.calleeLine === edge.resolved.line),
                            `edge ${edge.caller} -> ${edge.name} must keep its recorded heuristic target ${edge.resolved.path}:${edge.resolved.line}`
                        ).toBe(true);
                    }
                }
            });

            it('statement imports match exactly', () => {
                const actual = dumpFile(relPath).imports.map((i) => ({
                    module: i.module, names: JSON.parse(i.names), line: i.line, startLine: i.startLine, endLine: i.endLine,
                }));
                expect(actual).toEqual(expected.imports);
            });

            it('import bindings match exactly', () => {
                const actual = dumpFile(relPath).bindings.map((b) => ({
                    source: b.source, localName: b.localName, importedName: b.importedName,
                    kind: b.kind, typeOnly: !!b.typeOnly, line: b.line, column: b.col,
                }));
                expect(actual).toEqual(expected.bindings);
            });
        });
    }
});
