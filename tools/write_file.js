import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { randomBytes } from 'crypto';
import { validatePath, normalizeLineEndings } from '../lib.js';

function findResumeOffset(existingTailLines, incomingLines) {
    if (!existingTailLines.length || !incomingLines.length) return 0;

    const trim = (s) => s.trimEnd();
    const firstIncoming = trim(incomingLines[0]);

    for (let i = 0; i < existingTailLines.length; i++) {
        if (trim(existingTailLines[i]) !== firstIncoming) continue;

        const overlapLen = Math.min(existingTailLines.length - i, incomingLines.length);

        let matched = true;
        for (let j = 0; j < overlapLen; j++) {
            if (trim(existingTailLines[i + j]) !== trim(incomingLines[j])) {
                matched = false;
                break;
            }
        }

        if (matched) return overlapLen;
    }

    return 0;
}

export function register(server) {
    server.registerTool("write_file", {
        title: "Write File",
        description: "Create or overwrite a file. Auto-creates parent directories. Use 'append' to add instead of replace.",
        inputSchema: {
            path: z.string(),
            content: z.string(),
            createOnly: z.boolean().optional().default(false).describe("If true, fails when the file already exists."),
            append: z.boolean().optional().default(false).describe("If true, appends content to the end of an existing file. Creates the file if it doesn't exist."),
        },
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {
        const validPath = await validatePath(args.path);

        // Normalize line endings
        const normalizedContent = normalizeLineEndings(args.content);

        // Check if file exists and gather pre-write state
        let existed = false;

        try {
            await fs.stat(validPath);
            existed = true;
        } catch { /* file doesn't exist */ }

        // createOnly guard
        if (args.createOnly && existed) {
            throw new Error(
                `File already exists. " ` +
                `Use createOnly=false to overwrite, or use edit_file for targeted changes.`
            );
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(validPath);
        try {
            await fs.mkdir(parentDir, { recursive: true });
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw new Error(`Cannot create parent directory: ${err.message}`);
            }
        }

        // Determine final content
        let finalContent = normalizedContent;
        let resumedLines = 0;
        if (args.append && existed) {
            try {
                const existing = await fs.readFile(validPath, 'utf-8');
                const existingLines = existing.split('\n');
                const incomingLines = normalizedContent.split('\n');

                // Resume-append: detect if incoming content overlaps with the file tail.
                // Takes last 500 lines of existing as the tail to compare against.
                const tailLines = existingLines.slice(-500);
                const overlap = findResumeOffset(tailLines, incomingLines);

                let appendContent;
                if (overlap > 0) {
                    resumedLines = overlap;
                    // Skip the already-written prefix, append only the delta
                    appendContent = incomingLines.slice(overlap).join('\n');
                } else {
                    appendContent = normalizedContent;
                }

                // Ensure a newline separates existing content from appended content
                const separator = existing.endsWith('\n') ? '' : '\n';
                finalContent = existing + separator + appendContent;
            } catch (err) {
                throw new Error(`Cannot read existing file for append: ${err.message}`);
            }
        }

        // Atomic write: temp file + rename
        const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
        try {
            await fs.writeFile(tempPath, finalContent, 'utf-8');

            // Verify write - check file size matches expected
            const tempStat = await fs.stat(tempPath);
            const expectedBytes = Buffer.byteLength(finalContent, 'utf-8');
            if (tempStat.size !== expectedBytes) {
                throw new Error('Write verification failed.');
            }

            await fs.rename(tempPath, validPath);
        } catch (error) {
            try { await fs.unlink(tempPath); } catch { /* ignore cleanup failure */ }
            throw error;
        }
        let message;
        if (args.append) {
            message = 'Content appended.';
        } else if (existed) {
            message = 'File updated.';
        } else {
            message = 'File written.';
        }
        return {
            content: [{ type: "text", text: message }],
        };
    });
}
