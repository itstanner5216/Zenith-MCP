import fs from 'fs/promises';
import path from 'path';

import {
    computeCompressionBudget,
    runToonBridge,
    isCompressionUseful,
} from '../dist/core/compression.js';
import { register as registerReadTextFile } from '../dist/tools/read_file.js';
import { register as registerReadMultipleFiles } from '../dist/tools/read_multiple_files.js';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tests', 'artifacts', 'compression');

const FILES = [
    'dist/core/shared.js',
    'dist/tools/search_files.js',
    'dist/tools/read_file.js',
    'dist/core/tree-sitter.js',
    'dist/core/toon_bridge.js',
    'dist/tools/write_file.js',
];

function createServer() {
    const tools = new Map();
    return {
        tools,
        registerTool(name, _config, handler) {
            tools.set(name, handler);
        },
    };
}

function createCtx(rootDir) {
    return {
        async validatePath(requestedPath) {
            const resolved = path.resolve(rootDir, requestedPath);
            if (!resolved.startsWith(rootDir)) {
                throw new Error('Access denied');
            }
            return resolved;
        },
    };
}

function hasStructuredMarkers(text) {
    return /# \.\.\. \[lines \d+-\d+ omitted\]/.test(text) || /# \.\.\. \[\d+ lines omitted\]/.test(text);
}

function hasHardCut(text) {
    return !text.endsWith('\n') && !text.endsWith('}') && !text.endsWith('];') && !text.endsWith(');');
}

function preview(text, length = 1500) {
    return text.slice(0, length);
}

async function ensureCleanDir(dir) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
}

async function main() {
    await ensureCleanDir(OUT_DIR);

    const server = createServer();
    const ctx = createCtx(ROOT);
    registerReadTextFile(server, ctx);
    registerReadMultipleFiles(server, ctx);

    const readText = server.tools.get('read_file');
    const readMultiple = server.tools.get('read_multiple_files');

    const summary = [];

    for (const relPath of FILES) {
        const absPath = path.join(ROOT, relPath);
        const raw = await fs.readFile(absPath, 'utf8');
        const budget = computeCompressionBudget(raw.length, 50_000);
        const bridge = await runToonBridge(absPath, budget);
        const finalResult = await readText({ path: relPath, compression: true, maxChars: 50_000 });
        const finalText = finalResult.content[0].text;

        const bridgeAccepted = isCompressionUseful(raw, bridge, 50_000);
        const finalMode = bridgeAccepted ? 'tree-sitter structured output accepted' : 'bridge rejected, 70% fallback truncation used';

        const artifact = [
            `FILE: ${relPath}`,
            `RAW_CHARS: ${raw.length}`,
            `TARGET_70_PERCENT_BUDGET: ${budget}`,
            `BRIDGE_CHARS: ${bridge ? bridge.length : 0}`,
            `FINAL_TOOL_CHARS: ${finalText.length}`,
            `BRIDGE_ACCEPTED: ${bridgeAccepted}`,
            `FINAL_MODE: ${finalMode}`,
            `BRIDGE_HAS_STRUCTURED_MARKERS: ${bridge ? hasStructuredMarkers(bridge) : false}`,
            `FINAL_HAS_STRUCTURED_MARKERS: ${hasStructuredMarkers(finalText)}`,
            `FINAL_LOOKS_HARD_CUT: ${hasHardCut(finalText)}`,
            '',
            '=== FINAL TOOL OUTPUT ===',
            finalText,
            '',
            '=== DIRECT TOON BRIDGE OUTPUT ===',
            bridge ?? '[null]',
            '',
            '=== RAW PREVIEW (first 1500 chars) ===',
            preview(raw),
            '',
        ].join('\n');

        const outName = relPath.replace(/[\/.]/g, '_') + '.txt';
        await fs.writeFile(path.join(OUT_DIR, outName), artifact, 'utf8');

        summary.push({
            relPath,
            raw: raw.length,
            budget,
            bridge: bridge ? bridge.length : 0,
            final: finalText.length,
            bridgeAccepted,
            bridgeMarkers: bridge ? hasStructuredMarkers(bridge) : false,
            finalMarkers: hasStructuredMarkers(finalText),
            finalHardCut: hasHardCut(finalText),
        });
    }

    const multiResult = await readMultiple({
        paths: FILES,
        maxCharsPerFile: 50_000,
    });
    await fs.writeFile(
        path.join(OUT_DIR, 'read_multiple_files_output.txt'),
        multiResult.content[0].text,
        'utf8',
    );

    const summaryText = [
        'Compression artifact summary',
        '',
        ...summary.map((row) =>
            [
                `FILE: ${row.relPath}`,
                `  raw=${row.raw}`,
                `  target_budget=${row.budget}`,
                `  bridge=${row.bridge}`,
                `  final=${row.final}`,
                `  bridge_accepted=${row.bridgeAccepted}`,
                `  bridge_has_structured_markers=${row.bridgeMarkers}`,
                `  final_has_structured_markers=${row.finalMarkers}`,
                `  final_looks_hard_cut=${row.finalHardCut}`,
                '',
            ].join('\n')
        ),
    ].join('\n');

    await fs.writeFile(path.join(OUT_DIR, 'SUMMARY.txt'), summaryText, 'utf8');

    process.stdout.write(`${OUT_DIR}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
});
