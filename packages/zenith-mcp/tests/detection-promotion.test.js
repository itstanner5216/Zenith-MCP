import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Promotion policy: detection is signal, promotion is consent.
//   - observations are counted per DISTINCT session in the global DB
//   - detection notifies the host with promotion instructions
//   - auto_promote_sessions (config, or ZENITH_AUTO_PROMOTE_SESSIONS env
//     override) promotes in-memory after N distinct sessions — the config
//     file is never written
// ---------------------------------------------------------------------------

const FIXTURE_BASE = fs.mkdtempSync(path.join(os.homedir(), '.zenith-promo-test-'));

afterAll(() => {
    try { fs.rmSync(FIXTURE_BASE, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkGitRepo(name) {
    const dir = path.join(FIXTURE_BASE, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
}

function mkCtx(allowedDirs = []) {
    return {
        getAllowedDirectories: () => allowedDirs,
        validatePath: async (p) => p,
    };
}

async function importAll() {
    const pcMod = await import('../dist/core/project-context.js');
    const dbMod = await import('../dist/core/db-adapter.js');
    const bMod = await import('../dist/core/detection/boundaries.js');
    return { ...pcMod, ...dbMod, ...bMod };
}

let mod;

beforeEach(async () => {
    vi.resetModules();
    mod = await importAll();
    mod.clearBoundaryCache();
    delete process.env.ZENITH_AUTO_PROMOTE_SESSIONS;
});

afterEach(() => {
    delete process.env.ZENITH_AUTO_PROMOTE_SESSIONS;
});

describe('observation counting (db-adapter)', () => {
    function memConn() {
        // in-memory db via openDb on a temp file under the fixture
        const dbPath = path.join(FIXTURE_BASE, `obs-${Math.random().toString(36).slice(2)}.db`);
        const conn = mod.openDb(dbPath);
        mod.initObservationSchema(conn);
        return conn;
    }

    it('first observation counts one session', () => {
        const conn = memConn();
        const n = mod.recordProjectObservation(conn, {
            rootPath: '/x/repo', method: 'git', sessionId: 's1',
        });
        expect(n).toBe(1);
    });

    it('repeat observations in the SAME session are idempotent', () => {
        const conn = memConn();
        mod.recordProjectObservation(conn, { rootPath: '/x/repo', method: 'git', sessionId: 's1' });
        const n = mod.recordProjectObservation(conn, { rootPath: '/x/repo', method: 'git', sessionId: 's1' });
        expect(n).toBe(1);
    });

    it('a DIFFERENT session increments the distinct-session count', () => {
        const conn = memConn();
        mod.recordProjectObservation(conn, { rootPath: '/x/repo', method: 'git', sessionId: 's1' });
        mod.recordProjectObservation(conn, { rootPath: '/x/repo', method: 'git', sessionId: 's2' });
        const n = mod.recordProjectObservation(conn, { rootPath: '/x/repo', method: 'git', sessionId: 's3' });
        expect(n).toBe(3);
    });
});

describe('notify-on-detect', () => {
    it('detection fires the host notification with promotion instructions', () => {
        const repo = mkGitRepo('notify-repo');
        const pc = new mod.ProjectContext(mkCtx([repo]));
        const messages = [];
        pc.setNotifyFn(m => messages.push(m));

        pc.getRoot(path.join(repo, 'f.ts'));

        expect(pc.bindingTier).toBe('detected');
        expect(messages.length).toBe(1);
        expect(messages[0]).toMatch(/Detected git-based project/);
        expect(messages[0]).toContain(repo);
        expect(messages[0]).toMatch(/### Projects|stashInit/);
    });

    it('notification fires once per root per session (idempotent)', () => {
        const repo = mkGitRepo('notify-once-repo');
        const pc = new mod.ProjectContext(mkCtx([repo]));
        const messages = [];
        pc.setNotifyFn(m => messages.push(m));

        pc.getRoot(path.join(repo, 'a.ts'));
        pc.getRoot(path.join(repo, 'b.ts'));
        pc.getRoot(path.join(repo, 'deep', 'c.ts'));

        expect(messages.length).toBe(1);
    });
});

describe('auto-promotion (opt-in threshold)', () => {
    it('threshold=1 promotes on first detection: registry tier + project DB enabled', () => {
        process.env.ZENITH_AUTO_PROMOTE_SESSIONS = '1';
        const repo = mkGitRepo('promo-repo');
        const pc = new mod.ProjectContext(mkCtx([repo]));
        const messages = [];
        pc.setNotifyFn(m => messages.push(m));

        pc.getRoot(path.join(repo, 'f.ts'));

        expect(pc.bindingTier).toBe('registry'); // promoted
        expect(messages[0]).toMatch(/Auto-promoted/);
        // Promotion unlocks materialization
        expect(pc.getWorkingRoot(path.join(repo, 'f.ts'))).toBe(repo);
        const { isGlobal } = pc.getStashDb(path.join(repo, 'f.ts'));
        expect(isGlobal).toBe(false);
    });

    it('threshold=0 (default) never auto-promotes', () => {
        const repo = mkGitRepo('no-promo-repo');
        const pc = new mod.ProjectContext(mkCtx([repo]));
        pc.getRoot(path.join(repo, 'f.ts'));
        expect(pc.bindingTier).toBe('detected');
        const { isGlobal } = pc.getStashDb(path.join(repo, 'f.ts'));
        expect(isGlobal).toBe(true);
    });

    it('below-threshold detection stays detected and mentions the threshold', () => {
        process.env.ZENITH_AUTO_PROMOTE_SESSIONS = '99';
        const repo = mkGitRepo('below-threshold-repo');
        const pc = new mod.ProjectContext(mkCtx([repo]));
        const messages = [];
        pc.setNotifyFn(m => messages.push(m));

        pc.getRoot(path.join(repo, 'f.ts'));

        expect(pc.bindingTier).toBe('detected');
        expect(messages[0]).toMatch(/Auto-promotes after 99 distinct sessions/);
    });
});
