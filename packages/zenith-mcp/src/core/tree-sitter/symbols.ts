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
// Definition node-type vocabulary
//
// DEF_TYPES is the canonical set of AST node types that can act as a
// definition container in our shipped tree-sitter tag queries. Every
// outermost node type that any *-tags.scm file places a `@definition.<kind>`
// or `@name.definition.<kind>` capture on appears here.
//
// This set is NOT hand-curated from intuition. It is derived from the
// shipped `packages/zenith-mcp/grammars/queries/*-tags.scm` files and is
// kept in sync by the regression test at
// `packages/zenith-mcp/tests/def-types-coverage.test.js`, which re-parses
// the shipped query files at test time and fails if any definition capture
// targets a node type missing from this set.
//
// To add coverage for a new language or a new pattern, add the relevant
// query patterns to the appropriate *-tags.scm file, then re-run the
// regression test — it will print the exact node types to append below.
//
// Keep the list alphabetical (case-sensitive ASCII) so diffs stay minimal.
// ---------------------------------------------------------------------------

export const DEF_TYPES: ReadonlySet<string> = new Set<string>([
    // XML/HTML element-shape patterns (PascalCase upstream node names)
    'Attribute',
    'EmptyElemTag',
    'STag',

    // Snake-case node types, alphabetical
    'abstract_class_declaration',
    'abstract_method_signature',
    'alias',
    'alias_declaration',
    'anchor',
    'annotation_type_declaration',
    'arg_instruction',
    // arrow_function: PR #23 hand-list entry — never a name-capture ancestor (selection unaffected), but structure.ts descent boundaries use it.
    'arrow_function',
    'assignment',
    'assignment_expression',
    'assignment_statement',
    'attribute',
    'attrset_expression',
    'atx_heading',
    'block',
    'block_mapping_pair',
    'capture',
    'class',
    'class_declaration',
    'class_definition',
    'class_selector',
    'class_specifier',
    'column_definition',
    'concept_definition',
    'const_declaration',
    'const_item',
    'const_spec',
    'constant_declaration',
    'constructor_declaration',
    'create_function_statement',
    'create_index_statement',
    'create_table_statement',
    'create_type_statement',
    'create_view_statement',
    'datasource_declaration',
    'declaration',
    'decorated_definition',
    'delegate_declaration',
    'directive_attribute',
    'directive_definition',
    'document',
    'element',
    'enum',
    'enum_constant',
    'enum_declaration',
    'enum_field',
    'enum_item',
    'enum_member_declaration',
    'enum_specifier',
    'enum_type_definition',
    'enum_type_extension',
    'enum_value_declaration',
    'enum_variant',
    'enumerator',
    'env_instruction',
    'event_declaration',
    'field',
    'field_declaration',
    'field_definition',
    'file_scoped_namespace_declaration',
    'flow_pair',
    'fragment_definition',
    'from_instruction',
    'function_declaration',
    'function_definition',
    'function_expression',
    'function_item',
    'function_signature',
    'generator_declaration',
    'generator_function',
    'generator_function_declaration',
    'id_selector',
    'impl_item',
    'inherit',
    'init_declaration',
    'input_object_type_definition',
    'interface_declaration',
    'interface_type_definition',
    'interface_type_extension',
    'keyframes_statement',
    'label_instruction',
    'let_expression',
    'lexical_declaration',
    'macro_definition',
    'media_statement',
    'message',
    'method',
    'method_declaration',
    'method_definition',
    'method_signature',
    'mixin_statement',
    'mod_item',
    'model_declaration',
    'module',
    'named_capturing_group',
    'named_node',
    'namespace_declaration',
    'namespace_definition',
    'object',
    'object_declaration',
    'object_type_definition',
    'object_type_extension',
    'oneof',
    'operation_definition',
    'pair',
    'placeholder',
    'preproc_def',
    'preproc_function_def',
    'property_declaration',
    'property_signature',
    'protocol_declaration',
    'public_field_definition',
    'rec_attrset_expression',
    'record_declaration',
    'rpc',
    'rule_set',
    'scalar_type_definition',
    'schema_definition',
    'service',
    'setext_heading',
    'short_var_declaration',
    'singleton_method',
    'static_item',
    'struct_declaration',
    'struct_item',
    'struct_specifier',
    'table',
    'table_array_element',
    'trait_declaration',
    'trait_item',
    'type_alias',
    'type_alias_declaration',
    'type_declaration',
    'type_definition',
    'type_item',
    'type_spec',
    'typealias_declaration',
    'union_item',
    'union_specifier',
    'union_type_definition',
    'var_spec',
    'variable_assignment',
    'variable_declaration',
    'variable_declarator',
]);

// ---------------------------------------------------------------------------
// Definition node selection
//
// `getSymbols()` historically picked the body node for a definition by
// taking whichever `@definition.<kind>` capture fired last inside a single
// tree-sitter match. That works when each `.scm` pattern carries exactly
// one definition capture, but it is fragile against nested or overlapping
// patterns: a parent definition can silently steal a child's source span,
// and any future signature-extraction code that walks `bodyCapture.node`'s
// children for `parameters` / `return_type` / `type_parameters` would
// inherit children that don't belong to it.
//
// `selectDefinitionNode()` replaces that policy with a deterministic
// ancestor walk: from the name node outward, collect every DEF_TYPES-typed
// ancestor; the tightest is the primary definition; if a strictly-outer
// ancestor is a known wrapper around the primary's type, that wrapper is
// the span node. Primary is what you walk for parameters/return shape;
// span is what you use for the full user-visible range (including any
// leading decorator prefix).
// ---------------------------------------------------------------------------

/**
 * Result of {@link selectDefinitionNode}. Carries two views of the owning
 * definition so different consumers can pick the right one:
 *
 * - `primaryNode` — the tightest DEF_TYPES-typed ancestor of the name.
 *   The place where the definition's parameters, return type, and type
 *   parameters live. Walk this when extracting signature shape; a parent
 *   container cannot accidentally contribute its own children here.
 *
 * - `spanNode` — the wrapper that sits as the IMMEDIATE AST parent of
 *   `primaryNode` and contributes leading metadata to the source span
 *   (today: Python's `decorated_definition` over a `function_definition`
 *   or `class_definition`). Equal to `primaryNode` whenever no wrapper
 *   applies, or whenever the wrapper does not directly wrap the primary
 *   in the AST. Use this when you want the full user-visible range of
 *   the definition including its decorators.
 *
 *   The "direct AST parent only" rule prevents an outer wrapper from
 *   incorrectly attaching to a nested inner definition. For example, in
 *   `@deco\nclass C:\n    def m(self): ...`, `m`'s `primaryNode` is the
 *   inner `function_definition`, but its `spanNode` is also that same
 *   `function_definition` — NOT the outer `decorated_definition` (which
 *   wraps the class, not the method).
 *
 * - `candidates` — the innermost-first list of DEF_TYPES ancestors that
 *   were considered, exposed for diagnostics and tests.
 */
export interface DefinitionNodeSelection {
    primaryNode: Node;
    spanNode: Node;
    candidates: ReadonlyArray<Node>;
}

/**
 * Known wrapper definition types and the set of inner definition types
 * each is allowed to wrap. A wrapper carries leading metadata (decorators,
 * export modifiers) and surrounds a real definition that holds the
 * parameters and return shape.
 *
 * Conservatively populated — only entries that appear in the shipped
 * `*-tags.scm` files belong here. Extend when grammars introduce
 * additional wrapper conventions.
 */
const WRAPPER_DEFINITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
    ['decorated_definition', new Set<string>(['function_definition', 'class_definition'])],
]);

/**
 * Deterministically pick the definition node that owns `nameNode`.
 *
 * Walks every DEF_TYPES-typed ancestor of `nameNode` from inside out,
 * returns the tightest as `primaryNode`. If any strictly-outer ancestor
 * is a known wrapper around `primaryNode`'s type, that wrapper is
 * returned as `spanNode` (otherwise `spanNode === primaryNode`).
 *
 * Returns `null` if `nameNode` has no DEF_TYPES ancestor — the caller
 * should fall back to its own span source (the body capture, or the
 * name node's own range).
 */
export function selectDefinitionNode(nameNode: Node): DefinitionNodeSelection | null {
    const candidates: Node[] = [];
    let cur: Node | null = nameNode.parent;
    while (cur !== null) {
        if (DEF_TYPES.has(cur.type)) {
            candidates.push(cur);
        }
        cur = cur.parent;
    }
    if (candidates.length === 0) return null;

    // candidates is non-empty (just checked); the `!` is erased at compile
    // time and preserves runtime exactly.
    const primary = candidates[0]!;
    let span: Node = primary;

    // Wrapper handling: only the IMMEDIATE AST parent can promote the span.
    // This rules out the "outer wrapper attaches to a nested inner def"
    // false positive (e.g. a `decorated_definition` wrapping a class would
    // otherwise also attach to that class's methods, because methods have
    // the wrapper's allowed inner type `function_definition` — yet the
    // wrapper does not actually wrap them).
    const directParent = primary.parent;
    if (directParent !== null) {
        const wrapInners = WRAPPER_DEFINITIONS.get(directParent.type);
        if (wrapInners && wrapInners.has(primary.type)) {
            span = directParent;
        }
    }

    return { primaryNode: primary, spanNode: span, candidates };
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

            // endLine source-of-truth ranking, most preferred first:
            //
            // 1. For definitions: walk DEF_TYPES ancestors of the name node
            //    and use the primary (tightest) ancestor's end. This is
            //    deterministic, span-tight, and never lets a parent
            //    container's range bleed into the symbol — a method inside
            //    a class gets the method's own end, not the class's end.
            // 2. The body capture from the `.scm` pattern, if present.
            //    Used for references (the selection function is
            //    definition-only) and as a fallback when the name node
            //    has no DEF_TYPES ancestor (malformed-pattern edge case).
            // 3. The name node's own end (single-line symbol).
            let endLine: number;
            if (kind === 'def') {
                const selected = selectDefinitionNode(nameCapture.node);
                if (selected) {
                    endLine = selected.primaryNode.endPosition.row + 1;
                } else if (bodyCapture) {
                    endLine = bodyCapture.node.endPosition.row + 1;
                } else {
                    endLine = nameCapture.node.endPosition.row + 1;
                }
            } else if (bodyCapture) {
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
 * Returns an array of { line, column, kind } for each ERROR/MISSING node
 * found, where `kind` is the name tree-sitter gives the breakage: `ERROR`
 * for error nodes, `MISSING <type>` (anonymous token types quoted) for
 * missing nodes.
 * Returns null if the language is not supported.
 * Returns empty array if no errors detected.
 *
 * @param source   - the source code to check
 * @param langName - tree-sitter language name
 */
export async function checkSyntaxErrors(source: string, langName: string): Promise<Array<{ line: number; column: number; kind: string }> | null> {
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

        const errors: Array<{ line: number; column: number; kind: string }> = [];
        const MAX_ERRORS = 10;

        function walk(node: Node): void {
            if (errors.length >= MAX_ERRORS) return;
            if (node.type === 'ERROR' || node.isMissing) {
                errors.push({
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column,
                    kind: node.isMissing
                        ? `MISSING ${node.isNamed ? node.type : `"${node.type}"`}`
                        : 'ERROR',
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
