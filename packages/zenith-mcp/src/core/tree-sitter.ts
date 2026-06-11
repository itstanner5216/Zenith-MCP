// ---------------------------------------------------------------------------
// tree-sitter.ts — Public barrel for the tree-sitter integration
//
// This module is the PUBLIC seam: language detection, runtime/loader, and
// syntax checking. It deliberately does NOT re-export the symbol-extraction
// or fact-extraction APIs (getSymbols / getDefinitions / findSymbol /
// extractStructureForDef / extractAnchorsForDef / extractImportsFromSymbols /
// extractInjections / extractLocals / bodySlice / bodyHash / parseCaptureTag /
// DEF_TYPES / QUERIES_LANG_MAP / getCompiledModularQuery).
//
// Per docs (toon constraints §0.5 / toon goal):
//   tree-sitter extracts facts  →  db-adapter persists them  →  consumers read the DB.
//
// The ONLY non-test source files allowed to import the extractor submodules
// directly are the ingestion path: core/indexing/extract.ts (the single-parse
// orchestrator) and the tree-sitter submodules themselves. Consumers read
// symbols via core/indexed-symbols.ts and facts via core/db-adapter.ts.
// The extractor's own behavioral tests under packages/zenith-mcp/tests/ may
// import the submodules because they ARE the extractor's tests.
//
// If a future consumer needs symbol/structure/anchor data, add the query to
// indexed-symbols.ts or db-adapter.ts — do not add an extractor call site.
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

// Syntax validation parses and reports ERROR/MISSING nodes — it produces no
// symbol facts and is safe to expose.
export { checkSyntaxErrors } from './tree-sitter/symbols.js';
