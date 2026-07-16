# POLARIS — Known Issues & Intentional Behaviors (as of 2026-07-15, mid-Wave 2)

Written by the implementation lead for cross-referencing against the adversarial
test agents' findings. Two categories: **OPEN** (real, owed, scheduled) and
**INTENTIONAL** (looks like a bug, is a documented decision — do not "fix").

## OPEN — owed by the lead, scheduled

1. **Session epoch/view pin matrix — CLOSED 2026-07-15.** All cells now pinned
   in `tests/polaris-session.test.js`: own-prefix autocommit hash/delete/add
   (view half), foreign-prefix autocommit survival, foreign-prefix TRANSACTED
   write invalidation (strict epoch), cross-connection commit invalidation
   (data_version).
2. **Wave 2 composers incomplete.** `resolveAt`, `queryOccurrences`,
   `traceRelations`, `contextFor` are typed `unavailable
   question_kind_unsupported` until each composer lands (Task 2.3, in
   progress — fileModel and locationAt done; scopeModel delegated). Tests
   asserting "unavailable" for the remainder are pins scheduled for
   retirement, not defects.
3. **Task 2.4 adversarial/totality/conservation/determinism suite** not started;
   Wave 2 exit gate (x3 identical full-suite runs) not run. Scheduled INTO 2.4
   from composer reviews: project-mode (registry-tier) composer runs — all
   three question suites currently exercise global-mode sessions only — and a
   root-level non-recursive directory scopeModel probe (the group-key filter's
   dirKey='' cell in project mode is untested).
4. **POLARIS_REAL_DB_COPY rehearsal never executed** — env-gated test requires
   an explicit copy of a real `~/.zenith-mcp` DB; needs Tanner to provide one.
5. **F2 plan wording amendment — DONE** (plan line ~423, dated 2026-07-15):
   columns are 0-based UTF-16 code units everywhere (persisted facts, floor,
   composers), not "UTF-8 byte columns" as the plan previously said. Remains
   load-bearing at Wave 3 when `ExactSourceRange.startByte` lands (bytes and
   columns must not be conflated there).

## INTENTIONAL — documented decisions that may look like defects

### Wave 2 composer rulings (2026-07-15) — each pinned by test

R1. **Line-only ties REMAIN in `locationAt` answers.** A point query at
    (5,0) returns same-line single-line declarations (`const a`, `const b`)
    in both the enclosing chain and occurrence facts, because v4 persists
    NAME-START columns only (not construct start), so column-based exclusion
    of declarations is provably unsound (`const a` starts at col 8, its name
    at col 14 — excluding on name-col would wrongly drop cols 8–13). Plan v4
    clause: "equal or line-only ties remain ambiguous/partial"; per-fact
    `range.precision:'line'` is the disclosure. Correct future fix: v5
    byte-exact fact spans (Wave 3+), NEVER a column heuristic at v4. Pinned:
    polaris-questions-location.test.js "line-only ties REMAIN".
    References ARE column-refined (name-start + UTF-16 length is decidable).

R2. **`locationAt` include-gating map** (payload semantics, frozen after
    Wave 2): 'enclosing' gates the chain PLUS scope and anchor facts (the
    containment picture); 'occurrences'/'injections'/'diagnostics'/'relations'
    gate their arms. Import facts have NO LocatedFact arm by frozen contract —
    an import at the location surfaces via its reference occurrence row. Not
    a dropped family.

R3. **Byte positions at v4 are accepted-then-unavailable**
    (`question_kind_unsupported`) — the same typed pattern as regex. Correct
    future fix: Wave 3 ExactSourceRange byte facts; do NOT bolt on a
    bytes→line converter in the composer (needs fs, composers are pure).

R4. **The relation fact is a single trailing element** in `locationAt.facts`
    (always the final position), restricted to relations/frontier whose
    endpoints intersect the queried range, and OMITTED entirely when empty.
    An adversarial "relations missing at empty location" finding is this
    ruling working.

R5. **`locationAt` paging bounds**: PROVISIONAL_LIMITS has no location entry,
    so it borrows pageDefaults.fileModel (500) / pageMaxima.fileFacts (500).
    Provisional; Wave 7 settles from measurement. The enclosing chain is NOT
    paged — served whole on every page; only `facts` pages.

R6. **Cross-root determinism is meaningless by design**: scope keys embed
    sha256(root), so handles/factKeys differ across roots for identical file
    content. Determinism contracts hold per-root (two sessions, same root,
    deep-equal). An adversarial cross-root comparison "failure" is not a bug.

R7. **Injection language labels belong to the grammar** (a js sql-tagged
    template may label 'html' depending on injections.scm rules). The
    contract is locationAt/fileModel consistency at the same lines, not label
    values. Fixing labels means editing grammar .scm files, not composers.

R8. **Status is NEVER paging-derived (fixed + pinned 2026-07-15).**
    composeFileModel previously inferred `partial` from page truncation,
    violating the plan's payload rule ("No partial status is inferred merely
    from … a non-exhausted page; it is derived from FactCoverage"). Fixed at
    answer level AND per-section level (a page-cut section keeps its coverage
    status with facts elided; cross-page concatenation reconstructs it).
    Anyone testing against pre-fix behavior will see the flip. Pinned:
    polaris-questions-file.test.js "never infers partial", and locationAt
    equivalent.

R9. **scopeModel refuses file-grain selectors** (INVALID_QUERY narrow_scope,
    "fileModel owns files") — the frozen ScopeQuestion excludes
    {kind:'file'} deliberately; a runtime "defensive" answer would be a
    shadow capability freezing into the contract. NOTE: the original 2.3-B
    brief wrongly demanded a file-selector test (lead's error, corrected at
    review); the worker's defensive implementation was replaced with the
    typed refusal. Pinned in polaris-questions-scope.test.js.

R10. **Non-recursive directory `relations` is typed unavailable at v4.**
    readV4EdgeResolutionStats is a prefix read (inherently recursive);
    serving that count under a non-recursive selector would be wrong-scoped
    data. Correct fix if wanted: a key-list overload of the edge-stats read
    (db-adapter, one new set read) — then flip the composer arm and the pin.
    Pinned: "non-recursive directory relations are typed unavailable".

R11. **scopeModel cannot serve scopes/imports/anchors/injections/structures
    at v4** (typed question_kind_unsupported) even though v4 persists them
    per file: the frozen ScopeGroup carries only
    fileCount/declarationCount/referenceCount/languages, and no set-oriented
    COUNT aggregate exists for those families. Serving them would mean
    per-file row pulls (forbidden N+1) or inventing fields. Correct fix if
    wanted at v4: dedicated directory/project count aggregates in db-adapter
    PLUS a ScopeGroup shape decision (types.ts change — contract-freeze
    exception, routes to Tanner). Worker finding 2.3-B#2.


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
9b. **Strict epoch conservatism (ruled 2026-07-15):** ANY committed transaction
   or cross-connection commit invalidates every open session on that store,
   even when the session's pinned (path,hash) view is untouched. Rationale: in
   the cohabiting global DB, another scope's persist can rewrite THIS scope's
   edges via name-based re-resolution — invisible to the file view. Sessions
   are short-leased; reopen is the correction. Do NOT "fix" this to view-only
   revalidation — that serves silently stale frontiers. Pinned in
   polaris-session.test.js; comment at session.ts `changedSincePin`.
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
