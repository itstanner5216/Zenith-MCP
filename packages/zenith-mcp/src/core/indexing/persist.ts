// ---------------------------------------------------------------------------
// indexing/persist.ts — Writes ParsedFileRecord in one transaction
//
// Invariant: Every DB write goes through a named db-adapter function.
// Single transaction per file. FK cascades handle child table cleanup.
// ---------------------------------------------------------------------------

import type { DbConnection } from '../db-adapter.js';
import {
    runTransaction, upsertFile, deleteSymbolsByFile,
    insertSymbol, insertEdge,
    insertSymbolStructure, insertAnchor,
    insertImport, insertLocalScope, insertInjection,
    updateSymbolExtras,
} from '../db-adapter.js';
import type { ParsedFileRecord } from './types.js';

export function persistParsedFile(conn: DbConnection, record: ParsedFileRecord): void {
    runTransaction(conn, () => {
        // 1. Clear old data (FK cascades clean child tables)
        deleteSymbolsByFile(conn, record.relPath);
        // 2. Upsert file
        upsertFile(conn, record.relPath, record.hash, Date.now());
        // 3. Insert symbols, build key→id map.
        //    Pass 1 inserts every symbol so keyToId is COMPLETE before any
        //    parent link is resolved. Pass 2 then applies updateSymbolExtras,
        //    so parent_symbol_id no longer depends on parent-before-child
        //    ordering in record.symbols (e.g. same-line `class C { m(){} }`).
        const keyToId = new Map<string, number>();
        const inserted: { sym: typeof record.symbols[number]; rowId: number }[] = [];
        for (const sym of record.symbols) {
            const rowId = insertSymbol(conn, {
                name: sym.name, kind: sym.kind, type: sym.type,
                filePath: record.relPath, line: sym.line, endLine: sym.endLine, column: sym.column,
            });
            const key = `${sym.name}:${sym.line}:${sym.column}`;
            keyToId.set(key, rowId);
            inserted.push({ sym, rowId });
        }
        for (const { sym, rowId } of inserted) {
            if (sym.bodyHash || sym.captureTag || sym.parentSymbolKey || sym.visibility) {
                const parentId = sym.parentSymbolKey ? (keyToId.get(sym.parentSymbolKey) ?? null) : null;
                updateSymbolExtras(conn, rowId, { captureTag: sym.captureTag, bodyHash: sym.bodyHash, parentSymbolId: parentId, visibility: sym.visibility });
            }
        }
        // 4. Edges
        for (const edge of record.edges) {
            const containerId = keyToId.get(edge.containerDefKey);
            if (containerId !== undefined) insertEdge(conn, containerId, edge.referencedName);
        }
        // 5. Structures
        for (const struct of record.structures) {
            const symbolId = keyToId.get(struct.parentSymbolKey);
            if (symbolId === undefined) continue;
            insertSymbolStructure(conn, { symbolId, paramsJson: JSON.stringify(struct.params), returnText: struct.returnKind, decoratorsJson: JSON.stringify(struct.decorators), modifiersJson: JSON.stringify(struct.modifiers), genericsText: null, parentKind: struct.parentKind, parentName: null });
        }
        // 6. Anchors
        for (const anchor of record.anchors) {
            const symbolId = keyToId.get(anchor.parentSymbolKey);
            if (symbolId === undefined) continue;
            insertAnchor(conn, { symbolId, kind: anchor.kind, line: anchor.line, text: anchor.text });
        }
        // 7. Imports
        for (const imp of record.imports) {
            insertImport(conn, { filePath: record.relPath, module: imp.module, importedNamesJson: JSON.stringify(imp.importedNames), line: imp.line });
        }
        // 8. Injections
        for (const inj of record.injections) {
            insertInjection(conn, { filePath: record.relPath, hostLang: inj.hostLang, injectedLang: inj.injectedLang, startLine: inj.startLine, endLine: inj.endLine, startByte: inj.startByte, endByte: inj.endByte });
        }
        // 9. Local scopes
        //    Skip scopes whose owning symbol does not resolve. local_scopes
        //    rows are FK'd to symbols(id) ON DELETE CASCADE and consumed
        //    strictly per-symbol (getLocalScopesForSymbol WHERE symbol_id = ?),
        //    so a NULL-owner scope is unreachable AND uncleanable — the cascade
        //    only fires from a deleted owning symbol, leaving owner-less rows to
        //    accumulate across re-indexes. An owner-less scope has no consumer.
        for (const local of record.locals) {
            const symbolId = local.parentSymbolKey ? (keyToId.get(local.parentSymbolKey) ?? null) : null;
            if (symbolId === null) continue;
            insertLocalScope(conn, { symbolId, scopeKind: local.scopeKind, startLine: local.startLine, endLine: local.endLine, parametersJson: JSON.stringify(local.parameters), localsJson: JSON.stringify(local.locals) });
        }
    });
}
