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
import { openMemoryDb, closeDb, initSymbolSchema, queryRaw } from '../dist/core/db-adapter.js';
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

    it('STRUCTURAL: resolve is one guarded batch-level call, not a per-file N+1', async () => {
        // Source-scan guard (compression-seam.test.js style). Proves placement:
        //   - ensureIndexFresh resolves ONCE, guarded by the accumulated count
        //     (`reindexed > 0`) — which can only be evaluated after the loop.
        //   - indexFile (the per-file primitive) never resolves → no per-file N+1.
        const src = await fs.promises.readFile(
            path.resolve(__dirname, '..', 'src', 'core', 'symbol-index.ts'), 'utf8',
        );

        expect(src, 'ensureIndexFresh: guarded batch resolve present')
            .toContain('if (reindexed > 0) resolveAllEdgeTargets(db);');

        const indexFileBody = src.slice(
            src.indexOf('export async function indexFile'),
            src.indexOf('export async function indexDirectory'),
        );
        expect(indexFileBody, 'per-file indexFile must NOT resolve (avoids the N+1)')
            .not.toContain('resolveAllEdgeTargets');

        console.log('structural placement (guarded, post-loop; indexFile resolve-free): true');
    });
});
