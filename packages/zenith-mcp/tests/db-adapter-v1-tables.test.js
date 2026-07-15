// db-adapter-v1-tables.test.js
//
// Tests for all new db-adapter functions added in this PR (v0 → v4 schema
// migration, symbol extended columns, symbol_structures, anchors, imports,
// injections, local_scopes, edge resolution, getFileFacts, getSchemaVersion).
//
// Every test uses openMemoryDb() + initSymbolSchema() for an in-process, zero-I/O
// SQLite instance. No temp directories, no git repos.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
    openMemoryDb,
    closeDb,
    initSymbolSchema,
    insertSymbol,
    upsertFile,
    insertEdge,
    // v1 new functions
    updateSymbolExtras,
    insertSymbolStructure,
    getSymbolStructure,
    readSymbolStructure,
    findSymbolStructuresByName,
    execRaw,
    insertAnchor,
    getAnchorsForFile,
    insertImport,
    insertImportBinding,
    getImportBindingsForFile,
    getImportsForFile,
    getFilesImporting,
    insertInjection,
    getInjectionsForFile,
    insertLocalScope,
    getLocalScopesForSymbol,
    getUnresolvedEdges,
    findSymbolByNameUnique,
    findSymbolParent,
    updateEdgeCalleeSymbol,
    getFileFacts,
    getSchemaVersion,
} from '../dist/core/db-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb() {
    const db = openMemoryDb();
    initSymbolSchema(db);
    return db;
}

function addFile(db, filePath) {
    upsertFile(db, filePath, 'abc123', Date.now());
}

function addSymbol(db, opts = {}) {
    return insertSymbol(db, {
        name: opts.name ?? 'myFunc',
        kind: opts.kind ?? 'def',
        type: opts.type ?? 'function',
        filePath: opts.filePath ?? 'src/index.ts',
        line: opts.line ?? 1,
        endLine: opts.endLine ?? 10,
        column: opts.column ?? 0,
    });
}

// ---------------------------------------------------------------------------
// Schema migration: getSchemaVersion
// ---------------------------------------------------------------------------

describe('getSchemaVersion', () => {
    it('returns 4 after initSymbolSchema (v0 → v4 migrations applied)', () => {
        const db = makeDb();
        expect(getSchemaVersion(db)).toBe(4);
        closeDb(db);
    });

    it('returns 0 on a fresh memory db without init', () => {
        // Fresh db: the schema_version table does not exist yet. getSchemaVersion
        // must treat the resulting "no such table" as version 0 (the un-migrated
        // baseline) rather than throwing.
        const freshDb = openMemoryDb();
        expect(getSchemaVersion(freshDb)).toBe(0);
        // After running the migration on the same connection it must report 4.
        initSymbolSchema(freshDb);
        expect(getSchemaVersion(freshDb)).toBe(4);
        closeDb(freshDb);
    });
});

// ---------------------------------------------------------------------------
// updateSymbolExtras
// ---------------------------------------------------------------------------

describe('updateSymbolExtras', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/index.ts'); });
    afterEach(() => closeDb(db));

    it('sets captureTag, bodyHash, visibility on a symbol', () => {
        const id = addSymbol(db);
        updateSymbolExtras(db, id, {
            captureTag: 'definition.function',
            bodyHash: 'aabbcc',
            visibility: 'public',
        });
        // Verify via getFileFacts (which reads capture_tag and visibility)
        const facts = getFileFacts(db, 'src/index.ts');
        expect(facts.defs).toHaveLength(1);
        expect(facts.defs[0].captureTag).toBe('definition.function');
        expect(facts.defs[0].visibility).toBe('public');
    });

    it('sets parentSymbolId linking child to parent', () => {
        const parentId = addSymbol(db, { name: 'ParentClass', type: 'class', line: 1, endLine: 20 });
        const childId = addSymbol(db, { name: 'childMethod', type: 'method', line: 5, endLine: 10 });
        updateSymbolExtras(db, childId, { parentSymbolId: parentId });
        // Check via findSymbolParent
        const parent = findSymbolParent(db, childId);
        expect(parent).not.toBeNull();
        expect(parent.id).toBe(parentId);
        expect(parent.name).toBe('ParentClass');
    });

    it('allows nulling out extras', () => {
        const id = addSymbol(db);
        updateSymbolExtras(db, id, { captureTag: 'definition.function', visibility: 'private' });
        updateSymbolExtras(db, id, { captureTag: null, visibility: null });
        const facts = getFileFacts(db, 'src/index.ts');
        expect(facts.defs[0].captureTag).toBeNull();
        expect(facts.defs[0].visibility).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Symbol Structures (insertSymbolStructure, getSymbolStructure, findSymbolStructuresByName)
// ---------------------------------------------------------------------------

describe('insertSymbolStructure + getSymbolStructure', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/foo.ts'); });
    afterEach(() => closeDb(db));

    it('inserts and retrieves symbol structure round-trip', () => {
        const id = addSymbol(db, { filePath: 'src/foo.ts' });
        insertSymbolStructure(db, {
            symbolId: id,
            paramsJson: JSON.stringify(['required_parameter', 'optional_parameter']),
            returnText: 'type_annotation',
            decoratorsJson: JSON.stringify(['decorator']),
            modifiersJson: JSON.stringify(['export', 'async']),
            genericsText: '<T>',
            parentKind: 'class_declaration',
            parentName: 'MyClass',
        });

        const row = getSymbolStructure(db, id);
        expect(row).not.toBeNull();
        expect(row.symbol_id).toBe(id);
        expect(row.params).toEqual(['required_parameter', 'optional_parameter']);
        expect(row.returnText).toBe('type_annotation');
        expect(row.decorators).toEqual(['decorator']);
        expect(row.modifiers).toEqual(['export', 'async']);
        expect(row.genericsText).toBe('<T>');
        expect(row.parentKind).toBe('class_declaration');
        expect(row.parentName).toBe('MyClass');
    });

    it('returns null for non-existent symbol id', () => {
        expect(getSymbolStructure(db, 99999)).toBeNull();
    });

    it('handles null optional fields', () => {
        const id = addSymbol(db, { filePath: 'src/foo.ts' });
        insertSymbolStructure(db, {
            symbolId: id,
            paramsJson: '[]',
            returnText: null,
            decoratorsJson: '[]',
            modifiersJson: '[]',
            genericsText: null,
            parentKind: null,
            parentName: null,
        });
        const row = getSymbolStructure(db, id);
        expect(row.returnText).toBeNull();
        expect(row.genericsText).toBeNull();
        expect(row.parentKind).toBeNull();
    });
});

describe('findSymbolStructuresByName', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/bar.ts'); });
    afterEach(() => closeDb(db));

    it('finds structures by symbol name', () => {
        const id = addSymbol(db, { name: 'compute', type: 'function', filePath: 'src/bar.ts' });
        insertSymbolStructure(db, { symbolId: id, paramsJson: '[]', returnText: null, decoratorsJson: '[]', modifiersJson: '[]', genericsText: null, parentKind: null, parentName: null });

        const { rows, corrupt } = findSymbolStructuresByName(db, 'compute');
        expect(rows).toHaveLength(1);
        expect(corrupt).toHaveLength(0);
        expect(rows[0].file_path).toBe('src/bar.ts');
    });

    it('filters by kind/type when provided', () => {
        const id = addSymbol(db, { name: 'Widget', type: 'class', line: 1, endLine: 20, filePath: 'src/bar.ts' });
        insertSymbolStructure(db, { symbolId: id, paramsJson: '[]', returnText: null, decoratorsJson: '[]', modifiersJson: '[]', genericsText: null, parentKind: null, parentName: null });

        expect(findSymbolStructuresByName(db, 'Widget', 'class').rows).toHaveLength(1);
        expect(findSymbolStructuresByName(db, 'Widget', 'function').rows).toHaveLength(0);
    });

    it('returns empty rows when name not found', () => {
        const result = findSymbolStructuresByName(db, 'nonExistentSymbol');
        expect(result.rows).toHaveLength(0);
        expect(result.corrupt).toHaveLength(0);
    });

    // POLARIS Task 1.1 — corrupt structure JSON is a typed, loud condition,
    // never an empty shape.
    it('reports corrupt JSON rows in `corrupt` with row/file/line/detail', () => {
        const okId = addSymbol(db, { name: 'twin', type: 'function', filePath: 'src/bar.ts', line: 3, endLine: 5 });
        insertSymbolStructure(db, { symbolId: okId, paramsJson: '["x"]', returnText: null, decoratorsJson: '[]', modifiersJson: '[]', genericsText: null, parentKind: null, parentName: null });
        const badId = addSymbol(db, { name: 'twin', type: 'function', filePath: 'src/bar.ts', line: 10, endLine: 12 });
        insertSymbolStructure(db, { symbolId: badId, paramsJson: '{not json', returnText: null, decoratorsJson: '[]', modifiersJson: '[]', genericsText: null, parentKind: null, parentName: null });

        const { rows, corrupt } = findSymbolStructuresByName(db, 'twin');
        expect(rows).toHaveLength(1);
        expect(rows[0].symbol_id).toBe(okId);
        expect(corrupt).toHaveLength(1);
        expect(corrupt[0].rowId).toBe(badId);
        expect(corrupt[0].filePath).toBe('src/bar.ts');
        expect(corrupt[0].line).toBe(10);
        expect(corrupt[0].detail).toContain('params_json');
    });

    it('valid-JSON-wrong-shape (non-array) is corruption too, not data', () => {
        const id = addSymbol(db, { name: 'shapely', type: 'function', filePath: 'src/bar.ts' });
        insertSymbolStructure(db, { symbolId: id, paramsJson: '{"a":1}', returnText: null, decoratorsJson: '[]', modifiersJson: '[]', genericsText: null, parentKind: null, parentName: null });
        const { rows, corrupt } = findSymbolStructuresByName(db, 'shapely');
        expect(rows).toHaveLength(0);
        expect(corrupt).toHaveLength(1);
        expect(corrupt[0].detail).toContain('not a JSON array');
    });

    it('readSymbolStructure returns the typed ok | missing | corrupt result', () => {
        const id = addSymbol(db, { name: 'typedRead', type: 'function', filePath: 'src/bar.ts' });
        insertSymbolStructure(db, { symbolId: id, paramsJson: '["n"]', returnText: 'number', decoratorsJson: '[]', modifiersJson: '[]', genericsText: null, parentKind: null, parentName: null });

        const ok = readSymbolStructure(db, id);
        expect(ok.status).toBe('ok');
        expect(ok.structure.params).toEqual(['n']);

        expect(readSymbolStructure(db, 999999).status).toBe('missing');

        execRaw(db, `UPDATE symbol_structures SET modifiers_json = '[broken' WHERE symbol_id = ${id}`);
        const corrupt = readSymbolStructure(db, id);
        expect(corrupt.status).toBe('corrupt');
        expect(corrupt.corruption.rowId).toBe(id);
        expect(corrupt.corruption.detail).toContain('modifiers_json');

        // The compat surface throws loudly on corruption — it can never be
        // observed as [] or null.
        expect(() => getSymbolStructure(db, id)).toThrow(/STRUCTURE_CORRUPT/);
    });
});

// ---------------------------------------------------------------------------
// Anchors (insertAnchor, getAnchorsForFile)
// ---------------------------------------------------------------------------

describe('insertAnchor + getAnchorsForFile', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/anchored.ts'); });
    afterEach(() => closeDb(db));

    it('inserts anchors and retrieves them ordered by line', () => {
        const symbolId = addSymbol(db, { filePath: 'src/anchored.ts', line: 1, endLine: 20 });
        insertAnchor(db, { symbolId, kind: 'return', line: 18, text: '  return result;' });
        insertAnchor(db, { symbolId, kind: 'if', line: 5, text: '  if (x > 0) {' });
        insertAnchor(db, { symbolId, kind: 'throw', line: 12, text: '  throw new Error();' });

        const anchors = getAnchorsForFile(db, 'src/anchored.ts');
        expect(anchors).toHaveLength(3);
        // Ordered by line ascending
        expect(anchors[0].line).toBe(5);
        expect(anchors[0].kind).toBe('if');
        expect(anchors[1].line).toBe(12);
        expect(anchors[2].line).toBe(18);
        // symbol_name is populated via JOIN
        expect(anchors[0].symbol_name).toBe('myFunc');
    });

    it('returns empty array for a file with no anchors', () => {
        expect(getAnchorsForFile(db, 'src/nonexistent.ts')).toHaveLength(0);
    });

    it('stores text verbatim', () => {
        const id = addSymbol(db, { filePath: 'src/anchored.ts' });
        insertAnchor(db, { symbolId: id, kind: 'call', line: 3, text: '  foo.bar(baz, qux)' });
        const anchors = getAnchorsForFile(db, 'src/anchored.ts');
        expect(anchors[0].text).toBe('  foo.bar(baz, qux)');
    });
});

// ---------------------------------------------------------------------------
// Imports (insertImport, getImportsForFile, getFilesImporting)
// ---------------------------------------------------------------------------

describe('insertImport + getImportsForFile + getFilesImporting', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/mod.ts'); });
    afterEach(() => closeDb(db));

    it('inserts imports and retrieves them ordered by line', () => {
        insertImport(db, { filePath: 'src/mod.ts', module: 'path', importedNamesJson: JSON.stringify(['join', 'resolve']), line: 2, startLine: 2, endLine: 4 });
        insertImport(db, { filePath: 'src/mod.ts', module: 'fs', importedNamesJson: JSON.stringify(['readFileSync']), line: 1 });

        const imports = getImportsForFile(db, 'src/mod.ts');
        expect(imports).toHaveLength(2);
        expect(imports[0].line).toBe(1); // ordered by line
        expect(imports[0].module).toBe('fs');
        expect(imports[0].importedNames).toEqual(['readFileSync']);
        expect(imports[1].module).toBe('path');
        expect(imports[1].importedNames).toEqual(['join', 'resolve']);
        expect(imports[1].startLine).toBe(2);
        expect(imports[1].endLine).toBe(4);
    });

    it('returns empty array when file has no imports', () => {
        addFile(db, 'src/other.ts');
        expect(getImportsForFile(db, 'src/other.ts')).toHaveLength(0);
    });

    it('getFilesImporting returns files that import a given module', () => {
        addFile(db, 'src/a.ts');
        addFile(db, 'src/b.ts');
        insertImport(db, { filePath: 'src/mod.ts', module: 'shared-lib', importedNamesJson: '[]', line: 1 });
        insertImport(db, { filePath: 'src/a.ts', module: 'shared-lib', importedNamesJson: '["Foo"]', line: 3 });
        insertImport(db, { filePath: 'src/b.ts', module: 'other-lib', importedNamesJson: '[]', line: 1 });

        const files = getFilesImporting(db, 'shared-lib');
        const paths = files.map(r => r.file_path).sort();
        expect(paths).toContain('src/mod.ts');
        expect(paths).toContain('src/a.ts');
        expect(paths).not.toContain('src/b.ts');
    });

    it('handles empty importedNames (side-effect imports)', () => {
        insertImport(db, { filePath: 'src/mod.ts', module: './polyfill', importedNamesJson: '[]', line: 5 });
        const imports = getImportsForFile(db, 'src/mod.ts');
        expect(imports).toHaveLength(1);
        expect(imports[0].importedNames).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Import bindings (insertImportBinding, getImportBindingsForFile)
// ---------------------------------------------------------------------------

describe('insertImportBinding + getImportBindingsForFile', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/mod.ts'); });
    afterEach(() => closeDb(db));

    it('inserts binding-level imports and retrieves them ordered by line/column', () => {
        insertImportBinding(db, {
            filePath: 'src/mod.ts',
            source: './x',
            localName: 'later',
            importedName: 'later',
            importKind: 'named',
            isTypeOnly: false,
            line: 2,
            column: 10,
        });
        insertImportBinding(db, {
            filePath: 'src/mod.ts',
            source: './x',
            localName: 'Foo',
            importedName: 'default',
            importKind: 'default',
            isTypeOnly: true,
            line: 1,
            column: 7,
        });

        expect(getImportBindingsForFile(db, 'src/mod.ts')).toEqual([
            {
                source: './x',
                localName: 'Foo',
                importedName: 'default',
                importKind: 'default',
                isTypeOnly: true,
                line: 1,
                column: 7,
            },
            {
                source: './x',
                localName: 'later',
                importedName: 'later',
                importKind: 'named',
                isTypeOnly: false,
                line: 2,
                column: 10,
            },
        ]);
    });
});

// ---------------------------------------------------------------------------
// Injections (insertInjection, getInjectionsForFile)
// ---------------------------------------------------------------------------

describe('insertInjection + getInjectionsForFile', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/template.ts'); });
    afterEach(() => closeDb(db));

    it('inserts and retrieves injections', () => {
        insertInjection(db, {
            filePath: 'src/template.ts',
            hostLang: 'javascript',
            injectedLang: 'sql',
            startLine: 10,
            endLine: 15,
            startByte: 200,
            endByte: 350,
        });

        const injections = getInjectionsForFile(db, 'src/template.ts');
        expect(injections).toHaveLength(1);
        const inj = injections[0];
        expect(inj.host_lang).toBe('javascript');
        expect(inj.injected_lang).toBe('sql');
        expect(inj.start_line).toBe(10);
        expect(inj.end_line).toBe(15);
        expect(inj.start_byte).toBe(200);
        expect(inj.end_byte).toBe(350);
    });

    it('returns empty array when file has no injections', () => {
        addFile(db, 'src/plain.ts');
        expect(getInjectionsForFile(db, 'src/plain.ts')).toHaveLength(0);
    });

    it('inserts multiple injections for the same file', () => {
        insertInjection(db, { filePath: 'src/template.ts', hostLang: 'javascript', injectedLang: 'css', startLine: 1, endLine: 5, startByte: 0, endByte: 100 });
        insertInjection(db, { filePath: 'src/template.ts', hostLang: 'javascript', injectedLang: 'html', startLine: 20, endLine: 30, startByte: 400, endByte: 700 });

        expect(getInjectionsForFile(db, 'src/template.ts')).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Local Scopes (insertLocalScope, getLocalScopesForSymbol)
// ---------------------------------------------------------------------------

describe('insertLocalScope + getLocalScopesForSymbol', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/scoped.ts'); });
    afterEach(() => closeDb(db));

    it('inserts and retrieves local scopes for a symbol', () => {
        const symbolId = addSymbol(db, { filePath: 'src/scoped.ts' });
        insertLocalScope(db, {
            symbolId,
            scopeKind: 'function_declaration',
            startLine: 1,
            endLine: 10,
            parametersJson: JSON.stringify([{ name: 'x', line: 1, column: 4 }]),
            localsJson: JSON.stringify([{ name: 'result', line: 3, column: 8 }]),
        });

        const scopes = getLocalScopesForSymbol(db, symbolId);
        expect(scopes).toHaveLength(1);
        expect(scopes[0].scope_kind).toBe('function_declaration');
        expect(scopes[0].start_line).toBe(1);
        expect(scopes[0].end_line).toBe(10);
        expect(scopes[0].parameters).toEqual([{ name: 'x', line: 1, column: 4 }]);
        expect(scopes[0].locals).toEqual([{ name: 'result', line: 3, column: 8 }]);
    });

    it('allows null symbolId (top-level scope)', () => {
        // symbolId null means no parent symbol
        insertLocalScope(db, {
            symbolId: null,
            scopeKind: 'module',
            startLine: 1,
            endLine: 100,
            parametersJson: '[]',
            localsJson: '[]',
        });
        // No crash — row inserted with null symbol_id
        // Can't easily query via getLocalScopesForSymbol(null), but no error is the invariant
    });

    it('returns empty array when symbol has no scopes', () => {
        expect(getLocalScopesForSymbol(db, 99999)).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Edge Resolution (getUnresolvedEdges, findSymbolByNameUnique, findSymbolParent, updateEdgeCalleeSymbol)
// ---------------------------------------------------------------------------

describe('findSymbolByNameUnique', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/uni.ts'); });
    afterEach(() => closeDb(db));

    it('returns the symbol when exactly one matches', () => {
        const id = addSymbol(db, { name: 'uniqueFunc', kind: 'def', filePath: 'src/uni.ts' });
        const result = findSymbolByNameUnique(db, 'uniqueFunc', 'def');
        expect(result).not.toBeNull();
        expect(result.id).toBe(id);
    });

    it('returns null when zero symbols match', () => {
        expect(findSymbolByNameUnique(db, 'nonExistent', 'def')).toBeNull();
    });

    it('returns null when two or more symbols match (ambiguous)', () => {
        addFile(db, 'src/other.ts');
        addSymbol(db, { name: 'ambiguousFunc', kind: 'def', filePath: 'src/uni.ts', line: 1, endLine: 5 });
        addSymbol(db, { name: 'ambiguousFunc', kind: 'def', filePath: 'src/other.ts', line: 10, endLine: 15 });
        expect(findSymbolByNameUnique(db, 'ambiguousFunc', 'def')).toBeNull();
    });

    it('distinguishes by kind — ref vs def', () => {
        addSymbol(db, { name: 'mixedName', kind: 'def', filePath: 'src/uni.ts', line: 1, endLine: 5 });
        addSymbol(db, { name: 'mixedName', kind: 'ref', filePath: 'src/uni.ts', line: 10, endLine: 10 });
        // def: exactly one → returns it
        expect(findSymbolByNameUnique(db, 'mixedName', 'def')).not.toBeNull();
        // ref: exactly one → returns it too
        expect(findSymbolByNameUnique(db, 'mixedName', 'ref')).not.toBeNull();
    });
});

describe('findSymbolParent', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/parent.ts'); });
    afterEach(() => closeDb(db));

    it('returns null when symbol has no parent', () => {
        const id = addSymbol(db, { name: 'topLevel', filePath: 'src/parent.ts' });
        expect(findSymbolParent(db, id)).toBeNull();
    });

    it('returns parent after updateSymbolExtras sets parentSymbolId', () => {
        const parentId = addSymbol(db, { name: 'Container', type: 'class', line: 1, endLine: 30, filePath: 'src/parent.ts' });
        const childId = addSymbol(db, { name: 'method', type: 'method', line: 5, endLine: 10, filePath: 'src/parent.ts' });
        updateSymbolExtras(db, childId, { parentSymbolId: parentId });

        const parent = findSymbolParent(db, childId);
        expect(parent).not.toBeNull();
        expect(parent.id).toBe(parentId);
        expect(parent.name).toBe('Container');
    });
});

describe('getUnresolvedEdges + updateEdgeCalleeSymbol', () => {
    let db;
    beforeEach(() => { db = makeDb(); addFile(db, 'src/caller.ts'); addFile(db, 'src/callee.ts'); });
    afterEach(() => closeDb(db));

    it('returns unresolved edges for a file', () => {
        const defId = addSymbol(db, { name: 'caller', filePath: 'src/caller.ts', line: 1, endLine: 10 });
        insertEdge(db, defId, 'targetFunc');

        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        expect(unresolved.length).toBeGreaterThanOrEqual(1);
        const edge = unresolved.find(e => e.referenced_name === 'targetFunc');
        expect(edge).toBeDefined();
    });

    it('returns empty array after edges are resolved', () => {
        const callerId = addSymbol(db, { name: 'caller2', filePath: 'src/caller.ts', line: 1, endLine: 5 });
        const calleeId = addSymbol(db, { name: 'callee2', filePath: 'src/callee.ts', line: 1, endLine: 5 });
        insertEdge(db, callerId, 'callee2');

        const unresolved = getUnresolvedEdges(db, 'src/caller.ts');
        const edge = unresolved.find(e => e.referenced_name === 'callee2');
        expect(edge).toBeDefined();

        updateEdgeCalleeSymbol(db, edge.id, calleeId);

        const remaining = getUnresolvedEdges(db, 'src/caller.ts');
        expect(remaining.find(e => e.referenced_name === 'callee2')).toBeUndefined();
    });

    it('returns empty array when file has no edges', () => {
        expect(getUnresolvedEdges(db, 'src/caller.ts')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// getFileFacts aggregate
// ---------------------------------------------------------------------------

describe('getFileFacts', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => closeDb(db));

    it('returns empty facts for a file with no data', () => {
        addFile(db, 'src/empty.ts');
        const facts = getFileFacts(db, 'src/empty.ts');
        expect(facts.defs).toHaveLength(0);
        expect(facts.edges).toHaveLength(0);
        expect(facts.anchors).toHaveLength(0);
        expect(facts.imports).toHaveLength(0);
        expect(facts.injections).toHaveLength(0);
    });

    it('includes defs ordered by line', () => {
        addFile(db, 'src/multi.ts');
        addSymbol(db, { name: 'funcB', kind: 'def', type: 'function', filePath: 'src/multi.ts', line: 20, endLine: 30 });
        addSymbol(db, { name: 'funcA', kind: 'def', type: 'function', filePath: 'src/multi.ts', line: 1, endLine: 10 });

        const facts = getFileFacts(db, 'src/multi.ts');
        expect(facts.defs).toHaveLength(2);
        expect(facts.defs[0].name).toBe('funcA');
        expect(facts.defs[1].name).toBe('funcB');
    });

    it('includes RESOLVED edges keyed by caller/callee LINE (not name)', () => {
        // Phase 4: getFileFacts returns edges by RESOLVED line endpoints, grouped by
        // symbol IDENTITY — never by name. Only edges whose callee resolves to a def
        // IN THIS FILE are returned (INNER JOIN on callee_symbol_id + same file_path).
        addFile(db, 'src/edges.ts');
        const callerId = addSymbol(db, { name: 'caller', kind: 'def', filePath: 'src/edges.ts', line: 1, endLine: 10 });
        const helperId = addSymbol(db, { name: 'helper', kind: 'def', filePath: 'src/edges.ts', line: 20, endLine: 25 });
        insertEdge(db, callerId, 'helper');
        insertEdge(db, callerId, 'helper'); // two call sites → callCount = 2

        // Resolve both edges to helper's symbol id (same-file resolution pattern used
        // by the getUnresolvedEdges/updateEdgeCalleeSymbol tests above).
        for (const e of getUnresolvedEdges(db, 'src/edges.ts')) {
            if (e.referenced_name === 'helper') updateEdgeCalleeSymbol(db, e.id, helperId);
        }

        const facts = getFileFacts(db, 'src/edges.ts');
        const edge = facts.edges.find(e => e.callerLine === 1 && e.calleeLine === 20);
        expect(edge, 'edge keyed by resolved caller/callee LINE').toBeDefined();
        expect(edge.callCount).toBe(2);
        expect(edge.caller_name, 'no name keys survive the seam').toBeUndefined();
        expect(edge.callee_name).toBeUndefined();
    });

    it('includes anchors and imports, import bindings, and injections', () => {
        addFile(db, 'src/full.ts');
        const defId = addSymbol(db, { name: 'richFunc', kind: 'def', filePath: 'src/full.ts', line: 5, endLine: 15 });
        insertAnchor(db, { symbolId: defId, kind: 'return', line: 14, text: '  return x;' });
        insertImport(db, { filePath: 'src/full.ts', module: 'lodash', importedNamesJson: '["merge"]', line: 1 });
        insertImportBinding(db, { filePath: 'src/full.ts', source: 'lodash', localName: 'merge', importedName: 'merge', importKind: 'named', isTypeOnly: false, line: 1, column: 9 });
        insertInjection(db, { filePath: 'src/full.ts', hostLang: 'typescript', injectedLang: 'sql', startLine: 8, endLine: 10, startByte: 100, endByte: 200 });

        const facts = getFileFacts(db, 'src/full.ts');
        expect(facts.defs).toHaveLength(1);
        expect(facts.anchors).toHaveLength(1);
        expect(facts.anchors[0].symbol_name).toBe('richFunc');
        expect(facts.anchors[0].kind).toBe('return');
        expect(facts.imports).toHaveLength(1);
        expect(facts.imports[0].module).toBe('lodash');
        expect(facts.importBindings).toHaveLength(1);
        expect(facts.importBindings[0].localName).toBe('merge');
        expect(facts.injections).toHaveLength(1);
        expect(facts.injections[0].injected_lang).toBe('sql');
    });

    it('defs include captureTag and visibility from extended columns', () => {
        addFile(db, 'src/tagged.ts');
        const id = addSymbol(db, { name: 'exportedFn', kind: 'def', filePath: 'src/tagged.ts', line: 1, endLine: 5 });
        updateSymbolExtras(db, id, { captureTag: 'definition.function', visibility: 'public' });

        const facts = getFileFacts(db, 'src/tagged.ts');
        expect(facts.defs[0].captureTag).toBe('definition.function');
        expect(facts.defs[0].visibility).toBe('public');
    });

    it('does not include ref symbols in defs list', () => {
        addFile(db, 'src/refs.ts');
        addSymbol(db, { name: 'myFunc', kind: 'def', filePath: 'src/refs.ts', line: 1, endLine: 10 });
        addSymbol(db, { name: 'helperRef', kind: 'ref', filePath: 'src/refs.ts', line: 5, endLine: 5 });

        const facts = getFileFacts(db, 'src/refs.ts');
        expect(facts.defs).toHaveLength(1);
        expect(facts.defs[0].name).toBe('myFunc');
    });
});

// ---------------------------------------------------------------------------
// initSymbolSchema idempotency (v4 migration can run twice safely)
// ---------------------------------------------------------------------------

describe('initSymbolSchema v4 migration idempotency', () => {
    it('calling initSymbolSchema twice does not throw', () => {
        const db = openMemoryDb();
        expect(() => {
            initSymbolSchema(db);
            initSymbolSchema(db);
        }).not.toThrow();
        expect(getSchemaVersion(db)).toBe(4);
        closeDb(db);
    });

    it('v1/v2/v3/v4 tables and columns exist after migration', () => {
        const db = makeDb();
        // Verify tables exist by inserting a file + symbol and writing to each new table
        addFile(db, 'probe.ts');
        const id = addSymbol(db, { filePath: 'probe.ts' });

        expect(() => insertSymbolStructure(db, { symbolId: id, paramsJson: '[]', returnText: null, decoratorsJson: '[]', modifiersJson: '[]', genericsText: null, parentKind: null, parentName: null })).not.toThrow();
        expect(() => insertAnchor(db, { symbolId: id, kind: 'return', line: 1, text: 'return x;' })).not.toThrow();
        expect(() => insertImport(db, { filePath: 'probe.ts', module: 'x', importedNamesJson: '[]', line: 1 })).not.toThrow();
        expect(() => insertImportBinding(db, { filePath: 'probe.ts', source: 'x', localName: 'x', importedName: 'default', importKind: 'default', isTypeOnly: false, line: 1, column: 7 })).not.toThrow();
        expect(() => insertInjection(db, { filePath: 'probe.ts', hostLang: 'js', injectedLang: 'sql', startLine: 1, endLine: 2, startByte: 0, endByte: 10 })).not.toThrow();
        expect(() => insertLocalScope(db, { symbolId: id, scopeKind: 'block', startLine: 1, endLine: 2, parametersJson: '[]', localsJson: '[]' })).not.toThrow();
        closeDb(db);
    });
});
