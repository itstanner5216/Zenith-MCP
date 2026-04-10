import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { validatePath } from '../lib.js';
import {
    DEFAULT_EXCLUDES, isSensitive,
    ripgrepAvailable, ripgrepFindFiles,
    BM25Index, CHAR_BUDGET,
} from '../shared.js';
import { isSupported, getLangForFile, getDefinitions } from '../tree-sitter.js';

export function register(server) {
    server.registerTool("find_files", {
        title: "Find Files",
        description: "Find files by name glob, path substring, extension, or symbol definition.",
        inputSchema: {
            path: z.string().describe("Root directory to search in"),
            namePattern: z.string().optional().describe("Glob for filename, e.g. '*.ts', 'Button*.tsx', 'index.js'. Matches filename only, not full path."),
            pathContains: z.string().optional().describe("Substring that must appear anywhere in the full file path, e.g. 'components/Button', 'src/utils', 'auth'."),
            extensions: z.array(z.string()).optional().describe(
                "Filter by file extensions, e.g. ['.ts', '.tsx']. Dot prefix required."
            ),
            relevanceQuery: z.string().optional().describe(
                "Rank results by path relevance, e.g. 'authentication middleware'. " +
                "Queries under 3 characters are too short to affect ordering."
            ),
            maxResults: z.number().optional().default(100),
            includeMetadata: z.boolean().optional().default(false).describe("Include file size and modified date per result."),
            definesSymbol: z.string().optional().describe(
                "Find files that define a specific symbol (function, class, method, interface, etc.). " +
                "The symbol must be a definition, not just a reference. " +
                "Supports dot-qualified names like 'MyClass.sendMessage'. " +
                "Can be combined with namePattern/pathContains/extensions to narrow the search scope."
            ),
        },
        annotations: { readOnlyHint: true }
    }, async (args) => {
        if (!args.namePattern && !args.pathContains && !args.extensions?.length && !args.definesSymbol) {
            throw new Error("Provide at least one of: namePattern (glob), pathContains (path substring), extensions (file extension filter), or definesSymbol");
        }
        const rootPath = await validatePath(args.path);
        const maxResults = Math.min(500, Math.max(1, args.maxResults ?? 100));
        const hasRg = await ripgrepAvailable();

        let rawResults = [];

        if (hasRg) {
            // When extensions filter is active, overfetch 5x to absorb filtering losses.
            // For single-extension searches, pass directly as ripgrep glob for native speed.
            const extGlobs = args.extensions?.length ? args.extensions.map(e => `*${e}`) : null;
            const effectivePattern = (extGlobs?.length === 1 && !args.namePattern)
                ? extGlobs[0]
                : (args.namePattern || null);

            const results = await ripgrepFindFiles(rootPath, {
                namePattern: effectivePattern,
                pathContains: args.pathContains || null,
                maxResults: Math.min(maxResults * 5, 2000), // 5x overfetch absorbs heavy extension filtering
            });
            if (results !== null) {
                rawResults = results;
            }
        }

        // JS fallback if ripgrep unavailable or failed
        if (rawResults.length === 0) {
            const nameRegex = args.namePattern
                ? new RegExp(args.namePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i')
                : null;

            async function walk(dir) {
                if (rawResults.length >= maxResults) return;
                let entries;
                try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    if (rawResults.length >= maxResults) return;
                    const fullPath = path.join(dir, entry.name);
                    if (DEFAULT_EXCLUDES.some(p => entry.name === p)) continue;
                    if (isSensitive(fullPath)) continue;
                    if (entry.isDirectory()) {
                        try { await validatePath(fullPath); } catch { continue; }
                        await walk(fullPath);
                    } else {
                        const nameMatch = !nameRegex || nameRegex.test(entry.name);
                        const pathMatch = !args.pathContains || fullPath.toLowerCase().includes(args.pathContains.toLowerCase());
                        if (nameMatch && pathMatch) rawResults.push(fullPath);
                    }
                }
            }

            await walk(rootPath);
        }

        // Apply extensions filter
        if (args.extensions?.length) {
            const extSet = new Set(args.extensions.map(e => e.toLowerCase()));
            rawResults = rawResults.filter(f => extSet.has(path.extname(f).toLowerCase()));
        }

        // ---- SYMBOL SEARCH MODE ----
        // When definesSymbol is set, filter to files that actually define the symbol.
        // This replaces the normal output — results include symbol location info.
        if (args.definesSymbol) {
            // Filter to tree-sitter supported files only
            const supportedFiles = rawResults.filter(f => isSupported(f));

            if (supportedFiles.length === 0) {
                const text = 'No supported files found for symbol search.';
                return {
                    content: [{ type: "text", text }],
                };
            }

            // Parse files in parallel (capped at 50 concurrent) to find the symbol
            const BATCH_SIZE = 50;
            const MAX_FILE_SIZE = 512 * 1024; // skip files > 512KB
            const symbolName = args.definesSymbol;
            const symbolMatches = [];

            for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (filePath) => {
                    try {
                        const stat = await fs.stat(filePath);
                        if (stat.size > MAX_FILE_SIZE || stat.size === 0) return null;

                        const langName = getLangForFile(filePath);
                        if (!langName) return null;

                        const source = await fs.readFile(filePath, 'utf-8');
                        const defs = await getDefinitions(source, langName);
                        if (!defs) return null;

                        // Handle dot-qualified names: "MyClass.sendMessage"
                        const parts = symbolName.split('.');
                        const targetName = parts[parts.length - 1];
                        const parentNames = parts.slice(0, -1);

                        let matches = defs.filter(d => d.name === targetName);
                        if (matches.length === 0) return null;

                        // Verify parent containment for qualified names
                        if (parentNames.length > 0) {
                            matches = matches.filter(sym => {
                                let current = sym;
                                for (let pi = parentNames.length - 1; pi >= 0; pi--) {
                                    const parent = defs.find(d =>
                                        d.name === parentNames[pi] &&
                                        d.line <= current.line &&
                                        d.endLine >= current.endLine &&
                                        d !== current
                                    );
                                    if (!parent) return false;
                                    current = parent;
                                }
                                return true;
                            });
                            if (matches.length === 0) return null;
                        }

                        return { filePath, matches };
                    } catch {
                        return null;
                    }
                }));

                for (const result of results) {
                    if (result) symbolMatches.push(result);
                }

                // Stop early if we have enough
                if (symbolMatches.length >= maxResults) break;
            }

            // Format output
            if (symbolMatches.length === 0) {
                const text = 'No matches.';
                return {
                    content: [{ type: "text", text }],
                };
            }

            const outputLines = [];
            for (const { filePath, matches } of symbolMatches.slice(0, maxResults)) {
                for (const sym of matches) {
                    outputLines.push(`${filePath}:${sym.line}  [${sym.type}] ${sym.name} (lines ${sym.line}-${sym.endLine})`);
                }
            }

            const text = outputLines.join('\n');
            return {
                content: [{ type: "text", text }],
            };
        }

        // BM25 relevance ranking by file path
        if (args.relevanceQuery && args.relevanceQuery.length > 2 && rawResults.length > 1) {
            const index = new BM25Index();
            const docs = rawResults.map((filePath, i) => ({
                id: String(i),
                // Tokenize path components for BM25 scoring
                text: filePath.replace(/[/\\]/g, ' ').replace(/\./g, ' ').replace(/-/g, ' ').replace(/_/g, ' _ '),
            }));
            index.build(docs);
            const ranked = index.search(args.relevanceQuery, maxResults);
            rawResults = ranked.map(r => rawResults[Number(r.id)]);
        }

        // Trim to maxResults
        rawResults = rawResults.slice(0, maxResults);

        // Sort by path for determinism
        if (!args.relevanceQuery) {
            rawResults.sort();
        }

        // Build output with optional metadata
        let outputLines = [];
        if (args.includeMetadata && rawResults.length > 0) {
            const metaPromises = rawResults.map(async (filePath) => {
                try {
                    const stat = await fs.stat(filePath);
                    const sizeKB = (stat.size / 1024).toFixed(1);
                    const modified = stat.mtime.toISOString().slice(0, 10);
                    return `${filePath}  (${sizeKB}KB, ${modified})`;
                } catch {
                    return filePath;
                }
            });
            outputLines = await Promise.all(metaPromises);
        } else {
            outputLines = rawResults;
        }

        // Enforce character budget
        const budgetLines = [];
        let charCount = 0;
        for (const line of outputLines) {
            if (charCount + line.length + 1 > CHAR_BUDGET) break;
            budgetLines.push(line);
            charCount += line.length + 1;
        }

        const text = budgetLines.length > 0
            ? budgetLines.join('\n')
            : 'No files found.';
        return {
            content: [{ type: "text", text }],
        };
    });
}
