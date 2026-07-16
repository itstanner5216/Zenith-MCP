# POLARIS — Known Issues & Intentional Behaviors (as of 2026-07-15, mid-Wave 2)

Written by the implementation lead for cross-referencing against the adversarial
test agents' findings. Two categories: **OPEN** (real, owed, scheduled) and
**INTENTIONAL** (looks like a bug, is a documented decision — do not "fix").

## OPEN — owed by the lead, scheduled

1. **Unpinned session behaviors (review gaps, scheduled Task 2.4).** The
   adversarial session review verified these behaviors correct but they have no
   regression pins yet in `tests/polaris-session.test.js`:
   - Out-of-domain write survival: a commit touching files *outside* the pinned
     domain must NOT invalidate the session (epoch halves move, pinned view
     backstop must hold the answer valid).
   - Epoch view add/delete-vs-hash: file *added* to and *deleted* from the
     pinned scope must each trigger `INPUT_CHANGED` via the (path,hash) view
     even when `PRAGMA data_version` alone would miss same-connection writes.
2. **Wave 2 composers incomplete.** `locationAt`, `resolveAt`,
   `queryOccurrences`, `traceRelations`, `scopeModel`, `contextFor` are typed
   `unavailable question_kind_unsupported` until each composer lands (Task 2.3,
   in progress — fileModel done). Tests asserting "unavailable" for these six
   are pins scheduled for retirement, not defects.
3. **Task 2.4 adversarial/totality/conservation/determinism suite** not started;
   Wave 2 exit gate (x3 identical full-suite runs) not run.
4. **POLARIS_REAL_DB_COPY rehearsal never executed** — env-gated test requires
   an explicit copy of a real `~/.zenith-mcp` DB; needs Tanner to provide one.
5. **F2 plan wording amendment — DONE** (plan line ~423, dated 2026-07-15):
   columns are 0-based UTF-16 code units everywhere (persisted facts, floor,
   composers), not "UTF-8 byte columns" as the plan previously said. Remains
   load-bearing at Wave 3 when `ExactSourceRange.startByte` lands (bytes and
   columns must not be conflated there).

## INTENTIONAL — documented decisions that may look like defects

6. **v4 honesty gaps in composed answers** (resolve at v5, per FACT_LEDGER
   `availableFrom`): `OccurrenceFact.namespace` is always `'unknown'` (v4
   cannot distinguish value/type namespace); `tainted` is always `false` (v4
   persists no parse-taint); sections exports/signatures/diagnostics/module/
   configuration return typed `unavailable question_kind_unsupported`;
   bindings section returns `question_requires_binding`.
7. **fileModel `relations` section is unpageable by design** — object-shaped,
   served whole on every page, counted in totals only; only array-shaped
   sections occupy paging positions.
8. **Session cap (H4)** counts every domain member including unsupported files
   (symbol-index counts only indexable ones). Documented conservative choice,
   session.ts ~line 113.
9. **Revalidation view spans keys beyond the 5000-file cap (H2)** — the
   (path,hash) view covers the whole key predicate, wider than capped
   membership, so a change beyond the cap invalidates the session. Conservative
   by design (over-invalidation, never staleness).
10. **Literal floor: rg is acceleration only** (review F1). A complete
    zero-match rg pass is always re-run in-process; absence proofs come only
    from the in-process scanner. `--encoding none` pinned. Any rg exit/signal/
    stderr anomaly discards rg entirely. Slower than trusting rg; correct.
11. **Over-bound floor files (H1)** are skipped and recorded in `overBound`
    (kills completeness, not the scan); budget exhaustion still stops the scan.
12. **Prefix-bound comment in db-adapter.ts (~2708)**: range arms exist only to
    enable the (kind,name) index; substr rescues too-LOOSE bounds only; the
    equivalence suite guards too-TIGHT. Comment was corrected 2026-07-15 — if
    an agent finds the old "can at worst over-scan" claim quoted anywhere else,
    it's stale.
13. **`compressFile` returning `null` means serve-raw** (TOON contract, never a
    bug); retention band [68%,72%] exact; zero files under
    `packages/zenith-toon` change in POLARIS.
14. **`namePrefixUpperBound` throws on empty prefix** by contract (empty prefix
    means "no name filter", handled before SQL); lone surrogates normalize to
    U+FFFD at bind so bounds derive from the normalized prefix.
15. **Non-polaris legacy tests read the real user config** via `getConfig()`
    (documented Wave-0 limitation; polaris suites are hermetic via HOME stub).
    Aggressive `advanced.default_excludes` on a foreign machine could perturb
    the 28-file baseline count. Accepted; legacy tool layer is being replaced.
16. **Adapter config errors are plain `Error`** (not a typed
    `AdapterConfigurationError`) — open allowlist ruling, deliberately parked:
    tool layer is being rebuilt from scratch after POLARIS.
17. **Scaling caveat (documented):** per-call revalidation reads the whole
    scope hash view; project-mode empty-prefix sessions scan the entire `files`
    table per query. Measured at Wave 7 (Decision 23), not before.
18. **Env:** pnpm launcher broken (stub binary); all builds/tests invoke
    `node_modules/.bin/*` directly. `tsc --build` emits JS despite type errors
    (noEmitOnError off) — always check the exit code, not emitted files.

## Transients already resolved (no action)

- The 2.2-C agent's mid-flight report of a no-OFFSET gate failure on
  `text-floor.ts` was an artifact of scanning a concurrently-edited file;
  current gate + file pass (full suite 1,659/0 post-merge, twice).
