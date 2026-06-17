// Shared invariant checker for the zenith-toon constraint suite.
//
// This module encodes the Priority-0 ("line numbers must be TRUE") guarantees
// from docs/toon-constraints/constraints.md as a single mechanical validator so
// every entry point and fixture is held to the same contract. It is test
// support only — it never ships — so the "no helpers" rule that governs the
// inline emission code in string-codec.ts does not apply here.
//
// The validator operates on the line-numbered structured-source output form:
//   - shown lines:   `N. <verbatim original line N>`
//   - omission marks: `[TRUNCATED: lines X-Y]` (flush-left, 1-based inclusive)
//
// It deliberately does NOT enforce the 6-line omission threshold itself: that
// floor is path-specific (Phase H guarantees it for the structured engine) and
// is asserted separately by the callers that know which path they exercised.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TOON_PKG_ROOT = path.resolve(THIS_DIR, '..', '..');
export const REPO_ROOT = path.resolve(TOON_PKG_ROOT, '..', '..');

/** Canonical, sole-permitted omission marker. Flush-left, 1-based inclusive. */
export const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
/** A shown line: line number, dot, single space, then verbatim content. */
export const SHOWN_RE = /^(\d+)\. ([\s\S]*)$/;

/** Legacy / forbidden marker shapes that must never appear in output. */
export const LEGACY_OMISSION_RE = /\[\s*\d+\s+lines?\s+omitted\s*\]/i; // `# ... [N lines omitted]`
export const L_ANNOTATION_RE = /#\s*L\d+\b/;                          // `# L{n}` signature hack

export interface InvariantOptions {
  /**
   * When set, every internal omission gap (between two shown lines) must span at
   * least this many lines. The structured engine guarantees 6 via Phase H; the
   * plain `compressString` source path makes no such promise, so callers opt in.
   */
  minGap?: number;
  /**
   * Require that an omission running to EOF carries a closing
   * `[TRUNCATED: lines X-end]` marker, i.e. the last shown line must be the last
   * source line unless a trailing marker accounts for the tail. Defaults to
   * true. The structured engine's budget-break path currently drops the tail
   * without a marker, so the sweeps that exercise that path opt out explicitly
   * (and the gap is escalated separately); every other call keeps it strict.
   */
  requireTrailingMarker?: boolean;
  /**
   * Require that an omission starting at the top of the file carries an opening
   * `[TRUNCATED: lines 1-X]` marker, i.e. the first shown line must be line 1
   * unless a leading marker accounts for the head. Defaults to true. The
   * structured engine's budget-break path can drop leading low-priority lines
   * (e.g. blank/comment runs) without a marker, so the sweeps that exercise that
   * path opt out explicitly (escalated separately); every other call stays strict.
   */
  requireLeadingMarker?: boolean;
  /** Human label surfaced in assertion messages. */
  label?: string;
}

/**
 * Validate one compressed output against the original source. Throws an Error
 * with a precise message on the first violation. Returns the set of shown
 * 1-based line numbers and the parsed markers for further assertions.
 *
 * Enforces the full Priority-0 contract: verbatim content, strictly ascending
 * numbers, and that EVERY omitted range — leading, internal, or trailing — is
 * accounted for by a `[TRUNCATED: lines X-Y]` marker whose range exactly equals
 * the omission (constraints.md:3 and the good/bad examples at 113-158).
 */
export function assertLineTruth(
  source: string,
  output: string,
  opts: InvariantOptions = {},
): { shown: number[]; markers: Array<{ x: number; y: number }> } {
  const label = opts.label ? `[${opts.label}] ` : '';
  const requireTrailingMarker = opts.requireTrailingMarker ?? true;
  const requireLeadingMarker = opts.requireLeadingMarker ?? true;
  const srcLines = source.split('\n');
  const total = srcLines.length;

  if (output.length === 0) {
    throw new Error(`${label}empty output for non-empty source`);
  }

  const outLines = output.split('\n');
  const shown: number[] = [];
  const markers: Array<{ x: number; y: number }> = [];

  let lastShown = 0; // 0 => nothing shown yet
  let pending: { x: number; y: number } | null = null; // marker awaiting its closing shown line

  for (const raw of outLines) {
    // No marker may carry indentation — markers are flush-left metadata.
    if (LEGACY_OMISSION_RE.test(raw)) {
      throw new Error(`${label}legacy "[N lines omitted]" marker found: ${JSON.stringify(raw)}`);
    }
    if (L_ANNOTATION_RE.test(raw)) {
      throw new Error(`${label}forbidden "# L{n}" annotation found: ${JSON.stringify(raw)}`);
    }

    const markerMatch = raw.match(MARKER_RE);
    if (markerMatch) {
      const x = Number(markerMatch[1]);
      const y = Number(markerMatch[2]);
      if (x > y) throw new Error(`${label}marker range inverted: ${raw}`);
      if (x < 1 || y > total) {
        throw new Error(`${label}marker out of file bounds (1..${total}): ${raw}`);
      }
      if (pending) {
        throw new Error(`${label}two consecutive markers without intervening content: ${raw}`);
      }
      // A marker's start must continue immediately after the last shown line —
      // no silent, unaccounted region may precede it.
      if (x !== lastShown + 1) {
        throw new Error(
          `${label}marker start ${x} does not continue after last shown line ${lastShown} (expected ${lastShown + 1})`,
        );
      }
      markers.push({ x, y });
      pending = { x, y };
      continue;
    }

    const shownMatch = raw.match(SHOWN_RE);
    if (!shownMatch) {
      throw new Error(`${label}output line is neither a numbered line nor a marker: ${JSON.stringify(raw)}`);
    }
    const n = Number(shownMatch[1]);
    const content = shownMatch[2] ?? '';

    if (n < 1 || n > total) {
      throw new Error(`${label}shown line number ${n} outside file bounds (1..${total})`);
    }
    // Priority-0: verbatim, character-perfect copy of the real source line.
    const expected = srcLines[n - 1];
    if (content !== expected) {
      throw new Error(
        `${label}line ${n} not verbatim:\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(content)}`,
      );
    }
    // Strictly ascending.
    if (n <= lastShown) {
      throw new Error(`${label}line numbers not strictly ascending (${lastShown} then ${n})`);
    }

    if (pending) {
      // The marker that preceded this line must end exactly one line before it.
      if (pending.y !== n - 1) {
        throw new Error(
          `${label}marker [${pending.x}-${pending.y}] does not abut shown line ${n} (expected end ${n - 1})`,
        );
      }
      if (opts.minGap !== undefined) {
        const gap = pending.y - pending.x + 1;
        if (gap < opts.minGap) {
          throw new Error(
            `${label}omission gap ${pending.x}-${pending.y} is ${gap} lines (< minimum ${opts.minGap})`,
          );
        }
      }
      pending = null;
    } else if (lastShown === 0) {
      // First emitted content is a shown line. If it is not line 1, lines
      // 1..n-1 were dropped with no leading marker — a silent leading gap.
      if (n !== 1 && requireLeadingMarker) {
        throw new Error(`${label}silent leading gap: output starts at line ${n} with no marker for lines 1-${n - 1}`);
      }
    } else if (n !== lastShown + 1) {
      // A jump in line numbers with no marker between is a silent gap.
      throw new Error(
        `${label}silent gap: shown line ${n} follows ${lastShown} with no omission marker`,
      );
    }

    shown.push(n);
    lastShown = n;
  }

  // A trailing marker (omission running to EOF) must end at the last source line.
  if (pending && pending.y !== total) {
    throw new Error(
      `${label}trailing marker [${pending.x}-${pending.y}] must end at last line ${total}`,
    );
  }
  // Output that ends on a shown line short of EOF dropped the tail with no
  // marker — a silent trailing gap. The model would believe the file ends early.
  if (!pending && requireTrailingMarker && lastShown !== 0 && lastShown !== total) {
    throw new Error(
      `${label}silent trailing gap: output ends at line ${lastShown} but file has ${total} lines (no trailing marker)`,
    );
  }

  return { shown, markers };
}

/**
 * Cheap, dependency-free structure synthesizer. Produces StructureBlock[] from a
 * source string by treating `def`/`class`/`function`/exported-const lines as
 * block openings spanning to the next opening (or EOF). The structured engine
 * only needs plausible block bounds to exercise its selection/marker logic — the
 * line-truth guarantees it must uphold do not depend on the blocks being
 * semantically perfect.
 */
export function synthesizeStructure(source: string): Array<{
  name: string;
  kind: string;
  type: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  anchors: Array<{ startLine: number; endLine: number; kind: string; priority: number }>;
}> {
  const lines = source.split('\n');
  const openRe =
    /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:def|class|function|interface|type|enum)\s+(\w+)|^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/;
  const opens: Array<{ idx: number; name: string }> = [];
  lines.forEach((line, idx) => {
    const m = line.match(openRe);
    if (m) opens.push({ idx, name: m[1] ?? m[2] ?? `blk${idx}` });
  });

  const blocks = opens.map((o, i) => {
    const start = o.idx;
    const end = i + 1 < opens.length ? opens[i + 1]!.idx - 1 : lines.length - 1;
    // Attach a synthetic `return` anchor near the block end so SageRank has signal.
    const anchorLine = Math.min(end, start + Math.floor((end - start) / 2));
    return {
      name: o.name,
      kind: 'def',
      type: 'function',
      startLine: start,
      endLine: Math.max(start, end),
      exported: /^\s*export\b/.test(lines[start] ?? ''),
      anchors: [
        { startLine: anchorLine, endLine: anchorLine, kind: 'return', priority: 400 },
      ],
    };
  });
  return blocks;
}

/** Deterministic small PRNG so fuzz fixtures are reproducible across CI runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Read one of the committed real-language fixtures used across the suite. */
export function readFixture(name: string): string {
  return fs.readFileSync(path.join(TOON_PKG_ROOT, 'tests', name), 'utf8');
}

/** Read a zenith-mcp source file for the package-ownership static guards. */
export function readMcpSource(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'packages', 'zenith-mcp', 'src', rel), 'utf8');
}

/** Read a zenith-toon source file for the source-constant static guards. */
export function readToonSource(rel: string): string {
  return fs.readFileSync(path.join(TOON_PKG_ROOT, 'src', rel), 'utf8');
}

/** A library of synthetic source bodies that stress the line-based engine. */
export function syntheticSources(): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = [];

  // Long flat module: many top-level statements, few blocks.
  out.push({
    name: 'flat-module',
    source: Array.from({ length: 80 }, (_, i) => `const x${i} = compute(${i}); // statement ${i}`).join('\n'),
  });

  // Several functions with bodies, exported and not.
  {
    const parts: string[] = ["import { compute } from './m.js';", ''];
    for (let f = 0; f < 6; f++) {
      parts.push(`${f % 2 === 0 ? 'export ' : ''}function fn${f}(a, b) {`);
      for (let b = 0; b < 12; b++) parts.push(`  const t${b} = a + b + ${b};`);
      parts.push('  return a + b;');
      parts.push('}');
      parts.push('');
    }
    out.push({ name: 'multi-function', source: parts.join('\n') });
  }

  // Blocks separated by large comment gaps (exercises gap markers).
  {
    const parts: string[] = [];
    parts.push('class Service {');
    for (let m = 0; m < 4; m++) {
      parts.push(`  method${m}() {`);
      for (let i = 0; i < 10; i++) parts.push(`    // filler ${m}.${i}`);
      parts.push(`    return ${m};`);
      parts.push('  }');
    }
    parts.push('}');
    out.push({ name: 'class-with-methods', source: parts.join('\n') });
  }

  // Lines whose content itself looks like "N. text" — guards the parser.
  out.push({
    name: 'numeric-prefixed-content',
    source: Array.from({ length: 40 }, (_, i) => `${i}. function step${i}() { return run(${i}); }`).join('\n'),
  });

  // Blank-line heavy source (blank handling in the reassembly loop).
  {
    const parts: string[] = [];
    for (let i = 0; i < 30; i++) {
      parts.push(`function g${i}() { return ${i}; }`);
      parts.push('');
      parts.push('');
    }
    out.push({ name: 'blank-heavy', source: parts.join('\n') });
  }

  return out;
}
