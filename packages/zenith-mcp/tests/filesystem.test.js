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
    const validateInsideBase = async (p) => {
        const resolved = path.resolve(p);
        const allowedBase = path.resolve(baseDir);
        const relative = path.relative(allowedBase, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            const err = new Error('Path outside allowed directory');
            err.code = 'ENOENT';
            throw err;
        }
        return resolved;
    };

    return {
        validatePath: validateInsideBase,
        validateNewFilePath: validateInsideBase,
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

    it('moves a file to a new filename under an existing allowed parent', async () => {
        const src = path.join(tmpDir, 'original.txt');
        const dst = path.join(tmpDir, 'moved.txt');
        fs.writeFileSync(src, 'content');
        const result = await handler({ mode: 'move', source: src, destination: dst });
        expect(result.content[0].text).toBe('Moved.');
        expect(fs.existsSync(src)).toBe(false);
        expect(fs.readFileSync(dst, 'utf-8')).toBe('content');
    });

    it('moves a file into a not-yet-existing nested destination', async () => {
        const src = path.join(tmpDir, 'original.txt');
        const dst = path.join(tmpDir, 'nested', 'deeper', 'moved.txt');
        fs.writeFileSync(src, 'nested content');
        const result = await handler({ mode: 'move', source: src, destination: dst });
        expect(result.content[0].text).toBe('Moved.');
        expect(fs.existsSync(src)).toBe(false);
        expect(fs.readFileSync(dst, 'utf-8')).toBe('nested content');
    });

    it('rejects moving to a destination outside the sandbox', async () => {
        const src = path.join(tmpDir, 'original.txt');
        const dst = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
        fs.writeFileSync(src, 'content');
        await expect(handler({ mode: 'move', source: src, destination: dst }))
            .rejects.toThrow('Path outside allowed directory');
        expect(fs.readFileSync(src, 'utf-8')).toBe('content');
        expect(fs.existsSync(dst)).toBe(false);
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

    it('rejects moving from a source outside the sandbox', async () => {
        const src = path.join(os.tmpdir(), `outside-src-${Date.now()}.txt`);
        const dst = path.join(tmpDir, 'dest.txt');
        fs.writeFileSync(src, 'escaped content');
        try {
            await expect(handler({ mode: 'move', source: src, destination: dst }))
                .rejects.toThrow('Path outside allowed directory');
            expect(fs.existsSync(dst)).toBe(false);
        } finally {
            try { fs.unlinkSync(src); } catch {}
        }
    });

    it('creates a single-level parent directory when it does not exist', async () => {
        const src = path.join(tmpDir, 'flat.txt');
        const dst = path.join(tmpDir, 'subdir', 'flat.txt');
        fs.writeFileSync(src, 'flat content');
        const result = await handler({ mode: 'move', source: src, destination: dst });
        expect(result.content[0].text).toBe('Moved.');
        expect(fs.existsSync(src)).toBe(false);
        expect(fs.readFileSync(dst, 'utf-8')).toBe('flat content');
        expect(fs.statSync(path.join(tmpDir, 'subdir')).isDirectory()).toBe(true);
    });

    it('overwrites an existing file at destination (atomic rename)', async () => {
        const src = path.join(tmpDir, 'new-version.txt');
        const dst = path.join(tmpDir, 'existing-dest.txt');
        fs.writeFileSync(src, 'new content');
        fs.writeFileSync(dst, 'old content');
        const result = await handler({ mode: 'move', source: src, destination: dst });
        expect(result.content[0].text).toBe('Moved.');
        expect(fs.existsSync(src)).toBe(false);
        expect(fs.readFileSync(dst, 'utf-8')).toBe('new content');
    });

    it('moves a directory to a destination with a non-existent parent', async () => {
        const src = path.join(tmpDir, 'mydir');
        const dst = path.join(tmpDir, 'parent', 'child', 'mydir');
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'data.txt'), 'dir content');
        const result = await handler({ mode: 'move', source: src, destination: dst });
        expect(result.content[0].text).toBe('Moved.');
        expect(fs.existsSync(src)).toBe(false);
        expect(fs.statSync(dst).isDirectory()).toBe(true);
        expect(fs.readFileSync(path.join(dst, 'data.txt'), 'utf-8')).toBe('dir content');
    });

    it('rejects moving a directory into its own subdirectory without creating nested dirs', async () => {
        const src = path.join(tmpDir, 'mydir');
        const dst = path.join(src, 'nested', 'newname');
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'data.txt'), 'dir content');

        await expect(handler({ mode: 'move', source: src, destination: dst }))
            .rejects.toThrow('Cannot move a directory into its own subdirectory.');

        expect(fs.existsSync(src)).toBe(true);
        expect(fs.existsSync(path.join(src, 'nested'))).toBe(false);
        expect(fs.readFileSync(path.join(src, 'data.txt'), 'utf-8')).toBe('dir content');
    });

    it('preserves file content exactly when moving to nested destination', async () => {
        const src = path.join(tmpDir, 'binary-like.txt');
        const content = 'line1\nline2\nline3\n';
        const dst = path.join(tmpDir, 'archive', 'binary-like.txt');
        fs.writeFileSync(src, content);
        await handler({ mode: 'move', source: src, destination: dst });
        expect(fs.readFileSync(dst, 'utf-8')).toBe(content);
    });
});

describe('file_manager move - validateNewFilePath context', () => {
    let tmpDir;
    let ctx;

    beforeEach(() => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('mkCtx exposes validateNewFilePath alongside validatePath', () => {
        expect(typeof ctx.validateNewFilePath).toBe('function');
        expect(typeof ctx.validatePath).toBe('function');
    });

    it('validateNewFilePath rejects paths outside the sandbox', async () => {
        const outsidePath = path.join(os.tmpdir(), `escape-check-${Date.now()}.txt`);
        await expect(ctx.validateNewFilePath(outsidePath))
            .rejects.toThrow('Path outside allowed directory');
    });

    it('validateNewFilePath accepts paths inside the sandbox', async () => {
        const insidePath = path.join(tmpDir, 'subdir', 'file.txt');
        const resolved = await ctx.validateNewFilePath(insidePath);
        expect(resolved).toBe(path.resolve(insidePath));
    });

    it('validateNewFilePath blocks path traversal via .. segments', async () => {
        const traversalPath = path.join(tmpDir, 'allowed', '..', '..', 'escape.txt');
        await expect(ctx.validateNewFilePath(traversalPath))
            .rejects.toThrow('Path outside allowed directory');
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

describe('file_manager move - missing argument guards', () => {
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

    it('throws "source required for move." when source is omitted', async () => {
        const dst = path.join(tmpDir, 'dest.txt');
        await expect(handler({ mode: 'move', destination: dst }))
            .rejects.toThrow('source required for move.');
    });

    it('throws "destination required for move." when destination is omitted', async () => {
        const src = path.join(tmpDir, 'src.txt');
        fs.writeFileSync(src, 'data');
        await expect(handler({ mode: 'move', source: src }))
            .rejects.toThrow('destination required for move.');
    });

    it('throws "source required for move." when source is empty string', async () => {
        const dst = path.join(tmpDir, 'dest.txt');
        await expect(handler({ mode: 'move', source: '', destination: dst }))
            .rejects.toThrow('source required for move.');
    });

    it('throws "destination required for move." when destination is empty string', async () => {
        const src = path.join(tmpDir, 'src.txt');
        fs.writeFileSync(src, 'data');
        await expect(handler({ mode: 'move', source: src, destination: '' }))
            .rejects.toThrow('destination required for move.');
    });
});

describe('file_manager move - non-existent source', () => {
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

    it('throws ENOENT when source file does not exist inside sandbox', async () => {
        const src = path.join(tmpDir, 'ghost.txt');
        const dst = path.join(tmpDir, 'ghost-dest.txt');
        // src intentionally not created
        await expect(handler({ mode: 'move', source: src, destination: dst }))
            .rejects.toThrow(/ENOENT/);
    });

    it('does not create destination when source is missing', async () => {
        const src = path.join(tmpDir, 'nonexistent.txt');
        const dst = path.join(tmpDir, 'shouldnotexist.txt');
        await expect(handler({ mode: 'move', source: src, destination: dst }))
            .rejects.toThrow();
        expect(fs.existsSync(dst)).toBe(false);
    });
});

describe('file_manager move - parent directory creation uses validateNewFilePath', () => {
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

    it('mkdir for destination parent is idempotent when parent already exists', async () => {
        const existingParent = path.join(tmpDir, 'existing-parent');
        fs.mkdirSync(existingParent);
        const src = path.join(tmpDir, 'file.txt');
        const dst = path.join(existingParent, 'file.txt');
        fs.writeFileSync(src, 'idempotent');
        const result = await handler({ mode: 'move', source: src, destination: dst });
        expect(result.content[0].text).toBe('Moved.');
        expect(fs.readFileSync(dst, 'utf-8')).toBe('idempotent');
    });

    it('creates deeply nested parent directories (3+ levels)', async () => {
        const src = path.join(tmpDir, 'deep.txt');
        const dst = path.join(tmpDir, 'a', 'b', 'c', 'd', 'deep.txt');
        fs.writeFileSync(src, 'deep');
        const result = await handler({ mode: 'move', source: src, destination: dst });
        expect(result.content[0].text).toBe('Moved.');
        expect(fs.readFileSync(dst, 'utf-8')).toBe('deep');
        expect(fs.statSync(path.join(tmpDir, 'a', 'b', 'c', 'd')).isDirectory()).toBe(true);
    });

    it('uses validateNewFilePath not validatePath for destination (calls the right ctx method)', async () => {
        let validateNewFilePathCallCount = 0;
        let validatePathCallCount = 0;
        const spyCtx = {
            validatePath: async (p) => {
                validatePathCallCount++;
                return ctx.validatePath(p);
            },
            validateNewFilePath: async (p) => {
                validateNewFilePathCallCount++;
                return ctx.validateNewFilePath(p);
            },
            getAllowedDirectories: ctx.getAllowedDirectories,
        };
        const mod = await importFilesystem();
        const { server, calls } = captureHandler();
        mod.register(server, spyCtx);
        const spyHandler = calls[0].handler;

        const src = path.join(tmpDir, 'spy-src.txt');
        const dst = path.join(tmpDir, 'spy-dst.txt');
        fs.writeFileSync(src, 'spy');
        await spyHandler({ mode: 'move', source: src, destination: dst });

        // source uses validatePath, destination uses validateNewFilePath
        expect(validatePathCallCount).toBe(1);
        expect(validateNewFilePathCallCount).toBe(1);
    });
});

describe('file_manager move - validateNewFilePath context (additional)', () => {
    it('validateNewFilePath accepts path exactly equal to the base directory', async () => {
        const tmpDir = mkTmpDir();
        const ctx = mkCtx(tmpDir);
        // path.relative(base, base) === '' which does not start with '..' and is not absolute
        const resolved = await ctx.validateNewFilePath(tmpDir);
        expect(resolved).toBe(path.resolve(tmpDir));
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('validateNewFilePath rejects a sibling directory path', async () => {
        const tmpDir = mkTmpDir();
        const ctx = mkCtx(tmpDir);
        // sibling: strip last segment and add a different name
        const siblingDir = path.join(path.dirname(tmpDir), `sibling-${Date.now()}`);
        const siblingFile = path.join(siblingDir, 'escape.txt');
        await expect(ctx.validateNewFilePath(siblingFile))
            .rejects.toThrow('Path outside allowed directory');
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('validatePath and validateNewFilePath behave identically for inside paths', async () => {
        const tmpDir = mkTmpDir();
        const ctx = mkCtx(tmpDir);
        const insidePath = path.join(tmpDir, 'x', 'y', 'z.txt');
        const r1 = await ctx.validatePath(insidePath);
        const r2 = await ctx.validateNewFilePath(insidePath);
        expect(r1).toBe(r2);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('validatePath and validateNewFilePath both reject paths outside the sandbox', async () => {
        const tmpDir = mkTmpDir();
        const ctx = mkCtx(tmpDir);
        const outside = path.join(os.tmpdir(), `both-reject-${Date.now()}.txt`);
        await expect(ctx.validatePath(outside)).rejects.toThrow('Path outside allowed directory');
        await expect(ctx.validateNewFilePath(outside)).rejects.toThrow('Path outside allowed directory');
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
});
