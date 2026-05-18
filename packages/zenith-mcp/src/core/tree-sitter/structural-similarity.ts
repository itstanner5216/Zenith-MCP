// ---------------------------------------------------------------------------
// tree-sitter/structural-similarity.ts — Structural fingerprinting & similarity
//
// Contains:
//   - SymbolStructure (exported interface)
//   - getStructuralFingerprint()     — AST node type sequence for a line range
//   - computeStructuralSimilarity()  — Jaccard similarity on 3-grams
//   - getSymbolStructure()           — structural signature for a def node
// ---------------------------------------------------------------------------

import { Parser, Node } from 'web-tree-sitter';
import { loadLanguage, DEF_TYPES } from './runtime.js';

export interface SymbolStructure {
    params: string[];
    returnKind: string | null;
    parentKind: string | null;
    decorators: string[];
    modifiers: string[];
}

/**
 * Compute a structural fingerprint for a range of source lines.
 * Returns an ordered array of AST node types for all nodes whose start row
 * falls within [startLine-1, endLine-1].
 *
 * @param source    - full source code
 * @param langName  - tree-sitter language name
 * @param startLine - 1-based start line
 * @param endLine   - 1-based end line
 */
export async function getStructuralFingerprint(source: string, langName: string, startLine: number, endLine: number): Promise<string[]> {
    const language = await loadLanguage(langName);
    if (!language) return [];

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    if (!tree) return [];

    try {
        const nodeTypes: string[] = [];
        const startRow = startLine - 1;
        const endRow = endLine - 1;

        function walk(node: Node): void {
            if (node.startPosition.row >= startRow && node.startPosition.row <= endRow) {
                nodeTypes.push(node.type);
            }
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child) walk(child);
            }
        }

        walk(tree.rootNode);
        return nodeTypes;
    } finally {
        tree.delete();
        parser.delete();
    }
}

/**
 * Compute Jaccard similarity between two structural fingerprints using 3-grams.
 * Returns a score from 0.0 to 1.0.
 *
 * @param fingerprintA
 * @param fingerprintB
 */
export function computeStructuralSimilarity(fingerprintA: string[], fingerprintB: string[]): number {
    function buildNgrams(arr: string[], n: number): Set<string> {
        const set = new Set<string>();
        for (let i = 0; i <= arr.length - n; i++) {
            set.add(arr.slice(i, i + n).join('\x00'));
        }
        return set;
    }

    const gramsA = buildNgrams(fingerprintA, 3);
    const gramsB = buildNgrams(fingerprintB, 3);

    if (gramsA.size === 0 && gramsB.size === 0) {
        // Both fingerprints too short for 3-grams — direct sequence equality.
        if (fingerprintA.length !== fingerprintB.length) return 0.0;
        for (let i = 0; i < fingerprintA.length; i++) {
            if (fingerprintA[i] !== fingerprintB[i]) return 0.0;
        }
        return 1.0;
    }
    if (gramsA.size === 0 || gramsB.size === 0) return 0.0;

    let intersection = 0;
    for (const g of gramsA) {
        if (gramsB.has(g)) intersection++;
    }

    const union = gramsA.size + gramsB.size - intersection;
    return union === 0 ? 0.0 : intersection / union;
}

/**
 * Extract a structural signature for the symbol whose definition spans
 * `startLine`..`endLine` (1-based, inclusive). Used by refactor_batch outlier
 * detection to flag occurrences whose shape differs from peers in the same
 * symbol group.
 *
 * Returns null if the language cannot be loaded or no matching def node is found.
 */
export async function getSymbolStructure(source: string, langName: string, startLine: number, endLine: number): Promise<SymbolStructure | null> {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    if (!tree) return null;

    try {
        const startRow = startLine - 1;
        const endRow = endLine - 1;

        let defNode: Node | null = null;
        function findDef(node: Node): boolean {
            if (DEF_TYPES.has(node.type) &&
                node.startPosition.row === startRow &&
                node.endPosition.row === endRow) {
                defNode = node;
                return true;
            }
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && findDef(child)) return true;
            }
            return false;
        }
        findDef(tree.rootNode);
        if (!defNode) return null;

        // defNode is Node here (TypeScript narrowed it above via null check)
        const foundNode: Node = defNode;

        const params: string[] = [];
        function collectParams(node: Node, isRoot: boolean): boolean {
            if (!isRoot && DEF_TYPES.has(node.type)) return false;
            if (/parameters?$/.test(node.type) || node.type === 'formal_parameters') {
                for (let i = 0; i < node.childCount; i++) {
                    const c = node.child(i);
                    if (!c) continue;
                    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
                    params.push(c.type);
                }
                return true;
            }
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && collectParams(child, false)) return true;
            }
            return false;
        }
        collectParams(foundNode, true);

        let returnKind: string | null = null;
        for (let i = 0; i < foundNode.childCount; i++) {
            const c = foundNode.child(i);
            if (!c) continue;
            const fieldName = foundNode.fieldNameForChild ? foundNode.fieldNameForChild(i) : null;
            if (fieldName === 'return_type' || /^type_annotation$|^return_type$/.test(c.type)) {
                returnKind = c.type;
                break;
            }
        }

        let parentKind: string | null = null;
        let p: Node | null = foundNode.parent;
        while (p) {
            if (DEF_TYPES.has(p.type) || p.type === 'program' || p.type === 'module' || p.type === 'source_file') {
                parentKind = p.type;
                break;
            }
            p = p.parent;
        }

        const decorators: string[] = [];
        if (foundNode.parent) {
            const siblings: Node[] = [];
            for (let i = 0; i < foundNode.parent.childCount; i++) {
                const sibling = foundNode.parent.child(i);
                if (sibling) siblings.push(sibling);
            }
            const idx = siblings.indexOf(foundNode);
            for (let i = idx - 1; i >= 0; i--) {
                const prev = siblings[i];
                if (prev === undefined) break;
                if (prev.type === 'decorator') decorators.unshift(prev.type);
                else break;
            }
        }
        for (let i = 0; i < foundNode.childCount; i++) {
            const c = foundNode.child(i);
            if (c && c.type === 'decorator') decorators.push(c.type);
        }

        const MODIFIER_TYPES = new Set(['async', 'static', 'public', 'private', 'protected', 'readonly', '*']);
        const modifiers = new Set<string>();
        function collectModifiers(node: Node): void {
            if (DEF_TYPES.has(node.type)) return;
            if (MODIFIER_TYPES.has(node.type)) modifiers.add(node.type);
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child) collectModifiers(child);
            }
        }
        for (let i = 0; i < foundNode.childCount; i++) {
            const child = foundNode.child(i);
            if (child) collectModifiers(child);
        }

        return {
            params,
            returnKind,
            parentKind,
            decorators,
            modifiers: [...modifiers].sort(),
        };
    } finally {
        tree.delete();
        parser.delete();
    }
}
