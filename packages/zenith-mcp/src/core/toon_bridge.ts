// toon_bridge.ts
// In-process bridge: tree-sitter structure extraction → toon compression.
// Called directly by compression.ts or executed via CLI for subprocess isolation.

import { getCompressionStructure, getLangForFile } from './tree-sitter.js';
import { compressSourceStructured, compressString } from 'zenith-toon';
import type { StructureBlock } from 'zenith-toon';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Compress source text using tree-sitter structure + toon codec.
 * Falls back to unstructured compression when tree-sitter can't parse.
 *
 * @param content  - raw file text
 * @param budget   - target character budget
 * @param filePath - optional, used to detect language for tree-sitter
 * @returns compressed text, or original if already within budget
 */
export async function compressToon(
    content: string,
    budget: number,
    filePath?: string,
): Promise<string> {
    if (content.length <= budget) return content;

    let structure: StructureBlock[] | null = null;
    const langName = filePath ? getLangForFile(filePath) : null;

    if (langName) {
        try {
            const defs = await getCompressionStructure(content, langName);
            if (defs && defs.length > 0) {
                structure = defs.map((d: { name: string; type: string; startLine: number; endLine: number; exported: boolean; anchors: Array<{ startLine: number; endLine: number; kind: string; priority: number }> }) => ({
                    name: d.name,
                    kind: d.type,
                    type: d.type,
                    startLine: d.startLine,
                    endLine: d.endLine,
                    exported: d.exported ?? false,
                    anchors: d.anchors ?? [],
                }));
            }
        } catch {
            // tree-sitter unavailable or parse failed — fall through to unstructured
        }
    }

    return structure
        ? compressSourceStructured(content, budget, structure)
        : compressString(content, budget);
}

// CLI Entry Point — invoked by compression.ts as: node dist/core/toon_bridge.js <filepath> <budget>
const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (scriptPath === thisPath) {
    const filePath = process.argv[2];
    const budget = parseInt(process.argv[3] ?? '0', 10);

    if (filePath && !isNaN(budget) && budget > 0) {
        const content = fs.readFileSync(filePath, 'utf-8');
        compressToon(content, budget, filePath)
            .then(out => process.stdout.write(out))
            .catch(err => {
                console.error(err);
                process.exit(1);
            });
    } else {
        process.exit(1);
    }
}

