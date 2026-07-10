import { describe, expect, it, afterEach } from 'vitest';
import { extractParsedFile } from '../dist/core/indexing/extract.js';
import { persistParsedFile } from '../dist/core/indexing/persist.js';
import {
    closeDb,
    getFileFacts,
    initSymbolSchema,
    openMemoryDb,
} from '../dist/core/db-adapter.js';

function byLocal(bindings) {
    return new Map(bindings.map(binding => [binding.localName, binding]));
}

describe('import bindings', () => {
    let db;
    afterEach(() => { if (db) { closeDb(db); db = undefined; } });

    it('extracts JS/TS binding-level import facts without replacing statement imports', async () => {
        const source = [
            'import defaultThing, { foo as bar, type TypeOnly, baz } from "./mod";',
            'import type DefaultType, { Named as Renamed } from "./types";',
            'import * as ns from "pkg";',
            'import "side-effect";',
            'import cjs = require("legacy");',
            'import {',
            '  multi',
            '} from "./multi";',
            '',
        ].join('\n');

        const record = await extractParsedFile(source, 'typescript', 'src/imports.ts', 'hash-imports');
        expect(record).not.toBeNull();
        if (!record) return;

        const bindings = byLocal(record.importBindings);
        expect(bindings.get('defaultThing')).toMatchObject({
            source: './mod',
            localName: 'defaultThing',
            importedName: 'default',
            importKind: 'default',
            isTypeOnly: false,
            line: 1,
        });
        expect(bindings.get('bar')).toMatchObject({
            source: './mod',
            localName: 'bar',
            importedName: 'foo',
            importKind: 'named',
            isTypeOnly: false,
            line: 1,
        });
        expect(bindings.get('TypeOnly')).toMatchObject({
            source: './mod',
            localName: 'TypeOnly',
            importedName: 'TypeOnly',
            importKind: 'named',
            isTypeOnly: true,
            line: 1,
        });
        expect(bindings.get('baz')).toMatchObject({
            source: './mod',
            localName: 'baz',
            importedName: 'baz',
            importKind: 'named',
            isTypeOnly: false,
            line: 1,
        });
        expect(bindings.get('DefaultType')).toMatchObject({
            source: './types',
            localName: 'DefaultType',
            importedName: 'default',
            importKind: 'default',
            isTypeOnly: true,
            line: 2,
        });
        expect(bindings.get('Renamed')).toMatchObject({
            source: './types',
            localName: 'Renamed',
            importedName: 'Named',
            importKind: 'named',
            isTypeOnly: true,
            line: 2,
        });
        expect(bindings.get('ns')).toMatchObject({
            source: 'pkg',
            localName: 'ns',
            importedName: null,
            importKind: 'namespace',
            isTypeOnly: false,
            line: 3,
        });
        expect(bindings.get('cjs')).toMatchObject({
            source: 'legacy',
            localName: 'cjs',
            importedName: null,
            importKind: 'namespace',
            isTypeOnly: false,
            line: 5,
        });
        expect(bindings.has('')).toBe(false);
        expect(bindings.get('multi')).toMatchObject({
            source: './multi',
            localName: 'multi',
            importedName: 'multi',
            importKind: 'named',
            isTypeOnly: false,
            line: 7,
        });

        expect(record.imports.length).toBeGreaterThan(0);
        expect(record.imports).toContainEqual(expect.objectContaining({
            module: './mod',
            importedNames: ['defaultThing', 'bar', 'TypeOnly', 'baz'],
            line: 1,
            startLine: 1,
            endLine: 1,
        }));
        expect(record.imports).toContainEqual(expect.objectContaining({
            module: './types',
            importedNames: ['DefaultType', 'Renamed'],
            line: 2,
            startLine: 2,
            endLine: 2,
        }));
        expect(record.imports).toContainEqual(expect.objectContaining({
            module: 'side-effect',
            importedNames: [],
            line: 4,
            startLine: 4,
            endLine: 4,
        }));
        expect(record.imports).toContainEqual(expect.objectContaining({
            module: './multi',
            importedNames: ['multi'],
            line: 6,
            startLine: 6,
            endLine: 8,
        }));
    });

    it('keeps same-line import statements separated (no binding cross-contamination)', async () => {
        const source = 'import { a } from "./x"; import { b } from "./y";\n';
        const record = await extractParsedFile(source, 'typescript', 'src/sameline.ts', 'hash-sameline');
        expect(record).not.toBeNull();
        if (!record) return;

        const byModule = new Map(record.imports.map(imp => [imp.module, imp]));
        expect(byModule.get('./x')?.importedNames).toEqual(['a']);
        expect(byModule.get('./y')?.importedNames).toEqual(['b']);

        const bindings = byLocal(record.importBindings);
        expect(bindings.get('a')).toMatchObject({ source: './x', importedName: 'a', importKind: 'named' });
        expect(bindings.get('b')).toMatchObject({ source: './y', importedName: 'b', importKind: 'named' });
    });

    it('records the module specifier, not a string-literal export name', async () => {
        const source = 'import { "a-b" as a } from "./mod";\n';
        const record = await extractParsedFile(source, 'typescript', 'src/strlit.ts', 'hash-strlit');
        expect(record).not.toBeNull();
        if (!record) return;

        expect(record.imports).toHaveLength(1);
        expect(record.imports[0].module).toBe('./mod');

        const bindings = byLocal(record.importBindings);
        expect(bindings.get('a')).toMatchObject({
            source: './mod',
            localName: 'a',
            importedName: 'a-b',
            importKind: 'named',
        });
    });

    it('marks `import type x = require(...)` as type-only', async () => {
        const source = 'import type cjs = require("legacy");\n';
        const record = await extractParsedFile(source, 'typescript', 'src/typereq.ts', 'hash-typereq');
        expect(record).not.toBeNull();
        if (!record) return;

        const bindings = byLocal(record.importBindings);
        expect(bindings.get('cjs')).toMatchObject({
            source: 'legacy',
            importKind: 'namespace',
            isTypeOnly: true,
        });
    });

    it('persists import bindings into getFileFacts and replaces stale rows on re-index', async () => {
        db = openMemoryDb();
        initSymbolSchema(db);

        const first = await extractParsedFile('import { oldName } from "./x";\n', 'typescript', 'src/reindex.ts', 'hash-old');
        expect(first).not.toBeNull();
        if (!first) return;
        persistParsedFile(db, first);
        expect(getFileFacts(db, 'src/reindex.ts').importBindings.map(b => b.localName)).toEqual(['oldName']);

        const second = await extractParsedFile('import { newName as localNew } from "./x";\n', 'typescript', 'src/reindex.ts', 'hash-new');
        expect(second).not.toBeNull();
        if (!second) return;
        persistParsedFile(db, second);

        const facts = getFileFacts(db, 'src/reindex.ts');
        expect(facts.importBindings).toEqual([
            expect.objectContaining({
                source: './x',
                localName: 'localNew',
                importedName: 'newName',
                importKind: 'named',
                isTypeOnly: false,
            }),
        ]);
    });
});
