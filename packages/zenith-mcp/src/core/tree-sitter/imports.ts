// ---------------------------------------------------------------------------
// tree-sitter/imports.ts — File-level import edge extraction
//
// Invariant: Post-processes getSymbols output. Does NOT re-parse.
// Extracts import edges grouped by import STATEMENT (one row per statement).
// ---------------------------------------------------------------------------

import type { SymbolInfo } from './symbols.js';

export interface ImportEdge {
    module: string;
    importedNames: string[];  // best-effort binding/import names; empty = side-effect/wildcard or unavailable
    line: number;
    startLine: number;
    endLine: number;
}

/**
 * Extract file-level import edges from already-computed symbols.
 *
 * Consumes refs of type 'module' (the import source, e.g. `'fs'` / `os`) and
 * 'import' (a named binding pulled from that source, e.g. `readFile`). The
 * shipped tag queries emit, per import statement, one 'module' ref for the
 * source followed by zero or more 'import' refs for the named bindings.
 *
 * Grouping key is the import STATEMENT, not the source line. A multi-line
 * statement such as
 *
 *     from mod import (
 *         a,
 *         b,
 *         c,
 *     )
 *
 * places the 'module' ref (`mod`) on the `from` line and each named binding
 * (`a`, `b`, `c`) on its own later line. Grouping by line would fragment this
 * into four edges and — worse — misattribute the named bindings as their own
 * modules (an import-only line has no 'module' ref, so the old code fell back
 * to treating the first imported name as the source). We instead associate
 * each 'import' ref with the nearest preceding 'module' ref and emit exactly
 * one edge per 'module' ref, carrying all of that statement's names.
 *
 * `SymbolInfo` here carries only line/column position (no AST node range), so
 * the statement boundary cannot be read from an enclosing node. The line-sorted
 * ref stream makes the source the first ref of its statement, so "nearest
 * preceding 'module' ref" is the correct statement key given the data.
 *
 * A bare 'import' ref with no preceding 'module' ref (e.g. Rust `use foo;`,
 * where the single path segment is itself the imported module) is emitted as
 * its own edge with the name used as the module — that name genuinely is the
 * import source, which is distinct from the multi-line misattribution bug
 * (where a real 'module' ref exists earlier in the same statement).
 */
export function extractImportsFromSymbols(symbols: SymbolInfo[]): ImportEdge[] {
    const importRefs = symbols.filter(s =>
        s.kind === 'ref' && (s.type === 'module' || s.type === 'import')
    );

    if (importRefs.length === 0) return [];

    // getSymbols sorts by line; preserve that order so the 'module' ref of a
    // statement is seen before its named bindings. Use a stable sort by line
    // to be robust to caller-supplied ordering without disturbing same-line ties.
    const ordered = importRefs
        .map((ref, idx) => ({ ref, idx }))
        .sort((a, b) => (a.ref.line - b.ref.line) || (a.idx - b.idx))
        .map(entry => entry.ref);

    const imports: ImportEdge[] = [];
    let current: ImportEdge | null = null;

    for (const ref of ordered) {
        if (ref.type === 'module') {
            // A 'module' ref opens a new statement edge; all following 'import'
            // refs (until the next 'module' ref) are this statement's names.
            current = { module: ref.name, importedNames: [], line: ref.line, startLine: ref.line, endLine: ref.endLine };
            imports.push(current);
        } else if (current !== null) {
            // Named binding belonging to the open statement (its source ref
            // appeared earlier). This is the multi-line case: attach the name
            // to the current edge rather than spawning a misattributed module.
            current.importedNames.push(ref.name);
            current.endLine = Math.max(current.endLine, ref.endLine);
        } else {
            // Bare import with no preceding source ref: the name is the module.
            imports.push({ module: ref.name, importedNames: [ref.name], line: ref.line, startLine: ref.line, endLine: ref.endLine });
        }
    }

    return imports;
}
