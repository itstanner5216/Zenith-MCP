// polaris-basis-conservation.test.js — POLARIS Task 2.4 (seeded at 2.3)
//
// The evidence lattice and coverage algebra: composed grades never exceed
// their weakest input, candidate/issue orders are canonical and free of row
// IDs or insertion order, and coverage cannot silently drop a requested
// domain. This file grows composer-level conservation properties in Task 2.4;
// the pure-algebra pins land with the module itself.

import { describe, it, expect } from 'vitest';

import {
    canonicalIssues, compareCandidates, comparePositions, coverageBuilder,
    factKey, gradeAtMost, gradeOfBasis, gradeRank, rangeKey, textKey, weakestGrade,
} from '../dist/core/intelligence/evidence.js';

const GRADES = ['text', 'structural', 'binding'];

describe('the grade lattice', () => {
    it('orders text < structural < binding', () => {
        expect(gradeRank('text')).toBeLessThan(gradeRank('structural'));
        expect(gradeRank('structural')).toBeLessThan(gradeRank('binding'));
    });

    it('weakestGrade is the meet: commutative, idempotent, never stronger', () => {
        for (const a of GRADES) {
            expect(weakestGrade(a)).toBe(a);
            for (const b of GRADES) {
                const m = weakestGrade(a, b);
                expect(m).toBe(weakestGrade(b, a));
                expect(gradeAtMost(m, a)).toBe(true);
                expect(gradeAtMost(m, b)).toBe(true);
                for (const c of GRADES) {
                    // associativity via variadic form
                    expect(weakestGrade(a, b, c)).toBe(weakestGrade(weakestGrade(a, b), c));
                }
            }
        }
        expect(weakestGrade('binding', 'text', 'structural')).toBe('text');
    });

    it('every candidate basis maps to a total, honest grade', () => {
        const bindingBases = ['declaration_self', 'lexical_scope', 'explicit_import',
            'explicit_reexport', 'qualified_namespace', 'direct_member', 'language_global'];
        for (const basis of bindingBases) expect(gradeOfBasis(basis)).toBe('binding');
        for (const basis of ['exact_declaration', 'parent_containment', 'heuristic_name']) {
            expect(gradeOfBasis(basis)).toBe('structural');
        }
        expect(gradeOfBasis('text_occurrence')).toBe('text');
    });
});

describe('canonical orders', () => {
    const mk = (over = {}) => ({
        symbol: { path: 'src/a.ts', handle: { stableKey: 'k1' } },
        proofGrade: 'structural',
        qualifierVerified: false,
        sameFile: false,
        nearDistance: null,
        line: 10,
        column: 0,
        ...over,
    });

    it('candidates: grade desc, qualifier desc, sameFile desc, near asc null-last, then stable keys', () => {
        const items = [
            mk({ proofGrade: 'text', symbol: { path: 'src/z.ts', handle: { stableKey: 'z' } } }),
            mk({ proofGrade: 'binding' }),
            mk({ qualifierVerified: true }),
            mk({ sameFile: true }),
            mk({ nearDistance: 3 }),
            mk({ nearDistance: 1 }),
            mk(),
        ];
        const sorted = [...items].sort(compareCandidates);
        expect(sorted[0].proofGrade).toBe('binding');
        expect(sorted[1].qualifierVerified).toBe(true);
        expect(sorted[2].sameFile).toBe(true);
        expect(sorted[3].nearDistance).toBe(1);
        expect(sorted[4].nearDistance).toBe(3);
        expect(sorted[5].nearDistance).toBeNull();
        expect(sorted[6].proofGrade).toBe('text');
    });

    it('ordering is permutation-invariant (no insertion-order dependence)', () => {
        const items = [
            mk({ line: 2 }), mk({ line: 1, column: 5 }), mk({ line: 1, column: 2 }),
            mk({ proofGrade: 'binding' }), mk({ nearDistance: 7 }),
            mk({ symbol: { path: 'src/b.ts', handle: { stableKey: 'b' } } }),
        ];
        const oracle = [...items].sort(compareCandidates);
        for (let i = 0; i < 20; i++) {
            const shuffled = [...items].sort(() => Math.random() - 0.5);
            expect(shuffled.sort(compareCandidates)).toEqual(oracle);
        }
    });

    it('positions: line, column null-first as -1, endLine, kind, name', () => {
        const rows = [
            { startLine: 2, startColumn: 0, endLine: 2, kind: 'def', name: 'b' },
            { startLine: 1, startColumn: null, endLine: 1, kind: 'def', name: 'a' },
            { startLine: 1, startColumn: 0, endLine: 1, kind: 'def', name: 'a' },
            { startLine: 1, startColumn: 0, endLine: 1, kind: 'def', name: 'A' },
        ];
        const sorted = [...rows].sort(comparePositions);
        expect(sorted[0].startColumn).toBeNull();
        expect(sorted[1].name).toBe('A'); // uppercase sorts before lowercase — byte order
        expect(sorted[2].name).toBe('a');
        expect(sorted[3].startLine).toBe(2);
    });

    it('issues: closed-enum order, deduplicated', () => {
        expect(canonicalIssues(['semantic_pending', 'incomplete_cap', 'semantic_pending', 'parse_tainted']))
            .toEqual(['incomplete_cap', 'parse_tainted', 'semantic_pending']);
    });
});

describe('coverage algebra', () => {
    it('every requested domain must resolve — silent drops throw', () => {
        const cov = coverageBuilder();
        cov.request('declaration');
        cov.request('export');
        cov.complete('declaration');
        expect(() => cov.build()).toThrow(/dropped a requested domain silently: export/);
        cov.unavailable('export', 'question_kind_unsupported');
        const built = cov.build();
        expect(built.complete).toEqual(['declaration']);
        expect(built.unavailable).toEqual([{ domain: 'export', reason: 'question_kind_unsupported' }]);
        expect(built.tainted).toBe(false);
    });

    it('unavailable beats complete for the same domain, taint is sticky, issues canonical', () => {
        const cov = coverageBuilder();
        cov.request('reference');
        cov.complete('reference');
        cov.unavailable('reference', 'path_outside_scope');
        cov.taint();
        cov.issue('semantic_pending');
        cov.issue('incomplete_cap');
        const built = cov.build();
        expect(built.complete).toEqual([]);
        expect(built.unavailable[0].reason).toBe('path_outside_scope');
        expect(built.tainted).toBe(true);
        expect(built.issues).toEqual(['incomplete_cap', 'semantic_pending']);
    });
});

describe('handle keys', () => {
    const base = {
        scopeKey: 'g/abc',
        path: 'src/a.ts',
        sourceHash: 'h1',
        family: 'declaration',
        occurrenceKey: 'def:alphaFn:1',
        range: { precision: 'line', startLine: 1, startColumn: 0, endLine: 3 },
        kind: 'function',
        name: 'alphaFn',
    };

    it('is stable for identical inputs and moves for every field', () => {
        const key = factKey(base);
        expect(key).toBe(factKey({ ...base }));
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        for (const [field, value] of [
            ['scopeKey', 'g/xyz'], ['path', 'src/b.ts'], ['sourceHash', 'h2'],
            ['family', 'reference'], ['occurrenceKey', 'def:alphaFn:2'],
            ['kind', 'method'], ['name', 'betaFn'],
            ['range', { precision: 'line', startLine: 2, startColumn: 0, endLine: 3 }],
        ]) {
            expect(factKey({ ...base, [field]: value }), `field ${field} must move the key`).not.toBe(key);
        }
    });

    it('length-prefixing prevents concatenation ambiguity', () => {
        // ('ab','c') and ('a','bc') must not collide.
        const a = factKey({ ...base, path: 'ab', sourceHash: 'c' });
        const b = factKey({ ...base, path: 'a', sourceHash: 'bc' });
        expect(a).not.toBe(b);
    });

    it('fact and text domains never collide', () => {
        const t = textKey({
            sourceDomainDigest: base.scopeKey,
            path: base.path,
            range: base.range,
            literal: base.name,
        });
        expect(t).not.toBe(factKey(base));
        expect(t).toMatch(/^[0-9a-f]{64}$/);
    });

    it('range keys distinguish precision and null columns', () => {
        expect(rangeKey({ precision: 'byte', startByte: 0, endByte: 5 }))
            .not.toBe(rangeKey({ precision: 'line', startLine: 0, startColumn: 0, endLine: 5 }));
        expect(rangeKey({ precision: 'line', startLine: 1, startColumn: null, endLine: 1 }))
            .toBe('l:1:-1:1');
    });
});
