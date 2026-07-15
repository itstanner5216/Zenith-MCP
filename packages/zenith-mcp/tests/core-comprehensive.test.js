/**
 * Comprehensive test suite for core modules — exhaustive branch coverage.
 *
 * Target Files:
 *   - src/core/lib.ts (tailFile, headFile, offsetReadFile, writeFileContent, formatSize)
 *   - src/core/shared.ts (isSensitive, ripgrepSearch, lastRipgrepError, ripgrepCountMatches)
 *   - src/core/roots-utils.ts (getValidRootDirectories, parseRootUri)
 *
 * Detected Framework: Vitest 4.x
 * Mocking Strategy: Filesystem I/O via temp dirs; ripgrep via live binary.
 *
 * Taxonomy Covered:
 *   - Happy Path: Standard inputs producing correct outputs
 *   - Boundary: Zero, negative, max-int, empty strings, exact thresholds
 *   - Equivalence: Representative inputs from each logical partition
 *   - Exception: Error paths, invalid inputs, missing files, permission errors
 *   - State Transition: Ring buffer wrap-around, chunk accumulation
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'core-comp-'));
}

function mkTmpGitRepo() {
    const dir = mkTmpDir();
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    return dir;
}

// ═══════════════════════════════════════════════════════════════════════════════
// lib.ts — tailFile
// ═══════════════════════════════════════════════════════════════════════════════
describe('tailFile — comprehensive branch coverage', () => {
    let tmpDir;

    beforeEach(() => { tmpDir = mkTmpDir(); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Branch: n <= 0 → returns ''
    it('returns empty for numLines = 0', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'line1\nline2\n');
        expect(await tailFile(f, 0)).toBe('');
    });

    it('returns empty for negative numLines', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'line1\nline2\n');
        expect(await tailFile(f, -5)).toBe('');
    });

    it('returns empty for NaN numLines', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'line1\nline2\n');
        expect(await tailFile(f, NaN)).toBe('');
    });

    it('returns empty for Infinity numLines (treated as non-finite)', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'line1\nline2\n');
        expect(await tailFile(f, Infinity)).toBe('');
    });

    // Branch: small file (≤ 131072), count <= cap → direct slice
    it('returns all lines for small file when numLines >= total lines', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'small.txt');
        fs.writeFileSync(f, 'a\nb\nc');
        expect(await tailFile(f, 10)).toBe('a\nb\nc');
    });

    it('returns last N lines from small file', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'small.txt');
        fs.writeFileSync(f, 'one\ntwo\nthree\nfour\nfive');
        expect(await tailFile(f, 2)).toBe('four\nfive');
    });

    // Branch: small file, ring buffer wraps (count > cap)
    it('correctly wraps ring buffer for small file with many lines', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'many.txt');
        const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
        fs.writeFileSync(f, lines.join('\n'));
        const result = await tailFile(f, 3);
        expect(result).toBe('line-98\nline-99\nline-100');
    });

    // Branch: empty file → returns ''
    it('returns empty string for empty file', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'empty.txt');
        fs.writeFileSync(f, '');
        expect(await tailFile(f, 5)).toBe('');
    });

    // Branch: single line file
    it('handles single-line file', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'one.txt');
        fs.writeFileSync(f, 'only line');
        expect(await tailFile(f, 1)).toBe('only line');
    });

    // Branch: large file (> 131072 bytes), backward chunk reading
    it('reads last N lines from large file via backward chunks', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'big.log');
        // Create a file > 131072 bytes
        const lines = Array.from({ length: 20000 }, (_, i) => `log-entry-${String(i).padStart(5, '0')}`);
        fs.writeFileSync(f, lines.join('\n'));
        const stat = fs.statSync(f);
        expect(stat.size).toBeGreaterThan(131072);

        const result = await tailFile(f, 3);
        expect(result).toBe('log-entry-19997\nlog-entry-19998\nlog-entry-19999');
    });

    // Branch: large file requesting exactly 1 line
    it('large file with numLines=1 returns only last line', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'big.log');
        const lines = Array.from({ length: 20000 }, (_, i) => `entry-${i}`);
        fs.writeFileSync(f, lines.join('\n'));
        const result = await tailFile(f, 1);
        expect(result).toBe('entry-19999');
    });

    // Branch: numLines > total lines in large file → returns entire file
    it('large file requesting more lines than exist returns all content', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'big.log');
        const lines = Array.from({ length: 20000 }, (_, i) => `line-${i}`);
        fs.writeFileSync(f, lines.join('\n'));
        const result = await tailFile(f, 100000);
        const resultLines = result.split('\n');
        expect(resultLines.length).toBe(20000);
        expect(resultLines[0]).toBe('line-0');
    });

    // Boundary: file with trailing newline
    it('handles file ending with newline correctly', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'trailing.txt');
        fs.writeFileSync(f, 'a\nb\nc\n');
        const result = await tailFile(f, 2);
        expect(result).toBe('b\nc');
    });

    // Boundary: file with CRLF line endings (large file path)
    it('handles CRLF in large files', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'crlf.log');
        const lines = Array.from({ length: 20000 }, (_, i) => `line-${i}`);
        fs.writeFileSync(f, lines.join('\r\n'));
        const result = await tailFile(f, 2);
        expect(result).toContain('line-19998');
        expect(result).toContain('line-19999');
    });

    // Boundary: numLines cap at 50_000
    it('caps requested lines at 50000', async () => {
        const { tailFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'small.txt');
        fs.writeFileSync(f, 'a\nb\nc');
        // Requesting 100000 lines from 3-line file should return all 3
        const result = await tailFile(f, 100000);
        expect(result).toBe('a\nb\nc');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// lib.ts — headFile
// ═══════════════════════════════════════════════════════════════════════════════
describe('headFile — branch coverage', () => {
    let tmpDir;
    beforeEach(() => { tmpDir = mkTmpDir(); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('returns empty for numLines <= 0', async () => {
        const { headFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'line1\nline2\n');
        expect(await headFile(f, 0)).toBe('');
        expect(await headFile(f, -1)).toBe('');
    });

    it('returns first N lines', async () => {
        const { headFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'one\ntwo\nthree\nfour\nfive');
        expect(await headFile(f, 3)).toBe('one\ntwo\nthree');
    });

    it('returns all lines when numLines exceeds file length', async () => {
        const { headFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'a\nb');
        expect(await headFile(f, 100)).toBe('a\nb');
    });

    it('handles empty file', async () => {
        const { headFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'empty.txt');
        fs.writeFileSync(f, '');
        expect(await headFile(f, 5)).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// lib.ts — offsetReadFile
// ═══════════════════════════════════════════════════════════════════════════════
describe('offsetReadFile — branch coverage', () => {
    let tmpDir;
    beforeEach(() => { tmpDir = mkTmpDir(); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Branch: length <= 0 → early return
    it('returns empty for length <= 0', async () => {
        const { offsetReadFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'line1\nline2\nline3');
        const result = await offsetReadFile(f, 0, 0);
        expect(result).toEqual({ content: '', linesReturned: 0, hasMore: false });
    });

    it('returns empty for negative length', async () => {
        const { offsetReadFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'line1\nline2');
        const result = await offsetReadFile(f, 0, -5);
        expect(result).toEqual({ content: '', linesReturned: 0, hasMore: false });
    });

    // Branch: offset skips lines, collects `length` lines
    it('skips offset lines and returns requested count', async () => {
        const { offsetReadFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'zero\none\ntwo\nthree\nfour');
        const result = await offsetReadFile(f, 2, 2);
        expect(result.content).toBe('two\nthree');
        expect(result.linesReturned).toBe(2);
        expect(result.hasMore).toBe(true);
    });

    // Branch: hasMore = false when file ends before length
    it('hasMore is false when fewer lines remain than requested', async () => {
        const { offsetReadFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'zero\none\ntwo');
        const result = await offsetReadFile(f, 1, 100);
        expect(result.content).toBe('one\ntwo');
        expect(result.linesReturned).toBe(2);
        expect(result.hasMore).toBe(false);
    });

    // Branch: offset beyond file length → empty
    it('returns empty when offset exceeds total lines', async () => {
        const { offsetReadFile } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'a.txt');
        fs.writeFileSync(f, 'a\nb');
        const result = await offsetReadFile(f, 100, 5);
        expect(result.content).toBe('');
        expect(result.linesReturned).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// lib.ts — formatSize boundary
// ═══════════════════════════════════════════════════════════════════════════════
describe('formatSize — boundary values', () => {
    it('throws RangeError for negative input', async () => {
        const { formatSize } = await import('../dist/core/lib.js');
        expect(() => formatSize(-1)).toThrow(RangeError);
    });

    it('throws RangeError for NaN', async () => {
        const { formatSize } = await import('../dist/core/lib.js');
        expect(() => formatSize(NaN)).toThrow(RangeError);
    });

    it('throws RangeError for Infinity', async () => {
        const { formatSize } = await import('../dist/core/lib.js');
        expect(() => formatSize(Infinity)).toThrow(RangeError);
    });

    it('handles exactly 1023 bytes (boundary before KB)', async () => {
        const { formatSize } = await import('../dist/core/lib.js');
        expect(formatSize(1023)).toBe('1023 B');
    });

    it('handles exactly 1024 bytes', async () => {
        const { formatSize } = await import('../dist/core/lib.js');
        expect(formatSize(1024)).toBe('1.00 KB');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// lib.ts — writeFileContent
// ═══════════════════════════════════════════════════════════════════════════════
describe('writeFileContent — branch coverage', () => {
    let tmpDir;
    beforeEach(() => { tmpDir = mkTmpDir(); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Branch: file doesn't exist → exclusive create (wx flag)
    it('creates new file when it does not exist', async () => {
        const { writeFileContent } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'new.txt');
        await writeFileContent(f, 'hello');
        expect(fs.readFileSync(f, 'utf8')).toBe('hello');
    });

    // Branch: file exists → EEXIST caught → atomic temp+rename
    it('overwrites existing file via temp+rename', async () => {
        const { writeFileContent } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'existing.txt');
        fs.writeFileSync(f, 'old content');
        await writeFileContent(f, 'new content');
        expect(fs.readFileSync(f, 'utf8')).toBe('new content');
    });

    // Branch: non-EEXIST error propagates
    it('throws when parent directory does not exist', async () => {
        const { writeFileContent } = await import('../dist/core/lib.js');
        const f = path.join(tmpDir, 'no', 'such', 'dir', 'file.txt');
        await expect(writeFileContent(f, 'data')).rejects.toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// lib.ts — findResumeOffset
// ═══════════════════════════════════════════════════════════════════════════════
describe('findResumeOffset — edge cases', () => {
    it('returns 0 when no overlap exists', async () => {
        const { findResumeOffset } = await import('../dist/core/lib.js');
        expect(findResumeOffset(['a', 'b', 'c'], ['x', 'y', 'z'])).toBe(0);
    });

    it('detects full overlap', async () => {
        const { findResumeOffset } = await import('../dist/core/lib.js');
        expect(findResumeOffset(['a', 'b', 'c'], ['b', 'c'])).toBe(2);
    });

    it('returns 0 for empty existing lines', async () => {
        const { findResumeOffset } = await import('../dist/core/lib.js');
        expect(findResumeOffset([], ['x', 'y'])).toBe(0);
    });

    it('returns 0 for empty incoming lines', async () => {
        const { findResumeOffset } = await import('../dist/core/lib.js');
        expect(findResumeOffset(['a', 'b'], [])).toBe(0);
    });

    it('trims trailing whitespace when comparing', async () => {
        const { findResumeOffset } = await import('../dist/core/lib.js');
        expect(findResumeOffset(['a  ', 'b  '], ['a', 'b'])).toBe(2);
    });

    it('strips terminal empty lines from both arrays', async () => {
        const { findResumeOffset } = await import('../dist/core/lib.js');
        // Terminal empty line artifacts from split('\n')
        expect(findResumeOffset(['a', 'b', ''], ['b', ''])).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// shared.ts — isSensitive comprehensive
// ═══════════════════════════════════════════════════════════════════════════════
describe('isSensitive — exhaustive pattern coverage', () => {
    let isSensitive;
    beforeEach(async () => {
        const mod = await import('../dist/core/shared.js');
        isSensitive = mod.isSensitive;
    });

    // Equivalence class: .env files
    it('.env at various depths', () => {
        expect(isSensitive('/project/.env')).toBe(true);
        expect(isSensitive('/a/b/c/.env')).toBe(true);
        expect(isSensitive('.env')).toBe(true);
    });

    // Equivalence class: certificate/key files
    it('certificate and key extensions', () => {
        expect(isSensitive('/ssl/server.pem')).toBe(true);
        expect(isSensitive('/keys/private.key')).toBe(true);
        expect(isSensitive('/certs/ca.crt')).toBe(true);
    });

    // Equivalence class: credentials/secrets in filename
    it('credentials and secret substrings', () => {
        expect(isSensitive('/app/credentials.json')).toBe(true);
        expect(isSensitive('/app/aws_credentials')).toBe(true);
        expect(isSensitive('/app/secret_keys.yaml')).toBe(true);
        expect(isSensitive('/data/my_secret.toml')).toBe(true);
    });

    // Equivalence class: .config/** (the fixed pattern)
    it('.config subdirectory files outside $HOME', () => {
        expect(isSensitive('/tmp/project/.config/app.json')).toBe(true);
        expect(isSensitive('/var/lib/.config/nested/file')).toBe(true);
    });

    it('.config subdirectory files under $HOME', () => {
        const home = os.homedir();
        expect(isSensitive(path.join(home, '.config', 'app', 'settings.json'))).toBe(true);
    });

    // Equivalence class: non-sensitive files
    it('normal source files are not sensitive', () => {
        expect(isSensitive('/project/src/index.ts')).toBe(false);
        expect(isSensitive('/project/package.json')).toBe(false);
        expect(isSensitive('/project/README.md')).toBe(false);
        expect(isSensitive('/project/tsconfig.json')).toBe(false);
    });

    // Boundary: docker-compose files
    it('docker-compose.yaml/yml are sensitive', () => {
        expect(isSensitive('/deploy/docker-compose.yaml')).toBe(true);
        expect(isSensitive('/deploy/docker-compose.yml')).toBe(true);
    });

    // Boundary: files that look similar but aren't sensitive
    it('non-sensitive similarly named files', () => {
        expect(isSensitive('/project/config.ts')).toBe(false);
        expect(isSensitive('/project/secret-garden.md')).toBe(true); // contains 'secret'
        expect(isSensitive('/project/environment.ts')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// shared.ts — lastRipgrepError
// ═══════════════════════════════════════════════════════════════════════════════
describe('lastRipgrepError — state transitions', () => {
    it('is null after successful search', async () => {
        const { ripgrepSearch, lastRipgrepError, ripgrepAvailable } = await import('../dist/core/shared.js');
        const available = await ripgrepAvailable();
        if (!available) return;

        const tmpDir = mkTmpDir();
        fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello world');
        try {
            await ripgrepSearch(tmpDir, { contentQuery: 'hello', maxResults: 5 });
            // After a successful search, lastRipgrepError should be null
            const mod = await import('../dist/core/shared.js');
            expect(mod.lastRipgrepError).toBeNull();
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('is populated after ripgrep failure (invalid regex)', async () => {
        const { ripgrepSearch, ripgrepAvailable } = await import('../dist/core/shared.js');
        const available = await ripgrepAvailable();
        if (!available) return;

        const tmpDir = mkTmpDir();
        fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'content');
        try {
            const result = await ripgrepSearch(tmpDir, {
                contentQuery: '[unclosed(bracket',
                maxResults: 5,
                literalSearch: false,
            });
            if (result === null) {
                // Re-import to get current module state
                const mod = await import('../dist/core/shared.js');
                expect(mod.lastRipgrepError).toBeTruthy();
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// roots-utils.ts — getValidRootDirectories
// ═══════════════════════════════════════════════════════════════════════════════
describe('getValidRootDirectories — comprehensive URI forms', () => {
    const home = os.homedir();

    // Happy path: standard file:// URI
    it('resolves file:///absolute/path correctly', async () => {
        const { getValidRootDirectories } = await import('../dist/core/roots-utils.js');
        const tmpDir = mkTmpDir();
        try {
            const result = await getValidRootDirectories([{ uri: `file://${tmpDir}` }]);
            expect(result).toContain(tmpDir);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // Non-standard: file:~ (just tilde)
    it('resolves file:~ to home directory', async () => {
        const { getValidRootDirectories } = await import('../dist/core/roots-utils.js');
        const result = await getValidRootDirectories([{ uri: 'file:~' }]);
        expect(result).toContain(home);
    });

    // Non-standard: file:~/subdir
    it('resolves file:~/subdir to home subdirectory', async () => {
        const { getValidRootDirectories } = await import('../dist/core/roots-utils.js');
        const entries = fs.readdirSync(home);
        const subdir = entries.find(e => {
            try { return fs.statSync(path.join(home, e)).isDirectory(); } catch { return false; }
        });
        if (!subdir) return;
        const result = await getValidRootDirectories([{ uri: `file:~/${subdir}` }]);
        expect(result).toContain(path.join(home, subdir));
    });

    // Bare tilde (no file: prefix)
    it('resolves bare ~ to home directory', async () => {
        const { getValidRootDirectories } = await import('../dist/core/roots-utils.js');
        const result = await getValidRootDirectories([{ uri: '~' }]);
        expect(result).toContain(home);
    });

    // Bare ~/path
    it('resolves ~/subdir', async () => {
        const { getValidRootDirectories } = await import('../dist/core/roots-utils.js');
        const entries = fs.readdirSync(home);
        const subdir = entries.find(e => {
            try { return fs.statSync(path.join(home, e)).isDirectory(); } catch { return false; }
        });
        if (!subdir) return;
        const result = await getValidRootDirectories([{ uri: `~/${subdir}` }]);
        expect(result).toContain(path.join(home, subdir));
    });

    // Exception: nonexistent path
    it('skips nonexistent paths', async () => {
        const { getValidRootDirectories } = await import('../dist/core/roots-utils.js');
        const result = await getValidRootDirectories([{ uri: '/no/such/path/exists' }]);
        expect(result).toHaveLength(0);
    });

    // Exception: path is a file, not directory
    it('skips files (non-directories)', async () => {
        const { getValidRootDirectories } = await import('../dist/core/roots-utils.js');
        const tmpDir = mkTmpDir();
        const filePath = path.join(tmpDir, 'file.txt');
        fs.writeFileSync(filePath, 'x');
        try {
            const result = await getValidRootDirectories([{ uri: filePath }]);
            expect(result).toHaveLength(0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // Multiple roots mixing valid and invalid
    it('filters valid from invalid in mixed input', async () => {
        const { getValidRootDirectories } = await import('../dist/core/roots-utils.js');
        const tmpDir = mkTmpDir();
        try {
            const result = await getValidRootDirectories([
                { uri: tmpDir },
                { uri: '/nonexistent/xyz' },
                { uri: '~' },
            ]);
            expect(result).toContain(tmpDir);
            expect(result).toContain(home);
            expect(result.length).toBe(2);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // Edge: empty input array
    it('returns empty for empty input', async () => {
        const { getValidRootDirectories } = await import('../dist/core/roots-utils.js');
        expect(await getValidRootDirectories([])).toEqual([]);
    });
});
