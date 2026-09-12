import { z } from "zod";
import fs from "fs/promises";
import path from 'path';
import { randomBytes } from 'crypto';
import { normalizeLineEndings, createMinimalDiff, findResumeOffset } from '../core/lib.js';
import { getStashEntry, consumeAttempt, clearStash, listStash, scheduleStashCleanup } from '../core/stash.js';
import { applyEditList, syntaxWarn } from '../core/edit-engine.js';
import { getDb, snapshotSymbol, getSessionId, } from '../core/symbol-index.js';
import { getProjectContext } from '../core/project-context.js';
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
    range?: number | string;
};

type StashEntry = NonNullable<ReturnType<typeof getStashEntry>>;
type PendingSnapshots = Awaited<ReturnType<typeof applyEditList>>['pendingSnapshots'];
type Disambiguation = { startLine?: number; nearLine?: number };

const stashRestoreInputSchema = z.object({
    mode: z.enum(["apply", "restore", "list", "read"]).describe("apply: retry a stashed edit/write. restore: clear a stash entry. list: browse stash. read: inspect a stash entry."),
    stashId: z.number().optional().describe("Stash entry ID for apply/read/restore."),
    corrections: z.array(z.object({
        index: z.number().describe("1-based edit index."),
        startLine: z.number().optional().describe("Exact line for block edits."),
        nearLine: z.number().optional().describe("Approximate line for symbol edits."),
    }).strict()).optional().describe("apply: disambiguation hints for ambiguous edits."),
    newPath: z.string().optional().describe("apply: redirect write to a different path."),
    dryRun: z.boolean().optional().default(false).describe("apply: preview the result without writing."),
    file: z.string().optional().describe("list: exact file path filter; read/restore/apply: DB routing hint. Relative and missing paths are normalized safely."),
    type: z.enum(['edit', 'write']).optional().describe("list: filter entries by type."),
    range: z.union([
        z.number().int().positive(),
        z.string().regex(/^\d+\s*-\s*\d+$/),
    ]).optional().describe("list only. Omit to return the 10 newest entries. A number N returns the newest N. A string like '10-30' returns that inclusive 1-based slice of newest-first history."),
}).strict();

function parseListRange(range?: number | string): { start: number; end: number } {
    if (range === undefined) return { start: 1, end: 10 };

    if (typeof range === 'number') {
        if (!Number.isSafeInteger(range) || range < 1) {
            throw new Error('range must be a positive integer or an inclusive range like "10-30".');
        }
        return { start: 1, end: range };
    }

    const match = /^(\d+)\s*-\s*(\d+)$/.exec(range.trim());
    if (!match) {
        throw new Error('range must be a positive integer or an inclusive range like "10-30".');
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new Error('range must start at 1 or greater and end at or after its start.');
    }
    return { start, end };
}

function listEntries(ctx: ToolContext, args: StashRestoreArgs, routedFile?: string) {
    const { start, end } = parseListRange(args.range);
    const { entries, isGlobal } = listStash(ctx, routedFile, {
        ...(args.type !== undefined ? { type: args.type } : {}),
        start,
        end,
    });
    if (!entries.length) {
        const msg = isGlobal ? 'Empty. (global)' : 'Empty.';
        return { content: [{ type: 'text' as const, text: msg }] };
    }
    const lines = entries.map((entry) => `#${entry.id} [${entry.type}] ${entry.filePath || '(no path)'} (attempt ${entry.attempts}/2)`);
    if (isGlobal) {
        lines.unshift('(global stash — no project detected; newest first)');
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

function readEntry(ctx: ToolContext, args: StashRestoreArgs, routedFile?: string) {
    if (!args.stashId) {
        throw new Error('stashId required.');
    }
    const entry = getStashEntry(ctx, args.stashId, routedFile);
    if (!entry) {
        throw new Error(`Stash #${args.stashId} not found.`);
    }
    if (entry.type === 'edit') {
        const edits = entry.payload.edits;
        const failed = entry.payload.failedIndices;
        const lines = edits.map((edit: { symbol?: string; block_start?: number; block_end?: number }, index: number) => {
            const status = failed.includes(index) ? 'FAILED' : 'ok';
            let mode = 'content';
            if (edit.symbol) {
                mode = `symbol:${edit.symbol}`;
            } else if (edit.block_start) {
                mode = `block:${edit.block_start}...${edit.block_end}`;
            }
            return `#${index + 1} [${status}] ${mode}`;
        });
        return { content: [{ type: 'text' as const, text: `[edit] ${entry.filePath || '(no path)'}\n${lines.join('\n')}` }] };
    }
    if (entry.type === 'write') {
        const payload = entry.payload;
        const preview = payload.content.length > 500 ? payload.content.slice(0, 500) + '...' : payload.content;
        return { content: [{ type: 'text' as const, text: `[write] ${entry.filePath || '(no path)'}\n${preview}` }] };
    }
    throw new Error(`Unknown stash type: ${entry.type}`);
}

function restoreEntry(ctx: ToolContext, args: StashRestoreArgs, routedFile?: string) {
    if (!args.stashId) {
        throw new Error('stashId required for restore.');
    }
    const entry = getStashEntry(ctx, args.stashId, routedFile);
    if (!entry) {
        throw new Error(`Stash #${args.stashId} not found.`);
    }
    clearStash(ctx, args.stashId, routedFile);
    return { content: [{ type: 'text' as const, text: 'Cleared.' }] };
}

async function replaceEditedFile(
    ctx: ToolContext,
    stashId: number,
    entryFilePath: string,
    validPath: string,
    workingContent: string,
): Promise<void> {
    const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
    try {
        await fs.writeFile(tempPath, workingContent, 'utf-8');
        await fs.rename(tempPath, validPath);
        clearStash(ctx, stashId, entryFilePath);
    } catch (error) {
        try {
            await fs.unlink(tempPath);
        } catch { }
        throw error;
    }
}

function recordPendingSnapshots(ctx: ToolContext, validPath: string, pendingSnapshots: PendingSnapshots): void {
    if (pendingSnapshots.length === 0) {
        return;
    }
    try {
        const pc = getProjectContext(ctx);
        const repoRoot = pc.getWorkingRoot(validPath);
        const db = getDb(repoRoot);
        const sessionId = ctx.sessionId ?? getSessionId();
        const relPath = path.relative(repoRoot, validPath);
        for (const snapshot of pendingSnapshots) {
            if (snapshot.symbol !== undefined) {
                snapshotSymbol(db, snapshot.symbol, relPath, snapshot.originalText, sessionId, snapshot.line);
            }
        }
    } catch { /* best-effort */ }
}

async function applyEditEntry(ctx: ToolContext, args: StashRestoreArgs, entry: StashEntry, stashId: number) {
    const entryFilePath = entry.filePath;
    if (!entryFilePath) {
        throw new Error(`Stash #${stashId} has no file path.`);
    }
    if (!args.dryRun && !consumeAttempt(ctx, stashId, entryFilePath)) {
        throw new Error(`Stash #${stashId}: max retries (2) exceeded. Stash removed.`);
    }

    const validPath = await ctx.validatePath(entryFilePath);
    const originalContent = normalizeLineEndings(await fs.readFile(validPath, 'utf-8'));
    const edits = entry.payload.edits;
    const disambiguations = new Map<number, Disambiguation>();
    for (const correction of args.corrections ?? []) {
        disambiguations.set(correction.index - 1, {
            ...(correction.startLine !== undefined ? { startLine: correction.startLine } : {}),
            ...(correction.nearLine !== undefined ? { nearLine: correction.nearLine } : {}),
        });
    }
    const { workingContent, errors, pendingSnapshots } = await applyEditList(originalContent, edits, {
        filePath: validPath,
        isBatch: edits.length > 1,
        disambiguations,
    });
    if (errors.length > 0) {
        const failMsg = errors.map((error: { msg: string }) => error.msg).join('\n');
        throw new Error(`${errors.length} failed.\n${failMsg}`);
    }
    if (args.dryRun) {
        const patch = createMinimalDiff(originalContent, workingContent, validPath);
        return { content: [{ type: 'text' as const, text: patch }] };
    }

    await replaceEditedFile(ctx, stashId, entryFilePath, validPath, workingContent);
    recordPendingSnapshots(ctx, validPath, pendingSnapshots);
    const warning = await syntaxWarn(validPath, workingContent);
    return { content: [{ type: 'text' as const, text: `Applied.${warning}` }] };
}

async function appendContent(validPath: string, content: string): Promise<string> {
    let existed = false;
    try {
        await fs.stat(validPath);
        existed = true;
    } catch { }
    if (!existed) {
        return content;
    }

    const existing = await fs.readFile(validPath, 'utf-8');
    const existingLines = existing.split('\n');
    const incomingLines = content.split('\n');
    const tailLines = existingLines.slice(-500);
    const overlap = findResumeOffset(tailLines, incomingLines);
    const appendChunk = overlap > 0 ? incomingLines.slice(overlap).join('\n') : content;
    const separator = existing.endsWith('\n') ? '' : '\n';
    return existing + separator + appendChunk;
}

async function applyWriteEntry(ctx: ToolContext, args: StashRestoreArgs, entry: StashEntry, stashId: number) {
    const targetPath = args.newPath || entry.filePath;
    if (!targetPath) {
        throw new Error(`Stash #${stashId} has no file path. Provide newPath.`);
    }
    if (!args.dryRun && !consumeAttempt(ctx, stashId, targetPath)) {
        throw new Error(`Stash #${stashId}: max retries (2) exceeded. Stash removed.`);
    }

    const validPath = await ctx.validatePath(targetPath);
    const content = entry.payload.content;
    try {
        await fs.mkdir(path.dirname(validPath), { recursive: true });
    } catch (error) {
        const fsError = error as NodeJS.ErrnoException;
        if (fsError.code !== 'EEXIST') {
            throw new Error(`Cannot create directory: ${fsError.message}`);
        }
    }
    if (args.dryRun) {
        return { content: [{ type: 'text' as const, text: `${Buffer.byteLength(content, 'utf-8')} bytes` }] };
    }

    const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
    try {
        const finalContent = entry.payload.mode === 'append'
            ? await appendContent(validPath, content)
            : content;
        await fs.writeFile(tempPath, finalContent, 'utf-8');
        await fs.rename(tempPath, validPath);
    } catch (error) {
        try {
            await fs.unlink(tempPath);
        } catch { }
        throw new Error(`Write retry failed: ${errorMessage(error)}`);
    }
    clearStash(ctx, stashId, targetPath);
    return { content: [{ type: 'text' as const, text: 'Applied.' }] };
}

async function applyEntry(ctx: ToolContext, args: StashRestoreArgs, routedFile?: string) {
    if (!args.stashId) {
        throw new Error('stashId required.');
    }
    const entry = getStashEntry(ctx, args.stashId, routedFile);
    if (!entry) {
        throw new Error(`Stash #${args.stashId} not found or expired.`);
    }
    if (entry.type === 'edit') {
        return applyEditEntry(ctx, args, entry, args.stashId);
    }
    if (entry.type === 'write') {
        return applyWriteEntry(ctx, args, entry, args.stashId);
    }
    throw new Error(`Unknown stash type: ${entry.type}`);
}

async function handleRequest(ctx: ToolContext, args: StashRestoreArgs) {
    const routedFile = args.file ? await ctx.validateNewFilePath(args.file) : undefined;
    scheduleStashCleanup(ctx, routedFile);

    switch (args.mode) {
        case 'list':
            return listEntries(ctx, args, routedFile);
        case 'read':
            return readEntry(ctx, args, routedFile);
        case 'restore':
            return restoreEntry(ctx, args, routedFile);
        case 'apply':
            return applyEntry(ctx, args, routedFile);
        default:
            throw new Error('Invalid mode.');
    }
}

export function register(server: ToolServer, ctx: ToolContext) {
    server.registerTool("stashRestore", {
        title: "Stash Restore",
        description: "Retry failed edits/writes or browse cached stash entries. For symbol version restore/history, use refactor_batch instead.",
        inputSchema: stashRestoreInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, (args: StashRestoreArgs) => handleRequest(ctx, args));
}
