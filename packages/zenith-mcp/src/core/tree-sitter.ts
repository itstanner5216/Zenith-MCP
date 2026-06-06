// ---------------------------------------------------------------------------
// tree-sitter.ts — Barrel re-export file
//
// This module re-exports the complete public API from the tree-sitter
// submodules. All external imports continue to work unchanged.
// ---------------------------------------------------------------------------

export {
    getLangForFile,
    getSupportedExtensions,
    isSupported,
} from './tree-sitter/languages.js';

export {
    treeSitterAvailable,
    loadLanguage,
    getCompiledQuery,
} from './tree-sitter/runtime.js';

export type { SymbolInfo, SymbolFilterOptions } from './tree-sitter/symbols.js';

export {
    getSymbols,
    getDefinitions,
    getSymbolSummary,
    getSymbolSummaryString,
    findSymbol,
    getFileSymbols,
    getFileSymbolSummary,
    checkSyntaxErrors,
} from './tree-sitter/symbols.js';

export { getCompiledModularQuery, DEF_TYPES, QUERIES_LANG_MAP } from './tree-sitter/runtime.js';
export { extractStructureForDef, type SymbolStructure } from './tree-sitter/structure.js';
export { extractAnchorsForDef, type AnchorEntry } from './tree-sitter/anchors.js';
export { extractImportsFromSymbols, type ImportEdge } from './tree-sitter/imports.js';
export { extractInjections, type InjectionSpan } from './tree-sitter/injections.js';
export { extractLocals, type LocalScope, type LocalSymbol } from './tree-sitter/locals.js';
export { bodySlice, bodyHash } from './tree-sitter/body.js';
export { parseCaptureTag, type ParsedCaptureTag } from './tree-sitter/capture-tags.js';

