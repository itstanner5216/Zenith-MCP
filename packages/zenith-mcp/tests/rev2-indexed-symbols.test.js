// ---------------------------------------------------------------------------
// rev2-indexed-symbols.test.js
//
// Regression tests for review-2 findings [W] and [FF] in
// packages/zenith-mcp/src/core/indexed-symbols.ts. Both fixes are exercised
// through the module's PUBLIC, DB-backed API (loadSymbolInFile /
// loadFileSymbolSummary) — the private helpers pluralize() / applyFilters()
// are tested via their only public consumers, matching the project's
// behavioral-test convention (cf. compression-utils.test.js, which pins the
// private budget logic through the public compressForTool seam).
//
// These import the compiled dist build like the sibling DB/tree-sitter
// integration tests (edit-engine-batch-shift.test.js,
// rev2-locals-containment.test.js): the on-demand indexer loads `.wasm`
// grammars whose path is resolved relative to dist/, so the runtime artifact
// is the correct entry point.
//
// Fixtures live under a tmpdir + .git root so findRepoRoot() resolves and the
// on-demand indexer (ensureIndexFresh) parses + persists before each query.
//
// ---------------------------------------------------------------------------
// [W] loadSymbolInFile must NOT reapply nameFilter to its exact-name results
//
//   loadSymbolInFile is the DB-backed replacement for the old tree-sitter
//   findSymbol(): it looks up symbols by EXACT name (findSymbolsByNameInFile
//   on the innermost dot-segment). The old findSymbol() stripped nameFilter
//   from the options it forwarded (symbols.ts: `const { nameFilter: _,
//   ...restOptions } = options`) precisely because applyFilters() does a
//   SUBSTRING nameFilter match — reapplying it would hide valid exact matches.
//
//   The DB version originally stripped only kindFilter, leaving nameFilter in
//   restOpts. So a caller passing an incidental nameFilter that the exact
//   symbol's name does not contain (e.g. symbol "alpha" + nameFilter "beta")
//   had its exact match silently filtered away.
//     pre-fix : applyFilters([alpha], { nameFilter:'beta' }) drops alpha -> [] -> FAILS
//     post-fix: nameFilter stripped alongside kindFilter -> [alpha]       -> passes
//
// ---------------------------------------------------------------------------
// [FF] pluralize() y->ies only after a CONSONANT
//
//   pluralize() is private; its sole public consumer is loadFileSymbolSummary,
//   which pluralizes any symbol-type that occurs more than once. TOML's
//   array-of-tables header `[[name]]` is indexed with type `table_array`
//   (grammars/queries/toml/definitions.scm -> @definition.table_array). That
//   type ends in a VOWEL + 'y' ("...arra-y"), which is exactly the case the
//   old rule mishandled:
//     pre-fix : "table_array".slice(0,-1)+"ies" -> "table_arraies" -> FAILS
//     post-fix: vowel-y guard skips the ies rule -> "table_arrays"  -> passes
//   The consonant-y types (e.g. nothing reachable ends consonant+y in the
//   indexed set) and the unchanged 's'-suffix case ("class" -> "classes") are
//   covered for regression safety.
//
//   NOTE on duplication (cubic #48, P3): pluralize() and applyFilters() are
//   duplicated between indexed-symbols.ts and tree-sitter/symbols.ts. Per the
//   review disposition that cross-file dedup is a SEPARATE concern and is NOT
//   performed here; this test pins only the indexed-symbols.ts copy.
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    loadSymbolInFile,
    loadFileSymbolSummary,
} from '../dist/core/indexed-symbols.js';
import { getDb } from '../dist/core/symbol-index.js';
import { upsertFile, insertSymbol } from '../dist/core/db-adapter.js';

let testDir;

beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev2-indexed-symbols-'));
    // A .git marker makes findRepoRoot() resolve testDir as the repo root.
    fs.mkdirSync(path.join(testDir, '.git'));
});

afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// alpha occupies lines 1-3, blank 4, beta occupies lines 5-7.
const twoFnSource =
    'function alpha(x) {\n' +
    '    return x + 1;\n' +
    '}\n' +
    '\n' +
    'function beta(y) {\n' +
    '    return y * 2;\n' +
    '}\n';

describe('indexed-symbols.ts loadSymbolInFile exact-name vs nameFilter (review-2 [W])', () => {
    it('returns the exact match even when an incidental nameFilter is present (no hidden matches)', async () => {
        const filePath = path.join(testDir, 'mod.js');
        fs.writeFileSync(filePath, twoFnSource);

        // The caller asks for the EXACT symbol "alpha" but also passes an
        // unrelated nameFilter "beta". "alpha" does not CONTAIN "beta", so the
        // old substring re-filter would erase the exact match.
        //   pre-fix : [] (alpha hidden by nameFilter 'beta') -> FAILS below
        //   post-fix: [alpha] (nameFilter stripped on the exact-name path)
        const result = await loadSymbolInFile(filePath, 'alpha', { nameFilter: 'beta' });

        expect(result).not.toBeNull();
        expect(Array.isArray(result)).toBe(true);

        // CORE [W] ASSERTION — fail-before / pass-after flip.
        const names = result.map((s) => s.name);
        expect(names).toContain('alpha');
        expect(result).toHaveLength(1);
        expect(result[0].kind).toBe('def');
    });

    it('control: the same exact lookup WITHOUT a nameFilter also returns the match (guards against over-pruning)', async () => {
        const filePath = path.join(testDir, 'mod.js');
        fs.writeFileSync(filePath, twoFnSource);

        const result = await loadSymbolInFile(filePath, 'alpha');
        expect(result).not.toBeNull();
        expect(result.map((s) => s.name)).toEqual(['alpha']);
    });

    it('a genuinely absent symbol still returns no matches (the fix does not make everything match)', async () => {
        const filePath = path.join(testDir, 'mod.js');
        fs.writeFileSync(filePath, twoFnSource);

        // Stripping nameFilter must not turn exact lookup into "match anything":
        // a name that is not defined yields an empty result regardless.
        const result = await loadSymbolInFile(filePath, 'doesNotExist', { nameFilter: 'alpha' });
        expect(result).not.toBeNull();
        expect(result).toHaveLength(0);
    });

    it('still honors the other forwarded filters (excludeNames) on the exact-name path', async () => {
        const filePath = path.join(testDir, 'mod.js');
        fs.writeFileSync(filePath, twoFnSource);

        // Only nameFilter (and the already-applied kindFilter) are stripped.
        // excludeNames must still take effect: excluding "alpha" drops the
        // exact match, proving the rest-destructure kept the other filters.
        const excluded = await loadSymbolInFile(filePath, 'alpha', { excludeNames: ['alpha'] });
        expect(excluded).not.toBeNull();
        expect(excluded).toHaveLength(0);

        // And excluding an UNRELATED name leaves the exact match intact.
        const kept = await loadSymbolInFile(filePath, 'alpha', { excludeNames: ['beta'] });
        expect(kept).not.toBeNull();
        expect(kept.map((s) => s.name)).toEqual(['alpha']);
    });
});

describe('indexed-symbols.ts pluralize via loadFileSymbolSummary (review-2 [FF])', () => {
    it('pluralizes a vowel-y symbol type with plain -s ("table_array" -> "table_arrays", not "table_arraies")', async () => {
        // Two TOML array-of-tables -> two `table_array` defs -> pluralized.
        const tomlPath = path.join(testDir, 'conf.toml');
        fs.writeFileSync(
            tomlPath,
            '[[products]]\nname = "a"\n\n[[products]]\nname = "b"\n'
        );

        const summary = await loadFileSymbolSummary(tomlPath);
        expect(summary).not.toBeNull();

        // CORE [FF] ASSERTION — fail-before / pass-after flip.
        //   pre-fix : "...2 table_arraies..." (y->ies applied after a vowel) -> FAILS
        //   post-fix: "...2 table_arrays..."  (vowel-y guard -> plain -s)
        expect(summary).toContain('2 table_arrays');
        expect(summary).not.toContain('table_arraies');
    });

    it('leaves the singular ("1 table_array") untouched (count of 1 never pluralizes)', async () => {
        const tomlPath = path.join(testDir, 'one.toml');
        fs.writeFileSync(tomlPath, '[[only]]\nx = 1\n');

        const summary = await loadFileSymbolSummary(tomlPath);
        expect(summary).not.toBeNull();
        expect(summary).toContain('1 table_array');
        // Must not have been pluralized (neither correctly nor with the old bug).
        expect(summary).not.toContain('table_arrays');
        expect(summary).not.toContain('table_arraies');
    });

    it('the unchanged trailing-s rule still holds ("class" -> "classes")', async () => {
        // Two JS classes -> type `class` occurs twice -> pluralized via the
        // `endsWith('s')` branch, which neither [FF] nor [W] alters.
        const jsPath = path.join(testDir, 'classes.js');
        fs.writeFileSync(
            jsPath,
            'class Foo {\n    m() {}\n}\nclass Bar {\n    n() {}\n}\n'
        );

        const summary = await loadFileSymbolSummary(jsPath);
        expect(summary).not.toBeNull();
        expect(summary).toContain('2 classes');
    });
});

// ---------------------------------------------------------------------------
// Direct pluralize() coverage: key/query/class via DB-seeded summary
//
// pluralize() is private; the only public path through it is
// loadFileSymbolSummary.  No tree-sitter grammar in this repo currently
// emits symbol types "key" or "query", so we cannot exercise those inputs
// through real file parsing.  Instead we pre-seed the DB directly:
//
//   1. getDb(testDir)  — opens the same DbConnection that loadFileSymbolSummary
//      will use (keyed by repoRoot in the global _dbCache).
//   2. upsertFile(db, relPath, md5(content), now)  — stamps a hash that matches
//      the file on disk.  ensureIndexFresh() sees existingHash === hash and
//      SKIPS re-indexing, leaving our synthetic rows intact.
//   3. insertSymbol(db, { type:'key', kind:'def', ... }) × 2  — two defs with
//      the target type so pluralize() is invoked (count === 1 uses the singular).
//   4. loadFileSymbolSummary(absPath)  — exercises the real pluralize() code
//      inside the compiled module.
//
// Fail-before / pass-after for each type:
//   "key"   – vowel+'y' tail; old rule: "key".slice(0,-1)+"ies"="keies" -> FAILS
//             new rule: /[aeiou]y$/ matches 'ey' -> skips ies -> "keys" -> PASSES
//   "query" – consonant+'y' tail; old rule: correct ("queries") BUT the test
//             confirms the guard does NOT regress the consonant-y case: still
//             "queries" post-fix -> PASSES
//   "class" – ends in 's'; pluralize("class")="classes"; unchanged by [FF]
//             -> PASSES (regression guard)
//
// NOTE on cubic #48 P3 (duplication): the indexed-symbols.ts copy of pluralize()
// is what executes here; the symbols.ts copy is a separate concern and is NOT
// tested or changed in this wave.  See the test-file header comment.
// ---------------------------------------------------------------------------

// Helper: MD5 hash matching hashFileContent() inside symbol-index.js.
function md5(content) {
    return createHash('md5').update(content).digest('hex');
}

// Helper: seed two defs of a given type into the DB so pluralize is exercised.
// Returns the absolute path of the (real, empty-ish) JS fixture file.
async function seedSymbolType(repoRoot, typeName) {
    // Use a unique file name per type so parallel runs don't clash.
    const fileName = `seed-${typeName.replace(/[^a-z0-9]/g, '_')}.js`;
    const absPath = path.join(repoRoot, fileName);
    const relPath = fileName;
    // Content is a valid .js stub so shouldIndexFile() passes isSupported().
    const content = `// seed file for type ${typeName}\n`;
    fs.writeFileSync(absPath, content);

    // Prime the DB's files table with the real hash so ensureIndexFresh skips.
    const db = getDb(repoRoot);
    upsertFile(db, relPath, md5(content), Date.now());

    // Insert two defs with the target type.
    for (let i = 1; i <= 2; i++) {
        insertSymbol(db, {
            name: `${typeName}Sym${i}`,
            kind: 'def',
            type: typeName,
            filePath: relPath,
            line: i,
            endLine: i,
            column: 0,
        });
    }
    return absPath;
}

describe('indexed-symbols.ts pluralize via DB-seeded summary: key / query / class (review-2 [FF])', () => {
    it('pluralize("key") === "keys" — vowel-y guard prevents "keies" regression', async () => {
        // pre-fix : if (type.endsWith('y')) return type.slice(0,-1)+'ies'
        //           -> "key".slice(0,-1)+"ies" = "keies" -> FAILS
        // post-fix: /[aeiou]y$/ matches 'ey' -> guard fires -> type+'s' = "keys" -> PASSES
        const absPath = await seedSymbolType(testDir, 'key');
        const summary = await loadFileSymbolSummary(absPath);
        expect(summary).not.toBeNull();
        expect(summary).toContain('2 keys');
        expect(summary).not.toContain('keies');
    });

    it('pluralize("query") === "queries" — consonant-y path still works after [FF]', async () => {
        // pre-fix : "query".slice(0,-1)+"ies" = "queries" (accidentally correct)
        //           BUT the guard must NOT break it:
        // post-fix: /[aeiou]y$/ does NOT match 'ry' -> ies branch fires -> "queries" -> PASSES
        const absPath = await seedSymbolType(testDir, 'query');
        const summary = await loadFileSymbolSummary(absPath);
        expect(summary).not.toBeNull();
        expect(summary).toContain('2 queries');
    });

    it('pluralize("class") === "classes" — trailing-s rule unchanged by [FF]', async () => {
        // pre-fix and post-fix both: "class".endsWith('s') -> "classes"
        // Regression guard: [FF] must not disturb the 's'-suffix branch.
        const absPath = await seedSymbolType(testDir, 'class');
        const summary = await loadFileSymbolSummary(absPath);
        expect(summary).not.toBeNull();
        expect(summary).toContain('2 classes');
    });
});
