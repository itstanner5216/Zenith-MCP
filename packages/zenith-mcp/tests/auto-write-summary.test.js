/**
 * Tests for formatAutoWriteSummary() in packages/zenith-mcp/src/config/auto-write.ts.
 *
 * PR change: replaced direct result.errors[0].match(...) with:
 *   const firstError = result.errors[0];
 *   if (firstError !== undefined) { ... }
 *   const failedPath = failedPathMatch?.[1] ?? "unknown path";
 *
 * This function takes an AutoWriteResult and produces a human-readable summary.
 * Three outcome branches:
 *   1. No errors and at least one written → success message
 *   2. At least one error → partial-success message with failed path
 *   3. Nothing written and no errors → "nothing to update" message
 */

import { describe, expect, it } from 'vitest';
import { formatAutoWriteSummary } from '../dist/config/auto-write.js';

// Helper to build an AutoWriteResult
function makeResult({ written = [], skipped = [], errors = [] } = {}) {
    return { written, skipped, errors };
}

// ---------------------------------------------------------------------------
// Success branch — no errors, at least one written
// ---------------------------------------------------------------------------

describe('formatAutoWriteSummary — success branch', () => {
    it('returns success message when one file is written', () => {
        const result = makeResult({ written: ['/some/path/config.json'] });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toMatch(/All configurations updated/i);
    });

    it('returns success message when multiple files are written', () => {
        const result = makeResult({
            written: ['/path/a.json', '/path/b.json', '/path/c.json'],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toMatch(/All configurations updated/i);
    });

    it('mentions backups in success message', () => {
        const result = makeResult({ written: ['/a.json'] });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toMatch(/backup/i);
    });

    it('success message does not mention errors', () => {
        const result = makeResult({ written: ['/a.json'] });
        const msg = formatAutoWriteSummary(result);
        expect(msg.toLowerCase()).not.toContain('error');
    });
});

// ---------------------------------------------------------------------------
// Error branch — at least one error
// ---------------------------------------------------------------------------

describe('formatAutoWriteSummary — error branch', () => {
    it('returns partial-success message when there is one error and no written', () => {
        const result = makeResult({
            errors: ['Failed to update /home/user/.config/tool.json (permission denied)'],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toMatch(/0\/1/);
    });

    it('includes the failed path extracted from the error message', () => {
        const result = makeResult({
            errors: ['Failed to update /home/user/.config/tool.json (permission denied)'],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toContain('/home/user/.config/tool.json');
    });

    it('counts correctly when some written and some errors', () => {
        const result = makeResult({
            written: ['/path/a.json', '/path/b.json'],
            errors: ['Failed to update /path/c.json (read-only)'],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toMatch(/2\/3/);
    });

    it('uses "unknown path" when the error message does not match the pattern', () => {
        const result = makeResult({
            errors: ['Something went totally wrong'],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toContain('unknown path');
    });

    it('only uses the FIRST error for the message (not subsequent ones)', () => {
        const result = makeResult({
            errors: [
                'Failed to update /first/path.json (error 1)',
                'Failed to update /second/path.json (error 2)',
            ],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toContain('/first/path.json');
        // The second error path should not appear in the message
        expect(msg).not.toContain('/second/path.json');
    });

    it('mentions manual configuration required', () => {
        const result = makeResult({
            errors: ['Failed to update /path/to/config.json and it failed'],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toMatch(/manually configured/i);
    });

    it('mentions that the configuration file remains unchanged', () => {
        const result = makeResult({
            errors: ['Failed to update /path/to/config.json (some reason)'],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toMatch(/remains unchanged/i);
    });

    it('handles error string matching " and " separator', () => {
        // Pattern matches (.+?)(?:\s+\(| and)
        const result = makeResult({
            errors: ['Failed to update /path/to/file.json and needs attention'],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toContain('/path/to/file.json');
    });
});

// ---------------------------------------------------------------------------
// Nothing to update branch — no written, no errors
// ---------------------------------------------------------------------------

describe('formatAutoWriteSummary — nothing to update branch', () => {
    it('returns a message about no configurations when written and errors are both empty', () => {
        const result = makeResult();
        const msg = formatAutoWriteSummary(result);
        expect(msg.length).toBeGreaterThan(0);
        expect(msg).toMatch(/no mcp configurations/i);
    });

    it('also handles the case with skipped entries but no written or errors', () => {
        const result = makeResult({ skipped: ['/some/path'] });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toMatch(/no mcp configurations/i);
    });
});

// ---------------------------------------------------------------------------
// Edge cases / regression
// ---------------------------------------------------------------------------

describe('formatAutoWriteSummary — edge cases', () => {
    it('handles a single written with skipped entries (success still)', () => {
        const result = makeResult({
            written: ['/a.json'],
            skipped: ['/b.json'],
        });
        const msg = formatAutoWriteSummary(result);
        expect(msg).toMatch(/All configurations updated/i);
    });

    it('total is written.length + errors.length (skipped does not count)', () => {
        const result = makeResult({
            written: ['/a.json'],
            errors: ['Failed to update /b.json (reason)'],
            skipped: ['/c.json'],
        });
        const msg = formatAutoWriteSummary(result);
        // 1 written + 1 error = total 2, so message says "1/2"
        expect(msg).toMatch(/1\/2/);
    });
});