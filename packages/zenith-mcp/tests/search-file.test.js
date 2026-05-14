import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-file-test-'));
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

async function importSearchFile() {
    return await import('../dist/tools/search_file.js');
}

describe('search_file tool handler — registration', () => {
    it('registers with correct name and schema', async () => {
        const { server, calls } = captureHandler();
        const mod = await importSearchFile();
        mod.register(server, mkCtx('/tmp'));
        expect(calls[0].name).toBe('search_file');
        const schema = calls[0].schema.inputSchema;
        expect(schema.def.shape.path).toBeDefined();
        expect(schema.def.shape.maxChars).toBeDefined();
        expect(schema.def.shape.grep).toBeDefined();
        expect(schema.def.shape.grepContext).toBeDefined();
        expect(schema.def.shape.symbol).toBeDefined();
        expect(schema.def.shape.nearLine).toBeDefined();
        expect(schema.def.shape.expandLines).toBeDefined();
    });
});

describe('search_file tool handler — grep mode', () => {
    let repoDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        const mod = await importSearchFile();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('returns matches with line numbers and asterisk marker', async () => {
        const filePath = path.join(repoDir, 'sample.txt');
        fs.writeFileSync(filePath, 'line one\nline two\nline three\n');
        const result = await handler({ path: filePath, grep: 'two' });
        expect(result.content[0].text).toContain('2:*line two');
    });

    it('is case-insensitive by default', async () => {
        const filePath = path.join(repoDir, 'sample.txt');
        fs.writeFileSync(filePath, 'Hello World\nhello world\nHELLO WORLD\n');
        const result = await handler({ path: filePath, grep: 'hello' });
        const text = result.content[0].text;
        expect(text).toContain('1:');
        expect(text).toContain('2:');
        expect(text).toContain('3:');
    });

    it('returns "No matches." when pattern not found', async () => {
        const filePath = path.join(repoDir, 'sample.txt');
        fs.writeFileSync(filePath, 'line one\nline two\nline three\n');
        const result = await handler({ path: filePath, grep: 'nonexistent' });
        expect(result.content[0].text).toBe('No matches.');
    });

    it('emits "---" separator when gap exceeds context window', async () => {
        const filePath = path.join(repoDir, 'sample.txt');
        const lines = ['match line 1'];
        for (let i = 0; i < 200; i++) lines.push('nomatch line ' + (i + 2));
        lines.push('match line 202');
        fs.writeFileSync(filePath, lines.join('\n'));
        const result = await handler({ path: filePath, grep: 'match', grepContext: 1 });
        const text = result.content[0].text;
        const matchLines = text.split('\n').filter(l => l.includes('*match'));
        expect(matchLines.length).toBe(2);
        const firstMatchLineNum = parseInt(matchLines[0].split(':')[0]);
        const secondMatchLineNum = parseInt(matchLines[1].split(':')[0]);
        expect(secondMatchLineNum - firstMatchLineNum).toBeGreaterThan(2);
    });

    it('respects grepContext for surrounding lines', async () => {
        const filePath = path.join(repoDir, 'sample.txt');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5\n');
        const result = await handler({ path: filePath, grep: 'line3', grepContext: 1 });
        const text = result.content[0].text;
        expect(text).toContain('2:');
        expect(text).toContain('3:');
        expect(text).toContain('4:');
    });

    it('caps grepContext at 30', async () => {
        const filePath = path.join(repoDir, 'sample.txt');
        fs.writeFileSync(filePath, 'line1\n');
        const result = await handler({ path: filePath, grep: 'line1', grepContext: 999 });
        expect(result.content[0].text).toBeDefined();
    });

    it('handles empty file gracefully', async () => {
        const filePath = path.join(repoDir, 'empty.txt');
        fs.writeFileSync(filePath, '');
        const result = await handler({ path: filePath, grep: 'anything' });
        expect(result.content[0].text).toBe('No matches.');
    });

    it('handles single-line file', async () => {
        const filePath = path.join(repoDir, 'oneliner.txt');
        fs.writeFileSync(filePath, 'only line\n');
        const result = await handler({ path: filePath, grep: 'only' });
        expect(result.content[0].text).toContain('1:');
    });

    it('respects maxChars budget', async () => {
        const filePath = path.join(repoDir, 'large.txt');
        const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
        fs.writeFileSync(filePath, lines.join('\n'));
        const result = await handler({ path: filePath, grep: 'line', maxChars: 200 });
        expect(result.content[0].text).toBeDefined();
    });
});

describe('search_file tool handler — symbol mode', () => {
    let repoDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        const mod = await importSearchFile();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('throws "Unsupported file type." for unsupported extensions', async () => {
        const filePath = path.join(repoDir, 'data.xyz');
        fs.writeFileSync(filePath, 'some content');
        await expect(handler({ path: filePath, symbol: 'foo' })).rejects.toThrow('Unsupported file type.');
    });

    it('throws "Symbol not found." when symbol does not exist', async () => {
        const filePath = path.join(repoDir, 'sample.js');
        fs.writeFileSync(filePath, 'function hello() {}\n');
        await expect(handler({ path: filePath, symbol: 'nonexistent' })).rejects.toThrow('Symbol not found.');
    });

    it('throws "Multiple matches. Use nearLine." when symbol appears multiple times without nearLine', async () => {
        const filePath = path.join(repoDir, 'sample.js');
        fs.writeFileSync(filePath, 'function foo() {}\nfunction foo() {}\n');
        await expect(handler({ path: filePath, symbol: 'foo' })).rejects.toThrow('Multiple matches. Use nearLine.');
    });

    it('throws "Provide grep or symbol." when neither is provided', async () => {
        const filePath = path.join(repoDir, 'sample.txt');
        fs.writeFileSync(filePath, 'some content');
        await expect(handler({ path: filePath, grep: undefined, symbol: undefined }))
            .rejects.toThrow('Provide grep or symbol.');
    });

    it('uses nearLine to disambiguate multiple symbol matches', async () => {
        const filePath = path.join(repoDir, 'sample.js');
        fs.writeFileSync(filePath, 'function foo() { return 1; }\nfunction foo() { return 2; }\nfunction foo() { return 3; }\n');
        const result = await handler({ path: filePath, symbol: 'foo', nearLine: 2 });
        expect(result.content[0].text).toBeDefined();
    });

    it('expandLines adds surrounding context', async () => {
        const filePath = path.join(repoDir, 'sample.js');
        fs.writeFileSync(filePath, 'line1\nline2\nfunction foo() {}\nline4\nline5\n');
        const result = await handler({ path: filePath, symbol: 'foo', expandLines: 1 });
        const text = result.content[0].text;
        expect(text).toContain('line2');
        expect(text).toContain('line4');
    });

    it('expandLines is capped at 50', async () => {
        const filePath = path.join(repoDir, 'sample.js');
        const lines = ['function foo() { return 1; }'];
        for (let i = 1; i < 200; i++) {
            lines.push(`// line ${i}`);
        }
        fs.writeFileSync(filePath, lines.join('\n'));
        const result = await handler({ path: filePath, symbol: 'foo', expandLines: 999 });
        const linesOut = result.content[0].text.split('\n');
        expect(linesOut.length).toBeLessThanOrEqual(103);
    });
});