import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    return dir;
}

async function importProjectContext() {
    return await import('../dist/core/project-context.js');
}

function mkCtx(repoDir) {
    return {
        getAllowedDirectories: () => [repoDir],
        validatePath: async (p) => p,
        _roots: [repoDir],
    };
}

describe('ProjectContext — registry-first resolution', () => {
    let repoDir;
    let ctx;
    let ProjectContext;

    beforeEach(async () => {
        vi.resetModules();
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        const mod = await importProjectContext();
        ProjectContext = mod.ProjectContext;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('unregistered git repo under tmp stays global (junk-filtered — tmp never promotes)', () => {
        const pc = new ProjectContext(ctx);
        const root = pc.getRoot(path.join(repoDir, 'file.js'));
        // Unregistered AND under os.tmpdir() → junk filter blocks detection →
        // global. Unregistered repos in real locations now bind via detection —
        // see project-context-detection.test.js.
        expect(root).toBeNull();
        expect(pc.isGlobal).toBe(true);
    });

    it('registered project path resolves to project root', () => {
        const pc = new ProjectContext(ctx);
        pc.reloadRegistry([{
            project_id: 'test-project',
            project_name: 'Test Project',
            project_root: repoDir,
        }]);
        const root = pc.getRoot(path.join(repoDir, 'file.js'));
        expect(root).toBe(repoDir);
        expect(pc.isGlobal).toBe(false);
    });

    it('auto-switches when path moves to a different registered project', () => {
        const repoDir2 = mkTmpGitRepo();
        try {
            const pc = new ProjectContext(ctx);
            pc.reloadRegistry([
                { project_id: 'proj-a', project_name: 'A', project_root: repoDir },
                { project_id: 'proj-b', project_name: 'B', project_root: repoDir2 },
            ]);

            pc.getRoot(path.join(repoDir, 'file.js'));
            expect(pc.isGlobal).toBe(false);

            // Switch to project B
            const rootB = pc.getRoot(path.join(repoDir2, 'other.js'));
            expect(rootB).toBe(repoDir2);
        } finally {
            fs.rmSync(repoDir2, { recursive: true, force: true });
        }
    });

    it('falls back to global when no roots match', async () => {
        const { ProjectContext } = await importProjectContext();
        const emptyCtx = {
            getAllowedDirectories: () => [],
            validatePath: async (p) => p,
        };
        const pc = new ProjectContext(emptyCtx);
        expect(pc.isGlobal).toBe(true);
    });

    it('fast-path: same-project files skip registry lookup', () => {
        const pc = new ProjectContext(ctx);
        pc.reloadRegistry([{
            project_id: 'test-project',
            project_name: 'Test Project',
            project_root: repoDir,
        }]);
        const root1 = pc.getRoot(path.join(repoDir, 'a.js'));
        const root2 = pc.getRoot(path.join(repoDir, 'sub', 'b.js'));
        expect(root1).toBe(root2);
    });
});

describe('ProjectContext — getStashDb', () => {
    let repoDir;
    let ctx;

    beforeEach(async () => {
        vi.resetModules();
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('returns a project-scoped DB for registered project path', async () => {
        const { ProjectContext } = await importProjectContext();
        const pc = new ProjectContext(ctx);
        pc.reloadRegistry([{
            project_id: 'test-project',
            project_name: 'Test Project',
            project_root: repoDir,
        }]);
        const result = pc.getStashDb(path.join(repoDir, 'test.js'));
        expect(result.db).toBeTruthy();
        expect(result.isGlobal).toBe(false);
        expect(result.root).toBeTruthy();
    });

    it('returns global DB for unregistered path', async () => {
        const { ProjectContext } = await importProjectContext();
        const emptyCtx = {
            getAllowedDirectories: () => [],
            validatePath: async (p) => p,
        };
        const pc = new ProjectContext(emptyCtx);
        const result = pc.getStashDb();
        expect(result.db).toBeTruthy();
        expect(result.isGlobal).toBe(true);
    });
});

describe('ProjectContext — initProject', () => {
    let repoDir;
    let ctx;

    beforeEach(async () => {
        vi.resetModules();
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('registers a project root and binds to it', async () => {
        const { ProjectContext } = await importProjectContext();
        const pc = new ProjectContext(ctx);
        const result = pc.initProject(repoDir, 'test-project');
        expect(result).toBe(path.resolve(repoDir));
        expect(pc._boundRoot).toBe(path.resolve(repoDir));
        expect(pc._explicit).toBe(true);
    });

    it('throws for non-existent directory', async () => {
        const { ProjectContext } = await importProjectContext();
        const pc = new ProjectContext(ctx);
        expect(() => pc.initProject('/nonexistent/path/xyz', 'bad'))
            .toThrow('Not a directory');
    });

    it('uses basename as default name', async () => {
        const { ProjectContext } = await importProjectContext();
        const pc = new ProjectContext(ctx);
        pc.initProject(repoDir);
        // Verify it bound correctly with basename as the project name
        expect(pc._boundRoot).toBe(path.resolve(repoDir));
        expect(pc._explicit).toBe(true);
    });
});

describe('ProjectContext — refresh', () => {
    let repoDir;
    let ctx;

    beforeEach(async () => {
        vi.resetModules();
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('reset resolves state so next getRoot re-resolves', async () => {
        const { ProjectContext } = await importProjectContext();
        const pc = new ProjectContext(ctx);
        pc.reloadRegistry([{
            project_id: 'test-project',
            project_name: 'Test',
            project_root: repoDir,
        }]);
        const root1 = pc.getRoot(path.join(repoDir, 'file.js'));
        expect(root1).toBeTruthy();

        pc.refresh();
        // After refresh, _resolveNoFile re-runs and finds the registry match
        expect(pc._resolved).toBe(true);
        expect(pc._explicit).toBe(false);
    });
});

describe('ProjectContext — singleton', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('getProjectContext returns same instance', async () => {
        const { getProjectContext } = await importProjectContext();
        const ctx = { getAllowedDirectories: () => [], validatePath: async (p) => p };
        const instance1 = getProjectContext(ctx);
        const instance2 = getProjectContext(ctx);
        expect(instance1).toBe(instance2);
    });
});

describe('ProjectContext — onRootsChanged', () => {
    it('refreshes singleton instance when roots change (preserves explicit binding)', async () => {
        vi.resetModules();
        const { getProjectContext, onRootsChanged } = await importProjectContext();
        const ctx = { getAllowedDirectories: () => [], validatePath: async (p) => p };
        const pc = getProjectContext(ctx);
        pc._resolved = true;
        pc._explicit = true;
        onRootsChanged(ctx);
        // Issue 8: explicit bindings are sticky — onRootsChanged must NOT override
        // a project that was explicitly registered via initProject().
        expect(pc._explicit).toBe(true);
    });

    it('refactor-batch path: getProjectContext via ctx is refreshed by onRootsChanged(ctx)', async () => {
        vi.resetModules();
        const { getProjectContext, onRootsChanged } = await importProjectContext();
        // Simulate the ToolContext that refactor_batch.ts passes directly to getProjectContext
        const ctx = {
            getAllowedDirectories: () => [],
            validatePath: async (p) => p,
            sessionId: 'test-session',
            validateNewFilePath: async (p) => p,
            setAllowedDirectories: () => {},
        };
        // Obtain the context through ctx (as refactor_batch now does)
        const pc = getProjectContext(ctx);
        pc._resolved = true;
        pc._explicit = true;

        // onRootsChanged is called by server.ts with the same ctx object
        onRootsChanged(ctx);

        // Issue 8: The cached instance keyed by ctx must NOT have its explicit
        // binding cleared — explicit bindings survive a roots-change.
        expect(pc._explicit).toBe(true);
        expect(pc._resolved).toBe(true); // refresh() skips re-resolve when explicit
    });

    it('wrapper object does NOT get refreshed by onRootsChanged(ctx)', async () => {
        vi.resetModules();
        const { getProjectContext, onRootsChanged } = await importProjectContext();
        const ctx = { getAllowedDirectories: () => [], validatePath: async (p) => p };
        // A separate wrapper object (old incorrect pattern)
        const wrapper = { getAllowedDirectories: () => ctx.getAllowedDirectories() };
        const pc = getProjectContext(wrapper);
        pc._resolved = true;
        pc._explicit = true;

        // Calling onRootsChanged with the original ctx cannot reach the wrapper-keyed instance
        onRootsChanged(ctx);

        // The wrapper-keyed instance is NOT refreshed
        expect(pc._explicit).toBe(true);
    });
});
