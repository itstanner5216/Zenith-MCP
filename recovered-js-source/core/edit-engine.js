import path from 'path';
import { normalizeLineEndings } from '../core/lib.js';
import { getLangForFile, findSymbol, checkSyntaxErrors } from '../core/tree-sitter.js';

// ---------------------------------------------------------------------------
// Content-match helpers (lifted verbatim from edit_file.js lines 283-409)
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

// ---------------------------------------------------------------------------
// applyEditList — pure function, no I/O
// ---------------------------------------------------------------------------

async function applyEditList(content, edits, { filePath, isBatch, disambiguations } = {}) {
    let workingContent = content;
    const errors = [];
    const pendingSnapshots = [];

    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const tag = isBatch ? `#${i + 1}: ` : '';

        // BLOCK mode
        if (edit.mode === 'block') {
            const lines = workingContent.split('\n');
            const expectedStart = edit.block_start.trim();
            const expectedEnd = edit.block_end.trim();

            const candidates = [];
            for (let s = 0; s < lines.length; s++) {
                if (lines[s].trim() !== expectedStart) continue;
                for (let e = s; e < lines.length; e++) {
                    if (lines[e].trim() !== expectedEnd) continue;
                    candidates.push({ start: s, end: e });
                    break;
                }
            }

            if (candidates.length === 0) {
                errors.push({ i, msg: `${tag}block_start not found in file.` });
                continue;
            }

            let chosen;
            if (candidates.length === 1) {
                chosen = candidates[0];
            } else {
                // Check disambiguations map
                const dis = disambiguations?.get(i);
                if (dis?.startLine !== undefined) {
                    chosen = candidates.find(c => c.start === dis.startLine - 1);
                    if (!chosen) {
                        errors.push({ i, msg: `${tag}no match at line ${dis.startLine}.` });
                        continue;
                    }
                } else {
                    const locs = candidates.map(c => `lines ${c.start + 1}-${c.end + 1}`).join(', ');
                    errors.push({ i, msg: `${tag}Ambiguous: ${locs}.` });
                    continue;
                }
            }

            const normalizedNew = normalizeLineEndings(edit.replacement_block);
            lines.splice(chosen.start, chosen.end - chosen.start + 1, ...normalizedNew.split('\n'));
            workingContent = lines.join('\n');
            continue;
        }

        // SYMBOL mode
        if (edit.mode === 'symbol') {
            const dis = disambiguations?.get(i);
            const nearLine = dis?.nearLine ?? edit.nearLine;
            const langName = getLangForFile(filePath);
            if (!langName) {
                errors.push({ i, msg: `${tag}Unsupported file type.` });
                continue;
            }
            const symbolMatches = await findSymbol(workingContent, langName, edit.symbol, {
                kindFilter: 'def', nearLine,
            });
            if (!symbolMatches?.length) {
                errors.push({ i, msg: `${tag}Symbol not found.` });
                continue;
            }
            if (symbolMatches.length > 1 && !nearLine) {
                errors.push({ i, msg: `${tag}Multiple matches. Use nearLine.` });
                continue;
            }
            const sym = symbolMatches[0];
            const lines = workingContent.split('\n');
            const originalText = lines.slice(sym.line - 1, sym.endLine).join('\n');
            const normalizedNew = normalizeLineEndings(edit.newText);
            lines.splice(sym.line - 1, sym.endLine - (sym.line - 1), ...normalizedNew.split('\n'));
            workingContent = lines.join('\n');
            pendingSnapshots.push({
                symbol: edit.symbol,
                originalText,
                line: sym.line,
                filePath: filePath,
            });
            continue;
        }

        // CONTENT mode
        if (edit.mode === 'content') {
            const dis = disambiguations?.get(i);
            const nearLine = dis?.nearLine ?? edit.nearLine;
            const match = findMatch(workingContent, edit.oldContent, nearLine);
            if (!match) {
                errors.push({ i, msg: generateDiagnostic(workingContent, edit.oldContent, i, isBatch) });
                continue;
            }
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
            continue;
        }
    }

    return { workingContent, errors, pendingSnapshots };
}

// ---------------------------------------------------------------------------
// syntaxWarn — pure computation, no I/O
// ---------------------------------------------------------------------------

async function syntaxWarn(filePath, content) {
    try {
        const ext = path.extname(filePath).toLowerCase();
        if (['.scss', '.mdx', '.jsonc'].includes(ext)) return '';
        const langName = getLangForFile(filePath);
        if (!langName) return '';
        const syntaxErrors = await checkSyntaxErrors(content, langName);
        if (!syntaxErrors?.length) return '';
        const locations = syntaxErrors.map(e => `${e.line}:${e.column}`).join(', ');
        return `\n⚠ Parse errors at lines ${locations}`;
    } catch {
        return '';
    }
}

export { findMatch, applyEditList, syntaxWarn };
