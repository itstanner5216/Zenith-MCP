// ---------------------------------------------------------------------------
// indexing/resolve.ts — Cross-file edge resolution
//
// Algorithm: For each unresolved edge (callee_symbol_id IS NULL), query all
// def symbols with matching name. If exactly one exists → link. If ambiguous → skip.
//
// Concurrency: ON DELETE SET NULL on edges.callee_symbol_id means if callee
// file is re-indexed, stale resolutions auto-null. Next indexDirectory run heals.
//
// Trigger: Called once per indexDirectory batch, after all files persisted.
// NOT called by single-file indexFile (too expensive for interactive edits).
// ---------------------------------------------------------------------------

import type { DbConnection } from '../db-adapter.js';
import { runTransaction, getUnresolvedEdges, findSymbolByNameUnique, findSymbolParent, updateEdgeCalleeSymbol } from '../db-adapter.js';

export function resolveEdgeTargets(conn: DbConnection, filePath: string): void {
    const unresolved = getUnresolvedEdges(conn, filePath);
    if (unresolved.length === 0) return;

    // Group by name to avoid repeated queries
    const byName = new Map<string, number[]>();
    for (const edge of unresolved) {
        if (!byName.has(edge.referenced_name)) byName.set(edge.referenced_name, []);
        byName.get(edge.referenced_name)!.push(edge.id);
    }

    runTransaction(conn, () => {
        for (const [name, edgeIds] of byName) {
            // STRICT unambiguous resolution. We only link an edge when the resolution
            // is provably unique. Anything else stays null and is healed on the next
            // sweep (callee files re-indexing nulls stale rows via ON DELETE SET NULL).
            //
            // 1. Full-name unique def? → link.
            const target = findSymbolByNameUnique(conn, name, 'def');
            if (target) {
                for (const edgeId of edgeIds) updateEdgeCalleeSymbol(conn, edgeId, target.id);
                continue;
            }
            // 2. Dot-qualified "Foo.bar" fallback. Strict policy:
            //    a) short name ("bar") MUST resolve to exactly one def globally, AND
            //    b) that def's parent (by parent_symbol_id) MUST exist and its name
            //       MUST equal the qualifier ("Foo").
            //    If either condition fails, the column stays null. We do not pick the
            //    short name on its own — the qualifier exists precisely because the
            //    short name is ambiguous in scope.
            const dotIdx = name.lastIndexOf('.');
            if (dotIdx <= 0) continue;
            const qualifier = name.slice(0, dotIdx);
            const shortName = name.slice(dotIdx + 1);
            const shortTarget = findSymbolByNameUnique(conn, shortName, 'def');
            if (!shortTarget) continue;
            const parent = findSymbolParent(conn, shortTarget.id);
            if (!parent || parent.name !== qualifier) continue;
            for (const edgeId of edgeIds) updateEdgeCalleeSymbol(conn, edgeId, shortTarget.id);
        }
    });
}
