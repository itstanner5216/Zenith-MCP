import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { CHAR_BUDGET } from '../core/shared.js';
import { compressTextFile, computeCompressionBudget, truncateToBudget } from '../core/compression.js';
import type { ToolServer, ToolContext } from './types.js';

interface ReadMultipleFilesArgs {
    paths: string[];
    maxCharsPerFile?: number;
    compression?: boolean;
    showLineNumbers?: boolean;
}

interface FileInfoValid {
    requestedPath: string;
    validPath: string;
    size: number;
    error: null;
    budget?: number;
}

interface FileInfoError {
    requestedPath: string;
    validPath: null;
    size: number;
    error: string;
    budget?: number;
}

type FileInfo = FileInfoValid | FileInfoError;

// Simple concurrency limiter
async function parallelMap<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, concurrency = 8): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i], i);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

export function register(server: ToolServer, ctx: ToolContext) {
    server.registerTool<ReadMultipleFilesArgs>("read_multiple_files", {
        title: "Read Multiple Files",
        description: "Read multiple files at once. Large files are truncated.",
        inputSchema: {
            paths: z.array(z.string())
                .min(1)
                .max(50)
                .describe("File paths to read."),
            maxCharsPerFile: z.number().optional().describe("Max characters per file."),
            compression: z.boolean().optional().default(true).describe("Compress whitespace in returned content."),
            showLineNumbers: z.boolean().optional().default(false).describe("Prefix each line with its line number."),
        },
        annotations: { readOnlyHint: true }
    }, async (args: ReadMultipleFilesArgs) => {
        const fileCount = args.paths.length;
        // Phase 1: Validate paths and get file sizes
        const fileInfos: FileInfo[] = await parallelMap(args.paths, async (filePath) => {
            try {
                const validPath = await ctx.validatePath(filePath);
                const stat = await fs.stat(validPath);
                return {
                    requestedPath: filePath,
                    validPath,
                    size: stat.size,
                    error: null,
                } satisfies FileInfoValid;
            }
            catch (error) {
                return {
                    requestedPath: filePath,
                    validPath: null,
                    size: 0,
                    error: error instanceof Error ? error.message : String(error),
                } satisfies FileInfoError;
            }
        });
        // Phase 2: Calculate per-file budgets
        const validFiles = fileInfos.filter((f): f is FileInfoValid => f.error === null);
        const totalBudget = CHAR_BUDGET - (fileCount * 200);
        let perFileBudget: number | null;
        if (args.maxCharsPerFile) {
            perFileBudget = Math.min(args.maxCharsPerFile, totalBudget);
        }
        else {
            const sortedBySize = [...validFiles].sort((a, b) => a.size - b.size);
            const budgets = new Map<string, number>();
            let remainingBudget = totalBudget;
            let remainingFiles = sortedBySize.length;
            for (const file of sortedBySize) {
                const share = Math.floor(remainingBudget / remainingFiles);
                const needed = Math.min(Math.ceil(file.size * 1.15), share);
                budgets.set(file.requestedPath, needed);
                remainingBudget -= needed;
                remainingFiles--;
            }
            perFileBudget = null;
            fileInfos.forEach(f => {
                if (f.error === null) {
                    f.budget = budgets.get(f.requestedPath) || Math.floor(totalBudget / fileCount);
                }
            });
        }
        // Phase 3: Read files in parallel with budget enforcement
        const results = await parallelMap(fileInfos, async (fileInfo) => {
            const displayPath = fileInfo.validPath !== null ? fileInfo.validPath : fileInfo.requestedPath;
            const fileLabel = `- ${path.basename(displayPath)}`;
            if (fileInfo.error !== null) {
                return `${fileLabel}\nERROR: ${fileInfo.error}`;
            }
            const validPath: string = fileInfo.validPath;
            const budget = perFileBudget !== null ? perFileBudget : (fileInfo.budget || Math.floor(totalBudget / fileCount));
            const entryPrefix = `${fileLabel}\n`;
            try {
                let content: string | null = null;
                let effectiveBudget = budget;
                if (args.compression !== false && !args.showLineNumbers) {
                    content = await fs.readFile(validPath, 'utf8');
                    const totalEntryBudget = computeCompressionBudget(content.length, budget);
                    const contentBudget = Math.max(0, totalEntryBudget - entryPrefix.length);
                    const compressed = await compressTextFile(validPath, content, contentBudget);
                    if (compressed !== null) {
                        return `${entryPrefix}${compressed.text}`;
                    }
                    effectiveBudget = contentBudget;
                }
                if (content === null) {
                    const byteLimit = budget * 4;
                    const fd = await fs.open(validPath, 'r');
                    try {
                        const buf = Buffer.allocUnsafe(byteLimit);
                        const { bytesRead } = await fd.read(buf, 0, byteLimit, 0);
                        content = buf.slice(0, bytesRead).toString('utf8');
                    }
                    finally {
                        await fd.close();
                    }
                }
                const truncatedResult = truncateToBudget(content, effectiveBudget);
                content = truncatedResult.text;
                const truncated = truncatedResult.truncated;
                if (args.showLineNumbers) {
                    const lines = content.split('\n');
                    if (lines[lines.length - 1] === '')
                        lines.pop();
                    content = lines.map((line, i) => `${i + 1}:${line}`).join('\n');
                }
                if (args.compression !== false && !args.showLineNumbers) {
                    return `${entryPrefix}${content}`;
                }
                return truncated
                    ? `${entryPrefix}${content}\n[truncated]`
                    : `${entryPrefix}${content}`;
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return `${fileLabel}\nERROR: ${msg}`;
            }
        });
        const text = results.join('\n\n');
        const finalText = text.length > CHAR_BUDGET
            ? text.slice(0, CHAR_BUDGET) + '\n[truncated]'
            : text;
        return {
            content: [{ type: "text" as const, text: finalText }],
        };
    });
}
//# sourceMappingURL=read_multiple_files.js.map
