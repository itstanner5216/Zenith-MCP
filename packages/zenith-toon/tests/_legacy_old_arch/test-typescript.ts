// ---------------------------------------------------------------------------
// tree-sitter/symbols.ts — Symbol extraction, caching and analysis
//
// Contains:
//   - SymbolInfo / SymbolFilterOptions types
//   - getSymbols(), getDefinitions()
//   - getSymbolSummary(), getSymbolSummaryString()
//   - findSymbol(), getFileSymbols(), getFileSymbolSummary()
//   - checkSyntaxErrors()
//   - Symbol cache helpers (sourceHash, getCachedSymbols, setCachedSymbols)
// ---------------------------------------------------------------------------

import { Parser, Node } from 'web-tree-sitter';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
    loadLanguage,
    getCompiledQuery,
    SYMBOL_CACHE_MAX,
    _symbolCache,
} from './runtime.js';
import { getLangForFile } from './languages.js';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface SymbolInfo {
    name: string;
    kind: string;
    type: string;
    line: number;
    endLine: number;
    column: number;
}

export interface SymbolFilterOptions {
    nameFilter?: string;
    kindFilter?: string;
    typeFilter?: string;
    excludeNames?: string[];
    nearLine?: number;
}

// ---------------------------------------------------------------------------
// Symbol cache helpers
// ---------------------------------------------------------------------------

function sourceHash(source: string): string {
    return createHash('md5').update(source).digest('hex');
}

function getCachedSymbols(hash: string): SymbolInfo[] | null {
    const entry = _symbolCache.get(hash);
    if (entry) {
        entry.ts = Date.now(); // touch for LRU
        return entry.symbols;
    }
    return null;
}

function setCachedSymbols(hash: string, symbols: SymbolInfo[]): void {
    // Evict oldest if at capacity
    if (_symbolCache.size >= SYMBOL_CACHE_MAX) {
        let oldestKey: string | null = null;
        let oldestTs = Infinity;
        for (const [key, val] of _symbolCache) {
            if (val.ts < oldestTs) {
                oldestTs = val.ts;
                oldestKey = key;
            }
        }
        if (oldestKey) _symbolCache.delete(oldestKey);
    }
    _symbolCache.set(hash, { symbols, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Extract all symbols from source code.
 *
 * Uses query.matches() to properly pair @name.definition.* captures with
 * their sibling @definition.* captures, giving us both the symbol name
 * and its full body extent.
 *
 * @param source   - the source code
 * @param langName - tree-sitter language name
 * @param options  - optional filters
 * @returns null if language not supported or no query
 */
export async function getSymbols(source: string, langName: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
    // Check cache first
    const hash = sourceHash(langName + ':' + source);
    const cached = getCachedSymbols(hash);
    if (cached) {
        return applyFilters(cached, options);
    }

    const language = await loadLanguage(langName);
    if (!language) return null;

    const query = await getCompiledQuery(langName);
    if (!query) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    if (!tree) {
        parser.delete();
        return null;
    }

    try {
        // Use matches() to get grouped captures per pattern match.
        // Each match contains both @name.definition.X and @definition.X captures.
        const matches = query.matches(tree.rootNode);
        const symbols: SymbolInfo[] = [];
        const seen = new Set<string>();

        for (const match of matches) {
            const { captures } = match;

            // Find the name capture and the definition/reference body capture
            let nameCapture = null;
            let bodyCapture = null;

            for (const cap of captures) {
                if (cap.name.startsWith('name.')) {
                    nameCapture = cap;
                } else if (cap.name.startsWith('definition.') || cap.name.startsWith('reference.')) {
                    bodyCapture = cap;
                }
            }

            if (!nameCapture) continue;

            const tag = nameCapture.name;
            let kind: string;
            let type: string;
            if (tag.startsWith('name.definition.')) {
                kind = 'def';
                type = tag.slice('name.definition.'.length);
            } else if (tag.startsWith('name.reference.')) {
                kind = 'ref';
                type = tag.slice('name.reference.'.length);
            } else {
                continue;
            }

            const name = nameCapture.node.text;
            const line = nameCapture.node.startPosition.row + 1;
            const column = nameCapture.node.startPosition.column;

            // endLine comes from the body capture if available, otherwise from
            // the name capture's own end (single-line symbol)
            let endLine: number;
            if (bodyCapture) {
                endLine = bodyCapture.node.endPosition.row + 1;
            } else {
                endLine = nameCapture.node.endPosition.row + 1;
            }

            // Dedup by name:kind:line
            const key = `${name}:${kind}:${line}`;
            if (seen.has(key)) continue;
            seen.add(key);

            symbols.push({ name, kind, type, line, endLine, column });
        }

        // Sort by line number
        symbols.sort((a, b) => a.line - b.line);

        // Cache the full unfiltered result
        setCachedSymbols(hash, symbols);

        return applyFilters(symbols, options);
    } finally {
        // Clean up parse tree and parser (query is cached, don't delete it)
        tree.delete();
        parser.delete();
    }
}

/**
 * Apply optional filters to a symbol list.
 */
function applyFilters(symbols: SymbolInfo[], options: SymbolFilterOptions): SymbolInfo[] {
    const cloneOne = (s: SymbolInfo): SymbolInfo => ({ ...s });
    if (!options.kindFilter && !options.nameFilter && !options.typeFilter && !options.excludeNames) {
        return symbols.map(cloneOne);
    }

    return symbols.filter(sym => {
        if (options.kindFilter && sym.kind !== options.kindFilter) return false;
        if (options.typeFilter && sym.type !== options.typeFilter) return false;
        if (options.nameFilter && !sym.name.toLowerCase().includes(options.nameFilter.toLowerCase())) return false;
        if (options.excludeNames && options.excludeNames.includes(sym.name)) return false;
        return true;
    }).map(cloneOne);
}

/**
 * Get only definitions from source code.
 * Convenience wrapper around getSymbols with kindFilter='def'.
 */
export async function getDefinitions(source: string, langName: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
    return getSymbols(source, langName, { ...options, kindFilter: 'def' });
}

/**
 * Get a summary count of symbols by type for a file.
 *
 * @param source   - the source code
 * @param langName - tree-sitter language name
 */
export async function getSymbolSummary(source: string, langName: string): Promise<{ defs: Record<string, number>; refs: Record<string, number>; defTotal: number; refTotal: number } | null> {
    const symbols = await getSymbols(source, langName);
    if (!symbols) return null;

    const defs: Record<string, number> = {};
    const refs: Record<string, number> = {};
    let defTotal = 0, refTotal = 0;

    for (const sym of symbols) {
        if (sym.kind === 'def') {
            defs[sym.type] = (defs[sym.type] ?? 0) + 1;
            defTotal++;
        } else {
            refs[sym.type] = (refs[sym.type] ?? 0) + 1;
            refTotal++;
        }
    }

    return { defs, refs, defTotal, refTotal };
}

/**
 * Format a symbol summary as a compact string for directory listings.
 * E.g. "3 functions, 1 class, 2 methods" — definitions only.
 * Returns null if no definitions found or language not supported.
 */
export async function getSymbolSummaryString(source: string, langName: string): Promise<string | null> {
    const summary = await getSymbolSummary(source, langName);
    if (!summary || summary.defTotal === 0) return null;

    const parts: string[] = [];
    // Ordered by typical importance
    const order = ['class', 'interface', 'type', 'enum', 'function', 'method', 'module',
                   'key', 'section', 'selector', 'keyframes', 'media',
                   'variable', 'constant', 'property', 'object', 'mixin', 'extension',
                   'macro', 'resource', 'output', 'provider', 'local'];
    const used = new Set<string>();

    for (const t of order) {
        if (summary.defs[t]) {
            const count = summary.defs[t];
            const label = count === 1 ? t : pluralize(t);
            parts.push(`${count} ${label}`);
            used.add(t);
        }
    }

    // Any remaining types not in the order list
    for (const [t, count] of Object.entries(summary.defs)) {
        if (used.has(t)) continue;
        const label = count === 1 ? t : pluralize(t);
        parts.push(`${count} ${label}`);
    }

    return parts.length > 0 ? parts.join(', ') : null;
}

function pluralize(type: string): string {
    if (type.endsWith('s')) return type + 'es';
    if (type.endsWith('y')) return type.slice(0, -1) + 'ies';
    return type + 's';
}

/**
 * Find a specific symbol by name in source code.
 *
 * Supports dot-qualified names like "MyClass.sendMessage" — splits on '.'
 * and checks that the symbol named 'sendMessage' is contained within
 * a symbol named 'MyClass'.
 *
 * If multiple matches exist and nearLine is provided, sorts by proximity.
 * Otherwise returns all matches (caller decides whether to reject or pick).
 *
 * @param source      - the source code
 * @param langName    - tree-sitter language name
 * @param symbolName  - exact name or dot-qualified name
 * @param options     - optional filters
 */
export async function findSymbol(source: string, langName: string, symbolName: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
    const kindFilter = options.kindFilter ?? 'def';

    // Handle dot-qualified names: "MyClass.sendMessage"
    const parts = symbolName.split('.');
    const targetName = parts[parts.length - 1];  // innermost name
    const parentNames = parts.slice(0, -1);       // qualifying parents

    const { nameFilter: _, ...restOptions } = options;
    const allSymbols = await getSymbols(source, langName, { ...restOptions, kindFilter });
    if (!allSymbols) return null;

    // Find direct matches on the target name
    let matches = allSymbols.filter((s: SymbolInfo) => s.name === targetName);

    // If qualified, filter to only those nested inside the parent symbol(s)
    if (parentNames.length > 0 && matches.length > 0) {
        // For each parent level, find the parent symbol and check containment
        const allDefs = kindFilter === 'def' ? allSymbols :
            await getSymbols(source, langName, { kindFilter: 'def' });
        if (!allDefs) return matches; // can't verify parents, return unfiltered

        matches = matches.filter((sym: SymbolInfo) => {
            let current: SymbolInfo = sym;
            // Walk outward through parent qualifiers
            for (let i = parentNames.length - 1; i >= 0; i--) {
                const parentName = parentNames[i];
                // Find a definition that contains current's line range
                const parent = allDefs.find((d: SymbolInfo) =>
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

    // Sort by proximity to nearLine if specified
    if (matches.length > 1 && options.nearLine !== undefined) {
        const nearLine = options.nearLine;
        matches.sort((a: SymbolInfo, b: SymbolInfo) =>
            Math.abs(a.line - nearLine) - Math.abs(b.line - nearLine)
        );
    }

    return matches;
}

/**
 * Get symbols for a file by path. Reads the file, detects language, parses.
 * Convenience wrapper that handles the full file → symbols pipeline.
 *
 * @param filePath - absolute path to the file
 * @param options  - same options as getSymbols
 */
export async function getFileSymbols(filePath: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
    const langName = getLangForFile(filePath);
    if (!langName) return null;

    let source: string;
    try {
        source = await fs.readFile(filePath, 'utf-8');
    } catch {
        return null;
    }

    return getSymbols(source, langName, options);
}

/**
 * Get symbol summary string for a file by path.
 * Returns null if unsupported or no definitions found.
 */
export async function getFileSymbolSummary(filePath: string): Promise<string | null> {
    const langName = getLangForFile(filePath);
    if (!langName) return null;

    let source: string;
    try {
        const stat = await fs.stat(filePath);
        // Skip large files — parsing a 2MB file for a directory listing isn't worth it
        if (stat.size > 256 * 1024) return null;
        source = await fs.readFile(filePath, 'utf-8');
    } catch {
        return null;
    }

    return getSymbolSummaryString(source, langName);
}

/**
 * Parse source code and check for syntax errors.
 * Returns an array of { line, column } for each ERROR node found.
 * Returns null if the language is not supported.
 * Returns empty array if no errors detected.
 *
 * @param source   - the source code to check
 * @param langName - tree-sitter language name
 */
export async function checkSyntaxErrors(source: string, langName: string): Promise<Array<{ line: number; column: number }> | null> {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    if (!tree) return null;

    try {
        if (!tree.rootNode.hasError) {
            return [];
        }

        const errors: Array<{ line: number; column: number }> = [];
        const MAX_ERRORS = 10;

        function walk(node: Node): void {
            if (errors.length >= MAX_ERRORS) return;
            if (node.type === 'ERROR' || node.isMissing) {
                errors.push({
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column,
                });
            }
            for (let i = 0; i < node.childCount; i++) {
                if (errors.length >= MAX_ERRORS) return;
                const child = node.child(i);
                if (child) walk(child);
            }
        }

        walk(tree.rootNode);
        return errors;
    } finally {
        tree.delete();
        parser.delete();
    }
}
