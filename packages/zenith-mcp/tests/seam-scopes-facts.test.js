// ---------------------------------------------------------------------------
// seam-scopes-facts.test.js  (Wave 2, Task T6 — J1 + M1)
//
// Proves the scopes leg of the MCP→TOON facts seam that Wave 1 landed:
//   T2 (db-adapter.ts): getFileFacts() now JOINs local_scopes→symbols and
//      returns a `scopes` array of { scopeKind, startLine, endLine }, ordered.
//   T4 (compression.ts): compressForTool() forwards dbFacts.scopes verbatim
//      into the compressFile() facts literal, and seeds an empty-facts default
//      that includes `scopes: []`.
//
// COVERAGE BOUNDARY (M1) — read this before adding/removing assertions:
//   • T6 proves the DB→getFileFacts hop BEHAVIORALLY (an in-memory DB with a
//     real symbols+local_scopes round-trip; the assertions below run the real
//     dist getFileFacts and inspect its output). This is the load-bearing half:
//     a casing/JOIN/ordering regression in the query fails here, loudly.
//   • T6 proves the compression.ts MAPPING and EMPTY-FALLBACK by SOURCE-SCAN
//     (grep-style byte checks on compression.ts), exactly mirroring the existing
//     compression-seam.test.js precedent — that file already guards the seam's
//     import/decision invariants by scanning source rather than executing the
//     async pipeline. We follow the same convention here for the scopes map.
//   • The FULL end-to-end seam (a real compressForTool-equivalent run on a real
//     indexed file, observing scopes flow all the way into tileByDefs) is owned
//     by T7's tests/_tiling-measure.mjs — NOT duplicated here. If you want an
//     executed end-to-end check, add it there, not in this file.
//
// Scope of this file: in-memory DB + source-scan ONLY. No network, no real-repo
// indexing, no dist build (MCP tests import from ../dist, which Wave 1 built).
//
// In-memory DB pattern mirrors tests/rev2-persist-orphan-locals.test.js
// (openMemoryDb + initSymbolSchema, imports from ../dist/core/db-adapter.js).
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    openMemoryDb,
    closeDb,
    initSymbolSchema,
    upsertFile,
    insertSymbol,
    insertLocalScope,
    getFileFacts,
} from '../dist/core/db-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPRESSION_PATH = path.resolve(__dirname, '..', 'src', 'core', 'compression.ts');

const REL_PATH = 'src/scoped.ts';

// Insert one `def` symbol into a file and return its row id. Mirrors the
// addSymbol helper in db-adapter-v1-tables.test.js (insertSymbol field shape).
// symbols.file_path REFERENCES files(path) with foreign_keys ON, so the owning
// `files` row must exist first — upsertFile is idempotent, safe to call per def.
function insertOwnerDef(db, overrides = {}) {
    const filePath = overrides.filePath ?? REL_PATH;
    upsertFile(db, filePath, 'hash', Date.now());
    return insertSymbol(db, {
        name: overrides.name ?? 'owner',
        kind: overrides.kind ?? 'def',
        type: overrides.type ?? 'function',
        filePath,
        line: overrides.line ?? 1,
        endLine: overrides.endLine ?? 40,
        column: overrides.column ?? 0,
    });
}

// Insert an OWNED local_scopes row (symbol_id non-null) for the given owner.
function insertOwnedScope(db, symbolId, scope) {
    insertLocalScope(db, {
        symbolId,
        scopeKind: scope.scopeKind,
        startLine: scope.startLine,
        endLine: scope.endLine,
        parametersJson: '[]',
        localsJson: '[]',
    });
}

// ===========================================================================
// BEHAVIORAL — the real proof of the DB→facts hop (executes dist getFileFacts)
// ===========================================================================
describe('seam scopes — DB→getFileFacts behavioral hop [T6 J1]', () => {
    let db;
    beforeEach(() => { db = openMemoryDb(); initSymbolSchema(db); });
    afterEach(() => closeDb(db));

    it('surfaces an owned local_scopes row as facts.scopes {scopeKind,startLine,endLine}', () => {
        const ownerId = insertOwnerDef(db);
        insertOwnedScope(db, ownerId, { scopeKind: 'statement_block', startLine: 5, endLine: 12 });

        const facts = getFileFacts(db, REL_PATH);

        expect(facts.scopes).toHaveLength(1);
        const scope = facts.scopes[0];
        expect(scope).toBeDefined();
        if (scope === undefined) throw new Error('unreachable: scope[0] missing after length check');
        // Field-by-field: pins the camelCase SELECT aliases (scopeKind/startLine/endLine).
        // A snake_case regression in the query would silently null these (C3).
        expect(scope.scopeKind).toBe('statement_block');
        expect(scope.startLine).toBe(5);
        expect(scope.endLine).toBe(12);
        // Exact transport shape — only the three span columns, nothing extra.
        expect(scope).toEqual({ scopeKind: 'statement_block', startLine: 5, endLine: 12 });
    });

    it('returns multiple owned scopes ordered by startLine (deterministic tiling input)', () => {
        const ownerId = insertOwnerDef(db);
        // Insert OUT OF startLine order so a missing ORDER BY would surface here.
        insertOwnedScope(db, ownerId, { scopeKind: 'catch_clause', startLine: 30, endLine: 34 });
        insertOwnedScope(db, ownerId, { scopeKind: 'statement_block', startLine: 5, endLine: 12 });
        insertOwnedScope(db, ownerId, { scopeKind: 'for_statement', startLine: 14, endLine: 22 });

        const facts = getFileFacts(db, REL_PATH);

        expect(facts.scopes).toHaveLength(3);
        // ORDER BY ls.start_line, ls.end_line → ascending by startLine.
        const startLines = facts.scopes.map((s) => s.startLine);
        expect(startLines).toEqual([5, 14, 30]);
        expect(facts.scopes).toEqual([
            { scopeKind: 'statement_block', startLine: 5, endLine: 12 },
            { scopeKind: 'for_statement', startLine: 14, endLine: 22 },
            { scopeKind: 'catch_clause', startLine: 30, endLine: 34 },
        ]);
    });

    it('breaks startLine ties by endLine (ORDER BY start_line, end_line)', () => {
        const ownerId = insertOwnerDef(db);
        // Two scopes share a startLine; the wider one must NOT come first.
        insertOwnedScope(db, ownerId, { scopeKind: 'wide', startLine: 5, endLine: 20 });
        insertOwnedScope(db, ownerId, { scopeKind: 'narrow', startLine: 5, endLine: 9 });

        const facts = getFileFacts(db, REL_PATH);

        expect(facts.scopes).toEqual([
            { scopeKind: 'narrow', startLine: 5, endLine: 9 },
            { scopeKind: 'wide', startLine: 5, endLine: 20 },
        ]);
    });

    it('EXCLUDES a null-owner ("module") scope — the JOIN drops rows with no symbol', () => {
        // persist.ts:80 never inserts a scope whose owning symbol does not resolve,
        // so null-owner rows do not exist in production. We insert one DIRECTLY here
        // (insertLocalScope accepts symbolId: null) to prove the getFileFacts query's
        // own defense: `JOIN symbols s ON s.id = ls.symbol_id` is an INNER join, so a
        // row with symbol_id IS NULL has no symbol to match and is excluded — module-
        // level code legitimately gets no scope sub-blocks.
        const ownerId = insertOwnerDef(db);
        insertOwnedScope(db, ownerId, { scopeKind: 'statement_block', startLine: 5, endLine: 12 });
        insertLocalScope(db, {
            symbolId: null,
            scopeKind: 'module',
            startLine: 1,
            endLine: 40,
            parametersJson: '[]',
            localsJson: '[]',
        });

        const facts = getFileFacts(db, REL_PATH);

        // Only the OWNED scope survives; the null-owner 'module' row is gone.
        expect(facts.scopes).toHaveLength(1);
        expect(facts.scopes.map((s) => s.scopeKind)).toEqual(['statement_block']);
        expect(facts.scopes.some((s) => s.scopeKind === 'module')).toBe(false);
    });

    it('only returns scopes for the requested file (file_path filter via the JOIN)', () => {
        // A scope owned by a symbol in ANOTHER file must not leak into REL_PATH facts.
        const ownerHere = insertOwnerDef(db);
        insertOwnedScope(db, ownerHere, { scopeKind: 'statement_block', startLine: 5, endLine: 12 });
        const ownerOther = insertOwnerDef(db, { name: 'otherOwner', filePath: 'src/other.ts' });
        insertOwnedScope(db, ownerOther, { scopeKind: 'for_statement', startLine: 3, endLine: 9 });

        const here = getFileFacts(db, REL_PATH);
        const other = getFileFacts(db, 'src/other.ts');

        expect(here.scopes).toEqual([{ scopeKind: 'statement_block', startLine: 5, endLine: 12 }]);
        expect(other.scopes).toEqual([{ scopeKind: 'for_statement', startLine: 3, endLine: 9 }]);
    });

    it('returns an empty scopes array when the file has a def but no local_scopes', () => {
        insertOwnerDef(db);
        const facts = getFileFacts(db, REL_PATH);
        expect(facts.scopes).toEqual([]);
    });
});

// ===========================================================================
// MAPPING (source-scan) — compression.ts forwards dbFacts.scopes verbatim.
// Mirrors compression-seam.test.js: byte-level scan of the source at rest, so
// this depends only on filesystem state (not the dist build).
// ===========================================================================
describe('seam scopes — compression.ts forwarding map [T6 source-scan]', () => {
    it('forwards dbFacts.scopes into the compressFile facts as {scopeKind,startLine,endLine}', async () => {
        const source = await fs.readFile(COMPRESSION_PATH, 'utf8');

        // The verbatim camelCase→camelCase identity map T4 added. Whitespace-
        // tolerant so cosmetic reformatting does not break the guard, but the
        // field reads (s.scopeKind / s.startLine / s.endLine) are pinned exactly —
        // a casing drift on any of them would silently empty scopes at runtime (C3).
        const forwardRe = /scopes:\s*dbFacts\.scopes\.map\(\s*s\s*=>\s*\(\{\s*scopeKind:\s*s\.scopeKind\s*,\s*startLine:\s*s\.startLine\s*,\s*endLine:\s*s\.endLine\s*\}\)\s*\)/;

        expect(
            forwardRe.test(source),
            'compression.ts must forward dbFacts.scopes verbatim as ' +
            '`scopes: dbFacts.scopes.map(s => ({ scopeKind: s.scopeKind, startLine: s.startLine, endLine: s.endLine }))`. ' +
            'This is pure transport — no filter/rank/normalize (AGENTS.md §0.5 / Step F5).',
        ).toBe(true);

        // The forwarded field names must be character-identical to the db-adapter
        // SELECT aliases proven behaviorally above (scopeKind/startLine/endLine).
        expect(source.includes('s.scopeKind')).toBe(true);
        expect(source.includes('s.startLine')).toBe(true);
        expect(source.includes('s.endLine')).toBe(true);
    });
});

// ===========================================================================
// EMPTY FALLBACK (source-scan) — the empty-facts default includes scopes: [].
// Rule 12 graceful degradation: a DB failure must still hand TOON a well-formed
// facts object (scopes present, just empty) so the text path can run.
// ===========================================================================
describe('seam scopes — compression.ts empty-facts default [T6 source-scan]', () => {
    it('seeds the empty dbFacts default with scopes: []', async () => {
        const source = await fs.readFile(COMPRESSION_PATH, 'utf8');

        // Pin the `scopes: []` entry on the FileFacts empty default. The other
        // fields (defs/edges/anchors/imports/injections) are also `[]`; we assert
        // scopes specifically — that is the field T4 introduced for this seam.
        const defaultRe = /let\s+dbFacts\s*:\s*FileFacts\s*=\s*\{[^}]*\bscopes:\s*\[\s*\][^}]*\}/;

        expect(
            defaultRe.test(source),
            'compression.ts empty-facts default must include `scopes: []` so a DB ' +
            'failure degrades to a well-formed payload (Rule 12). Without it, TOON ' +
            "would read `undefined.map` on the scopes leg.",
        ).toBe(true);
    });
});
