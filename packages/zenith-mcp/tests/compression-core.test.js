import fs from 'fs/promises';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compressForTool } from '../dist/core/compression.js';

describe('compression core', () => {
    let tmpDir;

    beforeEach(async () => {
        const parent = path.join(process.cwd(), '.vitest-temp');
        await fs.mkdir(parent, { recursive: true });
        tmpDir = await fs.mkdtemp(path.join(parent, 'zenith-compression-core-'));
        await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
    });

    afterEach(async () => {
        if (tmpDir) {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('targets 70 percent of the original content by default', async () => {
        const rawText = await fs.readFile(path.join(process.cwd(), 'src/core/lib.ts'), 'utf8');
        const filePath = path.join(tmpDir, 'src/core/lib.ts');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, rawText, 'utf8');
        const prefixedSource = rawText.split('\n').map((line, i) => `${i + 1}. ${line}`).join('\n');

        const maxChars = Math.floor(prefixedSource.length * 0.72);
        const result = await compressForTool(filePath, prefixedSource, maxChars);

        // compressForTool must compress (not return null) and produce a shorter output
        expect(result).not.toBeNull();
        expect(result.length).toBeLessThan(prefixedSource.length);
        // Documented retention contract: 68–72% acceptable, ">72% not acceptable"
        // (markers included). Line-granularity + marker accounting puts this fixture
        // at ~69.7%, so assert a tight, truthful band around the 70% target. The old
        // `floorChars * 0.5` allowed down to 35% retention and caught nothing.
        expect(result.length).toBeGreaterThanOrEqual(Math.floor(prefixedSource.length * 0.68));
        expect(result.length).toBeLessThanOrEqual(Math.floor(prefixedSource.length * 0.72));
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
        const rawText = await fs.readFile(path.join(process.cwd(), 'src/core/lib.ts'), 'utf8');
        const filePath = path.join(tmpDir, 'src/core/lib.ts');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, rawText, 'utf8');
        const sourceLines = rawText.split('\n');
        const prefixedSource = sourceLines.map((line, i) => `${i + 1}. ${line}`).join('\n');
        const maxChars = Math.floor(prefixedSource.length * 0.72);
        const result = await compressForTool(filePath, prefixedSource, maxChars);

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
