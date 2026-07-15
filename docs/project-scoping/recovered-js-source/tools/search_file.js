import { z } from "zod";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { CHAR_BUDGET } from '../core/shared.js';
import { getLangForFile, findSymbol } from '../core/tree-sitter.js';

export function register(server, ctx) {
    const handler = async (args) => {
        const validPath = await ctx.validatePath(args.path);
        const maxChars = Math.min(args.maxChars ?? 50000, CHAR_BUDGET);

        if (args.grep) {
            const grepPattern = new RegExp(args.grep, 'i');
            const grepContext = Math.min(Math.max(0, args.grepContext ?? 0), 30);
            const beforeCount = grepContext;
            const afterCount = grepContext;
            const hasContext = beforeCount > 0 || afterCount > 0;

            const outputEntries = [];
            let totalLines = 0;
            let charCount = 0;

            const beforeBuffer = [];
            let afterRemaining = 0;
            let lastEmittedLine = 0;

            function emit(lineNum, line, isMatch) {
                if (outputEntries.length > 0 && lineNum <= outputEntries[outputEntries.length - 1].num) return;

                if (hasContext && lastEmittedLine > 0 && lineNum > lastEmittedLine + 1) {
                    const sep = '---';
                    if (charCount + sep.length + 1 <= maxChars) {
                        outputEntries.push({ num: -1, text: sep, isMatch: false });
                        charCount += sep.length + 1;
                    }
                }

                const marker = isMatch ? '*' : '';
                const formatted = `${lineNum}:${marker}${line}`;
                if (charCount + formatted.length + 1 <= maxChars) {
                    outputEntries.push({ num: lineNum, text: formatted, isMatch });
                    charCount += formatted.length + 1;
                    lastEmittedLine = lineNum;
                }
            }

            await new Promise((resolve, reject) => {
                const stream = createReadStream(validPath, { encoding: 'utf-8' });
                const rl = createInterface({ input: stream, crlfDelay: Infinity });

                rl.on('line', (line) => {
                    totalLines++;
                    const isMatch = grepPattern.test(line);

                    if (isMatch) {
                        if (hasContext) {
                            for (const bufItem of beforeBuffer) {
                                emit(bufItem.num, bufItem.text, false);
                            }
                            beforeBuffer.length = 0;
                        }

                        emit(totalLines, line, true);
                        afterRemaining = afterCount;
                    } else if (afterRemaining > 0) {
                        emit(totalLines, line, false);
                        afterRemaining--;
                    } else if (beforeCount > 0) {
                        beforeBuffer.push({ num: totalLines, text: line });
                        if (beforeBuffer.length > beforeCount) beforeBuffer.shift();
                    }
                });

                rl.on('close', resolve);
                rl.on('error', reject);
                stream.on('error', reject);
            });

            const content = outputEntries.length > 0
                ? outputEntries.map(e => e.text).join('\n')
                : 'No matches.';

            return {
                content: [{ type: "text", text: content }],
            };
        }

        if (args.symbol) {
            const langName = getLangForFile(validPath);
            if (!langName) {
                throw new Error('Unsupported file type.');
            }

            const source = await fs.readFile(validPath, 'utf-8');
            const allLines = source.split('\n');
            const totalLines = allLines.length;

            const matches = await findSymbol(source, langName, args.symbol, {
                kindFilter: 'def',
                nearLine: args.nearLine,
            });

            if (!matches || matches.length === 0) {
                throw new Error('Symbol not found.');
            }

            if (matches.length > 1 && !args.nearLine) {
                throw new Error('Multiple matches. Use nearLine.');
            }

            const sym = matches[0];
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
                content: [{ type: "text", text }],
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
