// A21 pinning test — lastIndexedAt must not leak persistence history through
// file identity.
//
// Plan §Authoritative fact ledger line 732: "Internal row IDs, storage keys,
// timestamps, raw JSON encodings ... are persistence mechanics rather than
// public facts and never cross the facade."
//
// Independent oracles:
//   * runtime: the persisted files.last_indexed column DOES hold a real
//     timestamp (anti-vacuity — the persistence history exists), yet the
//     public identity facts expose no such key.
//   * compile-time: the FileIdentityFacts declaration in built dist rejects an
//     object literal carrying lastIndexedAt (TS excess-property), and accepts
//     the exact public shape without it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const savedHome = new Map(HOME_KEYS.map((key) => [key, process.env[key]]));
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(TESTS_DIR, '..');
const VIRTUAL_FIXTURE = path.join(
    PACKAGE_DIR, 'dist', 'core', 'intelligence', '__a21_identity_timestamp__.ts',
);

const COMPILER_OPTIONS = {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
};

function compileVirtual(source) {
    const baseHost = ts.createCompilerHost(COMPILER_OPTIONS, true);
    const normalizedFixture = path.resolve(VIRTUAL_FIXTURE);
    const host = {
        ...baseHost,
        fileExists(fileName) {
            return path.resolve(fileName) === normalizedFixture || baseHost.fileExists(fileName);
        },
        readFile(fileName) {
            if (path.resolve(fileName) === normalizedFixture) return source;
            return baseHost.readFile(fileName);
        },
        getSourceFile(fileName, languageVersion) {
            const text = host.readFile(fileName);
            if (text === undefined) return undefined;
            return ts.createSourceFile(fileName, text, languageVersion, true,
                ts.getScriptKindFromFileName(fileName));
        },
    };
    const program = ts.createProgram({ rootNames: [VIRTUAL_FIXTURE], options: COMPILER_OPTIONS, host });
    return ts.getPreEmitDiagnostics(program).filter((d) => (
        d.category === ts.DiagnosticCategory.Error
        && d.file !== undefined
        && path.resolve(d.file.fileName) === normalizedFixture
    ));
}

function identityLiteral(includeTimestamp) {
    return [
        "import type { FileIdentityFacts } from './types.js';",
        'const facts: FileIdentityFacts = {',
        "    path: 'src/main.ts',",
        "    language: 'typescript',",
        "    sourceHash: 'abc',",
        '    oversized: false,',
        includeTimestamp ? '    lastIndexedAt: 1,' : '',
        '};',
        'void facts;',
    ].filter((line) => line !== '').join('\n');
}

let fakeHome;
let projectRoot;
let ctx;
let mods;

async function open() {
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor: path.join(projectRoot, 'src', 'main.ts'),
        domain: { kind: 'project' },
        freshness: { mode: 'disk' },
    });
    expect(result.status).toBe('opened');
    return result.session;
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-a21-home-'));
    for (const key of HOME_KEYS) process.env[key] = fakeHome;
    vi.resetModules();
    mods = {
        session: await import('../dist/core/intelligence/session.js'),
        pc: await import('../dist/core/project-context.js'),
        db: await import('../dist/core/db-adapter.js'),
    };
    projectRoot = fs.mkdtempSync(path.join(fakeHome, 'project-'));
    ctx = { getAllowedDirectories: () => [projectRoot], validatePath: async (c) => c };
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'main.ts'),
        'export function target(): number {\n    return 1;\n}\n');
    mods.pc.getProjectContext(ctx).reloadRegistry([{
        project_id: 'a21', project_name: 'a21', project_root: projectRoot,
    }]);
});

afterEach(() => {
    try { mods?.pc.closeGlobalDb(); } catch { /* ignore */ }
    try { mods?.pc.resetProjectContext(); } catch { /* ignore */ }
    for (const key of HOME_KEYS) {
        const value = savedHome.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('A21 — file identity does not leak lastIndexedAt', () => {
    it('projects identity without the persisted timestamp the store still holds', async () => {
        const session = await open();
        try {
            const result = await session.fileModel('src/main.ts', { sections: ['identity'] });
            expect(['complete', 'partial']).toContain(result.status);
            const identity = result.data.sections.find((s) => s.section === 'identity');
            expect(identity?.facts).not.toBeNull();
            const facts = identity.facts;

            // Anti-vacuity: the persistence layer really does track last_indexed.
            const connection = mods.pc.getProjectContext(ctx)
                .getIntelligenceStore(path.join(projectRoot, 'src', 'main.ts')).address.db;
            const rawRows = mods.db.queryRaw(connection,
                'SELECT last_indexed AS lastIndexed FROM files WHERE path = ?', 'src/main.ts');
            expect(rawRows).toHaveLength(1);
            expect(typeof rawRows[0].lastIndexed).toBe('number');

            // Contract: the public identity fact exposes no persistence timestamp.
            expect(Object.keys(facts).sort()).toEqual(['language', 'oversized', 'path', 'sourceHash']);
            expect('lastIndexedAt' in facts).toBe(false);
        } finally {
            session.close();
        }
    });

    it('rejects a FileIdentityFacts literal carrying lastIndexedAt at compile time', () => {
        // Control: the exact public shape compiles clean.
        const clean = compileVirtual(identityLiteral(false));
        expect(clean.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
            .toBe('');
        // The timestamp variant is an excess property — rejected by the type.
        const withTimestamp = compileVirtual(identityLiteral(true));
        expect(withTimestamp.some((d) => d.code === 2353 || d.code === 2322)).toBe(true);
    });
});
