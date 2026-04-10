import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { minimatch } from "minimatch";
import { validatePath } from '../lib.js';
import { DEFAULT_EXCLUDES } from '../shared.js';
import { isSupported, getFileSymbolSummary, getFileSymbols } from '../tree-sitter.js';

export function register(server) {
    server.registerTool("directory_tree", {
        title: "Directory Tree",
        description: "Recursive tree view as JSON. Directories have 'children', files do not.",
        inputSchema: {
            path: z.string(),
            excludePatterns: z.array(z.string()).optional().default([]),
            showSymbols: z.boolean().optional().default(false).describe("Add symbol summary string to each supported file (e.g. '3 functions, 1 class')."),
            showSymbolNames: z.boolean().optional().default(false).describe("Add full list of definition names to each supported file. Implies showSymbols. More detailed but larger output.")
        },
        annotations: { readOnlyHint: true }
    }, async (args) => {
        const rootPath = args.path;
        const showSymbols = args.showSymbols || args.showSymbolNames || false;
        const showSymbolNames = args.showSymbolNames || false;
        let totalEntries = 0;
        const MAX_ENTRIES = 500;

        async function buildTree(currentPath, excludePatterns = []) {
            if (totalEntries >= MAX_ENTRIES) return [];
            const validPath = await validatePath(currentPath);
            const entries = await fs.readdir(validPath, { withFileTypes: true });
            const result = [];

            // Separate files for parallel symbol processing
            const fileEntries = [];
            const dirEntries = [];

            for (const entry of entries) {
                const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
                const shouldExclude = excludePatterns.some(pattern => {
                    if (pattern.includes('*')) return minimatch(relativePath, pattern, { dot: true });
                    return minimatch(relativePath, pattern, { dot: true }) ||
                        minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
                        minimatch(relativePath, `**/${pattern}/**`, { dot: true });
                });
                const shouldExcludeByDefault = DEFAULT_EXCLUDES.some(p =>
                    entry.name === p ||
                    minimatch(relativePath, p, { dot: true }) ||
                    minimatch(relativePath, `**/${p}`, { dot: true })
                );
                if (shouldExclude || shouldExcludeByDefault) continue;

                if (entry.isDirectory()) {
                    dirEntries.push(entry);
                } else {
                    fileEntries.push(entry);
                }
            }

            // Batch symbol lookups for files in parallel
            let symbolResults = null;
            if (showSymbols && fileEntries.length > 0) {
                const promises = fileEntries.map(async (entry) => {
                    const fullPath = path.join(currentPath, entry.name);
                    if (!isSupported(fullPath)) return [entry.name, null, null];
                    try {
                        if (showSymbolNames) {
                            // Get full symbol list
                            const symbols = await getFileSymbols(fullPath, { kindFilter: 'def' });
                            if (!symbols || symbols.length === 0) return [entry.name, null, null];
                            const names = symbols.slice(0, 50).map(s => `${s.name} (${s.type})`);
                            const summary = await getFileSymbolSummary(fullPath);
                            return [entry.name, summary, names];
                        } else {
                            const summary = await getFileSymbolSummary(fullPath);
                            return [entry.name, summary, null];
                        }
                    } catch {
                        return [entry.name, null, null];
                    }
                });
                const results = await Promise.all(promises);
                symbolResults = new Map(results.map(([name, summary, names]) => [name, { summary, names }]));
            }

            // Build entries in original order (dirs first, then files)
            for (const entry of dirEntries) {
                if (totalEntries >= MAX_ENTRIES) break;
                const entryData = {
                    name: entry.name,
                    children: await buildTree(path.join(currentPath, entry.name), excludePatterns)
                };
                result.push(entryData);
                totalEntries++;
            }

            for (const entry of fileEntries) {
                if (totalEntries >= MAX_ENTRIES) break;
                const entryData = { name: entry.name };

                if (symbolResults) {
                    const info = symbolResults.get(entry.name);
                    if (info && info.summary) {
                        entryData.symbols = info.summary;
                    }
                    if (info && info.names) {
                        entryData.symbolNames = info.names;
                    }
                }

                result.push(entryData);
                totalEntries++;
            }

            return result;
        }

        const treeData = await buildTree(rootPath, args.excludePatterns);
        const text = JSON.stringify(treeData) + (totalEntries >= MAX_ENTRIES ? '\n## truncated ##' : '');
        return {
            content: [{ type: "text", text }],
        };
    });
}
