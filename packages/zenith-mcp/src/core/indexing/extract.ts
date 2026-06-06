// ---------------------------------------------------------------------------
// indexing/extract.ts — Single-parse orchestrator for one file
//
// Invariant: Parses source ONCE. Shares the tree rootNode with all extractors.
// Returns a ParsedFileRecord with no DB awareness. Pure data extraction.
// ---------------------------------------------------------------------------

import { Parser, type Node, type QueryCapture } from 'web-tree-sitter';
import { loadLanguage, getCompiledQuery } from '../tree-sitter/runtime.js';
import { extractStructureForDef } from '../tree-sitter/structure.js';
import { extractAnchorsForDef } from '../tree-sitter/anchors.js';
import { extractImportsFromSymbols } from '../tree-sitter/imports.js';
import { extractInjections } from '../tree-sitter/injections.js';
import { extractLocals } from '../tree-sitter/locals.js';
import { bodySlice, bodyHash } from '../tree-sitter/body.js';
import type { SymbolInfo } from '../tree-sitter/symbols.js';
import type { ParsedFileRecord, SymbolRow, StructureRow, AnchorRow, RawEdgeRow, LocalScopeRow } from './types.js';

export async function extractParsedFile(
    source: string, langName: string, relPath: string, hash: string
): Promise<ParsedFileRecord | null> {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const query = await getCompiledQuery(langName);
    if (!query) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) { parser.delete(); return null; }

    try {
        const rootNode = tree.rootNode;

        // --- Step 1: Run tags query to get symbols (same logic as symbols.ts) ---
        const matches = query.matches(rootNode);
        const rawSymbols: SymbolInfo[] = [];
        const seen = new Set<string>();
        for (const match of matches) {
            let nameCapture: QueryCapture | null = null;
            let bodyCapture: QueryCapture | null = null;
            for (const cap of match.captures) {
                if (cap.name.startsWith('name.')) nameCapture = cap;
                else if (cap.name.startsWith('definition.') || cap.name.startsWith('reference.')) bodyCapture = cap;
            }
            if (!nameCapture) continue;
            const tag = nameCapture.name;
            let kind: string, type: string;
            if (tag.startsWith('name.definition.')) { kind = 'def'; type = tag.slice(16); }
            else if (tag.startsWith('name.reference.')) { kind = 'ref'; type = tag.slice(15); }
            else continue;
            const name = nameCapture.node.text;
            const line = nameCapture.node.startPosition.row + 1;
            const column = nameCapture.node.startPosition.column;
            const endLine = bodyCapture ? bodyCapture.node.endPosition.row + 1 : nameCapture.node.endPosition.row + 1;
            const key = `${name}:${kind}:${line}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rawSymbols.push({ name, kind, type, line, endLine, column });
        }
        rawSymbols.sort((a, b) => a.line - b.line);

        const defs = rawSymbols.filter(s => s.kind === 'def');

        // --- Step 2: Build SymbolRows with containment + body hash ---
        const symbols: SymbolRow[] = [];
        for (const s of rawSymbols) {
            let bHash: string | null = null;
            let parentKey: string | null = null;
            let visibility: string | null = null;

            if (s.kind === 'def') {
                const slice = bodySlice(source, s.line, s.endLine);
                bHash = bodyHash(slice);
                // Parent containment: smallest enclosing def
                let bestParent: SymbolInfo | null = null;
                let bestSpan = Infinity;
                for (const d of defs) {
                    if (d === s) continue;
                    if (d.line <= s.line && d.endLine >= s.endLine) {
                        const span = d.endLine - d.line;
                        if (span < bestSpan) { bestSpan = span; bestParent = d; }
                    }
                }
                if (bestParent) parentKey = `${bestParent.name}:${bestParent.line}:${bestParent.column}`;
            }

            const captureTag = s.kind === 'def' ? `definition.${s.type}` : `reference.${s.type}`;
            symbols.push({ name: s.name, kind: s.kind === 'def' ? 'def' : 'ref', type: s.type, captureTag, line: s.line, endLine: s.endLine, column: s.column, bodyHash: bHash, parentSymbolKey: parentKey, visibility });
        }

        // --- Step 3: Structure extraction (shares rootNode) ---
        const structures: StructureRow[] = [];
        for (const s of defs) {
            const struct = extractStructureForDef(rootNode, s.line, s.endLine, langName);
            if (struct) {
                const key = `${s.name}:${s.line}:${s.column}`;
                structures.push({ parentSymbolKey: key, params: struct.params, returnKind: struct.returnKind, decorators: struct.decorators, modifiers: struct.modifiers, parentKind: struct.parentKind });
                // Derive visibility
                const sym = symbols.find(sym => sym.line === s.line && sym.column === s.column && sym.kind === 'def');
                if (sym) {
                    if (struct.modifiers.includes('export') || struct.modifiers.includes('public') || struct.modifiers.includes('pub')) sym.visibility = 'public';
                    else if (struct.modifiers.includes('private')) sym.visibility = 'private';
                    else if (struct.modifiers.includes('protected')) sym.visibility = 'protected';
                }
            }
        }

        // --- Step 4: Anchor extraction (shares rootNode, uses DEF_TYPES to find def nodes) ---
        const anchors: AnchorRow[] = [];
        const lines = source.split('\n');
        for (const s of defs) {
            const startRow = s.line - 1;
            const endRow = s.endLine - 1;
            // Find the AST node for this def
            let defNode: Node | null = null;
            function findDefNode(node: Node): boolean {
                if (node.startPosition.row === startRow && node.endPosition.row === endRow) { defNode = node; return true; }
                if (node.startPosition.row <= startRow && node.endPosition.row >= endRow) {
                    for (let i = 0; i < node.childCount; i++) {
                        const child = node.child(i);
                        if (child && findDefNode(child)) return true;
                    }
                }
                return false;
            }
            findDefNode(rootNode);
            if (defNode) {
                const defAnchors = extractAnchorsForDef(defNode, langName, startRow);
                const key = `${s.name}:${s.line}:${s.column}`;
                for (const a of defAnchors) {
                    // a.line is node.startPosition.row of a node inside this parsed
                    // source, so lines[a.line] is provably defined (in range).
                    const text = lines[a.line]!.slice(0, 80);
                    anchors.push({ parentSymbolKey: key, kind: a.kind, line: a.line, priority: a.priority, text });
                }
            }
        }

        // --- Step 5: Imports (post-processes symbols, no re-parse) ---
        const imports = extractImportsFromSymbols(rawSymbols);

        // --- Step 6: Injections (shares rootNode) ---
        const injections = await extractInjections(rootNode, langName);
        const injectionRows = injections.map(inj => ({
            hostLang: inj.hostLang, injectedLang: inj.injectedLang,
            startLine: inj.startLine, endLine: inj.endLine,
            startByte: inj.startByte, endByte: inj.endByte,
        }));

        // --- Step 7: Locals (shares rootNode) ---
        const localScopes = await extractLocals(rootNode, langName);
        const locals: LocalScopeRow[] = (localScopes ?? []).map(scope => {
            let parentKey: string | null = null;
            for (const d of defs) {
                if (d.line <= scope.startLine && d.endLine >= scope.endLine) {
                    parentKey = `${d.name}:${d.line}:${d.column}`;
                    break;
                }
            }
            return { parentSymbolKey: parentKey, scopeKind: scope.scopeKind, startLine: scope.startLine, endLine: scope.endLine, parameters: scope.parameters, locals: scope.locals };
        });

        // --- Step 8: Edges (innermost-def containment) ---
        const defEntries = symbols.filter(s => s.kind === 'def');
        const edges: RawEdgeRow[] = [];
        for (const ref of symbols.filter(s => s.kind === 'ref')) {
            let bestDef: SymbolRow | null = null;
            let bestSpan = Infinity;
            for (const def of defEntries) {
                if (ref.line >= def.line && ref.line <= def.endLine) {
                    const span = def.endLine - def.line;
                    if (span < bestSpan) { bestSpan = span; bestDef = def; }
                }
            }
            if (bestDef) edges.push({ containerDefKey: `${bestDef.name}:${bestDef.line}:${bestDef.column}`, referencedName: ref.name });
        }

        return { relPath, hash, lang: langName, symbols, structures, anchors, imports, injections: injectionRows, locals, edges };
    } finally {
        tree.delete();
        parser.delete();
    }
}
