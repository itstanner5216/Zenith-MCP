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

import { Parser, Language, Query } from 'web-tree-sitter';
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

const EXT_TO_LANG = {
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
export function getLangForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return EXT_TO_LANG[ext] || null;
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions() {
    return Object.keys(EXT_TO_LANG);
}

/**
 * Check if a file can be parsed by tree-sitter.
 */
export function isSupported(filePath) {
    return getLangForFile(filePath) !== null;
}

// ---------------------------------------------------------------------------
// Initialization & caching
// ---------------------------------------------------------------------------

let _initPromise = null;
const _languageCache = new Map();       // lang name → Language object (or null)
const _queryStringCache = new Map();    // lang name → raw .scm string (or null)
const _compiledQueryCache = new Map();  // lang name → Query object (or null)

// Symbol cache: hash(source) → Symbol[]
const SYMBOL_CACHE_MAX = 100;
const _symbolCache = new Map();         // hash → { symbols, ts }

/**
 * Initialize the tree-sitter WASM runtime. Idempotent.
 */
async function ensureInit() {
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
async function loadLanguage(langName) {
    if (_languageCache.has(langName)) {
        return _languageCache.get(langName);
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
        console.error(`Failed to load grammar for ${langName}:`, err.message);
        _languageCache.set(langName, null);
        return null;
    }
}

/**
 * Load the .scm query string for a language. Cached permanently.
 */
async function loadQueryString(langName) {
    if (_queryStringCache.has(langName)) {
        return _queryStringCache.get(langName);
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
async function getCompiledQuery(langName) {
    if (_compiledQueryCache.has(langName)) {
        return _compiledQueryCache.get(langName);
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
        console.error(`Failed to compile query for ${langName}:`, err.message);
        _compiledQueryCache.set(langName, null);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Symbol cache helpers
// ---------------------------------------------------------------------------

function sourceHash(source) {
    return createHash('md5').update(source).digest('hex');
}

function getCachedSymbols(hash) {
    const entry = _symbolCache.get(hash);
    if (entry) {
        entry.ts = Date.now(); // touch for LRU
        return entry.symbols;
    }
    return null;
}

function setCachedSymbols(hash, symbols) {
    // Evict oldest if at capacity
    if (_symbolCache.size >= SYMBOL_CACHE_MAX) {
        let oldestKey = null, oldestTs = Infinity;
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
 * @typedef {Object} Symbol
 * @property {string}  name     - Symbol identifier (e.g. 'sendMessage')
 * @property {string}  kind     - 'def' or 'ref'
 * @property {string}  type     - Symbol type: 'function', 'class', 'method',
 *                                'interface', 'type', 'enum', 'module',
 *                                'call', 'key', 'section', 'selector', etc.
 * @property {number}  line     - 1-based start line of the identifier
 * @property {number}  endLine  - 1-based end line of the full definition body
 * @property {number}  column   - 0-based column of the identifier
 */

/**
 * Extract all symbols from source code.
 *
 * Uses query.matches() to properly pair @name.definition.* captures with
 * their sibling @definition.* captures, giving us both the symbol name
 * and its full body extent.
 *
 * @param {string} source   - the source code
 * @param {string} langName - tree-sitter language name
 * @param {Object} [options]
 * @param {string} [options.nameFilter]   - substring filter on symbol name (case-insensitive)
 * @param {string} [options.kindFilter]   - 'def' or 'ref'
 * @param {string} [options.typeFilter]   - 'function', 'class', 'method', etc.
 * @param {string[]} [options.excludeNames] - exact names to exclude
 * @returns {Promise<Symbol[] | null>} null if language not supported or no query
 */
export async function getSymbols(source, langName, options = {}) {
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

    // Use matches() to get grouped captures per pattern match.
    // Each match contains both @name.definition.X and @definition.X captures.
    const matches = query.matches(tree.rootNode);
    const symbols = [];
    const seen = new Set();

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
        let kind, type;
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
        let endLine;
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
function applyFilters(symbols, options) {
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
export async function getDefinitions(source, langName, options = {}) {
    return getSymbols(source, langName, { ...options, kindFilter: 'def' });
}

const COMPRESSION_ANCHOR_RULES = {
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

function maybeAddAnchor(block, anchor) {
    if (!block.anchors) block.anchors = [];

    const existing = block.anchors.find(
        item => item.startLine === anchor.startLine && item.endLine === anchor.endLine
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

function assignAnchorToInnermostBlock(blocks, startLine, endLine, kind, priority) {
    let target = null;

    for (const block of blocks) {
        if (block.startLine > startLine || block.endLine < endLine) continue;
        if (!target || (block.endLine - block.startLine) < (target.endLine - target.startLine)) {
            target = block;
        }
    }

    if (!target || startLine <= target.startLine) return;

    maybeAddAnchor(target, { startLine, endLine, kind, priority });
}

function shouldCaptureAnchor(node, parent, rule) {
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

export async function getCompressionStructure(source, langName) {
    const defs = await getDefinitions(source, langName);
    if (!defs || defs.length === 0) return defs;

    const blocks = defs.map(d => ({
        type: d.type,
        name: d.name,
        startLine: d.line - 1,
        endLine: d.endLine - 1,
        exported: false,
        anchors: [],
    }));

    const rules = COMPRESSION_ANCHOR_RULES[langName];
    if (!rules) return blocks;

    const language = await loadLanguage(langName);
    if (!language) return blocks;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    try {
        function walk(node, parent = null) {
            const rule = rules[node.type];
            if (shouldCaptureAnchor(node, parent, rule)) {
                const startLine = node.startPosition.row;
                const rawEndLine = node.endPosition.row;
                const endLine = rawEndLine <= startLine + 1 ? rawEndLine : startLine;
                assignAnchorToInnermostBlock(blocks, startLine, endLine, rule.kind, rule.priority);
            }

            for (let i = 0; i < node.childCount; i++) {
                walk(node.child(i), node);
            }
        }

        walk(tree.rootNode, null);
    } finally {
        tree.delete();
        parser.delete();
    }

    for (const block of blocks) {
        if (block.anchors.length > 0) {
            block.anchors.sort((a, b) => b.priority - a.priority || a.startLine - b.startLine);
            block.anchors = block.anchors.slice(0, 16);
        }
    }

    return blocks;
}

/**
 * Get a summary count of symbols by type for a file.
 *
 * @param {string} source   - the source code
 * @param {string} langName - tree-sitter language name
 * @returns {Promise<{ defs: Object, refs: Object, defTotal: number, refTotal: number } | null>}
 */
export async function getSymbolSummary(source, langName) {
    const symbols = await getSymbols(source, langName);
    if (!symbols) return null;

    const defs = {};
    const refs = {};
    let defTotal = 0, refTotal = 0;

    for (const sym of symbols) {
        if (sym.kind === 'def') {
            defs[sym.type] = (defs[sym.type] || 0) + 1;
            defTotal++;
        } else {
            refs[sym.type] = (refs[sym.type] || 0) + 1;
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
export async function getSymbolSummaryString(source, langName) {
    const summary = await getSymbolSummary(source, langName);
    if (!summary || summary.defTotal === 0) return null;

    const parts = [];
    // Ordered by typical importance
    const order = ['class', 'interface', 'type', 'enum', 'function', 'method', 'module',
                   'key', 'section', 'selector', 'keyframes', 'media',
                   'variable', 'constant', 'property', 'object', 'mixin', 'extension',
                   'macro', 'resource', 'output', 'provider', 'local'];
    const used = new Set();

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

function pluralize(type) {
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
 * @param {string} source      - the source code
 * @param {string} langName    - tree-sitter language name
 * @param {string} symbolName  - exact name or dot-qualified name
 * @param {Object} [options]
 * @param {string} [options.kindFilter] - 'def' or 'ref' (default: 'def')
 * @param {number} [options.nearLine]   - prefer match closest to this line
 * @returns {Promise<Symbol[] | null>}  matched symbols sorted by relevance, or null
 */
export async function findSymbol(source, langName, symbolName, options = {}) {
    const kindFilter = options.kindFilter || 'def';

    // Handle dot-qualified names: "MyClass.sendMessage"
    const parts = symbolName.split('.');
    const targetName = parts[parts.length - 1];  // innermost name
    const parentNames = parts.slice(0, -1);       // qualifying parents

    const allSymbols = await getSymbols(source, langName, { kindFilter });
    if (!allSymbols) return null;

    // Find direct matches on the target name
    let matches = allSymbols.filter(s => s.name === targetName);

    // If qualified, filter to only those nested inside the parent symbol(s)
    if (parentNames.length > 0 && matches.length > 0) {
        // For each parent level, find the parent symbol and check containment
        const allDefs = kindFilter === 'def' ? allSymbols :
            await getSymbols(source, langName, { kindFilter: 'def' });
        if (!allDefs) return matches; // can't verify parents, return unfiltered

        matches = matches.filter(sym => {
            let current = sym;
            // Walk outward through parent qualifiers
            for (let i = parentNames.length - 1; i >= 0; i--) {
                const parentName = parentNames[i];
                // Find a definition that contains current's line range
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

    // Sort by proximity to nearLine if specified
    if (matches.length > 1 && options.nearLine) {
        matches.sort((a, b) =>
            Math.abs(a.line - options.nearLine) - Math.abs(b.line - options.nearLine)
        );
    }

    return matches;
}

/**
 * Get symbols for a file by path. Reads the file, detects language, parses.
 * Convenience wrapper that handles the full file → symbols pipeline.
 *
 * @param {string} filePath - absolute path to the file
 * @param {Object} [options] - same options as getSymbols
 * @returns {Promise<Symbol[] | null>}
 */
export async function getFileSymbols(filePath, options = {}) {
    const langName = getLangForFile(filePath);
    if (!langName) return null;

    let source;
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
export async function getFileSymbolSummary(filePath) {
    const langName = getLangForFile(filePath);
    if (!langName) return null;

    let source;
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
export async function treeSitterAvailable() {
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
 * @param {string} source   - the source code to check
 * @param {string} langName - tree-sitter language name
 * @returns {Promise<Array<{line: number, column: number}> | null>}
 */
export async function checkSyntaxErrors(source, langName) {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    try {
        const rootHasError = typeof tree.rootNode.hasError === 'function'
            ? tree.rootNode.hasError()
            : tree.rootNode.hasError;
        if (!rootHasError) {
            return [];
        }

        const errors = [];
        const MAX_ERRORS = 10;

        function walk(node) {
            if (errors.length >= MAX_ERRORS) return;
            const nodeMissing = typeof node.isMissing === 'function'
                ? node.isMissing()
                : node.isMissing;
            if (node.type === 'ERROR' || nodeMissing) {
                errors.push({
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column,
                });
            }
            for (let i = 0; i < node.childCount; i++) {
                if (errors.length >= MAX_ERRORS) return;
                walk(node.child(i));
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
 * @param {string} source    - full source code
 * @param {string} langName  - tree-sitter language name
 * @param {number} startLine - 1-based start line
 * @param {number} endLine   - 1-based end line
 * @returns {Promise<string[]>}
 */
export async function getStructuralFingerprint(source, langName, startLine, endLine) {
    const language = await loadLanguage(langName);
    if (!language) return [];

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    try {
        const nodeTypes = [];
        const startRow = startLine - 1;
        const endRow = endLine - 1;

        function walk(node) {
            if (node.startPosition.row >= startRow && node.startPosition.row <= endRow) {
                nodeTypes.push(node.type);
            }
            for (let i = 0; i < node.childCount; i++) {
                walk(node.child(i));
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
 * @param {string[]} fingerprintA
 * @param {string[]} fingerprintB
 * @returns {number}
 */
export function computeStructuralSimilarity(fingerprintA, fingerprintB) {
    function buildNgrams(arr, n) {
        const set = new Set();
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

/**
 * Extract a structural signature for the symbol whose definition spans
 * `startLine`..`endLine` (1-based, inclusive). Used by refactor_batch outlier
 * detection to flag occurrences whose shape differs from peers in the same
 * symbol group.
 *
 * Returns null if the language cannot be loaded or no matching def node is found.
 */
export async function getSymbolStructure(source, langName, startLine, endLine) {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

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

        let defNode = null;
        function findDef(node) {
            if (DEF_TYPES.has(node.type) &&
                node.startPosition.row === startRow &&
                node.endPosition.row === endRow) {
                defNode = node;
                return true;
            }
            for (let i = 0; i < node.childCount; i++) {
                if (findDef(node.child(i))) return true;
            }
            return false;
        }
        findDef(tree.rootNode);
        if (!defNode) return null;

        const params = [];
        function collectParams(node) {
            if (/parameters?$/.test(node.type) || node.type === 'formal_parameters') {
                for (let i = 0; i < node.childCount; i++) {
                    const c = node.child(i);
                    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
                    params.push(c.type);
                }
                return true;
            }
            for (let i = 0; i < node.childCount; i++) {
                if (collectParams(node.child(i))) return true;
            }
            return false;
        }
        collectParams(defNode);

        let returnKind = null;
        for (let i = 0; i < defNode.childCount; i++) {
            const c = defNode.child(i);
            const fieldName = defNode.fieldNameForChild ? defNode.fieldNameForChild(i) : null;
            if (fieldName === 'return_type' || /^type_annotation$|^return_type$/.test(c.type)) {
                returnKind = c.type;
                break;
            }
        }

        let parentKind = null;
        let p = defNode.parent;
        while (p) {
            if (DEF_TYPES.has(p.type) || p.type === 'program' || p.type === 'module' || p.type === 'source_file') {
                parentKind = p.type;
                break;
            }
            p = p.parent;
        }

        const decorators = [];
        if (defNode.parent) {
            const siblings = [];
            for (let i = 0; i < defNode.parent.childCount; i++) siblings.push(defNode.parent.child(i));
            const idx = siblings.indexOf(defNode);
            for (let i = idx - 1; i >= 0; i--) {
                if (siblings[i].type === 'decorator') decorators.unshift(siblings[i].type);
                else break;
            }
        }
        for (let i = 0; i < defNode.childCount; i++) {
            const c = defNode.child(i);
            if (c.type === 'decorator') decorators.push(c.type);
        }

        const MODIFIER_TYPES = new Set(['async', 'static', 'public', 'private', 'protected', 'readonly', '*']);
        const modifiers = new Set();
        function collectModifiers(node) {
            if (MODIFIER_TYPES.has(node.type)) modifiers.add(node.type);
            for (let i = 0; i < node.childCount; i++) collectModifiers(node.child(i));
        }
        for (let i = 0; i < defNode.childCount; i++) collectModifiers(defNode.child(i));

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
