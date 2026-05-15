import { z } from "zod";
import fs from "fs/promises";
import path from 'path';
import { randomBytes } from 'crypto';
import { normalizeLineEndings, createMinimalDiff, findResumeOffset } from '../core/lib.js';
import { getStashEntry, consumeAttempt, clearStash, listStash } from '../core/stash.js';
import { applyEditList, syntaxWarn } from '../core/edit-engine.js';
import { findRepoRoot, getDb, snapshotSymbol, getSessionId, } from '../core/symbol-index.js';
import type { ToolServer, ToolContext } from './types.js';
import { errorMessage } from './types.js';

type StashRestoreArgs = {
    mode: 'apply' | 'restore' | 'list' | 'read';
    stashId?: number;
    corrections?: Array<{ index: number; startLine?: number; nearLine?: number }>;
    newPath?: string;
    dryRun?: boolean;
    file?: string;
    type?: 'edit' | 'write';
};

export function register(server: ToolServer, ctx: ToolContext) {
    server.registerTool("stashRestore", {
        title: "Stash Restore",
        description: "Retry failed edits/writes or browse cached stash entries. For symbol version restore/history, use refactor_batch instead.",
        inputSchema: z.object({
            mode: z.enum(["apply", "restore", "list", "read"]).describe("apply: retry a stashed edit/write. restore: clear a stash entry. list: browse stash. read: inspect a stash entry."),
            stashId: z.number().optional().describe("Stash entry ID for apply/read/restore."),
            corrections: z.array(z.object({
                index: z.number().describe("1-based edit index."),
                startLine: z.number().optional().describe("Exact line for block edits."),
                nearLine: z.number().optional().describe("Approximate line for symbol edits."),
            })).optional().describe("apply: disambiguation hints for ambiguous edits."),
            newPath: z.string().optional().describe("apply: redirect write to a different path."),
            dryRun: z.boolean().optional().default(false).describe("apply: preview the result without writing."),
            file: z.string().optional().describe("list/read/restore: filter by file path."),
            type: z.enum(['edit', 'write']).optional().describe("list: filter entries by type."),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args: StashRestoreArgs) => {
        // =================================================================
        // LIST
        // =================================================================
        if (args.mode === 'list') {
            const { entries, isGlobal } = listStash(ctx, args.file);
            let filtered = entries;
            if (args.type) {
                filtered = entries.filter((e: { type: string }) => e.type === args.type);
            }
            if (!filtered.length) {
                const msg = isGlobal ? 'Empty. (global)' : 'Empty.';
                return { content: [{ type: 'text', text: msg }] };
            }
            const lines = filtered.map((e: { id: number; type: string; filePath: string; attempts: number }) => `#${e.id} [${e.type}] ${e.filePath} (attempt ${e.attempts}/2)`);
            if (isGlobal)
                lines.unshift('(global stash — no project detected)');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        // =================================================================
        // READ
        // =================================================================
        if (args.mode === 'read') {
            if (!args.stashId)
                throw new Error('stashId required.');
            const entry = getStashEntry(ctx, args.stashId, args.file);
            if (!entry)
                throw new Error(`Stash #${args.stashId} not found.`);
            if (entry.type === 'edit') {
                const edits = entry.payload.edits;
                const failed = entry.payload.failedIndices;
                const lines = edits.map((e: { symbol?: string; block_start?: number; block_end?: number }, i: number) => {
                    const status = failed.includes(i) ? 'FAILED' : 'ok';
                    const mode = e.symbol ? `symbol:${e.symbol}` : e.block_start ? `block:${e.block_start}...${e.block_end}` : `content`;
                    return `#${i + 1} [${status}] ${mode}`;
                });
                return { content: [{ type: 'text', text: `[edit] ${entry.filePath}\n${lines.join('\n')}` }] };
            }
            if (entry.type === 'write') {
                const p = entry.payload;
                const preview = p.content.length > 500 ? p.content.slice(0, 500) + '...' : p.content;
                return { content: [{ type: 'text', text: `[write] ${entry.filePath}\n${preview}` }] };
            }
            throw new Error(`Unknown stash type: ${entry.type}`);
        }
        // =================================================================
        // RESTORE — clear a stash entry
        // =================================================================
        if (args.mode === 'restore') {
            if (!args.stashId)
                throw new Error('stashId required for restore.');
            const entry = getStashEntry(ctx, args.stashId, args.file);
            if (!entry)
                throw new Error(`Stash #${args.stashId} not found.`);
            clearStash(ctx, args.stashId, args.file);
            return { content: [{ type: 'text', text: `Cleared.` }] };
        }
        // =================================================================
        // APPLY — retry a cached edit or write
        // =================================================================
        if (args.mode === 'apply') {
            if (!args.stashId)
                throw new Error('stashId required.');
            const entry = getStashEntry(ctx, args.stashId, args.newPath || args.file);
            if (!entry)
                throw new Error(`Stash #${args.stashId} not found or expired.`);
            if (!args.dryRun) {
                const canRetry = consumeAttempt(ctx, args.stashId, entry.filePath);
                if (!canRetry)
                    throw new Error(`Stash #${args.stashId}: max retries (2) exceeded. Stash removed.`);
            }
            // --- Edit apply ---
            if (entry.type === 'edit') {
                const validPath = await ctx.validatePath(entry.filePath);
                const originalContent = normalizeLineEndings(await fs.readFile(validPath, 'utf-8'));
                const edits = entry.payload.edits;
                const corrections = args.corrections || [];
                const disambiguations = new Map();
                for (const c of corrections) {
                    disambiguations.set(c.index - 1, { startLine: c.startLine, nearLine: c.nearLine });
                }
                const { workingContent, errors, pendingSnapshots } = await applyEditList(originalContent, edits, {
                    filePath: validPath,
                    isBatch: edits.length > 1,
                    disambiguations,
                });
                if (errors.length > 0) {
                    const failMsg = errors.map((e: { msg: string }) => e.msg).join('\n');
                    throw new Error(`${errors.length} failed.\n${failMsg}`);
                }
                if (args.dryRun) {
                    const patch = createMinimalDiff(originalContent, workingContent, validPath);
                    return { content: [{ type: 'text', text: patch }] };
                }
                const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
                try {
                    await fs.writeFile(tempPath, workingContent, 'utf-8');
                    await fs.rename(tempPath, validPath);
                    clearStash(ctx, args.stashId, entry.filePath);
                }
                catch (error) {
                    try {
                        await fs.unlink(tempPath);
                    }
                    catch { }
                    throw error;
                }
                if (!args.dryRun && pendingSnapshots && pendingSnapshots.length > 0) {
                    try {
                        const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
                        const db = getDb(repoRoot);
                        const sessionId = ctx.sessionId ?? getSessionId();
                        const relPath = path.relative(repoRoot, validPath);
                        for (const snap of pendingSnapshots) {
                            if (snap.symbol !== undefined) {
                                snapshotSymbol(db, snap.symbol, relPath, snap.originalText, sessionId, snap.line);
                            }
                        }
                    }
                    catch { /* best-effort */ }
                }
                const warning = await syntaxWarn(validPath, workingContent);
                return { content: [{ type: 'text', text: `Applied.${warning}` }] };
            }
            // --- Write apply ---
            if (entry.type === 'write') {
                const targetPath = args.newPath || entry.filePath;
                const validPath = await ctx.validatePath(targetPath);
                const content = entry.payload.content;
                const parentDir = path.dirname(validPath);
                try {
                    await fs.mkdir(parentDir, { recursive: true });
                }
                catch (err) {
                    const e = err as NodeJS.ErrnoException;
                    if (e.code !== 'EEXIST')
                        throw new Error(`Cannot create directory: ${e.message}`);
                }
                if (args.dryRun) {
                    return { content: [{ type: 'text', text: `${Buffer.byteLength(content, 'utf-8')} bytes` }] };
                }
                const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
                try {
                    if (entry.payload.mode === 'append') {
                        let finalContent = content;
                        let existed = false;
                        try {
                            await fs.stat(validPath);
                            existed = true;
                        }
                        catch { }
                        if (existed) {
                            const existing = await fs.readFile(validPath, 'utf-8');
                            const existingLines = existing.split('\n');
                            const incomingLines = content.split('\n');
                            const tailLines = existingLines.slice(-500);
                            const overlap = findResumeOffset(tailLines, incomingLines);
                            const appendChunk = overlap > 0 ? incomingLines.slice(overlap).join('\n') : content;
                            const separator = existing.endsWith('\n') ? '' : '\n';
                            finalContent = existing + separator + appendChunk;
                        }
                        await fs.writeFile(tempPath, finalContent, 'utf-8');
                        await fs.rename(tempPath, validPath);
                    }
                    else {
                        await fs.writeFile(tempPath, content, 'utf-8');
                        await fs.rename(tempPath, validPath);
                    }
                }
                catch (error) {
                    try {
                        await fs.unlink(tempPath);
                    }
                    catch { }
                    throw new Error(`Write retry failed: ${errorMessage(error)}`);
                }
                clearStash(ctx, args.stashId, entry.filePath);
                return { content: [{ type: 'text', text: `Applied.` }] };
            }
            throw new Error(`Unknown stash type: ${entry.type}`);
        }
        throw new Error('Invalid mode.');
    });
}
