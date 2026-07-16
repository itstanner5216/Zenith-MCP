// Independent POLARIS correctness audit: encoding and content freshness.
//
// Oracles are deliberately outside the implementation under test:
//   1. JavaScript String#indexOf reports UTF-16 code-unit columns, the amended
//      public contract's unit. Buffer.byteLength supplies the negative byte
//      control and must disagree after multibyte/supplementary prefixes.
//   2. Indexing caller-supplied bytes and indexing those same bytes from disk
//      are independent ingestion frames that must project the same facts.
//   3. A fact identity is content-addressed: no-op reopen preserves it, a
//      byte change outside the occurrence changes it, and restoration recovers
//      the original key.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const SAVED_HOME = HOME_KEYS.map((key) => [key, process.env[key]]);

let fakeHome;
let facade;
let projectContext;

function contextFor(root) {
    return {
        getAllowedDirectories: () => [root],
        validatePath: async (value) => value,
    };
}

function declarationsOf(result) {
    expect(result.status).toBeOneOf(['complete', 'partial']);
    const section = result.data.sections.find((candidate) => candidate.section === 'declarations');
    expect(section).toBeDefined();
    expect(section.status).toBe('complete');
    return section.facts;
}

function referencesOf(result) {
    expect(result.status).toBeOneOf(['complete', 'partial']);
    const section = result.data.sections.find((candidate) => candidate.section === 'references');
    expect(section).toBeDefined();
    expect(section.status).toBe('complete');
    return section.facts;
}

async function openProject(root, freshness) {
    const ctx = contextFor(root);
    projectContext.getProjectContext(ctx).reloadRegistry([{
        project_id: 'independent-unicode',
        project_name: 'independent-unicode',
        project_root: root,
    }]);
    const opened = await facade.openAstSession(ctx, {
        anchor: path.join(root, 'src', 'subject.ts'),
        domain: { kind: 'project' },
        freshness,
    });
    expect(opened.status).toBe('opened');
    expect(opened.session.basis.scopeMode).toBe('project');
    return opened.session;
}

function publicOccurrenceShape(fact) {
    return {
        path: fact.path,
        role: fact.role,
        name: fact.name,
        qualifiedName: fact.qualifiedName,
        kind: fact.kind,
        namespace: fact.namespace,
        range: fact.range,
        owner: fact.owner,
        ownerSource: fact.ownerSource,
        evidence: fact.evidence,
        tainted: fact.tainted,
        stableKey: fact.handle.stableKey,
    };
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-independent-unicode-'));
    for (const key of HOME_KEYS) process.env[key] = fakeHome;
    vi.resetModules();
    facade = await import('../dist/core/intelligence/ast-intelligence.js');
    projectContext = await import('../dist/core/project-context.js');
});

afterEach(() => {
    try { projectContext.closeGlobalDb(); } catch { /* isolated cleanup */ }
    try { projectContext.resetProjectContext(); } catch { /* isolated cleanup */ }
    for (const [key, value] of SAVED_HOME) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* isolated cleanup */ }
});

describe('independent UTF-16 and content-addressed oracles', () => {
    it('projects declaration and reference columns as UTF-16 code units across every adversarial prefix class', async () => {
        const root = fs.mkdtempSync(path.join(fakeHome, 'project-'));
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'subject.ts'), 'export function diskOnly() { return 0; }\n');

        const prefixes = [
            ['ascii', 'plain'],
            ['bmp-multibyte', 'é'],
            ['private-use-low', ''],
            ['private-use-high', '￿'],
            ['supplementary-emoji', '😀'],
            ['supplementary-symbol', '𝌆'],
            ['lone-surrogate', '\ud800'],
        ];
        const lines = prefixes.map(([label, prefix], index) =>
            `const marker${index} = "${prefix}"; export function target${index}() { return target${index}(); } // ${label}`);
        const source = `${lines.join('\r\n')}\r\n`;

        const session = await openProject(root, {
            mode: 'content',
            files: [{ path: 'src/subject.ts', content: source }],
        });
        const result = await session.fileModel('src/subject.ts', {
            sections: ['declarations', 'references'],
        });
        const declarations = declarationsOf(result);
        const references = referencesOf(result);

        let provedByteOracleWouldFail = false;
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const name = `target${index}`;
            const first = line.indexOf(name);
            const second = line.indexOf(name, first + name.length);
            expect(first).toBeGreaterThanOrEqual(0);
            expect(second).toBeGreaterThan(first);

            const declaration = declarations.find((fact) => fact.name === name);
            const reference = references.find((fact) => fact.name === name && fact.range.startColumn === second);
            expect(declaration, `declaration ${name}`).toBeDefined();
            expect(reference, `reference ${name}`).toBeDefined();
            expect(declaration.range).toEqual({
                precision: 'line', startLine: index + 1, startColumn: first, endLine: index + 1,
            });
            expect(reference.range.startLine).toBe(index + 1);
            expect(reference.range.startColumn).toBe(second);

            const declarationByteColumn = Buffer.byteLength(line.slice(0, first), 'utf8');
            const referenceByteColumn = Buffer.byteLength(line.slice(0, second), 'utf8');
            if (declarationByteColumn !== first || referenceByteColumn !== second) {
                provedByteOracleWouldFail = true;
            }
        }
        // Anti-vacuity control: at least one adversarial prefix MUST make the
        // old UTF-8-byte interpretation disagree with the asserted oracle.
        expect(provedByteOracleWouldFail).toBe(true);
        session.close();
    });

    it('content-mode ingestion equals a clean disk ingestion of the identical bytes', async () => {
        const root = fs.mkdtempSync(path.join(fakeHome, 'project-'));
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        const diskSource = 'export function diskOnly() { return 0; }\n';
        const suppliedSource = [
            'const marker = "é￿😀𝌆\ud800";',
            'export function suppliedOnly(value: number): number {',
            '    return suppliedOnly(value - 1);',
            '}',
            '',
        ].join('\n');
        const subject = path.join(root, 'src', 'subject.ts');
        fs.writeFileSync(subject, diskSource);

        const diskBefore = await openProject(root, { mode: 'disk' });
        const beforeResult = await diskBefore.fileModel('src/subject.ts', { sections: ['declarations', 'references'] });
        expect(declarationsOf(beforeResult).map((fact) => fact.name)).toContain('diskOnly');
        diskBefore.close();

        const contentSession = await openProject(root, {
            mode: 'content',
            files: [{ path: 'src/subject.ts', content: suppliedSource }],
        });
        const contentResult = await contentSession.fileModel('src/subject.ts', {
            sections: ['declarations', 'references'],
        });
        const contentProjection = [
            ...declarationsOf(contentResult),
            ...referencesOf(contentResult),
        ].map(publicOccurrenceShape);
        expect(contentProjection.some((fact) => fact.name === 'suppliedOnly')).toBe(true);
        expect(contentProjection.some((fact) => fact.name === 'diskOnly')).toBe(false);
        contentSession.close();

        fs.writeFileSync(subject, suppliedSource);
        const diskAfter = await openProject(root, { mode: 'disk' });
        const diskAfterResult = await diskAfter.fileModel('src/subject.ts', {
            sections: ['declarations', 'references'],
        });
        const diskProjection = [
            ...declarationsOf(diskAfterResult),
            ...referencesOf(diskAfterResult),
        ].map(publicOccurrenceShape);
        expect(diskProjection).toEqual(contentProjection);
        diskAfter.close();
    });

    it('preserves fact identity on a no-op, changes it with source bytes, and restores it with the original content', async () => {
        const root = fs.mkdtempSync(path.join(fakeHome, 'project-'));
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        const subject = path.join(root, 'src', 'subject.ts');
        const original = 'export function stableTarget() { return 1; } // A\n';
        const changed = 'export function stableTarget() { return 1; } // B\n';
        fs.writeFileSync(subject, original);

        const keyForCurrentDisk = async () => {
            const session = await openProject(root, { mode: 'disk' });
            const result = await session.fileModel('src/subject.ts', { sections: ['declarations'] });
            const target = declarationsOf(result).find((fact) => fact.name === 'stableTarget');
            expect(target).toBeDefined();
            const key = target.handle.stableKey;
            session.close();
            return key;
        };

        const originalKey = await keyForCurrentDisk();
        const noOpKey = await keyForCurrentDisk();
        expect(noOpKey).toBe(originalKey);

        fs.writeFileSync(subject, changed);
        const changedKey = await keyForCurrentDisk();
        expect(changedKey).not.toBe(originalKey);

        fs.writeFileSync(subject, original);
        const restoredKey = await keyForCurrentDisk();
        expect(restoredKey).toBe(originalKey);
    });

    it('keeps every project-mode fileModel path scope-relative for absolute and relative questions', async () => {
        const root = fs.mkdtempSync(path.join(fakeHome, 'project-'));
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        const subject = path.join(root, 'src', 'subject.ts');
        fs.writeFileSync(subject, 'export function localTarget() { return localTarget(); }\n');

        const session = await openProject(root, { mode: 'disk' });
        const relativeResult = await session.fileModel('src/subject.ts', {
            sections: ['identity', 'declarations', 'references'],
        });
        const absoluteResult = await session.fileModel(subject, {
            sections: ['identity', 'declarations', 'references'],
        });
        expect(relativeResult.data.path).toBe('src/subject.ts');
        expect(absoluteResult.data.path).toBe('src/subject.ts');
        expect(relativeResult.data.path).not.toBe(subject); // negative leak control
        for (const fact of [...declarationsOf(relativeResult), ...referencesOf(relativeResult)]) {
            expect(fact.path).toBe('src/subject.ts');
            expect(path.isAbsolute(fact.path)).toBe(false);
            expect(fact.path.startsWith('g/')).toBe(false);
        }
        session.close();
    });
});
