// ---------------------------------------------------------------------------
// compression.ts — Facts pipe between zenith-mcp and zenith-toon.
//
// MCP owns: file reading, tree-sitter parsing, symbol-index queries, path
// resolution — i.e. raw FACTS only.
// TOON owns: every compression decision (parse, internal block/context shaping,
// SageRank weighting, anchor priority, injection preservation, keep-ratio +
// truncation marker, omission threshold, line-number assertion).
//
// LINE-NUMBER PREFIX: read_file / read_multiple_files are the SINGLE authority
// that places the `N. ` line-number prefix, ONCE, before calling in here. Nothing
// downstream recomputes or re-prefixes a line. So this pipe receives N.-prefixed
// text and does two things with it: (1) STRIPS the prefix (the same regex TOON
// uses) to feed the symbol indexer the REAL code — line N is already prefix N, so
// facts keep true line numbers and tree-sitter never sees the prefixed text;
// (2) hands the PREFIXED copy to TOON, which emits its kept lines verbatim.
//
// HARD INVARIANTS (grep-checkable after execution):
//   - Exactly one symbol imported from zenith-toon: compressFile.
//   - Zero compression decisions here: no ranking, no priority shaping, no edge
//     transforms, no keep-ratio math, no usefulness gate, no anchor mapping,
//     no exported-symbol selection, no injection boosting. (Stripping a prefix to
//     index real code is transport, not a compression decision.)
//   - One compressFile call. Raw facts in. Compressed string (or null) out.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { compressFile } from 'zenith-toon';
import { getLangForFile } from './tree-sitter.js';
import { findRepoRoot, getDb, ensureFreshFromContent } from './symbol-index.js';
import { getFileFacts, type FileFacts } from './db-adapter.js';

export async function compressForTool(
    validPath: string,
    prefixedSource: string,
    maxChars: number,
): Promise<string | null> {
    if (maxChars <= 0 || prefixedSource.length <= maxChars) return null;

    const langName = getLangForFile(validPath);
    const repoRoot = findRepoRoot(validPath);
    // facts.path crosses the MCP→TOON seam REPO-RELATIVE (Rule 15), never absolute.
    // Outside any repo there is no repo-relative form, so fall back to the basename.
    const relPath = repoRoot ? path.relative(repoRoot, validPath) : path.basename(validPath);

    // Empty-facts default. TOON tolerates this and falls back to its text path.
    let dbFacts: FileFacts = { defs: [], references: [], edges: [], referenceEdges: [], anchors: [], imports: [], importBindings: [], injections: [], scopes: [] };

    if (repoRoot) {
        try {
            const db = getDb(repoRoot);
            // read_file already placed the `N. ` prefix; strip it (the SAME regex TOON
            // uses to weigh lines) so the indexer parses the REAL code, never the
            // prefixed text. The reconstruction is exact for the `N. ` form, so these
            // bytes equal the on-disk source the background indexer hashed — facts keep
            // true line numbers (line N is already prefix N) and there is no spurious
            // re-index. Content-addressed freshness (C+): index the EXACT code bytes we
            // are about to compress, not whatever is on disk now. Inside the try so any
            // failure degrades to the empty-facts payload (Rule 12: TOON still
            // compresses via its text path).
            const indexedSource = prefixedSource
                .split('\n')
                .map(l => l.replace(/^\s*\d+[.:]\s?/, ''))
                .join('\n');
            await ensureFreshFromContent(db, repoRoot, validPath, indexedSource);
            dbFacts = getFileFacts(db, relPath);
        } catch { /* DB unavailable — hand TOON the empty-facts payload */ }
    }

    return compressFile({
        source: prefixedSource,
        maxChars,
        facts: {
            path: relPath,
            langName,
            // A def's `type` is always set from its tree-sitter capture tag
            // (indexing/extract.ts: `type = tag.slice(16)`), so every def row
            // carries a type in practice. The `symbols.type` column is merely
            // declared nullable, so we narrow it honestly with a type-guard
            // rather than asserting non-null — this drops nothing for real defs
            // and forwards a `string` (not `string | null`) to TOON's RawFileFacts.
            defs: dbFacts.defs
                .filter((d): d is typeof d & { type: string } => d.type !== null)
                .map(d => ({
                    name: d.name, kind: 'def', type: d.type,
                    line: d.line, endLine: d.endLine,
                    visibility: d.visibility, captureTag: d.captureTag,
                })),
            references: dbFacts.references.map(r => ({
                name: r.name, type: r.type,
                line: r.line, endLine: r.endLine, column: r.column,
            })),
            edges: dbFacts.edges.map(e => ({
                callerLine: e.callerLine, calleeLine: e.calleeLine, callCount: e.callCount,
            })),
            referenceEdges: dbFacts.referenceEdges.map(e => ({
                callerLine: e.callerLine, referencedName: e.referencedName,
                referenceKind: e.referenceKind, referenceCount: e.referenceCount,
            })),
            anchors: dbFacts.anchors.map(a => ({
                symbolName: a.symbol_name, kind: a.kind,
                line: a.line, endLine: a.endLine, text: a.text,
            })),
            imports: dbFacts.imports.map(i => ({
                module: i.module, importedNames: i.importedNames,
                line: i.line, startLine: i.startLine, endLine: i.endLine,
            })),
            importBindings: dbFacts.importBindings.map(i => ({
                source: i.source,
                localName: i.localName,
                importedName: i.importedName,
                importKind: i.importKind,
                isTypeOnly: i.isTypeOnly,
                line: i.line,
                column: i.column,
            })),
            injections: dbFacts.injections.map(j => ({
                injectedLang: j.injected_lang, startLine: j.start_line, endLine: j.end_line,
            })),
            // CASING WARNING (C3): reads camelCase scopeKind/startLine/endLine — these MUST match
            // db-adapter.ts's SELECT aliases in T2. A mismatch silently yields empty scopes with NO
            // build error. Pure transport: do not filter/rank/normalize/drop small scopes
            // (AGENTS.md §0.5 / Step F5). camelCase → camelCase identity map, verbatim.
            scopes: dbFacts.scopes.map(s => ({ scopeKind: s.scopeKind, startLine: s.startLine, endLine: s.endLine })),
        },
    });
}
