// Package ownership — the MCP→TOON seam (Priority 0.5).
//
// Source: docs/toon-constraints/constraints.md §"Priority 0.5 — Package
// Ownership" (lines 17-97) and docs/toon-goal/zenith-toon-goal.md §"Package
// Ownership". These are STATIC guards over zenith-mcp source: MCP supplies raw
// facts and pipes TOON's string out verbatim — it makes ZERO compression
// decisions and reimplements ZERO engines.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, readMcpSource } from './invariants.js';

const MCP_SRC = path.join(REPO_ROOT, 'packages', 'zenith-mcp', 'src');

/** Recursively collect every .ts file under zenith-mcp/src. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ALL_MCP_FILES = walk(MCP_SRC);
const readAll = () => ALL_MCP_FILES.map((f) => ({ rel: path.relative(MCP_SRC, f), text: fs.readFileSync(f, 'utf8') }));

describe('Ownership — forbidden compression decisions are absent from MCP', () => {
  // Symbols that, per the constraints, must live in TOON and never in MCP.
  const FORBIDDEN_SYMBOLS = [
    'computeCompressionBudget',
    'isCompressionUseful',
    'DEFAULT_COMPRESSION_KEEP_RATIO',
    'truncateToBudget',
    'compressTextFile',
  ];

  it('none of the moved-to-TOON compression symbols appear in MCP', () => {
    const files = readAll();
    for (const sym of FORBIDDEN_SYMBOLS) {
      for (const { rel, text } of files) {
        expect(text.includes(sym), `forbidden symbol ${sym} found in zenith-mcp/src/${rel}`).toBe(false);
      }
    }
  });

  it('MCP does not import the structured-source or string engines from TOON', () => {
    // MCP is allowed exactly one TOON entry point: compressFile. Importing
    // compressSourceStructured / compressString would mean MCP is shaping
    // structure or choosing a codec — a compression decision.
    for (const { rel, text } of readAll()) {
      const toonImport = text.match(/import\s+\{([^}]*)\}\s+from\s+['"]zenith-toon['"]/);
      if (!toonImport) continue;
      const named = toonImport[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      expect(named, `zenith-mcp/src/${rel} imports more than compressFile from TOON`).toEqual(['compressFile']);
    }
  });

  it('MCP never reimplements an engine name as a local definition', () => {
    // The goal forbids fake local SageRank/BMX/budget/dedup. Guard against MCP
    // declaring its own.
    const ENGINE_DECLS = [
      /\b(?:class|function|const)\s+SageRank\b/,
      /\b(?:class|function|const)\s+BMXPlusIndex\b/,
      /\b(?:class|function|const)\s+BudgetAllocator\b/,
      /\b(?:class|function|const)\s+Deduplicator\b/,
    ];
    for (const { rel, text } of readAll()) {
      for (const re of ENGINE_DECLS) {
        expect(re.test(text), `zenith-mcp/src/${rel} declares a local engine (${re})`).toBe(false);
      }
    }
  });
});

describe('Ownership — the seam file is a pure facts pipe', () => {
  const seam = readMcpSource('core/compression.ts');

  it('imports exactly `compressFile` from zenith-toon, nothing else', () => {
    const matches = [...seam.matchAll(/from\s+['"]zenith-toon['"]/g)];
    expect(matches.length, 'exactly one zenith-toon import line').toBe(1);
    expect(seam).toMatch(/import\s+\{\s*compressFile\s*\}\s+from\s+['"]zenith-toon['"]/);
  });

  it('makes exactly one compressFile call', () => {
    const calls = [...seam.matchAll(/\bcompressFile\s*\(/g)];
    expect(calls.length, 'exactly one compressFile(...) invocation').toBe(1);
  });

  it('contains no compression-decision math (keep-ratio, sqrt weighting, thresholds)', () => {
    // The seam hands raw facts across. Any of these tokens in EXECUTABLE code
    // would mean a decision leaked back into MCP. The file's header comment
    // legitimately names these forbidden concepts, so scan code only.
    const code = seam
      .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1');     // line comments (keep `://` in URLs)
    const DECISION_TOKENS = [/Math\.sqrt/, /0\.70/, /keep.?ratio/i, /_MIN_OMISSION_THRESHOLD/, /TRUNCATED/];
    for (const re of DECISION_TOKENS) {
      expect(re.test(code), `seam contains compression-decision token ${re}`).toBe(false);
    }
  });
});

describe('Ownership — MCP pipes TOON output verbatim (no post-processing)', () => {
  // read_file / read_multiple_files must emit TOON's returned string untouched:
  // no re-prefixing, no `[truncated]` suffix, no re-slicing on the compressed
  // branch. We assert the compressed branch returns the value directly.
  const readFileTool = readMcpSource('tools/read_file.ts');
  const readMultiTool = readMcpSource('tools/read_multiple_files.ts');

  it('read_file returns the compressed string directly', () => {
    // The compressed branch must hand `compressed` straight into the result.
    expect(readFileTool).toMatch(/const compressed = await compressForTool\(/);
    expect(readFileTool).toMatch(/text:\s*compressed\b/);
    // It must NOT re-number or suffix the compressed value.
    expect(readFileTool).not.toMatch(/compressed\s*\.\s*split\(/);
    expect(readFileTool).not.toMatch(/compressed[^;\n]*\[truncated\]/);
  });

  it('read_multiple_files returns the compressed string (prefix only, verbatim body)', () => {
    expect(readMultiTool).toMatch(/const compressed = await compressForTool\(/);
    // Only the entry prefix may be prepended; the compressed body is untouched.
    expect(readMultiTool).toMatch(/return\s+`\$\{entryPrefix\}\$\{compressed\}`/);
    expect(readMultiTool).not.toMatch(/compressed\s*\.\s*split\(/);
  });
});

describe('Ownership — no NEW MCP-side compression/toon-named files', () => {
  it('the only compression/toon-named MCP source file is the sanctioned seam', () => {
    const named = ALL_MCP_FILES
      .map((f) => path.relative(MCP_SRC, f))
      .filter((rel) => /compress|toon/i.test(path.basename(rel)));
    expect(named.sort()).toEqual(['core/compression.ts']);
  });
});
