// polaris-text-floor.test.js — POLARIS Task 2.3
//
// The literal floor: rg-or-in-process equivalence for exact identifiers,
// proof-backed absence preconditions, typed partials on every bound, in-hand
// content override, and annotation-not-filtering.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanLiteralFloor } from '../dist/core/intelligence/text-floor.js';

const RG_AVAILABLE = (() => {
    try {
        const r = spawnSync('rg', ['--version'], { encoding: 'utf8' });
        return r.error === undefined && r.status === 0;
    } catch {
        return false;
    }
})();

let root;
let files; // canonical FloorFile list

function keyOf(m) {
    return `${m.storeKey}\x1f${m.byteOffset}`;
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-floor-'));
    const write = (rel, content) => {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        return { storeKey: rel.split(path.sep).join('/'), absPath: abs };
    };
    const writeRaw = (rel, buffer) => write(rel, buffer);
    files = [
        write('a.ts', 'targetFn();\nconst x = targetFn;\n// targetFnLike (boundary-adjacent)\n'),
        write('deep/b.ts', 'export function targetFn(): void {}\n'),
        write('c.txt', 'no hits here\n'),
        write('crlf.ts', 'line one\r\nconst y = targetFn();\r\n'),
        write('uni.ts', 'const \u00e9 = 1;\nconst \u00fcn\u00efcodeFn = targetFn;\n'),
        write('periodic.ts', 'aaa\n'),
        write('zero.ts', 'targetFn at offset zero? no \u2014 this line pads.\ntargetFn\n'),
        // Review F1 input classes: rg without --encoding none transcodes
        // BOM'd files (UTF-8 BOM shifts offsets by 3; a UTF-16 BOM ahead of
        // raw UTF-8 bytes makes rg miss the literal entirely).
        writeRaw('bom-u8.ts', Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('targetFn();\n', 'utf8')])),
        writeRaw('bom-u16.ts', Buffer.concat([
            Buffer.from([0xff, 0xfe]), Buffer.from('targetFn\n', 'utf8')])),
        writeRaw('invalid-utf8.ts', Buffer.concat([
            Buffer.from([0xc3, 0x28, 0x0a]), Buffer.from('targetFn\n', 'utf8')])),
    ].sort((a, b) => (a.storeKey < b.storeKey ? -1 : 1));
});

afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('scanner equivalence', () => {
    it.skipIf(!RG_AVAILABLE)('rg and in-process produce identical match sets', () => {
        const viaRg = scanLiteralFloor('targetFn', files, { forceScanner: 'rg' });
        const inProc = scanLiteralFloor('targetFn', files, { forceScanner: 'in_process' });
        expect(viaRg.scanner).toBe('rg');
        expect(inProc.scanner).toBe('in_process');
        expect(viaRg.matches.map(keyOf).sort()).toEqual(inProc.matches.map(keyOf).sort());
        // Line/column/boundary annotations are derived identically (both
        // sides read the true bytes for hit files), so full records match.
        const norm = (o) => o.matches
            .map((m) => ({ ...m }))
            .sort((a, b) => keyOf(a) < keyOf(b) ? -1 : 1);
        expect(norm(viaRg)).toEqual(norm(inProc));
        expect(viaRg.complete).toBe(true);
        expect(inProc.complete).toBe(true);
        // The F1 input classes are all present in the corpus and must hit:
        // BOM-u8 at true offset 3, BOM-u16 at 2, invalid-UTF-8 prefix at 3.
        const at = (list, key) => list.filter((m) => m.storeKey === key).map((m) => m.byteOffset);
        for (const o of [viaRg, inProc]) {
            expect(at(o.matches, 'bom-u8.ts')).toEqual([3]);
            expect(at(o.matches, 'bom-u16.ts')).toEqual([2]);
            expect(at(o.matches, 'invalid-utf8.ts')).toEqual([3]);
        }
    });

    it.skipIf(!RG_AVAILABLE)('periodic literals match non-overlapping in both scanners', () => {
        const viaRg = scanLiteralFloor('aa', files, { forceScanner: 'rg' });
        const inProc = scanLiteralFloor('aa', files, { forceScanner: 'in_process' });
        const rgPeriodic = viaRg.matches.filter((m) => m.storeKey === 'periodic.ts');
        const inProcPeriodic = inProc.matches.filter((m) => m.storeKey === 'periodic.ts');
        expect(inProcPeriodic.map(keyOf)).toEqual(rgPeriodic.map(keyOf));
        expect(inProcPeriodic.length).toBe(1); // 'aaa' yields ONE non-overlapping 'aa'
    });

    it('a missing rg binary falls back to in-process silently', () => {
        const outcome = scanLiteralFloor('targetFn', files, { rgCommand: 'definitely-not-a-real-binary-xyz' });
        expect(outcome.scanner).toBe('in_process');
        expect(outcome.complete).toBe(true);
        expect(outcome.matches.length).toBeGreaterThan(0);
    });
});

describe('facts of the scan', () => {
    it('finds every hit with exact byte offsets, lines, and UTF-16 columns', () => {
        const outcome = scanLiteralFloor('targetFn', files, { forceScanner: 'in_process' });
        const inUni = outcome.matches.find((m) => m.storeKey === 'uni.ts');
        expect(inUni).toBeDefined();
        expect(inUni.line).toBe(2);
        // 'const ünïcodeFn = ' — column counts UTF-16 units, not bytes.
        expect(inUni.column).toBe('const \u00fcn\u00efcodeFn = '.length);
        const inCrlf = outcome.matches.find((m) => m.storeKey === 'crlf.ts');
        expect(inCrlf.line).toBe(2);
        expect(inCrlf.column).toBe('const y = '.length);
        // Boundary annotation: 'targetFnLike' hit is annotated non-boundary
        // but PRESENT — annotation never discards.
        const aHits = outcome.matches.filter((m) => m.storeKey === 'a.ts');
        expect(aHits.length).toBe(3);
        expect(aHits.filter((m) => m.identifierBoundary).length).toBe(2);
        expect(aHits.filter((m) => !m.identifierBoundary).length).toBe(1);
    });

    it('proves absence only over a complete scan, confirmed in-process', () => {
        const outcome = scanLiteralFloor('utterlyAbsentIdentifier', files);
        expect(outcome.matches).toEqual([]);
        expect(outcome.complete).toBe(true);
        expect(outcome.scannedFiles).toBe(files.length);
        expect(outcome.unreadable).toEqual([]);
        expect(outcome.overBound).toEqual([]);
        expect(outcome.stopReason).toBeNull();
        // F1 discipline: an rg-clean verdict is never the proof — a complete
        // zero-match scan must come from the mandatory scanner.
        expect(outcome.scanner).toBe('in_process');
    });

    it('deterministic across repeated runs', () => {
        const a = scanLiteralFloor('targetFn', files, { forceScanner: 'in_process' });
        const b = scanLiteralFloor('targetFn', files, { forceScanner: 'in_process' });
        expect(a).toEqual(b);
    });

    it('empty literals are refused loudly', () => {
        expect(() => scanLiteralFloor('', files)).toThrow(/empty literal/);
    });
});

describe('typed partials', () => {
    it('the byte budget stops the scan and forbids absence', () => {
        const outcome = scanLiteralFloor('targetFn', files, {
            forceScanner: 'in_process',
            byteBudget: 40, // after a.ts (66 bytes) this fires immediately
        });
        expect(outcome.stopReason).toBe('byte_budget');
        expect(outcome.complete).toBe(false);
        expect(outcome.scannedFiles).toBeLessThan(files.length);
    });

    it('an over-bound file is skipped, recorded, and kills completeness — never the scan', () => {
        const big = path.join(root, 'big.ts');
        fs.writeFileSync(big, 'x'.repeat(1024));
        const withBig = [{ storeKey: 'big.ts', absPath: big }, ...files]
            .sort((a, b) => (a.storeKey < b.storeKey ? -1 : 1));
        const outcome = scanLiteralFloor('targetFn', withBig, {
            forceScanner: 'in_process',
            fileByteBound: 512,
        });
        fs.rmSync(big);
        expect(outcome.overBound).toEqual(['big.ts']);
        expect(outcome.stopReason).toBeNull();
        expect(outcome.complete).toBe(false);
        // Files sorting after the oversized one still yielded candidates (H1).
        expect(outcome.matches.length).toBeGreaterThan(0);
        expect(outcome.scannedFiles).toBe(withBig.length - 1);
    });

    const canChmod = process.getuid === undefined || process.getuid() !== 0;
    it.skipIf(!canChmod)('unreadable files are recorded and kill completeness (both scanners)', () => {
        const locked = path.join(root, 'locked.ts');
        fs.writeFileSync(locked, 'targetFn();\n');
        fs.chmodSync(locked, 0o000);
        const withLocked = [...files, { storeKey: 'locked.ts', absPath: locked }]
            .sort((a, b) => (a.storeKey < b.storeKey ? -1 : 1));
        try {
            const inProc = scanLiteralFloor('targetFn', withLocked, { forceScanner: 'in_process' });
            expect(inProc.unreadable).toEqual(['locked.ts']);
            expect(inProc.complete).toBe(false);
            if (RG_AVAILABLE) {
                // The strict trust rule: an unreadable file makes rg exit
                // non-clean, which discards the WHOLE rg pass — the default
                // scan falls back to in-process and records the unreadable
                // file itself. No file is ever counted scanned-and-clean.
                const fallback = scanLiteralFloor('targetFn', withLocked);
                expect(fallback.scanner).toBe('in_process');
                expect(fallback.unreadable).toEqual(['locked.ts']);
                expect(fallback.complete).toBe(false);
            }
        } finally {
            fs.chmodSync(locked, 0o644);
            fs.rmSync(locked);
        }
    });

    it('a partially-succeeding rg run is discarded entirely, never half-trusted', () => {
        // A fake rg that emits one plausible hit line, then dies with exit 2:
        // possibly-truncated output must not be parsed (review H3).
        const fake = path.join(root, 'fake-rg.sh');
        fs.writeFileSync(fake, '#!/bin/sh\nprintf \'whatever\\0000:targetFn\\n\'\nexit 2\n');
        fs.chmodSync(fake, 0o755);
        const outcome = scanLiteralFloor('targetFn', files, { rgCommand: fake });
        expect(outcome.scanner).toBe('in_process');
        expect(outcome.complete).toBe(true);
        expect(outcome.matches.length).toBeGreaterThan(0);
        expect(outcome.matches.every((m) => m.storeKey !== 'whatever')).toBe(true);
    });
});

describe('in-hand content', () => {
    it('content-fresh paths scan supplied bytes, never disk', () => {
        const override = files.map((f) =>
            f.storeKey === 'c.txt' ? { ...f, content: 'now targetFn lives here\n' } : f);
        const outcome = scanLiteralFloor('targetFn', override); // default scanner path
        const inC = outcome.matches.filter((m) => m.storeKey === 'c.txt');
        expect(inC.length).toBe(1);
        expect(inC[0].byteOffset).toBe(4);
        expect(outcome.complete).toBe(true);

        // And the disk-only scan still finds nothing in c.txt.
        const diskOnly = scanLiteralFloor('targetFn', files);
        expect(diskOnly.matches.filter((m) => m.storeKey === 'c.txt')).toEqual([]);
    });
});
