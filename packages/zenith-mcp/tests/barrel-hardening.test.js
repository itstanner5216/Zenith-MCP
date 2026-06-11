// ---------------------------------------------------------------------------
// barrel-hardening.test.js
//
// Mechanical lock on the public tree-sitter barrel.
//
// The barrel is the seam between extractor internals and the rest of the
// world (per Locked Decision #14 + the comment in src/core/tree-sitter.ts).
// External consumers MUST go through indexed-symbols.ts / db-adapter.ts —
// the barrel deliberately does NOT re-export getSymbols / getDefinitions /
// findSymbol / extractStructureForDef / extractAnchorsForDef /
// extractImportsFromSymbols / extractInjections / extractLocals /
// bodySlice / bodyHash / parseCaptureTag / DEF_TYPES / QUERIES_LANG_MAP /
// getCompiledModularQuery.
//
// This test imports the dist barrel as a namespace object and asserts the
// SET of exported names is EXACTLY the 7 sanctioned ones:
//
//   { getLangForFile, getSupportedExtensions, isSupported,
//     treeSitterAvailable, loadLanguage, getCompiledQuery,
//     checkSyntaxErrors }
//
// On a mismatch the failure message reports the symmetric difference by
// name (extras + missing) so any future leak is loud and named.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import * as barrel from '../dist/core/tree-sitter.js';

const EXPECTED_EXPORTS = new Set([
    'getLangForFile',
    'getSupportedExtensions',
    'isSupported',
    'treeSitterAvailable',
    'loadLanguage',
    'getCompiledQuery',
    'checkSyntaxErrors',
]);

describe('barrel-hardening — public tree-sitter barrel surface', () => {
    it('Object.keys(barrel) equals EXACTLY the 7 sanctioned exports (symmetric difference reported by name)', () => {
        const actual = new Set(Object.keys(barrel));

        // Build the symmetric difference once so the failure message can
        // name every leak and every missing export at the same time.
        const extras = [...actual].filter((k) => !EXPECTED_EXPORTS.has(k)).sort();
        const missing = [...EXPECTED_EXPORTS].filter((k) => !actual.has(k)).sort();

        const expectedSorted = [...EXPECTED_EXPORTS].sort();
        const actualSorted = [...actual].sort();

        expect(
            { extras, missing },
            `Barrel surface must be exactly the 7 sanctioned exports.\n` +
            `  Expected (${expectedSorted.length}): ${JSON.stringify(expectedSorted)}\n` +
            `  Actual   (${actualSorted.length}): ${JSON.stringify(actualSorted)}\n` +
            `  Extras   (forbidden leaks): ${JSON.stringify(extras)}\n` +
            `  Missing  (removed by leak): ${JSON.stringify(missing)}\n` +
            `If a future consumer needs symbol/structure/anchor data, route ` +
            `it through indexed-symbols.ts or db-adapter.ts — do NOT re-add ` +
            `the export here (Locked Decision #14).`,
        ).toEqual({ extras: [], missing: [] });
    });
});
