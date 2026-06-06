import path from 'path';
import { normalizeLineEndings } from '../core/lib.js';
import { getLangForFile, checkSyntaxErrors } from '../core/tree-sitter.js';
// Edit-engine is a SYMBOL-FACT CONSUMER. Per docs/toon-constraints §0.5
// symbol facts come from the DB-backed adapter, never the tree-sitter
// extractor. The only call site allowed to extract directly is the
// ingestion path in `./symbol-index.ts`.
//
// Known limitation: this consumer applies edits to an in-flight buffer
// (`workingContent`) that mutates between symbol-mode edits in the
// same applyEditList run. The DB reflects the last-indexed disk state,
// not the in-memory buffer, so successive symbol-mode edits in one run
// may target lines that have shifted. That is an edit-engine concern
// to address separately (e.g. pre-resolve all symbol ranges before any
// edit applies, with line-shift accounting between iterations) and is
// NOT a license to keep this site on direct extraction.
import { loadSymbolInFile } from '../core/indexed-symbols.js';

// ---------------------------------------------------------------------------
// Edit interfaces
// ---------------------------------------------------------------------------

export interface Edit {
    filePath?: string;
    oldText?: string;
    newText?: string;
    isBatch?: boolean;
    disambiguations?: Map<number, { startLine?: number; nearLine?: number }>;
    mode?: 'block' | 'symbol' | 'content';
    block_start?: string;
    block_end?: string;
    replacement_block?: string;
    nearLine?: number;
    symbol?: string;
    oldContent?: string;
    newContent?: string;
}

interface ApplyEditListOptions {
    filePath?: string;
    isBatch?: boolean;
    disambiguations?: Map<number, { startLine?: number; nearLine?: number }>;
}

interface MatchResult {
    index: number;
    matchedText: string;
    strategy: 'exact' | 'trim-trailing' | 'indent-stripped';
}

interface PendingSnapshot {
    symbol: string | undefined;
    originalText: string;
    line: number;
    filePath: string | undefined;
}

interface EditError {
    i: number;
    msg: string;
}

// ---------------------------------------------------------------------------
// Content-match helpers (lifted verbatim from edit_file.js lines 283-409)
// ---------------------------------------------------------------------------

function findMatch(content: string, oldText: string, nearLine: number | undefined): MatchResult | null {
    const normalizedOld = normalizeLineEndings(oldText);

    // Strategy 1: Exact match
    const exactIdx = findOccurrence(content, normalizedOld, nearLine);
    if (exactIdx !== -1) {
        return { index: exactIdx, matchedText: normalizedOld, strategy: 'exact' };
    }

    // Strategy 2: Trimmed trailing whitespace match
    const contentLinesTrimmed = content.split('\n').map((l: string) => l.trimEnd());
    const oldLinesTrimmed = normalizedOld.split('\n').map((l: string) => l.trimEnd());
    const trimmedContent = contentLinesTrimmed.join('\n');
    const trimmedOld = oldLinesTrimmed.join('\n');
    const trimIdx = findOccurrence(trimmedContent, trimmedOld, nearLine);
    if (trimIdx !== -1) {
        const origIdx = mapTrimmedIndex(content, trimmedContent, trimIdx);
        if (origIdx !== -1) {
            const endPos = findOriginalEnd(content, origIdx, oldLinesTrimmed.length);
            return { index: origIdx, matchedText: content.slice(origIdx, endPos), strategy: 'trim-trailing' };
        }
    }

    // Strategy 3: Indentation-stripped match
    const oldLines = normalizedOld.split('\n');
    const contentLines = content.split('\n');
    const strippedOld = oldLines.map((l: string) => l.trim());

    const searchStart = nearLine ? Math.max(0, nearLine - 50) : 0;
    const searchEnd = nearLine ? Math.min(contentLines.length, nearLine + 50) : contentLines.length;

    for (let i = searchStart; i <= searchEnd - strippedOld.length; i++) {
        let isMatch = true;
        for (let j = 0; j < strippedOld.length; j++) {
            if (contentLines[i + j]!.trim() !== strippedOld[j]) { // nosemgrep
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

function findOccurrence(haystack: string, needle: string, nearLine: number | undefined): number {
    if (!nearLine) {
        return haystack.indexOf(needle);
    }

    const occurrences: number[] = [];
    let pos = 0;
    while (true) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) break;
        occurrences.push(idx);
        pos = idx + 1;
    }

    if (occurrences.length === 0) return -1;
    if (occurrences.length === 1) return occurrences[0]!;

    let best = occurrences[0]!;
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

function mapTrimmedIndex(original: string, trimmed: string, trimmedIdx: number): number {
    const normalizedOrig = normalizeLineEndings(original);
    const trimmedBefore = trimmed.slice(0, trimmedIdx);

    const lineNum = trimmedBefore.split('\n').length - 1;
    const lastNewline = trimmedBefore.lastIndexOf('\n');
    const trimmedColumn = lastNewline === -1
        ? trimmedBefore.length
        : trimmedBefore.length - lastNewline - 1;

    const origLines = normalizedOrig.split('\n');
    let origIdx = 0;
    for (let i = 0; i < lineNum; i++) {
        origIdx += origLines[i]!.length + 1; // nosemgrep
    }

    // Map the column: the trimmed column maps to the same column in the original
    // (trailing whitespace is only removed from the end, not the start)
    const originalLine = origLines[lineNum] ?? '';
    const boundedColumn = Math.min(trimmedColumn, originalLine.length);
    return origIdx + boundedColumn;
}

function findOriginalEnd(content: string, startIdx: number, numLines: number): number {
    let pos = startIdx;
    for (let i = 0; i < numLines; i++) {
        const nextNewline = content.indexOf('\n', pos);
        if (nextNewline === -1) return content.length;
        pos = nextNewline + 1;
    }
    return pos - 1;
}

function generateDiagnostic(content: string, oldText: string, editIndex: number, isBatch: boolean | undefined): string {
    const tag = isBatch ? `Edit #${editIndex + 1}: ` : '';
    const oldLines = normalizeLineEndings(oldText).split('\n');
    const firstOldLine = oldLines[0]!.trim();
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trim().includes(firstOldLine) || // nosemgrep
            (lines[i]!.trim().length > 5 && firstOldLine.includes(lines[i]!.trim()))) { // nosemgrep
            return `${tag}oldContent not found. Near line ${i + 1}.`;
        }
    }

    for (const oldLine of oldLines) {
        const trimmed = oldLine.trim();
        if (!trimmed) continue;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i]!.includes(trimmed)) { // nosemgrep
                return `${tag}oldContent not found. Near line ${i + 1}.`;
            }
        }
    }

    return `${tag}oldContent not found.`;
}

// ---------------------------------------------------------------------------
// applyEditList — pure function, no I/O
// ---------------------------------------------------------------------------

async function applyEditList(content: string, edits: Edit[], { filePath, isBatch, disambiguations }: ApplyEditListOptions = {}): Promise<{ workingContent: string; errors: EditError[]; pendingSnapshots: PendingSnapshot[] }> {
    let workingContent = content;
    const errors: EditError[] = [];
    const pendingSnapshots: PendingSnapshot[] = [];

    for (const [i, edit] of edits.entries()) {
        const tag = isBatch ? `#${i + 1}: ` : '';

        // BLOCK mode
        if (edit.mode === 'block') {
            if (!edit.block_start || !edit.block_end || edit.replacement_block === undefined) {
                errors.push({
                    i,
                    msg: `${tag}block mode requires block_start, block_end, and replacement_block.`,
                });
                continue;
            }

            const lines = workingContent.split('\n');

            // Support multi-line block_start / block_end:
            // Extract the first line as the start anchor, last line as the end anchor.
            // Any intermediate lines from the input are used as verification
            // to filter false-positive candidates.
            const startInputLines = normalizeLineEndings(edit.block_start).split('\n');
            const endInputLines = normalizeLineEndings(edit.block_end).split('\n');
            const anchorStart = startInputLines[0]!.trim();
            const anchorEnd = endInputLines[endInputLines.length - 1]!.trim();

            // Collect intermediate lines for verification (all lines between
            // the first line of block_start and the last line of block_end).
            // These must appear in order within the candidate range.
            const verifyLines: string[] = [];
            for (let v = 1; v < startInputLines.length; v++) {
                const trimmed = startInputLines[v]!.trim();
                if (trimmed) verifyLines.push(trimmed);
            }
            for (let v = 0; v < endInputLines.length - 1; v++) {
                const trimmed = endInputLines[v]!.trim();
                if (trimmed) verifyLines.push(trimmed);
            }

            const candidates: Array<{ start: number; end: number }> = [];
            for (let s = 0; s < lines.length; s++) {
                if (lines[s]!.trim() !== anchorStart) continue;
                for (let e = s; e < lines.length; e++) {
                    if (lines[e]!.trim() !== anchorEnd) continue;
                    // Verify intermediate lines exist in order within [s, e]
                    if (verifyLines.length > 0) {
                        let vi = 0;
                        for (let k = s + 1; k < e && vi < verifyLines.length; k++) {
                            if (lines[k]!.trim() === verifyLines[vi]) vi++;
                        }
                        if (vi < verifyLines.length) continue; // intermediate verification failed
                    }
                    candidates.push({ start: s, end: e });
                    break;
                }
            }

            if (candidates.length === 0) {
                errors.push({ i, msg: `${tag}block_start not found in file.` });
                continue;
            }

            let chosen: { start: number; end: number } | undefined;
            if (candidates.length === 1) {
                chosen = candidates[0]!;
            } else {
                // Check disambiguations map (from stashRestore corrections)
                const dis = disambiguations?.get(i);
                if (dis?.startLine !== undefined) {
                    chosen = candidates.find(c => c.start === dis.startLine! - 1);
                    if (!chosen) {
                        errors.push({ i, msg: `${tag}no match at line ${dis.startLine}.` });
                        continue;
                    }
                } else {
                    // Preemptive disambiguation via nearLine: pick the closest
                    // candidate without requiring a stash round-trip
                    const nearLine = dis?.nearLine ?? edit.nearLine;
                    if (nearLine !== undefined) {
                        candidates.sort((a, b) =>
                            Math.abs(a.start - (nearLine - 1)) - Math.abs(b.start - (nearLine - 1))
                        );
                        chosen = candidates[0]!;
                    } else {
                        const locs = candidates.map(c => `lines ${c.start + 1}-${c.end + 1}`).join(', ');
                        errors.push({ i, msg: `${tag}Ambiguous: ${locs}. Provide startLine or nearLine.` });
                        continue;
                    }
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
            // Symbol-mode edits require a file path: the DB-backed lookup
            // below (`loadSymbolInFile`) needs an absolute on-disk path to
            // identify the file in the symbol index. Previously this was
            // implicit — `getLangForFile(undefined)` would have returned
            // null and triggered the same "Unsupported file type" branch.
            // Now we surface the precondition explicitly so the type
            // system can prove it before the DB call.
            if (filePath === undefined) {
                errors.push({ i, msg: `${tag}Unsupported file type.` });
                continue;
            }
            const langName = getLangForFile(filePath);
            if (!langName) {
                errors.push({ i, msg: `${tag}Unsupported file type.` });
                continue;
            }
            const findSymbolOpts: { kindFilter: string; nearLine?: number } = { kindFilter: 'def' };
            if (nearLine !== undefined) findSymbolOpts.nearLine = nearLine;
            // DB-backed read: locate the symbol via the indexed
            // symbol-index for `filePath`. `loadSymbolInFile` ensures the
            // file is freshly indexed (re-parses if the on-disk hash
            // changed) before querying. Returns null when no repo root
            // can be located for the file (e.g. file outside any known
            // project) — that's the same user-facing surface as the
            // prior "symbol queries not available" branch.
            const symbolMatches = await loadSymbolInFile(filePath, edit.symbol!, findSymbolOpts);
            if (symbolMatches === null) {
                errors.push({ i, msg: `${tag}Symbol queries not available for ${langName}. Use block or content mode instead.` });
                continue;
            }
            if (symbolMatches.length === 0) {
                errors.push({ i, msg: `${tag}Symbol not found.` });
                continue;
            }
            if (symbolMatches.length > 1 && !nearLine) {
                errors.push({ i, msg: `${tag}Multiple matches. Use nearLine.` });
                continue;
            }
            const sym = symbolMatches[0];
            if (sym === undefined) {
                errors.push({ i, msg: `${tag}Symbol not found.` });
                continue;
            }
            const lines = workingContent.split('\n');
            const originalText = lines.slice(sym.line - 1, sym.endLine).join('\n');
            const normalizedNew = normalizeLineEndings(edit.newText!);
            lines.splice(sym.line - 1, sym.endLine - (sym.line - 1), ...normalizedNew.split('\n'));
            workingContent = lines.join('\n');
            pendingSnapshots.push({
                symbol: edit.symbol!,
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
            const match = findMatch(workingContent, edit.oldContent!, nearLine);
            if (!match) {
                errors.push({ i, msg: generateDiagnostic(workingContent, edit.oldContent!, i, isBatch) });
                continue;
            }
            const normalizedNew = normalizeLineEndings(edit.newContent!);
            if (match.strategy === 'indent-stripped') {
                const matchedLines = match.matchedText.split('\n');
                const newLines = normalizedNew.split('\n');
                const originalIndent = matchedLines[0]!.match(/^\s*/)?.[0] || '';
                const oldIndent = normalizeLineEndings(edit.oldContent!).split('\n')[0]!.match(/^\s*/)?.[0] || '';
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

async function syntaxWarn(filePath: string, content: string): Promise<string> {
    try {
        const ext = path.extname(filePath).toLowerCase();
        // Suppression list: extensions registered to a grammar whose strict
        // parser will reject the format's idiomatic content.
        //   .mdx   — Markdown with embedded JSX; plain Markdown grammar errors
        //   .jsonc — JSON-with-comments; strict JSON rejects `//` and `/* */`
        //   .json5 — JSON5 (unquoted keys, trailing commas, etc.)
        //   .jsonl, .ndjson — multiple top-level JSON values per file
        // .geojson / .topojson are strict JSON variants and stay un-suppressed.
        if (['.mdx', '.jsonc', '.json5', '.jsonl', '.ndjson'].includes(ext)) return '';
        const langName = getLangForFile(filePath);
        if (!langName) return '';
        const syntaxErrors = await checkSyntaxErrors(content, langName);
        if (!syntaxErrors?.length) return '';
        const locations = syntaxErrors.map(e => `${e.line}:${e.column}`).join(', ');
        // Leading \n gives visual separation when this string is appended to
        // other tool output. The body is plain text — no decorative glyph or
        // emoji. Tool output stays actionable and machine-readable.
        return `\nParse errors at lines ${locations}`;
    } catch {
        return '';
    }
}

export { findMatch, applyEditList, syntaxWarn };
