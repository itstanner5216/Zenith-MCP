// polaris-questions-file.test.js — POLARIS Task 2.3 (fileModel)
//
// The fileModel composer over real stores: complete section algebra (exactly
// one tagged result per requested section, canonical order), honest v4
// unavailability, identity/occurrence/import/scope/structure/relation
// assembly from persisted rows, containment relations from parent IDs,
// frontier honesty, canonical paging with MAC'd continuation, entry-protocol
// integration (epoch, corruption), and determinism under a frozen clock.

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
        helpers: await import(pathToFileURL(path.join(import.meta.dirname, 'helpers', 'polaris-db.js')).href),
    };
}

function mkCtx(allowedDirs) {
    return { getAllowedDirectories: () => allowedDirs, validatePath: async (p) => p };
}

const MAIN_TS = [
    'import { helper, type Widget } from \'./lib.js\';',
    'import * as ns from \'./lib.js\';',
    '',
    'export class Outer {',
    '    method(): number {',
    '        helper();',
    '        return ns.helper();',
    '    }',
    '}',
    '',
    'export function topFn(): void {',
    '    ghostFn();',
    '}',
    '',
    'export function withParams(count: number, label: string): string {',
    '    return label;',
    '}',
    '',
].join('\n');

const LIB_TS = [
    'export function helper(): number {',
    '    return 7;',
    '}',
    'export interface Widget {',
    '    id: number;',
    '}',
    '',
].join('\n');

function seedWorkspace(root) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), MAIN_TS);
    fs.writeFileSync(path.join(root, 'src', 'lib.ts'), LIB_TS);
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

function sectionOf(model, name) {
    const matches = model.sections.filter((s) => s.section === name);
    expect(matches, `exactly one ${name} section`).toHaveLength(1);
    return matches[0];
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-qfile-'));
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

describe('fileModel — the complete section algebra', () => {
    it('answers every section exactly once, in canonical order, with honest v4 unavailability', async () => {
        const { session } = await openSession();
        const result = await session.fileModel('src/main.ts');
        expect(result.status).toBe('partial'); // v4-unavailable sections exist
        const model = result.data;

        const ORDER = ['identity', 'declarations', 'references', 'scopes', 'imports',
            'exports', 'structures', 'signatures', 'anchors', 'injections',
            'diagnostics', 'module', 'configuration', 'relations', 'bindings', 'coverage'];
        expect(model.sections.map((s) => s.section)).toEqual(ORDER);

        for (const name of ['exports', 'signatures', 'diagnostics', 'module', 'configuration']) {
            const s = sectionOf(model, name);
            expect(s.status).toBe('unavailable');
            expect(s.reason).toBe('question_kind_unsupported');
        }
        expect(sectionOf(model, 'bindings').reason).toBe('question_requires_binding');

        // Coverage discipline: every requested domain resolved, none dropped.
        const cov = model.coverage;
        expect(cov.requested.length).toBeGreaterThan(0);
        const resolved = new Set([...cov.complete, ...cov.unavailable.map((u) => u.domain)]);
        for (const domain of cov.requested) expect(resolved.has(domain)).toBe(true);
        expect(sectionOf(model, 'coverage').facts).toEqual(cov);
        session.close();
    });

    it('assembles identity, occurrences, imports, and containment from persisted rows', async () => {
        const { session } = await openSession();
        const result = await session.fileModel('src/main.ts');
        const model = result.data;
        // A5: public path is the allowed-root-relative path, never the g/ store key.
        const publicPath = model.path;
        expect(publicPath).toBe('src/main.ts');

        const identity = sectionOf(model, 'identity');
        expect(identity.status).toBe('complete');
        expect(identity.facts.language).toBe('typescript');
        expect(identity.facts.oversized).toBe(false);
        expect(identity.facts.sourceHash).toMatch(/^[0-9a-f]{32}$/); // md5 content hash

        const decls = sectionOf(model, 'declarations').facts;
        const byName = new Map(decls.map((d) => [d.name, d]));
        expect(byName.has('Outer')).toBe(true);
        expect(byName.has('topFn')).toBe(true);
        const method = byName.get('method');
        expect(method.qualifiedName).toBe('Outer.method');
        expect(method.owner.name).toBe('Outer');
        expect(method.ownerSource).toBe('parent_symbol_id');
        expect(method.evidence).toBe('structural');
        expect(method.namespace).toBe('unknown');
        expect(method.handle.kind).toBe('fact');
        expect(method.range.precision).toBe('line');
        expect(method.path).toBe(publicPath);

        const refs = sectionOf(model, 'references').facts;
        expect(refs.some((r) => r.name === 'helper')).toBe(true);
        expect(refs.every((r) => r.role === 'reference' && r.qualifiedName === null)).toBe(true);

        const imports = sectionOf(model, 'imports').facts;
        expect(imports.length).toBeGreaterThanOrEqual(2);
        const named = imports.find((i) => i.bindings.some((b) => b.localName === 'helper'));
        expect(named.module).toBe('./lib.js');
        const widget = named.bindings.find((b) => b.localName === 'Widget');
        expect(widget.typeOnly).toBe(true);
        const nsImport = imports.find((i) => i.bindings.some((b) => b.localName === 'ns'));
        expect(nsImport.bindings.find((b) => b.localName === 'ns').bindingKind).toBe('namespace');

        const relations = sectionOf(model, 'relations').facts;
        const contains = relations.explicit.filter((r) => r.kind === 'contains');
        expect(contains.length).toBeGreaterThanOrEqual(1); // Outer contains method
        for (const rel of contains) {
            expect(rel.grade).toBe('structural');
            expect(rel.proof.length).toBeGreaterThanOrEqual(1);
            expect(rel.proof[0].kind).toBe('containment');
        }
        // ghostFn is an unresolved name edge — it must surface as frontier.
        const ghost = relations.frontier.find((f) => f.referencedName === 'ghostFn');
        expect(ghost).toBeDefined();
        expect(ghost.reason).toBe('name_only');
        expect(ghost.candidates).toEqual([]);
        // helper resolves heuristically at v4 — candidates only, never proof.
        const helperEdge = relations.frontier.find((f) => f.referencedName === 'helper');
        expect(helperEdge).toBeDefined();
        expect(helperEdge.reason).toBe('legacy_heuristic');
        expect(helperEdge.candidates.length).toBeGreaterThanOrEqual(1);
        expect(helperEdge.candidates[0].candidateBasis).toBe('heuristic_name');
        expect(result.issues).toContain('unresolved_frontier');
        session.close();
    });

    it('refuses paths outside the pinned domain and answers unsupported members honestly', async () => {
        const { session } = await openSession();
        const outside = await session.fileModel('../elsewhere/nope.ts');
        expect(outside.status).toBe('unavailable');
        expect(outside.reason).toBe('path_outside_scope');

        const txt = await session.fileModel('notes.txt');
        expect(txt.status).toBe('partial');
        for (const s of txt.data.sections) {
            if (s.section === 'coverage') continue;
            expect(s.status).toBe('unavailable');
            expect(s.reason,
                `section ${s.section} of an unsupported file`,
            ).toBe(['exports', 'signatures', 'diagnostics', 'module', 'configuration', 'bindings']
                .includes(s.section)
                ? s.reason // v4 reasons take precedence and are already pinned above
                : 'unsupported_language');
        }
        session.close();
    });

    it('restricts to requested sections and keeps coverage exact', async () => {
        const { session } = await openSession();
        const result = await session.fileModel('src/lib.ts', { sections: ['declarations', 'coverage'] });
        const model = result.data;
        expect(model.sections.map((s) => s.section)).toEqual(['declarations', 'coverage']);
        expect(model.coverage.requested).toEqual(['declaration', 'file']);
        expect(sectionOf(model, 'declarations').facts.some((d) => d.name === 'helper')).toBe(true);
        session.close();
    });
});

describe('fileModel — paging', () => {
    it('concatenated pages equal the one-shot answer with exact totals', async () => {
        const { session } = await openSession();
        const oneShot = await session.fileModel('src/main.ts');
        expect(oneShot.data.page.exhausted).toBe(true);
        expect(oneShot.data.page.total.kind).toBe('exact');
        const totalFacts = oneShot.data.page.total.value;
        expect(totalFacts).toBeGreaterThan(4);

        const factsOf = (model) => model.sections.flatMap((s) =>
            Array.isArray(s.facts) ? s.facts : []);
        const oneShotFacts = factsOf(oneShot.data);

        let after;
        const collected = [];
        for (let guard = 0; guard < 50; guard++) {
            const page = await session.fileModel('src/main.ts',
                after === undefined ? { page: { limit: 3 } } : { page: { limit: 3, after } });
            expect(page.status).toBeOneOf(['partial', 'complete']);
            expect(page.data.page.total).toEqual({ kind: 'exact', value: totalFacts });
            collected.push(...factsOf(page.data));
            if (page.data.page.next === null) {
                expect(page.data.page.exhausted).toBe(true);
                break;
            }
            after = page.data.page.next;
        }
        expect(collected).toEqual(oneShotFacts);
        session.close();
    });

    it('rejects cursors minted for a different fileModel question', async () => {
        const { session } = await openSession();
        const declOnly = await session.fileModel('src/main.ts',
            { sections: ['declarations', 'references'], page: { limit: 1 } });
        expect(declOnly.data.page.next).not.toBeNull();
        const stolen = await session.fileModel('src/main.ts',
            { page: { limit: 1, after: declOnly.data.page.next } });
        expect(stolen.status).toBe('failed');
        expect(stolen.failure.code).toBe('INVALID_QUERY');
        session.close();
    });

    it('never infers partial from a non-exhausted page: clean coverage stays complete (plan payload rule)', async () => {
        // declarations/references/scopes are v4-complete domains and the
        // relations section (whose frontier adds an issue) is not requested,
        // so coverage is clean; limit 1 forces truncation. The plan forbids
        // deriving `partial` from paging — status must stay 'complete' while
        // page.exhausted/next carry the enumeration state.
        const { session } = await openSession();
        const sections = ['declarations', 'references', 'scopes'];
        let after;
        let pages = 0;
        let sawTruncated = false;
        for (let guard = 0; guard < 60; guard++) {
            const page = await session.fileModel('src/main.ts',
                after === undefined
                    ? { sections, page: { limit: 1 } }
                    : { sections, page: { limit: 1, after } });
            expect(page.status).toBe('complete');
            expect(page.data.coverage.unavailable).toEqual([]);
            expect(page.data.coverage.issues).toEqual([]);
            pages += 1;
            if (page.data.page.next === null) {
                expect(page.data.page.exhausted).toBe(true);
                break;
            }
            sawTruncated = true;
            expect(page.data.page.exhausted).toBe(false);
            after = page.data.page.next;
        }
        expect(sawTruncated).toBe(true); // anti-vacuity: truncation actually happened
        expect(pages).toBeGreaterThan(1);
        session.close();
    });
});

describe('fileModel — entry protocol integration', () => {
    it('runs under epoch revalidation: an external commit fails the call typed', async () => {
        const { root, session } = await openSession();
        const first = await session.fileModel('src/main.ts');
        expect(first.status).toBe('partial');

        // A second connection commits into the same global store.
        const globalDbPath = path.join(fakeHome, '.zenith-mcp', 'global-stash.db');
        const other = mods.db.openDb(globalDbPath);
        mods.db.runTransaction(other, () => {
            mods.db.execRaw(other, 'CREATE TABLE IF NOT EXISTS polaris_probe (id INTEGER PRIMARY KEY)');
            mods.db.execRaw(other, 'INSERT INTO polaris_probe DEFAULT VALUES');
        });
        mods.db.closeDb(other);

        const second = await session.fileModel('src/main.ts');
        expect(second.status).toBe('failed');
        expect(second.failure.code).toBe('INPUT_CHANGED');
        expect(second.failure.retryable).toBe(true);
        void root;
        session.close();
    });

    it('does not present a complete qualified name when parent ancestry is incomplete (A14)', async () => {
        const { session } = await openSession();
        await session.fileModel('src/main.ts');
        const conn = mods.pc.getGlobalDbConnection();
        // Break 'method' ancestry: point its parent at a symbol id that does not
        // exist, so the parent walk truncates (missing parent). File hash is
        // unchanged, so revalidation passes and the composer assembles it.
        mods.db.queryRaw(conn, 'PRAGMA foreign_keys = OFF');
        mods.db.queryRaw(conn,
            "UPDATE symbols SET parent_symbol_id = 999999 WHERE name = 'method' AND kind = 'def'");
        mods.db.queryRaw(conn, 'PRAGMA foreign_keys = ON');
        const model = (await session.fileModel('src/main.ts')).data;
        const decls = sectionOf(model, 'declarations').facts;
        const method = decls.find((d) => d.name === 'method');
        // Honest: a truncated/missing ancestry cannot assert a qualified name.
        expect(method.qualifiedName).toBe(null);
        // Anti-vacuity: a genuine top-level def still carries its bare name.
        const topFn = decls.find((d) => d.name === 'topFn');
        expect(topFn.qualifiedName).toBe('topFn');
        // A14 coverage half: the truncation surfaces as an incomplete-facts
        // caveat on the answer (never a silent complete).
        expect(model.coverage.issues).toContain('incomplete_facts');
        session.close();
    });

    it('maps persisted corruption to a typed STORE_CORRUPT failure', async () => {
        const { session } = await openSession();
        await session.fileModel('src/main.ts');

        // Corrupt a structure row through the SAME connection in autocommit:
        // neither epoch half moves and no file hash changes, so revalidation
        // passes and the composer must catch this at the assembly boundary.
        const conn = mods.pc.getGlobalDbConnection();
        // A5: DB lookup key comes from the persisted store (fixture), NOT the
        // public payload, whose path is now the decoded root-relative path.
        const storeKey = mods.db.queryRaw(conn,
            "SELECT file_path AS p FROM symbols WHERE name = 'topFn' AND kind = 'def' LIMIT 1")[0].p;
        // queryRaw, not execRaw: exec() cannot bind parameters.
        mods.db.queryRaw(conn,
            `UPDATE symbol_structures SET params_json = '{corrupt!' WHERE rowid IN (
                SELECT ss.rowid FROM symbol_structures ss
                JOIN symbols s ON s.id = ss.symbol_id
                WHERE s.file_path = ? LIMIT 1)`,
            storeKey);
        const corrupted = mods.db.queryRaw(conn,
            `SELECT COUNT(*) AS n FROM symbol_structures ss
             JOIN symbols s ON s.id = ss.symbol_id
             WHERE s.file_path = ? AND ss.params_json = '{corrupt!'`,
            storeKey);
        expect(corrupted[0].n).toBe(1); // the corruption actually landed

        const result = await session.fileModel('src/main.ts');
        expect(result.status).toBe('failed');
        expect(result.failure.code).toBe('STORE_CORRUPT');
        expect(result.failure.retryable).toBe(false);
        expect(result.failure.correction).toBe('repair_store');
        session.close();
    });

    it('is deterministic under a frozen clock', async () => {
        let t = 1_000_000;
        const { session } = await openSession({ now: () => t });
        const a = await session.fileModel('src/main.ts');
        const b = await session.fileModel('src/main.ts');
        expect(b).toEqual(a);
        session.close();
    });
});
