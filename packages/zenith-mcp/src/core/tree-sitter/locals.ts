// ---------------------------------------------------------------------------
// tree-sitter/locals.ts — Per-scope parameter and local variable extraction
//
// Invariant: Runs locals.scm on a pre-parsed tree. Does NOT re-parse.
// Returns null if no locals.scm exists for the language.
// ---------------------------------------------------------------------------

import type { Node } from 'web-tree-sitter';
import { getCompiledModularQuery } from './runtime.js';

export interface LocalSymbol {
    name: string;
    line: number;    // 1-based
    column: number;
}

export interface LocalScope {
    scopeKind: string;       // node type of the @scope capture
    startLine: number;       // 1-based
    endLine: number;         // 1-based
    parameters: LocalSymbol[];
    locals: LocalSymbol[];
}

/**
 * Run locals.scm and extract per-scope parameters and local definitions.
 * Returns null if no locals.scm exists for this language.
 */
export async function extractLocals(rootNode: Node, langName: string): Promise<LocalScope[] | null> {
    const query = await getCompiledModularQuery(langName, 'locals.scm');
    if (!query) return null;

    const matches = query.matches(rootNode);

    // Collect scopes, parameters, and definitions
    const scopes: Array<{ node: Node; kind: string }> = [];
    const params: Array<{ node: Node }> = [];
    const defs: Array<{ node: Node }> = [];

    for (const match of matches) {
        for (const cap of match.captures) {
            if (cap.name === 'scope') {
                scopes.push({ node: cap.node, kind: cap.node.type });
            } else if (cap.name === 'local.parameter') {
                params.push({ node: cap.node });
            } else if (cap.name === 'local.definition') {
                defs.push({ node: cap.node });
            }
        }
    }

    if (scopes.length === 0) return [];

    // Build LocalScope results by assigning params/defs to their containing scope
    const result: LocalScope[] = [];
    for (const scope of scopes) {
        const sNode = scope.node;
        const scopeStartRow = sNode.startPosition.row;
        const scopeEndRow = sNode.endPosition.row;

        const scopeParams: LocalSymbol[] = [];
        for (const p of params) {
            const row = p.node.startPosition.row;
            if (row >= scopeStartRow && row <= scopeEndRow) {
                // Check that this param is directly in THIS scope (not a nested one)
                let directChild = true;
                for (const innerScope of scopes) {
                    if (innerScope === scope) continue;
                    const iStart = innerScope.node.startPosition.row;
                    const iEnd = innerScope.node.endPosition.row;
                    if (row >= iStart && row <= iEnd &&
                        iStart > scopeStartRow && iEnd < scopeEndRow) {
                        directChild = false;
                        break;
                    }
                }
                if (directChild) {
                    scopeParams.push({
                        name: p.node.text,
                        line: row + 1,
                        column: p.node.startPosition.column,
                    });
                }
            }
        }

        const scopeDefs: LocalSymbol[] = [];
        for (const d of defs) {
            const row = d.node.startPosition.row;
            if (row >= scopeStartRow && row <= scopeEndRow) {
                let directChild = true;
                for (const innerScope of scopes) {
                    if (innerScope === scope) continue;
                    const iStart = innerScope.node.startPosition.row;
                    const iEnd = innerScope.node.endPosition.row;
                    if (row >= iStart && row <= iEnd &&
                        iStart > scopeStartRow && iEnd < scopeEndRow) {
                        directChild = false;
                        break;
                    }
                }
                if (directChild) {
                    scopeDefs.push({
                        name: d.node.text,
                        line: row + 1,
                        column: d.node.startPosition.column,
                    });
                }
            }
        }

        result.push({
            scopeKind: scope.kind,
            startLine: scopeStartRow + 1,
            endLine: scopeEndRow + 1,
            parameters: scopeParams,
            locals: scopeDefs,
        });
    }

    return result;
}
