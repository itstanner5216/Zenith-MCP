// validator/run.ts
//
// Run a contender on real files, time it, check determinism, validate the output.
//
//   npx tsx validator/run.ts <contenderModule> <file1> [file2 ...]
//
// THE CONTENDER IS A BLACK BOX. Its only contract is one function:
//
//     export function compress(rawText: string): string            // (sync or async)
//     // or: export default function (rawText: string): string
//
// Raw original file text in, compressed `N. `-prefixed-with-markers text out. Nothing about
// lines, drops, states, budgets, or engines is in that contract — the contender may solve the
// problem any way it likes. This runner only measures speed + determinism and hands the output
// to the validator, which checks it against the repo contract. How it works is not our concern;
// whether its output is legal (and how it behaves) is all we test.

import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { validate, formatReport, type ValidationReport } from './validate.js';

type CompressFn = (rawText: string) => string | Promise<string>;

const SLOW_MS = 1500; // your tolerance: a 3000-line file in ~1.5s is a maybe; slower is a problem

async function loadContender(modulePath: string): Promise<CompressFn> {
  const url = pathToFileURL(resolve(modulePath)).href;
  const mod: Record<string, unknown> = await import(url);
  const candidate = mod.compress ?? mod.default;
  if (typeof candidate !== 'function') {
    throw new Error(
      `contender module "${modulePath}" must export a \`compress(rawText)\` function (named or default).`,
    );
  }
  return candidate as CompressFn;
}

async function timeOnce(fn: CompressFn, raw: string): Promise<{ output: string; ms: number }> {
  const t0 = performance.now();
  const output = await fn(raw);
  return { output, ms: performance.now() - t0 };
}

async function main(): Promise<void> {
  const [, , modulePath, ...files] = process.argv;
  if (modulePath === undefined || files.length === 0) {
    console.error('usage: npx tsx validator/run.ts <contenderModule> <file1> [file2 ...]');
    process.exit(2);
  }

  let compress: CompressFn;
  try {
    compress = await loadContender(modulePath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
    return;
  }

  let allPass = true;

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const lineCount = raw.split('\n').length;

    let first: { output: string; ms: number };
    try {
      first = await timeOnce(compress, raw);
    } catch (err) {
      allPass = false;
      console.log(`\n=== ${file} (${lineCount} lines) ===`);
      console.log(`  THREW: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Determinism: run again, compare byte-for-byte.
    let deterministic = true;
    try {
      const second = await compress(raw);
      deterministic = second === first.output;
    } catch {
      deterministic = false;
    }

    const report: ValidationReport = validate(raw, first.output);
    if (!report.pass || !deterministic) allPass = false;

    const speedTag = first.ms > SLOW_MS ? '  [SLOW]' : '';
    console.log(`\n=== ${file} (${lineCount} lines) ===`);
    console.log(
      `  ${report.pass ? 'PASS' : 'FAIL'} | ${first.ms.toFixed(1)}ms${speedTag} | ` +
        `removed ${report.metrics.removedPct.toFixed(1)}% | ` +
        `deterministic: ${deterministic ? 'yes' : 'NO'} | ` +
        `largest hole: ${report.profile.maxOmission} lines`,
    );
    if (!report.pass) {
      for (const c of report.checks) {
        if (!c.pass) console.log(`     [FAIL] ${c.name}\n            ${c.detail}`);
      }
    }
    if (!deterministic) {
      console.log('     [FAIL] determinism — same input produced different output across two runs');
    }
  }

  console.log(`\n${allPass ? 'ALL FILES PASS' : 'ONE OR MORE FILES FAILED'} (validation is the gate; read "largest hole" to judge quality)`);
  process.exit(allPass ? 0 : 1);
}

void main();
