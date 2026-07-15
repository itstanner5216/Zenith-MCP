import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Boundary finders are junk-filtered against os.tmpdir(), so fixtures live
// under the home directory instead of the usual tmpdir.
const FIXTURE_BASE = fs.mkdtempSync(path.join(os.homedir(), '.zenith-boundary-test-'));
const cleanupDirs = [FIXTURE_BASE];

function mkdirp(...segments) {
    const dir = path.join(FIXTURE_BASE, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function importBoundaries() {
    return await import('../dist/core/detection/boundaries.js');
}

afterAll(() => {
    for (const dir of cleanupDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

describe('findGitRoot — pure fs walk', () => {
    it('finds a .git directory root', async () => {
        const { findGitRoot } = await importBoundaries();
        const repo = mkdirp('repo-a');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        const deep = mkdirp('repo-a', 'src', 'nested');
        expect(findGitRoot(path.join(deep, 'file.ts'))).toBe(repo);
    });

    it('treats a .git FILE as a worktree root (worktree dir wins, not parent repo)', async () => {
        const { findGitRoot } = await importBoundaries();
        const parent = mkdirp('parent-repo');
        fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
        const worktree = mkdirp('parent-repo', 'wt');
        fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../.git/worktrees/wt\n');
        expect(findGitRoot(path.join(worktree, 'x.ts'))).toBe(worktree);
    });

    it('returns null when no .git exists anywhere up the chain', async () => {
        const { findGitRoot } = await importBoundaries();
        const bare = mkdirp('no-git-here', 'sub');
        // Note: FIXTURE_BASE itself has no .git; the walk may escape up to a
        // real repo only if the home dir tree has one above the fixture —
        // guard by asserting the result is not inside the fixture.
        const result = findGitRoot(path.join(bare, 'f.txt'));
        if (result !== null) {
            expect(result.startsWith(FIXTURE_BASE)).toBe(false);
        }
    });

    it('handles nonexistent paths (new-file case) via dirname', async () => {
        const { findGitRoot } = await importBoundaries();
        const repo = mkdirp('repo-newfile');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        expect(findGitRoot(path.join(repo, 'does', 'not', 'exist.ts'))).toBe(repo);
    });
});

describe('findMarkerRoot — nearest marker, exclusions, home ceiling', () => {
    it('finds nearest marker dir walking up', async () => {
        const { findMarkerRoot } = await importBoundaries();
        const proj = mkdirp('marker-proj');
        fs.writeFileSync(path.join(proj, 'pyproject.toml'), '');
        const deep = mkdirp('marker-proj', 'src', 'pkg');
        expect(findMarkerRoot(path.join(deep, 'm.py'))).toBe(proj);
    });

    it('skips excluded dirs (node_modules) as marker candidates', async () => {
        const { findMarkerRoot } = await importBoundaries();
        const proj = mkdirp('excl-proj');
        fs.writeFileSync(path.join(proj, 'package.json'), '{}');
        const nm = mkdirp('excl-proj', 'node_modules', 'dep');
        fs.writeFileSync(path.join(nm, 'package.json'), '{}');
        // nm/dep is not excluded by basename, but its package.json makes it a
        // candidate — the walk from inside node_modules/dep returns dep itself
        // (nearest marker NOT under an excluded basename). One level up,
        // node_modules IS excluded, so from a file directly in node_modules
        // the project root wins.
        const fromNodeModulesFile = findMarkerRoot(path.join(proj, 'node_modules', 'f.js'));
        expect(fromNodeModulesFile).toBe(proj);
    });

    it('never returns the home directory even if home has a marker', async () => {
        const { findMarkerRoot } = await importBoundaries();
        // A bare dir directly under the fixture with no marker of its own:
        // the walk stops at home, never returning home itself.
        const bare = mkdirp('bare-no-marker');
        const result = findMarkerRoot(path.join(bare, 'f.txt'));
        if (result !== null) {
            expect(result).not.toBe(path.resolve(os.homedir()));
        }
    });
});

describe('isJunkRoot', () => {
    it('rejects filesystem root, home, and tmp', async () => {
        const { isJunkRoot } = await importBoundaries();
        expect(isJunkRoot('/')).toBe(true);
        expect(isJunkRoot(os.homedir())).toBe(true);
        expect(isJunkRoot(os.tmpdir())).toBe(true);
        expect(isJunkRoot(path.join(os.tmpdir(), 'proj'))).toBe(true);
    });

    it('accepts ordinary project dirs under home', async () => {
        const { isJunkRoot } = await importBoundaries();
        expect(isJunkRoot(path.join(os.homedir(), 'Projects', 'x'))).toBe(false);
        expect(isJunkRoot(FIXTURE_BASE)).toBe(false);
    });
});

describe('clampToAllowed — audit direction fixes', () => {
    it('keeps candidate already inside an allowed dir (no over-clamp)', async () => {
        const { clampToAllowed } = await importBoundaries();
        const repo = mkdirp('clamp-repo');
        const pkg = mkdirp('clamp-repo', 'packages', 'x');
        // both repo and pkg allowed; candidate = repo must survive
        expect(clampToAllowed(repo, path.join(pkg, 'f.ts'), [repo, pkg])).toBe(repo);
    });

    it('clamps a candidate that escaped ABOVE the allowed dir down to it', async () => {
        const { clampToAllowed } = await importBoundaries();
        const outer = mkdirp('clamp-outer');
        const inner = mkdirp('clamp-outer', 'granted');
        expect(clampToAllowed(outer, path.join(inner, 'f.ts'), [inner])).toBe(inner);
    });

    it('does not reject paths outside allowed dirs (fix-plan Issue 4)', async () => {
        const { clampToAllowed } = await importBoundaries();
        const somewhere = mkdirp('clamp-elsewhere');
        const unrelated = mkdirp('clamp-unrelated');
        expect(clampToAllowed(somewhere, path.join(somewhere, 'f.ts'), [unrelated]))
            .toBe(somewhere);
    });
});

describe('findProjectBoundary — ladder, junk filter, generation cache', () => {
    beforeEach(async () => {
        const { clearBoundaryCache } = await importBoundaries();
        clearBoundaryCache();
    });

    it('git outranks deeper markers (monorepo does not fragment)', async () => {
        const { findProjectBoundary } = await importBoundaries();
        const repo = mkdirp('mono-repo');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'package.json'), '{}');
        const sub = mkdirp('mono-repo', 'packages', 'app');
        fs.writeFileSync(path.join(sub, 'package.json'), '{}');
        const result = findProjectBoundary(path.join(sub, 'index.ts'), { noCache: true });
        expect(result).toEqual({ root: repo, method: 'git' });
    });

    it('falls back to markers when no git root exists in the fixture', async () => {
        const { findProjectBoundary, findGitRoot } = await importBoundaries();
        const proj = mkdirp('plain-marker-proj');
        fs.writeFileSync(path.join(proj, 'go.mod'), 'module x');
        const result = findProjectBoundary(path.join(proj, 'main.go'), { noCache: true });
        // If the fixture tree sits inside a real repo (home checkout), git wins
        // legitimately; otherwise the marker result must be exact.
        if (findGitRoot(proj) === null) {
            expect(result).toEqual({ root: proj, method: 'marker' });
        } else {
            expect(result).not.toBeNull();
        }
    });

    it('junk-filters git repos under tmp', async () => {
        const { findProjectBoundary } = await importBoundaries();
        const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-repo-'));
        cleanupDirs.push(tmpRepo);
        fs.mkdirSync(path.join(tmpRepo, '.git'), { recursive: true });
        expect(findProjectBoundary(path.join(tmpRepo, 'f.ts'), { noCache: true })).toBeNull();
    });

    it('generation bump invalidates cached results', async () => {
        const { findProjectBoundary } = await importBoundaries();
        const repo = mkdirp('gen-repo');
        const file = path.join(repo, 'f.ts');
        // gen 1: no .git yet — cached null
        expect(findProjectBoundary(file, { generation: 1 })).toBeNull();
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        // same generation: stale cached null is expected (documented behavior)
        expect(findProjectBoundary(file, { generation: 1 })).toBeNull();
        // bumped generation: fresh walk sees the repo
        expect(findProjectBoundary(file, { generation: 2 }))
            .toEqual({ root: repo, method: 'git' });
    });
});
