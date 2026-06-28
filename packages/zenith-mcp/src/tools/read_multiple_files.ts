import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { getCharBudget } from '../core/shared.js';
import { compressForTool } from '../core/compression.js';
import type { ToolServer, ToolContext } from './types.js';

interface ReadMultipleFilesArgs {
    paths: string[];
    maxCharsPerFile?: number;
    compression?: boolean;
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
            const item = items[i];
            if (item === undefined) {
                throw new Error(`parallelMap invariant violated: items[${i}] is undefined`);
            }
            results[i] = await fn(item, i);
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
        inputSchema: z.object({
            paths: z.array(z.string())
                .min(1)
                .max(50)
                .describe("File paths to read."),
            maxCharsPerFile: z.number().optional().describe("Max characters per file."),
            compression: z.boolean().optional().default(true).describe("Compress file-read output."),
        }).strict(),
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false }
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
        // Phase 2: Calculate per-file output ceilings
        const validFiles = fileInfos.filter((f): f is FileInfoValid => f.error === null);
        const totalBudget = getCharBudget() - (fileCount * 200);
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
                // The fileCount*200 reservation pre-subtracted from totalBudget pays for
                // per-entry overhead (the "- name\n" label + per-line "N:" prefixes).
                // Credit it back per file — `needed` covers content bytes only.
                budgets.set(file.requestedPath, needed + 200);
                remainingBudget -= needed;
                remainingFiles--;
            }
            perFileBudget = null;
            fileInfos.forEach(f => {
                if (f.error === null) {
                    f.budget = budgets.get(f.requestedPath) || Math.floor(totalBudget / fileCount) + 200;
                }
            });
        }
        // Phase 3: Read files in parallel with output ceiling enforcement
        const results = await parallelMap(fileInfos, async (fileInfo) => {
            const displayPath = fileInfo.validPath !== null ? fileInfo.validPath : fileInfo.requestedPath;
            const fileLabel = `- ${path.basename(displayPath)}`;
            if (fileInfo.error !== null) {
                return `${fileLabel}\nERROR: ${fileInfo.error}`;
            }
            const validPath: string = fileInfo.validPath;
            const budget = perFileBudget !== null ? perFileBudget : (fileInfo.budget || Math.floor(totalBudget / fileCount) + 200);
            const entryPrefix = `${fileLabel}\n`;
            try {
                const byteLimit = budget * 4;
                const fd = await fs.open(validPath, 'r');
                let content: string;
                let bytesRead: number;
                try {
                    const buf = Buffer.allocUnsafe(byteLimit);
                    const readResult = await fd.read(buf, 0, byteLimit, 0);
                    bytesRead = readResult.bytesRead;
                    content = buf.slice(0, bytesRead).toString('utf8');
                }
                finally {
                    await fd.close();
                }

                // read_multiple_files places the `N. ` line-number prefix ONCE here,
                // up front (Rule 10: line numbers are mandatory; Priority 0: they must
                // be true). This prefixed text is canonical — it feeds BOTH the
                // compression path and the plain path, and nothing downstream ever
                // recomputes or re-prefixes a line. compressForTool strips the prefix
                // only to index the real code; TOON strips only to weigh lines and
                // emits each one verbatim, so the number a line carries is the one set
                // here. (A partial window keeps lines 1..K from the file start, so its
                // numbers stay true too.)
                const srcLines = content.split('\n');
                if (srcLines[srcLines.length - 1] === '') srcLines.pop();
                content = srcLines.map((line, i) => `${i + 1}. ${line}`).join('\n');

                const effectiveBudget = Math.max(0, budget - entryPrefix.length);

                if (args.compression !== false && fileInfo.size <= byteLimit) {
                    // fileInfo.size <= byteLimit ⇒ the WHOLE file was captured within the
                    // IO cap (bytesRead === byteLimit at the exact boundary still means the
                    // entire file is in hand), so TOON sees the real source and its line
                    // numbers/markers tell the truth. Partial windows (size > cap) skip
                    // compression (the markers would lie) and use the truncate fallback below.
                    // Priority 0.5 seam: TOON gets the N.-prefixed, FULL text + caller's
                    // budget. Its return is emitted VERBATIM (no re-prefixing, no
                    // '[truncated]' suffix).
                    const compressed = await compressForTool(validPath, content, effectiveBudget);
                    if (compressed !== null) {
                        return `${entryPrefix}${compressed}`;
                    }
                }

                let truncated = false;
                if (content.length > effectiveBudget) {
                    let cutoff = content.lastIndexOf('\n', effectiveBudget);
                    if (cutoff === -1) cutoff = effectiveBudget;
                    content = content.slice(0, cutoff);
                    truncated = true;
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
        const finalText = text.length > getCharBudget()
            ? text.slice(0, getCharBudget()) + '\n[truncated]'
            : text;
        return {
            content: [{ type: "text" as const, text: finalText }],
        };
    });
}
//# sourceMappingURL=read_multiple_files.js.map
