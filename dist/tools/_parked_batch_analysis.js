// =================================================================
// PARKED: Batch analysis params from old stashApply / edit_file
// These were moved out to simplify stashRestore. Will revisit later.
// =================================================================
//
// Schema params that lived under batch:
//
//   query: z.string().optional()         — BM25 impact analysis query
//   load: z.array(z.union([z.number(), z.string()])).optional() — load specific results by index/name
//   symbols: z.array(z.string()).optional() — symbol filter
//   range: z.number().optional()         — line range filter
//   excludeLines: z.array(z.number()).optional() — exclude lines
//   dryRun: z.boolean().optional()
//   reapply: z.object({ symbols: z.array(z.string()) }).optional()
//
// Handler code that used these:
//
// --- Query ---
// if (batch.query && !batch.load) {
//     const results = impactQuery(session.db, batch.query, batch.symbols);
//     session.impactResults = results;
//     session.stage = 1;
//     const lines = results.map((r, i) =>
//         `${i + 1}. ${r.name} (${r.filePath}) score:${r.score.toFixed(2)}`
//     );
//     return { content: [{ type: 'text', text: lines.join('\n') || 'No results.' }] };
// }
//
// --- Load ---
// if (batch.load) {
//     let targetedEntries;
//     targetedEntries = batch.load.map(item => {
//         if (typeof item === 'number') return session.impactResults[item - 1];
//         return session.impactResults.find(r => r.name === item) || { name: item, filePath: null };
//     }).filter(Boolean);
//     return loadDiff(session, targetedEntries, batch.excludeLines, batch.range);
// }
//
// --- Reapply ---
// if (batch.reapply) {
//     for (const sym of batch.reapply.symbols) {
//         const cached = session.editPayloadCache.get(sym);
//         if (!cached) continue;
//         const group = session.loadedGroups?.find(g => g.symbolName === sym);
//         if (!group) continue;
//         for (const occ of group.occurrences) {
//             // ... splice cached text into file at symbol location
//         }
//     }
// }
//
// Dependencies needed if re-enabling:
//   import { _batchSession, getOrCreateSession, parseEditPayload, loadDiff, resolveRepoPath } from './edit_file.js';
//   import { impactQuery, snapshotSymbol, getVersionHistory, getVersionText, restoreVersion, getSessionId } from '../core/symbol-index.js';
