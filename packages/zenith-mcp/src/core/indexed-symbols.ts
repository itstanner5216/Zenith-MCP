// ---------------------------------------------------------------------------
// indexed-symbols.ts — Consumer-side DB-backed symbol reads
//
// This module is the only sanctioned way for consumers (edit tools,
// search tools, directory listings, compression seam, refactor batch)
// to obtain symbol facts about a file. It hides the
// `findRepoRoot → getDb → ensureIndexFresh → query DB` dance behind a
// shape that mirrors the old tree-sitter `getSymbols` / `getDefinitions`
// / `findSymbol` extractor APIs.
//
// Architecture (docs/toon-constraints/constraints.md §0.5 and
// docs/toon-goal/zenith-toon-goal.md):
//
//   tree-sitter extracts symbol facts          ← only the DB
//          ↓                                     ingestion path
//   db-adapter persists them                     (./symbol-index.ts)
//          ↓                                     is allowed to call
//   all later symbol consumers read from DB      extraction directly.
//
// Consumers MUST go through this module. Direct imports of
// `getSymbols` / `getDefinitions` / `findSymbol` from
// `./tree-sitter/symbols.js` are forbidden in consumer code — the
// barrel deliberately does not re-export them, and the submodule is
// reserved for the ingestion path. The extractor's own behavioral
// tests under `packages/zenith-mcp/tests/` may import the submodule
// because they ARE the extractor's tests; that is not a consumer
// pattern and does not extend to other tests or to any src/ file.
// Every other reader uses the helpers below.
//
// Indexing is on-demand: every helper calls `ensureIndexFresh()` so
// the DB reflects current disk state before the query runs. If the
// file hash hasn't changed since the last index, the call is a cheap
// hash check; if it has, the file is re-parsed and re-persisted before
// the query. Consumers don't have to think about staleness.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { findRepoRoot, getDb, ensureIndexFresh } from './symbol-index.js';
import {
    getSymbolsInFile,
    findSymbolsByNameInFile,
} from './db-adapter.js';

/**
 * One symbol row as returned from the DB-backed adapter. Shape matches
 * the tree-sitter extractor's `SymbolInfo` so consumers can swap calls
 * without touching downstream usage.
 */
export interface IndexedSymbol {
    name: string;
    kind: string;
    type: string;
    line: number;
    endLine: number;
    column: number;
}

/**
 * Optional filters mirroring the old `SymbolFilterOptions` shape so
 * consumer code that constructed filter objects keeps working.
 */
export interface SymbolFilterOptions {
    nameFilter?: string;
    kindFilter?: string;
    typeFilter?: string;
    excludeNames?: string[];
    nearLine?: number;
}

/**
 * Load every indexed symbol (defs + refs) for a file from the DB-backed
 * adapter, re-indexing first if the file's content hash has changed.
 *
 * Returns `null` when no repo root can be located for `absPath` (file is
 * outside any known project) — callers should treat that as "symbol
 * data unavailable" and fall back accordingly. Returns an empty array
 * when the file is supported but yields no symbols.
 */
export async function loadFileSymbols(
    absPath: string,
    opts: SymbolFilterOptions = {}
): Promise<IndexedSymbol[] | null> {
    const repoRoot = findRepoRoot(absPath);
    if (!repoRoot) return null;

    const db = getDb(repoRoot);
    await ensureIndexFresh(db, repoRoot, [absPath]);

    const relPath = path.relative(repoRoot, absPath);
    const rows = getSymbolsInFile(db, relPath);
    return applyFilters(rows, opts);
}

/**
 * Load only the definitions for a file from the DB-backed adapter.
 * Convenience wrapper around {@link loadFileSymbols} with
 * `kindFilter: 'def'`.
 */
export async function loadFileDefinitions(
    absPath: string,
    opts: SymbolFilterOptions = {}
): Promise<IndexedSymbol[] | null> {
    return loadFileSymbols(absPath, { ...opts, kindFilter: 'def' });
}

/**
 * Locate symbol(s) by name in a single file from the DB-backed adapter.
 *
 * Supports dot-qualified names like `"MyClass.sendMessage"` — splits
 * on `.`, looks up the innermost name, then walks back through parent
 * qualifiers using line-range containment on the file's definition
 * list (same algorithm the prior tree-sitter `findSymbol()` used).
 *
 * If multiple matches exist and `opts.nearLine` is supplied, results
 * are sorted by proximity to that line.
 *
 * Returns `null` when no repo root can be located for `absPath`.
 */
export async function loadSymbolInFile(
    absPath: string,
    symbolName: string,
    opts: SymbolFilterOptions = {}
): Promise<IndexedSymbol[] | null> {
    const repoRoot = findRepoRoot(absPath);
    if (!repoRoot) return null;

    const db = getDb(repoRoot);
    await ensureIndexFresh(db, repoRoot, [absPath]);

    const relPath = path.relative(repoRoot, absPath);
    const kindFilter = opts.kindFilter ?? 'def';

    // Dot-qualified handling: "Outer.Inner.method" → target is "method",
    // qualifying parents are ["Outer", "Inner"].
    const parts = symbolName.split('.');
    // split() on any string yields ≥1 element; guard makes the invariant explicit
    // (Rule 6: no `!` non-null assertions).
    const lastPart = parts[parts.length - 1];
    if (lastPart === undefined) return [];
    const targetName = lastPart;
    const parentNames = parts.slice(0, -1);

    let matches = findSymbolsByNameInFile(db, relPath, targetName, kindFilter);

    if (parentNames.length > 0 && matches.length > 0) {
        // Parent verification needs the file's full def list regardless
        // of the caller's kindFilter — the parents are always defs.
        const allDefs = (getSymbolsInFile(db, relPath)).filter(s => s.kind === 'def');

        matches = matches.filter((sym) => {
            let current: IndexedSymbol = sym;
            for (let i = parentNames.length - 1; i >= 0; i--) {
                // i is bounded by parentNames.length; guard makes the invariant
                // explicit (Rule 6: no `!` non-null assertions).
                const parentName = parentNames[i];
                if (parentName === undefined) return false;
                const parent = allDefs.find(d =>
                    d.name === parentName &&
                    d.line <= current.line &&
                    d.endLine >= current.endLine &&
                    d !== current
                );
                if (!parent) return false;
                current = parent;
            }
            return true;
        });
    }

    if (matches.length > 1 && opts.nearLine !== undefined) {
        const nearLine = opts.nearLine;
        matches.sort((a, b) =>
            Math.abs(a.line - nearLine) - Math.abs(b.line - nearLine)
        );
    }

    // Honor the remaining extra filters the caller passed (typeFilter /
    // excludeNames) for shape parity with the prior extractor API. Two
    // filters are deliberately stripped before forwarding to applyFilters:
    //   - kindFilter: already applied above via the SQL query.
    //   - nameFilter: this is the EXACT-name lookup path (matches were
    //     selected by `targetName` via findSymbolsByNameInFile). applyFilters
    //     does a SUBSTRING nameFilter match, so reapplying it here could hide
    //     valid exact matches whose name does not contain an incidental
    //     nameFilter the caller also passed. The prior tree-sitter
    //     `findSymbol()` stripped nameFilter for exactly this reason
    //     (see symbols.ts:findSymbol — `const { nameFilter: _, ...restOptions }`),
    //     so stripping it here preserves findSymbol compatibility.
    // Using rest-destructure (rather than `{ ...opts, kindFilter: undefined }`)
    // keeps us compatible with `exactOptionalPropertyTypes: true`.
    const { kindFilter: _unusedKindFilter, nameFilter: _unusedNameFilter, ...restOpts } = opts;
    return applyFilters(matches, restOpts);
}

/**
 * Compact summary string of definition counts in a file, e.g.
 * `"3 functions, 1 class, 2 methods"`. Returns `null` if the file has
 * no indexed definitions or sits outside any known repo root.
 *
 * The category ordering matches the prior `getSymbolSummaryString` so
 * directory listings render identically.
 */
export async function loadFileSymbolSummary(absPath: string): Promise<string | null> {
    const defs = await loadFileDefinitions(absPath);
    if (!defs || defs.length === 0) return null;

    const counts: Record<string, number> = {};
    for (const d of defs) {
        counts[d.type] = (counts[d.type] ?? 0) + 1;
    }

    // Ordered by typical importance (matches symbols.ts:getSymbolSummaryString).
    const order = ['class', 'interface', 'type', 'enum', 'function', 'method', 'module',
                   'key', 'section', 'selector', 'keyframes', 'media',
                   'variable', 'constant', 'property', 'object', 'mixin', 'extension',
                   'macro', 'resource', 'output', 'provider', 'local'];
    const used = new Set<string>();
    const parts: string[] = [];

    for (const t of order) {
        const c = counts[t];
        if (c) {
            parts.push(`${c} ${c === 1 ? t : pluralize(t)}`);
            used.add(t);
        }
    }
    for (const [t, c] of Object.entries(counts)) {
        if (used.has(t)) continue;
        parts.push(`${c} ${c === 1 ? t : pluralize(t)}`);
    }

    return parts.length > 0 ? parts.join(', ') : null;
}

function pluralize(type: string): string {
    if (type.endsWith('s')) return type + 'es';
    // y → ies only when the y follows a CONSONANT ("query" → "queries").
    // A vowel before the y keeps the plain -s form ("key" → "keys").
    if (type.endsWith('y') && !/[aeiou]y$/.test(type)) return type.slice(0, -1) + 'ies';
    return type + 's';
}

function applyFilters(symbols: IndexedSymbol[], opts: SymbolFilterOptions): IndexedSymbol[] {
    const cloneOne = (s: IndexedSymbol): IndexedSymbol => ({ ...s });
    if (!opts.kindFilter && !opts.nameFilter && !opts.typeFilter && !opts.excludeNames) {
        return symbols.map(cloneOne);
    }
    return symbols.filter(sym => {
        if (opts.kindFilter && sym.kind !== opts.kindFilter) return false;
        if (opts.typeFilter && sym.type !== opts.typeFilter) return false;
        if (opts.nameFilter && !sym.name.toLowerCase().includes(opts.nameFilter.toLowerCase())) return false;
        if (opts.excludeNames && opts.excludeNames.includes(sym.name)) return false;
        return true;
    }).map(cloneOne);
}
