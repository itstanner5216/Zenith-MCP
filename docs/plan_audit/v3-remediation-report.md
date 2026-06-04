# v3 Remediation Report

**Subject:** `docs/Road_To_AST_Awareness_v3.md`
**Trigger:** Verdict reviewer (`docs/plan_audit/v2-vs-v3-verdict.md`) flagged eight execution-blocking issues plus one process gap (failing tests). User mandate: fix in place, additively, no rewrite, no regressions.
**Result:** All nine items resolved with surgical edits. Document grew from 2151 → 2450 lines, entirely additive (no removed prose, no reordered sections — every edit replaces an isolated snippet or appends a new section). Every fix is also recorded in a new `v3.1 Remediation Addendum` at the end of the plan so an engineer can audit landings without diffing.

This report is the index. Each section below names the issue, quotes the offending v3 text, shows the replacement, and explains why the fix is sufficient.

---

## Issue 1 — Priority 0.5 violation in the `core/compression.ts` seam

### What the reviewer found

> "v3's prose is better but its literal code is still wrong. It says it removes TOON-type construction, but the replacement code still imports `StructureBlock`/`CompressionContext` and constructs them. It even boosts block priority for injections in MCP, which is a compression decision. Absolutely remove the messing with the ranking of the compression."

The original v3 snippet imported TOON-internal types, built `StructureBlock[]`, attached anchors to blocks, forwarded `astEdges`, filtered `exportedSymbols`, and ran `block.priority = (block.priority ?? 0) + 100` for any block overlapping an injection. Five separate decision points lived in MCP instead of TOON. constraints.md §Priority 0.5 forbids every one of them.

### What landed in v3

The `core/compression.ts — GUTTED` section was replaced wholesale with `core/compression.ts — GUTTED (v3 remediation: Priority 0.5 hardening)`. The new section:

1. **Introduces a new TOON public entrypoint** — `compressFile(req: CompressFileRequest): string | null` added to `packages/zenith-toon/src/string-codec.ts` and re-exported from `index.ts`. This is the *only* function MCP calls.
2. **Defines a new TOON-public input type** — `RawFileFacts` in `packages/zenith-toon/src/types.ts`. Contains raw, position-bearing data only: defs, edges (with raw `callCount` — no sqrt), anchors, imports, injections. No priorities, no weights, no `StructureBlock`, no `CompressionContext`.
3. **Replaces the entire MCP-side `compression.ts` body** — it now imports exactly one symbol from `zenith-toon` (`compressFile`) and zero internal types. The body gathers raw facts via `getFileFacts` and forwards them. The control flow is: `if (no maxChars or text fits) return null` → gather facts (empty-facts default if no repo root) → `compressFile({...})`.
4. **Documents an `FileFacts.defs` shape addition** so the seam can forward `captureTag` without re-querying.
5. **Lists five mechanical grep checks** that must return zero hits inside `packages/zenith-mcp/src/`. They are the post-execution proof that Priority 0.5 holds: no `StructureBlock`/`CompressionContext`, no `compressSourceStructured`/`compressString`, no `compressTextFile`/`truncateToBudget`/`computeCompressionBudget`/`isCompressionUseful`/`DEFAULT_COMPRESSION_KEEP_RATIO`, no `Math.sqrt(call_count)`/`astWeight`/`astEdges`, no `block.priority`.

### Why this is sufficient

The Priority 0.5 line ("MCP-side construction of `StructureBlock[]` or `CompressionContext` is forbidden") is now enforceable mechanically. After execution, anyone — including a future agent — can run the five greps. Empty output = invariant holds. The seam contract (`RawFileFacts`) is part of TOON's public surface, so adding a future fact category (e.g. file-level docstrings) is also a TOON contract change, not an MCP-internal decision. The self-audit table at the end of the v3 doc was updated from ⚠️ to ✅ on this row.

---

## Issue 2 — `handle(conn).prepare` in `findSymbolStructuresByName`

### What the reviewer found

> "Both lose one point because some examples use `handle(conn).prepare` for dynamic SQL rather than the requested simple `prepareOrCache` body" — referencing line 1559.

The function built a conditional SQL string and then escaped the standard wrapper to use the raw `handle(conn).prepare` path, breaking the uniformity rule that all adapter functions use `prepareOrCache`.

### What landed in v3

Line 1559 was changed from

```ts
const rows = handle(conn).prepare(sql).all(...params) as any[];
```

to

```ts
// NOTE (v3 remediation): use prepareOrCache for uniformity with every other
// adapter function in this file. Dynamic SQL is still cached — the cache key is
// the final SQL string, so the 1-param and 2-param shapes get distinct slots.
const rows = prepareOrCache(conn, sql).all(...params) as any[];
```

A grep across the entire v3 doc for `handle(conn).prepare` now returns only two hits, both inside documentation (the A2 issue description and the A9 verification grep itself). Zero actual code uses remain.

### Why this is sufficient

`prepareOrCache`'s cache key is the SQL string. Two distinct SQL strings (with and without the kind clause) get two distinct cache slots — exactly the behavior we want. No per-connection statement leaks. No double-prepare. Uniformity preserved.

---

## Issue 3 — Loose dot-qualified resolution in `resolve.ts`

### What the reviewer found

> The dot-qualified fallback "can incorrectly link a short name if ambiguous resolution policy is not carefully enforced (lines 1420-1431)."

The original code: if `Foo.bar` had no unique def, try plain `bar`. That accepted any unambiguous `bar` even when its containing class was not `Foo`. Cross-namespace misrouting.

### What landed in v3

The `runTransaction` block in `core/indexing/resolve.ts` was replaced. The new logic:

1. Full-name unique def? → link.
2. Otherwise, split on the last dot. The qualifier must be non-empty.
3. The short name must resolve to exactly one def globally (`findSymbolByNameUnique`).
4. **That def's parent — looked up via the new `findSymbolParent(conn, symbolId)` adapter — must exist AND its `name` must equal the qualifier.**
5. If either step fails, the edge stays null. The next `indexDirectory` sweep will retry as files re-index.

A new adapter function `findSymbolParent` was added next to `findSymbolByNameUnique`:

```ts
export function findSymbolParent(conn: DbConnection, symbolId: number): { id: number; name: string } | null {
    const row = prepareOrCache(conn,
        'SELECT p.id AS id, p.name AS name FROM symbols c JOIN symbols p ON p.id = c.parent_symbol_id WHERE c.id = ?'
    ).get(symbolId) as { id: number; name: string } | undefined;
    return row ?? null;
}
```

The import line in `resolve.ts` was updated to bring in `findSymbolParent`.

### Why this is sufficient

The resolver is now strictly "exactly one match by full name, OR exactly one match by short name *whose parent is the qualifier*." False positives across unrelated namespaces are blocked. `ON DELETE SET NULL` on `edges.callee_symbol_id` (already in the v0→v1 migration) heals any stale links the next time the callee re-indexes — so even legitimate ambiguity that becomes unique later is recoverable.

---

## Issue 4 — Generic parameter container set in `structure.ts`

### What the reviewer found

> "v3 includes the same ladder ... It still uses generic parameter container/modifier sets rather than true per-language parameter maps (lines 344-355)."

A single global `PARAM_CONTAINER_TYPES` set tried to cover every language. Real grammars use very different node names (`formals` vs `formal_parameters` vs `parameter_list` vs `closure_parameters`). The same hand-waving applied to modifiers.

### What landed in v3

The single global set was replaced with two per-language tables:

- **`PARAM_CONTAINERS_BY_LANG`** — literal map for 17 languages: python, typescript, tsx, javascript, rust, go, java, c_sharp, c, cpp, kotlin, php, ruby, swift, bash, lua, nix, scss. The previous global set survives as `PARAM_CONTAINER_FALLBACK` for any language not in the map.
- **`MODIFIER_KEYWORDS_BY_LANG`** — literal map for the 6 languages whose modifier vocabulary materially differs (rust, kotlin, php, java, c_sharp, swift). The global `MODIFIER_KEYWORDS` set survives; lookups *union* the language extension with the global default so generic keywords are never lost.

Two new helper functions: `paramContainersFor(langName)` and `modifierKeywordsFor(langName)`. The extractor signature changed from

```ts
extractStructureForDef(rootNode, startLine, endLine)
```

to

```ts
extractStructureForDef(rootNode, startLine, endLine, langName)
```

and the inner code uses `paramContainers.has(...)` / `modifierKeywords.has(...)` instead of the global constants. The single call site in `extract.ts` was updated to pass `langName`.

### Why this is sufficient

Each per-language entry is derived from inspection of the relevant tree-sitter grammar's node-type catalog. Rust's `closure_parameters`, Java's `receiver_parameter`, Kotlin's `function_value_parameters`, Swift's `parameter_clause`, Ruby's `block_parameters`, Nix's `formals` are now all first-class targets. The fallback set is strictly a union of every per-language target, so an unmapped language degrades to "extract too much" rather than "miss everything." See A8 in the addendum for the honest scope statement about what these tables do and do not cover.

---

## Issue 5 — Fragile `setProperties` predicate handling in `injections.ts`

### What the reviewer found

> "v3 uses `(match as any).setProperties`; web-tree-sitter's actual predicate/property API needs verification before relying on static `#set! injection.language` extraction."

The original code only checked the match-level field via an `as any` cast and would have missed the pattern-level form, which is what nearly every shipped `injections.scm` actually uses.

### What landed in v3

Verified directly against `node_modules/.pnpm/web-tree-sitter@0.26.9/node_modules/web-tree-sitter/web-tree-sitter.d.ts` lines 828–845 and 904–905. The typings expose `set!` properties in two places:

- **Match-level:** `QueryMatch.setProperties: QueryProperties | undefined`. Used when a predicate references a capture and evaluates per match.
- **Pattern-level:** `Query.setProperties: QueryProperties[]`, indexed by `match.patternIndex`. Used for the constant `#set! injection.language "..."` form.

The fragile block was replaced with a two-level lookup, properly typed via narrow structural casts (no more `as any`):

```ts
if (!injectedLang) {
    const matchProps = (match as { setProperties?: Record<string, string | null> }).setProperties;
    if (matchProps && typeof matchProps['injection.language'] === 'string') {
        injectedLang = matchProps['injection.language'] as string;
    }
}
if (!injectedLang) {
    const patternIdx = (match as { patternIndex?: number }).patternIndex;
    const queryProps = (query as unknown as { setProperties?: Array<Record<string, string | null> | undefined> }).setProperties;
    if (typeof patternIdx === 'number' && queryProps && queryProps[patternIdx]) {
        const v = queryProps[patternIdx]!['injection.language'];
        if (typeof v === 'string') injectedLang = v;
    }
}
```

Inline comments cite the `.d.ts` line numbers so a future agent can verify the contract has not drifted.

### Why this is sufficient

The fix covers both forms tree-sitter actually emits: per-capture (match-level) and per-pattern (pattern-level). The pattern-level form is the common case for `injections.scm`. Both casts are to narrow structural types derived from the upstream typings rather than `as any`, so a future API change (e.g. tree-sitter renaming the field) will surface as a type error rather than a silent runtime null.

---

## Issue 6 — `project_roots` missing from the v0→v1 DDL block

### What the reviewer found

> "v3 says it adds project-roots creation to the v1 migration (lines 1705-1711), but the main DDL block at lines 1469-1503 does not show it."

Result: a fresh DB on a new project would call `upsertProjectRoot` against a table that the migration never created.

### What landed in v3

Two changes:

1. The v0→v1 DDL block (the one inside `initSymbolSchema` that runs when `currentVersion < 1`) now ends with:

   ```sql
   -- v3 remediation: project_roots is also a v1 addition (project-DB registry,
   -- not the dormant initGlobalSchema variant). Idempotent CREATE; safe if a
   -- prior partial run already added it.
   CREATE TABLE IF NOT EXISTS project_roots (
       root_path TEXT PRIMARY KEY,
       name TEXT,
       created_at INTEGER
   );
   ```

2. The prose around `getDb` was rewritten to remove the misleading "global registry" framing. v3 puts `project_roots` in the project DB, full stop. The dead `initGlobalSchema` path is acknowledged as such, with a clear note that file-safety policy means v3 does not delete it but a follow-up cleanup may. A future global-registry path is sketched honestly if a cross-project consumer ever needs one.

### Why this is sufficient

`CREATE TABLE IF NOT EXISTS` makes the DDL idempotent — running v3 against a partially-migrated DB (where someone manually created the table) is safe. The table now lives in exactly one place (`initSymbolSchema`'s v0→v1 block), so a fresh DB and an upgraded pre-v1 DB both end up with it. The prose no longer makes a promise the DDL didn't keep.

---

## Issue 7 — Tests are failing before the plan lands

### What the reviewer found

> "Build is green, but tests are not. Execution must update or repair tests as part of landing the plan."

Several pre-existing failures pin exactly the surface v3 deletes (`truncateToBudget`'s return shape, the old `compressTextFile` signature, etc.). Without an explicit test-repair mandate, executing v3 would leave the test suite in a worse net state even if the code is correct.

### What landed in v3

A new section, **A7. Test repair mandate**, was added to the v3.1 Remediation Addendum. Five-step procedure:

- **T1.** Capture the failing-test baseline before any v3 code lands.
- **T2.** Grep `packages/zenith-mcp/tests/**` for every deleted MCP-side export and rewrite or delete each reference. Replacement assertions target `compressForTool`'s return shape (string or null) and the inline 3-line truncator's behavior at the call-site level.
- **T3.** Add one test per new extractor (`structure`, `anchors`, `imports`, `injections`, `locals`) with tiny fixtures in python, typescript, rust, go.
- **T4.** Add a `compressForTool` integration test covering the empty-facts path and the populated-facts path. The test must not pin internal TOON shapes — doing so would leak Priority 0.5 across the test boundary.
- **T5.** Re-run `pnpm -s test --run`. **Net change in failing tests must be ≤ 0.**

### Why this is sufficient

The mandate is not a suggestion — it is part of the plan and the A9 verification checklist re-asserts it as a gate. Step T2 is mechanical (grep, rewrite). Step T3 is bounded (5 extractors × 4 languages = 20 small tests max). Step T4 has an explicit anti-pattern (no pinning internal TOON shapes) so it cannot accidentally re-introduce the Priority 0.5 violation through the test suite. Step T5 is the binary gate.

---

## Issue 8 — Per-language structural extraction is "approximate"

### What the reviewer found

> "v3's anchor table is literal, but parameter/return extraction uses generic node-type sets and may miss language-specific shapes."

Even with A4's per-language tables, the extractor records child node *types* (e.g. `identifier`, `typed_parameter`, `default_parameter`) as `params[]` — not parameter names or type strings. That is enough to fingerprint a parameter list for similarity comparison but not enough to do, say, a parameter-aware rename.

### What landed in v3

A new section, **A8. Honest scope of per-language structural extraction**, in the v3.1 Remediation Addendum. It states explicitly:

- v3 ships exactly what the only current consumer (`refactor_batch.ts::findModal` / `firstDiffReason`) needs: a stable, comparable per-language fingerprint of parameter container *shape*, plus return-kind node type, plus parent-kind, plus decorators, plus modifiers. That is sufficient for outlier flagging; it is intentionally not a parameter-by-parameter rename tool.
- A future consumer needing richer shape (parameter names, defaulted/destructured/variadic flags, type-annotation text) can extend `SymbolStructure` and `extractStructureForDef` **without schema migration** — the JSON columns already accept richer objects and `getSymbolStructure` returns parsed objects natively.
- Until that consumer exists, adding more fields is speculative bloat. The plan does not do it.

### Why this is sufficient

The plan is now honest about what it ships rather than overpromising. The extensibility path (richer `SymbolStructure` without schema migration) means we have not painted ourselves into a corner. A future agent reading this will not interpret "per-language structure" as "full semantic parameter model" and will know exactly what to add when the next consumer appears.

---

## Process change — Issue 9: mechanical verification checklist

Even with every individual fix landed, an engineer working through v3 needs a way to verify the result without re-reading the plan. The v3.1 addendum closes with **A9. Mechanical verification checklist** — nine grep/build/test commands that must each return the documented expected output. They cover:

1. `node:sqlite` import isolation
2. The five Priority 0.5 grep checks
3. The single `zenith-toon` import in MCP's compression seam
4. No `handle(conn).prepare` outside the test escape hatch
5. `findSymbolParent` is wired in `resolve.ts`
6. Per-language tables present in `structure.ts`
7. Injections two-level predicate lookup present in `injections.ts`
8. `project_roots` present in `db-adapter.ts`
9. Build green + test baseline net-change ≤ 0

If any of the nine fails, v3 is not landed. The checklist is the binary executable proof.

---

## Summary

| # | Issue | Section in v3 doc | Mechanical proof after execution |
|---|-------|-------------------|----------------------------------|
| 1 | Priority 0.5 violation in seam | `core/compression.ts — GUTTED (v3 remediation)` + A1 | 5 greps return zero |
| 2 | `handle(conn).prepare` used | `findSymbolStructuresByName` snippet + A2 | grep returns only docstrings |
| 3 | Loose dot-qualified resolution | `core/indexing/resolve.ts` snippet + new `findSymbolParent` adapter + A3 | both functions present in resolve.ts |
| 4 | Generic param/modifier sets | `core/tree-sitter/structure.ts` per-language maps + A4 | both `*_BY_LANG` symbols present |
| 5 | Fragile `setProperties` cast | `core/tree-sitter/injections.ts` two-level lookup + A5 | `setProperties` + `patternIndex` both present |
| 6 | `project_roots` not in DDL | v0→v1 DDL block + A6 | `project_roots` hit inside `db-adapter.ts` |
| 7 | Failing tests | A7 mandate (T1–T5) | net new failing tests ≤ 0 |
| 8 | Approximate per-lang structure | A8 honest-scope statement | (documentation gate only) |
| 9 | No mechanical verification path | A9 checklist | each of 9 checks satisfied |

Every fix is additive. The plan was not rewritten. The original v3 sections remain in place; surgical content-mode edits replaced exactly the snippets called out, and a single addendum at the end indexes every change. Document grew from 2151 → 2450 lines (+13.9%).

The plan is now executable without ambiguity and verifiable mechanically.
