import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
    formatSize,
    normalizeLineEndings,
    countOccurrences,
    applyFileEdits,
    createUnifiedDiff,
    createMinimalDiff,
    tailFile,
} from '../dist/core/lib.js';

describe('lib formatSize', () => {
    it('returns "0 B" for zero bytes', () => {
        expect(formatSize(0)).toBe('0 B');
    });

    it('formats bytes correctly', () => {
        expect(formatSize(512)).toBe('512 B');
    });

    it('formats kilobytes correctly', () => {
        expect(formatSize(1024)).toBe('1.00 KB');
    });

    it('formats megabytes correctly', () => {
        expect(formatSize(1048576)).toBe('1.00 MB');
    });

    it('formats gigabytes correctly', () => {
        expect(formatSize(1073741824)).toBe('1.00 GB');
    });

    it('formats terabytes correctly', () => {
        expect(formatSize(1099511627776)).toBe('1.00 TB');
    });

    it('handles non-round sizes', () => {
        expect(formatSize(1536)).toBe('1.50 KB');
    });

    it('handles 1 byte', () => {
        expect(formatSize(1)).toBe('1 B');
    });
});

describe('lib normalizeLineEndings', () => {
    it('converts CRLF to LF', () => {
        expect(normalizeLineEndings('line1\r\nline2\r\n')).toBe('line1\nline2\n');
    });

    it('leaves LF-only text unchanged', () => {
        expect(normalizeLineEndings('line1\nline2\n')).toBe('line1\nline2\n');
    });

    it('handles mixed CRLF and LF', () => {
        expect(normalizeLineEndings('a\r\nb\nc\r\n')).toBe('a\nb\nc\n');
    });

    it('handles empty string', () => {
        expect(normalizeLineEndings('')).toBe('');
    });

    it('handles string with no newlines', () => {
        expect(normalizeLineEndings('hello')).toBe('hello');
    });
});

describe('lib countOccurrences', () => {
    it('counts single occurrence', () => {
        expect(countOccurrences('hello world', 'world')).toBe(1);
    });

    it('counts multiple non-overlapping occurrences', () => {
        expect(countOccurrences('abcabcabc', 'abc')).toBe(3);
    });

    it('returns 0 when needle not found', () => {
        expect(countOccurrences('hello', 'xyz')).toBe(0);
    });

    it('handles empty haystack', () => {
        expect(countOccurrences('', 'test')).toBe(0);
    });

    it('handles multiline text with CRLF normalization', () => {
        expect(countOccurrences('a\r\nb\r\na', 'a')).toBe(2);
    });

    it('counts correctly when needle appears at start and end', () => {
        expect(countOccurrences('xyzhelloxyz', 'xyz')).toBe(2);
    });

    it('rejects empty search strings', () => {
        expect(() => countOccurrences('hello world', '')).toThrow('countOccurrences: search must not be empty');
    });
});

describe('lib applyFileEdits', () => {
    it('rejects empty oldText before attempting to match', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-utils-'));
        const filePath = path.join(tempDir, 'sample.txt');
        try {
            await fs.writeFile(filePath, 'hello world\n', 'utf-8');
            await expect(
                applyFileEdits(filePath, [{ oldText: '', newText: 'replacement' }], true)
            ).rejects.toThrow('applyFileEdits: oldText must not be empty');
        } finally {
            try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
        }
    });
});

describe('lib tailFile', () => {
    // Covers large-file branch and guards against O(n²)-style repeated string
    // prepending regressions by requiring correct tail output across many chunks.
    it('returns the requested final lines from a large file without scanning output order incorrectly', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tail-file-test-'));
        const filePath = path.join(tempDir, 'large.log');
        try {
            const lines = Array.from({ length: 30_000 }, (_, i) => `line-${i + 1}`);
            await fs.writeFile(filePath, lines.join('\n'), 'utf-8');

            const result = await tailFile(filePath, 4);

            expect(result).toBe('line-29997\nline-29998\nline-29999\nline-30000');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('returns empty string for non-positive requested line counts', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tail-file-empty-test-'));
        const filePath = path.join(tempDir, 'sample.log');
        try {
            await fs.writeFile(filePath, 'line-1\nline-2', 'utf-8');

            await expect(tailFile(filePath, 0)).resolves.toBe('');
            await expect(tailFile(filePath, -1)).resolves.toBe('');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});

describe('lib createUnifiedDiff', () => {
    it('produces diff with header when content differs', () => {
        const diff = createUnifiedDiff('old line\n', 'new line\n', 'test.txt');
        expect(diff).toContain('test.txt');
        expect(diff).toContain('-old line');
        expect(diff).toContain('+new line');
    });

    it('produces no additions when content is identical', () => {
        const diff = createUnifiedDiff('same\n', 'same\n');
        expect(diff).not.toContain('-same');
        expect(diff).not.toContain('+same');
    });

    it('normalizes CRLF before diffing', () => {
        const diff = createUnifiedDiff('line1\r\nline2\r\n', 'line1\nline2\n');
        expect(diff).not.toContain('-line1');
        expect(diff).not.toContain('+line1');
    });
});

describe('lib createMinimalDiff', () => {
    it('produces minimal diff with zero context lines', () => {
        const diff = createMinimalDiff('a\nb\nc\n', 'a\nx\nc\n', 'f.txt');
        expect(diff).toContain('-b');
        expect(diff).toContain('+x');
    });

    it('handles identical content', () => {
        const diff = createMinimalDiff('same\n', 'same\n');
        expect(diff).toContain('---');
        expect(diff).toContain('+++');
    });
});
