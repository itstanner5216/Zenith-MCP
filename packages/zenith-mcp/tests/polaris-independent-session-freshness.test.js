// polaris-independent-session-freshness.test.js
//
// Independent-oracle audit of the POLARIS Task 2.1 session boundary.  These
// tests deliberately avoid deriving expected values from session helpers:
//
//   - hand-authored source fixtures are the oracle for persisted declarations;
//   - raw SQL is the independent read path for partial-ingestion state;
//   - filesystem creation-order permutations are the metamorphic oracle for
//     canonical domain identity;
//   - commit versus rollback is the control pair for fact-epoch invalidation;
//   - emitter-session acceptance is the positive control for cursor rejection;
//   - a healthy v4 project is the positive control for FUTURE_SCHEMA refusal.
//
// Each test contains an explicit positive/negative control so a plausible
// mutation cannot leave it vacuously green.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const SAVED_HOME = HOME_KEYS.map((key) => [key, process.env[key]]);

let fakeHome;
let mods;
const liveSessions = [];

async function importFresh() {
    vi.resetModules();
    return {
        session: await import('../dist/core/intelligence/session.js'),
        pc: await import('../dist/core/project-context.js'),
        db: await import('../dist/core/db-adapter.js'),
        si: await import('../dist/core/symbol-index.js'),
    };
}

function mkCtx(root) {
    return {
        getAllowedDirectories: () => [root],
        validatePath: async (candidate) => candidate,
    };
}

function registerProject(ctx, root) {
    mods.pc.getProjectContext(ctx).reloadRegistry([{
        project_id: `independent-${path.basename(root)}`,
        project_name: path.basename(root),
        project_root: root,
    }]);
}

function makeProject(files, creationOrder = Object.keys(files)) {
    const root = fs.mkdtempSync(path.join(fakeHome, 'project-'));
    for (const relative of creationOrder) {
        const content = files[relative];
        if (content === undefined) throw new Error(`missing fixture content for ${relative}`);
        const absolute = path.join(root, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
    }
    return root;
}

async function openProject(root, freshness = { mode: 'disk' }, deps = {}, existingCtx) {
    const ctx = existingCtx ?? mkCtx(root);
    registerProject(ctx, root);
    const firstSource = findFirstSource(root);
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor: firstSource,
        domain: { kind: 'project' },
        freshness,
    }, deps);
    if (result.status === 'opened') liveSessions.push(result.session);
    return { ctx, result };
}

function findFirstSource(root) {
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.shift();
        if (current === undefined) break;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name === '.mcp') continue;
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) pending.push(absolute);
            else if (/\.(?:ts|js|py|go|rs|java)$/.test(entry.name)) return absolute;
        }
    }
    throw new Error(`fixture has no supported source under ${root}`);
}

function expectOpened(result) {
    expect(result.status).toBe('opened');
    if (result.status !== 'opened') throw new Error(result.failure.detail);
    return result.session;
}

function section(model, sectionName) {
    const matches = model.sections.filter((entry) => entry.section === sectionName);
    expect(matches).toHaveLength(1);
    return matches[0];
}

async function declarationNames(session, relativePath) {
    const result = await session.fileModel(relativePath, { sections: ['declarations'] });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete' && result.status !== 'partial') return [];
    return section(result.data, 'declarations').facts.map((fact) => fact.name);
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-independent-session-'));
    for (const key of HOME_KEYS) process.env[key] = fakeHome;
    mods = await importFresh();
});

afterEach(() => {
    for (const session of liveSessions.splice(0)) {
        try { session.close(); } catch { /* already closed */ }
    }
    try { mods.pc.closeGlobalDb(); } catch { /* not opened */ }
    try { mods.pc.resetProjectContext(); } catch { /* not initialized */ }
    for (const [key, value] of SAVED_HOME) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('independent session factory and freshness oracles', () => {
    it('canonical source-domain identity ignores filesystem creation order but changes with source bytes', async () => {
        const baseline = {
            'src/a.ts': 'export function alpha(): number { return 1; }\n',
            'src/z.ts': 'export function zeta(): number { return 2; }\n',
            'notes.txt': 'unsupported member\n',
        };
        const changed = {
            ...baseline,
            'src/a.ts': 'export function alpha(): number { return 99; }\n',
        };

        const rootForward = makeProject(baseline, ['src/a.ts', 'src/z.ts', 'notes.txt']);
        const rootReverse = makeProject(baseline, ['notes.txt', 'src/z.ts', 'src/a.ts']);
        const rootMutation = makeProject(changed, ['src/z.ts', 'notes.txt', 'src/a.ts']);

        const forward = expectOpened((await openProject(rootForward)).result);
        const reverse = expectOpened((await openProject(rootReverse)).result);
        const mutation = expectOpened((await openProject(rootMutation)).result);

        // Positive control: same member set and bytes, despite opposite
        // directory insertion order, has one canonical identity.
        expect(reverse.basis.sourceDomain).toMatchObject({
            digest: forward.basis.sourceDomain.digest,
            fileCount: forward.basis.sourceDomain.fileCount,
        });

        // Negative control: one hand-authored byte change must move identity.
        expect(mutation.basis.sourceDomain.digest)
            .not.toBe(forward.basis.sourceDomain.digest);

        // The factory materializes its project store before enumeration; its
        // own .mcp database artifacts are not caller source-domain members.
        expect(
            forward.basis.sourceDomain.fileCount,
            'source-domain membership must exclude the factory\'s own .mcp artifacts',
        ).toBe(Object.keys(baseline).length);
    });

    it('content mode persists the exact in-hand program while leaving disk bytes untouched', async () => {
        const disk = 'export function diskOnly(): number { return 1; }\n';
        const inHand = 'export function memoryOnly(): number { return 2; }\n';
        const root = makeProject({ 'src/target.ts': disk });
        const target = path.join(root, 'src', 'target.ts');

        const opened = await openProject(root, {
            mode: 'content',
            files: [{ path: target, content: inHand }],
        });
        const session = expectOpened(opened.result);
        const model = await session.fileModel('src/target.ts', {
            sections: ['identity', 'declarations'],
        });
        expect(model.status).toBe('complete');
        if (model.status !== 'complete' && model.status !== 'partial') return;

        const names = section(model.data, 'declarations').facts.map((fact) => fact.name);
        const identity = section(model.data, 'identity').facts;

        // Positive oracle: the only declaration in the in-hand fixture exists
        // and its v4 source hash equals an independent Node crypto digest.
        expect(names).toContain('memoryOnly');
        expect(identity.sourceHash)
            .toBe(crypto.createHash('md5').update(inHand).digest('hex'));

        // Negative controls: disk-only facts did not leak through, and the
        // write-through fact transition did not overwrite the source file.
        expect(names).not.toContain('diskOnly');
        expect(fs.readFileSync(target, 'utf8')).toBe(disk);
        expect(session.basis.sourceDomain.contentFileCount).toBe(1);
        expect(session.basis.sourceDomain.contentDigest).not.toBeNull();
    });

    it('content-domain identity is a set-order invariant and remains content-sensitive', async () => {
        const root = makeProject({
            'a.ts': 'export function diskA(): number { return 1; }\n',
            'b.ts': 'export function diskB(): number { return 2; }\n',
        });
        const ctx = mkCtx(root);
        const a = path.join(root, 'a.ts');
        const b = path.join(root, 'b.ts');
        const contentA = 'export function contentA(): number { return 10; }\n';
        const contentB = 'export function contentB(): number { return 20; }\n';

        const reversed = expectOpened((await openProject(root, {
            mode: 'content',
            files: [{ path: b, content: contentB }, { path: a, content: contentA }],
        }, {}, ctx)).result);
        const canonical = expectOpened((await openProject(root, {
            mode: 'content',
            files: [{ path: a, content: contentA }, { path: b, content: contentB }],
        }, {}, ctx)).result);
        const mutation = expectOpened((await openProject(root, {
            mode: 'content',
            files: [{ path: a, content: contentA }, {
                path: b,
                content: 'export function changedB(): number { return 21; }\n',
            }],
        }, {}, ctx)).result);

        // Positive control: request permutation cannot alter a content-domain
        // identity. Both entries are counted exactly once.
        expect(reversed.basis.sourceDomain.contentDigest)
            .toBe(canonical.basis.sourceDomain.contentDigest);
        expect(canonical.basis.sourceDomain.contentFileCount).toBe(2);

        // Negative control: changing one member's exact bytes must move it.
        expect(mutation.basis.sourceDomain.contentDigest)
            .not.toBe(canonical.basis.sourceDomain.contentDigest);
    });

    it('a later content-ingestion failure preserves earlier live facts without committing the failed file', async () => {
        const oldA = 'export function oldAlpha(): number { return 1; }\n';
        const oldB = 'export function oldBeta(): number { return 2; }\n';
        const newA = 'export function newAlpha(): number { return 10; }\n';
        const newB = 'export function newBeta(): number { return 20; }\n';
        const root = makeProject({ 'a.ts': oldA, 'b.ts': oldB });
        const ctx = mkCtx(root);

        const baseline = expectOpened((await openProject(root, { mode: 'disk' }, {}, ctx)).result);
        baseline.close();

        const conn = mods.si.getDb(root);
        mods.db.execRaw(conn, `
            CREATE TEMP TRIGGER polaris_independent_fail_beta
            BEFORE INSERT ON symbols
            WHEN NEW.file_path = 'b.ts'
            BEGIN
                SELECT RAISE(ABORT, 'POLARIS_INDEPENDENT_FAIL_BETA');
            END
        `);

        let result;
        try {
            result = (await openProject(root, {
                mode: 'content',
                files: [
                    { path: path.join(root, 'a.ts'), content: newA },
                    { path: path.join(root, 'b.ts'), content: newB },
                ],
            }, {}, ctx)).result;
        } finally {
            mods.db.execRaw(conn, 'DROP TRIGGER IF EXISTS polaris_independent_fail_beta');
        }

        expect(result.status).toBe('failed');
        if (result.status !== 'failed') return;
        expect(result.failure.code).toBe('FRESHNESS_FAILED');
        expect(result.updated).toEqual(['a.ts']);
        expect(result.failedPath).toBe('b.ts');

        // Independent raw-SQL oracle over the live store. Positive control:
        // the successfully processed file remains authoritative after the
        // failed open. Negative control: the failed file stayed at its exact
        // pre-request declaration; its attempted replacement did not commit.
        const definitions = (filePath) => mods.db.queryRaw(conn,
            "SELECT name FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY name",
            filePath).map((row) => row.name);
        expect(definitions('a.ts')).toContain('newAlpha');
        expect(definitions('a.ts')).not.toContain('oldAlpha');
        expect(definitions('b.ts')).toContain('oldBeta');
        expect(definitions('b.ts')).not.toContain('newBeta');
    });
});

describe('independent epoch, cursor, and lease controls', () => {
    it('a fact-only rollback preserves a cursor while a fact-only commit invalidates it as INPUT_CHANGED', async () => {
        const root = makeProject({
            'target.ts': [
                'export function alpha(): number { return 1; }',
                'export function beta(): number { return 2; }',
                'export function gamma(): number { return 3; }',
                '',
            ].join('\n'),
        });
        const session = expectOpened((await openProject(root)).result);
        const first = await session.fileModel('target.ts', {
            sections: ['declarations'],
            page: { limit: 1 },
        });
        expect(first.status).toBe('complete'); // payload rule: truncation carries page.next, not a partial status (import-extension 9892b58)
        if (first.status !== 'complete' && first.status !== 'partial') return;
        expect(first.data.page.next).not.toBeNull();
        const cursor = first.data.page.next;
        if (cursor === null) return;

        const conn = mods.si.getDb(root);
        expect(() => mods.db.runTransaction(conn, () => {
            mods.db.queryRaw(conn,
                "UPDATE symbols SET name = 'rolled_back_name' WHERE file_path = 'target.ts' AND kind = 'def' AND name = 'alpha'");
            throw new Error('ROLLBACK_CONTROL');
        })).toThrow('ROLLBACK_CONTROL');

        // Negative control: rollback changed neither facts nor epoch, so the
        // already-issued cursor remains valid and alpha remains persisted.
        const afterRollback = await session.fileModel('target.ts', {
            sections: ['declarations'],
            page: { limit: 1, after: cursor },
        });
        expect(afterRollback.status).not.toBe('failed');
        expect(mods.db.queryRaw(conn,
            "SELECT COUNT(*) AS n FROM symbols WHERE file_path = 'target.ts' AND kind = 'def' AND name = 'alpha'")[0].n)
            .toBe(1);

        mods.db.runTransaction(conn, () => {
            mods.db.queryRaw(conn,
                "UPDATE symbols SET name = 'committed_name' WHERE file_path = 'target.ts' AND kind = 'def' AND name = 'alpha'");
        });

        // Positive control: this write changes only a fact row, not files.hash;
        // the connection-local generation must still reject the old cursor.
        const afterCommit = await session.fileModel('target.ts', {
            sections: ['declarations'],
            page: { limit: 1, after: cursor },
        });
        expect(afterCommit.status).toBe('failed');
        if (afterCommit.status === 'failed') {
            expect(afterCommit.failure.code).toBe('INPUT_CHANGED');
            expect(afterCommit.failure.correction).toBe('reopen_session');
        }
    });

    it('a public continuation works only on its emitter even when a twin session pins the same basis', async () => {
        const root = makeProject({
            'target.ts': [
                'export function first(): number { return 1; }',
                'export function second(): number { return 2; }',
                'export function third(): number { return 3; }',
                '',
            ].join('\n'),
        });
        const ctx = mkCtx(root);
        const emitter = expectOpened((await openProject(root, { mode: 'disk' }, {}, ctx)).result);
        const twin = expectOpened((await openProject(root, { mode: 'disk' }, {}, ctx)).result);
        expect(twin.basis.sourceDomain.digest).toBe(emitter.basis.sourceDomain.digest);

        const first = await emitter.fileModel('target.ts', {
            sections: ['declarations'], page: { limit: 1 },
        });
        expect(first.status).toBe('complete'); // payload rule: truncation carries page.next, not a partial status (import-extension 9892b58)
        if (first.status !== 'complete' && first.status !== 'partial') return;
        const cursor = first.data.page.next;
        expect(cursor).not.toBeNull();
        if (cursor === null) return;

        // Positive control: the exact normalized question on the emitter
        // accepts the cursor and advances to a disjoint declaration.
        const emitterPage = await emitter.fileModel('target.ts', {
            sections: ['declarations'], page: { limit: 1, after: cursor },
        });
        expect(emitterPage.status).not.toBe('failed');
        if (emitterPage.status === 'complete' || emitterPage.status === 'partial') {
            const firstNames = section(first.data, 'declarations').facts.map((fact) => fact.name);
            const nextNames = section(emitterPage.data, 'declarations').facts.map((fact) => fact.name);
            expect(nextNames).not.toEqual(firstNames);
        }

        // Negative control: identical scope/domain/question is insufficient;
        // the twin has a different per-session MAC secret.
        const replay = await twin.fileModel('target.ts', {
            sections: ['declarations'], page: { limit: 1, after: cursor },
        });
        expect(replay.status).toBe('failed');
        if (replay.status === 'failed') {
            expect(replay.failure.code).toBe('INVALID_QUERY');
            expect(replay.failure.retryable).toBe(false);
        }
    });

    it('INVALID_QUERY does not slide the lease while a valid continuation does', async () => {
        const root = makeProject({
            'target.ts': [
                'export function one(): number { return 1; }',
                'export function two(): number { return 2; }',
                'export function three(): number { return 3; }',
                '',
            ].join('\n'),
        });
        let now = 1_000_000;
        const session = expectOpened((await openProject(root, { mode: 'disk' }, { now: () => now })).result);
        const first = await session.fileModel('target.ts', {
            sections: ['declarations'], page: { limit: 1 },
        });
        expect(first.status).toBe('complete'); // payload rule: truncation carries page.next, not a partial status (import-extension 9892b58)
        if (first.status !== 'complete' && first.status !== 'partial') return;
        const cursor = first.data.page.next;
        expect(cursor).not.toBeNull();
        if (cursor === null) return;

        const beforeFailure = session.basis.expiresAt;
        now += 20_000;
        const wrongQuestion = await session.fileModel('target.ts', {
            sections: ['declarations', 'references'],
            page: { limit: 1, after: cursor },
        });
        expect(wrongQuestion.status).toBe('failed');
        if (wrongQuestion.status === 'failed') {
            expect(wrongQuestion.failure.code).toBe('INVALID_QUERY');
        }
        // Negative control: a failed authenticated-entry attempt grants no
        // additional lease time.
        expect(session.basis.expiresAt).toBe(beforeFailure);

        now += 1_000;
        const valid = await session.fileModel('target.ts', {
            sections: ['declarations'], page: { limit: 1, after: cursor },
        });
        expect(valid.status).not.toBe('failed');
        // Positive control: the successful call slides by exactly 30 seconds.
        expect(session.basis.expiresAt).toBe(now + 30_000);
        expect(session.basis.expiresAt).toBeGreaterThan(beforeFailure);
    });
});

describe('independent typed-open failure boundary', () => {
    it('maps a future project schema to FUTURE_SCHEMA while a healthy sibling opens normally', async () => {
        const futureRoot = makeProject({
            'target.ts': 'export function futureFixture(): number { return 1; }\n',
        });
        const mcpDir = path.join(futureRoot, '.mcp');
        fs.mkdirSync(mcpDir, { recursive: true });
        const seeded = mods.db.openDb(path.join(mcpDir, 'symbols.db'));
        mods.db.execRaw(seeded, `
            CREATE TABLE schema_version (version INTEGER NOT NULL);
            INSERT INTO schema_version(version) VALUES (999)
        `);
        mods.db.closeDb(seeded);

        const failed = (await openProject(futureRoot)).result;
        expect(failed.status).toBe('failed');
        if (failed.status === 'failed') {
            expect(failed.failure).toMatchObject({
                code: 'FUTURE_SCHEMA',
                retryable: false,
                correction: 'repair_store',
            });
            expect(failed.failure.detail).toMatch(/version 999/);
            expect(failed.updated).toEqual([]);
            expect(failed.unchanged).toEqual([]);
            expect(failed.failedPath).toBeNull();
        }

        // Positive control: refusal comes from the future-version predicate,
        // not from the fixture, registration, or session factory itself.
        const healthyRoot = makeProject({
            'target.ts': 'export function healthyFixture(): number { return 1; }\n',
        });
        const healthy = (await openProject(healthyRoot)).result;
        expect(healthy.status).toBe('opened');
        if (healthy.status === 'opened') {
            expect(await declarationNames(healthy.session, 'target.ts'))
                .toContain('healthyFixture');
        }
    });
});
