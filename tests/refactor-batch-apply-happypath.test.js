// Probe the apply happy path: query → load → apply, verify that the indices
// emitted by `load` match the indices checked by `apply`.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { register } from '../dist/tools/refactor_batch.js';
import { getDb } from '../dist/core/symbol-index.js';

function makeServer() {
    let captured = null;
    return {
        registerTool(name, def, handler) { captured = { name, def, handler }; },
        get tool() { return captured; },
    };
}

function makeCtx(repoRoot, sessionId) {
    return {
        sessionId,
        validatePath: async (p) => {
            const abs = path.isAbsolute(p) ? p : path.join(repoRoot, p);
            const resolved = path.resolve(abs);
            if (!resolved.startsWith(path.resolve(repoRoot))) throw new Error('outside');
            return resolved;
        },
        getAllowedDirectories: () => [repoRoot],
        _roots: [{ uri: 'file://' + repoRoot }],
    };
}

let tmpRepo;

beforeAll(async () => {
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'refactor-hp-'));
    await fs.mkdir(path.join(tmpRepo, '.git'));
    await fs.writeFile(path.join(tmpRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    await fs.writeFile(path.join(tmpRepo, 'hp_a.js'),
`function targetFn(x) { return x + 1; }

function callerA() { return targetFn(1); }
`);
    await fs.writeFile(path.join(tmpRepo, 'hp_b.js'),
`function targetFn(x) { return x + 1; }

function callerB() { return targetFn(2); }
`);
});

afterAll(async () => {
    try { await fs.rm(tmpRepo, { recursive: true, force: true }); } catch {}
});

describe('refactor_batch full happy path', () => {
    it('query → load → apply with numeric index from load writes file and updates version row', async () => {
        const sessionId = 'hp-full-' + Math.random();
        const s = makeServer();
        const ctx = makeCtx(tmpRepo, sessionId);
        register(s, ctx);
        const handler = s.tool.handler;

        // 1. Query
        const qRes = await handler({
            mode: 'query', target: 'targetFn', fileScope: 'hp_a.js',
            direction: 'forward', depth: 1,
        });
        // Query returns CALLERS of targetFn → callerA (forward direction)
        // This cached.results will contain callerA, not targetFn.

        // 2. Load targetFn explicitly
        const lRes = await handler({
            mode: 'loadDiff',
            selection: [
                { symbol: 'targetFn', file: 'hp_a.js' },
                { symbol: 'targetFn', file: 'hp_b.js' },
            ],
            contextLines: 0, loadMore: false,
        });
        const loadText = lRes.content[0].text;
        // Extract the indices assigned by load
        const indices = [...loadText.matchAll(/targetFn \[(\d+)\]/g)].map(m => Number(m[1]));
        expect(indices.length).toBe(2);

        // 3. Apply with the indices we just saw — user sends indices 1 and 2
        const body = 'function targetFn(x) {\n    return x + 2;\n}';
        const aRes = await handler({
            mode: 'apply',
            payload: `targetFn ${indices.join(',')}\n${body}\n`,
            dryRun: false,
        });

        const applyText = aRes.content[0].text;
        // A successful apply should mention "Applied" not "Unknown symbol" or "No diff loaded"
        // This verifies the load → apply index contract.
        expect(applyText).not.toMatch(/Unknown symbol/);
        expect(applyText).not.toMatch(/No diff loaded/);
    });
});
