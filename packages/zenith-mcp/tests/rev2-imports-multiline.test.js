// rev2-imports-multiline.test.js
//
// Regression test for review-2 finding [S] (cubic P1): multi-line import
// statements were fragmented by extractImportsFromSymbols because it grouped
// refs by `ref.line`. For a statement whose imported names span several lines,
// each name landed on its own line, became its own ImportEdge, and — since an
// import-only line carries no 'module' ref — the first imported name was
// misattributed as the module source.
//
// The fix groups by the import STATEMENT: each 'module' ref opens one edge and
// the following 'import' refs (its named bindings, on whatever line) attach to
// it. This file asserts the multi-line case collapses to ONE correct edge and
// that no edge ever uses an imported name as its module.

import { describe, expect, it } from 'vitest';
import { extractImportsFromSymbols } from '../dist/core/tree-sitter/imports.js';

/** Minimal SymbolInfo factory mirroring getSymbols() output. */
function sym(kind, type, name, line, col = 0) {
    return { kind, type, name, line, endLine: line, column: col };
}

describe('extractImportsFromSymbols — multi-line statements (rev2 [S])', () => {
    it('collapses a multi-line import (names on separate lines) into ONE edge with the real module', () => {
        // Models, e.g.:
        //   from mod import (   # line 1: 'module' ref `mod`
        //       a,              # line 2: 'import' ref `a`
        //       b,              # line 3: 'import' ref `b`
        //       c,              # line 4: 'import' ref `c`
        //   )
        // getSymbols sorts by line, so the source ref precedes its names.
        const symbols = [
            sym('ref', 'module', 'mod', 1),
            sym('ref', 'import', 'a', 2),
            sym('ref', 'import', 'b', 3),
            sym('ref', 'import', 'c', 4),
        ];

        const imports = extractImportsFromSymbols(symbols);

        // Exactly ONE edge for the whole statement (fail-before: would be 4).
        expect(imports).toHaveLength(1);

        const edge = imports[0];
        expect(edge.module).toBe('mod');
        expect(edge.importedNames).toContain('a');
        expect(edge.importedNames).toContain('b');
        expect(edge.importedNames).toContain('c');
        // Anchored on the statement's source line, not a name line.
        expect(edge.line).toBe(1);
    });

    it('never misattributes an imported name as the module (the [S] bug)', () => {
        const importedNameSet = new Set(['a', 'b', 'c']);
        const symbols = [
            sym('ref', 'module', 'mod', 10),
            sym('ref', 'import', 'a', 11),
            sym('ref', 'import', 'b', 12),
            sym('ref', 'import', 'c', 13),
        ];

        const imports = extractImportsFromSymbols(symbols);

        // Fail-before: lines 11/12/13 each produced an edge whose `module` was
        // the imported name itself (a, b, c). Pass-after: no such edge exists.
        for (const edge of imports) {
            expect(importedNameSet.has(edge.module)).toBe(false);
        }
        // And the only module present is the genuine source.
        expect(imports.map(e => e.module)).toEqual(['mod']);
    });

    it('keeps single-line imports correct (module + names share a line → one edge)', () => {
        // e.g. `import { readFile, writeFile } from 'fs'` all on line 3.
        const symbols = [
            sym('ref', 'module', 'fs', 3),
            sym('ref', 'import', 'readFile', 3),
            sym('ref', 'import', 'writeFile', 3),
        ];

        const imports = extractImportsFromSymbols(symbols);

        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('fs');
        expect(imports[0].importedNames).toEqual(['readFile', 'writeFile']);
        expect(imports[0].line).toBe(3);
    });

    it('separates two multi-line statements into two correct edges', () => {
        const symbols = [
            // from modA import ( x, y )  spanning lines 1-3
            sym('ref', 'module', 'modA', 1),
            sym('ref', 'import', 'x', 2),
            sym('ref', 'import', 'y', 3),
            // from modB import ( z )  spanning lines 5-6
            sym('ref', 'module', 'modB', 5),
            sym('ref', 'import', 'z', 6),
        ];

        const imports = extractImportsFromSymbols(symbols);

        expect(imports).toHaveLength(2);
        const a = imports.find(i => i.module === 'modA');
        const b = imports.find(i => i.module === 'modB');
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(a.importedNames).toEqual(['x', 'y']);
        expect(a.line).toBe(1);
        expect(b.importedNames).toEqual(['z']);
        expect(b.line).toBe(5);
    });
});
