// ---------------------------------------------------------------------------
// rule12-unsupported-lang-seam.test.js
//
// Rule 12 regression coverage at the PUBLIC compressFile seam, replacing the
// deleted rev2-toon-unsupported-lang.test.js (which drove the removed
// compressString engine and demanded non-null output — a contract that no
// longer exists).
//
// What Rule 12 + Priority 0.4 still guarantee, and what this suite pins:
//
//   1. TOON never REFUSES TO TRY: an unsupported language (langName null, no
//      defs — exactly the facts shape the MCP seam sends when tree-sitter has
//      no grammar) must never throw out of compressFile. The public boundary
//      always resolves to `string | null`.
//   2. `null` is a first-class, CORRECT outcome ("use raw") — these tests
//      never treat null as failure.
//   3. IF a string is returned, it must be legal output: every line is either
//      a verbatim `N. `-prefixed copy of the original line at that number or
//      a flush-left `[TRUNCATED: lines X-Y]` marker, ascending, gap-accounted,
//      and shorter than the input.
//
// This suite deliberately asserts the throw/null/verify CONTRACT, not a
// particular compression outcome — whether today's engine chain compresses or
// declines a no-facts input is TOON's decision (Priority 0.5), and either
// answer is success. What is NEVER success is an exception escaping
// compressFile or an illegal string crossing the seam.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { compressFile } from 'zenith-toon';

const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const SHOWN_RE = /^(\d+)\. (.*)$/s;

// The exact facts shape packages/zenith-mcp/src/core/compression.ts hands TOON
// for a file with no tree-sitter grammar: langName null, every fact list empty.
function unsupportedFacts(relPath) {
    return {
        path: relPath,
        langName: null,
        defs: [],
        references: [],
        edges: [],
        referenceEdges: [],
        anchors: [],
        imports: [],
        importBindings: [],
        injections: [],
        scopes: [],
    };
}

function prefixLines(rawLines) {
    return rawLines.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

// If compressFile returned a string, it must be LEGAL output under the repo
// contract — re-derived entirely from the output text vs. the prefixed input.
function assertLegalOutput(prefixedSource, output) {
    const srcLines = prefixedSource.split('\n');
    const outLines = output.split('\n');

    let cursor = 0; // highest 1-based original line accounted for
    for (const raw of outLines) {
        const mm = MARKER_RE.exec(raw);
        if (mm) {
            const x = Number(mm[1]);
            const y = Number(mm[2]);
            expect(y, `marker ${raw}: end < start`).toBeGreaterThanOrEqual(x);
            expect(x, `marker ${raw}: overlaps/leaves silent gap`).toBe(cursor + 1);
            expect(y, `marker ${raw}: range beyond EOF`).toBeLessThanOrEqual(srcLines.length);
            expect(y - x + 1, `marker ${raw}: dropped run under the 6-line minimum`).toBeGreaterThanOrEqual(6);
            cursor = y;
            continue;
        }
        const sm = SHOWN_RE.exec(raw);
        expect(sm, `output line is neither a marker nor an 'N. ' line: ${JSON.stringify(raw)}`).not.toBeNull();
        const n = Number(sm[1]);
        expect(n, `shown line ${n}: out of order or silent gap`).toBe(cursor + 1);
        // Verbatim keystone: the whole output line equals the prefixed source line.
        expect(raw, `line ${n} not verbatim`).toBe(srcLines[n - 1]);
        cursor = n;
    }
    expect(cursor, 'output does not account for the full file').toBe(srcLines.length);
    expect(output.length, 'compressed output not shorter than input').toBeLessThan(prefixedSource.length);
}

// A body of code-shaped text in a language TOON has no grammar name for.
function buildUnsupportedSource(nDefs = 25, bodyLines = 10) {
    const rawLines = [];
    for (let f = 0; f < nDefs; f += 1) {
        rawLines.push(`def helper_${f}(ctx, options):`);
        for (let i = 0; i < bodyLines; i += 1) {
            rawLines.push(`    value_${f}_${i} = compute(ctx, ${i}, "xxxxxxxxxxxxxxxx")`);
        }
        rawLines.push(`    return value_${f}_0`);
    }
    return prefixLines(rawLines);
}

describe('Rule 12 — unsupported language at the public compressFile seam', () => {
    it('never throws for langName:null + empty facts across a budget sweep; any string returned is legal', () => {
        const source = buildUnsupportedSource();
        const budgets = [0.3, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0, 1.5];

        for (const mult of budgets) {
            const maxChars = Math.floor(source.length * mult);
            let result;
            // The ONLY forbidden outcome is a throw escaping compressFile.
            expect(() => {
                result = compressFile({ source, maxChars, facts: unsupportedFacts('scripts/tool.xyz') });
            }, `compressFile threw at budget ${mult}x`).not.toThrow();

            // Boundary contract: string | null, nothing else.
            expect(result === null || typeof result === 'string').toBe(true);
            if (typeof result === 'string') assertLegalOutput(source, result);
        }
    });

    it('never throws for prose (non-code) content with no facts', () => {
        const rawLines = [];
        for (let i = 0; i < 300; i += 1) {
            rawLines.push(`This is documentation paragraph line ${i} with prose text repeated for bulk.`);
        }
        const source = prefixLines(rawLines);

        let result;
        expect(() => {
            result = compressFile({ source, maxChars: Math.floor(source.length * 0.6), facts: unsupportedFacts('notes.txt') });
        }).not.toThrow();
        expect(result === null || typeof result === 'string').toBe(true);
        if (typeof result === 'string') assertLegalOutput(source, result);
    });

    it('degenerate inputs resolve to string|null, never a throw', () => {
        const cases = [
            { name: 'empty source', source: '', maxChars: 100 },
            { name: 'single line', source: '1. lone line of an unsupported language', maxChars: 10 },
            { name: 'zero budget', source: buildUnsupportedSource(4, 4), maxChars: 0 },
            { name: 'negative budget', source: buildUnsupportedSource(4, 4), maxChars: -5 },
            { name: 'blank lines only', source: prefixLines(['', '', '', '', '', '', '', '']), maxChars: 5 },
        ];

        for (const c of cases) {
            let result;
            expect(() => {
                result = compressFile({ source: c.source, maxChars: c.maxChars, facts: unsupportedFacts('misc.dat') });
            }, `compressFile threw on: ${c.name}`).not.toThrow();
            expect(result === null || typeof result === 'string', `non string|null on: ${c.name}`).toBe(true);
        }
    });

    it('supported language with empty facts (DB-unavailable seam path) also never throws', () => {
        // compression.ts degrades to the empty-facts payload when the symbol DB
        // is unavailable — same guarantee must hold with a langName present.
        const source = buildUnsupportedSource();
        const facts = { ...unsupportedFacts('src/x.ts'), langName: 'typescript' };

        let result;
        expect(() => {
            result = compressFile({ source, maxChars: Math.floor(source.length * 0.7), facts });
        }).not.toThrow();
        expect(result === null || typeof result === 'string').toBe(true);
        if (typeof result === 'string') assertLegalOutput(source, result);
    });
});
