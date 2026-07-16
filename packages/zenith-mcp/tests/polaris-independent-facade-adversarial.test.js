import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const SAVED_HOME = new Map(HOME_KEYS.map((key) => [key, process.env[key]]));

let fakeHome;
let scratch;
let sessionModule;
let projectContext;

function write(root, relative, content) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
    return absolute;
}

function section(model, name) {
    const matches = model.sections.filter((candidate) => candidate.section === name);
    expect(matches, `exactly one ${name} section`).toHaveLength(1);
    return matches[0];
}

function relationKeys(model) {
    const relations = section(model, 'relations').facts;
    return [
        ...relations.explicit.map((relation) => JSON.stringify([
            'explicit', relation.kind, relation.source.stableKey,
            relation.target.stableKey,
        ])),
        ...relations.frontier.map((frontier) => JSON.stringify([
            'frontier', frontier.source.handle.stableKey, frontier.referencedName,
            frontier.referenceKind, frontier.count,
        ])),
    ].sort();
}

async function open(root, ctx, registerProject = false) {
    if (registerProject) {
        projectContext.getProjectContext(ctx).reloadRegistry([{
            project_id: 'independent-facade',
            project_name: 'independent-facade',
            project_root: root,
        }]);
    }
    return sessionModule.openAstSessionWithDeps(ctx, {
        anchor: path.join(root, 'src', 'main.ts'),
        domain: { kind: 'project' },
        freshness: { mode: 'disk' },
    });
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-independent-home-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-independent-facade-'));
    for (const key of HOME_KEYS) process.env[key] = fakeHome;
    vi.resetModules();
    sessionModule = await import('../dist/core/intelligence/session.js');
    projectContext = await import('../dist/core/project-context.js');
});

afterEach(() => {
    try { projectContext?.closeGlobalDb(); } catch { /* isolated cleanup */ }
    try { projectContext?.resetProjectContext(); } catch { /* isolated cleanup */ }
    for (const key of HOME_KEYS) {
        const value = SAVED_HOME.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* isolated cleanup */ }
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* isolated cleanup */ }
});

describe('independent facade boundary oracles', () => {
    it('decodes global storage keys to allowed-root-relative public paths', async () => {
        const root = path.join(scratch, 'allowed');
        const source = write(root, 'src/main.ts',
            'export function publicPathTarget() { return publicPathTarget(); }\n');
        const ctx = {
            getAllowedDirectories: () => [root],
            validatePath: async (candidate) => candidate,
        };
        const opened = await open(root, ctx);
        expect(opened.status).toBe('opened');
        if (opened.status !== 'opened') return;
        expect(opened.session.basis.scopeMode).toBe('global');

        const result = await opened.session.fileModel(source, {
            sections: ['identity', 'declarations', 'references'],
        });
        expect(result.status).toBe('complete');
        if (result.status !== 'complete' && result.status !== 'partial') return;

        const expected = path.relative(root, source).split(path.sep).join('/');
        expect(expected).toBe('src/main.ts');
        expect(path.isAbsolute(expected)).toBe(false);
        expect(result.data.path).toBe(expected);
        expect(section(result.data, 'identity').facts.path).toBe(expected);
        for (const fact of [
            ...section(result.data, 'declarations').facts,
            ...section(result.data, 'references').facts,
        ]) {
            expect(fact.path).toBe(expected);
        }
        opened.session.close();
    });

    it('paginates relation facts exactly once with the array-shaped fact stream', async () => {
        const root = path.join(scratch, 'paged');
        write(root, 'src/main.ts', [
            'export class Outer {',
            '    method() { return helper(); }',
            '}',
            'export function helper() { return 1; }',
            'export function caller() { return missingName(); }',
            '',
        ].join('\n'));
        const ctx = {
            getAllowedDirectories: () => [root],
            validatePath: async (candidate) => candidate,
        };
        const opened = await open(root, ctx, true);
        expect(opened.status).toBe('opened');
        if (opened.status !== 'opened') return;

        const question = { sections: ['declarations', 'relations'], page: { limit: 100 } };
        const oneShot = await opened.session.fileModel('src/main.ts', question);
        expect(['complete', 'partial']).toContain(oneShot.status);
        if (oneShot.status !== 'complete' && oneShot.status !== 'partial') return;
        const expectedRelations = relationKeys(oneShot.data);
        expect(expectedRelations.length).toBeGreaterThan(0);

        const collectedRelations = [];
        const collectedDeclarations = [];
        let after;
        let pages = 0;
        do {
            const page = await opened.session.fileModel('src/main.ts', {
                sections: ['declarations', 'relations'],
                page: after === undefined ? { limit: 1 } : { limit: 1, after },
            });
            expect(['complete', 'partial']).toContain(page.status);
            if (page.status !== 'complete' && page.status !== 'partial') return;
            pages += 1;
            expect(pages).toBeLessThan(20);
            collectedDeclarations.push(...section(page.data, 'declarations').facts
                .map((fact) => fact.handle.stableKey));
            collectedRelations.push(...relationKeys(page.data));
            after = page.data.page.next ?? undefined;
        } while (after !== undefined);

        expect(pages).toBeGreaterThan(1);
        const oneShotDeclarations = section(oneShot.data, 'declarations').facts
            .map((fact) => fact.handle.stableKey);
        expect(collectedDeclarations).toEqual(oneShotDeclarations);
        expect(collectedRelations).toEqual(expectedRelations);

        // Mutation control: replaying whole object sections per page creates
        // duplicates and cannot satisfy the exact-once keyset oracle.
        expect([...expectedRelations, ...expectedRelations]).not.toEqual(expectedRelations);
        opened.session.close();
    });

    it('enforces realpath validation before a symlink can import outside bytes', async () => {
        const root = path.join(scratch, 'symlink-root');
        const outside = path.join(scratch, 'outside');
        fs.mkdirSync(root, { recursive: true });
        const secret = write(outside, 'secret.ts',
            'export function outsideSecret() { return 8675309; }\n');
        const link = path.join(root, 'linked.ts');
        fs.symlinkSync(secret, link);
        const realRoot = fs.realpathSync(root);
        let validationCalls = 0;
        const ctx = {
            getAllowedDirectories: () => [root],
            validatePath: async (candidate) => {
                validationCalls += 1;
                const real = await fs.promises.realpath(candidate);
                if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
                    throw new Error('outside allowed root');
                }
                return real;
            },
        };

        await expect(ctx.validatePath(link)).rejects.toThrow('outside allowed root');
        validationCalls = 0;
        const opened = await sessionModule.openAstSessionWithDeps(ctx, {
            anchor: link,
            domain: { kind: 'file', path: link },
            freshness: { mode: 'disk' },
        });

        let leakedOutsideBytes = false;
        if (opened.status === 'opened') {
            const model = await opened.session.fileModel(link, { sections: ['declarations'] });
            if (model.status === 'complete' || model.status === 'partial') {
                leakedOutsideBytes = section(model.data, 'declarations').facts
                    .some((fact) => fact.name === 'outsideSecret');
            }
            opened.session.close();
        }
        expect({
            validatorUsed: validationCalls > 0,
            outsideBytesHidden: !leakedOutsideBytes,
            refused: opened.status === 'failed',
        }).toEqual({ validatorUsed: true, outsideBytesHidden: true, refused: true });
    });
});
