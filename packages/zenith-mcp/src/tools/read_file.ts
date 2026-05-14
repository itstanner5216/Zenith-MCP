import { z } from "zod";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { readFileContent, tailFile, headFile, offsetReadFile } from '../core/lib.js';
import { CHAR_BUDGET } from '../core/shared.js';
import { compressTextFile, computeCompressionBudget, truncateToBudget } from '../core/compression.js';
import { ToolServer, ToolContext } from './types.js';

interface ReadFileMetadata {
    totalLines?: number;
    linesReturned?: number;
    hasMore?: boolean;
    truncatedAt?: number;
}

interface LineWindow {
    startLine: number;
    endLine: number;
}

interface OffsetReadResult {
    content: string;
    totalLines: number;
    linesReturned: number;
}

function countLines(str: string): number {
    if (!str)
        return 0;
    const n = (str.match(/\n/g) || []).length;
    return str.endsWith('\n') ? n : n + 1;
}

export function register(server: ToolServer, ctx: ToolContext) {
    const handler = async (args: {
        path: string;
        maxChars?: number;
        head?: number;
        tail?: number;
        offset?: number;
        showLineNumbers?: boolean;
        compression?: boolean;
        aroundLine?: number;
        context?: number;
        ranges?: Array<{ startLine: number; endLine: number }>;
    }) => {
        const validPath = await ctx.validatePath(args.path);
        const maxChars = Math.min(args.maxChars ?? 50000, CHAR_BUDGET);
        if (args.aroundLine !== undefined || (args.ranges && args.ranges.length > 0)) {
            const windows: LineWindow[] = [];
            if (args.aroundLine !== undefined) {
                const windowRadius = args.context ?? 30;
                windows.push({
                    startLine: Math.max(1, args.aroundLine - windowRadius),
                    endLine: args.aroundLine + windowRadius,
                });
            }
            if (args.ranges && args.ranges.length > 0) {
                for (const r of args.ranges) {
                    windows.push({ startLine: Math.max(1, r.startLine), endLine: r.endLine });
                }
            }
            windows.sort((a, b) => a.startLine - b.startLine);
            const merged: LineWindow[] = [];
            for (const w of windows) {
                if (merged.length === 0 || w.startLine > merged[merged.length - 1].endLine + 1) {
                    merged.push({ ...w });
                }
                else {
                    merged[merged.length - 1].endLine = Math.max(merged[merged.length - 1].endLine, w.endLine);
                }
            }
            const outputLines: string[] = [];
            let totalLines = 0;
            let charCount = 0;
            let windowIdx = 0;
            let lastCollectedLine = -1;
            let budgetExhausted = false;
            await new Promise<void>((resolve, reject) => {
                const stream = createReadStream(validPath, { encoding: 'utf-8' });
                const rl = createInterface({ input: stream, crlfDelay: Infinity });
                rl.on('line', (line) => {
                    totalLines++;
                    if (budgetExhausted)
                        return;
                    while (windowIdx < merged.length && totalLines > merged[windowIdx].endLine) {
                        windowIdx++;
                    }
                    if (windowIdx >= merged.length)
                        return;
                    const currentWindow = merged[windowIdx];
                    if (totalLines < currentWindow.startLine)
                        return;
                    if (lastCollectedLine !== -1 && totalLines > lastCollectedLine + 1) {
                        outputLines.push('---');
                        charCount += 4;
                    }
                    const formatted = `${totalLines}:${line}`;
                    if (charCount + formatted.length + 1 <= maxChars) {
                        outputLines.push(formatted);
                        charCount += formatted.length + 1;
                        lastCollectedLine = totalLines;
                    }
                    else {
                        budgetExhausted = true;
                    }
                });
                rl.on('close', resolve);
                rl.on('error', reject);
                stream.on('error', reject);
            });
            const text = (budgetExhausted ? '[truncated]\n' : '') + outputLines.join('\n');
            return {
                content: [{ type: "text" as const, text }],
            };
        }
        let standardReadContent: string | null = null;
        let standardReadBudget = maxChars;
        if (args.compression) {
            standardReadContent = await readFileContent(validPath);
            const compressed = await compressTextFile(validPath, standardReadContent, maxChars);
            if (compressed !== null) {
                return { content: [{ type: "text" as const, text: compressed.text }] };
            }
            standardReadBudget = computeCompressionBudget(standardReadContent.length, maxChars);
        }
        let content: string | null = null;
        let meta: ReadFileMetadata = {};
        if (args.tail) {
            content = await tailFile(validPath, args.tail);
        }
        else if (typeof args.offset === 'number' && args.offset >= 0) {
            const length = args.head || 200;
            const result = await offsetReadFile(validPath, args.offset, length) as OffsetReadResult;
            content = result.content;
            meta = {
                totalLines: result.totalLines,
                linesReturned: result.linesReturned,
                hasMore: (args.offset + result.linesReturned) < result.totalLines,
            };
        }
        else if (args.head) {
            content = await headFile(validPath, args.head);
        }
        else {
            content = standardReadContent ?? await readFileContent(validPath);
        }
        let truncated = false;
        if (content && content.length > standardReadBudget) {
            if (!meta.totalLines) {
                meta.totalLines = countLines(content);
            }
            const truncatedResult = truncateToBudget(content, standardReadBudget);
            content = truncatedResult.text;
            truncated = true;
            const truncLines = countLines(content);
            meta.truncatedAt = truncLines;
        }
        if (args.showLineNumbers && content) {
            const startLine = (typeof args.offset === 'number' && args.offset >= 0) ? args.offset + 1 : 1;
            const lines = content.split('\n');
            if (lines[lines.length - 1] === '')
                lines.pop();
            content = lines.map((line: string, i: number) => `${startLine + i}:${line}`).join('\n');
        }
        let metaHeader = '';
        if (truncated && !args.compression) {
            metaHeader = `[truncated offset=${meta.truncatedAt}]\n`;
        }
        if (!truncated && meta.hasMore && !args.compression) {
            metaHeader = `[offset=${args.offset! + meta.linesReturned!}]\n`;
        }
        const text = metaHeader + content;
        return {
            content: [{ type: "text" as const, text }],
        };
    };
    server.registerTool("read_file", {
        title: "Read File",
        description: "Read file content.",
        inputSchema: z.object({
            path: z.string().describe("File path."),
            maxChars: z.number().optional().describe("Max chars. Up to 400K."),
            head: z.number().optional().describe("First N lines."),
            tail: z.number().optional().describe("Last N lines."),
            offset: z.number().optional().describe("Start line (0-based). Use with head."),
            showLineNumbers: z.boolean().optional().describe("Prefix lines with numbers."),
            compression: z.boolean().optional().describe("Compress whitespace."),
            aroundLine: z.number().optional().describe("Center window on this line."),
            context: z.number().optional().describe("Window radius. Default 30."),
            ranges: z.array(z.object({ startLine: z.number(), endLine: z.number() })).optional().describe("Explicit line ranges."),
        }),
        annotations: { readOnlyHint: true }
    }, handler);
}
//# sourceMappingURL=read_file.js.map
