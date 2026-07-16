# POLARIS res-2 — Fix Report (A19, A5, A8, A14)

**Worktree:** `import-extension` · **Toolchain:** Node 26.3.0 / vitest 4.1.10
**Status:** all four findings resolved and proven green; no regression introduced.
**Owner ruling adopted:** N7 = **Option A** (add typed `UnavailabilityReason` values;
withhold facts rather than serve stale/absent ones).

---

## 1. Findings resolved

### A19 — non-string JSON list members silently coerced
`parseJsonStringArray` accepted any JSON array and passed non-string members
through. **Fix (`questions/file.ts`):** every member is type-checked; a
non-string member is `STORE_CORRUPT`. **Proof:** `polaris-resolution-a19-json-list.test.js`
(5 cases + anti-vacuity controls), 5/5 green.

### A5 — global store keys leaked through the public facade
`g/<sha256(root)>/<relpath>` store keys reached public `path:` fields instead of
the allowed-root-relative path. **Fix (`questions/file.ts`, `questions/location.ts`):**
a `publicPathOf(address, storeKey)` helper decodes at every public projection
(identity, model, occurrences, located symbols, relation frontier source,
locate-target candidates). Internal `queryDigest` keeps the raw store key.
**Owner refinement applied:** `publicPathOf` **hard-fails as `STORE_CORRUPT`** on a
non-decodable key — no `?? storeKey` silent re-leak. **Proof:** questions-file +
questions-location green (incl. a corruption test whose DB lookup key comes from
the store/codec, never from the public payload).

### A8 — oversized / missing assemblies claimed `complete`
The null-assembly branch and the oversized branch both called
`coverage.complete(domain)` unconditionally, so a missing/unreadable file or an
oversized source (whose stored rows are preserved *stale* facts) reported its
domains as complete. **Fix (`questions/file.ts` + `types.ts`, Option A):**
- Two new `UnavailabilityReason` values: `source_unreadable`, `source_file_too_large`.
- **Missing** (present in domain, absent/unreadable in store) → every requested
  domain `unavailable(source_unreadable)`, no facts.
- **Oversized** (`toolarge@` sentinel) → parse-dependent domains
  `unavailable(source_file_too_large)` with **facts withheld**; `identity`
  (path/language/hash) stays honestly `complete` and flags `oversized: true`.

**Proof:** `polaris-resolution-a8-oversized.test.js` (seeds a >16 MiB source →
`toolarge@` sentinel). Verified end-to-end: `coverage.complete = ["file"]`;
`declaration/reference/scope/import/structure/anchor/injection/relation` all
`unavailable(source_file_too_large)`; `declarations` section `status:'unavailable'`
with **no** `facts`; identity complete with `oversized:true`.

> Missing-branch note: in normal operation the "present-in-domain, absent-in-store"
> state is caught by freshness revalidation (`status:'failed'`) before the
> null-assembly branch is reached — it is a defensive path. It is covered by
> inspection and shares the exact `unavailable(reason)` mechanism proven by the
> oversized test, rather than forced through a brittle store-mutation fixture.

### A14 — incomplete parent ancestry presented as complete
A depth-64-capped or missing-parent walk still emitted a full dotted
`qualifiedName` and ordinary owner metadata as if the chain were complete.
The depth cap itself is intentional; the false completeness was the defect.
**Fix (`questions/file.ts`), two halves:**
- **Claim-strip (pure code):** `qualifiedName` is asserted only when the walk
  reached the root (`cursor === null` at loop exit); a truncated chain yields
  `null`. Top-level (bare name) and complete-nested (dotted) are unchanged, so
  `qualifiedName === null` on a declaration now uniquely means "ancestry truncated."
- **Coverage half:** any assembled declaration with `qualifiedName === null`
  raises the `incomplete_facts` coverage issue, so the answer is `partial`,
  never silently complete. (Facts are present, so the domain is *not* marked
  `unavailable` — that would wrongly withhold real declarations.)

**Proof:** `polaris-questions-file.test.js` A14 test — RED-first (a parent pointed
outside the file's rows via FK-off makes `method.qualifiedName` a bare `'method'`),
then GREEN (`null`), with anti-vacuity (`topFn` keeps `'topFn'`) and the
`incomplete_facts` caveat asserted. 27/27 across file+location.

---

## 2. Gate deliverables (per the lead's request)

### (a) Exhaustive `UnavailabilityReason` switch enumeration
`grep` across `src` for every `UnavailabilityReason` consumer: the value is only
**produced** (`coverage.unavailable(domain, reason)` and `{status:'unavailable',
reason}` section results in `questions/{file,location,scope}.ts`, `session.ts`,
`ast-intelligence.ts`) and **stored** in the coverage builder's
`Map<FactDomain, UnavailabilityReason>` (`evidence.ts`). **There is no exhaustive
`switch`/`Record<UnavailabilityReason, …>` over the union anywhere in `src`.**
Consequently the two new values require **no handler changes**; `tsc --build`
is clean.

### (b) Pins flipping off `complete`-for-unreadable
**Zero.** No existing test pinned `complete` for a missing or oversized file
(A8 had "no baseline signature," as the lead noted), so nothing flips — the fix
is additive. The two new pinning tests (`a8-oversized`, and the A14 case in
`questions-file`) are the proof in place of expected-value adjudication.

---

## 3. No-regression evidence

Ran all POLARIS suites (perf gate excluded — environment-dependent, known
version-gate failures unrelated to this slice). **My scope is entirely green:**
`questions-file` (incl. A14), `questions-location`, `questions-scope`,
`resolution-a19`, `resolution-a8-oversized`. Every failure observed maps to a
**known, out-of-res-2-scope finding** owned by another worktree:

| Failing test (finding) | Owner |
|---|---|
| heuristic_name as ResolvedLocatedSymbol (**A2**) | res-5 |
| edge target equals clean rebuild (**A3**) | res-1 |
| keyset-tied occurrences exactly once (**A4**) | res-1 |
| BINARY UTF-8 ordering (**A9**) | res-1 |
| rolled-back savepoint generation (**A10**) | res-1 |
| fileModel + facade relation paging exactly once (**A6**) | res-5 |
| realpath before symlink import (**A17/A18**) | res-3/res-5 |
| source-domain identity vs source bytes | res-1/res-3 |
| astral char boundary misclassification (**F2 boundaries**) | res-3 |

No failure lands in res-2's changed code. A5 (previously RED at baseline) is now
GREEN; A19/A8/A14 add green. Net: strictly fewer failures than baseline, none new.

---

## 4. Files changed

- `src/core/intelligence/types.ts` — `+source_unreadable +source_file_too_large` on `UnavailabilityReason`.
- `src/core/intelligence/questions/file.ts` — A19 member check; A5 `publicPathOf` (hard-fail) + public path sites; A8 missing/oversized → unavailable; A14 claim-strip + `incomplete_facts`.
- `src/core/intelligence/questions/location.ts` — A5 `publicPathOf` at public path sites.
- `tests/polaris-resolution-a19-json-list.test.js` (new), `tests/polaris-resolution-a8-oversized.test.js` (new), `tests/polaris-questions-file.test.js` (A14 test added; 2 stale A5 expectations updated — disclosed).

## 5. Integration note
Slice lands **on top of res-5** (its reworked paging/assembly underpins the file.ts
composer). res-2 edits live in the `import-extension` worktree, not `resolution-2`.
