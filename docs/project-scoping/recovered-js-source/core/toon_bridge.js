// toon_bridge.js
// Accepts a file path and budget (chars) via CLI args.
// Runs tree-sitter to extract code structure, then calls toon's
// --structured mode via subprocess, returning the compressed result.
//
// Usage: node toon_bridge.js <filepath> <budget_chars>

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { getCompressionStructure, getLangForFile } from './tree-sitter.js';

const inputPath = process.argv[2];
const budget    = parseInt(process.argv[3], 10);

if (!inputPath || isNaN(budget)) {
    process.stderr.write('Usage: node toon_bridge.js <filepath> <budget_chars>\n');
    process.exit(1);
}

const content = readFileSync(inputPath, 'utf8');

if (content.length <= budget) {
    process.stdout.write(content);
    process.exit(0);
}

let structure = null;
const langName = getLangForFile(inputPath);

if (langName) {
    try {
        const defs = await getCompressionStructure(content, langName);
        if (defs && defs.length > 0) {
            structure = defs;
        }
    } catch (e) {
        process.stderr.write(`tree-sitter parse failed for ${inputPath}: ${e.message}\n`);
    }
}

// Hand off to toon --structured (falls back to regex codec if structure is null)
const payload = JSON.stringify({ content, budget, structure });

const toonProjectDir = process.env.TOON_PROJECT_DIR || '/home/tanner/Projects/toon';

const result = execFileSync('python3', ['-m', 'toon', '--structured'], {
    input:     payload,
    encoding:  'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout:   30_000,
    cwd:       toonProjectDir,
});

process.stdout.write(result);
