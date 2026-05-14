import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-test-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    return dir;
}

function captureHandler() {
    const calls = [];
    const server = {
        registerTool: (name, schema, handler) => {
            calls.push({ name, schema, handler });
        },
    };
    return { server, calls };
}

function mkCtx(repoDir) {
    return {
        validatePath: async (p) => path.resolve(p),
        getAllowedDirectories: () => [repoDir],
        sessionId: 'test-session',
    };
}

async function importEditFile() {
    return await import('../dist/tools/edit_file.js');
}

describe('edit_file tool handler — registration', () => {
    it('registers with correct name and schema', async () => {
        const { server, calls } = captureHandler();
        const mod = await importEditFile();
        mod.register(server, mkCtx('/tmp'));
        expect(calls[0].name).toBe('edit_file');
        const schema = calls[0].schema;
        expect(schema.inputSchema.path).toBeDefined();
        expect(schema.inputSchema.edits).toBeDefined();
        expect(schema.inputSchema.dryRun).toBeDefined();
    });
});

describe('edit_file tool handler — content mode', () => {
    let repoDir;
    let handler;
    let ctx;

    beforeEach(async () => {
        vi.resetModules();
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        const mod = await importEditFile();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('applies single content edit and returns "Applied."', async () => {
        const filePath = path.join(repoDir, 'test.js');
        fs.writeFileSync(filePath, 'function foo() {\n    return 1;\n}\n');
        const result = await handler({
            path: filePath,
            edits: [{ mode: 'content', oldContent: '    return 1;', newContent: '    return 2;' }],
        });
        expect(result.content[0].text).toContain('Applied');
        expect(fs.readFileSync(filePath, 'utf-8')).toContain('return 2');
    });

    it('applies multiple content edits in batch', async () => {
        const filePath = path.join(repoDir, 'multi.js');
        fs.writeFileSync(filePath, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
        const result = await handler({
            path: filePath,
            edits: [
                { mode: 'content', oldContent: 'const a = 1;', newContent: 'const a = 10;' },
                { mode: 'content', oldContent: 'const b = 2;', newContent: 'const b = 20;' },
            ],
        });
        expect(result.content[0].text).toContain('Applied');
        const written = fs.readFileSync(filePath, 'utf-8');
        expect(written).toContain('a = 10');
        expect(written).toContain('b = 20');
    });

    it('returns error and stashes on failed edit', async () => {
        const filePath = path.join(repoDir, 'fail.js');
        fs.writeFileSync(filePath, 'const x = 1;\n');
        await expect(handler({
            path: filePath,
            edits: [{ mode: 'content', oldContent: 'nonexistent', newContent: 'y' }],
        })).rejects.toThrow('failed');
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('const x = 1;\n');
    });

    it('throws when no edits provided', async () => {
        const filePath = path.join(repoDir, 'noedits.js');
        fs.writeFileSync(filePath, 'content\n');
        await expect(handler({ path: filePath, edits: [] }))
            .rejects.toThrow('No edits provided');
    });

    it('throws when edits is null/undefined', async () => {
        const filePath = path.join(repoDir, 'nulledits.js');
        fs.writeFileSync(filePath, 'content\n');
        await expect(handler({ path: filePath, edits: undefined }))
            .rejects.toThrow('No edits provided');
    });

    it('returns a syntax warning when the rewritten file has parse errors', async () => {
        const filePath = path.join(repoDir, 'warn.js');
        fs.writeFileSync(filePath, 'function foo() {\n    return 1;\n}\n');
        const result = await handler({
            path: filePath,
            edits: [{ mode: 'content', oldContent: '    return 1;', newContent: '    return {' }],
        });
        expect(result.content[0].text).toContain('⚠ Parse errors');
        expect(fs.readFileSync(filePath, 'utf-8')).toContain('return {');
    });
});

describe('edit_file tool handler — dryRun mode', () => {
    let repoDir;
    let handler;

    beforeEach(async () => {
        vi.resetModules();
        repoDir = mkTmpGitRepo();
        const ctx = mkCtx(repoDir);
        const mod = await importEditFile();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('returns diff preview without modifying file in dryRun', async () => {
        const filePath = path.join(repoDir, 'dry.js');
        fs.writeFileSync(filePath, 'function foo() {\n    return 1;\n}\n');
        const result = await handler({
            path: filePath,
            edits: [{ mode: 'content', oldContent: '    return 1;', newContent: '    return 99;' }],
            dryRun: true,
        });
        expect(result.content[0].text).toContain('return 99');
        expect(fs.readFileSync(filePath, 'utf-8')).toContain('return 1');
        expect(fs.readFileSync(filePath, 'utf-8')).not.toContain('return 99');
    });
});

describe('edit_file tool handler — block mode', () => {
    let repoDir;
    let handler;

    beforeEach(async () => {
        vi.resetModules();
        repoDir = mkTmpGitRepo();
        const ctx = mkCtx(repoDir);
        const mod = await importEditFile();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('replaces block between start and end markers', async () => {
        const filePath = path.join(repoDir, 'block.js');
        fs.writeFileSync(filePath, 'function foo() {\n    return 1;\n}\n');
        const result = await handler({
            path: filePath,
            edits: [{
                mode: 'block',
                block_start: 'function foo() {',
                block_end: '}',
                replacement_block: 'function foo() {\n    return 2;\n}',
            }],
        });
        expect(result.content[0].text).toContain('Applied');
        expect(fs.readFileSync(filePath, 'utf-8')).toContain('return 2');
    });

    it('preserves the original file when block replacement fails', async () => {
        const filePath = path.join(repoDir, 'missing-block.js');
        fs.writeFileSync(filePath, 'function foo() {\n    return 1;\n}\n');
        await expect(handler({
            path: filePath,
            edits: [{
                mode: 'block',
                block_start: 'function missing() {',
                block_end: '}',
                replacement_block: 'function missing() {\n    return 2;\n}',
            }],
        })).rejects.toThrow('block_start not found');
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('function foo() {\n    return 1;\n}\n');
    });
});