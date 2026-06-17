import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyEditList } from '../dist/core/edit-engine.js';

// Per docs/toon-constraints/constraints.md §0.5 and the integration plan
// (Wave 2, T8: edit-engine + the batch shift ledger), symbol-mode edits go
// through the DB-backed `loadSymbolInFile` path. The DB stores DISK-frame
// coordinates: if the same `applyEditList` batch performs symbol edit #1
// followed by symbol edit #2, the DB still hands back #2's disk lines even
// though #1 already shifted the in-flight buffer. The shift ledger added in
// `applyEditList` converts each DB coordinate to its current working-frame
// location before splicing — the regression that PR #20 documented as a
// known silent-corruption limitation.
//
// Fixture: a real file under a tmpdir+.git root so `findRepoRoot` resolves
// (mirrors edit-engine-core.test.js / edit-engine-pending-snapshots.test.js).
// Two top-level functions per file so successive symbol edits target distinct
// symbols whose disk positions differ.

// alpha occupies lines 1-3, blank 4, beta occupies lines 5-7, blank 8, gamma occupies lines 9-11.
const twoFnSource = `function alpha(x) {
    return x + 1;
}

function beta(y) {
    return y * 2;
}

function gamma(z) {
    return z - 3;
}
`;

let testDir;
let testFilePath;

beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-engine-shift-'));
    fs.mkdirSync(path.join(testDir, '.git'));
    testFilePath = path.join(testDir, 'test.js');
    fs.writeFileSync(testFilePath, twoFnSource);
});

afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
});

describe('applyEditList batch shift ledger', () => {
    // Case 1: first edit GROWS the file (two extra lines), second edit must
    // still land exactly on the second symbol. Without the ledger the second
    // splice would target pre-batch coordinates — the silent corruption the
    // ledger fixes. PR #20's edit-engine has no ledger and therefore corrupts
    // here; the test is load-bearing.
    it('grow case: first edit adds two lines, second symbol lands exactly on shifted location', async () => {
        // alpha was lines 1-3 (3 lines). Replace with 5 lines (+2 net).
        const newAlpha = [
            'function alpha(x) {',
            '    // line A',
            '    // line B',
            '    return x + 100;',
            '}',
        ].join('\n');
        // beta was lines 5-7 (3 lines). Replace with 3 lines (delta 0).
        const newBeta = [
            'function beta(y) {',
            '    return y + 200;',
            '}',
        ].join('\n');

        const edits = [
            { mode: 'symbol', symbol: 'alpha', newText: newAlpha },
            { mode: 'symbol', symbol: 'beta', newText: newBeta },
        ];
        const result = await applyEditList(twoFnSource, edits, { filePath: testFilePath, isBatch: true });

        expect(result.errors).toHaveLength(0);
        expect(result.pendingSnapshots).toHaveLength(2);

        // Expected file: alpha (5 lines), blank, beta (3 lines), blank, gamma (3 lines), trailing newline.
        const expected = [
            'function alpha(x) {',
            '    // line A',
            '    // line B',
            '    return x + 100;',
            '}',
            '',
            'function beta(y) {',
            '    return y + 200;',
            '}',
            '',
            'function gamma(z) {',
            '    return z - 3;',
            '}',
            '',
        ].join('\n');
        expect(result.workingContent).toBe(expected);

        // Defensive checks: no fragments of either symbol's ORIGINAL body
        // survived (would indicate the second splice landed on stale lines
        // and didn't actually consume the original beta range).
        expect(result.workingContent).not.toContain('return x + 1;');
        expect(result.workingContent).not.toContain('return y * 2;');
        // And gamma is intact — splice arithmetic didn't blow past beta.
        expect(result.workingContent).toContain('function gamma(z) {');
        expect(result.workingContent).toContain('    return z - 3;');

        // beta's snapshot must reflect the WORKING-frame line at the time of
        // the splice (the mapped value), not the disk-frame DB value. After
        // alpha grew by 2 lines, beta now starts at working-line 7.
        const betaSnap = result.pendingSnapshots[1];
        expect(betaSnap.symbol).toBe('beta');
        expect(betaSnap.line).toBe(7);
        // And the recorded originalText must be the beta body that was
        // ACTUALLY replaced from working content — i.e. the unchanged beta.
        expect(betaSnap.originalText).toBe('function beta(y) {\n    return y * 2;\n}');
    });

    // Case 2: first edit SHRINKS the file. Symmetric coverage of the ledger:
    // negative deltas must subtract from later coordinates, not be ignored
    // (or treated as zero), or the second symbol splice over-extends and
    // corrupts content beyond the symbol's actual working-frame end.
    it('shrink case: first edit removes lines, second symbol still lands exactly', async () => {
        // alpha was 3 lines. Replace with 1 line (delta -2).
        const newAlpha = 'function alpha(x) { return x; }';
        // beta was 3 lines. Replace with 4 lines (delta +1).
        const newBeta = [
            'function beta(y) {',
            '    const t = y;',
            '    return t * 2;',
            '}',
        ].join('\n');

        const edits = [
            { mode: 'symbol', symbol: 'alpha', newText: newAlpha },
            { mode: 'symbol', symbol: 'beta', newText: newBeta },
        ];
        const result = await applyEditList(twoFnSource, edits, { filePath: testFilePath, isBatch: true });

        expect(result.errors).toHaveLength(0);
        expect(result.pendingSnapshots).toHaveLength(2);

        // Expected: alpha (1 line), blank, beta (4 lines), blank, gamma (3 lines), trailing newline.
        const expected = [
            'function alpha(x) { return x; }',
            '',
            'function beta(y) {',
            '    const t = y;',
            '    return t * 2;',
            '}',
            '',
            'function gamma(z) {',
            '    return z - 3;',
            '}',
            '',
        ].join('\n');
        expect(result.workingContent).toBe(expected);

        // No remnants of the originals.
        expect(result.workingContent).not.toContain('return x + 1;');
        expect(result.workingContent).not.toContain('return y * 2;');
        expect(result.workingContent).toContain('function gamma(z) {');

        // After alpha shrank by 2 lines, beta starts at working-line 3 (was disk-5).
        const betaSnap = result.pendingSnapshots[1];
        expect(betaSnap.symbol).toBe('beta');
        expect(betaSnap.line).toBe(3);
        expect(betaSnap.originalText).toBe('function beta(y) {\n    return y * 2;\n}');
    });

    // Identity-ledger check: a single symbol edit (ledger is empty when the
    // splice runs) must match the historical PR #20 splice positions exactly.
    // This pins the ledger as additive: it MUST be a no-op when there are no
    // prior shifts, so existing single-edit fixtures keep passing.
    it('single symbol edit: ledger is identity (no prior shifts) and splice position is unchanged', async () => {
        const newAlpha = [
            'function alpha(x) {',
            '    return x + 999;',
            '}',
        ].join('\n');

        const edits = [
            { mode: 'symbol', symbol: 'alpha', newText: newAlpha },
        ];
        const result = await applyEditList(twoFnSource, edits, { filePath: testFilePath, isBatch: false });

        expect(result.errors).toHaveLength(0);
        expect(result.pendingSnapshots).toHaveLength(1);

        // Identity expectation: alpha's snapshot.line equals the disk-frame
        // DB line (1) — because no prior splices means mapDiskLine returns
        // input unchanged. Equivalent to PR #20's `sym.line` direct read.
        const snap = result.pendingSnapshots[0];
        expect(snap.symbol).toBe('alpha');
        expect(snap.line).toBe(1);
        expect(snap.originalText).toBe('function alpha(x) {\n    return x + 1;\n}');

        // The rest of the file is byte-perfect — beta and gamma untouched.
        const expected = [
            'function alpha(x) {',
            '    return x + 999;',
            '}',
            '',
            'function beta(y) {',
            '    return y * 2;',
            '}',
            '',
            'function gamma(z) {',
            '    return z - 3;',
            '}',
            '',
        ].join('\n');
        expect(result.workingContent).toBe(expected);
    });

    // Finding N1: a content-mode edit that GROWS the line count must push a
    // ledger entry too. Content mode mutates `workingContent` via string
    // splicing (not `lines.splice`), but the working frame's line numbers
    // still shift below the replacement. Without a ledger push the next
    // symbol edit's DB-frame coordinates are mapped against an incomplete
    // ledger, so the splice lands on stale (pre-batch) lines — exactly the
    // corruption class the ledger exists to kill.
    //
    // Fixture sequence:
    //   1. Content edit on alpha's body line replaces ONE line with THREE,
    //      so disk lines below shift by +2. ledger push must be:
    //        { start: 2, delta: +2, removed: 1 } (1-based start = line 2).
    //   2. Symbol edit on beta (disk lines 5-7). Without the content-mode
    //      ledger push, mapDiskLine(5) returns 5 (identity) and the splice
    //      lands at working-line 5 — which is now `    // line B` inside
    //      alpha — silent corruption. With the push, mapDiskLine(5) returns
    //      7 (the post-grow working line) and the splice lands exactly on
    //      beta.
    it('content-mode edit growing line count: subsequent symbol edit lands on shifted location (N1)', async () => {
        const edits = [
            {
                mode: 'content',
                oldContent: '    return x + 1;',
                newContent: '    // line A\n    // line B\n    return x + 1;',
            },
            {
                mode: 'symbol',
                symbol: 'beta',
                newText: 'function beta(y) {\n    return y + 200;\n}',
            },
        ];
        const result = await applyEditList(twoFnSource, edits, { filePath: testFilePath, isBatch: true });

        expect(result.errors).toHaveLength(0);
        // Only the symbol edit produces a snapshot — content mode does not.
        expect(result.pendingSnapshots).toHaveLength(1);

        const expected = [
            'function alpha(x) {',
            '    // line A',
            '    // line B',
            '    return x + 1;',
            '}',
            '',
            'function beta(y) {',
            '    return y + 200;',
            '}',
            '',
            'function gamma(z) {',
            '    return z - 3;',
            '}',
            '',
        ].join('\n');
        expect(result.workingContent).toBe(expected);

        // No fragment of beta's original body survives — would mean the
        // symbol splice landed on stale (unshifted) lines and skipped beta.
        expect(result.workingContent).not.toContain('return y * 2;');
        // gamma untouched — the symbol splice didn't over-reach.
        expect(result.workingContent).toContain('function gamma(z) {');
        expect(result.workingContent).toContain('    return z - 3;');

        // beta's snapshot reflects the WORKING-frame line after the content
        // edit (which added 2 lines), so beta now starts at working-line 7.
        const betaSnap = result.pendingSnapshots[0];
        expect(betaSnap.symbol).toBe('beta');
        expect(betaSnap.line).toBe(7);
        expect(betaSnap.originalText).toBe('function beta(y) {\n    return y * 2;\n}');
    });

    // Finding N5: when edit 2's symbol disk lines fall INSIDE edit 1's
    // replaced range, the symbol's original lines no longer exist in the
    // working frame. mapDiskLine returns a poisoned sentinel (-1) for any
    // disk line in `[s.start, s.start + s.removed)`, and symbol mode fails
    // closed with the existing overlap error shape — no silent splice of
    // already-replaced territory.
    //
    // Without the sentinel: mapped > s.start was the only branch; for a
    // disk line strictly inside a prior shrink the existing `endLine <
    // startLine` clamp may not fire (e.g. shrink small enough to keep end
    // >= start after both get shifted), so the splice would execute on a
    // degenerate range — quietly corrupting the prior edit's new content.
    // The sentinel makes that path a fail-closed error instead.
    //
    // Fixture sequence:
    //   1. Block edit replaces lines 4-7 (the blank line + beta in full).
    //      ledger entry: { start: 4, removed: 4, delta: <some> } so beta's
    //      disk lines 5 and 7 both satisfy mapped > 4 && mapped <= 8 →
    //      sentinel -1 for both.
    //   2. Symbol edit on beta (disk lines 5-7) → mapDiskLine returns -1
    //      for both endpoints → fail-closed overlap error.
    //
    // Then assert: the symbol edit produced the overlap error (not a
    // silent splice), AND beta's original body did NOT survive (because
    // edit 1 cleanly replaced it), AND beta's REPLACEMENT (from edit 1)
    // is intact (was not subsequently corrupted).
    it('symbol edit whose disk lines fall inside a prior replaced range: fail-closed (N5)', async () => {
        // Block edit replaces lines 2-7 (alpha's body line through beta's
        // closing brace) with a single-line replacement. The block range
        // wholly contains beta (disk lines 5-7), and the ledger entry
        // satisfies [s.start, s.start + s.removed) = [2, 8) — so beta's
        // mapped lines 5 and 7 are both poisoned by the N5 sentinel.
        //
        // Multi-line block_start ('    return x + 1;\n}') uses the first
        // line as anchorStart and the trailing `}` as a verifyLine that
        // forces the candidate's e to skip past line 2's '}' (no
        // intermediate `}` between s=1 and e=2) and continue on to the
        // FIRST `}` that follows another `}` — beta's closing brace at
        // line index 6 (1-based line 7). One unambiguous candidate at
        // {start: 1, end: 6}, blockRemovedCount = 6, ledger entry
        // { start: 2, delta: 1-6 = -5, removed: 6 }.
        const edits = [
            {
                mode: 'block',
                block_start: '    return x + 1;\n}',
                block_end: '}',
                replacement_block: '// beta has been replaced by the block edit',
            },
            {
                mode: 'symbol',
                symbol: 'beta',
                newText: 'function beta(y) {\n    return y + 200;\n}',
            },
        ];
        const result = await applyEditList(twoFnSource, edits, { filePath: testFilePath, isBatch: true });

        // Exactly one error: the overlap from the symbol edit. The block
        // edit succeeded (no error), the symbol edit failed closed.
        expect(result.errors).toHaveLength(1);
        const err = result.errors[0];
        expect(err.i).toBe(1);
        // Existing overlap-error message shape (Locked Decision #13).
        expect(err.msg).toBe(
            "#2: Overlapping batch edits target 'beta'. Split the batch.",
        );
        // The failed symbol edit produced NO snapshot — fail-closed means
        // no splice happened, so no pendingSnapshots entry for beta.
        expect(result.pendingSnapshots).toHaveLength(0);

        // Beta's original body did NOT survive — the block edit cleanly
        // replaced it BEFORE the symbol edit even tried.
        expect(result.workingContent).not.toContain('return y * 2;');
        // The block-edit replacement IS intact (was not subsequently
        // corrupted by the symbol splice — fail-closed means no write).
        expect(result.workingContent).toContain('// beta has been replaced by the block edit');
        // alpha's signature line survived (the block edit started at line 2,
        // not line 1, so the function alpha header is intact). gamma is
        // entirely below the block range and is untouched.
        expect(result.workingContent).toContain('function alpha(x) {');
        expect(result.workingContent).toContain('function gamma(z) {');
        expect(result.workingContent).toContain('    return z - 3;');
    });

    // Sentinel boundary, dangerous side: the FIRST replaced line must poison.
    // Edit 1 (content mode) replaces exactly beta's header line — disk line 5,
    // one line, two-line replacement → ledger { start: 5, delta: +1, removed: 1 },
    // poison interval [5, 6). Edit 2 targets symbol beta whose DB coordinates
    // START at disk line 5 — the first replaced line. The original (s.start, …]
    // formula left line 5 unpoisoned AND unshifted: the splice executed at
    // working line 5, silently consuming the content edit's replacement header.
    // The corrected [s.start, s.start + s.removed) interval fails it closed.
    it('symbol starting exactly at a prior edit replaced-range first line: fail-closed (sentinel lower bound)', async () => {
        const edits = [
            {
                mode: 'content',
                oldContent: 'function beta(y) {',
                newContent: '// boundary-replaced header\nfunction beta(y) {',
            },
            {
                mode: 'symbol',
                symbol: 'beta',
                newText: 'function beta(y) {\n    return y + 777;\n}',
            },
        ];
        const result = await applyEditList(twoFnSource, edits, { filePath: testFilePath, isBatch: true });

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].i).toBe(1);
        expect(result.errors[0].msg).toBe(
            "#2: Overlapping batch edits target 'beta'. Split the batch.",
        );
        // The content edit's replacement survives intact; the symbol edit
        // wrote nothing.
        expect(result.workingContent).toContain('// boundary-replaced header');
        expect(result.workingContent).toContain('    return y * 2;');
        expect(result.workingContent).not.toContain('    return y + 777;');
    });

    // Sentinel boundary, legitimate side: the first SURVIVING line must map,
    // not poison. Adjacent functions (no separating line): alpha owns disk
    // lines 1-3, beta STARTS at disk line 4 === s.start + s.removed after
    // edit 1 replaces alpha (start 1, removed 3, 5-line body → delta +2).
    // The original (…, s.start + s.removed] formula poisoned line 4 — a
    // false reject of a perfectly disjoint batch. The corrected half-open
    // interval maps it through the delta: beta splices at working lines 6-8.
    it('symbol starting exactly at the first line AFTER a prior replaced range: maps and applies (sentinel upper bound)', async () => {
        const adjacentSource = [
            'function alpha(x) {',
            '    return x + 1;',
            '}',
            'function beta(y) {',
            '    return y * 2;',
            '}',
            '',
        ].join('\n');
        fs.writeFileSync(testFilePath, adjacentSource);

        const newAlpha = [
            'function alpha(x) {',
            '    const doubled = x * 2;',
            '    // grown by two lines',
            '    return doubled + 1;',
            '}',
        ].join('\n');
        const newBeta = [
            'function beta(y) {',
            '    return y - 555;',
            '}',
        ].join('\n');
        const result = await applyEditList(adjacentSource, [
            { mode: 'symbol', symbol: 'alpha', newText: newAlpha },
            { mode: 'symbol', symbol: 'beta', newText: newBeta },
        ], { filePath: testFilePath, isBatch: true });

        expect(result.errors).toHaveLength(0);
        expect(result.pendingSnapshots).toHaveLength(2);
        const out = result.workingContent.split('\n');
        // Alpha's grown body occupies lines 1-5; beta lands immediately after.
        expect(out[0]).toBe('function alpha(x) {');
        expect(out[2]).toBe('    // grown by two lines');
        expect(out[4]).toBe('}');
        expect(out[5]).toBe('function beta(y) {');
        expect(out[6]).toBe('    return y - 555;');
        expect(result.workingContent).not.toContain('    return y * 2;');
    });
});
