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
    if (langName === 'python') {
        const statements: ImportStatementFacts[] = [];
        const stack: Node[] = [rootNode];
        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;

            if (node.type === 'import_statement' || node.type === 'import_from_statement') {
                const bindings: ImportBinding[] = [];
                let module = '';

                if (node.type === 'import_from_statement') {
                    for (let i = 0; i < node.childCount; i++) {
                        const child = node.child(i);
                        if (child && node.fieldNameForChild(i) === 'module_name') {
                            module = child.text;
                            break;
                        }
                    }

                    if (module.length === 0) continue;
                    for (let i = 0; i < node.childCount; i++) {
                        const child = node.child(i);
                        if (!child || node.fieldNameForChild(i) !== 'name') continue;

                        if (child.type === 'dotted_name') {
                            const local = findFirstDescendantOfType(child, 'identifier');
                            if (!local) continue;
                            bindings.push({
                                source: module,
                                localName: local.text,
                                importedName: child.text,
                                importKind: 'named',
                                isTypeOnly: false,
                                line: local.startPosition.row + 1,
                                column: local.startPosition.column,
                            });
                        } else if (child.type === 'aliased_import') {
                            let imported: Node | null = null;
                            let local: Node | null = null;
                            for (let j = 0; j < child.childCount; j++) {
                                const part = child.child(j);
                                const field = child.fieldNameForChild(j);
                                if (part && field === 'name') imported = part;
                                else if (part && field === 'alias') local = part;
                            }
                            if (!imported || !local || local.type !== 'identifier') continue;
                            bindings.push({
                                source: module,
                                localName: local.text,
                                importedName: imported.text,
                                importKind: 'named',
                                isTypeOnly: false,
                                line: local.startPosition.row + 1,
                                column: local.startPosition.column,
                            });
                        }
                    }
                } else {
                    for (let i = 0; i < node.childCount; i++) {
                        const child = node.child(i);
                        if (!child || node.fieldNameForChild(i) !== 'name') continue;

                        let sourceNode: Node | null = null;
                        let local: Node | null = null;
                        if (child.type === 'dotted_name') {
                            sourceNode = child;
                            local = findFirstDescendantOfType(child, 'identifier');
                        } else if (child.type === 'aliased_import') {
                            for (let j = 0; j < child.childCount; j++) {
                                const part = child.child(j);
                                const field = child.fieldNameForChild(j);
                                if (part && field === 'name') sourceNode = part;
                                else if (part && field === 'alias') local = part;
                            }
                        }
                        if (!sourceNode || !local || local.type !== 'identifier') continue;
                        if (module.length === 0) module = sourceNode.text;
                        bindings.push({
                            source: sourceNode.text,
                            localName: local.text,
                            importedName: null,
                            importKind: 'namespace',
                            isTypeOnly: false,
                            line: local.startPosition.row + 1,
                            column: local.startPosition.column,
                        });
                    }
                }

                if (module.length === 0) continue;
                statements.push({
                    span: {
                        module,
                        line: node.startPosition.row + 1,
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                    },
                    bindings,
                });
                continue;
            }

            for (let i = node.childCount - 1; i >= 0; i--) {
                const child = node.child(i);
                if (child) stack.push(child);
            }
        }

        statements.sort((a, b) => (a.span.startLine - b.span.startLine) || (a.span.endLine - b.span.endLine));
        return statements;
    }

    if (langName === 'go') {
        const statements: ImportStatementFacts[] = [];
        for (let i = 0; i < rootNode.childCount; i++) {
            const node = rootNode.child(i);
            if (!node || node.type !== 'import_declaration') continue;

            const specs: Node[] = [];
            const stack: Node[] = [node];
            while (stack.length > 0) {
                const current = stack.pop();
                if (!current) continue;
                if (current.type === 'import_spec') {
                    specs.push(current);
                    continue;
                }
                for (let j = current.childCount - 1; j >= 0; j--) {
                    const child = current.child(j);
                    if (child) stack.push(child);
                }
            }
            specs.sort((a, b) => (a.startPosition.row - b.startPosition.row) || (a.startPosition.column - b.startPosition.column));

            const bindings: ImportBinding[] = [];
            let module = '';
            for (const spec of specs) {
                let nameNode: Node | null = null;
                let pathNode: Node | null = null;
                for (let j = 0; j < spec.childCount; j++) {
                    const child = spec.child(j);
                    const field = spec.fieldNameForChild(j);
                    if (child && field === 'name') nameNode = child;
                    else if (child && field === 'path') pathNode = child;
                }
                if (!pathNode) continue;

                const pathText = pathNode.text;
                const first = pathText[0] ?? '';
                const last = pathText[pathText.length - 1] ?? '';
                const source = pathText.length >= 2
                    && ((first === '"' && last === '"') || (first === '`' && last === '`'))
                    ? pathText.slice(1, -1)
                    : pathText;
                if (source.length === 0) continue;
                if (module.length === 0) module = source;

                if (nameNode && (nameNode.type === 'blank_identifier' || nameNode.type === 'dot')) continue;

                let localName = '';
                let localLine = 0;
                let localColumn = 0;
                if (nameNode) {
                    if (nameNode.type !== 'package_identifier') continue;
                    localName = nameNode.text;
                    localLine = nameNode.startPosition.row + 1;
                    localColumn = nameNode.startPosition.column;
                } else {
                    const slash = source.lastIndexOf('/');
                    localName = source.slice(slash + 1);
                    if (localName.length === 0) continue;
                    const content = findFirstDescendantOfType(pathNode, 'interpreted_string_literal_content')
                        ?? findFirstDescendantOfType(pathNode, 'raw_string_literal_content');
                    if (content) {
                        localLine = content.startPosition.row + 1;
                        localColumn = content.startPosition.column
                            + new TextEncoder().encode(source.slice(0, slash + 1)).length;
                    } else {
                        localLine = pathNode.startPosition.row + 1;
                        localColumn = pathNode.startPosition.column + 1
                            + new TextEncoder().encode(source.slice(0, slash + 1)).length;
                    }
                }

                bindings.push({
                    source,
                    localName,
                    importedName: null,
                    importKind: 'namespace',
                    isTypeOnly: false,
                    line: localLine,
                    column: localColumn,
                });
            }

            if (module.length === 0) continue;
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

    if (langName === 'rust') {
        const statements: ImportStatementFacts[] = [];
        const statementStack: Node[] = [rootNode];
        while (statementStack.length > 0) {
            const node = statementStack.pop();
            if (!node) continue;

            if (node.type === 'use_declaration') {
                let argument: Node | null = null;
                for (let i = 0; i < node.childCount; i++) {
                    const child = node.child(i);
                    if (child && node.fieldNameForChild(i) === 'argument') {
                        argument = child;
                        break;
                    }
                }
                if (!argument) continue;

                const bindings: ImportBinding[] = [];
                let module = '';
                const work: Array<{ node: Node; prefix: string }> = [{ node: argument, prefix: '' }];
                while (work.length > 0) {
                    const entry = work.pop();
                    if (!entry) continue;
                    const current = entry.node;

                    if (current.type === 'scoped_use_list') {
                        let path: Node | null = null;
                        let list: Node | null = null;
                        for (let i = 0; i < current.childCount; i++) {
                            const child = current.child(i);
                            const field = current.fieldNameForChild(i);
                            if (child && field === 'path') path = child;
                            else if (child && field === 'list') list = child;
                        }
                        if (!path || !list) continue;
                        const nextPrefix = entry.prefix.length > 0
                            ? `${entry.prefix}::${path.text}`
                            : path.text;
                        if (module.length === 0) module = nextPrefix;
                        work.push({ node: list, prefix: nextPrefix });
                    } else if (current.type === 'use_list') {
                        for (let i = current.childCount - 1; i >= 0; i--) {
                            const child = current.child(i);
                            if (child && child.isNamed) work.push({ node: child, prefix: entry.prefix });
                        }
                    } else if (current.type === 'use_wildcard') {
                        let path: Node | null = null;
                        for (let i = 0; i < current.childCount; i++) {
                            const child = current.child(i);
                            if (child && child.isNamed) {
                                path = child;
                                break;
                            }
                        }
                        if (path && module.length === 0) {
                            module = entry.prefix.length > 0
                                ? `${entry.prefix}::${path.text}`
                                : path.text;
                        }
                    } else if (current.type === 'scoped_identifier') {
                        let path: Node | null = null;
                        let local: Node | null = null;
                        for (let i = 0; i < current.childCount; i++) {
                            const child = current.child(i);
                            const field = current.fieldNameForChild(i);
                            if (child && field === 'path') path = child;
                            else if (child && field === 'name') local = child;
                        }
                        if (!path || !local || local.type !== 'identifier') continue;
                        const source = entry.prefix.length > 0
                            ? `${entry.prefix}::${path.text}`
                            : path.text;
                        if (source.length === 0) continue;
                        if (module.length === 0) module = source;
                        bindings.push({
                            source,
                            localName: local.text,
                            importedName: local.text,
                            importKind: 'named',
                            isTypeOnly: false,
                            line: local.startPosition.row + 1,
                            column: local.startPosition.column,
                        });
                    } else if (current.type === 'use_as_clause') {
                        let path: Node | null = null;
                        let local: Node | null = null;
                        for (let i = 0; i < current.childCount; i++) {
                            const child = current.child(i);
                            const field = current.fieldNameForChild(i);
                            if (child && field === 'path') path = child;
                            else if (child && field === 'alias') local = child;
                        }
                        if (!path || !local || local.type !== 'identifier') continue;
                        const separator = path.text.lastIndexOf('::');
                        if (separator < 0 && (path.type === 'self' || path.type === 'crate' || path.type === 'super')) continue;
                        const importedName = separator >= 0 ? path.text.slice(separator + 2) : path.text;
                        const pathSource = separator >= 0 ? path.text.slice(0, separator) : '';
                        const source = entry.prefix.length > 0
                            ? (pathSource.length > 0 ? `${entry.prefix}::${pathSource}` : entry.prefix)
                            : pathSource;
                        if (source.length === 0 || importedName.length === 0) continue;
                        if (module.length === 0) module = source;
                        bindings.push({
                            source,
                            localName: local.text,
                            importedName,
                            importKind: 'named',
                            isTypeOnly: false,
                            line: local.startPosition.row + 1,
                            column: local.startPosition.column,
                        });
                    } else if (current.type === 'identifier' && entry.prefix.length > 0) {
                        if (module.length === 0) module = entry.prefix;
                        bindings.push({
                            source: entry.prefix,
                            localName: current.text,
                            importedName: current.text,
                            importKind: 'named',
                            isTypeOnly: false,
                            line: current.startPosition.row + 1,
                            column: current.startPosition.column,
                        });
                    }
                }

                if (module.length === 0) continue;
                bindings.sort((a, b) => (a.line - b.line) || (a.column - b.column));
                statements.push({
                    span: {
                        module,
                        line: node.startPosition.row + 1,
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                    },
                    bindings,
                });
                continue;
            }

            for (let i = node.childCount - 1; i >= 0; i--) {
                const child = node.child(i);
                if (child) statementStack.push(child);
            }
        }

        statements.sort((a, b) => (a.span.startLine - b.span.startLine) || (a.span.endLine - b.span.endLine));
        return statements;
    }

    if (langName === 'java') {
        const statements: ImportStatementFacts[] = [];
        for (let i = 0; i < rootNode.childCount; i++) {
            const node = rootNode.child(i);
            if (!node || node.type !== 'import_declaration') continue;

            const path = findDirectChildOfType(node, 'scoped_identifier');
            if (!path) continue;
            const wildcard = findDirectChildOfType(node, 'asterisk');
            const bindings: ImportBinding[] = [];
            let module = path.text;

            if (!wildcard) {
                const local = findLastDirectChildOfType(path, 'identifier');
                const separator = path.text.lastIndexOf('.');
                if (!local || separator < 0) continue;
                module = path.text.slice(0, separator);
                bindings.push({
                    source: module,
                    localName: local.text,
                    importedName: local.text,
                    importKind: 'named',
                    isTypeOnly: false,
                    line: local.startPosition.row + 1,
                    column: local.startPosition.column,
                });
            }

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
