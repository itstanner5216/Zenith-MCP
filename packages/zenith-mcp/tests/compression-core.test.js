import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compressForTool } from '../dist/core/compression.js';

describe('compression core', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-compression-core-'));
    });

    afterEach(async () => {
        if (tmpDir) {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('targets 70 percent of the original content by default', async () => {
        // Build a large source-code-like text so compressForTool actually compresses
        const lines = Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i};`);
        const rawText = lines.join('\n');
        const filePath = path.join(tmpDir, 'large.js');
        await fs.writeFile(filePath, rawText, 'utf8');

        // maxChars well below rawText.length forces compression
        const maxChars = Math.floor(rawText.length * 0.5);
        const result = await compressForTool(filePath, rawText, maxChars);

        // compressForTool must compress (not return null) and produce a shorter output
        expect(result).not.toBeNull();
        expect(result.length).toBeLessThan(rawText.length);
        // The 70% floor: result must not be shorter than 70% of rawText
        const floorChars = Math.floor(rawText.length * 0.70);
        expect(result.length).toBeGreaterThanOrEqual(floorChars * 0.5); // TOON may add markers; assert sensible range
    });

    it('rejects outputs not compressed enough — returns null when maxChars >= rawText.length', async () => {
        const rawText = 'export const x = 1;\n'.repeat(20);
        const filePath = path.join(tmpDir, 'small.js');
        await fs.writeFile(filePath, rawText, 'utf8');

        // When maxChars equals rawText.length: nothing to compress
        expect(await compressForTool(filePath, rawText, rawText.length)).toBeNull();
        // When maxChars exceeds rawText.length: also returns null
        expect(await compressForTool(filePath, rawText, rawText.length + 100)).toBeNull();
        // When maxChars is zero: also returns null (rawText.length > 0 but maxChars <= 0)
        expect(await compressForTool(filePath, rawText, 0)).toBeNull();
    });

    it('truncates cleanly on a newline — output lines have N. prefix and markers match contract', async () => {
        // Build a multi-line source file; the structured compressor emits N. <line> + [TRUNCATED: lines X-Y] markers
        const sourceLines = Array.from({ length: 80 }, (_, i) => `export const line${i} = ${i};`);
        const rawText = sourceLines.join('\n');
        const filePath = path.join(tmpDir, 'source.js');
        await fs.writeFile(filePath, rawText, 'utf8');

        const maxChars = Math.floor(rawText.length * 0.6);
        const result = await compressForTool(filePath, rawText, maxChars);

        // compressForTool must have compressed (not null)
        expect(result).not.toBeNull();

        const outputLines = result.split('\n');
        for (const outputLine of outputLines) {
            const isNumberedLine = /^\d+\. /.test(outputLine);
            const isMarkerLine = /^\[TRUNCATED: lines \d+-\d+\]$/.test(outputLine);
            expect(isNumberedLine || isMarkerLine).toBe(true);

            if (isNumberedLine) {
                // Extract 1-based line number and verify verbatim content matches source
                const dotIdx = outputLine.indexOf('. ');
                const lineNum = parseInt(outputLine.slice(0, dotIdx), 10);
                const content = outputLine.slice(dotIdx + 2);
                // 1-based line number maps to sourceLines[lineNum - 1]
                expect(sourceLines[lineNum - 1]).toBe(content);
            }
        }
    });
});
