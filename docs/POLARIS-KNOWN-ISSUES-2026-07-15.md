# POLARIS — Known Issues & Intentional Behaviors (as of 2026-07-15, mid-Wave 2)

**NO documented issue has been cleared by the owner, regardless of the authority in which it was written, all issues are to be challenged, and attempts should be made to resolve them correctly**
**This includes the INTENTIONAL items: a documented rationale is the lead's reasoning, not a clearance. "Do not fix" / "not a bug" means "here's why the lead thinks so" — if you can show otherwise, challenge it. The original plan is the only authority who has the final say in whats correct, outside of myself, the owner, unless explicitly approved by me, and a proper plan amendment is made. No plan amendments are approved without my explicit approval, for any reason.**

Written by the implementation lead for cross-referencing against the adversarial
test agents' findings. Two categories: **OPEN** (real, owed, scheduled) and
**INTENTIONAL** (looks like a bug, is a documented decision — do not "fix") and
**Independent Audit Additions** for independent auditor issues/findings deduped
against the current issues/findings.

Status vocabulary (lead entries): every decision below is a **lead decision —
pending owner** unless it carries an explicit **owner-approved (date)** mark.
No entry written by the lead may claim ruled/cleared/settled status; where
older text said so, it has been relabeled, not re-argued.

### Independent audit additions (2026-07-16; deduplicated)

A1. **[P1] Session source identity includes its own `.mcp` artifacts — RED.**
    Project-store creation precedes domain enumeration, and `.mcp` is absent
    from the default excludes. A three-file fixture reports seven members after
    `.mcp/.gitignore`, the DB, WAL, and SHM enter the source-domain count/digest.
    Evidence: `polaris-independent-session-freshness.test.js:134-169`;
    `session.ts:122-185`; `shared.ts:52-65`; `symbol-index.ts:105-114`.

A2. **[P1] `ResolvedLocatedSymbol` does not type-enforce “resolved means proved” — RED.**
    The alias narrows only the handle. A fact handle carrying
    `candidateBasis:'heuristic_name'` compiles as resolved with zero diagnostics,
    contrary to the locked proof gate. Evidence:
    `polaris-independent-adversarial-contracts.test.js:183-203`;
    `types.ts:45-50,77-90`; plan lines 235 and 425.

A3. **[P1] Same-name definition reindex can orphan incoming edge targets — RED.**
    Symbol replacement nulls incoming FKs, but equal old/new definition-name
    sets skip affected-name re-resolution. Incremental state loses the target;
    a clean rebuild retains it. Evidence:
    `polaris-independent-adversarial-contracts.test.js:204-263`;
    `persist.ts:34-44,119-143`; `db-adapter.ts:241-245`.

A4. **[P1] Occurrence keyset pagination is not a strict total order — RED.**
    Cursor/order `(path,line,column,name)` can tie for legal rows that differ in
    other persisted fields. Page one returns one row and its continuation skips
    the tied remainder. Independently reproduced by
    `polaris-audit-occurrences-differential.test.js` (raw-row differential over a
    `type`-distinct tie — concat length 1 against total 2, natural distinct-column
    rows as the control). Evidence:
    `polaris-independent-adversarial-contracts.test.js:264-327`;
    `db-adapter.ts:2122-2131,2671-2765`.

A5. **[P1] Global storage prefixes leak through the public facade — RED.**
    `g/<rootHash>/...` is correct inside the global DB but `FileModel`, identity,
    and occurrence paths return it instead of the allowed-root-relative path.
    Evidence: `polaris-independent-facade-adversarial.test.js:78-110`;
    `file.ts:210-224,475,573-580,687-690`; plan line 789.

A6. **[P1] `fileModel` pagination violates exact-once, accounting, and status contracts — RED.**
    Only array-shaped facts occupy cursor positions. Identity/relations count
    toward totals but not `returned`; relations replay whole on every page; and
    page truncation still drives section/answer `partial` state. Page walks
    therefore duplicate object facts and cannot reconcile to the one-shot
    canonical answer. Evidence:
    `polaris-independent-facade-adversarial.test.js:111-166` and
    `polaris-audit-file-model-paging.test.js`; `file.ts:638-694`. This entry
    replaces the former R8 and former intentional item 7; the defect is listed
    nowhere else in this document.

A7. **[P1] The v4 fact-ledger projection is not lossless.** Persisted scope
    locals/parameters, injection host language/byte offsets, structure
    decorators/generics/parent facts, and occurrence visibility are not
    representable; orphan structures and unmatched bindings can disappear.
    The imports section also never requests/completes the separate
    `import_binding` domain. This concerns persisted v4 facts, not the typed
    unavailability for future families documented in intentional item 6.
    Evidence: `types.ts:708-755`; `file.ts:241-309,435-451,599-618`.

A8. **[P1] Missing and oversized assemblies claim false per-domain completeness.**
    Missing assembly fabricates empty identity/facts while calling
    `coverage.complete`; an oversized current source can project preserved
    prior rows under the new sentinel while its sections remain `complete`.
    The outer answer is partial, but its section/domain claims are still false.
    Evidence: `file.ts:148-203,542-618`; `symbol-index.ts:366-375`.

A9. **[P1] Canonical string ordering conflicts across SQLite and JavaScript — RED.**
    SQLite `BINARY` uses UTF-8 bytes while generic/domain/adapter post-sorts use
    JavaScript UTF-16 `<`; U+E000 and U+10000 reverse order. Evidence:
    `polaris-independent-adversarial-contracts.test.js:328-382`;
    `evidence.ts:151-169`; `session.ts:185,720-722`;
    `db-adapter.ts:2845-2866,3230-3242,3286`.

A10. **[P1] A rolled-back nested savepoint can advance the fact epoch — RED.**
    Outer generation uses SQLite `total_changes`, which includes writes later
    rolled back to a savepoint. A net-read-only outer commit therefore moves
    `commitGeneration` and invalidates sessions. This is distinct from
    intentional item 9b: a real committed write should still invalidate.
    Evidence: `polaris-independent-adversarial-contracts.test.js:383-428`;
    `db-adapter.ts:1263-1289`.

A11. **[P1] Content freshness order and receipts are inaccurate.** Files are
    applied in caller order without duplicate rejection; the `0|1` freshness
    result is ignored; the failed path enters `unchanged`; and unattempted paths
    are conflated with unchanged paths. Evidence: `session.ts:682-722`;
    `symbol-index.ts:555-577`; plan line 254.

A12. **[P1] Directory enumeration errors silently shrink the source domain.**
    A failed `readdir` returns as if the subtree were empty, without an
    unreadable member, `incomplete_walk`, or typed failure. Per-file unreadable
    handling is separate and does not close this directory-walk gap. Evidence:
    `session.ts:142-145,167-183,751-764`.

A13. **[P1] Ripgrep executes before literal-floor safety bounds.** Every disk
    path is passed to rg before stat, per-file size, or aggregate byte-budget
    enforcement. The later bounded accounting cannot bound rg's actual work.
    Intentional items 10 and 11 remain valid descriptions of result/absence
    semantics; this issue is the unbounded optimization step before them.
    Evidence: `text-floor.ts:207-220,231-280`; plan lines 763-767.

A14. **[P1] Incomplete parent ancestry is silently presented as complete.**
    Missing parents and depth-64 truncation stop assembly without corruption or
    partial coverage, after which ordinary owner metadata and complete sections
    are emitted. The depth cap itself remains intentional; the false
    completeness is the defect. Evidence: `file.ts:158-183,570-596`; plan line
    721.

A15. **[P1] Frontier candidate identity, ancestry, and ordering conflict with their contracts.**
    Public fact handles use fabricated `sourceHash:'legacy'`; computed ancestors
    are omitted while `parent_symbol_id` is claimed; candidate Sets are not
    sorted by the locked comparator. Evidence: `file.ts:353-413`;
    `db-adapter.ts:2394-2397`; plan lines 272 and 676.

A16. **[P1] Operational store failures can escape the typed API boundary.**
    Query entry maps only errors prefixed `STORE_CORRUPT` and rethrows other
    SQLite/store errors; open-time pinning is also outside a catch. This is
    separate from intentional item 16, which concerns adapter configuration
    errors rather than operational failures crossing a public query/open seam.
    Evidence: `session.ts:539-554,725-733`; plan lines 240 and 1315.

A17. **[P1] Explicit file/anchor symlinks bypass realpath scope validation — RED.**
    Session routing and enumeration use lexical containment without invoking
    `FsContext.validatePath`. An in-root symlink can index and return an outside
    declaration. Recursive Dirent walking is not the asserted exploit.
    Evidence: `polaris-independent-facade-adversarial.test.js:167-211`;
    `session.ts:128-172,630-650`; `project-context.ts:325-353`;
    `lib.ts:79-92`.

A18. **[P2] Nullable malformed spans can disappear from range reads.** SQL
    three-valued comparisons filter null symbol/scope/injection spans instead
    of surfacing `STORE_CORRUPT`. This remains latent while the corresponding
    public location path is unavailable. Evidence:
    `db-adapter.ts:2516-2538,2559-2575,2595-2609`.

A19. **[P2] Non-string persisted JSON-list members are coerced into facts.**
    Valid arrays such as `[1,null,{}]` are stringified rather than rejected as
    store corruption. Invalid JSON syntax and non-array JSON are already
    rejected correctly. Evidence: `file.ts:51-62`.

A20. **[P2] Astral identifier characters receive the wrong boundary annotation — RED.**
    `.slice(-1)`/`.slice(0,1)` truncates an adjacent supplementary-plane letter
    or number to one surrogate, so `identifierBoundary` becomes true when
    `\p{L}`/`\p{N}` requires false. Raw hits remain intact; only the annotation
    is wrong. Focused oracle: 10 pass, 3 red in
    `polaris-audit-text-floor-unicode.test.js:146-192`. Source:
    `text-floor.ts:76-86`.

A21. **[P2] `lastIndexedAt` leaks persistence history through file identity.**
    The public type and composer expose an internal timestamp even though the
    authoritative ledger says storage timestamps never cross the facade.
    Evidence: `types.ts:482-489`; `file.ts:187-192,573-580`; plan line 732.
    
**NO documented issue has been cleared by the owner, regardless of the authority in which it was written, all issues are to be challenged, and attempts should be made to resolve them correctly**
**This includes the INTENTIONAL items: a documented rationale is the lead's reasoning, not a clearance. "Do not fix" / "not a bug" means "here's why the lead thinks so" — if you can show otherwise, challenge it. The original plan is the only authority who has the final say in whats correct, outside of myself, the owner, unless explicitly approved by me, and a proper plan amendment is made. No plan amendments are approved without my explicit approval, for any reason.**

## INTENTIONAL — documented decisions that may look like defects

### Wave 2 composer decisions (2026-07-15) — lead decisions, pending owner; each pinned by test

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
    An adversarial "relations missing at empty location" finding is this working. (not
    cleared by owner at this time).

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

R8. **SUPERSEDED BY AUDIT A6.** This entry formerly claimed the paging/status
    fix was complete ("fixed + pinned 2026-07-15"). Independent repro
    (A6: object-fact replay across pages, returned-vs-total accounting,
    residual truncation-driven state) disputes that claim. The 710 rule
    itself (status derives from FactCoverage, never from paging) is plan
    text and stands; the LEAD'S IMPLEMENTATION of it is what A6 indicts.
    Lead owes re-verification and the fix; do not rely on the former claim.

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
    
**NO documented issue has been cleared by the owner, regardless of the authority in which it was written, all issues are to be challenged, and attempts should be made to resolve them correctly**
**This includes the INTENTIONAL items: a documented rationale is the lead's reasoning, not a clearance. "Do not fix" / "not a bug" means "here's why the lead thinks so" — if you can show otherwise, challenge it. The original plan is the only authority who has the final say in whats correct, outside of myself, the owner, unless explicitly approved by me, and a proper plan amendment is made. No plan amendments are approved without my explicit approval, for any reason.**
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
3b. **Audit findings A1–A21 triage owed by the lead (2026-07-16).** Wave 2
   composer work is PAUSED until the RED contract findings are dispositioned:
   each becomes a fix task (lead or delegated to the parallel worktree
   agents), a challenge with evidence, or an owner escalation. None are
   presumed wrong; several (A3, A6, A10 at minimum) dispute the lead's own
   prior claims and are provisionally accepted as real pending re-verification.
4. **POLARIS_REAL_DB_COPY rehearsal never executed** — env-gated test requires
   an explicit copy of a real `~/.zenith-mcp` DB; needs Tanner to provide one.
5. **F2 plan wording (UTF-16 vs UTF-8 columns) — OWNER-APPROVED 2026-07-16.**
   Columns are 0-based UTF-16 code units everywhere (persisted facts, floor,
   composers); plan line ~423 now carries the amendment with the approval
   recorded. History: improperly applied as adopted 2026-07-15, demoted to
   proposed 2026-07-16, then explicitly approved by Tanner the same day.
   Load-bearing at Wave 3: `ExactSourceRange.startByte` must not conflate
   bytes with columns. Note A9 (audit) is a DIFFERENT axis — it concerns
   canonical SORT order of strings, not position units; F2's approval does
   not resolve A9.

6. **v4 honesty gaps in composed answers** (resolve at v5, per FACT_LEDGER
   `availableFrom`): `OccurrenceFact.namespace` is always `'unknown'` (v4
   cannot distinguish value/type namespace); `tainted` is always `false` (v4
   persists no parse-taint); sections exports/signatures/diagnostics/module/
   configuration return typed `unavailable question_kind_unsupported`;
   bindings section returns `question_requires_binding`.
7. **fileModel `relations` section is unpageable by design — SUPERSEDED BY
   AUDIT A6** insofar as the surrounding paging accounting is disputed; the
   design intent (object-shaped section, served whole) is retained as a lead
   decision pending owner, but its current implementation is part of the A6
   defect surface and will be re-established or corrected with that fix.
8. **Session cap (H4)** counts every domain member including unsupported files
   (symbol-index counts only indexable ones). Documented conservative choice,
   session.ts ~line 113.
9. **Revalidation view spans keys beyond the 5000-file cap (H2)** — the
   (path,hash) view covers the whole key predicate, wider than capped
   membership, so a change beyond the cap invalidates the session. Conservative
   by design (over-invalidation, never staleness).
9b. **Strict epoch conservatism (2026-07-15):** ANY committed transaction
   or cross-connection commit invalidates every open session on that store,
   even when the session's pinned (path,hash) view is untouched. Rationale: in
   the cohabiting global DB, another scope's persist can rewrite THIS scope's
   edges via name-based re-resolution — invisible to the file view. Sessions
   are short-leased; reopen is the correction. Lead's reasoning — challengeable
   per the banner — is that view-only revalidation would serve silently stale
   frontiers. Distinct from audit A10 (rolled-back savepoint writes moving the
   generation), which the lead acknowledges as a real, separate defect.
   Pinned in polaris-session.test.js; comment at session.ts `changedSincePin`.
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
    `AdapterConfigurationError`) — open allowlist, deliberately parked:
    tool layer is being rebuilt from scratch after POLARIS. (not cleared by owner at this time).
17. **Scaling caveat (documented):** per-call revalidation reads the whole
    scope hash view; project-mode empty-prefix sessions scan the entire `files`
    table per query. Measured at Wave 7 (Decision 23), not before.
18. **Env:** pnpm launcher broken (stub binary); all builds/tests invoke
    `node_modules/.bin/*` directly. `tsc --build` emits JS despite type errors
    (noEmitOnError off) — always check the exit code, not emitted files.
    
**NO documented issue has been cleared by the owner, regardless of the authority in which it was written, all issues are to be challenged, and attempts should be made to resolve them correctly**
**This includes the INTENTIONAL items: a documented rationale is the lead's reasoning, not a clearance. "Do not fix" / "not a bug" means "here's why the lead thinks so" — if you can show otherwise, challenge it. The original plan is the only authority who has the final say in whats correct, outside of myself, the owner, unless explicitly approved by me, and a proper plan amendment is made. No plan amendments are approved without my explicit approval, for any reason.**

## Transients already resolved (no action)

- The 2.2-C agent's mid-flight report of a no-OFFSET gate failure on
  `text-floor.ts` was an artifact of scanning a concurrently-edited file;
  current gate + file pass (full suite 1,659/0 post-merge, twice).
