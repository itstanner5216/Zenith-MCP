// Goal alignment — reuse the real engines; ship no fake knockoffs.
//
// Source: docs/toon-goal/zenith-toon-goal.md §"Use the Real Engines" &
// §"Forbidden Designs", and docs/toon-constraints/constraints.md lines 79, 56-58.
// SageRank/BMX+/BudgetAllocator/Deduplicator are imported and called, never
// reimplemented as "simpler" local versions.

import { describe, it, expect } from 'vitest';
import * as toon from '../../src/index.js';
import { readToonSource, TOON_PKG_ROOT } from './invariants.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Goal — the real engines exist and are the public surface', () => {
  it('the named engine source files are present', () => {
    for (const f of ['sagerank.ts', 'bmx-plus.ts', 'budget.ts', 'dedup.ts']) {
      expect(fs.existsSync(path.join(TOON_PKG_ROOT, 'src', f)), `missing engine src/${f}`).toBe(true);
    }
  });

  it('public API re-exports the engines and the codec entry points', () => {
    // These are the live surface MCP and tests depend on; dropping any is drift.
    expect(typeof toon.compressFile).toBe('function');
    expect(typeof toon.compressSourceStructured).toBe('function');
    expect(typeof toon.compressString).toBe('function');
    expect(typeof toon.SageRank).toBe('function'); // class
    expect(typeof toon.BMXPlusIndex).toBe('function');
    expect(typeof toon.BudgetAllocator).toBe('function');
    expect(typeof toon.Deduplicator).toBe('function');
  });
});

describe('Goal — SageRank is imported, not reimplemented inside the codec', () => {
  const codec = readToonSource('string-codec.ts');

  it('string-codec imports SageRank from the real engine module', () => {
    expect(codec).toMatch(/import\s+\{\s*SageRank\s*\}\s+from\s+['"]\.\/sagerank\.js['"]/);
  });

  it('string-codec instantiates SageRank rather than defining a local one', () => {
    expect(codec).toMatch(/new\s+SageRank\s*\(/);
    expect(codec, 'codec must not redefine SageRank').not.toMatch(/\bclass\s+SageRank\b/);
  });

  it('exactly one SageRank class definition exists in the package', () => {
    const srcDir = path.join(TOON_PKG_ROOT, 'src');
    const defs = fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\bclass\s+SageRank\b/.test(fs.readFileSync(path.join(srcDir, f), 'utf8')));
    expect(defs).toEqual(['sagerank.ts']);
  });
});

describe('Goal — no MCP-side tree-sitter-to-TOON compression adapter', () => {
  it('the structured engine lives in TOON, exposed via compressSourceStructured', () => {
    // The structured-source decision engine must be a TOON export. (Its presence
    // here, combined with the package-ownership guards, pins the ownership line.)
    expect(typeof toon.compressSourceStructured).toBe('function');
    const codec = readToonSource('string-codec.ts');
    expect(codec).toMatch(/function _compressSourceStructured\(/);
  });
});
