# TOON line-removal benchmark harness

A frozen, reproducible bench for the two TOON missions. It exists so "better algorithm,
proven with real results" means **a number this harness produced**, not prose. Every candidate
is judged by the production `verifyOutput` and a brute-force optimum; the candidate only ever
returns `drop[]`, and the harness recomputes every headline figure itself. A beautiful but false
"beats the DP" cannot survive here.

## Run

```bash
cd packages/zenith-toon
npx tsx bench/run.ts
# add bigger real files:
BENCH_EXTRA_DIRS=/abs/path/to/big/src:/another npx tsx bench/run.ts
```

Prints three scoreboards and writes them to `bench/results/<timestamp>.json`.

## The seam (read this first)

Both missions operate on **one function**: `selectDropsToBand(weights, lines, eligible, netMin, netMax)`
in `src/removal.ts`.

- **Mission 1** — a single-pass selector that matches the DP's optimality without the DP.
- **Mission 2** — a selector that does **not** hit the 60M-cell resource wall on 400–1250+ line
  files. The guard that throws (`input exceeds the exact-DP size bound`) lives *inside*
  `selectDropsToBand`; the harness catches it and records `status='bailed'` — exactly the
  production degrade-to-raw path.

The harness injects a candidate at this seam, then runs the **real** engine path around it:
it renders `drop[]` into output byte-identically to `removalEngine` and hands the result to the
**real** `verifyOutput` (H1–H7). Two consequences:

1. **Eligibility is a profile, not a live ranking.** The seam sits *after* the value-blind gate,
   so the harness supplies `eligible[]` from a seeded profile (`all` / `clustered` / `sparse` /
   `realistic`) standing in for the SageRank+BMX cores. This is reproducible without the indexer,
   and it makes **Invariant 2 hold by construction**: a `Selector` only ever receives sizes and
   the `eligible` boolean — never a score — so it physically cannot blend ranks.
2. **End-to-end through `compressFile` (with real facts) is a separate, final check** the primary
   does in the last round. The harness proves the *selection algorithm*; it does not re-prove the
   tiler or the ranking engines.

## Add a candidate

Edit `bench/selectors.ts`, register one function in `REGISTRY` with the exact
`selectDropsToBand` signature:

```ts
export const m1_intervalGreedy: Selector = (weights, lines, eligible, netMin, netMax) => {
  // ... return { drop, netRemoved, bandSatisfied }
};
// in REGISTRY:
'm1-interval-greedy': m1_intervalGreedy,
```

Nothing else changes. The harness renders it through the real path, judges it with
`verifyOutput`, scores it against the brute-force optimum and the baseline, and adds its rows to
the JSON. `baseline-dp` (the real DP) and `greedy-single-pass` (a valid floor) ship as references.

## What the numbers mean

**Status** (per case × profile): `in-band` (valid, landed in [68%,72%]) · `infeasible` (valid, band
unreachable — same legal-nearest behaviour the DP has) · `invalid` (`verifyOutput` threw or a run
rule broke — the verify H-code is printed) · `bailed` (**FAILURE** — the exact DP's table exceeds 60M, so the file produces no compression and silently degrades to raw; this is the Mission 2 disease, not an acceptable outcome) · `error` (other throw).

**Mission 1 scoreboard**
- `matchOpt%` — fraction of small inputs where the selector reproduces the *gentlest-optimal*
  selection. `baseline-dp` is `100.0` by construction; that's the bar a single-pass must meet.
- `meanGap` — average extra net removed vs optimal when both land in band (`0` = optimal). A fast
  heuristic that's slightly less gentle shows up here as a small positive gap; a sloppy one shows a
  large gap or a nonzero `bandMiss%`.

**Mission 2 scoreboard**
- `exactDP-cells` / `overWall` — the `(n+1)×25×netSpan` table the *exact* DP would allocate, for
  every input. This is the wall: `baseline-dp` flips to `bailed` once it exceeds 60M (~340 mixed
  lines). An M2 winner stays `in-band` with bounded `time` across the whole sweep.

**Cross-checks** (anti-cheat, always on)
- `verifyOk` — the production verifier accepted the output. Non-negotiable.
- `selfReportConsistent` — the candidate's returned `netRemoved` / `bandSatisfied` match the
  harness's independent recompute. Catches a selector that lies in its return struct (`verifyOutput`
  catches lies in the output string).
- `deterministic` — identical inputs yield an identical selection (Invariant 7).

## Acceptance bars (what "winning" is)

A candidate is a real win only if, across the corpus and every profile:
- `verifyOk` and `valid` on **100%** of cases (no invariant ever bent), and `deterministic` 100%;
- **Mission 1**: `matchOpt% = 100` (or a stated, justified `meanGap` if trading optimality for
  speed) — and faster / single-pass where that's the point;
- **Mission 2**: a `bailed` case is a **failure** — the file gets no compression and silently degrades to raw. Most
  real files are 400–1250 lines, exactly where `baseline-dp` bails, so the baseline fails on the
  majority of real inputs. Drive `bailed` to **zero** — `in-band` with bounded time + memory across
  the whole 400 → 1250+ line sweep. Respect the graveyard budgets: beat ~5–6 s (iterative convergence) and stay well under
  the ~1.4 GB that raising `MAX_CELLS` would cost — i.e. cut the *asymptotic* cell count, not the
  constant.

If it isn't in the JSON, it didn't happen.
