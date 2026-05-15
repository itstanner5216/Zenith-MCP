/**
 * Tests for read_file.ts window merging logic changed in this PR.
 *
 * PR changes:
 *   1. Window merge: replaced `merged.length === 0 || w.startLine > merged[merged.length-1].endLine + 1`
 *      with: `const last = merged[merged.length - 1]; if (last === undefined || w.startLine > ...)`
 *      Then for the else branch: `last.endLine = Math.max(last.endLine, w.endLine);`
 *      (Direct mutation of `last` ref instead of re-indexing merged)
 *
 *   2. Window iteration: replaced while loop with `while (currentWindow !== undefined && ...)`
 *
 * These changes are equivalent in behavior but safer under noUncheckedIndexedAccess.
 *
 * The tests verify:
 *   - aroundLine with context reads lines around a target line
 *   - ranges: multiple non-overlapping ranges
 *   - ranges: overlapping ranges are merged
 *   - ranges: adjacent ranges are merged into one window
 *   - ranges: single range works
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-window-test-'));
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

async function importReadFile() {
    return await import('../dist/tools/read_file.js');
}

// Create a file with numbered lines for easy testing
function makeNumberedFile(dir, numLines) {
    const lines = Array.from({ length: numLines }, (_, i) => `line ${i + 1}`);
    const filePath = path.join(dir, `numbered-${numLines}.txt`);
    fs.writeFileSync(filePath, lines.join('\n'));
    return filePath;
}

describe('read_file — window merge logic (aroundLine)', () => {
    let repoDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        const mod = await importReadFile();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('reads lines around a target line with default context', async () => {
        const filePath = makeNumberedFile(repoDir, 100);
        const result = await handler({ path: filePath, aroundLine: 50, compression: false });
        const text = result.content[0].text;
        expect(text).toContain('line 50');
        expect(text).toContain('line 20'); // 30 lines before
        expect(text).toContain('line 80'); // 30 lines after
    });

    it('respects context parameter for aroundLine', async () => {
        const filePath = makeNumberedFile(repoDir, 100);
        const result = await handler({ path: filePath, aroundLine: 50, context: 5, compression: false });
        const text = result.content[0].text;
        expect(text).toContain('line 45');
        expect(text).toContain('line 55');
        // Lines further away should NOT be present
        expect(text).not.toContain('line 40');
        expect(text).not.toContain('line 60');
    });

    it('aroundLine near start of file does not go below line 1', async () => {
        const filePath = makeNumberedFile(repoDir, 50);
        const result = await handler({ path: filePath, aroundLine: 2, context: 5, compression: false });
        const text = result.content[0].text;
        expect(text).toContain('line 1');
        expect(text).toContain('line 2');
        // Should not crash or include negative line references
    });
});

describe('read_file — window merge logic (ranges)', () => {
    let repoDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        repoDir = mkTmpGitRepo();
        ctx = mkCtx(repoDir);
        const mod = await importReadFile();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    it('reads a single range', async () => {
        const filePath = makeNumberedFile(repoDir, 50);
        const result = await handler({
            path: filePath,
            ranges: [{ startLine: 10, endLine: 15 }],
            compression: false,
        });
        const text = result.content[0].text;
        expect(text).toContain('line 10');
        expect(text).toContain('line 15');
        expect(text).not.toContain('line 9');
        expect(text).not.toContain('line 16');
    });

    it('reads multiple non-overlapping ranges', async () => {
        const filePath = makeNumberedFile(repoDir, 100);
        const result = await handler({
            path: filePath,
            ranges: [
                { startLine: 5, endLine: 8 },
                { startLine: 20, endLine: 25 },
            ],
            compression: false,
        });
        const text = result.content[0].text;
        expect(text).toContain('line 5');
        expect(text).toContain('line 8');
        expect(text).toContain('line 20');
        expect(text).toContain('line 25');
        // Lines between ranges should not be present
        expect(text).not.toContain('line 10');
        expect(text).not.toContain('line 15');
    });

    it('merges overlapping ranges (window merge logic)', async () => {
        const filePath = makeNumberedFile(repoDir, 100);
        // Two overlapping ranges: [10-20] and [15-30] → merged to [10-30]
        const result = await handler({
            path: filePath,
            ranges: [
                { startLine: 10, endLine: 20 },
                { startLine: 15, endLine: 30 },
            ],
            compression: false,
        });
        const text = result.content[0].text;
        expect(text).toContain('line 10');
        expect(text).toContain('line 25');
        expect(text).toContain('line 30');
    });

    it('merges adjacent ranges (startLine = prevEndLine + 1)', async () => {
        const filePath = makeNumberedFile(repoDir, 100);
        // Adjacent ranges: [5-10] and [11-20] → merged to [5-20]
        const result = await handler({
            path: filePath,
            ranges: [
                { startLine: 5, endLine: 10 },
                { startLine: 11, endLine: 20 },
            ],
            compression: false,
        });
        const text = result.content[0].text;
        expect(text).toContain('line 5');
        expect(text).toContain('line 10');
        expect(text).toContain('line 11');
        expect(text).toContain('line 20');
    });

    it('handles unsorted ranges (should be sorted before merging)', async () => {
        const filePath = makeNumberedFile(repoDir, 100);
        // Provide ranges in reverse order
        const result = await handler({
            path: filePath,
            ranges: [
                { startLine: 30, endLine: 40 },
                { startLine: 5, endLine: 15 },
            ],
            compression: false,
        });
        const text = result.content[0].text;
        expect(text).toContain('line 5');
        expect(text).toContain('line 30');
    });

    it('handles single-line range', async () => {
        const filePath = makeNumberedFile(repoDir, 50);
        const result = await handler({
            path: filePath,
            ranges: [{ startLine: 25, endLine: 25 }],
            compression: false,
        });
        const text = result.content[0].text;
        expect(text).toContain('line 25');
        // Should not include adjacent lines (no context by default in ranges mode)
        expect(text).not.toContain('line 24');
        expect(text).not.toContain('line 26');
    });

    it('combines aroundLine and ranges in same request', async () => {
        const filePath = makeNumberedFile(repoDir, 100);
        const result = await handler({
            path: filePath,
            aroundLine: 50,
            context: 2,
            ranges: [{ startLine: 90, endLine: 95 }],
            compression: false,
        });
        const text = result.content[0].text;
        expect(text).toContain('line 48'); // aroundLine context
        expect(text).toContain('line 52');
        expect(text).toContain('line 90'); // range
        expect(text).toContain('line 95');
    });
});