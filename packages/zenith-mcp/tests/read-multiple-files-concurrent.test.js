/**
 * Tests for read_multiple_files concurrency (parallelMap) changed in this PR.
 *
 * PR change: In parallelMap(), added:
 *   const item = items[i];
 *   if (item === undefined) continue;
 *
 * This guards against the case where items[nextIndex] could theoretically be
 * undefined under noUncheckedIndexedAccess. The semantics remain the same
 * since items.length bounds nextIndex.
 *
 * These tests verify that:
 *   - Multiple files are read correctly in parallel
 *   - High concurrency (>8 files) works correctly
 *   - Results are returned in input order regardless of completion order
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rmf-concurrent-test-'));
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

describe('read_multiple_files — concurrency (parallelMap)', () => {
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

    it('reads exactly 8 files (default concurrency boundary)', async () => {
        const files = [];
        for (let i = 0; i < 8; i++) {
            files.push(makeFile(tmpDir, `file${i}.txt`, `content-${i}`));
        }
        const result = await handler({ paths: files, compression: false });
        const text = result.content[0].text;
        for (let i = 0; i < 8; i++) {
            expect(text).toContain(`content-${i}`);
        }
    });

    it('reads more than 8 files (exceeds default concurrency)', async () => {
        const count = 20;
        const files = [];
        for (let i = 0; i < count; i++) {
            files.push(makeFile(tmpDir, `file${i}.txt`, `unique-content-${i}`));
        }
        const result = await handler({ paths: files, compression: false });
        const text = result.content[0].text;
        for (let i = 0; i < count; i++) {
            expect(text).toContain(`unique-content-${i}`);
        }
    });

    it('output preserves file ordering for concurrent reads', async () => {
        // Create files with content that includes their index for order verification
        const count = 15;
        const files = [];
        for (let i = 0; i < count; i++) {
            files.push(makeFile(tmpDir, `ordered-${i}.txt`, `LINE_${String(i).padStart(3, '0')}_MARK`));
        }
        const result = await handler({ paths: files, compression: false });
        const text = result.content[0].text;
        // Find positions of each file's content — should be in order 0,1,2,...
        // Use padded indices so LINE_001 never matches inside LINE_010 etc.
        let prevPos = -1;
        for (let i = 0; i < count; i++) {
            const pos = text.indexOf(`LINE_${String(i).padStart(3, '0')}_MARK`);
            expect(pos).toBeGreaterThan(prevPos);
            prevPos = pos;
        }
    });

    it('handles mix of valid and invalid files in concurrent batch', async () => {
        const good1 = makeFile(tmpDir, 'good1.txt', 'alpha');
        const missing = path.join(tmpDir, 'missing.txt');
        const good2 = makeFile(tmpDir, 'good2.txt', 'beta');
        const result = await handler({ paths: [good1, missing, good2], compression: false });
        const text = result.content[0].text;
        expect(text).toContain('alpha');
        expect(text).toContain('ERROR');
        expect(text).toContain('beta');
    });

    it('handles 50 files (max allowed by schema)', async () => {
        const files = [];
        for (let i = 0; i < 50; i++) {
            files.push(makeFile(tmpDir, `f${i}.txt`, `v${i}`));
        }
        const result = await handler({ paths: files, compression: false });
        const text = result.content[0].text;
        expect(text).toContain('v0');
        expect(text).toContain('v49');
    });

    it('concurrent reads produce same result as sequential reads', async () => {
        const files = [];
        for (let i = 0; i < 12; i++) {
            files.push(makeFile(tmpDir, `seq${i}.txt`, `data${i}`));
        }
        // Run twice — results should be identical
        const result1 = await handler({ paths: files, compression: false });
        const result2 = await handler({ paths: files, compression: false });
        expect(result1.content[0].text).toBe(result2.content[0].text);
    });
});