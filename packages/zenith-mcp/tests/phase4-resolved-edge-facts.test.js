// phase4-resolved-edge-facts.test.js
//
// Phase 4: the compression seam must hand TOON RESOLVED, LINE-KEYED call-graph
// edges — not ambiguous name strings. This proves the path
//   DB (resolved edges) -> getFileFacts -> compression.ts -> Source.facts -> SageRank
// carries line endpoints, and that two distinct defs sharing a NAME no longer
// collapse into one edge (the bug the old `GROUP BY caller.name, referenced_name`
// query caused).
//
// SPLIT, by necessity:
//   • BEHAVIORAL (live, DB-backed): getFileFacts is the live consumer
//     (compression.ts:49). We index real files with the real tree-sitter
//     extractor into an in-memory DB (edges resolved by the Phase-3 fix), then
//     assert getFileFacts returns line-keyed resolved edges with no leaks.
//   • STRUCTURAL (source-scan): the TOON engines CANNOT execute yet — bmx-plus.ts
//     imports the not-yet-built ./removal.js, so importing SageRank fails at module
//     load. So the Source.facts -> SageRank leg is proven by scanning the toon
//     source: Source.facts is line-keyed, SageRank consumes callerLine/calleeLine,
//     and no name-based edge resolution exists. (Running it end-to-end is deferred
//     to the removal/render stage — stated explicitly.)

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { openMemoryDb, closeDb, initSymbolSchema, getFileFacts } from '../dist/core/db-adapter.js';
import { ensureIndexFresh } from '../dist/core/symbol-index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOON_SRC = path.resolve(__dirname, '..', '..', 'zenith-toon', 'src');
const MCP_SRC = path.resolve(__dirname, '..', 'src', 'core');

/** Map def NAME -> its line, from getFileFacts (defs are name+line keyed). */
function defLines(facts) {
    const m = new Map();
    for (const d of facts.defs) m.set(d.name, d.line);
    return m;
}

describe('Phase 4 — seam hands TOON resolved, line-keyed edges', () => {
    let repoDir;
    let db;

    beforeEach(() => {
        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-edges-'));
        db = openMemoryDb();
        initSymbolSchema(db);
    });

    afterEach(() => {
        try { closeDb(db); } catch { /* ignore */ }
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('edges resolved by line: getFileFacts returns line endpoints, not names', async () => {
        const abs = path.join(repoDir, 'solo.ts');
        fs.writeFileSync(abs,
            'function helper() { return 1; }\n' +     // line 1
            'function main() { return helper(); }\n',  // line 2 -> calls helper
        );
        await ensureIndexFresh(db, repoDir, [abs]);

        const facts = getFileFacts(db, 'solo.ts');
        const lines = defLines(facts);

        // Every edge carries numeric line endpoints + callCount — and NO name keys.
        const allLineKeyed = facts.edges.length > 0 && facts.edges.every(e =>
            typeof e.callerLine === 'number' && typeof e.calleeLine === 'number' &&
            typeof e.callCount === 'number' &&
            e.caller_name === undefined && e.callee_name === undefined);
        // The main -> helper edge connects the correct lines.
        const correct = facts.edges.some(e =>
            e.callerLine === lines.get('main') && e.calleeLine === lines.get('helper'));

        const ok = allLineKeyed && correct;
        console.log(`edges resolved by line: ${ok}`);
        console.log(`  edges = ${JSON.stringify(facts.edges)}  (main@${lines.get('main')} helper@${lines.get('helper')})`);

        expect(allLineKeyed, 'edges are line-keyed with no name fields').toBe(true);
        expect(correct, 'main->helper connects the right lines').toBe(true);
    });

    it('dup-name routes correctly: two defs sharing a name do NOT collapse', async () => {
        // Two methods both named `run`, each calling the SAME callee `shared`.
        // OLD query `GROUP BY caller.name, referenced_name` -> ONE row (both `run`s
        // merged). NEW query `GROUP BY caller.id, callee.id` -> TWO rows with
        // DISTINCT callerLines. (Two classes = a realistic dup-name case.)
        const abs = path.join(repoDir, 'dup.ts');
        fs.writeFileSync(abs,
            'function shared() { return 1; }\n' +              // line 1
            'class A {\n' +                                     // line 2
            '  run() { return shared(); }\n' +                 // line 3  A.run -> shared
            '}\n' +                                             // line 4
            'class B {\n' +                                     // line 5
            '  run() { return shared(); }\n' +                 // line 6  B.run -> shared
            '}\n',                                              // line 7
        );
        await ensureIndexFresh(db, repoDir, [abs]);

        const facts = getFileFacts(db, 'dup.ts');
        const lines = defLines(facts);
        const sharedLine = lines.get('shared');

        // Edges whose callee is `shared`: must be TWO, with DISTINCT caller lines
        // (the two `run` methods) — proof they didn't collapse to one name-keyed row.
        const toShared = facts.edges.filter(e => e.calleeLine === sharedLine);
        const distinctCallers = new Set(toShared.map(e => e.callerLine));
        const ok = toShared.length === 2 && distinctCallers.size === 2;

        console.log(`dup-name routes correctly: ${ok}`);
        console.log(`  defs = ${JSON.stringify([...lines])}`);
        console.log(`  edges = ${JSON.stringify(facts.edges)}`);

        expect(sharedLine, 'callee `shared` was indexed').toBeGreaterThan(0);
        expect(toShared.length, 'both run() callers kept as separate edges').toBe(2);
        expect(distinctCallers.size, 'the two callers have distinct lines (no name collapse)').toBe(2);
    });

    it('no unresolved/cross-file edges leak: only same-file resolved edges returned', async () => {
        // a.ts: caller() calls localHelper (same file, resolvable),
        //        bHelper (defined in b.ts — cross-file), and
        //        ghostFn (never defined — unresolvable / NULL callee).
        const aAbs = path.join(repoDir, 'a.ts');
        const bAbs = path.join(repoDir, 'b.ts');
        fs.writeFileSync(bAbs, 'export function bHelper() { return 2; }\n');
        fs.writeFileSync(aAbs,
            'import { bHelper } from "./b";\n' +                                   // line 1
            'function localHelper() { return 1; }\n' +                            // line 2
            'function caller() { return localHelper() + bHelper() + ghostFn(); }\n', // line 3
        );
        await ensureIndexFresh(db, repoDir, [aAbs, bAbs]);

        const facts = getFileFacts(db, 'a.ts');
        const lines = defLines(facts);
        // a.ts's own def lines — every returned edge endpoint must be one of these.
        const aDefLineSet = new Set([...lines.values()]);

        const callerToLocal = facts.edges.some(e =>
            e.callerLine === lines.get('caller') && e.calleeLine === lines.get('localHelper'));
        // No edge may point OUT of a.ts (cross-file bHelper) or to a NULL callee
        // (ghostFn) — both are excluded by the INNER JOIN + callee.file_path = ?.
        const noLeak = facts.edges.every(e => aDefLineSet.has(e.calleeLine));

        const ok = callerToLocal && noLeak;
        console.log(`no unresolved/cross-file edges leak: ${ok}`);
        console.log(`  a.ts edges = ${JSON.stringify(facts.edges)}  (caller@${lines.get('caller')} localHelper@${lines.get('localHelper')})`);

        expect(callerToLocal, 'same-file caller->localHelper IS present').toBe(true);
        expect(noLeak, 'cross-file (bHelper) and NULL-callee (ghostFn) edges excluded').toBe(true);
    });

    it('STRUCTURAL: Source.facts is line-keyed and the toon side consumes it by line (no name fallback)', async () => {
        const compressSrc = await fs.promises.readFile(path.join(TOON_SRC, 'compress-source.ts'), 'utf8');
        const sageSrc = await fs.promises.readFile(path.join(TOON_SRC, 'sagerank.ts'), 'utf8');
        const bridgeSrc = await fs.promises.readFile(path.join(TOON_SRC, 'index.ts'), 'utf8');
        const compressionTs = await fs.promises.readFile(path.join(MCP_SRC, 'compression.ts'), 'utf8');

        // Source.facts declared, edges line-keyed.
        const factsDeclared = /readonly facts\?:\s*RawFileFacts/.test(compressSrc) &&
            /callerLine: number/.test(compressSrc) && /calleeLine: number/.test(compressSrc);
        // SageRank's edge projection reads line endpoints, never names.
        const sageByLine = /e\.callerLine/.test(sageSrc) && /e\.calleeLine/.test(sageSrc) &&
            !/callerName|calleeName|referenced_name/.test(sageSrc);
        // The seam (MCP compression.ts) and the bridge forward line-keyed edges, no names.
        const seamByLine = /callerLine:\s*e\.callerLine/.test(compressionTs) &&
            !/callerName|calleeName/.test(compressionTs);
        const bridgeByLine = /callerLine: number/.test(bridgeSrc) &&
            !/callerName|calleeName/.test(bridgeSrc) &&
            /facts:\s*\{/.test(bridgeSrc); // bridge populates Source.facts

        const ok = factsDeclared && sageByLine && seamByLine && bridgeByLine;
        console.log(`structural: Source.facts line-keyed + toon consumes by line (no name fallback): ${ok}`);

        expect(factsDeclared, 'Source.facts declared with line-keyed edges').toBe(true);
        expect(sageByLine, 'SageRank reads callerLine/calleeLine, no name resolution').toBe(true);
        expect(seamByLine, 'compression.ts forwards line-keyed edges, no names').toBe(true);
        expect(bridgeByLine, 'bridge declares line-keyed edges and populates Source.facts').toBe(true);
    });
});
