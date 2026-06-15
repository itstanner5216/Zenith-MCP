// ---------------------------------------------------------------------------
// indexing/resolve.ts — Cross-file edge resolution
//
// Algorithm: For each unresolved edge (callee_symbol_id IS NULL), gather all
// def symbols with matching name (the candidate set, fetched ONCE per name).
// Resolution is then decided per edge using its caller's file_path:
//   - plain name: prefer a unique same-file def (#17 scope-aware); else fall
//     back to a globally-unique def; else leave unresolved.
//   - dot-qualified "Foo.bar": keep the `bar` defs whose parent is named "Foo"
//     (#16); link iff exactly one survives.
//
// Concurrency: ON DELETE SET NULL on edges.callee_symbol_id means if a callee
// file is re-indexed, stale resolutions auto-null. A fresh resolve pass re-reads
// those nulls and re-resolves them — the healing semantics are preserved.
//
// Trigger: resolveAllEdgeTargets(conn) is called once per indexDirectory batch,
// after all files are persisted — ONE pass over the whole DB (review #18,
// "Performance Is Correctness": the old per-file loop was an N+1). The single-
// file resolveEdgeTargets(conn, filePath) remains for callers that resolve one
// file's edges. NOTE: single-file indexFile() deliberately does NOT resolve —
// it is too expensive for interactive edits; the batch pass heals afterwards.
// ---------------------------------------------------------------------------

import type { DbConnection } from '../db-adapter.js';
import { runTransaction, getUnresolvedEdges, getAllUnresolvedEdges, findDefsByName, findSymbolParent, updateEdgeCalleeSymbol } from '../db-adapter.js';

/** An unresolved edge tagged with the file its caller (container def) lives in. */
interface PendingEdge {
    id: number;
    callerFilePath: string;
}

/**
 * Group edges by their referenced name. Each entry carries the full edge so the
 * per-name resolver can decide each edge against its own caller file.
 */
function groupByName(named: Array<{ name: string; edge: PendingEdge }>): Map<string, PendingEdge[]> {
    const byName = new Map<string, PendingEdge[]>();
    for (const { name, edge } of named) {
        const bucket = byName.get(name);
        if (bucket) bucket.push(edge);
        else byName.set(name, [edge]);
    }
    return byName;
}

/**
 * Resolve a group of edges that all reference the same `name`. Candidates for
 * `name` are fetched ONCE here (no N+1) and reused across every edge in the
 * group. Resolution is decided per edge against its caller's file_path so the
 * scope-aware (#17) same-file preference is honoured even when the group spans
 * multiple caller files (the whole-DB batch pass).
 */
function resolveNameGroup(conn: DbConnection, name: string, edges: PendingEdge[]): void {
    const dotIdx = name.lastIndexOf('.');

    if (dotIdx > 0) {
        // --- #16 dot-qualified "Foo.bar" ---------------------------------
        // The qualifier exists PRECISELY because the short name is ambiguous in
        // scope, so the old "shortName must be globally unique" gate was self-
        // defeating. Instead: take ALL `bar` defs, keep those whose parent
        // (parent_symbol_id) is named exactly "Foo", and link iff exactly one
        // survives. (Independent of caller file — qualification is structural.)
        const qualifier = name.slice(0, dotIdx);
        const shortName = name.slice(dotIdx + 1);
        const shortCandidates = findDefsByName(conn, shortName, 'def');
        const underQualifier = shortCandidates.filter((c) => {
            const parent = findSymbolParent(conn, c.id);
            return parent !== null && parent.name === qualifier;
        });
        if (underQualifier.length !== 1) return; // ambiguous or unmatched → leave null
        const target = underQualifier[0];
        if (!target) return; // defensive: length===1 guarantees this, but no non-null assertion
        for (const edge of edges) updateEdgeCalleeSymbol(conn, edge.id, target.id);
        return;
    }

    if (dotIdx === 0) return; // leading dot (".foo") is not dot-qualified — leave null

    // --- plain name: #17 scope-aware (additive, precision-preserving) ----
    // Fetch the candidate set ONCE for this name.
    const candidates = findDefsByName(conn, name, 'def');
    if (candidates.length === 0) return; // unknown callee → leave null

    for (const edge of edges) {
        // 1. Same-file preference: a def of `name` in the caller's own file is
        //    the most precise resolution (a local definition). If exactly one
        //    exists, link to it.
        const sameFile = candidates.filter((c) => c.filePath === edge.callerFilePath);
        if (sameFile.length === 1) {
            const local = sameFile[0];
            if (local) {
                updateEdgeCalleeSymbol(conn, edge.id, local.id);
                continue;
            }
        }
        // 2. Otherwise fall back to the EXISTING safe behaviour: link only when
        //    the name is globally unique. This is exactly what the old resolver
        //    did (findSymbolByNameUnique returned the lone match), so precision
        //    is unchanged — we never link a name the old rule left ambiguous.
        if (candidates.length === 1) {
            const onlyGlobal = candidates[0];
            if (onlyGlobal) updateEdgeCalleeSymbol(conn, edge.id, onlyGlobal.id);
            continue;
        }
        // 3. Ambiguous (>1 candidate) with no unique same-file def → leave null;
        //    healed on the next sweep.
    }
}

/**
 * Resolve unresolved edges whose caller (container def) lives in `filePath`.
 * All such edges share one caller file, so candidates are still fetched once
 * per name. Retained for callers that resolve a single file's edges; the batch
 * pass (resolveAllEdgeTargets) is preferred for whole-directory indexing.
 */
export function resolveEdgeTargets(conn: DbConnection, filePath: string): void {
    const unresolved = getUnresolvedEdges(conn, filePath);
    if (unresolved.length === 0) return;

    const named = unresolved.map((e) => ({ name: e.referenced_name, edge: { id: e.id, callerFilePath: filePath } }));
    const byName = groupByName(named);

    runTransaction(conn, () => {
        for (const [name, edges] of byName) {
            resolveNameGroup(conn, name, edges);
        }
    });
}

/**
 * Whole-DB resolution in ONE pass (review #18). Fetches every unresolved edge
 * once, groups by referenced name, fetches each distinct name's candidate set
 * ONCE, and resolves per edge against the edge's caller file. Replaces the
 * per-file loop in symbol-index.ts that re-ran resolution (and re-queried) for
 * every file — an N+1 the "Performance Is Correctness" constraint forbids.
 *
 * Healing: a re-indexed callee nulls stale rows via ON DELETE SET NULL; a fresh
 * call here re-reads those nulls and re-resolves them, so the self-healing
 * sweep semantics are unchanged.
 */
export function resolveAllEdgeTargets(conn: DbConnection): void {
    const unresolved = getAllUnresolvedEdges(conn);
    if (unresolved.length === 0) return;

    const named = unresolved.map((e) => ({ name: e.referenced_name, edge: { id: e.id, callerFilePath: e.caller_file_path } }));
    const byName = groupByName(named);

    runTransaction(conn, () => {
        for (const [name, edges] of byName) {
            resolveNameGroup(conn, name, edges);
        }
    });
}
