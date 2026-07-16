// A15 pinning test — frontier candidate identity / ancestry / ordering.
//
// Plan Decision 24 (line 272) exactly-once identity + Decision 26 candidate
// order (line 676 region). Direction: real source hash, computed ancestors,
// comparator-sorted candidate sets.
//
// Independent oracles (never the frontier composer itself):
//   * real source hash  -> a frontier candidate's stable handle key must EQUAL
//     the target's own declaration fact key, taken from target.ts's fileModel
//     declarations. A fabricated `sourceHash:'legacy'` key cannot match.
//   * computed ancestors -> a nested target's candidate.parentChain must equal
//     the target declaration's real owner fact key.
//   * comparator order   -> two candidates seeded in path-reversed insertion
//     order must come back in canonical (path) order, not insertion order.
//
// Edges carrying the legacy heuristic callee are seeded directly so the test
// is independent of the indexer's own name-resolution behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const savedHome = new Map(HOME_KEYS.map((key) => [key, process.env[key]]));

let fakeHome;
let projectRoot;
let ctx;
let mods;
let connection;

async function open() {
    const result = await mods.session.openAstSessionWithDeps(ctx, {
        anchor: path.join(projectRoot, 'src', 'caller.ts'),
        domain: { kind: 'project' },
        freshness: { mode: 'disk' },
    });
    expect(result.status).toBe('opened');
    return result.session;
}

function defId(name, filePath) {
    const rows = mods.db.queryRaw(connection,
        "SELECT id FROM symbols WHERE kind = 'def' AND name = ? AND file_path = ?",
        name, filePath);
    expect(rows, `one def ${name} in ${filePath}`).toHaveLength(1);
    return rows[0].id;
}

function seedEdge(container, referencedName, callee) {
    mods.db.queryRaw(connection, `
        INSERT INTO edges (container_def_id, referenced_name, reference_kind, callee_symbol_id)
        VALUES (?, ?, 'call', ?) RETURNING id
    `, container, referencedName, callee);
}

function frontier(model, referencedName) {
    const relations = model.sections.find((s) => s.section === 'relations');
    const groups = relations.facts.frontier.filter((f) => f.referencedName === referencedName);
    expect(groups, `one frontier group for ${referencedName}`).toHaveLength(1);
    return groups[0];
}

async function declarationKey(session, filePath, name) {
    const model = await session.fileModel(filePath, { sections: ['declarations'] });
    const decl = model.data.sections.find((s) => s.section === 'declarations')
        .facts.find((f) => f.name === name);
    expect(decl, `declaration ${name} in ${filePath}`).toBeTruthy();
    return { key: decl.handle.stableKey, owner: decl.owner };
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-a15-home-'));
    for (const key of HOME_KEYS) process.env[key] = fakeHome;
    vi.resetModules();
    mods = {
        session: await import('../dist/core/intelligence/session.js'),
        pc: await import('../dist/core/project-context.js'),
        db: await import('../dist/core/db-adapter.js'),
    };
    projectRoot = fs.mkdtempSync(path.join(fakeHome, 'project-'));
    ctx = { getAllowedDirectories: () => [projectRoot], validatePath: async (c) => c };
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'caller.ts'),
        'export function driver(): number {\n    return 0;\n}\n');
    fs.writeFileSync(path.join(projectRoot, 'src', 'target.ts'), [
        'export class Holder {',
        '    inner(): number {',
        '        return 1;',
        '    }',
        '}',
        'export function alpha(): number {',
        '    return 2;',
        '}',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'other.ts'),
        'export function beta(): number {\n    return 3;\n}\n');

    mods.pc.getProjectContext(ctx).reloadRegistry([{
        project_id: 'a15', project_name: 'a15', project_root: projectRoot,
    }]);

    const bootstrap = await open();
    bootstrap.close();
    connection = mods.pc.getProjectContext(ctx)
        .getIntelligenceStore(path.join(projectRoot, 'src', 'caller.ts')).address.db;

    const driver = defId('driver', 'src/caller.ts');
    const inner = defId('inner', 'src/target.ts');
    const alpha = defId('alpha', 'src/target.ts');
    const beta = defId('beta', 'src/other.ts');
    mods.db.runTransaction(connection, () => {
        // Nested cross-file target for real-hash + ancestor oracles.
        seedEdge(driver, 'inner', inner);
        // Two candidates in path-reversed insertion order: alpha(target.ts) is
        // inserted before beta(other.ts), but 'src/other.ts' < 'src/target.ts'.
        seedEdge(driver, 'multi', alpha);
        seedEdge(driver, 'multi', beta);
    });
});

afterEach(() => {
    try { mods?.pc.closeGlobalDb(); } catch { /* ignore */ }
    try { mods?.pc.resetProjectContext(); } catch { /* ignore */ }
    for (const key of HOME_KEYS) {
        const value = savedHome.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('A15 — frontier candidate identity, ancestry, ordering', () => {
    it('mints a candidate handle equal to the target\'s real declaration fact key', async () => {
        const session = await open();
        try {
            const oracle = await declarationKey(session, 'src/target.ts', 'inner');
            expect(oracle.key).toMatch(/^[0-9a-f]{64}$/); // real domain-separated fact key

            const model = await session.fileModel('src/caller.ts', {
                sections: ['declarations', 'relations'],
            });
            const group = frontier(model.data, 'inner');
            expect(group.candidates).toHaveLength(1);
            const candidate = group.candidates[0];

            // Real source hash: candidate identity is the target's own fact key,
            // impossible under a fabricated 'legacy' source hash.
            expect(candidate.handle.stableKey).toBe(oracle.key);
            expect(candidate.candidateBasis).toBe('heuristic_name');
        } finally {
            session.close();
        }
    });

    it('carries the computed ancestor chain instead of an empty parentChain', async () => {
        const session = await open();
        try {
            const oracle = await declarationKey(session, 'src/target.ts', 'inner');
            expect(oracle.owner, 'inner is nested under Holder').toBeTruthy();

            const model = await session.fileModel('src/caller.ts', {
                sections: ['declarations', 'relations'],
            });
            const candidate = frontier(model.data, 'inner').candidates[0];
            expect(candidate.parentChain).toEqual([oracle.owner.stableKey]);
            expect(candidate.parentChainSource).toBe('parent_symbol_id');
        } finally {
            session.close();
        }
    });

    it('returns comparator-sorted candidate sets, not insertion order', async () => {
        const session = await open();
        try {
            const model = await session.fileModel('src/caller.ts', {
                sections: ['declarations', 'relations'],
            });
            const group = frontier(model.data, 'multi');
            expect(group.candidates).toHaveLength(2);
            const paths = group.candidates.map((c) => c.path);
            const names = group.candidates.map((c) => c.name);

            // Canonical order is by path (both are same-grade heuristic
            // candidates); insertion order was alpha(target.ts) then
            // beta(other.ts), so a sorted result must flip them.
            expect(paths).toEqual(['src/other.ts', 'src/target.ts']);
            expect(names).toEqual(['beta', 'alpha']);
            expect([...paths]).toEqual([...paths].sort());
        } finally {
            session.close();
        }
    });
});
