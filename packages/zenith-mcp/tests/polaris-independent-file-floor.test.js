// Independent POLARIS audit: evidence lattice, literal floor, and the
// implemented fileModel composer. Expected values come from hand-derived
// byte facts, Node's crypto/Buffer primitives, or raw SQL -- never by
// snapshotting the implementation under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    domainHash, gradeAtMost, weakestGrade,
} from '../dist/core/intelligence/evidence.js';
import { scanLiteralFloor } from '../dist/core/intelligence/text-floor.js';

const RG_AVAILABLE = (() => {
    const result = spawnSync('rg', ['--version'], { encoding: 'utf8' });
    return result.error === undefined && result.status === 0;
})();

function referenceDomainHash(domain, parts) {
    const hash = crypto.createHash('sha256');
    for (const value of [domain, ...parts]) {
        const bytes = Buffer.from(value, 'utf8');
        hash.update(`${bytes.length}:`);
        hash.update(bytes);
    }
    return hash.digest('hex');
}

function codeUnitLengthMutation(domain, parts) {
    const hash = crypto.createHash('sha256');
    for (const value of [domain, ...parts]) {
        hash.update(`${value.length}:`);
        hash.update(Buffer.from(value, 'utf8'));
    }
    return hash.digest('hex');
}

function rawByteOracle(literal, files) {
    const needle = Buffer.from(literal, 'utf8');
    const matches = [];
    for (const file of files) {
        const bytes = file.content === undefined
            ? fs.readFileSync(file.absPath)
            : Buffer.from(file.content, 'utf8');
        let from = 0;
        for (;;) {
            const byteOffset = bytes.indexOf(needle, from);
            if (byteOffset === -1) break;
            const prefix = bytes.subarray(0, byteOffset).toString('utf8');
            const lines = prefix.split('\n');
            matches.push({
                storeKey: file.storeKey,
                byteOffset,
                line: lines.length,
                column: lines[lines.length - 1].length,
            });
            from = byteOffset + needle.length;
        }
    }
    return matches;
}

function positionProjection(outcome) {
    return outcome.matches.map(({ storeKey, byteOffset, line, column }) => ({
        storeKey, byteOffset, line, column,
    }));
}

function stableRows(rows) {
    return rows.map((row) => JSON.stringify(row)).sort();
}

function section(model, name) {
    const found = model.sections.filter((candidate) => candidate.section === name);
    expect(found, `one ${name} section`).toHaveLength(1);
    return found[0];
}

describe('independent evidence-lattice oracles', () => {
    it('uses UTF-8 byte lengths in the domain-separated hash', () => {
        const domain = 'fact-😀';
        const parts = ['ASCII', 'é', '\uE000', '𝌆', '\uD800'];
        const expected = referenceDomainHash(domain, parts);

        expect(domainHash(domain, parts)).toBe(expected);
        expect(domainHash(domain, [...parts].reverse())).not.toBe(expected);

        // Mutation control: a JS-code-unit length prefix disagrees on this
        // corpus, so this test turns red if byte lengths regress to `.length`.
        const plausibleWrongHash = codeUnitLengthMutation(domain, parts);
        expect(plausibleWrongHash).not.toBe(expected);
        expect(domainHash(domain, parts)).not.toBe(plausibleWrongHash);
    });

    it('computes the meet for every deterministic grade triple', () => {
        const grades = ['text', 'structural', 'binding'];
        const rank = new Map(grades.map((grade, index) => [grade, index]));
        let mixedControlObserved = false;

        for (const a of grades) {
            for (const b of grades) {
                for (const c of grades) {
                    const inputs = [a, b, c];
                    const expected = inputs.reduce((left, right) =>
                        rank.get(left) <= rank.get(right) ? left : right);
                    const plausibleWrong = inputs.reduce((left, right) =>
                        rank.get(left) >= rank.get(right) ? left : right);
                    expect(weakestGrade(a, b, c)).toBe(expected);
                    expect(inputs.every((input) => gradeAtMost(expected, input))).toBe(true);
                    if (expected !== plausibleWrong) mixedControlObserved = true;
                }
            }
        }

        // Negative control: the strongest-input mutation differs on mixed
        // triples, proving the exhaustive loop is capable of failing.
        expect(mixedControlObserved).toBe(true);
        expect(gradeAtMost('binding', 'text')).toBe(false);
        expect(gradeAtMost('text', 'binding')).toBe(true);
    });
});

describe('literal floor against raw-byte and metamorphic oracles', () => {
    it('matches hand-derived UTF-8 offsets and UTF-16 columns', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-independent-floor-'));
        try {
            const contentA = 'head\r\nAé\uE000😀\uD800::needle::needleX\n';
            const contentB = 'needle at start\n';
            const contentC = 'no literal here\n';
            const files = [
                ['a.ts', contentA],
                ['b.ts', contentB],
                ['c.ts', contentC],
            ].map(([storeKey, content]) => {
                const absPath = path.join(root, storeKey);
                fs.writeFileSync(absPath, content);
                return { storeKey, absPath };
            });

            const expected = rawByteOracle('needle', files);
            const outcome = scanLiteralFloor('needle', files, { forceScanner: 'in_process' });

            expect(expected).toEqual([
                { storeKey: 'a.ts', byteOffset: 21, line: 2, column: 8 },
                { storeKey: 'a.ts', byteOffset: 29, line: 2, column: 16 },
                { storeKey: 'b.ts', byteOffset: 0, line: 1, column: 0 },
            ]);
            expect(positionProjection(outcome)).toEqual(expected);
            expect(outcome.complete).toBe(true);

            const boundaries = new Map(outcome.matches.map((match) =>
                [`${match.storeKey}:${match.byteOffset}`, match.identifierBoundary]));
            expect(boundaries.get('a.ts:21')).toBe(true);
            expect(boundaries.get('a.ts:29')).toBe(false); // followed by X
            expect(boundaries.get('b.ts:0')).toBe(true);

            const absent = scanLiteralFloor('definitelyAbsent', files,
                { forceScanner: 'in_process' });
            expect(absent.matches).toEqual([]);
            expect(absent.complete).toBe(true);

            // Mutation controls: byte, UTF-16, and code-point coordinates
            // are intentionally all different before the first hit.
            const linePrefix = 'Aé\uE000😀\uD800::';
            expect(Buffer.byteLength(linePrefix)).toBe(15);
            expect(linePrefix.length).toBe(8);
            expect([...linePrefix].length).toBe(7);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(!RG_AVAILABLE)('keeps rg and in-process output equivalent on the Unicode corpus', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-independent-rg-'));
        try {
            const files = [
                ['a.ts', 'head\r\nAé\uE000😀\uD800::needle::needleX\n'],
                ['b.ts', 'needle at start\n'],
                ['c.ts', 'no literal here\n'],
            ].map(([storeKey, content]) => {
                const absPath = path.join(root, storeKey);
                fs.writeFileSync(absPath, content);
                return { storeKey, absPath };
            });

            const oracle = rawByteOracle('needle', files);
            const viaRg = scanLiteralFloor('needle', files, { forceScanner: 'rg' });
            const inProcess = scanLiteralFloor('needle', files, { forceScanner: 'in_process' });

            expect(viaRg.scanner).toBe('rg');
            expect(viaRg.complete).toBe(true);
            expect(inProcess.complete).toBe(true);
            expect(positionProjection(viaRg)).toEqual(oracle);
            expect(viaRg.matches).toEqual(inProcess.matches);

            // Negative control: a one-byte shift is not accepted as an
            // equivalent result, so offset parsing is materially asserted.
            const shifted = oracle.map((match, index) =>
                index === 0 ? { ...match, byteOffset: match.byteOffset + 1 } : match);
            expect(positionProjection(viaRg)).not.toEqual(shifted);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('treats the byte budget as an exact inclusive threshold', () => {
        const first = { storeKey: 'a.ts', absPath: '/not-read/a.ts', content: 'abcdefghij' };
        const second = { storeKey: 'b.ts', absPath: '/not-read/b.ts', content: 'needle!' };
        const firstBytes = Buffer.byteLength(first.content);
        const allBytes = firstBytes + Buffer.byteLength(second.content);

        const throughFirst = scanLiteralFloor('needle', [first, second], {
            forceScanner: 'in_process', byteBudget: firstBytes,
        });
        expect(throughFirst.scannedBytes).toBe(firstBytes);
        expect(throughFirst.scannedFiles).toBe(1);
        expect(throughFirst.matches).toEqual([]);
        expect(throughFirst.stopReason).toBe('byte_budget');
        expect(throughFirst.complete).toBe(false);

        const throughAll = scanLiteralFloor('needle', [first, second], {
            forceScanner: 'in_process', byteBudget: allBytes,
        });
        expect(throughAll.scannedBytes).toBe(allBytes);
        expect(throughAll.scannedFiles).toBe(2);
        expect(throughAll.matches.map((match) => match.storeKey)).toEqual(['b.ts']);
        expect(throughAll.stopReason).toBeNull();
        expect(throughAll.complete).toBe(true);

        // Mutation control for `>=` versus `>` at the budget boundary.
        const oneByteShort = scanLiteralFloor('needle', [first, second], {
            forceScanner: 'in_process', byteBudget: allBytes - 1,
        });
        expect(oneByteShort.complete).toBe(false);
        expect(oneByteShort.matches).toEqual([]);
    });
});

describe('fileModel supported sections against raw SQL', () => {
    const HOME_KEYS = ['HOME', 'USERPROFILE'];
    const savedHome = new Map(HOME_KEYS.map((key) => [key, process.env[key]]));
    const canonicalSections = [
        'declarations', 'references', 'scopes', 'imports',
        'structures', 'anchors', 'injections',
    ];

    let fakeHome;
    let projectRoot;
    let ctx;
    let session;
    let connection;
    let mods;

    async function open() {
        const result = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(projectRoot, 'src', 'main.ts'),
            domain: { kind: 'project' },
            freshness: { mode: 'disk' },
        });
        expect(result.status).toBe('opened');
        expect(result.session.basis.scopeMode).toBe('project');
        return result.session;
    }

    beforeEach(async () => {
        fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-independent-model-'));
        for (const key of HOME_KEYS) process.env[key] = fakeHome;

        vi.resetModules();
        mods = {
            session: await import('../dist/core/intelligence/session.js'),
            pc: await import('../dist/core/project-context.js'),
            db: await import('../dist/core/db-adapter.js'),
        };

        projectRoot = fs.mkdtempSync(path.join(fakeHome, 'project-'));
        ctx = {
            getAllowedDirectories: () => [projectRoot],
            validatePath: async (candidate) => candidate,
        };
        fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, 'src', 'dep.ts'), [
            'export interface Widget { id: number; }',
            'export function helper(value: number): number {',
            '    return value + 1;',
            '}',
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(projectRoot, 'src', 'main.ts'), [
            "import { helper, type Widget } from './dep.js';",
            "import * as ns from './dep.js';",
            '',
            'export class Outer {',
            '    method(value: number): number {',
            '        if (value > 0) {',
            '            return helper(value);',
            '        }',
            '        return ns.helper(0);',
            '    }',
            '}',
            '',
            'export function topFn(item: Widget): number {',
            '    for (let i = 0; i < 2; i += 1) {',
            '        helper(i);',
            '    }',
            '    return item.id;',
            '}',
            '',
        ].join('\n'));

        mods.pc.getProjectContext(ctx).reloadRegistry([{
            project_id: 'independent',
            project_name: 'independent',
            project_root: projectRoot,
        }]);

        // First open creates and indexes the real project store. Add one
        // hand-authored authoritative injection fact, then reopen so the
        // session pins the post-commit epoch.
        const bootstrap = await open();
        bootstrap.close();
        connection = mods.pc.getProjectContext(ctx)
            .getIntelligenceStore(path.join(projectRoot, 'src', 'main.ts')).address.db;
        mods.db.runTransaction(connection, () => {
            mods.db.insertInjection(connection, {
                filePath: 'src/main.ts',
                hostLang: 'typescript',
                injectedLang: 'sql',
                startLine: 7,
                endLine: 7,
                startByte: 120,
                endByte: 141,
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

    it('concatenates keyset pages to the one-shot raw-fact projection', async () => {
        const oneShotResult = await session.fileModel('src/main.ts', {
            sections: canonicalSections,
        });
        expect(oneShotResult.status).toBe('complete');
        const oneShot = oneShotResult.data;
        expect(oneShot.path).toBe('src/main.ts');
        expect(oneShot.sections.map((item) => item.section)).toEqual(canonicalSections);

        const rawSymbols = mods.db.queryRaw(connection, `
            SELECT s.name, s.kind AS storageKind, s.type AS factKind,
                   s.line, COALESCE(s.end_line, s.line) AS endLine, s.column,
                   p.name AS ownerName
            FROM symbols s
            LEFT JOIN symbols p ON p.id = s.parent_symbol_id
            WHERE s.file_path = ?
            ORDER BY s.line, s.column, COALESCE(s.end_line, s.line), s.type, s.name
        `, 'src/main.ts');
        const rawImports = mods.db.queryRaw(connection, `
            SELECT module, imported_names_json AS importedNamesJson,
                   COALESCE(start_line, line) AS startLine,
                   COALESCE(end_line, line) AS endLine
            FROM imports WHERE file_path = ?
            ORDER BY COALESCE(start_line, line), COALESCE(end_line, line), module
        `, 'src/main.ts');
        const rawBindings = mods.db.queryRaw(connection, `
            SELECT source, local_name AS localName, imported_name AS importedName,
                   import_kind AS bindingKind, is_type_only AS typeOnly, line, column
            FROM import_bindings WHERE file_path = ?
            ORDER BY line, column, import_kind, local_name
        `, 'src/main.ts');
        const rawScopes = mods.db.queryRaw(connection, `
            SELECT ls.scope_kind AS kind, ls.start_line AS startLine,
                   COALESCE(ls.end_line, ls.start_line) AS endLine, s.name AS ownerName
            FROM local_scopes ls JOIN symbols s ON s.id = ls.symbol_id
            WHERE s.file_path = ?
            ORDER BY ls.start_line, COALESCE(ls.end_line, ls.start_line), ls.scope_kind, s.name
        `, 'src/main.ts');
        const rawStructures = mods.db.queryRaw(connection, `
            SELECT s.name AS ownerName, ss.params_json AS paramsJson,
                   ss.modifiers_json AS modifiersJson, ss.return_text AS returnText
            FROM symbol_structures ss JOIN symbols s ON s.id = ss.symbol_id
            WHERE s.file_path = ?
            ORDER BY s.line, s.column, s.type, s.name
        `, 'src/main.ts');
        const rawAnchors = mods.db.queryRaw(connection, `
            SELECT a.kind, a.line, COALESCE(a.end_line, a.line) AS endLine
            FROM anchors a JOIN symbols s ON s.id = a.symbol_id
            WHERE s.file_path = ?
            ORDER BY a.line, COALESCE(a.end_line, a.line), a.kind, s.name
        `, 'src/main.ts');
        const rawInjections = mods.db.queryRaw(connection, `
            SELECT injected_lang AS language, start_line AS startLine,
                   COALESCE(end_line, start_line) AS endLine
            FROM injections WHERE file_path = ?
            ORDER BY start_line, start_byte, end_byte, end_line, injected_lang
        `, 'src/main.ts');

        const declarations = section(oneShot, 'declarations').facts;
        const references = section(oneShot, 'references').facts;
        const scopes = section(oneShot, 'scopes').facts;
        const imports = section(oneShot, 'imports').facts;
        const structures = section(oneShot, 'structures').facts;
        const anchors = section(oneShot, 'anchors').facts;
        const injections = section(oneShot, 'injections').facts;

        const occurrenceShape = (fact) => ({
            name: fact.name,
            factKind: fact.kind,
            line: fact.range.startLine,
            endLine: fact.range.endLine,
            column: fact.range.startColumn,
            ownerName: fact.owner?.name ?? null,
        });
        const rawOccurrenceShape = (row) => ({
            name: row.name,
            factKind: row.factKind,
            line: row.line,
            endLine: row.endLine,
            column: row.column,
            ownerName: row.ownerName,
        });
        expect(stableRows(declarations.map(occurrenceShape))).toEqual(stableRows(
            rawSymbols.filter((row) => row.storageKind === 'def').map(rawOccurrenceShape),
        ));
        expect(stableRows(references.map(occurrenceShape))).toEqual(stableRows(
            rawSymbols.filter((row) => row.storageKind === 'ref').map(rawOccurrenceShape),
        ));
        expect([...declarations, ...references].every((fact) =>
            fact.evidence === 'structural' && fact.namespace === 'unknown')).toBe(true);

        const declarationKeyByName = new Map(declarations.map((fact) =>
            [fact.name, fact.handle.stableKey]));
        expect(stableRows(scopes.map((fact) => ({
            kind: fact.kind,
            startLine: fact.range.startLine,
            endLine: fact.range.endLine,
            ownerStableKey: fact.ownerStableKey,
        })))).toEqual(stableRows(rawScopes.map((row) => ({
            kind: row.kind,
            startLine: row.startLine,
            endLine: row.endLine,
            ownerStableKey: declarationKeyByName.get(row.ownerName),
        }))));

        expect(stableRows(imports.map((fact) => ({
            module: fact.module,
            importedNames: [...fact.importedNames],
            startLine: fact.range.startLine,
            endLine: fact.range.endLine,
        })))).toEqual(stableRows(rawImports.map((row) => ({
            module: row.module,
            importedNames: row.importedNamesJson ? JSON.parse(row.importedNamesJson) : [],
            startLine: row.startLine,
            endLine: row.endLine,
        }))));
        expect(stableRows(imports.flatMap((fact) => fact.bindings.map((binding) => ({
            source: fact.module,
            localName: binding.localName,
            importedName: binding.importedName,
            bindingKind: binding.bindingKind,
            typeOnly: Number(binding.typeOnly),
            line: binding.range.startLine,
            column: binding.range.startColumn,
        }))))).toEqual(stableRows(rawBindings.map((row) => ({
            ...row,
            importedName: row.importedName ?? row.localName,
        }))));

        const declarationNameByKey = new Map(declarations.map((fact) =>
            [fact.handle.stableKey, fact.name]));
        expect(stableRows(structures.map((fact) => ({
            ownerName: declarationNameByKey.get(fact.ownerStableKey),
            parameters: [...fact.parameters],
            modifiers: [...fact.modifiers],
            returnText: fact.declaredReturnType,
        })))).toEqual(stableRows(rawStructures.map((row) => ({
            ownerName: row.ownerName,
            parameters: row.paramsJson ? JSON.parse(row.paramsJson) : [],
            modifiers: row.modifiersJson ? JSON.parse(row.modifiersJson) : [],
            returnText: row.returnText,
        }))));
        expect(stableRows(anchors.map((fact) => ({
            kind: fact.kind,
            line: fact.range.startLine,
            endLine: fact.range.endLine,
        })))).toEqual(stableRows(rawAnchors));
        expect(stableRows(injections.map((fact) => ({
            language: fact.language,
            startLine: fact.range.startLine,
            endLine: fact.range.endLine,
        })))).toEqual(stableRows(rawInjections));

        const expectedCounts = {
            declarations: rawSymbols.filter((row) => row.storageKind === 'def').length,
            references: rawSymbols.filter((row) => row.storageKind === 'ref').length,
            scopes: rawScopes.length,
            imports: rawImports.length,
            structures: rawStructures.length,
            anchors: rawAnchors.length,
            injections: rawInjections.length,
        };
        for (const [name, count] of Object.entries(expectedCounts)) {
            expect(count, `${name} fixture control`).toBeGreaterThan(0);
        }
        expect(rawSymbols.some((row) => row.name === 'topFn')).toBe(true);
        expect(rawSymbols.some((row) => row.name === 'neverPresent')).toBe(false);

        const reversedSections = [...canonicalSections].reverse();
        const collected = new Map(canonicalSections.map((name) => [name, []]));
        let after;
        let expectedTotal;
        let returnedTotal = 0;
        let pageCount = 0;
        for (; pageCount < 100; pageCount += 1) {
            const result = await session.fileModel('src/main.ts', {
                sections: reversedSections,
                page: after === undefined ? { limit: 2 } : { limit: 2, after },
            });
            expect(result.status).toBeOneOf(['complete', 'partial']);
            expect(result.data.sections.map((item) => item.section)).toEqual(canonicalSections);
            expect(result.data.page.returned).toBeLessThanOrEqual(2);
            expect(result.data.page.total.kind).toBe('exact');
            expectedTotal ??= result.data.page.total.value;
            expect(result.data.page.total.value).toBe(expectedTotal);
            returnedTotal += result.data.page.returned;
            for (const name of canonicalSections) {
                collected.get(name).push(...section(result.data, name).facts);
            }
            if (result.data.page.exhausted) {
                expect(result.data.page.next).toBeNull();
                break;
            }
            expect(result.data.page.next).not.toBeNull();
            after = result.data.page.next;
        }

        expect(pageCount).toBeGreaterThan(0); // limit=2 exercised continuation
        expect(expectedTotal).toBe(Object.values(expectedCounts).reduce((a, b) => a + b, 0));
        expect(returnedTotal).toBe(expectedTotal);
        for (const name of canonicalSections) {
            expect(collected.get(name)).toEqual(section(oneShot, name).facts);
        }

        const declarationsOnly = await session.fileModel('src/main.ts', {
            sections: ['declarations'],
        });
        expect(declarationsOnly.data.sections.map((item) => item.section))
            .toEqual(['declarations']);
        expect(section(declarationsOnly.data, 'declarations').facts).toEqual(declarations);

        // Mutation controls: dropping one raw declaration or duplicating one
        // page cannot satisfy the independent/raw and metamorphic oracles.
        expect(stableRows(declarations.map(occurrenceShape))).not.toEqual(stableRows(
            rawSymbols.filter((row) => row.storageKind === 'def').slice(1).map(rawOccurrenceShape),
        ));
        expect(returnedTotal + 1).not.toBe(expectedTotal);
    }, 30_000);
});
