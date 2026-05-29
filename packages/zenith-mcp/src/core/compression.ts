// ---------------------------------------------------------------------------
// compression.ts — Bridge between zenith-mcp file reading and zenith-toon
//
// MCP owns: file reading, tree-sitter parsing, symbol-index queries, path resolution
// TOON owns: compression intelligence (what to keep, what to drop)
//
// This module is the seam: it collects structural data from MCP's stores and
// passes it to toon as a plain CompressionContext object.
// ---------------------------------------------------------------------------

import path from 'path';
import { compressString, compressSourceStructured } from 'zenith-toon';
import { getLangForFile, getSymbols } from './tree-sitter.js';
import { findRepoRoot, getDb } from './symbol-index.js';
import { getFileBlockEdges } from './db-adapter.js';
import type { StructureBlock, CompressionContext } from 'zenith-toon';

export const DEFAULT_COMPRESSION_KEEP_RATIO = 0.70;

export function computeCompressionBudget(rawLength: number, maxChars: number, keepRatio = DEFAULT_COMPRESSION_KEEP_RATIO): number {
    if (!Number.isFinite(rawLength) || rawLength <= 0) return 0;
    const boundedMaxChars = Math.max(0, Math.floor(maxChars));
    const ratioBudget = Math.max(1, Math.floor(rawLength * keepRatio));
    return Math.min(boundedMaxChars, ratioBudget);
}

export function isCompressionUseful(rawText: string, compressedText: string | null, maxChars: number, keepRatio = DEFAULT_COMPRESSION_KEEP_RATIO): compressedText is string {
    if (compressedText === null || compressedText.length === 0 || rawText.length === 0) return false;

    const boundedMaxChars = Math.max(0, Math.floor(maxChars));
    if (rawText.length === boundedMaxChars) return false;

    const targetBudget = computeCompressionBudget(rawText.length, maxChars, keepRatio);
    if (targetBudget <= 0 || targetBudget >= rawText.length) return false;

    return compressedText.length < rawText.length
        && compressedText.length <= targetBudget
        && compressedText.length < boundedMaxChars;
}

export function truncateToBudget(text: unknown, budget: number): { text: string; truncated: boolean } {
    if (typeof text !== 'string') {
        return { text: '', truncated: false };
    }

    if (text.length <= budget) {
        const hasContent = text.replace(/\n/g, '').length > 0;
        return { text, truncated: !hasContent };
    }

    let cutoff = text.lastIndexOf('\n', budget);
    if (cutoff === -1) cutoff = budget;

    return {
        text: text.slice(0, cutoff),
        truncated: true,
    };
}

/**
 * Compress a source file using tree-sitter structure + symbol-index graph data.
 *
 * Flow:
 *   1. Detect language via tree-sitter
 *   2. Parse symbols → map to StructureBlock[]
 *   3. If repo root found, query symbol-index for call-graph edges
 *   4. Assemble CompressionContext and hand to zenith-toon
 *   5. Fall back to unstructured compression if AST route fails
 */
export async function compressTextFile(
    validPath: string,
    rawText: string,
    maxChars: number,
    keepRatio = DEFAULT_COMPRESSION_KEEP_RATIO
): Promise<{ text: string; targetBudget: number; rawLength: number; compressedLength: number } | null> {
    const targetBudget = computeCompressionBudget(rawText.length, maxChars, keepRatio);
    if (targetBudget <= 0 || targetBudget >= rawText.length) {
        return null;
    }

    let compressed: string | null = null;
    const langName = getLangForFile(validPath);

    if (langName) {
        try {
            const rawSymbols = await getSymbols(rawText, langName);
            if (rawSymbols) {
                const defs = rawSymbols.filter(s => s.kind === 'def');

                const structure: StructureBlock[] = defs.map(s => ({
                    name: s.name,
                    kind: s.kind,
                    type: s.type,
                    startLine: s.line - 1,
                    endLine: s.endLine - 1,
                    exported: false,
                    anchors: [],
                }));

                const context: CompressionContext = {};

                // Enrich with call-graph data from symbol index
                const repoRoot = findRepoRoot(validPath);
                if (repoRoot && defs.length > 0) {
                    try {
                        const db = getDb(repoRoot);
                        const relPath = path.relative(repoRoot, validPath);
                        const blockNames = defs.map(d => d.name);
                        const graphData = getFileBlockEdges(db, relPath, blockNames);
                        if (graphData.edges.length > 0) {
                            context.astEdges = graphData.edges;
                        }
                    } catch {
                        // DB unavailable or not indexed — compress without graph context
                    }
                }

                compressed = compressSourceStructured(rawText, targetBudget, structure, context);
            }
        } catch {
            // tree-sitter unavailable or parse failed — fall through to unstructured
        }
    }

    // Fallback: unstructured compression for unsupported file types or parse failures
    if (!compressed) {
        compressed = compressString(rawText, targetBudget);
    }

    if (!isCompressionUseful(rawText, compressed, maxChars, keepRatio)) {
        return null;
    }

    return {
        text: compressed,
        targetBudget,
        rawLength: rawText.length,
        compressedLength: compressed.length,
    };
}
