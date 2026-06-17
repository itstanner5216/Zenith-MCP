// ---------------------------------------------------------------------------
// rev2-locals-containment.test.js
//
// Regression test for review-2 finding [H]: nested-scope containment in
// packages/zenith-mcp/src/core/tree-sitter/locals.ts.
//
// extractLocals() assigns each captured parameter / local definition to its
// directly-enclosing @scope. To do that it must decide, for a symbol that
// lives inside the current scope's range, whether it ALSO lives inside a
// nested child scope (in which case it belongs to the child, not the current
// scope). The original implementation tested that nested-ness with ROW
// comparison and STRICT inequalities:
//
//     iStart > scopeStartRow && iEnd < scopeEndRow
//
// That clause is false whenever an inner scope shares a boundary ROW with its
// parent — e.g. a single-line nested arrow function, or a nested arrow that
// ends on the same line as its enclosing arrow. When the clause is wrongly
// false, the inner scope is not recognised as containing the symbol, so the
// symbol is left attributed to the OUTER scope IN ADDITION to the inner one:
// it is double-counted.
//
// The fix replaces the strict row clause with BYTE-OFFSET containment
// (node.startIndex / node.endIndex), which is unique per position and so is
// correct even when start/end ROWS coincide. The coarse row-membership
// pre-filter (row >= iStart && row <= iEnd) is retained.
//
// These tests pin the documented behaviour:
//   - byte-offset build (current src): a nested param is attributed to the
//     INNER scope and is NOT double-counted in the outer scope  -> PASS
//   - row-strict build (the pre-fix code): the nested param appears in BOTH
//     the inner and outer scopes                                 -> FAIL
//
// They import the extractor submodule directly, which the public barrel
// (core/tree-sitter.ts) explicitly allows for the extractor's own tests.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { Parser } from 'web-tree-sitter';
import { loadLanguage } from '../dist/core/tree-sitter.js';
import { extractLocals } from '../dist/core/tree-sitter/locals.js';

/** Parse `source` for `lang` and return { tree, root } with explicit guards. */
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

describe('locals.ts nested-scope containment (review-2 [H])', () => {
    it('attributes a nested arrow param to the inner scope when the inner scope shares its END row with the outer scope', async () => {
        // Outer arrow spans lines 1-2; inner arrow is entirely on line 2 and so
        // shares its END row (line 2) with the outer arrow. This is precisely
        // the shared-boundary case the strict row clause mishandles.
        //
        //   line 1:  const f = (a) =>
        //   line 2:    (b) => a + b;
        //
        // Distinct startLines (1 vs 2) let us identify the two scopes through
        // the public LocalScope shape (which exposes startLine/endLine but not
        // byte offsets).
        const source = 'const f = (a) =>\n  (b) => a + b;\n';
        const { tree, parser, root } = await parseSource(source, 'typescript');

        try {
            const scopes = await extractLocals(root, 'typescript');
            expect(Array.isArray(scopes)).toBe(true);

            const outer = scopes.find(s => s.startLine === 1);
            const inner = scopes.find(s => s.startLine === 2);
            expect(outer).toBeTruthy();
            expect(inner).toBeTruthy();

            const outerParamNames = outer.parameters.map(p => p.name);
            const innerParamNames = inner.parameters.map(p => p.name);

            // The inner arrow's own parameter belongs to the inner scope.
            expect(innerParamNames).toContain('b');

            // CORE [H] ASSERTION — the fail-before / pass-after flip:
            // the inner param must NOT leak up into the outer scope.
            //   pre-fix (row-strict): outerParamNames === ['a','b']  -> FAILS here
            //   post-fix (byte-off ): outerParamNames === ['a']      -> passes
            expect(outerParamNames).not.toContain('b');

            // The outer arrow keeps its own parameter (guards against the fix
            // over-pruning and dropping 'a' entirely).
            expect(outerParamNames).toContain('a');

            // 'b' is attributed to exactly one scope across the whole result
            // (no double-count anywhere).
            const scopesWithB = scopes.filter(s => s.parameters.some(p => p.name === 'b'));
            expect(scopesWithB).toHaveLength(1);
            expect(scopesWithB[0].startLine).toBe(2);
        } finally {
            tree?.delete();
            parser.delete();
        }
    });

    it('does not double-count a param of a single-line nested arrow that shares BOTH boundary rows with its parent', async () => {
        // The canonical [H] example: everything is on one line, so the inner
        // arrow shares BOTH its start and end row with the outer arrow. Here
        // both scopes report startLine === endLine === 1, so they are not
        // distinguishable through startLine; we assert on the flattened count,
        // which is the precise statement of "not double-counted".
        //
        //   const f = (a) => (b) => a + b;
        const source = 'const f = (a) => (b) => a + b;\n';
        const { tree, parser, root } = await parseSource(source, 'typescript');

        try {
            const scopes = await extractLocals(root, 'typescript');
            expect(Array.isArray(scopes)).toBe(true);

            // The inner param 'b' must be attributed to exactly one scope.
            //   pre-fix (row-strict): 'b' counted in both arrows -> length 2 -> FAILS
            //   post-fix (byte-off ): 'b' counted once           -> length 1 -> passes
            const scopesWithB = scopes.filter(s => s.parameters.some(p => p.name === 'b'));
            expect(scopesWithB).toHaveLength(1);

            // And it is not dropped entirely.
            const totalB = scopes
                .flatMap(s => s.parameters)
                .filter(p => p.name === 'b').length;
            expect(totalB).toBe(1);
        } finally {
            tree?.delete();
            parser.delete();
        }
    });

    it('does not mis-attribute the OUTER param/local across same-line scopes (byte-membership)', async () => {
        // Companion to the [H] guard above, covering the direction the original
        // tests missed. Pre-fix, scope MEMBERSHIP was row-based, so on a single
        // line every symbol counted as "in range" of every same-line scope. The
        // result for `const f = (a) => (b) => a + b;` was one arrow grabbing BOTH
        // params (params=[a,b], locals=[f]) while the other arrow got nothing —
        // the outer param 'a' and the top-level local 'f' leaked into the inner
        // arrow's byte range, where they do not belong.
        //
        //   pre-fix (row membership): some scope has BOTH a and b  -> FAILS here
        //   post-fix (byte membership): a and b live in different scopes; f in neither arrow
        const source = 'const f = (a) => (b) => a + b;\n';
        const { tree, parser, root } = await parseSource(source, 'typescript');

        try {
            const scopes = await extractLocals(root, 'typescript');
            expect(Array.isArray(scopes)).toBe(true);

            // Each param is attributed to exactly one scope...
            const scopesWithA = scopes.filter(s => s.parameters.some(p => p.name === 'a'));
            const scopesWithB = scopes.filter(s => s.parameters.some(p => p.name === 'b'));
            expect(scopesWithA, "outer param 'a' must be attributed to exactly one scope").toHaveLength(1);
            expect(scopesWithB, "inner param 'b' must be attributed to exactly one scope").toHaveLength(1);

            // ...and 'a' and 'b' are params of DIFFERENT arrows. The precise
            // statement of the bug: no single scope may own both.
            const bothInOneScope = scopes.some(s => {
                const names = s.parameters.map(p => p.name);
                return names.includes('a') && names.includes('b');
            });
            expect(
                bothInOneScope,
                "REGRESSION: a single scope owns BOTH 'a' and 'b' — row-based membership has " +
                'leaked the outer param into the inner arrow. Membership must be tested by byte span.',
            ).toBe(false);

            // The top-level local 'f' must not leak into either arrow's byte range.
            const arrowScopesWithF = scopes.filter(
                s => s.scopeKind === 'arrow_function' && s.locals.some(l => l.name === 'f'),
            );
            expect(
                arrowScopesWithF,
                "REGRESSION: top-level local 'f' leaked into an arrow scope it does not lie within.",
            ).toHaveLength(0);
        } finally {
            tree?.delete();
            parser.delete();
        }
    });
});
