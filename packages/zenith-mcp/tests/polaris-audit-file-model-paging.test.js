// polaris-audit-file-model-paging.test.js — INDEPENDENT CORRECTNESS AUDIT
//
// Auditor-authored (not part of the shipped suite). Oracle: METAMORPHIC —
// Decision 24 (plan line 270): "Following valid cursors to exhaustion yields
// each canonical fact exactly once." Task 2.4 property (plan line 1315):
// "concatenating all valid pages equals the one-shot canonical oracle with no
// gaps/duplicates." Cursor contract (plan line 517): "decoded page boundaries
// and concatenated data must match."
//
// The expected value is NOT the code's snapshot: it is the plan-locked relation
// between the one-shot answer and the concatenation of its own pages. Both come
// from the implementation, but the *relation* between them is the contract, so
// a paging/segmentation defect is detectable regardless of what either path
// prints.
//
// FINDING F1 (HIGH — surfaced, not self-ruled): the fileModel composer serves
// object-shaped sections (relations, identity) WHOLE on every page while
// counting them once in page.total. Concatenating N keyset pages therefore
// repeats every relation fact N times — a duplicate, not "exactly once". The
// composer does this deliberately (a source comment calls them "served whole on
// every page"), but the locked plan grants no such carve-out. This test encodes
// the plan invariant; it is RED until the contract/implementation are reconciled
// by the owner.
//
// Anti-vacuity: the ARRAY-only variant of the same oracle is GREEN (array
// sections DO paginate exactly-once), proving the harness and oracle are sound
// and isolating the failure to the object-shaped sections.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const SAVED_HOME = HOME_KEYS.map((k) => [k, process.env[k]]);

let fakeHome;
let mods;

async function importFresh() {
    vi.resetModules();
    return {
        session: await import('../dist/core/intelligence/session.js'),
        pc: await import('../dist/core/project-context.js'),
    };
}

function mkCtx(allowedDirs) {
    return { getAllowedDirectories: () => allowedDirs, validatePath: async (p) => p };
}

// A workspace with resolved relations (helper) AND an unresolved frontier
// (ghostFn / mysteryCall / phantom) plus enough array facts (declarations,
// references, scopes, imports, structures) that a small page limit forces
// several pages — the precondition for object-section duplication to become
// observable.
const MAIN_TS = [
    'import { helper } from \'./lib.js\';',
    '',
    'export class Outer {',
    '    method(): number {',
    '        helper();',
    '        return ghostFn();',
    '    }',
    '    other(): number {',
    '        return mysteryCall(helper());',
    '    }',
    '}',
    '',
    'export function topFn(): void {',
    '    ghostFn();',
    '    helper();',
    '    phantom();',
    '}',
    '',
    'export function midFn(a: number): number {',
    '    return helper() + ghostFn() + a;',
    '}',
    '',
].join('\n');

const LIB_TS = [
    'export function helper(): number {',
    '    return 7;',
    '}',
    '',
].join('\n');

function seedWorkspace(root) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), MAIN_TS);
    fs.writeFileSync(path.join(root, 'src', 'lib.ts'), LIB_TS);
}

async function openSession() {
    const root = fs.mkdtempSync(path.join(fakeHome, 'ws-'));
    seedWorkspace(root);
    const result = await mods.session.openAstSessionWithDeps(mkCtx([root]), {
        anchor: path.join(root, 'src', 'main.ts'),
        domain: { kind: 'project' },
        freshness: { mode: 'disk' },
    });
    expect(result.status).toBe('opened');
    return result.session;
}

// Deterministic structural identity for a fact, independent of the code's own
// canonicalizer (recursively key-sorted JSON). Used only for identity/counting.
function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort()
        .map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

// Every ENUMERABLE fact in a model, tagged by logical stream. `coverage` is
// page metadata (a FactCoverage summary), not an enumerable fact, so it is
// excluded. Object-shaped sections contribute their element facts.
function enumerableFacts(model) {
    const out = [];
    for (const s of model.sections) {
        if (s.status === 'unavailable') continue;
        if (s.section === 'coverage') continue;
        const f = s.facts;
        if (Array.isArray(f)) {
            for (const x of f) out.push(`${s.section}\u0000${stable(x)}`);
        } else if (s.section === 'relations' && f && typeof f === 'object') {
            for (const r of (f.explicit ?? [])) out.push(`relations.explicit\u0000${stable(r)}`);
            for (const r of (f.frontier ?? [])) out.push(`relations.frontier\u0000${stable(r)}`);
        } else if (s.section === 'identity' && f && typeof f === 'object') {
            out.push(`identity\u0000${stable(f)}`);
        }
    }
    return out;
}

function relationFacts(model) {
    return enumerableFacts(model).filter((k) => k.startsWith('relations.'));
}

function arrayFacts(model) {
    // Only genuinely array-shaped sections (matches the shipped suite's own
    // `factsOf`), used as the positive control.
    return model.sections.flatMap((s) =>
        (s.status !== 'unavailable' && Array.isArray(s.facts))
            ? s.facts.map((x) => `${s.section}\u0000${stable(x)}`) : []);
}

function multiset(keys) {
    const m = new Map();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
}

function multisetsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const [k, n] of a) if (b.get(k) !== n) return false;
    return true;
}

// Walk every keyset page (fixed limit, no section override → stable digest) and
// return the concatenation of a chosen fact projector across all pages.
async function walkPages(session, project, limit) {
    const collected = [];
    let after;
    for (let guard = 0; guard < 500; guard++) {
        const opts = after === undefined ? { page: { limit } } : { page: { limit, after } };
        const page = await session.fileModel('src/main.ts', opts);
        expect(['partial', 'complete']).toContain(page.status);
        collected.push(...project(page.data));
        if (page.data.page.next === null) {
            expect(page.data.page.exhausted).toBe(true);
            return collected;
        }
        expect(page.data.page.exhausted).toBe(false);
        after = page.data.page.next;
    }
    throw new Error('pagination did not terminate within guard');
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-audit-fmpage-'));
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

describe('fileModel paging — the fixture actually exercises the seam', () => {
    it('one-shot has relations AND enough array facts to force multi-page walks', async () => {
        const session = await openSession();
        const oneShot = await session.fileModel('src/main.ts');
        expect(oneShot.data.page.exhausted).toBe(true);

        const rels = relationFacts(oneShot.data);
        const arr = arrayFacts(oneShot.data);
        // Preconditions for the finding to be observable — if these regress the
        // later tests would be vacuously green, so assert them explicitly.
        expect(rels.length, 'fixture must yield >=1 relation fact').toBeGreaterThan(0);
        expect(arr.length, 'fixture must yield several array facts').toBeGreaterThan(4);
        session.close();
    });
});

describe('fileModel paging — POSITIVE CONTROL (array sections paginate exactly once)', () => {
    // Proves the oracle+harness are sound: array-shaped sections DO satisfy
    // concat==one-shot. If this ever fails, the finding tests below are not
    // trustworthy. (This mirrors the shipped suite's own projection.)
    for (const limit of [1, 2, 3]) {
        it(`array-only concat equals one-shot at limit=${limit}`, async () => {
            const session = await openSession();
            const oneShot = await session.fileModel('src/main.ts');
            const expected = multiset(arrayFacts(oneShot.data));
            const got = multiset(await walkPages(session, arrayFacts, limit));
            expect(multisetsEqual(got, expected)).toBe(true);
            session.close();
        });
    }
});

describe('fileModel paging — FINDING F1: object sections duplicate across pages', () => {
    // PRIMARY assertion, centered on `relations` (Decision 26 names a canonical
    // relation order, so relations are unambiguously canonical facts subject to
    // Decision 24's "exactly once"). RED until reconciled.
    for (const limit of [1, 2, 3]) {
        it(`relations appear exactly once across concatenated pages (limit=${limit})`, async () => {
            const session = await openSession();
            const oneShot = await session.fileModel('src/main.ts');
            const expected = multiset(relationFacts(oneShot.data));
            expect(expected.size, 'precondition: one-shot has relation facts').toBeGreaterThan(0);

            const got = multiset(await walkPages(session, relationFacts, limit));

            // Decision 24 / line 1315: concatenation must equal the one-shot
            // canonical oracle with NO duplicates. Object sections served whole
            // per page violate this.
            expect(multisetsEqual(got, expected),
                'relations must appear exactly once across all pages').toBe(true);
            session.close();
        });
    }

    it('full canonical answer: concat of all pages equals one-shot (line 1315)', async () => {
        const session = await openSession();
        const oneShot = await session.fileModel('src/main.ts');
        const expected = multiset(enumerableFacts(oneShot.data));
        const got = multiset(await walkPages(session, enumerableFacts, 2));
        expect(multisetsEqual(got, expected),
            'every canonical fact (array + object) exactly once across pages').toBe(true);
        session.close();
    });

    it('limit > total returns a single exhausted page (no duplication when unpaged)', async () => {
        // Negative control for the *mechanism*: with one page there is nothing
        // to duplicate, so this MUST pass even under the current implementation.
        // It localizes the defect to the multi-page case.
        const session = await openSession();
        const oneShot = await session.fileModel('src/main.ts');
        const expected = multiset(enumerableFacts(oneShot.data));
        const big = await session.fileModel('src/main.ts', { page: { limit: 100000 } });
        expect(big.data.page.next).toBeNull();
        expect(big.data.page.exhausted).toBe(true);
        const got = multiset(enumerableFacts(big.data));
        expect(multisetsEqual(got, expected)).toBe(true);
        session.close();
    });
});
