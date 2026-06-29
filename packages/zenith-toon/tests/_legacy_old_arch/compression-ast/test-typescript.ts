import { Parser, Node } from 'web-tree-sitter';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
    loadLanguage,
    getCompiledQuery,
    SYMBOL_CACHE_MAX,
import { getLangForFile } from './languages.js';
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
// ... [lines 43-48 omitted]
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
// ... [lines 73-93 omitted]
export async function getSymbols(source: string, langName: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
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
            // ... [lines 133-138 omitted]
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
            let endLine: number;
            // ... [lines 161-167 omitted]
            const key = `${name}:${kind}:${line}`;
        // ... [lines 169-180 omitted]
        return applyFilters(symbols, options);
    } finally {
        // Clean up parse tree and parser (query is cached, don't delete it)
        tree.delete();
        parser.delete();
    }
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
// ... [lines 205-210 omitted]
export async function getDefinitions(source: string, langName: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
// ... [lines 212-220 omitted]
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
// ... [lines 241-246 omitted]
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
        // ... [lines 265-270 omitted]
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
// ... [lines 283-298 omitted]
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
        const allDefs = kindFilter === 'def' ? allSymbols :
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
 // ... [lines 349-354 omitted]
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
 // ... [lines 367-372 omitted]
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
// ... [lines 391-401 omitted]
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
