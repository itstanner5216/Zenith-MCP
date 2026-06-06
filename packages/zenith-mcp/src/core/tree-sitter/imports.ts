// ---------------------------------------------------------------------------
// tree-sitter/imports.ts — File-level import edge extraction
//
// Invariant: Post-processes getSymbols output. Does NOT re-parse.
// Extracts import edges grouped by line (one row per import statement).
// ---------------------------------------------------------------------------

import type { SymbolInfo } from './symbols.js';

export interface ImportEdge {
    module: string;
    importedNames: string[];  // empty = wildcard/side-effect import
    line: number;
}

/**
 * Extract file-level import edges from already-computed symbols.
 * Groups refs with type 'import' or 'module' by source line.
 */
export function extractImportsFromSymbols(symbols: SymbolInfo[]): ImportEdge[] {
    const moduleRefs = symbols.filter(s =>
        s.kind === 'ref' && (s.type === 'module' || s.type === 'import')
    );

    if (moduleRefs.length === 0) return [];

    // Group by line — refs on the same line belong to the same import statement
    const byLine = new Map<number, SymbolInfo[]>();
    for (const ref of moduleRefs) {
        if (!byLine.has(ref.line)) byLine.set(ref.line, []);
        byLine.get(ref.line)!.push(ref);
    }

    const imports: ImportEdge[] = [];
    for (const [line, refs] of byLine) {
        const moduleRef = refs.find(r => r.type === 'module');
        const importRefs = refs.filter(r => r.type === 'import');
        imports.push({
            // byLine only holds lines with at least one 'module' or 'import' ref;
            // when moduleRef is absent, every ref on the line is 'import', so importRefs[0] is present.
            module: moduleRef?.name ?? importRefs[0]!.name,
            importedNames: importRefs.map(r => r.name),
            line,
        });
    }

    return imports;
}
