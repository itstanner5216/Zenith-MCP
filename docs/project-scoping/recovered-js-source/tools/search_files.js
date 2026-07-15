import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { minimatch } from "minimatch";
import {
    DEFAULT_EXCLUDES, isSensitive,
    ripgrepAvailable, ripgrepSearch, ripgrepFindFiles,
    bm25RankResults, bm25PreFilterFiles,
    CHAR_BUDGET, RANK_THRESHOLD,
} from '../core/shared.js';
import {
    isSupported, getLangForFile, getDefinitions,
    getStructuralFingerprint, computeStructuralSimilarity,
} from '../core/tree-sitter.js';
import { findRepoRoot, getDb, indexDirectory } from '../core/symbol-index.js';

// Smaller budget for content-search results (match snippets, not full files).
// Configurable via env var. Symbol/list modes still use full CHAR_BUDGET.
const SEARCH_CHAR_BUDGET = (() => {
    const v = parseInt(process.env.SEARCH_CHAR_BUDGET || '15000', 10);
    return isNaN(v) ? 15_000 : Math.min(v, CHAR_BUDGET);
})();

const DEFAULT_EXCLUDE_GLOBS = DEFAULT_EXCLUDES.map(p => `**/${p}/**`);

export function register(server, ctx) {
    server.registerTool("search_files", {
        title: "Search Files",
        description: "Search file contents, find files, or search symbols.",
        inputSchema: z.object({
            mode: z.enum(["content", "files", "symbol", "structural", "definition"]).describe("Search mode."),
            path: z.string().describe("Directory to search."),
            maxResults: z.number().optional().describe("Max results."),
            contentQuery: z.string().optional().describe("Text or regex."),
            pattern: z.string().optional().describe("File glob pattern."),
            contextLines: z.number().optional().describe("Context lines around each match."),
            literalSearch: z.boolean().optional().describe("Treat contentQuery as literal string."),
            countOnly: z.boolean().optional().describe("Return counts only."),
            includeHidden: z.boolean().optional().describe("Include hidden files."),
            pathContains: z.string().optional().describe("Substring in full path."),
            extensions: z.array(z.string()).optional().describe("Filter by extensions, e.g. ['.ts']."),
            namePattern: z.string().optional().describe("Glob against filename only."),
            includeMetadata: z.boolean().optional().describe("Include size and modified date."),
            symbolQuery: z.string().optional().describe("Substring to match symbol names."),
            symbolKind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'module', 'any']).optional().describe("Filter by symbol kind."),
            structuralQuery: z.string().optional().describe("Symbol name for structural similarity."),
            definesSymbol: z.string().optional().describe("Symbol to find."),
        }),
        annotations: { readOnlyHint: true }
    }, async (args) => {
        const rootPath = await ctx.validatePath(args.path);

        // ---- SYMBOL SEARCH / LIST MODE ----
        if (args.mode === "symbol") {
            const listAll = !args.symbolQuery;
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 50));

            // Discover files — reuse ripgrep for speed
            const hasRg = await ripgrepAvailable();
            let filePaths = [];

            if (hasRg) {
                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: args.pattern || null,
                    maxResults: 2000,
                    excludePatterns: DEFAULT_EXCLUDE_GLOBS,
                });
                if (results) filePaths = results;
            }

            // JS fallback
            if (filePaths.length === 0) {
                async function walk(dir) {
                    if (filePaths.length >= 2000) return;
                    let entries;
                    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; } // nosemgrep
                    for (const entry of entries) {
                        if (filePaths.length >= 2000) return;
                        const fullPath = path.join(dir, entry.name); // nosemgrep
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
                return { content: [{ type: "text", text: 'No supported files found.' }] };
            }

            const MAX_FILE_SIZE = 512 * 1024;
            const BATCH_SIZE = 50;
            const typeFilter = args.symbolKind && args.symbolKind !== 'any' ? args.symbolKind : null;

            if (listAll) {
                const outputLines = [];

                for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                    const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(async (filePath) => {
                        try {
                            const stat = await fs.stat(filePath); // nosemgrep
                            if (stat.size > MAX_FILE_SIZE || stat.size === 0) return null;

                            const langName = getLangForFile(filePath);
                            if (!langName) return null;

                            const source = await fs.readFile(filePath, 'utf-8'); // nosemgrep
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

                const budgetLines = [];
                let charCount = 0;
                for (const line of outputLines) {
                    if (charCount + line.length + 1 > CHAR_BUDGET) break;
                    budgetLines.push(line);
                    charCount += line.length + 1;
                }

                return { content: [{ type: "text", text: budgetLines.join('\n') }] };

            } else {
                // ---- SYMBOL QUERY MODE ----
                const symbolQuery = args.symbolQuery;
                const outputLines = [];

                for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                    const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(async (filePath) => {
                        try {
                            const stat = await fs.stat(filePath); // nosemgrep
                            if (stat.size > MAX_FILE_SIZE || stat.size === 0) return null;

                            const langName = getLangForFile(filePath);
                            if (!langName) return null;

                            const source = await fs.readFile(filePath, 'utf-8'); // nosemgrep
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
                        if (outputLines.length >= userMaxResults) break;
                    }
                    if (outputLines.length >= userMaxResults) break;
                }

                const budgetLines = [];
                let charCount = 0;
                for (const line of outputLines.slice(0, userMaxResults)) {
                    if (charCount + line.length + 1 > CHAR_BUDGET) break;
                    budgetLines.push(line);
                    charCount += line.length + 1;
                }

                const text = budgetLines.length > 0 ? budgetLines.join('\n') : 'No matches.';
                return { content: [{ type: "text", text }] };
            }
        }

        // ---- STRUCTURAL SIMILARITY MODE ----
        if (args.mode === "structural") {
            const repoRoot = findRepoRoot(rootPath);
            if (!repoRoot) {
                return { content: [{ type: 'text', text: 'Not in a git repository.' }] };
            }

            const db = getDb(repoRoot);
            await indexDirectory(db, repoRoot, rootPath, { maxFiles: 2000 });

            const scopePrefix = path.relative(repoRoot, rootPath);
            const qBaseQuery = scopePrefix
                ? 'SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ? AND file_path LIKE ?'
                : 'SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ?';
            const qBaseParams = scopePrefix
                ? [args.structuralQuery, 'def', `${scopePrefix}%`]
                : [args.structuralQuery, 'def'];
            const qRows = db.prepare(qBaseQuery).all(...qBaseParams);

            if (qRows.length === 0) {
                return { content: [{ type: 'text', text: `Symbol "${args.structuralQuery}" not found in index.` }] };
            }
            if (qRows.length > 1) {
                const candidates = qRows.map((r, i) => `${String.fromCharCode(97 + i)}) ${r.file_path}:${r.line}`);
                return { content: [{ type: 'text', text: `Multiple definitions for "${args.structuralQuery}":\n${candidates.join('\n')}\nNarrow with path.` }] };
            }
            const qRow = qRows[0];

            const qAbsPath = path.resolve(repoRoot, qRow.file_path); // nosemgrep
            const qLang = getLangForFile(qAbsPath);
            if (!qLang) {
                return { content: [{ type: 'text', text: 'Unsupported language.' }] };
            }

            let qSource;
            try { qSource = await fs.readFile(qAbsPath, 'utf-8'); } catch { // nosemgrep
                return { content: [{ type: 'text', text: 'Could not read source file.' }] };
            }

            const queryFp = await getStructuralFingerprint(qSource, qLang, qRow.line, qRow.end_line);
            if (!queryFp || queryFp.length === 0) {
                return { content: [{ type: 'text', text: 'Could not compute fingerprint.' }] };
            }

            const candType = (args.symbolKind && args.symbolKind !== 'any') ? args.symbolKind : (qRow.type || null);
            let candQuery, candParams;
            if (scopePrefix && candType) {
                candQuery = `SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def' AND type = ? AND file_path LIKE ? ORDER BY name`;
                candParams = [candType, `${scopePrefix}%`];
            } else if (scopePrefix) {
                candQuery = `SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def' AND file_path LIKE ? ORDER BY name`;
                candParams = [`${scopePrefix}%`];
            } else if (candType) {
                candQuery = `SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def' AND type = ? ORDER BY name`;
                candParams = [candType];
            } else {
                candQuery = `SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def' ORDER BY name`;
                candParams = [];
            }
            const candidates = db.prepare(candQuery).all(...candParams);

            const userMax = Math.min(50, args.maxResults ?? 20);
            const matches = [];
            const fileCache = new Map();
            let charCount = 0;

            for (const cand of candidates) {
                if (cand.name === args.structuralQuery && cand.file_path === qRow.file_path) continue;
                const absPath = path.resolve(repoRoot, cand.file_path); // nosemgrep

                const lang = getLangForFile(absPath);
                if (!lang) continue;

                let src = fileCache.get(absPath);
                if (src === undefined) {
                    try { src = await fs.readFile(absPath, 'utf-8'); } catch { src = null; } // nosemgrep
                    fileCache.set(absPath, src);
                }
                if (!src) continue;

                const fp = await getStructuralFingerprint(src, lang, cand.line, cand.end_line);
                if (!fp || fp.length === 0) continue;

                const score = computeStructuralSimilarity(queryFp, fp);
                if (score >= 0.5) {
                    matches.push({ name: cand.name, filePath: cand.file_path, line: cand.line, score });
                }
            }

            matches.sort((a, b) => b.score - a.score);
            const top = matches.slice(0, userMax);

            if (top.length === 0) {
                return { content: [{ type: 'text', text: 'No structurally similar symbols found.' }] };
            }

            const outLines = [];
            charCount = 0;
            for (const r of top) {
                const line = `${r.filePath}:${r.line}  [${(r.score * 100).toFixed(0)}%] ${r.name}`;
                if (charCount + line.length + 1 > CHAR_BUDGET) break;
                outLines.push(line);
                charCount += line.length + 1;
            }
            return { content: [{ type: 'text', text: outLines.join('\n') }] };
        }

        // ---- DEFINITION MODE (find files defining a symbol) ----
        if (args.mode === "definition") {
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 100));
            const hasRg = await ripgrepAvailable();

            let rawResults = [];

            if (hasRg) {
                const extGlobs = args.extensions?.length ? args.extensions.map(e => `*${e}`) : null;
                const effectivePattern = (extGlobs?.length === 1 && !args.namePattern)
                    ? extGlobs[0]
                    : (args.namePattern || null);

                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: effectivePattern,
                    pathContains: args.pathContains || null,
                    maxResults: Math.min(userMaxResults * 5, 2000),
                    excludePatterns: DEFAULT_EXCLUDE_GLOBS,
                });
                if (results !== null) rawResults = results;
            }

            if (rawResults.length === 0) {
                const nameRegex = args.namePattern
                    ? new RegExp(args.namePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i')
                    : null;

                async function walk(dir) {
                    if (rawResults.length >= userMaxResults * 5) return;
                    let entries;
                    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; } // nosemgrep
                    for (const entry of entries) {
                        if (rawResults.length >= userMaxResults * 5) return;
                        const fullPath = path.join(dir, entry.name); // nosemgrep
                        if (DEFAULT_EXCLUDES.some(p => entry.name === p)) continue;
                        if (isSensitive(fullPath)) continue;
                        if (entry.isDirectory()) {
                            try { await ctx.validatePath(fullPath); } catch { continue; }
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

            if (args.extensions?.length) {
                const extSet = new Set(args.extensions.map(e => e.toLowerCase()));
                rawResults = rawResults.filter(f => extSet.has(path.extname(f).toLowerCase()));
            }

            const supportedFiles = rawResults.filter(f => isSupported(f));
            if (supportedFiles.length === 0) {
                return { content: [{ type: "text", text: 'No supported files found for symbol search.' }] };
            }

            const BATCH_SIZE = 50;
            const MAX_FILE_SIZE = 512 * 1024;
            const symbolName = args.definesSymbol;
            const symbolMatches = [];

            for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (filePath) => {
                    try {
                        const stat = await fs.stat(filePath); // nosemgrep
                        if (stat.size > MAX_FILE_SIZE || stat.size === 0) return null;

                        const langName = getLangForFile(filePath);
                        if (!langName) return null;

                        const source = await fs.readFile(filePath, 'utf-8'); // nosemgrep
                        const defs = await getDefinitions(source, langName);
                        if (!defs) return null;

                        const parts = symbolName.split('.');
                        const targetName = parts[parts.length - 1];
                        const parentNames = parts.slice(0, -1);

                        let matches = defs.filter(d => d.name === targetName);
                        if (matches.length === 0) return null;

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

                if (symbolMatches.length >= userMaxResults) break;
            }

            if (symbolMatches.length === 0) {
                return { content: [{ type: "text", text: 'No matches.' }] };
            }

            const outputLines = [];
            for (const { filePath, matches } of symbolMatches.slice(0, userMaxResults)) {
                for (const sym of matches) {
                    outputLines.push(`${filePath}:${sym.line}  [${sym.type}] ${sym.name} (lines ${sym.line}-${sym.endLine})`);
                }
            }

            return { content: [{ type: "text", text: outputLines.join('\n') }] };
        }

        // ---- FILES MODE ----
        if (args.mode === "files") {
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 100));
            const hasRg = await ripgrepAvailable();

            let rawResults = [];

            if (hasRg) {
                const extGlobs = args.extensions?.length ? args.extensions.map(e => `*${e}`) : null;
                const effectivePattern = args.pattern
                    || ((extGlobs?.length === 1 && !args.namePattern) ? extGlobs[0] : (args.namePattern || null));

                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: effectivePattern,
                    pathContains: args.pathContains || null,
                    maxResults: Math.min(userMaxResults * 2, 2000),
                    excludePatterns: DEFAULT_EXCLUDE_GLOBS,
                });
                if (results !== null) rawResults = results;
            }

            if (rawResults.length === 0) {
                const nameRegex = args.namePattern
                    ? new RegExp(args.namePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i')
                    : null;

                async function walk(dir) {
                    if (rawResults.length >= userMaxResults) return;
                    let entries;
                    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; } // nosemgrep
                    for (const entry of entries) {
                        if (rawResults.length >= userMaxResults) return;
                        const fullPath = path.join(dir, entry.name); // nosemgrep
                        const rel = path.relative(rootPath, fullPath);
                        if (DEFAULT_EXCLUDES.some(p => entry.name === p)) continue;
                        if (isSensitive(fullPath)) continue;
                        if (entry.isDirectory()) {
                            try { await ctx.validatePath(fullPath); } catch { continue; }
                            await walk(fullPath);
                        } else if (entry.isFile()) {
                            const nameMatch = !nameRegex || nameRegex.test(entry.name);
                            const patternMatch = !args.pattern || minimatch(rel, args.pattern, { dot: true });
                            const pathMatch = !args.pathContains || fullPath.toLowerCase().includes(args.pathContains.toLowerCase());
                            if (nameMatch && patternMatch && pathMatch) rawResults.push(fullPath);
                        }
                    }
                }
                await walk(rootPath);
            }

            if (args.extensions?.length) {
                const extSet = new Set(args.extensions.map(e => e.toLowerCase()));
                rawResults = rawResults.filter(f => extSet.has(path.extname(f).toLowerCase()));
            }

            rawResults = rawResults.slice(0, userMaxResults);
            rawResults.sort();

            let outputLines;
            if (args.includeMetadata && rawResults.length > 0) {
                outputLines = await Promise.all(rawResults.map(async (filePath) => {
                    try {
                        const stat = await fs.stat(filePath); // nosemgrep
                        const sizeKB = (stat.size / 1024).toFixed(1);
                        const modified = stat.mtime.toISOString().slice(0, 10);
                        return `${filePath}  (${sizeKB}KB, ${modified})`;
                    } catch {
                        return filePath;
                    }
                }));
            } else {
                outputLines = rawResults;
            }

            const budgetLines = [];
            let charCount = 0;
            for (const line of outputLines) {
                if (charCount + line.length + 1 > CHAR_BUDGET) break;
                budgetLines.push(line);
                charCount += line.length + 1;
            }

            const text = budgetLines.length > 0 ? budgetLines.join('\n') : 'No files found.';
            return { content: [{ type: "text", text }] };
        }

        // ---- CONTENT SEARCH MODE ----
        const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 50));
        const contextLines = Math.max(0, args.contextLines ?? 0);
        const allExcludes = DEFAULT_EXCLUDE_GLOBS;

        const flags = 'gi';
        const contentRegex = args.literalSearch
            ? new RegExp(args.contentQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) // nosemgrep
            : new RegExp(args.contentQuery, flags); // nosemgrep

        // ---- RIPGREP PATH ----
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
                            ignoreCase: true,
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

            if (rgResults === null) {
                rgResults = await ripgrepSearch(rootPath, {
                    contentQuery: args.contentQuery,
                    filePattern: args.pattern || null,
                    ignoreCase: true,
                    maxResults: Math.max(userMaxResults, 500),
                    excludePatterns: allExcludes,
                    contextLines,
                    literalSearch: args.literalSearch ?? false,
                    includeHidden: args.includeHidden ?? false,
                });
            }

            if (rgResults !== null) {
                if (rgResults.length === 0) {
                    return { content: [{ type: "text", text: 'No matches.' }] };
                }

                if (args.countOnly) {
                    const fileSet = new Set(rgResults.map(r => r.file));
                    return { content: [{ type: "text", text: `matches: ${rgResults.length}\nfiles: ${fileSet.size}` }] };
                }

                const rawLines = rgResults.map(r => `${r.file}:${r.line}: ${r.content}`);

                let outputLines;
                if (rawLines.length > RANK_THRESHOLD) {
                    const { ranked } = bm25RankResults(rawLines, args.contentQuery, SEARCH_CHAR_BUDGET);
                    outputLines = ranked;
                } else {
                    outputLines = [];
                    let charCount = 0;
                    for (const line of rawLines) {
                        if (charCount + line.length + 1 > SEARCH_CHAR_BUDGET) break;
                        outputLines.push(line);
                        charCount += line.length + 1;
                    }
                }

                return { content: [{ type: "text", text: outputLines.join('\n') }] };
            }
        }

        // ------------------------------------------------------------------
        // JS fallback (content mode)
        // ------------------------------------------------------------------
        const contentResults = [];
        const maxJsFallback = Math.min(200, userMaxResults);

        async function grepFile(filePath) {
            if (contentResults.length >= maxJsFallback) return;
            try {
                const content = await fs.readFile(filePath, 'utf-8'); // nosemgrep
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (contentResults.length >= maxJsFallback) break;
                    if (contentRegex.test(lines[i])) { // nosemgrep
                        contentResults.push(`${filePath}:${i + 1}: ${lines[i].trim().slice(0, 500)}`); // nosemgrep
                    }
                }
            } catch { /* skip binary/unreadable */ }
        }

        async function walk(dir) {
            if (contentResults.length >= maxJsFallback) return;
            let entries;
            try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; } // nosemgrep
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name); // nosemgrep
                const rel = path.relative(rootPath, fullPath);
                const excluded = allExcludes.some(pat =>
                    minimatch(rel, pat, { dot: true }) ||
                    minimatch(rel, pat.replace(/^\*\*\//, ''), { dot: true })
                );
                if (excluded) continue;
                if (isSensitive(fullPath)) continue;
                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    if (!args.pattern || minimatch(rel, args.pattern, { dot: true })) await grepFile(fullPath);
                }
            }
        }

        await walk(rootPath);

        if (args.countOnly) {
            const fileSet = new Set(contentResults.map(r => r.split(':')[0]));
            return { content: [{ type: "text", text: `matches: ${contentResults.length}\nfiles: ${fileSet.size}` }] };
        }

        let finalOutput;
        if (contentResults.length > RANK_THRESHOLD) {
            const { ranked } = bm25RankResults(contentResults, args.contentQuery, SEARCH_CHAR_BUDGET);
            finalOutput = ranked;
        } else {
            finalOutput = [];
            let charCount = 0;
            for (const line of contentResults) {
                if (charCount + line.length + 1 > SEARCH_CHAR_BUDGET) break;
                finalOutput.push(line);
                charCount += line.length + 1;
            }
        }

        const text = finalOutput.length > 0 ? finalOutput.join('\n') : 'No matches.';
        return { content: [{ type: "text", text }] };
    });
}
