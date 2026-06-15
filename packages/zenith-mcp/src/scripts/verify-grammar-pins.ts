/**
 * verify-grammar-pins.ts
 *
 * Reads grammars/.grammar-pins.json and verifies that each pinned grammar
 * WASM matches its recorded sha256. Exits nonzero on any mismatch.
 *
 * This is the "doesn't auto-update" enforcement: if someone swaps a pinned
 * wasm (re-download, accidental rebuild, dependency bump), this script
 * catches the drift.
 *
 * Usage: node dist/scripts/verify-grammar-pins.js
 *        pnpm verify-grammar-pins
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const grammarsDir = path.join(__dirname, '..', 'grammars', 'grammars');
const pinsPath = path.join(__dirname, '..', 'grammars', '.grammar-pins.json');

function sha256(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

function main(): void {
    if (!fs.existsSync(pinsPath)) {
        console.log('No grammar pins found (.grammar-pins.json missing). Nothing to verify.');
        return;
    }

    const manifest = JSON.parse(fs.readFileSync(pinsPath, 'utf-8'));
    const pinned = manifest.pinned as Record<string, {
        sha256: string;
        source: string;
        commit: string;
    }>;

    const entries = Object.entries(pinned);
    if (entries.length === 0) {
        console.log('No pinned grammars.');
        return;
    }

    let failures = 0;

    for (const [name, pin] of entries) {
        const wasmPath = path.join(grammarsDir, `tree-sitter-${name}.wasm`);

        if (!fs.existsSync(wasmPath)) {
            console.error(`FAIL  ${name}: wasm file not found at ${wasmPath}`);
            failures++;
            continue;
        }

        const actual = sha256(wasmPath);

        if (actual === pin.sha256) {
            console.log(`OK    ${name} (sha256 verified)`);
        } else {
            console.error(`FAIL  ${name}: sha256 mismatch`);
            console.error(`      expected: ${pin.sha256}`);
            console.error(`      actual:   ${actual}`);
            console.error(`      source:   ${pin.source}@${pin.commit}`);
            failures++;
        }
    }

    if (failures > 0) {
        console.error(`\n${failures} pinned grammar(s) failed verification.`);
        process.exit(1);
    }
}

main();
