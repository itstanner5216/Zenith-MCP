// ---------------------------------------------------------------------------
// indexing-extract-spans.test.js
//
// Regression tests for the single-parse indexing extractor at
// packages/zenith-mcp/src/core/indexing/extract.ts.
//
// These pin four behaviors that the integrated extractor delivers (and
// that pre-integration trunks did not), each one chosen so it would fail
// on a baseline that lacked the corresponding fix:
//
//   1. TS class method endLine — every nested definition gets its own
//      tight range, never the parent class's endLine. The method's
//      parentSymbolKey points at the enclosing class via name:line:column.
//
//   2. Exported TS function anchors — exported defs surface a non-empty
//      anchor list including `return`. The pre-integration positional
//      walk matched `export_statement` (same row span as the inner
//      function_declaration), and the anchor walk pruned everything at
//      depth>0 because `function_declaration` is in DEF_NODE_TYPES —
//      yielding ZERO anchors. Passing the PRIMARY node restores them.
//
//   3. Decorated Python method — own endLine on the inner function_def;
//      anchors are persisted 1-based (`line >= 1`) so the seam with TOON
//      and `compressFile` agrees on one unit. The 1-based contract is
//      verified end-to-end by asserting `lines[anchor.line - 1]`
//      contains the anchor's `text` (the file slice the index recorded).
//
//   4. Python last-method-ends-on-class-row — when the method's end
//      coincides with the class's final line, the method's structure
//      row must carry the METHOD's params, not the class's. The
//      pre-integration positional `findDef` had a clause-2 false-outer-
//      match that returned the CLASS node here, so the method silently
//      inherited the class's empty params list.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { extractParsedFile } from '../dist/core/indexing/extract.js';

// ---------------------------------------------------------------------------
// FIX1 — TS class method endLine + parentSymbolKey
// ---------------------------------------------------------------------------

describe('indexing extract — TS class method endLine and parentSymbolKey', () => {
    it('greet endLine is its own end (5), not the class endLine (9); parentSymbolKey points at C', async () => {
        // 9-line file:
        //   1:
        //   2:  class C {
        //   3:      greet() {
        //   4:          return 1;
        //   5:      }
        //   6:
        //   7:      // tail
        //   8:      other = 2;
        //   9:  }
        // Class C spans 2-9; greet's body ends on line 5. A regression that
        // attached the class as greet's owner would surface as
        // greet.endLine === 9 here.
        const source = [
            '',
            'class C {',
            '    greet() {',
            '        return 1;',
            '    }',
            '',
            '    // tail',
            '    other = 2;',
            '}',
        ].join('\n');

        const rec = await extractParsedFile(source, 'typescript', 'fix1.ts', 'hash1');
        expect(rec).not.toBeNull();
        const symbols = rec.symbols;

        const cls = symbols.find(s => s.name === 'C' && s.kind === 'def');
        const greet = symbols.find(s => s.name === 'greet' && s.kind === 'def');

        expect(cls).toBeTruthy();
        expect(cls.type).toBe('class');
        expect(cls.line).toBe(2);
        expect(cls.endLine).toBe(9);

        expect(greet).toBeTruthy();
        expect(greet.type).toBe('method');
        expect(greet.line).toBe(3);
        // Hard pin: the method MUST NOT inherit the class's endLine.
        expect(greet.endLine).toBe(5);
        expect(greet.endLine).not.toBe(cls.endLine);

        // parentSymbolKey = "C:${cls.line}:${cls.column}" — derived from
        // the class's name-capture coordinates, NOT hard-coded.
        const expectedParentKey = `C:${cls.line}:${cls.column}`;
        expect(greet.parentSymbolKey).toBe(expectedParentKey);
    });
});

// ---------------------------------------------------------------------------
// FIX2 — Exported TS function anchors restoration
// ---------------------------------------------------------------------------

describe('indexing extract — exported TS function anchors', () => {
    it('exported foo has non-empty anchors including return anchors with 1-based text persistence', async () => {
        // A SINGLE-LINE fixture like
        // `export function foo() { if (x) return 1; }` would be degenerate
        // for the anchor rule: the extractor's anchor walk only records nodes
        // whose `startPosition.row > defStartRow` (anchors.ts), so on a
        // single-line def NO anchor is reachable BY DESIGN — the def's own
        // first line is never an anchor. To exercise the load-bearing
        // restoration of body anchors on an exported def we need a MULTI-LINE
        // body where every interior statement lives on a row strictly below
        // the def's start row.
        //
        // Behavior pinned here: the `export_statement` and the inner
        // `function_declaration` share their start row (the line carrying
        // `export function foo`). The old positional findDefNode walked the
        // tree top-down and matched the OUTER export_statement first; the
        // anchor walk then pruned everything at depth>0 because
        // function_declaration is in DEF_NODE_TYPES — yielding ZERO anchors
        // and erasing the exported def's body shape entirely.
        //
        // The integrated extractor passes the PRIMARY node (the
        // function_declaration itself, picked by selectDefinitionNode) to
        // extractAnchorsForDef, so the prune-at-depth-0 rule no longer fires
        // and the body anchors come back.
        const source = [
            'export function foo(x: number): number {', // line 1
            '    if (x > 1) {',                          // line 2
            '        return x * 2;',                     // line 3
            '    }',                                      // line 4
            '    return 1;',                             // line 5
            '}',                                          // line 6
        ].join('\n');
        const sourceLines = source.split('\n');

        const rec = await extractParsedFile(source, 'typescript', 'fix2.ts', 'hash2');
        expect(rec).not.toBeNull();

        const foo = rec.symbols.find(s => s.name === 'foo' && s.kind === 'def');
        expect(foo).toBeTruthy();
        expect(foo.type).toBe('function');
        expect(foo.line).toBe(1);
        // The name-capture column for the exported `foo` lands at 16 (the
        // start column of the `foo` identifier in `export function foo`).
        // This pins the key shape `foo:1:16` used below.
        expect(foo.column).toBe(16);

        const fooAnchors = rec.anchors.filter(
            a => a.parentSymbolKey === `foo:${foo.line}:${foo.column}`,
        );

        // NON-EMPTY: this is the load-bearing assertion. The baseline
        // (PR #23 extract.js) returns zero anchors here because the anchor
        // walk pruned the inner function_declaration at depth 1.
        expect(fooAnchors.length).toBeGreaterThan(0);

        // Exact shape: the multi-line body produces exactly three anchors
        // — one `if` (line 2, priority 320) and two `return` (lines 3 and 5,
        // priority 400). Pinning the exact set fails LOUDLY against any
        // regression that prunes the inner function or shifts the walk's
        // depth-0 entry point.
        expect(fooAnchors.length).toBe(3);

        // Must specifically include `return` anchors — pins not just
        // "something came through" but "the body's actual control-flow
        // anchors came through". Both `return x * 2;` (line 3) and
        // `return 1;` (line 5) must be present.
        const returnAnchors = fooAnchors.filter(a => a.kind === 'return');
        expect(returnAnchors.length).toBe(2);
        const returnLines = returnAnchors.map(a => a.line).sort((a, b) => a - b);
        expect(returnLines).toEqual([3, 5]);

        // The single `if (x > 1) {` lives on line 2. On a 0-based persistence
        // regression this would land on line 1 (the def signature row) and
        // both this assertion and the text comparison below would fail.
        const ifAnchors = fooAnchors.filter(a => a.kind === 'if');
        expect(ifAnchors.length).toBe(1);
        expect(ifAnchors[0].line).toBe(2);

        // Priorities tie the anchor table back to the rule map: `if` at 320,
        // `return` at 400. A regression that swapped rule maps or lost
        // priorities would fail here.
        expect(ifAnchors[0].priority).toBe(320);
        for (const ra of returnAnchors) {
            expect(ra.priority).toBe(400);
        }

        // Every anchor line is 1-based and the file slice the index recorded
        // matches `sourceLines[anchor.line - 1].slice(0, 80)`. On a 0-based
        // persistence regression this would land one line above the actual
        // anchor text and every comparison would fail.
        for (const a of fooAnchors) {
            expect(a.line).toBeGreaterThanOrEqual(1);
            expect(a.line).toBeLessThanOrEqual(sourceLines.length);
            const expectedLine = sourceLines[a.line - 1];
            expect(expectedLine).toBeDefined();
            expect(a.text).toBe(expectedLine.slice(0, 80));
        }
    });
});

// ---------------------------------------------------------------------------
// FIX3 — Decorated Python method endLine + anchors 1-based
// ---------------------------------------------------------------------------

describe('indexing extract — decorated Python method anchors are 1-based', () => {
    it('decorated foo gets its own endLine and every anchor line is 1-based with matching text', async () => {
        // 5-line decorated Python function:
        //   1:  @my_decorator
        //   2:  def foo(x: int) -> int:
        //   3:      if x > 0:
        //   4:          return x * 2
        //   5:      return 0
        //
        // The inner function_definition spans lines 2-5; the wrapping
        // decorated_definition spans 1-5. selectDefinitionNode picks the
        // function_definition as the PRIMARY (used for endLine and the
        // anchor walk), so foo.endLine === 5 (NOT 1, NOT inherited from
        // anywhere outer).
        //
        // The seam contract (Locked Decision #7): anchors are persisted
        // 1-based. The baseline (PR #23 extract.js) persists anchors as
        // `node.startPosition.row` directly (0-based), making
        // `lines[anchor.line - 1]` land one line ABOVE the actual anchor
        // text — the unit-mismatch this test pins.
        const source = [
            '@my_decorator',                 // line 1
            'def foo(x: int) -> int:',        // line 2
            '    if x > 0:',                  // line 3
            '        return x * 2',           // line 4
            '    return 0',                   // line 5
        ].join('\n');
        const sourceLines = source.split('\n');

        const rec = await extractParsedFile(source, 'python', 'fix3.py', 'hash3');
        expect(rec).not.toBeNull();

        const foo = rec.symbols.find(s => s.name === 'foo' && s.kind === 'def');
        expect(foo).toBeTruthy();
        expect(foo.type).toBe('function');
        expect(foo.line).toBe(2);
        // Method's own end, from the function_definition primary —
        // never the wrapping decorated_definition's end (also 5 here,
        // but the contract is "primary's end", which is what gets
        // pinned).
        expect(foo.endLine).toBe(5);

        const fooAnchors = rec.anchors.filter(
            a => a.parentSymbolKey === `foo:${foo.line}:${foo.column}`,
        );
        // Anchors must be present — pins the decorated-def restoration.
        // The baseline routes the body capture through the
        // function_definition (not the decorated_definition wrapper), so
        // this happens to pass on PR #23 today too; the 1-based check
        // below is the genuinely load-bearing piece.
        expect(fooAnchors.length).toBeGreaterThan(0);

        // Every anchor line is 1-based and the file slice the index
        // recorded matches `lines[anchor.line - 1]`. On 0-based
        // persistence this would land one line above the actual code.
        for (const a of fooAnchors) {
            expect(a.line).toBeGreaterThanOrEqual(1);
            expect(a.line).toBeLessThanOrEqual(sourceLines.length);
            // Anchors carry the source line they sit on, sliced to 80
            // chars by the extractor (extract.ts: `lines[a.line].slice(0,80)`
            // with the 1-based persistence storing `a.line + 1`). The
            // persisted `text` therefore equals exactly
            // `sourceLines[a.line - 1].slice(0, 80)`. On 0-based
            // persistence (the PR23 baseline) this comparison lands the
            // expected line ONE line above the anchor and fails.
            const expectedLine = sourceLines[a.line - 1];
            expect(expectedLine).toBeDefined();
            expect(a.text).toBe(expectedLine.slice(0, 80));
        }

        // Spot-check the specific anchor lines by kind — pins both
        // 1-basedness and that BOTH `return` statements made it through.
        // In a 0-based persistence regression these lines would be 3, 4
        // (one line below) — the equality check would fail both ways.
        const returnAnchors = fooAnchors.filter(a => a.kind === 'return');
        expect(returnAnchors.length).toBe(2);
        const returnLines = returnAnchors.map(a => a.line).sort((a, b) => a - b);
        // First return is on line 4 (`return x * 2`), second on line 5
        // (`return 0`). 0-based persistence would yield [3, 4].
        expect(returnLines).toEqual([4, 5]);
    });
});

// ---------------------------------------------------------------------------
// FIX4 — Python class whose last method ends on the class's final row
// ---------------------------------------------------------------------------

describe('indexing extract — last-method-ends-on-class-row structure ownership', () => {
    it('last method s structure row carries the methods params, not the empty class params', async () => {
        // Fixture: class C with two methods; `last` ends on the same line
        // as the class itself.
        //   1:  class C:
        //   2:      def first(self):
        //   3:          return 1
        //   4:      def last(self, a: int, b: str) -> None:
        //   5:          self.a = a
        //   6:          self.b = b
        //
        // The pre-integration extractor's positional structure walk had a
        // clause-2 match (`startRow <= startRow && endRow === endRow`) that
        // returned the CLASS for `last` because the class's endRow (5) ===
        // last's endRow (5). Result: `last`'s structure row inherited the
        // class's params (empty list), silently erasing the method's
        // signature.
        //
        // The fix is the new extractStructureForDef signature: the indexer
        // passes the cached spanNode (the function_definition) directly,
        // and structure no longer needs a positional search.
        const source = [
            'class C:',
            '    def first(self):',
            '        return 1',
            '    def last(self, a: int, b: str) -> None:',
            '        self.a = a',
            '        self.b = b',
        ].join('\n');

        const rec = await extractParsedFile(source, 'python', 'fix4.py', 'hash4');
        expect(rec).not.toBeNull();

        const cls = rec.symbols.find(s => s.name === 'C' && s.kind === 'def');
        const last = rec.symbols.find(s => s.name === 'last' && s.kind === 'def');

        expect(cls).toBeTruthy();
        expect(cls.type).toBe('class');
        expect(cls.line).toBe(1);
        expect(cls.endLine).toBe(6);

        expect(last).toBeTruthy();
        expect(last.type).toBe('function');
        expect(last.line).toBe(4);
        // The method's own end coincides with the class's end here — the
        // false-outer-match clause exploits exactly this alignment.
        expect(last.endLine).toBe(6);
        expect(last.endLine).toBe(cls.endLine);

        // The structure row for `last` must be present AND carry the
        // method's params, not the class's empty params. The class has
        // no `parameters` container in Python, so a false-outer-match
        // surfaces as an empty params list on the method.
        const lastKey = `last:${last.line}:${last.column}`;
        const lastStruct = rec.structures.find(st => st.parentSymbolKey === lastKey);

        expect(lastStruct).toBeTruthy();
        // Three parameters: self (identifier), a: int (typed_parameter),
        // b: str (typed_parameter). The grammar surfaces each parameter
        // as its AST node type — the load-bearing check is "non-empty
        // with three entries" (a regression to the class would yield 0).
        expect(lastStruct.params.length).toBe(3);
        // Sanity-check: at least one entry must be a typed_parameter
        // (the explicit `a: int` / `b: str` ones). If the indexer ever
        // attached the class node here, params would be empty.
        expect(lastStruct.params).toContain('typed_parameter');
    });
});
