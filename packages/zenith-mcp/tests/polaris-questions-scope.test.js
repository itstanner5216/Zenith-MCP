// polaris-questions-scope.test.js — POLARIS Task 2.3-B (scopeModel)
//
// The scopeModel composer over real stores: set-oriented directory/project/file
// aggregates with exact totals cross-checked against independent ground truth
// (raw SQL + the fileModel composer), recursive vs non-recursive directory
// difference, the file-selector aggregate slice, typed module refusal, keyset
// paging with MAC'd continuation, coverage honesty (v5/v6 unavailable, empty
// scope factually empty, unresolved-edge frontier), entry-protocol integration
// (INPUT_CHANGED, SESSION_CLOSED), and determinism.
//
// Status discipline pinned per the 2.3-B correction: a truncated page with
// clean coverage answers 'complete' (paging progress lives in page.exhausted /
// page.next), NEVER 'partial'.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const SAVED_HOME = HOME_KEYS.map((k) => [k, process.env[k]]);

let fakeHome;
let mods;

async function importFresh() {
    vi.resetModules();
    return {
        session: await import('../dist/core/intelligence/session.js'),
        pc: await import('../dist/core/project-context.js'),
        db: await import('../dist/core/db-adapter.js'),
    };
}

function mkCtx(allowedDirs) {
    return { getAllowedDirectories: () => allowedDirs, validatePath: async (p) => p };
}

// A small multi-directory TypeScript workspace. alpha.ts calls ghostFn (an
// undefined name → an unresolved edge → frontier) and beta (a sibling decl).
const ALPHA_TS = [
    'export function alpha(): number {',
    '    ghostFn();',
    '    return beta();',
    '}',
    'export function beta(): number { return 1; }',
    '',
].join('\n');

const GAMMA_TS = [
    'export class Gamma {',
    '    run(): void { alpha(); }',
    '}',
    '',
].join('\n');

const DELTA_TS = [
    'export const d = 5;',
    'export function useD(): number { return d; }',
    '',
].join('\n');

// Every supported (.ts) member of the fixture, by scope-relative path.
const TS_FILES = ['src/alpha.ts', 'src/gamma.ts', 'src/sub/delta.ts'];

function seedWorkspace(root) {
    fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'alpha.ts'), ALPHA_TS);
    fs.writeFileSync(path.join(root, 'src', 'gamma.ts'), GAMMA_TS);
    fs.writeFileSync(path.join(root, 'src', 'sub', 'delta.ts'), DELTA_TS);
    // A directory that holds only a non-code file: no present members under it.
    fs.writeFileSync(path.join(root, 'src', 'empty', 'notes.txt'), 'no code here\n');
}

async function openOver(root, deps) {
    const ctx = mkCtx([root]);
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor: path.join(root, 'src', 'alpha.ts'),
        domain: { kind: 'project' },
        freshness: { mode: 'disk' },
    }, deps);
    expect(result.status).toBe('opened');
    return result.session;
}

async function openSession(deps) {
    const root = fs.mkdtempSync(path.join(fakeHome, 'ws-'));
    seedWorkspace(root);
    return { root, session: await openOver(root, deps) };
}

function sectionOf(model, name) {
    const matches = model.sections.filter((s) => s.section === name);
    expect(matches, `exactly one ${name} section`).toHaveLength(1);
    return matches[0];
}

// Independent ground truth from the fileModel composer (a different projection
// than scopeModel's aggregate read): count decl/ref facts per file and sum.
async function fileModelTotals(session) {
    let declarations = 0;
    let references = 0;
    for (const p of TS_FILES) {
        const fm = await session.fileModel(p);
        declarations += sectionOf(fm.data, 'declarations').facts.length;
        references += sectionOf(fm.data, 'references').facts.length;
    }
    return { fileCount: TS_FILES.length, declarations, references };
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-qscope-'));
    for (const k of HOME_KEYS) process.env[k] = fakeHome;
    mods = await importFresh();
});

afterEach(() => {
    try { mods.pc.closeGlobalDb(); } catch { /* ignore */ }
    try { mods.pc.resetProjectContext(); } catch { /* ignore */ }
    for (const [k, v] of SAVED_HOME) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('scopeModel — project aggregates and ground truth', () => {
    it('projects per-group rows with exact totals cross-checked against raw SQL and fileModel', async () => {
        const { session } = await openSession();

        // Independent ground truth #1: raw symbol/file counts straight from SQL.
        const conn = mods.pc.getGlobalDbConnection();
        const rawDef = mods.db.queryRaw(conn, "SELECT COUNT(*) AS n FROM symbols WHERE kind='def'")[0].n;
        const rawRef = mods.db.queryRaw(conn, "SELECT COUNT(*) AS n FROM symbols WHERE kind='ref'")[0].n;
        const rawFiles = mods.db.queryRaw(conn, 'SELECT COUNT(*) AS n FROM files')[0].n;
        // Independent ground truth #2: the fileModel composer's per-file facts.
        const fmTotals = await fileModelTotals(session);
        expect(fmTotals).toEqual({ fileCount: rawFiles, declarations: rawDef, references: rawRef });
        expect(rawFiles).toBe(3);

        const answer = await session.scopeModel({
            scope: { kind: 'project' },
            sections: ['files', 'declarations', 'references'],
        });
        // All requested sections available, no issues → complete coverage.
        expect(answer.status).toBe('complete');
        expect(answer.issues).toEqual([]);
        expect(answer.data.scope).toEqual({ kind: 'project' });

        const files = sectionOf(answer.data, 'files');
        expect(files.status).toBe('complete');
        expect(files.total).toEqual({ kind: 'exact', value: rawFiles });
        expect(sectionOf(answer.data, 'declarations').total).toEqual({ kind: 'exact', value: rawDef });
        expect(sectionOf(answer.data, 'references').total).toEqual({ kind: 'exact', value: rawRef });

        // Per-group rows: the sum over groups equals the scope total exactly.
        const groups = files.groups;
        expect(groups.length).toBeGreaterThanOrEqual(2); // src and src/sub
        const sum = (f) => groups.reduce((n, g) => n + g[f], 0);
        expect(sum('fileCount')).toBe(rawFiles);
        expect(sum('declarationCount')).toBe(rawDef);
        expect(sum('referenceCount')).toBe(rawRef);
        // Directory-key canonical ordering (ascending).
        const keys = groups.map((g) => g.key);
        expect([...keys].sort()).toEqual(keys);
        for (const g of groups) {
            expect(g.languages.some((l) => l.language === 'typescript')).toBe(true);
        }

        // The page is over the GROUP list, not the section metric.
        expect(answer.data.page).toEqual({
            returned: groups.length,
            total: { kind: 'exact', value: groups.length },
            exhausted: true,
            next: null,
        });
        session.close();
    });
});

describe('scopeModel — selectors', () => {
    it('distinguishes recursive from non-recursive directory scope', async () => {
        const { session } = await openSession();
        const sections = ['files'];

        const recursive = await session.scopeModel({
            scope: { kind: 'directory', path: 'src', recursive: true }, sections,
        });
        const nonRecursive = await session.scopeModel({
            scope: { kind: 'directory', path: 'src', recursive: false }, sections,
        });

        const recGroups = sectionOf(recursive.data, 'files').groups.map((g) => g.key);
        const nonGroups = sectionOf(nonRecursive.data, 'files').groups.map((g) => g.key);

        // Recursive descends into src/sub; non-recursive keeps only src itself.
        expect(recGroups.some((k) => k.endsWith('/src/sub'))).toBe(true);
        expect(nonGroups.some((k) => k.endsWith('/src/sub'))).toBe(false);
        expect(nonGroups.every((k) => k.endsWith('/src'))).toBe(true);
        expect(recGroups.length).toBeGreaterThan(nonGroups.length);

        // Recursive file total includes src/sub; non-recursive excludes it.
        const recTotal = sectionOf(recursive.data, 'files').total.value;
        const nonTotal = sectionOf(nonRecursive.data, 'files').total.value;
        expect(recTotal).toBeGreaterThan(nonTotal);
        expect(recTotal).toBe(3);
        expect(nonTotal).toBe(2);
        session.close();
    });

    it('refuses file-grain selectors with the same typed refusal as module (fileModel owns files)', async () => {
        // The frozen ScopeQuestion deliberately excludes { kind: 'file' } —
        // answering it at runtime would be a shadow capability freezing into
        // the contract. Untyped callers get INVALID_QUERY narrow_scope for
        // member and unknown paths alike (known-issues R9).
        const { session } = await openSession();
        for (const p of ['src/alpha.ts', 'does/not/exist.ts']) {
            const answer = await session.scopeModel({ scope: { kind: 'file', path: p } });
            expect(answer.status).toBe('failed');
            expect(answer.failure.code).toBe('INVALID_QUERY');
            expect(answer.failure.retryable).toBe(false);
            expect(answer.failure.correction).toBe('narrow_scope');
            expect(answer.failure.detail).toContain('fileModel');
        }
        session.close();
    });

    it('non-recursive directory relations are typed unavailable, never a recursive count (R10)', async () => {
        // Edge stats are prefix reads (inherently recursive); serving that
        // number under a non-recursive selector would be wrong-scoped data.
        const { session } = await openSession();
        const nonRec = await session.scopeModel({
            scope: { kind: 'directory', path: 'src', recursive: false },
            sections: ['files', 'relations'],
        });
        expect(nonRec.status).toBe('partial');
        const rel = sectionOf(nonRec.data, 'relations');
        expect(rel.status).toBe('unavailable');
        expect(rel.reason).toBe('question_kind_unsupported');
        expect(nonRec.data.coverage.unavailable).toContainEqual(
            { domain: 'relation', reason: 'question_kind_unsupported' });
        // The files section still answers exactly.
        expect(sectionOf(nonRec.data, 'files').status).toBe('complete');

        // The recursive selector serves relations normally.
        const rec = await session.scopeModel({
            scope: { kind: 'directory', path: 'src', recursive: true },
            sections: ['relations'],
        });
        const recRel = sectionOf(rec.data, 'relations');
        expect(recRel.status).not.toBe('unavailable');
        expect(recRel.total.value).toBeGreaterThan(0);
        session.close();
    });

    it('refuses a module selector with a typed INVALID_QUERY narrow_scope', async () => {
        const { session } = await openSession();
        const answer = await session.scopeModel({ scope: { kind: 'module', moduleKey: 'anything' } });
        expect(answer.status).toBe('failed');
        expect(answer.failure.code).toBe('INVALID_QUERY');
        expect(answer.failure.retryable).toBe(false);
        expect(answer.failure.correction).toBe('narrow_scope');
        session.close();
    });
});

describe('scopeModel — paging', () => {
    it('a truncated page with clean coverage is complete, not partial (2.3-B correction)', async () => {
        const { session } = await openSession();
        const first = await session.scopeModel({
            scope: { kind: 'project' },
            sections: ['files', 'declarations', 'references'], // all available → clean coverage
            page: { limit: 1 },
        });
        // Truncated (>=2 groups, limit 1) but coverage is clean:
        expect(first.status).toBe('complete');
        expect(first.issues).toEqual([]);
        expect(first.data.page.exhausted).toBe(false);
        expect(first.data.page.next).not.toBeNull();
        expect(first.data.page.returned).toBe(1);
        // Per-section status is ALSO coverage-derived, never paging-derived.
        expect(sectionOf(first.data, 'files').status).toBe('complete');
        session.close();
    });

    it('concatenated pages equal the one-shot group list with a constant exact total', async () => {
        const { session } = await openSession();
        const sections = ['files', 'declarations', 'references'];
        const oneShot = await session.scopeModel({ scope: { kind: 'project' }, sections });
        const oneShotGroups = sectionOf(oneShot.data, 'files').groups;
        expect(oneShot.data.page.exhausted).toBe(true);
        const groupTotal = oneShot.data.page.total;
        expect(groupTotal.kind).toBe('exact');

        let after;
        const collected = [];
        for (let guard = 0; guard < 50; guard++) {
            const page = await session.scopeModel({
                scope: { kind: 'project' }, sections,
                page: after === undefined ? { limit: 1 } : { limit: 1, after },
            });
            expect(page.status).toBe('complete');
            expect(page.data.page.total).toEqual(groupTotal);
            collected.push(...sectionOf(page.data, 'files').groups);
            if (page.data.page.next === null) {
                expect(page.data.page.exhausted).toBe(true);
                break;
            }
            after = page.data.page.next;
        }
        expect(collected).toEqual(oneShotGroups);
        session.close();
    });

    it('rejects a cursor minted for a different scopeModel question, and refuses after close', async () => {
        const { session } = await openSession();
        const minted = await session.scopeModel({
            scope: { kind: 'project' }, sections: ['files'], page: { limit: 1 },
        });
        expect(minted.data.page.next).not.toBeNull();

        // Same session/scope, DIFFERENT sections → query digest mismatch.
        const stolen = await session.scopeModel({
            scope: { kind: 'project' }, sections: ['declarations'],
            page: { limit: 1, after: minted.data.page.next },
        });
        expect(stolen.status).toBe('failed');
        expect(stolen.failure.code).toBe('INVALID_QUERY');

        session.close();
        const closed = await session.scopeModel({ scope: { kind: 'project' } });
        expect(closed.status).toBe('failed');
        expect(closed.failure.code).toBe('SESSION_CLOSED');
    });
});

describe('scopeModel — coverage honesty', () => {
    it('types v5/v6 sections unavailable and surfaces unresolved edges as frontier', async () => {
        const { session } = await openSession();
        const answer = await session.scopeModel({ scope: { kind: 'project' } }); // every section
        expect(answer.status).toBe('partial'); // v5/v6 sections + frontier

        for (const name of ['modules', 'exports', 'signatures', 'diagnostics', 'configuration']) {
            const s = sectionOf(answer.data, name);
            expect(s.status).toBe('unavailable');
            expect(s.reason).toBe('question_kind_unsupported');
        }
        expect(sectionOf(answer.data, 'bindings').reason).toBe('question_requires_binding');

        // The unresolved ghostFn() edge is a frontier count.
        expect(answer.issues).toContain('unresolved_frontier');
        expect(answer.data.coverage.issues).toContain('unresolved_frontier');
        expect(sectionOf(answer.data, 'relations').status).toBe('complete');
        expect(sectionOf(answer.data, 'relations').total.value).toBeGreaterThanOrEqual(1);

        // Coverage discipline: every requested domain resolved, none dropped.
        const cov = answer.data.coverage;
        const resolved = new Set([...cov.complete, ...cov.unavailable.map((u) => u.domain)]);
        for (const domain of cov.requested) expect(resolved.has(domain)).toBe(true);
        session.close();
    });

    it('answers an empty directory as a factual empty with complete coverage', async () => {
        const { session } = await openSession();
        const answer = await session.scopeModel({
            scope: { kind: 'directory', path: 'src/empty', recursive: true },
            sections: ['files', 'declarations', 'references'],
        });
        expect(answer.status).toBe('complete'); // factual empty, not an error/partial
        expect(answer.issues).toEqual([]);
        expect(sectionOf(answer.data, 'files').groups).toEqual([]);
        expect(sectionOf(answer.data, 'files').total).toEqual({ kind: 'exact', value: 0 });
        expect(answer.data.page).toEqual({
            returned: 0, total: { kind: 'exact', value: 0 }, exhausted: true, next: null,
        });
        session.close();
    });
});

describe('scopeModel — entry protocol integration', () => {
    it('fails a query typed INPUT_CHANGED when a domain file changes underneath it', async () => {
        const { session } = await openSession();
        const first = await session.scopeModel({ scope: { kind: 'project' }, sections: ['files'] });
        expect(first.status).toBe('complete');

        // A second connection commits into the same global store.
        const globalDbPath = path.join(fakeHome, '.zenith-mcp', 'global-stash.db');
        const other = mods.db.openDb(globalDbPath);
        mods.db.runTransaction(other, () => {
            mods.db.execRaw(other, 'CREATE TABLE IF NOT EXISTS polaris_probe (id INTEGER PRIMARY KEY)');
            mods.db.execRaw(other, 'INSERT INTO polaris_probe DEFAULT VALUES');
        });
        mods.db.closeDb(other);

        const second = await session.scopeModel({ scope: { kind: 'project' }, sections: ['files'] });
        expect(second.status).toBe('failed');
        expect(second.failure.code).toBe('INPUT_CHANGED');
        expect(second.failure.retryable).toBe(true);
        session.close();
    });

    it('is deterministic: two identical sessions/queries produce deep-equal answers', async () => {
        let t = 2_000_000;
        const deps = { now: () => t };
        const root = fs.mkdtempSync(path.join(fakeHome, 'ws-det-'));
        seedWorkspace(root);

        const q = { scope: { kind: 'project' }, sections: ['files', 'declarations', 'references', 'relations'] };

        const s1 = await openOver(root, deps);
        const a = await s1.scopeModel(q);
        s1.close();

        // A fresh session over the SAME root: same scope key, same store keys.
        mods.pc.resetProjectContext();
        const s2 = await openOver(root, deps);
        const b = await s2.scopeModel(q);
        s2.close();

        // Single-page answers carry no cursor (next: null), so the whole answer
        // is byte-identical — the canonical factual content matches exactly.
        expect(b).toEqual(a);
        expect(a.data.page.next).toBeNull();
    });
});
