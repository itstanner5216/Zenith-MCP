// rev2-directory-sizecap.test.js
//
// Review [V] (cubic #36 P2): the directory tool's tree-mode symbol-summary path
// calls loadFileDefinitions / loadFileSymbolSummary, which index+parse the file
// via the DB-backed loaders with NO size cap. Listing a directory that contains
// a very large supported file therefore triggers unbounded parse/index work and
// degrades tree-listing performance ("Performance Is Correctness" — unbounded
// operations with no size cap are bugs).
//
// The fix adds a size cap (MAX_FILE_SIZE = 512 * 1024, the same bound search_files.ts
// and core/shared.ts use to gate these loaders / file reads): files larger than
// the threshold are SKIPPED for symbols — the entry still LISTS, only its summary
// is absent.
//
// Proof strategy (fail-before / pass-after):
//   We mock ../dist/core/indexed-symbols.js so loadFileSymbolSummary /
//   loadFileDefinitions are spies. The directory tool imports these loaders
//   directly, so the spies observe exactly which files the tool decides to load
//   symbols for.
//     - A small supported file (a few bytes) → the loader IS called for it, and
//       its summary renders in the tree output.
//     - An oversized supported file (> MAX_FILE_SIZE) → the loader is NEVER
//       called for it (the size cap short-circuits BEFORE the loader), yet the
//       file STILL appears in the listing with no symbol suffix.
//
//   Fail-before: without the cap the tool calls the loader for EVERY supported
//   file, so the spy would record the oversized file's path → the
//   "not.toContain(bigPath)" assertion fails.
//   Pass-after: the cap skips the oversized file, so the spy is called only with
//   the small file's path, and the oversized file is still listed.
//
// The directory tool is exercised through the same capture-handler harness as
// directory.test.js (register → grab the handler → invoke with args).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Spies are declared via the hoisted mock factory and read back through the
// imported (mocked) module below. loadFileSymbolSummary returns a concrete
// summary so the small file's symbols render; loadFileDefinitions returns one
// def so showSymbolNames has data. Both record their call args so we can assert
// WHICH files reached the loaders.
vi.mock('../dist/core/indexed-symbols.js', () => {
    return {
        loadFileSymbolSummary: vi.fn(async () => '1 function'),
        loadFileDefinitions: vi.fn(async () => [
            { name: 'foo', kind: 'def', type: 'function', line: 1, endLine: 1, column: 0 },
        ]),
    };
});

import * as indexedSymbols from '../dist/core/indexed-symbols.js';

// The size cap the source uses (src/tools/directory.ts → MAX_FILE_SIZE).
const MAX_FILE_SIZE = 512 * 1024;

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rev2-dir-sizecap-'));
}

function captureHandler() {
    const calls = [];
    const server = {
        registerTool: (name, schema, handler) => {
            calls.push({ name, schema, handler });
        },
    };
    return { server, calls };
}

function mkCtx() {
    // validatePath resolves to an absolute path (mirrors directory.test.js).
    return {
        validatePath: async (p) => path.resolve(p),
        getAllowedDirectories: () => [],
    };
}

describe('directory tool — symbol-summary size cap (review [V])', () => {
    let tmpDir;
    let handler;
    let smallPath;
    let bigPath;

    beforeEach(async () => {
        tmpDir = mkTmpDir();

        // Small supported file: a few bytes, well under the cap.
        smallPath = path.join(tmpDir, 'small.ts');
        fs.writeFileSync(smallPath, 'export function foo() { return 1; }\n');

        // Oversized supported file: strictly larger than MAX_FILE_SIZE. Still a
        // valid .ts file (so isSupported() is true) — the ONLY reason its symbols
        // must be skipped is its size.
        bigPath = path.join(tmpDir, 'big.ts');
        const filler = '// '.padEnd(120, 'x') + '\n'; // ~121 bytes/line
        const lineCount = Math.ceil((MAX_FILE_SIZE + 64 * 1024) / filler.length);
        fs.writeFileSync(bigPath, 'export function big() { return 2; }\n' + filler.repeat(lineCount));

        // Sanity: the big file really is over the cap and the small one under it.
        expect(fs.statSync(bigPath).size).toBeGreaterThan(MAX_FILE_SIZE);
        expect(fs.statSync(smallPath).size).toBeLessThan(MAX_FILE_SIZE);

        vi.clearAllMocks();

        const mod = await import('../dist/tools/directory.js');
        const { server, calls } = captureHandler();
        mod.register(server, mkCtx());
        handler = calls[0].handler;
    });

    afterEach(() => {
        vi.clearAllMocks();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    // Collect every absolute path the symbol loaders were asked to load.
    function loaderCallPaths() {
        const summaryCalls = indexedSymbols.loadFileSymbolSummary.mock.calls.map(c => c[0]);
        const defsCalls = indexedSymbols.loadFileDefinitions.mock.calls.map(c => c[0]);
        return [...summaryCalls, ...defsCalls];
    }

    it('skips the symbol load for an oversized file but still lists it (showSymbols)', async () => {
        const result = await handler({ mode: 'tree', path: tmpDir, showSymbols: true, depth: 1 });
        const text = result.content[0].text;

        // Both files still appear in the listing — the cap must not drop entries.
        expect(text).toContain('small.ts');
        expect(text).toContain('big.ts');

        const loaded = loaderCallPaths();

        // The small file DID reach the loaders (symbols are computed for it).
        expect(loaded).toContain(smallPath);

        // The oversized file NEVER reached the loaders — the size cap short-
        // circuited before any index/parse work. THIS is the fail-before / pass-
        // after assertion: pre-fix the loader would be called for big.ts too.
        expect(loaded).not.toContain(bigPath);

        // The small file's summary renders; the big file's line carries no
        // symbol suffix (its summary was skipped, not merely empty).
        const smallLine = text.split('\n').find(l => l.includes('small.ts'));
        const bigLine = text.split('\n').find(l => l.includes('big.ts'));
        expect(smallLine).toBeDefined();
        expect(bigLine).toBeDefined();
        expect(smallLine).toContain('(1 function)');
        expect(bigLine).not.toContain('(');
    });

    it('skips the symbol load for an oversized file under showSymbolNames too', async () => {
        const result = await handler({ mode: 'tree', path: tmpDir, showSymbolNames: true, depth: 1 });
        const text = result.content[0].text;

        expect(text).toContain('small.ts');
        expect(text).toContain('big.ts');

        const loaded = loaderCallPaths();
        // Small file loads names; oversized file is skipped entirely.
        expect(loaded).toContain(smallPath);
        expect(loaded).not.toContain(bigPath);

        // Small file shows its symbol names; big file shows none.
        const smallLine = text.split('\n').find(l => l.includes('small.ts'));
        const bigLine = text.split('\n').find(l => l.includes('big.ts'));
        expect(smallLine).toContain('foo (function)');
        expect(bigLine).not.toContain('[');
    });
});
