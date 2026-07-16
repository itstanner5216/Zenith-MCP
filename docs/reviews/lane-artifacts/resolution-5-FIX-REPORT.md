# FIX-REPORT — resolution-5 (CONTRACTS, all escalation-bound)

**Worktree:** `/home/tanner/Projects/Zenith-Worktrees/resolution-5`
**Plan:** `docs/concepts/AST_INTELLIGENCE_SYNTHESIS.md`
**Toolchain:** `pnpm install` → `pnpm build` → `pnpm exec vitest run <files>` (Node 26, tests import from `dist/`).
**Branch discipline:** proof artifact only — nothing committed, staged, or pushed.

> Every finding below changes a public **type / contract / payload**. Per the Shared Charter,
> the output is a **`PROPOSED AMENDMENT — PENDING OWNER APPROVAL`**, proven to build and pass,
> presented for the owner's ruling. None is self-adopted, ruled, approved, or cleared.

## Change surface

| File | Findings |
|---|---|
| `packages/zenith-mcp/src/core/intelligence/types.ts` | A2, A6, A7, A21 |
| `packages/zenith-mcp/src/core/intelligence/questions/file.ts` | A6, A7, A15, A21 |
| `packages/zenith-mcp/src/core/db-adapter.ts` | A15 |

New pinning tests (proof artifacts):
`tests/polaris-resolution5-a7-fact-projection.test.js`,
`tests/polaris-resolution5-a15-frontier-identity.test.js`,
`tests/polaris-resolution5-a21-identity-timestamp.test.js`.
Full working diff: `git diff` (also saved to the session at `files/resolution5.diff`).

## Constraints honored

No SQL `OFFSET`; no non-null assertions (`!`) added (all new nullable reads are explicitly guarded
under `noUncheckedIndexedAccess`); internal SQLite IDs never cross the facade (A15 mints the target's
own scope-relative fact key, not a row id); no file under `packages/zenith-toon` touched.

## Full-suite no-regression (whole `zenith-mcp` package)

| | Files | Tests | Passed | Failed |
|---|---|---|---|---|
| Baseline (pre-change) | 6 failed / 126 | 1773 | 1754 | 17 |
| After fixes | 5 failed / 129 | 1786 | 1773 | 11 |

`+13` tests (the three new pinning files), `+19` passing (6 previously-red targets flipped GREEN
plus 13 new), `−6` failures. A `comm` diff of the two failure lists shows **zero new failures**: the
remaining 11 are all pre-existing and belong to *other* worktrees' findings (BINARY UTF‑8 ordering,
keyset‑tie occurrence paging, edge clean-rebuild equality, savepoint epoch, global-key decode,
symlink realpath, session source-domain, text-floor astral boundaries, occurrences-differential).
Baseline/final captures: `files/baseline-full-suite.txt`, `files/final-full-suite.txt`.

RED-first for the three *new* tests was proven mechanically: with the three source files reverted
(`git checkout --`) and rebuilt, 12 of 13 new assertions fail; the one green is a supporting
count-invariant that holds trivially when no orphan is present. Restored + rebuilt → all 13 green.

---

## A2 — `ResolvedLocatedSymbol` did not enforce "resolved means proved"

**Repro (RED):** `tests/polaris-independent-adversarial-contracts.test.js` →
*"rejects heuristic_name as a ResolvedLocatedSymbol even when its handle is a persisted fact"*.
The oracle compiles a virtual `.ts` against built `dist` declarations: `exact_declaration`+fact handle
must compile; `text_occurrence`+text handle and `heuristic_name`+fact handle must be `TS2322`. Under
original code the `heuristic_name` case compiled clean → RED.

**Root cause:** `ResolvedLocatedSymbol = LocatedSymbol & { handle: ProvableSymbolHandle }` narrowed only
the *handle*. `candidateBasis` stayed the full `CandidateBasis`, so a fact-handled `heuristic_name`
inhabited the resolved arm.

**Fix (plan line 441 — *"resolved has no weak basis variant … a candidate carrying `heuristic_name`,
`legacy_callee_id` (internal only), `text_occurrence`, or a text handle cannot satisfy the resolved
branch"*):** add and apply

```ts
export type ResolvedCandidateBasis = Exclude<CandidateBasis, 'heuristic_name' | 'text_occurrence'>;
export type ResolvedLocatedSymbol = LocatedSymbol & {
    handle: ProvableSymbolHandle;
    candidateBasis: ResolvedCandidateBasis;
};
```

`legacy_callee_id` is internal-only and never part of the public `CandidateBasis`, so nothing extra is
needed to exclude it. No composer constructs a `resolved` target at v4 (`grep` for `status:'resolved'`
finds none), so this is a pure compile-time tightening with no runtime behavior change.

**GREEN:** the pinning test passes; full suite unchanged apart from the flip.

**PROPOSED AMENDMENT:** narrow the public `ResolvedLocatedSymbol.candidateBasis`.

**Ranked alternatives:**
1. *(implemented)* `Exclude<CandidateBasis,'heuristic_name'|'text_occurrence'>` — the literal plan‑441
   set; keeps `parent_containment` (structural) and `exact_declaration` as proof-bearing.
2. *Stricter split* — `ProvenLocatedSymbol` (adds `parent_containment`) vs `ResolvedLocatedSymbol`
   (`BindingBasis | 'exact_declaration'` only), forbidding containment-only "resolutions". More future‑proof
   for a v6 `resolveAt`, but exceeds what line 441 requires and would need a second exported type; offered
   for the owner's consideration, not adopted.
3. Runtime assertion only — rejected: the plan mandates a *compile-time* constructor guarantee.

---

## A6 — fileModel paging replayed object-shaped sections; `returned ≠ total`

**Repro (RED):** two oracles.
`tests/polaris-independent-facade-adversarial.test.js` → *"paginates relation facts exactly once with
the array-shaped fact stream"* (concatenated per-page relation keys must equal the one-shot set).
`tests/polaris-audit-file-model-paging.test.js` → multiset oracle: every enumerable fact (each array
element, each `relations.explicit`, each `relations.frontier`, and the single `identity` object) must
appear **exactly once** across keyset pages at limits 1/2/3, plus the full-canonical concat. Both RED:
the loop served every non-array section WHOLE on every page (a source comment even called it "served
whole on every page"), so relations/identity duplicated across pages, and their `factCount` counted in
`total` but never in `consumed` → `returned < total`.

**Root cause (`file.ts` paging loop):** `if (r.status==='unavailable' || !Array.isArray(facts)) { paged.push(r); }`
lumped object-shaped enumerable sections in with typed-unavailable ones and re-emitted them on every page.

**Fix (plan Decision 24 line 272 — *"following valid cursors to exhaustion yields each canonical fact
exactly once"*; direction — *"object-shaped sections get one stable cursor position (no replay);
returned/total reconcile"*):** object-shaped enumerable sections (`identity`, `relations`) now occupy
**one atomic cursor position** in the canonical stream — the same shape `locationAt` already uses for its
one-position relation fact (`location.ts:313`). Emitted WHOLE on exactly the page whose window reaches
that position and has budget; present-but-empty otherwise (`relations` → `{explicit:[],frontier:[]}`,
`identity` → `facts:null`). On emission the section adds its full `factCount` to `consumed`, so summed
`returned` reconciles with `total`. `FileSectionResult` identity becomes
`facts: FileIdentityFacts | null` (null means *"not on this page"*, never *unavailable*).

**GREEN:** facade oracle + all nine audit cases pass; the negative control ("limit > total → single
exhausted page") still passes.

**PROPOSED AMENDMENT:** `{ section:'identity'; …; facts: FileIdentityFacts | null }` in the public
`FileSectionResult` union (relations already tolerates empty facts). All existing readers take identity
from a one-shot/first page where it is non-null; the compile guarantees the union documents the
"empty page" state explicitly.

**Ranked alternatives:**
1. *(implemented)* atomic object-section position — matches the finding's exact wording and the existing
   `locationAt` house pattern; robust (no cross-page ordering coupling), reconciles `returned`/`total`.
2. *Per-relation position* — make each `explicit`/`frontier` a paged element (canonical Decision‑26
   order). More granular, but forces the composer's emission order to match the facade oracle's incidental
   sort (fragile frontier-order coupling) and still needs a nullable identity; rejected as higher-risk for
   equal contract value.
3. *Serve identity/coverage as always-present metadata excluded from the fact stream* — rejected: the audit
   oracle counts `identity` as a canonical fact requiring exactly-once, so it must page, not replay.

---

## A7 — v4 fact-ledger projection was lossy

**Repro (RED):** `tests/polaris-resolution5-a7-fact-projection.test.js` (new). Independent oracle is raw
SQL over the real persisted rows (never the composer); fields the TS extractor cannot emit (generics
text, parent name, a declared visibility, an unmatched binding) are seeded exactly as the shipped
file-floor audit seeds its injection. Under original code the projections dropped: scope
`parameters`/`locals`; injection `hostLanguage` + byte offsets; structure
`decorators`/`generics`/`parentKind`/`parentName`; occurrence `visibility`; orphan structures
(`structureFactOf` returned `null`); import bindings matching no statement; and the `import_binding`
coverage domain was never requested/completed.

**Fix (plan §Authoritative fact ledger — *"Every row must have at least one lossless typed projection …
project persisted fields faithfully or type them explicitly unavailable — never silently drop"*):**
- `ScopeFact` gains `parameters`/`locals: ScopeMemberFact[]` (`{name, range}`), parsed from the persisted
  `parameters_json`/`locals_json`.
- `InjectionFact` gains `hostLanguage: string|null` and `byteRange: {startByte,endByte}|null`. Bytes are
  projected as a **separate** field, never folded into `range.precision:'byte'` — `ExactSourceRange`
  requires columns the injection row does not persist, and the plan forbids inventing byte precision.
- `StructureFact` gains `decorators`/`generics`/`parentKind`/`parentName`; `ownerStableKey` becomes
  `string|null`; `structureFactOf` no longer returns `null` — an orphan (owner row absent from the file
  assembly) is surfaced with `ownerStableKey:null` instead of vanishing.
- `OccurrenceFact` gains `visibility: string|null` (the persisted `symbols.visibility`, never inferred).
- `importFactsOf` surfaces unmatched bindings as `origin:'binding_only'` `ImportFact`s (grouped by source
  in canonical order, `importedNames:[]`, range covering only their own binding lines) so
  `import_binding`'s ledger projection (`fileModel.imports[].bindings`) stays lossless while inventing no
  statement. Statement imports carry `origin:'statement'`.
- `SECTION_DOMAIN` → `SECTION_DOMAINS` (`Record<FileSection, NonEmpty<FactDomain>>`); `imports` covers both
  `import` and `import_binding`, and every branch (v4-unavailable / unsupported / assembly-null / present)
  requests and resolves **both**, so the coverage builder never throws on a silently-dropped domain.

**GREEN:** all 8 A7 cases pass; the shipped `polaris-independent-file-floor` raw-SQL oracle and
`polaris-questions-*` still pass (added fields are additive; existing assertions map to fixed shapes).

**PROPOSED AMENDMENT:** the extended `ScopeFact` / `InjectionFact` / `StructureFact` / `OccurrenceFact`
shapes, the nullable `StructureFact.ownerStableKey`, the `ImportFact.origin` discriminant, and the
multi-domain section→domain map.

**Ranked alternatives:**
1. *(implemented)* faithful structured projection of every persisted field; orphans/unmatched surfaced
   explicitly; bytes as a discrete field.
2. *Type the hard cases "unavailable"* (e.g. leave generics/byteRange off, add coverage issues) — permitted
   by the direction but strictly less useful; rejected under Rule 13 (most robust wins) since the data is
   present and projectable.
3. *Upgrade injection `range` to `precision:'byte'`* — rejected: would fabricate the columns
   `ExactSourceRange` demands (the plan explicitly forbids inventing byte offsets from line spans).

---

## A15 — frontier candidate identity / ancestry / ordering

**Repro (RED):** `tests/polaris-resolution5-a15-frontier-identity.test.js` (new). Legacy-heuristic callee
edges are seeded directly (independent of the indexer's own resolution). Oracles: a candidate's stable
handle key must equal the target's **own** declaration fact key taken from `target.ts`'s `fileModel`
declarations; a nested target's `parentChain` must equal the target's real owner fact key; two candidates
seeded in path-reversed insertion order must return in canonical (path) order. Under original code all
three fail — `locateTarget` fabricated `sourceHash:'legacy'`, hardcoded family `'declaration'`, set
`parentChain:[]`, and returned candidates in `Set` insertion order.

**Fix (plan Decision 24 line 272 exactly-once identity + Decision 26 candidate order; direction — *"real
source hash, computed ancestors, comparator-sorted sets"*):**
- `readV4ParentAncestry` now also returns each row's file `hash` (`LEFT JOIN files`, so a hashless row stays
  visible) and its def/ref `role` (the same `CASE WHEN kind='def' … 'ref' …` mapping the bundle uses).
  `files.path` is `PRIMARY KEY`, so the join cannot multiply rows.
- `locateTarget` mints the target's **real** persisted fact key with the identical inputs
  `assembleSymbol` uses (scope key, scope-relative path, real source hash, real role, occurrence key,
  range, kind, name), guarding every identity input for `null` and returning `null` (candidate not a
  resolvable fact) if any is missing — never a fabricated hash and never a SQLite id across the facade.
- `parentChain` is the computed innermost-first ancestor fact keys.
- Candidate sets are sorted with the shared `compareCandidates` engine (Rule 17 — reuse the real engine),
  which for same-grade heuristic candidates resolves to `(sameFile desc, path, line, column, stableKey)`.

**GREEN:** all 3 A15 cases pass; the key-equality oracle proves the candidate handle is byte-identical to
the target's own declaration fact key.

**PROPOSED AMENDMENT:** none of the *public payload field names* change, but the frontier candidate's
`handle.stableKey`, `parentChain`, and candidate ordering are now materially different values (real vs
fabricated). Behavior-changing → escalated.

**Ranked alternatives:**
1. *(implemented)* real hash + real role + computed ancestors + shared comparator.
2. *Restrict candidates to `role='def'`* (skip reference targets) — a reasonable tightening the design
   review raised; not adopted because a heuristic edge that legitimately points at a reference occurrence
   is still a real, faithfully-keyed fact, and dropping it loses information. Offered for the owner.
3. *Sort frontier candidates by a bespoke local comparator* — rejected (Rule 17): the canonical engine
   already exists and must be reused.

---

## A21 — `lastIndexedAt` leaked persistence history through file identity (P2)

**Repro (RED):** `tests/polaris-resolution5-a21-identity-timestamp.test.js` (new). Runtime oracle: the
persisted `files.last_indexed` column *does* hold a real timestamp (anti-vacuity), yet the public
identity fact must expose no such key. Compile-time oracle: a `FileIdentityFacts` literal carrying
`lastIndexedAt` must be rejected (`TS2353/2322`) while the exact public shape compiles clean. Under
original code both fail (`lastIndexedAt` is present).

**Fix (plan §Authoritative fact ledger line 732 — *"Internal row IDs, storage keys, timestamps, raw JSON
encodings … are persistence mechanics rather than public facts and never cross the facade"*):** drop
`lastIndexedAt` from `FileIdentityFacts`, from both identity-composition branches (present and partial),
and from the internal `FileAssembly` (its only consumer). No test or source reads it thereafter
(`grep` confirms).

**GREEN:** both A21 cases pass; full suite unaffected.

**PROPOSED AMENDMENT:** remove `FileIdentityFacts.lastIndexedAt`. Coordinated with A6, which makes the
same section's `facts` nullable — the A21 test also pins that `null` never means *unavailable* and that
the timestamp is absent from the partial branch.

**Ranked alternatives:**
1. *(implemented)* remove the field entirely — the ledger is unambiguous that timestamps are not public.
2. *Keep it but document it as advisory* — rejected: directly contradicts line 732.

---

## Summary

All five findings build (`pnpm build` green), each pinning test flips **RED → GREEN**, and the full
`zenith-mcp` suite shows **no regressions** (only pre-existing other-worktree failures remain). Every
change is a **PROPOSED AMENDMENT pending owner approval**; nothing here is adopted, ruled, or committed.
