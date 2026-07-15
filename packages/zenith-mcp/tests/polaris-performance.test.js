// polaris-performance.test.js — POLARIS Task 0.3
//
// Performance ground and release formulas, BEFORE any production change:
//
//   - The cap-settlement formulas (Decision 23 / Task 7.2) are encoded here
//     as pure functions with exact unit tests. This file is their reference
//     implementation: when Wave 2 creates src/core/intelligence/limits.ts and
//     Wave 7 settles the constants, those must agree with these definitions.
//   - Raw v4 indexing and lookup distributions (p50/p95/p99) are MEASURED on
//     three corpora: the fixture workspace, this repository's sources, and a
//     generated 5,000-file corpus — five warm-ups and 100 measured operations
//     for lookup distributions, seed and machine fingerprint printed.
//   - Planned-but-unbuilt fact families (v5/v6 tables) are reported
//     `not_yet_available`, never fabricated (the no-fabrication rule is
//     itself asserted).
//
// Wave 0 records ground truth; it deliberately imposes NO latency gates —
// release gates freeze at Wave 7 from measured p99s on the qualification
// machine. Everything here is evidence, printed for the record.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    getFileFacts,
    findDefsByName,
    getFileCount,
    queryRaw,
} from '../dist/core/db-adapter.js';
import { indexDirectory } from '../dist/core/symbol-index.js';
import { makeTempDir } from './helpers/polaris-db.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(TESTS_DIR, 'fixtures', 'polaris-workspace');
const REPO_SRC = path.join(TESTS_DIR, '..', 'src');

const WARMUPS = 5;
const MEASURED_OPS = 100;
const GENERATED_FILE_COUNT = 5000;
const SEED = 0x504f4c41; // 'POLA'

// ---------------------------------------------------------------------------
// Release formulas (Decision 23) — the reference implementation
// ---------------------------------------------------------------------------

/** Smallest power of two >= n (n >= 1). */
export function nextPowerOfTwo(n) {
    if (!Number.isFinite(n) || n < 1) return 1;
    return 2 ** Math.ceil(Math.log2(n));
}

/** Count/byte/page limits freeze at max(provisional, nextPowerOfTwo(4 * observedP99)). */
export function settleCountLimit(provisional, observedP99) {
    return Math.max(provisional, nextPowerOfTwo(4 * observedP99));
}

/** Retention age freezes at max(provisionalHours, ceil(4 * p99LifetimeHours)). */
export function settleRetentionAgeHours(provisionalHours, p99LifetimeHours) {
    return Math.max(provisionalHours, Math.ceil(4 * p99LifetimeHours));
}

/** Percentile over a sample (nearest-rank on a sorted copy). */
export function percentile(samples, p) {
    if (samples.length === 0) return NaN;
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    const value = sorted[idx];
    return value === undefined ? NaN : value;
}

/** Deterministic PRNG (mulberry32) so sampled operations are reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function dist(samples) {
    return {
        n: samples.length,
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        p99: percentile(samples, 99),
        max: samples.length ? Math.max(...samples) : NaN,
    };
}

function fmt(d) {
    return `n=${d.n} p50=${d.p50.toFixed(2)}ms p95=${d.p95.toFixed(2)}ms p99=${d.p99.toFixed(2)}ms max=${d.max.toFixed(2)}ms`;
}

function machineFingerprint() {
    const cpu = os.cpus()[0];
    return {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpu: cpu ? cpu.model : 'unknown',
        cores: os.cpus().length,
        seed: SEED,
    };
}

/**
 * Measure lookup distributions over an indexed database: alternating
 * name-candidate lookups (the resolver shape) and whole-file fact reads (the
 * TOON seam shape), sampled deterministically from the DB's own contents.
 */
function measureLookups(db, rng) {
    const names = queryRaw(db, "SELECT DISTINCT name FROM symbols WHERE kind = 'def' ORDER BY name").map((r) => r.name);
    const files = queryRaw(db, 'SELECT path FROM files ORDER BY path').map((r) => r.path);
    expect(names.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(0);

    const pick = (arr) => arr[Math.floor(rng() * arr.length)] ?? arr[0];

    for (let i = 0; i < WARMUPS; i++) {
        findDefsByName(db, pick(names), 'def');
        getFileFacts(db, pick(files));
    }

    const nameLookup = [];
    const fileFacts = [];
    for (let i = 0; i < MEASURED_OPS; i++) {
        const name = pick(names);
        let t0 = performance.now();
        findDefsByName(db, name, 'def');
        nameLookup.push(performance.now() - t0);

        const file = pick(files);
        t0 = performance.now();
        getFileFacts(db, file);
        fileFacts.push(performance.now() - t0);
    }
    return { nameLookup: dist(nameLookup), fileFacts: dist(fileFacts) };
}

// ---------------------------------------------------------------------------
// Formula unit tests
// ---------------------------------------------------------------------------

describe('release formulas (reference implementation)', () => {
    it('nextPowerOfTwo is exact at and between powers', () => {
        expect(nextPowerOfTwo(1)).toBe(1);
        expect(nextPowerOfTwo(2)).toBe(2);
        expect(nextPowerOfTwo(3)).toBe(4);
        expect(nextPowerOfTwo(4)).toBe(4);
        expect(nextPowerOfTwo(5)).toBe(8);
        expect(nextPowerOfTwo(96)).toBe(128);
        expect(nextPowerOfTwo(4 * 24)).toBe(128);
        expect(nextPowerOfTwo(513)).toBe(1024);
    });

    it('count limits never settle below their provisional value', () => {
        expect(settleCountLimit(500, 10)).toBe(500);   // 4*10 -> 64 < 500
        expect(settleCountLimit(500, 200)).toBe(1024); // 4*200 -> 1024
        expect(settleCountLimit(24, 6)).toBe(32);      // 4*6 -> 32 > 24
        expect(settleCountLimit(24, 3)).toBe(24);      // 4*3 -> 16 < 24 -> provisional holds
    });

    it('retention age settles in whole hours with 4x headroom', () => {
        expect(settleRetentionAgeHours(24, 1)).toBe(24);
        expect(settleRetentionAgeHours(24, 6.5)).toBe(26);
        expect(settleRetentionAgeHours(24, 10)).toBe(40);
    });

    it('percentile is nearest-rank and total', () => {
        const s = [5, 1, 4, 2, 3];
        expect(percentile(s, 50)).toBe(3);
        expect(percentile(s, 99)).toBe(5);
        expect(percentile([7], 50)).toBe(7);
        expect(Number.isNaN(percentile([], 50))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Measured corpora
// ---------------------------------------------------------------------------

const tempDirs = [];

afterAll(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

describe('measured v4 ground', () => {
    beforeAll(() => {
        console.log('[POLARIS perf] machine:', JSON.stringify(machineFingerprint()));
    });

    it('fixture workspace: indexing distribution over repeated fresh passes', async () => {
        const passes = [];
        for (let i = 0; i < WARMUPS + 10; i++) {
            const dir = makeTempDir('polaris-perf-fixture-');
            tempDirs.push(dir);
            const db = openDb(path.join(dir, 'perf.db'));
            initSymbolSchema(db);
            const t0 = performance.now();
            await indexDirectory(db, WORKSPACE, WORKSPACE);
            const elapsed = performance.now() - t0;
            if (i >= WARMUPS) passes.push(elapsed);
            expect(getFileCount(db)).toBeGreaterThan(0);
            closeDb(db);
        }
        const d = dist(passes);
        console.log(`[POLARIS perf] fixture-workspace full-index: ${fmt(d)}`);
        expect(Number.isFinite(d.p99)).toBe(true);
    }, 120_000);

    it('this repository (src/): one full index pass + 100 measured lookups', async () => {
        const dir = makeTempDir('polaris-perf-repo-');
        tempDirs.push(dir);
        const db = openDb(path.join(dir, 'repo.db'));
        initSymbolSchema(db);

        const t0 = performance.now();
        await indexDirectory(db, REPO_SRC, REPO_SRC);
        const indexMs = performance.now() - t0;
        const fileCount = getFileCount(db);
        console.log(`[POLARIS perf] repo-src full-index: ${indexMs.toFixed(0)}ms over ${fileCount} files`);
        expect(fileCount).toBeGreaterThan(50);

        const { nameLookup, fileFacts } = measureLookups(db, mulberry32(SEED));
        console.log(`[POLARIS perf] repo-src name-lookup: ${fmt(nameLookup)}`);
        console.log(`[POLARIS perf] repo-src file-facts:  ${fmt(fileFacts)}`);
        expect(Number.isFinite(nameLookup.p99)).toBe(true);
        expect(Number.isFinite(fileFacts.p99)).toBe(true);
        closeDb(db);
    }, 300_000);

    it(`generated ${GENERATED_FILE_COUNT}-file corpus: one full index pass + 100 measured lookups`, async () => {
        const corpusDir = makeTempDir('polaris-perf-corpus-');
        tempDirs.push(corpusDir);
        const rng = mulberry32(SEED);

        // Deterministic tiny modules: one def + one cross-file call each, in
        // 50 subdirectories, so the corpus exercises the walk, batching, and
        // the whole-DB resolve pass at scale.
        for (let i = 0; i < GENERATED_FILE_COUNT; i++) {
            const sub = path.join(corpusDir, `pkg${i % 50}`);
            if (i < 50) fs.mkdirSync(sub, { recursive: true });
            const callee = `genFn${Math.floor(rng() * GENERATED_FILE_COUNT)}`;
            fs.writeFileSync(
                path.join(sub, `mod${i}.ts`),
                `export function genFn${i}(n: number): number {\n    return ${callee}(n) + ${i};\n}\n`
            );
        }

        const dir = makeTempDir('polaris-perf-corpus-db-');
        tempDirs.push(dir);
        const db = openDb(path.join(dir, 'corpus.db'));
        initSymbolSchema(db);

        const t0 = performance.now();
        await indexDirectory(db, corpusDir, corpusDir);
        const indexMs = performance.now() - t0;
        const fileCount = getFileCount(db);
        console.log(`[POLARIS perf] generated-corpus full-index: ${indexMs.toFixed(0)}ms over ${fileCount} files (${(indexMs / Math.max(1, fileCount)).toFixed(2)}ms/file)`);
        expect(fileCount).toBe(GENERATED_FILE_COUNT);

        const { nameLookup, fileFacts } = measureLookups(db, mulberry32(SEED ^ 0xff));
        console.log(`[POLARIS perf] generated-corpus name-lookup: ${fmt(nameLookup)}`);
        console.log(`[POLARIS perf] generated-corpus file-facts:  ${fmt(fileFacts)}`);
        expect(Number.isFinite(nameLookup.p99)).toBe(true);
        expect(Number.isFinite(fileFacts.p99)).toBe(true);
        closeDb(db);
    }, 600_000);

    it('planned fact families report not_yet_available — nothing is fabricated', () => {
        // Wave 3/5 tables do not exist yet. Their metric slots are reported
        // explicitly as unavailable; a fabricated or borrowed number here
        // would poison the Wave 7 settlement.
        const planned = [
            'ast_parse_diagnostics', 'ast_scopes', 'ast_declarations',
            'ast_references', 'ast_exports', 'ast_signatures',
            'ast_explicit_relations', 'intelligence_change_log',
            'intelligence_snapshots', 'intelligence_units', 'semantic_bindings',
        ];
        const report = {};
        const dir = makeTempDir('polaris-perf-nya-');
        tempDirs.push(dir);
        const db = openDb(path.join(dir, 'nya.db'));
        initSymbolSchema(db);
        for (const table of planned) {
            const exists = queryRaw(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table).length === 1;
            report[table] = exists ? 'MEASURABLE' : 'not_yet_available';
        }
        closeDb(db);
        console.log('[POLARIS perf] planned-table metrics:', JSON.stringify(report));
        // At Wave 0 every planned table must be honestly absent.
        expect(Object.values(report).every((v) => v === 'not_yet_available')).toBe(true);
    });
});
