// polaris-audit-occurrences-differential.test.js — INDEPENDENT CORRECTNESS AUDIT
//
// Auditor-authored. Target: the built v4 read `queryV4Occurrences`, the read
// that the (still-stubbed) queryOccurrences composer will wrap.
//
// Oracles:
//   * DIFFERENTIAL — a hand-written JS filter over the raw `symbols` rows,
//     implementing the read's DOCUMENTED parameter semantics (role, scopePrefix
//     as a path prefix, exact/prefix name, kinds), sorted by UTF-8 byte order
//     via Buffer.compare (the charter's sanctioned independent reference for
//     SQLite BINARY collation — "never JS <"). This is the "adapter read vs
//     hand-written raw SQL over the same rows" oracle the charter names. It
//     validates the READ LAYER (filter/order/total/pagination), not the indexer.
//   * METAMORPHIC — concatenating keyset pages equals the one-shot result
//     (Decision 24, line 270). The shipped suite only paginates declarations;
//     this exercises references (many rows, shared names).
//   * INDEPENDENT REFERENCE — UTF-8 byte collation on Unicode names, shown to
//     differ from a JS `<` sort for the chosen inputs (anti-vacuity built in).
//
// FINDING (LATENT, surfaced): the keyset `(path,line,column,name)` has no unique
// tiebreaker. Decision 26 (line 272) gives occurrences/positions the canonical
// order `(startByte,endByte,kind,name)` and candidates append handle.stableKey;
// the v4 keyset omits any such final discriminator. Two schema-permitted rows
// sharing (path,line,column,name) but differing in `type` are distinct facts,
// yet keyset pagination SKIPS the second (Decision 24 requires "each canonical
// fact exactly once"). Natural extraction currently yields distinct columns, so
// this is latent — but the schema permits it and the composer that will publish
// this read is not yet built. Framed for the owner; not self-ruled.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    execRaw,
    queryRaw,
    queryV4Occurrences,
} from '../dist/core/db-adapter.js';
import { indexDirectory } from '../dist/core/symbol-index.js';

const SOURCES = {
    'src/main.ts': `import { helper } from './lib.js';
export function alpha(value: number): number {
    helper();
    return beta(value) + beta(value + 1);
}
export function beta(value: number): number {
    return value + helper();
}
export class Holder {
    run(value: number): number {
        return alpha(value);
    }
}
`,
    'src/lib.ts': `export function helper(): number {
    return 7;
}
export const CONST_ONE = 1;
`,
    'pkg/util.ts': `export function alpha(): void {}
export function zeta(): void {
    alpha();
}
`,
};

let tempDir;
let db;
let rawSymbols;

// --- Independent oracle machinery -------------------------------------------

function cmpBytes(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// SQLite ORDER BY path, line, column, name under BINARY collation: text columns
// compare by UTF-8 bytes, integer columns numerically.
function cmpRow(x, y) {
    return cmpBytes(x.path, y.path)
        || (x.line - y.line)
        || (x.column - y.column)
        || cmpBytes(x.name, y.name);
}

function projectApi(row) {
    return {
        path: row.path, line: row.line, column: row.column, name: row.name,
        role: row.role, kind: row.kind, endLine: row.endLine,
    };
}

// The DOCUMENTED semantics, implemented independently of the SQL:
//   role: declaration↔raw.kind==='def', reference↔raw.kind==='ref'
//   scopePrefix: raw.file_path starts with the prefix (a path/directory prefix)
//   name exact/prefix; kinds: raw.type ∈ kinds
function oracle(filter) {
    if (filter.kinds && filter.kinds.length === 0) return { rows: [], total: 0 };
    const roleKind = filter.role === 'declaration' ? 'def' : 'ref';
    const matched = rawSymbols.filter((r) => {
        if (r.kind !== roleKind) return false;
        if (filter.scopePrefix && !r.file_path.startsWith(filter.scopePrefix)) return false;
        if (filter.name?.mode === 'exact' && r.name !== filter.name.value) return false;
        if (filter.name?.mode === 'prefix' && filter.name.value !== ''
            && !r.name.startsWith(filter.name.value)) return false;
        if (filter.kinds && !filter.kinds.includes(r.type)) return false;
        return true;
    }).map((r) => ({
        path: r.file_path, line: r.line, column: r.column, name: r.name,
        role: r.kind === 'def' ? 'declaration' : 'reference',
        kind: r.type, endLine: r.end_line,
    }));
    matched.sort(cmpRow);
    return { rows: matched, total: matched.length };
}

beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-audit-occ-'));
    const repoRoot = path.join(tempDir, 'repo');
    for (const [rel, src] of Object.entries(SOURCES)) {
        const abs = path.join(repoRoot, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, src);
    }
    db = openDb(path.join(tempDir, 'facts.db'));
    initSymbolSchema(db);
    await indexDirectory(db, repoRoot, repoRoot);
    rawSymbols = queryRaw(db,
        'SELECT id, name, kind, type, file_path, line, end_line, column FROM symbols');
}, 60_000);

afterAll(() => {
    try { closeDb(db); } catch { /* ignore */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('queryV4Occurrences — differential vs an independent raw-row filter', () => {
    // Build the filter matrix from values actually present, so the oracle is
    // exercised on real inputs.
    function filterMatrix() {
        const kinds = [...new Set(rawSymbols.map((r) => r.type).filter((t) => t !== null))];
        const combos = [];
        for (const role of ['declaration', 'reference']) {
            for (const scopePrefix of ['', 'src/', 'pkg/']) {
                combos.push({ role, scopePrefix });
                combos.push({ role, scopePrefix, name: { mode: 'exact', value: 'alpha' } });
                combos.push({ role, scopePrefix, name: { mode: 'exact', value: 'helper' } });
                combos.push({ role, scopePrefix, name: { mode: 'prefix', value: 'a' } });
                combos.push({ role, scopePrefix, name: { mode: 'prefix', value: 'bet' } });
                if (kinds.length > 0) combos.push({ role, scopePrefix, kinds: [kinds[0]] });
            }
        }
        return combos;
    }

    it('every filter combination matches the independent oracle (rows + total)', () => {
        const combos = filterMatrix();
        expect(combos.length).toBeGreaterThan(10);
        for (const filter of combos) {
            const api = queryV4Occurrences(db, filter, { limit: 100000 });
            const ref = oracle(filter);
            const label = JSON.stringify(filter);
            expect(api.total, `total ${label}`).toBe(ref.total);
            expect(api.rows.map(projectApi), `rows ${label}`).toEqual(ref.rows);
            // Keys must be distinct so the canonical order is fully determined
            // (guards the ordered comparison against tie-induced flakiness).
            const keys = api.rows.map((r) => `${r.path}\u0000${r.line}\u0000${r.column}\u0000${r.name}`);
            expect(new Set(keys).size, `distinct keys ${label}`).toBe(keys.length);
        }
    });

    it('anti-vacuity: the oracle disagrees with a deliberately wrong filter', () => {
        // Swapping the role must make the oracle and API diverge — proving the
        // comparison is not trivially satisfied.
        const good = oracle({ role: 'declaration', scopePrefix: '' });
        const wrong = oracle({ role: 'reference', scopePrefix: '' });
        expect(good.rows).not.toEqual(wrong.rows);
        const api = queryV4Occurrences(db, { role: 'declaration', scopePrefix: '' }, { limit: 100000 });
        expect(api.rows.map(projectApi)).toEqual(good.rows);
        expect(api.rows.map(projectApi)).not.toEqual(wrong.rows);
    });
});

describe('queryV4Occurrences — keyset pagination completeness (references)', () => {
    // METAMORPHIC: concat of keyset pages == one-shot, for REFERENCES (shared
    // names, many rows). The shipped suite only does this for declarations.
    for (const limit of [1, 2, 3]) {
        it(`reference pages at limit=${limit} concatenate to the one-shot result`, () => {
            const oneShot = queryV4Occurrences(db, { role: 'reference', scopePrefix: '' }, { limit: 100000 });
            expect(oneShot.rows.length).toBeGreaterThan(3);

            const collected = [];
            let afterKey;
            for (let guard = 0; guard < 1000; guard++) {
                const req = afterKey === undefined ? { limit } : { afterKey, limit };
                const page = queryV4Occurrences(db, { role: 'reference', scopePrefix: '' }, req);
                expect(page.total).toBe(oneShot.total);
                collected.push(...page.rows);
                if (page.rows.length < limit) break;
                const last = page.rows[page.rows.length - 1];
                afterKey = { path: last.path, line: last.line, column: last.column, name: last.name };
            }
            expect(collected.map(projectApi)).toEqual(oneShot.rows.map(projectApi));
        });
    }
});

describe('queryV4Occurrences — Unicode name collation is UTF-8 bytes, not JS order', () => {
    // Synthetic rows (schema permits any TEXT name) with well-formed code points
    // chosen so UTF-8 byte order and UTF-16 (JS `<`) order DISAGREE:
    //   U+FFFF sorts BEFORE astral chars in UTF-8, but AFTER them in UTF-16.
    const NAMES = ['A', 'Z', 'a', 'é', '\uFFFF', '\u{10000}', '\u{1F600}'];

    function withSyntheticRows(fn) {
        execRaw(db, 'SAVEPOINT polaris_audit_uni');
        try {
            queryRaw(db, "INSERT INTO files (path, hash, last_indexed) VALUES ('zsynth/u.ts', 'h', 1) RETURNING path");
            for (const name of NAMES) {
                queryRaw(db,
                    `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                     VALUES (?, 'ref', 'call', 'zsynth/u.ts', 1, 1, 0) RETURNING id`,
                    name);
            }
            return fn();
        } finally {
            execRaw(db, 'ROLLBACK TO polaris_audit_uni');
            execRaw(db, 'RELEASE polaris_audit_uni');
        }
    }

    it('orders Unicode names by UTF-8 bytes (independent Buffer.compare reference)', () => {
        withSyntheticRows(() => {
            const api = queryV4Occurrences(db, { role: 'reference', scopePrefix: 'zsynth/' }, { limit: 100 });
            const got = api.rows.map((r) => r.name);

            const utf8Order = [...NAMES].sort(cmpBytes);
            const jsOrder = [...NAMES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

            // Anti-vacuity: the two orders genuinely differ for this input, so
            // matching UTF-8 order is a real claim, not a tautology.
            expect(utf8Order).not.toEqual(jsOrder);

            expect(got).toEqual(utf8Order);
            expect(got).not.toEqual(jsOrder);
        });
    });

    it('exact and prefix name filters are Unicode-correct', () => {
        withSyntheticRows(() => {
            const exact = queryV4Occurrences(db,
                { role: 'reference', scopePrefix: 'zsynth/', name: { mode: 'exact', value: 'é' } },
                { limit: 100 });
            expect(exact.rows.map((r) => r.name)).toEqual(['é']);
            expect(exact.total).toBe(1);

            // Astral prefix: add two names sharing an astral first code point.
            queryRaw(db,
                `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                 VALUES ('\u{1F600}x', 'ref', 'call', 'zsynth/u.ts', 2, 2, 0) RETURNING id`);
            queryRaw(db,
                `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                 VALUES ('\u{1F600}y', 'ref', 'call', 'zsynth/u.ts', 3, 3, 0) RETURNING id`);
            const pref = queryV4Occurrences(db,
                { role: 'reference', scopePrefix: 'zsynth/', name: { mode: 'prefix', value: '\u{1F600}' } },
                { limit: 100 });
            // Oracle: names that start with 😀 are 😀 itself, 😀x, 😀y.
            const expected = ['\u{1F600}', '\u{1F600}x', '\u{1F600}y'].sort(cmpBytes);
            expect(pref.rows.map((r) => r.name).sort(cmpBytes)).toEqual(expected);
        });
    });
});

describe('queryV4Occurrences — LATENT: non-unique keyset skips a distinct fact', () => {
    // Two schema-permitted rows sharing (path,line,column,name) but differing in
    // `type` are distinct occurrences. one-shot sees both (total=2); keyset
    // pagination at limit=1 cannot advance past the shared key and drops the
    // second — violating Decision 24 "each canonical fact exactly once".
    it('metamorphic concat != one-shot when two facts share the page key', () => {
        execRaw(db, 'SAVEPOINT polaris_audit_dup');
        try {
            queryRaw(db, "INSERT INTO files (path, hash, last_indexed) VALUES ('zdup/d.ts', 'h', 1) RETURNING path");
            queryRaw(db,
                `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                 VALUES ('dupName', 'ref', 'call', 'zdup/d.ts', 1, 1, 5) RETURNING id`);
            queryRaw(db,
                `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                 VALUES ('dupName', 'ref', 'property', 'zdup/d.ts', 1, 1, 5) RETURNING id`);

            const filter = { role: 'reference', scopePrefix: '', name: { mode: 'exact', value: 'dupName' } };
            const oneShot = queryV4Occurrences(db, filter, { limit: 100 });
            expect(oneShot.total, 'store holds two distinct dupName facts').toBe(2);
            expect(oneShot.rows).toHaveLength(2);

            // Walk keyset pages exactly as a paginating consumer must.
            const collected = [];
            let afterKey;
            for (let guard = 0; guard < 10; guard++) {
                const req = afterKey === undefined ? { limit: 1 } : { afterKey, limit: 1 };
                const page = queryV4Occurrences(db, filter, req);
                collected.push(...page.rows);
                if (page.rows.length < 1) break;
                const last = page.rows[page.rows.length - 1];
                afterKey = { path: last.path, line: last.line, column: last.column, name: last.name };
            }

            // Decision 24: following cursors to exhaustion yields each fact once.
            // Today the second fact is skipped, so this is RED.
            expect(collected).toHaveLength(oneShot.total);
            expect(new Set(collected.map((r) => r.kind))).toEqual(new Set(['call', 'property']));
        } finally {
            execRaw(db, 'ROLLBACK TO polaris_audit_dup');
            execRaw(db, 'RELEASE polaris_audit_dup');
        }
    });

    it('anti-vacuity: with distinct columns the same walk is complete (control)', () => {
        // Identical setup but distinct columns → distinct keys → keyset walk is
        // complete. Proves the failure above is caused by key collision, not by
        // the walk logic in this test.
        execRaw(db, 'SAVEPOINT polaris_audit_dup2');
        try {
            queryRaw(db, "INSERT INTO files (path, hash, last_indexed) VALUES ('zdup2/d.ts', 'h', 1) RETURNING path");
            queryRaw(db,
                `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                 VALUES ('dupName', 'ref', 'call', 'zdup2/d.ts', 1, 1, 5) RETURNING id`);
            queryRaw(db,
                `INSERT INTO symbols (name, kind, type, file_path, line, end_line, column)
                 VALUES ('dupName', 'ref', 'property', 'zdup2/d.ts', 1, 1, 9) RETURNING id`);
            const filter = { role: 'reference', scopePrefix: '', name: { mode: 'exact', value: 'dupName' } };
            const oneShot = queryV4Occurrences(db, filter, { limit: 100 });
            expect(oneShot.total).toBe(2);

            const collected = [];
            let afterKey;
            for (let guard = 0; guard < 10; guard++) {
                const req = afterKey === undefined ? { limit: 1 } : { afterKey, limit: 1 };
                const page = queryV4Occurrences(db, filter, req);
                collected.push(...page.rows);
                if (page.rows.length < 1) break;
                const last = page.rows[page.rows.length - 1];
                afterKey = { path: last.path, line: last.line, column: last.column, name: last.name };
            }
            expect(collected).toHaveLength(2);
        } finally {
            execRaw(db, 'ROLLBACK TO polaris_audit_dup2');
            execRaw(db, 'RELEASE polaris_audit_dup2');
        }
    });
});
