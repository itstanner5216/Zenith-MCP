import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Detection ladder integration — the 2026-07-14 restoration.
// Tier precedence: explicit > registry > detected > global.
// Fixtures live under HOME because tmp is junk-filtered by design.
// ---------------------------------------------------------------------------

const FIXTURE_BASE = fs.mkdtempSync(path.join(os.homedir(), '.zenith-ctx-detect-'));

afterAll(() => {
    try { fs.rmSync(FIXTURE_BASE, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkHomeGitRepo(name) {
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
    const ptMod = await import('../dist/core/detection/process-tree.js');
    return { ...pcMod, ...bMod, ...ptMod };
}

let ProjectContext, clearBoundaryCache, clearCallerCwdCache;

beforeEach(async () => {
    vi.resetModules();
    const mod = await importAll();
    ProjectContext = mod.ProjectContext;
    clearBoundaryCache = mod.clearBoundaryCache;
    clearCallerCwdCache = mod.clearCallerCwdCache;
    clearBoundaryCache();
    clearCallerCwdCache();
});

describe('tool-call path evidence — detected tier', () => {
    it('binds an unregistered git repo in a real location via file access', () => {
        const repo = mkHomeGitRepo('detect-repo');
        const pc = new ProjectContext(mkCtx([repo]));
        const root = pc.getRoot(path.join(repo, 'src', 'index.ts'));
        expect(root).toBe(repo);
        expect(pc.isGlobal).toBe(false);
        expect(pc.bindingTier).toBe('detected');
    });

    it('registry match outranks detection for the same path', () => {
        const repo = mkHomeGitRepo('registry-beats-detect');
        const pc = new ProjectContext(mkCtx([repo]));
        pc.reloadRegistry([
            { project_id: 'reg-proj', project_name: 'reg-proj', project_root: repo },
        ]);
        const root = pc.getRoot(path.join(repo, 'file.ts'));
        expect(root).toBe(fs.realpathSync(repo));
        expect(pc.bindingTier).toBe('registry');
    });

    it('explicit binding is sticky against detection of other paths', () => {
        const home1 = mkHomeGitRepo('explicit-home');
        const other = mkHomeGitRepo('other-repo');
        const pc = new ProjectContext(mkCtx([home1, other]));
        pc.initProject(home1);
        pc.getRoot(path.join(other, 'f.ts'));
        expect(pc.getRoot()).toBe(path.resolve(home1));
        expect(pc.bindingTier).toBe('explicit');
    });

    it('plain dir with no git and no markers still falls to global — never refuses', () => {
        const bare = path.join(FIXTURE_BASE, 'bare-dir');
        fs.mkdirSync(bare, { recursive: true });
        const pc = new ProjectContext(mkCtx([bare]));
        const { db, isGlobal } = pc.getStashDb(path.join(bare, 'note.txt'));
        expect(db).toBeTruthy();      // ALWAYS a working DB
        expect(isGlobal).toBe(true);  // the global one, as designed
    });

    it('detected root routes stash to the GLOBAL DB — detection is signal, not consent', () => {
        const repo = mkHomeGitRepo('scoped-db-repo');
        const pc = new ProjectContext(mkCtx([repo]));
        const { db, isGlobal } = pc.getStashDb(path.join(repo, 'a.ts'));
        expect(db).toBeTruthy();
        expect(isGlobal).toBe(true);                     // global until promoted
        expect(pc.bindingTier).toBe('detected');          // identity still bound
        // Anti-litter: no .mcp materialized in the detected repo
        expect(fs.existsSync(path.join(repo, '.mcp'))).toBe(false);
    });

    it('REGISTERED root still gets a project-scoped stash DB', () => {
        const repo = mkHomeGitRepo('registered-db-repo');
        const pc = new ProjectContext(mkCtx([repo]));
        pc.reloadRegistry([
            { project_id: 'reg-db', project_name: 'reg-db', project_root: repo },
        ]);
        const { db, root, isGlobal } = pc.getStashDb(path.join(repo, 'a.ts'));
        expect(db).toBeTruthy();
        expect(root).toBe(fs.realpathSync(repo));
        expect(isGlobal).toBe(false);
    });
});

describe('allowed-dir detection in no-file resolution', () => {
    it('binds when a granted directory is itself a repo', () => {
        const repo = mkHomeGitRepo('granted-repo');
        const pc = new ProjectContext(mkCtx([repo]));
        expect(pc.getRoot()).toBe(repo);
        expect(pc.bindingTier).toBe('detected');
    });

    it('stays global when granted dirs are junk (tmp)', () => {
        const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-granted-'));
        fs.mkdirSync(path.join(tmpRepo, '.git'), { recursive: true });
        try {
            const pc = new ProjectContext(mkCtx([tmpRepo]));
            expect(pc.getRoot()).toBeNull();
            expect(pc.isGlobal).toBe(true);
        } finally {
            fs.rmSync(tmpRepo, { recursive: true, force: true });
        }
    });
});

describe('pingCallerEnvironment — upgrade-from-global only', () => {
    it('upgrades a global binding using the caller process tree', () => {
        // vitest's own cwd sits inside this worktree — a real git boundary —
        // so the ping must find SOMETHING (worktree root) in dev and CI alike.
        const pc = new ProjectContext(mkCtx([]));
        expect(pc.getRoot()).toBeNull(); // no dirs granted → global
        pc.pingCallerEnvironment();
        // Own cwd is a real repo in every environment this suite runs in.
        expect(pc.isGlobal).toBe(false);
        expect(['detected', 'registry']).toContain(pc.bindingTier);
    });

    it('never displaces a registry binding', () => {
        const repo = mkHomeGitRepo('ping-no-displace');
        const pc = new ProjectContext(mkCtx([repo]));
        pc.reloadRegistry([
            { project_id: 'pinned', project_name: 'pinned', project_root: repo },
        ]);
        const before = pc.getRoot(path.join(repo, 'f.ts'));
        expect(pc.bindingTier).toBe('registry');
        pc.pingCallerEnvironment();
        expect(pc.getRoot()).toBe(before);
        expect(pc.bindingTier).toBe('registry');
    });

    it('never displaces an explicit binding', () => {
        const repo = mkHomeGitRepo('ping-vs-explicit');
        const pc = new ProjectContext(mkCtx([repo]));
        pc.initProject(repo);
        pc.pingCallerEnvironment();
        expect(pc.getRoot()).toBe(path.resolve(repo));
        expect(pc.bindingTier).toBe('explicit');
    });
});

describe('registerSessionRoot — detected tier for unregistered MCP roots', () => {
    it('binds an unregistered repo offered as an MCP root', () => {
        const repo = mkHomeGitRepo('mcp-root-repo');
        const pc = new ProjectContext(mkCtx([repo]));
        pc.registerSessionRoot(repo);
        expect(pc.getRoot()).toBe(repo);
        expect(pc.bindingTier).toBe('detected');
    });
});

describe('reloadRegistry — detected bindings survive', () => {
    it('keeps a detected binding when the registry reloads empty', () => {
        const repo = mkHomeGitRepo('survive-reload');
        const pc = new ProjectContext(mkCtx([repo]));
        pc.getRoot(path.join(repo, 'f.ts'));
        expect(pc.bindingTier).toBe('detected');
        pc.reloadRegistry([]);
        expect(pc.getRoot()).toBe(repo);
        expect(pc.bindingTier).toBe('detected');
    });

    it('drops a registry binding whose project was removed (existing contract)', () => {
        const repo = mkHomeGitRepo('dropped-project');
        const pc = new ProjectContext(mkCtx([repo]));
        pc.reloadRegistry([
            { project_id: 'temp', project_name: 'temp', project_root: repo },
        ]);
        pc.getRoot(path.join(repo, 'f.ts'));
        expect(pc.bindingTier).toBe('registry');
        pc.reloadRegistry([]);
        expect(pc.isGlobal).toBe(true);
    });
});
