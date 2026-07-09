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

export function extractImportStatementSpans(rootNode: Node, langName: string): ImportStatementSpan[] {
    if (langName !== 'typescript' && langName !== 'tsx' && langName !== 'javascript') return [];

    const statements: ImportStatementSpan[] = [];
    const stack: Node[] = [rootNode];

    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;

        if (node.type === 'import_statement') {
            const sourceNode = findFirstDescendantOfType(node, 'string');
            if (sourceNode) {
                statements.push({
                    module: stringLiteralValue(sourceNode),
                    line: node.startPosition.row + 1,
                    startLine: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
                });
            }
        }

        for (let i = node.childCount - 1; i >= 0; i--) {
            const child = node.child(i);
            if (child) stack.push(child);
        }
    }

    statements.sort((a, b) => (a.startLine - b.startLine) || (a.endLine - b.endLine));
    return statements;
}

export function extractImportBindings(rootNode: Node, langName: string): ImportBinding[] {
    if (langName !== 'typescript' && langName !== 'tsx' && langName !== 'javascript') return [];

    const bindings: ImportBinding[] = [];
    const stack: Node[] = [rootNode];

    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;

        if (node.type === 'import_statement') {
            const sourceNode = findFirstDescendantOfType(node, 'string');
            const source = sourceNode ? stringLiteralValue(sourceNode) : null;
            if (source !== null) {
                extractFromImportStatement(node, source, bindings);
            }
        }

        for (let i = node.childCount - 1; i >= 0; i--) {
            const child = node.child(i);
            if (child) stack.push(child);
        }
    }

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
                isTypeOnly: false,
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

        const names: Node[] = [];
        for (let j = 0; j < child.childCount; j++) {
            const specChild = child.child(j);
            if (specChild && specChild.type === 'identifier') names.push(specChild);
        }

        const first = names[0];
        if (!first) continue;
        const second = names[1] ?? null;
        const local = second ?? first;

        bindings.push({
            source,
            localName: local.text,
            importedName: first.text,
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
