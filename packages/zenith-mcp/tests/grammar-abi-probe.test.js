import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLanguage } from '../dist/core/tree-sitter/runtime.js';
import { Parser, Language } from 'web-tree-sitter';
import { ensureInit } from '../dist/core/tree-sitter/runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGrammarsDir = path.join(__dirname, '..', 'dist', 'grammars', 'grammars');
const sqlWasmPath = path.join(distGrammarsDir, 'tree-sitter-sql.wasm');
const brokenFixture = path.join(__dirname, 'fixtures', 'tree-sitter-sql-abi-broken.wasm');
const goodBackup = sqlWasmPath + '.probe-test-bak';

describe('Grammar ABI compatibility probe', () => {

    describe('detection mechanism', () => {
        // Tests that the broken wasm fixture exhibits the exact failure mode
        // the probe is designed to catch: Language.load() succeeds but
        // Parser.parse() throws a RuntimeError.

        it('loads the ABI-broken fixture successfully (Language metadata intact)', async () => {
            await ensureInit();
            const language = await Language.load(brokenFixture);
            expect(language).toBeDefined();
            expect(language.nodeTypeCount).toBeGreaterThan(0);
        });

        it('crashes on parse with a RuntimeError (the ABI mismatch signature)', async () => {
            await ensureInit();
            const language = await Language.load(brokenFixture);
            const parser = new Parser();
            parser.setLanguage(language);
            expect(() => parser.parse('')).toThrow();
        });
    });

    describe('loadLanguage integration', () => {
        let language;
        let stderrOutput = '';
        let originalStderrWrite;

        beforeAll(async () => {
            // Back up the working wasm and swap in the ABI-broken fixture
            fs.copyFileSync(sqlWasmPath, goodBackup);
            fs.copyFileSync(brokenFixture, sqlWasmPath);

            // Capture stderr to verify the probe's warning
            originalStderrWrite = process.stderr.write.bind(process.stderr);
            process.stderr.write = (chunk, ...args) => {
                stderrOutput += String(chunk);
                return true;
            };

            // This is the only loadLanguage('sql') call in this process,
            // so the module-level cache is empty — the probe runs.
            language = await loadLanguage('sql');

            process.stderr.write = originalStderrWrite;
        });

        afterAll(() => {
            // Restore the working wasm
            if (fs.existsSync(goodBackup)) {
                fs.copyFileSync(goodBackup, sqlWasmPath);
                fs.unlinkSync(goodBackup);
            }
        });

        it('returns the Language (not null) despite ABI mismatch', () => {
            // Query compilation and symbol metadata must remain available
            expect(language).not.toBeNull();
            expect(language.nodeTypeCount).toBeGreaterThan(0);
        });

        it('logs a clear ABI-incompatible warning to stderr', () => {
            expect(stderrOutput).toContain('ABI-incompatible');
            expect(stderrOutput).toContain('sql');
            expect(stderrOutput).toContain('parsing is disabled');
        });

        it('mentions the fix (rebuild with pinned CLI)', () => {
            expect(stderrOutput).toContain('Rebuild');
        });
    });
});
