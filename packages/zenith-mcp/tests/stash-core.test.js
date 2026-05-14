import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

async function importStashModules() {
    const { getProjectContext } = await import('../dist/core/project-context.js');
    const stash = await import('../dist/core/stash.js');
    return { getProjectContext, ...stash };
}

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-test-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    return dir;
}

function mkCtx(repoDir) {
    return {
        getAllowedDirectories: () => [repoDir],
        validatePath: async (p) => p,
        _roots: [repoDir],
    };
}

describe('stash core — CRUD operations', () => {
    let repoDir;
    let ctx;
    let modules;

    beforeEach(async () => {
        vi.resetModules();
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        modules = await importStashModules();
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('stashEntry inserts and getStashEntry retrieves', () => {
        const id = modules.stashEntry(ctx, 'edit', path.join(repoDir, 'test.js'), { foo: 'bar' });
        expect(typeof id).toBe('number');

        const entry = modules.getStashEntry(ctx, id, path.join(repoDir, 'test.js'));
        expect(entry).not.toBeNull();
        expect(entry.type).toBe('edit');
        expect(entry.payload).toEqual({ foo: 'bar' });
        expect(entry.attempts).toBe(0);
    });

    it('getStashEntry returns null for nonexistent id', () => {
        const entry = modules.getStashEntry(ctx, 99999, path.join(repoDir, 'test.js'));
        expect(entry).toBeNull();
    });

    it('consumeAttempt increments attempts and returns true on first call', () => {
        const id = modules.stashEntry(ctx, 'edit', path.join(repoDir, 'test.js'), { x: 1 });
        const result = modules.consumeAttempt(ctx, id, path.join(repoDir, 'test.js'));
        expect(result).toBe(true);

        const entry = modules.getStashEntry(ctx, id, path.join(repoDir, 'test.js'));
        expect(entry.attempts).toBe(1);
    });

    it('consumeAttempt deletes entry after MAX_ATTEMPTS (2) exceeded', () => {
        const id = modules.stashEntry(ctx, 'edit', path.join(repoDir, 'test.js'), { x: 1 });

        const first = modules.consumeAttempt(ctx, id, path.join(repoDir, 'test.js'));
        expect(first).toBe(true);

        const second = modules.consumeAttempt(ctx, id, path.join(repoDir, 'test.js'));
        expect(second).toBe(true);

        // BUG: uses > instead of >=, so a 3rd consumeAttempt is needed to trigger deletion
        // when MAX_ATTEMPTS=2. The code allows consumeAttempt to return true 2 times
        // (attempts goes 0→1, 1→2, and 2 > 2 is false). Only at attempt 3 (next=3, 3>2=true)
        // does it delete. This means the actual limit is 3 consumeAttempt calls, not 2.
        const third = modules.consumeAttempt(ctx, id, path.join(repoDir, 'test.js'));
        expect(third).toBe(false);

        const entry = modules.getStashEntry(ctx, id, path.join(repoDir, 'test.js'));
        expect(entry).toBeNull();
    });

    it('clearStash removes entry', () => {
        const id = modules.stashEntry(ctx, 'write', path.join(repoDir, 'test.js'), { content: 'abc' });
        modules.clearStash(ctx, id, path.join(repoDir, 'test.js'));
        const entry = modules.getStashEntry(ctx, id, path.join(repoDir, 'test.js'));
        expect(entry).toBeNull();
    });

    it('listStash returns all entries', () => {
        modules.stashEntry(ctx, 'edit', path.join(repoDir, 'a.js'), { edits: [] });
        modules.stashEntry(ctx, 'write', path.join(repoDir, 'b.js'), { content: 'hello' });

        const { entries } = modules.listStash(ctx, path.join(repoDir, 'a.js'));
        expect(entries.length).toBeGreaterThanOrEqual(2);
        expect(entries.some(e => e.type === 'edit')).toBe(true);
        expect(entries.some(e => e.type === 'write')).toBe(true);
    });

    it('listStash returns empty entries for clean repo', () => {
        const { entries } = modules.listStash(ctx, path.join(repoDir, 'clean.js'));
        expect(entries).toHaveLength(0);
    });

    it('consumeAttempt returns false for nonexistent id', () => {
        const result = modules.consumeAttempt(ctx, 99999, path.join(repoDir, 'test.js'));
        expect(result).toBe(false);
    });
});

describe('stash core — convenience wrappers', () => {
    let repoDir;
    let ctx;
    let modules;

    beforeEach(async () => {
        vi.resetModules();
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        modules = await importStashModules();
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('stashEdits creates edit-type entry with edits and failedIndices', () => {
        const id = modules.stashEdits(ctx, path.join(repoDir, 'test.js'), [{ mode: 'content' }], [0]);
        const entry = modules.getStashEntry(ctx, id, path.join(repoDir, 'test.js'));
        expect(entry.type).toBe('edit');
        expect(entry.payload.edits).toEqual([{ mode: 'content' }]);
        expect(entry.payload.failedIndices).toEqual([0]);
    });

    it('stashWrite creates write-type entry with content and mode', () => {
        const id = modules.stashWrite(ctx, path.join(repoDir, 'test.js'), 'file content', 'append');
        const entry = modules.getStashEntry(ctx, id, path.join(repoDir, 'test.js'));
        expect(entry.type).toBe('write');
        expect(entry.payload.content).toBe('file content');
        expect(entry.payload.mode).toBe('append');
    });

    it('stashWrite defaults mode to overwrite', () => {
        const id = modules.stashWrite(ctx, path.join(repoDir, 'test.js'), 'content');
        const entry = modules.getStashEntry(ctx, id, path.join(repoDir, 'test.js'));
        expect(entry.payload.mode).toBe('overwrite');
    });
});
