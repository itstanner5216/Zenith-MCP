/**
 * Comprehensive test suite for tool modules — exhaustive branch coverage.
 *
 * Target Files:
 *   - src/tools/directory.ts (list mode, tree mode, escapeCtrl, sensitive filtering)
 *   - src/tools/search_file.ts (grep mode, symbol mode, error paths)
 *   - src/tools/write_file.ts (create, overwrite, append, failIfExists, stat errors)
 *   - src/tools/refactor_batch.ts (schema strictness, mode validation)
 *
 * Detected Framework: Vitest 4.x
 * Mocking Strategy: Temp git repos for realistic filesystem; live ripgrep binary.
 *
 * Taxonomy Covered:
 *   - Happy Path: Normal tool invocations
 *   - Boundary: Empty dirs, max entries, char budgets, zero-length content
 *   - Equivalence: Different file types, extensions, pattern classes
 *   - Exception: Permission errors, missing files, invalid args, malformed schemas
 *   - State Transition: Append with overlap detection, file existence transitions
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tools-comp-'));
}

function mkTmpGitRepo() {
    const dir = mkTmpDir();
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
        validateNewFilePath: async (p) => path.resolve(p),
        getAllowedDirectories: () => [baseDir],
        sessionId: 'test-session',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// directory.ts — list mode comprehensive
// ═══════════════════════════════════════════════════════════════════════════════
describe('directory tool — list mode comprehensive', () => {
    let tmpDir, handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        const ctx = mkCtx(tmpDir);
        const mod = await import('../dist/tools/directory.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Happy path
    it('lists files and directories correctly', async () => {
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), '');
        fs.mkdirSync(path.join(tmpDir, 'subdir'));
        const result = await handler({ mode: 'list', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('subdir/');
        expect(text).toContain('a.txt');
    });

    // Boundary: empty directory
    it('handles empty directory', async () => {
        const result = await handler({ mode: 'list', path: tmpDir });
        expect(result.content[0].text).toBe('');
    });

    // Boundary: depth = 1 (default, no recursion into subdirs beyond listing)
    it('depth=1 lists subdir names but not their contents', async () => {
        fs.mkdirSync(path.join(tmpDir, 'sub'));
        fs.writeFileSync(path.join(tmpDir, 'sub', 'deep.txt'), '');
        const result = await handler({ mode: 'list', path: tmpDir, depth: 1 });
        const text = result.content[0].text;
        expect(text).toContain('sub/');
        expect(text).not.toContain('deep.txt');
    });

    // Boundary: depth > 1 shows recursive contents
    it('depth=2 shows files inside subdirectories', async () => {
        fs.mkdirSync(path.join(tmpDir, 'sub'));
        fs.writeFileSync(path.join(tmpDir, 'sub', 'deep.txt'), '');
        const result = await handler({ mode: 'list', path: tmpDir, depth: 2 });
        const text = result.content[0].text;
        expect(text).toContain('deep.txt');
    });

    // Exception: sensitive files filtered
    it('omits sensitive files (.env, .pem, credentials)', async () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=x');
        fs.writeFileSync(path.join(tmpDir, 'server.pem'), 'cert');
        fs.writeFileSync(path.join(tmpDir, 'credentials.json'), '{}');
        fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'code');
        const result = await handler({ mode: 'list', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('app.ts');
        expect(text).not.toContain('.env');
        expect(text).not.toContain('.pem');
        expect(text).not.toContain('credentials');
    });

    // State: default excludes (node_modules, .git, etc.)
    it('excludes node_modules by default', async () => {
        fs.mkdirSync(path.join(tmpDir, 'node_modules'));
        fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), '');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), '');
        const result = await handler({ mode: 'list', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('app.js');
        expect(text).not.toContain('node_modules');
    });

    // Escape: control characters in filenames
    it('escapes control characters in list output', async () => {
        try {
            fs.writeFileSync(path.join(tmpDir, 'file\x01name.txt'), '');
        } catch { return; } // skip if FS rejects
        const result = await handler({ mode: 'list', path: tmpDir });
        const text = result.content[0].text;
        expect(text).not.toContain('\x01');
        expect(text).toContain('\\x01');
    });

    // Sort: by size
    it('sorts by size when sortBy=size', async () => {
        fs.writeFileSync(path.join(tmpDir, 'small.txt'), 'x');
        fs.writeFileSync(path.join(tmpDir, 'large.txt'), 'x'.repeat(1000));
        const result = await handler({ mode: 'list', path: tmpDir, sortBy: 'size', includeSizes: true });
        const text = result.content[0].text;
        const lines = text.split('\n');
        // large.txt should appear first when sorting by size descending
        expect(lines[0]).toContain('large.txt');
    });

    // User exclude patterns
    it('respects user-specified excludePatterns', async () => {
        fs.writeFileSync(path.join(tmpDir, 'keep.ts'), '');
        fs.writeFileSync(path.join(tmpDir, 'drop.log'), '');
        const result = await handler({ mode: 'list', path: tmpDir, excludePatterns: ['*.log'] });
        const text = result.content[0].text;
        expect(text).toContain('keep.ts');
        expect(text).not.toContain('drop.log');
    });

    // File sizes display
    it('shows file sizes when includeSizes=true', async () => {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello world');
        const result = await handler({ mode: 'list', path: tmpDir, includeSizes: true });
        const text = result.content[0].text;
        expect(text).toContain('B');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// directory.ts — tree mode comprehensive
// ═══════════════════════════════════════════════════════════════════════════════
describe('directory tool — tree mode comprehensive', () => {
    let tmpDir, handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        const ctx = mkCtx(tmpDir);
        const mod = await import('../dist/tools/directory.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('produces tree output with nested structure', async () => {
        fs.mkdirSync(path.join(tmpDir, 'src'));
        fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), '');
        fs.writeFileSync(path.join(tmpDir, 'README.md'), '');
        const result = await handler({ mode: 'tree', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('src');
        expect(text).toContain('main.ts');
        expect(text).toContain('README.md');
    });

    it('omits sensitive files in tree mode', async () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'KEY=val');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), '');
        const result = await handler({ mode: 'tree', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('app.js');
        expect(text).not.toContain('.env');
    });

    it('respects depth limit in tree mode', async () => {
        fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'c'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'a', 'b', 'c', 'deep.txt'), '');
        const result = await handler({ mode: 'tree', path: tmpDir, depth: 2 });
        const text = result.content[0].text;
        // depth 2 should show a/ and a/b/ but not traverse into c/
        expect(text).toContain('a');
        expect(text).toContain('b');
        expect(text).not.toContain('deep.txt');
    });

    it('handles empty directory in tree mode', async () => {
        const result = await handler({ mode: 'tree', path: tmpDir });
        // Should not throw, text may be empty or minimal
        expect(result.content[0].text).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// search_file.ts — comprehensive
// ═══════════════════════════════════════════════════════════════════════════════
describe('search_file — grep mode comprehensive', () => {
    let tmpDir, handler;

    beforeEach(async () => {
        tmpDir = mkTmpGitRepo();
        const ctx = mkCtx(tmpDir);
        const mod = await import('../dist/tools/search_file.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Happy path
    it('finds matches with line numbers and markers', async () => {
        const f = path.join(tmpDir, 'code.js');
        fs.writeFileSync(f, 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
        const result = await handler({ path: f, grep: 'const' });
        const text = result.content[0].text;
        expect(text).toContain('1:*');
        expect(text).toContain('2:*');
        expect(text).toContain('3:*');
    });

    // Boundary: no matches
    it('returns "No matches." for unmatched pattern', async () => {
        const f = path.join(tmpDir, 'code.js');
        fs.writeFileSync(f, 'hello world');
        const result = await handler({ path: f, grep: 'zzzzz' });
        expect(result.content[0].text).toBe('No matches.');
    });

    // Boundary: empty file
    it('returns "No matches." for empty file', async () => {
        const f = path.join(tmpDir, 'empty.txt');
        fs.writeFileSync(f, '');
        const result = await handler({ path: f, grep: 'anything' });
        expect(result.content[0].text).toBe('No matches.');
    });

    // Exception: no grep or symbol → error
    it('throws when neither grep nor symbol provided', async () => {
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'content');
        await expect(handler({ path: f })).rejects.toThrow('Provide grep or symbol.');
    });

    // Boundary: maxChars budget truncates output
    it('truncates output to maxChars budget', async () => {
        const f = path.join(tmpDir, 'big.txt');
        const content = Array.from({ length: 500 }, (_, i) => `line-number-${i}`).join('\n');
        fs.writeFileSync(f, content);
        const result = await handler({ path: f, grep: 'line', maxChars: 100 });
        const text = result.content[0].text;
        expect(text.length).toBeLessThanOrEqual(200); // some overhead
    });

    // Context lines
    it('includes context lines around matches', async () => {
        const f = path.join(tmpDir, 'code.txt');
        fs.writeFileSync(f, 'before\ntarget\nafter\n');
        const result = await handler({ path: f, grep: 'target', grepContext: 1 });
        const text = result.content[0].text;
        expect(text).toContain('before');
        expect(text).toContain('after');
    });

    // Error detail from ripgrep
    it('includes error detail when ripgrep fails on invalid regex', async () => {
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'data');
        try {
            await handler({ path: f, grep: '[bad(' });
        } catch (err) {
            expect(err.message).toContain('ripgrep');
        }
    });
});

describe('search_file — symbol mode comprehensive', () => {
    let tmpDir, handler;

    beforeEach(async () => {
        tmpDir = mkTmpGitRepo();
        const ctx = mkCtx(tmpDir);
        const mod = await import('../dist/tools/search_file.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Happy path: find a symbol
    it('finds function definition with line numbers', async () => {
        const f = path.join(tmpDir, 'mod.js');
        fs.writeFileSync(f, 'function greet(name) {\n  return "Hi " + name;\n}\n');
        const result = await handler({ path: f, symbol: 'greet' });
        const text = result.content[0].text;
        expect(text).toContain('function greet');
        expect(text).toContain('1:');
    });

    // Exception: unsupported file
    it('throws for unsupported file type', async () => {
        const f = path.join(tmpDir, 'data.csv');
        fs.writeFileSync(f, 'a,b,c');
        await expect(handler({ path: f, symbol: 'foo' })).rejects.toThrow('Unsupported file type.');
    });

    // Exception: symbol not found
    it('throws when symbol does not exist', async () => {
        const f = path.join(tmpDir, 'mod.js');
        fs.writeFileSync(f, 'const x = 1;');
        await expect(handler({ path: f, symbol: 'nonexistent' })).rejects.toThrow('Symbol not found.');
    });

    // Boundary: expandLines=0
    it('returns just the symbol body when expandLines=0', async () => {
        const f = path.join(tmpDir, 'mod.js');
        fs.writeFileSync(f, '// comment\nfunction foo() { return 1; }\n// end\n');
        const result = await handler({ path: f, symbol: 'foo', expandLines: 0 });
        const text = result.content[0].text;
        expect(text).toContain('function foo');
        expect(text).not.toContain('// comment');
        expect(text).not.toContain('// end');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// write_file.ts — comprehensive
// ═══════════════════════════════════════════════════════════════════════════════
describe('write_file — comprehensive branch coverage', () => {
    let tmpDir, handler;

    beforeEach(async () => {
        tmpDir = mkTmpGitRepo();
        const ctx = mkCtx(tmpDir);
        const mod = await import('../dist/tools/write_file.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Branch: create new file
    it('creates new file and returns "File written."', async () => {
        const f = path.join(tmpDir, 'new.txt');
        const result = await handler({ path: f, content: 'hello' });
        expect(result.content[0].text).toBe('File written.');
        expect(fs.readFileSync(f, 'utf8')).toBe('hello');
    });

    // Branch: overwrite existing file
    it('overwrites existing file and returns "File updated."', async () => {
        const f = path.join(tmpDir, 'exist.txt');
        fs.writeFileSync(f, 'old');
        const result = await handler({ path: f, content: 'new' });
        expect(result.content[0].text).toBe('File updated.');
        expect(fs.readFileSync(f, 'utf8')).toBe('new');
    });

    // Branch: failIfExists=true on existing file → throws
    it('throws "File already exists." when failIfExists=true and file exists', async () => {
        const f = path.join(tmpDir, 'exist.txt');
        fs.writeFileSync(f, 'old');
        await expect(handler({ path: f, content: 'new', failIfExists: true }))
            .rejects.toThrow('File already exists.');
    });

    // Branch: failIfExists=true on missing file → succeeds
    it('creates file when failIfExists=true and file does not exist', async () => {
        const f = path.join(tmpDir, 'fresh.txt');
        const result = await handler({ path: f, content: 'data', failIfExists: true });
        expect(result.content[0].text).toBe('File written.');
    });

    // Branch: append mode on new file — creates it but reports as appended
    it('append on non-existing file creates it', async () => {
        const f = path.join(tmpDir, 'append-new.txt');
        const result = await handler({ path: f, content: 'first', append: true });
        // write_file always reports "Content appended." when append=true
        expect(result.content[0].text).toBe('Content appended.');
        expect(fs.readFileSync(f, 'utf8')).toBe('first');
    });

    // Branch: append mode on existing file — adds content
    it('append on existing file adds content with separator', async () => {
        const f = path.join(tmpDir, 'append-exist.txt');
        fs.writeFileSync(f, 'line1');
        const result = await handler({ path: f, content: 'line2', append: true });
        expect(result.content[0].text).toBe('Content appended.');
        const content = fs.readFileSync(f, 'utf8');
        expect(content).toContain('line1');
        expect(content).toContain('line2');
    });

    // Branch: append with resume offset (overlap detection)
    it('append deduplicates overlapping content', async () => {
        const f = path.join(tmpDir, 'resume.txt');
        fs.writeFileSync(f, 'line1\nline2\nline3\n');
        // Incoming starts with overlap (line2, line3) then new content
        const result = await handler({ path: f, content: 'line2\nline3\nline4\n', append: true });
        expect(result.content[0].text).toBe('Content appended.');
        const content = fs.readFileSync(f, 'utf8');
        // Should not have duplicate line2, line3
        const lines = content.split('\n').filter(l => l);
        const line2Count = lines.filter(l => l === 'line2').length;
        expect(line2Count).toBe(1);
    });

    // Branch: auto-creates parent directories
    it('creates parent directories automatically', async () => {
        const f = path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt');
        const result = await handler({ path: f, content: 'nested' });
        expect(result.content[0].text).toBe('File written.');
        expect(fs.readFileSync(f, 'utf8')).toBe('nested');
    });

    // Branch: non-ENOENT stat error (restricted parent)
    it('throws for EACCES stat errors (not treated as file-missing)', async () => {
        const restricted = path.join(tmpDir, 'noaccess');
        fs.mkdirSync(restricted);
        const f = path.join(restricted, 'test.txt');
        fs.writeFileSync(f, 'existing');
        fs.chmodSync(restricted, 0o000);
        try {
            await expect(handler({ path: f, content: 'x', failIfExists: true }))
                .rejects.toThrow(/Cannot access|EACCES/i);
        } finally {
            fs.chmodSync(restricted, 0o755);
        }
    });

    // Boundary: CRLF normalization
    it('normalizes CRLF to LF in written content', async () => {
        const f = path.join(tmpDir, 'crlf.txt');
        await handler({ path: f, content: 'line1\r\nline2\r\n' });
        const raw = fs.readFileSync(f, 'utf8');
        expect(raw).toBe('line1\nline2\n');
        expect(raw).not.toContain('\r');
    });

    // Boundary: empty content
    it('writes empty file', async () => {
        const f = path.join(tmpDir, 'empty.txt');
        await handler({ path: f, content: '' });
        expect(fs.readFileSync(f, 'utf8')).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// refactor_batch.ts — schema validation comprehensive
// ═══════════════════════════════════════════════════════════════════════════════
describe('refactor_batch — schema validation comprehensive', () => {
    let schema;

    beforeEach(async () => {
        const mod = await import('../dist/tools/refactor_batch.js');
        const { server, calls } = captureHandler();
        const ctx = mkCtx('/tmp');
        mod.register(server, ctx);
        schema = calls[0].schema.inputSchema;
    });

    // Happy path: valid modes
    it('accepts all valid mode values', () => {
        for (const mode of ['query', 'loadDiff', 'apply', 'reapply', 'restore', 'history']) {
            const result = schema.safeParse({ mode });
            expect(result.success).toBe(true);
        }
    });

    // Exception: invalid mode
    it('rejects invalid mode values', () => {
        const result = schema.safeParse({ mode: 'invalid' });
        expect(result.success).toBe(false);
    });

    // Exception: missing required mode
    it('rejects when mode is missing', () => {
        const result = schema.safeParse({});
        expect(result.success).toBe(false);
    });

    // Strict: unknown top-level key
    it('rejects unknown top-level keys', () => {
        const result = schema.safeParse({ mode: 'query', unknownField: 'x' });
        expect(result.success).toBe(false);
    });

    // Strict: unknown key in selection object
    it('rejects unknown keys in selection objects', () => {
        const result = schema.safeParse({
            mode: 'loadDiff',
            selection: [{ symbol: 'foo', file: 'bar.ts', extra: 'bad' }],
        });
        expect(result.success).toBe(false);
    });

    // Strict: unknown key in newTargets object
    it('rejects unknown keys in newTargets objects', () => {
        const result = schema.safeParse({
            mode: 'reapply',
            symbolGroup: 'test',
            newTargets: [{ symbol: 'a', unknown: true }],
        });
        expect(result.success).toBe(false);
    });

    // Happy: valid selection with numeric indices
    it('accepts numeric indices in selection', () => {
        const result = schema.safeParse({
            mode: 'loadDiff',
            selection: [1, 2, 3],
        });
        expect(result.success).toBe(true);
    });

    // Happy: valid selection with object pairs
    it('accepts {symbol, file} pairs in selection', () => {
        const result = schema.safeParse({
            mode: 'loadDiff',
            selection: [{ symbol: 'foo' }, { symbol: 'bar', file: 'baz.ts' }],
        });
        expect(result.success).toBe(true);
    });

    // Happy: mixed selection (numbers and objects)
    it('accepts mixed selection (numbers and objects)', () => {
        const result = schema.safeParse({
            mode: 'loadDiff',
            selection: [1, { symbol: 'foo' }],
        });
        expect(result.success).toBe(true);
    });

    // Boundary: selection with number < 1
    it('rejects selection with number < 1', () => {
        const result = schema.safeParse({
            mode: 'loadDiff',
            selection: [0],
        });
        expect(result.success).toBe(false);
    });

    // Happy: newTargets with strings and objects
    it('accepts newTargets with string and object entries', () => {
        const result = schema.safeParse({
            mode: 'reapply',
            symbolGroup: 'test',
            newTargets: ['symbolA', { symbol: 'symbolB' }],
        });
        expect(result.success).toBe(true);
    });

    // Boundary: depth range
    it('accepts depth within range 1-5', () => {
        expect(schema.safeParse({ mode: 'query', depth: 1 }).success).toBe(true);
        expect(schema.safeParse({ mode: 'query', depth: 5 }).success).toBe(true);
    });

    it('rejects depth out of range', () => {
        expect(schema.safeParse({ mode: 'query', depth: 0 }).success).toBe(false);
        expect(schema.safeParse({ mode: 'query', depth: 6 }).success).toBe(false);
    });

    // Boundary: contextLines range
    it('rejects negative contextLines', () => {
        const result = schema.safeParse({ mode: 'loadDiff', contextLines: -1 });
        expect(result.success).toBe(false);
    });

    // Happy: direction enum
    it('accepts forward and reverse direction', () => {
        expect(schema.safeParse({ mode: 'query', direction: 'forward' }).success).toBe(true);
        expect(schema.safeParse({ mode: 'query', direction: 'reverse' }).success).toBe(true);
    });

    it('rejects invalid direction', () => {
        expect(schema.safeParse({ mode: 'query', direction: 'sideways' }).success).toBe(false);
    });

    // Boundary: version must be non-negative integer
    it('rejects negative version', () => {
        const result = schema.safeParse({ mode: 'restore', symbol: 'x', file: 'y', version: -1 });
        expect(result.success).toBe(false);
    });

    it('accepts version 0', () => {
        const result = schema.safeParse({ mode: 'restore', symbol: 'x', file: 'y', version: 0 });
        expect(result.success).toBe(true);
    });
});
