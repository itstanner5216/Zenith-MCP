# TOON output validator

A pure checker for TOON's repo-wide contract (`AGENTS.md`). It answers one question: **is this a
legal compression?** It is a *gate*, not a ranker and not a competition. Passing earns a contender
the right to be looked at — it does not crown anything.

## What it is

`validate(rawOriginal, output)` takes the original file text and a contender's compressed output
string and checks only properties of the **output**, by reading it against the original. It knows
nothing about *how* the output was produced — no line-selection seam, no internal accounting, no
"did it drop in runs of 6." A contender is a black box: raw text in, `N. `-prefixed-with-markers
text out, solved any way it likes. This validator never constrains the method, only the artifact.

## What it checks (every item is from AGENTS.md)

1. **Structure** — every output line is either a valid marker or an `N. ` content line. Synthetic
   summaries, JSON condensations, annotated lines, or malformed markers fail here.
2. **Line fidelity** — every shown line carries its **true** original number, and its content is a
   **verbatim** character-for-character copy (the line equals exactly `` `N. ` `` + original line N).
3. **Coverage** — the output reconstructs lines `1..N` exactly: ascending, no overlaps, and **no
   silent gaps** — every omitted range is covered by a marker stating the real lines removed.
4. **Marker format** — exactly `[TRUNCATED: lines X-Y]`, flush-left, real range. No variants.
5. **Min block (6)** — every block of consecutive shown lines is **>=6**, anywhere (top, middle, or
   tail — no boundary exemption). "No shown block under 6" and "no marker leaves a sliver" are the
   same rule from opposite sides; >=6 means 6 passes, 5 fails. A short block must be grown to 6 or
   dropped entirely. This is a property of the output's shape, *not* "drops come in sixes."
6. **Ratio** — retained content in **[68%, 72%]**, i.e. **removed in [28%, 32%], target 30%**.
   Measured on character content (the engine's `text.length` basis). The report also shows the
   *effective read-cost reduction* (full prefixed output vs full prefixed file — the truer token
   saving) for reference; the gate is the 68–72% band.

Plus **speed** and **determinism**, measured by the runner when it executes a contender.

## Valid is not good — where quality is judged

The validator cannot tell you whether the right 30% was dropped, because "right" means *kept the
parts that matter*, and that is a judgment, not a formula. So it surfaces the **behaviour** instead
of scoring it. The number to watch is **`maxOmission` — the largest single hole.** A contender that
rips out 50 contiguous lines per marker will pass every check above and still be useless: a 50-line
hole almost certainly swallowed a function signature, an import, or the one branch you cared about.
That disqualification is visible only by *looking* at what was dropped — so once valid candidates
exist, you read their behaviour (hole sizes, where they cut) and decide. The validator makes the
field legible; it does not pick.

## Use

Validate a saved output against its original:

```bash
npx tsx validator/validate.ts <originalFile> <outputFile>
```

Run a contender on real files (any size), timed + determinism-checked + validated:

```bash
npx tsx validator/run.ts <contenderModule> <file1> [file2 ...]
```

The contender module's only contract:

```ts
export function compress(rawText: string): string;   // sync or async; or `export default`
```

Raw file text in, compressed text out. Test it on genuinely large files (3000+ lines) — the whole
point is that an *average* file must pass fast (target < 1s; ~1.5s on a 3000-line file is a maybe).
An agent can also import `validate()` directly and call it in its own loop until it passes.
