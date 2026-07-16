/**
 * POLARIS Task 2.3 — the literal floor (plan §Literal floor and
 * proof-backed absence).
 *
 * The one module in questions/* land allowed to touch processes and the
 * filesystem. Used ONLY by queryOccurrences with name.mode 'exact'. It scans
 * the session's pinned domain for an exact UTF-8 byte literal and either
 * returns raw hits (candidate evidence, never facts) or proves absence.
 *
 * Contract highlights:
 *  - ripgrep is an OPTIMIZATION: fixed-string, no config, no ignore files,
 *    hidden+text enabled, explicitly enumerated path chunks so its domain is
 *    exactly the session's. The in-process scanner is mandatory and
 *    behaviorally equivalent for exact identifiers; any rg failure falls
 *    back silently.
 *  - content-fresh paths scan the session's in-hand bytes, never disk.
 *  - the 64 MiB byte budget and per-file bound produce a typed partial: a
 *    partial floor may return matches but can never prove absence.
 *  - identifier-boundary classification may ANNOTATE, never discard.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { PROVISIONAL_LIMITS } from './limits.js';

export interface FloorFile {
    storeKey: string;
    absPath: string;
    /** In-hand bytes for content-fresh paths; disk is never read when set. */
    content?: string;
}

export interface FloorMatch {
    storeKey: string;
    /** Absolute byte offset of the literal's first byte in the file. */
    byteOffset: number;
    /** 1-based line, 0-based UTF-16 column (matches persisted facts). */
    line: number;
    column: number;
    /** Annotation only — a non-boundary hit is still a hit. */
    identifierBoundary: boolean;
}

export interface FloorOutcome {
    matches: FloorMatch[];
    scanner: 'rg' | 'in_process';
    scannedBytes: number;
    scannedFiles: number;
    /** Store keys that could not be read (disk mode only). */
    unreadable: string[];
    /** Store keys skipped for exceeding the per-file bound (scan continued). */
    overBound: string[];
    /** Which global bound fired, if any. */
    stopReason: 'byte_budget' | null;
    /**
     * True only when every enumerated file was fully read and no bound
     * fired — the precondition for proof-backed absence. Absence proofs are
     * ALWAYS confirmed by the in-process scanner: an rg-clean verdict is an
     * optimization for the has-hits case, never proof (review finding F1).
     */
    complete: boolean;
}

export interface FloorOptions {
    /** Byte budget; defaults to the provisional 64 MiB. */
    byteBudget?: number;
    /** Per-file byte bound; defaults to the provisional source bound. */
    fileByteBound?: number;
    /** Force a scanner (tests prove rg/in-process equivalence with this). */
    forceScanner?: 'rg' | 'in_process';
    /** Override the rg binary name (tests simulate absence). */
    rgCommand?: string;
}

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

function boundaryAnnotation(buffer: Buffer, start: number, literalBytes: number): boolean {
    // Generic annotation only: language-specific identifier rules differ, so
    // this NEVER discards a hit (plan step 3). Adjacency is tested on whole
    // Unicode code points, not UTF-16 halves: a supplementary-plane identifier
    // char (\p{L}/\p{N}) must not be split into a lone surrogate (audit A20),
    // which would misread an astral letter or digit beside the literal as a
    // non-identifier and wrongly annotate the hit as on an identifier boundary.
    // The 4-byte windows end/begin on the literal's own char boundaries, so the
    // last code point before and the first code point after are the true
    // adjacent chars for valid UTF-8 (leading partial bytes decode to U+FFFD
    // and are ignored because only the boundary code point is inspected).
    const beforeText = start === 0 ? '' : buffer.subarray(Math.max(0, start - 4), start).toString('utf8');
    const afterStart = start + literalBytes;
    const afterText = afterStart >= buffer.length ? '' : buffer.subarray(afterStart, Math.min(buffer.length, afterStart + 4)).toString('utf8');
    const before = [...beforeText].at(-1) ?? '';
    const after = [...afterText].at(0) ?? '';
    const beforeIsIdent = before !== '' && IDENTIFIER_CHAR.test(before);
    const afterIsIdent = after !== '' && IDENTIFIER_CHAR.test(after);
    return !beforeIsIdent && !afterIsIdent;
}

function locate(buffer: Buffer, byteOffset: number): { line: number; column: number } {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < byteOffset; i++) {
        if (buffer[i] === 0x0a) {
            line += 1;
            lineStart = i + 1;
        }
    }
    const column = buffer.subarray(lineStart, byteOffset).toString('utf8').length;
    return { line, column };
}

function scanBuffer(storeKey: string, buffer: Buffer, literal: Buffer): FloorMatch[] {
    const matches: FloorMatch[] = [];
    let from = 0;
    for (;;) {
        const at = buffer.indexOf(literal, from);
        if (at === -1) break;
        const { line, column } = locate(buffer, at);
        matches.push({
            storeKey,
            byteOffset: at,
            line,
            column,
            identifierBoundary: boundaryAnnotation(buffer, at, literal.length),
        });
        from = at + literal.length; // non-overlapping, byte-equivalent to rg
    }
    return matches;
}

interface RgScanResult {
    /** byteOffset list per absPath; null means rg is unavailable/unusable. */
    hits: Map<string, number[]> | null;
}

function runRipgrep(literal: string, absPaths: readonly string[], rgCommand: string): RgScanResult {
    const hits = new Map<string, number[]>();
    const CHUNK = 512; // explicit path enumeration, bounded argv
    for (let i = 0; i < absPaths.length; i += CHUNK) {
        const chunk = absPaths.slice(i, i + CHUNK);
        const result = spawnSync(rgCommand, [
            '--no-config', '--no-ignore', '--hidden', '--text',
            // Byte-exact search: without this rg auto-detects BOMs and
            // transcodes (a UTF-16 BOM misses UTF-8 literals; a UTF-8 BOM
            // shifts every reported offset by 3). Review finding F1.
            '--encoding', 'none',
            '--fixed-strings', '--byte-offset', '--only-matching',
            '--with-filename', '--no-line-number', '--null',
            '--regexp', literal,
            '--', ...chunk,
        ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        // Strict trust rule (F1/H3): anything but a clean exit (0 = hits,
        // 1 = no hits) with an empty stderr makes the WHOLE rg pass
        // unusable — no partial trust of possibly-truncated stdout, no
        // stderr parsing heuristics. In-process takes over entirely.
        if (result.error !== undefined || result.signal !== null
            || (result.status !== 0 && result.status !== 1)
            || typeof result.stdout !== 'string'
            || String(result.stderr ?? '').trim() !== '') {
            return { hits: null };
        }
        // --null terminates the filename with \0; format: <path>\0<offset>:<match>
        for (const line of result.stdout.split('\n')) {
            if (line === '') continue;
            const nul = line.indexOf('\0');
            if (nul === -1) continue;
            const file = line.slice(0, nul);
            const rest = line.slice(nul + 1);
            const colon = rest.indexOf(':');
            if (colon === -1) continue;
            const offset = Number(rest.slice(0, colon));
            if (!Number.isInteger(offset)) continue;
            const list = hits.get(file);
            if (list === undefined) hits.set(file, [offset]);
            else list.push(offset);
        }
    }
    return { hits };
}

/**
 * Scan the enumerated domain for the exact literal. Files are visited in the
 * given (canonical) order; determinism does not depend on scanner choice.
 *
 * Absence discipline (review finding F1): an rg pass that finds nothing is
 * never accepted as proof — a complete zero-match rg scan is re-run through
 * the mandatory in-process scanner, and THAT result is returned. rg only
 * accelerates the has-hits case, where its output is cross-derived from the
 * real bytes anyway (line/column/boundary come from our own read).
 */
export function scanLiteralFloor(
    literal: string,
    files: readonly FloorFile[],
    options: FloorOptions = {},
): FloorOutcome {
    if (literal.length === 0) {
        throw new Error('scanLiteralFloor: empty literal (composer must refuse earlier)');
    }
    const primary = scanOnce(literal, files, options, options.forceScanner !== 'in_process');
    if (primary.scanner === 'rg' && primary.complete && primary.matches.length === 0
        && options.forceScanner !== 'rg') {
        return scanOnce(literal, files, options, false);
    }
    return primary;
}

function scanOnce(
    literal: string,
    files: readonly FloorFile[],
    options: FloorOptions,
    wantRg: boolean,
): FloorOutcome {
    const byteBudget = options.byteBudget ?? PROVISIONAL_LIMITS.textFloorBytes;
    const fileByteBound = options.fileByteBound ?? PROVISIONAL_LIMITS.sourceFileBytes;
    const literalBytes = Buffer.from(literal, 'utf8');

    // rg pass (optimization only; disk-backed files only). In-hand content is
    // always scanned in process because rg cannot see unsaved bytes.
    let rgHits: Map<string, number[]> | null = null;
    let scanner: 'rg' | 'in_process' = 'in_process';
    // The exact set of disk paths handed to rg: only files that pass the same
    // stat / per-file / aggregate byte bounds the scan loop enforces (audit
    // A13). rg is acceleration only, so it must never scan a file the bounded
    // scan would refuse; and the loop below trusts an rg "no hits" verdict only
    // for a path proven to be in this domain (never for a file the loop reaches
    // that rg was not asked about — e.g. after a mid-scan filesystem change).
    const rgDomain = new Set<string>();
    if (wantRg) {
        // Bound rg's work up front. A file over the per-file bound, or past the
        // shared byte budget, is one whose rg hits the scan loop already
        // discards (it skips or never reaches it), so excluding it here narrows
        // rg's work without changing any output. Content-fresh files never
        // reach rg but still consume the shared budget, so they are accounted
        // here to place the disk cutoff exactly where the scan loop places it.
        let plannedBytes = 0;
        for (const file of files) {
            if (file.content !== undefined) {
                const size = Buffer.byteLength(file.content, 'utf8');
                if (size > fileByteBound) continue;
                if (plannedBytes + size > byteBudget) break;
                plannedBytes += size;
                continue; // in-hand bytes are invisible to rg but consume budget
            }
            let size = -1;
            try {
                const stat = fs.statSync(file.absPath);
                if (stat.isFile()) size = stat.size;
            } catch {
                // Unreadable at stat: the scan loop records it as unreadable,
                // and rg would fail on it too. Never part of rg's domain.
            }
            if (size < 0) continue; // stat failed or non-regular (rg must not recurse a directory)
            if (size > fileByteBound) continue;
            if (plannedBytes + size > byteBudget) break;
            plannedBytes += size;
            rgDomain.add(file.absPath);
        }
        const diskPaths = [...rgDomain];
        const rgResult = diskPaths.length === 0
            ? { hits: new Map<string, number[]>() }
            : runRipgrep(literal, diskPaths, options.rgCommand ?? 'rg');
        if (rgResult.hits !== null) {
            rgHits = rgResult.hits;
            scanner = 'rg';
        } else if (options.forceScanner === 'rg') {
            throw new Error('scanLiteralFloor: rg forced but unavailable');
        }
    }

    const matches: FloorMatch[] = [];
    const unreadable: string[] = [];
    const overBound: string[] = [];
    let scannedBytes = 0;
    let scannedFiles = 0;
    let stopReason: FloorOutcome['stopReason'] = null;

    for (const file of files) {
        let buffer: Buffer;
        if (file.content !== undefined) {
            buffer = Buffer.from(file.content, 'utf8');
            if (buffer.length > fileByteBound) {
                // One oversized member kills completeness, never the scan
                // (review H1): later files still yield candidates.
                overBound.push(file.storeKey);
                continue;
            }
        } else {
            try {
                const size = fs.statSync(file.absPath).size;
                if (size > fileByteBound) {
                    overBound.push(file.storeKey);
                    continue;
                }
                if (scannedBytes + size > byteBudget) {
                    stopReason = 'byte_budget';
                    break;
                }
                // With rg, files rg proved hit-free are counted without a
                // second read (never as absence proof — see the wrapper);
                // files WITH hits are read once so line/column/boundary come
                // from the true bytes. Only trust rg's verdict for a path that
                // was actually in rg's bounded domain; a file the loop reaches
                // that rg was never asked about is scanned in process below.
                if (rgHits !== null && rgDomain.has(file.absPath)) {
                    scannedBytes += size;
                    scannedFiles += 1;
                    const offsets = rgHits.get(file.absPath);
                    if (offsets === undefined || offsets.length === 0) continue;
                    buffer = fs.readFileSync(file.absPath);
                    for (const offset of offsets.sort((a, b) => a - b)) {
                        const { line, column } = locate(buffer, offset);
                        matches.push({
                            storeKey: file.storeKey, byteOffset: offset, line, column,
                            identifierBoundary: boundaryAnnotation(buffer, offset, literalBytes.length),
                        });
                    }
                    continue;
                }
                buffer = fs.readFileSync(file.absPath);
            } catch {
                unreadable.push(file.storeKey);
                continue;
            }
        }
        if (scannedBytes + buffer.length > byteBudget) {
            stopReason = 'byte_budget';
            break;
        }
        scannedBytes += buffer.length;
        scannedFiles += 1;
        matches.push(...scanBuffer(file.storeKey, buffer, literalBytes));
    }

    return {
        matches,
        scanner,
        scannedBytes,
        scannedFiles,
        unreadable,
        overBound,
        stopReason,
        complete: stopReason === null && unreadable.length === 0
            && overBound.length === 0 && scannedFiles === files.length,
    };
}
