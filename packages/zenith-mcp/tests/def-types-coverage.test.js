// ---------------------------------------------------------------------------
// def-types-coverage.test.js
//
// Regression test for DEF_TYPES (exported from
// packages/zenith-mcp/src/core/tree-sitter/symbols.ts).
//
// Re-parses every shipped *-tags.scm file at test time, extracts the
// outermost AST node type of each pattern that carries a
// @definition.<kind> or @name.definition.<kind> capture, and asserts that
// every such node type is present in DEF_TYPES.
//
// This guards against silently broken coverage: if a future grammar query
// edit introduces a new definition node type, this test fails with the
// exact node type and language that needs to be added to DEF_TYPES.
//
// The parser below intentionally does NOT use web-tree-sitter to walk the
// .scm files — it is a tiny S-expression scanner that mirrors how the
// runtime extractor interprets capture names. Keeping it inline (rather
// than importing from src) means the test stays the independent ground
// truth: the implementation and the test cannot share a bug here.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEF_TYPES } from '../dist/core/tree-sitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.resolve(__dirname, '../grammars/queries');

// ---------------------------------------------------------------------------
// Tree-sitter query (.scm) parser
// ---------------------------------------------------------------------------

const DEF_CAPTURE_RE = /@(?:name\.)?definition\.[\w_.-]+/;
const IDENT_RE = /^([_a-zA-Z][\w]*)/;

function stripComments(text) {
    // Tree-sitter query comments: `;` to end of line, but `;` inside a
    // double-quoted string (predicate args) is literal text, not a comment.
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const c = text[i];
        if (inString) {
            if (c === '\\') {
                // Escape sequence inside a quoted string — copy both chars
                // verbatim. If a stray backslash sits at EOF the input is
                // malformed; fail loudly rather than fabricating a missing char.
                if (i + 1 >= text.length) {
                    throw new Error('Malformed tree-sitter query: trailing backslash in string literal');
                }
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

// Yield the outermost node-type identifier(s) for a pattern that spans
// text[start..end]. `(node_type ...)` yields one type; `[(a) (b) (c)]`
// yields each child's outermost type. Predicates like `(#match? ...)`
// yield nothing.
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
                // skip trailing quantifier and capture on the child
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

// Public entry point — extract every definition node type from one .scm file.
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
        if (end === -1) {
            throw new Error(`Malformed tree-sitter query: unmatched '${c}' at offset ${i}`);
        }
        // search for definition markers
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
// Tests
// ---------------------------------------------------------------------------

describe('DEF_TYPES coverage against shipped *-tags.scm', () => {
    it('exports a non-empty DEF_TYPES Set', () => {
        expect(DEF_TYPES).toBeInstanceOf(Set);
        expect(DEF_TYPES.size).toBeGreaterThan(100);
    });

    it('finds the shipped grammars/queries directory with tags files', async () => {
        const stat = await fs.stat(QUERIES_DIR);
        expect(stat.isDirectory()).toBe(true);
        const files = (await fs.readdir(QUERIES_DIR)).filter(f => f.endsWith('-tags.scm'));
        // 36 ships today (bash, c, c_sharp, cpp, csharp, css, dockerfile, go,
        // graphql, hcl, html, java, javascript, json, kotlin, lua, markdown,
        // nix, php, prisma, proto, python, query, regex, ruby, rust, scss,
        // sql, svelte, swift, toml, tsx, typescript, vue, xml, yaml).
        expect(files.length).toBeGreaterThanOrEqual(36);
    });

    it('covers every definition node type used in any shipped tags.scm', async () => {
        const files = (await fs.readdir(QUERIES_DIR))
            .filter(f => f.endsWith('-tags.scm'))
            .sort();

        const perLang = new Map();
        const allTypes = new Set();
        for (const f of files) {
            const text = await fs.readFile(path.join(QUERIES_DIR, f), 'utf-8');
            const types = extractDefinitionNodeTypes(text);
            perLang.set(f.replace('-tags.scm', ''), types);
            for (const t of types) allTypes.add(t);
        }

        // Sanity-check the parser is doing real work — if the parser
        // silently breaks (e.g. regex regression) we'd otherwise pass.
        expect(allTypes.size).toBeGreaterThan(100);

        const missing = [...allTypes].filter(t => !DEF_TYPES.has(t)).sort();

        if (missing.length > 0) {
            const lines = [
                `DEF_TYPES is missing ${missing.length} definition node ` +
                `type(s) that shipped tags.scm files reference:`,
                '',
            ];
            for (const t of missing) {
                const langs = [...perLang.entries()]
                    .filter(([_, types]) => types.has(t))
                    .map(([lang]) => lang)
                    .sort();
                lines.push(`  - ${t}  (used in: ${langs.join(', ')})`);
            }
            lines.push('');
            lines.push(
                'Add the missing node types to DEF_TYPES in ' +
                'packages/zenith-mcp/src/core/tree-sitter/symbols.ts ' +
                '(keep the list alphabetical).'
            );
            throw new Error(lines.join('\n'));
        }

        expect(missing).toEqual([]);
    });
});
