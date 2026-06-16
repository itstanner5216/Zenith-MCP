// ---------------------------------------------------------------------------
// rev2-structure-params.test.js
//
// Regression tests for review-2 findings [Q] and [R] in
// packages/zenith-mcp/src/core/tree-sitter/structure.ts —
// extractStructureForDef()'s parameter collection.
//
// [Q] decorated-def params lost
//     The indexer passes selectDefinitionNode().spanNode to
//     extractStructureForDef. For a DECORATED Python def that spanNode is the
//     `decorated_definition` WRAPPER, whose inner `function_definition` holds
//     the actual params. The old collector walked the wrapper, hit the inner
//     function_definition (a DEF_TYPES node, !isRoot) and returned false at
//     the `!isRoot && DEF_TYPES.has` guard — so a decorated def's params were
//     NEVER collected and the def lost all structural extraction.
//       pre-fix : params === []        (empty)            -> FAILS the non-empty assertion
//       post-fix: params === ['typed_parameter', ...]     -> passes
//
// [R] param extraction short-circuits after the first container
//     A def with BOTH a type-parameter container and a formal-parameter
//     container (a generic function) has the two containers as sibling direct
//     children of the def node. The old collector `return true`d after the
//     FIRST container it found (type_parameters), so the formal parameters
//     were never collected.
//       pre-fix : params has 'type_parameter' but NOT 'required_parameter'  -> FAILS
//       post-fix: params has BOTH                                           -> passes
//
// These import the extractor submodule directly (the public barrel allows the
// extractor's own tests to do so) and reconstruct EXACTLY what the indexer
// feeds extractStructureForDef: selectDefinitionNode(name).spanNode. They run
// against the compiled dist build, matching the sibling tree-sitter tests
// (def-node-selection.test.js, rev2-locals-containment.test.js).
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { Parser } from 'web-tree-sitter';
import { loadLanguage } from '../dist/core/tree-sitter.js';
import { selectDefinitionNode } from '../dist/core/tree-sitter/symbols.js';
import { extractStructureForDef } from '../dist/core/tree-sitter/structure.js';

// Locate the first AST node whose type matches `predicate` and whose `.text`
// equals `name`. Mirrors the helper in def-node-selection.test.js.
function findNamedNode(root, name, predicate) {
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (predicate(node) && node.text === name) return node;
        for (let i = node.childCount - 1; i >= 0; i--) {
            const child = node.child(i);
            if (child) stack.push(child);
        }
    }
    return null;
}

/** Parse `source` for `lang`, returning { tree, parser, root } with guards. */
async function parseSource(source, lang) {
    const language = await loadLanguage(lang);
    expect(language).toBeTruthy();

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    expect(tree).toBeTruthy();

    const root = tree?.rootNode;
    expect(root).toBeTruthy();
    return { tree, parser, root };
}

// ---------------------------------------------------------------------------
// [Q] decorated Python def — params reached THROUGH the wrapper
// ---------------------------------------------------------------------------

describe('structure.ts decorated-def params (review-2 [Q])', () => {
    it('extracts params for a decorated Python def fed via its decorated_definition spanNode', async () => {
        // @my_decorator
        // def foo(x: int, y: str) -> int:
        //     return x
        const source = '@my_decorator\ndef foo(x: int, y: str) -> int:\n    return x\n';
        const { tree, parser, root } = await parseSource(source, 'python');

        try {
            const fooName = findNamedNode(root, 'foo', n => n.type === 'identifier');
            expect(fooName).toBeTruthy();

            // Reconstruct EXACTLY what the indexer passes: the spanNode. For a
            // decorated def this is the `decorated_definition` wrapper — the
            // node that triggered finding [Q].
            const sel = selectDefinitionNode(fooName);
            expect(sel).toBeTruthy();
            expect(sel.spanNode.type).toBe('decorated_definition');

            const struct = extractStructureForDef(sel.spanNode, 'python');
            expect(struct).toBeTruthy();

            // CORE [Q] ASSERTION — fail-before / pass-after:
            //   pre-fix : params === []      -> length 0 -> FAILS
            //   post-fix: params non-empty (the inner function_definition's
            //             `parameters` are reached through the wrapper)
            expect(struct.params.length).toBeGreaterThan(0);
            // The two annotated params surface as `typed_parameter` nodes; a
            // regression that re-loses the wrapper descent would empty this.
            expect(struct.params).toContain('typed_parameter');
        } finally {
            tree?.delete();
            parser.delete();
        }
    });

    it('a NON-decorated Python def is unaffected (spanNode === function_definition, params still collected)', async () => {
        // Guards the [Q] fix against only working for the wrapped path: the
        // plain function must still get its params from the direct walk.
        const source = 'def plain(a, b):\n    return a\n';
        const { tree, parser, root } = await parseSource(source, 'python');

        try {
            const name = findNamedNode(root, 'plain', n => n.type === 'identifier');
            expect(name).toBeTruthy();

            const sel = selectDefinitionNode(name);
            expect(sel).toBeTruthy();
            // No wrapper applies — span and primary are the same function node.
            expect(sel.spanNode.type).toBe('function_definition');
            expect(sel.spanNode).toBe(sel.primaryNode);

            const struct = extractStructureForDef(sel.spanNode, 'python');
            expect(struct).toBeTruthy();
            // Two positional params: a, b (each an `identifier` inside
            // `parameters`).
            expect(struct.params.length).toBe(2);
            expect(struct.params).toContain('identifier');
        } finally {
            tree?.delete();
            parser.delete();
        }
    });
});

// ---------------------------------------------------------------------------
// [R] generic function — BOTH type-params AND formal-params represented
// ---------------------------------------------------------------------------

describe('structure.ts collects all param containers (review-2 [R])', () => {
    it('a TS generic function captures BOTH its type_parameters and formal_parameters', async () => {
        // function identity<T extends object>(value: T, label: string): T {
        //     return value;
        // }
        //
        // function_declaration has type_parameters and formal_parameters as
        // sibling direct children. The old collector stopped after the first
        // (type_parameters), dropping the formal parameters.
        const source =
            'function identity<T extends object>(value: T, label: string): T {\n' +
            '    return value;\n' +
            '}\n';
        const { tree, parser, root } = await parseSource(source, 'typescript');

        try {
            const idName = findNamedNode(root, 'identity', n => n.type === 'identifier');
            expect(idName).toBeTruthy();

            const sel = selectDefinitionNode(idName);
            expect(sel).toBeTruthy();
            // No wrapper for a bare TS function — the def node is fed directly.
            expect(sel.spanNode.type).toBe('function_declaration');

            const struct = extractStructureForDef(sel.spanNode, 'typescript');
            expect(struct).toBeTruthy();

            // CORE [R] ASSERTION — fail-before / pass-after:
            //   `type_parameter`     comes from the type_parameters container
            //   `required_parameter` comes from the formal_parameters container
            //   pre-fix : only the first container collected — params has
            //             'type_parameter' but NOT 'required_parameter' -> FAILS
            //   post-fix: BOTH containers collected -> both present
            expect(struct.params).toContain('type_parameter');
            expect(struct.params).toContain('required_parameter');

            // Both formal params are present (value, label), proving the whole
            // formal_parameters container was collected, not just sampled.
            const formalCount = struct.params.filter(p => p === 'required_parameter').length;
            expect(formalCount).toBe(2);
        } finally {
            tree?.delete();
            parser.delete();
        }
    });

    it('a non-generic TS function still collects its single formal_parameters container', async () => {
        // Guards the [R] fix against over- or under-collecting when only one
        // container exists.
        const source = 'function add(a: number, b: number): number {\n    return a + b;\n}\n';
        const { tree, parser, root } = await parseSource(source, 'typescript');

        try {
            const name = findNamedNode(root, 'add', n => n.type === 'identifier');
            expect(name).toBeTruthy();

            const sel = selectDefinitionNode(name);
            expect(sel).toBeTruthy();
            expect(sel.spanNode.type).toBe('function_declaration');

            const struct = extractStructureForDef(sel.spanNode, 'typescript');
            expect(struct).toBeTruthy();
            // No type parameters here; just the two formal params.
            expect(struct.params).not.toContain('type_parameter');
            const formalCount = struct.params.filter(p => p === 'required_parameter').length;
            expect(formalCount).toBe(2);
        } finally {
            tree?.delete();
            parser.delete();
        }
    });
});
