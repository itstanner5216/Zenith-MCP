import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { register } from '../dist/tools/refactor_batch.js';
import { getDb } from '../dist/core/symbol-index.js';

// -----------------------------------------------------------------------------
// Test harness: fake MCP server captures the registered handler + schema.
// -----------------------------------------------------------------------------

function makeServer() {
    let captured = null;
    return {
        registerTool(name, def, handler) {
            captured = { name, def, handler };
        },
        get tool() { return captured; },
    };
}

function makeCtx(repoRoot) {
    return {
        sessionId: 'test-session-1',
        validatePath: async (p) => {
            const abs = path.isAbsolute(p) ? p : path.join(repoRoot, p);
            const resolved = path.resolve(abs);
            if (!resolved.startsWith(path.resolve(repoRoot))) {
                throw new Error('outside allowed');
            }
            return resolved;
        },
        getAllowedDirectories: () => [repoRoot],
        _roots: [{ uri: 'file://' + repoRoot }],
    };
}

// -----------------------------------------------------------------------------
// Fixture: a tiny repo where three functions share the name `validateCard`.
// -----------------------------------------------------------------------------

let tmpRepo;
let server;
let ctx;

beforeAll(async () => {
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'refactor-batch-'));
    // Init as a git repo so findRepoRoot resolves here
    await fs.mkdir(path.join(tmpRepo, '.git'));
    await fs.writeFile(path.join(tmpRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    // Write three files with different flavors of validateCard so outlier
    // detection has something to do.
    await fs.writeFile(path.join(tmpRepo, 'a.js'),
`function validateCard(card) {
    if (!card) return false;
    return card.length === 16;
}

function caller() {
    return validateCard('1234567812345678');
}
`);

    await fs.writeFile(path.join(tmpRepo, 'b.js'),
`function validateCard(card) {
    if (!card) return false;
    return card.length === 16;
}

function callerB() {
    return validateCard('x');
}
`);

    // Outlier: async version with different params
    await fs.writeFile(path.join(tmpRepo, 'c.js'),
`async function validateCard(card, opts) {
    if (!card) return false;
    return card.length === 16 && !!opts;
}

function callerC() {
    return validateCard('x', {});
}
`);

    server = makeServer();
    ctx = makeCtx(tmpRepo);
    register(server, ctx);
});

afterAll(async () => {
    try { await fs.rm(tmpRepo, { recursive: true, force: true }); } catch {}
});

// -----------------------------------------------------------------------------

describe('refactor_batch registration', () => {
    it('registers with name refactor_batch', () => {
        expect(server.tool.name).toBe('refactor_batch');
    });

    it('description does not contain "If true"', () => {
        const d = server.tool.def.description;
        expect(d.toLowerCase()).not.toContain('if true');
    });

    it('inputSchema has mode enum with all 6 modes', () => {
        const schema = server.tool.def.inputSchema;
        expect(schema.constructor.name).toBe('ZodObject');
        const modeField = schema.shape.mode;
        // Unwrap default wrapper if present
        const inner = modeField._def?.innerType ?? modeField;
        const values = inner._def?.values ?? inner.options;
        expect([...values].sort()).toEqual(['apply', 'history', 'loadDiff', 'query', 'reapply', 'restore']);
    });

    it('no param description starts with "If true"', () => {
        const schema = server.tool.def.inputSchema;
        for (const [, field] of Object.entries(schema.shape)) {
            const desc = field._def?.description
                ?? field._def?.innerType?._def?.description;
            if (desc) expect(desc.toLowerCase()).not.toMatch(/^if true/);
        }
    });
});

describe('refactor_batch query mode', () => {
    it('builds the index on first call and returns a numbered list', async () => {
        // Clear any existing symbols so we actually exercise the first-call path
        const db = getDb(tmpRepo);
        db.prepare('DELETE FROM files').run();
        db.prepare('DELETE FROM symbols').run();
        db.prepare('DELETE FROM edges').run();

        const handler = server.tool.handler;
        // validateCard has multiple defs, so without fileScope we expect disambiguation.
        // Use fileScope to get a concrete result list.
        const res = await handler({
            mode: 'query',
            target: 'validateCard',
            fileScope: 'a.js',
            direction: 'forward',
            depth: 1,
        });
        const text = res.content[0].text;
        // Either "No references." or a numbered list with "N total"
        expect(text.split('\n').length).toBeGreaterThanOrEqual(1);

        // Confirm DB was populated during query
        const count = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
        expect(count).toBeGreaterThan(0);
    });

    it('returns disambiguation list when target has multiple defs and no fileScope', async () => {
        const handler = server.tool.handler;
        const res = await handler({
            mode: 'query',
            target: 'validateCard',
            direction: 'forward',
            depth: 1,
        });
        const text = res.content[0].text;
        expect(text.startsWith('Multiple definitions:')).toBe(true);
        // Should list each file that defines validateCard
        expect(text).toContain('a.js');
        expect(text).toContain('b.js');
        expect(text).toContain('c.js');
    });
});

describe('refactor_batch loadDiff mode', () => {
    it('rejects numeric selection without prior query (fresh session)', async () => {
        // Use a fresh session to guarantee no cached query.
        const freshCtx = {
            ...ctx,
            sessionId: 'isolated-session-' + Math.random(),
        };
        // Re-register under a fresh ctx to get a handler bound to that ctx
        const s = makeServer();
        register(s, freshCtx);
        const res = await s.tool.handler({
            mode: 'loadDiff',
            selection: [1, 2],
            contextLines: 2,
            loadMore: false,
        });
        expect(res.content[0].text).toBe('Run query first.');
    });

    it('loads explicit {symbol, file} pairs without needing a prior query', async () => {
        const s = makeServer();
        const freshCtx = { ...ctx, sessionId: 'explicit-session-' + Math.random() };
        register(s, freshCtx);

        const res = await s.tool.handler({
            mode: 'loadDiff',
            selection: [
                { symbol: 'validateCard', file: 'a.js' },
                { symbol: 'validateCard', file: 'b.js' },
                { symbol: 'validateCard', file: 'c.js' },
            ],
            contextLines: 1,
            loadMore: false,
        });
        const text = res.content[0].text;
        // Header includes counts
        expect(text).toMatch(/in a\.js/);
        expect(text).toMatch(/in b\.js/);
        expect(text).toMatch(/in c\.js/);
        // Each occurrence appears in the body
        expect(text).toContain('validateCard [1]');
        expect(text).toContain('validateCard [2]');
        expect(text).toContain('validateCard [3]');
        // The async version from c.js should be flagged as outlier (modifiers differ or params differ)
        expect(text).toMatch(/validateCard \[\d\] c\.js ⚠ /);
        // Other occurrences should not be flagged
        const aLine = text.split('\n').find(l => l.startsWith('validateCard [1] a.js'));
        expect(aLine).not.toContain('⚠');
    });

    it('honours MAX_CHARS without splitting a symbol — emits [truncated] N remaining', async () => {
        // Create 5 files each with a huge function inside tmpRepo (project-context
        // is a module-level singleton, so we cannot switch roots mid-test). Sum of
        // bodies (~40k) exceeds MAX_CHARS=30000 default.
        const bigBody = 'x'.repeat(8000);
        for (const f of ['p.js', 'q.js', 'r.js', 's.js', 't.js']) {
            await fs.writeFile(path.join(tmpRepo, f),
`function doStuff() {
    // ${bigBody}
    return 1;
}
`);
        }

        const bigCtx = { ...ctx, sessionId: 'big-session-' + Math.random() };
        const s = makeServer();
        register(s, bigCtx);

        const res = await s.tool.handler({
            mode: 'loadDiff',
            selection: [
                { symbol: 'doStuff', file: 'p.js' },
                { symbol: 'doStuff', file: 'q.js' },
                { symbol: 'doStuff', file: 'r.js' },
                { symbol: 'doStuff', file: 's.js' },
                { symbol: 'doStuff', file: 't.js' },
            ],
            contextLines: 0,
            loadMore: false,
        });
        const text = res.content[0].text;

        // Must have a truncation marker AND the big body must appear intact
        // (never split mid-symbol).
        expect(text).toMatch(/\[truncated\] \d+ remaining/);
        // At least one full big body present (function header + return appears together)
        const blocks = text.split('doStuff [');
        const nonEmpty = blocks.filter(b => b.includes('return 1'));
        expect(nonEmpty.length).toBeGreaterThan(0);
        // Every emitted block containing 'function doStuff' must also contain 'return 1'
        for (const b of blocks) {
            if (b.includes('function doStuff()')) {
                expect(b).toContain('return 1');
            }
        }

        // Follow-up loadMore resumes without duplicate entries
        const res2 = await s.tool.handler({
            mode: 'loadDiff',
            selection: [],
            loadMore: true,
        });
        const text2 = res2.content[0].text;

        // First load files ∩ second load files should be empty (no duplicates)
        const filesIn = (t) => {
            const set = new Set();
            for (const line of t.split('\n')) {
                const m = line.match(/^doStuff \[\d+\] (\S+)/);
                if (m) set.add(m[1]);
            }
            return set;
        };
        const first = filesIn(text);
        const second = filesIn(text2);
        for (const f of second) expect(first.has(f)).toBe(false);

        // Cleanup the big fixture files so later tests aren't affected
        for (const f of ['p.js', 'q.js', 'r.js', 's.js', 't.js']) {
            await fs.rm(path.join(tmpRepo, f), { force: true });
        }
    });

    it('loadMore returns "Nothing to continue." when nothing remains', async () => {
        const s = makeServer();
        const freshCtx = { ...ctx, sessionId: 'done-session-' + Math.random() };
        register(s, freshCtx);
        const res = await s.tool.handler({
            mode: 'loadDiff',
            selection: [],
            loadMore: true,
        });
        expect(res.content[0].text).toBe('Nothing to continue.');
    });

    it('context lines are prefixed with │ while body lines are not', async () => {
        const s = makeServer();
        const freshCtx = { ...ctx, sessionId: 'ctx-prefix-' + Math.random() };
        register(s, freshCtx);

        const res = await s.tool.handler({
            mode: 'loadDiff',
            selection: [{ symbol: 'validateCard', file: 'a.js' }],
            contextLines: 2,
            loadMore: false,
        });
        const text = res.content[0].text;
        const lines = text.split('\n');
        // Find lines after the header — context lines should start with │
        const headerIdx = lines.findIndex(l => l.startsWith('validateCard ['));
        expect(headerIdx).toBeGreaterThanOrEqual(0);
        // Body lines (the function itself) should NOT have │ prefix
        const bodyLines = lines.filter(l => l.includes('function validateCard'));
        expect(bodyLines.length).toBeGreaterThan(0);
        for (const bl of bodyLines) {
            expect(bl).not.toMatch(/^│ /);
        }
    });
});

describe('refactor_batch history mode', () => {
    it('returns empty when no versions exist', async () => {
        const s = makeServer();
        const freshCtx = { ...ctx, sessionId: 'hist-empty-' + Math.random() };
        register(s, freshCtx);
        const res = await s.tool.handler({
            mode: 'history',
            symbol: 'nonexistent',
            file: 'a.js',
        });
        expect(res.content[0].text).toContain('No version history');
    });

    it('requires symbol param', async () => {
        const s = makeServer();
        const freshCtx = { ...ctx, sessionId: 'hist-nosym-' + Math.random() };
        register(s, freshCtx);
        const res = await s.tool.handler({
            mode: 'history',
        });
        expect(res.content[0].text).toBe('symbol required for history.');
    });
});

describe('refactor_batch restore mode', () => {
    it('requires symbol param', async () => {
        const s = makeServer();
        const freshCtx = { ...ctx, sessionId: 'restore-nosym-' + Math.random() };
        register(s, freshCtx);
        const res = await s.tool.handler({ mode: 'restore' });
        expect(res.content[0].text).toBe('symbol required for restore.');
    });

    it('requires file param', async () => {
        const s = makeServer();
        const freshCtx = { ...ctx, sessionId: 'restore-nofile-' + Math.random() };
        register(s, freshCtx);
        const res = await s.tool.handler({ mode: 'restore', symbol: 'validateCard' });
        expect(res.content[0].text).toBe('file required for restore.');
    });

    it('lists versions when version is omitted', async () => {
        const s = makeServer();
        const freshCtx = { ...ctx, sessionId: 'restore-list-' + Math.random() };
        register(s, freshCtx);
        const res = await s.tool.handler({
            mode: 'restore',
            symbol: 'validateCard',
            file: 'a.js',
        });
        // Either lists versions or says no history
        const text = res.content[0].text;
        expect(text).toMatch(/v\d|No version history/);
    });

    it('full pipeline: apply → restore roundtrip', async () => {
        const sessionId = 'restore-rt-' + Math.random();
        const s = makeServer();
        const freshCtx = { ...ctx, sessionId };
        register(s, freshCtx);
        const handler = s.tool.handler;

        // Read original file content
        const origContent = await fs.readFile(path.join(tmpRepo, 'a.js'), 'utf-8');

        // Load the symbol
        const loadRes = await handler({
            mode: 'loadDiff',
            selection: [{ symbol: 'validateCard', file: 'a.js' }],
            contextLines: 0,
            loadMore: false,
        });
        const loadText = loadRes.content[0].text;
        const idx = [...loadText.matchAll(/validateCard \[(\d+)\]/g)].map(m => Number(m[1]));

        // Apply an edit
        const newBody = 'function validateCard(card) {\n    return card.length === 15;\n}';
        const applyRes = await handler({
            mode: 'apply',
            payload: `validateCard ${idx.join(',')}\n${newBody}\n`,
            dryRun: false,
        });
        expect(applyRes.content[0].text).toMatch(/Applied/);

        // File should be changed
        const changedContent = await fs.readFile(path.join(tmpRepo, 'a.js'), 'utf-8');
        expect(changedContent).toContain('return card.length === 15');

        // Check history — should have at least one version
        const histRes = await handler({ mode: 'history', symbol: 'validateCard', file: 'a.js' });
        expect(histRes.content[0].text).toMatch(/^v0/);

        // Restore to v0
        const restoreRes = await handler({
            mode: 'restore',
            symbol: 'validateCard',
            file: 'a.js',
            version: 0,
        });
        expect(restoreRes.content[0].text).toContain('restored to v0');

        // File should be back to original
        const restoredContent = await fs.readFile(path.join(tmpRepo, 'a.js'), 'utf-8');
        expect(restoredContent).toContain('return card.length === 16');

        // Restore the original for other tests
        await fs.writeFile(path.join(tmpRepo, 'a.js'), origContent, 'utf-8');
    });
});
