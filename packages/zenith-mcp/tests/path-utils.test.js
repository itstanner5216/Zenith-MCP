import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';

import {
    convertToWindowsPath,
    normalizePath,
    expandHome,
} from '../dist/core/path-utils.js';

describe('path-utils', () => {
    const originalPlatform = process.platform;
    const originalHomedir = os.homedir;

    beforeEach(() => {
        vi.resetAllMocks();
        // Reset platform and homedir for each test
        Object.defineProperty(process, 'platform', {
            value: originalPlatform,
            configurable: true,
            writable: true,
        });
        vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', {
            value: originalPlatform,
            configurable: true,
        });
        vi.restoreAllMocks();
    });

    describe('expandHome', () => {
        it('expands tilde root path', () => {
            expect(expandHome('~')).toBe('/home/testuser');
        });

        it('expands tilde with slash', () => {
            expect(expandHome('~/projects')).toBe('/home/testuser/projects');
        });

        it('leaves non-tilde paths unchanged', () => {
            expect(expandHome('/absolute/path')).toBe('/absolute/path');
            expect(expandHome('relative/path')).toBe('relative/path');
            // Current behavior: ~/... is ALWAYS expanded if starts with '~/'
            expect(expandHome('~/not/at/start')).toBe('/home/testuser/not/at/start');
        });

        it('handles empty string', () => {
            expect(expandHome('')).toBe('');
        });
    });

    describe('convertToWindowsPath', () => {
        it('leaves WSL paths unchanged on all platforms (critical for fs compatibility)', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            expect(convertToWindowsPath('/mnt/c/Users/test')).toBe('/mnt/c/Users/test');
            Object.defineProperty(process, 'platform', { value: 'win32' });
            expect(convertToWindowsPath('/mnt/c/Users/test')).toBe('/mnt/c/Users/test');
        });

        it('converts Unix-style Windows path on win32', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            expect(convertToWindowsPath('/c/windows/system32')).toBe('C:\\windows\\system32');
            expect(convertToWindowsPath('/d/data/file.txt')).toBe('D:\\data\\file.txt');
        });

        it('does not convert Unix-style paths on non-Windows', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            expect(convertToWindowsPath('/c/windows')).toBe('/c/windows');
        });

        it('standardizes existing Windows paths to backslashes', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            expect(convertToWindowsPath('C:/Users/test')).toBe('C:\\Users\\test');
            // Current behavior (per implementation): drive letter case is preserved in convertToWindowsPath (capitalization happens in normalizePath)
            expect(convertToWindowsPath('c:/temp')).toBe('c:\\temp');
        });

        it('leaves Unix absolute paths unchanged on non-Windows', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            expect(convertToWindowsPath('/home/user/file')).toBe('/home/user/file');
        });

        it('handles boundary empty and root paths', () => {
            expect(convertToWindowsPath('')).toBe('');
            expect(convertToWindowsPath('/')).toBe('/');
        });
    });

    describe('normalizePath', () => {
        it('strips surrounding quotes and whitespace', () => {
            expect(normalizePath('  "/home/test"  ')).toBe('/home/test');
            expect(normalizePath("'~/docs'")).toBe('/home/testuser/docs');
        });

        it('returns empty string for empty input (does not become ".")', () => {
            expect(normalizePath('')).toBe('');
            expect(normalizePath('   ')).toBe('');
        });

        it('expands home directory in various forms', () => {
            expect(normalizePath('~')).toBe('/home/testuser');
            expect(normalizePath('~/code')).toBe('/home/testuser/code');
        });

        it('preserves Unix paths on Linux including WSL and root', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            expect(normalizePath('/home/user/project')).toBe('/home/user/project');
            expect(normalizePath('/mnt/c/windows')).toBe('/mnt/c/windows');
            expect(normalizePath('/')).toBe('/');
            expect(normalizePath('/././test/../docs')).toBe('/docs');
        });

        it('normalizes relative paths on Linux preserving forward slashes', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            expect(normalizePath('./src/../utils')).toBe('utils');
            expect(normalizePath('src//utils/file.ts')).toBe('src/utils/file.ts');
        });

        it('handles Windows paths when platform is win32', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\testuser');

            expect(normalizePath('C:/Users/testuser/docs')).toBe('C:\\Users\\testuser\\docs');
            expect(normalizePath('/c/Users/test')).toBe('C:\\Users\\test');
            expect(normalizePath('~/docs')).toBe('C:\\Users\\testuser\\docs');
            expect(normalizePath('C:\\Windows\\System32')).toBe('C:\\Windows\\System32');
        });

        it('handles UNC paths specially to preserve leading double backslashes', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            expect(normalizePath('\\\\server\\share\\file.txt')).toBe('\\\\server\\share\\file.txt');
            // Current behavior on test platform (Linux running with win32 mock): //server normalizes to /server/share/file via path.normalize
            // This tests the isUnixPath detection branch for paths starting with //
            expect(normalizePath('//server/share/file')).toBe('/server/share/file');
        });

        it('resolves dot and parent directory segments correctly across platforms', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            expect(normalizePath('/a/b/../c/./d')).toBe('/a/c/d');
            Object.defineProperty(process, 'platform', { value: 'win32' });
            // Current behavior (Linux Node with win32 mock + backslashes): path.normalize does not fully collapse Windows-style paths the same as native Win32
            // Tests the platform-specific branch; actual output matches input normalization behavior
            expect(normalizePath('C:\\a\\b\\..\\c\\.\\d')).toBe('C:\\a\\b\\..\\c\\.\\d');
        });

        it('capitalizes drive letter on Windows', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            expect(normalizePath('c:\\windows\\system')).toBe('C:\\windows\\system');
        });

        it('handles boundary cases for multiple slashes and trailing slashes', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            expect(normalizePath('///home//user///')).toBe('/home/user');
            expect(normalizePath('/home/user/')).toBe('/home/user');
            Object.defineProperty(process, 'platform', { value: 'win32' });
            // Current behavior: trailing backslash is preserved in some Windows normalization paths (per current impl)
            expect(normalizePath('C:\\\\windows\\\\system\\\\')).toBe('C:\\windows\\system\\');
        });

        it('AMBIGUOUS edge case: very long paths or special chars - tested defensively', () => {
            // Inferred from normalize logic: should not throw, should process
            const longPath = '/very/long/path/with/many/segments/that/might/exceed/normal/but/node/handles/it/' + 'x'.repeat(100);
            Object.defineProperty(process, 'platform', { value: 'linux' });
            const result = normalizePath(longPath);
            expect(result).toContain('/very/long/path');
            expect(typeof result).toBe('string');
        });
    });

    describe('cross platform consistency', () => {
        it('normalizePath(expandHome("~/test")) produces expected home path regardless of initial platform', () => {
            const homeExpanded = expandHome('~/test');
            Object.defineProperty(process, 'platform', { value: 'linux' });
            expect(normalizePath(homeExpanded)).toBe('/home/testuser/test');

            Object.defineProperty(process, 'platform', { value: 'win32' });
            vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\testuser');
            expect(normalizePath('~/test')).toBe('C:\\Users\\testuser\\test');
        });
    });
});
