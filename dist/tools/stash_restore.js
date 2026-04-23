import { z } from "zod";
import fs from "fs/promises";
import path from 'path';
import { randomBytes } from 'crypto';
import { normalizeLineEndings, createMinimalDiff } from '../core/lib.js';
import { getLangForFile, findSymbol, checkSyntaxErrors } from '../core/tree-sitter.js';
import { getStashEntry, consumeAttempt, clearStash, listStash } from '../core/stash.js';
import { findMatch, generateDiagnostic } from './edit_file.js';
import {
    findRepoRoot, getDb, indexFile, snapshotSymbol,
    getVersionHistory, getVersionText, restoreVersion,
} from '../core/symbol-index.js';

export function register(server, ctx) {
    server.registerTool("stashRestore", {
        title: "Stash Restore",
        description: "Manage stashed failed edits/writes. Modes: apply (retry from cache), restore (rollback applied edit/write or restore symbol version), list (show all stash entries), read (view stash contents).",
        inputSchema: {
            mode: z.enum(['apply', 'restore', 'list', 'read']).describe("Operation mode."),
            stashId: z.number().optional().describe("Stash entry ID."),

            // apply mode
            corrections: z.array(z.object({
                index: z.number().describe("1-based edit index that failed."),
                verifyStart: z.string().optional(),
                verifyEnd: z.string().optional(),
                oldText: z.string().optional(),
                startLine: z.number().optional(),
                endLine: z.number().optional(),
                nearLine: z.number().optional(),
                symbol: z.string().optional().describe("Corrected symbol name."),
            })).optional().describe("Corrected verification for failed edits only."),
            newPath: z.string().optional().describe("Corrected path for a failed write."),

            // restore mode
            symbol: z.string().optional().describe("Symbol name to restore to a previous version."),
            version: z.number().optional().describe("Version number to restore to."),
            file: z.string().optional().describe("File containing the symbol."),

            // list filter
            type: z.enum(['edit', 'write', 'symbol']).optional().describe("Filter list by stash type."),

            dryRun: z.boolean().optional().default(false),
        },
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {

        const resolveRepoRoots = () => {
            const dirs = ctx.getAllowedDirectories();
            return [...new Set(dirs.map(d => findRepoRoot(d) || d))];
        };

        const resolveStashRoots = (filePath) => {
            if (filePath) {
                const root = findRepoRoot(filePath) || path.dirname(filePath);
                return [root];
            }
            return resolveRepoRoots();
        };

        // =================================================================
        // LIST
        // =================================================================
        if (args.mode === 'list') {
            const roots = resolveStashRoots(args.file);
            let entries = [];
            for (const root of roots) entries.push(...listStash(root));
            if (args.type) {
                if (args.type === 'symbol') {
                    entries = entries.filter(e => e.type === 'edit' && e.payload?.edits?.some(ed => ed.symbol));
                } else {
                    entries = entries.filter(e => e.type === args.type);
                }
            }
            if (!entries.length) return { content: [{ type: 'text', text: args.type ? `No ${args.type} entries in stash.` : 'Stash is empty.' }] };
            const lines = entries.map(e =>
                `#${e.id} [${e.type}] ${e.filePath} (attempt ${e.attempts}/${2})`
            );
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // =================================================================
        // READ
        // =================================================================
        if (args.mode === 'read') {
            if (!args.stashId) throw new Error('stashId required.');
            const roots = resolveStashRoots(args.file);
            let entry = null;
            let foundRoot = null;
            for (const root of roots) {
                entry = getStashEntry(root, args.stashId);
                if (entry) { foundRoot = root; break; }
            }
            if (!entry) throw new Error(`Stash #${args.stashId} not found.`);

            if (entry.type === 'edit') {
                const edits = entry.payload.edits;
                const failed = entry.payload.failedIndices;
                const lines = edits.map((e, i) => {
                    const status = failed.includes(i) ? 'FAILED' : 'ok';
                    const mode = e.symbol ? `symbol:${e.symbol}` : e.startLine ? `range:${e.startLine}-${e.endLine}` : `oldText`;
                    return `#${i + 1} [${status}] ${mode}`;
                });
                return { content: [{ type: 'text', text: `edit ${entry.filePath}\n${lines.join('\n')}` }] };
            }

            if (entry.type === 'write') {
                const p = entry.payload;
                const preview = p.content.length > 500 ? p.content.slice(0, 500) + '...' : p.content;
                return { content: [{ type: 'text', text: `write [${p.mode}] ${entry.filePath}\n${preview}` }] };
            }

            return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
        }

        // =================================================================
        // RESTORE — rollback a stash entry or restore a symbol version
        // =================================================================
        if (args.mode === 'restore') {
            // Symbol version restore (no stashId needed)
            if (args.symbol) {
                const filePath = args.file;
                if (!filePath) throw new Error('file required for symbol restore.');
                const absPath = await ctx.validatePath(filePath).catch(() => filePath);
                const repoRoot = findRepoRoot(absPath) || path.dirname(absPath);
                const db = getDb(repoRoot);

                if (args.version !== undefined) {
                    const history = getVersionHistory(db, args.symbol, ctx.sessionId, absPath);
                    const versionEntry = history?.[args.version];
                    if (!versionEntry) throw new Error(`${args.symbol}: version ${args.version} not found.`);
                    const text = getVersionText(db, versionEntry.id);
                    if (!text) throw new Error(`${args.symbol}: version ${args.version} not found.`);

                    const content = normalizeLineEndings(await fs.readFile(absPath, 'utf-8'));
                    const langName = getLangForFile(absPath);
                    if (!langName) throw new Error(`${args.symbol}: unsupported language.`);

                    const matches = await findSymbol(content, langName, args.symbol, { kindFilter: 'def' });
                    if (!matches?.length) throw new Error(`${args.symbol}: not found in file.`);
                    const sym = matches[0];
                    const lines = content.split('\n');
                    lines.splice(sym.line - 1, sym.endLine - (sym.line - 1), ...text.split('\n'));
                    const newContent = lines.join('\n');

                    if (!args.dryRun) {
                        const tempPath = `${absPath}.${randomBytes(16).toString('hex')}.tmp`;
                        await fs.writeFile(tempPath, newContent, 'utf-8');
                        await fs.rename(tempPath, absPath);
                        await indexFile(db, repoRoot, absPath);
                    }
                    return { content: [{ type: 'text', text: `${args.symbol}: restored to v${args.version}.` }] };
                } else {
                    const restored = restoreVersion(db, args.symbol);
                    return { content: [{ type: 'text', text: `${args.symbol}: ${restored ? 'restored' : 'no history'}.` }] };
                }
            }

            // Stash entry restore — revert an applied stash
            if (!args.stashId) throw new Error('stashId or symbol required for restore.');
            const roots = resolveStashRoots(args.file);
            let entry = null;
            let repoRoot = null;
            for (const root of roots) {
                entry = getStashEntry(root, args.stashId);
                if (entry) { repoRoot = root; break; }
            }
            if (!entry) throw new Error(`Stash #${args.stashId} not found.`);
            clearStash(repoRoot, args.stashId);
            return { content: [{ type: 'text', text: `Stash #${args.stashId} cleared.` }] };
        }

        // =================================================================
        // APPLY — retry a cached edit or write
        // =================================================================
        if (args.mode === 'apply') {
            if (!args.stashId) throw new Error('stashId required.');

            const roots = resolveStashRoots(args.newPath || args.file);
            let entry = null;
            let repoRoot = null;
            for (const root of roots) {
                entry = getStashEntry(root, args.stashId);
                if (entry) { repoRoot = root; break; }
            }
            if (!entry) throw new Error(`Stash #${args.stashId} not found or expired.`);

            const canRetry = consumeAttempt(repoRoot, args.stashId);
            if (!canRetry) throw new Error(`Stash #${args.stashId}: max retries (2) exceeded. Stash removed.`);

            // --- Edit apply ---
            if (entry.type === 'edit') {
                const validPath = await ctx.validatePath(entry.filePath);
                const originalContent = normalizeLineEndings(await fs.readFile(validPath, 'utf-8'));
                let workingContent = originalContent;
                const edits = entry.payload.edits;
                const failedIndices = entry.payload.failedIndices;
                const corrections = args.corrections || [];
                const errors = [];

                const correctionMap = new Map();
                for (const c of corrections) correctionMap.set(c.index, c);

                for (let i = 0; i < edits.length; i++) {
                    let edit = { ...edits[i] };

                    if (failedIndices.includes(i)) {
                        const corr = correctionMap.get(i + 1);
                        if (corr) {
                            if (corr.verifyStart !== undefined) edit.verifyStart = corr.verifyStart;
                            if (corr.verifyEnd !== undefined) edit.verifyEnd = corr.verifyEnd;
                            if (corr.oldText !== undefined) edit.oldText = corr.oldText;
                            if (corr.startLine !== undefined) edit.startLine = corr.startLine;
                            if (corr.endLine !== undefined) edit.endLine = corr.endLine;
                            if (corr.nearLine !== undefined) edit.nearLine = corr.nearLine;
                    if (corr.symbol !== undefined) edit.symbol = corr.symbol;
                        }
                    }

                    // Range mode
                    if (typeof edit.startLine === 'number' && typeof edit.endLine === 'number') {
                        const lines = workingContent.split('\n');
                        const start = edit.startLine - 1;
                        const end = edit.endLine;
                        if (edit.newText === undefined) { errors.push({ i, msg: `#${i+1}: newText required.` }); continue; }
                        if (start < 0 || end > lines.length || start >= end) { errors.push({ i, msg: `#${i+1}: invalid range.` }); continue; }
                        if (edit.verifyStart) {
                            const actual = lines[start]?.trim();
                            if (actual !== edit.verifyStart.trim()) {
                                errors.push({ i, msg: `#${i+1}: verifyStart mismatch. Got: "${actual}"` }); continue;
                            }
                        }
                        if (edit.verifyEnd) {
                            const actual = lines[end - 1]?.trim();
                            if (actual !== edit.verifyEnd.trim()) {
                                errors.push({ i, msg: `#${i+1}: verifyEnd mismatch. Got: "${actual}"` }); continue;
                            }
                        }
                        const normalizedNew = normalizeLineEndings(edit.newText);
                        lines.splice(start, end - start, ...normalizedNew.split('\n'));
                        workingContent = lines.join('\n');
                        continue;
                    }

                    // Symbol mode
                    if (edit.symbol) {
                        const langName = getLangForFile(validPath);
                        if (!langName) { errors.push({ i, msg: `#${i+1}: unsupported language.` }); continue; }
                        const symbolMatches = await findSymbol(workingContent, langName, edit.symbol, { kindFilter: 'def', nearLine: edit.nearLine });
                        if (!symbolMatches?.length) { errors.push({ i, msg: `#${i+1}: symbol not found.` }); continue; }
                        if (symbolMatches.length > 1 && !edit.nearLine) { errors.push({ i, msg: `#${i+1}: multiple matches, use nearLine.` }); continue; }
                        const sym = symbolMatches[0];
                        const lines = workingContent.split('\n');
                        lines.splice(sym.line - 1, sym.endLine - (sym.line - 1), ...normalizeLineEndings(edit.newText).split('\n'));
                        workingContent = lines.join('\n');
                        continue;
                    }

                    // Content match mode
                    if (!edit.oldText) { errors.push({ i, msg: `#${i+1}: provide oldText, range, or symbol.` }); continue; }
                    const match = findMatch(workingContent, edit.oldText, edit.nearLine);
                    if (!match) { errors.push({ i, msg: `#${i+1}: oldText not found.` }); continue; }
                    if (edit.newText === undefined) { errors.push({ i, msg: `#${i+1}: newText required.` }); continue; }
                    const normalizedNew = normalizeLineEndings(edit.newText);
                    workingContent = workingContent.slice(0, match.index) + normalizedNew + workingContent.slice(match.index + match.matchedText.length);
                }

                if (errors.length > 0) {
                    const failMsg = errors.map(e => e.msg).join('\n');
                    throw new Error(`${errors.length} failed.\n${failMsg}`);
                }

                if (args.dryRun) {
                    const patch = createMinimalDiff(originalContent, workingContent, validPath);
                    return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, diff: patch }) }] };
                }

                const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
                try {
                    await fs.writeFile(tempPath, workingContent, 'utf-8');
                    await fs.rename(tempPath, validPath);
                    clearStash(repoRoot, args.stashId);
                } catch (error) {
                    try { await fs.unlink(tempPath); } catch {}
                    throw error;
                }

                let syntaxWarning = '';
                try {
                    const ext = path.extname(validPath).toLowerCase();
                    if (!['.scss', '.mdx', '.jsonc'].includes(ext)) {
                        const langName = getLangForFile(validPath);
                        if (langName) {
                            const syntaxErrors = await checkSyntaxErrors(workingContent, langName);
                            if (syntaxErrors?.length) {
                                syntaxWarning = `\n⚠ Parse errors at lines ${syntaxErrors.map(e => `${e.line}:${e.column}`).join(', ')}`;
                            }
                        }
                    }
                } catch {}

                return { content: [{ type: 'text', text: `Stash #${args.stashId} applied.${syntaxWarning}` }] };
            }

            // --- Write apply ---
            if (entry.type === 'write') {
                const targetPath = args.newPath || entry.filePath;
                const validPath = await ctx.validatePath(targetPath);
                const content = entry.payload.content;
                const parentDir = path.dirname(validPath);
                try { await fs.mkdir(parentDir, { recursive: true }); } catch (err) {
                    if (err.code !== 'EEXIST') throw new Error(`Cannot create directory: ${err.message}`);
                }

                if (args.dryRun) {
                    return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, path: validPath, bytes: Buffer.byteLength(content, 'utf-8') }) }] };
                }

                const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
                try {
                    if (entry.payload.mode === 'append') {
                        await fs.appendFile(validPath, content, 'utf-8');
                    } else {
                        await fs.writeFile(tempPath, content, 'utf-8');
                        await fs.rename(tempPath, validPath);
                    }
                } catch (error) {
                    try { await fs.unlink(tempPath); } catch {}
                    throw new Error(`Write retry failed: ${error.message}`);
                }

                clearStash(repoRoot, args.stashId);
                return { content: [{ type: 'text', text: `Stash #${args.stashId} applied to ${validPath}.` }] };
            }

            throw new Error(`Unknown stash type: ${entry.type}`);
        }

        throw new Error('Invalid mode.');
    });
}
