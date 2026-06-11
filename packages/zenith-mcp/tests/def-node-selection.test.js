// ---------------------------------------------------------------------------
// def-node-selection.test.js
//
// Behavioral tests for the definition-node selection logic in
// packages/zenith-mcp/src/core/tree-sitter/symbols.ts.
//
// The selection function — `selectDefinitionNode(nameNode)` — walks
// DEF_TYPES-typed ancestors of a name node from inside out, picks the
// tightest as `primaryNode`, and (when applicable) reports the outer
// wrapper as `spanNode`. `getSymbols()` uses `primaryNode.endPosition` for
// each definition's `endLine`, which gives every nested or wrapped
// definition its own range — a parent container can never silently
// inherit child params or returns, and a child can never accidentally
// extend its span over the parent.
//
// These tests lock in that contract for:
//   - interface and class methods nested inside parent types
//   - decorated functions (Python @decorator)
//   - fields, properties, methods inside a class body
//   - generic functions with type parameters and value parameters
//
// Plus one direct test against `selectDefinitionNode()` to verify the
// `primaryNode` / `spanNode` split is observable for Python decorators —
// the wrapper-unwrap primitive future signature-extraction code depends
// on.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { Parser } from 'web-tree-sitter';
// `getDefinitions` and `loadLanguage` are pre-existing exports from the
// public tree-sitter barrel. The new selection primitives — `DEF_TYPES`
// and `selectDefinitionNode` — are intentionally NOT exposed at the
// barrel because they are extraction internals on the DB ingestion path,
// not a general public symbol API. The test imports them directly from
// the symbols submodule to validate the internals without promoting
// them to public surface.
import { loadLanguage } from '../dist/core/tree-sitter.js';
import { DEF_TYPES, getDefinitions, selectDefinitionNode } from '../dist/core/tree-sitter/symbols.js';

// Helper: locate the first AST node whose type matches `predicate` and
// whose `.text` equals `name`. Used by the direct selection test to find
// the identifier for a known definition without hard-coding offsets.
function findNamedNode(root, name, predicate) {
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (predicate(node) && node.text === name) {
            return node;
        }
        for (let i = node.childCount - 1; i >= 0; i--) {
            const child = node.child(i);
            if (child) stack.push(child);
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// 1. Interface / class methods inside parent types
// ---------------------------------------------------------------------------

describe('def-node selection — methods inside interfaces and classes', () => {
    it('TS interface methods get their own range, not the interface range', async () => {
        // Greeter spans lines 2-5 (4 lines). greet sits on line 3 (single-line
        // signature). If the selector mistakenly used the interface as the
        // method's owner, greet.endLine would equal 5 (Greeter.endLine).
        const source = [
            '',
            'interface Greeter {',
            '    greet(name: string): string;',
            '    farewell(): void;',
            '}',
            '',
        ].join('\n');

        const defs = await getDefinitions(source, 'typescript');

        const greeter = defs.find(d => d.name === 'Greeter');
        const greet = defs.find(d => d.name === 'greet');
        const farewell = defs.find(d => d.name === 'farewell');

        expect(greeter).toBeTruthy();
        expect(greeter.type).toBe('interface');
        expect(greeter.line).toBe(2);
        expect(greeter.endLine).toBe(5);

        expect(greet).toBeTruthy();
        expect(greet.line).toBe(3);
        expect(greet.endLine).toBe(3);
        expect(greet.endLine).toBeLessThan(greeter.endLine);

        expect(farewell).toBeTruthy();
        expect(farewell.line).toBe(4);
        expect(farewell.endLine).toBe(4);
        expect(farewell.endLine).toBeLessThan(greeter.endLine);
    });

    it('TS class methods get their own range, not the class range', async () => {
        // HelloGreeter spans many lines; each method should report its own
        // body's end, not the class's end. greet's body ends at line 7;
        // farewell's body ends at line 11. If the selector returned the
        // class as the owner, both methods would have endLine === 12.
        const source = [
            '',
            'class HelloGreeter {',
            '    greet(name: string): string {',
            '        const m = "hello";',
            '        return m + " " + name;',
            '    }',
            '',
            '    farewell(): void {',
            '        return;',
            '    }',
            '}',
            '',
        ].join('\n');

        const defs = await getDefinitions(source, 'typescript');

        const klass = defs.find(d => d.name === 'HelloGreeter');
        const greet = defs.find(d => d.name === 'greet');
        const farewell = defs.find(d => d.name === 'farewell');

        expect(klass).toBeTruthy();
        expect(klass.type).toBe('class');
        expect(klass.line).toBe(2);
        expect(klass.endLine).toBe(11);

        expect(greet).toBeTruthy();
        expect(greet.type).toBe('method');
        expect(greet.line).toBe(3);
        expect(greet.endLine).toBe(6);
        expect(greet.endLine).toBeLessThan(klass.endLine);

        expect(farewell).toBeTruthy();
        expect(farewell.type).toBe('method');
        expect(farewell.line).toBe(8);
        expect(farewell.endLine).toBe(10);
        expect(farewell.endLine).toBeLessThan(klass.endLine);
    });
});

// ---------------------------------------------------------------------------
// 2. Decorated functions (Python)
// ---------------------------------------------------------------------------

describe('def-node selection — decorated functions', () => {
    it('Python decorated function reports the def line for the name, not the decorator line', async () => {
        // The selector should anchor `line` to the identifier `foo`, which
        // sits on the `def` line (line 3), not the `@my_decorator` line
        // (line 2). `endLine` should be the function body's end (line 4),
        // which comes from the tightest DEF_TYPES ancestor
        // (function_definition) rather than the wrapping
        // decorated_definition.
        const source = [
            '',
            '@my_decorator',
            'def foo(x: int) -> int:',
            '    return x * 2',
            '',
        ].join('\n');

        const defs = await getDefinitions(source, 'python');
        const foo = defs.find(d => d.name === 'foo');

        expect(foo).toBeTruthy();
        expect(foo.type).toBe('function');
        expect(foo.line).toBe(3);
        expect(foo.endLine).toBe(4);
    });

    it('Python decorated method inside a class gets its own range, strictly inside the class', async () => {
        // The fixture is deliberately structured so MyClass.endLine and
        // bar.endLine cannot accidentally coincide — there's trailing
        // class content after bar. If the selector mistakenly used the
        // class as bar's owner, bar.endLine would jump to the class's
        // last line and the strict less-than assertion would fail.
        const source = [
            '',
            '',
            '',
            '',
            'class MyClass:',
            '    @classmethod',
            '    def bar(cls):',
            '        return cls.__name__',
            '',
            '    other_attr = 42',
            '    last_attr = "tail"',
            '',
        ].join('\n');

        const defs = await getDefinitions(source, 'python');
        const myClass = defs.find(d => d.name === 'MyClass');
        const bar = defs.find(d => d.name === 'bar');

        expect(myClass).toBeTruthy();
        expect(myClass.type).toBe('class');
        expect(myClass.line).toBe(5);
        expect(myClass.endLine).toBe(11);

        expect(bar).toBeTruthy();
        expect(bar.type).toBe('function');
        expect(bar.line).toBe(7);
        expect(bar.endLine).toBe(8);
        // Strict span-tightness: bar's range must NOT extend through the
        // trailing class attributes — that would mean the class was
        // mistakenly chosen as bar's owner.
        expect(bar.endLine).toBeLessThan(myClass.endLine);
    });

    it('selectDefinitionNode does NOT attach a class-level wrapper to a nested non-decorated method', async () => {
        // Regression guard against "wrapper selection is too broad": a
        // `decorated_definition` that wraps a *class* must NEVER promote
        // itself to be the spanNode of methods nested inside that class.
        // If wrapper handling considered any ancestor (not just the
        // direct AST parent), then `method_one`'s spanNode would
        // mistakenly become the outer decorated_definition that covers
        // the entire class body — silently widening every method's
        // declared span. The contract: spanNode === primaryNode when no
        // wrapper sits directly above primary in the AST.
        const source = [
            '@my_class_dec',
            'class WrappedClass:',
            '    def method_one(self):',
            '        return 1',
            '',
        ].join('\n');

        const language = await loadLanguage('python');
        expect(language).toBeTruthy();
        const parser = new Parser();
        parser.setLanguage(language);
        const tree = parser.parse(source);
        expect(tree).toBeTruthy();

        try {
            const methodName = findNamedNode(tree.rootNode, 'method_one', n => n.type === 'identifier');
            expect(methodName).toBeTruthy();

            const sel = selectDefinitionNode(methodName);
            expect(sel).toBeTruthy();
            expect(sel.primaryNode.type).toBe('function_definition');
            // The class's decorated_definition IS in `candidates`, but
            // it does not sit as the direct parent of method_one's
            // function_definition (a `block` does), so it must NOT be
            // chosen as spanNode.
            expect(sel.spanNode.type).toBe('function_definition');
            expect(sel.spanNode).toBe(sel.primaryNode);

            // Sanity: the ancestor walk did encounter both the class
            // and its wrapper — the contract is about how spanNode is
            // chosen, not about hiding them from `candidates`.
            const types = sel.candidates.map(c => c.type);
            expect(types).toContain('function_definition');
            expect(types).toContain('class_definition');
            expect(types).toContain('decorated_definition');
        } finally {
            tree.delete();
            parser.delete();
        }
    });

    it('selectDefinitionNode unwraps Python decorated_definition: primary is function_definition, span is decorated_definition', async () => {
        // Direct test of the selection primitive. The contract: when a
        // function is decorated, `primaryNode` is the inner
        // function_definition (so future signature-extraction code walks
        // the right node for parameters) and `spanNode` is the outer
        // decorated_definition (so callers that want the full
        // decorator-inclusive range have a single source).
        const source = '@my_decorator\ndef foo(x):\n    return x\n';

        const language = await loadLanguage('python');
        expect(language).toBeTruthy();

        const parser = new Parser();
        parser.setLanguage(language);
        const tree = parser.parse(source);
        expect(tree).toBeTruthy();

        try {
            const fooName = findNamedNode(tree.rootNode, 'foo', n => n.type === 'identifier');
            expect(fooName).toBeTruthy();

            const selection = selectDefinitionNode(fooName);
            expect(selection).toBeTruthy();
            expect(selection.primaryNode.type).toBe('function_definition');
            expect(selection.spanNode.type).toBe('decorated_definition');
            expect(selection.primaryNode).not.toBe(selection.spanNode);

            // The span starts on the decorator line; the primary starts on
            // the def line. This is the source-of-truth split that future
            // signature extraction depends on.
            expect(selection.spanNode.startPosition.row).toBeLessThan(
                selection.primaryNode.startPosition.row
            );

            // Both candidates appear in the candidates list, innermost first.
            expect(selection.candidates.length).toBeGreaterThanOrEqual(2);
            expect(selection.candidates[0].type).toBe('function_definition');
            expect(selection.candidates[1].type).toBe('decorated_definition');
        } finally {
            tree.delete();
            parser.delete();
        }
    });

    it('selectDefinitionNode returns spanNode === primaryNode for a non-wrapped function', async () => {
        const source = 'def plain(x):\n    return x\n';

        const language = await loadLanguage('python');
        const parser = new Parser();
        parser.setLanguage(language);
        const tree = parser.parse(source);

        try {
            const name = findNamedNode(tree.rootNode, 'plain', n => n.type === 'identifier');
            expect(name).toBeTruthy();

            const selection = selectDefinitionNode(name);
            expect(selection).toBeTruthy();
            expect(selection.primaryNode.type).toBe('function_definition');
            // No wrapper applies — span and primary are the same node.
            expect(selection.spanNode).toBe(selection.primaryNode);
            // candidates includes the function plus any DEF_TYPES ancestor
            // up to (and possibly including) the file's root. tree-sitter
            // Python's root node type is `module`, which is in DEF_TYPES,
            // so candidates can legitimately contain function_definition
            // plus module. What matters is the tightest is the function.
            expect(selection.candidates.length).toBeGreaterThanOrEqual(1);
            expect(selection.candidates[0].type).toBe('function_definition');
        } finally {
            tree.delete();
            parser.delete();
        }
    });
});

// ---------------------------------------------------------------------------
// 3. Fields, properties, methods inside a class body
// ---------------------------------------------------------------------------

describe('def-node selection — fields, properties, methods in a class', () => {
    it('each class member gets its own tight range, never the class range', async () => {
        // User class spans lines 2-15. Each member (defaultName field, name
        // field, age field, constructor, greet method, displayName getter)
        // should land within its own definition, not extend to line 15.
        const source = [
            '',
            'class User {',
            '    static defaultName = "Anonymous";',
            '    name: string = "";',
            '    private age: number = 0;',
            '',
            '    constructor(name: string) {',
            '        this.name = name;',
            '    }',
            '',
            '    greet(): string {',
            '        return "Hello, " + this.name;',
            '    }',
            '',
            '    get displayName(): string {',
            '        return this.name.toUpperCase();',
            '    }',
            '}',
            '',
        ].join('\n');

        const defs = await getDefinitions(source, 'typescript');
        const user = defs.find(d => d.name === 'User');

        expect(user).toBeTruthy();
        expect(user.type).toBe('class');
        expect(user.line).toBe(2);
        expect(user.endLine).toBe(18);

        // Every other definition with a known member name must land STRICTLY
        // inside the User class span, and must NOT inherit User.endLine.
        const memberNames = ['defaultName', 'name', 'age', 'constructor', 'greet', 'displayName'];
        for (const memberName of memberNames) {
            const member = defs.find(d => d.name === memberName);
            if (!member) continue; // grammar may not surface every member
            expect(member.line).toBeGreaterThanOrEqual(user.line);
            expect(member.endLine).toBeLessThan(user.endLine);
        }

        // Spot-check a few key members directly so a regression to "all
        // members got class.endLine" can't slip through if some member
        // happened not to be captured by the grammar.
        const constructor = defs.find(d => d.name === 'constructor');
        const greet = defs.find(d => d.name === 'greet');
        if (constructor) {
            expect(constructor.line).toBe(7);
            expect(constructor.endLine).toBe(9);
        }
        if (greet) {
            expect(greet.line).toBe(11);
            expect(greet.endLine).toBe(13);
        }
    });
});

// ---------------------------------------------------------------------------
// 4. Generic functions with type parameters AND value parameters
// ---------------------------------------------------------------------------

describe('def-node selection — generic functions', () => {
    it('TS generic function reports the function name without type-parameter leakage', async () => {
        const source = [
            '',
            'function identity<T extends object>(value: T, label: string): T {',
            '    return value;',
            '}',
            '',
        ].join('\n');

        const defs = await getDefinitions(source, 'typescript');
        const id = defs.find(d => d.name === 'identity');

        expect(id).toBeTruthy();
        expect(id.type).toBe('function');
        expect(id.line).toBe(2);
        expect(id.endLine).toBe(4);
        // The captured name is exactly "identity" — type parameters do not
        // bleed into the name (a regression here would surface as
        // "identity<T extends object>" or similar).
        expect(id.name).toBe('identity');
    });

    it('TS generic method inside a generic class keeps method range distinct from class range', async () => {
        const source = [
            '',
            'class Box<T> {',
            '    private value: T;',
            '',
            '    constructor(value: T) {',
            '        this.value = value;',
            '    }',
            '',
            '    map<U>(fn: (v: T) => U): Box<U> {',
            '        return new Box<U>(fn(this.value));',
            '    }',
            '}',
            '',
        ].join('\n');

        const defs = await getDefinitions(source, 'typescript');
        const box = defs.find(d => d.name === 'Box');
        const map = defs.find(d => d.name === 'map');

        expect(box).toBeTruthy();
        expect(box.type).toBe('class');
        expect(box.line).toBe(2);
        expect(box.endLine).toBe(12);

        expect(map).toBeTruthy();
        expect(map.type).toBe('method');
        expect(map.name).toBe('map');
        expect(map.line).toBe(9);
        expect(map.endLine).toBe(11);
        // Hard span-tightness check: the method's end must precede the
        // class's end, even though the method is generic and lives inside
        // a generic class.
        expect(map.endLine).toBeLessThan(box.endLine);
    });
});

// ---------------------------------------------------------------------------
// Sanity: DEF_TYPES is the vocabulary backbone of the selector
// ---------------------------------------------------------------------------

describe('def-node selection — DEF_TYPES wiring', () => {
    it('DEF_TYPES contains the node types this test relies on', () => {
        // If a future edit accidentally drops one of these from DEF_TYPES,
        // selectDefinitionNode would silently skip the right ancestor and
        // these behavioral tests would fail in confusing ways. Catch it
        // here with a clear error instead.
        const required = [
            'class_declaration',
            'interface_declaration',
            'method_definition',
            'method_signature',
            'function_declaration',
            'function_definition',
            'decorated_definition',
            'class_definition',
            'public_field_definition',
        ];
        for (const t of required) {
            expect(DEF_TYPES.has(t), `DEF_TYPES is missing '${t}'`).toBe(true);
        }
    });
});
