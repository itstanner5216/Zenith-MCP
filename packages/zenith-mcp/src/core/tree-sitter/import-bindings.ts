// ---------------------------------------------------------------------------
// tree-sitter/import-bindings.ts — Binding-level import extraction
//
// Invariant: Walks the already-parsed tree root shared by indexing/extract.ts.
// Extracts local bindings, not compression decisions.
// ---------------------------------------------------------------------------

import type { Node } from 'web-tree-sitter';

export type ImportBindingKind = 'named' | 'default' | 'namespace';

export interface ImportBinding {
    source: string;
    localName: string;
    importedName: string | null;
    importKind: ImportBindingKind;
    isTypeOnly: boolean;
    line: number;
    column: number;
}

export interface ImportStatementSpan {
    module: string;
    line: number;
    startLine: number;
    endLine: number;
}

export interface ImportStatementFacts {
    span: ImportStatementSpan;
    bindings: ImportBinding[];
}

export function extractImportStatements(rootNode: Node, langName: string): ImportStatementFacts[] {
    if (langName !== 'typescript' && langName !== 'tsx' && langName !== 'javascript') return [];

    const statements: ImportStatementFacts[] = [];
    // `import_statement` is a top-level construct in JS/TS — always a direct
    // child of the program node — so walking the full tree is wasted work.
    for (let i = 0; i < rootNode.childCount; i++) {
        const node = rootNode.child(i);
        if (!node || node.type !== 'import_statement') continue;

        // The module specifier is the LAST direct `string` child of the
        // statement (the `from` clause) — a first-descendant search would find
        // a string-literal export name first: import { "a-b" as a } from "./m".
        // `import x = require("m")` keeps its specifier inside the require
        // clause, so that one is read from the clause's argument.
        const requireClause = findDirectChildOfType(node, 'import_require_clause');
        const sourceNode = requireClause
            ? findFirstDescendantOfType(requireClause, 'string')
            : findLastDirectChildOfType(node, 'string');
        if (!sourceNode) continue;
        const module = stringLiteralValue(sourceNode);

        // Bindings are extracted from THIS statement node, so a binding can
        // never be attributed to another statement sharing the same line span.
        const bindings: ImportBinding[] = [];
        extractFromImportStatement(node, module, bindings);

        statements.push({
            span: {
                module,
                line: node.startPosition.row + 1,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
            },
            bindings,
        });
    }

    statements.sort((a, b) => (a.span.startLine - b.span.startLine) || (a.span.endLine - b.span.endLine));
    return statements;
}

export function extractImportStatementSpans(rootNode: Node, langName: string): ImportStatementSpan[] {
    return extractImportStatements(rootNode, langName).map(stmt => stmt.span);
}

export function extractImportBindings(rootNode: Node, langName: string): ImportBinding[] {
    const bindings = extractImportStatements(rootNode, langName).flatMap(stmt => stmt.bindings);
    bindings.sort((a, b) => (a.line - b.line) || (a.column - b.column));
    return bindings;
}

function extractFromImportStatement(node: Node, source: string, bindings: ImportBinding[]): void {
    const statementTypeOnly = hasDirectChildType(node, 'type');
    const importClause = findDirectChildOfType(node, 'import_clause');
    const importRequireClause = findDirectChildOfType(node, 'import_require_clause');

    if (importRequireClause) {
        const local = findDirectChildOfType(importRequireClause, 'identifier');
        if (local) {
            bindings.push({
                source,
                localName: local.text,
                importedName: null,
                importKind: 'namespace',
                // `import type foo = require("m")` carries `type` on the
                // statement node; the require clause is not exempt from it.
                isTypeOnly: statementTypeOnly,
                line: local.startPosition.row + 1,
                column: local.startPosition.column,
            });
        }
        return;
    }

    if (!importClause) {
        return;
    }

    for (let i = 0; i < importClause.childCount; i++) {
        const child = importClause.child(i);
        if (!child) continue;

        if (child.type === 'identifier') {
            bindings.push({
                source,
                localName: child.text,
                importedName: 'default',
                importKind: 'default',
                isTypeOnly: statementTypeOnly,
                line: child.startPosition.row + 1,
                column: child.startPosition.column,
            });
        } else if (child.type === 'namespace_import') {
            const local = findLastDirectChildOfType(child, 'identifier');
            if (local) {
                bindings.push({
                    source,
                    localName: local.text,
                    importedName: null,
                    importKind: 'namespace',
                    isTypeOnly: statementTypeOnly,
                    line: local.startPosition.row + 1,
                    column: local.startPosition.column,
                });
            }
        } else if (child.type === 'named_imports') {
            extractNamedImports(child, source, statementTypeOnly, bindings);
        }
    }
}

function extractNamedImports(node: Node, source: string, statementTypeOnly: boolean, bindings: ImportBinding[]): void {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child || child.type !== 'import_specifier') continue;

        // Specifier names may be identifiers OR string literals — TS allows
        // arbitrary module namespace names: import { "a-b" as a } from "./m".
        const names: Node[] = [];
        for (let j = 0; j < child.childCount; j++) {
            const specChild = child.child(j);
            if (specChild && (specChild.type === 'identifier' || specChild.type === 'string')) names.push(specChild);
        }

        const first = names[0];
        if (!first) continue;
        const second = names[1] ?? null;
        const local = second ?? first;
        // The local binding must be an identifier; a lone string specifier
        // binds nothing addressable in code.
        if (local.type !== 'identifier') continue;
        const importedName = first.type === 'string' ? stringLiteralValue(first) : first.text;

        bindings.push({
            source,
            localName: local.text,
            importedName,
            importKind: 'named',
            isTypeOnly: statementTypeOnly || hasDirectChildType(child, 'type'),
            line: local.startPosition.row + 1,
            column: local.startPosition.column,
        });
    }
}

function findDirectChildOfType(node: Node, type: string): Node | null {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === type) return child;
    }
    return null;
}

function findLastDirectChildOfType(node: Node, type: string): Node | null {
    for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i);
        if (child && child.type === type) return child;
    }
    return null;
}

function findFirstDescendantOfType(node: Node, type: string): Node | null {
    const stack: Node[] = [node];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        if (current.type === type) return current;
        for (let i = current.childCount - 1; i >= 0; i--) {
            const child = current.child(i);
            if (child) stack.push(child);
        }
    }
    return null;
}

function hasDirectChildType(node: Node, type: string): boolean {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === type) return true;
    }
    return false;
}

function stringLiteralValue(node: Node): string {
    const fragments: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && (child.type === 'string_fragment' || child.type === 'escape_sequence')) {
            fragments.push(child.text);
        }
    }
    if (fragments.length > 0) return fragments.join('');

    const text = node.text;
    if (text.length >= 2) {
        const first = text[0] ?? '';
        const last = text[text.length - 1] ?? '';
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return text.slice(1, -1);
        }
    }
    return text;
}
