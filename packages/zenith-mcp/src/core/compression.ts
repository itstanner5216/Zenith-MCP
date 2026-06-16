// ---------------------------------------------------------------------------
// compression.ts — Facts pipe between zenith-mcp and zenith-toon.
//
// MCP owns: file reading, tree-sitter parsing, symbol-index queries, path
// resolution — i.e. raw FACTS only.
// TOON owns: every compression decision (parse, internal block/context shaping,
// SageRank weighting, anchor priority, injection preservation, keep-ratio +
// truncation marker, omission threshold, line-number assertion).
//
// HARD INVARIANTS (grep-checkable after execution):
//   - Exactly one symbol imported from zenith-toon: compressFile.
//   - Zero compression decisions here: no ranking, no priority shaping, no edge
//     transforms, no keep-ratio math, no usefulness gate, no anchor mapping,
//     no exported-symbol selection, no injection boosting.
//   - One compressFile call. Raw facts in. Compressed string (or null) out.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { compressFile } from 'zenith-toon';
import { getLangForFile } from './tree-sitter.js';
import { findRepoRoot, getDb, ensureFreshFromContent } from './symbol-index.js';
import { getFileFacts, type FileFacts } from './db-adapter.js';

export async function compressForTool(
    validPath: string,
    rawText: string,
    maxChars: number,
): Promise<string | null> {
    if (maxChars <= 0 || rawText.length <= maxChars) return null;

    const langName = getLangForFile(validPath);
    const repoRoot = findRepoRoot(validPath);
    // facts.path crosses the MCP→TOON seam REPO-RELATIVE (Rule 15), never absolute.
    // Outside any repo there is no repo-relative form, so fall back to the basename.
    const relPath = repoRoot ? path.relative(repoRoot, validPath) : path.basename(validPath);

    // Empty-facts default. TOON tolerates this and falls back to its text path.
    let dbFacts: FileFacts = { defs: [], edges: [], anchors: [], imports: [], injections: [] };

    if (repoRoot) {
        try {
            const db = getDb(repoRoot);
            // Content-addressed freshness (C+): index the EXACT bytes we're about to
            // compress, so the facts describe `rawText` — not whatever is on disk now.
            // No redundant disk read (we already hold the bytes) and no read-vs-reindex
            // race. Inside the try so any failure degrades to the empty-facts payload
            // (Rule 12: TOON still compresses via its text path).
            await ensureFreshFromContent(db, repoRoot, validPath, rawText);
            dbFacts = getFileFacts(db, relPath);
        } catch { /* DB unavailable — hand TOON the empty-facts payload */ }
    }

    return compressFile({
        source: rawText,
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
            edges: dbFacts.edges.map(e => ({
                callerName: e.caller_name, calleeName: e.callee_name, callCount: e.call_count,
            })),
            anchors: dbFacts.anchors.map(a => ({
                symbolName: a.symbol_name, kind: a.kind, line: a.line, text: a.text,
            })),
            imports: dbFacts.imports.map(i => ({
                module: i.module, importedNames: i.importedNames, line: i.line,
            })),
            injections: dbFacts.injections.map(j => ({
                injectedLang: j.injected_lang, startLine: j.start_line, endLine: j.end_line,
            })),
        },
    });
}
