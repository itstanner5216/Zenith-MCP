import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { validatePath, formatSize, getAllowedDirectories } from '../lib.js';

const CAP = 250;

export function register(server) {
    server.registerTool("list_directory", {
        title: "List Directory",
        description: "List files and directories. Directories have trailing /. Use depth > 1 for recursive (max 10). Use listAllowed=true to list allowed directories instead.",
        inputSchema: {
            path: z.string().optional(),
            depth: z.number().optional().default(1).describe("Recursion depth. 1 = current dir only, 2+ = recurse. Max 10."),
            includeSizes: z.boolean().optional().default(false).describe("Show file sizes."),
            sortBy: z.enum(["name", "size"]).optional().default("name").describe("Sort by name or size. Only effective with includeSizes."),
            listAllowed: z.boolean().optional().default(false).describe("Return allowed directories instead of listing a path.")
        },
        annotations: { readOnlyHint: true }
    }, async (args) => {
        if (args.listAllowed) {
            return {
                content: [{ type: "text", text: getAllowedDirectories().join('\n') }],
            };
        }
        const validPath = await validatePath(args.path);
        const depth = Math.max(1, Math.min(args.depth || 1, 10));
        const includeSizes = args.includeSizes || false;
        const sortBy = args.sortBy || "name";

        async function listRecursive(dirPath, currentDepth, relativeBase) {
            const lines = [];
            let entries;
            try {
                entries = await fs.readdir(dirPath, { withFileTypes: true });
            } catch {
                lines.push(`[DENIED] ${relativeBase || path.basename(dirPath)}`);
                return lines;
            }

            let truncated = entries.length > CAP;
            if (truncated) entries = entries.slice(0, CAP);

            let processed = entries.map(e => ({ entry: e, size: 0 }));
            if (includeSizes) {
                processed = await Promise.all(entries.map(async (entry) => {
                    try {
                        const stats = await fs.stat(path.join(dirPath, entry.name));
                        return { entry, size: stats.size };
                    } catch {
                        return { entry, size: 0 };
                    }
                }));
                if (sortBy === "size") {
                    processed.sort((a, b) => b.size - a.size);
                }
            }

            for (const { entry, size } of processed) {
                if (lines.length >= CAP) break;
                const rel = relativeBase ? path.join(relativeBase, entry.name) : entry.name;

                if (entry.isDirectory()) {
                    lines.push(`${rel}/`);
                    if (currentDepth + 1 < depth) {
                        const subLines = await listRecursive(
                            path.join(dirPath, entry.name),
                            currentDepth + 1,
                            rel
                        );
                        lines.push(...subLines);
                    }
                } else {
                    lines.push(includeSizes ? `${rel}  ${formatSize(size)}` : rel);
                }
            }

            if (truncated) {
                lines.push('## truncated ##');
            }
            return lines;
        }

        const lines = await listRecursive(validPath, 0, '');
        return {
            content: [{ type: "text", text: lines.join("\n") }],
        };
    });
}
