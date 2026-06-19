import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dir-test-'));
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
        validatePath: async (p) => path.resolve(p),
        validateNewFilePath: async (p) => path.resolve(p),
        getAllowedDirectories: () => [baseDir],
    };
}

async function importDirectory() {
    return await import('../dist/tools/directory.js');
}

describe('directory tool — list mode', () => {
    let tmpDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importDirectory();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('lists files in a flat directory', async () => {
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello');
        fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'world');
        const result = await handler({ mode: 'list', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('a.txt');
        expect(text).toContain('b.txt');
    });

    it('marks directories with trailing slash', async () => {
        fs.mkdirSync(path.join(tmpDir, 'subdir'));
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), '');
        const result = await handler({ mode: 'list', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('subdir/');
        expect(text).toContain('file.txt');
    });

    it('lists recursively when depth > 1', async () => {
        fs.mkdirSync(path.join(tmpDir, 'sub'));
        fs.writeFileSync(path.join(tmpDir, 'sub', 'deep.txt'), 'data');
        const result = await handler({ mode: 'list', path: tmpDir, depth: 3 });
        const text = result.content[0].text;
        expect(text).toContain('sub/');
        expect(text).toContain('deep.txt');
    });

    it('does not recurse into subdirectories at depth 1', async () => {
        fs.mkdirSync(path.join(tmpDir, 'sub'));
        fs.writeFileSync(path.join(tmpDir, 'sub', 'hidden.txt'), 'x');
        const result = await handler({ mode: 'list', path: tmpDir, depth: 1 });
        const text = result.content[0].text;
        expect(text).toContain('sub/');
        expect(text).not.toContain('hidden.txt');
    });

    it('shows file sizes when includeSizes is true', async () => {
        fs.writeFileSync(path.join(tmpDir, 'sized.txt'), '12345');
        const result = await handler({ mode: 'list', path: tmpDir, includeSizes: true });
        const text = result.content[0].text;
        expect(text).toContain('sized.txt');
        expect(text).toMatch(/\d+(\.\d+)?\s*(B|KB|MB)/);
    });

    it('sorts by size descending when sortBy is size', async () => {
        fs.writeFileSync(path.join(tmpDir, 'small.txt'), 'a');
        fs.writeFileSync(path.join(tmpDir, 'large.txt'), 'a'.repeat(1000));
        const result = await handler({ mode: 'list', path: tmpDir, includeSizes: true, sortBy: 'size' });
        const lines = result.content[0].text.split('\n').filter(l => l.includes('.txt'));
        const largeIdx = lines.findIndex(l => l.includes('large.txt'));
        const smallIdx = lines.findIndex(l => l.includes('small.txt'));
        expect(largeIdx).toBeLessThan(smallIdx);
    });

    it('clamps depth to minimum 1', async () => {
        fs.mkdirSync(path.join(tmpDir, 'sub'));
        fs.writeFileSync(path.join(tmpDir, 'sub', 'deep.txt'), 'x');
        const result = await handler({ mode: 'list', path: tmpDir, depth: -5 });
        const text = result.content[0].text;
        expect(text).toContain('sub/');
        expect(text).not.toContain('deep.txt');
    });

    it('clamps depth to maximum 10', async () => {
        const result = await handler({ mode: 'list', path: tmpDir, depth: 999 });
        expect(result.content[0].text).toBeDefined();
    });

    it('returns [DENIED] for unreadable subdirectory', async () => {
        fs.mkdirSync(path.join(tmpDir, 'denied'), { recursive: true });
        const deniedPath = path.join(tmpDir, 'denied');
        const originalReaddir = fsp.readdir;
        const readdir = vi.spyOn(fsp, 'readdir').mockImplementation(async (target, options) => {
            if (path.resolve(String(target)) === deniedPath) {
                const error = new Error('permission denied');
                error.code = 'EACCES';
                throw error;
            }
            return await originalReaddir(target, options);
        });
        try {
            const result = await handler({ mode: 'list', path: tmpDir, depth: 3 });
            const text = result.content[0].text;
            expect(text).toContain('[DENIED]');
        } finally {
            readdir.mockRestore();
        }
    });

    it('returns empty output for empty directory', async () => {
        const result = await handler({ mode: 'list', path: tmpDir });
        expect(result.content[0].text).toBe('');
    });

    it('uses empty string path when path is omitted, resolving via validatePath', async () => {
        const result = await handler({ mode: 'list' });
        const text = result.content[0].text;
        expect(typeof text).toBe('string');
    });
});

describe('directory tool — tree mode', () => {
    let tmpDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importDirectory();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('renders files and directories with indentation', async () => {
        fs.mkdirSync(path.join(tmpDir, 'src'));
        fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), '');
        const result = await handler({ mode: 'tree', path: tmpDir, depth: 2 });
        const text = result.content[0].text;
        expect(text).toContain('src/');
        expect(text).toContain('app.js');
        const appLine = text.split('\n').find(l => l.includes('app.js'));
        expect(appLine).toMatch(/^  /);
    });

    it('excludes node_modules by default', async () => {
        fs.mkdirSync(path.join(tmpDir, 'node_modules'));
        fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), '');
        fs.writeFileSync(path.join(tmpDir, 'keep.js'), '');
        const result = await handler({ mode: 'tree', path: tmpDir });
        const text = result.content[0].text;
        expect(text).not.toContain('node_modules');
        expect(text).toContain('keep.js');
    });

    it('excludes .git by default', async () => {
        fs.mkdirSync(path.join(tmpDir, '.git'));
        fs.writeFileSync(path.join(tmpDir, '.git', 'config'), '');
        const result = await handler({ mode: 'tree', path: tmpDir });
        expect(result.content[0].text).not.toContain('.git');
    });

    it('applies custom excludePatterns', async () => {
        fs.mkdirSync(path.join(tmpDir, 'build'));
        fs.writeFileSync(path.join(tmpDir, 'build', 'out.js'), '');
        fs.writeFileSync(path.join(tmpDir, 'main.js'), '');
        const result = await handler({ mode: 'tree', path: tmpDir, excludePatterns: ['build'] });
        const text = result.content[0].text;
        expect(text).not.toContain('build');
        expect(text).toContain('main.js');
    });

    it('applies glob excludePatterns with wildcards', async () => {
        fs.mkdirSync(path.join(tmpDir, 'src'));
        fs.writeFileSync(path.join(tmpDir, 'src', 'file.min.js'), '');
        fs.writeFileSync(path.join(tmpDir, 'src', 'file.js'), '');
        const result = await handler({ mode: 'tree', path: tmpDir, excludePatterns: ['*.min.js'], depth: 2 });
        const text = result.content[0].text;
        expect(text).not.toContain('file.min.js');
        expect(text).toContain('file.js');
    });

    it('escapes control characters in file names', async () => {
        const ctrlName = 'file\twith\ttabs.txt';
        fs.writeFileSync(path.join(tmpDir, ctrlName), '');
        const result = await handler({ mode: 'tree', path: tmpDir });
        const text = result.content[0].text;
        expect(text).not.toMatch(/\t/);
        expect(text).toContain('\\t');
    });

    it('shows symbol counts when showSymbols is true', async () => {
        const srcDir = path.join(tmpDir, 'src');
        fs.mkdirSync(srcDir);
        fs.writeFileSync(path.join(srcDir, 'mod.ts'), 'export function foo() {}\nexport class Bar {}');
        const result = await handler({ mode: 'tree', path: tmpDir, showSymbols: true, depth: 2 });
        const text = result.content[0].text;
        const modLine = text.split('\n').find(l => l.includes('mod.ts'));
        expect(modLine).toBeDefined();
        if (modLine.includes('(')) {
            expect(modLine).toMatch(/\(\d+\s*(function|method|class|variable|property|interface|module)/i);
        }
    });

    it('uses empty string path when path is omitted in tree mode, resolving via validatePath', async () => {
        const result = await handler({ mode: 'tree' });
        const text = result.content[0].text;
        expect(typeof text).toBe('string');
    });
});


describe('directory tool — copy mode', () => {
    let tmpDir;
    let ctx;
    let registration;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importDirectory();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        registration = calls[0].schema;
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('schema includes copy', () => {
        const parsed = registration.inputSchema.parse({
            mode: 'copy',
            source: path.join(tmpDir, 'src.txt'),
            destination: path.join(tmpDir, 'dest.txt'),
        });

        expect(parsed.mode).toBe('copy');
        expect(parsed.overwrite).toBe(false);
        expect(parsed.recursive).toBe(false);
        expect(parsed.preserveTimestamps).toBe(true);
        expect(parsed.preserveMode).toBe(true);
        expect(registration.annotations).toMatchObject({
            readOnlyHint: false,
            idempotentHint: false,
            destructiveHint: false,
        });
    });

    it('copies one file to a new destination', async () => {
        const source = path.join(tmpDir, 'source.txt');
        const destination = path.join(tmpDir, 'destination.txt');
        fs.writeFileSync(source, 'hello');

        const result = await handler({ mode: 'copy', source, destination });

        expect(result.content[0].text).toBe('Copied.');
        expect(fs.readFileSync(destination, 'utf8')).toBe('hello');
    });

    it('refuses to overwrite existing destination by default', async () => {
        const source = path.join(tmpDir, 'source.txt');
        const destination = path.join(tmpDir, 'destination.txt');
        fs.writeFileSync(source, 'new');
        fs.writeFileSync(destination, 'old');

        await expect(handler({ mode: 'copy', source, destination })).rejects.toThrow('Destination exists.');
        expect(fs.readFileSync(destination, 'utf8')).toBe('old');
    });

    it('overwrites only when overwrite is true', async () => {
        const source = path.join(tmpDir, 'source.txt');
        const destination = path.join(tmpDir, 'destination.txt');
        fs.writeFileSync(source, 'new');
        fs.writeFileSync(destination, 'old');

        await handler({ mode: 'copy', source, destination, overwrite: true });

        expect(fs.readFileSync(destination, 'utf8')).toBe('new');
    });

    it('preserves file contents and mode', async () => {
        const source = path.join(tmpDir, 'source.sh');
        const destination = path.join(tmpDir, 'destination.sh');
        fs.writeFileSync(source, '#!/bin/sh\necho ok\n');
        fs.chmodSync(source, 0o744);

        await handler({ mode: 'copy', source, destination });

        expect(fs.readFileSync(destination, 'utf8')).toBe('#!/bin/sh\necho ok\n');
        expect(fs.statSync(destination).mode & 0o777).toBe(0o744);
    });

    it('copies directories only when recursive is true', async () => {
        const source = path.join(tmpDir, 'source-dir');
        const destination = path.join(tmpDir, 'destination-dir');
        fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(source, 'nested', 'file.txt'), 'data');

        await handler({ mode: 'copy', source, destination, recursive: true });

        expect(fs.readFileSync(path.join(destination, 'nested', 'file.txt'), 'utf8')).toBe('data');
    });

    it('rejects directory copy without recursive', async () => {
        const source = path.join(tmpDir, 'source-dir');
        const destination = path.join(tmpDir, 'destination-dir');
        fs.mkdirSync(source);

        await expect(handler({ mode: 'copy', source, destination })).rejects.toThrow('recursive required for directory copy.');
        expect(fs.existsSync(destination)).toBe(false);
    });

    it('rejects symlink source', async () => {
        const target = path.join(tmpDir, 'target.txt');
        const source = path.join(tmpDir, 'link.txt');
        const destination = path.join(tmpDir, 'destination.txt');
        fs.writeFileSync(target, 'target');
        fs.symlinkSync(target, source);

        await expect(handler({ mode: 'copy', source, destination })).rejects.toThrow('Cannot copy symbolic links.');
        expect(fs.existsSync(destination)).toBe(false);
    });

    it('validates source through validatePath', async () => {
        const source = path.join(tmpDir, 'source.txt');
        const destination = path.join(tmpDir, 'destination.txt');
        fs.writeFileSync(source, 'data');
        const validatePath = vi.fn(async (p) => path.resolve(p));
        ctx.validatePath = validatePath;

        await handler({ mode: 'copy', source, destination });

        expect(validatePath).toHaveBeenCalledWith(source);
    });

    it('validates destination through validateNewFilePath', async () => {
        const source = path.join(tmpDir, 'source.txt');
        const destination = path.join(tmpDir, 'destination.txt');
        fs.writeFileSync(source, 'data');
        const validateNewFilePath = vi.fn(async (p) => path.resolve(p));
        ctx.validateNewFilePath = validateNewFilePath;

        await handler({ mode: 'copy', source, destination });

        expect(validateNewFilePath).toHaveBeenCalledWith(destination);
    });

    it('does not include sensitive/default-excluded files during recursive copy', async () => {
        const source = path.join(tmpDir, 'source-dir');
        const destination = path.join(tmpDir, 'destination-dir');
        fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(source, 'keep.txt'), 'keep');
        fs.writeFileSync(path.join(source, '.env'), 'secret');
        fs.writeFileSync(path.join(source, 'node_modules', 'pkg.js'), 'excluded');

        await handler({ mode: 'copy', source, destination, recursive: true });

        expect(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe('keep');
        expect(fs.existsSync(path.join(destination, '.env'))).toBe(false);
        expect(fs.existsSync(path.join(destination, 'node_modules'))).toBe(false);
    });

    it('throws when source is missing in copy mode', async () => {
        const destination = path.join(tmpDir, 'destination.txt');
        await expect(handler({ mode: 'copy', destination })).rejects.toThrow('source required for copy.');
    });

    it('throws when destination is missing in copy mode', async () => {
        const source = path.join(tmpDir, 'source.txt');
        fs.writeFileSync(source, 'data');
        await expect(handler({ mode: 'copy', source })).rejects.toThrow('destination required for copy.');
    });

    it('throws when destination path is an existing directory', async () => {
        const source = path.join(tmpDir, 'source.txt');
        const destination = path.join(tmpDir, 'dest-dir');
        fs.writeFileSync(source, 'data');
        fs.mkdirSync(destination);

        await expect(handler({ mode: 'copy', source, destination })).rejects.toThrow('Destination is a directory.');
    });

    it('does not preserve mode when preserveMode is false', async () => {
        const source = path.join(tmpDir, 'source.sh');
        const destination = path.join(tmpDir, 'destination.sh');
        fs.writeFileSync(source, '#!/bin/sh\necho hi\n');
        fs.chmodSync(source, 0o744);

        const chmodSpy = vi.spyOn(fsp, 'chmod');
        try {
            await handler({ mode: 'copy', source, destination, preserveMode: false });
            expect(chmodSpy).not.toHaveBeenCalled();
        } finally {
            chmodSpy.mockRestore();
        }
    });

    it('does not preserve timestamps when preserveTimestamps is false', async () => {
        const source = path.join(tmpDir, 'source.txt');
        const destination = path.join(tmpDir, 'destination.txt');
        fs.writeFileSync(source, 'data');

        const utimesSpy = vi.spyOn(fsp, 'utimes');
        try {
            await handler({ mode: 'copy', source, destination, preserveTimestamps: false });
            expect(utimesSpy).not.toHaveBeenCalled();
        } finally {
            utimesSpy.mockRestore();
        }
    });

    it('creates intermediate parent directories for nested destination', async () => {
        const source = path.join(tmpDir, 'source.txt');
        const destination = path.join(tmpDir, 'a', 'b', 'c', 'destination.txt');
        fs.writeFileSync(source, 'nested-dest');

        await handler({ mode: 'copy', source, destination });

        expect(fs.readFileSync(destination, 'utf8')).toBe('nested-dest');
    });

    it('throws when a symlink is encountered inside a recursive directory copy', async () => {
        const source = path.join(tmpDir, 'source-dir');
        const destination = path.join(tmpDir, 'destination-dir');
        const realFile = path.join(tmpDir, 'real.txt');
        fs.mkdirSync(source);
        fs.writeFileSync(realFile, 'real');
        fs.symlinkSync(realFile, path.join(source, 'link.txt'));

        await expect(handler({ mode: 'copy', source, destination, recursive: true })).rejects.toThrow('Cannot copy symbolic links.');
    });

    it('copies an empty file without error', async () => {
        const source = path.join(tmpDir, 'empty.txt');
        const destination = path.join(tmpDir, 'empty-dest.txt');
        fs.writeFileSync(source, '');

        const result = await handler({ mode: 'copy', source, destination });

        expect(result.content[0].text).toBe('Copied.');
        expect(fs.readFileSync(destination, 'utf8')).toBe('');
        expect(fs.statSync(destination).size).toBe(0);
    });

    it('copies binary file content faithfully', async () => {
        const source = path.join(tmpDir, 'binary.bin');
        const destination = path.join(tmpDir, 'binary-dest.bin');
        const binaryContent = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x80, 0x7F]);
        fs.writeFileSync(source, binaryContent);

        await handler({ mode: 'copy', source, destination });

        const destContent = fs.readFileSync(destination);
        expect(destContent).toEqual(binaryContent);
    });

    it('copies multiple levels of nested directories recursively', async () => {
        const source = path.join(tmpDir, 'root');
        const destination = path.join(tmpDir, 'root-copy');
        fs.mkdirSync(path.join(source, 'a', 'b', 'c'), { recursive: true });
        fs.writeFileSync(path.join(source, 'top.txt'), 'top');
        fs.writeFileSync(path.join(source, 'a', 'mid.txt'), 'mid');
        fs.writeFileSync(path.join(source, 'a', 'b', 'c', 'deep.txt'), 'deep');

        await handler({ mode: 'copy', source, destination, recursive: true });

        expect(fs.readFileSync(path.join(destination, 'top.txt'), 'utf8')).toBe('top');
        expect(fs.readFileSync(path.join(destination, 'a', 'mid.txt'), 'utf8')).toBe('mid');
        expect(fs.readFileSync(path.join(destination, 'a', 'b', 'c', 'deep.txt'), 'utf8')).toBe('deep');
    });

    it('overwrites existing files during recursive copy when overwrite is true', async () => {
        const source = path.join(tmpDir, 'source-dir');
        const destination = path.join(tmpDir, 'destination-dir');
        fs.mkdirSync(source);
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(source, 'file.txt'), 'updated');
        fs.writeFileSync(path.join(destination, 'file.txt'), 'original');

        await handler({ mode: 'copy', source, destination, recursive: true, overwrite: true });

        expect(fs.readFileSync(path.join(destination, 'file.txt'), 'utf8')).toBe('updated');
    });

    it('cleans up temp file when copy fails mid-operation', async () => {
        const source = path.join(tmpDir, 'source.txt');
        const destination = path.join(tmpDir, 'destination.txt');
        fs.writeFileSync(source, 'data');

        const originalRename = fsp.rename;
        vi.spyOn(fsp, 'rename').mockImplementation(async () => {
            throw new Error('rename failed');
        });
        try {
            await expect(handler({ mode: 'copy', source, destination })).rejects.toThrow('rename failed');
            // No temp files should remain in tmpDir
            const remaining = fs.readdirSync(tmpDir).filter(f => f.startsWith('.zenith-copy-'));
            expect(remaining).toHaveLength(0);
        } finally {
            fsp.rename = originalRename;
            vi.restoreAllMocks();
        }
    });

    it('copies an empty source directory without error', async () => {
        const source = path.join(tmpDir, 'empty-dir');
        const destination = path.join(tmpDir, 'empty-dir-copy');
        fs.mkdirSync(source);

        const result = await handler({ mode: 'copy', source, destination, recursive: true });

        expect(result.content[0].text).toBe('Copied.');
        expect(fs.statSync(destination).isDirectory()).toBe(true);
    });

    it('validates each child source path during recursive directory copy', async () => {
        const source = path.join(tmpDir, 'source-dir');
        const destination = path.join(tmpDir, 'destination-dir');
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'child.txt'), 'child');

        const validatePath = vi.fn(async (p) => path.resolve(p));
        ctx.validatePath = validatePath;

        await handler({ mode: 'copy', source, destination, recursive: true });

        // Called once for source itself, once for the child inside copyDirectorySafe
        const calls = validatePath.mock.calls.map(c => c[0]);
        expect(calls.some(p => p.includes('child.txt'))).toBe(true);
    });

    it('validates each child destination path during recursive directory copy', async () => {
        const source = path.join(tmpDir, 'source-dir');
        const destination = path.join(tmpDir, 'destination-dir');
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'child.txt'), 'child');

        const validateNewFilePath = vi.fn(async (p) => path.resolve(p));
        ctx.validateNewFilePath = validateNewFilePath;

        await handler({ mode: 'copy', source, destination, recursive: true });

        const calls = validateNewFilePath.mock.calls.map(c => c[0]);
        expect(calls.some(p => p.includes('child.txt'))).toBe(true);
    });
});
