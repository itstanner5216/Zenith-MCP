// polaris-boundaries.test.js — POLARIS Task 0.4
//
// Boundary and source-ownership guards, live from Wave 0 so every later wave
// builds inside them rather than being audited after the fact:
//
//   1. Tree-sitter FACT extractors are ingestion-only: no production module
//      imports them except core/indexing/extract.ts and the tree-sitter
//      submodules themselves. The parse-only barrel (core/tree-sitter.ts) may
//      import runtime/languages plumbing and the sanctioned checkSyntaxErrors
//      surface — never the fact extractors.
//   2. queryRaw is a test-only escape hatch: zero production callers.
//   3. TOON is untouchable: the POLARIS plan's own file manifest (every
//      closed-allowlist path in AST_INTELLIGENCE_SYNTHESIS.md) must not name
//      a single file under packages/zenith-toon, and zenith-mcp source must
//      not import zenith-toon outside the one sanctioned compression seam.
//   4. Exactly one public intelligence facade may ever exist, at its
//      sanctioned path, and no intelligence file may be named for
//      compression/TOON.
//   5. Test fixtures resolve inside the tests root — no symlink escapes.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.join(TESTS_DIR, '..');
const SRC_DIR = path.join(PKG_DIR, 'src');
const PLAN_PATH = path.join(PKG_DIR, '..', '..', 'docs', 'concepts', 'AST_INTELLIGENCE_SYNTHESIS.md');

function walk(dir, ext) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p, ext);
        return e.isFile() && (!ext || p.endsWith(ext)) ? [p] : [];
    });
}

function rel(p) {
    return path.relative(SRC_DIR, p).split(path.sep).join('/');
}

const SRC_FILES = walk(SRC_DIR, '.ts');

// ---------------------------------------------------------------------------
// 1. Fact extractors are ingestion-only
// ---------------------------------------------------------------------------

// The fact-extraction submodules — the ones whose output feeds the index.
// runtime.js and languages.js are parse plumbing (grammar loading, language
// detection); they are not fact extractors and the barrel legitimately
// re-exports them.
const FACT_SUBMODULES = [
    'structure', 'anchors', 'imports', 'import-bindings',
    'injections', 'locals', 'body', 'symbols',
];

const FACT_IMPORT_RE = new RegExp(
    `from\\s+['"][^'"]*/tree-sitter/(${FACT_SUBMODULES.join('|')})(?:\\.js)?['"]`
);

describe('tree-sitter fact extractors are ingestion-only', () => {
    it('no production import of a fact submodule outside extract.ts, the submodules, and the sanctioned barrel surface', () => {
        const violations = [];
        for (const file of SRC_FILES) {
            const relPath = rel(file);
            const insideSubmodules = relPath.startsWith('core/tree-sitter/');
            const isExtractOrchestrator = relPath === 'core/indexing/extract.ts';
            const isBarrel = relPath === 'core/tree-sitter.ts';
            if (insideSubmodules || isExtractOrchestrator) continue;

            const text = fs.readFileSync(file, 'utf8');
            const match = text.match(FACT_IMPORT_RE);
            if (!match) continue;

            if (isBarrel) {
                // The barrel's ONE sanctioned fact-submodule import is
                // checkSyntaxErrors from symbols.js (parse-diagnostic surface,
                // not fact extraction). Anything else is a violation.
                const barrelFactImports = [...text.matchAll(new RegExp(FACT_IMPORT_RE.source, 'g'))];
                for (const m of barrelFactImports) {
                    if (m[1] !== 'symbols') violations.push(`${relPath} imports tree-sitter/${m[1]}`);
                }
                if (/from\s+['"][^'"]*\/tree-sitter\/symbols(?:\.js)?['"]/.test(text)) {
                    const importLine = text.split('\n').find((l) => l.includes('/tree-sitter/symbols'));
                    if (importLine && !/checkSyntaxErrors/.test(importLine)) {
                        violations.push(`${relPath} imports more than checkSyntaxErrors from tree-sitter/symbols`);
                    }
                }
                continue;
            }
            violations.push(`${relPath} imports tree-sitter/${match[1]}`);
        }
        expect(violations, violations.join('; ')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 2. queryRaw has zero production callers
// ---------------------------------------------------------------------------

describe('queryRaw is test-only', () => {
    it('no production module calls or imports queryRaw', () => {
        const violations = [];
        for (const file of SRC_FILES) {
            const relPath = rel(file);
            if (relPath === 'core/db-adapter.ts') continue; // definition site
            const text = fs.readFileSync(file, 'utf8');
            if (/\bqueryRaw\b/.test(text)) violations.push(relPath);
        }
        expect(violations, violations.join('; ')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 3. TOON is untouchable
// ---------------------------------------------------------------------------

describe('TOON boundary', () => {
    it('the POLARIS plan manifest names no file under packages/zenith-toon', () => {
        expect(fs.existsSync(PLAN_PATH), 'the POLARIS plan document must exist').toBe(true);
        const plan = fs.readFileSync(PLAN_PATH, 'utf8');
        // Allowlist entries are standalone bullet lines of exactly `- \`path\``
        // under the closed-allowlist headings. Prose MENTIONS of zenith-toon
        // (e.g. the locked decision forbidding changes there) are not manifest
        // entries and must not trip this guard.
        const manifest = [...plan.matchAll(/^- `(packages\/[^`]+)`\s*$/gm)].map((m) => m[1]);
        expect(manifest.length).toBeGreaterThan(50); // sanity: the allowlists are present
        const toonEntries = manifest.filter((p) => p.startsWith('packages/zenith-toon'));
        expect(toonEntries, `plan manifest must not touch TOON: ${toonEntries.join(', ')}`).toEqual([]);
    });

    it('zenith-mcp imports zenith-toon only at the sanctioned compression seam', () => {
        const violations = [];
        for (const file of SRC_FILES) {
            const relPath = rel(file);
            const text = fs.readFileSync(file, 'utf8');
            if (/from\s+['"]zenith-toon['"]/.test(text) && relPath !== 'core/compression.ts') {
                violations.push(relPath);
            }
        }
        expect(violations, violations.join('; ')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 4. One facade, correctly named, never named for compression
// ---------------------------------------------------------------------------

describe('intelligence facade discipline', () => {
    it('at most one ast-intelligence facade exists, at its sanctioned path', () => {
        const facades = SRC_FILES.filter((f) => path.basename(f).startsWith('ast-intelligence'));
        expect(facades.length).toBeLessThanOrEqual(1);
        if (facades.length === 1) {
            expect(rel(facades[0])).toBe('core/intelligence/ast-intelligence.ts');
        }
    });

    it('no intelligence file is named for compression or TOON', () => {
        const intelligenceDir = path.join(SRC_DIR, 'core', 'intelligence');
        const offenders = walk(intelligenceDir, '.ts')
            .filter((f) => /toon|compress/i.test(path.basename(f)))
            .map(rel);
        expect(offenders, offenders.join('; ')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 5. Fixtures stay inside the tests root
// ---------------------------------------------------------------------------

describe('fixture containment', () => {
    it('every file under tests/fixtures resolves inside the tests root', () => {
        const fixturesDir = path.join(TESTS_DIR, 'fixtures');
        const testsRoot = fs.realpathSync(TESTS_DIR);
        for (const p of walk(fixturesDir)) {
            const real = fs.realpathSync(p);
            expect(
                real.startsWith(testsRoot + path.sep),
                `${path.relative(TESTS_DIR, p)} escapes the tests root`
            ).toBe(true);
        }
    });
});
