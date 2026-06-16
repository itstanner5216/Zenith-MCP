// ---------------------------------------------------------------------------
// tree-sitter/structure.ts — Per-symbol structural shape extraction
//
// Invariant: Operates on a pre-parsed tree node. Does NOT parse source itself.
// Consumers must pass the rootNode from a shared parse in extract.ts.
// No imports from db-adapter or symbol-index — pure AST walk.
// ---------------------------------------------------------------------------

import type { Node } from 'web-tree-sitter';
import { DEF_TYPES } from './symbols.js';

export interface SymbolStructure {
    params: string[];           // child node types inside parameters/formal_parameters
    returnKind: string | null;  // node type of return_type/type_annotation child
    parentKind: string | null;  // enclosing scope node type
    decorators: string[];       // decorator/annotation node types preceding the def
    modifiers: string[];        // sorted modifier keywords (public/private/static/async/etc.)
}

/**
 * Per-language parameter-container node-type map.
 *
 * Replaces the previous single global PARAM_CONTAINER_TYPES set with true
 * per-language tables derived from the shipped tree-sitter grammars. The
 * generic union (PARAM_CONTAINER_FALLBACK) remains as the fall-through for
 * any language not covered — it cannot be more wrong than the prior code.
 *
 * Sourced from inspection of the relevant grammar node-type catalogs:
 *   python:     `parameters` (def + lambda use the same node)
 *   typescript: `formal_parameters` + `type_parameters` for generics
 *   tsx:        same as typescript
 *   javascript: `formal_parameters`
 *   rust:       `parameters` (fn) + `type_parameters` (generics) + `closure_parameters`
 *   go:         `parameter_list` + `type_parameter_list`
 *   java:       `formal_parameters` + `type_parameters` + `receiver_parameter`
 *   c_sharp:    `parameter_list` + `type_parameter_list` + `bracketed_parameter_list`
 *   c / cpp:    `parameter_list` + `template_parameter_list`
 *   kotlin:     `function_value_parameters` + `type_parameters`
 *   php:        `formal_parameters`
 *   ruby:       `method_parameters` + `block_parameters` + `lambda_parameters`
 *   swift:      `parameter_clause` + `generic_parameter_clause`
 *   bash:       (functions have no formal parameter node) — empty set; falls through cleanly
 *   lua:        `parameters`
 *   nix:        `formals` (function set patterns) + `identifier` (single-arg lambdas)
 *   scss:       `arguments`
 */
const PARAM_CONTAINER_FALLBACK: ReadonlySet<string> = new Set([
    'parameters', 'formal_parameters', 'parameter_list',
    'parameter_declaration', 'type_parameters', 'type_parameter_list',
    'template_parameter_list', 'function_value_parameters',
    'method_parameters', 'block_parameters', 'lambda_parameters',
    'closure_parameters', 'parameter_clause', 'generic_parameter_clause',
    'bracketed_parameter_list', 'receiver_parameter', 'formals', 'arguments',
]);

const PARAM_CONTAINERS_BY_LANG: Readonly<Record<string, ReadonlySet<string>>> = {
    python:     new Set(['parameters']),
    typescript: new Set(['formal_parameters', 'type_parameters']),
    tsx:        new Set(['formal_parameters', 'type_parameters']),
    javascript: new Set(['formal_parameters']),
    rust:       new Set(['parameters', 'type_parameters', 'closure_parameters']),
    go:         new Set(['parameter_list', 'type_parameter_list']),
    java:       new Set(['formal_parameters', 'type_parameters', 'receiver_parameter']),
    c_sharp:    new Set(['parameter_list', 'type_parameter_list', 'bracketed_parameter_list']),
    c:          new Set(['parameter_list']),
    cpp:        new Set(['parameter_list', 'template_parameter_list']),
    kotlin:     new Set(['function_value_parameters', 'type_parameters']),
    php:        new Set(['formal_parameters']),
    ruby:       new Set(['method_parameters', 'block_parameters', 'lambda_parameters']),
    swift:      new Set(['parameter_clause', 'generic_parameter_clause']),
    bash:       new Set<string>(),
    lua:        new Set(['parameters']),
    nix:        new Set(['formals']),
    scss:       new Set(['arguments']),
};

export function paramContainersFor(langName: string): ReadonlySet<string> {
    return PARAM_CONTAINERS_BY_LANG[langName] ?? PARAM_CONTAINER_FALLBACK;
}

/**
 * Wrapper definition types → the inner definition node types each may wrap.
 *
 * A "wrapper" is a definition node that carries only leading metadata
 * (decorators / export modifiers) around the real definition that holds the
 * signature. The indexer passes selectDefinitionNode().spanNode, so a
 * decorated Python def arrives here as its `decorated_definition` wrapper;
 * its params live on the inner `function_definition` / `class_definition`.
 *
 * This intentionally mirrors the canonical WRAPPER_DEFINITIONS table in
 * symbols.ts (the authority that produced the spanNode). That table is a
 * module-private const there, so structure.ts keeps its own copy rather than
 * widening symbols.ts's public surface. Keep the two in sync; the param test
 * pins the decorated-def behavior that depends on this entry.
 */
const WRAPPER_DEFINITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
    ['decorated_definition', new Set<string>(['function_definition', 'class_definition'])],
]);

/**
 * Per-language modifier-keyword overrides. The global MODIFIER_KEYWORDS set
 * stays as the default. Languages whose modifier vocabulary is materially
 * different (rust's `pub`/`unsafe`, kotlin's `open`/`suspend`/`inline`,
 * php's `final`/`readonly`, etc.) extend it. Extraction code below unions
 * the language map with the global set so we never lose a generic keyword.
 */
const MODIFIER_KEYWORDS_BY_LANG: Readonly<Record<string, ReadonlySet<string>>> = {
    rust:    new Set(['pub', 'unsafe', 'async', 'const', 'extern', 'default', 'mut']),
    kotlin:  new Set(['public', 'private', 'protected', 'internal', 'open', 'final',
                       'abstract', 'override', 'suspend', 'inline', 'noinline', 'crossinline',
                       'tailrec', 'operator', 'infix', 'external', 'lateinit', 'data',
                       'sealed', 'companion', 'enum', 'annotation']),
    php:     new Set(['public', 'private', 'protected', 'static', 'abstract', 'final', 'readonly']),
    java:    new Set(['public', 'private', 'protected', 'static', 'abstract', 'final',
                       'synchronized', 'native', 'strictfp', 'default', 'sealed', 'non-sealed']),
    c_sharp: new Set(['public', 'private', 'protected', 'internal', 'static', 'abstract',
                       'sealed', 'virtual', 'override', 'async', 'unsafe', 'extern',
                       'readonly', 'partial', 'new', 'volatile']),
    swift:   new Set(['public', 'private', 'fileprivate', 'internal', 'open',
                       'static', 'class', 'final', 'override', 'mutating', 'nonmutating',
                       'lazy', 'weak', 'unowned', 'dynamic', 'convenience', 'required',
                       'optional', 'async', 'throws', 'rethrows', 'indirect']),
};

export function modifierKeywordsFor(langName: string): ReadonlySet<string> {
    const base = MODIFIER_KEYWORDS;
    const ext = MODIFIER_KEYWORDS_BY_LANG[langName];
    if (!ext) return base;
    const union = new Set<string>(base);
    for (const m of ext) union.add(m);
    return union;
}

/** Modifier keywords extracted from preceding tokens or child nodes */
const MODIFIER_KEYWORDS: ReadonlySet<string> = new Set([
    'public', 'private', 'protected', 'static', 'async', 'abstract',
    'const', 'final', 'override', 'pub', 'export', 'default', 'readonly',
    'virtual', 'sealed', 'internal', 'extern', 'inline', 'unsafe',
]);

/**
 * Extract the structural shape of one definition.
 * @param defNode  The definition node — the indexer passes selectDefinitionNode().spanNode,
 *                 so decorated/wrapped defs arrive as their wrapper (decorator extraction
 *                 below depends on that, matching the old positional clause-2 behavior).
 *                 The old (rootNode, startLine, endLine) positional search is gone: it carried a
 *                 false-outer-match — a Python method ending on its class's last row matched the
 *                 CLASS via clause 2 and stole its structure row.
 */
export function extractStructureForDef(defNode: Node, langName: string): SymbolStructure | null {
    const paramContainers = paramContainersFor(langName);
    const modifierKeywords = modifierKeywordsFor(langName);
    const foundNode: Node = defNode;

    // --- Params ---
    const params: string[] = [];

    // Push the param-bearing children of a single param-container node
    // (skipping the structural delimiter tokens) into `params`.
    function collectFromContainer(container: Node): void {
        for (let i = 0; i < container.childCount; i++) {
            const c = container.child(i);
            if (!c) continue;
            if (c.type === '(' || c.type === ')' || c.type === ',') continue;
            params.push(c.type);
        }
    }

    // The node whose OWN signature we collect. When `foundNode` is a wrapper
    // (e.g. Python's `decorated_definition`), the real definition — the one
    // this symbol actually is — is the single inner definition child the
    // wrapper is known to wrap. Step into it so its params are reached; the
    // old recursion bailed at that inner DEF_TYPES node and lost every param
    // of every decorated def (review-2 [Q]).
    let paramRoot: Node = foundNode;
    const wrapInners = WRAPPER_DEFINITIONS.get(foundNode.type);
    if (wrapInners) {
        for (let i = 0; i < foundNode.childCount; i++) {
            const child = foundNode.child(i);
            if (child && wrapInners.has(child.type)) {
                paramRoot = child;
                break;
            }
        }
    }

    // Collect ALL param containers in the definition's own signature scope.
    // In every shipped grammar the signature containers (formal params AND a
    // sibling type-parameter list, when generic) sit as direct children of
    // the definition node, with the body block as another direct child. We
    // therefore scan the direct children only: that captures both containers
    // of a generic def (review-2 [R] — the old code returned after the first)
    // while never descending into the body or into nested definitions, whose
    // params are not this definition's. Nested defs (and the Python `block`
    // body, itself a DEF_TYPES node) are skipped explicitly.
    for (let i = 0; i < paramRoot.childCount; i++) {
        const child = paramRoot.child(i);
        if (!child) continue;
        if (DEF_TYPES.has(child.type)) continue;
        if (paramContainers.has(child.type)) {
            collectFromContainer(child);
        }
    }

    // --- Return type ---
    let returnKind: string | null = null;
    for (let i = 0; i < foundNode.childCount; i++) {
        const c = foundNode.child(i);
        if (!c) continue;
        if (c.type === 'type_annotation' || c.type === 'return_type') {
            returnKind = c.type;
            break;
        }
    }

    // --- Parent kind ---
    let parentKind: string | null = null;
    let p: Node | null = foundNode.parent;
    while (p) {
        if (DEF_TYPES.has(p.type) || p.type === 'program' || p.type === 'module' || p.type === 'source_file') {
            parentKind = p.type;
            break;
        }
        p = p.parent;
    }

    // --- Decorators ---
    const decorators: string[] = [];
    if (foundNode.parent) {
        const parent = foundNode.parent;
        for (let i = 0; i < parent.childCount; i++) {
            const sibling = parent.child(i);
            if (sibling === foundNode) break;
            if (!sibling) continue;
            if (sibling.type === 'decorator' || sibling.type === 'annotation' ||
                sibling.type === 'attribute_list' || sibling.type === 'attribute') {
                decorators.push(sibling.type);
            }
        }
    }
    // Handle decorated_definition wrapper (Python)
    if (foundNode.type === 'decorated_definition') {
        for (let i = 0; i < foundNode.childCount; i++) {
            const child = foundNode.child(i);
            if (child && child.type === 'decorator') decorators.push('decorator');
        }
    }

    // --- Modifiers ---
    const modifiers: string[] = [];
    // Check immediate children and preceding siblings for modifier keywords
    for (let i = 0; i < foundNode.childCount; i++) {
        const child = foundNode.child(i);
        if (!child) continue;
        if (modifierKeywords.has(child.type)) {
            modifiers.push(child.type);
        }
        // Check text of named children that might be keywords
        if (child.type === 'modifiers' || child.type === 'modifier') {
            for (let j = 0; j < child.childCount; j++) {
                const mod = child.child(j);
                if (mod && modifierKeywords.has(mod.text)) {
                    modifiers.push(mod.text);
                }
            }
        }
    }
    // Check parent for export_statement wrapping (JS/TS)
    if (foundNode.parent?.type === 'export_statement') {
        modifiers.push('export');
    }
    modifiers.sort();

    return { params, returnKind, parentKind, decorators, modifiers };
}
