import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { minimatch } from "minimatch";
import { DEFAULT_EXCLUDES, isSensitive, ripgrepAvailable, ripgrepSearch, ripgrepFindFiles, bm25RankResults, bm25PreFilterFiles, CHAR_BUDGET, RANK_THRESHOLD } from '../core/shared.js';
import { RipgrepResult } from '../core/shared.js';
import { isSupported, getLangForFile, getDefinitions, getStructuralFingerprint, computeStructuralSimilarity, } from '../core/tree-sitter.js';
import type { SymbolFilterOptions } from '../core/tree-sitter.js';
import { findRepoRoot, getDb, indexDirectory } from '../core/symbol-index.js';
import { ToolServer, ToolContext } from './types.js';
import { loadConfig } from '../config/index.js';
// Smaller budget for content-search results (match snippets, not full files).
// Configurable via config. Symbol/list modes still use full CHAR_BUDGET.
const _config = loadConfig();
const SEARCH_CHAR_BUDGET = Math.min(_config.advanced.search_char_budget, CHAR_BUDGET);
const DEFAULT_EXCLUDE_GLOBS = DEFAULT_EXCLUDES.map(p => `**/${p}/**`);

interface SymbolDbRow {
    file_path: string;
    line: number;
    end_line: number;
    kind: string;
    type: string | null;
    name: string;
}

interface SearchFilesArgs {
    mode: "content" | "files" | "symbol" | "structural" | "definition";
    path: string;
    maxResults?: number;
    contentQuery?: string;
    pattern?: string;
    contextLines?: number;
    literalSearch?: boolean;
    countOnly?: boolean;
    includeHidden?: boolean;
    pathContains?: string;
    extensions?: string[];
    namePattern?: string;
    includeMetadata?: boolean;
    symbolQuery?: string;
    symbolKind?: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'module' | 'any';
    structuralQuery?: string;
    definesSymbol?: string;
}

export function register(server: ToolServer, ctx: ToolContext) {
    server.registerTool<SearchFilesArgs>("search_files", {
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
    }, async (args: SearchFilesArgs) => {
        const rootPath = await ctx.validatePath(args.path);
        // ---- SYMBOL SEARCH / LIST MODE ----
        if (args.mode === "symbol") {
            const listAll = !args.symbolQuery;
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 50));
            // Discover files — reuse ripgrep for speed
            const hasRg = await ripgrepAvailable();
            let filePaths: string[] = [];
            if (hasRg) {
                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: args.pattern || null,
                    maxResults: 2000,
                    excludePatterns: DEFAULT_EXCLUDE_GLOBS,
                });
                if (results)
                    filePaths = results;
            }
            // JS fallback
            if (filePaths.length === 0) {
                async function walk(dir: string) {
                    if (filePaths.length >= 2000)
                        return;
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    }
                    catch {
                        return;
                    } 
                    for (const entry of entries) {
                        if (filePaths.length >= 2000)
                            return;
                        const fullPath = path.join(dir, entry.name); 
                        if (DEFAULT_EXCLUDES.some(p => entry.name === p))
                            continue;
                        if (isSensitive(fullPath))
                            continue;
                        if (entry.isDirectory()) {
                            await walk(fullPath);
                        }
                        else {
                            filePaths.push(fullPath);
                        }
                    }
                }
                await walk(rootPath);
            }
            // Filter to supported files
            const supportedFiles = filePaths.filter(f => isSupported(f));
            if (supportedFiles.length === 0) {
                return { content: [{ type: "text" as const, text: 'No supported files found.' }] };
            }
            const MAX_FILE_SIZE = 512 * 1024;
            const BATCH_SIZE = 50;
            const typeFilter = args.symbolKind && args.symbolKind !== 'any' ? args.symbolKind : undefined;
            if (listAll) {
                const outputLines: string[] = [];
                for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                    const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(async (filePath) => {
                        try {
                            const stat = await fs.stat(filePath); 
                            if (stat.size > MAX_FILE_SIZE || stat.size === 0)
                                return null;
                            const langName = getLangForFile(filePath);
                            if (!langName)
                                return null;
                            const source = await fs.readFile(filePath, 'utf-8');
                            const symOpts: SymbolFilterOptions = {};
                            if (typeFilter !== undefined) symOpts.typeFilter = typeFilter;
                            const defs = await getDefinitions(source, langName, symOpts);
                            if (!defs || defs.length === 0)
                                return null;
                            const rel = path.relative(rootPath, filePath);
                            const names = defs.map(d => `${d.name} (${d.type}:${d.line})`);
                            return { rel, defs, names };
                        }
                        catch {
                            return null;
                        }
                    }));
                    for (const result of results) {
                        if (!result)
                            continue;
                        outputLines.push(`${result.rel}: ${result.names.join(', ')}`);
                    }
                }
                const budgetLines: string[] = [];
                let charCount = 0;
                for (const line of outputLines) {
                    if (charCount + line.length + 1 > CHAR_BUDGET)
                        break;
                    budgetLines.push(line);
                    charCount += line.length + 1;
                }
                return { content: [{ type: "text" as const, text: budgetLines.join('\n') }] };
            }
            else {
                // ---- SYMBOL QUERY MODE ----
                const symbolQuery = args.symbolQuery;
                const outputLines: string[] = [];
                for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                    const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(async (filePath) => {
                        try {
                            const stat = await fs.stat(filePath); 
                            if (stat.size > MAX_FILE_SIZE || stat.size === 0)
                                return null;
                            const langName = getLangForFile(filePath);
                            if (!langName)
                                return null;
                            const source = await fs.readFile(filePath, 'utf-8');
                            const symOpts: SymbolFilterOptions = {};
                            if (symbolQuery !== undefined) symOpts.nameFilter = symbolQuery;
                            if (typeFilter !== undefined) symOpts.typeFilter = typeFilter;
                            const defs = await getDefinitions(source, langName, symOpts);
                            if (!defs || defs.length === 0)
                                return null;
                            const rel = path.relative(rootPath, filePath);
                            return defs.map(d => ({
                                line: `${rel}:${d.line}  [${d.type}] ${d.name} (lines ${d.line}-${d.endLine})`,
                                file: rel,
                            }));
                        }
                        catch {
                            return null;
                        }
                    }));
                    for (const result of results) {
                        if (!result)
                            continue;
                        for (const entry of result) {
                            outputLines.push(entry.line);
                        }
                        if (outputLines.length >= userMaxResults)
                            break;
                    }
                    if (outputLines.length >= userMaxResults)
                        break;
                }
                const budgetLines: string[] = [];
                let charCount = 0;
                for (const line of outputLines.slice(0, userMaxResults)) {
                    if (charCount + line.length + 1 > CHAR_BUDGET)
                        break;
                    budgetLines.push(line);
                    charCount += line.length + 1;
                }
                const text = budgetLines.length > 0 ? budgetLines.join('\n') : 'No matches.';
                return { content: [{ type: "text" as const, text }] };
            }
        }
        // ---- STRUCTURAL SIMILARITY MODE ----
        if (args.mode === "structural") {
            const repoRoot = findRepoRoot(rootPath);
            if (!repoRoot) {
                return { content: [{ type: 'text' as const, text: 'Not in a git repository.' }] };
            }
            const db = getDb(repoRoot);
            await indexDirectory(db, repoRoot, rootPath, { maxFiles: 2000 });
            const scopePrefix = path.relative(repoRoot, rootPath);
            const qBaseQuery = scopePrefix
                ? 'SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ? AND file_path LIKE ?'
                : 'SELECT file_path, line, end_line, kind, type FROM symbols WHERE name = ? AND kind = ?';
            const qBaseParams: unknown[] = scopePrefix
                ? [args.structuralQuery, 'def', `${scopePrefix}%`]
                : [args.structuralQuery, 'def'];
            const qRows = db.prepare<unknown[], SymbolDbRow>(qBaseQuery).all(...qBaseParams);
            if (qRows.length === 0) {
                return { content: [{ type: 'text' as const, text: `Symbol "${args.structuralQuery}" not found in index.` }] };
            }
            if (qRows.length > 1) {
                const candidates = qRows.map((r: SymbolDbRow, i: number) => `${String.fromCharCode(97 + i)}) ${r.file_path}:${r.line}`);
                return { content: [{ type: 'text' as const, text: `Multiple definitions for "${args.structuralQuery}":\n${candidates.join('\n')}\nNarrow with path.` }] };
            }
            const qRow = qRows[0];
            if (qRow === undefined) {
                return { content: [{ type: 'text' as const, text: `Symbol "${args.structuralQuery}" not found in index.` }] };
            }
            const qAbsPath = path.resolve(repoRoot, qRow.file_path);
            const qLang = getLangForFile(qAbsPath);
            if (!qLang) {
                return { content: [{ type: 'text' as const, text: 'Unsupported language.' }] };
            }
            let qSource;
            try {
                qSource = await fs.readFile(qAbsPath, 'utf-8');
            }
            catch { 
                return { content: [{ type: 'text' as const, text: 'Could not read source file.' }] };
            }
            const queryFp = await getStructuralFingerprint(qSource, qLang, qRow.line, qRow.end_line);
            if (!queryFp || queryFp.length === 0) {
                return { content: [{ type: 'text' as const, text: 'Could not compute fingerprint.' }] };
            }
            const candType = (args.symbolKind && args.symbolKind !== 'any') ? args.symbolKind : (qRow.type || null);
            let candQuery: string;
            let candParams: unknown[];
            if (scopePrefix && candType) {
                candQuery = `SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def' AND type = ? AND file_path LIKE ? ORDER BY name`;
                candParams = [candType, `${scopePrefix}%`];
            }
            else if (scopePrefix) {
                candQuery = `SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def' AND file_path LIKE ? ORDER BY name`;
                candParams = [`${scopePrefix}%`];
            }
            else if (candType) {
                candQuery = `SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def' AND type = ? ORDER BY name`;
                candParams = [candType];
            }
            else {
                candQuery = `SELECT name, file_path, line, end_line FROM symbols WHERE kind = 'def' ORDER BY name`;
                candParams = [];
            }
            const candidates = db.prepare<unknown[], SymbolDbRow>(candQuery).all(...candParams);
            const userMax = Math.min(50, args.maxResults ?? 20);
            const matches: Array<{ name: string; filePath: string; line: number; score: number }> = [];
            const fileCache = new Map<string, string | null>();
            let charCount = 0;
            for (const cand of candidates) {
                if (cand.name === args.structuralQuery && cand.file_path === qRow.file_path)
                    continue;
                const absPath = path.resolve(repoRoot, cand.file_path); 
                const lang = getLangForFile(absPath);
                if (!lang)
                    continue;
                let src = fileCache.get(absPath);
                if (src === undefined) {
                    try {
                        src = await fs.readFile(absPath, 'utf-8');
                    }
                    catch {
                        src = null;
                    } 
                    fileCache.set(absPath, src);
                }
                if (!src)
                    continue;
                const fp = await getStructuralFingerprint(src, lang, cand.line, cand.end_line);
                if (!fp || fp.length === 0)
                    continue;
                const score = computeStructuralSimilarity(queryFp, fp);
                if (score >= 0.5) {
                    matches.push({ name: cand.name, filePath: cand.file_path, line: cand.line, score });
                }
            }
            matches.sort((a, b) => b.score - a.score);
            const top = matches.slice(0, userMax);
            if (top.length === 0) {
                return { content: [{ type: 'text' as const, text: 'No structurally similar symbols found.' }] };
            }
            const outLines: string[] = [];
            charCount = 0;
            for (const r of top) {
                const line = `${r.filePath}:${r.line}  [${(r.score * 100).toFixed(0)}%] ${r.name}`;
                if (charCount + line.length + 1 > CHAR_BUDGET)
                    break;
                outLines.push(line);
                charCount += line.length + 1;
            }
            return { content: [{ type: 'text' as const, text: outLines.join('\n') }] };
        }
        // ---- DEFINITION MODE (find files defining a symbol) ----
        if (args.mode === "definition") {
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 100));
            const hasRg = await ripgrepAvailable();
            let rawResults: string[] = [];
            if (hasRg) {
                const extGlobs = args.extensions?.length ? args.extensions.map((e: string) => `*${e}`) : null;
                const singleExtGlob = (extGlobs?.length === 1 && !args.namePattern) ? extGlobs[0] : undefined;
                const effectivePattern: string | null = singleExtGlob !== undefined
                    ? singleExtGlob
                    : (args.namePattern || null);
                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: effectivePattern,
                    pathContains: args.pathContains || null,
                    maxResults: Math.min(userMaxResults * 5, 2000),
                    excludePatterns: DEFAULT_EXCLUDE_GLOBS,
                });
                if (results !== null)
                    rawResults = results;
            }
            if (rawResults.length === 0) {
                const nameRegex = args.namePattern
                    ? new RegExp(args.namePattern.replace(/\\/g, '\\\\').replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i')
                    : null;
                async function walk(dir: string) {
                    if (rawResults.length >= userMaxResults * 5)
                        return;
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    }
                    catch {
                        return;
                    } 
                    for (const entry of entries) {
                        if (rawResults.length >= userMaxResults * 5)
                            return;
                        const fullPath = path.join(dir, entry.name); 
                        if (DEFAULT_EXCLUDES.some(p => entry.name === p))
                            continue;
                        if (isSensitive(fullPath))
                            continue;
                        if (entry.isDirectory()) {
                            try {
                                await ctx.validatePath(fullPath);
                            }
                            catch {
                                continue;
                            }
                            await walk(fullPath);
                        }
                        else {
                            const nameMatch = !nameRegex || nameRegex.test(entry.name);
                            const pathMatch = !args.pathContains || fullPath.toLowerCase().includes(args.pathContains.toLowerCase());
                            if (nameMatch && pathMatch)
                                rawResults.push(fullPath);
                        }
                    }
                }
                await walk(rootPath);
            }
            if (args.extensions?.length) {
                const extSet = new Set(args.extensions.map((e: string) => e.toLowerCase()));
                rawResults = rawResults.filter(f => extSet.has(path.extname(f).toLowerCase()));
            }
            const supportedFiles = rawResults.filter(f => isSupported(f));
            if (supportedFiles.length === 0) {
                return { content: [{ type: "text" as const, text: 'No supported files found for symbol search.' }] };
            }
            const BATCH_SIZE = 50;
            const MAX_FILE_SIZE = 512 * 1024;
            const symbolName = args.definesSymbol!;
            interface DefinitionSymbol {
                name: string;
                type: string;
                line: number;
                endLine: number;
            }
            const symbolMatches: Array<{ filePath: string; matches: DefinitionSymbol[] }> = [];
            for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (filePath) => {
                    try {
                        const stat = await fs.stat(filePath); 
                        if (stat.size > MAX_FILE_SIZE || stat.size === 0)
                            return null;
                        const langName = getLangForFile(filePath);
                        if (!langName)
                            return null;
                        const source = await fs.readFile(filePath, 'utf-8'); 
                        const defs = await getDefinitions(source, langName);
                        if (!defs)
                            return null;
                        const parts = symbolName.split('.');
                        const targetName = parts[parts.length - 1];
                        const parentNames = parts.slice(0, -1);
                        let matches = defs.filter(d => d.name === targetName);
                        if (matches.length === 0)
                            return null;
                        if (parentNames.length > 0) {
                            matches = matches.filter(sym => {
                                let current = sym;
                                for (let pi = parentNames.length - 1; pi >= 0; pi--) {
                                    const parent = defs.find(d => d.name === parentNames[pi] &&
                                        d.line <= current.line &&
                                        d.endLine >= current.endLine &&
                                        d !== current);
                                    if (!parent)
                                        return false;
                                    current = parent;
                                }
                                return true;
                            });
                            if (matches.length === 0)
                                return null;
                        }
                        return { filePath, matches };
                    }
                    catch {
                        return null;
                    }
                }));
                for (const result of results) {
                    if (result)
                        symbolMatches.push(result);
                }
                if (symbolMatches.length >= userMaxResults)
                    break;
            }
            if (symbolMatches.length === 0) {
                return { content: [{ type: "text" as const, text: 'No matches.' }] };
            }
            const outputLines: string[] = [];
            for (const { filePath, matches } of symbolMatches.slice(0, userMaxResults)) {
                for (const sym of matches) {
                    outputLines.push(`${filePath}:${sym.line}  [${sym.type}] ${sym.name} (lines ${sym.line}-${sym.endLine})`);
                }
            }
            return { content: [{ type: "text" as const, text: outputLines.join('\n') }] };
        }
        // ---- FILES MODE ----
        if (args.mode === "files") {
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 100));
            const hasRg = await ripgrepAvailable();
            let rawResults: string[] = [];
            if (hasRg) {
                const extGlobs = args.extensions?.length ? args.extensions.map((e: string) => `*${e}`) : null;
                const singleExtGlob = (extGlobs?.length === 1 && !args.namePattern) ? extGlobs[0] : undefined;
                const fallbackPattern: string | null = singleExtGlob !== undefined
                    ? singleExtGlob
                    : (args.namePattern || null);
                const effectivePattern: string | null = args.pattern || fallbackPattern;
                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: effectivePattern,
                    pathContains: args.pathContains || null,
                    maxResults: Math.min(userMaxResults * 2, 2000),
                    excludePatterns: DEFAULT_EXCLUDE_GLOBS,
                });
                if (results !== null)
                    rawResults = results;
            }
            if (rawResults.length === 0) {
                const nameRegex = args.namePattern
                    ? new RegExp(args.namePattern.replace(/\\/g, '\\\\').replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i')
                    : null;
                async function walk(dir: string) {
                    if (rawResults.length >= userMaxResults)
                        return;
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    }
                    catch {
                        return;
                    } 
                    for (const entry of entries) {
                        if (rawResults.length >= userMaxResults)
                            return;
                        const fullPath = path.join(dir, entry.name); 
                        const rel = path.relative(rootPath, fullPath);
                        if (DEFAULT_EXCLUDES.some(p => entry.name === p))
                            continue;
                        if (isSensitive(fullPath))
                            continue;
                        if (entry.isDirectory()) {
                            try {
                                await ctx.validatePath(fullPath);
                            }
                            catch {
                                continue;
                            }
                            await walk(fullPath);
                        }
                        else if (entry.isFile()) {
                            const nameMatch = !nameRegex || nameRegex.test(entry.name);
                            const patternMatch = !args.pattern || minimatch(rel, args.pattern, { dot: true });
                            const pathMatch = !args.pathContains || fullPath.toLowerCase().includes(args.pathContains.toLowerCase());
                            if (nameMatch && patternMatch && pathMatch)
                                rawResults.push(fullPath);
                        }
                    }
                }
                await walk(rootPath);
            }
            if (args.extensions?.length) {
                const extSet = new Set(args.extensions.map((e: string) => e.toLowerCase()));
                rawResults = rawResults.filter(f => extSet.has(path.extname(f).toLowerCase()));
            }
            rawResults = rawResults.slice(0, userMaxResults);
            rawResults.sort();
            let outputLines: string[];
            if (args.includeMetadata && rawResults.length > 0) {
                outputLines = await Promise.all(rawResults.map(async (filePath) => {
                    try {
                        const stat = await fs.stat(filePath); 
                        const sizeKB = (stat.size / 1024).toFixed(1);
                        const modified = stat.mtime.toISOString().slice(0, 10);
                        return `${filePath}  (${sizeKB}KB, ${modified})`;
                    }
                    catch {
                        return filePath;
                    }
                }));
            }
            else {
                outputLines = rawResults;
            }
            const budgetLines: string[] = [];
            let charCount = 0;
            for (const line of outputLines) {
                if (charCount + line.length + 1 > CHAR_BUDGET)
                    break;
                budgetLines.push(line);
                charCount += line.length + 1;
            }
            const text = budgetLines.length > 0 ? budgetLines.join('\n') : 'No files found.';
            return { content: [{ type: "text" as const, text }] };
        }
        // ---- CONTENT SEARCH MODE ----
        if (!args.contentQuery) {
            throw new Error('contentQuery required for content mode.');
        }
        const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 50));
        const contextLines = Math.max(0, args.contextLines ?? 0);
        const allExcludes = DEFAULT_EXCLUDE_GLOBS;
        const flags = 'gi';
        const contentRegex = args.literalSearch
            ? new RegExp(args.contentQuery!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) 
            : new RegExp(args.contentQuery!, flags); 
        // ---- RIPGREP PATH ----
        const hasRg = await ripgrepAvailable();
        if (hasRg) {
            let rgResults: RipgrepResult[] | null = null;
            if (args.contentQuery!.length > 2) {
                try {
                    const candidateFiles = await bm25PreFilterFiles(rootPath, args.contentQuery!, 100, allExcludes);
                    if (candidateFiles.length > 0) {
                        rgResults = await ripgrepSearch(rootPath, {
                            contentQuery: args.contentQuery!,
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
                }
                catch {
                }
            }
            if (rgResults === null) {
                rgResults = await ripgrepSearch(rootPath, {
                    contentQuery: args.contentQuery!,
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
                    return { content: [{ type: "text" as const, text: 'No matches.' }] };
                }
                if (args.countOnly) {
                    const fileSet = new Set(rgResults.map(r => r.file));
                    return { content: [{ type: "text" as const, text: `matches: ${rgResults.length}\nfiles: ${fileSet.size}` }] };
                }
                const rawLines = rgResults.map(r => `${r.file}:${r.line}: ${r.content}`);
                let outputLines: string[];
                if (rawLines.length > RANK_THRESHOLD) {
                    const { ranked } = bm25RankResults(rawLines, args.contentQuery!, SEARCH_CHAR_BUDGET);
                    outputLines = ranked;
                }
                else {
                    outputLines = [];
                    let charCount = 0;
                    for (const line of rawLines) {
                        if (charCount + line.length + 1 > SEARCH_CHAR_BUDGET)
                            break;
                        outputLines.push(line);
                        charCount += line.length + 1;
                    }
                }
                return { content: [{ type: "text" as const, text: outputLines.join('\n') }] };
            }
        }
        // ------------------------------------------------------------------
        // JS fallback (content mode)
        // ------------------------------------------------------------------
        const contentResults: string[] = [];
        const maxJsFallback = Math.min(200, userMaxResults);
        async function grepFile(filePath: string) {
            if (contentResults.length >= maxJsFallback)
                return;
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const lines = content.split('\n');
                let lineNumber = 0;
                for (const line of lines) {
                    lineNumber++;
                    if (contentResults.length >= maxJsFallback)
                        break;
                    if (contentRegex.test(line)) {
                        contentResults.push(`${filePath}:${lineNumber}: ${line.trim().slice(0, 500)}`);
                    }
                }
            }
            catch { /* skip binary/unreadable */ }
        }
        async function walk(dir: string) {
            if (contentResults.length >= maxJsFallback)
                return;
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            } 
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name); 
                const rel = path.relative(rootPath, fullPath);
                const excluded = allExcludes.some(pat => minimatch(rel, pat, { dot: true }) ||
                    minimatch(rel, pat.replace(/^\*\*\//, ''), { dot: true }));
                if (excluded)
                    continue;
                if (isSensitive(fullPath))
                    continue;
                if (entry.isDirectory()) {
                    await walk(fullPath);
                }
                else if (entry.isFile()) {
                    if (!args.pattern || minimatch(rel, args.pattern, { dot: true }))
                        await grepFile(fullPath);
                }
            }
        }
        await walk(rootPath);
        if (args.countOnly) {
            const fileSet = new Set(contentResults.map(r => r.split(':')[0]));
            return { content: [{ type: "text" as const, text: `matches: ${contentResults.length}\nfiles: ${fileSet.size}` }] };
        }
        let finalOutput: string[];
        if (contentResults.length > RANK_THRESHOLD) {
            const { ranked } = bm25RankResults(contentResults, args.contentQuery!, SEARCH_CHAR_BUDGET);
            finalOutput = ranked;
        }
        else {
            finalOutput = [];
            let charCount = 0;
            for (const line of contentResults) {
                if (charCount + line.length + 1 > SEARCH_CHAR_BUDGET)
                    break;
                finalOutput.push(line);
                charCount += line.length + 1;
            }
        }
        const text = finalOutput.length > 0 ? finalOutput.join('\n') : 'No matches.';
        return { content: [{ type: "text" as const, text }] };
    });
}
