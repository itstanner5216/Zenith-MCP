import { z } from "zod";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { validatePath, readFileContent, tailFile, headFile, offsetReadFile } from '../lib.js';
import { CHAR_BUDGET } from '../shared.js';
import { getLangForFile, findSymbol } from '../tree-sitter.js';

function countLines(str) {
    if (!str) return 0;
    const n = (str.match(/\n/g) || []).length;
    // A trailing newline doesn't represent an extra logical line
    return str.endsWith('\n') ? n : n + 1;
}

export function register(server) {
    const handler = async (args) => {
        const validPath = await validatePath(args.path);
        const maxChars = Math.min(args.maxChars ?? 50000, CHAR_BUDGET);

        // Validate parameter combinations
        if ((args.head && args.tail) || (args.tail && args.offset !== undefined) || (args.head && args.tail && args.offset !== undefined)) {
            throw new Error("Cannot combine tail with head or offset. Use offset+head for windowed reads, or tail alone.");
        }

        if (args.grep && (args.head || args.tail || args.offset !== undefined)) {
            throw new Error("Cannot combine 'grep' with head/tail/offset.");
        }

        const hasWindowMode = args.aroundLine !== undefined || (args.ranges && args.ranges.length > 0);
        if (hasWindowMode && (args.grep || args.head || args.tail || args.offset !== undefined)) {
            throw new Error("Cannot combine aroundLine/ranges with grep/head/tail/offset. ");
        }

        const hasSymbolMode = args.symbol !== undefined;
        if (hasSymbolMode && (args.grep || args.head || args.tail || args.offset !== undefined || hasWindowMode)) {
            throw new Error("Cannot combine 'symbol' with grep/head/tail/offset/aroundLine/ranges. ");
        }

        // ---- SYMBOL MODE ----
        // Read a specific symbol's body by name, resolved via tree-sitter.
        if (hasSymbolMode) {
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

            // Use the best match (first after nearLine sort, or the only one)
            const sym = matches[0];
            const expand = Math.max(0, Math.min(args.expandLines ?? 0, 50));
            const startLine = Math.max(1, sym.line - expand);
            const endLine = Math.min(totalLines, sym.endLine + expand);

            const slice = allLines.slice(startLine - 1, endLine);
            // Always show line numbers in symbol mode — it's code context
            const numbered = slice.map((line, i) => {
                const ln = startLine + i;
                return `${ln}:${line}`;
            });

            const text = numbered.join('\n');
            return {
                content: [{ type: "text", text }],
            };
        }

        // ---- GREP MODE ----
        // Extract matching lines with optional before/after context (like grep -B/-A)
        if (args.grep) {
            const grepPattern = new RegExp(args.grep, args.grepIgnoreCase !== false ? 'i' : '');
            const invertMatch = args.grepInvert ?? false;
            const beforeCount = Math.min(Math.max(0, args.grepBefore ?? 0), 20);
            const afterCount = Math.min(Math.max(0, args.grepAfter ?? 0), 30);
            const hasContext = beforeCount > 0 || afterCount > 0;

            const outputEntries = [];  // { num, text, isMatch }
            let totalLines = 0;
            let charCount = 0;

            // Ring buffer for before-context lines
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
                    const rawMatch = grepPattern.test(line);
                    const isMatch = invertMatch ? !rawMatch : rawMatch;

                    if (isMatch) {
                        // Flush before-context buffer
                        if (hasContext) {
                            for (const ctx of beforeBuffer) {
                                emit(ctx.num, ctx.text, false);
                            }
                            beforeBuffer.length = 0;
                        }

                        emit(totalLines, line, true);
                        afterRemaining = afterCount;
                    } else if (afterRemaining > 0) {
                        // After-context line
                        emit(totalLines, line, false);
                        afterRemaining--;
                    } else if (beforeCount > 0) {
                        // Store in ring buffer for potential before-context
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

        // ---- WINDOW MODE ----
        // Returns context windows around specific line numbers.
        // Triggered by aroundLine and/or ranges params.
        if (hasWindowMode) {

            // Build window list from aroundLine + ranges
            const windows = [];
            if (args.aroundLine !== undefined) {
                const ctx = args.context ?? 30;
                windows.push({
                    startLine: Math.max(1, args.aroundLine - ctx),
                    endLine: args.aroundLine + ctx,
                });
            }
            if (args.ranges && args.ranges.length > 0) {
                for (const r of args.ranges) {
                    windows.push({ startLine: Math.max(1, r.startLine), endLine: r.endLine });
                }
            }

            // Sort windows by startLine, then merge overlapping/adjacent windows
            windows.sort((a, b) => a.startLine - b.startLine);
            const merged = [];
            for (const w of windows) {
                if (merged.length === 0 || w.startLine > merged[merged.length - 1].endLine + 1) {
                    merged.push({ ...w });
                } else {
                    merged[merged.length - 1].endLine = Math.max(merged[merged.length - 1].endLine, w.endLine);
                }
            }

            // Stream line-by-line, collect lines that fall inside any window
            const outputLines = [];
            let totalLines = 0;
            let charCount = 0;
            let windowIdx = 0;
            let lastCollectedLine = -1;
            let budgetExhausted = false;

            await new Promise((resolve, reject) => {
                const stream = createReadStream(validPath, { encoding: 'utf-8' });
                const rl = createInterface({ input: stream, crlfDelay: Infinity });

                rl.on('line', (line) => {
                    totalLines++;
                    if (budgetExhausted) return;

                    // Advance window pointer past windows we've already passed
                    while (windowIdx < merged.length && totalLines > merged[windowIdx].endLine) {
                        windowIdx++;
                    }
                    if (windowIdx >= merged.length) return;

                    const currentWindow = merged[windowIdx];
                    if (totalLines < currentWindow.startLine) return;

                    if (lastCollectedLine !== -1 && totalLines > lastCollectedLine + 1) {
                        outputLines.push('---');
                        charCount += 4;
                    }

                    const formatted = `${totalLines}:${line}`;
                    if (charCount + formatted.length + 1 <= maxChars) {
                        outputLines.push(formatted);
                        charCount += formatted.length + 1;
                        lastCollectedLine = totalLines;
                    } else {
                        budgetExhausted = true;
                    }
                });

                rl.on('close', resolve);
                rl.on('error', reject);
                stream.on('error', reject);
            });

            const text = (budgetExhausted ? '## truncated ##\n' : '') + outputLines.join('\n');
            return {
                content: [{ type: "text", text }],
            };
        }

        // ---- STANDARD READ MODES ----
        let content;
        let meta = {};

        if (args.tail) {
            content = await tailFile(validPath, args.tail);
        } else if (typeof args.offset === 'number' && args.offset >= 0) {
            const length = args.head || 200;
            const result = await offsetReadFile(validPath, args.offset, length);
            content = result.content;
            meta = {
                totalLines: result.totalLines,
                linesReturned: result.linesReturned,
                hasMore: (args.offset + result.linesReturned) < result.totalLines,
            };
        } else if (args.head) {
            content = await headFile(validPath, args.head);
        } else {
            content = await readFileContent(validPath);
        }

        // Smart truncation: if content exceeds char budget, truncate with notice
        let truncated = false;
        if (content && content.length > maxChars) {
            // Count total lines from full content before truncation
            if (!meta.totalLines) {
                meta.totalLines = countLines(content);
            }

            // Find a good break point (end of line)
            let cutoff = content.lastIndexOf('\n', maxChars);
            if (cutoff === -1) cutoff = maxChars;
            content = content.slice(0, cutoff);
            truncated = true;

            // Count lines in truncated content for accurate offset guidance
            const truncLines = countLines(content);
            meta.truncatedAt = truncLines;
        }

        // Add line numbers if requested
        if (args.showLineNumbers && content) {
            const startLine = (typeof args.offset === 'number' && args.offset >= 0) ? args.offset + 1 : 1;
            const lines = content.split('\n');
            if (lines[lines.length - 1] === '') lines.pop();
            content = lines.map((line, i) => `${startLine + i}:${line}`).join('\n');
        }

        let metaHeader = '';
        if (truncated) {
            metaHeader = `## truncated — offset=${meta.truncatedAt} ##\n`;
        }
        if (!truncated && meta.hasMore) {
            metaHeader = `## offset=${args.offset + meta.linesReturned} ##\n`;
        }

        const text = metaHeader + content;
        return {
            content: [{ type: "text", text }],
        };
    };

    server.registerTool("read_text_file", {
        title: "Read Text File",
        description: "Read a text file. Supports head/tail/offset, grep with context, aroundLine windows, line ranges, and symbol lookup.",
        inputSchema: {
            path: z.string(),
            tail: z.number().optional().describe("Last N lines."),
            head: z.number().optional().describe("First N lines."),
            offset: z.number().optional().describe("Start line (0-based). Combine with head."),
            grep: z.string().optional().describe("Regex to match lines."),
            grepIgnoreCase: z.boolean().optional().default(true),
            grepBefore: z.number().optional().default(0).describe("Context lines before match. Max 20."),
            grepAfter: z.number().optional().default(0).describe("Context lines after match. Max 30."),
            grepInvert: z.boolean().optional().default(false).describe("Return non-matching lines."),
            showLineNumbers: z.boolean().optional().default(false).describe("Prefix lines with numbers."),
            maxChars: z.number().optional().default(50000).describe("Max characters (up to 400000)."),
            aroundLine: z.number().optional().describe("Center a window on this line."),
            context: z.number().optional().default(30).describe("Window size for aroundLine."),
            ranges: z.array(z.object({ startLine: z.number(), endLine: z.number() })).optional().describe("Explicit line ranges to return."),
            symbol: z.string().optional().describe("Read a symbol by name. Dot-qualified for methods."),
            expandLines: z.number().optional().default(0).describe("Extra context around symbol. Max 50."),
            nearLine: z.number().optional().describe("Disambiguate multiple symbol matches."),
        },
        annotations: { readOnlyHint: true }
    }, handler);
}
