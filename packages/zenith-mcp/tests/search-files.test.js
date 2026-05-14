import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-files-test-'));
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

function mkCtx(baseDir) {
    return {
        validatePath: async (p) => path.resolve(p),
        getAllowedDirectories: () => [baseDir],
    };
}

async function importSearchFiles() {
    return await import('../dist/tools/search_files.js');
}

describe('search_files tool — files mode', () => {
    let repoDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        const mod = await importSearchFiles();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('finds files matching a glob pattern', async () => {
        fs.mkdirSync(path.join(repoDir, 'src'));
        fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), '');
        fs.writeFileSync(path.join(repoDir, 'src', 'util.ts'), '');
        fs.writeFileSync(path.join(repoDir, 'readme.md'), '');
        const result = await handler({ mode: 'files', path: repoDir, pattern: '**/*.ts' });
        const text = result.content[0].text;
        expect(text).toContain('app.ts');
        expect(text).toContain('util.ts');
        expect(text).not.toContain('readme.md');
    });

    it('filters by extension', async () => {
        fs.writeFileSync(path.join(repoDir, 'a.ts'), '');
        fs.writeFileSync(path.join(repoDir, 'b.js'), '');
        const result = await handler({ mode: 'files', path: repoDir, extensions: ['.ts'] });
        const text = result.content[0].text;
        expect(text).toContain('a.ts');
        expect(text).not.toContain('b.js');
    });

    it('filters by pathContains substring', async () => {
        fs.mkdirSync(path.join(repoDir, 'src'));
        fs.mkdirSync(path.join(repoDir, 'test'));
        fs.writeFileSync(path.join(repoDir, 'src', 'mod.ts'), '');
        fs.writeFileSync(path.join(repoDir, 'test', 'mod.ts'), '');
        const result = await handler({ mode: 'files', path: repoDir, pathContains: 'src' });
        const text = result.content[0].text;
        expect(text).toContain('src/mod.ts');
        expect(text).not.toContain('test/mod.ts');
    });

    it('excludes default directories like node_modules', async () => {
        fs.mkdirSync(path.join(repoDir, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'node_modules', 'pkg.js'), '');
        fs.writeFileSync(path.join(repoDir, 'keep.txt'), '');
        const result = await handler({ mode: 'files', path: repoDir });
        const text = result.content[0].text;
        expect(text).not.toContain('node_modules');
        expect(text).toContain('keep.txt');
    });

    it('includes metadata when includeMetadata is true', async () => {
        fs.writeFileSync(path.join(repoDir, 'data.txt'), 'hello world');
        const result = await handler({ mode: 'files', path: repoDir, includeMetadata: true });
        const text = result.content[0].text;
        expect(text).toMatch(/\d+(\.\d+)?KB/);
        expect(text).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('returns No files found. for empty directory', async () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
        const result = await handler({ mode: 'files', path: emptyDir });
        expect(result.content[0].text).toBe('No files found.');
        fs.rmSync(emptyDir, { recursive: true, force: true });
    });

    it('respects maxResults', async () => {
        for (let i = 0; i < 10; i++) {
            fs.writeFileSync(path.join(repoDir, `file${i}.txt`), '');
        }
        const result = await handler({ mode: 'files', path: repoDir, maxResults: 3 });
        const lines = result.content[0].text.split('\n').filter(l => l.trim());
        expect(lines.length).toBeLessThanOrEqual(3);
    });
});

describe('search_files tool — content mode', () => {
    let repoDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        const mod = await importSearchFiles();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('finds content matching a regex query', async () => {
        fs.writeFileSync(path.join(repoDir, 'code.ts'), 'function hello() {}\nfunction world() {}');
        const result = await handler({ mode: 'content', path: repoDir, contentQuery: 'hello' });
        const text = result.content[0].text;
        expect(text).toContain('hello');
    });

    it('returns No matches. when content not found', async () => {
        fs.writeFileSync(path.join(repoDir, 'code.ts'), 'function hello() {}');
        const result = await handler({ mode: 'content', path: repoDir, contentQuery: 'nonexistent_xyz' });
        expect(result.content[0].text).toBe('No matches.');
    });

    it('supports literal search', async () => {
        fs.writeFileSync(path.join(repoDir, 'data.txt'), 'price: 10.00\nprice: 20.00');
        const result = await handler({ mode: 'content', path: repoDir, contentQuery: '10.00', literalSearch: true });
        const text = result.content[0].text;
        expect(text).toContain('10.00');
    });

    it('returns countOnly format when requested', async () => {
        fs.writeFileSync(path.join(repoDir, 'a.txt'), 'foo bar baz\nfoo qux');
        const result = await handler({ mode: 'content', path: repoDir, contentQuery: 'foo', countOnly: true });
        const text = result.content[0].text;
        expect(text).toMatch(/^matches: \d+\nfiles: \d+$/);
    });

    it('searches case-insensitively by default', async () => {
        fs.writeFileSync(path.join(repoDir, 'case.txt'), 'HELLO world');
        const result = await handler({ mode: 'content', path: repoDir, contentQuery: 'hello' });
        const text = result.content[0].text;
        expect(text).toContain('HELLO');
    });

    it('finds content across files matching query', async () => {
        fs.mkdirSync(path.join(repoDir, 'src'));
        fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'searchterm');
        fs.writeFileSync(path.join(repoDir, 'other.txt'), 'searchterm');
        const result = await handler({ mode: 'content', path: repoDir, contentQuery: 'searchterm' });
        const text = result.content[0].text;
        expect(text).toContain('app.ts');
        expect(text).toContain('other.txt');
    });
});
