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

// NOTE: DEF_TYPES, selectDefinitionNode, and DefinitionNodeSelection are
// intentionally NOT re-exported here. They are symbol-extraction internals
// that belong to the indexing/persistence path. Consumer-facing symbol
// access must come from the DB-backed adapter, not from the extractor.
// The submodule (`./tree-sitter/symbols.js`) still exports them so the
// in-package tests (which validate the extraction internals directly)
// and any future indexing-path call sites can reach them without
// promoting them to a general public API.

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

