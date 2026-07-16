// polaris-audit-scope-prefix-range.test.js — INDEPENDENT CORRECTNESS AUDIT
//
// Auditor-authored. Target: getScopeFileHashView(conn, scopePrefix) in
// db-adapter.ts — the built read sessions use for the pinned source-domain
// digest and its per-call revalidation. It answers "every files row whose path
// starts with scopePrefix" by the half-open range [prefix, prefix[:-1]+'0').
//
// Oracle (the charter's named "v4 range query vs. a naive full-scan filter"):
//   * DIFFERENTIAL / INDEPENDENT REFERENCE — a naive full-scan filtered by a
//     direct BYTE-LEVEL prefix test (Buffer.subarray(0,len).equals) — computed a
//     different way than the range trick, and faithful to SQLite BINARY (UTF-8
//     byte) semantics rather than JS UTF-16. For well-formed strings a UTF-16
//     `startsWith` agrees, but the byte oracle removes all doubt at the encoding
//     boundary. Sorted by Buffer.compare (never JS `<`).
//
// Why this seam: the range's correctness rests entirely on the trailing '/'
// (0x2F) → '0' (0x30) increment being a true prefix-successor over UTF-8 bytes.
// A plausible-wrong implementation ("match the stem `src`", i.e. forget the
// slash boundary) would leak sibling directories whose first divergent byte sits
// just below '/' (`-`=0x2D, `.`=0x2E) or just above it (`0`=0x30), or a file
// literally named `src`. The fixture is built to straddle exactly that boundary,
// and one test demonstrates the wrong implementation WOULD be caught (anti-vacuity).
//
// Expected posture: these are CONTRACT-LOCKS (expected green). The mutation
// demonstration proves they are not vacuous; a boundary regression turns them red.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    queryRaw,
    getScopeFileHashView,
} from '../dist/core/db-adapter.js';

// Adversarial fixture. Paths straddle the '/' (0x2F) boundary of the `src/`
// scope so the range/startsWith equivalence is actually exercised, not assumed.
//   inside src/ :            src/…            ('/'=0x2F)
//   sibling below '/':       src-sibling/…    ('-'=0x2D)  src.config/… ('.'=0x2E)
//   sibling above '/':       src0/…           ('0'=0x30 — equals the upper stem)
//   sibling, letter tail:    srcery/…         ('e'=0x65)
//   bare stem as a file:     src              (a file literally named "src")
//   multibyte scope:         𝌆mod/…           (U+1D306, 4 UTF-8 bytes)
//   collation pair:          zz/\uFFFF.ts vs zz/\u{10000}.ts (byte vs UTF-16 order differ)
const FILES = [
    ['a.ts', 'h_root_a'],
    ['README.md', 'h_readme'],
    ['src', 'h_bare_src_file'],
    ['src/a.ts', 'h_src_a'],
    ['src/b.ts', 'h_src_b'],
    ['src/nested/c.ts', 'h_src_nested_c'],
    ['src/nested/deep/d.ts', 'h_src_nested_deep_d'],
    ['src-sibling/x.ts', 'h_sib_dash'],
    ['src.config/x.ts', 'h_sib_dot'],
    ['src0/x.ts', 'h_sib_zero'],
    ['srcery/x.ts', 'h_sib_letter'],
    ['pkg/util.ts', 'h_pkg_util'],
    ['\u{1D306}mod/e.ts', 'h_astral_e'],
    ['\u{1D306}mod/f.ts', 'h_astral_f'],
    ['zz/\uFFFF.ts', 'h_bmp_max'],
    ['zz/\u{10000}.ts', 'h_astral_min'],
];

let tempDir;
let db;

// --- Independent oracle machinery -------------------------------------------

// SQLite ORDER BY path under BINARY collation == UTF-8 byte order == Buffer.compare.
function cmpBytes(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// Direct byte-level prefix test — computed independently of the range trick,
// faithful to SQLite BINARY. path's UTF-8 bytes must start with prefix's bytes.
function byteStartsWith(p, prefix) {
    const pb = Buffer.from(p, 'utf8');
    const qb = Buffer.from(prefix, 'utf8');
    return pb.length >= qb.length && pb.subarray(0, qb.length).equals(qb);
}

// The naive full-scan oracle: filter all files by the byte prefix, project
// (path, hash), sort by UTF-8 byte order. '' means "everything".
function scopeOracle(prefix) {
    const rows = FILES
        .filter(([p]) => prefix === '' || byteStartsWith(p, prefix))
        .map(([p, h]) => ({ path: p, hash: h }));
    rows.sort((x, y) => cmpBytes(x.path, y.path));
    return rows;
}

beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-audit-scope-'));
    db = openDb(path.join(tempDir, 'facts.db'));
    initSymbolSchema(db);
    for (const [p, h] of FILES) {
        queryRaw(db, 'INSERT INTO files (path, hash, last_indexed) VALUES (?, ?, ?)', p, h, 0);
    }
});

afterAll(() => {
    if (db) closeDb(db);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('getScopeFileHashView — range query vs. naive full-scan prefix (differential)', () => {
    // The main contract-lock: the range [prefix, prefix[:-1]+'0') must equal a
    // direct byte-prefix full-scan, for every prefix, including the multibyte
    // scope and the boundary siblings. Independent oracle, not a snapshot.
    const PREFIXES = [
        '',
        'src/',
        'src/nested/',
        'src/nested/deep/',
        'src-sibling/',
        'src.config/',
        'src0/',
        'srcery/',
        'pkg/',
        '\u{1D306}mod/',
        'zz/',
        'does-not-exist/',
    ];
    for (const prefix of PREFIXES) {
        it(`range == naive byte-prefix full-scan for scopePrefix=${JSON.stringify(prefix)}`, () => {
            const got = getScopeFileHashView(db, prefix);
            expect(got).toEqual(scopeOracle(prefix));
        });
    }
});

describe('getScopeFileHashView — the slash boundary is real (anti-vacuity mutation)', () => {
    // Proves the fixture actually straddles the '/' boundary AND that a plausible
    // wrong implementation (match the stem `src` without the slash) would be
    // caught by the differential above. If the two oracles were identical the
    // whole suite would be vacuous; here they differ by exactly the siblings.
    it('the correct src/ scope excludes every sibling that a stem match would leak', () => {
        const correct = new Set(getScopeFileHashView(db, 'src/').map((r) => r.path));

        // The wrong implementation: byte-prefix on the bare stem 'src' (no slash).
        const stemMatch = FILES
            .filter(([p]) => byteStartsWith(p, 'src'))
            .map(([p]) => p);

        const leaked = stemMatch.filter((p) => !correct.has(p)).sort((a, b) => cmpBytes(a, b));

        // The boundary siblings + the bare-stem file are exactly the leak set.
        expect(leaked).toEqual([
            'src', 'src-sibling/x.ts', 'src.config/x.ts', 'src0/x.ts', 'srcery/x.ts',
        ].sort((a, b) => cmpBytes(a, b)));

        // And the real function excludes every one of them.
        for (const p of leaked) expect(correct.has(p)).toBe(false);

        // Positive control: the genuine members ARE present.
        for (const p of ['src/a.ts', 'src/b.ts', 'src/nested/c.ts', 'src/nested/deep/d.ts']) {
            expect(correct.has(p)).toBe(true);
        }
    });

    it("a bare file named 'src' is below the 'src/' lower bound and excluded", () => {
        // 'src' < 'src/' in byte order (a strict prefix is smaller), so the
        // lower bound alone must drop it. Independently reasoned, not observed.
        expect(cmpBytes('src', 'src/')).toBeLessThan(0);
        const members = getScopeFileHashView(db, 'src/').map((r) => r.path);
        expect(members).not.toContain('src');
    });
});

describe('getScopeFileHashView — ordering is UTF-8 byte order, not JS UTF-16', () => {
    // Anti-vacuity for the ORDER BY claim: pick two members of the same scope
    // whose relative order flips between UTF-8 bytes and JS `<`. U+FFFF encodes
    // to EF BF BF; U+10000 encodes to F0 90 80 80 — so U+FFFF sorts FIRST by
    // bytes. In UTF-16, U+10000 is the surrogate pair D800 DC00 (0xD800…) and
    // U+FFFF is 0xFFFF, so JS `<` puts the astral char first — the opposite.
    it('returns zz/ members in UTF-8 byte order, which differs from a JS < sort', () => {
        const got = getScopeFileHashView(db, 'zz/').map((r) => r.path);
        const byBytes = ['zz/\uFFFF.ts', 'zz/\u{10000}.ts'].sort((a, b) => cmpBytes(a, b));
        const byUtf16 = ['zz/\uFFFF.ts', 'zz/\u{10000}.ts'].slice().sort();

        expect(got).toEqual(byBytes);            // matches the byte-order reference
        expect(byBytes).not.toEqual(byUtf16);    // the two orders genuinely differ
        expect(got).not.toEqual(byUtf16);        // so this lock is not vacuous
    });
});

describe('getScopeFileHashView — documented precondition (positive/negative control)', () => {
    // The function contracts that scopePrefix is '' or ends with '/'. Locking the
    // throw is locking the function's own stated precondition, not incidental behavior.
    it("throws for a non-empty prefix that does not end with '/'", () => {
        expect(() => getScopeFileHashView(db, 'src')).toThrow();
    });
    it("does not throw for '' or a '/'-terminated prefix", () => {
        expect(() => getScopeFileHashView(db, '')).not.toThrow();
        expect(() => getScopeFileHashView(db, 'src/')).not.toThrow();
    });
});
