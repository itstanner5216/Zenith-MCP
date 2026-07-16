// ---------------------------------------------------------------------------
// indexing/persist.ts — Writes ParsedFileRecord in one transaction
//
// Invariant: Every DB write goes through a named db-adapter function.
// Single transaction per file. FK cascades handle symbol-child cleanup;
// file-FK'd tables are cleared explicitly (Task 1.1).
//
// Affected-name resolution (POLARIS Task 1.3) happens INSIDE this same
// transaction: read old definition names, replace facts, clear every stale
// edge target touching the changed names, re-resolve the affected names —
// then commit. A fault at any statement leaves the entire old state or the
// entire new state; no cleared-but-owed resolution can ever commit.
// ---------------------------------------------------------------------------

import type { DbConnection } from '../db-adapter.js';
import {
    runTransaction, upsertFile, deleteSymbolsByFile,
    deleteImportsByFile, deleteImportBindingsByFile, deleteInjectionsByFile,
    getDefinitionNamesByFile, clearEdgeTargetsByNames,
    insertSymbol, insertEdge,
    insertSymbolStructure, insertAnchor,
    insertImport, insertImportBinding, insertLocalScope, insertInjection,
    updateSymbolExtras,
} from '../db-adapter.js';
import { resolveEdgesForNames } from './resolve.js';
import type { ParsedFileRecord } from './types.js';

export function persistParsedFile(conn: DbConnection, record: ParsedFileRecord): void {
    runTransaction(conn, () => {
        // 0. Read the OLD definition names before anything is replaced — the
        //    affected-name protocol needs the old∪new union (Task 1.3).
        const oldDefinitionNames = getDefinitionNamesByFile(conn, record.relPath);

        // 1. Clear old data. Symbol-FK'd children (structures, anchors,
        //    local_scopes, edges) go with their symbols via FK cascade. The
        //    file-FK'd tables (imports, import_bindings, injections) are
        //    cleared EXPLICITLY: since the file upsert became non-destructive
        //    (POLARIS Task 1.1, ON CONFLICT DO UPDATE), the old
        //    INSERT-OR-REPLACE cascade no longer clears them implicitly — the
        //    replacement transaction owns that clear now.
        deleteSymbolsByFile(conn, record.relPath);
        deleteImportsByFile(conn, record.relPath);
        deleteImportBindingsByFile(conn, record.relPath);
        deleteInjectionsByFile(conn, record.relPath);
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
            if (containerId !== undefined) insertEdge(conn, containerId, edge.referencedName, edge.referenceKind);
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
            insertAnchor(conn, { symbolId, kind: anchor.kind, line: anchor.line, endLine: anchor.endLine, text: anchor.text });
        }
        // 7. Imports
        for (const imp of record.imports) {
            insertImport(conn, { filePath: record.relPath, module: imp.module, importedNamesJson: JSON.stringify(imp.importedNames), line: imp.line, startLine: imp.startLine, endLine: imp.endLine });
        }
        for (const binding of record.importBindings) {
            insertImportBinding(conn, {
                filePath: record.relPath,
                source: binding.source,
                localName: binding.localName,
                importedName: binding.importedName,
                importKind: binding.importKind,
                isTypeOnly: binding.isTypeOnly,
                line: binding.line,
                column: binding.column,
            });
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

        // 10. Affected-name resolution (POLARIS Task 1.3), same transaction.
        //     Every definition row in this file was deleted and reinserted, so
        //     every old/new definition name changed storage identity even when
        //     the two name sets are equal. Clear every reference group whose
        //     terminal name can resolve through one of those identities, then
        //     re-resolve the exact groups the clear touched plus this file's
        //     own (all-unresolved) new references. The clear returns the full
        //     referenced names (including qualified groups), so nothing
        //     cleared is ever left owed at commit.
        const newDefinitionNames = [...new Set(record.symbols.filter((s) => s.kind === 'def').map((s) => s.name))];
        const changedDefinitions = [...new Set([...oldDefinitionNames, ...newDefinitionNames])];

        const clearedNames = changedDefinitions.length > 0
            ? clearEdgeTargetsByNames(conn, changedDefinitions)
            : [];

        const newReferencedNames = record.edges.map((e) => e.referencedName);
        const affectedNames = [...new Set([...changedDefinitions, ...clearedNames, ...newReferencedNames])];
        resolveEdgesForNames(conn, affectedNames);
    });
}
