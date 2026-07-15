import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Regression pins for the 2026-07-14 adversarial review findings.
// Each test names the finding it guards. If one of these fails, someone has
// reintroduced a defect that was already caught once — read the finding.
// ---------------------------------------------------------------------------

const FIXTURE_BASE = fs.mkdtempSync(path.join(os.homedir(), '.zenith-review-reg-'));

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
    const bMod = await import('../dist/core/detection/boundaries.js');
    return { ...pcMod, ...bMod };
}

let ProjectContext, clearBoundaryCache, findProjectBoundary;

beforeEach(async () => {
    vi.resetModules();
    const mod = await importAll();
    ProjectContext = mod.ProjectContext;
    clearBoundaryCache = mod.clearBoundaryCache;
    findProjectBoundary = mod.findProjectBoundary;
    clearBoundaryCache();
});

describe('P1-1: explicit bindings are sticky against REGISTRY switches too', () => {
    it('a registered project touched after initProject does not steal the binding', () => {
        const repoA = mkGitRepo('p11-a');
        const repoB = mkGitRepo('p11-b');
        const pc = new ProjectContext(mkCtx([repoA, repoB]));
        pc.reloadRegistry([
            { project_id: 'B', project_name: 'B', project_root: repoB },
        ]);
        pc.initProject(repoA);
        // Path evidence inside registered project B — must NOT displace explicit A
        pc.getRoot(path.join(repoB, 'f.ts'));
        expect(pc.getRoot()).toBe(path.resolve(repoA));
        expect(pc.bindingTier).toBe('explicit');
    });
});

describe('P1-2: boundary cache keys on the FULL path — sibling dirs never collide', () => {
    it('a cached null for /base/a does not shadow the repo at /base/b', () => {
        const base = path.join(FIXTURE_BASE, 'p12');
        const plain = path.join(base, 'a');
        const repo = path.join(base, 'b');
        fs.mkdirSync(plain, { recursive: true });
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

        const optsWithGen = { generation: 7, cacheSalt: 'p12' };
        const first = findProjectBoundary(plain, optsWithGen);   // caches for 'a'
        const second = findProjectBoundary(repo, optsWithGen);   // must NOT hit 'a' entry
        // 'a' has no repo of its own; whatever it resolves to, 'b' must
        // resolve to itself via git.
        expect(second).toEqual({ root: repo, method: 'git' });
        if (first) expect(first.root).not.toBe(repo);
    });
});

describe('P2-3: per-instance cache salt isolates sessions', () => {
    it('same generation, different allowed dirs, no cross-poisoning of clamps', () => {
        const outer = mkGitRepo('p23-outer');
        const inner = path.join(outer, 'granted');
        fs.mkdirSync(inner, { recursive: true });

        // Session 1: inner granted → git root clamps DOWN to inner
        const clamped = findProjectBoundary(path.join(inner, 'f.ts'), {
            generation: 0, cacheSalt: 'session1', allowedDirectories: [inner],
        });
        expect(clamped).toEqual({ root: inner, method: 'git' });

        // Session 2: same generation, NO allowed dirs → must see the true root,
        // not session 1's clamped result
        const unclamped = findProjectBoundary(path.join(inner, 'f.ts'), {
            generation: 0, cacheSalt: 'session2', allowedDirectories: [],
        });
        expect(unclamped).toEqual({ root: outer, method: 'git' });
    });
});

describe('P2-4: absence of evidence never demotes an affirmative binding', () => {
    it('a stray evidence-less file access leaves a registry binding intact', () => {
        const repo = mkGitRepo('p24-repo');
        const strayDir = path.join(FIXTURE_BASE, 'p24-stray');
        fs.mkdirSync(strayDir, { recursive: true });
        const pc = new ProjectContext(mkCtx([repo, strayDir]));
        pc.reloadRegistry([
            { project_id: 'pinned', project_name: 'pinned', project_root: repo },
        ]);
        pc.getRoot(path.join(repo, 'f.ts'));
        expect(pc.bindingTier).toBe('registry');

        // Stray access: plain dir, no git, no markers (walk stops at home)
        pc.getRoot(path.join(strayDir, 'notes.txt'));
        expect(pc.bindingTier).toBe('registry');
        expect(pc.isGlobal).toBe(false);
    });

    it('an unresolved session still settles to global on evidence-less access', () => {
        const strayDir = path.join(FIXTURE_BASE, 'p24-stray2');
        fs.mkdirSync(strayDir, { recursive: true });
        const pc = new ProjectContext(mkCtx([]));
        pc.getRoot(path.join(strayDir, 'notes.txt'));
        expect(pc.isGlobal).toBe(true);
    });
});

describe('P2-8: a registered project nested in a detected root wins on its paths', () => {
    it('registry outranks detected even inside the fast path', () => {
        const repo = mkGitRepo('p28-mono');
        const sub = path.join(repo, 'packages', 'x');
        fs.mkdirSync(sub, { recursive: true });
        const pc = new ProjectContext(mkCtx([repo]));

        // Bind detected to the monorepo root
        pc.getRoot(path.join(repo, 'README.md'));
        expect(pc.bindingTier).toBe('detected');
        expect(pc.getRoot()).toBe(repo);

        // Register the subpackage, then touch a path inside it
        pc.reloadRegistry([
            { project_id: 'x', project_name: 'x', project_root: sub },
        ]);
        pc.getRoot(path.join(sub, 'src', 'f.ts'));
        expect(pc.bindingTier).toBe('registry');
        expect(pc.getRoot()).toBe(fs.realpathSync(sub));
    });
});

describe('P2-5: macOS-style realpath tmp is junk', () => {
    it('/private/tmp paths are filtered', async () => {
        const { isJunkRoot } = await importAll();
        expect(isJunkRoot('/private/tmp/scratch')).toBe(true);
        expect(isJunkRoot('/private/tmp')).toBe(true);
    });
});
