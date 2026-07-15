// polaris-no-non-null.test.js — POLARIS Task 1.5
//
// Syntax-aware production gate. Parses every src/**/*.ts with the TypeScript
// compiler API and asserts ZERO postfix non-null assertion nodes
// (ts.SyntaxKind.NonNullExpression, i.e. `expr!`).
//
// Why AST and not regex: a `!` character cannot be classified by text alone.
// A regex gate would false-positive on logical-NOT (`!x`), inequality
// (`x !== y`), and — verified in this repo — the tree-sitter `#set!`
// predicate names that appear in comments in
// src/core/tree-sitter/injections.ts. It would also mis-handle
// definite-assignment assertions (`foo!: Bar`), which are a different syntax
// kind (a PropertyDeclaration exclamation token, NOT a NonNullExpression) and
// are intentionally out of scope for this gate. Only NonNullExpression nodes
// are production non-null assertions; this gate flags exactly those.

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');

/** Recursively collect every non-declaration `.ts` file under `dir`, sorted. */
function collectTsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectTsFiles(full));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out.sort();
}

/** Every NonNullExpression node in `text`, as `{ line, column, snippet }` (1-based). */
function findNonNullAssertions(fileName, text) {
    const sf = ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        ts.ScriptKind.TS,
    );
    const lines = text.split('\n');
    const hits = [];
    const visit = (node) => {
        if (node.kind === ts.SyntaxKind.NonNullExpression) {
            const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            hits.push({ line: line + 1, column: character + 1, snippet: (lines[line] ?? '').trim() });
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return hits;
}

describe('POLARIS Task 1.5 — no production non-null assertions', () => {
    const files = collectTsFiles(SRC_DIR);

    // --- Detector self-tests: keep the gate from ever passing vacuously ---

    it('scans a non-trivial number of source files', () => {
        expect(files.length).toBeGreaterThan(50);
    });

    it('positive control: the detector DOES flag a NonNullExpression', () => {
        expect(findNonNullAssertions('control.ts', 'const y = x!.foo;')).toHaveLength(1);
        expect(findNonNullAssertions('control.ts', 'const n = map.get(k)!;')).toHaveLength(1);
    });

    it('negative control: the detector does NOT flag !, !==, or definite-assignment', () => {
        const sample = [
            'const a = !x;',                       // logical NOT (PrefixUnaryExpression)
            'if (x !== y) {}',                     // inequality (BinaryExpression)
            'class C { foo!: number; }',           // definite-assignment (out of scope)
            'let bar!: string;',                   // definite-assignment on a variable
            '// #set! injection.language "sql"',   // tree-sitter predicate in a comment
        ].join('\n');
        expect(findNonNullAssertions('control.ts', sample)).toHaveLength(0);
    });

    // --- The gate ---

    it('finds zero NonNullExpression nodes across src/**/*.ts', () => {
        const violations = [];
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            for (const hit of findNonNullAssertions(file, text)) {
                violations.push(`${path.relative(SRC_DIR, file)}:${hit.line}:${hit.column}  ${hit.snippet}`);
            }
        }
        expect(
            violations,
            `Found ${violations.length} production non-null assertion(s) under src/**/*.ts:\n${violations.join('\n')}`,
        ).toHaveLength(0);
    });
});
