import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { randomBytes } from 'crypto';
import { normalizeLineEndings } from '../core/lib.js';
import { stashWrite } from '../core/stash.js';

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

export function register(server, ctx) {
    server.registerTool("write_file", {
        title: "Write File",
        description: "Create or overwrite a file. Auto-creates parent directories. Use 'append' to add instead of replace.",
        inputSchema: {
            path: z.string().describe("File to write."),
            content: z.string().describe("Content to write."),
            failIfExists: z.boolean().optional().default(false).describe("Fail if the file already exists."),
            append: z.boolean().optional().default(false).describe("Append instead of overwriting."),
        },
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {
        const validPath = await ctx.validatePath(args.path);

        const normalizedContent = normalizeLineEndings(args.content);

        let existed = false;
        try {
            await fs.stat(validPath);
            existed = true;
        } catch { /* file doesn't exist */ }

        if (args.failIfExists && existed) {
            throw new Error(`File already exists.`);
        }

        const parentDir = path.dirname(validPath);
        try {
            await fs.mkdir(parentDir, { recursive: true });
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw new Error(`Cannot create parent directory: ${err.message}`);
            }
        }

        let finalContent = normalizedContent;
        let resumedLines = 0;
        if (args.append && existed) {
            try {
                const existing = await fs.readFile(validPath, 'utf-8');
                const existingLines = existing.split('\n');
                const incomingLines = normalizedContent.split('\n');

                const tailLines = existingLines.slice(-500);
                const overlap = findResumeOffset(tailLines, incomingLines);

                let appendContent;
                if (overlap > 0) {
                    resumedLines = overlap;
                    appendContent = incomingLines.slice(overlap).join('\n');
                } else {
                    appendContent = normalizedContent;
                }

                const separator = existing.endsWith('\n') ? '' : '\n';
                finalContent = existing + separator + appendContent;
            } catch (err) {
                throw new Error(`Cannot read existing file for append: ${err.message}`);
            }
        }

        const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
        try {
            await fs.writeFile(tempPath, finalContent, 'utf-8');

            const tempStat = await fs.stat(tempPath);
            const expectedBytes = Buffer.byteLength(finalContent, 'utf-8');
            if (tempStat.size !== expectedBytes) {
                throw new Error('Write verification failed.');
            }

            await fs.rename(tempPath, validPath);
        } catch (error) {
            try { await fs.unlink(tempPath); } catch { /* ignore cleanup failure */ }
            const stashId = stashWrite(ctx, validPath, normalizedContent, args.append ? 'append' : 'write');
            throw new Error(`Write failed. Cached as stash:${stashId}.`);
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
