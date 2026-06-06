// languages-csharp.test.js
//
// Tests for the c_sharp rename in tree-sitter/languages.ts.
//
// PR diff: .cs and .csx were mapped to 'csharp'; they are now mapped to 'c_sharp'.
// This test verifies:
//   1. getLangForFile('.cs') returns 'c_sharp' (not 'csharp')
//   2. getLangForFile('.csx') returns 'c_sharp'
//   3. Other language mappings are unaffected (regression check)
//
// Also covers QUERIES_LANG_MAP consistency: 'c_sharp' key exists, 'csharp' is legacy.

import { describe, expect, it } from 'vitest';
import { getLangForFile, isSupported } from '../dist/core/tree-sitter/languages.js';
import { QUERIES_LANG_MAP } from '../dist/core/tree-sitter/runtime.js';

describe('getLangForFile — c_sharp rename', () => {
    it('maps .cs to c_sharp', () => {
        expect(getLangForFile('/project/src/MyClass.cs')).toBe('c_sharp');
    });

    it('maps .csx to c_sharp', () => {
        expect(getLangForFile('/project/src/Script.csx')).toBe('c_sharp');
    });

    it('does NOT return csharp for .cs (old name)', () => {
        expect(getLangForFile('/project/src/MyClass.cs')).not.toBe('csharp');
    });

    it('does NOT return csharp for .csx (old name)', () => {
        expect(getLangForFile('/project/src/Script.csx')).not.toBe('csharp');
    });

    it('isSupported returns true for .cs files', () => {
        expect(isSupported('/any/path/Foo.cs')).toBe(true);
    });

    it('isSupported returns true for .csx files', () => {
        expect(isSupported('/any/path/Script.csx')).toBe(true);
    });
});

describe('getLangForFile — regression: other languages unaffected', () => {
    it('.ts still maps to typescript', () => {
        expect(getLangForFile('foo.ts')).toBe('typescript');
    });

    it('.js still maps to javascript', () => {
        expect(getLangForFile('index.js')).toBe('javascript');
    });

    it('.py still maps to python', () => {
        expect(getLangForFile('script.py')).toBe('python');
    });

    it('.rs still maps to rust', () => {
        expect(getLangForFile('lib.rs')).toBe('rust');
    });

    it('.java still maps to java', () => {
        expect(getLangForFile('Main.java')).toBe('java');
    });

    it('.kt still maps to kotlin', () => {
        expect(getLangForFile('Main.kt')).toBe('kotlin');
    });

    it('.go still maps to go', () => {
        expect(getLangForFile('main.go')).toBe('go');
    });

    it('unrecognized extension returns null', () => {
        expect(getLangForFile('file.unknownXYZ')).toBeNull();
    });
});

describe('QUERIES_LANG_MAP — c_sharp key exists', () => {
    it('QUERIES_LANG_MAP has c_sharp key (not csharp)', () => {
        expect(Object.keys(QUERIES_LANG_MAP)).toContain('c_sharp');
    });

    it('c_sharp entry has at least definitions.scm', () => {
        expect(QUERIES_LANG_MAP['c_sharp']).toContain('definitions.scm');
    });
});