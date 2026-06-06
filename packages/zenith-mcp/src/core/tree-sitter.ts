// ---------------------------------------------------------------------------
// tree-sitter.ts — Public barrel for the tree-sitter integration
//
// This module is the PUBLIC seam. It exposes the language-detection,
// runtime/loader, and syntax-check surfaces — utilities that callers
// throughout the codebase legitimately need.
//
// It deliberately does NOT re-export the symbol-extraction API.
//
// Per the architecture (docs/toon-constraints/constraints.md §0.5 and
// docs/toon-goal/zenith-toon-goal.md):
//
//   tree-sitter extracts symbol facts
//          ↓
//   db-adapter persists them
//          ↓
//   all later symbol consumers read from the DB-backed adapter
//
// Symbol extraction is the DB-ingestion path, not a reusable public API.
// Promoting `getSymbols` / `getDefinitions` / `findSymbol` / etc. at this
// barrel creates a seam that lets future code bypass the DB and extract
// symbols on demand — which is what this constraint exists to prevent.
//
// The ONLY non-test source file allowed to import the extractor
// directly from `./tree-sitter/symbols.js` is `./symbol-index.ts` —
// the DB ingestion path that extracts symbols only in order to
// persist them through db-adapter. Every other consumer (compression
// seam, edit-engine, refactor_batch, directory, search) reads symbol
// data via `./indexed-symbols.js`, which goes through the DB.
//
// The extractor's own behavioral tests under
// `packages/zenith-mcp/tests/` may also import from the symbols
// submodule because they ARE the extractor's tests.
//
// No other code should add a submodule import. If a future consumer
// needs symbol data, add the query to `./indexed-symbols.js` or to
// `./db-adapter.ts` — do not add a new extractor call site.
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

// `checkSyntaxErrors` is syntax validation (parses and reports ERROR /
// MISSING nodes), not symbol extraction — it produces no symbol facts
// and is safe to expose here.
export { checkSyntaxErrors } from './tree-sitter/symbols.js';

