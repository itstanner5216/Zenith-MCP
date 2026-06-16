import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Compression-module mock. By default it delegates to the REAL compressForTool so
// every existing test keeps observing real behavior. The boundary test below installs
// a temporary override (compressOverride) to spy on whether the compression gate is
// entered for a file whose size === byteLimit. The hoisted holder keeps state the
// hoisted vi.mock factory can read.
const compHolder = vi.hoisted(() => ({ override: null }));
vi.mock('../dist/core/compression.js', async (importActual) => {
    const actual = await importActual();
    return {
        ...actual,
        compressForTool: (...args) =>
            compHolder.override ? compHolder.override(...args) : actual.compressForTool(...args),
    };
});

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

    describe('line numbering (Rule 10: mandatory, no opt-out)', () => {
        it('ALWAYS prefixes each line with "N:" — there is no way to disable', async () => {
            // Rule 10: line numbers are MANDATORY structural metadata. The showLineNumbers
            // opt-out was removed; numbering is unconditional. (Previously this passed
            // `showLineNumbers: true`; the param no longer exists.)
            const fp = makeFile(tmpDir, 'lines.txt', 'alpha\nbeta\ngamma');
            const result = await handler({ paths: [fp], compression: false });
            const text = result.content[0].text;
            expect(text).toContain('1:alpha');
            expect(text).toContain('2:beta');
            expect(text).toContain('3:gamma');
        });

        it('still line-numbers output even when raw (uncompressed) content is requested', async () => {
            // Rule 10: line numbering cannot be turned off. This case used to assert
            // showLineNumbers:false produced raw, unprefixed lines ("aaa\nbbb") — that
            // encoded Rule-10-FORBIDDEN behavior (the anti-pattern table explicitly bans a
            // showLineNumbers toggle), so it now asserts the mandatory "N:" prefixes.
            const fp = makeFile(tmpDir, 'raw.txt', 'aaa\nbbb');
            const result = await handler({ paths: [fp], compression: false });
            const text = result.content[0].text;
            expect(text).toContain('1:aaa');
            expect(text).toContain('2:bbb');
            // And the raw, unprefixed body must NOT appear.
            expect(text).not.toContain('aaa\nbbb');
        });
    });

    describe('schema strictness (Rule 9: all schemas strict)', () => {
        it('rejects an unknown key via .strict()', async () => {
            // Rule 9: the inputSchema is .strict(), so unknown top-level keys (including the
            // removed showLineNumbers opt-out) are rejected rather than silently ignored.
            const { server, calls } = captureHandler();
            const mod = await importModule();
            mod.register(server, mkCtx(tmpDir));
            const inputSchema = calls[0].schema.inputSchema;

            const ok = inputSchema.safeParse({ paths: ['/tmp/x'] });
            expect(ok.success).toBe(true);

            // The removed opt-out param is now an unknown key → rejected.
            const bad = inputSchema.safeParse({ paths: ['/tmp/x'], showLineNumbers: true });
            expect(bad.success).toBe(false);

            const bad2 = inputSchema.safeParse({ paths: ['/tmp/x'], totallyUnknownKey: 1 });
            expect(bad2.success).toBe(false);
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

        // [DD] boundary: a fully-captured file whose size EXACTLY equals byteLimit must
        // still enter the compression path. byteLimit = perFileBudget * 4, and with
        // maxCharsPerFile the per-file budget is fixed, so byteLimit is deterministic.
        //
        // FAIL-BEFORE: the old gate `bytesRead < byteLimit` is FALSE when bytesRead ===
        //   byteLimit (the buffer is exactly filled by the whole file), so compression is
        //   SKIPPED and the spy is never called.
        // PASS-AFTER: the new gate `fileInfo.size <= byteLimit` is TRUE, so compressForTool
        //   IS called and its verbatim return is emitted.
        it('still compresses a file whose size exactly equals byteLimit', async () => {
            const M = 100;                 // maxCharsPerFile → perFileBudget = 100
            const byteLimit = M * 4;       // = 400
            const content = 'a'.repeat(byteLimit); // file size === byteLimit exactly
            const fp = makeFile(tmpDir, 'bound.txt', content);
            expect(fs.statSync(fp).size).toBe(byteLimit);

            const spy = vi.fn(() => 'COMPRESSED_SENTINEL');
            compHolder.override = spy;
            try {
                const result = await handler({ paths: [fp], maxCharsPerFile: M });
                const text = result.content[0].text;
                // Gate was entered: compressForTool ran and its output was emitted verbatim.
                expect(spy).toHaveBeenCalledTimes(1);
                expect(text).toContain('COMPRESSED_SENTINEL');
            } finally {
                compHolder.override = null;
            }
        });

        // Control for the boundary: a file ONE byte OVER the cap (size > byteLimit) is a
        // partial window and must SKIP compression in both old and new code, proving the
        // gate is genuinely size-bounded rather than always-on.
        it('skips compression when size exceeds byteLimit (partial window)', async () => {
            const M = 100;
            const byteLimit = M * 4;       // = 400
            const content = 'a'.repeat(byteLimit + 1); // 401 bytes > cap
            const fp = makeFile(tmpDir, 'over.txt', content);

            const spy = vi.fn(() => 'COMPRESSED_SENTINEL');
            compHolder.override = spy;
            try {
                const result = await handler({ paths: [fp], maxCharsPerFile: M });
                const text = result.content[0].text;
                expect(spy).not.toHaveBeenCalled();
                expect(text).not.toContain('COMPRESSED_SENTINEL');
            } finally {
                compHolder.override = null;
            }
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
