import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ORIGINAL = path.resolve('dist', 'tools', 'directory.js');
const COMPILED = path.resolve('dist', 'tools', 'directory.js');

function getExportNames(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const names = new Set();
  // export function foo(
  for (const m of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  // export const foo =
  for (const m of content.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  // export class Foo
  for (const m of content.matchAll(/export\s+class\s+(\w+)/g)) names.add(m[1]);
  // export { foo, bar as baz }
  for (const m of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    m[1].split(',').forEach(s => {
      const raw = s.trim();
      if (!raw) return;
      const name = raw.split(/\s+as\s+/i)[0].trim();
      if (name) names.add(name);
    });
  }
  // export default
  if (/export\s+default\b/.test(content)) names.add('default');
  return [...names].sort();
}

function getFunctionSigs(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const sigs = {};
  // export function foo(a, b, c=1) {
  for (const m of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)) {
    const params = m[2].split(',').filter(p => p.trim() && !p.trim().startsWith('...')).length;
    sigs[m[1]] = params;
  }
  // export const foo = (a, b) =>
  for (const m of content.matchAll(/export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g)) {
    const params = m[2].split(',').filter(p => p.trim()).length;
    sigs[m[1]] = params;
  }
  return sigs;
}

describe('MIGRATION GATE: tools/directory.js', () => {
  it('original file must exist', () => {
    expect(fs.existsSync(ORIGINAL), 'Missing original dist file').toBe(true);
  });

  it('compiled file must exist', () => {
    expect(fs.existsSync(COMPILED), 'Missing compiled dist file').toBe(true);
  });

  it('must preserve all exports', () => {
    const orig = getExportNames(ORIGINAL);
    const comp = getExportNames(COMPILED);
    expect(comp, 'Missing or added exports').toEqual(orig);
  });

  it('must preserve all function parameter counts', () => {
    const orig = getFunctionSigs(ORIGINAL);
    const comp = getFunctionSigs(COMPILED);
    for (const [name, count] of Object.entries(orig)) {
      expect(comp[name], `Function ${name} parameter count changed or removed`).toBe(count);
    }
    for (const name of Object.keys(comp)) {
      expect(orig[name], `Function ${name} was added`).toBeDefined();
    }
  });
});
