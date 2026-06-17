// rev2-anchors-nested-prune.test.js
//
// Review-2 regression for disposition item [T] (cubic #40, P2):
// `extractAnchorsForDef` used to prune nested definitions with a LOCAL,
// hand-rolled `DEF_NODE_TYPES` set that omitted most definition node types:
//
//     'function_declaration', 'function_definition', 'method_definition',
//     'function_item', 'class_declaration', 'class_definition',
//     'arrow_function', 'function_expression'
//
// When a symbol contained a nested def whose node type was NOT in that
// partial set, the walk descended into the nested def and its in-body
// anchors LEAKED into the enclosing symbol's anchor list.
//
// The fix replaces the partial local set with the curated `DEF_SCOPE_NODE_TYPES`
// in anchors.ts — the COMPLETE set of genuine function/class/method/type
// definition *openers*. It is deliberately NOT the canonical `DEF_TYPES`:
// DEF_TYPES also contains body/structural node types (block, statement_block,
// assignment, …) that are part of a def's OWN body, so pruning on it would
// drop the def's own anchors. DEF_SCOPE_NODE_TYPES adds the missing real def
// openers (method_declaration, interface_declaration, …) without those body nodes.
//
// These tests pick definition node types that ARE def-scope openers but were
// MISSING from the old 8-type local set, and assert that anchors inside such a
// nested def do NOT appear in the outer def's anchor list.
//
// Like anchors-pure.test.js, this is a pure AST-walk unit test: it mocks the
// tree-sitter Node interface with plain objects (no tree-sitter runtime).
//
// Fail-before / pass-after:
//   - OLD code: `DEF_NODE_TYPES` lacked e.g. `method_declaration` /
//     `interface_declaration` / `enum_declaration`, so the walk recursed into
//     the nested def and pushed its inner `return_statement` anchor → the
//     inner line WOULD appear in the outer list (assertion fails).
//   - NEW code: DEF_SCOPE_NODE_TYPES.has('method_declaration') === true, so
//     depth>0 pruning fires and the inner anchor is dropped (assertion passes).

import { describe, expect, it } from 'vitest';
import { extractAnchorsForDef } from '../dist/core/tree-sitter/anchors.js';
import { DEF_TYPES } from '../dist/core/tree-sitter/symbols.js';

// ---------------------------------------------------------------------------
// Node mock builder (identical shape to anchors-pure.test.js)
// ---------------------------------------------------------------------------

/**
 * Create a minimal mock tree-sitter Node.
 * @param type     node type string
 * @param startRow 0-based start row
 * @param endRow   0-based end row
 * @param children array of child mock nodes
 */
function makeNode(type, startRow, endRow, children = []) {
    return {
        type,
        startPosition: { row: startRow, column: 0 },
        endPosition: { row: endRow, column: 0 },
        get childCount() { return children.length; },
        child(i) { return children[i] ?? null; },
    };
}

// The exact members of the OLD, partial, hand-rolled local set that the fix
// removed. Anything in canonical DEF_TYPES but NOT in here was the leak source.
const OLD_PARTIAL_DEF_NODE_TYPES = new Set([
    'function_declaration', 'function_definition', 'method_definition',
    'function_item', 'class_declaration', 'class_definition',
    'arrow_function', 'function_expression',
]);

describe('rev2 [T] — nested-def pruning uses curated DEF_SCOPE_NODE_TYPES (no leak)', () => {
    it('guards the premise: chosen node types are in DEF_TYPES but were missing from the old local set', () => {
        // If this ever flips, the test below stops exercising the leak path —
        // this guard makes such drift loud instead of silently passing.
        for (const t of ['method_declaration', 'interface_declaration', 'enum_declaration']) {
            expect(DEF_TYPES.has(t)).toBe(true);
            expect(OLD_PARTIAL_DEF_NODE_TYPES.has(t)).toBe(false);
        }
    });

    it('does NOT leak anchors from a nested java method_declaration into the outer class', () => {
        // Java: a class_declaration containing a nested method_declaration.
        // `method_declaration` is in canonical DEF_TYPES but was absent from
        // the old local set, so the inner method's anchors used to leak.
        const innerReturn = makeNode('return_statement', 5, 5);   // inside the method body
        const innerThrow = makeNode('throw_statement', 6, 6);     // inside the method body
        const innerMethod = makeNode('method_declaration', 3, 8, [innerReturn, innerThrow]);

        // The class itself has a direct in-body anchor (an if at the class
        // initializer level) that MUST still be reported.
        const classIf = makeNode('if_statement', 2, 2);
        const outerClass = makeNode('class_declaration', 0, 10, [classIf, innerMethod]);

        const anchors = extractAnchorsForDef(outerClass, 'java', 0);
        const lines = anchors.map(a => a.line);

        // Outer class's own anchor is kept.
        expect(lines).toContain(2);
        // Inner method's anchors are pruned (would have leaked under the old set).
        expect(lines).not.toContain(5);
        expect(lines).not.toContain(6);
        // No anchor kinds from the nested method survive.
        const kinds = anchors.map(a => a.kind);
        expect(kinds).not.toContain('return');
        expect(kinds).not.toContain('throw');
    });

    it('prunes a deeply nested anchor inside a java method_declaration (recursive walk)', () => {
        // Anchor buried under a block inside the nested method — the old set
        // failed to prune the method, so the recursive walk reached this too.
        const deepLoop = makeNode('for_statement', 6, 9);
        const methodBlock = makeNode('block', 4, 10, [deepLoop]);
        const innerMethod = makeNode('method_declaration', 3, 11, [methodBlock]);
        const outerClass = makeNode('class_declaration', 0, 13, [innerMethod]);

        const anchors = extractAnchorsForDef(outerClass, 'java', 0);
        expect(anchors.map(a => a.line)).not.toContain(6);
        expect(anchors).toHaveLength(0);
    });

    it('does NOT leak anchors from a nested c_sharp interface/method into the outer namespace-level class', () => {
        // C#: a class_declaration containing a method_declaration with an
        // await + foreach inside. method_declaration absent from old set.
        const innerAwait = makeNode('await_expression', 4, 4);
        const innerForeach = makeNode('foreach_statement', 5, 7);
        const innerMethod = makeNode('method_declaration', 3, 8, [innerAwait, innerForeach]);
        const outerClass = makeNode('class_declaration', 0, 10, [innerMethod]);

        const anchors = extractAnchorsForDef(outerClass, 'c_sharp', 0);
        const kinds = anchors.map(a => a.kind);
        expect(kinds).not.toContain('await');
        expect(kinds).not.toContain('loop');
        expect(anchors).toHaveLength(0);
    });

    it('keeps the outer def\'s own anchors while pruning only the nested def', () => {
        // Sanity: the fix must not over-prune. Outer method (java
        // method_declaration is itself a valid def root passed in as defNode)
        // keeps its own anchors; only the *nested* method is pruned.
        const outerReturn = makeNode('return_statement', 9, 9);  // outer body anchor — kept
        const innerReturn = makeNode('return_statement', 5, 5);  // nested method anchor — pruned
        const innerMethod = makeNode('method_declaration', 3, 7, [innerReturn]);
        const outerMethod = makeNode('method_declaration', 0, 11, [innerMethod, outerReturn]);

        const anchors = extractAnchorsForDef(outerMethod, 'java', 0);
        const lines = anchors.map(a => a.line);
        expect(lines).toContain(9);     // outer return kept
        expect(lines).not.toContain(5); // nested return pruned
        expect(anchors).toHaveLength(1);
    });
});
