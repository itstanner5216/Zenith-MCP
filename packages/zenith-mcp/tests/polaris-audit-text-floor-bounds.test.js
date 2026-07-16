// polaris-audit-text-floor-bounds.test.js — INDEPENDENT CORRECTNESS AUDIT
//
// Auditor-authored pinning test for AUDIT A13: "ripgrep runs before the
// literal-floor safety bounds (unbounded work)."
//
// Plan (docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md, "Literal floor and
// proof-backed absence"):
//   * step 2 — rg is invoked over "only canonical explicitly enumerated path
//     chunks so its domain exactly matches step 1";
//   * step 4 — "Stop at 64 MiB or the file bound";
//   * KNOWN-ISSUES item 10 — "rg is acceleration only".
// Taken together, rg must never be handed files the bounded in-process scan
// would refuse to read: files over the per-file byte bound, or files past the
// aggregate byte budget. Handing those to rg makes rg do strictly more work
// than the bounded scan — the A13 defect.
//
// ORACLE (independent of the code under test): a stub `rg` binary that records
// the exact argv it is spawned with to a log file on disk, then exits 1 (clean
// "no hits"). The test reads that raw on-disk log — observable committed state,
// never scanLiteralFloor's own return value — and asserts which files rg was
// actually asked to scan. The scan OUTPUT (overBound / stopReason / scanned
// counts) is asserted separately and is invariant across the fix: A13 changes
// only the WORK rg does, not the result.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanLiteralFloor } from '../dist/core/intelligence/text-floor.js';

let root;
let rgLog;
let stubRg;

// A stub `rg` that appends every argument it receives (one per line) to rgLog
// and exits 1 (a clean no-hits status). Its argv is the independent oracle for
// exactly which files the floor handed to ripgrep.
function writeStubRg() {
    const script = `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${rgLog}'; done\nexit 1\n`;
    fs.writeFileSync(stubRg, script);
    fs.chmodSync(stubRg, 0o755);
}

function diskFile(storeKey, bytes) {
    const absPath = path.join(root, storeKey);
    fs.writeFileSync(absPath, bytes);
    return { storeKey, absPath };
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-audit-bounds-'));
    rgLog = path.join(root, 'rg-invocations.log');
    stubRg = path.join(root, 'stub-rg.sh');
    writeStubRg();
});

afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('text floor — A13: rg domain is bounded by per-file size and byte budget', () => {
    // Canonical order (by storeKey): a_small, b_huge, c_small, d_pastbudget.
    //   fileByteBound = 1000, byteBudget = 40.
    //   a_small (20B)      → in-bound      (planned 20)
    //   b_huge  (2000B)    → OVER per-file bound → skipped, must NOT reach rg
    //   c_small (20B)      → in-bound      (planned 40, exactly at budget)
    //   d_pastbudget (20B) → 40+20 > 40 → PAST budget → must NOT reach rg
    // A correct floor hands rg exactly {a_small, c_small}. The buggy floor
    // hands rg all four disk paths (rg runs before any bound is applied).
    function corpus() {
        return [
            diskFile('a_small.ts', 'a'.repeat(20)),
            diskFile('b_huge.ts', 'b'.repeat(2000)),
            diskFile('c_small.ts', 'c'.repeat(20)),
            diskFile('d_pastbudget.ts', 'd'.repeat(20)),
        ];
    }

    it('never spawns rg on over-bound or past-budget files (A13)', () => {
        const files = corpus();
        const outcome = scanLiteralFloor('needleZZZ', files, {
            forceScanner: 'rg',
            rgCommand: stubRg,
            fileByteBound: 1000,
            byteBudget: 40,
        });

        // The scan result is invariant: the fix changes rg's workload, not the
        // outcome. These hold before AND after the fix (they pin no regression).
        expect(outcome.scanner).toBe('rg');
        expect(outcome.overBound).toEqual(['b_huge.ts']);
        expect(outcome.stopReason).toBe('byte_budget');
        expect(outcome.scannedFiles).toBe(2);
        expect(outcome.scannedBytes).toBe(40);

        const invoked = fs.existsSync(rgLog) ? fs.readFileSync(rgLog, 'utf8') : '';
        const byKey = (f, k) => f.find((x) => x.storeKey === k).absPath;

        // ANTI-VACUITY CONTROL: rg WAS invoked, and the log captured it — the
        // in-bound files must appear. Without this, the assertions below could
        // pass vacuously if rg were never spawned or the log never written.
        expect(invoked).toContain(byKey(files, 'a_small.ts'));
        expect(invoked).toContain(byKey(files, 'c_small.ts'));

        // THE A13 ASSERTIONS (RED on the buggy build, which runs rg before the
        // bounds and therefore hands it every disk path):
        expect(invoked).not.toContain(byKey(files, 'b_huge.ts'));       // over per-file bound
        expect(invoked).not.toContain(byKey(files, 'd_pastbudget.ts')); // past byte budget
    });

    it('anti-vacuity: with generous bounds the same corpus DOES reach rg (proves the oracle detects rg invocation)', () => {
        // Identical corpus, but bounds large enough that every file is in-bound.
        // Here rg legitimately sees all four — proving the log records paths and
        // that the previous test's exclusions are real, not a broken stub.
        const files = corpus();
        const outcome = scanLiteralFloor('needleZZZ', files, {
            forceScanner: 'rg',
            rgCommand: stubRg,
            fileByteBound: 1024 * 1024,
            byteBudget: 64 * 1024 * 1024,
        });
        expect(outcome.scanner).toBe('rg');
        expect(outcome.overBound).toEqual([]);
        expect(outcome.stopReason).toBeNull();

        const invoked = fs.existsSync(rgLog) ? fs.readFileSync(rgLog, 'utf8') : '';
        for (const key of ['a_small.ts', 'b_huge.ts', 'c_small.ts', 'd_pastbudget.ts']) {
            expect(invoked).toContain(files.find((x) => x.storeKey === key).absPath);
        }
    });
});
