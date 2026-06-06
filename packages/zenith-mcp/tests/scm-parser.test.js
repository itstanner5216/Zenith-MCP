// ---------------------------------------------------------------------------
// scm-parser.test.js
//
// Unit tests for the four S-expression / tree-sitter query helper functions
// that live inside packages/zenith-mcp/tests/def-types-coverage.test.js.
//
// Because those helpers are not exported (they are intentionally inline in
// the coverage test file to serve as an independent ground-truth parser),
// we re-inline them here verbatim and exercise them at the unit level.
//
// This file validates:
//   - stripComments()
//   - findMatchingClose()
//   - outermostNodeTypes()
//   - extractDefinitionNodeTypes()
//
// The test cases deliberately cover edge cases that the integration test
// (def-types-coverage.test.js) does not exercise in isolation.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Re-inline the helpers (verbatim copy from def-types-coverage.test.js)
// ---------------------------------------------------------------------------

const DEF_CAPTURE_RE = /@(?:name\.)?definition\.[\w_.-]+/;
const IDENT_RE = /^([_a-zA-Z][\w]*)/;

function stripComments(text) {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const c = text[i];
        if (inString) {
            if (c === '\\') {
                if (i + 1 >= text.length) break;
                out += c;
                out += text[i + 1];
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            out += c;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === ';') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

function findMatchingClose(text, start) {
    const open = text[start];
    const close = open === '(' ? ')' : ']';
    let depth = 0;
    let i = start;
    let inString = false;
    while (i < text.length) {
        const c = text[i];
        if (inString) {
            if (c === '\\') { i += 2; continue; }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') { inString = true; i++; continue; }
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') {
            depth--;
            if (depth === 0 && c === close) return i;
        }
        i++;
    }
    return -1;
}

function outermostNodeTypes(text, start, end) {
    const head = text[start];
    if (head === '(') {
        let i = start + 1;
        while (i < end && /\s/.test(text[i])) i++;
        if (text[i] === '#') return [];
        const m = IDENT_RE.exec(text.slice(i, end));
        return m ? [m[1]] : [];
    }
    if (head === '[') {
        const types = [];
        let i = start + 1;
        while (i < end) {
            while (i < end && /\s/.test(text[i])) i++;
            if (i >= end) break;
            if (text[i] === '(' || text[i] === '[') {
                const childEnd = findMatchingClose(text, i);
                if (childEnd === -1) break;
                for (const t of outermostNodeTypes(text, i, childEnd)) types.push(t);
                i = childEnd + 1;
                while (i < end && /\s/.test(text[i])) i++;
                if (i < end && /[?*+!]/.test(text[i])) i++;
                while (i < end && /\s/.test(text[i])) i++;
                if (i < end && text[i] === '@') {
                    i++;
                    while (i < end && /[\w.\-]/.test(text[i])) i++;
                }
            } else {
                i++;
            }
        }
        return types;
    }
    return [];
}

function extractDefinitionNodeTypes(scmText) {
    const text = stripComments(scmText);
    const types = new Set();
    const n = text.length;
    let i = 0;
    while (i < n) {
        while (i < n && /\s/.test(text[i])) i++;
        if (i >= n) break;
        const c = text[i];
        if (c !== '(' && c !== '[') { i++; continue; }
        const end = findMatchingClose(text, i);
        if (end === -1) break;
        let after = end + 1;
        while (after < n && /\s/.test(text[after])) after++;
        if (after < n && /[?*+!]/.test(text[after])) after++;
        while (after < n && /\s/.test(text[after])) after++;
        if (after < n && text[after] === '@') {
            after++;
            while (after < n && /[\w.\-]/.test(text[after])) after++;
        }
        const pattern = text.slice(i, after);
        if (DEF_CAPTURE_RE.test(pattern)) {
            for (const t of outermostNodeTypes(text, i, end)) {
                if (t && t !== '_') types.add(t);
            }
        }
        i = after;
    }
    return types;
}

// ---------------------------------------------------------------------------
// stripComments tests
// ---------------------------------------------------------------------------

describe('stripComments', () => {
    it('returns empty string unchanged', () => {
        expect(stripComments('')).toBe('');
    });

    it('removes a single-line comment that starts with ;', () => {
        const result = stripComments('; this is a comment\n');
        expect(result).toBe('\n');
    });

    it('removes inline comments after code', () => {
        const result = stripComments('(function_declaration) ; trailing comment\n');
        expect(result).toBe('(function_declaration) \n');
    });

    it('preserves semicolons inside double-quoted strings', () => {
        const result = stripComments('(#match? @cap "a;b;c")');
        expect(result).toBe('(#match? @cap "a;b;c")');
    });

    it('handles multiple comments across lines', () => {
        const input = '; line 1\ncode ; inline\n; line 3\n';
        const result = stripComments(input);
        expect(result).toBe('\ncode \n\n');
    });

    it('handles text with no comments', () => {
        const input = '(class_declaration name: (identifier) @name.definition.class)';
        expect(stripComments(input)).toBe(input);
    });

    it('preserves escaped quote inside a string', () => {
        const input = '(#match? @cap "say \\"hi\\"")';
        const result = stripComments(input);
        expect(result).toBe(input);
    });

    it('handles a stray backslash at EOF in a string gracefully', () => {
        // Malformed input — the function should not throw or loop infinitely
        const input = '"trailing\\';
        expect(() => stripComments(input)).not.toThrow();
    });

    it('preserves newlines that follow a comment', () => {
        const result = stripComments('; comment\ncode\n');
        expect(result).toBe('\ncode\n');
    });

    it('handles multiple semicolons on the same line as a comment', () => {
        const result = stripComments(';;; double semi\n');
        expect(result).toBe('\n');
    });
});

// ---------------------------------------------------------------------------
// findMatchingClose tests
// ---------------------------------------------------------------------------

describe('findMatchingClose', () => {
    it('finds matching ) for opening ( at index 0', () => {
        const text = '(hello)';
        expect(findMatchingClose(text, 0)).toBe(6);
    });

    it('finds matching ] for opening [ at index 0', () => {
        const text = '[a b c]';
        expect(findMatchingClose(text, 0)).toBe(6);
    });

    it('handles nested parens', () => {
        const text = '(a (b (c) d) e)';
        expect(findMatchingClose(text, 0)).toBe(14);
    });

    it('finds inner closing paren when start points to inner open', () => {
        const text = '(a (b) c)';
        expect(findMatchingClose(text, 3)).toBe(5);
    });

    it('returns -1 when there is no matching close', () => {
        const text = '(unclosed';
        expect(findMatchingClose(text, 0)).toBe(-1);
    });

    it('returns -1 for an empty string', () => {
        expect(findMatchingClose('(', 0)).toBe(-1);
    });

    it('handles parens inside double-quoted strings (not counted as delimiters)', () => {
        const text = '(#match? "a(b)")';
        // The ) inside the string should not end the expression
        expect(findMatchingClose(text, 0)).toBe(15);
    });

    it('handles escaped quote inside string', () => {
        const text = '(#match? "a\\"b\\"c")';
        const result = findMatchingClose(text, 0);
        expect(result).toBe(text.length - 1);
    });

    it('handles consecutive sibling parens: returns close of first', () => {
        const text = '(a) (b)';
        expect(findMatchingClose(text, 0)).toBe(2);
        expect(findMatchingClose(text, 4)).toBe(6);
    });

    it('handles bracket-inside-paren nesting', () => {
        const text = '([a b] c)';
        expect(findMatchingClose(text, 0)).toBe(8);
        expect(findMatchingClose(text, 1)).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// outermostNodeTypes tests
// ---------------------------------------------------------------------------

describe('outermostNodeTypes', () => {
    it('extracts a single node type from a simple pattern', () => {
        const text = '(class_declaration)';
        const end = findMatchingClose(text, 0);
        expect(outermostNodeTypes(text, 0, end)).toEqual(['class_declaration']);
    });

    it('returns empty array for a predicate pattern (#match? etc.)', () => {
        const text = '(#match? @cap "foo")';
        const end = findMatchingClose(text, 0);
        expect(outermostNodeTypes(text, 0, end)).toEqual([]);
    });

    it('extracts multiple node types from an alternation [...]', () => {
        const text = '[(class_declaration) (class_definition)]';
        const end = findMatchingClose(text, 0);
        const types = outermostNodeTypes(text, 0, end);
        expect(types).toContain('class_declaration');
        expect(types).toContain('class_definition');
        expect(types).toHaveLength(2);
    });

    it('handles alternation with three members', () => {
        const text = '[(function_declaration) (function_definition) (function_expression)]';
        const end = findMatchingClose(text, 0);
        const types = outermostNodeTypes(text, 0, end);
        expect(types).toEqual(['function_declaration', 'function_definition', 'function_expression']);
    });

    it('returns empty array when text starts with something other than ( or [', () => {
        expect(outermostNodeTypes('@capture', 0, 7)).toEqual([]);
    });

    it('handles node types with leading whitespace inside parens', () => {
        const text = '(  class_declaration  )';
        const end = findMatchingClose(text, 0);
        expect(outermostNodeTypes(text, 0, end)).toEqual(['class_declaration']);
    });

    it('handles alternation members with trailing captures', () => {
        // Members inside [...] can carry @captures; these should be skipped
        const text = '[(class_declaration) @cap (struct_specifier) @cap2]';
        const end = findMatchingClose(text, 0);
        const types = outermostNodeTypes(text, 0, end);
        expect(types).toContain('class_declaration');
        expect(types).toContain('struct_specifier');
    });

    it('returns empty array for an empty paren group', () => {
        const text = '()';
        const end = findMatchingClose(text, 0);
        expect(outermostNodeTypes(text, 0, end)).toEqual([]);
    });

    it('returns empty array for empty alternation', () => {
        const text = '[]';
        const end = findMatchingClose(text, 0);
        expect(outermostNodeTypes(text, 0, end)).toEqual([]);
    });

    it('handles nested patterns — only returns outermost type', () => {
        const text = '(class_declaration body: (class_body))';
        const end = findMatchingClose(text, 0);
        // Should only return the outermost node type
        expect(outermostNodeTypes(text, 0, end)).toEqual(['class_declaration']);
    });

    it('handles camelCase XML node types', () => {
        const text = '(STag)';
        const end = findMatchingClose(text, 0);
        expect(outermostNodeTypes(text, 0, end)).toEqual(['STag']);
    });

    it('handles underscore-started identifiers', () => {
        const text = '(_node_type)';
        const end = findMatchingClose(text, 0);
        expect(outermostNodeTypes(text, 0, end)).toEqual(['_node_type']);
    });
});

// ---------------------------------------------------------------------------
// extractDefinitionNodeTypes tests
// ---------------------------------------------------------------------------

describe('extractDefinitionNodeTypes', () => {
    it('returns an empty Set for empty input', () => {
        const result = extractDefinitionNodeTypes('');
        expect(result).toBeInstanceOf(Set);
        expect(result.size).toBe(0);
    });

    it('returns an empty Set for input with no definition captures', () => {
        const scm = '(function_declaration name: (identifier) @name)';
        expect(extractDefinitionNodeTypes(scm).size).toBe(0);
    });

    it('extracts node type from @definition.* capture', () => {
        const scm = '(function_declaration) @definition.function';
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('function_declaration')).toBe(true);
    });

    it('extracts node type from @name.definition.* capture', () => {
        const scm = '(class_declaration name: (identifier) @name.definition.class)';
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('class_declaration')).toBe(true);
    });

    it('ignores @reference.* captures', () => {
        const scm = '(identifier) @name.reference.class';
        const result = extractDefinitionNodeTypes(scm);
        expect(result.size).toBe(0);
    });

    it('ignores plain @name captures without definition.', () => {
        const scm = '(identifier) @name';
        const result = extractDefinitionNodeTypes(scm);
        expect(result.size).toBe(0);
    });

    it('handles multiple patterns with definition captures', () => {
        const scm = `
(function_declaration) @definition.function
(class_declaration) @definition.class
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('function_declaration')).toBe(true);
        expect(result.has('class_declaration')).toBe(true);
    });

    it('strips comments before extracting node types', () => {
        const scm = `
; This is a comment, not code
(struct_item) @definition.struct ; inline comment
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('struct_item')).toBe(true);
    });

    it('handles alternation in pattern (bracket syntax)', () => {
        const scm = `
[
  (function_declaration)
  (function_definition)
] @definition.function
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('function_declaration')).toBe(true);
        expect(result.has('function_definition')).toBe(true);
    });

    it('does not include wildcard _ type', () => {
        const scm = '(_) @definition.something';
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('_')).toBe(false);
    });

    it('does not include predicate patterns (#match? etc.)', () => {
        const scm = `
(function_declaration
  (#match? @name "^[A-Z]")) @definition.function
`;
        const result = extractDefinitionNodeTypes(scm);
        // function_declaration should still be captured
        expect(result.has('function_declaration')).toBe(true);
    });

    it('handles patterns with nested child nodes (only outermost matters)', () => {
        const scm = `
(class_declaration
  name: (identifier) @name.definition.class
  body: (class_body))
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('class_declaration')).toBe(true);
        // Inner 'identifier' should not be captured
        expect(result.has('identifier')).toBe(false);
    });

    it('deduplicates node types that appear in multiple patterns', () => {
        const scm = `
(function_declaration) @definition.function
(function_declaration
  name: (identifier) @name.definition.function)
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('function_declaration')).toBe(true);
        // Set — no duplicates
        expect(result.size).toBe(1);
    });

    it('handles camelCase XML node types', () => {
        const scm = '(STag) @definition.element';
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('STag')).toBe(true);
    });

    it('returns a Set (not an array)', () => {
        const result = extractDefinitionNodeTypes('(fn_def) @definition.function');
        expect(result).toBeInstanceOf(Set);
    });

    it('handles .name.definition. capture variant with complex nested content', () => {
        const scm = `
(method_declaration
  name: (identifier) @name.definition.method
  parameters: (formal_parameters)
  body: (block))
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('method_declaration')).toBe(true);
    });

    it('is not confused by a semicolon inside a predicate string argument', () => {
        const scm = `
(function_declaration
  (#match? @name ";not;a;comment;")
  name: (identifier) @name.definition.function)
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('function_declaration')).toBe(true);
    });

    it('handles a real-world-style TypeScript pattern', () => {
        const scm = `
(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.variable
    value: [(arrow_function) (function_expression)])) @definition.variable
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('class_declaration')).toBe(true);
        expect(result.has('function_declaration')).toBe(true);
        expect(result.has('lexical_declaration')).toBe(true);
    });

    it('handles a real-world-style Rust pattern with alternation', () => {
        const scm = `
[
  (function_item)
  (function_signature_item)
] @definition.function

(struct_item name: (type_identifier) @name.definition.class)

(enum_item
  name: (type_identifier) @name.definition.enum)
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('function_item')).toBe(true);
        expect(result.has('struct_item')).toBe(true);
        expect(result.has('enum_item')).toBe(true);
    });

    it('handles input that is only comments', () => {
        const scm = `
; Just comments
; Nothing else here
`;
        const result = extractDefinitionNodeTypes(scm);
        expect(result.size).toBe(0);
    });

    it('handles patterns with optional quantifiers (? * +)', () => {
        // Quantifiers after a child node should be skipped, not confuse extraction
        const scm = '(block_statement (expression)? @name.definition.block)';
        // The outer node is block_statement
        const result = extractDefinitionNodeTypes(scm);
        expect(result.has('block_statement')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// DEF_CAPTURE_RE regex tests (the pattern used to identify definition captures)
// ---------------------------------------------------------------------------

describe('DEF_CAPTURE_RE regex', () => {
    it('matches @definition.<kind>', () => {
        expect(DEF_CAPTURE_RE.test('@definition.class')).toBe(true);
        expect(DEF_CAPTURE_RE.test('@definition.function')).toBe(true);
        expect(DEF_CAPTURE_RE.test('@definition.method')).toBe(true);
    });

    it('matches @name.definition.<kind>', () => {
        expect(DEF_CAPTURE_RE.test('@name.definition.class')).toBe(true);
        expect(DEF_CAPTURE_RE.test('@name.definition.variable')).toBe(true);
    });

    it('does not match @reference.*', () => {
        expect(DEF_CAPTURE_RE.test('@reference.class')).toBe(false);
        expect(DEF_CAPTURE_RE.test('@name.reference.class')).toBe(false);
    });

    it('does not match bare @name', () => {
        expect(DEF_CAPTURE_RE.test('@name')).toBe(false);
    });

    it('does not match @definition without a dot-suffix', () => {
        // Strictly, @definition alone is not a valid capture in tree-sitter
        // but the regex should not match it without a trailing .<kind>
        expect(DEF_CAPTURE_RE.test('@definition')).toBe(false);
    });

    it('matches definition captures with hyphenated kinds', () => {
        // Some grammars use hyphen-separated kinds
        expect(DEF_CAPTURE_RE.test('@definition.type-alias')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// IDENT_RE regex tests
// ---------------------------------------------------------------------------

describe('IDENT_RE regex', () => {
    it('matches plain snake_case identifiers', () => {
        const m = IDENT_RE.exec('class_declaration ...');
        expect(m).not.toBeNull();
        expect(m[1]).toBe('class_declaration');
    });

    it('matches camelCase identifiers', () => {
        const m = IDENT_RE.exec('STag ...');
        expect(m).not.toBeNull();
        expect(m[1]).toBe('STag');
    });

    it('matches identifiers starting with underscore', () => {
        const m = IDENT_RE.exec('_node ...');
        expect(m).not.toBeNull();
        expect(m[1]).toBe('_node');
    });

    it('does not match identifiers starting with a digit', () => {
        expect(IDENT_RE.exec('123foo')).toBeNull();
    });

    it('does not match identifiers starting with #', () => {
        // Tree-sitter predicates start with #
        expect(IDENT_RE.exec('#match? ...')).toBeNull();
    });

    it('stops at whitespace', () => {
        const m = IDENT_RE.exec('foo bar');
        expect(m[1]).toBe('foo');
    });
});
