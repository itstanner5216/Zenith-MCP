import { z } from "zod";
import fs from "fs/promises";
import { validatePath } from '../lib.js';
import { CHAR_BUDGET } from '../shared.js';

function countLines(str) {
    if (!str) return 0;
    const n = (str.match(/\n/g) || []).length;
    return str.endsWith('\n') ? n : n + 1;
}

// Simple concurrency limiter
async function parallelMap(items, fn, concurrency = 8) {
    const results = new Array(items.length);
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

export function register(server) {
    server.registerTool("read_multiple_files", {
        title: "Read Multiple Files",
        description: "Read multiple files at once. Large files are truncated.",
        inputSchema: {
            paths: z.array(z.string())
                .min(1)
                .max(50)
                .describe("File paths to read."),
            maxCharsPerFile: z.number().optional().describe("Max characters per file."),
            showLineNumbers: z.boolean().optional().default(false).describe("Prefix each line with its line number."),
        },
        annotations: { readOnlyHint: true }
    }, async (args) => {
        const fileCount = args.paths.length;

        // Phase 1: Validate paths and get file sizes
        const fileInfos = await parallelMap(args.paths, async (filePath) => {
            try {
                const validPath = await validatePath(filePath);
                const stat = await fs.stat(validPath);
                return {
                    requestedPath: filePath,
                    validPath,
                    size: stat.size,
                    error: null,
                };
            } catch (error) {
                return {
                    requestedPath: filePath,
                    validPath: null,
                    size: 0,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        });

        // Phase 2: Calculate per-file budgets
        // Strategy: sort by size, allocate equally, redistribute surplus from small files
        const validFiles = fileInfos.filter(f => !f.error);
        const totalBudget = CHAR_BUDGET - (fileCount * 200); // reserve space for separators

        let perFileBudget;
        if (args.maxCharsPerFile) {
            perFileBudget = Math.min(args.maxCharsPerFile, totalBudget);
        } else {
            // Dynamic budget: start with equal split, redistribute surplus
            const sortedBySize = [...validFiles].sort((a, b) => a.size - b.size);
            const budgets = new Map();
            let remainingBudget = totalBudget;
            let remainingFiles = sortedBySize.length;

            for (const file of sortedBySize) {
                const share = Math.floor(remainingBudget / remainingFiles);
                // Estimate char count (UTF-8 text is roughly 1 byte = 1 char)
                const needed = Math.min(Math.ceil(file.size * 1.15), share);
                budgets.set(file.requestedPath, needed);
                remainingBudget -= needed;
                remainingFiles--;
            }

            perFileBudget = null; // use per-file budgets map
            // Store for later use
            fileInfos.forEach(f => {
                if (!f.error) {
                    f.budget = budgets.get(f.requestedPath) || Math.floor(totalBudget / fileCount);
                }
            });
        }

        // Phase 3: Read files in parallel with budget enforcement
        const results = await parallelMap(fileInfos, async (fileInfo) => {
            if (fileInfo.error) {
                return `## ${fileInfo.requestedPath} ##\nERROR: ${fileInfo.error}`;
            }

            const budget = perFileBudget || fileInfo.budget || Math.floor(totalBudget / fileCount);

            try {
                // Bounded read: only load up to budget*4 bytes to avoid OOM on large files
                let content;
                const byteLimit = budget * 4; // max 4 bytes per UTF-8 code point
                const fd = await fs.open(fileInfo.validPath, 'r');
                try {
                    const buf = Buffer.allocUnsafe(byteLimit);
                    const { bytesRead } = await fd.read(buf, 0, byteLimit, 0);
                    content = buf.slice(0, bytesRead).toString('utf8');
                } finally {
                    await fd.close();
                }
                let truncated = false;

                if (content.length > budget) {
                    let cutoff = content.lastIndexOf('\n', budget);
                    content = cutoff > 0 ? content.slice(0, cutoff) : content.slice(0, budget);
                    truncated = true;
                }

                // Add line numbers if requested
                if (args.showLineNumbers) {
                    const lines = content.split('\n');
                    if (lines[lines.length - 1] === '') lines.pop();
                    content = lines.map((line, i) => {
                        const num = i + 1;
                        return (num === 1 || num % 10 === 0) ? `${num}: ${line}` : line;
                    }).join('\n');
                }

                return truncated
                    ? `## ${fileInfo.requestedPath} ##\n${content}\n## truncated ##`
                    : `## ${fileInfo.requestedPath} ##\n${content}`;
            } catch (error) {
                return `## ${fileInfo.requestedPath} ##\nERROR: ${error.message || error}`;
            }
        });

        const text = results.join('\n');

        // Final safety: enforce absolute char limit
        const finalText = text.length > CHAR_BUDGET
            ? text.slice(0, CHAR_BUDGET) + '\n## truncated ##'
            : text;

        return {
            content: [{ type: "text", text: finalText }],
        };
    });
}
