import { z } from "zod";
import fs from "fs/promises";
import path from 'path';
import { randomBytes } from 'crypto';
import { normalizeLineEndings, createMinimalDiff } from '../core/lib.js';
import { getLangForFile, findSymbol, checkSyntaxErrors, getSymbols, getDefinitions, isSupported } from '../core/tree-sitter.js';
import { findRepoRoot, getDb, indexDirectory, indexFile, ensureIndexFresh, impactQuery, snapshotSymbol, getVersionHistory, getVersionText, restoreVersion, getSessionId, pruneOldSessions } from '../core/symbol-index.js';
import { CHAR_BUDGET } from '../core/shared.js';
import { stashEdits } from '../core/stash.js';

// Validate a repo-relative path cannot escape the repo root before resolving.
function resolveRepoPath(repoRoot, relPath) {
    const normalRoot = path.resolve(repoRoot); // nosemgrep
    const resolved = path.resolve(normalRoot, relPath); // nosemgrep
    if (!resolved.startsWith(normalRoot + path.sep) && resolved !== normalRoot) {
        throw new Error('Path out of repository bounds.');
    }
    return resolved;
}

// Edit retry cache moved to ../core/stash.js

// ---------------------------------------------------------------------------
// Batch session state
// ---------------------------------------------------------------------------

const _batchSession = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

async function getOrCreateSession(filePath, ctx, clientSessionId) {
    const repoRoot = findRepoRoot(filePath);
    if (!repoRoot) throw new Error('Not a git repository.');


    const sessionId = getSessionId(clientSessionId);
    const existing = _batchSession.get(sessionId);
    if (existing && existing.repoRoot === repoRoot &&
        (Date.now() - existing.timestamp) < SESSION_TTL_MS) {
        existing.timestamp = Date.now();
        return existing;
    }
    const db = getDb(repoRoot);
    pruneOldSessions(db, sessionId);
    // Await on fresh DB so index is populated before first impact query.
    // On subsequent calls, update incrementally in background.
    const fileCount = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
    if (fileCount === 0) {
        await indexDirectory(db, repoRoot, repoRoot, { maxFiles: 5000 });
    } else {
        indexDirectory(db, repoRoot, repoRoot, { maxFiles: 5000 }).catch(() => {});
    }
    const session = {
        stage: 0,
        repoRoot,
        db,
        impactResults: [],
        loadedGroups: [],
        editPayloadCache: new Map(),
        retryCount: new Map(),
        timestamp: Date.now(),
        clientSessionId,
    };
    _batchSession.set(sessionId, session);
    return session;
}

// ---------------------------------------------------------------------------
// Edit payload parser — locates headers by pattern, takes everything between
// them as the function body.
// ---------------------------------------------------------------------------

function parseEditPayload(edit) {
    // Accept both canonical plain format and backward-compatible bracketed format:
    //   symbolName 1,2 rel/path.ts     (canonical — plain indices)
    //   symbolName [1,2] rel/path.ts   (bracketed — emitted by loadDiff display)
    // Group 1 = symbolName, group 2 = bracketed indices, group 3 = plain indices
    const headerRe = /^(\S+)\s+(?:\[([\d,]+)\]|(\d[\d,]*)(?:\s|$))/;
    const lines = edit.split('\n');
    const groups = [];
    let current = null;

    for (const line of lines) {
        const m = line.match(headerRe);
        if (m) {
            if (current) {
                current.body = trimBodyLines(current.bodyLines);
                groups.push(current);
            }
            const indicesStr = m[2] ?? m[3];
            current = {
                symbolName: m[1],
                indices: indicesStr ? indicesStr.split(',').map(n => parseInt(n, 10)) : [],
                bodyLines: [],
            };
        } else if (current) {
            current.bodyLines.push(line);
        }
    }
    if (current) {
        current.body = trimBodyLines(current.bodyLines);
        groups.push(current);
    }
    return groups;
}

function trimBodyLines(lines) {
    let start = 0;
    let end = lines.length - 1;
    while (start <= end && lines[start].trim() === '') start++;
    while (end >= start && lines[end].trim() === '') end--;
    return lines.slice(start, end + 1).join('\n');
}

// ---------------------------------------------------------------------------
// Shared diff loading (Load branch and Symbols skip-ahead branch)
// ---------------------------------------------------------------------------

async function loadDiff(session, targetedEntries, excludeLines, range) {
    const contextLines = typeof range === 'number' && range >= 0 ? range : 5;
    const { db, repoRoot } = session;

    // Freshness check on targeted files
    const uniqueFiles = [...new Set(
        targetedEntries.filter(e => e.filePath).map(e => resolveRepoPath(repoRoot, e.filePath))
    )];
    if (uniqueFiles.length > 0) {
        await ensureIndexFresh(db, repoRoot, uniqueFiles);
    }

    // Build occurrence groups keyed by symbol name
    const groupMap = new Map();


    for (const entry of targetedEntries) {
        if (!entry.filePath) continue;
        const absFilePath = resolveRepoPath(repoRoot, entry.filePath);

        let source;
        try {
            source = normalizeLineEndings(await fs.readFile(absFilePath, 'utf-8')); // nosemgrep
        } catch {
            continue;
        }

        const langName = getLangForFile(absFilePath);
        if (!langName) continue;

        const syms = await findSymbol(source, langName, entry.name, { kindFilter: 'def' });
        if (!syms || syms.length === 0) continue;

        for (const sym of syms) {
            if (excludeLines && excludeLines.includes(sym.line)) continue;

            const lines = source.split('\n');
            const ctxStart = Math.max(0, sym.line - 1 - contextLines);
            const ctxEnd = Math.min(lines.length, sym.endLine + contextLines);
            const body = lines.slice(ctxStart, ctxEnd).join('\n');

            if (!groupMap.has(entry.name)) {
                groupMap.set(entry.name, { symbolName: entry.name, occurrences: [] });
            }
            groupMap.get(entry.name).occurrences.push({
                index: groupMap.get(entry.name).occurrences.length + 1,
                absFilePath,
                relFilePath: entry.filePath,
                startLine: sym.line,
                endLine: sym.endLine,
                body,
                warning: null,
            });
        }
    }

    // Outlier detection within each group
    for (const [, group] of groupMap) {
        if (group.occurrences.length < 2) continue;
        const occs = group.occurrences;
        const refFirst = occs[0].body.split('\n')[0];
        const refLen = occs[0].body.split('\n').length;
        const refParams = (refFirst.match(/,/g) || []).length + 1;

        for (let i = 1; i < occs.length; i++) {
            const first = occs[i].body.split('\n')[0]; // nosemgrep
            const len = occs[i].body.split('\n').length; // nosemgrep
            const params = (first.match(/,/g) || []).length + 1;
            let warning = null;
            if (Math.abs(params - refParams) / Math.max(refParams, 1) > 0.3) {
                warning = 'signature differs';
            } else if (Math.abs(len - refLen) / Math.max(refLen, 1) > 0.3) {
                warning = 'body diverges';
            }
            occs[i].warning = warning; // nosemgrep
        }
    }

    // Bonus 4: scope summary line
    const fileSummary = new Map();
    for (const [, group] of groupMap) {
        for (const occ of group.occurrences) {
            fileSummary.set(occ.relFilePath, (fileSummary.get(occ.relFilePath) || 0) + 1);
        }
    }
    const summaryLine = [...fileSummary.entries()].map(([f, n]) => `${n} in ${f}`).join(', ');

    // Assemble diff document with budget enforcement
    const outputParts = [];
    let charCount = summaryLine.length + 1;
    let loadedCount = 0;
    let truncated = false;
    let totalCount = 0;

    for (const [, group] of groupMap) totalCount += group.occurrences.length;

    // Track only occurrences actually emitted within the char budget.
    const emittedGroupMap = new Map();

    outer: for (const [, group] of groupMap) {
        for (const occ of group.occurrences) {
            const header = `${group.symbolName} [${occ.index}] ${occ.relFilePath}${occ.warning ? ` \u26a0 ${occ.warning}` : ''}`;
            const block = `${header}\n\n${occ.body}\n`;

            if (charCount + block.length > CHAR_BUDGET) {
                truncated = true;
                break outer;
            }

            outputParts.push(block);
            charCount += block.length;
            loadedCount++;

            if (!emittedGroupMap.has(group.symbolName)) {
                emittedGroupMap.set(group.symbolName, { symbolName: group.symbolName, occurrences: [] });
            }
            emittedGroupMap.get(group.symbolName).occurrences.push(occ);
        }
    }

    // Persist emitted occurrences. Append to existing if continuing from truncation.
    const newGroups = [...emittedGroupMap.values()];
    if (session.stage === 2 && session.loadedGroups) {
        for (const ng of newGroups) {
            const existing = session.loadedGroups.find(g => g.symbolName === ng.symbolName);
            if (existing) {
                existing.occurrences.push(...ng.occurrences);
            } else {
                session.loadedGroups.push(ng);
            }
        }
    } else {
        session.loadedGroups = newGroups;
    }
    session.stage = 2;

    // Store deferred entries for pagination
    if (truncated) {
        const deferred = [];
        let pastEmitted = false;
        for (const [, group] of groupMap) {
            for (const occ of group.occurrences) {
                if (!emittedGroupMap.has(group.symbolName) ||
                    !emittedGroupMap.get(group.symbolName).occurrences.includes(occ)) {
                    deferred.push({ name: group.symbolName, filePath: occ.filePath });
                }
            }
        }
        session.deferredEntries = deferred;
    } else {
        session.deferredEntries = null;
    }

    const parts = [];
    if (summaryLine) parts.push(summaryLine);
    parts.push(...outputParts);
    if (truncated) parts.push(`${loadedCount} of ${totalCount} loaded. Send load again for remaining.`);

    return { content: [{ type: 'text', text: parts.join('\n') }] };
}

// ---------------------------------------------------------------------------
// Existing content-match helpers
// ---------------------------------------------------------------------------

function findMatch(content, oldText, nearLine) {
    const normalizedOld = normalizeLineEndings(oldText);

    // Strategy 1: Exact match
    const exactIdx = findOccurrence(content, normalizedOld, nearLine);
    if (exactIdx !== -1) {
        return { index: exactIdx, matchedText: normalizedOld, strategy: 'exact' };
    }

    // Strategy 2: Trimmed trailing whitespace match
    const contentLinesTrimmed = content.split('\n').map(l => l.trimEnd());
    const oldLinesTrimmed = normalizedOld.split('\n').map(l => l.trimEnd());
    const trimmedContent = contentLinesTrimmed.join('\n');
    const trimmedOld = oldLinesTrimmed.join('\n');
    const trimIdx = findOccurrence(trimmedContent, trimmedOld, nearLine);
    if (trimIdx !== -1) {
        const origIdx = mapTrimmedIndex(content, trimmedContent, trimIdx, trimmedOld.length);
        if (origIdx !== -1) {
            const endPos = findOriginalEnd(content, origIdx, oldLinesTrimmed.length);
            return { index: origIdx, matchedText: content.slice(origIdx, endPos), strategy: 'trim-trailing' };
        }
    }

    // Strategy 3: Indentation-stripped match
    const oldLines = normalizedOld.split('\n');
    const contentLines = content.split('\n');
    const strippedOld = oldLines.map(l => l.trim());

    const searchStart = nearLine ? Math.max(0, nearLine - 50) : 0;
    const searchEnd = nearLine ? Math.min(contentLines.length, nearLine + 50) : contentLines.length;

    for (let i = searchStart; i <= searchEnd - strippedOld.length; i++) {
        let isMatch = true;
        for (let j = 0; j < strippedOld.length; j++) {
            if (contentLines[i + j].trim() !== strippedOld[j]) { // nosemgrep
                isMatch = false;
                break;
            }
        }
        if (isMatch) {
            const matchedLines = contentLines.slice(i, i + strippedOld.length);
            const beforeLines = contentLines.slice(0, i);
            const idx = beforeLines.join('\n').length + (beforeLines.length > 0 ? 1 : 0);
            return { index: idx, matchedText: matchedLines.join('\n'), strategy: 'indent-stripped' };
        }
    }

    return null;
}

function findOccurrence(haystack, needle, nearLine) {
    if (!nearLine) {
        return haystack.indexOf(needle);
    }

    const occurrences = [];
    let pos = 0;
    while (true) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) break;
        occurrences.push(idx);
        pos = idx + 1;
    }

    if (occurrences.length === 0) return -1;
    if (occurrences.length === 1) return occurrences[0];

    let best = occurrences[0];
    let bestDist = Infinity;
    for (const idx of occurrences) {
        const lineNum = haystack.slice(0, idx).split('\n').length;
        const dist = Math.abs(lineNum - nearLine);
        if (dist < bestDist) {
            bestDist = dist;
            best = idx;
        }
    }
    return best;
}

function mapTrimmedIndex(original, trimmed, trimmedIdx, trimmedLen) {
    const trimmedBefore = trimmed.slice(0, trimmedIdx);
    const lineNum = trimmedBefore.split('\n').length - 1;
    const normalizedOrig = normalizeLineEndings(original);
    const origLines = normalizedOrig.split('\n');
    let origIdx = 0;
    for (let i = 0; i < lineNum; i++) {
        origIdx += origLines[i].length + 1; // nosemgrep
    }
    return origIdx;
}

function findOriginalEnd(content, startIdx, numLines) {
    let pos = startIdx;
    for (let i = 0; i < numLines; i++) {
        const nextNewline = content.indexOf('\n', pos);
        if (nextNewline === -1) return content.length;
        pos = nextNewline + 1;
    }
    return pos - 1;
}

function generateDiagnostic(content, oldText, editIndex, isBatch) {
    const tag = isBatch ? `Edit #${editIndex + 1}: ` : '';
    const oldLines = normalizeLineEndings(oldText).split('\n');
    const firstOldLine = oldLines[0].trim();
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().includes(firstOldLine) || // nosemgrep
            (lines[i].trim().length > 5 && firstOldLine.includes(lines[i].trim()))) { // nosemgrep
            return `${tag}oldContent not found. Near line ${i + 1}.`;
        }
    }

    for (const oldLine of oldLines) {
        const trimmed = oldLine.trim();
        if (!trimmed) continue;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(trimmed)) { // nosemgrep
                return `${tag}oldContent not found. Near line ${i + 1}.`;
            }
        }
    }

    return `${tag}oldContent not found.`;
}

// Export batch helpers for stashApply tool
export { _batchSession, getOrCreateSession, parseEditPayload, loadDiff, resolveRepoPath, findMatch, generateDiagnostic };

export function register(server, ctx) {
    server.registerTool("edit_file", {
        title: "Edit File",
        description: "Edit a text file by block, content match, or symbol name.",
        inputSchema: {
            path: z.string().describe("File to edit."),
            edits: z.array(z.object({
                block_start: z.string().optional().describe("First line of the block to replace. Use with block_end + replacement_block."),
                block_end: z.string().optional().describe("Last line of the block to replace."),
                replacement_block: z.string().optional().describe("Replacement for the matched block."),
                oldContent: z.string().optional().describe("Exact text to find. Use with newContent."),
                newContent: z.string().optional().describe("Replacement text."),
                symbol: z.string().optional().describe("Symbol name. Dot-qualified for methods. Use with newText."),
                newText: z.string().optional().describe("Replacement for the symbol."),
                nearLine: z.number().optional().describe("Approximate line. Symbol disambiguation only."),
            })),
            dryRun: z.boolean().default(false).describe("Preview without writing."),
        },
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {
        const validPath = await ctx.validatePath(args.path);
        const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);

        if (!args.edits || args.edits.length === 0) throw new Error('No edits provided.');

        const originalContent = normalizeLineEndings(await fs.readFile(validPath, 'utf-8')); // nosemgrep
        let workingContent = originalContent;
        const isBatch = args.edits.length > 1;
        const errors = [];

        for (let i = 0; i < args.edits.length; i++) {
            const edit = args.edits[i]; // nosemgrep
            const tag = isBatch ? `#${i + 1}: ` : '';

            // ---- BLOCK REPLACE MODE ----
            if (edit.block_start || edit.block_end) {
                if (!edit.block_start || !edit.block_end) { errors.push({ i, msg: `${tag}Both block_start and block_end required.` }); continue; }
                if (edit.replacement_block === undefined) { errors.push({ i, msg: `${tag}replacement_block required.` }); continue; }

                const lines = workingContent.split('\n');
                const expectedStart = edit.block_start.trim();
                const expectedEnd = edit.block_end.trim();

                // Find all matching start/end pairs
                const candidates = [];
                for (let s = 0; s < lines.length; s++) {
                    if (lines[s].trim() !== expectedStart) continue;
                    for (let e = s; e < lines.length; e++) {
                        if (lines[e].trim() !== expectedEnd) continue;
                        candidates.push({ start: s, end: e });
                        break; // first end match per start
                    }
                }

                if (candidates.length === 0) {
                    errors.push({ i, msg: `${tag}block_start not found in file.` }); continue;
                }

                let chosen;
                if (candidates.length === 1) {
                    chosen = candidates[0];
                } else {
                    // Ambiguous — stash and return candidates with line numbers
                    const failedIndices = [i];
                    const stashId = stashEdits(ctx, validPath, args.edits, failedIndices);
                    const locs = candidates.map(c => `lines ${c.start + 1}-${c.end + 1}`).join(', ');
                    throw new Error(`${tag}Multiple matches: ${locs}. stash:${stashId}\nUse stashRestore with startLine to disambiguate.`);
                }

                const normalizedNew = normalizeLineEndings(edit.replacement_block);
                lines.splice(chosen.start, chosen.end - chosen.start + 1, ...normalizedNew.split('\n'));
                workingContent = lines.join('\n');
                continue;
            }

            // ---- SYMBOL-BASED EDIT MODE ----
            if (edit.symbol) {
                if (edit.oldContent) { errors.push({ i, msg: `${tag}symbol mode is exclusive.` }); continue; }
                if (edit.newText === undefined) { errors.push({ i, msg: `${tag}newText required.` }); continue; }

                const langName = getLangForFile(validPath);
                if (!langName) { errors.push({ i, msg: `${tag}Unsupported file type.` }); continue; }

                const symbolMatches = await findSymbol(workingContent, langName, edit.symbol, {
                    kindFilter: 'def', nearLine: edit.nearLine,
                });
                if (!symbolMatches || symbolMatches.length === 0) { errors.push({ i, msg: `${tag}Symbol not found.` }); continue; }
                if (symbolMatches.length > 1 && !edit.nearLine) { errors.push({ i, msg: `${tag}Multiple matches. Use nearLine.` }); continue; }

                const sym = symbolMatches[0];
                const lines = workingContent.split('\n');
                const normalizedNew = normalizeLineEndings(edit.newText);
                lines.splice(sym.line - 1, sym.endLine - (sym.line - 1), ...normalizedNew.split('\n'));
                workingContent = lines.join('\n');
                continue;
            }

            // ---- CONTENT MATCH MODE ----
            if (!edit.oldContent) { errors.push({ i, msg: `${tag}Provide block_start/block_end, oldContent, or symbol.` }); continue; }

            const match = findMatch(workingContent, edit.oldContent, edit.nearLine);
            if (!match) { errors.push({ i, msg: generateDiagnostic(workingContent, edit.oldContent, i, isBatch) }); continue; }
            if (edit.newContent === undefined) { errors.push({ i, msg: `${tag}newContent required.` }); continue; }

            const normalizedNew = normalizeLineEndings(edit.newContent);
            if (match.strategy === 'indent-stripped') {
                const matchedLines = match.matchedText.split('\n');
                const newLines = normalizedNew.split('\n');
                const originalIndent = matchedLines[0].match(/^\s*/)?.[0] || '';
                const oldIndent = normalizeLineEndings(edit.oldContent).split('\n')[0].match(/^\s*/)?.[0] || '';
                const reindentedNew = newLines.map((line, j) => {
                    if (j === 0) return originalIndent + line.trimStart();
                    const lineIndent = line.match(/^\s*/)?.[0] || '';
                    const relIndent = lineIndent.length - (oldIndent?.length || 0);
                    return originalIndent + ' '.repeat(Math.max(0, relIndent)) + line.trimStart();
                }).join('\n');
                workingContent = workingContent.slice(0, match.index) + reindentedNew + workingContent.slice(match.index + match.matchedText.length);
            } else {
                workingContent = workingContent.slice(0, match.index) + normalizedNew + workingContent.slice(match.index + match.matchedText.length);
            }
        }

        // All-or-nothing: if any failed, stash everything and commit nothing
        if (errors.length > 0) {
            const failedIndices = errors.map(e => e.i);
            const stashId = stashEdits(ctx, validPath, args.edits, failedIndices);
            const failMsg = errors.map(e => `#${e.i + 1}: ${e.msg}`).join('\n');
            throw new Error(`${errors.length} failed, 0 applied. stash:${stashId}\n${failMsg}`);
        }

        // All succeeded — write file
        if (!args.dryRun) {
            const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
            try {
                await fs.writeFile(tempPath, workingContent, 'utf-8'); // nosemgrep
                await fs.rename(tempPath, validPath); // nosemgrep
            } catch (error) {
                try { await fs.unlink(tempPath); } catch { /* ignore */ } // nosemgrep
                throw error;
            }
        }

        if (args.dryRun) {
            const patch = createMinimalDiff(originalContent, workingContent, validPath);
            return { content: [{ type: "text", text: JSON.stringify({ dryRun: true, diff: patch }) }] };
        }

        // Post-edit AST error detection
        let syntaxWarning = '';
        try {
            const ext = path.extname(validPath).toLowerCase();
            const lossyAliases = ['.scss', '.mdx', '.jsonc'];
            if (!lossyAliases.includes(ext)) {
                const langName = getLangForFile(validPath);
                if (langName) {
                    const syntaxErrors = await checkSyntaxErrors(workingContent, langName);
                    if (syntaxErrors && syntaxErrors.length > 0) {
                        const locations = syntaxErrors.map(e => `${e.line}:${e.column}`).join(', ');
                        syntaxWarning = `\n\u26a0 Parse errors at lines ${locations}`;
                    }
                }
            }
        } catch { /* best-effort */ }

        return { content: [{ type: "text", text: `Applied.${syntaxWarning}` }] };
    });
}


