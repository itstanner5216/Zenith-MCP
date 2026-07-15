import { z } from "zod";
import fs from "fs/promises";
import path from 'path';
import { randomBytes } from 'crypto';
import { normalizeLineEndings, createMinimalDiff } from '../core/lib.js';
import { stashEdits } from '../core/stash.js';
import { applyEditList, syntaxWarn } from '../core/edit-engine.js';
import { findRepoRoot, getDb, snapshotSymbol, getSessionId } from '../core/symbol-index.js';

export function register(server, ctx) {
    server.registerTool("edit_file", {
        title: "Edit File",
        description: "Edit a text file.",
        inputSchema: {
            path: z.string().describe("File to edit."),
            edits: z.array(z.object({
                mode: z.enum(["block", "content", "symbol"]),
                block_start: z.string().optional().describe("First line of block."),
                block_end: z.string().optional().describe("Last line of block."),
                replacement_block: z.string().optional().describe("Replacement text."),
                oldContent: z.string().optional().describe("Text to find."),
                newContent: z.string().optional().describe("Replacement text."),
                symbol: z.string().optional().describe("Symbol name."),
                newText: z.string().optional().describe("Replacement text."),
                nearLine: z.number().optional().describe("Approx line number."),
            })),
            dryRun: z.boolean().default(false).describe("Preview without writing."),
        },
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {
        const validPath = await ctx.validatePath(args.path);
        if (!args.edits?.length) throw new Error('No edits provided.');

        const originalContent = normalizeLineEndings(await fs.readFile(validPath, 'utf-8'));
        const isBatch = args.edits.length > 1;

        const { workingContent, errors, pendingSnapshots } = await applyEditList(originalContent, args.edits, {
            filePath: validPath,
            isBatch,
        });

        if (errors.length > 0) {
            const failedIndices = errors.map(e => e.i);
            const stashId = stashEdits(ctx, validPath, args.edits, failedIndices);
            const failMsg = errors.map(e => e.msg).join('\n');
            throw new Error(`${errors.length} failed. stash:${stashId}\n${failMsg}`);
        }

        if (args.dryRun) {
            return { content: [{ type: 'text', text: createMinimalDiff(originalContent, workingContent, validPath) }] };
        }

        const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
        try {
            await fs.writeFile(tempPath, workingContent, 'utf-8');
            await fs.rename(tempPath, validPath);
        } catch (error) {
            try { await fs.unlink(tempPath); } catch {}
            throw error;
        }

        if (pendingSnapshots.length > 0) {
            try {
                const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
                const db = getDb(repoRoot);
                const sessionId = ctx.sessionId || getSessionId();
                const relPath = path.relative(repoRoot, validPath);
                for (const snap of pendingSnapshots) {
                    snapshotSymbol(db, snap.symbol, relPath, snap.originalText, sessionId, snap.line);
                }
            } catch { /* versioning is best-effort; never fail an edit because of it */ }
        }

        const warning = await syntaxWarn(validPath, workingContent);
        return { content: [{ type: 'text', text: `Applied.${warning}` }] };
    });
}
