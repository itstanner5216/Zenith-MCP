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
    DEF_TYPES,
    getSymbols,
    getDefinitions,
    getSymbolSummary,
    getSymbolSummaryString,
    findSymbol,
    getFileSymbols,
    getFileSymbolSummary,
    checkSyntaxErrors,
} from './tree-sitter/symbols.js';

