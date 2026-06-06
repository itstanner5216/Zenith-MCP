import { z } from "zod";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { readFileContent } from '../core/lib.js';
import { getCharBudget } from '../core/shared.js';
import { compressForTool } from '../core/compression.js';
import { ToolServer, ToolContext } from './types.js';

interface LineWindow {
    startLine: number;
    endLine: number;
}

export function register(server: ToolServer, ctx: ToolContext) {
    const handler = async (args: {
        path: string;
        maxChars?: number;
        compression?: boolean;
        aroundLine?: number;
        context?: number;
        ranges?: Array<{ startLine: number; endLine: number }>;
    }) => {
        const validPath = await ctx.validatePath(args.path);
        const maxChars = Math.min(args.maxChars ?? 50000, getCharBudget());
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
                const last = merged[merged.length - 1];
                if (last === undefined || w.startLine > last.endLine + 1) {
                    merged.push({ ...w });
                }
                else {
                    last.endLine = Math.max(last.endLine, w.endLine);
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
                    let currentWindow = merged[windowIdx];
                    while (currentWindow !== undefined && totalLines > currentWindow.endLine) {
                        windowIdx++;
                        currentWindow = merged[windowIdx];
                    }
                    if (currentWindow === undefined)
                        return;
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
            const body = outputLines.join('\n');
            const text = budgetExhausted
                ? (body.length > 0 ? `${body}\n[truncated]` : '[truncated]')
                : body;
            return {
                content: [{ type: "text" as const, text }],
            };
        }

        let content = await readFileContent(validPath);
        let truncated = false;
        if (content.length > maxChars) {
            let cutoff = content.lastIndexOf('\n', maxChars);
            if (cutoff === -1) cutoff = maxChars;
            content = content.slice(0, cutoff);
            truncated = true;
        }

        const lines = content.split('\n');
        if (lines[lines.length - 1] === '')
            lines.pop();
        content = lines.map((line: string, i: number) => `${i + 1}:${line}`).join('\n');

        if (args.compression) {
            const compressed = await compressForTool(validPath, content, maxChars);
            if (compressed !== null) {
                content = compressed;
            }
        }

        const text = truncated ? `${content}\n[truncated]` : content;
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
            compression: z.boolean().optional().describe("Compress file-read output."),
            aroundLine: z.number().optional().describe("Center window on this line."),
            context: z.number().optional().describe("Window radius. Default 30."),
            ranges: z.array(z.object({ startLine: z.number(), endLine: z.number() })).optional().describe("Explicit line ranges."),
        }),
        annotations: { readOnlyHint: true }
    }, handler);
}
//# sourceMappingURL=read_file.js.map
