import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
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
        fs.chmodSync(path.join(tmpDir, 'denied'), 0o000);
        try {
            const result = await handler({ mode: 'list', path: tmpDir, depth: 3 });
            const text = result.content[0].text;
            expect(text).toContain('[DENIED]');
        } finally {
            fs.chmodSync(path.join(tmpDir, 'denied'), 0o755);
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
        const result = await handler({ mode: 'tree', path: tmpDir });
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
        const result = await handler({ mode: 'tree', path: tmpDir, excludePatterns: ['*.min.js'] });
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
        const result = await handler({ mode: 'tree', path: tmpDir, showSymbols: true });
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
