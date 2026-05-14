import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rmf-test-'));
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

function mkCtx(allowedDir) {
    return {
        validatePath: async (p) => path.resolve(p),
        getAllowedDirectories: () => [allowedDir],
    };
}

async function importModule() {
    return await import('../dist/tools/read_multiple_files.js');
}

function makeFile(dir, name, content) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
}

describe('read_multiple_files', () => {
    let tmpDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importModule();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    describe('registration', () => {
        it('registers with name "read_multiple_files"', async () => {
            const { server, calls } = captureHandler();
            const mod = await importModule();
            mod.register(server, mkCtx(tmpDir));
            expect(calls[0].name).toBe('read_multiple_files');
        });

        it('has readOnlyHint annotation', async () => {
            const { server, calls } = captureHandler();
            const mod = await importModule();
            mod.register(server, mkCtx(tmpDir));
            expect(calls[0].schema.annotations.readOnlyHint).toBe(true);
        });
    });

    describe('happy path', () => {
        it('reads a single file', async () => {
            const fp = makeFile(tmpDir, 'a.txt', 'hello world');
            const result = await handler({ paths: [fp], compression: false });
            const text = result.content[0].text;
            expect(text).toContain('hello world');
        });

        it('reads multiple files and joins with double newline', async () => {
            const f1 = makeFile(tmpDir, 'a.txt', 'aaa');
            const f2 = makeFile(tmpDir, 'b.txt', 'bbb');
            const result = await handler({ paths: [f1, f2], compression: false });
            const text = result.content[0].text;
            expect(text).toContain('aaa');
            expect(text).toContain('bbb');
            expect(text).toContain('\n\n');
        });

        it('returns { type: "text", text: ... } content array', async () => {
            const fp = makeFile(tmpDir, 'x.txt', 'data');
            const result = await handler({ paths: [fp], compression: false });
            expect(result.content).toHaveLength(1);
            expect(result.content[0].type).toBe('text');
            expect(typeof result.content[0].text).toBe('string');
        });
    });

    describe('showLineNumbers', () => {
        it('prefixes each line with "N:" when showLineNumbers is true', async () => {
            const fp = makeFile(tmpDir, 'lines.txt', 'alpha\nbeta\ngamma');
            const result = await handler({ paths: [fp], showLineNumbers: true });
            const text = result.content[0].text;
            expect(text).toContain('1:alpha');
            expect(text).toContain('2:beta');
            expect(text).toContain('3:gamma');
        });

        it('does not prefix lines when showLineNumbers is false', async () => {
            const fp = makeFile(tmpDir, 'raw.txt', 'aaa\nbbb');
            const result = await handler({ paths: [fp], showLineNumbers: false, compression: false });
            const text = result.content[0].text;
            expect(text).toContain('aaa\nbbb');
        });
    });

    describe('compression', () => {
        it('returns raw content when compression is false', async () => {
            const content = 'a'.repeat(2000);
            const fp = makeFile(tmpDir, 'big.txt', content);
            const result = await handler({ paths: [fp], compression: false });
            const text = result.content[0].text;
            expect(text).toContain(content);
        });

        it('compresses by default and returns entry with label prefix', async () => {
            const content = 'a'.repeat(2000);
            const fp = makeFile(tmpDir, 'big.txt', content);
            const result = await handler({ paths: [fp] });
            const text = result.content[0].text;
            expect(text).toContain('- big.txt');
        });
    });

    describe('maxCharsPerFile', () => {
        it('limits per-file output when maxCharsPerFile is set', async () => {
            const content = 'x'.repeat(10000);
            const fp = makeFile(tmpDir, 'huge.txt', content);
            const result = await handler({ paths: [fp], maxCharsPerFile: 500, compression: false });
            const text = result.content[0].text;
            const dataPortion = text.split('\n').slice(1).join('\n');
            expect(dataPortion.length).toBeLessThanOrEqual(600);
        });
    });

    describe('error paths', () => {
        it('returns ERROR for a nonexistent file', async () => {
            const bad = path.join(tmpDir, 'does_not_exist.txt');
            const result = await handler({ paths: [bad] });
            expect(result.content[0].text).toContain('ERROR');
        });

        it('returns ERROR for a denied file (validatePath throws)', async () => {
            const badCtx = {
                validatePath: async () => { throw new Error('Access denied'); },
                getAllowedDirectories: () => [tmpDir],
            };
            const mod = await importModule();
            const { server, calls } = captureHandler();
            mod.register(server, badCtx);
            const h = calls[0].handler;
            const result = await h({ paths: ['/etc/shadow'] });
            expect(result.content[0].text).toContain('ERROR');
            expect(result.content[0].text).toContain('Access denied');
        });

        it('succeeds for some files and reports errors for others', async () => {
            const good = makeFile(tmpDir, 'ok.txt', 'good');
            const bad = path.join(tmpDir, 'missing.txt');
            const result = await handler({ paths: [good, bad], compression: false });
            const text = result.content[0].text;
            expect(text).toContain('good');
            expect(text).toContain('ERROR');
        });
    });

    describe('boundary values', () => {
        it('handles a single path (min boundary)', async () => {
            const fp = makeFile(tmpDir, 'single.txt', 'one');
            const result = await handler({ paths: [fp], compression: false });
            expect(result.content[0].text).toContain('one');
        });

        it('handles an empty file', async () => {
            const fp = makeFile(tmpDir, 'empty.txt', '');
            const result = await handler({ paths: [fp] });
            expect(result.content).toHaveLength(1);
        });
    });

    describe('file label', () => {
        it('includes the basename as a label prefixed with "- "', async () => {
            const fp = makeFile(tmpDir, 'mydoc.txt', 'stuff');
            const result = await handler({ paths: [fp], compression: false });
            expect(result.content[0].text).toContain('- mydoc.txt');
        });
    });
});
