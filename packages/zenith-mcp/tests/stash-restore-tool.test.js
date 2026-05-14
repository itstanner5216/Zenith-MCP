import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-restore-tool-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    return dir;
}

function captureHandler() {
    let captured = null;
    const server = {
        registerTool: (_name, _meta, handler) => { captured = handler; },
    };
    return { server, get: () => captured };
}

function mkCtx(repoDir, sessionId) {
    return {
        sessionId: sessionId || null,
        getAllowedDirectories: () => [repoDir],
        validatePath: async (p) => {
            if (path.isAbsolute(p)) return p;
            return path.join(repoDir, p);
        },
    };
}

function text(result) {
    return result.content[0].text;
}

async function importStashRestore() {
    return await import('../dist/tools/stash_restore.js');
}

async function importStashCore() {
    return await import('../dist/core/stash.js');
}

describe('stashRestore — registration', () => {
    it('registers tool with correct name', async () => {
        vi.resetModules();
        const dir = mkTmpGitRepo();
        try {
            const ctx = mkCtx(dir);
            const { server, get } = captureHandler();
            const mod = await importStashRestore();
            mod.register(server, ctx);
            expect(get()).toBeDefined();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('stashRestore — list mode', () => {
    let dir, ctx, handler;

    beforeEach(async () => {
        vi.resetModules();
        dir = mkTmpGitRepo();
        ctx = mkCtx(dir);
        const h = captureHandler();
        const mod = await importStashRestore();
        mod.register(h.server, ctx);
        handler = h.get();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns "Empty." when no stash entries exist', async () => {
        const result = await handler({ mode: 'list', file: path.join(dir, 'nonexistent.js') });
        expect(text(result)).toMatch(/empty/i);
    });

    it('lists entries created via stashCore', async () => {
        const core = await importStashCore();
        const filePath = path.join(dir, 'a.js');
        core.stashEntry(ctx, 'edit', filePath, { edits: [], failedIndices: [] });
        core.stashEntry(ctx, 'write', path.join(dir, 'b.js'), { content: 'hello' });

        const result = await handler({ mode: 'list' });
        const t = text(result);
        expect(t).toContain('[edit]');
        expect(t).toContain('[write]');
        expect(t).toContain('a.js');
    });

    it('filters by type=edit', async () => {
        const core = await importStashCore();
        core.stashEntry(ctx, 'edit', path.join(dir, 'e.js'), { edits: [], failedIndices: [] });
        core.stashEntry(ctx, 'write', path.join(dir, 'w.js'), { content: 'x' });

        const result = await handler({ mode: 'list', type: 'edit' });
        const t = text(result);
        expect(t).toContain('[edit]');
        expect(t).not.toContain('[write]');
    });

    it('filters by type=write', async () => {
        const core = await importStashCore();
        core.stashEntry(ctx, 'edit', path.join(dir, 'e.js'), { edits: [], failedIndices: [] });
        core.stashEntry(ctx, 'write', path.join(dir, 'w.js'), { content: 'x' });

        const result = await handler({ mode: 'list', type: 'write' });
        const t = text(result);
        expect(t).toContain('[write]');
        expect(t).not.toContain('[edit]');
    });

    it('routes list to correct project DB via file parameter', async () => {
        const core = await importStashCore();
        core.stashEntry(ctx, 'edit', path.join(dir, 'target.js'), { edits: [], failedIndices: [] });
        core.stashEntry(ctx, 'edit', path.join(dir, 'other.js'), { edits: [], failedIndices: [] });

        const result = await handler({ mode: 'list', file: path.join(dir, 'target.js') });
        const t = text(result);
        expect(t).toContain('target.js');
        expect(t).toContain('other.js');
    });

    it('returns empty when type filter matches nothing', async () => {
        const core = await importStashCore();
        core.stashEntry(ctx, 'write', path.join(dir, 'a.js'), { content: 'x' });

        const result = await handler({ mode: 'list', type: 'edit' });
        expect(text(result)).toMatch(/empty/i);
    });

    it('shows attempt count in listing', async () => {
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'edit', path.join(dir, 'a.js'), { edits: [], failedIndices: [] });
        core.consumeAttempt(ctx, id, path.join(dir, 'a.js'));

        const result = await handler({ mode: 'list' });
        expect(text(result)).toContain('attempt 1/2');
    });
});

describe('stashRestore — read mode', () => {
    let dir, ctx, handler;

    beforeEach(async () => {
        vi.resetModules();
        dir = mkTmpGitRepo();
        ctx = mkCtx(dir);
        const h = captureHandler();
        const mod = await importStashRestore();
        mod.register(h.server, ctx);
        handler = h.get();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('throws when stashId is missing', async () => {
        await expect(handler({ mode: 'read' })).rejects.toThrow(/stashId required/i);
    });

    it('throws for unknown stashId', async () => {
        await expect(handler({ mode: 'read', stashId: 99999 }))
            .rejects.toThrow(/not found/i);
    });

    it('reads edit-type entry and shows edit details', async () => {
        const core = await importStashCore();
        const filePath = path.join(dir, 'edit.js');
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [
                { mode: 'content', oldContent: 'old', newContent: 'new' },
                { mode: 'symbol', symbol: 'foo' },
            ],
            failedIndices: [1],
        });

        const result = await handler({ mode: 'read', stashId: id });
        const t = text(result);
        expect(t).toContain('[edit]');
        expect(t).toContain('edit.js');
        expect(t).toContain('#1 [ok] content');
        expect(t).toContain('#2 [FAILED] symbol:foo');
    });

    it('reads edit-type entry with block edits', async () => {
        const core = await importStashCore();
        const filePath = path.join(dir, 'block.js');
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [
                { block_start: 'function a', block_end: '}', replacement_block: 'new' },
            ],
            failedIndices: [],
        });

        const result = await handler({ mode: 'read', stashId: id });
        expect(text(result)).toContain('block:function a...}');
    });

    it('reads write-type entry and shows content preview', async () => {
        const core = await importStashCore();
        const filePath = path.join(dir, 'write.js');
        const id = core.stashEntry(ctx, 'write', filePath, {
            content: 'hello world this is content',
            mode: 'overwrite',
        });

        const result = await handler({ mode: 'read', stashId: id });
        const t = text(result);
        expect(t).toContain('[write]');
        expect(t).toContain('write.js');
        expect(t).toContain('hello world this is content');
    });

    it('truncates write content preview over 500 chars', async () => {
        const core = await importStashCore();
        const filePath = path.join(dir, 'big.js');
        const longContent = 'x'.repeat(600);
        const id = core.stashEntry(ctx, 'write', filePath, {
            content: longContent,
            mode: 'overwrite',
        });

        const result = await handler({ mode: 'read', stashId: id });
        expect(text(result)).toContain('...');
        expect(text(result).length).toBeLessThan(longContent.length + 100);
    });

    it('reads entry filtered by file path', async () => {
        const core = await importStashCore();
        const filePath = path.join(dir, 'specific.js');
        const id = core.stashEntry(ctx, 'write', filePath, {
            content: 'specific content',
            mode: 'overwrite',
        });

        const result = await handler({ mode: 'read', stashId: id, file: filePath });
        expect(text(result)).toContain('specific content');
    });
});

describe('stashRestore — restore mode (clear)', () => {
    let dir, ctx, handler;

    beforeEach(async () => {
        vi.resetModules();
        dir = mkTmpGitRepo();
        ctx = mkCtx(dir);
        const h = captureHandler();
        const mod = await importStashRestore();
        mod.register(h.server, ctx);
        handler = h.get();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('throws when stashId is missing', async () => {
        await expect(handler({ mode: 'restore' })).rejects.toThrow(/stashId required/i);
    });

    it('throws for unknown stashId', async () => {
        await expect(handler({ mode: 'restore', stashId: 99999 }))
            .rejects.toThrow(/not found/i);
    });

    it('clears an existing stash entry', async () => {
        const core = await importStashCore();
        const filePath = path.join(dir, 'a.js');
        const id = core.stashEntry(ctx, 'edit', filePath, { edits: [], failedIndices: [] });

        const result = await handler({ mode: 'restore', stashId: id, file: filePath });
        expect(text(result)).toBe('Cleared.');

        const entry = core.getStashEntry(ctx, id, filePath);
        expect(entry).toBeNull();
    });

    it('clears write-type entry', async () => {
        const core = await importStashCore();
        const filePath = path.join(dir, 'w.js');
        const id = core.stashEntry(ctx, 'write', filePath, { content: 'data', mode: 'overwrite' });

        await handler({ mode: 'restore', stashId: id, file: filePath });

        const entry = core.getStashEntry(ctx, id, filePath);
        expect(entry).toBeNull();
    });
});

describe('stashRestore — apply mode: edit', () => {
    let dir, ctx, handler;

    beforeEach(async () => {
        vi.resetModules();
        dir = mkTmpGitRepo();
        ctx = mkCtx(dir);
        const h = captureHandler();
        const mod = await importStashRestore();
        mod.register(h.server, ctx);
        handler = h.get();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('throws when stashId is missing', async () => {
        await expect(handler({ mode: 'apply' })).rejects.toThrow(/stashId required/i);
    });

    it('throws for unknown stashId', async () => {
        await expect(handler({ mode: 'apply', stashId: 99999 }))
            .rejects.toThrow(/not found/i);
    });

    it('applies a content-mode edit from stash', async () => {
        const filePath = path.join(dir, 'apply.js');
        fs.writeFileSync(filePath, 'hello world\n');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [{ mode: 'content', oldContent: 'hello', newContent: 'goodbye' }],
            failedIndices: [0],
        });

        const result = await handler({ mode: 'apply', stashId: id, file: filePath });
        expect(text(result)).toMatch(/applied/i);
        expect(fs.readFileSync(filePath, 'utf-8')).toContain('goodbye');
    });

    it('dryRun returns a diff without writing', async () => {
        const filePath = path.join(dir, 'dryrun.js');
        fs.writeFileSync(filePath, 'hello world\n');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [{ mode: 'content', oldContent: 'hello', newContent: 'goodbye' }],
            failedIndices: [0],
        });

        const result = await handler({ mode: 'apply', stashId: id, file: filePath, dryRun: true });
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world\n');
        expect(text(result)).toContain('dryrun.js');
    });

    it('dryRun does not consume an attempt', async () => {
        const filePath = path.join(dir, 'attempt.js');
        fs.writeFileSync(filePath, 'hello world\n');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [{ mode: 'content', oldContent: 'hello', newContent: 'goodbye' }],
            failedIndices: [0],
        });

        await handler({ mode: 'apply', stashId: id, file: filePath, dryRun: true });

        const entry = core.getStashEntry(ctx, id, filePath);
        expect(entry).not.toBeNull();
        expect(entry.attempts).toBe(0);
    });

    it('non-dryRun consumes an attempt', async () => {
        const filePath = path.join(dir, 'consume.js');
        fs.writeFileSync(filePath, 'hello world\n');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [{ mode: 'content', oldContent: 'hello', newContent: 'goodbye' }],
            failedIndices: [0],
        });

        await handler({ mode: 'apply', stashId: id, file: filePath });

        const entry = core.getStashEntry(ctx, id, filePath);
        expect(entry).toBeNull();
    });

    it('clears stash after successful apply', async () => {
        const filePath = path.join(dir, 'clear.js');
        fs.writeFileSync(filePath, 'line1\nline2\n');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [{ mode: 'content', oldContent: 'line1', newContent: 'replaced' }],
            failedIndices: [0],
        });

        await handler({ mode: 'apply', stashId: id, file: filePath });
        expect(core.getStashEntry(ctx, id, filePath)).toBeNull();
    });

    it('throws when max retries exceeded', async () => {
        const filePath = path.join(dir, 'maxretry.js');
        fs.writeFileSync(filePath, 'hello world\n');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [{ mode: 'content', oldContent: 'hello', newContent: 'goodbye' }],
            failedIndices: [0],
        });

        core.consumeAttempt(ctx, id, filePath);
        core.consumeAttempt(ctx, id, filePath);

        await expect(handler({ mode: 'apply', stashId: id, file: filePath }))
            .rejects.toThrow(/max retries/i);
    });

    it('throws when edit cannot be applied (oldContent not found)', async () => {
        const filePath = path.join(dir, 'fail.js');
        fs.writeFileSync(filePath, 'something else entirely\n');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [{ mode: 'content', oldContent: 'nonexistent text', newContent: 'replaced' }],
            failedIndices: [0],
        });

        await expect(handler({ mode: 'apply', stashId: id, file: filePath }))
            .rejects.toThrow(/failed/i);
    });

    it('applies multi-edit batch', async () => {
        const filePath = path.join(dir, 'multi.js');
        fs.writeFileSync(filePath, 'alpha\nbeta\ngamma\n');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'edit', filePath, {
            edits: [
                { mode: 'content', oldContent: 'alpha', newContent: 'ALPHA' },
                { mode: 'content', oldContent: 'gamma', newContent: 'GAMMA' },
            ],
            failedIndices: [0, 1],
        });

        const result = await handler({ mode: 'apply', stashId: id, file: filePath });
        expect(text(result)).toMatch(/applied/i);
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('ALPHA');
        expect(content).toContain('beta');
        expect(content).toContain('GAMMA');
    });
});

describe('stashRestore — apply mode: write', () => {
    let dir, ctx, handler;

    beforeEach(async () => {
        vi.resetModules();
        dir = mkTmpGitRepo();
        ctx = mkCtx(dir);
        const h = captureHandler();
        const mod = await importStashRestore();
        mod.register(h.server, ctx);
        handler = h.get();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('creates a new file from write stash', async () => {
        const filePath = path.join(dir, 'newfile.js');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'write', filePath, {
            content: 'new file content',
            mode: 'overwrite',
        });

        const result = await handler({ mode: 'apply', stashId: id });
        expect(text(result)).toBe('Applied.');
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('new file content');
    });

    it('overwrites existing file from write stash', async () => {
        const filePath = path.join(dir, 'overwrite.js');
        fs.writeFileSync(filePath, 'old content');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'write', filePath, {
            content: 'new content',
            mode: 'overwrite',
        });

        await handler({ mode: 'apply', stashId: id });
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
    });

    it('appends to existing file from write stash', async () => {
        const filePath = path.join(dir, 'append.js');
        fs.writeFileSync(filePath, 'existing line\n');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'write', filePath, {
            content: 'appended line\n',
            mode: 'append',
        });

        await handler({ mode: 'apply', stashId: id });
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('existing line');
        expect(content).toContain('appended line');
    });

    it('dryRun returns byte count without writing', async () => {
        const filePath = path.join(dir, 'drywrite.js');
        const core = await importStashCore();
        const content = 'hello world';
        const id = core.stashEntry(ctx, 'write', filePath, {
            content,
            mode: 'overwrite',
        });

        const result = await handler({ mode: 'apply', stashId: id, dryRun: true });
        expect(text(result)).toContain('bytes');
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('creates parent directories for write', async () => {
        const filePath = path.join(dir, 'deep', 'nested', 'file.js');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'write', filePath, {
            content: 'deep content',
            mode: 'overwrite',
        });

        await handler({ mode: 'apply', stashId: id });
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('deep content');
    });

    it('redirects write to newPath', async () => {
        const stashPath = path.join(dir, 'original.js');
        const redirectPath = path.join(dir, 'redirected.js');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'write', stashPath, {
            content: 'redirected content',
            mode: 'overwrite',
        });

        await handler({ mode: 'apply', stashId: id, newPath: redirectPath });
        expect(fs.existsSync(stashPath)).toBe(false);
        expect(fs.readFileSync(redirectPath, 'utf-8')).toBe('redirected content');
    });

    it('clears stash after successful write apply', async () => {
        const filePath = path.join(dir, 'wclear.js');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'write', filePath, {
            content: 'content',
            mode: 'overwrite',
        });

        await handler({ mode: 'apply', stashId: id });
        expect(core.getStashEntry(ctx, id, filePath)).toBeNull();
    });

    it('throws when max retries exceeded for write', async () => {
        const filePath = path.join(dir, 'wretry.js');
        const core = await importStashCore();
        const id = core.stashEntry(ctx, 'write', filePath, {
            content: 'x',
            mode: 'overwrite',
        });

        core.consumeAttempt(ctx, id, filePath);
        core.consumeAttempt(ctx, id, filePath);

        await expect(handler({ mode: 'apply', stashId: id }))
            .rejects.toThrow(/max retries/i);
    });
});

describe('stashRestore — error cases', () => {
    let dir, ctx, handler;

    beforeEach(async () => {
        vi.resetModules();
        dir = mkTmpGitRepo();
        ctx = mkCtx(dir);
        const h = captureHandler();
        const mod = await importStashRestore();
        mod.register(h.server, ctx);
        handler = h.get();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('throws on invalid mode', async () => {
        await expect(handler({ mode: 'invalid' })).rejects.toThrow(/invalid mode/i);
    });
});
