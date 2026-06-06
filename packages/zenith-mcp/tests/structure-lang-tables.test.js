// structure-lang-tables.test.js
//
// Tests for the pure lookup functions added to tree-sitter/structure.ts:
//   - paramContainersFor(langName)
//   - modifierKeywordsFor(langName)
//
// These are pure table lookups — no tree-sitter runtime, no file I/O.

import { describe, expect, it } from 'vitest';
import { paramContainersFor, modifierKeywordsFor } from '../dist/core/tree-sitter/structure.js';

// ---------------------------------------------------------------------------
// paramContainersFor
// ---------------------------------------------------------------------------

describe('paramContainersFor', () => {
    it('returns the language-specific set for typescript', () => {
        const containers = paramContainersFor('typescript');
        expect(containers.has('formal_parameters')).toBe(true);
        expect(containers.has('type_parameters')).toBe(true);
    });

    it('returns the language-specific set for javascript', () => {
        const containers = paramContainersFor('javascript');
        expect(containers.has('formal_parameters')).toBe(true);
    });

    it('returns the language-specific set for tsx (same as typescript)', () => {
        const tsSets = paramContainersFor('typescript');
        const tsxSets = paramContainersFor('tsx');
        // tsx and typescript share the same container types
        for (const t of tsSets) {
            expect(tsxSets.has(t)).toBe(true);
        }
    });

    it('returns the language-specific set for python (parameters)', () => {
        const containers = paramContainersFor('python');
        expect(containers.has('parameters')).toBe(true);
        // python uses 'parameters', not 'formal_parameters'
        expect(containers.has('formal_parameters')).toBe(false);
    });

    it('returns the language-specific set for go', () => {
        const containers = paramContainersFor('go');
        expect(containers.has('parameter_list')).toBe(true);
        expect(containers.has('type_parameter_list')).toBe(true);
    });

    it('returns the language-specific set for rust', () => {
        const containers = paramContainersFor('rust');
        expect(containers.has('parameters')).toBe(true);
        expect(containers.has('closure_parameters')).toBe(true);
    });

    it('returns the language-specific set for java', () => {
        const containers = paramContainersFor('java');
        expect(containers.has('formal_parameters')).toBe(true);
        expect(containers.has('receiver_parameter')).toBe(true);
    });

    it('returns the language-specific set for c_sharp', () => {
        const containers = paramContainersFor('c_sharp');
        expect(containers.has('parameter_list')).toBe(true);
        expect(containers.has('bracketed_parameter_list')).toBe(true);
    });

    it('returns empty set for bash (bash has no formal parameter nodes)', () => {
        const containers = paramContainersFor('bash');
        expect(containers.size).toBe(0);
    });

    it('falls back to PARAM_CONTAINER_FALLBACK for unknown languages', () => {
        const containers = paramContainersFor('unknown_lang_xyz');
        // Fallback includes all the common container names
        expect(containers.has('parameters')).toBe(true);
        expect(containers.has('formal_parameters')).toBe(true);
        expect(containers.has('parameter_list')).toBe(true);
    });

    it('returns a ReadonlySet (has, size available)', () => {
        const containers = paramContainersFor('typescript');
        expect(typeof containers.has).toBe('function');
        expect(typeof containers.size).toBe('number');
    });
});

// ---------------------------------------------------------------------------
// modifierKeywordsFor
// ---------------------------------------------------------------------------

describe('modifierKeywordsFor', () => {
    it('returns base keywords for a language with no overrides (e.g., python)', () => {
        const mods = modifierKeywordsFor('python');
        // Base set includes these
        expect(mods.has('public')).toBe(true);
        expect(mods.has('export')).toBe(true);
        expect(mods.has('static')).toBe(true);
    });

    it('for rust: includes rust-specific keywords (pub, unsafe)', () => {
        const mods = modifierKeywordsFor('rust');
        expect(mods.has('pub')).toBe(true);
        expect(mods.has('unsafe')).toBe(true);
        expect(mods.has('async')).toBe(true);
        // Also includes base keywords
        expect(mods.has('public')).toBe(true);
    });

    it('for kotlin: includes kotlin-specific keywords', () => {
        const mods = modifierKeywordsFor('kotlin');
        expect(mods.has('suspend')).toBe(true);
        expect(mods.has('override')).toBe(true);
        expect(mods.has('inline')).toBe(true);
        expect(mods.has('data')).toBe(true);
        // Base keywords still present
        expect(mods.has('public')).toBe(true);
    });

    it('for java: includes java-specific keywords', () => {
        const mods = modifierKeywordsFor('java');
        expect(mods.has('synchronized')).toBe(true);
        expect(mods.has('strictfp')).toBe(true);
        // Base keywords still present
        expect(mods.has('static')).toBe(true);
    });

    it('for c_sharp: includes c_sharp-specific keywords', () => {
        const mods = modifierKeywordsFor('c_sharp');
        expect(mods.has('virtual')).toBe(true);
        expect(mods.has('partial')).toBe(true);
        expect(mods.has('volatile')).toBe(true);
        // Base keywords still present
        expect(mods.has('override')).toBe(true);
    });

    it('for swift: includes swift-specific keywords', () => {
        const mods = modifierKeywordsFor('swift');
        expect(mods.has('fileprivate')).toBe(true);
        expect(mods.has('mutating')).toBe(true);
        expect(mods.has('convenience')).toBe(true);
    });

    it('for php: includes php-specific keywords', () => {
        const mods = modifierKeywordsFor('php');
        expect(mods.has('readonly')).toBe(true);
        expect(mods.has('final')).toBe(true);
    });

    it('for unknown lang: returns base keyword set unchanged', () => {
        const mods = modifierKeywordsFor('nolang_xyz');
        expect(mods.has('public')).toBe(true);
        expect(mods.has('private')).toBe(true);
        expect(mods.has('export')).toBe(true);
    });

    it('returns a superset when language extends base (union semantics)', () => {
        const base = modifierKeywordsFor('python'); // no overrides
        const rust = modifierKeywordsFor('rust');   // has rust extensions
        // Every base keyword is also in rust
        for (const kw of base) {
            expect(rust.has(kw)).toBe(true);
        }
        // Rust has additional keywords not in base
        expect(rust.size).toBeGreaterThan(base.size);
    });

    it('base set contains the core cross-language modifiers', () => {
        const mods = modifierKeywordsFor('go'); // no language-specific override for go
        const expected = ['public', 'private', 'protected', 'static', 'async',
                          'abstract', 'const', 'final', 'override', 'pub', 'export',
                          'default', 'readonly', 'virtual', 'sealed', 'internal',
                          'extern', 'inline', 'unsafe'];
        for (const kw of expected) {
            expect(mods.has(kw)).toBe(true);
        }
    });
});
