// ---------------------------------------------------------------------------
// review-compression-nulltype.test.js
//
// Regression test for PR-review finding #8: compressForTool() mapped DB defs
// into TOON's RawFileFacts with `type: d.type!` — a non-null assertion that
// (a) violates project Rule 6 (NO `!` assertions) and (b) would forward a
// `null` into TOON's `RawFileFacts.defs[].type`, which is typed `string`.
//
// Ground truth (core/indexing/extract.ts): a def's `type` is always set from
// its tree-sitter capture tag (`type = tag.slice(16)`), so a def row carries a
// non-null type in practice; the `symbols.type` column is nullable only because
// the schema declares it so. The fix narrows that nullable column with an
// honest type-guard (filter out null `type` before the map) — no `!`, no
// magic-string substitution, no behavior change for the normal non-null case.
//
// This test pins both halves of that contract:
//   1. NORMAL def flows end-to-end through compressForTool() and produces
//      output (the real facts-mapping path runs against a populated on-disk DB).
//   2. A forced null-`type` row (the practically-unreachable case the old `!`
//      pretended couldn't happen) is handled WITHOUT throwing and is dropped
//      from the facts handed to TOON — nothing is invented in its place.
//
// All DB primitives come from the BUILT dist (the orchestrator rebuilds at the
// wave gate), matching the convention used by db-adapter-v1-tables.test.js and
// compression-core.test.js.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compressForTool } from '../dist/core/compression.js';
import { findRepoRoot, getDb } from '../dist/core/symbol-index.js';
import {
    openMemoryDb,
    closeDb,
    initSymbolSchema,
    upsertFile,
    insertSymbol,
    getFileFacts,
} from '../dist/core/db-adapter.js';

// The exact narrowing the fix applies in compression.ts: keep only defs whose
// `type` is non-null, then project to TOON's def shape. Mirrored here so the
// null-handling assertion exercises the same predicate the seam relies on.
function defsToToonFacts(defs) {
    return defs
        .filter((d) => d.type !== null)
        .map((d) => ({
            name: d.name,
            kind: 'def',
            type: d.type,
            line: d.line,
            endLine: d.endLine,
            visibility: d.visibility,
            captureTag: d.captureTag,
        }));
}

describe('compression null-type guard (review finding #8)', () => {
    // -----------------------------------------------------------------------
    // 1. End-to-end: a normal def flows through compressForTool and produces
    //    output. This drives the real `dbFacts.defs.filter(...).map(...)`
    //    transformation against a populated DB at the resolved repo root.
    // -----------------------------------------------------------------------
    describe('end-to-end through compressForTool with a populated DB', () => {
        let repoRoot;

        beforeEach(async () => {
            repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-review-a2-'));
            // findRepoRoot() walks up for a `.git` entry; create one so the
            // temp dir is recognized as a repo root and getDb() opens the DB
            // there (.mcp/symbols.db).
            await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
        });

        afterEach(async () => {
            if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
        });

        it('maps a normal (non-null type) def and returns compressed output', async () => {
            // Resolve the repo root the same way compressForTool will, then
            // populate the SAME cached connection it will read from.
            const resolvedRoot = findRepoRoot(repoRoot);
            expect(resolvedRoot).not.toBeNull();

            const db = getDb(resolvedRoot);

            // A compressible, source-like file: several exported functions, one
            // with a long low-value padding body the structural engine drops. Each
            // def's `type` is set from its capture tag (the normal non-null case).
            const fns = [['alpha', 2], ['beta', 40], ['gamma', 2], ['delta', 3]];
            const srcLines = [];
            for (const [name, bulk] of fns) {
                srcLines.push(`export function ${name}(input) {`);
                for (let i = 0; i < bulk; i++) srcLines.push(`  const ${name}_pad${i} = input + ${i};`);
                srcLines.push(`  return ${name}_pad0;`);
                srcLines.push('}');
            }
            const rawText = srcLines.join('\n');
            const relPath = 'src/large.ts';
            const absPath = path.join(resolvedRoot, relPath);
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, rawText, 'utf8');

            upsertFile(db, relPath, 'hash-normal', Date.now());
            insertSymbol(db, {
                name: 'alpha',
                kind: 'def',
                type: 'function', // non-null, capture-tag-style
                filePath: relPath,
                line: 1,
                endLine: 4,
                column: 0,
            });

            // Sanity: the def really is present with a non-null type.
            const facts = getFileFacts(db, relPath);
            expect(facts.defs).toHaveLength(1);
            expect(facts.defs[0].type).toBe('function');

            // read_file is the single prefix authority: the seam receives the
            // `N. `-prefixed text and a budget measured against THAT representation.
            // compressForTool re-indexes the real file content (ensureFreshFromContent)
            // and runs the def-mapping. Must NOT throw and must produce output.
            const prefixed = rawText
                .split('\n')
                .map((line, i) => `${i + 1}. ${line}`)
                .join('\n');
            const maxChars = Math.floor(prefixed.length * 0.6);
            const result = await compressForTool(absPath, prefixed, maxChars);

            expect(result).not.toBeNull();
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
            expect(result.length).toBeLessThan(prefixed.length);
        });
    });

    // -----------------------------------------------------------------------
    // 2. In-memory: a forced null-`type` row is dropped honestly (no throw,
    //    no invented value). Mirrors the exact guard the seam applies.
    // -----------------------------------------------------------------------
    describe('null-type row handling (the case the old `!` masked)', () => {
        let db;

        beforeEach(() => {
            db = openMemoryDb();
            initSymbolSchema(db);
            upsertFile(db, 'src/index.ts', 'hash-mem', Date.now());
        });

        afterEach(() => closeDb(db));

        it('a non-null def survives the guard and projects a string `type`', () => {
            insertSymbol(db, {
                name: 'normalFn',
                kind: 'def',
                type: 'function_declaration',
                filePath: 'src/index.ts',
                line: 1,
                endLine: 5,
                column: 0,
            });

            const facts = getFileFacts(db, 'src/index.ts');
            const mapped = defsToToonFacts(facts.defs);

            expect(mapped).toHaveLength(1);
            expect(mapped[0].name).toBe('normalFn');
            // TOON's RawFileFacts.defs[].type is `string` — assert no null leaks.
            expect(typeof mapped[0].type).toBe('string');
            expect(mapped[0].type).toBe('function_declaration');
        });

        it('a forced null-type def is dropped without throwing and invents nothing', () => {
            // insertSymbol() types `type: string`, mirroring extract.ts where a
            // def always carries a capture-derived type. To exercise the
            // nullable COLUMN (which the old `!` pretended could never be null),
            // force the row to NULL via the raw handle — the only way to reach
            // the guard's negative branch, since no typed API writes null.
            const id = insertSymbol(db, {
                name: 'ghostFn',
                kind: 'def',
                type: 'placeholder',
                filePath: 'src/index.ts',
                line: 10,
                endLine: 12,
                column: 0,
            });
            db._db.prepare('UPDATE symbols SET type = NULL WHERE id = ?').run(id);

            const facts = getFileFacts(db, 'src/index.ts');
            // The DB layer faithfully surfaces the null column...
            expect(facts.defs).toHaveLength(1);
            expect(facts.defs[0].type).toBeNull();

            // ...and the guard drops it cleanly: no throw, empty result, and
            // crucially NO substituted/invented type value in its place.
            let mapped;
            expect(() => { mapped = defsToToonFacts(facts.defs); }).not.toThrow();
            expect(mapped).toEqual([]);
        });

        it('mixed defs: null-type rows drop, non-null rows pass through unchanged', () => {
            const goodId = insertSymbol(db, {
                name: 'keepMe',
                kind: 'def',
                type: 'class_declaration',
                filePath: 'src/index.ts',
                line: 1,
                endLine: 8,
                column: 0,
            });
            const badId = insertSymbol(db, {
                name: 'dropMe',
                kind: 'def',
                type: 'placeholder',
                filePath: 'src/index.ts',
                line: 20,
                endLine: 22,
                column: 0,
            });
            db._db.prepare('UPDATE symbols SET type = NULL WHERE id = ?').run(badId);

            const facts = getFileFacts(db, 'src/index.ts');
            expect(facts.defs).toHaveLength(2);

            const mapped = defsToToonFacts(facts.defs);
            expect(mapped).toHaveLength(1);
            expect(mapped[0].name).toBe('keepMe');
            expect(mapped[0].type).toBe('class_declaration');
            // The dropped row contributes no entry and no invented value.
            expect(mapped.find((d) => d.name === 'dropMe')).toBeUndefined();
            // goodId/badId referenced to keep intent explicit.
            expect(goodId).not.toBe(badId);
        });
    });
});
