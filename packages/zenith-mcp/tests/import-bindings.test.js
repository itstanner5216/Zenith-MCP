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

    it('extracts Python imports, aliases, relative sources, and wildcard spans', async () => {
        const source = [
            'import x',
            'import x.y as z',
            'from m import a',
            'from m import a as b',
            'from . import x',
            'from ..pkg import y as zed',
            'from m import *',
            '',
        ].join('\n');

        const record = await extractParsedFile(source, 'python', 'src/imports.py', 'hash-python-imports');
        expect(record).not.toBeNull();
        if (!record) return;

        expect(record.importBindings).toEqual([
            {
                source: 'x',
                localName: 'x',
                importedName: null,
                importKind: 'namespace',
                isTypeOnly: false,
                line: 1,
                column: 7,
            },
            {
                source: 'x.y',
                localName: 'z',
                importedName: null,
                importKind: 'namespace',
                isTypeOnly: false,
                line: 2,
                column: 14,
            },
            {
                source: 'm',
                localName: 'a',
                importedName: 'a',
                importKind: 'named',
                isTypeOnly: false,
                line: 3,
                column: 14,
            },
            {
                source: 'm',
                localName: 'b',
                importedName: 'a',
                importKind: 'named',
                isTypeOnly: false,
                line: 4,
                column: 19,
            },
            {
                source: '.',
                localName: 'x',
                importedName: 'x',
                importKind: 'named',
                isTypeOnly: false,
                line: 5,
                column: 14,
            },
            {
                source: '..pkg',
                localName: 'zed',
                importedName: 'y',
                importKind: 'named',
                isTypeOnly: false,
                line: 6,
                column: 23,
            },
        ]);
        expect(record.imports).toEqual([
            { module: 'x', importedNames: ['x'], line: 1, startLine: 1, endLine: 1 },
            { module: 'x.y', importedNames: ['z'], line: 2, startLine: 2, endLine: 2 },
            { module: 'm', importedNames: ['a'], line: 3, startLine: 3, endLine: 3 },
            { module: 'm', importedNames: ['b'], line: 4, startLine: 4, endLine: 4 },
            { module: '.', importedNames: ['x'], line: 5, startLine: 5, endLine: 5 },
            { module: '..pkg', importedNames: ['zed'], line: 6, startLine: 6, endLine: 6 },
            { module: 'm', importedNames: [], line: 7, startLine: 7, endLine: 7 },
        ]);
    });

    it('extracts single and block Go imports while leaving blank and dot imports span-only', async () => {
        const source = [
            'package p',
            'import "fmt"',
            'import f "foo/fmt"',
            'import _ "pkg"',
            'import . "other/pkg"',
            'import (',
            '  "os"',
            '  alias "example.com/mod/path"',
            '  _ "side/effect"',
            '  . "dot/pkg"',
            ')',
            '',
        ].join('\n');

        const record = await extractParsedFile(source, 'go', 'src/imports.go', 'hash-go-imports');
        expect(record).not.toBeNull();
        if (!record) return;

        expect(record.importBindings).toEqual([
            {
                source: 'fmt',
                localName: 'fmt',
                importedName: null,
                importKind: 'namespace',
                isTypeOnly: false,
                line: 2,
                column: 8,
            },
            {
                source: 'foo/fmt',
                localName: 'f',
                importedName: null,
                importKind: 'namespace',
                isTypeOnly: false,
                line: 3,
                column: 7,
            },
            {
                source: 'os',
                localName: 'os',
                importedName: null,
                importKind: 'namespace',
                isTypeOnly: false,
                line: 7,
                column: 3,
            },
            {
                source: 'example.com/mod/path',
                localName: 'alias',
                importedName: null,
                importKind: 'namespace',
                isTypeOnly: false,
                line: 8,
                column: 2,
            },
        ]);
        expect(record.imports).toEqual([
            { module: 'fmt', importedNames: ['fmt'], line: 2, startLine: 2, endLine: 2 },
            { module: 'foo/fmt', importedNames: ['f'], line: 3, startLine: 3, endLine: 3 },
            { module: 'pkg', importedNames: [], line: 4, startLine: 4, endLine: 4 },
            { module: 'other/pkg', importedNames: [], line: 5, startLine: 5, endLine: 5 },
            { module: 'os', importedNames: ['os', 'alias'], line: 6, startLine: 6, endLine: 11 },
        ]);
    });

    it('recursively flattens Rust use trees and leaves glob imports span-only', async () => {
        const source = [
            'use a::b::C;',
            'use a::b as c;',
            'use a::{b, c as d};',
            'use a::{b::{c, d}, e};',
            'use a::*;',
            'use self::x::Y;',
            'use crate::foo::Bar;',
            'use super::baz as qux;',
            '',
        ].join('\n');

        const record = await extractParsedFile(source, 'rust', 'src/imports.rs', 'hash-rust-imports');
        expect(record).not.toBeNull();
        if (!record) return;

        expect(record.importBindings).toEqual([
            { source: 'a::b', localName: 'C', importedName: 'C', importKind: 'named', isTypeOnly: false, line: 1, column: 10 },
            { source: 'a', localName: 'c', importedName: 'b', importKind: 'named', isTypeOnly: false, line: 2, column: 12 },
            { source: 'a', localName: 'b', importedName: 'b', importKind: 'named', isTypeOnly: false, line: 3, column: 8 },
            { source: 'a', localName: 'd', importedName: 'c', importKind: 'named', isTypeOnly: false, line: 3, column: 16 },
            { source: 'a::b', localName: 'c', importedName: 'c', importKind: 'named', isTypeOnly: false, line: 4, column: 12 },
            { source: 'a::b', localName: 'd', importedName: 'd', importKind: 'named', isTypeOnly: false, line: 4, column: 15 },
            { source: 'a', localName: 'e', importedName: 'e', importKind: 'named', isTypeOnly: false, line: 4, column: 19 },
            { source: 'self::x', localName: 'Y', importedName: 'Y', importKind: 'named', isTypeOnly: false, line: 6, column: 13 },
            { source: 'crate::foo', localName: 'Bar', importedName: 'Bar', importKind: 'named', isTypeOnly: false, line: 7, column: 16 },
            { source: 'super', localName: 'qux', importedName: 'baz', importKind: 'named', isTypeOnly: false, line: 8, column: 18 },
        ]);
        expect(record.imports).toEqual([
            { module: 'a::b', importedNames: ['C'], line: 1, startLine: 1, endLine: 1 },
            { module: 'a', importedNames: ['c'], line: 2, startLine: 2, endLine: 2 },
            { module: 'a', importedNames: ['b', 'd'], line: 3, startLine: 3, endLine: 3 },
            { module: 'a', importedNames: ['c', 'd', 'e'], line: 4, startLine: 4, endLine: 4 },
            { module: 'a', importedNames: [], line: 5, startLine: 5, endLine: 5 },
            { module: 'self::x', importedNames: ['Y'], line: 6, startLine: 6, endLine: 6 },
            { module: 'crate::foo', importedNames: ['Bar'], line: 7, startLine: 7, endLine: 7 },
            { module: 'super', importedNames: ['qux'], line: 8, startLine: 8, endLine: 8 },
        ]);
    });

    it('extracts Java regular and static imports while leaving wildcard imports span-only', async () => {
        const source = [
            'import a.b.C;',
            'import static a.b.C.m;',
            'import a.b.*;',
            '',
        ].join('\n');

        const record = await extractParsedFile(source, 'java', 'src/Imports.java', 'hash-java-imports');
        expect(record).not.toBeNull();
        if (!record) return;

        expect(record.importBindings).toEqual([
            {
                source: 'a.b',
                localName: 'C',
                importedName: 'C',
                importKind: 'named',
                isTypeOnly: false,
                line: 1,
                column: 11,
            },
            {
                source: 'a.b.C',
                localName: 'm',
                importedName: 'm',
                importKind: 'named',
                isTypeOnly: false,
                line: 2,
                column: 20,
            },
        ]);
        expect(record.imports).toEqual([
            { module: 'a.b', importedNames: ['C'], line: 1, startLine: 1, endLine: 1 },
            { module: 'a.b.C', importedNames: ['m'], line: 2, startLine: 2, endLine: 2 },
            { module: 'a.b', importedNames: [], line: 3, startLine: 3, endLine: 3 },
        ]);
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
