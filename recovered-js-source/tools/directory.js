import { z } from "zod";
 import fs from "fs/promises";
 import path from "path";
 import { minimatch } from "minimatch";
 import { formatSize } from '../core/lib.js';
 import { DEFAULT_EXCLUDES } from '../core/shared.js';
 import { isSupported, getFileSymbolSummary, getFileSymbols } from '../core/tree-sitter.js';
 
 const LIST_CAP = 250;
 const TREE_MAX_ENTRIES = 500;
 
 export function register(server, ctx) {
     server.registerTool("directory", {
         title: "Directory",
         description: "List directory contents or show a recursive tree.",
         inputSchema: z.object({
             mode: z.enum(["list", "tree"]).describe("Operation mode."),
             path: z.string().optional().describe("Dir path."),
             depth: z.number().optional().default(1).describe("Recursion depth."),
             includeSizes: z.boolean().optional().default(false).describe("Show file sizes."),
             sortBy: z.enum(["name", "size"]).optional().default("name").describe("Sort order."),
             excludePatterns: z.array(z.string()).optional().default([]).describe("Glob exclude patterns."),
             showSymbols: z.boolean().optional().default(false).describe("Show symbol counts."),
             showSymbolNames: z.boolean().optional().default(false).describe("Show symbol names."),
         }),
         annotations: { readOnlyHint: true }
     }, async (args) => {
         if (args.mode === "list") {
             const validPath = await ctx.validatePath(args.path);
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
 
                 let truncated = entries.length > LIST_CAP;
                 if (truncated) entries = entries.slice(0, LIST_CAP);
 
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
                     if (lines.length >= LIST_CAP) break;
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
 
                 if (truncated) lines.push('[truncated]');
                 return lines;
             }
 
             const lines = await listRecursive(validPath, 0, '');
             return { content: [{ type: "text", text: lines.join("\n") }] };
         }
 
         // mode === "tree"
         const rootPath = args.path;
         const showSymbols = args.showSymbols || args.showSymbolNames || false;
         const showSymbolNames = args.showSymbolNames || false;
         let totalEntries = 0;
 
         async function buildTree(currentPath, excludePatterns = []) {
             if (totalEntries >= TREE_MAX_ENTRIES) return [];
             const validPath = await ctx.validatePath(currentPath);
             const entries = await fs.readdir(validPath, { withFileTypes: true });
             const result = [];
 
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
 
                 if (entry.isDirectory()) dirEntries.push(entry);
                 else fileEntries.push(entry);
             }
 
             let symbolResults = null;
             if (showSymbols && fileEntries.length > 0) {
                 const promises = fileEntries.map(async (entry) => {
                     const fullPath = path.join(currentPath, entry.name);
                     if (!isSupported(fullPath)) return [entry.name, null, null];
                     try {
                         if (showSymbolNames) {
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
                 symbolResults = new Map(results.map(([name, summary, names]) => [name, { summary, names 
}]));
             }
 
             for (const entry of dirEntries) {
                 if (totalEntries >= TREE_MAX_ENTRIES) break;
                 const entryData = {
                     name: entry.name,
                     children: await buildTree(path.join(currentPath, entry.name), excludePatterns)
                 };
                 result.push(entryData);
                 totalEntries++;
             }
 
             for (const entry of fileEntries) {
                 if (totalEntries >= TREE_MAX_ENTRIES) break;
                 const entryData = { name: entry.name };
                 if (symbolResults) {
                     const info = symbolResults.get(entry.name);
                     if (info && info.summary) entryData.symbols = info.summary;
                     if (info && info.names) entryData.symbolNames = info.names;
                 }
                 result.push(entryData);
                 totalEntries++;
             }
 
             return result;
         }
 
         const treeData = await buildTree(rootPath, args.excludePatterns);
 
         function escapeControlChars(str) {
             return str.replace(/[\x00-\x1F\x7F]/g, (char) => {
                 const code = char.charCodeAt(0);
                 if (code === 0x09) return '\\t';
                 if (code === 0x0A) return '\\n';
                 if (code === 0x0D) return '\\r';
                 return `\\x${code.toString(16).padStart(2, '0')}`;
             });
         }
 
         function formatIndent(entries, depth = 0) {
             const lines = [];
             const indent = '  '.repeat(depth);
             for (const entry of entries) {
                 if (entry.children) {
                     lines.push(`${indent}${escapeControlChars(entry.name)}/`);
                     lines.push(...formatIndent(entry.children, depth + 1));
                 } else {
                     let suffix = '';
                     if (entry.symbols) suffix += `  (${escapeControlChars(entry.symbols)})`;
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
