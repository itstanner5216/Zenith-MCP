// anchors-pure.test.js
//
// Tests for extractAnchorsForDef from tree-sitter/anchors.ts.
//
// extractAnchorsForDef takes a tree-sitter Node and a language name. Since
// this is a pure AST walk with no I/O, we mock the Node interface using plain
// objects that match the shape accessed by the function:
//   - node.type: string
//   - node.startPosition.row: number
//   - node.endPosition.row: number
//   - node.childCount: number
//   - node.child(i): Node | null
//
// No tree-sitter runtime is initialised — these are structural unit tests.

import { describe, expect, it } from 'vitest';
import { extractAnchorsForDef } from '../dist/core/tree-sitter/anchors.js';

// ---------------------------------------------------------------------------
// Node mock builder
// ---------------------------------------------------------------------------

/**
 * Create a minimal mock tree-sitter Node.
 * @param type         The node type (e.g. 'return_statement', 'if_statement')
 * @param startRow     0-based start row
 * @param endRow       0-based end row
 * @param children     Array of child mock nodes
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

// ---------------------------------------------------------------------------
// extractAnchorsForDef — unsupported language
// ---------------------------------------------------------------------------

describe('extractAnchorsForDef — unsupported language', () => {
    it('returns empty array for an unknown language', () => {
        const node = makeNode('function_declaration', 0, 10);
        const anchors = extractAnchorsForDef(node, 'unknown_lang_xyz', 0);
        expect(anchors).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// extractAnchorsForDef — javascript
// ---------------------------------------------------------------------------

describe('extractAnchorsForDef — javascript language rules', () => {
    it('extracts a return_statement anchor', () => {
        // Def body: rows 0-10; return on row 8 (> defStartRow 0)
        const returnNode = makeNode('return_statement', 8, 8);
        const body = makeNode('function_declaration', 0, 10, [returnNode]);
        const anchors = extractAnchorsForDef(body, 'javascript', 0);

        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('return');
        expect(anchors[0].priority).toBe(400);
        expect(anchors[0].line).toBe(8);
        expect(anchors[0].endLine).toBe(8);
    });

    it('extracts an if_statement anchor', () => {
        const ifNode = makeNode('if_statement', 3, 6);
        const body = makeNode('function_declaration', 0, 10, [ifNode]);
        const anchors = extractAnchorsForDef(body, 'javascript', 0);

        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('if');
        expect(anchors[0].priority).toBe(320);
    });

    it('extracts multiple anchors from a function body', () => {
        const ifNode = makeNode('if_statement', 2, 5);
        const tryNode = makeNode('try_statement', 7, 12);
        const returnNode = makeNode('return_statement', 14, 14);
        const body = makeNode('function_declaration', 0, 15, [ifNode, tryNode, returnNode]);

        const anchors = extractAnchorsForDef(body, 'javascript', 0);
        expect(anchors).toHaveLength(3);

        const kinds = anchors.map(a => a.kind);
        expect(kinds).toContain('if');
        expect(kinds).toContain('try');
        expect(kinds).toContain('return');
    });

    it('skips the def signature line itself (defStartRow filter)', () => {
        // A return_statement at row 0 — same as defStartRow — should be skipped
        const returnOnSameLine = makeNode('return_statement', 0, 0);
        const body = makeNode('function_declaration', 0, 5, [returnOnSameLine]);

        const anchors = extractAnchorsForDef(body, 'javascript', 0);
        expect(anchors).toHaveLength(0);
    });

    it('does NOT descend into nested function declarations', () => {
        // Inner function at rows 3-8 containing its own return_statement
        const innerReturn = makeNode('return_statement', 6, 6);
        const innerFunc = makeNode('function_declaration', 3, 8, [innerReturn]);
        // Outer function containing innerFunc
        const outerReturn = makeNode('return_statement', 10, 10);
        const outerFunc = makeNode('function_declaration', 0, 12, [innerFunc, outerReturn]);

        const anchors = extractAnchorsForDef(outerFunc, 'javascript', 0);
        // Only the outer return — inner function is skipped entirely
        const lines = anchors.map(a => a.line);
        expect(lines).toContain(10);   // outer return
        expect(lines).not.toContain(6); // inner return — nested def, should be skipped
    });

    it('does NOT descend into arrow_function or function_expression', () => {
        const innerReturn = makeNode('return_statement', 2, 2);
        const arrowFunc = makeNode('arrow_function', 1, 4, [innerReturn]);
        const outerReturn = makeNode('return_statement', 6, 6);
        const outerFunc = makeNode('function_declaration', 0, 8, [arrowFunc, outerReturn]);

        const anchors = extractAnchorsForDef(outerFunc, 'javascript', 0);
        expect(anchors.map(a => a.line)).toContain(6);
        expect(anchors.map(a => a.line)).not.toContain(2);
    });

    it('handles call_expression anchors with correct priority', () => {
        const callNode = makeNode('call_expression', 4, 4);
        const body = makeNode('function_declaration', 0, 10, [callNode]);

        const anchors = extractAnchorsForDef(body, 'javascript', 0);
        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('call');
        expect(anchors[0].priority).toBe(140);
    });

    it('handles throw_statement anchor', () => {
        const throwNode = makeNode('throw_statement', 5, 5);
        const body = makeNode('function_declaration', 0, 10, [throwNode]);

        const anchors = extractAnchorsForDef(body, 'javascript', 0);
        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('throw');
        expect(anchors[0].priority).toBe(380);
    });

    it('handles switch_statement anchor', () => {
        const switchNode = makeNode('switch_statement', 3, 12);
        const body = makeNode('function_declaration', 0, 15, [switchNode]);

        const anchors = extractAnchorsForDef(body, 'javascript', 0);
        expect(anchors[0].kind).toBe('switch');
        expect(anchors[0].priority).toBe(300);
    });

    it('handles loop anchors (for/while/do)', () => {
        const forNode = makeNode('for_statement', 2, 4);
        const whileNode = makeNode('while_statement', 6, 8);
        const doNode = makeNode('do_statement', 10, 12);
        const body = makeNode('function_declaration', 0, 15, [forNode, whileNode, doNode]);

        const anchors = extractAnchorsForDef(body, 'javascript', 0);
        const loopAnchors = anchors.filter(a => a.kind === 'loop');
        expect(loopAnchors).toHaveLength(3);
    });

    it('returns empty array for a body with no matching node types', () => {
        // Only contains unknown/misc node types
        const misc = makeNode('expression_statement', 1, 1);
        const body = makeNode('function_declaration', 0, 5, [misc]);

        const anchors = extractAnchorsForDef(body, 'javascript', 0);
        expect(anchors).toHaveLength(0);
    });

    it('handles deeply nested nodes (recursive walk)', () => {
        // A nested if inside a block
        const ifNode = makeNode('if_statement', 3, 5);
        const block = makeNode('block', 1, 9, [ifNode]);
        const body = makeNode('function_declaration', 0, 10, [block]);

        const anchors = extractAnchorsForDef(body, 'javascript', 0);
        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('if');
        expect(anchors[0].line).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// extractAnchorsForDef — typescript (same rules as javascript)
// ---------------------------------------------------------------------------

describe('extractAnchorsForDef — typescript language rules', () => {
    it('extracts return_statement with priority 400', () => {
        const returnNode = makeNode('return_statement', 5, 5);
        const body = makeNode('function_declaration', 0, 8, [returnNode]);
        const anchors = extractAnchorsForDef(body, 'typescript', 0);
        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('return');
        expect(anchors[0].priority).toBe(400);
    });

    it('extracts await_expression with priority 180', () => {
        const awaitNode = makeNode('await_expression', 4, 4);
        const body = makeNode('function_declaration', 0, 8, [awaitNode]);
        const anchors = extractAnchorsForDef(body, 'typescript', 0);
        expect(anchors[0].kind).toBe('await');
        expect(anchors[0].priority).toBe(180);
    });
});

// ---------------------------------------------------------------------------
// extractAnchorsForDef — python language rules
// ---------------------------------------------------------------------------

describe('extractAnchorsForDef — python language rules', () => {
    it('maps raise_statement to kind throw', () => {
        const raiseNode = makeNode('raise_statement', 3, 3);
        const body = makeNode('function_definition', 0, 8, [raiseNode]);
        const anchors = extractAnchorsForDef(body, 'python', 0);
        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('throw');
    });

    it('maps with_statement to kind with', () => {
        const withNode = makeNode('with_statement', 2, 5);
        const body = makeNode('function_definition', 0, 8, [withNode]);
        const anchors = extractAnchorsForDef(body, 'python', 0);
        expect(anchors[0].kind).toBe('with');
        expect(anchors[0].priority).toBe(220);
    });

    it('maps except_clause to kind catch', () => {
        const exceptNode = makeNode('except_clause', 6, 8);
        const body = makeNode('function_definition', 0, 10, [exceptNode]);
        const anchors = extractAnchorsForDef(body, 'python', 0);
        expect(anchors[0].kind).toBe('catch');
    });
});

// ---------------------------------------------------------------------------
// extractAnchorsForDef — go language rules
// ---------------------------------------------------------------------------

describe('extractAnchorsForDef — go language rules', () => {
    it('maps defer_statement to kind defer', () => {
        const deferNode = makeNode('defer_statement', 2, 2);
        const body = makeNode('function_declaration', 0, 10, [deferNode]);
        const anchors = extractAnchorsForDef(body, 'go', 0);
        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('defer');
        expect(anchors[0].priority).toBe(220);
    });

    it('maps select_statement to kind switch', () => {
        const selectNode = makeNode('select_statement', 5, 9);
        const body = makeNode('function_declaration', 0, 12, [selectNode]);
        const anchors = extractAnchorsForDef(body, 'go', 0);
        expect(anchors[0].kind).toBe('switch');
    });
});

// ---------------------------------------------------------------------------
// extractAnchorsForDef — c_sharp language rules
// ---------------------------------------------------------------------------

describe('extractAnchorsForDef — c_sharp language rules', () => {
    it('maps foreach_statement to kind loop', () => {
        const foreachNode = makeNode('foreach_statement', 3, 7);
        const body = makeNode('method_definition', 0, 10, [foreachNode]);
        const anchors = extractAnchorsForDef(body, 'c_sharp', 0);
        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('loop');
        expect(anchors[0].priority).toBe(255);
    });

    it('maps await_expression to kind await', () => {
        const awaitNode = makeNode('await_expression', 4, 4);
        const body = makeNode('method_definition', 0, 8, [awaitNode]);
        const anchors = extractAnchorsForDef(body, 'c_sharp', 0);
        expect(anchors[0].kind).toBe('await');
    });
});

// ---------------------------------------------------------------------------
// extractAnchorsForDef — boundary: empty node tree
// ---------------------------------------------------------------------------

describe('extractAnchorsForDef — boundary cases', () => {
    it('emits an anchor when the def node itself matches an anchor rule', () => {
        const leaf = makeNode('return_statement', 1, 1);
        // leaf IS the def node; walk at depth=0, rule IS checked for depth=0 but
        // defStartRow=0 and row=1 > 0 → would match; however the def-root walk
        // doesn't emit the root itself at depth 0 unless it matches the rule
        const anchors = extractAnchorsForDef(leaf, 'javascript', 0);
        // The defNode itself is the return_statement; at depth 0 the rule IS matched
        // as long as startRow > defStartRow; row=1 > 0 so it matches.
        expect(anchors.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array when defNode has no children and is not an anchor type', () => {
        const emptyFunc = makeNode('function_declaration', 0, 5);
        const anchors = extractAnchorsForDef(emptyFunc, 'javascript', 0);
        expect(anchors).toHaveLength(0);
    });

    it('applies scss language rules correctly (if_statement is anchored)', () => {
        // scss HAS anchor rules (if_statement is one) — this checks they apply
        const ifNode = makeNode('if_statement', 2, 4);
        const body = makeNode('mixin_declaration', 0, 6, [ifNode]);
        const anchors = extractAnchorsForDef(body, 'scss', 0);
        // if_statement IS in the scss rules
        expect(anchors).toHaveLength(1);
        expect(anchors[0].kind).toBe('if');
    });
});