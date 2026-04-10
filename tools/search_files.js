import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { minimatch } from "minimatch";
import { validatePath } from '../lib.js';
import {
    DEFAULT_EXCLUDES, isSensitive,
    ripgrepAvailable, ripgrepSearch, ripgrepFindFiles,
    bm25RankResults, bm25PreFilterFiles,
    CHAR_BUDGET, RANK_THRESHOLD,
} from '../shared.js';
import {
    isSupported, getLangForFile, getSymbols, getDefinitions,
} from '../tree-sitter.js';

export function register(server) {
    server.registerTool("search_files", {
        title: "Search Files",
        description: "Search file contents, find files by glob, search symbols, or list symbols in a directory.",
        inputSchema: {
            path: z.string(),
            pattern: z.string().optional().describe("Glob pattern to match filenames/paths, e.g. '**/*.ts'"),
            contentQuery: z.string().optional().describe("Text or regex to search"),
            excludePatterns: z.array(z.string()).optional().default([]),
            ignoreCase: z.boolean().optional().default(true),
            maxResults: z.number().optional().default(50),
            contextLines: z.number().optional().default(0).describe("Number of context lines"),
            literalSearch: z.boolean().optional().default(false).describe("Treat contentQuery as literal string."),
            countOnly: z.boolean().optional().default(false).describe("Return match/file counts only, no content."),
            includeHidden: z.boolean().optional().default(false).describe("Include hidden files in search."),
            symbolQuery: z.string().optional().describe(
                "Search for symbols by name. " +
                "Substring match (case-insensitive). Cannot be combined with contentQuery."
            ),
            symbolKind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'module', 'any']).optional().default('any').describe(
                "Filter symbol search to a specific kind. Only used with symbolQuery or listSymbols."
            ),
            listSymbols: z.boolean().optional().default(false).describe(
                "Return an inventory of all symbols."
            ),
        },
        annotations: { readOnlyHint: true }
    }, async (args) => {
        const rootPath = await validatePath(args.path);

        // ---- SYMBOL SEARCH / LIST MODE ----
        if (args.symbolQuery || args.listSymbols) {
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 50));

            // Discover files — reuse ripgrep for speed
            const hasRg = await ripgrepAvailable();
            let filePaths = [];
            const callerExcludes = args.excludePatterns ?? [];
            const defaultExcludeGlobs = DEFAULT_EXCLUDES.map(p => `**/${p}/**`);

            if (hasRg) {
                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: args.pattern || null,
                    maxResults: 2000,
                    excludePatterns: [...callerExcludes, ...defaultExcludeGlobs],
                });
                if (results) filePaths = results;
            }

            // JS fallback
            if (filePaths.length === 0) {
                async function walk(dir) {
                    if (filePaths.length >= 2000) return;
                    let entries;
                    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
                    for (const entry of entries) {
                        if (filePaths.length >= 2000) return;
                        const fullPath = path.join(dir, entry.name);
                        if (DEFAULT_EXCLUDES.some(p => entry.name === p)) continue;
                        if (isSensitive(fullPath)) continue;
                        if (entry.isDirectory()) {
                            await walk(fullPath);
                        } else {
                            filePaths.push(fullPath);
                        }
                    }
                }
                await walk(rootPath);
            }

            // Filter to supported files
            const supportedFiles = filePaths.filter(f => isSupported(f));

            if (supportedFiles.length === 0) {
                const text = 'No supported files found.';
                return {
                    content: [{ type: "text", text }],
                };
            }

            const MAX_FILE_SIZE = 512 * 1024;
            const BATCH_SIZE = 50;
            const typeFilter = args.symbolKind && args.symbolKind !== 'any' ? args.symbolKind : null;

            if (args.listSymbols) {
                // ---- LIST SYMBOLS MODE ----
                const outputLines = [];

                for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                    const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(async (filePath) => {
                        try {
                            const stat = await fs.stat(filePath);
                            if (stat.size > MAX_FILE_SIZE || stat.size === 0) return null;

                            const langName = getLangForFile(filePath);
                            if (!langName) return null;

                            const source = await fs.readFile(filePath, 'utf-8');
                            const defs = await getDefinitions(source, langName, {
                                typeFilter: typeFilter,
                            });
                            if (!defs || defs.length === 0) return null;

                            const rel = path.relative(rootPath, filePath);
                            const names = defs.map(d => `${d.name} (${d.type}:${d.line})`);
                            return { rel, defs, names };
                        } catch {
                            return null;
                        }
                    }));

                    for (const result of results) {
                        if (!result) continue;
                        outputLines.push(`${result.rel}: ${result.names.join(', ')}`);
                    }
                }

                // Enforce char budget
                const budgetLines = [];
                let charCount = 0;
                for (const line of outputLines) {
                    if (charCount + line.length + 1 > CHAR_BUDGET) break;
                    budgetLines.push(line);
                    charCount += line.length + 1;
                }

                const text = budgetLines.join('\n');
                return {
                    content: [{ type: "text", text }],
                };

            } else {
                // ---- SYMBOL QUERY MODE ----
                const symbolQuery = args.symbolQuery;
                const outputLines = [];

                for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                    const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(async (filePath) => {
                        try {
                            const stat = await fs.stat(filePath);
                            if (stat.size > MAX_FILE_SIZE || stat.size === 0) return null;

                            const langName = getLangForFile(filePath);
                            if (!langName) return null;

                            const source = await fs.readFile(filePath, 'utf-8');
                            const defs = await getDefinitions(source, langName, {
                                nameFilter: symbolQuery,
                                typeFilter: typeFilter,
                            });
                            if (!defs || defs.length === 0) return null;

                            const rel = path.relative(rootPath, filePath);
                            return defs.map(d => ({
                                line: `${rel}:${d.line}  [${d.type}] ${d.name} (lines ${d.line}-${d.endLine})`,
                                file: rel,
                            }));
                        } catch {
                            return null;
                        }
                    }));

                    for (const result of results) {
                        if (!result) continue;
                        for (const entry of result) {
                            outputLines.push(entry.line);
                        }
                    }

                    if (outputLines.length >= userMaxResults) break;
                }

                // Enforce char budget
                const budgetLines = [];
                let charCount = 0;
                for (const line of outputLines.slice(0, userMaxResults)) {
                    if (charCount + line.length + 1 > CHAR_BUDGET) break;
                    budgetLines.push(line);
                    charCount += line.length + 1;
                }

                const text = budgetLines.length > 0
                    ? budgetLines.join('\n')
                    : 'No matches.';

                return {
                    content: [{ type: "text", text }],
                };
            }
        }

        // ---- EXISTING CONTENT/PATTERN SEARCH ----
        const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 50));
        const contextLines = Math.max(0, Math.min(args.contextLines ?? 0, 10));
        const contentRegex = args.contentQuery
            ? new RegExp(args.contentQuery, args.ignoreCase ? 'i' : '')
            : null;
        const mode = args.contentQuery ? 'search' : 'files';

        const callerExcludes = args.excludePatterns ?? [];
        const defaultExcludeGlobs = DEFAULT_EXCLUDES.map(p => `**/${p}/**`);
        const allExcludes = [...callerExcludes, ...defaultExcludeGlobs];

        // Ripgrep path with BM25 pre-filtering
        if (args.contentQuery) {
            const hasRg = await ripgrepAvailable();
            if (hasRg) {
                let rgResults = null;

                if (args.contentQuery.length > 2) {
                    try {
                        const candidateFiles = await bm25PreFilterFiles(
                            rootPath,
                            args.contentQuery,
                            100,
                            allExcludes
                        );

                        if (candidateFiles.length > 0) {
                            rgResults = await ripgrepSearch(rootPath, {
                                contentQuery: args.contentQuery,
                                filePattern: args.pattern || null,
                                ignoreCase: args.ignoreCase ?? true,
                                maxResults: Math.max(userMaxResults, 500),
                                excludePatterns: allExcludes,
                                contextLines,
                                literalSearch: args.literalSearch ?? false,
                                includeHidden: args.includeHidden ?? false,
                                fileList: candidateFiles,
                            });
                        }
                    } catch {
                    }
                }

                // Fallback if BM25 didn't run or failed
                if (rgResults === null) {
                    rgResults = await ripgrepSearch(rootPath, {
                        contentQuery: args.contentQuery,
                        filePattern: args.pattern || null,
                        ignoreCase: args.ignoreCase ?? true,
                        maxResults: Math.max(userMaxResults, 500),
                        excludePatterns: allExcludes,
                        contextLines,
                        literalSearch: args.literalSearch ?? false,
                        includeHidden: args.includeHidden ?? false,
                    });
                }

                if (rgResults !== null) {
                    if (rgResults.length === 0) {
                        const text = 'No matches.';
                        return {
                            content: [{ type: "text", text }],
                        };
                    }

                    // ---- COUNT-ONLY MODE ----
                    if (args.countOnly) {
                        const fileSet = new Set(rgResults.map(r => r.file));
                        const text = `matches: ${rgResults.length}\nfiles: ${fileSet.size}`;
                        return {
                            content: [{ type: "text", text }],
                        };
                    }

                    // Format results as lines
                    const rawLines = rgResults.map(r => `${r.file}:${r.line}: ${r.content}`);

                    // ---- POST-FILTER MODE ----
                    // If results exceed threshold, BM25 rank them and fit within char budget
                    let outputLines;

                    if (rawLines.length > RANK_THRESHOLD) {
                        const { ranked } = bm25RankResults(
                            rawLines, args.contentQuery, CHAR_BUDGET
                        );
                        outputLines = ranked;
                    } else {
                        // Under threshold: truncate to char budget without ranking
                        outputLines = [];
                        let charCount = 0;
                        for (const line of rawLines) {
                            if (charCount + line.length + 1 > CHAR_BUDGET) break;
                            outputLines.push(line);
                            charCount += line.length + 1;
                        }
                    }

                    const text = outputLines.join('\n');
                    return {
                        content: [{ type: "text", text }],
                    };
                }

            }
        }

        // ------------------------------------------------------------------
        // JS fallback
        // ------------------------------------------------------------------
        const fileResults = [];
        const contentResults = [];
        const maxJsFallback = Math.min(200, userMaxResults);

        async function grepFile(filePath) {
            if (contentResults.length >= maxJsFallback) return;
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (contentResults.length >= maxJsFallback) break;
                    if (contentRegex.test(lines[i])) {
                        contentResults.push(`${filePath}:${i + 1}: ${lines[i].trim().slice(0, 500)}`);
                    }
                }
            } catch { /* skip binary/unreadable */ }
        }

        async function walk(dir) {
            if (fileResults.length >= maxJsFallback && contentResults.length >= maxJsFallback) return;
            let entries;
            try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const rel = path.relative(rootPath, fullPath);
                const excluded = allExcludes.some(pat =>
                    minimatch(rel, pat, { dot: true }) ||
                    minimatch(rel, pat.replace(/^\*\*\//, ''), { dot: true })
                );
                if (excluded) continue;
                if (isSensitive(fullPath)) continue;
                if (entry.isDirectory()) {
                    try { await validatePath(fullPath); } catch { continue; }
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    if (mode === 'files') {
                        if (minimatch(rel, args.pattern, { dot: true })) {
                            fileResults.push(fullPath);
                            if (fileResults.length >= maxJsFallback) return;
                        }
                    } else {
                        if (!args.pattern || minimatch(rel, args.pattern, { dot: true })) await grepFile(fullPath);
                    }
                }
            }
        }

        await walk(rootPath);

        const results = mode === 'files' ? fileResults : contentResults;

        // ---- COUNT-ONLY MODE (JS fallback) ----
        if (args.countOnly) {
            const fileSet = new Set(contentResults.map(r => r.split(':')[0]));
            const text = mode === 'files'
                ? `files: ${results.length}`
                : `matches: ${results.length}\nfiles: ${fileSet.size}`;
            return {
                content: [{ type: "text", text }],
            };
        }

        // Apply BM25 post-filter on JS fallback too if over threshold
        let finalOutput;
        if (mode !== 'files' && results.length > RANK_THRESHOLD && args.contentQuery) {
            const { ranked } = bm25RankResults(results, args.contentQuery, CHAR_BUDGET);
            finalOutput = ranked;
        } else {
            // Truncate to char budget
            finalOutput = [];
            let charCount = 0;
            for (const line of results) {
                if (charCount + line.length + 1 > CHAR_BUDGET) break;
                finalOutput.push(line);
                charCount += line.length + 1;
            }
        }

        const text = finalOutput.length > 0
            ? finalOutput.join('\n')
            : 'No matches.';
        return {
            content: [{ type: "text", text }],
        };
    });
}
