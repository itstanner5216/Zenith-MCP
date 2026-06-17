// ---------------------------------------------------------------------------
// compression-seam.test.js
//
// Source-scan invariants for the MCP↔TOON compression seam. The seam's
// architectural contract (docs/toon-constraints §0.5 — "tree-sitter extracts
// facts, db-adapter persists them, consumers read the DB; TOON owns every
// compression decision") is enforced via grep-style scans of two source
// files, not via behavioral tests. This test fails LOUDLY when a future
// change tries to:
//
//   - reintroduce compression decisions inside MCP (budget math, usefulness
//     gates, keep-ratio math, anchor mapping, exported-symbol selection,
//     injection boosting, sqrt damping, structured-source compression,
//     compressString delegation, etc.).
//   - import more than one symbol from zenith-toon (or import anything
//     other than `compressFile`).
//   - sneak `Math.sqrt` into `db-adapter.ts` (the v3 remediation pinned
//     edges to RAW call counts; sqrt damping is TOON's responsibility).
//
// All forbidden tokens are checked literally against the source bytes at
// rest, so this test depends only on filesystem state — not on dist builds.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMPRESSION_PATH = path.resolve(__dirname, '..', 'src', 'core', 'compression.ts');
const DB_ADAPTER_PATH = path.resolve(__dirname, '..', 'src', 'core', 'db-adapter.ts');

// Tokens that must not appear anywhere in compression.ts. Each name is a
// compression decision owned by TOON; any reappearance here means MCP has
// taken back ownership of something the seam handed away.
const FORBIDDEN_COMPRESSION_TOKENS = [
    'computeCompressionBudget',
    'isCompressionUseful',
    'DEFAULT_COMPRESSION_KEEP_RATIO',
    'truncateToBudget',
    'compressTextFile',
    'compressSourceStructured',
    'compressString',
    'keepRatio',
    'StructureBlock',
    'Math.sqrt',
];

describe('compression-seam — source-scan invariants', () => {
    it('compression.ts contains none of the forbidden compression-decision tokens', async () => {
        const source = await fs.readFile(COMPRESSION_PATH, 'utf8');

        // Collect every hit so the failure message names them all at once
        // instead of failing one-by-one.
        const hits = FORBIDDEN_COMPRESSION_TOKENS.filter((tok) => source.includes(tok));

        expect(
            hits,
            `compression.ts must contain ZERO compression-decision tokens, but found: ${JSON.stringify(hits)}.\n` +
            `Each of these is TOON's job per docs/toon-constraints §0.5. ` +
            `If MCP needs that functionality, route it through compressFile() instead.`,
        ).toEqual([]);
    });

    it('compression.ts imports EXACTLY one symbol from zenith-toon: compressFile', async () => {
        const source = await fs.readFile(COMPRESSION_PATH, 'utf8');

        // Match every `from 'zenith-toon'` import statement (handles both
        // single- and double-quoted forms). Each match's m[1] is the brace
        // contents — the import specifier list.
        const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]zenith-toon['"]\s*;?/g;
        const matches = [...source.matchAll(importRe)];

        expect(
            matches.length,
            `compression.ts must have exactly ONE 'from \\'zenith-toon\\'' import, found ${matches.length}.`,
        ).toBe(1);

        // Parse the imported names — strip whitespace, drop empty entries,
        // drop `type ` prefixes (we want value imports only).
        const importedNames = matches[0][1]
            .split(',')
            .map((s) => s.trim())
            .map((s) => s.replace(/^type\s+/, ''))
            .filter((s) => s.length > 0);

        expect(
            importedNames,
            `compression.ts must import ONLY { compressFile } from zenith-toon, got: ${JSON.stringify(importedNames)}.`,
        ).toEqual(['compressFile']);
    });

    it('db-adapter.ts contains no Math.sqrt (edge weights stay RAW)', async () => {
        const source = await fs.readFile(DB_ADAPTER_PATH, 'utf8');

        // Sqrt damping is TOON's responsibility (per Locked Decision #16
        // "raw call_count, no Math.sqrt anywhere in MCP — enforced by test").
        // The string scan is intentionally literal so any future
        // `Math.sqrt(...)` call inside MCP fails loudly here.
        expect(
            source.includes('Math.sqrt'),
            `db-adapter.ts must not contain Math.sqrt — call counts are persisted RAW; ` +
            `sqrt damping is TOON's responsibility (Locked Decision #16).`,
        ).toBe(false);
    });
});
