// review-parent-linkage.test.js
//
// Wave A5 regression test for review finding #10:
//   persistParsedFile() dropped parent_symbol_id whenever a symbol's parent
//   appeared LATER in record.symbols. The old single-pass loop resolved
//   `keyToId.get(sym.parentSymbolKey)` in the SAME iteration that inserted the
//   symbol — so a forward reference (child before parent, e.g. a same-line
//   `class C { greet() {} }`) silently linked to null.
//
//   The fix splits the symbol loop into two passes: pass 1 inserts every symbol
//   and fully populates keyToId; pass 2 applies updateSymbolExtras (including
//   parentId resolution) once keyToId is complete. Parent linkage is therefore
//   order-independent.
//
// Drives the BUILT dist (dist/core/indexing/*.js + dist/core/db-adapter.js)
// against an in-memory SQLite DB — zero I/O, same pattern as resolve-edges.test.js.
//
// Named distinctly to avoid colliding with the parallel agents sharing this
// worktree (each Wave-A task owns one new test file).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    openMemoryDb,
    closeDb,
    initSymbolSchema,
    upsertFile,
    queryRaw,
} from '../dist/core/db-adapter.js';
import { extractParsedFile } from '../dist/core/indexing/extract.js';
import { persistParsedFile } from '../dist/core/indexing/persist.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb() {
    const db = openMemoryDb();
    initSymbolSchema(db);
    return db;
}

/** Read back every persisted symbol row for a file, ordered by insertion id. */
function readSymbols(db, relPath) {
    return queryRaw(
        db,
        'SELECT id, name, line, column, parent_symbol_id AS parentId FROM symbols WHERE file_path = ? ORDER BY id',
        relPath,
    );
}

function findRow(rows, name) {
    return rows.find((r) => r.name === name);
}

/**
 * Minimal ParsedFileRecord with no child-table payloads. Only `symbols` matters
 * for parent-linkage; everything else is empty so the assertion is unambiguous.
 */
function recordWithSymbols(relPath, symbols) {
    return {
        relPath,
        hash: 'hash',
        lang: 'typescript',
        symbols,
        structures: [],
        anchors: [],
        imports: [],
        importBindings: [],
        injections: [],
        locals: [],
        edges: [],
    };
}

function symbol(overrides) {
    return {
        name: 'sym',
        kind: 'def',
        type: 'function',
        captureTag: 'definition.function',
        line: 1,
        endLine: 1,
        column: 0,
        bodyHash: null,
        parentSymbolKey: null,
        visibility: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Core proof: forward reference (child listed BEFORE parent) still links.
//
// This is the order-sensitive case the old single-pass code dropped. The child
// `greet` references parent key `C:1:6`, but `C` is inserted AFTER `greet`, so
// at the moment the old loop processed `greet` the parent id was not yet in
// keyToId → it wrote parent_symbol_id = null. The second pass resolves it.
// ---------------------------------------------------------------------------

describe('persistParsedFile — parent linkage is insertion-order independent (finding #10)', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('resolves a child→parent link even when the child is listed before the parent', () => {
        const relPath = 'src/reversed.ts';
        upsertFile(db, relPath, 'hash', Date.now());

        // CHILD FIRST, PARENT SECOND — the forward-reference that broke single-pass.
        const rec = recordWithSymbols(relPath, [
            symbol({ name: 'greet', type: 'method', captureTag: 'definition.method', line: 1, column: 10, parentSymbolKey: 'C:1:6' }),
            symbol({ name: 'C', type: 'class', captureTag: 'definition.class', line: 1, column: 6, parentSymbolKey: null }),
        ]);

        persistParsedFile(db, rec);

        const rows = readSymbols(db, relPath);
        const child = findRow(rows, 'greet');
        const parent = findRow(rows, 'C');

        expect(parent).toBeTruthy();
        expect(child).toBeTruthy();
        // The load-bearing assertion: child links to the parent's id, NOT null.
        // Old single-pass code wrote null here because `C` had no id yet when
        // `greet` was processed.
        expect(child.parentId).toBe(parent.id);
        expect(child.parentId).not.toBeNull();
    });

    it('still links correctly when parent is listed before child (no regression on natural order)', () => {
        const relPath = 'src/natural.ts';
        upsertFile(db, relPath, 'hash', Date.now());

        // PARENT FIRST, CHILD SECOND — must keep working.
        const rec = recordWithSymbols(relPath, [
            symbol({ name: 'C', type: 'class', captureTag: 'definition.class', line: 1, column: 6, parentSymbolKey: null }),
            symbol({ name: 'greet', type: 'method', captureTag: 'definition.method', line: 1, column: 10, parentSymbolKey: 'C:1:6' }),
        ]);

        persistParsedFile(db, rec);

        const rows = readSymbols(db, relPath);
        const child = findRow(rows, 'greet');
        const parent = findRow(rows, 'C');

        expect(child.parentId).toBe(parent.id);
    });

    it('every parent-bearing symbol links regardless of where its parent sits in the list', () => {
        const relPath = 'src/mixed.ts';
        upsertFile(db, relPath, 'hash', Date.now());

        // Two children both pointing at a parent that appears LAST.
        const rec = recordWithSymbols(relPath, [
            symbol({ name: 'a', type: 'method', captureTag: 'definition.method', line: 2, column: 4, parentSymbolKey: 'Outer:1:6' }),
            symbol({ name: 'b', type: 'method', captureTag: 'definition.method', line: 3, column: 4, parentSymbolKey: 'Outer:1:6' }),
            symbol({ name: 'Outer', type: 'class', captureTag: 'definition.class', line: 1, column: 6, parentSymbolKey: null }),
        ]);

        persistParsedFile(db, rec);

        const rows = readSymbols(db, relPath);
        const outer = findRow(rows, 'Outer');
        expect(findRow(rows, 'a').parentId).toBe(outer.id);
        expect(findRow(rows, 'b').parentId).toBe(outer.id);
    });

    it('leaves parent_symbol_id null when the referenced parent key is genuinely absent', () => {
        const relPath = 'src/dangling.ts';
        upsertFile(db, relPath, 'hash', Date.now());

        // parentSymbolKey points at a key that is not in the record at all.
        const rec = recordWithSymbols(relPath, [
            symbol({ name: 'orphan', type: 'method', captureTag: 'definition.method', line: 2, column: 4, parentSymbolKey: 'Ghost:9:9' }),
        ]);

        persistParsedFile(db, rec);

        const rows = readSymbols(db, relPath);
        // Honest behavior preserved: a truly missing parent stays null (no
        // fabricated link), exactly as before.
        expect(findRow(rows, 'orphan').parentId).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Real-extractor proof: the same-line TS class `class C { greet() {} }` flows
// through extractParsedFile (so we exercise the genuine ParsedFileRecord shape,
// not just a hand-built one) and persists with a non-null parent link.
//
// extractParsedFile emits `C` (col 6) BEFORE `greet` (col 10) but gives the
// CLASS a parentSymbolKey pointing at the method (`greet:1:10`). Under the old
// single-pass code that class→method link dropped to null because `greet` had
// no id yet when `C` was inserted. The second pass fixes it.
// ---------------------------------------------------------------------------

describe('persistParsedFile — same-line class/method via real extractParsedFile (finding #10)', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('persists a non-null parent link for a single-line class definition', async () => {
        const relPath = 'src/single-line.ts';
        const source = 'class C { greet() {} }\n';

        const rec = await extractParsedFile(source, 'typescript', relPath, 'hash');
        expect(rec, 'extractParsedFile returned null (grammar failed to load)').toBeTruthy();

        // Confirm the fixture really is order-sensitive: at least one symbol's
        // parent key points at a symbol that is listed AFTER it. (Guards the
        // test against an extractor change that would make it vacuous.)
        const keyOf = (s) => `${s.name}:${s.line}:${s.column}`;
        const indexByKey = new Map(rec.symbols.map((s, i) => [keyOf(s), i]));
        const hasForwardRef = rec.symbols.some(
            (s, i) => s.parentSymbolKey && (indexByKey.get(s.parentSymbolKey) ?? -1) > i,
        );
        expect(hasForwardRef, 'fixture is not order-sensitive; pick a stronger fixture').toBe(true);

        upsertFile(db, relPath, 'hash', Date.now());
        persistParsedFile(db, rec);

        const rows = readSymbols(db, relPath);
        // Every symbol that carries a parentSymbolKey resolving to a real symbol
        // in this file must end up with a non-null parent_symbol_id.
        const idByKey = new Map(
            rows.map((r) => [`${r.name}:${r.line}:${r.column}`, r.id]),
        );
        for (const s of rec.symbols) {
            if (s.parentSymbolKey && idByKey.has(s.parentSymbolKey)) {
                const row = rows.find(
                    (r) => r.name === s.name && r.line === s.line && r.column === s.column,
                );
                expect(
                    row.parentId,
                    `symbol ${s.name} should link to parent ${s.parentSymbolKey}`,
                ).toBe(idByKey.get(s.parentSymbolKey));
            }
        }
    });
});
