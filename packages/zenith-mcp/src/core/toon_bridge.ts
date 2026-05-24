// toon_bridge.ts — Connects zenith-toon's compression to tree-sitter language awareness
//
// This is the integration layer where language structure meets compression:
//   1. Detects file language via getLangForFile() (43 grammars)
//   2. Extracts block + anchor structure via getCompressionStructure() (tree-sitter)
//   3. Queries call graph edges from the symbol index (SQLite)
//   4. Passes structure + AST edges to zenith-toon's compressSourceStructured()
//
// The AST edges come from the symbol index's edges table which tracks
// caller→callee relationships. This gives SageRank structural awareness
// beyond text similarity: functions that call each other get connected
// in the PageRank graph, making "hub" functions (called by many) and
// "authority" functions (calling many) rank higher.

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getCompressionStructure, getLangForFile } from './tree-sitter.js';
import { compressSourceStructured, compressString } from 'zenith-toon';
import type { StructureBlock, ASTEdge } from 'zenith-toon';
import { getFileBlockEdges, getFileDefinitions, type DbConnection } from './db-adapter.js';

/**
 * Build AST edges for compression ranking.
 * Maps symbol index edges to block indices for SageRank integration.
 */
function buildASTEdges(
    conn: DbConnection,
    filePath: string,
    structure: StructureBlock[],
): ASTEdge[] {
    // Get definitions from the symbol index
    const defs = getFileDefinitions(conn, filePath);
    if (defs.length === 0) return [];

    // Build name→blockIndex map by matching line ranges
    const nameToBlockIndex = new Map<string, number>();
    for (let i = 0; i < structure.length; i++) {
        const block = structure[i]!;
        // Find matching definition by line range overlap
        for (const def of defs) {
            if (def.name === block.name ||
                (def.line <= block.startLine && def.endLine >= block.startLine)) {
                nameToBlockIndex.set(def.name, i);
                break;
            }
        }
    }

    // Query edges and map to block indices
    const blockNames = [...nameToBlockIndex.keys()];
    if (blockNames.length === 0) return [];

    const { edges: dbEdges } = getFileBlockEdges(conn, filePath, blockNames);
    
    // Convert to ASTEdge format
    return dbEdges.map(e => ({
        from: e.from,
        to: e.to,
        weight: e.weight,
        kind: e.kind,
    }));
}

/**
 * Compress source text using tree-sitter structure + toon codec.
 * Falls back to unstructured compression when tree-sitter can't parse.
 * 
 * @param content - Source text to compress
 * @param budget - Target size in characters
 * @param filePath - Path to file (for language detection)
 * @param dbConn - Optional SQLite connection for AST edge lookup
 */
export async function compressToon(
    content: string,
    budget: number,
    filePath?: string,
    dbConn?: DbConnection | null,
): Promise<string> {
    if (content.length <= budget) return content;

    let structure: StructureBlock[] | null = null;
    let astEdges: ASTEdge[] | undefined;
    const langName = filePath ? getLangForFile(filePath) : null;

    if (langName) {
        try {
            const defs = await getCompressionStructure(content, langName);
            if (defs && defs.length > 0) {
                structure = defs.map((d) => ({
                    name: d.name,
                    kind: d.type,
                    type: d.type,
                    startLine: d.startLine,
                    endLine: d.endLine,
                    exported: d.exported ?? false,
                    anchors: d.anchors ?? [],
                }));

                // Build AST edges if db connection is available
                if (dbConn && filePath && structure.length > 0) {
                    try {
                        astEdges = buildASTEdges(dbConn, filePath, structure);
                    } catch {
                        // Edge lookup failed — continue without AST edges
                    }
                }
            }
        } catch {
            // tree-sitter unavailable or parse failed — fall through to unstructured
        }
    }

    return structure
        ? compressSourceStructured(content, budget, structure, astEdges)
        : compressString(content, budget);
}

// ── Back-compat CLI shim ─────────────────────────────────────────────────────
// Prior to the toon_bridge_cli.ts split, external callers ran:
//   node dist/core/toon_bridge.js <file> <budget>
// To avoid silent-failure breakage in pinned downstream tooling, detect when
// this module IS the entry script and run the same CLI dispatch as
// toon_bridge_cli.ts. Importers (the common case) are not affected.

const __thisFile = fileURLToPath(import.meta.url);
const __argv1 = process.argv[1];

if (__argv1) {
    let resolvedArgv: string;
    try {
        resolvedArgv = fs.realpathSync(__argv1);
    } catch {
        resolvedArgv = __argv1;
    }
    let resolvedSelf: string;
    try {
        resolvedSelf = fs.realpathSync(__thisFile);
    } catch {
        resolvedSelf = __thisFile;
    }

    if (resolvedArgv === resolvedSelf) {
        // Same strict budget parsing as toon_bridge_cli.ts (kept inline to keep
        // this shim self-contained and avoid a circular dependency).
        const [filePath, budgetRaw] = process.argv.slice(2);
        const valid = typeof budgetRaw === 'string' && /^\d+$/.test(budgetRaw);
        const budget = valid ? Number.parseInt(budgetRaw, 10) : NaN;

        if (!filePath || !Number.isFinite(budget) || budget <= 0) {
            process.exit(1);
        }

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            console.error(`Failed to read file ${filePath}:`, error);
            process.exit(1);
        }

        compressToon(content, budget, filePath)
            .then((out) => process.stdout.write(out))
            .catch((err) => { console.error(err); process.exit(1); });
    }
}
