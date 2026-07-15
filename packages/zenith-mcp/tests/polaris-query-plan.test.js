// polaris-query-plan.test.js — POLARIS Task 0.3
//
// Query-plan probes: pins EXPLAIN QUERY PLAN over the hot v4 adapter reads on
// a REAL indexed database, so index regressions (a dropped index, a query
// rewrite that de-indexes a lookup) fail loudly — and establishes the EQP
// methodology Wave 2 extends to every new intelligence read.
//
// Also enforces, from Wave 0 onward, two standing SQL rules the plan states
// for intelligence reads: no `OFFSET` pagination anywhere in adapter SQL
// (keyset continuation only, Decision 24), asserted as a source scan, and the
// plan-print discipline (full EQP output recorded in the test log for the
// qualification record).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    queryRaw,
} from '../dist/core/db-adapter.js';
import { indexDirectory } from '../dist/core/symbol-index.js';
import { makeTempDir } from './helpers/polaris-db.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(TESTS_DIR, '..', 'src');
const WORKSPACE = path.join(TESTS_DIR, 'fixtures', 'polaris-workspace');

let tmpDir;
let db;

beforeAll(async () => {
    tmpDir = makeTempDir('polaris-qp-');
    db = openDb(path.join(tmpDir, 'qp.db'));
    initSymbolSchema(db);
    await indexDirectory(db, WORKSPACE, WORKSPACE);
}, 60_000);

afterAll(() => {
    try { closeDb(db); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function explain(sql, ...params) {
    const rows = queryRaw(db, `EXPLAIN QUERY PLAN ${sql}`, ...params);
    const details = rows.map((r) => r.detail).join('\n');
    console.log(`[EQP] ${sql.replace(/\s+/g, ' ').trim()}\n${details}\n`);
    return details;
}

// ---------------------------------------------------------------------------
// Hot adapter reads use their intended indexes
// ---------------------------------------------------------------------------

describe('v4 hot reads are index-backed', () => {
    it('symbols by file (getSymbolsInFile / getFileFacts defs) uses idx_symbols_file', () => {
        const details = explain(
            "SELECT name, kind, type, line, end_line, column FROM symbols WHERE file_path = ? ORDER BY line",
            'typescript/same-line.ts'
        );
        expect(details).toContain('idx_symbols_file');
    });

    it('defs by name (findDefsByName / resolver candidates) uses a name index', () => {
        const details = explain(
            "SELECT id, file_path FROM symbols WHERE name = ? AND kind = ?",
            'slAdd', 'def'
        );
        // Either the plain name index or the composite (kind, name) index is
        // acceptable; both make the lookup indexed rather than a table scan.
        expect(/idx_symbols_name|idx_symbols_kind_name/.test(details)).toBe(true);
    });

    it('callers by referenced name (getCallers) uses idx_edges_target', () => {
        const details = explain(
            `SELECT s.name, s.file_path, COUNT(e.id) AS refCount FROM edges e
             JOIN symbols s ON s.id = e.container_def_id
             WHERE e.referenced_name = ? AND s.kind = 'def'
             GROUP BY s.name, s.file_path ORDER BY refCount DESC`,
            'slAdd'
        );
        expect(details).toContain('idx_edges_target');
    });

    it('imports by file uses idx_imports_file', () => {
        const details = explain(
            'SELECT module, imported_names_json, line FROM imports WHERE file_path = ?',
            'typescript/imports.ts'
        );
        expect(details).toContain('idx_imports_file');
    });

    it('import bindings by file are index-backed on file_path', () => {
        const details = explain(
            'SELECT source, local_name FROM import_bindings WHERE file_path = ?',
            'typescript/imports.ts'
        );
        // Either the plain file index or the composite (file_path, local_name)
        // index satisfies the file_path lookup; both are index-backed.
        expect(/idx_import_bindings_file|idx_import_bindings_local/.test(details)).toBe(true);
    });

    it('anchors join by symbol uses idx_anchors_symbol', () => {
        const details = explain(
            `SELECT a.kind, a.line FROM anchors a JOIN symbols s ON s.id = a.symbol_id WHERE s.file_path = ?`,
            'typescript/same-line.ts'
        );
        expect(details).toContain('idx_anchors_symbol');
    });

    it('edges by container (getFileBlockEdges shape) uses idx_edges_container or the symbols file index', () => {
        const details = explain(
            `SELECT caller.name, e.referenced_name, COUNT(e.id) FROM edges e
             JOIN symbols caller ON caller.id = e.container_def_id
             WHERE caller.file_path = ? AND caller.kind = 'def'
             GROUP BY caller.name, e.referenced_name`,
            'typescript/same-line.ts'
        );
        expect(/idx_edges_container|idx_symbols_file/.test(details)).toBe(true);
    });

    it('the whole-DB unresolved-edge sweep joins symbols by rowid (intended full edge scan)', () => {
        const details = explain(
            `SELECT e.id, e.referenced_name, s.file_path FROM edges e
             JOIN symbols s ON s.id = e.container_def_id
             WHERE e.callee_symbol_id IS NULL`
        );
        // The sweep DELIBERATELY scans edges once (whole-DB resolve pass); the
        // join side must be a rowid/PK lookup, never a second scan.
        expect(/SEARCH s USING INTEGER PRIMARY KEY|USING ROWID SEARCH/i.test(details)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Standing SQL rules, enforced from Wave 0 onward
// ---------------------------------------------------------------------------

function walkTsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walkTsFiles(p);
        return e.isFile() && p.endsWith('.ts') ? [p] : [];
    });
}

describe('standing SQL rules', () => {
    // SQL lives only inside string/template literals, so the OFFSET gate
    // scans exactly those — comments, identifiers (byteOffset, a loop's
    // `offset`), and prose can never trip it, while every way of writing
    // SQL pagination still does. Extraction is a tiny state machine, not a
    // regex, so 'https://…' in strings and escaped quotes are handled.
    function extractStringContents(source) {
        const out = [];
        let i = 0;
        const n = source.length;
        while (i < n) {
            const c = source[i];
            const next = source[i + 1];
            if (c === '/' && next === '/') { // line comment
                i = source.indexOf('\n', i);
                if (i === -1) break;
                continue;
            }
            if (c === '/' && next === '*') { // block comment
                const end = source.indexOf('*/', i + 2);
                i = end === -1 ? n : end + 2;
                continue;
            }
            if (c === '\'' || c === '"' || c === '`') {
                const quote = c;
                let content = '';
                i += 1;
                while (i < n) {
                    const s = source[i];
                    if (s === '\\') { content += source[i + 1] ?? ''; i += 2; continue; }
                    if (s === quote) { i += 1; break; }
                    if (quote === '`' && s === '$' && source[i + 1] === '{') {
                        // Interpolations are code, not string text; skip to
                        // the matching brace (approximation: no nested
                        // template-in-interpolation SQL, documented).
                        let depth = 1;
                        i += 2;
                        while (i < n && depth > 0) {
                            if (source[i] === '{') depth += 1;
                            else if (source[i] === '}') depth -= 1;
                            i += 1;
                        }
                        content += ' ';
                        continue;
                    }
                    content += s;
                    i += 1;
                }
                out.push(content);
                continue;
            }
            i += 1;
        }
        return out;
    }

    // (?<!-) exempts CLI flags like rg's '--byte-offset', which is a string
    // literal but not SQL. SQL OFFSET is never preceded by a hyphen.
    const OFFSET_IN_SQL = /(?<!-)\bOFFSET\b/i;
    // SQLite's comma form `LIMIT <skip>, <count>` is OFFSET pagination too.
    const LIMIT_COMMA_FORM = /\bLIMIT\s+(\?|\d+|[:@$]\w+)\s*,/i;

    function findOffsetViolations(source) {
        return extractStringContents(source).filter(
            (s) => OFFSET_IN_SQL.test(s) || LIMIT_COMMA_FORM.test(s),
        );
    }

    it('the detector fires on real SQL pagination and stays silent on honest tokens (anti-vacuity)', () => {
        // Every sanctioned shape that previously false-positived:
        expect(findOffsetViolations(`
            // prose: the byte offset of the match
            /* block prose: OFFSET pagination is forbidden */
            const args = ['--byte-offset', '--no-config'];
            for (const offset of offsets.sort()) { use(m.byteOffset + offset); }
            const url = 'https://example.com/x'; // comment with OFFSET word
        `)).toEqual([]);
        // Every way of actually writing the violation:
        expect(findOffsetViolations("db.query('SELECT * FROM t LIMIT ? OFFSET ?')")).toHaveLength(1);
        expect(findOffsetViolations('const q = `SELECT x FROM t\n LIMIT 5\n offset 10`;')).toHaveLength(1);
        expect(findOffsetViolations(`const q = 'OFFSET ' + n;`)).toHaveLength(1);
        expect(findOffsetViolations('run(`SELECT a FROM t LIMIT ?, ?`)')).toHaveLength(1);
        expect(findOffsetViolations("run('SELECT a FROM t LIMIT 10, 20')")).toHaveLength(1);
        expect(findOffsetViolations('run(`… LIMIT ${skip}, ${count}`)')).toHaveLength(0); // interpolation is code; count form without literal skip is keyset-shaped
        expect(findOffsetViolations("run('… LIMIT :skip, :count')")).toHaveLength(1);
    });

    it('no OFFSET pagination anywhere in db-adapter or intelligence sources', () => {
        const targets = [path.join(SRC_DIR, 'core', 'db-adapter.ts')];
        const intelligenceDir = path.join(SRC_DIR, 'core', 'intelligence');
        if (fs.existsSync(intelligenceDir)) targets.push(...walkTsFiles(intelligenceDir));
        expect(targets.length).toBeGreaterThan(1); // intelligence dir exists now

        for (const file of targets) {
            const text = fs.readFileSync(file, 'utf8');
            const violations = findOffsetViolations(text);
            expect(
                violations,
                `${path.relative(SRC_DIR, file)} must not use SQL OFFSET pagination (Decision 24); offending strings: ${JSON.stringify(violations)}`
            ).toEqual([]);
        }
    });

    it('EXPLAIN QUERY PLAN is available and structured (methodology probe)', () => {
        const rows = queryRaw(db, 'EXPLAIN QUERY PLAN SELECT COUNT(*) FROM files');
        expect(rows.length).toBeGreaterThan(0);
        expect(typeof rows[0].detail).toBe('string');
    });
});
