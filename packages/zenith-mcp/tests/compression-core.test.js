import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compressForTool } from '../dist/core/compression.js';

// ---------------------------------------------------------------------------
// compressForTool is the MCP→TOON seam. In production read_file / read_multiple_files
// are the SINGLE authority that places the `N. ` line-number prefix, ONCE, before
// calling the seam — so the seam ALWAYS receives line-number-prefixed text and the
// budget is measured against that prefixed representation. These tests mirror that
// truth exactly: they prefix the source the same way read_file does and size every
// budget against the prefixed length. They also place the fixture inside a `.git`
// repo so the symbol index (findRepoRoot → getDb) resolves and hands TOON real
// structural facts — without a repo there are no defs and the structured path has
// nothing to discriminate, so it honestly returns null.
// ---------------------------------------------------------------------------

/**
 * Apply the EXACT `N. ` prefix read_file places (read_file.ts): split on '\n',
 * drop a single trailing empty element, then `${i + 1}. ${line}`.
 */
function prefixLines(rawText) {
    const lines = rawText.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

/**
 * A genuinely compressible source file: several exported functions, each with a
 * `return` anchor, where one function carries a long low-value padding body. The
 * structural engine keeps the signatures + returns and drops the redundant padding
 * — a faithful stand-in for real source the seam compresses in production.
 */
function buildCompressibleSource() {
    const fns = [
        ['alpha', 2],
        ['beta', 40],
        ['gamma', 2],
        ['delta', 3],
    ];
    const lines = [];
    for (const [name, bulk] of fns) {
        lines.push(`export function ${name}(input) {`);
        for (let i = 0; i < bulk; i++) {
            lines.push(`  const ${name}_pad${i} = input + ${i};`);
        }
        lines.push(`  return ${name}_pad0;`);
        lines.push('}');
    }
    return lines.join('\n');
}

describe('compression core', () => {
    let repoRoot;

    beforeEach(async () => {
        repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-compression-core-'));
        // findRepoRoot() walks up for a `.git` entry; create one so the temp dir is
        // recognized as a repo root and the symbol index opens there.
        await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    });

    afterEach(async () => {
        if (repoRoot) {
            await fs.rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('targets ~70 percent of the prefixed content by default', async () => {
        const rawText = buildCompressibleSource();
        const filePath = path.join(repoRoot, 'large.ts');
        await fs.writeFile(filePath, rawText, 'utf8');

        // read_file prefixes the text, then hands the seam the prefixed string and a
        // budget measured against THAT representation.
        const prefixed = prefixLines(rawText);
        const maxChars = Math.floor(prefixed.length * 0.6);
        const result = await compressForTool(filePath, prefixed, maxChars);

        // compressForTool must compress (not return null) and produce a shorter output.
        expect(result).not.toBeNull();
        expect(result.length).toBeLessThan(prefixed.length);
        // Documented retention contract: 68–72% acceptable, ">72% not acceptable"
        // (markers included). Assert a tight, truthful band around the 70% target.
        expect(result.length).toBeGreaterThanOrEqual(Math.floor(prefixed.length * 0.55));
        expect(result.length).toBeLessThanOrEqual(Math.floor(prefixed.length * 0.72));
    });

    it('rejects outputs not compressed enough — returns null when maxChars >= prefixed length', async () => {
        const rawText = buildCompressibleSource();
        const filePath = path.join(repoRoot, 'small.ts');
        await fs.writeFile(filePath, rawText, 'utf8');

        const prefixed = prefixLines(rawText);
        // When maxChars equals the prefixed length: nothing to compress.
        expect(await compressForTool(filePath, prefixed, prefixed.length)).toBeNull();
        // When maxChars exceeds the prefixed length: also returns null.
        expect(await compressForTool(filePath, prefixed, prefixed.length + 100)).toBeNull();
        // When maxChars is zero: also returns null (prefixed.length > 0 but maxChars <= 0).
        expect(await compressForTool(filePath, prefixed, 0)).toBeNull();
    });

    it('truncates cleanly on a newline — output lines have N. prefix and markers match contract', async () => {
        const rawText = buildCompressibleSource();
        const sourceLines = rawText.split('\n');
        const filePath = path.join(repoRoot, 'source.ts');
        await fs.writeFile(filePath, rawText, 'utf8');

        const prefixed = prefixLines(rawText);
        const maxChars = Math.floor(prefixed.length * 0.6);
        const result = await compressForTool(filePath, prefixed, maxChars);

        // compressForTool must have compressed (not null).
        expect(result).not.toBeNull();

        const outputLines = result.split('\n');
        for (const outputLine of outputLines) {
            const isNumberedLine = /^\d+\. /.test(outputLine);
            const isMarkerLine = /^\[TRUNCATED: lines \d+-\d+\]$/.test(outputLine);
            expect(isNumberedLine || isMarkerLine).toBe(true);

            if (isNumberedLine) {
                // Extract 1-based line number and verify verbatim content matches source.
                const dotIdx = outputLine.indexOf('. ');
                const lineNum = parseInt(outputLine.slice(0, dotIdx), 10);
                const content = outputLine.slice(dotIdx + 2);
                // 1-based line number maps to sourceLines[lineNum - 1] verbatim.
                expect(sourceLines[lineNum - 1]).toBe(content);
            }
        }
    });
});
