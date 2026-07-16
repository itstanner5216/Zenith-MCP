# POLARIS FIX-REPORT — resolution-4 (`text-floor.ts`)

Worktree: `/home/tanner/Projects/Zenith-Worktrees/resolution-4`
Plan of record: `docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md` → **"Literal floor and
proof-backed absence"** (§ at file lines 775–786; the `763–767` cited in the prompt are
stale — the doc has since shifted and now points at `RelationFrontier`, but the finding
text unambiguously names the Literal-floor section).
Supporting authority: `docs/POLARIS-KNOWN-ISSUES-2026-07-15.md` item 10 ("rg is
acceleration only").

Toolchain: Node v26.5.0 + pnpm 11.13.1. `pnpm build:mcp` → `vitest run` (tests import
from `dist/`, so every proof below is against a fresh build). ripgrep 15.1.0 present at
`/usr/bin/rg` (the rg-differential tests are live, not skipped).

Sole source change: `packages/zenith-mcp/src/core/intelligence/text-floor.ts`
(+54/−6). New pinning test: `packages/zenith-mcp/tests/polaris-audit-text-floor-bounds.test.js`.
No commits/stages/pushes were made. Constraints honored: no SQL `OFFSET`, no non-null
assertions (`!`), no internal IDs crossing the facade, `packages/zenith-toon` untouched.

---

## Finding A13 — ripgrep runs before the literal-floor safety bounds (unbounded work)

**Plan-correct definition.** Literal-floor step 2 requires rg to be invoked over "only
canonical explicitly enumerated path chunks so its domain exactly matches step 1"; step 4
is the stopping discipline "Stop at 64 MiB or the file bound"; KNOWN-ISSUES item 10 fixes
rg as "acceleration only." Correct = rg never scans a file the bounded in-process scan
would refuse (over the per-file bound, or past the aggregate byte budget). The buggy code
handed rg **every** disk path up front, before any `stat` / per-file / budget check.

### 1. Repro proof (RED under the shipped build)

New pinning test `polaris-audit-text-floor-bounds.test.js`. **Independent oracle:** a stub
`rg` binary that records the exact argv it is spawned with to an on-disk log, then exits 1
(clean "no hits"). The test reads that raw log — observable committed state, never
`scanLiteralFloor`'s own return — to see which files rg was actually asked to scan.

Corpus (canonical order), `fileByteBound=1000`, `byteBudget=40`:
`a_small(20B, in-bound)`, `b_huge(2000B, over per-file bound)`, `c_small(20B, in-bound,
exactly at budget)`, `d_pastbudget(20B, 40+20>40 → past budget)`. A correct floor hands rg
exactly `{a_small, c_small}`.

Result against the built (pre-fix) code:

```
FAIL  tests/polaris-audit-text-floor-bounds.test.js > ... > never spawns rg on over-bound or past-budget files (A13)
AssertionError: expected '--no-config\n…' not to contain '/tmp/…/b_huge.ts'
  Received argv handed to rg:
    -- /tmp/…/a_small.ts /tmp/…/b_huge.ts /tmp/…/c_small.ts /tmp/…/d_pastbudget.ts
Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

rg was spawned on all four disk paths, including the over-bound `b_huge.ts` and the
past-budget `d_pastbudget.ts`. **Anti-vacuity control** (2nd test, "with generous bounds…
DOES reach rg") **passed**, proving the stub is really invoked and the log really records
paths — so the failing assertion is meaningful, not vacuous. The outcome-invariance
assertions (`scanner='rg'`, `overBound=['b_huge.ts']`, `stopReason='byte_budget'`,
`scannedFiles=2`, `scannedBytes=40`) also passed pre-fix, confirming the defect is
**unbounded work only**, not a wrong result.

### 2. The fix (cites plan step 2/4 + KNOWN-ISSUES 10)

In `scanOnce`, before spawning rg, walk `files` in canonical order under the identical
`stat` / per-file-bound / byte-budget discipline the scan loop uses, accumulating
`plannedBytes`, and collect the in-bound disk paths into `rgDomain`. rg is spawned on
`[...rgDomain]` only. Content-fresh files never reach rg but are accounted in
`plannedBytes` so the disk cutoff lands exactly where the scan loop puts it. Non-regular
paths and stat failures are excluded (a directory must not make rg recurse — that is the
purest form of the unbounded work this finding is about).

The scan loop stays the sole authority for `matches / overBound / stopReason /
scannedBytes / unreadable`. One guard is added to its rg fast-path:
`if (rgHits !== null && rgDomain.has(file.absPath))`. This closes a TOCTOU hole surfaced
in design review: if the filesystem changes between the pre-pass and the scan, a file the
loop reaches but rg was never asked about is **scanned in process** instead of being
mis-trusted as "rg proved hit-free."

**Why output is invariant.** The only disk paths removed from rg's input are exactly the
ones whose rg hits the scan loop already discards — over-bound files it `continue`s past,
and past-budget files it `break`s before reaching. In the rg-success path every file is
readable (an unreadable file makes rg exit non-clean → the whole rg pass is discarded →
pure in-process, where `rgDomain` is unused), so the stat-based pre-pass cutoff equals the
scan loop's actual cutoff and `rgDomain` equals the set of disk files the loop scans. Every
outcome field is byte-for-byte unchanged; only rg's workload shrinks.

### 3. Green proof (pinning test flips GREEN)

```
✓ tests/polaris-audit-text-floor-bounds.test.js (2 tests) 22ms
```

Both the A13 assertion and its anti-vacuity companion pass. The `b_huge.ts` /
`d_pastbudget.ts` paths no longer appear in rg's argv; `a_small.ts` / `c_small.ts` still do.

### 4. Full-suite no-regression — see the shared section at the end.

### 5. Proposed amendments — none.
No public type / return shape / payload changes: `scanLiteralFloor`'s signature and
`FloorOutcome` are untouched. One **behavior note** (not a public payload change, disclosed
for the lead): with the bounded domain, if `forceScanner:'rg'` is set **and** every disk
file is out of bounds **and** rg is unavailable, the bounded `diskPaths` is empty so rg is
not spawned and the "rg forced but unavailable" throw no longer fires (scanner reports
`'rg'` over zero disk work). `forceScanner` is a test-only knob; the production caller
(`queryOccurrences`) never forces rg, and no test exercises this edge. It is arguably more
correct (rg is not "needed" when it has no in-bound work). Flagged rather than hidden.

### 6. Ranked alternatives

1. **(chosen) Bounded pre-pass + `rgDomain.has()` fast-path gate.** Bounds rg's work,
   output provably invariant, TOCTOU-safe. Least-regressive: the authoritative scan loop is
   unchanged except one membership guard that is a no-op under a stable filesystem.
2. **Bounded pre-pass without the membership gate** (trust "absent from rgHits" = clean).
   Simpler, but a mid-scan filesystem change could let the loop reach a file rg never saw
   and silently treat it as hit-free → missed matches. Rejected on correctness.
3. **One authoritative bounded plan consumed by both rg and the scan.** Cleaner in the
   abstract, but a stat-only plan cannot reproduce the pinned "an unreadable file consumes
   0 budget" semantics (readability is only known at read time), so it would regress the
   byte-budget / unreadable behavior the existing suite pins. Rejected.
4. **Delegate the bound to rg (`--max-filesize`).** Only approximates the per-file bound,
   cannot express the aggregate 64 MiB budget or the exact canonical domain, and moves a
   bound decision into rg — the opposite of "rg is acceleration only." Rejected.

---

## Finding A20 — astral identifier chars get the wrong boundary annotation

**Plan-correct definition.** Literal-floor step 3: identifier-boundary classification "may
annotate candidates but never discard a raw hit." The annotation's own intent is the regex
`/[\p{L}\p{N}_$]/u` over the adjacent character. Correct = an astral (supplementary-plane)
`\p{L}`/`\p{N}` char adjacent to the hit is recognized as an identifier char, so the hit is
annotated **not** on a boundary. The bug: `.slice(-1)` / `.slice(0,1)` operate on UTF-16
code units and split the surrogate pair, testing a lone surrogate → misclassification.

### 1. Repro proof (RED under the shipped build)

Auditor-authored pinning test already in the tree:
`polaris-audit-text-floor-unicode.test.js` (F2 section, lines 146–192). Oracle: JS Unicode
property escapes on the **full** code point, with BMP + astral-non-letter controls that
isolate the defect to astral identifier chars. Against the built (pre-fix) code:

```
FAIL … BUG: astral LETTER (\p{L}) before the literal is misclassified as a boundary
  expected true to be false            (U+1D44E before 'target'  → line 177)
FAIL … BUG: astral LETTER (\p{L}) after the literal is misclassified as a boundary
  expected true to be false            (U+1D44E after 'target'   → line 183)
FAIL … BUG: astral NUMBER (\p{N}) adjacent is misclassified as a boundary
  expected true to be false            (U+1D7CE before 'target'  → line 190)
Test Files  1 failed  ·  Tests  3 failed | 10 passed
```

The three passing controls in the same block (BMP letter → false; space/punct → true;
astral **emoji** So → true) prove the harness can pass and fail, isolating the defect to
astral `\p{L}`/`\p{N}`.

### 2. The fix (cites plan step 3)

`boundaryAnnotation` now inspects whole code points instead of UTF-16 halves:

```ts
const before = [...beforeText].at(-1) ?? '';
const after  = [...afterText].at(0)  ?? '';
```

The 4-byte "before" window ends exactly on the literal's char boundary, so the last code
point of `[...beforeText]` is the true preceding char even when leading bytes are a partial
sequence (UTF-8 is self-synchronizing; the partial decodes to U+FFFD and is ignored because
only the last code point is read). The "after" window begins on a char boundary and any
UTF-8 char is ≤4 bytes, so the first code point is always the complete following char. No
non-null assertion: `[...str].at(±)` is `string | undefined` under
`noUncheckedIndexedAccess`, narrowed by `?? ''`. Annotation-only contract preserved — a hit
is still never discarded.

### 3. Green proof (pinning test flips GREEN)

```
✓ tests/polaris-audit-text-floor-unicode.test.js (13 tests) 24ms
```

All three BUG cases now pass; the controls and the UTF-16-column / rg-differential blocks
stay green.

### 4. Full-suite no-regression — see the shared section below.

### 5. Proposed amendments — none.
`FloorMatch.identifierBoundary` type and semantics are unchanged; the field simply now
matches the function's own `\p{L}\p{N}_$` intent for astral chars. **Caveat (not a defect
of the fix):** for **invalid** UTF-8 where `Buffer.indexOf` lands `start` mid-sequence, the
adjacency is inherently approximate for any implementation — the fix is correct on valid
UTF-8 boundaries and no worse than before on invalid bytes.

### 6. Ranked alternatives

1. **(chosen) Whole-code-point extraction from the decoded window** via
   `[...text].at(-1)/.at(0)`. Minimal, correct on valid UTF-8, no new dependency.
2. **`codePointAt` + manual surrogate arithmetic.** Same result, but locating the last
   code-point start needs explicit high/low-surrogate checks — fiddlier for no gain.
3. **`Intl.Segmenter` grapheme segmentation.** Overkill: the verdict is a single code
   point's `\p{L}`/`\p{N}` class, not a grapheme cluster; adds cost/complexity without
   changing any answer. Rejected.

---

## Shared proof — full package suite, no regression

Both fixes then the two targeted suites and the two existing floor suites:

```
✓ tests/polaris-audit-text-floor-bounds.test.js   (2 tests)
✓ tests/polaris-audit-text-floor-unicode.test.js  (13 tests)
✓ tests/polaris-text-floor.test.js                (12 tests)
✓ tests/polaris-independent-file-floor.test.js    (6 tests)
Test Files  4 passed (4)   ·   Tests  33 passed (33)
```

Whole `zenith-mcp` package (127 files), fixes applied:

```
Test Files  5 failed | 122 passed (127)
      Tests  14 failed | 1759 passed | 2 skipped (1775)
```

The 14 failures are **pre-existing and unrelated to `text-floor.ts`** — proven by
independent oracle (a clean rebuild): the `text-floor.ts` change was `git stash`ed, the
package rebuilt, and the five failing files re-run:

```
# baseline with text-floor.ts stashed (clean rebuild):
Test Files  5 failed (5)   ·   Tests  14 failed | 20 passed (34)
```

Identical failing set — same five files, same 14 tests — with the fix absent. The failing
files exercise unrelated subsystems (none import or touch the literal floor):

| File | Subject (unrelated to A13/A20) |
|---|---|
| `polaris-audit-file-model-paging.test.js` | fileModel object-section paging (audit F1/A6) |
| `polaris-audit-occurrences-differential.test.js` | non-unique keyset pagination |
| `polaris-independent-adversarial-contracts.test.js` | savepoint generation, keyset rows, same-name edges, SQLite BINARY ordering, heuristic-name rejection |
| `polaris-independent-facade-adversarial.test.js` | storage-key decoding, realpath/symlink guard, relation paging |
| `polaris-independent-session-freshness.test.js` | source-domain excludes `.mcp` artifacts |

Net effect of this branch: **−4 failures** (3 A20 + 1 A13 flipped RED→GREEN), **0 new
failures**. `tsc --build` exits 0 (clean type-check; no `!`, no `OFFSET`).

## Reproduce

```bash
pnpm build:mcp
cd packages/zenith-mcp
./node_modules/.bin/vitest run \
  tests/polaris-audit-text-floor-bounds.test.js \
  tests/polaris-audit-text-floor-unicode.test.js \
  tests/polaris-text-floor.test.js \
  tests/polaris-independent-file-floor.test.js
```
