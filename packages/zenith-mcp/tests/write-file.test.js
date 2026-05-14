import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-test-'));
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
    };
}

async function importWriteFile() {
    return await import('../dist/tools/write_file.js');
}

describe('write_file findResumeOffset (internal logic via append)', () => {
    let repoDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        const mod = await importWriteFile();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('creates a new file and returns "File written."', async () => {
        const filePath = path.join(repoDir, 'newfile.txt');
        const result = await handler({ path: filePath, content: 'hello world' });
        expect(result.content[0].text).toBe('File written.');
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
    });

    it('overwrites existing file and returns "File updated."', async () => {
        const filePath = path.join(repoDir, 'existing.txt');
        fs.writeFileSync(filePath, 'old content');
        const result = await handler({ path: filePath, content: 'new content' });
        expect(result.content[0].text).toBe('File updated.');
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
    });

    it('throws when failIfExists is true and file exists', async () => {
        const filePath = path.join(repoDir, 'exists.txt');
        fs.writeFileSync(filePath, 'data');
        await expect(handler({ path: filePath, content: 'x', failIfExists: true }))
            .rejects.toThrow('File already exists');
    });

    it('succeeds when failIfExists is true and file does not exist', async () => {
        const filePath = path.join(repoDir, 'notexists.txt');
        const result = await handler({ path: filePath, content: 'fresh', failIfExists: true });
        expect(result.content[0].text).toBe('File written.');
    });

    it('appends to existing file', async () => {
        const filePath = path.join(repoDir, 'append.txt');
        fs.writeFileSync(filePath, 'line1\nline2\n');
        const result = await handler({ path: filePath, content: 'line3\nline4\n', append: true });
        expect(result.content[0].text).toBe('Content appended.');
        const written = fs.readFileSync(filePath, 'utf-8');
        expect(written).toContain('line1');
        expect(written).toContain('line3');
    });

    // BUG: findResumeOffset fails to detect overlap when existing file ends with \n
    // because split('\n') produces a trailing empty string '' that breaks the line comparison.
    // The overlap check compares existingLines[1+2]='' with incomingLines[2]='ddd' which fails,
    // causing the entire incoming content to be appended without overlap detection.
    it('overlap detection fails when existing file ends with newline (BUG)', async () => {
        const filePath = path.join(repoDir, 'overlap.txt');
        fs.writeFileSync(filePath, 'aaa\nbbb\nccc\n');
        const result = await handler({
            path: filePath,
            content: 'bbb\nccc\nddd\neee\n',
            append: true,
        });
        expect(result.content[0].text).toBe('Content appended.');
        const written = fs.readFileSync(filePath, 'utf-8');
        expect(written).toContain('aaa');
        expect(written).toContain('ddd');
        expect(written).toContain('eee');
        // BUG: overlap detection fails, so bbb and ccc are duplicated
        const bbbCount = (written.match(/bbb/g) || []).length;
        expect(bbbCount).toBe(2); // should be 1 if overlap detection worked
    });

    it('creates parent directories automatically', async () => {
        const filePath = path.join(repoDir, 'deep', 'nested', 'file.txt');
        const result = await handler({ path: filePath, content: 'deep content' });
        expect(result.content[0].text).toBe('File written.');
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('deep content');
    });

    it('normalizes CRLF to LF on write', async () => {
        const filePath = path.join(repoDir, 'crlf.txt');
        await handler({ path: filePath, content: 'line1\r\nline2\r\n' });
        const written = fs.readFileSync(filePath, 'utf-8');
        expect(written).not.toContain('\r\n');
        expect(written).toBe('line1\nline2\n');
    });

    it('appends without overlap when content is entirely new', async () => {
        const filePath = path.join(repoDir, 'nooverlap.txt');
        fs.writeFileSync(filePath, 'alpha\nbeta\n');
        await handler({ path: filePath, content: 'gamma\ndelta\n', append: true });
        const written = fs.readFileSync(filePath, 'utf-8');
        expect(written).toContain('alpha');
        expect(written).toContain('gamma');
    });

    it('appends to empty-ish file', async () => {
        const filePath = path.join(repoDir, 'empty_append.txt');
        fs.writeFileSync(filePath, '');
        const result = await handler({ path: filePath, content: 'first line\n', append: true });
        expect(result.content[0].text).toBe('Content appended.');
        expect(fs.readFileSync(filePath, 'utf-8')).toContain('first line');
    });
});

describe('write_file registration', () => {
    it('registers with correct name and schema', async () => {
        const { server, calls } = captureHandler();
        const mod = await importWriteFile();
        mod.register(server, mkTmpGitRepo() && mkCtx('/tmp'));
        expect(calls[0].name).toBe('write_file');
        const schema = calls[0].schema;
        expect(schema.inputSchema.path).toBeDefined();
        expect(schema.inputSchema.content).toBeDefined();
    });
});
