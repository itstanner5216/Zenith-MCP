// polaris-independent-walk-coverage.test.js
//
// Independent-oracle audit of the POLARIS Task 2.1 domain walk (plan Decision 6:
// ordinary ignorance — an incomplete directory read — is a TYPED ANSWER, never
// a silently shrunken domain). A directory made unreadable (chmod 000) is the
// fault injector; the same project with permissions restored is the control.
//
// The test asserts BOTH sides of the metamorphic pair so a mutation that always
// (or never) reports 'incomplete_walk' cannot pass, and it fails the readdir as
// an explicit precondition so it can never be vacuously green.

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

async function openProjectAnchored(ctx, root, anchor) {
    registerProject(ctx, root);
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor,
        domain: { kind: 'project' },
        freshness: { mode: 'disk' },
    });
    if (result.status === 'opened') liveSessions.push(result.session);
    return result;
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-walk-coverage-'));
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

describe('independent domain-walk coverage oracle', () => {
    // chmod 000 is a no-op for root, which would make the precondition vacuous.
    it.skipIf((process.getuid?.() ?? 0) === 0)(
        'surfaces incomplete_walk when a subdirectory read fails, and clears it when readable',
        async () => {
            const root = fs.mkdtempSync(path.join(fakeHome, 'project-'));
            fs.writeFileSync(path.join(root, 'main.ts'),
                'export function reachable(): number { return 1; }\n');
            const locked = path.join(root, 'locked');
            fs.mkdirSync(locked);
            fs.writeFileSync(path.join(locked, 'secret.ts'),
                'export function hidden(): number { return 2; }\n');
            const ctx = mkCtx(root);
            const anchor = path.join(root, 'main.ts');

            fs.chmodSync(locked, 0o000);
            try {
                // Precondition: the subdirectory really is unreadable, so a
                // green result reflects the guard and not a lucky no-op.
                expect(() => fs.readdirSync(locked)).toThrow();

                const blocked = await openProjectAnchored(ctx, root, anchor);
                expect(blocked.status).toBe('opened');
                if (blocked.status !== 'opened') return;
                // Fault side: the unreadable subtree is reported, not swallowed.
                expect(blocked.session.basis.coverage).toContain('incomplete_walk');
            } finally {
                fs.chmodSync(locked, 0o755);
            }

            // Control side: with the subtree readable, the identical open reports
            // a complete walk (no incomplete_walk coverage).
            const clear = await openProjectAnchored(ctx, root, anchor);
            expect(clear.status).toBe('opened');
            if (clear.status !== 'opened') return;
            expect(clear.session.basis.coverage).not.toContain('incomplete_walk');
        },
    );
});
