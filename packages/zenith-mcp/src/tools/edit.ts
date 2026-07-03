import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { getLangForFile, checkSyntaxErrors } from "../core/tree-sitter.js";
import { getDb, getSessionId, findRepoRoot, snapshotEdit, ensureFreshFromContent } from "../core/symbol-index.js";
import { errorMessage, type ToolContext, type ToolServer } from "./types.js";

// ---------------------------------------------------------------------------
// edit — the single edit tool.
//
// Two edit shapes, inferred from populated fields (no mode param):
//   - line-range replace: startLine + endLine + newContent. The line numbers
//     ARE the target; no content matching.
//   - content replace: oldContent + newContent, for when the model has no
//     line numbers. The field is deliberately named oldContent, NOT oldText.
//
// Every line number in a call refers to the ORIGINAL file state. Each edit
// resolves to a character span over the original content ("claim"); claims
// may not overlap; the file is rebuilt in one pass over the sorted claims.
// Original-relative coordinates therefore hold by construction — there is no
// shift ledger to get wrong.
//
// Return contract (the strings below are load-bearing, verbatim):
//   - parse ran and was clean:  "Edit applied sucessfully, no parsing errors detected."
//   - parse ran and found breakage: "Edit applied sucessfully. A parsing error was detected at line N, <kind>."
//   - no parse could run:       "Edit applied sucessfully."
// "detected" is a claim about an observation that actually happened. It is
// never emitted on a path where no parse ran.
// ---------------------------------------------------------------------------

type EditSpec = {
    path?: string;
    startLine?: number;
    endLine?: number;
    oldContent?: string;
    newContent: string;
};

type EditArgs = {
    path: string;
    edits: EditSpec[];
};

// A resolved edit: replace original chars [start, end) with repl.
type Claim = { start: number; end: number; repl: string; editIndex: number };

// Grammars registered for these extensions reject the dialect's idiomatic
// content (comments in .jsonc, JSX in .mdx, …) — a parse there would report
// breakage the edit did not cause, so no parse claim is made for them.
const PARSE_SUPPRESSED_EXTS = new Set(['.mdx', '.jsonc', '.json5', '.jsonl', '.ndjson']);

function leadingWhitespace(line: string): string {
    let n = 0;
    while (n < line.length) {
        const ch = line[n];
        if (ch !== ' ' && ch !== '\t') break;
        n++;
    }
    return line.slice(0, n);
}

// Fit forgiveness: shift newText's base indentation to the replaced text's
// base indentation. The base prefix comes verbatim from the file (tabs stay
// tabs); relative depth inside newText is preserved; blank lines pass
// through. Whitespace only — if newText is not uniformly shiftable, it is
// applied untouched rather than altered.
function reindentToTarget(newText: string, replacedText: string): string {
    if (newText === '') return newText;
    const replacedFirst = replacedText.split('\n').find(l => l.trim() !== '');
    if (replacedFirst === undefined) return newText;
    const targetBase = leadingWhitespace(replacedFirst);
    const newLines = newText.split('\n');
    const newFirst = newLines.find(l => l.trim() !== '');
    if (newFirst === undefined) return newText;
    const newBase = leadingWhitespace(newFirst);
    if (newBase === targetBase) return newText;
    for (const l of newLines) {
        if (l.trim() !== '' && !l.startsWith(newBase)) return newText;
    }
    return newLines.map(l => (l.trim() === '' ? l : targetBase + l.slice(newBase.length))).join('\n');
}

function normalizeEols(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function register(server: ToolServer, ctx: ToolContext): void {
    const handler = async (args: EditArgs) => {
        const multiEdit = args.edits.length > 1;

        // ── Group edits by resolved target file, preserving call order and
        // global edit indices (so "#N:" matches the caller's array). Distinct
        // spellings of the same file resolve to one group, keeping every line
        // number original-file-relative. A sandbox rejection is a per-file
        // failure, not a call failure.
        const resolvedByGiven = new Map<string, string | { error: string }>();
        for (const spec of args.edits) {
            const given = spec.path ?? args.path;
            if (resolvedByGiven.has(given)) continue;
            try {
                resolvedByGiven.set(given, await ctx.validatePath(given));
            } catch (error) {
                resolvedByGiven.set(given, { error: errorMessage(error) });
            }
        }

        type FileGroup = {
            givenPath: string;
            absPath: string | null;
            validateError: string | null;
            edits: Array<{ spec: EditSpec; index: number }>;
        };
        const groups: FileGroup[] = [];
        const groupByKey = new Map<string, FileGroup>();
        for (const [index, spec] of args.edits.entries()) {
            const given = spec.path ?? args.path;
            const resolved = resolvedByGiven.get(given) ?? { error: 'Path not resolved.' };
            const key = typeof resolved === 'string' ? resolved : `!${given}`;
            let group = groupByKey.get(key);
            if (!group) {
                group = {
                    givenPath: given,
                    absPath: typeof resolved === 'string' ? resolved : null,
                    validateError: typeof resolved === 'string' ? null : resolved.error,
                    edits: [],
                };
                groupByKey.set(key, group);
                groups.push(group);
            }
            group.edits.push({ spec, index });
        }
        const multiFile = groups.length > 1;

        const failures: string[] = [];
        let anyWrote = false;
        let firstParseError: { line: number; kind: string } | null = null;
        let anyUnparsed = false;

        for (const group of groups) {
            const fileTag = multiFile ? `${group.givenPath}: ` : '';

            if (group.absPath === null) {
                failures.push(`${fileTag}${group.validateError ?? 'Path not resolved.'}`);
                continue;
            }
            const absPath = group.absPath;

            // ── One stat: existence check + the mode/owner to preserve.
            let fileMode: number;
            let fileUid: number;
            let fileGid: number;
            try {
                const st = await fs.stat(absPath);
                if (!st.isFile()) {
                    failures.push(`${fileTag}Not a file.`);
                    continue;
                }
                fileMode = st.mode & 0o7777;
                fileUid = st.uid;
                fileGid = st.gid;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                failures.push(`${fileTag}${code === 'ENOENT' ? 'File not found.' : errorMessage(error)}`);
                continue;
            }

            // ── Honest unwritable hard-fail before any work is spent.
            try {
                await fs.access(absPath, fs.constants.W_OK);
            } catch {
                failures.push(`${fileTag}File not writable.`);
                continue;
            }

            let raw: string;
            try {
                raw = await fs.readFile(absPath, 'utf-8');
            } catch {
                failures.push(`${fileTag}File not readable.`);
                continue;
            }

            // ── BOM + EOL bookkeeping. Edits run over an LF-normalized frame;
            // the file's dominant terminator (and BOM) is restored on write, so
            // CRLF files stay CRLF and lone-\r files are handled, not corrupted.
            const hadBom = raw.startsWith('\uFEFF');
            const noBom = hadBom ? raw.slice(1) : raw;
            const crlfCount = noBom.split('\r\n').length - 1;
            const loneCrCount = noBom.split('\r').length - 1 - crlfCount;
            const loneLfCount = noBom.split('\n').length - 1 - crlfCount;
            let eol = '\n';
            if (crlfCount > loneLfCount && crlfCount >= loneCrCount) eol = '\r\n';
            else if (loneCrCount > loneLfCount && loneCrCount > crlfCount) eol = '\r';
            const content = normalizeEols(noBom);

            // ── Line geometry of the ORIGINAL content. All coordinates below
            // are original-file-relative; nothing here mutates until the single
            // reconstruction pass at the end.
            const lines = content.split('\n');
            const lineCount = lines.length;
            const lineStarts: number[] = new Array(lineCount);
            {
                let offset = 0;
                for (let i = 0; i < lineCount; i++) {
                    lineStarts[i] = offset;
                    offset += (lines[i] ?? '').length + 1;
                }
            }
            // 1-based line accessors. The fallbacks are unreachable for valid
            // line numbers; they bias to end-of-content, never to offset math
            // that could corrupt an earlier region.
            const lineStartAt = (ln: number): number => lineStarts[ln - 1] ?? content.length;
            const lineTextEndAt = (ln: number): number => lineStartAt(ln) + (lines[ln - 1] ?? '').length;

            const claims: Claim[] = [];
            const overlapsClaim = (start: number, end: number): Claim | undefined =>
                claims.find(c => start < c.end && c.start < end);

            for (const { spec, index } of group.edits) {
                const tag = `${fileTag}${multiEdit ? `#${index + 1}: ` : ''}`;
                const hasOld = spec.oldContent !== undefined && spec.oldContent.length > 0;
                let rangeNote = '';

                // ── Line-range resolution. A complete range wins whenever it
                // is usable; oldContent never fails a valid line-range edit.
                if (spec.startLine !== undefined && spec.endLine !== undefined) {
                    // Swapped or off-the-front ranges are obvious intent — take them.
                    const s = Math.max(1, Math.min(spec.startLine, spec.endLine));
                    const eRaw = Math.max(spec.startLine, spec.endLine);
                    if (s <= lineCount) {
                        const e = Math.min(Math.max(eRaw, s), lineCount);
                        let start: number;
                        let end: number;
                        let repl: string;
                        if (spec.newContent === '') {
                            // Empty newContent deletes the lines outright (a
                            // newline is consumed so no blank line is left).
                            repl = '';
                            if (e < lineCount) {
                                start = lineStartAt(s);
                                end = lineStartAt(e + 1);
                            } else if (s > 1) {
                                start = lineTextEndAt(s - 1);
                                end = content.length;
                            } else {
                                start = 0;
                                end = content.length;
                            }
                        } else {
                            start = lineStartAt(s);
                            end = lineTextEndAt(e);
                            // Lines are the unit: one trailing newline in
                            // newContent is convention, not an extra blank line.
                            let text = normalizeEols(spec.newContent);
                            if (text.endsWith('\n')) text = text.slice(0, -1);
                            repl = reindentToTarget(text, content.slice(start, end));
                        }
                        const clash = overlapsClaim(start, end);
                        if (clash) {
                            failures.push(`${tag}Overlaps edit #${clash.editIndex + 1}.`);
                            continue;
                        }
                        claims.push({ start, end, repl, editIndex: index });
                        continue;
                    }
                    if (!hasOld) {
                        failures.push(`${tag}Line range ${spec.startLine}-${spec.endLine} out of bounds (${lineCount} lines).`);
                        continue;
                    }
                    rangeNote = `Line range ${spec.startLine}-${spec.endLine} out of bounds (${lineCount} lines); `;
                }

                if (!hasOld) {
                    failures.push(`${tag}Specify a line range or oldContent.`);
                    continue;
                }

                // ── Content resolution. Pure string operations — the needle is
                // never a pattern. Claim-aware at every tier: a candidate that
                // overlaps an earlier edit is skipped, so repeated oldContent
                // values progress through the file in edit order.
                const oldNorm = normalizeEols(spec.oldContent ?? '');
                const newNorm = normalizeEols(spec.newContent);
                let start = -1;
                let end = -1;
                let matchedWholeLines = false;

                // Tier 1: exact. A match that starts at a line start and ends
                // with only whitespace between it and the end of that line
                // consumes the trailing whitespace too — the same whole-line
                // outcome the trailing-whitespace-tolerant tier gives, so a
                // single-line and a multi-line oldContent behave alike.
                let from = 0;
                while (true) {
                    const idx = content.indexOf(oldNorm, from);
                    if (idx === -1) break;
                    let candidateEnd = idx + oldNorm.length;
                    const startsLine = idx === 0 || content[idx - 1] === '\n';
                    if (startsLine) {
                        let scan = candidateEnd;
                        while (scan < content.length && (content[scan] === ' ' || content[scan] === '\t')) scan++;
                        if (scan === content.length || content[scan] === '\n') candidateEnd = scan;
                    }
                    if (!overlapsClaim(idx, candidateEnd)) {
                        start = idx;
                        end = candidateEnd;
                        matchedWholeLines = startsLine &&
                            (end === content.length || content[end] === '\n');
                        break;
                    }
                    from = idx + 1;
                }

                const oldLines = oldNorm.split('\n');
                const blockLen = oldLines.length;

                // Tier 2: whole-line match tolerating trailing-whitespace drift.
                if (start === -1) {
                    const oldTrimmed = oldLines.map(l => l.trimEnd());
                    for (let i = 0; i + blockLen <= lineCount; i++) {
                        let matches = true;
                        for (let j = 0; j < blockLen; j++) {
                            if ((lines[i + j] ?? '').trimEnd() !== (oldTrimmed[j] ?? '')) {
                                matches = false;
                                break;
                            }
                        }
                        if (!matches) continue;
                        const cStart = lineStartAt(i + 1);
                        const cEnd = lineTextEndAt(i + blockLen);
                        if (overlapsClaim(cStart, cEnd)) continue;
                        start = cStart;
                        end = cEnd;
                        matchedWholeLines = true;
                        break;
                    }
                }

                // Tier 3: whole-line match tolerating a uniform base-indentation
                // shift (the pasted-at-the-wrong-depth case). Candidates keep
                // their relative structure; the nearest shift wins; two distinct
                // shifts at the same distance are ambiguous and match nothing —
                // correctness beats leniency.
                if (start === -1) {
                    const anchorIdx = oldLines.findIndex(l => l.trim() !== '');
                    if (anchorIdx !== -1) {
                        const oldBase = leadingWhitespace(oldLines[anchorIdx] ?? '');
                        const candidates: Array<{ line: number; delta: number }> = [];
                        for (let i = 0; i + blockLen <= lineCount; i++) {
                            const anchorLine = lines[i + anchorIdx] ?? '';
                            if (anchorLine.trim() === '') continue;
                            const fileBase = leadingWhitespace(anchorLine);
                            if (fileBase === oldBase) continue; // zero shift is tier-2 territory
                            let matches = true;
                            for (let j = 0; j < blockLen; j++) {
                                const o = oldLines[j] ?? '';
                                const f = lines[i + j] ?? '';
                                if (o.trim() === '') {
                                    if (f.trim() !== '') { matches = false; break; }
                                    continue;
                                }
                                if (!o.startsWith(oldBase) || !f.startsWith(fileBase) ||
                                    o.slice(oldBase.length).trimEnd() !== f.slice(fileBase.length).trimEnd()) {
                                    matches = false;
                                    break;
                                }
                            }
                            if (!matches) continue;
                            if (overlapsClaim(lineStartAt(i + 1), lineTextEndAt(i + blockLen))) continue;
                            candidates.push({ line: i, delta: fileBase.length - oldBase.length });
                        }
                        candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || a.line - b.line);
                        const best = candidates[0];
                        const runnerUp = candidates[1];
                        const ambiguous = best !== undefined && runnerUp !== undefined &&
                            Math.abs(runnerUp.delta) === Math.abs(best.delta) && runnerUp.delta !== best.delta;
                        if (best !== undefined && !ambiguous) {
                            start = lineStartAt(best.line + 1);
                            end = lineTextEndAt(best.line + blockLen);
                            matchedWholeLines = true;
                        }
                    }
                }

                if (start === -1) {
                    failures.push(`${tag}${rangeNote}oldContent not found.`);
                    continue;
                }
                const repl = matchedWholeLines ? reindentToTarget(newNorm, content.slice(start, end)) : newNorm;
                claims.push({ start, end, repl, editIndex: index });
            }

            if (claims.length === 0) continue; // nothing to write for this file

            // ── Single reconstruction pass over the original content. The
            // same walk derives each claim's literal patch (exact replaced
            // text, exact replacement as applied, original start line) — the
            // unit the snapshot layer stores.
            claims.sort((a, b) => a.start - b.start || a.editIndex - b.editIndex);
            const patches: Array<{ oldText: string; newText: string; line: number }> = [];
            let rebuilt = '';
            let pos = 0;
            let originalLine = 1;
            for (const c of claims) {
                const gap = content.slice(pos, c.start);
                const oldText = content.slice(c.start, c.end);
                originalLine += gap.split('\n').length - 1;
                patches.push({ oldText, newText: c.repl, line: originalLine });
                originalLine += oldText.split('\n').length - 1;
                rebuilt += gap + c.repl;
                pos = c.end;
            }
            rebuilt += content.slice(pos);
            const finalText = (hadBom ? '\uFEFF' : '') + (eol === '\n' ? rebuilt : rebuilt.split('\n').join(eol));

            // ── Snapshot + index plumbing (resolved once, used before and
            // after the write). Both are best-effort safety nets: they must
            // never fail an edit.
            const repoRoot = findRepoRoot(absPath);
            let db: ReturnType<typeof getDb> | null = null;
            if (repoRoot !== null) {
                try {
                    await ctx.validatePath(repoRoot);
                    db = getDb(repoRoot);
                } catch {
                    db = null;
                }
            }
            // Every write is preceded by per-edit patch snapshots, keyed per
            // session/file: a future undo reverses the newest patch by
            // content (which survives line drift), and a cached patch can be
            // re-applied elsewhere without restating newText.
            if (db !== null && repoRoot !== null) {
                try {
                    const relPath = path.relative(repoRoot, absPath);
                    const sessionId = ctx.sessionId ?? getSessionId();
                    for (const p of patches) {
                        snapshotEdit(db, relPath, p.oldText, p.newText, p.line, sessionId);
                    }
                } catch { /* snapshotting is a safety net; never fail the edit */ }
            }

            // ── Atomic write: temp → chmod (exact original mode; chmod is not
            // umask-masked, writeFile's mode option is) → best-effort chown →
            // rename. The temp file is removed on every failure path.
            const tempPath = `${absPath}.${randomBytes(8).toString('hex')}.tmp`;
            try {
                await fs.writeFile(tempPath, finalText, 'utf-8');
                await fs.chmod(tempPath, fileMode);
                try {
                    await fs.chown(tempPath, fileUid, fileGid);
                } catch { /* ownership is best-effort — never fail an edit over chown */ }
                await fs.rename(tempPath, absPath);
            } catch (error) {
                try { await fs.unlink(tempPath); } catch { /* already gone */ }
                const code = (error as NodeJS.ErrnoException).code;
                failures.push(`${fileTag}${code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
                    ? 'File not writable.'
                    : `Write failed${code ? ` (${code})` : ''}.`}`);
                continue;
            }
            anyWrote = true;

            if (db !== null && repoRoot !== null) {
                try {
                    await ensureFreshFromContent(db, repoRoot, absPath, finalText);
                } catch { /* index freshness is best-effort */ }
            }

            // ── Parse check: structural ERROR/MISSING detection only, on the
            // exact edited content, only for this edited file. When no parse
            // actually ran, no claim is made — "detected" is never emitted
            // without a real detection.
            try {
                let parsed = false;
                if (!PARSE_SUPPRESSED_EXTS.has(path.extname(absPath).toLowerCase())) {
                    const langName = getLangForFile(absPath);
                    if (langName) {
                        const errs = await checkSyntaxErrors(rebuilt, langName);
                        if (errs !== null) {
                            parsed = true;
                            const first = errs[0];
                            if (first !== undefined && firstParseError === null) {
                                firstParseError = { line: first.line, kind: first.kind };
                            }
                        }
                    }
                }
                if (!parsed) anyUnparsed = true;
            } catch {
                anyUnparsed = true;
            }
        }

        const out: string[] = [...failures];
        if (anyWrote) {
            if (firstParseError !== null) {
                out.push(`Edit applied sucessfully. A parsing error was detected at line ${firstParseError.line}, ${firstParseError.kind}.`);
            } else if (anyUnparsed) {
                out.push('Edit applied sucessfully.');
            } else {
                out.push('Edit applied sucessfully, no parsing errors detected.');
            }
        }
        return { content: [{ type: 'text' as const, text: out.join('\n') }] };
    };

    server.registerTool("edit", {
        title: "Edit",
        description: "Edit file lines or content.",
        inputSchema: z.strictObject({
            path: z.string().describe("File to edit."),
            edits: z.array(z.strictObject({
                path: z.string().optional().describe("Target a different file."),
                startLine: z.number().int().optional().describe("First line to replace. 1-based, original file."),
                endLine: z.number().int().optional().describe("Last line to replace, inclusive."),
                oldContent: z.string().optional().describe("Text to find when no line range."),
                newContent: z.string().describe("Replacement text. Empty deletes the line range."),
            })).min(1).describe("Applied in order. Line numbers always refer to the original file."),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
    }, handler);
}
