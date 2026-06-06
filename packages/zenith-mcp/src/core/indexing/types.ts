// ---------------------------------------------------------------------------
// indexing/types.ts — Shared shapes between extract.ts and persist.ts
//
// Invariant: No runtime imports. Pure type definitions.
// Single source of truth for the shape crossing the extractor→persister boundary.
// ---------------------------------------------------------------------------

export interface SymbolRow {
    name: string;
    kind: 'def' | 'ref';
    type: string;
    captureTag: string;         // full 'definition.function' etc.
    line: number;               // 1-based
    endLine: number;            // 1-based
    column: number;
    bodyHash: string | null;    // sha1 for defs only
    parentSymbolKey: string | null;  // transient FK: `${name}:${line}:${col}`
    visibility: string | null;  // 'public'|'private'|'protected'|'package'|null
}

export interface StructureRow {
    parentSymbolKey: string;    // FK to a SymbolRow
    params: string[];
    returnKind: string | null;
    decorators: string[];
    modifiers: string[];
    parentKind: string | null;
}

export interface AnchorRow {
    parentSymbolKey: string;
    kind: string;
    line: number;               // 0-based line index
    priority: number;
    text: string;               // first ~80 chars of the anchor line
}

export interface ImportRow {
    module: string;
    importedNames: string[];
    line: number;
}

export interface InjectionRow {
    hostLang: string;
    injectedLang: string;
    startLine: number;
    endLine: number;
    startByte: number;
    endByte: number;
}

export interface LocalScopeRow {
    parentSymbolKey: string | null;
    scopeKind: string;
    startLine: number;
    endLine: number;
    parameters: { name: string; line: number; column: number }[];
    locals: { name: string; line: number; column: number }[];
}

export interface RawEdgeRow {
    containerDefKey: string;
    referencedName: string;
}

export interface ParsedFileRecord {
    relPath: string;
    hash: string;
    lang: string;
    symbols: SymbolRow[];
    structures: StructureRow[];
    anchors: AnchorRow[];
    imports: ImportRow[];
    injections: InjectionRow[];
    locals: LocalScopeRow[];
    edges: RawEdgeRow[];
}
