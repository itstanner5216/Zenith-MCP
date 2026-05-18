import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { getCompressionStructure, getLangForFile } from './tree-sitter.js';
import { compressSourceStructured, compressString } from 'zenith-toon';
import type { StructureBlock } from 'zenith-toon';

/**
 * Compress source text using tree-sitter structure + toon codec.
 * Falls back to unstructured compression when tree-sitter can't parse.
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
                structure = defs.map((d) => ({
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
