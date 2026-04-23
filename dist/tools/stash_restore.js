import { z } from "zod";
import fs from "fs/promises";
import path from 'path';
import { randomBytes } from 'crypto';
import { normalizeLineEndings, createMinimalDiff } from '../core/lib.js';
import { getLangForFile, findSymbol, checkSyntaxErrors } from '../core/tree-sitter.js';
import { getStashEntry, consumeAttempt, clearStash, listStash } from '../core/stash.js';
import { getProjectContext } from '../core/project-context.js';
import { findMatch } from './edit_file.js';
import {
    findRepoRoot, getDb, indexFile,
    getVersionHistory, getVersionText, restoreVersion,
} from '../core/symbol-index.js';

export function register(server, ctx) {
    server.registerTool("stashRestore", {
        title: "Stash Restore",
        description: "Retry failed edits/writes, restore previous versions, or browse cached entries.",
        inputSchema: {
            mode: z.enum(['apply', 'restore', 'list', 'read', 'init']),
            stashId: z.number().optional().describe("Stash ID. Required for apply, read, and stash rollback."),
            corrections: z.array(z.object({
                index: z.number().describe("1-based edit index to disambiguate."),
                startLine: z.number().optional().describe("Line number for ambiguous block edits."),
                nearLine: z.number().optional().describe("Approximate line for ambiguous symbol edits."),
            })).optional().describe("apply mode. Disambiguation for ambiguous edits."),
            newPath: z.string().optional().describe("apply mode. Corrected path for a failed write."),
            dryRun: z.boolean().optional().default(false).describe("apply mode. Preview without writing."),
            symbol: z.string().optional().describe("restore mode. Symbol name to restore."),
            version: z.number().optional().describe("restore mode. Version number."),
            file: z.string().optional().describe("restore mode. File containing the symbol."),
            type: z.enum(['edit', 'write', 'symbol']).optional().describe("list mode. Filter by type."),
            projectRoot: z.string().optional().describe("init mode. Directory to register as project root."),
            projectName: z.string().optional().describe("init mode. Project name."),
        },
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {

        const pc = getProjectContext(ctx);

        // =================================================================
        // INIT — register a project root (no git needed)
        // =================================================================
        if (args.mode === 'init') {
            if (!args.projectRoot) throw new Error('projectRoot required.');
            const abs = pc.initProject(args.projectRoot, args.projectName);
            return { content: [{ type: 'text', text: `Project registered: ${abs}${args.projectName ? ` (${args.projectName})` : ''}` }] };
        }

        // =================================================================
        // LIST
        // =================================================================
        if (args.mode === 'list') {
            const { entries, isGlobal } = listStash(ctx, args.file);
            let filtered = entries;
            if (args.type) {
                if (args.type === 'symbol') {
                    filtered = entries.filter(e => e.type === 'edit' && e.payload?.edits?.some(ed => ed.symbol));
                } else {
                    filtered = entries.filter(e => e.type === args.type);
                }
            }
            if (!filtered.length) {
                let msg = args.type ? `No ${args.type} entries in stash.` : 'Stash is empty.';
                if (isGlobal) msg += ' No project detected — showing global stash. Use init mode to register a project root.';
                return { content: [{ type: 'text', text: msg }] };
            }
            const lines = filtered.map(e =>
                `#${e.id} [${e.type}] ${e.filePath} (attempt ${e.attempts}/2)`
            );
            if (isGlobal) lines.unshift('(global stash — no project detected)');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // =================================================================
        // READ
        // =================================================================
        if (args.mode === 'read') {
            if (!args.stashId) throw new Error('stashId required.');
            const entry = getStashEntry(ctx, args.stashId, args.file);
            if (!entry) throw new Error(`Stash #${args.stashId} not found.`);

            if (entry.type === 'edit') {
                const edits = entry.payload.edits;
                const failed = entry.payload.failedIndices;
                const lines = edits.map((e, i) => {
                    const status = failed.includes(i) ? 'FAILED' : 'ok';
                    const mode = e.symbol ? `symbol:${e.symbol}` : e.block_start ? `block:${e.block_start}...${e.block_end}` : `content`;
                    return `#${i + 1} [${status}] ${mode}`;
                });
                return { content: [{ type: 'text', text: `edit ${entry.filePath}\n${lines.join('\n')}` }] };
            }

            if (entry.type === 'write') {
                const p = entry.payload;
                const preview = p.content.length > 500 ? p.content.slice(0, 500) + '...' : p.content;
                return { content: [{ type: 'text', text: `write [${p.mode}] ${entry.filePath}\n${preview}` }] };
            }

            const edits = entry.payload.edits || [];
            const summary = edits.map((e, i) => {
                if (e.block_start) return `#${i+1}: block [${e.block_start}] → [${e.block_end}]`;
                if (e.oldContent) return `#${i+1}: content match`;
                if (e.symbol) return `#${i+1}: symbol ${e.symbol}`;
                return `#${i+1}: unknown`;
            }).join('\n');
            return { content: [{ type: 'text', text: `edit ${entry.filePath}\nfailed: ${(entry.payload.failedIndices||[]).join(', ')}\n${summary}` }] };
        }

        // =================================================================
        // RESTORE — rollback a stash entry or restore a symbol version
        // =================================================================
        if (args.mode === 'restore') {
            // Symbol version restore
            if (args.symbol) {
                const filePath = args.file;
                if (!filePath) throw new Error('file required for symbol restore.');
                const absPath = await ctx.validatePath(filePath).catch(() => filePath);
                const repoRoot = findRepoRoot(absPath) || path.dirname(absPath);
                const db = getDb(repoRoot);

                if (args.version !== undefined) {
                    const relPath = path.relative(repoRoot, absPath);
                    const history = getVersionHistory(db, args.symbol, ctx.sessionId, relPath);
                    const versionEntry = history?.[args.version];
                    if (!versionEntry) throw new Error(`${args.symbol}: version ${args.version} not found.`);
                    const text = getVersionText(db, versionEntry.id);
                    if (!text) throw new Error(`${args.symbol}: version ${args.version} text not found.`);

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

            // Stash entry rollback
            if (!args.stashId) throw new Error('stashId or symbol required for restore.');
            const entry = getStashEntry(ctx, args.stashId, args.file);
            if (!entry) throw new Error(`Stash #${args.stashId} not found.`);
            clearStash(ctx, args.stashId, args.file);
            return { content: [{ type: 'text', text: `Stash #${args.stashId} cleared.` }] };
        }

        // =================================================================
        // APPLY — retry a cached edit or write
        // =================================================================
        if (args.mode === 'apply') {
            if (!args.stashId) throw new Error('stashId required.');

            const entry = getStashEntry(ctx, args.stashId, args.newPath || args.file);
            if (!entry) throw new Error(`Stash #${args.stashId} not found or expired.`);

            if (!args.dryRun) {
                const canRetry = consumeAttempt(ctx, args.stashId, entry.filePath);
                if (!canRetry) throw new Error(`Stash #${args.stashId}: max retries (2) exceeded. Stash removed.`);
            }

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

                    // For ambiguous block edits, the correction just provides startLine
                    if (failedIndices.includes(i)) {
                        const corr = correctionMap.get(i + 1);
                        if (corr) {
                            if (corr.startLine !== undefined) edit.startLine = corr.startLine;
                            if (corr.nearLine !== undefined) edit.nearLine = corr.nearLine;
                        }
                    }

                    // Block replace mode
                    if (edit.block_start || edit.block_end) {
                        if (!edit.block_start || !edit.block_end) { errors.push({ i, msg: `#${i+1}: both block_start and block_end required.` }); continue; }
                        if (edit.replacement_block === undefined) { errors.push({ i, msg: `#${i+1}: replacement_block required.` }); continue; }

                        const lines = workingContent.split('\n');
                        const expectedStart = edit.block_start.trim();
                        const expectedEnd = edit.block_end.trim();
                        const candidates = [];
                        for (let s = 0; s < lines.length; s++) {
                            if (lines[s].trim() !== expectedStart) continue;
                            for (let e = s; e < lines.length; e++) {
                                if (lines[e].trim() !== expectedEnd) { continue; }
                                candidates.push({ start: s, end: e });
                                break;
                            }
                        }

                        if (candidates.length === 0) { errors.push({ i, msg: `#${i+1}: block_start not found.` }); continue; }

                        let chosen;
                        if (candidates.length === 1) {
                            chosen = candidates[0];
                        } else if (edit.startLine) {
                            chosen = candidates.find(c => c.start === edit.startLine - 1);
                            if (!chosen) { errors.push({ i, msg: `#${i+1}: no match at line ${edit.startLine}.` }); continue; }
                        
                        } else {
                            const locs = candidates.map(c => `lines ${c.start + 1}-${c.end + 1}`).join(', ');
                            errors.push({ i, msg: `#${i+1}: multiple matches: ${locs}. Provide startLine to disambiguate.` }); continue;
                        }

                        const normalizedNew = normalizeLineEndings(edit.replacement_block);
                        lines.splice(chosen.start, chosen.end - chosen.start + 1, ...normalizedNew.split('\n'));
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
                    if (!edit.oldContent) { errors.push({ i, msg: `#${i+1}: provide block_start/block_end, oldContent, or symbol.` }); continue; }
                    const match = findMatch(workingContent, edit.oldContent, edit.nearLine);
                    if (!match) { errors.push({ i, msg: `#${i+1}: oldContent not found.` }); continue; }
                    if (edit.newContent === undefined) { errors.push({ i, msg: `#${i+1}: newContent required.` }); continue; }
                    const normalizedNew = normalizeLineEndings(edit.newContent);
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
                    clearStash(ctx, args.stashId, entry.filePath);
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
                        let finalContent = content;
                        let existed = false;
                        try { await fs.stat(validPath); existed = true; } catch {}
                        if (existed) {
                            const existing = await fs.readFile(validPath, 'utf-8');
                            const existingLines = existing.split('\n');
                            const incomingLines = content.split('\n');
                            const tailLines = existingLines.slice(-500);
                            let overlap = 0;
                            if (tailLines.length && incomingLines.length) {
                                const trim = s => s.trimEnd();
                                const first = trim(incomingLines[0]);
                                for (let i = 0; i < tailLines.length; i++) {
                                    if (trim(tailLines[i]) !== first) continue;
                                    const overlapLen = Math.min(tailLines.length - i, incomingLines.length);
                                    let matched = true;
                                    for (let j = 0; j < overlapLen; j++) {
                                        if (trim(tailLines[i + j]) !== trim(incomingLines[j])) { matched = false; break; }
                                    }
                                    if (matched) { overlap = overlapLen; break; }
                                }
                            }
                            const appendChunk = overlap > 0 ? incomingLines.slice(overlap).join('\n') : content;
                            const separator = existing.endsWith('\n') ? '' : '\n';
                            finalContent = existing + separator + appendChunk;
                        }
                        await fs.writeFile(tempPath, finalContent, 'utf-8');
                        await fs.rename(tempPath, validPath);
                    } else {
                        await fs.writeFile(tempPath, content, 'utf-8');
                        await fs.rename(tempPath, validPath);
                    }
                } catch (error) {
                    try { await fs.unlink(tempPath); } catch {}
                    throw new Error(`Write retry failed: ${error.message}`);
                }

                clearStash(ctx, args.stashId, entry.filePath);
                return { content: [{ type: 'text', text: `Applied.` }] };
            }

            throw new Error(`Unknown stash type: ${entry.type}`);
        }

        throw new Error('Invalid mode.');
    });
}
