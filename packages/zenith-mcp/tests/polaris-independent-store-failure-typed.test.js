// polaris-independent-store-failure-typed.test.js
//
// Independent-oracle audit of the POLARIS Task 2.1 store-failure boundary (plan
// Decision 6: an operational store failure is a TYPED answer, never a raw throw
// escaping the facade). A raw `DROP TABLE files` on the session's own connection
// is the fault injector; a healthy read on the same session is the control.
//
// Two seams are covered — query time (StructuralSession.answer) and open time
// (the pin-view transaction). Under the pre-fix code the query seam only mapped
// STORE_CORRUPT-prefixed messages and the open seam had no catch at all, so both
// assertions reject/throw rather than returning a typed failure: non-vacuous.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeProject(files) {
    const root = fs.mkdtempSync(path.join(fakeHome, 'project-'));
    for (const [relative, content] of Object.entries(files)) {
        const absolute = path.join(root, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
    }
    return root;
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-store-failure-'));
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

describe('independent typed store-failure boundary', () => {
    it('maps a query-time store fault to a typed STORE_CORRUPT instead of throwing', async () => {
        const root = makeProject({ 'main.ts': 'export function q(): number { return 1; }\n' });
        const ctx = mkCtx(root);
        registerProject(ctx, root);
        const opened = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(root, 'main.ts'),
            domain: { kind: 'project' },
            freshness: { mode: 'disk' },
        });
        expect(opened.status).toBe('opened');
        if (opened.status !== 'opened') return;
        liveSessions.push(opened.session);

        // Positive control: the query answers cleanly against the healthy store.
        const before = await opened.session.fileModel('main.ts', { sections: ['declarations'] });
        expect(before.status).toBe('complete');

        // Fault injection on the session's own connection (a same-connection
        // autocommit DDL moves neither epoch half, so revalidation proceeds into
        // the now-missing table rather than short-circuiting as INPUT_CHANGED).
        const conn = mods.si.getDb(root);
        mods.db.execRaw(conn, 'DROP TABLE files');

        // The identical query now returns a typed operational failure; it must
        // not throw out of the facade.
        const after = await opened.session.fileModel('main.ts', { sections: ['declarations'] });
        expect(after.status).toBe('failed');
        if (after.status !== 'failed') return;
        expect(after.failure.code).toBe('STORE_CORRUPT');
        expect(after.failure.correction).toBe('repair_store');
    });

    it('maps an open-time store fault to a typed STORE_CORRUPT instead of throwing', async () => {
        const root = makeProject({
            'main.ts': 'export function o(): number { return 1; }\n',
            'docs/notes.txt': 'plain text, not an indexable source\n',
        });
        const ctx = mkCtx(root);
        registerProject(ctx, root);
        const anchor = path.join(root, 'main.ts');

        // Materialize + populate the store (creates the files table).
        const warm = await mods.session.openAstSessionWithDeps(ctx, {
            anchor, domain: { kind: 'project' }, freshness: { mode: 'disk' },
        });
        expect(warm.status).toBe('opened');
        if (warm.status === 'opened') warm.session.close();

        // An unsupported-only directory domain skips the disk-freshness writes,
        // so the pin-view read is the first `files` access at open time.
        const openDocs = () => mods.session.openAstSessionWithDeps(ctx, {
            anchor,
            domain: { kind: 'directory', path: 'docs', recursive: true },
            freshness: { mode: 'disk' },
        });

        // Positive control: it opens cleanly while the store is healthy.
        const control = await openDocs();
        expect(control.status).toBe('opened');
        if (control.status === 'opened') control.session.close();

        // Fault injection, then the pin-view read hits the missing table.
        const conn = mods.si.getDb(root);
        mods.db.execRaw(conn, 'DROP TABLE files');

        const faulted = await openDocs();
        expect(faulted.status).toBe('failed');
        if (faulted.status !== 'failed') return;
        expect(faulted.failure.code).toBe('STORE_CORRUPT');
        expect(faulted.failure.correction).toBe('repair_store');
    });
});
