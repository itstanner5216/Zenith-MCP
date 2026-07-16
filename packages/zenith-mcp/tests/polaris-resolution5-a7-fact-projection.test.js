// A7 pinning test — the v4 fact-ledger projection must be lossless.
//
// Plan §Authoritative fact ledger: "Every row must have at least one lossless
// typed projection." Direction: project persisted fields faithfully or type
// them explicitly unavailable — never silently drop.
//
// Independent oracle: raw SQL over the real persisted rows (never the composer
// under test). Fields the TS extractor cannot naturally produce (generics
// text, parent name, an orphan structure, an unmatched binding) are seeded
// directly, exactly as the shipped file-floor audit seeds its injection fact.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const savedHome = new Map(HOME_KEYS.map((key) => [key, process.env[key]]));

let fakeHome;
let projectRoot;
let ctx;
let mods;
let connection;
let session;

function stableRows(rows) {
    return rows.map((row) => JSON.stringify(row)).sort();
}

function section(model, name) {
    const found = model.sections.filter((s) => s.section === name);
    expect(found, `one ${name} section`).toHaveLength(1);
    return found[0];
}

async function open() {
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor: path.join(projectRoot, 'src', 'main.ts'),
        domain: { kind: 'project' },
        freshness: { mode: 'disk' },
    });
    expect(result.status).toBe('opened');
    return result.session;
}

const DEP_TS = 'export function helper(): number {\n    return 1;\n}\n';
const MAIN_TS = [
    "import { helper } from './dep.js';",
    '',
    'export class Widget {',
    '    private secret: number = 0;',
    '    public compute(param: number): number {',
    '        const local = param + 1;',
    '        return local + this.secret + helper();',
    '    }',
    '}',
    '',
    'export function topFn(a: number, b: number): number {',
    '    const sum = a + b;',
    '    return sum;',
    '}',
    '',
].join('\n');

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-a7-home-'));
    for (const key of HOME_KEYS) process.env[key] = fakeHome;
    vi.resetModules();
    mods = {
        session: await import('../dist/core/intelligence/session.js'),
        pc: await import('../dist/core/project-context.js'),
        db: await import('../dist/core/db-adapter.js'),
        file: await import('../dist/core/intelligence/questions/file.js'),
    };
    projectRoot = fs.mkdtempSync(path.join(fakeHome, 'project-'));
    ctx = { getAllowedDirectories: () => [projectRoot], validatePath: async (c) => c };
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'dep.ts'), DEP_TS);
    fs.writeFileSync(path.join(projectRoot, 'src', 'main.ts'), MAIN_TS);

    mods.pc.getProjectContext(ctx).reloadRegistry([{
        project_id: 'a7', project_name: 'a7', project_root: projectRoot,
    }]);

    const bootstrap = await open();
    bootstrap.close();
    connection = mods.pc.getProjectContext(ctx)
        .getIntelligenceStore(path.join(projectRoot, 'src', 'main.ts')).address.db;

    const computeRows = mods.db.queryRaw(connection, `
        SELECT ss.symbol_id AS symbolId FROM symbol_structures ss
        JOIN symbols s ON s.id = ss.symbol_id
        WHERE s.file_path = 'src/main.ts' AND s.name = 'compute'
    `);
    expect(computeRows, 'compute has a persisted structure row').toHaveLength(1);
    const computeSymbolId = computeRows[0].symbolId;

    mods.db.runTransaction(connection, () => {
        // Structure fields the extractor persists as null / does not emit.
        mods.db.queryRaw(connection, `
            UPDATE symbol_structures
            SET decorators_json = '["@Log"]', generics_text = '<T>',
                parent_kind = 'class_declaration', parent_name = 'Widget'
            WHERE symbol_id = ? RETURNING symbol_id
        `, computeSymbolId);
        // Injection with host language + exact byte offsets.
        mods.db.insertInjection(connection, {
            filePath: 'src/main.ts', hostLang: 'typescript', injectedLang: 'sql',
            startLine: 6, endLine: 6, startByte: 130, endByte: 151,
        });
        // A deterministic declared visibility on a symbol that exists.
        mods.db.queryRaw(connection, `
            UPDATE symbols SET visibility = 'protected'
            WHERE file_path = 'src/main.ts' AND name = 'compute' AND kind = 'def'
            RETURNING id
        `);
        // Import binding matching no import statement span.
        mods.db.insertImportBinding(connection, {
            filePath: 'src/main.ts', source: './ghost', localName: 'ghost',
            importedName: 'ghost', importKind: 'named', isTypeOnly: false,
            line: 500, column: 0,
        });
    });
    session = await open();
});

afterEach(() => {
    try { session?.close(); } catch { /* ignore */ }
    try { mods?.pc.closeGlobalDb(); } catch { /* ignore */ }
    try { mods?.pc.resetProjectContext(); } catch { /* ignore */ }
    for (const key of HOME_KEYS) {
        const value = savedHome.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('A7 — lossless v4 fact projection', () => {
    it('projects scope parameters and locals faithfully', async () => {
        const model = (await session.fileModel('src/main.ts', { sections: ['scopes'] })).data;
        const scopes = section(model, 'scopes').facts;
        const raw = mods.db.queryRaw(connection, `
            SELECT s.name AS ownerName, ls.parameters_json AS parametersJson,
                   ls.locals_json AS localsJson
            FROM local_scopes ls JOIN symbols s ON s.id = ls.symbol_id
            WHERE s.file_path = 'src/main.ts'
        `);
        // Anti-vacuity: at least one scope actually carries parameters.
        const rawParamNames = raw.flatMap((r) => JSON.parse(r.parametersJson || '[]').map((p) => p.name));
        expect(rawParamNames.length).toBeGreaterThan(0);

        const projected = stableRows(scopes.map((s) => ({
            params: s.parameters.map((p) => p.name),
            locals: s.locals.map((l) => l.name),
        })));
        const oracle = stableRows(raw.map((r) => ({
            params: JSON.parse(r.parametersJson || '[]').map((p) => p.name),
            locals: JSON.parse(r.localsJson || '[]').map((l) => l.name),
        })));
        expect(projected).toEqual(oracle);
        // Positions are carried, not dropped.
        for (const s of scopes) {
            for (const member of [...s.parameters, ...s.locals]) {
                expect(member.range.startLine).toBeGreaterThanOrEqual(1);
            }
        }
    });

    it('projects occurrence visibility faithfully', async () => {
        const model = (await session.fileModel('src/main.ts', { sections: ['declarations'] })).data;
        const decls = section(model, 'declarations').facts;
        const raw = mods.db.queryRaw(connection, `
            SELECT name, visibility FROM symbols
            WHERE file_path = 'src/main.ts' AND kind = 'def'
        `);
        const rawByName = new Map(raw.map((r) => [r.name, r.visibility ?? null]));
        // Anti-vacuity: a declared visibility really persisted.
        expect(rawByName.get('compute')).toBe('protected');

        for (const decl of decls) {
            expect(decl).toHaveProperty('visibility');
            expect(decl.visibility).toBe(rawByName.get(decl.name) ?? null);
        }
    });

    it('projects structure decorators, generics, and parent faithfully', async () => {
        const model = (await session.fileModel('src/main.ts', { sections: ['declarations', 'structures'] })).data;
        const structures = section(model, 'structures').facts;
        const declKeyToName = new Map(section(model, 'declarations').facts
            .map((f) => [f.handle.stableKey, f.name]));
        const compute = structures.find((s) => declKeyToName.get(s.ownerStableKey) === 'compute');
        expect(compute, 'compute structure projected').toBeTruthy();

        const raw = mods.db.queryRaw(connection, `
            SELECT ss.decorators_json AS decoratorsJson, ss.generics_text AS genericsText,
                   ss.parent_kind AS parentKind, ss.parent_name AS parentName
            FROM symbol_structures ss JOIN symbols s ON s.id = ss.symbol_id
            WHERE s.file_path = 'src/main.ts' AND s.name = 'compute'
        `)[0];
        expect(compute.decorators).toEqual(JSON.parse(raw.decoratorsJson));
        expect(compute.generics).toBe(raw.genericsText);
        expect(compute.parentKind).toBe(raw.parentKind);
        expect(compute.parentName).toBe(raw.parentName);
        // Anti-vacuity: these are the seeded non-null values.
        expect(compute.generics).toBe('<T>');
        expect(compute.parentName).toBe('Widget');
    });

    it('projects injection host language and byte offsets faithfully', async () => {
        const model = (await session.fileModel('src/main.ts', { sections: ['injections'] })).data;
        const injections = section(model, 'injections').facts;
        const raw = mods.db.queryRaw(connection, `
            SELECT host_lang AS hostLanguage, injected_lang AS injectedLanguage,
                   start_byte AS startByte, end_byte AS endByte
            FROM injections WHERE file_path = 'src/main.ts'
        `);
        expect(raw.length).toBeGreaterThan(0);
        const projected = stableRows(injections.map((i) => ({
            language: i.language, hostLanguage: i.hostLanguage, byteRange: i.byteRange,
        })));
        const oracle = stableRows(raw.map((r) => ({
            language: r.injectedLanguage, hostLanguage: r.hostLanguage,
            byteRange: r.startByte !== null && r.endByte !== null
                ? { startByte: r.startByte, endByte: r.endByte } : null,
        })));
        expect(projected).toEqual(oracle);
    });

    it('projects every persisted structure without dropping any', async () => {
        const model = (await session.fileModel('src/main.ts', { sections: ['structures'] })).data;
        const structures = section(model, 'structures').facts;
        const rawCount = mods.db.queryRaw(connection, `
            SELECT COUNT(*) AS n FROM symbol_structures ss
            JOIN symbols s ON s.id = ss.symbol_id WHERE s.file_path = 'src/main.ts'
        `)[0].n;
        expect(rawCount).toBeGreaterThan(0); // anti-vacuity: structures exist
        expect(structures.length).toBe(rawCount);
    });

    it('surfaces an orphan structure with a null owner instead of dropping it', () => {
        // Orphans (a structure whose symbol row is absent from the assembly)
        // are unreachable to seed under the ON DELETE CASCADE FK, so the
        // exported projection is exercised directly. The old code returned null
        // (dropped); the fix returns a faithful fact with a null owner key.
        const owner = { key: 'owner-fact-key', name: 'Owner', kind: 'class', row: { internalId: 7 } };
        const assembly = { storeKey: 'x.ts', byInternalId: new Map([[7, owner]]) };
        const row = (symbolInternalId) => ({
            symbolInternalId, filePath: 'x.ts', name: 'ghost', line: 1, column: 0,
            paramsJson: '["p"]', returnText: 'void', decoratorsJson: '[]',
            modifiersJson: '[]', genericsText: null, parentKind: null, parentName: null,
        });
        // Control: a resolvable owner yields its key (proves the branch matters).
        const owned = mods.file.structureFactOf(row(7), assembly);
        expect(owned.ownerStableKey).toBe('owner-fact-key');
        // Orphan: surfaced, not dropped, with a null owner key.
        const orphan = mods.file.structureFactOf(row(999), assembly);
        expect(orphan).not.toBeNull();
        expect(orphan.ownerStableKey).toBeNull();
        expect(orphan.parameters).toEqual(['p']);
    });

    it('surfaces import bindings that match no statement', async () => {
        const model = (await session.fileModel('src/main.ts', { sections: ['imports'] })).data;
        const imports = section(model, 'imports').facts;
        const rawBindingCount = mods.db.queryRaw(connection,
            "SELECT COUNT(*) AS n FROM import_bindings WHERE file_path = 'src/main.ts'")[0].n;
        const projectedBindings = imports.flatMap((i) => i.bindings);
        // No binding is dropped.
        expect(projectedBindings.length).toBe(rawBindingCount);

        const bindingOnly = imports.filter((i) => i.origin === 'binding_only');
        expect(bindingOnly.some((i) => i.bindings.some((b) => b.localName === 'ghost'))).toBe(true);
        // A binding-only group invents no statement names.
        for (const group of bindingOnly) expect(group.importedNames).toEqual([]);
        // The real statement is still origin 'statement'.
        expect(imports.some((i) => i.origin === 'statement'
            && i.bindings.some((b) => b.localName === 'helper'))).toBe(true);
    });

    it('completes the import_binding coverage domain', async () => {
        const result = await session.fileModel('src/main.ts', { sections: ['imports'] });
        const cov = result.data.coverage;
        expect(cov.requested).toContain('import');
        expect(cov.requested).toContain('import_binding');
        expect(cov.complete).toContain('import_binding');
    });
});
