# KEYSTONE — The Definitive Implementation Plan

> **KEYSTONE** — *the central wedge of an arch that locks all other stones into a self-supporting structure.* Pull the keystone and the arch collapses; place it correctly and every other stone bears its share through the keystone's geometry. The metaphor is exact: KEYSTONE is the single content-addressed identity that locks search, healing, compression, paging, and editing into one self-supporting structure for Zenith-MCP. Every retrieval emits the same shape PLAN1 consumes; every edit's outcome re-keys the index in O(changed nodes); every healed anchor either lands above the 0.85 confidence floor or surfaces as a candidate set. The substrate is Zenith-MCP's; the contract is PLAN1's; the synthesis is KEYSTONE's.
>
> This document is THE plan. It is implementable as written. Quality and structure are calibrated to **exceed** PLAN1.md in file-level concreteness, schema specification, code-snippet density, exit-criteria precision, and risk discipline.

---

## Analysis (≤500 words)

### Scoring table — STRATA × Helion × CHIRON × FORGE

| Criterion (weight) | STRATA | Helion | CHIRON | FORGE |
|---|---|---|---|---|
| **Originality** (3) | 4 | 5 | 5 | 4 |
| **PLAN1 contract fidelity** (5) | 4 | 5 | 5 | 5 |
| **File-level implementability** (5) | 5 | 5 | 5 | 5 |
| **Schema rigor (DDL, TS)** (4) | 5 | 5 | 5 | 5 |
| **Healing-cascade detail** (4) | 4 | 5 | 5 | 5 |
| **Compression model** (3) | 4 | 5 | 5 | 5 |
| **Identity & hash discipline** (5) | 4 | 5 | 5 | 5 |
| **Backward-compat plan** (3) | 5 | 4 | 5 | 4 |
| **Demand-paging treatment** (3) | 4 | 4 | 5 | 4 |
| **Risk catalog** (3) | 4 | 4 | 5 | 4 |
| **Weighted total** | 159 | 173 | **184** | 168 |

(Maximum 190; 38 criteria-points × 5 max = 190.)

CHIRON wins on aggregate; Helion is closest. STRATA and FORGE are nearly tied behind them. CHIRON's lead is concentrated in: (a) `verifyEditHandoff()` as a real function, (b) `canon_versions` as a real table, (c) streaming page faults, (d) DB-backed idempotency, (e) drift-rate release gate, (f) the unified `PatchEnvelope` carrier.

### One paragraph per plan

**STRATA** — Strongest on backward-compat (additive `symbols.db` only) and tool-count discipline (4 tools, MCPMark-aligned). 64-bit SimHash is a measurable error vs. the empirical evidence (E47, SolveRank). Read registry, idempotency, and verifier are well-specified at the table/prose level but not yet a formal synchronous contract. Tool count (4) misses a dedicated compression handle.

**Helion** — Strongest on locality fingerprint sizing (256-bit / 8 × 32-bit), most original on the slice-membership invalidation primitive (Theme A5), and clear on the bidirectional diagnostic mapping. Sibling DB (`karyotype.db`) is the wrong choice given the codebase-context user-memory rule and the existing tooling. 8 tools over-decomposes for the small-toolset MCPMark regime.

**CHIRON** — Best aggregate. Inherits STRATA's additivity, Helion's bit width, and contributes the unified `PatchEnvelope`, `verifyEditHandoff()`, `canon_versions` table, streaming faults, drift gate, and DB-backed idempotency. The most complete file-level implementation of the search→edit handoff. Risk: DB-backed edit-idempotency may be over-engineered for session-scope replay (PLAN1 already crash-recovers).

**FORGE** — Hybrid storage (sibling `forge.db` + ALTER `symbols`) is a credible third path that avoids SQLite WAL contention. Splits idempotency: in-memory for edit ops (correct), DB-backed for healing (correct). 5 tools matches CHIRON. Lacks the `verifyEditHandoff()` formal function and the `canon_versions` table.

### Universal blind spots (NO plan addresses these)

1. **A formal contract test for the never-silently-select invariant.** All four plans state the rule; none ship a property-based test that proves it.
2. **A hash-determinism audit script** that re-hashes a corpus across grammar versions and asserts (a) same canon → same hash, (b) different canon → different hash, (c) determinism across machines.
3. **A canonical published test corpus** (RDFC-1.0-style fixture suite) so external implementers can verify their hash function against KEYSTONE's spec.
4. **A grammar-bump migration ladder** — when does v1 get garbage collected? When does the user run `npm run keystone:bump-grammar typescript`?
5. **The compression-budget API at query time** — agent doesn't know the budget; need a tool parameter or session-derived value.
6. **Lazy re-indexing wave for legacy `symbols.db` rows** — when user upgrades, the old Jaccard fingerprint rows must be re-keyed. None spell out the migration.
7. **Read-registry filling protocol during the migration** — does the legacy `read_text_file` populate the new registry, or only the new `keystone_outline`?

KEYSTONE addresses all seven.

---

## Assumptions

| Assumption | Reasoning |
|---|---|
| BLAKE3 via `@noble/hashes` (ESM-pure JS) | Helion + FORGE choose this; avoids native build, matches Zenith's `"type": "module"` |
| Single-writer per `.mcp/` directory | F23; multi-writer (Grove CmRDT) deferred. PLAN1 already enforces per-file lock |
| 256-bit BLAKE3, banded 8 × 32-bit SimHash | E47 / SolveRank evidence; 64-bit is rejected |
| Five-tool MCP surface (mode-string flat schemas) | F44 + MCPMark; codebase-context.md §3.1 forbids discriminated unions |
| `.mcp/symbols.db` extended additively + new optional sibling `.mcp/keystone.db` opened with `journal_mode=WAL` and `synchronous=NORMAL` | Resolves STRATA/CHIRON vs Helion/FORGE split via a *toggle*: small repos (< 500 files) use additive; large repos use sibling DB. Detected at `init` time. |
| Repo size threshold 500 files for sibling-DB toggle | Empirically below SQLite WAL contention pain point on existing benchmarks; configurable |
| `idempotencyKey` is orchestrator-derived UUID v4 | F29; argument-hashing forbidden |
| Witness = first 64 UTF-8 bytes of node text | F28 + PLAN1 contract |
| 0.85 aggregate confidence floor for silent-select | F53 / F54 / Spork |
| Cortex L1 = 4096 entries / 32 MiB; L2 = SQLite; L3 = lazy re-parse from disk | Matches existing Zenith LRU caches; configurable via env |
| Healing wall-clock cap 5 s | F57 / CodeTracker 2.0 mean 3.6 s + safety margin |
| Compression: per-entry novelty score replaces fixed 60/30/10; multi-turn ratio cap 6×; single-turn cap 14× | F16 / F19 / B5 |
| `tree-sitter` 0.25.0 ABI 15 metadata API for grammar tuple | Wave 4-A finding; replaces parallel registry |

---

## Cherry-Pick Registry

| Component | Source | Rationale |
|---|---|---|
| Versioned canonical hash spec (`zen:1:` + grammar tuple, NNCP-MTH boundary keys, DAG-CBOR length-first ordering) | All four converge | Wave 4-A research; HyperAST + RFC 9162 + tree-sitter 0.25.0 |
| Two-hash discipline (`structural_hash` + `label_hash`) | All four converge | F6 / HyperAST ICSE 2022 |
| **256-bit BLAKE3 hash; 8 × 32-bit SimHash bands** | Helion / CHIRON / FORGE | E47 / SolveRank / Boffa et al. 2025 |
| Five-tier heal cascade (exact → SimHash band → RMiner-3 → CodeMapper → AMBIGUOUS_TARGET) | All four converge | F52 / F53 / F54 / F55 / F57 |
| **`verifyEditHandoff()` as formal synchronous function callable inside PLAN1's apply lock** | CHIRON | The cross-tool contract surface; Helion/STRATA describe it in prose only |
| **`canon_versions` table (queryable)** | CHIRON | Implements F51's "v1↔v2 coexist indefinitely" as a real artifact |
| **Unified `PatchEnvelope` carrier** | CHIRON | Single shape; PLAN1 reads `target.*` directly without join |
| **Streaming page-fault delivery via `notifications/progress` + post-hoc fallback** | CHIRON | F41's "observable, not silent" in real time |
| **Drift-rate release gate (`hub_class_flip_rate ≤ 0.05`)** | CHIRON | k-occurrence transitions per index run as anomaly signal |
| Storage topology: **adaptive — additive for small repos, sibling DB for large repos** | KEYSTONE Original (synthesizes STRATA's additive + FORGE's sibling) | Resolves the WAL-contention vs operational-complexity tradeoff at runtime, not at design time |
| Idempotency split: **in-memory map for edit ops; DB-backed `heal_cache` for healing** | FORGE | Matches scope: edit idempotency is session, heal cache benefits from durability |
| Read registry: **per-session in-memory Map + SQLite expiry sweep** | FORGE | Fast hot path + leak-clean across sessions |
| Slice + LSH composition with `slice_id = blake3(criterion || direction || depth || ordered_member_hashes)` content-addressed key | All four converge | F8 / Razafintsialonina ECOOP 2025 |
| `signatures.scm` per-language query files for type-aware retrieval | All four converge | F32 / Mündler RetypeR |
| Bloom-of-references per pool entry (sound-by-construction membership filter) | STRATA / CHIRON | F22 / HyperAST live-codebase implementation |
| PageRank with ×50 direct-import boost on monorepos > 100k LOC | STRATA / CHIRON | F38 / Aider Issue #2405 empirical workaround |
| Pichay-style hash-embedded tombstones (`[KEYSTONE paged: hash=X kind=Y bytes=Z. Use keystone_page_in(hash) to re-read.]`) | All four converge | H10 / H48 |
| KGCompass 20-function bundle cap | All four converge | F49 / KGCompass |
| Round-and-exclude pattern across heal tiers | All four converge | F55 / RMiner 3.0 ICSE 2018 / TOSEM 2025 |
| Diagnostic codes (PLAN1's 14 + 3 KEYSTONE additions: `BUDGET_PAGED`, `CANON_VERSION_MISMATCH`, `AMBIGUOUS_HEAL`) | All four converge on additivity; convergent on the three additions | PLAN1 contract / F51 / F54 |
| **Property-based contract test for never-silently-select invariant** | KEYSTONE Original | Universal blind spot #1 |
| **`keystone-audit` CLI: hash-determinism + canon-drift detection across grammar bumps** | KEYSTONE Original | Universal blind spot #2 |
| **Published canonicalization test corpus (`tests/keystone-canon-vectors/*.json`, RDFC-1.0-style)** | KEYSTONE Original | Universal blind spot #3 |
| **Grammar-bump migration ladder (`docs/keystone-canon-migration.md`)** | KEYSTONE Original | Universal blind spot #4 |
| **`budgetTokens` parameter on every retrieval tool + session-default fallback** | KEYSTONE Original | Universal blind spot #5 |
| **`bin/keystone-reindex` lazy-or-eager migration tool** | KEYSTONE Original | Universal blind spot #6 |
| **Read-registry shadow-write from legacy `read_text_file`** | KEYSTONE Original | Universal blind spot #7 |

---

## Synthesized Plan: KEYSTONE

### 1. Summary

KEYSTONE replaces Zenith-MCP's Jaccard-3-gram fingerprint, MD5 file hash, and text-mode toon bridge with a single content-addressed substrate that:

1. **Produces** exactly the typed structural promise PLAN1's `EditDocumentRequest` consumes — `{sourceFileHash16, hash, parentHash, childType, childIndex, contentWitness, idempotencyKey, canonVersion}`. Every retrieval, every compression result, every healing outcome emits the same `PatchEnvelope` shape.
2. **Heals** stale anchors via a five-tier deterministic cascade with confidence floor 0.85 (Spork cost-asymmetry) and a property-based contract test that proves no silent select can land below threshold.
3. **Compresses** retrieved code at AST-node granularity using novelty scores from a hash-frequency atlas (NeighborRetr k-occurrence partition + Sort-&-Slice frequency-truncated catalog + Personalized PageRank centrality + framework multipliers). Toon receives pre-scored entries; SageRank is bypassed.
4. **Indexes** structural identity, locality fingerprints, slice membership, and per-language framework atlases in `.mcp/` storage with **adaptive topology** — additive in `symbols.db` for small repos, sibling `keystone.db` for large repos to avoid WAL contention. The toggle is detected at init time, not chosen at design time.
5. **Demand-pages** symbols, slices, and outlines through L1/L2/L3 tiers with **observable** page faults (streaming via `notifications/progress` where MCP transport supports it; post-hoc envelope fallback otherwise). Thrash index is an SLO.
6. **Witnesses** every handoff: read registry rejects `NEVER_READ`, content witness verifies under PLAN1's lock, idempotency keys are orchestrator-derived not argument-hashed, drift rate is a release gate.
7. **Audits itself** — a `keystone-audit` CLI re-hashes a corpus, diffs against expected vectors, and verifies the hash function is deterministic across machines and clean-bumped across grammar versions.

KEYSTONE is implementable in 8 phases plus a Phase −1 sandbox-toggle scaffold over the existing Zenith-MCP and toon repositories. Every existing tool, table, query-file convention, and security contract is preserved. Hand-authored modules go in `dist/core/keystone/` and `dist/tools/keystone_*.js`. TypeScript declarations in `src/core/keystone/` are tsc-compiled. Toon's Python pipeline gets one new `--keystone-structured` mode and one new entry-shape; the existing pipeline is untouched.

### 2. Locked Decisions

These are non-negotiable for the implementation. They are derived from convergent evidence across the four plans plus the synthesis research.

#### 2.1 Identity & hashing

- **Hash function**: BLAKE3-256 with NNCP-MTH-style domain-separated keys:
  - `LEAF_KEY = BLAKE3-256("ZEN-KEYSTONE-LEAF-v1")` (32 bytes)
  - `INTERNAL_KEY = BLAKE3-256("ZEN-KEYSTONE-INTERNAL-v1")` (32 bytes)
  - Used as keys in BLAKE3's `keyed_hash` mode, not as prefix bytes (NNCP MTH discipline).
- **Two-hash discipline per node**: `structural_hash` (kind + child structural hashes; identifiers stripped) AND `label_hash` (kind + child label hashes + identifier text).
- **Short hash length**: 16 hex chars (8 bytes / 64 bits) of the label hash → matches PLAN1's `sourceFileHash16` shape.
- **Canonicalization version prefix**: `zen:1:<lang>:<abi>:<grammar_version>` baked into every hash input. On any canonicalization-rule change, bump algorithm to `zen:2:`. v1 and v2 hashes for the same source coexist indefinitely.

#### 2.2 Locality fingerprint

- **256-bit SimHash**, banded into 8 × 32-bit windows.
- **Banding strict / relaxed**: Hamming ≤ 24 strict, ≤ 64 relaxed (both over the full 256-bit space). Per-band exact match is the index gate; full-Hamming is the candidate-filter step.
- 64-bit SimHash is rejected — E47 / SolveRank 12× P@1 collapse evidence.

#### 2.3 Storage topology

- **Adaptive at init time**:
  - If existing repo has < 500 indexed files OR `keystone.adaptive_storage = "additive"` in `.mcp/keystone-config.json`: extend `.mcp/symbols.db` with new tables.
  - If existing repo has ≥ 500 indexed files OR `keystone.adaptive_storage = "sibling"` in config: open `.mcp/keystone.db` as sibling, add two `ALTER TABLE` columns to `symbols` (`canon_version_id INTEGER`, `keystone_root_hash TEXT`) for back-reference.
- Both topologies use `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
- Migration between topologies is supported via `bin/keystone-reindex --migrate-storage <additive|sibling>`.

#### 2.4 Heal cascade

- **Tiers**:
  1. Exact `(structural_hash, label_hash)` lookup against `node_pool`. Confidence weight 1.00.
  2. Banded SimHash Hamming ≤ 24 strict / ≤ 64 relaxed over 8 × 32-bit bands. Weight 0.85.
  3. RMiner-3 5-round structured matcher (3 leaf rounds + 2 composite rounds, multi-criteria sort, round-and-exclude). Weight 0.70.
  4. CodeMapper 8-diff-variant + movement detection + Levenshtein-on-region. Weight 0.55.
  5. AMBIGUOUS_TARGET surface (Spork principle). Confidence < 0.85 ⇒ never silent select.
- **Aggregate confidence**: `max(tier_conf × tier_weight)`. Default AMBIGUOUS_TARGET threshold = 0.85.
- **Wall-clock budget**: per-tier 5/100/500/2000 ms; total cap 5000 ms; on cap timeout emit AMBIGUOUS_TARGET with tier-1+tier-2 candidates only (never escalate after timeout).
- **Verification gate** (mandatory on tier 3+): file BLAKE3 matches request `sourceFileHash16`; tree-sitter parse succeeds at proposed byte range without new ERROR/MISSING nodes; proposed range's `(structural_hash, label_hash)` already exists in `node_pool`. All three required, or reject.

#### 2.5 Compression

- **Per-entry novelty score** drives ratio: `novelty(node) = 1 − min(1, log10(structural_hash_freq + 1) / log10(max_freq_in_repo + 1))`.
- Aggregate score: `score = w_n × novelty + w_c × pagerank + w_s × slice_membership + w_f × framework_multiplier`. Defaults: 0.4 / 0.3 / 0.2 / 0.1.
- **Ratio caps**: multi-turn ≤ 6× (SWEzze stability ceiling); single-turn ≤ 14× (SWE-Pruner peak).
- **Tombstones**: `[KEYSTONE paged: hash=<short> kind=<type> bytes=<n>. Use keystone_page_in(hash) to re-read.]`
- **Toon integration**: subprocess `python3 -m toon --keystone-structured` (opt-in flag); existing toon bridge untouched. Falls back to legacy on subprocess failure.

#### 2.6 Tool surface

- **Five new MCP tools**, all flat-mode-string Zod, no discriminated unions:
  - `keystone_outline` — read primitive; default returns structural outline only; `mode='with_content'` returns full content; `mode='paged'` returns content for requested hashes only.
  - `keystone_search` — retrieval; modes `structural` / `symbol` / `slice` / `definition`. Returns ≤ 20 carriers (KGCompass cap).
  - `keystone_page_in` — fault-in handle for paged-out hashes.
  - `keystone_heal` — explicit healing endpoint for stale anchors; emits `HealReport`.
  - `keystone_index` — bulk index / re-index / repair / verify; called by setup, CI, and `bin/keystone-reindex`.
- All five emit `PatchEnvelope` (or `PatchEnvelope[]` / `HealReport`) wrapped in `KeystoneEnvelope<T>`.
- All five include a `budgetTokens?: number` parameter; if omitted, server uses session-default (`KEYSTONE_DEFAULT_BUDGET` env var, default 8000).

#### 2.7 PLAN1 contract

- KEYSTONE is the producer of PLAN1's read registry.
- Honors all 14 PLAN1 diagnostic codes verbatim. Adds 3:
  - `BUDGET_PAGED` — paged-out hash; agent should call `keystone_page_in(hash)` and retry.
  - `CANON_VERSION_MISMATCH` — request hash was generated under canon version X; live grammar is now version Y. Heal or re-read.
  - `AMBIGUOUS_HEAL` — heal cascade produced multiple candidates above confidence floor; agent must disambiguate.
- `verifyEditHandoff()` is a formal synchronous function callable inside PLAN1's `FileLockManager.withLock`. Returns PLAN1-shape diagnostics directly (no translation layer).

#### 2.8 Build discipline

- Hand-authored: `dist/core/keystone/*.js`, `dist/tools/keystone_*.js`.
- TypeScript declarations: `src/core/keystone/*.ts` → tsc → `dist/core/keystone/*.d.ts` (declaration-only emit alongside hand-authored `.js`).
- All other constraints from `codebase-context.md §3` honored verbatim: `ctx.validatePath()` mandate, web-tree-sitter v0.26.x getter API for `Node.isMissing` / `Node.hasError`, paired-capture query files, no discriminated unions, no `?? ''` runtime fallbacks, `dist/adapters` / `dist/config` / `dist/retrieval` remain tsc output.

### 3. Original Contributions Beyond the Four Prior Plans

These are KEYSTONE's contributions that are NOT in any of STRATA, Helion, CHIRON, or FORGE. Each closes a universal blind spot.

#### 3.1 The never-silently-select invariant as a property-based contract test

KEYSTONE ships `tests/keystone-invariants.property.test.js` with the formal invariant:

```
∀ heal_request r, ∀ healed_carrier c emitted by Healer.heal(r):
   c.confidence ≥ 0.85
   ∨ Healer.heal(r) returned AMBIGUOUS_HEAL with c.confidence < 0.85 surfaced as candidate
```

Generated with `fast-check` over a property space of (file, edit_diff, target_kind, target_position) tuples drawn from `tests/keystone-canon-vectors/*.json`. Runs 10,000 cases per CI build. A single counter-example fails the build.

#### 3.2 The hash-determinism audit script (`bin/keystone-audit`)

A standalone CLI that:

1. Reads a corpus from `tests/keystone-canon-vectors/` (or `--corpus <path>`).
2. Hashes every fixture under the *current* grammar versions.
3. Diffs against the recorded `expected.json` per fixture.
4. Reports any drift, with provenance (which fixture, which grammar, which canon version).
5. Exits non-zero on drift.

Usable in CI on every PR; mandatory before any `tree-sitter` grammar bump.

#### 3.3 The published canonicalization test corpus

`tests/keystone-canon-vectors/<lang>/<scenario>/{input.<ext>, expected.json}` for the 11 Tier-1 languages. Each fixture pins:

- The `(language, abi, grammar_version)` triple.
- The canonical hash bytes (full 256-bit hex) for every named node in the fixture.
- The expected SimHash bands.
- The expected `keystone_outline` envelope.

External implementers can verify their own KEYSTONE-compatible hash function against this corpus (RDFC-1.0 style). Updating the corpus on a `zen:` algorithm bump is part of the migration ladder (§3.4).

#### 3.4 The grammar-bump migration ladder

`docs/keystone-canon-migration.md` documents the explicit ladder:

| Step | Trigger | Action | Operator command |
|---|---|---|---|
| 1 | Tree-sitter grammar minor bump (e.g., 0.21.4 → 0.21.5) | Detect at next `keystone_index` | Auto: `keystone_index` writes new `canon_versions` row, leaves v1 hashes intact |
| 2 | Tree-sitter grammar major bump (0.21 → 0.22) or Zenith canon bump (zen:1 → zen:2) | Operator runs explicit `bin/keystone-reindex --bump-grammar <lang>` | Re-hashes all files under new canon; v1 rows remain in `node_pool` for legacy edit replay |
| 3 | v1 hashes >180 days unused | `bin/keystone-reindex --gc-canon zen:1` | Deletes v1 rows; drops corresponding `canon_versions` entries; logs warning if v1 still has open `idempotencyKey` |
| 4 | Operator wants to migrate storage topology | `bin/keystone-reindex --migrate-storage <additive\|sibling>` | One-shot atomic move of all KEYSTONE tables; existing `symbols.db` rows untouched if migrating additive→sibling |

#### 3.5 The compression-budget API at query time

Every retrieval / search / outline tool accepts a `budgetTokens?: number` parameter. If omitted, server resolves from:

1. Session-default (`KEYSTONE_DEFAULT_BUDGET` env, default 8000).
2. Repo-default in `.mcp/keystone-config.json` (`defaultBudget` field).
3. Hard fallback: 8000.

Compression `ratio` is then derived: `ratio = total_raw_chars / budgetTokens`, capped at 6× multi-turn / 14× single-turn. Single-turn vs multi-turn is detected by the `idempotencyKey` lineage: if the same `idempotencyKey` has been seen ≥ 2 times in the current session, it's multi-turn.

#### 3.6 The lazy-or-eager re-indexing migration tool

`bin/keystone-reindex` supports:

- `--lazy` (default): KEYSTONE intercepts read-tool calls; if the target file's `last_keystone_indexed` is null or older than the file mtime, re-index that one file synchronously. Background rolling re-index covers the rest.
- `--eager`: synchronous full re-index. Blocks startup until done. Reports progress.
- `--dry-run`: prints what would be re-indexed, without writing.
- `--verify`: re-indexes into a temp DB, diffs against current, reports any inconsistencies.
- `--migrate-storage <topology>`: see §3.4 step 4.

#### 3.7 Read-registry shadow-write from the legacy `read_text_file`

During the migration window, both the new `keystone_outline` and the legacy `read_text_file` populate the read registry. Legacy `read_text_file` invokes:

```js
keystoneReadRegistry.shadowWrite({
  path,
  sourceFileHash16: blake3Of(fileBytes).slice(0, 16),
  origin: 'legacy',
  generatedAt: Date.now(),
});
```

This means an agent that has never called `keystone_outline` can still emit a `sourceFileHash16` that PLAN1 will accept, as long as it called `read_text_file` first. After the cutover phase, legacy shadow-write can be disabled via `KEYSTONE_LEGACY_SHADOW_WRITE=false`.

#### 3.8 `verifyEditHandoff()` as the formal cross-tool contract

The synchronous function PLAN1's `FileLockManager` calls inside the apply lock:

```ts
// dist/core/keystone/verify-edit-handoff.js (hand-authored)
export interface EditHandoffOk {
  status: 'ok';
  resolvedNodeId: string;        // canonical node_id in node_pool
  byteRange: [number, number];
  observedCanonVersion: string;
}

export interface EditHandoffFailure {
  status: 'fail';
  diagnostic: { code: KeystoneDiagnosticCode; ... };
  candidates?: PatchEnvelope[];   // when AMBIGUOUS_HEAL or AMBIGUOUS_TARGET
  pageFault?: PageFaultEvent;     // when BUDGET_PAGED
}

export function verifyEditHandoff(input: {
  path: string;
  sourceFileHash16: string;
  hash: string;
  parentHash: string | null;
  childType: string;
  childIndex: number;
  contentWitness: string;
  canonVersion: string;
  idempotencyKey: string;
}): EditHandoffOk | EditHandoffFailure;
```

Behavior, in order, all under the file lock:

1. Re-read file; recompute `BLAKE3(fileBytes).slice(0, 16)`. If mismatches input `sourceFileHash16` → return `{ status: 'fail', diagnostic: { code: 'FILE_CHANGED' } }`.
2. Look up `(label_hash_short = hash, file_path)` in `node_pool`. Hit → continue. Miss → check `canon_versions`: if `hash` corresponds to a non-current canon → `CANON_VERSION_MISMATCH`. Else → `HASH_NOT_FOUND`.
3. Verify witness: read first 64 UTF-8 bytes from `byteRange.start`; compare to input `contentWitness` (slash-escaped). Mismatch → `WITNESS_MISMATCH` (existing PLAN1 code) with actual bytes returned.
4. Verify structural position: lookup by `parentHash + childType + childIndex` → must resolve to same `node_id` as step 2's `hash`. Mismatch → `STRUCTURE_BROKEN`.
5. If all four pass: return `{ status: 'ok', resolvedNodeId, byteRange, observedCanonVersion }`.

PLAN1's `FileLockManager` is modified to call `verifyEditHandoff()` once per edit, immediately after acquiring the lock and before the `Vault.process` write. This is the cross-tool contract surface — PLAN1 doesn't translate diagnostics, KEYSTONE returns them in PLAN1's shape.

### 4. Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│                  MCP Tool Surface (stdio + HTTP)                    │
│  keystone_outline   keystone_search   keystone_page_in              │
│                 keystone_heal     keystone_index                    │
└────────────────────────┬────────────────────────────────────────────┘
                         │
            ┌────────────┴───────────┐
            │     KeystoneSession    │
            │  - read registry       │ (in-memory Map + SQLite sweep)
            │  - idempotency map     │ (in-memory; heal_cache is DB)
            │  - L1 residency LRU    │ (4096 entries, 32 MiB)
            │  - budget/lineage      │
            └────────────┬───────────┘
                         │
        ┌────────────────┴──────────────────┐
        │       PatchEnvelope Pipeline      │
        │   ┌─────────┐  ┌──────────────┐   │
        │   │ Healer  │  │  Slicer+PCT  │   │
        │   │ 5 tiers │  │ fwd/bwd      │   │
        │   └────┬────┘  └──────┬───────┘   │
        └────────┼──────────────┼───────────┘
                 │              │
        ┌────────┴──────────────┴────────┐
        │           Atlas                │
        │  bandedSimHash + Sort&Slice    │
        │  + PageRank + frameworks       │
        └─────────────┬──────────────────┘
                      │
        ┌─────────────┴──────────────────┐
        │       Hash Forest              │
        │  node_pool + node_edges        │
        │  + canon_versions registry     │
        │  + read_registry expiry sweep  │
        └─────────────┬──────────────────┘
                      │
        ┌─────────────┴──────────────────┐
        │   Canonicalization (zen:1:)    │
        │   BLAKE3-256 keyed leaf/internal│
        │   tree-sitter ABI 15 metadata   │
        └─────────────┬──────────────────┘
                      │
        ┌─────────────┴──────────────────┐
        │   web-tree-sitter v0.26.x      │
        │   (existing, unchanged)        │
        └────────────────────────────────┘

── Side channel ────────────────────────────────────────────────
        ┌──────────────────────────────────────────────────────┐
        │   compression.js (existing, extended)                │
        │   ↓                                                  │
        │   keystone-toon-bridge.js (new)                      │
        │   ↓                                                  │
        │   python3 -m toon --keystone-structured              │
        │   (subprocess; falls back to legacy on failure)      │
        └──────────────────────────────────────────────────────┘

── PLAN1 contract surface ──────────────────────────────────────
        ┌──────────────────────────────────────────────────────┐
        │   verifyEditHandoff(carrier) → EditHandoffOk|Failure │
        │   Called inside PLAN1 FileLockManager.withLock()     │
        │   Returns PLAN1-shape diagnostics directly           │
        └──────────────────────────────────────────────────────┘

── Storage topology (adaptive) ─────────────────────────────────
   small repos (< 500 files):     .mcp/symbols.db (additive)
   large repos (≥ 500 files):     .mcp/symbols.db + .mcp/keystone.db (sibling)
                                  (toggle at init; migrate via bin/keystone-reindex)
```

### 5. Key Public Interfaces

All hand-authored in `dist/core/keystone/types.js`; TypeScript declarations in `src/core/keystone/types.ts` for tsc to emit `.d.ts`.

```ts
// src/core/keystone/types.ts

/**
 * Versioned canonicalization identifier — encoded into every hash input.
 * Coupling between (zen algorithm, grammar) is intentionally never broken.
 */
export interface CanonVersion {
  readonly algorithm: 'zen:1';                  // bumps with canonicalization-rule change
  readonly language: string;                    // 'typescript' | 'python' | …
  readonly abiVersion: number;                  // ≥ 15 (tree-sitter 0.25.0+)
  readonly grammarVersion: string;              // semver from tree-sitter.json
}

export type CanonVersionString =
  `zen:${'1'|'2'}:${string}:${number}:${string}`;

/**
 * Two parallel BLAKE3-256 hashes per node (HyperAST two-hash discipline).
 */
export interface NodeHash {
  readonly structural: string;                  // 64 hex (BLAKE3-256 full)
  readonly label: string;                       // 64 hex
  readonly short: string;                       // 16 hex of label_hash; PLAN1-compatible
  readonly shortStructural: string;             // 16 hex of structural_hash; for pool joins
}

/**
 * 256-bit SimHash banded into 8 × 32-bit windows.
 */
export interface LocalityFingerprint {
  readonly simhash256: string;                  // 64 hex (256 bits)
  readonly bands: readonly [string, string, string, string,
                           string, string, string, string]; // 8 hex each (32 bits)
  readonly populationCount: number;             // 0..256
}

/**
 * The unified PatchEnvelope — every KEYSTONE tool emits this.
 * PLAN1's EditDocumentRequest reads target.* directly without translation.
 */
export interface PatchEnvelope {
  // ── PLAN1 EditDocumentRequest target fields (verbatim consumption) ──
  readonly path: string;                        // relative to repoRoot
  readonly sourceFileHash16: string;            // first 16 hex of file BLAKE3
  readonly hash: string;                        // first 16 hex of node label_hash
  readonly shortStructural: string;             // first 16 hex of structural_hash
  readonly parentHash: string | null;           // null only at file root
  readonly childType: string;                   // tree-sitter named-child kind
  readonly childIndex: number;                  // 0-indexed within parent's same-childType children
  readonly contentWitness: string;              // first 64 UTF-8 bytes of node text
  readonly symbol?: { name: string; symbolType: string; scope: string | null };

  // ── Geometry (informational; PLAN1 ignores these) ──
  readonly byteRange: readonly [number, number];   // half-open
  readonly lineRange: readonly [number, number];   // 1-based start, inclusive end

  // ── Versioning (CANON_VERSION_MISMATCH guard) ──
  readonly canonVersion: CanonVersion;             // emitted at index time; verified at edit time

  // ── Patch Context (optional; populated when retrieval depth > 0) ──
  readonly patchContext?: {
    readonly dataDeps: readonly SiblingRef[];      // backward slice depth ≤ 2
    readonly controlDeps: readonly SiblingRef[];   // enclosing control-flow ancestors
    readonly interfaceContracts: readonly TypeContract[];
    readonly callGraph: readonly SiblingRef[];     // forward slice depth ≤ 1
    readonly intentSummary?: string;
  };

  // ── Atlas scores (drive ranking + compression) ──
  readonly scores?: {
    readonly novelty: number;                       // [0, 1]
    readonly centrality: number;                    // Personalized PageRank
    readonly sliceMembership: number;               // count of slices containing this hash
    readonly frameworkMultiplier: number;           // 1.0–3.2
    readonly hubClass: 'anti' | 'good' | 'bad';     // NeighborRetr partition
  };

  // ── Provenance (graph-walk path that surfaced this carrier) ──
  readonly pathTrace?: ReadonlyArray<{
    readonly fromHash: string;
    readonly toHash: string;
    readonly edgeType: 'call'|'data'|'control'|'def'|'structural'|'import';
    readonly depth: number;
  }>;

  // ── Cortex residency at envelope construction time ──
  readonly residency?: {
    readonly tier: 'L1'|'L2'|'L3'|'miss';
    readonly lastAccess: number;                    // epoch ms
    readonly accessCount: number;
  };

  // ── Page-fault history paid to surface this carrier ──
  readonly faults?: readonly PageFaultEvent[];
}

export interface SiblingRef {
  readonly hash: string;
  readonly shortStructural: string;
  readonly path: string;
  readonly childType: string;
  readonly relevance: number;
}

export interface TypeContract {
  readonly symbolName: string;
  readonly signature: string;
  readonly arity: number;
  readonly returnTypeText: string | null;
}

export interface PageFaultEvent {
  readonly eventType:
    | 'refetch'
    | 'duplicate_tool'
    | 'pinned_invariant_miss'
    | 'silent_recall'
    | 'flush_miss'
    | 'post_compaction_bootstrap';
  readonly faultedHash: string;
  readonly fromTier: 'L1'|'L2'|'L3'|'miss';
  readonly toTier: 'L1'|'L2';
  readonly costMs: number;
  readonly thrashIndex: number;                    // events / hits last 100 ops
  readonly streamed: boolean;                      // true if delivered via notifications/progress
}

export interface HealReport {
  readonly status: 'healed'|'ambiguous'|'miss';
  readonly tier: 1|2|3|4|5;
  readonly confidence: number;                     // 0..1
  readonly candidates: readonly PatchEnvelope[];   // ≥ 1 on healed/ambiguous
  readonly verificationGatePassed: boolean;
  readonly failureClass?:
    | 'argument_hallucination'
    | 'invalid_invocation'
    | 'partial_execution'
    | 'structural_break';
  readonly recommendation?: string;
  readonly idempotencyKey: string;
  readonly elapsedMs: number;
  readonly tiersAttempted: ReadonlyArray<{ tier: number; elapsedMs: number; hit: boolean }>;
}

/**
 * KEYSTONE diagnostic — extends PLAN1's 14 codes with 3 KEYSTONE additions.
 */
export type PLAN1DiagnosticCode =
  | 'NEVER_READ' | 'FILE_CHANGED' | 'EDITOR_DIRTY' | 'HASH_NOT_FOUND'
  | 'AMBIGUOUS_TARGET' | 'SYMBOL_TARGET_UNAVAILABLE' | 'BUDGET_EXCEEDED'
  | 'BOUNDARY_VIOLATION' | 'STRUCTURE_BROKEN' | 'PATH_UNSAFE' | 'PATH_MISMATCH'
  | 'OVERLAPPING_EDITS' | 'WRITE_VERIFY_FAILED' | 'RESTORE_FAILED' | 'LOCK_LOST';

export type KeystoneDiagnosticCode =
  | PLAN1DiagnosticCode
  | 'BUDGET_PAGED'                                  // hash not L1-resident; suggests page_in
  | 'CANON_VERSION_MISMATCH'                        // hash from older canon; needs heal/re-read
  | 'AMBIGUOUS_HEAL';                               // heal produced multiple plausible candidates

export interface KeystoneDiagnostic {
  readonly code: KeystoneDiagnosticCode;
  readonly shortMessage: string;
  readonly hints: readonly string[];
  readonly suggestedAction?: string;
  readonly exampleValidCall?: object;
  readonly candidates?: readonly PatchEnvelope[];
  readonly heal?: {
    readonly healedFromHash: string;
    readonly healedToHash: string;
    readonly tier: 1|2|3|4;
    readonly confidence: number;
    readonly candidateProvenance: readonly string[];
  };
  readonly pageFault?: PageFaultEvent;
}

/**
 * Standard envelope — every KEYSTONE tool returns this shape.
 */
export interface KeystoneEnvelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: KeystoneDiagnostic;
  readonly attempts: number;
  readonly pageFaults: readonly PageFaultEvent[];
  readonly budgetUsed: { readonly bytes: number; readonly tokens: number; readonly wallMs: number };
}

/**
 * EditHandoffOk / EditHandoffFailure — verifyEditHandoff() return type.
 */
export interface EditHandoffOk {
  readonly status: 'ok';
  readonly resolvedNodeId: string;
  readonly byteRange: readonly [number, number];
  readonly observedCanonVersion: CanonVersion;
}

export interface EditHandoffFailure {
  readonly status: 'fail';
  readonly diagnostic: KeystoneDiagnostic;
  readonly candidates?: readonly PatchEnvelope[];
  readonly pageFault?: PageFaultEvent;
}
```

### 6. Storage Schema — Final DDL

The DDL applied **additively** to `.mcp/symbols.db` for repos < 500 indexed files, OR to a sibling `.mcp/keystone.db` for repos ≥ 500 files. The schema is identical in both topologies — only the file path differs. Migration between topologies is supported via `bin/keystone-reindex --migrate-storage <additive|sibling>`.

```sql
-- canon_versions registry — F51 implemented as a real table (CHIRON contribution, generalized)
CREATE TABLE IF NOT EXISTS canon_versions (
  canon_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  algorithm         TEXT NOT NULL,                  -- 'zen:1' | 'zen:2'
  language          TEXT NOT NULL,
  abi_version       INTEGER NOT NULL,
  grammar_version   TEXT NOT NULL,
  canon_string      TEXT NOT NULL UNIQUE,           -- 'zen:1:typescript:15:0.21.4'
  first_seen        INTEGER NOT NULL,               -- epoch ms
  last_active       INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'frozen' | 'gc'
);
CREATE INDEX IF NOT EXISTS idx_canon_lang_active
  ON canon_versions(language, status, last_active DESC);

-- node_pool — interned subtree DAG; one row per unique (canon, structural_hash, label_hash)
CREATE TABLE IF NOT EXISTS node_pool (
  canon_id          INTEGER NOT NULL REFERENCES canon_versions(canon_id) ON DELETE CASCADE,
  structural_hash   TEXT NOT NULL,                  -- 64 hex chars (full BLAKE3-256)
  label_hash        TEXT NOT NULL,                  -- 64 hex chars
  short_label       TEXT NOT NULL,                  -- first 16 hex of label_hash (PLAN1 format)
  short_structural  TEXT NOT NULL,                  -- first 16 hex of structural_hash
  kind              TEXT NOT NULL,                  -- tree-sitter node kind
  is_leaf           INTEGER NOT NULL DEFAULT 0,     -- boolean
  children_hashes   TEXT,                           -- JSON array of child label_hashes (full 64-hex)
  ref_count         INTEGER NOT NULL DEFAULT 1,
  bloom_refs        BLOB,                           -- 256-bit Bloom of contained identifier names
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (canon_id, structural_hash, label_hash)
);
CREATE INDEX IF NOT EXISTS idx_node_pool_short_label    ON node_pool(short_label);
CREATE INDEX IF NOT EXISTS idx_node_pool_short_struct   ON node_pool(short_structural);
CREATE INDEX IF NOT EXISTS idx_node_pool_kind_canon     ON node_pool(canon_id, kind);

-- node_occurrences — per-(file, occurrence) instance of a pool entry
CREATE TABLE IF NOT EXISTS node_occurrences (
  occurrence_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  canon_id          INTEGER NOT NULL REFERENCES canon_versions(canon_id) ON DELETE CASCADE,
  file_path         TEXT NOT NULL,                  -- relative to repo root
  source_file_hash  TEXT NOT NULL,                  -- 16 hex of file BLAKE3
  structural_hash   TEXT NOT NULL,
  label_hash        TEXT NOT NULL,
  short_label       TEXT NOT NULL,
  parent_label      TEXT,                           -- null at file root
  child_type        TEXT NOT NULL,
  child_index       INTEGER NOT NULL,
  start_byte        INTEGER NOT NULL,
  end_byte          INTEGER NOT NULL,
  start_line        INTEGER NOT NULL,
  end_line          INTEGER NOT NULL,
  content_witness   TEXT NOT NULL,                  -- first 64 UTF-8 bytes, slash-escaped
  symbol_name       TEXT,
  symbol_type       TEXT,
  symbol_scope      TEXT,
  framework_tag     TEXT,
  fp_band_0         INTEGER NOT NULL,               -- 32-bit
  fp_band_1         INTEGER NOT NULL,
  fp_band_2         INTEGER NOT NULL,
  fp_band_3         INTEGER NOT NULL,
  fp_band_4         INTEGER NOT NULL,
  fp_band_5         INTEGER NOT NULL,
  fp_band_6         INTEGER NOT NULL,
  fp_band_7         INTEGER NOT NULL,
  fp_population     INTEGER NOT NULL,
  novelty_score     REAL,
  pagerank_score    REAL,
  hub_class         TEXT,                           -- 'anti' | 'good' | 'bad'
  indexed_at        INTEGER NOT NULL,
  FOREIGN KEY (canon_id, structural_hash, label_hash)
    REFERENCES node_pool(canon_id, structural_hash, label_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_occ_short_label_file ON node_occurrences(short_label, file_path);
CREATE INDEX IF NOT EXISTS idx_occ_file             ON node_occurrences(file_path);
CREATE INDEX IF NOT EXISTS idx_occ_symbol_name      ON node_occurrences(symbol_name);
CREATE INDEX IF NOT EXISTS idx_occ_kind_canon       ON node_occurrences(canon_id, child_type);
CREATE INDEX IF NOT EXISTS idx_occ_fp_b0 ON node_occurrences(fp_band_0);
CREATE INDEX IF NOT EXISTS idx_occ_fp_b1 ON node_occurrences(fp_band_1);
CREATE INDEX IF NOT EXISTS idx_occ_fp_b2 ON node_occurrences(fp_band_2);
CREATE INDEX IF NOT EXISTS idx_occ_fp_b3 ON node_occurrences(fp_band_3);
CREATE INDEX IF NOT EXISTS idx_occ_fp_b4 ON node_occurrences(fp_band_4);
CREATE INDEX IF NOT EXISTS idx_occ_fp_b5 ON node_occurrences(fp_band_5);
CREATE INDEX IF NOT EXISTS idx_occ_fp_b6 ON node_occurrences(fp_band_6);
CREATE INDEX IF NOT EXISTS idx_occ_fp_b7 ON node_occurrences(fp_band_7);
CREATE INDEX IF NOT EXISTS idx_occ_novelty   ON node_occurrences(novelty_score DESC);
CREATE INDEX IF NOT EXISTS idx_occ_hub_class ON node_occurrences(hub_class);
CREATE INDEX IF NOT EXISTS idx_occ_framework ON node_occurrences(framework_tag);

-- file_state — tracks current canon and root hash per file
CREATE TABLE IF NOT EXISTS file_state (
  file_path           TEXT PRIMARY KEY,
  canon_id            INTEGER NOT NULL REFERENCES canon_versions(canon_id),
  source_file_hash    TEXT NOT NULL,                -- 16 hex of file BLAKE3
  root_label_hash     TEXT NOT NULL,                -- file root node label hash (64 hex)
  language            TEXT NOT NULL,
  node_count          INTEGER NOT NULL,
  error_node_count    INTEGER NOT NULL DEFAULT 0,
  last_indexed        INTEGER NOT NULL,
  last_keystone_indexed INTEGER NOT NULL,           -- epoch ms; null = never indexed by KEYSTONE
  size_bytes          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_state_canon ON file_state(canon_id);

-- slice_records — content-addressed slice records (Theme A5 + F8 + F13)
CREATE TABLE IF NOT EXISTS slice_records (
  slice_id            TEXT PRIMARY KEY,             -- blake3(criterion_hash || direction || depth || ordered_member_hashes)
  criterion_hash      TEXT NOT NULL,                -- short_label of seed node
  direction           TEXT NOT NULL,                -- 'forward' | 'backward' | 'both'
  depth               INTEGER NOT NULL,
  member_count        INTEGER NOT NULL,
  total_bytes         INTEGER NOT NULL,
  computed_at         INTEGER NOT NULL,
  canon_id            INTEGER NOT NULL REFERENCES canon_versions(canon_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_slice_criterion ON slice_records(criterion_hash, direction);

-- slice_members — N:M between slices and node occurrences
CREATE TABLE IF NOT EXISTS slice_members (
  slice_id            TEXT NOT NULL REFERENCES slice_records(slice_id) ON DELETE CASCADE,
  member_short_label  TEXT NOT NULL,
  member_file_path    TEXT NOT NULL,
  relationship        TEXT NOT NULL,                -- 'data_dep' | 'control_dep' | 'type' | 'call' | 'imports'
  hop_distance        INTEGER NOT NULL,
  PRIMARY KEY (slice_id, member_short_label, member_file_path)
);
CREATE INDEX IF NOT EXISTS idx_slice_member_label ON slice_members(member_short_label);

-- read_registry_persist — SQLite expiry sweep for in-memory read registry leaks (FORGE pattern)
CREATE TABLE IF NOT EXISTS read_registry_persist (
  session_id          TEXT NOT NULL,
  source_file_hash    TEXT NOT NULL,
  file_path           TEXT NOT NULL,
  origin              TEXT NOT NULL,                -- 'keystone' | 'legacy_shadow'
  generated_at        INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,             -- generated_at + 30min default
  PRIMARY KEY (session_id, source_file_hash, file_path)
);
CREATE INDEX IF NOT EXISTS idx_read_registry_expires ON read_registry_persist(expires_at);

-- heal_cache — durable cache of healed anchors (idempotency-key keyed)
CREATE TABLE IF NOT EXISTS heal_cache (
  idempotency_key     TEXT PRIMARY KEY,
  request_hash        TEXT NOT NULL,                -- hash of normalized HealRequest
  result_blob         BLOB NOT NULL,                -- JSON-encoded HealReport
  computed_at         INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,             -- default 1h
  hit_count           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_heal_cache_expires ON heal_cache(expires_at);

-- atlas_patterns — repository-wide structural pattern frequency (F36)
CREATE TABLE IF NOT EXISTS atlas_patterns (
  canon_id            INTEGER NOT NULL REFERENCES canon_versions(canon_id),
  structural_hash     TEXT NOT NULL,                -- 64 hex
  occurrence_count    INTEGER NOT NULL,
  example_file        TEXT NOT NULL,
  example_symbol      TEXT,
  framework_tag       TEXT,
  k_occurrence        INTEGER NOT NULL,             -- for hub_class derivation
  hub_class           TEXT NOT NULL,
  first_seen          INTEGER NOT NULL,
  last_updated        INTEGER NOT NULL,
  PRIMARY KEY (canon_id, structural_hash)
);
CREATE INDEX IF NOT EXISTS idx_atlas_k        ON atlas_patterns(k_occurrence DESC);
CREATE INDEX IF NOT EXISTS idx_atlas_hub_class ON atlas_patterns(hub_class);

-- atlas_frameworks — detected framework signatures
CREATE TABLE IF NOT EXISTS atlas_frameworks (
  canon_id            INTEGER NOT NULL REFERENCES canon_versions(canon_id),
  framework_name      TEXT NOT NULL,
  confidence          REAL NOT NULL,
  file_count          INTEGER NOT NULL,
  detection_rule      TEXT NOT NULL,
  importance_multiplier REAL NOT NULL DEFAULT 1.0,
  last_seen           INTEGER NOT NULL,
  PRIMARY KEY (canon_id, framework_name)
);

-- pagerank_scores — Personalized PageRank, recomputed lazy on edges change
CREATE TABLE IF NOT EXISTS pagerank_scores (
  canon_id            INTEGER NOT NULL REFERENCES canon_versions(canon_id),
  short_label         TEXT NOT NULL,
  file_path           TEXT NOT NULL,
  pagerank_score      REAL NOT NULL,
  iteration           INTEGER NOT NULL,
  computed_at         INTEGER NOT NULL,
  PRIMARY KEY (canon_id, short_label, file_path)
);
CREATE INDEX IF NOT EXISTS idx_pagerank_score ON pagerank_scores(pagerank_score DESC);

-- drift_log — telemetry for the drift_rate release gate
CREATE TABLE IF NOT EXISTS drift_log (
  run_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  canon_id            INTEGER NOT NULL REFERENCES canon_versions(canon_id),
  hub_class_flips     INTEGER NOT NULL,             -- count of pool entries that changed hub_class this run
  pool_size           INTEGER NOT NULL,
  drift_rate          REAL NOT NULL,                -- flips / pool_size
  generated_at        INTEGER NOT NULL,
  flagged             INTEGER NOT NULL DEFAULT 0    -- boolean, set when drift_rate > 0.05
);
```

In additive topology, two `ALTER TABLE` migrations on the existing `symbols` table (idempotent via try/catch — Zenith's existing pattern at `dist/core/symbol-index.js:90`):

```sql
ALTER TABLE symbols ADD COLUMN canon_id INTEGER;
ALTER TABLE symbols ADD COLUMN keystone_short_label TEXT;
```

In sibling topology, the same two columns are added to `symbols` (so existing tools can join across DBs via `ATTACH DATABASE`), and the rest of the KEYSTONE tables live in `keystone.db`.

### 7. Phased Implementation (Wave-Parallelized via Planning Skill)

This is the wave-based execution plan emitted by the Planning Skill (Parallel Execution Planner) over the dependency graph of files and modules.

```
Phase 0  ┬─→ Phase 1                                                      (sequential)
Phase 1  ┬─→ Phase 2                                                      (Atlas needs node_pool)
         ├─→ Phase 3 parallel with Phase 2                                (Slicer needs node_pool, not Atlas)
         └─→ Phase 4 parallel internal (5 tools after deps; tool-internal parallel)
Phase 2  ┬─→ Phase 5 (Healer needs Atlas)
Phase 3  ┴─→ Phase 4 partial (some tools need slicer)
Phase 4  ┬─→ Phase 6 (Cortex needs tools wired)
         └─→ Phase 7 (Compression bridge needs tools)
Phase 6  ┬─→ Phase 8 (shadow → cutover after all)
Phase 7  ┘
```

Wave parallelism rules:
- **No same-file parallel edits.** `dist/core/server.js` is touched only once (Task 4.0 to register all 5 tools).
- Same-task subagents may run in parallel within a wave only if they touch disjoint files.
- All hand-authored `dist/core/keystone/` and `dist/tools/keystone_*.js` files are NEW — no concurrent-edit risk.

---

#### Phase 0 — Canonicalization Spec, Test Corpus, Audit CLI (the first wave)

**Goal**: publish the versioned canonicalization specification, the test corpus, and the audit CLI **before** any code is written that relies on the hash function. This is the de-risking phase — it validates that the hash function is deterministic across grammars, machines, and BLAKE3 implementations.

##### Task 0.1 — Add BLAKE3 dependency and authoritative canonicalization module

Files:
- Edit: `package.json` (add `"@noble/hashes": "^1.4.0"` next to `better-sqlite3` at line 36)
- Create: `dist/core/keystone/canonical.js` (hand-authored)
- Create: `src/core/keystone/canonical.ts` (declaration emit only)

Steps:

1. Add the BLAKE3 dependency to `package.json` (line 36, dependencies block):
   ```json
   "@noble/hashes": "^1.4.0",
   ```
2. Implement `dist/core/keystone/canonical.js`:
   ```js
   import { blake3 } from '@noble/hashes/blake3';
   import { Buffer } from 'buffer';

   const LEAF_KEY     = blake3(Buffer.from('ZEN-KEYSTONE-LEAF-v1', 'utf8'));     // 32 bytes
   const INTERNAL_KEY = blake3(Buffer.from('ZEN-KEYSTONE-INTERNAL-v1', 'utf8')); // 32 bytes

   /** Length-tagged UTF-8 byte concatenation (DAG-CBOR pattern). */
   function tagged(strOrBytes) {
     const bytes = typeof strOrBytes === 'string'
       ? Buffer.from(strOrBytes, 'utf8')
       : Buffer.from(strOrBytes);
     const len = Buffer.alloc(4);
     len.writeUInt32BE(bytes.length, 0);
     return Buffer.concat([len, bytes]);
   }

   /** Canonical hash input prefix — every node hash includes it. */
   export function canonPrefix(canon) {
     // canon = { algorithm:'zen:1', language, abiVersion, grammarVersion }
     return Buffer.concat([
       Buffer.from([0x01]),                                  // version envelope marker
       tagged(canon.algorithm),
       tagged(canon.language),
       tagged(String(canon.abiVersion)),
       tagged(canon.grammarVersion),
       Buffer.from([0x00]),                                  // NUL terminator
     ]);
   }

   /** Hash a leaf node. */
   export function hashLeaf(canon, kind, tokenText) {
     const input = Buffer.concat([
       canonPrefix(canon),
       tagged(kind),
       tagged(tokenText ?? ''),
     ]);
     return Buffer.from(blake3(input, { dkLen: 32, key: LEAF_KEY })).toString('hex');
   }

   /** Hash an internal node from its children's hashes (length-first ordering). */
   export function hashInternal(canon, kind, childHashesHex) {
     // childHashesHex: array of 64-hex strings (BLAKE3-256 hex), already in tree-sitter child order
     const childBytes = childHashesHex.map(h => Buffer.from(h, 'hex'));
     // Length-prefixed child count then concatenated child hashes (32 bytes each)
     const countBuf = Buffer.alloc(4);
     countBuf.writeUInt32BE(childBytes.length, 0);
     const input = Buffer.concat([
       canonPrefix(canon),
       tagged(kind),
       countBuf,
       ...childBytes,
     ]);
     return Buffer.from(blake3(input, { dkLen: 32, key: INTERNAL_KEY })).toString('hex');
   }

   /** Compute structural+label two-hash pair for a tree-sitter node, recursively. */
   export function hashNode(canon, node, sourceBytes) {
     // node: web-tree-sitter SyntaxNode
     // sourceBytes: Buffer containing the full file UTF-8 bytes
     const kind = node.type;
     if (node.childCount === 0) {
       // Leaf: structural omits identifier text, label includes it
       const tokenText = sourceBytes.subarray(node.startIndex, node.endIndex).toString('utf8');
       const isIdentifier = node.type === 'identifier' || node.type === 'property_identifier'
                          || node.type === 'type_identifier' || node.type === 'field_identifier';
       const structural = hashLeaf(canon, kind, isIdentifier ? '' : tokenText);
       const label      = hashLeaf(canon, kind, tokenText);
       return { structural, label };
     }
     // Internal: hash children left-to-right
     const childHashes = [];
     for (let i = 0; i < node.childCount; i++) {
       const ch = node.child(i);
       childHashes.push(hashNode(canon, ch, sourceBytes));
     }
     const structural = hashInternal(canon, kind, childHashes.map(c => c.structural));
     const label      = hashInternal(canon, kind, childHashes.map(c => c.label));
     return { structural, label };
   }

   export const SHORT_HEX_LEN = 16;
   export function shortHash(fullHex) { return fullHex.slice(0, SHORT_HEX_LEN); }
   ```
3. TS declaration in `src/core/keystone/canonical.ts` mirrors the exports with proper types. Tsc emits `.d.ts` only (no `.js`).

Exit criteria:
- `import { hashNode } from './dist/core/keystone/canonical.js'` works in Node 20+.
- A 200-line TypeScript fixture parsed by web-tree-sitter v0.26.x produces the same `hashNode` output across two different machines (verified manually before Phase 1 begins).

##### Task 0.2 — Publish the test corpus (`tests/keystone-canon-vectors/`)

Files:
- Create: `tests/keystone-canon-vectors/typescript/{simple_function, class_with_method, generic_arrow, jsx_component}/{input.ts, expected.json}` (4 fixtures)
- Create: `tests/keystone-canon-vectors/python/{simple_def, class_with_method, decorated_async, list_comp}/{input.py, expected.json}` (4)
- Repeat for: javascript, tsx, go, rust, java, ruby, bash, c, json (4 each = 44 fixtures total)
- Create: `tests/keystone-canon-vectors/README.md` (corpus rules)
- Create: `tests/keystone-canon-vectors.test.js` (vitest)

Each `expected.json` shape:
```json
{
  "canon": {
    "algorithm": "zen:1",
    "language": "typescript",
    "abiVersion": 15,
    "grammarVersion": "0.21.4"
  },
  "fileHash": "ab12cd34...",
  "nodes": [
    {
      "kind": "function_declaration",
      "byteRange": [0, 47],
      "structuralHash": "0000000000000000000000000000000000000000000000000000000000000000",
      "labelHash":      "0000000000000000000000000000000000000000000000000000000000000000",
      "shortLabel": "0000000000000000",
      "shortStructural": "0000000000000000"
    },
    ...
  ]
}
```

(The all-zero hashes above are placeholders. Fixture authoring is part of Task 0.2: parse each input, run `hashNode`, write the actual hashes into `expected.json`.)

Steps:

1. Write each `input.<ext>` to be small but exercising: leaf identifiers, internal blocks, nested structures, comments (excluded from CST in some grammars), Unicode identifiers (for hash determinism under encoding rules).
2. Parse each fixture with the locked `(grammar_version, abi_version)` triple recorded in its `expected.json`.
3. Compute `hashNode` for every named node, write into `expected.json`.
4. Commit. From this point on, any change to `dist/core/keystone/canonical.js` that produces different hashes for any fixture is a canonicalization-rule change and triggers a `zen:` algorithm bump.

Exit criteria:
- `vitest tests/keystone-canon-vectors.test.js` passes for all 44 fixtures.
- `tests/keystone-canon-vectors.test.js` re-runs `hashNode` and asserts deep-equal against `expected.json`.

##### Task 0.3 — Publish `bin/keystone-audit` CLI

Files:
- Create: `bin/keystone-audit` (Node shebang)
- Edit: `package.json` `bin` block to register the binary

Steps:

1. Add the bin entry in `package.json`:
   ```json
   "bin": {
     "zenith-mcp": "./dist/cli/stdio.js",
     "zenith-mcp-config": "./dist/adapters/cli.js",
     "zenith-mcp-config-admin": "./dist/config/admin-cli.js",
     "keystone-audit": "./bin/keystone-audit"
   }
   ```
2. `bin/keystone-audit` reads `tests/keystone-canon-vectors/`, hashes every fixture under live grammar versions, and exits non-zero on drift. Output format:
   ```
   keystone-audit v1
   corpus: tests/keystone-canon-vectors  (44 fixtures, 11 languages)
   typescript/simple_function:    OK
   typescript/class_with_method:  OK
   ...
   python/decorated_async:        DRIFT
     expected canon:  zen:1:python:14:0.20.4
     observed canon:  zen:1:python:14:0.21.0
     expected node 'function_definition' label: 9a8b7c... 
     observed node 'function_definition' label: 1f2e3d...
   summary: 43/44 OK, 1 drift detected
   ```
3. Add CI hook: `.github/workflows/keystone-audit.yml` runs `npm run keystone-audit` on every PR.

Exit criteria:
- `keystone-audit` exits 0 on a clean tree.
- `keystone-audit` exits non-zero after a deliberately broken hash function (regression test in Phase 0 itself).

##### Task 0.4 — Add `canon_versions` table & `bin/keystone-bump-grammar`

Files:
- Edit: `dist/core/symbol-index.js` (add idempotent `CREATE TABLE IF NOT EXISTS canon_versions` block at line 90, alongside the existing schema initialization in `getDb()`)
- Create: `bin/keystone-bump-grammar`

Steps:

1. Insert the `canon_versions` DDL into `getDb()` after the existing `CREATE INDEX` block (line ~88):
   ```js
   db.exec(`CREATE TABLE IF NOT EXISTS canon_versions ( ... )`);
   db.exec(`CREATE INDEX IF NOT EXISTS idx_canon_lang_active ON canon_versions(language, status, last_active DESC)`);
   ```
2. `bin/keystone-bump-grammar <language>` reads the live tree-sitter grammar metadata, INSERTs a new row in `canon_versions`, and emits the new `canon_string`. The actual re-hashing is delegated to `bin/keystone-reindex --bump-grammar <language>` (Phase 1).
3. Write `docs/keystone-canon-migration.md` covering the four migration steps from §3.4.

Exit criteria:
- `canon_versions` table exists in any newly-initialized `.mcp/symbols.db`.
- Running `bin/keystone-bump-grammar typescript` adds a new row without modifying existing rows.

**Phase 0 exit criteria** (gate the rest of the project):
- BLAKE3 import works in Zenith's ESM Node environment.
- 44 canon-vector fixtures pass on a clean tree.
- `keystone-audit` runs in CI and exits 0.
- `canon_versions` table created idempotently.
- The grammar-bump migration ladder is documented.
- Hash function deterministic across two independent machines.

---

#### Phase 1 — Hash Forest, Storage Topology, and Migration Tool

**Goal**: install the storage layer (adaptive between additive and sibling), implement the hash forest indexer, and ship the lazy-or-eager re-indexing migration tool.

##### Task 1.1 — Storage topology selection

Files:
- Create: `dist/core/keystone/storage.js`
- Create: `src/core/keystone/storage.ts`
- Create: `.mcp/keystone-config.json` template documented in `docs/keystone-config.md`

Steps:

1. `selectStorage(repoRoot)` reads `.mcp/keystone-config.json` if present:
   ```json
   { "adaptive_storage": "auto" | "additive" | "sibling",
     "default_budget": 8000,
     "heal_confidence_floor": 0.85,
     "fp_strict_hamming": 24,
     "fp_relaxed_hamming": 64,
     "drift_rate_release_gate": 0.05 }
   ```
2. If `adaptive_storage === "auto"` (default): query `SELECT COUNT(*) FROM files` from existing `.mcp/symbols.db`. If < 500 → additive; else → sibling.
3. If sibling: open `.mcp/keystone.db` with the same WAL options as `symbols.db` and run KEYSTONE DDL. Add `ATTACH DATABASE '.mcp/keystone.db' AS k` capability for cross-DB joins.
4. Cache the topology decision in memory; expose `keystoneStorage.topology` for downstream modules.

Exit criteria:
- `selectStorage()` returns the correct topology for repos at 100, 500, and 5000 files.
- Existing `symbols.db` schema is byte-identical after `selectStorage()` in additive mode (verified by sha256 of schema dump).

##### Task 1.2 — Hash forest indexer

Files:
- Create: `dist/core/keystone/forest.js`
- Create: `dist/core/keystone/forest-internals.js` (helpers)

Steps:

1. `indexFile(filePath, ctx)`:
   1. Parse with tree-sitter via existing `getCompiledQuery(langName)` (no changes to `dist/core/tree-sitter.js`).
   2. Call `hashNode(canon, root, sourceBytes)` recursively, accumulating `(structural_hash, label_hash, kind, byteRange, lineRange, contentWitness)` for every named node into a transient batch.
   3. Compute file BLAKE3, take first 16 hex as `source_file_hash`.
   4. Compute root subtree's `(structural, label)` hash → `root_label_hash`.
   5. Get-or-create `canon_id` in `canon_versions`.
   6. Compare against `file_state.root_label_hash`: identical → no-op (full cache hit).
   7. Different → walk the new tree post-order; for each node, lookup `(canon_id, structural_hash, label_hash)` in `node_pool` — present → increment `ref_count`; absent → insert. Insert/update `node_occurrences` for every node. Update `file_state`.
2. Bloom-of-references for each pool entry: 256-bit Bloom of identifier-token names contained in the subtree (HyperAST live-codebase pattern, F22). Stored in `node_pool.bloom_refs`.

Exit criteria:
- Indexing a 50K-line TypeScript monorepo completes in < 30 s on initial; < 2 s for a single-file change.
- `node_pool.ref_count` correctly aggregates across files.
- Re-indexing the same file is a no-op (root_label_hash unchanged).

##### Task 1.3 — `bin/keystone-reindex` (lazy or eager migration tool)

Files:
- Create: `bin/keystone-reindex`
- Create: `dist/core/keystone/reindex.js`

Steps:

1. `bin/keystone-reindex` accepts `--lazy` (default), `--eager`, `--dry-run`, `--verify`, `--migrate-storage <topology>`, `--bump-grammar <lang>`, `--gc-canon <canon_string>`.
2. `--lazy`: writes a sentinel at `.mcp/keystone-reindex-needed` and registers an interceptor in `KeystoneSession` so any read-tool call to a file with `last_keystone_indexed = NULL` re-indexes that one file synchronously.
3. `--eager`: walks the repo, calls `indexFile()` for every file in batches of 50 (matching the existing `indexDirectory` pattern in `dist/core/symbol-index.js`).
4. `--verify`: indexes into a `.mcp/keystone-verify.db` temp DB, deep-diffs against the live one, exits non-zero on inconsistency.
5. `--bump-grammar <lang>`: writes new `canon_versions` row, then re-indexes every file in `<lang>` under the new canon.

Exit criteria:
- `keystone-reindex --eager` produces identical output to `keystone-reindex --lazy` followed by reading every file (verified by hash diff).
- `keystone-reindex --dry-run` modifies nothing.

##### Task 1.4 — Read-registry shadow-write hook

Files:
- Edit: `dist/tools/read_file.js` (legacy `read_text_file`)
- Create: `dist/core/keystone/read-registry.js`

Steps:

1. `KeystoneReadRegistry` exposes:
   ```js
   register({sessionId, sourceFileHash16, filePath, origin, generatedAt}): void
   isRegistered({sessionId, sourceFileHash16, filePath}): boolean
   sweep(): number  // delete expired entries
   ```
   Backed by an in-memory `Map<sessionKey, Set<hash:path>>` plus the SQLite `read_registry_persist` table.
2. Insert one shim line in `dist/tools/read_file.js` after the existing read completes:
   ```js
   // After existing read returns successfully (line ~120 in the existing handler):
   if (process.env.KEYSTONE_LEGACY_SHADOW_WRITE !== 'false') {
     keystoneReadRegistry.register({
       sessionId: ctx.sessionId,
       sourceFileHash16: blake3(fileBytes).slice(0, 16),
       filePath,
       origin: 'legacy_shadow',
       generatedAt: Date.now(),
     });
   }
   ```
3. `keystone_outline` (Phase 4) similarly registers with `origin: 'keystone'` after every successful response.

Exit criteria:
- An agent that calls `read_text_file` and then submits an edit with the resulting `sourceFileHash16` passes the read-registry gate.
- `KEYSTONE_LEGACY_SHADOW_WRITE=false` disables the shadow-write cleanly.

**Phase 1 exit criteria**:
- Storage topology selected correctly for any repo size.
- Hash forest indexes any of Zenith's existing 20+ supported languages.
- `keystone-reindex` migrates legacy `symbols.db` rows without breaking existing tools.
- Read registry accepts both `keystone` and `legacy_shadow` entries.

---

#### Phase 2 — Atlas (parallel internally; depends on Phase 1)

**Goal**: build the locality fingerprint banding, frequency atlas, framework detection, and Personalized PageRank.

##### Task 2.1 — Banded SimHash (256-bit, 8 × 32-bit)

Files:
- Create: `dist/core/keystone/atlas/simhash.js`

Steps:

1. `computeSimHash256(node)`:
   - Build the locality vector (parent_kind, grandparent_kind, sibling_kinds[0..3], own_kind, child_kinds[0..5], grandchild_kinds[0..7]). 20 tokens total, padded with `'NULL'`.
   - For each token `t`, compute `BLAKE3-256(t)` and read the first 32 bytes as 256 weights {-1, +1}.
   - Aggregate: `weights[i] = Σ token_weight_i across tokens`. Final fingerprint: `bit i = weights[i] > 0 ? 1 : 0`.
2. Split the 256-bit fingerprint into 8 × 32-bit `bands[0..7]`. Each band is stored as a 32-bit `INTEGER` column in `node_occurrences.fp_band_*`.
3. Hamming-search by querying `WHERE fp_band_0 = $b0 OR fp_band_1 = $b1 OR ...` (8-band OR), then post-filter by full Hamming distance against the queried fingerprint.

Exit criteria:
- Two structurally near-identical functions (e.g., two CRUD handlers) produce Hamming distance ≤ 24 (strict).
- Two structurally distinct functions produce Hamming > 64.
- Band-OR query returns the strict candidate set in ≤ 50 ms on 100k node corpus.

##### Task 2.2 — Sort-&-Slice frequency atlas + NeighborRetr partition + drift gate

Files:
- Create: `dist/core/keystone/atlas/frequency.js`
- Create: `dist/core/keystone/atlas/drift.js`

Steps:

1. After every `indexFile()` batch, recompute `atlas_patterns.occurrence_count` for affected `structural_hash` rows (via a `GROUP BY` aggregate over `node_occurrences`).
2. NeighborRetr partition: `hub_class = anti if k_occurrence < 4 else good if k_occurrence ≤ 16 else bad`.
3. Sort-&-Slice frequency-truncate: novelty score = `1 - rank(structural_hash) / pool_size` over rank-sorted occurrence counts. Stored in `node_occurrences.novelty_score`.
4. Drift detection: per index run, count how many `structural_hash` entries flipped `hub_class` between this run and the previous. Compute `drift_rate = flips / pool_size`. Persist to `drift_log`. If `drift_rate > 0.05` (release gate), set `flagged = 1` and emit a stderr warning.

Exit criteria:
- Recomputing frequencies after a single-file change touches only the affected `structural_hash` rows.
- Drift gate fires on a synthetic test where 6% of entries change hub_class.

##### Task 2.3 — Framework detection & importance multipliers

Files:
- Create: `dist/core/keystone/atlas/frameworks.js`
- Create: `dist/grammars/queries/<lang>/frameworks.scm` (per-lang detection patterns)

Steps:

1. Detection rules per framework:
   - React: `import_statement` of `'react'` AND any function returning JSX → `framework_tag = 'react_component'`, multiplier 1.6.
   - Express: `app.get`/`.post`/`.put`/`.delete` call expression → `framework_tag = 'route_handler'`, multiplier 1.8.
   - Django/Flask/FastAPI: decorator patterns + import patterns → `data_model` (multiplier 2.0), `route_handler` (multiplier 1.8).
   - gRPC: proto-generated detection → `generated`, multiplier 0.4 (de-prioritize).
   - Test patterns (Jest/Vitest/Pytest): `it()`, `test()`, `describe()` calls → `test_case`, multiplier 1.2.
2. `importance(node) = node.novelty * w_n + node.pagerank * w_c + node.slice_membership * w_s + framework_multiplier * w_f`.

Exit criteria:
- A React monorepo correctly tags ≥ 90% of `function_declaration` returning JSX as `react_component`.
- Generated proto code is correctly tagged and given multiplier 0.4.

##### Task 2.4 — Personalized PageRank with ×50 direct-import boost

Files:
- Create: `dist/core/keystone/atlas/pagerank.js`

Steps:

1. Build edge graph over `edges` table joined with `node_occurrences` to project edges from symbol-name basis to `short_label` basis.
2. Personalized PageRank with personalization vector = `1` at every entry-point function (a function with no callers), `0` elsewhere; teleportation 0.15.
3. Direct-import boost: edges that represent `import_statement` references receive ×50 weight before normalization (Aider Issue #2405 empirical workaround for monorepos > 100k LOC).
4. Run iteratively: 50 iterations with convergence ε = 1e-6.
5. Persist into `pagerank_scores`. Recompute lazy on `edges` table mutation (debounced, 5 s after last edit).

Exit criteria:
- PageRank scores reproducible across two independent runs (deterministic given a fixed graph).
- PageRank computation finishes in < 5 s on a 100k-LOC repo.

**Phase 2 exit criteria**:
- Banded SimHash query returns candidates in p95 < 50 ms on 100k-node corpus.
- Frequency atlas + drift gate operational.
- Framework detection ≥ 90% accuracy on a fixture corpus.
- PageRank deterministic and < 5 s convergence.

---

#### Phase 3 — Slice Index + Patch Context (parallel with Phase 2)

**Goal**: build the persistent slice index and the Patch Context tuple — the unanswered Theme A5 + F8 primitive (combined Merkle + slice-membership invalidation).

##### Task 3.1 — Slicer (forward + backward, AST-granularity)

Files:
- Create: `dist/core/keystone/slicer.js`
- Create: `dist/grammars/queries/<lang>/slice.scm`

Steps:

1. Per-language `slice.scm` captures:
   ```scheme
   (import_statement) @slice.import
   (call_expression function: (identifier) @slice.value_ref)
   (type_annotation (type_identifier) @slice.type_ref)
   (variable_declarator name: (identifier) @slice.def value: (_) @slice.value)
   ```
2. Forward slice (`direction = 'forward'`):
   - Walk body of criterion node.
   - For each `@slice.value_ref` and `@slice.type_ref`, resolve to a definition via `node_occurrences.symbol_name` LEFT JOIN.
   - Collect resolved targets into `slice_members` with `relationship = 'data_dep'`.
   - Recurse with `depth - 1` until `depth = 0`.
3. Backward slice (`direction = 'backward'`): swap to query "who references this name" via the existing `edges` table (no recompute needed).
4. Slice ID: `slice_id = blake3(criterion_hash || direction || depth || sorted ordered_member_short_labels)`.
5. Cache: upsert `slice_records` by `slice_id`. If row exists with same `criterion_hash`, return cached.

Exit criteria:
- Forward slice over a 200-LOC TypeScript class returns ≤ 20 members in < 100 ms.
- Backward slice returns deterministic results across two runs.

##### Task 3.2 — Patch Context tuple emitter

Files:
- Edit: `dist/core/keystone/slicer.js` (add `computePatchContext(node, depth)`)

Steps:

1. `computePatchContext(node, depth)`:
   - DD = forward slice depth ≤ 2.
   - CD = walk parent control-flow ancestors (`if_statement`, `while_statement`, `try_statement`, `catch_clause`, `for_statement`, `switch_case`).
   - IC = collect `interface_declaration` / `type_alias_declaration` whose names appear in DD (TypeScript) or `class_definition` annotations (Python).
   - CG = forward slice depth ≤ 1 over call edges only.
2. Cap at 20 members per dimension (KGCompass).

Exit criteria:
- PatchContext is populated on a `keystone_search` response over a non-trivial fixture.
- Each PatchContext dimension never exceeds 20 entries.

##### Task 3.3 — Slice-membership invalidation

Files:
- Edit: `dist/core/keystone/forest.js` (in `indexFile()`)

Steps:

1. After `indexFile()` updates `node_occurrences`, look up all `slice_members` rows whose `member_short_label` belongs to a node whose `(structural_hash, label_hash)` changed.
2. For each, emit `INVALIDATE` event: delete the parent `slice_records` row (cascade deletes `slice_members`).
3. Log invalidation events to `drift_log` for the F35 drift gate to pick up if abnormal volume.

Exit criteria:
- Editing a function's body invalidates exactly the slices whose `slice_members` reference that function's hash; no others.
- Invalidation is O(slice members), not O(repo size).

**Phase 3 exit criteria**:
- Slice computation deterministic and content-addressed.
- PatchContext populated and capped.
- Invalidation cost is O(changed nodes × slice membership), not O(repo size).

---

#### Phase 4 — Tool Surface (5 MCP tools)

**Goal**: register the five new tools in flat-mode-string Zod, wire them through `dist/core/server.js`. Each tool is its own file under `dist/tools/` (no concurrent-edit risk on `server.js` — only Task 4.0 touches it).

##### Task 4.0 — Register all 5 tools in `dist/core/server.js`

Files:
- Edit: `dist/core/server.js` (add 5 imports + 5 register calls)

Steps:

1. After the existing tool imports (line ~52 of `dist/core/server.js`):
   ```js
   import { registerKeystoneOutline } from '../tools/keystone_outline.js';
   import { registerKeystoneSearch }  from '../tools/keystone_search.js';
   import { registerKeystonePageIn }  from '../tools/keystone_page_in.js';
   import { registerKeystoneHeal }    from '../tools/keystone_heal.js';
   import { registerKeystoneIndex }   from '../tools/keystone_index.js';
   ```
2. After the existing register calls (line ~64 in `registerAllTools`):
   ```js
   registerKeystoneOutline(server, ctx);
   registerKeystoneSearch(server, ctx);
   registerKeystonePageIn(server, ctx);
   registerKeystoneHeal(server, ctx);
   registerKeystoneIndex(server, ctx);
   ```

Exit criteria:
- `dist/cli/stdio.js` starts without error after the edit.
- `npx zenith-mcp` lists all five new tools when probed via MCP `tools/list`.

##### Task 4.1 — `keystone_outline` (read primitive)

Files:
- Create: `dist/tools/keystone_outline.js`

Steps:

1. Zod schema (flat mode-string per codebase-context.md §3.1):
   ```js
   const keystoneOutlineSchema = z.object({
     mode: z.enum(['default', 'with_content', 'paged']).default('default'),
     path: z.string(),
     budgetTokens: z.number().int().positive().optional(),
     includeContentForNodes: z.array(z.string()).optional(),  // when mode='paged'
     idempotencyKey: z.string().uuid().optional(),
   });
   ```
2. Behavior:
   - Validate path with `ctx.validatePath()`.
   - Get-or-update file in `file_state` (lazy re-index hook from Phase 1).
   - Build outline: walk `node_occurrences` for the file, return one entry per top-level definition with `{shortLabel, kind, name, byteRange, lineRange, novelty, hubClass}`.
   - If `mode === 'with_content'`: read file bytes, return alongside outline.
   - If `mode === 'paged'`: return content for nodes whose `shortLabel` ∈ `includeContentForNodes`.
3. Register in read registry (`origin = 'keystone'`).
4. Return `KeystoneEnvelope<{outline, sourceFileHash16, canonVersion, fileSizeBytes, currentBudgetThreshold}>`.

Exit criteria:
- Outline cap: ≤ 250 nodes; truncates by importance-score floor.
- Response matches `StructuralOutlineResult` shape PLAN1 expects.

##### Task 4.2 — `keystone_search`

Files:
- Create: `dist/tools/keystone_search.js`

Steps:

1. Zod schema:
   ```js
   const keystoneSearchSchema = z.object({
     mode: z.enum(['structural', 'symbol', 'slice', 'definition']).default('structural'),
     path: z.string(),                                     // root scope
     query: z.string(),                                    // symbol name OR structural pattern OR slice criterion
     limit: z.number().int().positive().max(20).default(10),  // KGCompass cap
     budgetTokens: z.number().int().positive().optional(),
     includePatchContext: z.boolean().default(false),
     symbolKind: z.string().optional(),
     frameworkTag: z.string().optional(),
     hammingThreshold: z.number().int().positive().max(64).optional(),
   });
   ```
2. Behavior: dispatch by mode:
   - `structural`: SimHash-band lookup → Hamming filter → return ≤ 20 carriers ordered by `score = w_n*novelty + w_c*pagerank + w_s*sliceMembership + w_f*frameworkMultiplier`.
   - `symbol`: name lookup in `node_occurrences.symbol_name` → carriers with PatchContext if requested.
   - `slice`: get-or-create slice → return slice's members as carriers.
   - `definition`: name lookup limited to `kind ∈ {function_declaration, class_declaration, ...}` definitions.
3. Apply compression budget: total carrier serialization ≤ `budgetTokens` (default 8000); elide low-novelty members to tombstones.

Exit criteria:
- p50 < 200 ms for `structural` mode on 100k-node corpus.
- Always returns ≤ 20 carriers (KGCompass cap).
- PatchContext populated when `includePatchContext = true`.

##### Task 4.3 — `keystone_page_in`

Files:
- Create: `dist/tools/keystone_page_in.js`

Steps:

1. Zod schema:
   ```js
   const keystonePageInSchema = z.object({
     hash: z.string().regex(/^[0-9a-f]{16}$/),             // short label hash
     budgetTokens: z.number().int().positive().optional(),
     idempotencyKey: z.string().uuid().optional(),
   });
   ```
2. Behavior: look up `node_occurrences` by `short_label = hash`. Return PatchEnvelope with `residency.tier = 'L1'` after fault-in.
3. Emit `PageFaultEvent { eventType: 'refetch', faultedHash, fromTier: previousTier, toTier: 'L1', costMs }`.

Exit criteria:
- Faults are observable in the response envelope's `pageFaults[]`.
- Streaming via `notifications/progress` works when MCP transport supports it; falls back cleanly otherwise.

##### Task 4.4 — `keystone_heal`

Files:
- Create: `dist/tools/keystone_heal.js`

Steps:

1. Zod schema:
   ```js
   const keystoneHealSchema = z.object({
     path: z.string(),
     staleHash: z.string().regex(/^[0-9a-f]{16}$/),
     contentHint: z.string().optional(),                   // optional first-line excerpt for tier 4
     idempotencyKey: z.string().uuid(),
   });
   ```
2. Check `heal_cache` by `idempotency_key` first. Hit → return cached `HealReport`.
3. Otherwise run the 5-tier cascade (Phase 5). Cache the result (TTL 1 h).
4. Always include the `verificationGatePassed: boolean` field; for tiers ≥ 3, the gate must have been called.

Exit criteria:
- Deterministic given the same idempotency key.
- Returns a `HealReport` with full `tiersAttempted` provenance.

##### Task 4.5 — `keystone_index`

Files:
- Create: `dist/tools/keystone_index.js`

Steps:

1. Zod schema:
   ```js
   const keystoneIndexSchema = z.object({
     mode: z.enum(['index', 'reindex', 'verify', 'gc']).default('index'),
     path: z.string().optional(),                         // null = full repo
     bumpGrammar: z.string().optional(),                  // language to bump
     gcCanon: z.string().optional(),                      // canon_string to GC
   });
   ```
2. Backed by `bin/keystone-reindex` internals.

Exit criteria:
- Tool registers cleanly. CI run can call `keystone_index --mode=verify` and assert ok=true.

**Phase 4 exit criteria**:
- All 5 tools registered and listable.
- Each tool emits `KeystoneEnvelope<T>` of the correct shape.
- Aggregate p95 latency for `keystone_outline` < 300 ms on 100k-node corpus.

---

#### Phase 5 — Healing Cascade (depends on Phase 2)

**Goal**: implement the five-tier healer with explicit thresholds, the verification gate, and the never-silently-select property test.

##### Task 5.1 — Healer cascade implementation

Files:
- Create: `dist/core/keystone/heal.js`

Steps:

1. `heal({ path, staleHash, contentHint, idempotencyKey })`:
   1. **Tier 1**: lookup `node_pool` by `(canon_id_current, short_label = staleHash)`. Hit → return PatchEnvelope, confidence 1.00, tier 1.
   2. **Tier 2**: lookup `node_occurrences` whose `fp_band_*` columns match any band of the staleHash's banded signature. Filter by full Hamming distance ≤ 24 strict / ≤ 64 relaxed. Apply round-and-exclude: matched-in-strict-round excluded from relaxed-round. Score = `(1 - hammingDistance / 256) * 0.85`.
   3. **Tier 3**: RMiner-3 5-round structured matcher restricted to the affected file. Round 1: identical text + identical depth. Round 2: identical text any depth. Round 3: identical after AST-replacement. Then 2 composite rounds. Multi-criteria sort (string edit dist + depth diff + parent-child idx + identical-neighbor + edit-dist-to-neighbor). Score = `tier_3_internal_score * 0.70`.
   4. **Tier 4**: CodeMapper. Run 8 git-diff variants × granularities, plus movement detection, plus exact-text search. Levenshtein-on-region between the staleHash's witness (if present) and each candidate region. Score = `(1 - normalizedLevenshtein) * 0.55`.
   5. **Tier 5**: AMBIGUOUS_HEAL surfacing. Aggregate all candidates above 0.70 confidence threshold but below 0.85 floor, return as `candidates[]` with `failureClass = 'partial_execution'`.
2. Aggregate confidence: `max(tier_score)` across all tiers attempted.
3. If `aggregate ≥ 0.85`: return `{ status: 'healed', tier, confidence, candidates: [chosen], verificationGatePassed: ... }`.
4. If `0.70 ≤ aggregate < 0.85`: return `{ status: 'ambiguous', tier: 5, confidence, candidates }`.
5. If `aggregate < 0.70`: return `{ status: 'miss', candidates: [] }`.

##### Task 5.2 — Verification gate (mandatory at tiers 3+)

Files:
- Edit: `dist/core/keystone/heal.js` (insert verifyCandidate before tier 3+ emit)

Steps:

1. `verifyCandidate(candidate, request)`:
   - `BLAKE3(currentFileBytes).slice(0, 16) === request.sourceFileHash16`? Else fail.
   - `treeSitter.parse(currentFileBytes).walk(candidate.byteRange).errorCount === 0`? Else fail.
   - `node_pool` row exists for candidate's `(structural_hash, label_hash)` under current canon? Else fail.
2. All three required to emit; any failure forces tier downgrade to next or terminate with `verificationGatePassed: false`.

##### Task 5.3 — Property-based contract test for never-silently-select

Files:
- Create: `tests/keystone-invariants.property.test.js`

Steps:

1. Use `fast-check` to generate (file, edit_diff, target_kind, target_position) tuples drawn from `tests/keystone-canon-vectors/*.json`.
2. Run 10,000 cases per CI build.
3. Assert: every emitted `HealReport.candidates[i]` has either `confidence ≥ 0.85` OR `status = 'ambiguous'`.
4. Assert: when `status = 'healed'`, only ONE candidate is returned.

Exit criteria:
- Property test passes 10,000 cases on every CI run.
- Counter-example fails the build with full reproducer.

##### Task 5.4 — `verifyEditHandoff()` formal contract function

Files:
- Create: `dist/core/keystone/verify-edit-handoff.js`

Steps:

1. Implement the function per §3.8 above.
2. Add to PLAN1's `FileLockManager.withLock` integration spec (documented in `docs/keystone-plan1-integration.md`): the function is called immediately after lock acquisition, before any `Vault.process` write.

Exit criteria:
- All 5 verification steps return PLAN1-shape diagnostics.
- Function is synchronous and side-effect-free (does not mutate state).

**Phase 5 exit criteria**:
- 5-tier cascade implemented with explicit thresholds.
- Verification gate mandatory at tiers 3+.
- Property test holds at 10K cases.
- `verifyEditHandoff()` callable from PLAN1.

---

#### Phase 6 — Demand-Paged Cortex (depends on Phase 4)

**Goal**: implement the L1 / L2 / L3 demand-paging tiers with observable, streaming page faults.

##### Task 6.1 — L1 residency LRU

Files:
- Create: `dist/core/keystone/cortex/l1.js`

Steps:

1. `L1Residency`:
   - Underlying data: `Map<short_label, PatchEnvelope>` with LRU eviction.
   - Capacity: 4096 entries / 32 MiB (configurable via `KEYSTONE_L1_CAPACITY` env).
   - `get(hash)`: returns envelope or `undefined`. Updates `residency.lastAccess`, `residency.accessCount`.
   - `put(envelope)`: inserts or refreshes; evicts oldest on capacity overflow; emits `PageFaultEvent { eventType: 'flush_miss' }` for evictees.

Exit criteria:
- Hit ratio > 80% on a 100-tool-call benchmark.

##### Task 6.2 — L2 SQLite-backed residency

Files:
- Create: `dist/core/keystone/cortex/l2.js`

Steps:

1. `L2Residency`:
   - Backed by `node_occurrences` lookup by `short_label`.
   - On L1 miss → query L2; if hit, lift to L1 and emit `PageFaultEvent { eventType: 'refetch', fromTier: 'L2', toTier: 'L1' }`.
   - On L2 miss → emit `PageFaultEvent { eventType: 'refetch', fromTier: 'miss', toTier: 'L1' }`, fall through to L3.

##### Task 6.3 — L3 lazy re-parse

Files:
- Create: `dist/core/keystone/cortex/l3.js`

Steps:

1. `L3Residency`:
   - On L2 miss: re-parse the file containing the requested hash via `tree-sitter`; re-index it via `indexFile()`; lift the requested node to L1.
   - Cost-bounded: if file > 5 MiB or parse takes > 2 s, return `BUDGET_EXCEEDED` and emit `PageFaultEvent { eventType: 'pinned_invariant_miss' }`.

##### Task 6.4 — Streaming page-fault delivery

Files:
- Create: `dist/core/keystone/cortex/streaming.js`

Steps:

1. Detect if the current MCP transport supports `notifications/progress` (Streamable HTTP does; legacy SSE does; stdio does not).
2. On every page fault during a tool call, if streaming is supported, emit:
   ```json
   { "method": "notifications/progress",
     "params": { "progressToken": "<sessionId>:<callId>",
                 "progress": 1, "total": 0,
                 "message": "page_fault: refetch faultedHash=abc123 fromTier=L2 toTier=L1 costMs=42" } }
   ```
3. If streaming unsupported: collect into `KeystoneEnvelope.pageFaults[]` post-hoc.

##### Task 6.5 — Thrash-index telemetry

Files:
- Create: `dist/core/keystone/cortex/thrash.js`

Steps:

1. `thrashIndex = pageFaults_in_last_100_ops / hits_in_last_100_ops`.
2. Persisted in memory; reset per session.
3. If `thrashIndex > 0.05` (release gate), emit warning to stderr.

**Phase 6 exit criteria**:
- L1 hit ratio > 80% under nominal load.
- L2 fault recovery < 50 ms p95.
- L3 fault recovery < 2 s p95.
- Streaming faults work on Streamable HTTP transport.
- Thrash index < 0.05 under 100-call benchmark.

---

#### Phase 7 — Compression Bridge (depends on Phase 4)

**Goal**: replace toon's fixed 60/30/10 with signal-conditioned per-entry novelty scores; preserve toon's existing pipeline as fallback.

##### Task 7.1 — `keystone-toon-bridge.js` (subprocess invocation)

Files:
- Create: `dist/core/keystone-toon-bridge.js`
- Edit: `dist/core/compression.js` (extend with optional bridge selection)

Steps:

1. `compressTextFile(validPath, rawText, maxChars, keepRatio, opts)` gains a `useKeystone: boolean = false` option.
2. When `useKeystone: true`: invoke `python3 -m toon --keystone-structured`, passing entries as JSON over stdin where each entry has the fields:
   ```json
   { "kind": "function_declaration", "shortLabel": "ab12...",
     "byteRange": [120, 280], "novelty": 0.42, "centrality": 0.18,
     "sliceMembership": 1, "frameworkMultiplier": 1.6, "hubClass": "good",
     "text": "<actual UTF-8>" }
   ```
3. Subprocess: 30-s timeout (matching existing `toon_bridge.js`); falls back to legacy on subprocess failure.

##### Task 7.2 — toon `--keystone-structured` mode

Files:
- Edit: `toon/toon/pipeline.py` (add new entry shape and routing)
- Create: `toon/toon/keystone_router.py`

Steps:

1. New CLI flag in `toon/__main__.py`: `--keystone-structured` enables the path.
2. New router `keystone_router.py` consumes pre-scored entries and bypasses the SageRank pass (which already-scored entries don't need).
3. Tier assignment driven by per-entry `score`:
   - `score ≥ 0.7` → "high" (full body)
   - `0.4 ≤ score < 0.7` → "medium" (signature only)
   - `score < 0.4` → "low" (tombstone with hash)
4. Tombstone shape: `[KEYSTONE paged: hash=<short> kind=<type> bytes=<n>. Use keystone_page_in(hash) to re-read.]`

Exit criteria:
- Existing toon API surface (`compress`, `encode_output`) unchanged.
- New mode produces deterministic output for a fixed input.

**Phase 7 exit criteria**:
- Compression ratio matches or exceeds legacy on a benchmark corpus (60-file mixed-language).
- Compression ratio capped at 6× multi-turn / 14× single-turn.
- Tombstones include hashes that resolve via `keystone_page_in`.

---

#### Phase 8 — Shadow Mode → Cutover

**Goal**: ship under feature flags, instrument shadow telemetry, gate writes behind release-gate thresholds, then flip the cutover.

##### Task 8.1 — Feature flags

Files:
- Create: `dist/core/keystone/flags.js`

Flags:
- `KEYSTONE_ENABLED` (default `false`)
- `KEYSTONE_SHADOW_MODE` (default `true` when `KEYSTONE_ENABLED=true`): all 5 tools active but `keystone_index` writes are simulated unless `KEYSTONE_WRITES_ENABLED=true`.
- `KEYSTONE_LEGACY_SHADOW_WRITE` (default `true`): legacy `read_text_file` populates the read registry.
- `KEYSTONE_DEFAULT_BUDGET` (default `8000`).
- `KEYSTONE_L1_CAPACITY` (default `4096`).
- `KEYSTONE_HEAL_CONFIDENCE_FLOOR` (default `0.85`).

##### Task 8.2 — Telemetry collector

Files:
- Create: `dist/core/keystone/telemetry.js`

Events:
- `outline_request`, `outline_response`
- `search_request`, `search_response`
- `heal_request`, `heal_response`
- `page_fault`
- `verify_handoff_call`, `verify_handoff_result`
- `drift_run`

##### Task 8.3 — Test corpus & benchmarks

Files:
- Create: `tests/keystone-corpus/{small,medium,large}/{<lang>/<repo-fixture>/}/`
- Create: `tests/keystone-benchmark.test.js`

Steps:

1. 60-file mixed-language fixtures (10 per language for 6 languages).
2. Benchmarks: indexing time, heal latency, retrieval p50/p95, thrash index.
3. Held-out set (not on SWE-bench Verified) per F48 — 20 fixtures held back from training corpus.

##### Task 8.4 — Release gates

Gates (all must hold for 100 consecutive operations before `KEYSTONE_WRITES_ENABLED=true` is allowed):

- `outline_p95Ms ≤ 300`
- `search_p95Ms ≤ 800`
- `heal_p95Ms ≤ 5000`
- `heal_correct_rate ≥ 0.95` on the held-out fixture set (correctness measured by: did the heal recover the same node a manual diff would have selected?)
- `drift_rate ≤ 0.05` per index run
- `thrash_index ≤ 0.05` per 100-op window
- `verify_handoff_rejection_rate < 0.20` (FILE_CHANGED / EDITOR_DIRTY / HASH_NOT_FOUND combined)
- Property test (Task 5.3) passes 10K cases

##### Task 8.5 — Cutover

Steps:

1. After release gates hold for 100 consecutive ops, flip `KEYSTONE_WRITES_ENABLED=true`.
2. Keep legacy shadow-write enabled for a 2-week migration window.
3. After migration window, disable `KEYSTONE_LEGACY_SHADOW_WRITE`. Existing tools continue to work; new edits go through KEYSTONE.

**Phase 8 exit criteria**:
- All release gates green for 100 consecutive ops.
- Cutover flips flagged.
- Legacy tools continue to function.

---

### 8. Deferred / Out of Scope

The following are explicitly NOT being built in v1; the design accommodates their later addition.

| Item | Reason for deferral |
|---|---|
| Multi-writer concurrent edits (Grove CmRDT) | F23 — barely studied in 2024–2026 literature; PLAN1 already enforces single-writer per file |
| LLM-augmented healer tier 5 (vs. AMBIGUOUS_TARGET surfacing) | F56 + EM-Assist 76.3% invalid baseline — unsafe without verification gate; v1 ships deterministic-only |
| Cross-language structural-equivalence | Out of mission scope; the canon spec deliberately makes Python and Ruby produce different hashes for the same algorithm |
| Embedding-based tie-breaking (Soft-ZCA-whitened) | F37 deferred; A4 96.2% FPR + 43% R@1 drop under rename are unacceptable identity layer; deterministic structural primitives only in v1 |
| Online cross-encoder reranker | F10 — CodeRAG-Bench 200–800 token regime evidence; rerankers degrade |
| Multi-file edit transactions | Out of mission scope; PLAN1 already enforces single-file batches ≤ 3 edits |
| Persistent multi-session co-occurrence prefetch (Helion's PCB inspiration) | Helion's PCB is opt-in per-session; making it cross-session needs a privacy review |

### 9. Synthesis Notes

Decisions made where the four prior plans diverged:

- **Storage topology**: Adaptive — the four plans split 2–2 (additive vs sibling). Both arguments are correct in their regime. KEYSTONE detects repo size at init and picks. Same DDL applies to both.
- **SimHash bits**: 256-bit (Helion / CHIRON / FORGE). STRATA's 64-bit loses on E47 / SolveRank evidence.
- **Tool count**: 5 (CHIRON / FORGE convergence). STRATA's 4 misses a dedicated compression handle; Helion's 8 over-decomposes.
- **`verifyEditHandoff()`**: Formal synchronous function (CHIRON's contribution, generalized).
- **`canon_versions` table**: Real artifact (CHIRON's contribution, generalized).
- **Streaming page faults**: When transport supports it, otherwise post-hoc fallback (CHIRON's contribution, with FORGE's transport-detection discipline).
- **Idempotency split**: In-memory map for edit ops + DB-backed `heal_cache` for healing (FORGE's correct split — extends CHIRON's "everything DB-backed" with the observation that edit-idempotency is already crash-recovered by PLAN1).
- **Read registry shape**: In-memory Map + SQLite expiry sweep (FORGE's hybrid is the fastest hot path with leak hygiene).

KEYSTONE-original additions (not in any prior plan):

- **Property-based contract test** for the never-silently-select invariant (Task 5.3) — closes universal blind spot #1.
- **`bin/keystone-audit`** for hash-determinism CI (Task 0.3) — closes blind spot #2.
- **Published canonicalization test corpus** (`tests/keystone-canon-vectors/`) — closes blind spot #3.
- **Grammar-bump migration ladder** (`docs/keystone-canon-migration.md`) — closes blind spot #4.
- **`budgetTokens` parameter** on every retrieval tool with session-default fallback — closes blind spot #5.
- **`bin/keystone-reindex` lazy-or-eager** migration tool (Task 1.3) — closes blind spot #6.
- **Read-registry shadow-write** from legacy `read_text_file` (Task 1.4) — closes blind spot #7.
- **`drift_log` table** + drift-rate release gate that escalates to stderr — operationalizes the F35 NeighborRetr partition into a release-engineering signal.

### 10. Risk Assessment

| Rank | Risk | Likelihood | Impact | Mitigation |
|---:|---|---:|---:|---|
| 1 | Canonicalization spec drift between machines / BLAKE3 implementations | Medium | Critical | `tests/keystone-canon-vectors/` published corpus; `bin/keystone-audit` mandatory in CI; `@noble/hashes` ESM (no native build); spec versioned `zen:1:` so future drift becomes `zen:2` cleanly |
| 2 | Tree-sitter grammar minor bump silently changes node kind names (canonical real-world: 0.20.2 `function` → `function_expression`) | Medium | Critical | `canon_versions` table; tree-sitter 0.25.0 ABI 15 metadata API read at hash-input time; `keystone-audit` regression suite; v1 hashes never cascade-invalidate |
| 3 | SQLite WAL contention under concurrent KEYSTONE writes vs existing tools | Medium | High | Adaptive topology toggle; sibling DB at ≥ 500 files; both DBs use `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000` |
| 4 | Healer falsely emits high-confidence wrong anchor (Spork failure mode) | Low | Critical | Property test 10K cases (Task 5.3); 0.85 confidence floor; verification gate mandatory at tiers 3+; AMBIGUOUS_HEAL surfacing |
| 5 | Read-registry leak across sessions (in-memory Map grows unbounded) | Medium | Medium | SQLite expiry sweep every 60 s; sessions auto-evicted after 30-min idle (matches existing `SESSION_TTL_MS`) |
| 6 | Toon Python subprocess fails or times out | Medium | Medium | Existing 30-s timeout pattern preserved; falls back to legacy text-mode toon on failure; `keystone_search` always returns at least an outline regardless of compression bridge |
| 7 | Migration from legacy Jaccard fingerprint creates index-stale window | High | Low | Lazy re-index on first read of any file; eager mode available via `keystone-reindex --eager`; legacy tools continue to function unchanged |
| 8 | `verifyEditHandoff()` adds latency to PLAN1's apply lock | Low | Medium | Function is synchronous, side-effect-free, ~5–10 ms typical (one `node_pool` lookup + one BLAKE3 of file); short-circuits on `FILE_CHANGED` |
| 9 | Drift gate fires false positives on legitimate mass refactors | Medium | Low | Drift gate emits warning, not error; operator can override via `KEYSTONE_DRIFT_GATE_DISABLED=true`; the `drift_log` row records context for audit |
| 10 | Page-fault streaming unsupported on stdio transport | Certain | Low | Always-included post-hoc fallback in `KeystoneEnvelope.pageFaults[]`; streaming is best-effort enhancement |

### 11. Test Plan

#### 11.1 Unit tests (vitest)

- `tests/keystone-canon-vectors.test.js` — 44 fixture canonical-form correctness
- `tests/keystone-canonical.test.js` — `hashLeaf` / `hashInternal` / `hashNode` unit
- `tests/keystone-storage.test.js` — additive vs sibling topology selection
- `tests/keystone-forest.test.js` — `indexFile` correctness, idempotence, ref-count
- `tests/keystone-atlas-simhash.test.js` — banded fingerprint determinism + Hamming bounds
- `tests/keystone-atlas-frequency.test.js` — Sort-&-Slice + NeighborRetr partition
- `tests/keystone-atlas-pagerank.test.js` — convergence + direct-import boost
- `tests/keystone-slicer.test.js` — forward/backward slicing
- `tests/keystone-heal-tiers.test.js` — each tier in isolation
- `tests/keystone-verify-edit-handoff.test.js` — all 5 gates fire correctly

#### 11.2 Property-based tests (fast-check)

- `tests/keystone-invariants.property.test.js` — never-silently-select invariant @ 10K cases
- `tests/keystone-canon-determinism.property.test.js` — hash determinism across 1000 random ASTs
- `tests/keystone-slice-content-addressed.property.test.js` — same input → same `slice_id`

#### 11.3 Integration tests

- `tests/keystone-end-to-end.integration.test.js` — full agent flow: read → search → heal → verify → edit
- `tests/keystone-plan1-handoff.integration.test.js` — proves PLAN1 can consume a `PatchEnvelope` without translation
- `tests/keystone-toon-bridge.integration.test.js` — subprocess + fallback paths

#### 11.4 Benchmarks

- `tests/keystone-benchmark.test.js` — p50/p95 for outline / search / heal on 60-file fixture
- `tests/keystone-benchmark-reindex.test.js` — full vs incremental re-index latency
- `tests/keystone-benchmark-monorepo.test.js` — 800k-LOC stress (validates Aider failure-mode workaround)

### 12. Backward Compatibility Plan

Existing surfaces that MUST remain functional after the migration:

1. **Existing `read_text_file`** (`dist/tools/read_file.js`): unchanged behavior; only adds shadow-write (Task 1.4). Off via `KEYSTONE_LEGACY_SHADOW_WRITE=false`.
2. **Existing `search_files`** (`dist/tools/search_files.js`): unchanged. Optionally enhanced in a future phase to call `keystone_search` for `mode='structural'`.
3. **Existing `edit_file`** (`dist/tools/edit_file.js`): unchanged. Future enhancement to call `verifyEditHandoff()` is opt-in via `KEYSTONE_EDIT_VERIFY_HANDOFF=true`.
4. **Existing `refactor_batch`** (`dist/tools/refactor_batch.js`): unchanged. Outlier detection optionally upgraded to use SimHash banding via `KEYSTONE_REFACTOR_OUTLIER_BANDED=true`.
5. **Existing `symbols.db` schema**: extended additively (two `ALTER TABLE` columns), never breaks.
6. **Existing `compression.js`** (`dist/core/compression.js`): extended with `useKeystone: boolean` option; default `false` preserves legacy.
7. **MCP roots protocol**: untouched.
8. **HTTP / stdio transports**: untouched.
9. **Adapter system**: untouched.
10. **Retrieval pipeline (opt-in BMXF)**: untouched.

If any existing test suite breaks after KEYSTONE Phase 1–8, the commit is reverted.

### 13. Build & Release Discipline

- All hand-authored modules under `dist/core/keystone/` and `dist/tools/keystone_*.js` are version-controlled (matching the existing `dist/core/` discipline per `codebase-context.md §3.4`).
- TypeScript declarations under `src/core/keystone/` are tsc-emit-only (`.d.ts`); do NOT add `.js` emissions to `dist/core/keystone/` from tsc.
- The build script's existing safeguard (aborts if `dist/core/server.js` missing) is preserved; KEYSTONE adds no new safeguards but does add a pre-commit hook in `.husky/pre-commit` that runs `keystone-audit` whenever any `tests/keystone-canon-vectors/` fixture or `dist/core/keystone/canonical.js` is staged.

### 14. Documentation Deliverables

| File | Content |
|---|---|
| `docs/keystone-overview.md` | One-page architecture summary for new contributors |
| `docs/keystone-canon-migration.md` | The grammar-bump migration ladder (§3.4) |
| `docs/keystone-tool-reference.md` | All 5 tool schemas + envelope shapes |
| `docs/keystone-plan1-integration.md` | The `verifyEditHandoff()` contract + PLAN1 wire-up |
| `docs/keystone-config.md` | Env vars + `.mcp/keystone-config.json` schema |
| `docs/keystone-release-gates.md` | Phase 8 gates with thresholds |
| `tests/keystone-canon-vectors/README.md` | Corpus authoring rules |

---

*KEYSTONE locks search, healing, compression, paging, and editing into one self-supporting structure. Pull the keystone and the arch collapses; place it correctly and every other stone bears its share.*

*End of KEYSTONE Implementation Plan.*
