import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
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

function mkCtx(baseDir) {
    return {
        validatePath: async (p) => {
            const resolved = path.resolve(p);
            if (!resolved.startsWith(path.resolve(baseDir))) {
                const err = new Error('Path outside allowed directory');
                err.code = 'ENOENT';
                throw err;
            }
            return resolved;
        },
        getAllowedDirectories: () => [baseDir],
    };
}

async function importFilesystem() {
    return await import('../dist/tools/filesystem.js');
}

describe('file_manager mkdir', () => {
    let tmpDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importFilesystem();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('creates a single directory', async () => {
        const dirPath = path.join(tmpDir, 'newdir');
        const result = await handler({ mode: 'mkdir', path: dirPath });
        expect(result.content[0].text).toBe('Created.');
        expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    });

    it('creates nested directories recursively', async () => {
        const dirPath = path.join(tmpDir, 'a', 'b', 'c');
        const result = await handler({ mode: 'mkdir', path: dirPath });
        expect(result.content[0].text).toBe('Created.');
        expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    });

    it('succeeds on existing directory (mkdir -p behavior)', async () => {
        const dirPath = path.join(tmpDir, 'existing');
        fs.mkdirSync(dirPath);
        const result = await handler({ mode: 'mkdir', path: dirPath });
        expect(result.content[0].text).toBe('Created.');
    });
});

describe('file_manager delete', () => {
    let tmpDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importFilesystem();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('deletes an existing file', async () => {
        const filePath = path.join(tmpDir, 'to-delete.txt');
        fs.writeFileSync(filePath, 'bye');
        const result = await handler({ mode: 'delete', path: filePath });
        expect(result.content[0].text).toBe('Deleted.');
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('throws for non-existent file (ENOENT from stat is not caught)', async () => {
        const filePath = path.join(tmpDir, 'nope.txt');
        await expect(handler({ mode: 'delete', path: filePath }))
            .rejects.toThrow('ENOENT');
    });

    it('throws "Not a file." when path is a directory', async () => {
        const dirPath = path.join(tmpDir, 'adir');
        fs.mkdirSync(dirPath);
        await expect(handler({ mode: 'delete', path: dirPath }))
            .rejects.toThrow('Not a file.');
    });

    it('throws "Unable to locate file." when path escapes allowed directory', async () => {
        const outsidePath = '/tmp/__filesystem_test_escape_noexist__';
        await expect(handler({ mode: 'delete', path: outsidePath }))
            .rejects.toThrow('Unable to locate file.');
    });
});

describe('file_manager move', () => {
    let tmpDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importFilesystem();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('moves a file to a new location', async () => {
        const src = path.join(tmpDir, 'original.txt');
        const dst = path.join(tmpDir, 'moved.txt');
        fs.writeFileSync(src, 'content');
        const result = await handler({ mode: 'move', source: src, destination: dst });
        expect(result.content[0].text).toBe('Moved.');
        expect(fs.existsSync(src)).toBe(false);
        expect(fs.readFileSync(dst, 'utf-8')).toBe('content');
    });

    it('renames a directory', async () => {
        const src = path.join(tmpDir, 'olddir');
        const dst = path.join(tmpDir, 'newdir');
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'f.txt'), 'inside');
        const result = await handler({ mode: 'move', source: src, destination: dst });
        expect(result.content[0].text).toBe('Moved.');
        expect(fs.existsSync(src)).toBe(false);
        expect(fs.statSync(dst).isDirectory()).toBe(true);
        expect(fs.readFileSync(path.join(dst, 'f.txt'), 'utf-8')).toBe('inside');
    });
});

describe('file_manager info', () => {
    let tmpDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importFilesystem();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('returns metadata for a file', async () => {
        const filePath = path.join(tmpDir, 'info-test.txt');
        fs.writeFileSync(filePath, 'info content');
        const result = await handler({ mode: 'info', path: filePath });
        const text = result.content[0].text;
        expect(text).toContain('size:');
        expect(text).toContain('modified:');
        expect(text).toContain('created:');
        expect(text).toContain('accessed:');
        expect(text).toContain('isDirectory: false');
        expect(text).toContain('isFile: true');
        expect(text).toContain('permissions:');
    });

    it('returns metadata for a directory', async () => {
        const dirPath = path.join(tmpDir, 'infodir');
        fs.mkdirSync(dirPath);
        const result = await handler({ mode: 'info', path: dirPath });
        const text = result.content[0].text;
        expect(text).toContain('isDirectory: true');
        expect(text).toContain('isFile: false');
    });

    it('reports correct size', async () => {
        const filePath = path.join(tmpDir, 'sized.txt');
        const content = 'hello world';
        fs.writeFileSync(filePath, content);
        const result = await handler({ mode: 'info', path: filePath });
        const text = result.content[0].text;
        expect(text).toContain(`size: ${Buffer.byteLength(content)}`);
    });
});

describe('file_manager edge cases', () => {
    let tmpDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importFilesystem();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('throws "Unknown mode." for invalid mode', async () => {
        await expect(handler({ mode: 'invalid', path: '/tmp/x' }))
            .rejects.toThrow('Unknown mode.');
    });
});

describe('file_manager registration', () => {
    it('registers with correct name and schema', async () => {
        const tmpDir = mkTmpDir();
        const { server, calls } = captureHandler();
        const mod = await importFilesystem();
        mod.register(server, mkCtx(tmpDir));
        expect(calls[0].name).toBe('file_manager');
        const schema = calls[0].schema;
        expect(schema.title).toBe('Filesystem');
        expect(schema.description).toBeDefined();
        expect(schema.inputSchema).toBeDefined();
        expect(schema.inputSchema.shape).toBeDefined();
        expect(schema.inputSchema.shape.mode).toBeDefined();
        expect(schema.inputSchema.shape.path).toBeDefined();
        expect(schema.inputSchema.shape.source).toBeDefined();
        expect(schema.inputSchema.shape.destination).toBeDefined();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('has destructiveHint annotation set to true', async () => {
        const tmpDir = mkTmpDir();
        const { server, calls } = captureHandler();
        const mod = await importFilesystem();
        mod.register(server, mkCtx(tmpDir));
        expect(calls[0].schema.annotations.destructiveHint).toBe(true);
        expect(calls[0].schema.annotations.readOnlyHint).toBe(false);
        expect(calls[0].schema.annotations.idempotentHint).toBe(false);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
});
