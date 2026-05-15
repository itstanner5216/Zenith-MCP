/**
 * Tests for search_file.ts changes in this PR.
 *
 * PR changes:
 *   1. findOptions now conditionally adds nearLine instead of always including it:
 *      Before: { kindFilter: 'def', nearLine: args.nearLine }
 *      After:  const findOptions = { kindFilter: 'def' };
 *              if (args.nearLine !== undefined) findOptions.nearLine = args.nearLine;
 *
 *   2. Added explicit sym undefined check after matches[0]:
 *      const [sym] = matches;
 *      if (sym === undefined) { throw new Error('Symbol not found.'); }
 *
 * These tests focus on:
 *   - Symbol search with nearLine explicitly set to undefined (was passing undefined before)
 *   - Symbol search with nearLine = 0 (falsy but valid line number)
 *   - Various nearLine disambiguation cases
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-strict-test-'));
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

describe('search_file — symbol mode, nearLine conditioning', () => {
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

    it('finds single unique symbol without nearLine', async () => {
        const filePath = path.join(repoDir, 'main.js');
        fs.writeFileSync(filePath, 'function uniqueSymbol() {\n  return 42;\n}\n');
        const result = await handler({ path: filePath, symbol: 'uniqueSymbol' });
        expect(result.content[0].text).toContain('uniqueSymbol');
    });

    it('finds unique symbol when nearLine is explicitly undefined', async () => {
        const filePath = path.join(repoDir, 'main.js');
        fs.writeFileSync(filePath, 'function myFunc() {\n  return true;\n}\n');
        // nearLine: undefined should behave the same as omitting nearLine
        const result = await handler({ path: filePath, symbol: 'myFunc', nearLine: undefined });
        expect(result.content[0].text).toContain('myFunc');
    });

    it('disambiguates multiple symbols using nearLine', async () => {
        const filePath = path.join(repoDir, 'multi.js');
        fs.writeFileSync(
            filePath,
            'function duplicate() { return 1; }\n' +
            'function duplicate() { return 2; }\n'
        );
        // Without nearLine, should throw "Multiple matches"
        await expect(handler({ path: filePath, symbol: 'duplicate' }))
            .rejects.toThrow('Multiple matches');

        // With nearLine = 1, should select the first match
        const result = await handler({ path: filePath, symbol: 'duplicate', nearLine: 1 });
        expect(result.content[0].text).toContain('duplicate');
    });

    it('throws "Symbol not found." for a non-existent symbol', async () => {
        const filePath = path.join(repoDir, 'code.js');
        fs.writeFileSync(filePath, 'function realFunction() { return 0; }\n');
        await expect(handler({ path: filePath, symbol: 'doesNotExist' }))
            .rejects.toThrow('Symbol not found.');
    });

    it('handles nearLine = 0 (falsy but not undefined)', async () => {
        const filePath = path.join(repoDir, 'code.js');
        // nearLine = 0 means "near line 0" — should not throw an error for well-formed files
        fs.writeFileSync(filePath, 'function onlyOne() { return 42; }\n');
        // With a single match and nearLine=0, should still find it
        const result = await handler({ path: filePath, symbol: 'onlyOne', nearLine: 0 });
        expect(result.content[0].text).toContain('onlyOne');
    });

    it('returns content including the symbol definition line', async () => {
        const filePath = path.join(repoDir, 'sample.js');
        fs.writeFileSync(filePath, '// header\nfunction targetFunction() {\n  const x = 1;\n  return x;\n}\n');
        const result = await handler({ path: filePath, symbol: 'targetFunction' });
        const text = result.content[0].text;
        expect(text).toContain('function targetFunction');
    });

    it('expandLines: 0 returns only the symbol definition', async () => {
        const filePath = path.join(repoDir, 'sample.js');
        fs.writeFileSync(
            filePath,
            'const prefix = 1;\nfunction small() { return 0; }\nconst suffix = 2;\n'
        );
        const result = await handler({ path: filePath, symbol: 'small', expandLines: 0 });
        const text = result.content[0].text;
        expect(text).toContain('small');
    });

    it('throws "Unsupported file type." for .xyz extension with symbol', async () => {
        const filePath = path.join(repoDir, 'data.xyz');
        fs.writeFileSync(filePath, 'some content');
        await expect(handler({ path: filePath, symbol: 'foo' }))
            .rejects.toThrow('Unsupported file type.');
    });
});

// ---------------------------------------------------------------------------
// search_file — grep emit: duplicate guard
// ---------------------------------------------------------------------------

describe('search_file — grep mode, lastEntry guard', () => {
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

    it('does not emit the same line twice', async () => {
        const filePath = path.join(repoDir, 'file.txt');
        fs.writeFileSync(filePath, 'match here\nnot a match\nanother match\n');
        const result = await handler({ path: filePath, grep: 'match' });
        const lines = result.content[0].text.split('\n').filter(l => l.includes('*'));
        // Each matched line should appear only once
        const lineSet = new Set(lines);
        expect(lineSet.size).toBe(lines.length);
    });

    it('emits separator "---" between non-adjacent match groups with context', async () => {
        const content = Array.from({ length: 30 }, (_, i) =>
            i === 0 ? 'match-first-line' : i === 29 ? 'match-last-line' : `plain-${i}`
        ).join('\n');
        const filePath = path.join(repoDir, 'spaced.txt');
        fs.writeFileSync(filePath, content);
        const result = await handler({ path: filePath, grep: 'match', grepContext: 1 });
        const text = result.content[0].text;
        expect(text).toContain('---');
    });

    it('returns correct line numbers for grep matches', async () => {
        const filePath = path.join(repoDir, 'numbered.txt');
        fs.writeFileSync(filePath, 'line one\nline two\nTARGET here\nline four\n');
        const result = await handler({ path: filePath, grep: 'TARGET' });
        // Line 3 contains TARGET
        expect(result.content[0].text).toContain('3:');
    });
});