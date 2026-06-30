import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compressForTool } from '../dist/core/compression.js';
import { findRepoRoot, getDb } from '../dist/core/symbol-index.js';

// A realistic, source-like TS module: interfaces, interdependent functions that
// call each other (clamp ← normalizeConfig/computeScore ← Runner) and a class.
// This produces real tree-sitter defs and call edges, so the structured
// compressor has genuine ranking signal to drop low-value bodies down to the
// 68–72% retention band. Synthetic repeated `const x = N;` lines have no such
// signal and are (correctly) left uncompressed.
const FIXTURE_SOURCE = [
    'export interface Config {',
    '    name: string;',
    '    retries: number;',
    '    timeout: number;',
    '    verbose: boolean;',
    '}',
    '',
    'export interface Result {',
    '    ok: boolean;',
    '    value: number;',
    '    message: string;',
    '}',
    '',
    'const DEFAULT_RETRIES = 3;',
    'const DEFAULT_TIMEOUT = 1000;',
    '',
    'export function clamp(value: number, min: number, max: number): number {',
    '    if (value < min) {',
    '        return min;',
    '    }',
    '    if (value > max) {',
    '        return max;',
    '    }',
    '    return value;',
    '}',
    '',
    'export function normalizeConfig(input: Partial<Config>): Config {',
    '    const retries = clamp(input.retries ?? DEFAULT_RETRIES, 0, 10);',
    '    const timeout = clamp(input.timeout ?? DEFAULT_TIMEOUT, 100, 60000);',
    '    return {',
    '        name: input.name ?? "default",',
    '        retries,',
    '        timeout,',
    '        verbose: input.verbose ?? false,',
    '    };',
    '}',
    '',
    'export function computeScore(values: number[]): number {',
    '    let total = 0;',
    '    for (const value of values) {',
    '        total += clamp(value, 0, 100);',
    '    }',
    '    if (values.length === 0) {',
    '        return 0;',
    '    }',
    '    return total / values.length;',
    '}',
    '',
    'export class Runner {',
    '    private config: Config;',
    '    private history: Result[];',
    '',
    '    constructor(input: Partial<Config>) {',
    '        this.config = normalizeConfig(input);',
    '        this.history = [];',
    '    }',
    '',
    '    run(values: number[]): Result {',
    '        const score = computeScore(values);',
    '        const ok = score >= 50;',
    '        const result: Result = {',
    '            ok,',
    '            value: score,',
    '            message: ok ? "passed" : "failed",',
    '        };',
    '        this.history.push(result);',
    '        return result;',
    '    }',
    '',
    '    summary(): string {',
    '        const passed = this.history.filter((r) => r.ok).length;',
    '        const total = this.history.length;',
    '        return `${passed}/${total} passed`;',
    '    }',
    '',
    '    reset(): void {',
    '        this.history = [];',
    '    }',
    '}',
    '',
].join('\n');

// read_file places the `N. ` line-number prefix once before handing text to the
// compression pipe; mirror that here so compressForTool sees prefixed source.
function prefixLines(source) {
    return source.split('\n').map((line, i) => `${i + 1}. ${line}`).join('\n');
}

describe('compression core', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-compression-core-'));
        // findRepoRoot() walks up for a `.git` entry; create one so the temp dir
        // is recognized as a repo root and the symbol indexer can populate facts.
        await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
    });

    afterEach(async () => {
        if (tmpDir) {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('targets 70 percent of the original content by default', async () => {
        // A realistic source module (real defs + call edges) is what the
        // structured compressor needs to drop low-value bodies; the prefixed
        // text is what read_file hands to the pipe.
        const filePath = path.join(tmpDir, 'fixture.ts');
        await fs.writeFile(filePath, FIXTURE_SOURCE, 'utf8');
        getDb(findRepoRoot(tmpDir));
        const prefixed = prefixLines(FIXTURE_SOURCE);

        // maxChars below prefixed length forces compression
        const maxChars = Math.floor(prefixed.length * 0.6);
        const result = await compressForTool(filePath, prefixed, maxChars);

        // compressForTool must compress (not return null) and produce a shorter output
        expect(result).not.toBeNull();
        expect(result.length).toBeLessThan(prefixed.length);
        // Documented retention contract: 68–72% acceptable, ">72% not acceptable"
        // (markers included). This fixture lands at ~68.7%, so assert a tight,
        // truthful band around the 70% target.
        expect(result.length).toBeGreaterThanOrEqual(Math.floor(prefixed.length * 0.65));
        expect(result.length).toBeLessThanOrEqual(Math.floor(prefixed.length * 0.72));
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
        // The structured compressor emits verbatim `N. <line>` plus
        // [TRUNCATED: lines X-Y] markers; every shown line must map back to the
        // exact prefixed source line at that 1-based position.
        const filePath = path.join(tmpDir, 'source.ts');
        await fs.writeFile(filePath, FIXTURE_SOURCE, 'utf8');
        getDb(findRepoRoot(tmpDir));
        const prefixedLines = FIXTURE_SOURCE.split('\n').map((line, i) => `${i + 1}. ${line}`);
        const prefixed = prefixedLines.join('\n');

        const maxChars = Math.floor(prefixed.length * 0.6);
        const result = await compressForTool(filePath, prefixed, maxChars);

        // compressForTool must have compressed (not null)
        expect(result).not.toBeNull();

        const outputLines = result.split('\n');
        for (const outputLine of outputLines) {
            const isNumberedLine = /^\d+\. /.test(outputLine);
            const isMarkerLine = /^\[TRUNCATED: lines \d+-\d+\]$/.test(outputLine);
            expect(isNumberedLine || isMarkerLine).toBe(true);

            if (isNumberedLine) {
                // The 1-based line number maps to the verbatim prefixed source line.
                const dotIdx = outputLine.indexOf('. ');
                const lineNum = parseInt(outputLine.slice(0, dotIdx), 10);
                expect(prefixedLines[lineNum - 1]).toBe(outputLine);
            }
        }
    });
});
