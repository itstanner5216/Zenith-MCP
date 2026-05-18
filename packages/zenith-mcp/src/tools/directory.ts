import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { Dirent } from "fs";
import { minimatch } from "minimatch";
import { formatSize } from '../core/lib.js';
import { getDefaultExcludes, isSensitive } from '../core/shared.js';
import { isSupported, getFileSymbolSummary, getFileSymbols } from '../core/tree-sitter.js';
import type { ToolServer, ToolContext } from './types.js';

const LIST_CAP = 250;
const TREE_MAX_ENTRIES = 500;

interface FileTreeEntry {
    name: string;
    children?: FileTreeEntry[];
    symbols?: string;
    symbolNames?: string[];
}

interface DirectoryArgs {
    mode: "list" | "tree";
    path?: string;
    depth?: number;
    includeSizes?: boolean;
    sortBy?: "name" | "size";
    excludePatterns?: string[];
    showSymbols?: boolean;
    showSymbolNames?: boolean;
}

export function register(server: ToolServer, ctx: ToolContext): void {
    server.registerTool("directory", {
        title: "Directory",
        description: "List directory contents or show a recursive tree.",
        inputSchema: z.object({
            mode: z.enum(["list", "tree"]).describe("Operation mode."),
            path: z.string().optional().describe("Dir path."),
            depth: z.number().int().min(1).max(10).optional().describe("Recursion depth. Defaults to 1 for list, unlimited for tree."),
            includeSizes: z.boolean().optional().default(false).describe("Show file sizes."),
            sortBy: z.enum(["name", "size"]).optional().default("name").describe("Sort order."),
            excludePatterns: z.array(z.string()).optional().default([]).describe("Glob exclude patterns."),
            showSymbols: z.boolean().optional().default(false).describe("Show symbol counts."),
            showSymbolNames: z.boolean().optional().default(false).describe("Show symbol names."),
        }),
        annotations: { readOnlyHint: true }
    }, async (args: DirectoryArgs) => {
        if (args.mode === "list") {
            const validPath = await ctx.validatePath(args.path ?? '');
            const depth = Math.max(1, Math.min(args.depth || 1, 10));
            const includeSizes = args.includeSizes || false;
            const sortBy = args.sortBy || "name";
            const excludePatterns = args.excludePatterns ?? [];
            const defaultExcludes = getDefaultExcludes();

            function escapeCtrl(str: string): string {
                return str.replace(/[\x00-\x1F\x7F]/g, (c: string) => {
                    const code = c.charCodeAt(0);
                    if (code === 0x09) return '\\t';
                    if (code === 0x0A) return '\\n';
                    if (code === 0x0D) return '\\r';
                    return `\\x${code.toString(16).padStart(2, '0')}`;
                });
            }

            function compareEntries(
                left: { entry: Dirent; size: number },
                right: { entry: Dirent; size: number },
            ): number {
                if (sortBy === 'size' && left.size !== right.size) {
                    return right.size - left.size;
                }
                if (left.entry.isDirectory() !== right.entry.isDirectory()) {
                    return left.entry.isDirectory() ? -1 : 1;
                }
                return left.entry.name.localeCompare(right.entry.name, undefined, { numeric: true, sensitivity: 'base' });
            }

            async function listRecursive(dirPath: string, currentDepth: number, relativeBase: string): Promise<string[]> {
                const lines: string[] = [];
                let entries: Dirent[];
                try {
                    entries = await fs.readdir(dirPath, { withFileTypes: true });
                }
                catch {
                    lines.push(`[DENIED] ${relativeBase || path.basename(dirPath)}`);
                    return lines;
                }
                // Filter entries: user excludes + default excludes + sensitive files
                entries = entries.filter(entry => {
                    const rel = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
                    const fullPath = path.join(dirPath, entry.name);
                    // Sensitive file check
                    if (isSensitive(fullPath)) return false;
                    // Default excludes
                    if (defaultExcludes.some(p => entry.name === p ||
                        minimatch(rel, p, { dot: true }) ||
                        minimatch(rel, `**/${p}`, { dot: true }))) return false;
                    // User excludes
                    if (excludePatterns.length > 0 && excludePatterns.some(pattern => {
                        if (pattern.includes('*')) {
                            if (minimatch(rel, pattern, { dot: true })) return true;
                            if (!pattern.includes('/')) return minimatch(rel, `**/${pattern}`, { dot: true });
                            return false;
                        }
                        return minimatch(rel, pattern, { dot: true }) ||
                            minimatch(rel, `**/${pattern}`, { dot: true }) ||
                            minimatch(rel, `**/${pattern}/**`, { dot: true });
                    })) return false;
                    return true;
                });
                const truncated = entries.length > LIST_CAP;
                if (truncated) entries = entries.slice(0, LIST_CAP);
                // Load sizes when needed for sorting or display
                let processed: { entry: Dirent; size: number }[];
                if (includeSizes || sortBy === 'size') {
                    processed = await Promise.all(entries.map(async (entry) => {
                        try {
                            const stats = await fs.stat(path.join(dirPath, entry.name));
                            return { entry, size: stats.size };
                        }
                        catch {
                            return { entry, size: 0 };
                        }
                    }));
                }
                else {
                    processed = entries.map(e => ({ entry: e, size: 0 }));
                }
                processed.sort(compareEntries);
                for (const { entry, size } of processed) {
                    const rel = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
                    const safeRel = escapeCtrl(rel);
                    if (entry.isDirectory()) {
                        lines.push(`${safeRel}/`);
                        if (currentDepth + 1 < depth) {
                            const subLines: string[] = await listRecursive(path.join(dirPath, entry.name), currentDepth + 1, rel);
                            lines.push(...subLines);
                        }
                    }
                    else {
                        lines.push(includeSizes ? `${safeRel}  ${formatSize(size)}` : safeRel);
                    }
                }
                if (truncated) lines.push('[truncated]');
                return lines;
            }
            const lines = await listRecursive(validPath, 0, '');
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        // mode === "tree"
        const rootPath = await ctx.validatePath(args.path ?? '');
        const showSymbols = args.showSymbols || args.showSymbolNames || false;
        const showSymbolNames = args.showSymbolNames || false;
        let totalEntries = 0;
        const maxDepth = args.depth != null ? Math.max(1, Math.min(args.depth, 10)) : Infinity;
        const defaultExcludes = getDefaultExcludes();
        async function buildTree(currentPath: string, currentDepth: number, excludePatterns: string[] = []): Promise<FileTreeEntry[]> {
            if (totalEntries >= TREE_MAX_ENTRIES)
                return [];
            const validPath = await ctx.validatePath(currentPath);
            const entries = await fs.readdir(validPath, { withFileTypes: true });
            const result: FileTreeEntry[] = [];
            const fileEntries: Dirent[] = [];
            const dirEntries: Dirent[] = [];
            for (const entry of entries) {
                const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
                const fullPath = path.join(currentPath, entry.name);
                if (isSensitive(fullPath)) continue;
                const shouldExclude = excludePatterns.some((pattern: string) => {
                    if (pattern.includes('*')) {
                        if (minimatch(relativePath, pattern, { dot: true })) return true;
                        if (!pattern.includes('/')) return minimatch(relativePath, `**/${pattern}`, { dot: true });
                        return false;
                    }
                    return minimatch(relativePath, pattern, { dot: true }) ||
                        minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
                        minimatch(relativePath, `**/${pattern}/**`, { dot: true });
                });
                const shouldExcludeByDefault = defaultExcludes.some(p => entry.name === p ||
                    minimatch(relativePath, p, { dot: true }) ||
                    minimatch(relativePath, `**/${p}`, { dot: true }));
                if (shouldExclude || shouldExcludeByDefault)
                    continue;
                if (entry.isDirectory())
                    dirEntries.push(entry);
                else
                    fileEntries.push(entry);
            }
            let symbolResults: Map<string, { summary: string | null; names: string[] | null }> | null = null;
            if (showSymbols && fileEntries.length > 0) {
                const promises = fileEntries.map(async (entry): Promise<[string, string | null, string[] | null]> => {
                    const fullPath = path.join(currentPath, entry.name);
                    if (!isSupported(fullPath))
                        return [entry.name, null, null];
                    try {
                        if (showSymbolNames) {
                            const symbols = await getFileSymbols(fullPath, { kindFilter: 'def' });
                            if (!symbols || symbols.length === 0)
                                return [entry.name, null, null];
                            const names = symbols.slice(0, 50).map(s => `${s.name} (${s.type})`);
                            const summary = await getFileSymbolSummary(fullPath);
                            return [entry.name, summary, names];
                        }
                        else {
                            const summary = await getFileSymbolSummary(fullPath);
                            return [entry.name, summary, null];
                        }
                    }
                    catch {
                        return [entry.name, null, null];
                    }
                });
                const results = await Promise.all(promises);
                symbolResults = new Map(results.map(([name, summary, names]) => [name, { summary, names }]));
            }
            dirEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            fileEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            for (const entry of dirEntries) {
                if (totalEntries >= TREE_MAX_ENTRIES)
                    break;
                const nextPath = path.join(currentPath, entry.name);
                const entryData: FileTreeEntry = currentDepth + 1 < maxDepth
                    ? { name: entry.name, children: await buildTree(nextPath, currentDepth + 1, excludePatterns) }
                    : { name: entry.name, children: [] }; // Show as dir stub at max depth
                result.push(entryData);
                totalEntries++;
            }
            for (const entry of fileEntries) {
                if (totalEntries >= TREE_MAX_ENTRIES)
                    break;
                const entryData: FileTreeEntry = { name: entry.name };
                if (symbolResults) {
                    const info = symbolResults.get(entry.name);
                    if (info && info.summary)
                        entryData.symbols = info.summary;
                    if (info && info.names)
                        entryData.symbolNames = info.names;
                }
                result.push(entryData);
                totalEntries++;
            }
            return result;
        }
        const treeData = await buildTree(rootPath, 0, args.excludePatterns);
        function escapeControlChars(str: string): string {
            return str.replace(/[\x00-\x1F\x7F]/g, (char: string) => {
                const code = char.charCodeAt(0);
                if (code === 0x09)
                    return '\\t';
                if (code === 0x0A)
                    return '\\n';
                if (code === 0x0D)
                    return '\\r';
                return `\\x${code.toString(16).padStart(2, '0')}`;
            });
        }
        function formatIndent(entries: FileTreeEntry[], depth = 0): string[] {
            const lines: string[] = [];
            const indent = '  '.repeat(depth);
            for (const entry of entries) {
                if (entry.children) {
                    lines.push(`${indent}${escapeControlChars(entry.name)}/`);
                    lines.push(...formatIndent(entry.children, depth + 1));
                }
                else {
                    let suffix = '';
                    if (entry.symbols)
                        suffix += `  (${escapeControlChars(entry.symbols)})`;
                    if (entry.symbolNames) {
                        const sanitizedNames = entry.symbolNames.map(escapeControlChars);
                        suffix += `  [${sanitizedNames.join(', ')}]`;
                    }
                    lines.push(`${indent}${escapeControlChars(entry.name)}${suffix}`);
                }
            }
            return lines;
        }
        const textLines = formatIndent(treeData);
        const text = textLines.join('\n') + (totalEntries >= TREE_MAX_ENTRIES ? '\n[truncated]' : '');
        return { content: [{ type: "text", text }] };
    });
}
//# sourceMappingURL=directory.js.map
