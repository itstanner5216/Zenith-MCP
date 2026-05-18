import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { getCharBudget, ripgrepAvailable, ripgrepSearch, lastRipgrepError } from '../core/shared.js';
import { getLangForFile, findSymbol } from '../core/tree-sitter.js';
import type { ToolServer, ToolContext } from './types.js';

interface SearchFileArgs {
    path: string;
    maxChars?: number;
    grep?: string;
    grepContext?: number;
    symbol?: string;
    nearLine?: number;
    expandLines?: number;
}

export function register(server: ToolServer, ctx: ToolContext): void {
    const handler = async (args: SearchFileArgs) => {
        const validPath = await ctx.validatePath(args.path);
        const maxChars = Math.min(args.maxChars ?? 50000, getCharBudget());
        if (args.grep) {
            const hasRg = await ripgrepAvailable();
            if (!hasRg) {
                throw new Error('Regex grep requires ripgrep. In-process regex execution is disabled for safety.');
            }

            const grepContext = Math.min(Math.max(0, args.grepContext ?? 0), 30);
            const rgResults = await ripgrepSearch(path.dirname(validPath), {
                contentQuery: args.grep,
                ignoreCase: true,
                maxResults: 10000,
                contextLines: grepContext,
                fileList: [validPath],
                includeContextLines: true,
                skipSensitiveFilter: true,
                maxMatchesPerFile: 500,
            });

            if (rgResults === null) {
                const detail = lastRipgrepError ? `: ${lastRipgrepError}` : '';
                throw new Error(`Search failed — ripgrep process error${detail}`);
            }
            if (rgResults.length === 0) {
                return { content: [{ type: 'text' as const, text: 'No matches.' }] };
            }

            // Sort by line number to ensure ripgrep context events are in order
            rgResults.sort((a, b) => a.line - b.line);

            const outputLines: string[] = [];
            let charCount = 0;
            let prevLine = -1;
            for (const result of rgResults) {
                if (prevLine !== -1 && result.line > prevLine + 1) {
                    if (charCount + 4 > maxChars) break;
                    outputLines.push('---');
                    charCount += 4;
                }
                const marker = result.isContext ? '' : '*';
                const formatted = `${result.line}:${marker}${result.content}`;
                if (charCount + formatted.length + 1 > maxChars) break;
                outputLines.push(formatted);
                charCount += formatted.length + 1;
                prevLine = result.line;
            }

            return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
        }
        if (args.symbol) {
            const langName = getLangForFile(validPath);
            if (!langName) {
                throw new Error('Unsupported file type.');
            }
            const source = await fs.readFile(validPath, 'utf-8');
            const allLines = source.split('\n');
            const totalLines = allLines.length;
            const findOptions: { kindFilter: string; nearLine?: number } = { kindFilter: 'def' };
            if (args.nearLine !== undefined) findOptions.nearLine = args.nearLine;
            const matches = await findSymbol(source, langName, args.symbol, findOptions);
            if (!matches || matches.length === 0) {
                throw new Error('Symbol not found.');
            }
            if (matches.length > 1 && !args.nearLine) {
                throw new Error('Multiple matches. Use nearLine.');
            }
            const [sym] = matches;
            if (sym === undefined) {
                throw new Error('Symbol not found.');
            }
            const expand = Math.max(0, Math.min(args.expandLines ?? 0, 50));
            const startLine = Math.max(1, sym.line - expand);
            const endLine = Math.min(totalLines, sym.endLine + expand);
            const slice = allLines.slice(startLine - 1, endLine);
            const numbered = slice.map((line, i) => {
                const ln = startLine + i;
                return `${ln}:${line}`;
            });
            const text = numbered.join('\n');
            return {
                content: [{ type: "text" as const, text }],
            };
        }
        throw new Error('Provide grep or symbol.');
    };
    server.registerTool("search_file", {
        title: "Search File",
        description: "Search file by regex or symbol name.",
        inputSchema: z.object({
            path: z.string().describe("File path."),
            maxChars: z.number().optional().describe("Max chars. Up to 400K."),
            grep: z.string().optional().describe("Case-insensitive regex."),
            grepContext: z.number().optional().describe("Context lines. Max 30."),
            symbol: z.string().optional().describe("Symbol name. Dot-qualified for methods."),
            nearLine: z.number().optional().describe("Disambiguate multiple matches."),
            expandLines: z.number().optional().describe("Extra context. Max 50."),
        }),
        annotations: { readOnlyHint: true }
    }, handler);
}
//# sourceMappingURL=search_file.js.map
