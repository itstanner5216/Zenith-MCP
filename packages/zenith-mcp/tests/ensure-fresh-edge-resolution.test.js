// ensure-fresh-edge-resolution.test.js
//
// Phase 3 correctness fix (symbol-index.ts): the per-file read path
// (ensureIndexFresh) and the content-addressed single-file path
// (ensureFreshFromContent) must run ONE whole-DB edge resolve after a batch of
// reindexing completes — guarded by `reindexed > 0`.
//
// Before the fix, resolveAllEdgeTargets ran ONLY at the tail of indexDirectory,
// so edges written by any read tool / the compression seam stayed
// callee_symbol_id = NULL forever (verified live: 5228/5228 unresolved in the
// Zenith-MCP DB). After the fix every touched-file batch heals its own edges,
// while a no-change pass (reindexed === 0) costs nothing.
//
// Drives the built dist (../dist) like the other indexing tests; in-memory DB
// (zero DB I/O) + the REAL tree-sitter extractor so edges are produced for real.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { openMemoryDb, closeDb, initSymbolSchema, queryRaw, execRaw } from '../dist/core/db-adapter.js';
import { ensureFreshFromContent, ensureIndexFresh } from '../dist/core/symbol-index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Edge totals: how many edges exist and how many are resolved (callee non-null). */
function counts(db) {
    const r = queryRaw(db, 'SELECT COUNT(*) AS total, COUNT(callee_symbol_id) AS resolved FROM edges')[0];
    return { total: Number(r.total), resolved: Number(r.resolved) };
}

describe('Phase 3 — ensureIndexFresh / ensureFreshFromContent resolve edges at batch level', () => {
    let repoDir;
    let db;

    beforeEach(() => {
        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-resolve-'));
        db = openMemoryDb();
        initSymbolSchema(db);
    });

    afterEach(() => {
        try { closeDb(db); } catch { /* ignore */ }
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('single-file content path resolves edges', async () => {
        // main() calls helper(); both defined here → helper is a unique same-file
        // def, so the (main -> helper) edge is resolvable.
        const abs = path.join(repoDir, 'solo.ts');
        const content = 'function helper() { return 1; }\nfunction main() { return helper(); }\n';

        const reindexed = await ensureFreshFromContent(db, repoDir, abs, content);
        const { total, resolved } = counts(db);

        const ok = reindexed === 1 && total > 0 && resolved > 0;
        console.log(`single-file path resolves edges: ${ok}`);

        expect(reindexed, 'file was indexed from content').toBe(1);
        expect(total, 'extractor produced at least one edge').toBeGreaterThan(0);
        expect(resolved, 'single-file path resolved its edge(s)').toBeGreaterThan(0);
    });

    it('multi-file disk path resolves edges in one batch', async () => {
        // a.ts:caller() calls uniqueHelper(), defined ONLY in b.ts → the sole
        // resolvable edge is cross-file, so resolved > 0 proves the whole-DB resolve
        // ran across files after the loop.
        const aAbs = path.join(repoDir, 'a.ts');
        const bAbs = path.join(repoDir, 'b.ts');
        fs.writeFileSync(bAbs, 'export function uniqueHelper() { return 1; }\n');
        fs.writeFileSync(aAbs, 'export function caller() { return uniqueHelper(); }\n');

        const reindexed = await ensureIndexFresh(db, repoDir, [aAbs, bAbs]);
        const { total, resolved } = counts(db);

        const ok = reindexed === 2 && total > 0 && resolved > 0;
        console.log(`multi-file path resolves edges: ${ok}`);

        expect(reindexed, 'both files reindexed').toBe(2);
        expect(total, 'extractor produced the cross-file edge').toBeGreaterThan(0);
        expect(resolved, 'batch resolve linked the cross-file edge').toBeGreaterThan(0);
    });

    it('no-change path skips the resolve (reindexed === 0 leaves edges untouched)', async () => {
        const abs = path.join(repoDir, 'solo.ts');
        const content = 'function helper() { return 1; }\nfunction main() { return helper(); }\n';

        // First call indexes AND resolves.
        const first = await ensureFreshFromContent(db, repoDir, abs, content);
        expect(first).toBe(1);
        expect(counts(db).resolved).toBeGreaterThan(0);

        // Manually NULL every resolved edge (simulate staleness). If the upcoming
        // no-change call were to resolve, these would be re-linked.
        queryRaw(db, 'UPDATE edges SET callee_symbol_id = NULL');
        expect(counts(db).resolved).toBe(0);

        // Second call, SAME content → no reindex → resolve MUST be skipped → the
        // nulled edges stay null.
        const second = await ensureFreshFromContent(db, repoDir, abs, content);
        const afterResolved = counts(db).resolved;

        const ok = second === 0 && afterResolved === 0;
        console.log(`no-change path skips resolve: ${ok}`);

        expect(second, 'unchanged content → 0 reindexed').toBe(0);
        expect(afterResolved, 'resolve was skipped → nulled edges stay null').toBe(0);
    });

    it('STRUCTURAL: resolution lives inside the persist transaction, with no trailing sweep owed', async () => {
        // Source-scan guard (compression-seam.test.js style), re-pointed at the
        // POLARIS Task 1.3 architecture. Proves placement:
        //   - persistParsedFile executes the affected-name protocol inside its
        //     own transaction (clear stale targets, then resolveEdgesForNames)
        //     — no cleared-but-owed state can commit.
        //   - symbol-index owns NO trailing whole-DB sweep any more: neither
        //     ensureIndexFresh, ensureFreshFromContent, nor indexDirectory
        //     calls resolveAllEdgeTargets (that entry is test/backfill only).
        const symbolIndexSrc = await fs.promises.readFile(
            path.resolve(__dirname, '..', 'src', 'core', 'symbol-index.ts'), 'utf8',
        );
        const persistSrc = await fs.promises.readFile(
            path.resolve(__dirname, '..', 'src', 'core', 'indexing', 'persist.ts'), 'utf8',
        );

        expect(persistSrc, 'persist: affected-name clear present')
            .toContain('clearEdgeTargetsByNames(');
        expect(persistSrc, 'persist: affected-name resolution present')
            .toContain('resolveEdgesForNames(');
        expect(
            persistSrc.indexOf('clearEdgeTargetsByNames(') < persistSrc.indexOf('resolveEdgesForNames(conn, affectedNames)'),
            'persist: clear precedes re-resolution'
        ).toBe(true);

        expect(symbolIndexSrc, 'symbol-index: no whole-DB sweep remains in production paths')
            .not.toContain('resolveAllEdgeTargets');
        // The purge path resolves the names it removed — deletion is a
        // resolution-affecting event too.
        expect(symbolIndexSrc, 'purge: deletion-side re-resolution present')
            .toContain('resolveEdgesForNames(');

        console.log('structural placement (in-transaction affected-name protocol; no trailing sweep): true');
    });
});

// -----------------------------------------------------------------------------
// POLARIS Task 1.3 — clean-vs-incremental equality across every resolution
// transition. The clean oracle nulls every target and resolves from scratch
// via resolveAllEdgeTargets (its designed test/backfill role); the incremental
// state produced by the in-transaction affected-name protocol must equal it
// canonically after every transition.
// -----------------------------------------------------------------------------

describe('affected-name resolution: clean equals incremental (POLARIS Task 1.3)', () => {
    /** Canonical, ID-free view of every edge and its resolution. */
    function canonicalEdges(db) {
        return JSON.stringify(queryRaw(db, `
            SELECT caller.name AS callerName, caller.file_path AS callerFile,
                   e.referenced_name AS name, e.reference_kind AS kind,
                   callee.name AS calleeName, callee.file_path AS calleeFile, callee.line AS calleeLine
            FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            LEFT JOIN symbols callee ON callee.id = e.callee_symbol_id
            ORDER BY callerFile, callerName, name, kind, calleeFile, calleeLine
        `));
    }

    /**
     * The clean oracle: destroy every resolution, re-derive all of them from
     * scratch over the same facts, and return the canonical edge state.
     * Captured AFTER the incremental state so the comparison is on one DB.
     */
    async function expectCleanEqualsIncremental(db) {
        const incremental = canonicalEdges(db);
        const { resolveAllEdgeTargets } = await import('../dist/core/indexing/resolve.js');
        execRaw(db, 'UPDATE edges SET callee_symbol_id = NULL');
        resolveAllEdgeTargets(db);
        const clean = canonicalEdges(db);
        expect(incremental, 'incremental resolution state must equal a from-scratch rebuild').toBe(clean);
    }

    let repo;
    let db;
    let files;

    beforeEach(async () => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'affname-'));
        db = openMemoryDb();
        initSymbolSchema(db);
        files = {
            caller: path.join(repo, 'caller.ts'),
            a: path.join(repo, 'a.ts'),
            b: path.join(repo, 'b.ts'),
        };
    });

    afterEach(() => {
        try { closeDb(db); } catch { /* ignore */ }
        try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    async function put(abs, content) {
        const { ensureFreshFromContent } = await import('../dist/core/symbol-index.js');
        fs.writeFileSync(abs, content);
        return ensureFreshFromContent(db, repo, abs, content);
    }

    function calleeOf(callerName, refName) {
        const rows = queryRaw(db, `
            SELECT callee.file_path AS f FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            LEFT JOIN symbols callee ON callee.id = e.callee_symbol_id
            WHERE caller.name = ? AND e.referenced_name = ?`, callerName, refName);
        expect(rows.length).toBe(1);
        return rows[0].f; // null when unresolved
    }

    const CALLER = 'export function callFoo(): number {\n    return fooUniq();\n}\n';
    const DEF_A = 'export function fooUniq(): number {\n    return 1;\n}\n';
    const DEF_B = 'export function fooUniq(): number {\n    return 2;\n}\n';
    const B_WITHOUT_DEF = 'export function unrelatedFn(): number {\n    return 3;\n}\n';

    it('transition: add competitor — the unique resolution demotes to null', async () => {
        await put(files.caller, CALLER);
        await put(files.a, DEF_A);
        expect(calleeOf('callFoo', 'fooUniq')).toBe('a.ts');

        await put(files.b, DEF_B); // competitor appears
        expect(calleeOf('callFoo', 'fooUniq')).toBeNull();
        await expectCleanEqualsIncremental(db);
    });

    it('transition: remove competitor — the ambiguous name re-resolves', async () => {
        await put(files.caller, CALLER);
        await put(files.a, DEF_A);
        await put(files.b, DEF_B);
        expect(calleeOf('callFoo', 'fooUniq')).toBeNull();

        await put(files.b, B_WITHOUT_DEF); // competitor's def disappears (edit)
        expect(calleeOf('callFoo', 'fooUniq')).toBe('a.ts');
        await expectCleanEqualsIncremental(db);
    });

    it('transition: add missing definition — an unresolved reference binds', async () => {
        await put(files.caller, CALLER);
        expect(calleeOf('callFoo', 'fooUniq')).toBeNull(); // no def anywhere

        await put(files.a, DEF_A);
        expect(calleeOf('callFoo', 'fooUniq')).toBe('a.ts');
        await expectCleanEqualsIncremental(db);
    });

    it('transition: delete target file — the survivor becomes unique again', async () => {
        const { ensureIndexFresh } = await import('../dist/core/symbol-index.js');
        await put(files.caller, CALLER);
        await put(files.a, DEF_A);
        await put(files.b, DEF_B);
        expect(calleeOf('callFoo', 'fooUniq')).toBeNull();

        fs.rmSync(files.b); // deletion, discovered by freshness
        await ensureIndexFresh(db, repo, [files.b]);
        expect(calleeOf('callFoo', 'fooUniq')).toBe('a.ts');
        await expectCleanEqualsIncremental(db);
    });

    it('transition: caller-only edit — no definition churn, resolutions stable', async () => {
        await put(files.caller, CALLER);
        await put(files.a, DEF_A);
        const before = calleeOf('callFoo', 'fooUniq');
        expect(before).toBe('a.ts');

        // Body edit that changes bytes but not the definition-name set.
        await put(files.caller, 'export function callFoo(): number {\n    return fooUniq() + 0;\n}\n');
        expect(calleeOf('callFoo', 'fooUniq')).toBe('a.ts');
        await expectCleanEqualsIncremental(db);
    });

    it('transition: no-op freshness — same bytes need no recovery action', async () => {
        const { ensureFreshFromContent } = await import('../dist/core/symbol-index.js');
        await put(files.caller, CALLER);
        await put(files.a, DEF_A);
        const canonical = canonicalEdges(db);

        const reindexed = await ensureFreshFromContent(db, repo, files.a, DEF_A);
        expect(reindexed).toBe(0);
        expect(canonicalEdges(db), 'same-byte freshness must not need or perform recovery').toBe(canonical);
        await expectCleanEqualsIncremental(db);
    });

    it('transition: qualified competitor — a dot-qualified stale target is cleared too', async () => {
        const { ensureFreshFromContent } = await import('../dist/core/symbol-index.js');
        const { insertEdge, findDefsByName } = await import('../dist/core/db-adapter.js');

        // c.ts: class Outer { method() {} } — the original qualified target.
        const cAbs = path.join(repo, 'c.ts');
        await put(cAbs, 'export class Outer {\n    method(): number {\n        return 1;\n    }\n}\n');
        await put(files.caller, CALLER); // provides a container def for the injected edge
        await put(files.a, DEF_A);

        // Inject a dot-qualified edge (the shape some grammars emit) resolved
        // to c.ts's method — extraction shape varies by grammar, so the edge
        // is seeded directly; the unit under test is the clear/re-resolve.
        const containers = queryRaw(db, "SELECT id FROM symbols WHERE name = 'callFoo' AND kind = 'def'");
        const methodDefs = findDefsByName(db, 'method', 'def');
        expect(methodDefs.length).toBe(1);
        insertEdge(db, containers[0].id, 'Outer.method', 'call');
        execRaw(db, `UPDATE edges SET callee_symbol_id = ${methodDefs[0].id} WHERE referenced_name = 'Outer.method'`);
        expect(calleeOf('callFoo', 'Outer.method')).toBe('c.ts');

        // d.ts introduces a competing Outer.method chain. Its persist must
        // clear the dot-qualified edge (its TARGET bears a changed name) and
        // the re-resolution must refuse the now-ambiguous chain.
        const dAbs = path.join(repo, 'd.ts');
        await put(dAbs, 'export class Outer {\n    method(): number {\n        return 2;\n    }\n}\n');
        expect(calleeOf('callFoo', 'Outer.method')).toBeNull();
        await expectCleanEqualsIncremental(db);
    });
});
