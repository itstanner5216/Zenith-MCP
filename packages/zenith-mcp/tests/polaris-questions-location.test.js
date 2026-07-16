// polaris-questions-location.test.js — POLARIS Task 2.3 (locationAt)
//
// The locationAt composer over real stores: innermost-first containment
// chains, line/column intersection with v4 exactness disclosure (column
// refinement only for point queries and only against references), include
// gating with honest v4 diagnostics unavailability, canonical cross-family
// fact ordering pinned against fileModel as a ground-truth oracle, the
// trailing relation fact with frontier honesty, coverage-derived status
// (never paging-derived), MAC'd continuation, and entry-protocol integration.

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

// Line numbers below are load-bearing for the tests; columns never are —
// tests derive columns from answered facts, not from hand counting.
const MAIN_TS = [
    /* 1 */ 'import { helper } from \'./lib.js\';',
    /* 2 */ '',
    /* 3 */ 'export class Outer {',
    /* 4 */ '    inner(): number {',
    /* 5 */ '        const a = helper(); const b = helper();',
    /* 6 */ '        return a + b;',
    /* 7 */ '    }',
    /* 8 */ '}',
    /* 9 */ '',
    /* 10 */ 'export function topFn(): void {',
    /* 11 */ '    ghostFn();',
    /* 12 */ '}',
    '',
].join('\n');

const LIB_TS = [
    'export function helper(): number {',
    '    return 7;',
    '}',
    '',
].join('\n');

const INJECT_JS = [
    /* 1 */ 'export function render() {',
    /* 2 */ '    const q = sql`SELECT 1 FROM widgets`;',
    /* 3 */ '    return q;',
    /* 4 */ '}',
    '',
].join('\n');

function seedWorkspace(root) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), MAIN_TS);
    fs.writeFileSync(path.join(root, 'src', 'lib.ts'), LIB_TS);
    fs.writeFileSync(path.join(root, 'src', 'inject.js'), INJECT_JS);
    fs.writeFileSync(path.join(root, 'notes.txt'), 'no code here\n');
}

async function openSession(deps) {
    const root = fs.mkdtempSync(path.join(fakeHome, 'ws-'));
    seedWorkspace(root);
    const ctx = mkCtx([root]);
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor: path.join(root, 'src', 'main.ts'),
        domain: { kind: 'project' },
        freshness: { mode: 'disk' },
    }, deps);
    expect(result.status).toBe('opened');
    return { root, session: result.session };
}

const point = (line, column) => ({ kind: 'line_column', line, column });
const lineRange = (startLine, endLine) =>
    ({ precision: 'line', startLine, startColumn: null, endLine });

const factsOfKind = (answer, kind) =>
    answer.data.facts.filter((f) => f.kind === kind).map((f) => f.fact);

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-qloc-'));
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

describe('locationAt — containment chain', () => {
    it('answers innermost-first at a nested point, with containment basis', async () => {
        const { session } = await openSession();
        // Line 6 holds no same-line declarations, so the chain is pure ancestry.
        const answer = await session.locationAt('src/main.ts', { at: point(6, 0) });
        expect(answer.status).toBeOneOf(['complete', 'partial']);
        expect(answer.data.at).toEqual(point(6, 0));
        const names = answer.data.enclosing.map((s) => s.name);
        expect(names).toEqual(['inner', 'Outer']);
        for (const sym of answer.data.enclosing) {
            expect(sym.candidateBasis).toBe('parent_containment');
            expect(sym.range.precision).toBe('line');
        }
        // The innermost entry knows its parent chain from persisted parent IDs.
        expect(answer.data.enclosing[0].parentChainSource).toBe('parent_symbol_id');
        expect(answer.data.enclosing[0].qualifiedName).toBe('Outer.inner');
        session.close();
    });

    it('line-only ties REMAIN: same-line declarations stay in the chain, precision disclosed', async () => {
        // v4 persists name-start columns only, so a single-line `const a`
        // cannot be proven to exclude (5, 0) — the plan's v4 clause requires
        // keeping the tie rather than guessing. Deterministic order: line
        // desc, endLine asc, column desc.
        const { session } = await openSession();
        const answer = await session.locationAt('src/main.ts', { at: point(5, 0) });
        expect(answer.data.enclosing.map((s) => s.name)).toEqual(['b', 'a', 'inner', 'Outer']);
        session.close();
    });

    it('a range is enclosed only by declarations containing the WHOLE range', async () => {
        const { session } = await openSession();
        const wide = await session.locationAt('src/main.ts', { at: lineRange(3, 8) });
        expect(wide.data.enclosing.map((s) => s.name)).toEqual(['Outer']);
        const narrow = await session.locationAt('src/main.ts', { at: lineRange(5, 6) });
        expect(narrow.data.enclosing.map((s) => s.name)).toEqual(['inner', 'Outer']);
        session.close();
    });
});

describe('locationAt — occurrences and column refinement', () => {
    it('keeps both same-line references on a line query, exactly one on a column point', async () => {
        const { session } = await openSession();
        const wholeLine = await session.locationAt('src/main.ts',
            { at: lineRange(5, 5), include: ['occurrences'] });
        const refs = factsOfKind(wholeLine, 'occurrence').filter((f) => f.role === 'reference' && f.name === 'helper');
        expect(refs).toHaveLength(2); // anti-vacuity: the tie actually exists
        const [refA, refB] = refs;
        expect(refA.range.startColumn).not.toBe(refB.range.startColumn);

        // Point refinement: references are column-decidable (UTF-16 spans)…
        const atA = await session.locationAt('src/main.ts',
            { at: point(5, refA.range.startColumn), include: ['occurrences'] });
        const refsAtA = factsOfKind(atA, 'occurrence').filter((f) => f.role === 'reference');
        expect(refsAtA).toHaveLength(1);
        expect(refsAtA[0].range.startColumn).toBe(refA.range.startColumn);

        // …while declarations stay kept with line precision disclosed —
        // including the same-line `a`/`b` ties v4 cannot column-exclude
        // (persisted def columns are name-start, not construct-start).
        const declsAtA = factsOfKind(atA, 'occurrence').filter((f) => f.role === 'declaration');
        expect(declsAtA.map((d) => d.name).sort()).toEqual(['Outer', 'a', 'b', 'inner']);
        for (const d of declsAtA) expect(d.range.precision).toBe('line');

        // A column just past the reference's name span misses it.
        const past = await session.locationAt('src/main.ts',
            { at: point(5, refA.range.startColumn + 'helper'.length), include: ['occurrences'] });
        const refsPast = factsOfKind(past, 'occurrence')
            .filter((f) => f.role === 'reference' && f.range.startColumn === refA.range.startColumn);
        expect(refsPast).toHaveLength(0);
        session.close();
    });
});

describe('locationAt — cross-family facts against the fileModel oracle', () => {
    it('range facts per family equal intersection-filtered fileModel sections, canonically ordered', async () => {
        const { session } = await openSession();
        const range = { startLine: 3, endLine: 8 };
        const answer = await session.locationAt('src/main.ts', { at: lineRange(range.startLine, range.endLine) });
        const model = await session.fileModel('src/main.ts');
        const section = (name) => model.data.sections.find((s) => s.section === name).facts;
        const intersects = (f) => f.range.startLine <= range.endLine
            && (f.range.precision === 'line' ? f.range.endLine : f.range.endLine) >= range.startLine;

        const expectSame = (locKind, sectionFacts) => {
            const got = factsOfKind(answer, locKind);
            const want = sectionFacts.filter(intersects);
            expect(got).toEqual(expect.arrayContaining(want));
            expect(got).toHaveLength(want.length);
        };
        expectSame('scope', section('scopes'));
        expectSame('anchor', section('anchors'));
        expectSame('injection', section('injections'));
        const occ = [...section('declarations'), ...section('references')];
        expectSame('occurrence', occ);

        // Canonical order: (line asc, column asc with rangeless families first,
        // family rank occurrence<scope<anchor<injection), relation always last.
        const rank = { occurrence: 0, scope: 1, anchor: 2, injection: 3, relation: 4 };
        const keys = answer.data.facts.map((f) => f.kind === 'relation'
            ? [Number.MAX_SAFE_INTEGER, 0, rank[f.kind]]
            : [f.fact.range.startLine, f.fact.range.startColumn ?? -1, rank[f.kind]]);
        const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
        expect(keys).toEqual(sorted);
        session.close();
    });

    it('injections surface at their lines, equal to the fileModel oracle', async () => {
        const { session } = await openSession();
        const answer = await session.locationAt('src/inject.js', { at: lineRange(2, 2), include: ['injections'] });
        const injections = factsOfKind(answer, 'injection');
        expect(injections.length).toBeGreaterThan(0);
        // Grammar language labels are the grammar's business; the contract is
        // consistency with fileModel's injections section at the same lines.
        const model = await session.fileModel('src/inject.js', { sections: ['injections'] });
        const oracle = model.data.sections.find((s) => s.section === 'injections').facts
            .filter((f) => f.range.startLine <= 2 && f.range.endLine >= 2);
        expect(injections).toEqual(oracle);
        session.close();
    });
});

describe('locationAt — include gating and v4 honesty', () => {
    it('gates families by include and answers diagnostics as typed-unavailable at v4', async () => {
        const { session } = await openSession();
        const occOnly = await session.locationAt('src/main.ts',
            { at: lineRange(3, 8), include: ['occurrences'] });
        expect(occOnly.data.facts.every((f) => f.kind === 'occurrence')).toBe(true);
        expect(occOnly.data.enclosing).toEqual([]);
        expect(occOnly.data.coverage.requested.sort()).toEqual(['declaration', 'reference']);
        expect(occOnly.status).toBe('complete');

        const withDiag = await session.locationAt('src/main.ts',
            { at: lineRange(3, 8), include: ['occurrences', 'diagnostics'] });
        expect(withDiag.status).toBe('partial');
        expect(withDiag.data.coverage.unavailable).toEqual([
            { domain: 'diagnostic', reason: 'question_kind_unsupported' },
        ]);
        expect(factsOfKind(withDiag, 'occurrence').length).toBeGreaterThan(0);
        session.close();
    });

    it('byte positions are accepted-then-unavailable at v4', async () => {
        const { session } = await openSession();
        const answer = await session.locationAt('src/main.ts', { at: { kind: 'byte', byte: 120 } });
        expect(answer.status).toBe('unavailable');
        expect(answer.reason).toBe('question_kind_unsupported');
        session.close();
    });

    it('malformed positions fail typed with supply_position', async () => {
        const { session } = await openSession();
        for (const at of [
            point(0, 4),
            { precision: 'line', startLine: 9, startColumn: null, endLine: 3 },
            { nothing: true },
        ]) {
            const answer = await session.locationAt('src/main.ts', { at });
            expect(answer.status).toBe('failed');
            expect(answer.failure.code).toBe('INVALID_QUERY');
            expect(answer.failure.correction).toBe('supply_position');
        }
        session.close();
    });

    it('answers path_outside_scope and unsupported members honestly', async () => {
        const { session } = await openSession();
        const outside = await session.locationAt('../elsewhere.ts', { at: point(1, 0) });
        expect(outside.status).toBe('unavailable');
        expect(outside.reason).toBe('path_outside_scope');

        const txt = await session.locationAt('notes.txt', { at: point(1, 0) });
        expect(txt.status).toBe('partial');
        expect(txt.data.facts).toEqual([]);
        expect(txt.data.enclosing).toEqual([]);
        expect(txt.data.coverage.unavailable.length).toBeGreaterThan(0);
        expect(txt.data.coverage.unavailable.every((u) => u.reason === 'unsupported_language'
            || u.reason === 'question_kind_unsupported')).toBe(true);
        session.close();
    });
});

describe('locationAt — relations and frontier', () => {
    it('emits one trailing relation fact restricted to intersecting endpoints, with frontier honesty', async () => {
        const { session } = await openSession();
        const answer = await session.locationAt('src/main.ts', { at: point(11, 4) });
        expect(answer.status).toBe('partial'); // unresolved_frontier is an issue
        expect(answer.data.coverage.issues).toContain('unresolved_frontier');
        const relations = answer.data.facts.filter((f) => f.kind === 'relation');
        expect(relations).toHaveLength(1);
        expect(answer.data.facts.at(-1).kind).toBe('relation');
        const { frontier } = relations[0].fact;
        expect(frontier.length).toBeGreaterThan(0);
        const ghost = frontier.find((f) => f.referencedName === 'ghostFn');
        expect(ghost).toBeDefined();
        expect(ghost.source.name).toBe('topFn');
        expect(['name_only', 'legacy_heuristic']).toContain(ghost.reason);
        session.close();
    });

    it('omits the relation fact entirely when nothing relational intersects', async () => {
        const { session } = await openSession();
        // lib.ts helper: top-level, no parent containment, no outgoing edges.
        const answer = await session.locationAt('src/lib.ts', { at: point(2, 4), include: ['relations'] });
        expect(answer.data.facts.filter((f) => f.kind === 'relation')).toHaveLength(0);
        expect(answer.data.coverage.issues).not.toContain('unresolved_frontier');
        session.close();
    });
});

describe('locationAt — paging and status discipline', () => {
    it('never infers partial from a non-exhausted page; concatenation equals one-shot; enclosing rides whole', async () => {
        const { session } = await openSession();
        const q = { at: lineRange(3, 8), include: ['enclosing', 'occurrences'] };
        const oneShot = await session.locationAt('src/main.ts', q);
        expect(oneShot.status).toBe('complete');
        expect(oneShot.data.page.exhausted).toBe(true);
        expect(oneShot.data.page.total.kind).toBe('exact');
        expect(oneShot.data.page.total.value).toBeGreaterThan(2);

        let after;
        const collected = [];
        let sawTruncated = false;
        for (let guard = 0; guard < 60; guard++) {
            const page = await session.locationAt('src/main.ts',
                after === undefined ? { ...q, page: { limit: 1 } } : { ...q, page: { limit: 1, after } });
            // Coverage is clean here — the plan forbids paging-derived partial.
            expect(page.status).toBe('complete');
            expect(page.data.enclosing).toEqual(oneShot.data.enclosing);
            expect(page.data.page.total).toEqual(oneShot.data.page.total);
            collected.push(...page.data.facts);
            if (page.data.page.next === null) {
                expect(page.data.page.exhausted).toBe(true);
                break;
            }
            sawTruncated = true;
            expect(page.data.page.exhausted).toBe(false);
            after = page.data.page.next;
        }
        expect(sawTruncated).toBe(true);
        expect(collected).toEqual(oneShot.data.facts);
        session.close();
    });

    it('rejects cursors minted for a different question or different include set', async () => {
        const { session } = await openSession();
        const fm = await session.fileModel('src/main.ts', { sections: ['declarations', 'references'], page: { limit: 1 } });
        expect(fm.data.page.next).not.toBeNull();
        const stolenAcross = await session.locationAt('src/main.ts',
            { at: lineRange(3, 8), page: { limit: 1, after: fm.data.page.next } });
        expect(stolenAcross.status).toBe('failed');
        expect(stolenAcross.failure.code).toBe('INVALID_QUERY');

        const occ = await session.locationAt('src/main.ts',
            { at: lineRange(3, 8), include: ['occurrences'], page: { limit: 1 } });
        expect(occ.data.page.next).not.toBeNull();
        const stolenInclude = await session.locationAt('src/main.ts',
            { at: lineRange(3, 8), include: ['occurrences', 'injections'], page: { limit: 1, after: occ.data.page.next } });
        expect(stolenInclude.status).toBe('failed');
        expect(stolenInclude.failure.code).toBe('INVALID_QUERY');
        session.close();
    });
});

describe('locationAt — entry protocol and determinism', () => {
    it('runs under epoch revalidation: an external commit fails the call typed', async () => {
        const { session } = await openSession();
        const first = await session.locationAt('src/main.ts', { at: point(5, 0) });
        expect(first.status).toBeOneOf(['complete', 'partial']);

        const globalDbPath = path.join(fakeHome, '.zenith-mcp', 'global-stash.db');
        const other = mods.db.openDb(globalDbPath);
        mods.db.runTransaction(other, () => {
            mods.db.execRaw(other, 'CREATE TABLE IF NOT EXISTS polaris_probe (id INTEGER PRIMARY KEY)');
            mods.db.execRaw(other, 'INSERT INTO polaris_probe DEFAULT VALUES');
        });
        mods.db.closeDb(other);

        const second = await session.locationAt('src/main.ts', { at: point(5, 0) });
        expect(second.status).toBe('failed');
        expect(second.failure.code).toBe('INPUT_CHANGED');
        session.close();
    });

    it('is deterministic: two sessions over the SAME root answer deep-equal data', async () => {
        // Same root ⇒ same scope key ⇒ comparable handles. (Cross-root
        // comparison is meaningless: scope keys differ by design, and a
        // second root's indexing commits rightly invalidate open sessions —
        // strict epoch conservatism against cross-scope edge rewrites.)
        const root = fs.mkdtempSync(path.join(fakeHome, 'ws-'));
        seedWorkspace(root);
        const ctx = mkCtx([root]);
        const open = async () => {
            const result = await mods.session.openAstSessionWithDeps(ctx, {
                anchor: path.join(root, 'src', 'main.ts'),
                domain: { kind: 'project' },
                freshness: { mode: 'disk' },
            });
            expect(result.status).toBe('opened');
            return result.session;
        };
        const one = await open();
        const two = await open();
        const q = { at: lineRange(1, 12) };
        const a = await one.locationAt('src/main.ts', q);
        const b = await two.locationAt('src/main.ts', q);
        expect(a.status).toBe(b.status);
        expect(a.data.enclosing).toEqual(b.data.enclosing);
        expect(a.data.facts).toEqual(b.data.facts);
        expect(a.data.coverage).toEqual(b.data.coverage);
        one.close();
        two.close();
    });
});
