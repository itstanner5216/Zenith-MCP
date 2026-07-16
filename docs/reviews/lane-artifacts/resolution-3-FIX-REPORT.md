# POLARIS resolution-3 — FIX-REPORT (session.ts security/correctness findings)

Scope: **A17, A1, A11, A12, A16** — all in the AST-intelligence session layer.
Owner-only findings; each challenged, reproduced RED, fixed plan-correct, proven GREEN,
and proven regression-free against the full package suite.

## Base state & toolchain
- Branch reset onto `resolution-3` tip **46b341f** ("pre documented issues resolutions") —
  the exact state the findings + pinning tests + plan were authored against.
- Node 26 + `corepack pnpm`. Build: `pnpm build` (tsc `--build`, strict, `noUncheckedIndexedAccess`).
  Tests: `npx vitest run` from `packages/zenith-mcp`.
- Authority order honored: owner > plan (`docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md`)
  > findings (`docs/POLARIS-KNOWN-ISSUES-2026-07-15.md`) > tests.

## Files changed (source)
- `packages/zenith-mcp/src/core/shared.ts` — A1 (+5/-2).
- `packages/zenith-mcp/src/core/intelligence/session.ts` — A17 + A11 + A12 + A16 (+95/-22 total).

## Tests
- **Corrected** (encoded the bug, now asserts plan-truth): `tests/polaris-session.test.js`
  → "a mid-batch content failure returns an exact receipt" (A11).
- **New independent pinning tests** (hand-authored oracles, raw-SQL read path, fault-injection triggers,
  explicit positive/negative controls so a plausible mutation cannot stay green):
  - `tests/polaris-independent-content-receipts.test.js` (A11, 3 tests)
  - `tests/polaris-independent-walk-coverage.test.js` (A12, 1 test; skips when uid==0)
  - `tests/polaris-independent-store-failure-typed.test.js` (A16, 2 tests)
- **Pre-existing pinning tests** flipped RED→GREEN:
  - `tests/polaris-independent-facade-adversarial.test.js` → "enforces realpath validation…" (A17)
  - `tests/polaris-independent-session-freshness.test.js` → "canonical source-domain identity…" (A1)

## Suite-level proof (no regressions)
- **Baseline (source reverted):** 17 failed / 1754 passed / 2 skipped.
- **With fixes:** 15 failed / 1762 passed / 2 skipped.
- **Normalized diff of failing sets:** the ONLY tests removed from the failing set are exactly the
  A17 realpath test and the A1 canonical-identity test. **Zero** current failures are absent from
  baseline (no regressions). The 15 remaining failures are sibling-agent findings
  (F1 paging ×4, F2 unicode ×3, LATENT occurrences ×1, A2/A3/A4/A9/A10 adversarial-contracts ×5,
  A5/A6 facade ×2) — out of scope for this resolution and owned by other agents.
- `tests/stash-restore-tool.test.js` flaked once (a **20s timeout inside its own `git init`
  subprocess** under full-suite parallel load, with a `MaxListenersExceededWarning`); it passes in
  isolation and on re-run. Not touched by these changes (no process spawning added). Ambient flake.

## Constraints honored
- No SQL `OFFSET`; no TypeScript non-null assertions (`!`); `packages/zenith-toon` untouched.
- No public type/contract changes: every fix corrects VALUES/BEHAVIOR within existing types
  (`QueryResult`, `OperationalFailure`, `EnumeratedDomain`, the open-failure receipt). No plan amendment required.
- No commit/stage/push — branch is a proof artifact.

---

## A17 — Explicit file/anchor symlinks bypass realpath scope validation (SECURITY)

**Finding (verbatim):** "Session routing and enumeration use lexical containment without invoking
`FsContext.validatePath`. An in-root symlink can index and return an outside declaration. Recursive
Dirent walking is not the asserted exploit. Evidence: `session.ts:128-172,630-650`; `lib.ts:79-92`."

**RED proof:** `polaris-independent-facade-adversarial.test.js` → "enforces realpath validation
before a symlink can import outside bytes" FAILS on baseline source (an in-root symlink whose
realpath is outside the allowed root is indexed and its outside declaration returned).

**Root cause:** `openAstSessionWithDeps` routed on `path.resolve(request.anchor)` and
`enumerateDomain` selected file/dir paths by lexical `toStoreKey` containment only. `FsContext.
validatePath` (realpath + allowed-root check) was never called, so a symlink pointing outside the
allowed roots passed the lexical test.

**Fix (guard-only, never re-scope):**
- `openAstSessionWithDeps`: `await ctx.validatePath(request.anchor)` before any store/index work;
  refuse `INVALID_QUERY` on throw. The **lexical** `anchorAbs` is kept for routing so a legitimately
  symlinked *allowed* root is not silently re-scoped to its realpath (which would change store keys).
- `enumerateDomain(ctx, …)`: `await ctx.validatePath(abs)` for the `file` and `directory` selectors;
  return `{ invalid }` on throw. Directory *walks* already skip symlinks via `Dirent.isFile/isDirectory`,
  so only the anchor + explicit file/dir selectors are attack vectors — those are exactly the guarded points.
- Refuse on **any** `validatePath` throw (prod throws "Access denied", the harness throws
  "outside allowed root") rather than message-matching.

**Why guard-only, not route-through-realpath (alternatives ranked):**
1. **Guard, keep lexical path (chosen).** Blocks the escape with zero re-scoping risk; `fs.realpath`
   does not throw on benign unreadable/missing paths, so no false refusals. Most robust.
2. Route reads through `realpath`. Rejected — silently re-scopes a symlinked allowed-root to a
   different store key, a correctness regression for a legitimate configuration.
3. Message-match specific errors. Rejected — brittle across prod/test `validatePath` implementations.

**GREEN:** A17 test passes; full suite shows no regression.

---

## A1 — Session source identity includes its own `.mcp` artifacts

**Finding (verbatim):** "Project-store creation precedes domain enumeration, and `.mcp` is absent
from the default excludes. A three-file fixture reports seven members after `.mcp/.gitignore`, the DB,
WAL, and SHM enter the source-domain count/digest. Evidence:
`polaris-independent-session-freshness.test.js:134-169`; `shared.ts:52-65`; `symbol-index.ts:105-114`."

**RED proof:** `polaris-independent-session-freshness.test.js` → "canonical source-domain identity
ignores filesystem creation order but changes with source bytes" FAILS on baseline (the MCP's own
`.mcp` store files inflate the member count and pollute the identity digest).

**Root cause:** `getDefaultExcludes()` omitted `.mcp`, so the store the MCP writes into its own
project root (`.mcp/symbols.db` + `-wal`/`-shm`, `.mcp/.gitignore`) enumerated as source members.

**Fix:** `shared.ts getDefaultExcludes()` force-includes `.mcp` in **both** branches — appended to a
custom comma-list when absent, and added to the hardcoded default string. Making it *mandatory*
(not merely part of the replaceable default) means a caller-supplied exclude list cannot re-expose
the MCP's own artifacts. `enumerateDomain` and `shouldIndexFile` both consult these excludes, so the
directory (and its DB/WAL/SHM) drops out of the count and digest.

**Alternatives ranked:** (1) mandatory exclude in both branches (chosen — robust to config override);
(2) add `.mcp` only to the default string (rejected — a custom `EXCLUDES` env silently re-pollutes);
(3) special-case `.mcp` at each call site (rejected — scatters the invariant, invites drift).

**GREEN:** A1 test passes; full suite shows no regression.

---

## A11 — Content freshness order and receipts are inaccurate

**Finding (verbatim):** "Files are applied in caller order without duplicate rejection; the `0|1`
freshness result is ignored; the failed path enters `unchanged`; and unattempted paths are conflated
with unchanged paths. Evidence: `session.ts:682-722`; `symbol-index.ts:555-577`; plan line 254."
Plan Decision 14 requires canonical store-key order and a receipt naming `updated[]`, `unchanged[]`,
and `failed`. Receipt type: `updated: readonly string[]; unchanged: readonly string[]; failedPath: string | null`.

**RED proof (independent oracle):** `polaris-independent-content-receipts.test.js`:
- "processes content in canonical store-key order regardless of request order" — reversed request
  order still commits the canonically-first file and never touches the canonically-last; raw-SQL
  oracle confirms which programs committed.
- "separates already-fresh files (unchanged) from reindexed files (updated) in the receipt" — a
  byte-identical file (`0`) lands in `unchanged`, new bytes (`1`) in `updated`.
- "rejects a store-key-duplicated content file (canonical, not literal) as INVALID_QUERY" — an
  absolute + relative spelling of the same file collapse to one store key; the duplicate is rejected
  (asserted via the `/duplicate content file/` detail, so it can't pass for a membership reason).

All three FAIL on baseline. Additionally, the pre-existing `polaris-session.test.js` receipt test was
**itself a characterization of the bug** — it asserted the byte-identical file in `updated` (bug: 0|1
ignored), the **failed** file in `unchanged` (bug: failed→unchanged), and "notes never reached" under
**caller** order (bug: caller-order). It was corrected to the plan-true receipt (empirically captured):
`updated=[]`, `unchanged=[notes.txt, src/alpha.ts]` (canonical order), `failedPath=src/deep/beta.ts`,
plus an explicit assertion that the failed file never appears in `unchanged`. That corrected test also
FAILS on baseline (`[Array(1)]` vs `[]`), confirming it is a real oracle, not goalpost-moving.

**Root cause:** the content loop pushed **every** attempted file to `updated` (ignoring
`ensureFreshFromContentAt`'s `0|1`), processed files in caller order, and on failure set
`unchanged = contentKeys.slice(i)` — placing both the failed file and the unattempted tail into
`unchanged`. No duplicate rejection.

**Fix (session.ts content phase):**
1. Dedupe on canonical store key → reject duplicates as `INVALID_QUERY`.
2. `contentKeys.sort` by store key before processing (deterministic partial commit).
3. Honor the return: `reindexed === 1 → updated`, else `unchanged`.
4. On a file throwing: return `{ updated, unchanged, failedPath: entry.key }` where `updated`/
   `unchanged` hold only the 1..i-1 successes, the failed file is named **only** in `failedPath`, and
   the unattempted tail (i+1..) is **omitted** from all three.

**Semantic note:** a non-indexable file (e.g. `.txt`) and a byte-identical file both return `0` and
are reported `unchanged` — read as "attempted, no reindex/fact update," which is the least-wrong of
the three existing buckets (the type has no fourth `skipped` bucket, and adding one is a contract
change out of scope here).

**Alternatives ranked:** (1) honor `0|1` into updated/unchanged, canonical order, failed-only-in-
failedPath, unattempted-omitted (chosen — exactly the four sub-bugs A11 names, grounded in Decision 14
and the three-bucket type); (2) keep pushing all-attempted to `updated` (rejected — that is the bug,
and makes the `0|1` return meaningless); (3) add a fourth `skipped` bucket for non-indexables
(rejected here — public-type/contract change requiring a plan amendment).

**GREEN:** 3 new content-receipts tests + corrected `polaris-session.test.js` all pass; no regression.

---

## A12 — Directory-enumeration errors silently shrink the source domain

**Finding (verbatim):** "A failed `readdir` returns as if the subtree were empty, without an
unreadable member, `incomplete_walk`, or typed failure. Per-file unreadable handling is separate and
does not close this directory-walk gap. Evidence: `session.ts:142-145,167-183,751-764`."

**RED proof:** `polaris-independent-walk-coverage.test.js` → "surfaces incomplete_walk when a
subdirectory read fails, and clears it when readable" FAILS on baseline. Metamorphic control: the
same domain with the subdirectory readable must NOT report `incomplete_walk` (guards against a test
that always sees the flag). Uses a `chmod 000` subdir; skipped when uid==0 (root ignores the bit).

**Root cause:** `walk()` swallowed a `readdir` rejection with `catch { return; }`, so an unreadable
subtree looked identical to an empty one — the domain silently shrank with no signal.

**Fix:** thread `incompleteWalk` through `enumerateDomain`; the `readdir` catch sets
`incompleteWalk = true` (still returning, so enumeration continues over what is readable); surface it
as an `incomplete_walk` coverage issue on the session basis. This is proven **independent** of A17:
`fs.realpath` succeeds on a `chmod 000` directory (only `readdir` throws `EACCES`), so `validatePath`
does not pre-empt the walk — the two findings exercise different failure points.

**Alternatives ranked:** (1) record `incomplete_walk` coverage and continue (chosen — preserves the
readable partial domain while signaling incompleteness, matching the plan's coverage vocabulary);
(2) hard-fail the whole open on any `readdir` error (rejected — a single unreadable subdir should not
sink an otherwise valid session); (3) synthesize an `unreadable` member per failed dir (rejected —
fabricates members with no store key/hash, violating the identity contract).

**GREEN:** A12 test (incl. metamorphic control) passes; no regression.

---

## A16 — Operational store failures can escape the typed API boundary

**Finding (verbatim):** "Query entry maps only errors prefixed `STORE_CORRUPT` and rethrows other
SQLite/store errors; open-time pinning is also outside a catch. This is separate from intentional
item 16 (adapter configuration errors). Evidence: `session.ts:539-554,725-733`; plan lines 240, 1315."

**RED proof:** `polaris-independent-store-failure-typed.test.js`:
- "maps a query-time store fault to a typed STORE_CORRUPT instead of throwing"
- "maps an open-time store fault to a typed STORE_CORRUPT instead of throwing"

Both FAIL on baseline. A same-connection `DROP TABLE files` (raw SQL) is used: it does not move the
fact epoch (`data_version` is unchanged for the connection's own writes; the commit generation only
advances on an outer-commit), so revalidation proceeds into the missing table and surfaces the real
store fault — rather than short-circuiting as `INPUT_CHANGED`.

**Root cause:** the query seam matched only messages prefixed `STORE_CORRUPT` and rethrew everything
else (so a raw node:sqlite corruption error escaped as an untyped throw), and the open-time pinning
`runTransaction` had no catch at all.

**Fix:** a single classifier `typedStoreFailure(e): OperationalFailure | null`:
- `FUTURE_SCHEMA…`/`STORE_CORRUPT…` prefixed signals → the matching typed failure.
- `code === 'ERR_SQLITE_ERROR'` **and** a corruption-class message (`no such table`, `no such column`,
  `malformed`, `not a database`, `file is encrypted`) → `STORE_CORRUPT`.
- Everything else → `null` (rethrow). Transient/programming errors (locked db, too-many-variables,
  API misuse) deliberately stay **loud** so real defects are not masked as corruption.

Applied at exactly the two named seams: the `answer()` query catch, and the open-time pinning
`runTransaction` (now wrapped; `typedStoreFailure` → `openFailure`, else rethrow). The disk-freshness
and content loops already funnel indexing errors to typed `FRESHNESS_FAILED`, so no store error
escapes `openAstSessionWithDeps`.

**Alternatives ranked:** (1) allowlist corruption-class messages at both seams (chosen — typed where it
must be, loud where it must be; single source of truth, no drift); (2) blanket-map all
`ERR_SQLITE_ERROR` to `STORE_CORRUPT` (rejected — hides programming bugs and transient locks behind a
"corruption" label); (3) inline the classifier at each seam (rejected — duplicates the allowlist and
invites the two seams to diverge, a latent correctness bug).

**GREEN:** both A16 tests pass; no regression.
