// ---------------------------------------------------------------------------
// tree-sitter.js — Shared tree-sitter module for symbol-aware tools
//
// Provides:
//   1. Lazy initialization of web-tree-sitter WASM runtime
//   2. Grammar loading by file extension (cached after first load)
//   3. Query file loading (.scm patterns) per language
//   4. getSymbols()      — extract symbols (definitions + references) from source
//   5. getDefinitions()  — convenience: only definitions
//   6. getSymbolSummary()— count symbols by type for a file
//   7. findSymbol()      — find a specific symbol by name, with disambiguation
//   8. isSupported()     — check if tree-sitter supports a file extension
//
// Grammars:  ./grammars/grammars/tree-sitter-{lang}.wasm
// Queries:   ./grammars/queries/{lang}-tags.scm
// Runtime:   ./grammars/tree-sitter.wasm
//
// All loading is lazy. Nothing is loaded until first use.
// Language objects and compiled queries are cached permanently.
// Parsed symbols are cached by source hash (LRU, 100 entries).
// ---------------------------------------------------------------------------

import { Parser, Language, Query, Node } from 'web-tree-sitter';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const GRAMMARS_DIR = path.join(__dirname, '..', 'grammars', 'grammars');
const QUERIES_DIR  = path.join(__dirname, '..', 'grammars', 'queries');
const TS_WASM_PATH = path.join(__dirname, '..', 'grammars', 'tree-sitter.wasm');

// ---------------------------------------------------------------------------
// Extension → language mapping
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
    // JavaScript / TypeScript
    '.js':   'javascript',
    '.mjs':  'javascript',
    '.cjs':  'javascript',
    '.jsx':  'javascript',
    '.ts':   'typescript',
    '.mts':  'typescript',
    '.cts':  'typescript',
    '.tsx':  'tsx',
    // Python
    '.py':   'python',
    '.pyi':  'python',
    // Shell
    '.sh':   'bash',
    '.bash': 'bash',
    '.zsh':  'bash',
    // Go
    '.go':   'go',
    // Rust
    '.rs':   'rust',
    // Java
    '.java': 'java',
    // C / C++
    '.c':    'c',
    '.h':    'c',
    '.cpp':  'cpp',
    '.cc':   'cpp',
    '.cxx':  'cpp',
    '.hpp':  'cpp',
    '.hh':   'cpp',
    '.hxx':  'cpp',
    // C#
    '.cs':   'csharp',
    // Kotlin
    '.kt':   'kotlin',
    '.kts':  'kotlin',
    // PHP
    '.php':  'php',
    // Ruby
    '.rb':     'ruby',
    '.rake':   'ruby',
    '.gemspec': 'ruby',
    // Swift
    '.swift': 'swift',
    // Web
    '.css':  'css',
    '.scss': 'css',
    // Data formats
    '.json':  'json',
    '.jsonc': 'json',
    '.yaml':  'yaml',
    '.yml':   'yaml',
    '.sql':   'sql',
    // Documentation
    '.md':  'markdown',
    '.mdx': 'markdown',
};

/**
 * Get the tree-sitter language name for a file path.
 * Returns null if the extension is not supported.
 */
export function getLangForFile(filePath?: string): string | null {
    const ext = path.extname(filePath ?? '').toLowerCase();
    return EXT_TO_LANG[ext] ?? null;
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions(): string[] {
    return Object.keys(EXT_TO_LANG);
}

/**
 * Check if a file can be parsed by tree-sitter.
 */
export function isSupported(filePath: string): boolean {
    return getLangForFile(filePath) !== null;
}

// ---------------------------------------------------------------------------
// Initialization & caching
// ---------------------------------------------------------------------------

let _initPromise: Promise<void> | null = null;
const _languageCache: Map<string, Language | null> = new Map();
const _queryStringCache: Map<string, string | null> = new Map();
const _compiledQueryCache: Map<string, Query | null> = new Map();

// Symbol cache: hash(source) → Symbol[]
const SYMBOL_CACHE_MAX = 100;

interface SymbolCacheEntry {
    symbols: SymbolInfo[];
    ts: number;
}

const _symbolCache: Map<string, SymbolCacheEntry> = new Map();

/**
 * Initialize the tree-sitter WASM runtime. Idempotent.
 */
async function ensureInit(): Promise<void> {
    if (!_initPromise) {
        _initPromise = Parser.init({
            locateFile: () => TS_WASM_PATH,
        });
    }
    return _initPromise;
}

/**
 * Load a Language grammar (WASM), cached permanently.
 * Returns null if the grammar file doesn't exist.
 */
async function loadLanguage(langName: string): Promise<Language | null> {
    if (_languageCache.has(langName)) {
        return _languageCache.get(langName) ?? null;
    }

    await ensureInit();

    const wasmPath = path.join(GRAMMARS_DIR, `tree-sitter-${langName}.wasm`);
    try {
        await fs.access(wasmPath);
    } catch {
        _languageCache.set(langName, null);
        return null;
    }

    try {
        const language = await Language.load(wasmPath);
        _languageCache.set(langName, language);
        return language;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to load grammar for ${langName}:`, message);
        _languageCache.set(langName, null);
        return null;
    }
}

/**
 * Load the .scm query string for a language. Cached permanently.
 */
async function loadQueryString(langName: string): Promise<string | null> {
    if (_queryStringCache.has(langName)) {
        return _queryStringCache.get(langName) ?? null;
    }

    const scmPath = path.join(QUERIES_DIR, `${langName}-tags.scm`);
    try {
        const content = await fs.readFile(scmPath, 'utf-8');
        _queryStringCache.set(langName, content);
        return content;
    } catch {
        _queryStringCache.set(langName, null);
        return null;
    }
}

/**
 * Get a compiled Query object for a language. Cached permanently.
 * Returns null if language or query unavailable.
 */
async function getCompiledQuery(langName: string): Promise<Query | null> {
    if (_compiledQueryCache.has(langName)) {
        return _compiledQueryCache.get(langName) ?? null;
    }

    const language = await loadLanguage(langName);
    if (!language) {
        _compiledQueryCache.set(langName, null);
        return null;
    }

    const queryString = await loadQueryString(langName);
    if (!queryString) {
        _compiledQueryCache.set(langName, null);
        return null;
    }

    try {
        const query = new Query(language, queryString);
        _compiledQueryCache.set(langName, query);
        return query;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to compile query for ${langName}:`, message);
        _compiledQueryCache.set(langName, null);
        return null;
    }
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

    if (!tree) return null;

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

    // Clean up parse tree and parser (query is cached, don't delete it)
    tree.delete();
    parser.delete();

    // Sort by line number
    symbols.sort((a, b) => a.line - b.line);

    // Cache the full unfiltered result
    setCachedSymbols(hash, symbols);

    return applyFilters(symbols, options);
}

/**
 * Apply optional filters to a symbol list.
 */
function applyFilters(symbols: SymbolInfo[], options: SymbolFilterOptions): SymbolInfo[] {
    if (!options.kindFilter && !options.nameFilter && !options.typeFilter && !options.excludeNames) {
        return symbols;
    }

    return symbols.filter(sym => {
        if (options.kindFilter && sym.kind !== options.kindFilter) return false;
        if (options.typeFilter && sym.type !== options.typeFilter) return false;
        if (options.nameFilter && !sym.name.toLowerCase().includes(options.nameFilter.toLowerCase())) return false;
        if (options.excludeNames && options.excludeNames.includes(sym.name)) return false;
        return true;
    });
}

/**
 * Get only definitions from source code.
 * Convenience wrapper around getSymbols with kindFilter='def'.
 */
export async function getDefinitions(source: string, langName: string, options: SymbolFilterOptions = {}): Promise<SymbolInfo[] | null> {
    return getSymbols(source, langName, { ...options, kindFilter: 'def' });
}

interface AnchorRule {
    kind: string;
    priority: number;
}

interface AnchorRuleMap {
    [nodeType: string]: AnchorRule;
}

interface AnchorEntry {
    startLine: number;
    endLine: number;
    kind: string;
    priority: number;
}

interface BlockEntry {
    type: string;
    name: string;
    startLine: number;
    endLine: number;
    exported: boolean;
    anchors: AnchorEntry[];
}

const COMPRESSION_ANCHOR_RULES: Record<string, AnchorRuleMap> = {
    javascript: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        for_in_statement: { kind: 'loop', priority: 250 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
        call_expression: { kind: 'call', priority: 140 },
    },
    typescript: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        for_in_statement: { kind: 'loop', priority: 250 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
        call_expression: { kind: 'call', priority: 140 },
    },
    tsx: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        for_in_statement: { kind: 'loop', priority: 250 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
        call_expression: { kind: 'call', priority: 140 },
    },
    python: {
        return_statement: { kind: 'return', priority: 400 },
        raise_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        elif_clause: { kind: 'if', priority: 310 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        try_statement: { kind: 'try', priority: 280 },
        except_clause: { kind: 'catch', priority: 270 },
        with_statement: { kind: 'with', priority: 220 },
        await: { kind: 'await', priority: 180 },
        call: { kind: 'call', priority: 140 },
    },
};

function maybeAddAnchor(block: BlockEntry, anchor: AnchorEntry): void {
    if (!block.anchors) block.anchors = [];

    const existing = block.anchors.find(
        (item: AnchorEntry) => item.startLine === anchor.startLine && item.endLine === anchor.endLine
    );

    if (existing) {
        if (anchor.priority > existing.priority) {
            existing.priority = anchor.priority;
            existing.kind = anchor.kind;
        }
        return;
    }

    block.anchors.push(anchor);
}

function assignAnchorToInnermostBlock(blocks: BlockEntry[], startLine: number, endLine: number, kind: string, priority: number): void {
    let target: BlockEntry | null = null;

    for (const block of blocks) {
        if (block.startLine > startLine || block.endLine < endLine) continue;
        if (!target || (block.endLine - block.startLine) < (target.endLine - target.startLine)) {
            target = block;
        }
    }

    if (!target || startLine <= target.startLine) return;

    maybeAddAnchor(target, { startLine, endLine, kind, priority });
}

function shouldCaptureAnchor(node: Node, parent: Node | null, rule: AnchorRule | undefined): boolean {
    if (node.type === 'call_expression' && parent && (
        parent.type === 'call_expression' ||
        parent.type === 'await_expression' ||
        parent.type === 'expression_statement'
    )) {
        return false;
    }

    if (node.type === 'call' && parent && parent.type === 'await') {
        return false;
    }

    return !!rule;
}

export async function getCompressionStructure(source?: string, langName?: string): Promise<BlockEntry[] | null> {
    const defs = await getDefinitions(source ?? '', langName ?? '');
    if (!defs) return null;
    if (defs.length === 0) return [];

    const blocks: BlockEntry[] = defs.map((d: SymbolInfo) => ({
        type: d.type,
        name: d.name,
        startLine: d.line - 1,
        endLine: d.endLine - 1,
        exported: false,
        anchors: [],
    }));

    const rulesOrUndef = langName !== undefined ? COMPRESSION_ANCHOR_RULES[langName] : undefined;
    if (!rulesOrUndef) return blocks;
    const rules: AnchorRuleMap = rulesOrUndef;

    const language = await loadLanguage(langName ?? '');
    if (!language) return blocks;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source ?? '');

    if (!tree) return blocks;

    try {
        function walk(node: Node, parent: Node | null = null): void {
            const rule = rules[node.type];
            if (shouldCaptureAnchor(node, parent, rule)) {
                const startLine = node.startPosition.row;
                const rawEndLine = node.endPosition.row;
                const endLine = rawEndLine <= startLine + 1 ? rawEndLine : startLine;
                assignAnchorToInnermostBlock(blocks, startLine, endLine, rule.kind, rule.priority);
            }

            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child) walk(child, node);
            }
        }

        walk(tree.rootNode, null);
    } finally {
        tree.delete();
        parser.delete();
    }

    for (const block of blocks) {
        if (block.anchors.length > 0) {
            block.anchors.sort((a: AnchorEntry, b: AnchorEntry) => b.priority - a.priority || a.startLine - b.startLine);
            block.anchors = block.anchors.slice(0, 16);
        }
    }

    return blocks;
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

    const allSymbols = await getSymbols(source, langName, { kindFilter });
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
 * Check if tree-sitter is available (runtime can init, grammars exist).
 */
export async function treeSitterAvailable(): Promise<boolean> {
    try {
        await ensureInit();
        const files = await fs.readdir(GRAMMARS_DIR);
        return files.some(f => f.endsWith('.wasm'));
    } catch {
        return false;
    }
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
        // Compat shim for older web-tree-sitter where hasError was a method, not a getter
        const rootHasError = typeof tree.rootNode.hasError === 'function'
            ? (tree.rootNode.hasError as unknown as () => boolean)()
            : tree.rootNode.hasError;
        if (!rootHasError) {
            return [];
        }

        const errors: Array<{ line: number; column: number }> = [];
        const MAX_ERRORS = 10;

        function walk(node: Node): void {
            if (errors.length >= MAX_ERRORS) return;
            // Compat shim for older web-tree-sitter where isMissing was a method, not a getter.
            // Symmetric to the hasError shim above. Required for runtime correctness on legacy
            // versions where reading the property would yield a function reference (always truthy)
            // rather than the actual missing-node boolean.
            const nodeMissing: boolean = typeof node.isMissing === 'function'
                ? (node.isMissing as unknown as () => boolean)()
                : node.isMissing;
            if (node.type === 'ERROR' || nodeMissing) {
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

/**
 * Compute a structural fingerprint for a range of source lines.
 * Returns an ordered array of AST node types for all nodes whose start row
 * falls within [startLine-1, endLine-1].
 *
 * @param source    - full source code
 * @param langName  - tree-sitter language name
 * @param startLine - 1-based start line
 * @param endLine   - 1-based end line
 */
export async function getStructuralFingerprint(source: string, langName: string, startLine: number, endLine: number): Promise<string[]> {
    const language = await loadLanguage(langName);
    if (!language) return [];

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    if (!tree) return [];

    try {
        const nodeTypes: string[] = [];
        const startRow = startLine - 1;
        const endRow = endLine - 1;

        function walk(node: Node): void {
            if (node.startPosition.row >= startRow && node.startPosition.row <= endRow) {
                nodeTypes.push(node.type);
            }
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child) walk(child);
            }
        }

        walk(tree.rootNode);
        return nodeTypes;
    } finally {
        tree.delete();
        parser.delete();
    }
}

/**
 * Compute Jaccard similarity between two structural fingerprints using 3-grams.
 * Returns a score from 0.0 to 1.0.
 *
 * @param fingerprintA
 * @param fingerprintB
 */
export function computeStructuralSimilarity(fingerprintA: string[], fingerprintB: string[]): number {
    function buildNgrams(arr: string[], n: number): Set<string> {
        const set = new Set<string>();
        for (let i = 0; i <= arr.length - n; i++) {
            set.add(arr.slice(i, i + n).join('\x00'));
        }
        return set;
    }

    const gramsA = buildNgrams(fingerprintA, 3);
    const gramsB = buildNgrams(fingerprintB, 3);

    if (gramsA.size === 0 && gramsB.size === 0) return 1.0;
    if (gramsA.size === 0 || gramsB.size === 0) return 0.0;

    let intersection = 0;
    for (const g of gramsA) {
        if (gramsB.has(g)) intersection++;
    }

    const union = gramsA.size + gramsB.size - intersection;
    return union === 0 ? 0.0 : intersection / union;
}

interface SymbolStructure {
    params: string[];
    returnKind: string | null;
    parentKind: string | null;
    decorators: string[];
    modifiers: string[];
}

/**
 * Extract a structural signature for the symbol whose definition spans
 * `startLine`..`endLine` (1-based, inclusive). Used by refactor_batch outlier
 * detection to flag occurrences whose shape differs from peers in the same
 * symbol group.
 *
 * Returns null if the language cannot be loaded or no matching def node is found.
 */
export async function getSymbolStructure(source: string, langName: string, startLine: number, endLine: number): Promise<SymbolStructure | null> {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    if (!tree) return null;

    try {
        const startRow = startLine - 1;
        const endRow = endLine - 1;

        const DEF_TYPES = new Set([
            'function_declaration', 'function_definition', 'method_definition',
            'arrow_function', 'function', 'method',
            'class_declaration', 'class_definition',
            'function_signature', 'method_signature',
            'lexical_declaration', 'variable_declaration',
        ]);

        let defNode: Node | null = null;
        function findDef(node: Node): boolean {
            if (DEF_TYPES.has(node.type) &&
                node.startPosition.row === startRow &&
                node.endPosition.row === endRow) {
                defNode = node;
                return true;
            }
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && findDef(child)) return true;
            }
            return false;
        }
        findDef(tree.rootNode);
        if (!defNode) return null;

        // defNode is Node here (TypeScript narrowed it above via null check)
        const foundNode: Node = defNode;

        const params: string[] = [];
        function collectParams(node: Node): boolean {
            if (/parameters?$/.test(node.type) || node.type === 'formal_parameters') {
                for (let i = 0; i < node.childCount; i++) {
                    const c = node.child(i);
                    if (!c) continue;
                    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
                    params.push(c.type);
                }
                return true;
            }
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && collectParams(child)) return true;
            }
            return false;
        }
        collectParams(foundNode);

        let returnKind: string | null = null;
        for (let i = 0; i < foundNode.childCount; i++) {
            const c = foundNode.child(i);
            if (!c) continue;
            const fieldName = foundNode.fieldNameForChild ? foundNode.fieldNameForChild(i) : null;
            if (fieldName === 'return_type' || /^type_annotation$|^return_type$/.test(c.type)) {
                returnKind = c.type;
                break;
            }
        }

        let parentKind: string | null = null;
        let p: Node | null = foundNode.parent;
        while (p) {
            if (DEF_TYPES.has(p.type) || p.type === 'program' || p.type === 'module' || p.type === 'source_file') {
                parentKind = p.type;
                break;
            }
            p = p.parent;
        }

        const decorators: string[] = [];
        if (foundNode.parent) {
            const siblings: Node[] = [];
            for (let i = 0; i < foundNode.parent.childCount; i++) {
                const sibling = foundNode.parent.child(i);
                if (sibling) siblings.push(sibling);
            }
            const idx = siblings.indexOf(foundNode);
            for (let i = idx - 1; i >= 0; i--) {
                if (siblings[i].type === 'decorator') decorators.unshift(siblings[i].type);
                else break;
            }
        }
        for (let i = 0; i < foundNode.childCount; i++) {
            const c = foundNode.child(i);
            if (c && c.type === 'decorator') decorators.push(c.type);
        }

        const MODIFIER_TYPES = new Set(['async', 'static', 'public', 'private', 'protected', 'readonly', '*']);
        const modifiers = new Set<string>();
        function collectModifiers(node: Node): void {
            if (MODIFIER_TYPES.has(node.type)) modifiers.add(node.type);
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child) collectModifiers(child);
            }
        }
        for (let i = 0; i < foundNode.childCount; i++) {
            const child = foundNode.child(i);
            if (child) collectModifiers(child);
        }

        return {
            params,
            returnKind,
            parentKind,
            decorators,
            modifiers: [...modifiers].sort(),
        };
    } finally {
        tree.delete();
        parser.delete();
    }
}
