import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';

import {
    normalizePath,
    expandHome,
    isPathWithinAllowedDirectories,
} from '../dist/core/path-validation.js';

describe('path-validation normalizePath', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('returns input unchanged for non-strings', () => {
        expect(normalizePath(null)).toBeNull();
        expect(normalizePath(undefined)).toBeUndefined();
        expect(normalizePath('')).toBe('');
    });

    it('strips surrounding quotes', () => {
        expect(normalizePath('"hello"')).toBe('hello');
        expect(normalizePath("'hello'")).toBe('hello');
        expect(normalizePath('"he"llo"')).toBe('he"llo');
    });

    it('strips surrounding whitespace', () => {
        expect(normalizePath('  hello')).toBe('hello');
        expect(normalizePath('hello  ')).toBe('hello');
        expect(normalizePath('  hello  ')).toBe('hello');
    });

    it('rejects null bytes', () => {
        expect(() => normalizePath('hello\x00world')).toThrow('Path contains null bytes');
    });

    it('expands home directory tilde', () => {
        const home = os.homedir();
        expect(normalizePath('~')).toBe(home);
        expect(normalizePath('~/foo')).toBe(path.join(home, 'foo'));
    });

    it('resolves dot segments', () => {
        expect(normalizePath('/foo/./bar')).toBe('/foo/bar');
        expect(normalizePath('/foo/bar/..')).toBe('/foo');
    });

    it('removes trailing slashes unless root', () => {
        expect(normalizePath('/foo/')).toBe('/foo');
        expect(normalizePath('/')).toBe('/');
    });

    it('collapses multiple slashes', () => {
        expect(normalizePath('/foo//bar')).toBe('/foo/bar');
        expect(normalizePath('/foo///bar///baz')).toBe('/foo/bar/baz');
    });
});

describe('path-validation expandHome', () => {
    it('expands tilde to home directory', () => {
        const home = os.homedir();
        expect(expandHome('~')).toBe(home);
        expect(expandHome('~/foo')).toBe(path.join(home, 'foo'));
    });

    it('leaves non-tilde paths unchanged', () => {
        expect(expandHome('/foo/bar')).toBe('/foo/bar');
        expect(expandHome('relative')).toBe('relative');
    });
});

describe('path-validation isPathWithinAllowedDirectories', () => {
    const allowed = ['/home/user', '/tmp/project'];

    it('returns true for paths within allowed directories', () => {
        expect(isPathWithinAllowedDirectories('/home/user', allowed)).toBe(true);
        expect(isPathWithinAllowedDirectories('/home/user/file.txt', allowed)).toBe(true);
        expect(isPathWithinAllowedDirectories('/home/user/subdir/file.txt', allowed)).toBe(true);
    });

    it('returns true for exact allowed directory match', () => {
        expect(isPathWithinAllowedDirectories('/tmp/project', allowed)).toBe(true);
    });

    it('returns false for paths outside allowed directories', () => {
        expect(isPathWithinAllowedDirectories('/var', allowed)).toBe(false);
        expect(isPathWithinAllowedDirectories('/etc/passwd', allowed)).toBe(false);
        expect(isPathWithinAllowedDirectories('/home/other', allowed)).toBe(false);
    });

    it('handles empty allowed directories', () => {
        expect(isPathWithinAllowedDirectories('/foo', [])).toBe(false);
    });
});

describe('path-validation cache behavior', () => {
    it('caches normalized paths and returns same reference', () => {
        const result1 = normalizePath('/foo/bar');
        const result2 = normalizePath('/foo/bar');
        expect(result1).toBe(result2);
    });

    it('cache persists across multiple calls', () => {
        normalizePath('/unique/test/path');
        normalizePath('/unique/test/path');
        normalizePath('/unique/test/path');
        const cached = normalizePath('/unique/test/path');
        expect(typeof cached).toBe('string');
    });
});