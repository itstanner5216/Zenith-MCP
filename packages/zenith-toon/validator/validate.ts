// validator/validate.ts
//
// PURE OUTPUT VALIDATOR for TOON compression. Black box in, artifact checked out.
//
// This does NOT know or care how a contender produced its output — no line-selection seam, no
// internal accounting, no "did it drop in runs of 6." It takes the ORIGINAL file text and the
// contender's COMPRESSED output string, and answers only questions you can settle by reading the
// two texts against each other. Every check is a property of the OUTPUT, straight from AGENTS.md.
//
// It is a GATE, not a ranker. Passing means "this is a legal compression under the repo contract."
// It does NOT mean "this is a good compression" — that is a judgment made by LOOKING at what the
// output actually dropped (see the `profile` block: maxOmission is the drop-50-lines-at-a-time
// detector). Valid is the price of admission; quality is decided by a human reading the behaviour.
//
// Constraints enforced (AGENTS.md repo-wide contract):
//   1. Structure        — every output line is a valid marker OR an `N. ` content line, nothing else
//   2. Line fidelity    — every shown line carries its TRUE original number, content verbatim
//   3. Coverage         — output reconstructs [1..N] exactly: ascending, no silent gaps, no overlap
//   4. Marker format    — exactly `[TRUNCATED: lines X-Y]`, flush-left, real range
//   5. Min block (6)    — every block of consecutive shown lines is >= 6 (Rule 1; no boundary exemption)
//   6. Ratio            — retained content in [68%, 72%]  (== removed in [28%, 32%], target 30%)

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ValidationReport {
  pass: boolean; // every hard check passed
  checks: CheckResult[];
  metrics: {
    originalLines: number;
    shownLines: number;
    markers: number;
    fullContentChars: number; // sum of original line content lengths (no prefixes, no newlines)
    keptContentChars: number; // sum of shown line content lengths
    markerChars: number; // sum of marker string lengths
    retainedPct: number; // (kept + markers) / full * 100   — the AGENTS.md / engine measure (GATE)
    removedPct: number; // 100 - retainedPct                — what you call "compressed %"
    effectiveReadReductionPct: number; // 1 - prefixedOutput/prefixedFull — true token-cost savings (info)
  };
  profile: {
    omissionSizes: number[]; // omitted lines per marker (Y - X + 1)
    maxOmission: number; // largest single hole — the "drop-50" detector
    shownRunSizes: number[]; // length of each block of consecutive shown lines
    minShownBlock: number; // smallest block of consecutive shown lines anywhere (Infinity if none)
  };
}

const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const LEADING_NUM_RE = /^(\d+)\./; // a line that LOOKS like a content line (for good diagnostics)

type Token =
  | { kind: 'marker'; x: number; y: number; raw: string }
  | { kind: 'content'; n: number; raw: string }
  | { kind: 'bad'; raw: string };

export function validate(rawOriginal: string, output: string): ValidationReport {
  const originalLines = rawOriginal.split('\n');
  const lineCount = originalLines.length;
  const fullContentChars = originalLines.reduce((a, l) => a + l.length, 0);

  // Split output into lines; drop a single trailing '' produced by a terminal newline.
  const outLines = output.split('\n');
  if (outLines.length > 0 && outLines[outLines.length - 1] === '') outLines.pop();

  // ── Tokenize ──
  const tokens: Token[] = outLines.map((raw) => {
    const m = MARKER_RE.exec(raw);
    if (m) return { kind: 'marker', x: Number(m[1]), y: Number(m[2]), raw };
    if (LEADING_NUM_RE.test(raw)) {
      const num = LEADING_NUM_RE.exec(raw);
      return { kind: 'content', n: num ? Number(num[1]) : -1, raw };
    }
    return { kind: 'bad', raw };
  });

  const badLines: string[] = [];
  const fidelityFails: string[] = [];
  const coverageFails: string[] = [];
  const markerFormatFails: string[] = [];

  const omissionSizes: number[] = [];
  const shownRunSizes: number[] = [];

  let shownLines = 0;
  let markers = 0;
  let keptContentChars = 0;
  let markerChars = 0;

  // ── Ordered walk: enforces ascending order, exact coverage, no silent gaps/overlaps ──
  let cursor = 0; // highest original line accounted for so far
  let currentRun = 0; // length of the current maximal run of consecutive shown lines

  const closeRun = (): void => {
    if (currentRun > 0) shownRunSizes.push(currentRun);
    currentRun = 0;
  };

  for (const tok of tokens) {
    if (tok.kind === 'bad') {
      badLines.push(tok.raw);
      continue; // unrecognized line — structure failure; coverage will also be flagged at the end
    }

    if (tok.kind === 'marker') {
      closeRun(); // a marker ends the current run of shown lines
      markers++;
      markerChars += tok.raw.length;
      if (tok.y < tok.x) {
        markerFormatFails.push(`${tok.raw} (end < start)`);
      }
      if (tok.x !== cursor + 1) {
        coverageFails.push(
          `marker ${tok.raw}: expected to start at line ${cursor + 1}, got ${tok.x} (silent gap or overlap)`,
        );
      }
      if (tok.x < 1 || tok.y > lineCount) {
        markerFormatFails.push(`${tok.raw} (range outside 1..${lineCount})`);
      }
      const omitted = tok.y - tok.x + 1;
      omissionSizes.push(omitted);
      cursor = Math.max(cursor, tok.y);
      continue;
    }

    // content line
    const n = tok.n;
    if (n < 1 || n > lineCount) {
      fidelityFails.push(`"${tok.raw}" — line number ${n} is outside 1..${lineCount}`);
    } else {
      const orig = originalLines[n - 1];
      const expected = `${n}. ${orig ?? ''}`;
      if (tok.raw !== expected) {
        fidelityFails.push(
          `line ${n}: output is not a verbatim copy with the \`N. \` prefix.\n        expected: ${JSON.stringify(expected)}\n        got:      ${JSON.stringify(tok.raw)}`,
        );
      }
      keptContentChars += (orig ?? '').length;
    }
    if (n !== cursor + 1) {
      coverageFails.push(
        `line ${n}: expected next accounted line ${cursor + 1} (out of order, or a gap with no marker)`,
      );
    }
    cursor = Math.max(cursor, n);
    shownLines++;
    currentRun++;
  }
  closeRun(); // close the final run of shown lines

  if (cursor !== lineCount) {
    coverageFails.push(
      `output accounts for lines up to ${cursor}, but the original has ${lineCount} (trailing lines missing with no marker)`,
    );
  }

  // ── Min shown block (every shown block >= 6 lines, anywhere — top, middle, or tail) ──
  // One rule, two phrasings: "no shown block < 6" and "no marker leaves a sliver" are the same wall
  // from opposite sides — checking shown blocks settles both. NO boundary exemption: a 3-line head
  // or a 2-line tail is just as illegal as a sliver wedged between two markers. A block under 6 must
  // be grown to 6 (show neighbours) or dropped entirely (merged into a marker). >= 6 means 6 passes.
  const minShownBlock = shownRunSizes.length > 0 ? Math.min(...shownRunSizes) : Infinity;
  const blockViolations = shownRunSizes.filter((r) => r < 6);

  // ── Ratio ──
  const retainedPct = fullContentChars > 0 ? ((keptContentChars + markerChars) / fullContentChars) * 100 : 100;
  const removedPct = 100 - retainedPct;

  const prefixedFull = originalLines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const effectiveReadReductionPct = prefixedFull.length > 0 ? (1 - output.length / prefixedFull.length) * 100 : 0;

  // ── Assemble checks ──
  const checks: CheckResult[] = [
    {
      name: 'structure',
      pass: badLines.length === 0,
      detail:
        badLines.length === 0
          ? 'every output line is a valid marker or an `N. ` content line'
          : `${badLines.length} unrecognized line(s) (not a valid marker, not an \`N. \` line) — e.g. ${JSON.stringify(badLines[0])}`,
    },
    {
      name: 'line-fidelity (numbers true + content verbatim)',
      pass: fidelityFails.length === 0,
      detail:
        fidelityFails.length === 0
          ? 'every shown line carries its true original number with verbatim content'
          : `${fidelityFails.length} line(s) not faithful:\n      - ${fidelityFails.slice(0, 4).join('\n      - ')}${fidelityFails.length > 4 ? `\n      - ...and ${fidelityFails.length - 4} more` : ''}`,
    },
    {
      name: 'coverage (no silent gaps, ascending, complete)',
      pass: coverageFails.length === 0,
      detail:
        coverageFails.length === 0
          ? `output reconstructs lines 1..${lineCount} exactly, every gap marked`
          : `- ${coverageFails.slice(0, 4).join('\n      - ')}${coverageFails.length > 4 ? `\n      - ...and ${coverageFails.length - 4} more` : ''}`,
    },
    {
      name: 'marker-format ([TRUNCATED: lines X-Y], flush-left)',
      pass: markerFormatFails.length === 0,
      detail:
        markerFormatFails.length === 0
          ? `${markers} marker(s), all correctly formatted`
          : `${markerFormatFails.slice(0, 4).join('; ')}`,
    },
    {
      name: 'min-block (every shown block >= 6 lines)',
      pass: blockViolations.length === 0,
      detail:
        blockViolations.length === 0
          ? shownRunSizes.length > 0
            ? `smallest block of consecutive shown lines: ${minShownBlock} lines`
            : 'no lines shown'
          : `${blockViolations.length} shown block(s) are < 6 lines (smallest: ${minShownBlock}) — a block under 6 must be grown to 6 or dropped entirely`,
    },
    {
      name: 'ratio (28-32% removed / 68-72% retained, target 30%)',
      pass: retainedPct >= 68 && retainedPct <= 72,
      detail: `removed ${removedPct.toFixed(1)}% (retained ${retainedPct.toFixed(1)}%); target 30% removed / 70% retained`,
    },
  ];

  const pass = checks.every((c) => c.pass);

  return {
    pass,
    checks,
    metrics: {
      originalLines: lineCount,
      shownLines,
      markers,
      fullContentChars,
      keptContentChars,
      markerChars,
      retainedPct,
      removedPct,
      effectiveReadReductionPct,
    },
    profile: {
      omissionSizes,
      maxOmission: omissionSizes.length > 0 ? Math.max(...omissionSizes) : 0,
      shownRunSizes,
      minShownBlock,
    },
  };
}

// ── Human-readable report ──
export function formatReport(r: ValidationReport): string {
  const lines: string[] = [];
  lines.push(r.pass ? 'RESULT: PASS — legal compression under the repo contract' : 'RESULT: FAIL');
  lines.push('');
  for (const c of r.checks) {
    lines.push(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    lines.push(`         ${c.detail}`);
  }
  lines.push('');
  lines.push(
    `  metrics: ${r.metrics.originalLines} lines -> ${r.metrics.shownLines} shown + ${r.metrics.markers} markers | ` +
      `removed ${r.metrics.removedPct.toFixed(1)}% (retained ${r.metrics.retainedPct.toFixed(1)}%) | ` +
      `effective read-cost reduction ${r.metrics.effectiveReadReductionPct.toFixed(1)}%`,
  );
  lines.push(
    `  behaviour (judge quality here, not pass/fail): largest single hole = ${r.profile.maxOmission} lines` +
      (r.profile.minShownBlock === Infinity ? '' : `, smallest shown block = ${r.profile.minShownBlock} lines`),
  );
  lines.push(
    `             a large "largest hole" is the warning sign — you cannot preserve a signature or a branch that sits inside a 50-line drop.`,
  );
  return lines.join('\n');
}

// ── CLI: validate a saved output against its original ──
//   npx tsx validator/validate.ts <originalFile> <outputFile>
const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '###');
if (isMain) {
  const run = async (): Promise<void> => {
    const { readFileSync } = await import('node:fs');
    const [, , originalPath, outputPath] = process.argv;
    if (originalPath === undefined || outputPath === undefined) {
      console.error('usage: npx tsx validator/validate.ts <originalFile> <outputFile>');
      process.exit(2);
    }
    const original = readFileSync(originalPath, 'utf8');
    const out = readFileSync(outputPath, 'utf8');
    const report = validate(original, out);
    console.log(formatReport(report));
    process.exit(report.pass ? 0 : 1);
  };
  void run();
}
