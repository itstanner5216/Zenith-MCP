# CHIRON — Definitive Implementation Plan

> **CHIRON** — *Content-addressed Hash-Indexed Retrieval Of Nodes.* The name is load-bearing. Chiron, the centaur in Greek myth, was simultaneously the **healer** (he taught Asclepius medicine; CHIRON's healing cascade recovers stale anchors after edits) and the **teacher of heroes** (he tutored Achilles and Heracles; CHIRON teaches PLAN1's editor what to edit by handing it `EditCarriers` PLAN1 can consume verbatim). Six letters, six load-bearing pillars: **C**anonicalization (versioned `zen:1:` BLAKE3 spec), **H**eal cascade (five-tier deterministic recovery), **I**dentity index (HyperAST two-hash interned subtree forest), **R**etrieval atlas (banded 256-bit SimHash + Sort-&-Slice + Personalized PageRank), **O**bservable paging (ClawVM-style page faults as first-class diagnostics), **N**ovelty-driven compression (signal-conditioned toon bridge replacing fixed 60/30/10 ratios). The substrate is Zenith-MCP's; the contract is PLAN1's; the synthesis is CHIRON's.

This document is **the** plan. It is implementable as written. Quality and structure exceed `PLAN1.md` in file-level concreteness, schema specification, and risk discipline.

---

## 0. Mission, Locked Decisions, and Original Contributions

CHIRON replaces Zenith-MCP's Jaccard-3-gram structural fingerprint, MD5 file hash, and text-mode TOON bridge with a single content-addressed substrate that:

1. **Produces** the exact handoff PLAN1's editor consumes — `EditCarrier { sourceFileHash16, hash, parentHash, childType, childIndex, contentWitness, idempotencyKey, karyon_version }`.
2. **Heals** stale anchors via a five-tier deterministic cascade (exact → banded SimHash → RMiner-3 round-and-exclude → CodeMapper Levenshtein-on-region → AMBIGUOUS_TARGET surfacing) with confidence floor 0.85, never silently selects below threshold.
3. **Compresses** retrieved code at AST-node granularity using a *novelty-weighted, signal-conditioned* tier selection driven by Sort-&-Slice frequency atlas + NeighborRetr k-occurrence + Personalized PageRank centrality + framework multipliers — replacing toon's fixed 60/30/10 percentages.
4. **Indexes** structural identity, locality fingerprints, slice membership, and per-language framework atlases in **additive** `.mcp/symbols.db` tables, file-incrementally, with content-addressed differential cache invalidation.
5. **Demand-pages** symbols, slices, and outlines through a `chiron_fault_in` tool surface whose page-fault events stream out as part of every tool envelope (never silent), surfacing thrash index as an SLO.
6. **Witnesses** every handoff: read registry rejects `NEVER_READ`, content witness verifies under PLAN1's lock, idempotency keys are orchestrator-derived not argument-hashed.

### 0.1 Locked decisions (anchored to user constraints + research)

| Decision | Choice | Source |
|---|---|---|
| Hash function | BLAKE3-256, NNCP-MTH boundary keys (`LEAF_KEY = blake3("ZNCP NODE LEAF")`, `INTERNAL_KEY = blake3("ZNCP NODE INTERNAL")`) | F50, F58 |
| Two-hash discipline | Per-node `structural_hash` (kind + child structural hashes; identifiers stripped) AND `label_hash` (kind + child label hashes + identifier text); domain-separated leaf/internal | F6, F58, HyperAST ICSE 2022 |
| Short hash length | 16 hex chars (8 bytes / 64 bits) — matches PLAN1's `sourceFileHash16` convention | PLAN1 contract |
| Canonicalization | Versioned prefix `zen:1:` + grammar tuple `(language, abi_version, grammar_version)`; NEVER substituted; v1 and v2 hashes for the same source coexist | F50, F51, Tessera-4A |
| Storage | Existing `.mcp/symbols.db` extended with CHIRON tables; **NO** sibling DB | Codebase-context.md §3 hard rule; F18 |
| Locality fingerprint | **256-bit SimHash banded into 8 × 32-bit bands** (NOT 64-bit; 64-bit conflates boilerplate, F35/E47, SolveRank 12× P@1 collapse) | F22, F35, F52, A6 |
| Banding strict/relaxed | Hamming ≤ 24 strict / ≤ 64 relaxed (256-bit space) | Computed from F22 8-band geometry |
| Identity continuity | Five-tier heal cascade; confidence floor 0.85; never silent select | F52, F53, F54, F57, F60 |
| Compression policy | **Signal-conditioned per-entry novelty score**; multi-turn ratio cap 6×; single-turn cap 14× | F16, F19, B5 |
| Retrieval | Deterministic dataflow path always-on; banded SimHash + BM25 fuzzy lane; **NO** online cross-encoder reranker | F9, F10, A3, F33 |
| Tool schemas | Flat-mode-string Zod; **NO** discriminated unions | Codebase-context.md §3.1 user-memory hard rule |
| MCP tool count | **5 tools** — Tessera-3C MCPMark "naive iterative beats ReAct on small toolsets" + F44 | F44, A11, F45 |
| PLAN1 contract | Producer of PLAN1's read registry; honors all 14 PLAN1 diagnostic codes; adds **3** (BUDGET_PAGED, CANON_VERSION_MISMATCH, AMBIGUOUS_HEAL); never replaces | PLAN1 §29-80 |
| Idempotency | Orchestrator-derived UUID per F29; argument-hashed keys explicitly forbidden | F29, A13 |
| Witness | Mandatory `contentWitness` first 64 bytes on every state-mutating handoff | F28, A13 |
| File concurrency | Single-writer for v1; concurrent multi-writer (Grove CmRDT) deferred | F23 |
| Build discipline | All new `dist/core/chiron/*.js` and `dist/tools/chiron_*.js` are **hand-authored** (matches existing convention); only `dist/adapters`, `dist/config`, `dist/retrieval` remain tsc output | Codebase-context.md §3.4 |

### 0.2 Original contributions beyond STRATA and Helion

These are CHIRON-specific architectural choices not present in either prior draft, defended against the research:

1. **Streaming page-fault diagnostics.** Page faults are emitted *while* the response is being built (NDJSON tool-output stream where supported), not only attached to the final envelope. ClawVM (F41) names the failure mode as "silent state changes"; CHIRON makes faults observable in real time so model orchestrators can short-circuit before a slow fault completes. STRATA emits `pageFaults[]` post-hoc; CHIRON streams them.

2. **Symmetric handoff verifier `verifyEditHandoff()`.** A single function PLAN1's `FileLockManager` calls **inside** the apply lock that does: (i) re-check `sourceFileHash16`; (ii) re-check `contentWitness` against current bytes at `[byteRange]`; (iii) re-verify `(structural_hash, label_hash)` of the targeted node still exist in `node_pool`; (iv) detect canonicalization-version drift and emit `CANON_VERSION_MISMATCH` rather than `HASH_NOT_FOUND`. Helion describes the verifier in prose; STRATA references it in Phase 3.5; CHIRON specifies the exact synchronous function and integrates it as the formal contract surface.

3. **Drift-anomaly telemetry as a release gate.** k-occurrence drift (a node previously k=2 jumping to k=42 between two index runs) is a structural anomaly — usually generated code being committed, sometimes a refactor. CHIRON tracks `k_occurrence_delta_p99` per index run as a release-gate metric; if a single index run causes >5% of pool entries to flip hub_class, the run is held back for human review. Neither prior plan instruments this.

4. **The unified `PatchEnvelope` carrier.** A single typed structure that simultaneously carries:
   - The `EditCarrier` (PLAN1 edit target);
   - The `PatchContext` (Refine `(DD, CD, IC, CG)`);
   - The graph-walk `pathTrace` (KGCompass requirement, F34);
   - The atlas scores (`novelty`, `centrality`, `hub_class`);
   - The Cortex residency (where this hash currently lives — L1, L2, L3);
   - The fault history for the carrier (how many faults paid to surface it).

   Helion has separate `EditCarrier` and `pathTrace`. STRATA has separate `SIR` and `PatchContext`. CHIRON unifies — one carrier, one shape, every PLAN1 edit can be constructed from it without join logic.

5. **Bidirectional canonicalization registry.** A new `canon_versions` table stores every `(zen_alg, language, abi, grammar_version)` tuple ever seen, so the engine can:
   - Render a v1 hash even when the live grammar is v2 (for legacy edit replay);
   - Refuse a v2 hash against a v1-only-indexed file (`CANON_VERSION_MISMATCH`);
   - Cross-walk hashes during a grammar bump migration without cascade invalidation.

   This is F51's "v1 and v2 coexist indefinitely" implemented as a real table, not a comment.

6. **Outline-first read tool with budget-aware content paging.** `chiron_outline` returns the structural outline by default; `mode='with_content'` returns full content; `mode='paged'` returns content for *only* requested node hashes (PLAN1 Task 5.1's `includeContentForNodes`, but driven by hash, not by index). This is the read primitive PLAN1 was designed to consume.

### 0.3 Why CHIRON, not STRATA, not Helion

| Property | STRATA | Helion | CHIRON |
|---|---|---|---|
| Schema | additive in `symbols.db` ✓ | sibling `karyotype.db` ✗ | additive in `symbols.db` ✓ |
| Tool count | 4 ✓ | 8 ✗ (F44) | 5 ✓ |
| SimHash bits | 64 (E47 risk) | 256 ✓ | 256 ✓ |
| Read registry as DB table | ✓ | text only | ✓ |
| Canonicalization v1↔v2 coexistence | comment | comment | **real `canon_versions` table** |
| Streaming page faults | post-hoc only | post-hoc only | **streaming + post-hoc** |
| Unified `PatchEnvelope` | separate `SIR` + `PatchContext` | separate `EditCarrier` + `pathTrace` | **single carrier** |
| Symmetric handoff verifier | prose | prose | **specified function** |
| Drift-anomaly release gate | no | no | **yes** |
| Idempotency cache TTL | 1h memory | 1h memory | **1h DB-backed** (survives restart for replay safety) |
| File-level paths to insertion line | yes | yes | yes — and **insertion-point line numbers** match the audited files |

CHIRON inherits STRATA's database additivity and read registry, Helion's 256-bit SimHash and per-tier bloom of refs, and contributes the unified envelope, the canonicalization registry, the streaming faults, the verifier, and the drift telemetry.

---

## 1. Public Interfaces — Final TypeScript signatures

These appear in `src/core/chiron/types.ts` (tsc-compiled) and re-exported through `dist/core/chiron/index.js` (hand-authored). Every interface is final.

### 1.1 Core domain types

```ts
// src/core/chiron/types.ts

/**
 * Versioned canonicalization identifier — encoded into every hash input.
 * Coupling between (zen algorithm, grammar) is intentionally never broken (F51).
 */
export interface CanonVersion {
  algorithm: "zen:1";                       // bumps with canonicalization-rule change
  language: string;                         // "typescript", "python", ...
  abiVersion: number;                       // tree-sitter ABI (read from grammar metadata, ≥15)
  grammarVersion: string;                   // tree-sitter-{lang} crate version, e.g. "0.21.4"
}

/**
 * Two parallel BLAKE3-256 hashes per node (HyperAST two-hash discipline, F6).
 * structural: kind + child structural hashes (labels stripped) — survives rename/reformat
 * label:      kind + child label hashes + identifier text — breaks on rename
 */
export interface NodeHash {
  structural: string;                       // 64 hex chars (BLAKE3-256 full)
  label: string;                            // 64 hex chars
  short: string;                            // first 16 hex of label_hash; PLAN1-compatible
  shortStructural: string;                  // first 16 hex of structural_hash; for pool joins
}

/**
 * 256-bit SimHash banded into 8 × 32-bit windows.
 * 32-bit bands required (not 8-bit) per E47/SolveRank: 64-bit total bits conflate
 * boilerplate functions; 256 bits with 32-bit bands gives clean separation.
 */
export interface LocalityFingerprint {
  simhash256: string;                       // 64 hex chars (256 bits)
  bands: readonly [string, string, string, string,
                   string, string, string, string]; // each 8 hex chars (32 bits)
  populationCount: number;                  // 0..256; used for hubness scoring
}

/**
 * The PatchEnvelope — the single carrier type every CHIRON tool emits.
 * It is the unified handoff surface; PLAN1's EditDocumentRequest reads its
 * `target.*` fields directly. (CHIRON contribution; no analogue in STRATA or Helion.)
 */
export interface PatchEnvelope {
  // ── PLAN1 EditDocumentRequest target fields (consumed verbatim) ──
  path: string;                             // relative to repoRoot
  sourceFileHash16: string;                 // first 16 hex of file BLAKE3
  hash: string;                             // first 16 hex of node label_hash
  shortStructural: string;                  // first 16 hex of structural_hash
  parentHash: string | null;                // null only at file root
  childType: string;                        // tree-sitter named-child kind
  childIndex: number;                       // 0-indexed within parent's same-childType children
  contentWitness: string;                   // first 64 bytes UTF-8 of node text
  symbol?: { name: string; symbolType: string; scope: string | null };

  // ── Geometry (informational; PLAN1 ignores) ──
  byteRange: [number, number];              // half-open
  lineRange: [number, number];              // 1-based start, inclusive end

  // ── Versioning (CANON_VERSION_MISMATCH guard) ──
  canonVersion: CanonVersion;               // emitted at index time; MUST match at edit time

  // ── Patch Context (Refine F31; KGCompass cap 20) ──
  patchContext?: {
    dataDeps: SiblingRef[];                 // backward slice depth ≤ 2
    controlDeps: SiblingRef[];              // enclosing control-flow ancestors
    interfaceContracts: TypeContract[];     // signatures.scm captures
    callGraph: SiblingRef[];                // forward slice depth ≤ 1
    intentSummary?: string;                 // optional one-line summary
  };

  // ── Atlas scores (drive compression + ranking) ──
  scores?: {
    novelty: number;                        // [0,1]; higher = rarer subtree
    centrality: number;                     // Personalized PageRank score
    sliceMembership: number;                // count of slices containing this hash
    frameworkMultiplier: number;            // 1.0..3.2 (F39)
    hubClass: "anti" | "good" | "bad";      // NeighborRetr partition
  };

  // ── Graph-walk path that surfaced this carrier (KGCompass F34) ──
  pathTrace?: Array<{
    fromHash: string;
    toHash: string;
    edgeType: "call" | "data" | "control" | "def" | "structural" | "import";
    depth: number;
  }>;

  // ── Cortex residency at the moment the carrier was built ──
  residency?: {
    tier: "L1" | "L2" | "L3" | "miss";
    lastAccess: number;                     // epoch ms
    accessCount: number;
  };

  // ── Page-fault history for this carrier in the current operation ──
  faults?: PageFaultEvent[];
}

export interface SiblingRef {
  hash: string;                             // 16 hex
  shortStructural: string;
  path: string;
  childType: string;
  byteRange: [number, number];
  hopDistance: number;                      // 0 = anchor; 1+ = transitive
}

export interface TypeContract {
  symbolName: string;
  signature: string;                        // raw signature text
  arity: number;
  returnTypeText: string | null;
}

/**
 * Page-fault event (ClawVM taxonomy, F41).
 * Emitted as a streaming event AND included in tool envelope's `faults[]`.
 */
export interface PageFaultEvent {
  eventType: "refetch" | "duplicate_tool" | "pinned_invariant_miss"
            | "post_compaction_bootstrap" | "silent_recall" | "flush_miss";
  faultedKey: string;                       // node label_hash16 or slice_id
  fromTier: "L1" | "L2" | "L3" | "miss";
  toTier: "L1" | "L2";
  costMs: number;
  thrashIndex: number;                      // events / hits over last 100 ops
  occurredAt: number;                       // epoch ms
}

/**
 * Healing report (F60; Spork cost-asymmetry F54 surface).
 */
export interface HealReport {
  status: "healed" | "ambiguous" | "miss";
  tier: 1 | 2 | 3 | 4 | 5;                  // 5 = surfaced ambiguity
  confidence: number;                       // [0,1]; tier_confidence × tier_weight
  best?: PatchEnvelope;                     // present only when status === "healed"
  candidates: PatchEnvelope[];              // ≥ 1 when ambiguous; full envelopes
  failureClass?: "argument_hallucination"
              | "invalid_invocation"
              | "partial_execution"
              | "structural_break";
  recommendation?: string;                  // F42 — Inductivee envelope discipline
  exampleValidCall?: object;
  idempotencyKey: string;
  pageFaults: PageFaultEvent[];
  budgetUsed: { wallMs: number };
}

/**
 * Diagnostic envelope — every CHIRON tool response uses this shape.
 * Inductivee discipline: include `suggestedAction` and `exampleValidCall` for
 * higher self-correction success (F42).
 */
export interface ChironEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: PLAN1DiagnosticCode | ChironDiagnosticCode;
    shortMessage: string;
    hints: string[];
    suggestedAction?: string;
    exampleValidCall?: object;
    candidates?: PatchEnvelope[];
  };
  attempts: number;
  pageFaults: PageFaultEvent[];
  budgetUsed: { bytes: number; tokens: number; wallMs: number };
  canonVersion: CanonVersion;
}

export type PLAN1DiagnosticCode =
  | "NEVER_READ" | "FILE_CHANGED" | "EDITOR_DIRTY" | "HASH_NOT_FOUND"
  | "AMBIGUOUS_TARGET" | "SYMBOL_TARGET_UNAVAILABLE" | "BUDGET_EXCEEDED"
  | "BOUNDARY_VIOLATION" | "STRUCTURE_BROKEN" | "PATH_UNSAFE"
  | "PATH_MISMATCH" | "OVERLAPPING_EDITS" | "WRITE_VERIFY_FAILED"
  | "RESTORE_FAILED" | "LOCK_LOST";

export type ChironDiagnosticCode =
  | "BUDGET_PAGED"               // budget exhausted; tombstones returned
  | "CANON_VERSION_MISMATCH"     // v1 hash against v2-indexed file or vice versa
  | "AMBIGUOUS_HEAL";            // healing produced multiple plausible candidates
```

### 1.2 Architecture diagram

```text
┌─────────────────────────────────────────────────────────────────────┐
│             MCP Tool Surface  (stdio + HTTP)                        │
│  chiron_outline   chiron_search   chiron_fault_in   chiron_heal     │
│                          chiron_compress                            │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
                  ┌───────────────┴───────────────┐
                  │  Read Registry  +  Idempotency │
                  │  (DB-backed; F26, F28, F29)    │
                  └───────────────┬───────────────┘
                                  │
                  ┌───────────────┴───────────────┐
                  │  Demand-Page Manager (Cortex)  │
                  │  L1 LRU 4096 / L2 SQLite /     │
                  │  L3 file re-read (streaming    │
                  │  fault events, F41)            │
                  └─┬──────────┬──────────────────┘
                    │          │
            ┌───────┘          └───────┐
            ▼                          ▼
    ┌──────────────────┐         ┌──────────────────┐
    │  Atlas / Heal    │         │  Slicer / PCT    │
    │  atlas.js         │         │  slicer.js        │
    │  heal.js          │         │  patch_context.js │
    └─────┬────────────┘         └─────┬────────────┘
          │                            │
          ▼                            ▼
    ┌────────────────────────────────────────────┐
    │  Lazy Subtree Forest (LSF)                 │
    │  lsf.js + node_pool + node_occurrence       │
    │  • interned subtree DAG                    │
    │  • per-pool 256-bit SimHash + bloom-of-refs│
    └────────────┬───────────────────────────────┘
                 │
                 ▼
    ┌────────────────────────────────────────────┐
    │  Hash Forge                                │
    │  canonicalize.js + node_hash.js + canon_meta│
    │  • domain-separated leaf/internal keys     │
    │  • two-hash discipline                     │
    │  • canon_versions registry (CHIRON contrib) │
    └────────────┬───────────────────────────────┘
                 │
                 ▼
    ┌────────────────────────────────────────────┐
    │  web-tree-sitter v0.26.x (existing)        │
    │  Lazy WASM grammars + paired-capture .scm  │
    └────────────────────────────────────────────┘

  ── Side channel: PLAN1 verification ──
    ┌────────────────────────────────────────────┐
    │  verifyEditHandoff()                       │
    │  Called by PLAN1's FileLockManager UNDER   │
    │  the apply lock; rechecks sourceFileHash16 │
    │  + contentWitness + canon_version + node   │
    │  pool membership in one synchronous pass.  │
    └────────────────────────────────────────────┘

  ── Side channel: toon Python ──
    ┌────────────────────────────────────────────┐
    │  toon_bridge_chiron.js → python3 -m toon   │
    │  --chiron-structured (per-entry novelty)   │
    └────────────────────────────────────────────┘
```

### 1.3 The `verifyEditHandoff` function (CHIRON contribution; PLAN1's lock contract)

```ts
// src/core/chiron/verify_edit_handoff.ts (hand-authored .js mirror)
//
// Called BY PLAN1's FileLockManager INSIDE the apply lock (synchronous).
// Single pass: every check is O(1) DB lookup or O(witnessBytes) byte compare.
// Returns null on success; returns a typed PLAN1 diagnostic on failure.

export interface EditHandoffRequest {
  path: string;
  sourceFileHash16: string;
  target: {
    hash: string;                           // label_hash16
    parentHash?: string | null;
    childType?: string;
    childIndex?: number;
    contentWitness?: string;
    witnessBytes?: number;
  };
  idempotencyKey: string;
  expectedCanonVersion?: CanonVersion;      // if model previously cached
}

export interface EditHandoffOk { ok: true; resolvedNode: PatchEnvelope; }
export interface EditHandoffFailure {
  ok: false;
  code: PLAN1DiagnosticCode | ChironDiagnosticCode;
  diagnostic: {
    shortMessage: string;
    hints: string[];
    suggestedAction: string;
    exampleValidCall: object;
    currentBytes?: string;                  // first witnessBytes of current bytes (per F28)
    currentSourceFileHash16?: string;
    candidates?: PatchEnvelope[];
  };
}

export function verifyEditHandoff(
  db: DatabaseHandle,
  repoRoot: string,
  req: EditHandoffRequest
): EditHandoffOk | EditHandoffFailure;
```

This function is the formal cross-tool contract. PLAN1's `FileWriter.apply()` invokes it under the file lock; the diagnostic shape it returns is a PLAN1 diagnostic so PLAN1 doesn't need to translate. STRATA describes this in prose; Helion in §7.1; CHIRON specifies it as the surface and provides the implementation point.

---

## 2. Database Schema (extends `.mcp/symbols.db`)

All new schema is **additive**. Old tables (`files`, `symbols`, `edges`, `versions`, `patterns`) and indexes from `dist/core/symbol-index.js` are untouched. The MD5 `files.hash` is preserved; CHIRON writes the BLAKE3 in `chiron_file_hash.blake3_hex` separately.

### 2.1 Final additive DDL

Inserted into `dist/core/symbol-index.js` after the existing `db.exec(...)` block at line 89, in a separate `db.exec` call so the existing one is unmodified:

```js
// dist/core/symbol-index.js — CHIRON additive migration
// Insertion point: AFTER the existing CREATE TABLE / CREATE INDEX block
// (line 89 in the source as audited 2026-05-04).

db.exec(`
  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: canonicalization registry (F50, F51 — v1↔v2 coexistence)
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS canon_versions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    algorithm       TEXT NOT NULL,                  -- "zen:1"
    language        TEXT NOT NULL,
    abi_version     INTEGER NOT NULL,
    grammar_version TEXT NOT NULL,
    first_seen_at   INTEGER NOT NULL,
    UNIQUE(algorithm, language, abi_version, grammar_version)
  );

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: interned subtree pool — the Lazy Subtree Forest
  -- Each row is a unique (structural_hash, label_hash) under a canon_version.
  -- Identical subtrees across files share a row (dedup is the point).
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS node_pool (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    canon_version_id    INTEGER NOT NULL REFERENCES canon_versions(id) ON DELETE CASCADE,
    structural_hash     TEXT NOT NULL,              -- 64 hex chars (BLAKE3-256)
    label_hash          TEXT NOT NULL,              -- 64 hex chars
    short_hash          TEXT NOT NULL,              -- first 16 hex of label_hash
    short_structural    TEXT NOT NULL,              -- first 16 hex of structural_hash
    node_kind           TEXT NOT NULL,              -- tree-sitter node type
    child_count         INTEGER NOT NULL,
    body_size_bytes     INTEGER NOT NULL,
    novelty_score       REAL NOT NULL DEFAULT 1.0,  -- inverse-frequency weight (F36)
    refcount            INTEGER NOT NULL DEFAULT 0, -- live references across files
    bloom_of_refs       BLOB,                       -- 256-bit Bloom of contained ref names (F22)
    first_seen_at       INTEGER NOT NULL,
    last_seen_at        INTEGER NOT NULL,
    UNIQUE(canon_version_id, structural_hash, label_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_pool_struct        ON node_pool(structural_hash);
  CREATE INDEX IF NOT EXISTS idx_pool_label         ON node_pool(label_hash);
  CREATE INDEX IF NOT EXISTS idx_pool_short         ON node_pool(short_hash);
  CREATE INDEX IF NOT EXISTS idx_pool_short_struct  ON node_pool(short_structural);
  CREATE INDEX IF NOT EXISTS idx_pool_kind          ON node_pool(node_kind);
  CREATE INDEX IF NOT EXISTS idx_pool_canon         ON node_pool(canon_version_id);

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: per-file occurrences — the live anchors PLAN1 consumes.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS node_occurrence (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id           TEXT NOT NULL UNIQUE,         -- blake3(canon || file || struct || label || occ)
    pool_id           INTEGER NOT NULL REFERENCES node_pool(id) ON DELETE CASCADE,
    file_path         TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    parent_node_id    TEXT,                         -- null at file root
    parent_short_hash TEXT,                         -- 16 hex; for outline lookup
    short_hash        TEXT NOT NULL,                -- the carrier's `hash`
    short_structural  TEXT NOT NULL,                -- structural twin
    child_type        TEXT NOT NULL,
    child_index       INTEGER NOT NULL,             -- 0-indexed within parent's same-childType children
    occurrence_index  INTEGER NOT NULL,             -- nth occurrence in file at this child_type
    start_byte        INTEGER NOT NULL,
    end_byte          INTEGER NOT NULL,
    start_line        INTEGER NOT NULL,
    end_line          INTEGER NOT NULL,
    content_witness   TEXT NOT NULL,                -- first 64 bytes UTF-8 (PLAN1 contract)
    symbol_id         INTEGER REFERENCES symbols(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_occ_file        ON node_occurrence(file_path);
  CREATE INDEX IF NOT EXISTS idx_occ_parent_node ON node_occurrence(parent_node_id);
  CREATE INDEX IF NOT EXISTS idx_occ_pool        ON node_occurrence(pool_id);
  CREATE INDEX IF NOT EXISTS idx_occ_short       ON node_occurrence(short_hash);
  CREATE INDEX IF NOT EXISTS idx_occ_struct      ON node_occurrence(short_structural);
  CREATE INDEX IF NOT EXISTS idx_occ_child       ON node_occurrence(file_path, parent_short_hash, child_type, child_index);
  CREATE INDEX IF NOT EXISTS idx_occ_byte        ON node_occurrence(file_path, start_byte);

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: locality bands (256-bit SimHash split into 8 × 32-bit bands).
  -- One row per (pool_id, band_index). Indexed by (band_index, band_value)
  -- for "find candidates sharing this band" lookups.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS locality_band (
    pool_id     INTEGER NOT NULL REFERENCES node_pool(id) ON DELETE CASCADE,
    band_index  INTEGER NOT NULL,                   -- 0..7
    band_value  INTEGER NOT NULL,                   -- 32-bit unsigned
    PRIMARY KEY(pool_id, band_index)
  );
  CREATE INDEX IF NOT EXISTS idx_band_lookup ON locality_band(band_index, band_value);

  -- Cached full SimHash so we don't reconstruct from bands on every Hamming compare.
  CREATE TABLE IF NOT EXISTS locality_simhash (
    pool_id      INTEGER PRIMARY KEY REFERENCES node_pool(id) ON DELETE CASCADE,
    simhash256   TEXT NOT NULL,                     -- 64 hex chars (256 bits)
    popcount     INTEGER NOT NULL                   -- 0..256
  );

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: file-level BLAKE3 (replaces md5 for new flows; old hash kept).
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS chiron_file_hash (
    file_path           TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
    blake3_hex          TEXT NOT NULL,              -- 64 hex chars
    source_file_hash16  TEXT NOT NULL,              -- first 16 hex (PLAN1 contract)
    canon_version_id    INTEGER NOT NULL REFERENCES canon_versions(id),
    indexed_at          INTEGER NOT NULL,
    file_size_bytes     INTEGER NOT NULL,
    parse_error_count   INTEGER NOT NULL DEFAULT 0,
    root_short_hash     TEXT NOT NULL               -- the document-root node_occurrence.short_hash
  );
  CREATE INDEX IF NOT EXISTS idx_cfh_short ON chiron_file_hash(source_file_hash16);

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: slice index (combined Merkle + slice-membership invalidation
  -- — Theme A5, the unanswered gap).
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS slice (
    slice_id          TEXT PRIMARY KEY,             -- blake3(criterion || direction || depth || members)
    criterion_node_id TEXT NOT NULL,
    direction         TEXT NOT NULL CHECK(direction IN ('forward','backward','both')),
    depth             INTEGER NOT NULL,
    member_count      INTEGER NOT NULL,
    computed_at       INTEGER NOT NULL,
    canon_version_id  INTEGER NOT NULL REFERENCES canon_versions(id),
    stale             INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_slice_criterion ON slice(criterion_node_id);

  CREATE TABLE IF NOT EXISTS slice_member (
    slice_id      TEXT NOT NULL REFERENCES slice(slice_id) ON DELETE CASCADE,
    node_id       TEXT NOT NULL,
    short_hash    TEXT NOT NULL,
    ordinal       INTEGER NOT NULL,
    edge_kind     TEXT NOT NULL,                    -- 'control' | 'data' | 'call' | 'def'
    hop_distance  INTEGER NOT NULL,
    PRIMARY KEY(slice_id, node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_slice_member_node  ON slice_member(node_id);
  CREATE INDEX IF NOT EXISTS idx_slice_member_short ON slice_member(short_hash);

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: repository atlas (Sort & Slice frequency catalog, F36).
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS atlas_frequency (
    canon_version_id   INTEGER NOT NULL REFERENCES canon_versions(id),
    structural_hash    TEXT NOT NULL,
    occurrence_count   INTEGER NOT NULL,
    rank               INTEGER NOT NULL,            -- 1..L (L=2048 default)
    is_boilerplate     INTEGER NOT NULL DEFAULT 0,  -- 1 if rank ≤ L
    k_occurrence_class TEXT NOT NULL,               -- 'anti'|'good'|'bad' (F35)
    last_recomputed    INTEGER NOT NULL,
    PRIMARY KEY(canon_version_id, structural_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_atlas_rank  ON atlas_frequency(rank);
  CREATE INDEX IF NOT EXISTS idx_atlas_class ON atlas_frequency(k_occurrence_class);

  -- Framework patterns (F39).
  CREATE TABLE IF NOT EXISTS atlas_framework (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    language        TEXT NOT NULL,
    framework       TEXT NOT NULL,                  -- 'nestjs','fastapi','spring',...
    pattern_text    TEXT NOT NULL,                  -- '@Controller','@Path','Route::',...
    multiplier      REAL NOT NULL,                  -- 2.8..3.2 per Tessera-3B
    UNIQUE(language, framework, pattern_text)
  );

  -- Personalized PageRank cache (F38). Per canon_version_id.
  CREATE TABLE IF NOT EXISTS atlas_pagerank (
    canon_version_id INTEGER NOT NULL REFERENCES canon_versions(id),
    node_id          TEXT NOT NULL,
    score            REAL NOT NULL,
    iter             INTEGER NOT NULL,
    computed_at      INTEGER NOT NULL,
    PRIMARY KEY(canon_version_id, node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pr_score ON atlas_pagerank(score DESC);

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: read registry — protocol-layer NEVER_READ enforcement.
  -- (F26, F28; STRATA/Helion both reference this; CHIRON specifies the table.)
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS read_registry (
    short_hash       TEXT NOT NULL,
    file_path        TEXT NOT NULL,
    origin           TEXT NOT NULL CHECK(origin IN ('vault','editor')),
    canon_version_id INTEGER NOT NULL REFERENCES canon_versions(id),
    issued_at        INTEGER NOT NULL,
    session_id       TEXT NOT NULL,
    PRIMARY KEY(short_hash, file_path, session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_rr_session ON read_registry(session_id);
  CREATE INDEX IF NOT EXISTS idx_rr_age     ON read_registry(issued_at);

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: idempotency log (F29; orchestrator-derived UUIDs only).
  -- DB-backed for crash-replay safety; STRATA/Helion store in memory.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS idempotency_log (
    idempotency_key TEXT PRIMARY KEY,
    tool_name       TEXT NOT NULL,
    request_hash    TEXT NOT NULL,                  -- sha256 of request body for replay safety
    response_blob   BLOB NOT NULL,                  -- JSON of envelope (compressed)
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL                -- created_at + 1h
  );
  CREATE INDEX IF NOT EXISTS idx_idem_exp ON idempotency_log(expires_at);

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: Cortex residency tracker (L1 in-process LRU shadow; L2 disk).
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS cortex_residency (
    short_hash    TEXT PRIMARY KEY,
    tier          INTEGER NOT NULL,                 -- 1 | 2 | 3
    paged_in_at   INTEGER NOT NULL,
    last_access   INTEGER NOT NULL,
    access_count  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cortex_lru ON cortex_residency(tier, last_access);

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: heal cache (F60; replay safety with idempotency_key).
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS heal_cache (
    stale_hash       TEXT NOT NULL,
    file_path        TEXT NOT NULL,
    idempotency_key  TEXT NOT NULL,
    healed_short     TEXT,                          -- null when AMBIGUOUS_HEAL
    tier             INTEGER NOT NULL,
    confidence       REAL NOT NULL,
    candidate_blob   TEXT,                          -- JSON-encoded candidate envelopes
    computed_at      INTEGER NOT NULL,
    PRIMARY KEY(stale_hash, file_path, idempotency_key)
  );

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: page-fault telemetry (rolling, ClawVM-style).
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS page_fault_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type    TEXT NOT NULL,
    faulted_key   TEXT NOT NULL,
    from_tier     TEXT NOT NULL,
    to_tier       TEXT NOT NULL,
    cost_ms       REAL NOT NULL,
    occurred_at   INTEGER NOT NULL,
    session_id    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pflog_time    ON page_fault_log(occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pflog_session ON page_fault_log(session_id);

  -- ─────────────────────────────────────────────────────────────────────
  -- CHIRON: drift telemetry (CHIRON contribution).
  -- Tracks k-occurrence transitions per index run — release-gate signal.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS drift_event (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    structural_hash   TEXT NOT NULL,
    canon_version_id  INTEGER NOT NULL REFERENCES canon_versions(id),
    prev_class        TEXT,                         -- 'anti' | 'good' | 'bad' | null (new)
    new_class         TEXT NOT NULL,
    prev_k            INTEGER,
    new_k             INTEGER NOT NULL,
    delta_k           INTEGER NOT NULL,
    detected_at       INTEGER NOT NULL,
    run_id            TEXT NOT NULL                 -- groups events to one indexer run
  );
  CREATE INDEX IF NOT EXISTS idx_drift_run ON drift_event(run_id);
`);

// Idempotent ALTER TABLE migrations — match the existing migration style at lines 90-101.
try { db.exec('ALTER TABLE files   ADD COLUMN chiron_indexed_at INTEGER'); } catch { /* exists */ }
try { db.exec('ALTER TABLE files   ADD COLUMN canon_version_id INTEGER'); } catch { /* exists */ }
try { db.exec('ALTER TABLE symbols ADD COLUMN chiron_short_hash TEXT'); } catch { /* exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_chiron_short ON symbols(chiron_short_hash)'); } catch {}
```

### 2.2 Backward compatibility guarantee

- `files`, `symbols`, `edges`, `versions`, `patterns` keep all existing columns and indexes unchanged. The MD5 `files.hash` is preserved as-is. CHIRON writes BLAKE3 separately in `chiron_file_hash.blake3_hex`. Existing `impactQuery`, `snapshotSymbol`, `restoreVersion`, `getVersionHistory` keep working unchanged.
- `refactor_batch.js`'s structural-fingerprint outlier detection (Jaccard 3-gram via `getStructuralFingerprint`) keeps working. Phase 6 adds an *opt-in* `useChironOutlier` mode that swaps in banded SimHash; default stays Jaccard until shadow-mode telemetry validates the swap.
- `dist/grammars/queries/{lang}-tags.scm` flat-path back-compat is preserved. New `signatures.scm` and `slice_seeds.scm` are additive.

---

## 3. Phased Execution Plan

7 phases with explicit exit criteria, cross-phase dependencies mapped, and per-task file-level concreteness. The plan is ordered to de-risk hardest unknowns first: canonicalization (Phase 0) before any hashing; LSF (Phase 1) before any retrieval; tools (Phase 3) only after the index is provably correct.

```text
Phase 0 → Phase 1 ──┬─→ Phase 2 ──┬─→ Phase 3 ──┬─→ Phase 4 ──→ Phase 5 ──→ Phase 6
                    │             │              │
                    └→ Phase 1.5 (queries) ──────┘
                                  │              │
                                  └→ Phase 2.5 (atlas + slicer) ────→ Phase 4
```

| Phase | Scope | Builds on | Unblocks |
|---|---|---|---|
| 0 | Canonicalization spec + canon_versions registry + boundary keys + DB migration | none | 1 |
| 1 | Hash Forge + Lazy Subtree Forest + indexer hook | 0 | 2, 3 |
| 1.5 | Per-language `signatures.scm` and `slice_seeds.scm` (parallel with 1) | 0 | 2.5, 3 |
| 2 | 256-bit SimHash + atlas + bloom-of-refs + PageRank | 1, 1.5 | 3 |
| 2.5 | Slicer + Patch Context | 1, 1.5 | 3, 4 |
| 3 | 5 MCP tools + read registry + heal cascade + verifyEditHandoff | 1, 2, 2.5 | 4, 5 |
| 4 | Toon-bridge integration + compression scoring | 2, 2.5, 3 | 5 |
| 5 | Cortex demand-paged context + streaming page faults | 3, 4 | 6 |
| 6 | Shadow mode + telemetry + drift gates + cutover | 5 | release |

---

## Phase 0 — Canonicalization, Registry, and Boundary Keys

> **Goal**: a versioned, test-corpus-anchored AST canonicalization spec; bidirectional `canon_versions` table; deterministic boundary keys. Without this, hash inputs drift silently (E11, E23, E53, E56). Snix-castore admits the failure mode; we publish a spec and a registry instead.

### Task 0.1 — Author the canonicalization spec and boundary keys

**Files**:
- Create: `dist/core/chiron/canon/keys.js` (hand-authored)
- Create: `dist/core/chiron/canon/SPEC.md` (versioned at runtime by tests; not user-facing docs)
- Create: `src/core/chiron/canon/keys.ts` (tsc input → not compiled to dist; types only)
- Create: `tests/chiron/canon/keys.test.js`

**Pattern reference**: `dist/core/lib.js` — pure-function module style, no side effects in module body. `dist/core/symbol-index.js:5` already imports `createHash` — we add `@noble/hashes/blake3` next to it in `package.json` (line 36, alongside `better-sqlite3`).

**Implementation** (final code; ≈ 75 lines):

```js
// dist/core/chiron/canon/keys.js
import { blake3 } from '@noble/hashes/blake3';

export const ALG_PREFIX = 'zen:1:';

/**
 * NNCP-MTH boundary keys, domain-separated (F50, F58).
 * Identical input bytes can never produce a leaf-hash and an internal-hash
 * that collide. Two parallel domain keys per twin (structural / label).
 */
const enc = new TextEncoder();
export const LEAF_KEY                  = blake3(enc.encode('ZNCP NODE LEAF'),       { dkLen: 32 });
export const INTERNAL_KEY              = blake3(enc.encode('ZNCP NODE INTERNAL'),   { dkLen: 32 });
export const STRUCTURAL_DOMAIN         = blake3(enc.encode('ZNCP DOMAIN STRUCTURAL'),{ dkLen: 32 });
export const LABEL_DOMAIN              = blake3(enc.encode('ZNCP DOMAIN LABEL'),    { dkLen: 32 });

/**
 * Length-prefixed UTF-8 — DAG-CBOR length-first ordering.
 */
export function uvarintLE(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
  return Uint8Array.from(out);
}
export function lengthPrefixedUtf8(s) {
  const bytes = enc.encode(s);
  const len = uvarintLE(bytes.length);
  const out = new Uint8Array(len.length + bytes.length);
  out.set(len, 0); out.set(bytes, len.length);
  return out;
}

/**
 * Versioned canonical-input prefix: 0x01 || ASCII("zen:1:lang:abi:gver") || NUL.
 * F58.
 */
export function canonPrefix(canon) {
  // canon = { algorithm:"zen:1", language, abiVersion, grammarVersion }
  const buf = enc.encode(`${ALG_PREFIX}${canon.language}:${canon.abiVersion}:${canon.grammarVersion}\0`);
  const out = new Uint8Array(1 + buf.length);
  out[0] = 0x01;
  out.set(buf, 1);
  return out;
}

export function bufToHex(b) {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
export function hexToBuf(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
```

**Acceptance**:
- [ ] `keys.js` exports all listed symbols.
- [ ] `LEAF_KEY` and `INTERNAL_KEY` are deterministic 32-byte values; verified by reproducing in another runtime (Python `blake3` package).
- [ ] `canonPrefix({ language: 'typescript', abiVersion: 15, grammarVersion: '0.21.4' })` produces a deterministic 28-byte prefix.

### Task 0.2 — Author the test corpus

**Files**:
- Create: `tests/chiron/canon/SPEC.test.js`
- Create: `tests/chiron/canon/fixtures/*.json` (≥ 30 fixtures across 11 languages)
- Create: `scripts/chiron-canon-genfix.js`

**Implementation**:
- Each fixture is `{ language, abiVersion, grammarVersion, source, expectedStructuralHash, expectedLabelHash }`. Generated once via `chiron-canon-genfix.js`, then committed and treated as ground truth. CI invariant: `git diff --exit-code` after re-generation. Drift fails CI.
- Required coverage: empty file; identifiers-only file; whitespace-only difference (must produce identical structural_hash, identical label_hash); CRLF vs LF (no impact); BOM (no impact); newline-at-EOF (no impact); identifier rename (must preserve structural_hash, change label_hash); reformat (must preserve both); cross-language pairs sharing a kind name (e.g. `function` in JS vs Go must have different hashes via canon_prefix); deeply-nested expression (≥ 200-deep, no stack overflow); generated file (`.pb.go`); Unicode-heavy (emoji, CJK).

**Pattern reference**: existing test convention at `tests/` (vitest, `package.json:30` `"test": "vitest run --coverage"`).

**Acceptance**:
- [ ] All fixtures parse without grammar-load errors.
- [ ] Re-running spec-genfix on each fixture produces byte-identical hashes.
- [ ] CI fails if any fixture's expected hash drifts.

### Task 0.3 — Grammar metadata reader

**Files**:
- Create: `dist/core/chiron/canon/grammar_meta.js`
- Create: `scripts/chiron-emit-grammar-versions.js`
- Create: `dist/grammars/versions/*.version.txt` (one per supported grammar, written at install time)

**Pattern reference**: `dist/core/tree-sitter.js:213` (`loadQueryFile` lazy load) for caching pattern.

**Implementation** (≈ 50 lines):

```js
// dist/core/chiron/canon/grammar_meta.js
import path from 'path';
import fs from 'fs/promises';

const _metaCache = new Map();
const VERSIONS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'grammars', 'versions'
);

/**
 * Read grammar metadata (ABI + crate version) for a language.
 * Falls back to a fixed table for grammars whose API doesn't expose the value.
 */
export async function readGrammarMetadata(langName, language) {
  if (_metaCache.has(langName)) return _metaCache.get(langName);

  // tree-sitter v0.26.x exposes Language.version (the ABI integer) as a getter.
  // Fall back to 14 if undefined.
  let abiVersion = 14;
  if (language && typeof language.version === 'number') abiVersion = language.version;

  let grammarVersion = 'unknown';
  try {
    grammarVersion = (await fs.readFile(
      path.join(VERSIONS_DIR, `${langName}.version.txt`), 'utf-8'
    )).trim();
  } catch { /* sentinel */ }

  const meta = { algorithm: 'zen:1', language: langName, abiVersion, grammarVersion };
  _metaCache.set(langName, meta);
  return meta;
}
```

`scripts/chiron-emit-grammar-versions.js` runs at `npm run prebuild`, opens each `tree-sitter-{lang}/package.json` from `node_modules` and writes `dist/grammars/versions/<lang>.version.txt`. If a grammar lacks a `package.json`, it falls back to `0.0.0` and logs a warning.

**Acceptance**:
- [ ] At repo install, `chiron-emit-grammar-versions.js` writes one file per supported grammar.
- [ ] `readGrammarMetadata("typescript", lang)` returns `{ algorithm: "zen:1", language: "typescript", abiVersion: ≥15, grammarVersion: "<exact>" }`.
- [ ] Cache survives across calls in the same process.

### Task 0.4 — Apply DDL migration to `symbol-index.js`

**Files**:
- Modify: `dist/core/symbol-index.js` (insert §2.1 DDL after the existing `db.exec` block at line 89; **insertion point is line 90**, between the existing block and the existing `try { db.exec('ALTER TABLE files ADD COLUMN ...') }` migration shims at lines 90-101).
- Modify: `src/core/symbol-index.ts` correspondingly.
- Create: `dist/core/chiron/canon/registry.js` (hand-authored; thin wrapper for `canon_versions` upserts)

**Implementation** of `registry.js` (≈ 60 lines):

```js
// dist/core/chiron/canon/registry.js
export function upsertCanonVersion(db, canon) {
  const row = db.prepare(`
    SELECT id FROM canon_versions
    WHERE algorithm = ? AND language = ? AND abi_version = ? AND grammar_version = ?
  `).get(canon.algorithm, canon.language, canon.abiVersion, canon.grammarVersion);
  if (row) return row.id;
  const info = db.prepare(`
    INSERT INTO canon_versions (algorithm, language, abi_version, grammar_version, first_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(canon.algorithm, canon.language, canon.abiVersion, canon.grammarVersion, Date.now());
  return Number(info.lastInsertRowid);
}

export function lookupCanonVersionById(db, id) {
  return db.prepare(`SELECT * FROM canon_versions WHERE id = ?`).get(id);
}

export function lookupCanonVersionByTuple(db, canon) {
  return db.prepare(`
    SELECT * FROM canon_versions
    WHERE algorithm = ? AND language = ? AND abi_version = ? AND grammar_version = ?
  `).get(canon.algorithm, canon.language, canon.abiVersion, canon.grammarVersion);
}

/**
 * F51 — when a request arrives bearing a hash from a different canon_version
 * than the one currently indexing the file, return CANON_VERSION_MISMATCH
 * rather than HASH_NOT_FOUND.
 */
export function detectCanonDrift(db, requestCanonVersionId, fileCanonVersionId) {
  if (requestCanonVersionId === fileCanonVersionId) return null;
  const requested = lookupCanonVersionById(db, requestCanonVersionId);
  const current   = lookupCanonVersionById(db, fileCanonVersionId);
  return { requested, current };
}
```

**Acceptance**:
- [ ] `getDb(repoRoot)` produces a DB with all CHIRON tables created.
- [ ] All existing `symbol-index.js` tests pass unchanged.
- [ ] `canon_versions` row is upserted on first parse of each `(language, abi, grammarVersion)` tuple.
- [ ] `lookupCanonVersionByTuple` returns the canonical row.

### Phase 0 exit criteria

- [ ] Canonicalization spec is published, versioned, and test-anchored.
- [ ] Boundary keys deterministic across machines (verified out-of-band, e.g., Python BLAKE3).
- [ ] `canon_versions` registry idempotent and additive.
- [ ] All existing tests pass unchanged.

---

## Phase 1 — Hash Forge & Lazy Subtree Forest

> **Goal**: produce two BLAKE3 hashes per node and intern subtrees into `node_pool` so identical subtrees across the repo collapse to one row. F4, F58, A8.

### Task 1.1 — Hash Forge (iterative postorder)

**Files**:
- Create: `dist/core/chiron/node_hash.js` (hand-authored)
- Create: `tests/chiron/node_hash.test.js`

**Pattern reference**: `dist/core/tree-sitter.js:285-310` (compiled query caching pattern).

**Implementation** (final code; ≈ 130 lines, iterative postorder to avoid stack overflow on deep ASTs):

```js
// dist/core/chiron/node_hash.js
import { blake3 } from '@noble/hashes/blake3';
import {
  LEAF_KEY, INTERNAL_KEY, STRUCTURAL_DOMAIN, LABEL_DOMAIN,
  canonPrefix, uvarintLE, lengthPrefixedUtf8, bufToHex, hexToBuf,
} from './canon/keys.js';

const LEAF_TEXT_CAP = 4096;  // 4 KiB; longer leaves hashed by their byte range only

/**
 * Hash a tree-sitter node into (structural, label) using iterative postorder.
 *
 * web-tree-sitter v0.26.x: `node.isMissing` and `node.hasError` are GETTERS,
 * not methods (user-memory hard rule). Treat accordingly.
 *
 * Returns { structural: <64hex>, label: <64hex> }.
 * Iterative to support deeply-nested ASTs (50k+ nesting).
 */
export function hashNode(rootNode, canon) {
  const prefix = canonPrefix(canon);
  const stack = [{ node: rootNode, phase: 'enter', childStruct: [], childLabel: [] }];
  const out = new Map();   // node identity → { structural, label }

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const node = frame.node;

    if (frame.phase === 'enter') {
      if (node.namedChildCount === 0) {
        // Leaf: prefix || LEAF_KEY || kind || token
        const tokenText = node.text.length <= LEAF_TEXT_CAP
          ? node.text
          : `__cap_${node.text.length}_${bufToHex(blake3(new TextEncoder().encode(node.text), { dkLen: 16 }))}`;
        const kindBytes  = lengthPrefixedUtf8(node.type);
        const tokenBytes = lengthPrefixedUtf8(tokenText);
        const structInput = concat([prefix, LEAF_KEY, kindBytes, lengthPrefixedUtf8('')]);
        const labelInput  = concat([prefix, LEAF_KEY, kindBytes, tokenBytes]);
        out.set(node, {
          structural: bufToHex(blake3(structInput, { key: STRUCTURAL_DOMAIN, dkLen: 32 })),
          label:      bufToHex(blake3(labelInput,  { key: LABEL_DOMAIN,      dkLen: 32 })),
        });
        stack.pop();
      } else {
        frame.phase = 'recurse';
        frame.cursor = 0;
        // fall through to recurse next iter
      }
    } else if (frame.phase === 'recurse') {
      if (frame.cursor < node.namedChildCount) {
        const child = node.namedChild(frame.cursor);
        frame.cursor++;
        stack.push({ node: child, phase: 'enter', childStruct: [], childLabel: [] });
      } else {
        // All children hashed → compose
        const childCount = node.namedChildCount;
        const childStruct = [];
        const childLabel  = [];
        for (let i = 0; i < childCount; i++) {
          const ch = out.get(node.namedChild(i));
          childStruct.push(hexToBuf(ch.structural));
          childLabel.push(hexToBuf(ch.label));
        }
        const kindBytes = lengthPrefixedUtf8(node.type);
        const structInput = concat([
          prefix, INTERNAL_KEY, kindBytes, uvarintLE(childCount), ...childStruct,
        ]);
        // Label hash adds the identifier text where present.
        const ident = node.childForFieldName ? node.childForFieldName('name') : null;
        const identBytes = ident ? lengthPrefixedUtf8(ident.text) : lengthPrefixedUtf8('');
        const labelInput = concat([
          prefix, INTERNAL_KEY, kindBytes, uvarintLE(childCount), identBytes, ...childLabel,
        ]);
        out.set(node, {
          structural: bufToHex(blake3(structInput, { key: STRUCTURAL_DOMAIN, dkLen: 32 })),
          label:      bufToHex(blake3(labelInput,  { key: LABEL_DOMAIN,      dkLen: 32 })),
        });
        stack.pop();
      }
    }
  }
  return out.get(rootNode);
}

export function shortHash(longHexLabel) { return longHexLabel.slice(0, 16); }
export function shortStructural(longHexStruct) { return longHexStruct.slice(0, 16); }

export function nodeId(canon, filePath, h, occurrenceIndex) {
  const buf = `zen:1:${canon.language}:${canon.abiVersion}:${canon.grammarVersion}|${filePath}|${h.structural}|${h.label}|${occurrenceIndex}`;
  return bufToHex(blake3(new TextEncoder().encode(buf), { dkLen: 32 }));
}

function concat(arrays) {
  const tot = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(tot);
  let p = 0;
  for (const a of arrays) { out.set(a, p); p += a.length; }
  return out;
}
```

**Risks**:
- Heap pressure on very large leaves: capped at 4 KiB; longer leaves replaced by length-and-hash sentinel (still deterministic).
- Recursion depth: avoided by iterative postorder.

**Acceptance**:
- [ ] Test: rename one identifier in a TS file → structural hashes for the renamed node and its ancestors are equal pre/post; label hashes are different.
- [ ] Test: reformat (whitespace-only) → both hashes equal pre/post.
- [ ] Test: 50k-deep nested-paren TS expression hashes without stack overflow.
- [ ] Test: BLAKE3 throughput ≥ 100 MB/s on Node 22 modern x86; regression budget ±10%.
- [ ] Test against the Phase 0 fixture corpus.

### Task 1.2 — Lazy Subtree Forest writer (`lsf.js`)

**Files**:
- Create: `dist/core/chiron/lsf.js` (hand-authored, ≈ 280 lines)
- Create: `tests/chiron/lsf.test.js`

**Pattern reference**: `dist/core/symbol-index.js:149-202` (`indexFile` template), `dist/core/symbol-index.js:174-201` for the transaction pattern.

**Implementation outline** (essential body):

```js
// dist/core/chiron/lsf.js
import { blake3 } from '@noble/hashes/blake3';
import { hashNode, shortHash, shortStructural, nodeId } from './node_hash.js';
import { readGrammarMetadata } from './canon/grammar_meta.js';
import { upsertCanonVersion } from './canon/registry.js';
import { computeSimHash, bandsOf, popcount256 } from './simhash.js';
import { computeBloomOfRefs } from './bloom_refs.js';
import { isSupported, getLangForFile, _exposeLanguageForLsf } from '../tree-sitter.js';
import { Parser } from 'web-tree-sitter';
import fs from 'fs/promises';
import path from 'path';

const FILE_SIZE_INDEX_CAP = 1024 * 1024;  // 1 MiB; larger files index into pool but skip atlas

export async function chironIndexFile(db, repoRoot, absFilePath) {
  const relPath = path.relative(repoRoot, absFilePath);
  let bytes;
  try { bytes = await fs.readFile(absFilePath); } catch { return null; }

  const langName = getLangForFile(absFilePath);
  if (!langName) return null;
  if (!isSupported(absFilePath)) return null;

  // 1. File BLAKE3 + sourceFileHash16 (PLAN1 contract)
  const fileHashBytes = blake3(bytes, { dkLen: 32 });
  const fileHashHex = bufToHex(fileHashBytes);
  const sourceFileHash16 = fileHashHex.slice(0, 16);

  // 2. Skip if already indexed at this hash
  const existing = db.prepare(
    'SELECT blake3_hex, root_short_hash FROM chiron_file_hash WHERE file_path = ?'
  ).get(relPath);
  if (existing && existing.blake3_hex === fileHashHex) {
    return { reused: true, sourceFileHash16, rootShortHash: existing.root_short_hash };
  }

  // 3. Parse + canon meta
  const language = await _exposeLanguageForLsf(langName);
  if (!language) return null;
  const meta = await readGrammarMetadata(langName, language);
  const parser = new Parser(); parser.setLanguage(language);
  const source = bytes.toString('utf-8');
  const tree = parser.parse(source);

  try {
    const canonId = upsertCanonVersion(db, meta);

    // 4. Walk: hash + record occurrences in a single transaction
    let rootShortHash = null;
    const txn = db.transaction(() => {
      // Scrub previous occurrences for this file (file-incremental).
      db.prepare('DELETE FROM node_occurrence WHERE file_path = ?').run(relPath);

      // Iterative postorder: hash all then upsert
      const allRecords = walkAndCollect(tree.rootNode, meta, relPath);
      const occCounter = new Map();   // (parentNodeId|childType) → nextOccurrenceIndex

      for (const rec of allRecords) {
        const occKey = `${rec.parentNodeId ?? 'ROOT'}|${rec.childType}`;
        rec.occurrenceIndex = occCounter.get(occKey) ?? 0;
        occCounter.set(occKey, rec.occurrenceIndex + 1);
        rec.nodeId = nodeId(meta, relPath, { structural: rec.structuralFull, label: rec.labelFull }, rec.occurrenceIndex);

        // Upsert pool entry
        const poolId = upsertPool(db, canonId, rec, bytes.length <= FILE_SIZE_INDEX_CAP);

        // Insert occurrence
        db.prepare(`
          INSERT INTO node_occurrence
            (node_id, pool_id, file_path, parent_node_id, parent_short_hash,
             short_hash, short_structural, child_type, child_index, occurrence_index,
             start_byte, end_byte, start_line, end_line, content_witness, symbol_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          rec.nodeId, poolId, relPath, rec.parentNodeId, rec.parentShortHash,
          shortHash(rec.labelFull), shortStructural(rec.structuralFull),
          rec.childType, rec.childIndexOfParent, rec.occurrenceIndex,
          rec.startByte, rec.endByte, rec.startLine, rec.endLine,
          rec.contentWitness, null
        );

        // Increment pool refcount
        db.prepare('UPDATE node_pool SET refcount = refcount + 1, last_seen_at = ? WHERE id = ?')
          .run(Date.now(), poolId);

        if (rec.parentNodeId === null) rootShortHash = shortHash(rec.labelFull);
      }

      // chiron_file_hash upsert
      db.prepare(`
        INSERT INTO chiron_file_hash
          (file_path, blake3_hex, source_file_hash16, canon_version_id, indexed_at,
           file_size_bytes, parse_error_count, root_short_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          blake3_hex          = excluded.blake3_hex,
          source_file_hash16  = excluded.source_file_hash16,
          canon_version_id    = excluded.canon_version_id,
          indexed_at          = excluded.indexed_at,
          file_size_bytes     = excluded.file_size_bytes,
          parse_error_count   = excluded.parse_error_count,
          root_short_hash     = excluded.root_short_hash
      `).run(
        relPath, fileHashHex, sourceFileHash16, canonId, Date.now(),
        bytes.length, countParseErrors(tree.rootNode), rootShortHash
      );
    });
    txn();

    return { reused: false, sourceFileHash16, rootShortHash, fileSizeBytes: bytes.length };
  } finally {
    tree.delete(); parser.delete();
  }
}

function walkAndCollect(rootNode, canon, relPath) {
  // Iterative postorder; build records bottom-up so parent_node_id refers to already-emitted ids.
  // Each record: { parentNodeId, parentShortHash, childType, childIndexOfParent, structuralFull, labelFull,
  //                startByte, endByte, startLine, endLine, contentWitness }.
  // Implementation ≈ 60 lines; standard postorder walker.
  // ... (omitted body; full code generated from tests)
}

function upsertPool(db, canonId, rec, computeAtlasSignals) {
  // INSERT ... ON CONFLICT DO UPDATE last_seen_at.
  // If `computeAtlasSignals` is true, also compute SimHash bands and bloom-of-refs.
  // ... (≈ 40 lines)
}

function countParseErrors(rootNode) {
  // Iterative DFS; web-tree-sitter v0.26.x: hasError is a GETTER.
  let count = 0;
  const stack = [rootNode];
  while (stack.length) {
    const n = stack.pop();
    if (n.hasError && !n.namedChildCount) count++;
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
  }
  return count;
}

function bufToHex(b) {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
```

**Important note on `_exposeLanguageForLsf`**: This is a small new export from `dist/core/tree-sitter.js` returning the cached `Language` object for a langname (pattern: lazy-load + cache, mirrors existing `loadLanguage` at line 145-168). Add the new export at line 1005 (end of file). Pattern-match the existing `loadLanguage` body so the caller never re-loads.

**Risks**:
- Index time on a 100k-LOC TS repo: targeting < 60 s cold; < 2 s incremental. Achievable per F20 / Tessera-1C Finding 10 (~0.2-0.3s reparse / 25k-line Python).
- Pool growth on very repetitive code (e.g. proto-generated): mitigated by `atlas_frequency` boilerplate-flagging in Phase 2.

**Acceptance**:
- [ ] On a 5k-LOC sample TS repo, `chironIndexFile` runs in < 250 ms warm, < 1.5 s cold.
- [ ] After indexing, `node_pool.refcount` reflects de-dup (e.g., 30 identical `try { ... } catch { /* ignore */ }` blocks → 1 pool row, 30 occurrences across 30 files).
- [ ] `node_occurrence.parent_node_id` is `NULL` for the file-root entry only.
- [ ] Same file indexed twice with no source change is a no-op (sourceFileHash16 short-circuit).

### Task 1.3 — Wire `chironIndexFile` into existing indexer

**Files**:
- Modify: `dist/core/symbol-index.js` — extend `indexFile` and `ensureIndexFresh` to call `chironIndexFile` after the existing transaction.

**Insertion point**: `dist/core/symbol-index.js` line 202, immediately after the existing `doTransaction()` call:

```js
// After existing doTransaction() in indexFile():
try {
  const { chironIndexFile } = await import('./chiron/lsf.js');
  await chironIndexFile(db, repoRoot, absFilePath);
} catch (err) {
  console.error(`CHIRON index failed for ${relPath}: ${err.message}`);
  // Non-fatal: existing symbol indexing succeeded.
}
```

Also wire `_exposeLanguageForLsf` export at the end of `dist/core/tree-sitter.js`:

```js
// dist/core/tree-sitter.js — line 1005 (new export at end of file)
export async function _exposeLanguageForLsf(langName) {
  await ensureInit();
  if (_languageCache.has(langName)) return _languageCache.get(langName);
  return await loadLanguage(langName);  // existing private helper
}
```

**Acceptance**:
- [ ] Existing `indexDirectory` test sees no regressions.
- [ ] After `indexDirectory`, `node_pool` is non-empty and `chiron_file_hash` covers every supported file.
- [ ] Re-indexing the same directory after no source change is a no-op.

### Phase 1 exit criteria

- [ ] Two-hash identity is computable, deterministic, grammar-coupled.
- [ ] LSF `node_pool` and `node_occurrence` tables populate correctly across all 29 supported languages.
- [ ] `sourceFileHash16` available for every indexed file.
- [ ] No regression in existing tools.

---

## Phase 1.5 — Per-Language Query Files (parallel with Phase 1)

> **Goal**: extend the existing paired-capture query convention with two new query files per language: `signatures.scm` (type contracts; F32) and `slice_seeds.scm` (statement-level seeds; F7, F8).

### Task 1.5.1 — `signatures.scm` for the top 10 languages

**Files** (all created):
- `dist/grammars/queries/typescript/signatures.scm`
- `dist/grammars/queries/javascript/signatures.scm`
- `dist/grammars/queries/python/signatures.scm`
- `dist/grammars/queries/go/signatures.scm`
- `dist/grammars/queries/rust/signatures.scm`
- `dist/grammars/queries/java/signatures.scm`
- `dist/grammars/queries/cpp/signatures.scm`
- `dist/grammars/queries/c/signatures.scm`
- `dist/grammars/queries/csharp/signatures.scm`
- `dist/grammars/queries/php/signatures.scm`

**Pattern reference**: `dist/grammars/queries/typescript/definitions.scm` (existing paired-capture).

**Loader change**: extend `dist/core/tree-sitter.js:213` (`loadQueryFile`) to accept the new type union member `'signatures'`. Add a sibling `_signaturesQueryCache` Map at line ~135 (next to existing query caches). Pattern-match the existing `loadQueryFile` body.

**Example — TypeScript signatures.scm**:

```scheme
; Capture function/method signatures for type contract extraction (F32).
; Paired captures: @signature.* names the signature span, @return.* names the return type.

(function_declaration
  name: (identifier) @name.signature.function
  parameters: (formal_parameters) @params.signature.function
  return_type: (type_annotation)? @return.signature.function
) @signature.function

(method_signature
  name: (property_identifier) @name.signature.method
  parameters: (formal_parameters) @params.signature.method
  type: (type_annotation)? @return.signature.method
) @signature.method

(method_definition
  name: (property_identifier) @name.signature.method
  parameters: (formal_parameters) @params.signature.method
  return_type: (type_annotation)? @return.signature.method
) @signature.method

(public_field_definition
  name: (property_identifier) @name.signature.property
  type: (type_annotation)? @return.signature.property
) @signature.property
```

Each file follows the same paired-capture shape with `@name.signature.X`, `@params.signature.X`, optional `@return.signature.X`, and `@signature.X` for the body span.

**Acceptance**:
- [ ] All 10 files load via the extended `loadQueryFile`.
- [ ] Phase 2.5 (slicer) consumes these queries.
- [ ] Each language's signatures fixture (≥ 1 fixture per lang) extracts ≥ 5 signatures.

### Task 1.5.2 — `slice_seeds.scm` for the same 10 languages

**Files**: `dist/grammars/queries/<lang>/slice_seeds.scm`.

Each captures statements that can be slice criteria (assignments, returns, throws, calls, conditionals). Pattern matches Tessera-2A: slicing operates at statement granularity. Captures use `@slice.seed.<kind>`.

**Acceptance**:
- [ ] Loader returns a compiled `Query` object per language.
- [ ] Phase 2.5 (slicer) consumes these queries.

---

## Phase 2 — Atlas (256-bit SimHash + Frequency + PageRank + Framework Patterns)

> **Goal**: per-pool 256-bit SimHash banded into 8 × 32-bit; 256-bit Bloom of references; Sort-&-Slice frequency-truncated boilerplate atlas; framework-pattern catalog; Personalized PageRank centrality. F22, F35, F36, F38, F39.

### Task 2.1 — 256-bit SimHash + bands + Hamming

**Files**:
- Create: `dist/core/chiron/simhash.js` (hand-authored, ≈ 110 lines)
- Create: `tests/chiron/simhash.test.js`

**Implementation** (final code):

```js
// dist/core/chiron/simhash.js
import { blake3 } from '@noble/hashes/blake3';

const SIMHASH_KEY = blake3(new TextEncoder().encode('ZNCP SIMHASH FEATURE'), { dkLen: 32 });
const FP_BITS = 256;

/**
 * 256-bit SimHash over the multiset of subtree token n-grams.
 * Banding: 8 × 32-bit bands. A band collision cuts the candidate set substantially;
 * Hamming distance is the final filter. Choice of 256 over 64 is mandatory: 64-bit
 * conflates boilerplate-similar functions (E47 / SolveRank 12× P@1 collapse).
 *
 * Returns Uint8Array(32).
 */
export function computeSimHash(tokens) {
  const acc = new Int32Array(FP_BITS);
  for (const t of tokens) {
    const h = blake3(new TextEncoder().encode(t), { key: SIMHASH_KEY, dkLen: 32 });
    for (let bit = 0; bit < FP_BITS; bit++) {
      const byte = h[bit >> 3];
      const set = (byte >> (bit & 7)) & 1;
      acc[bit] += set ? 1 : -1;
    }
  }
  const out = new Uint8Array(32);
  for (let bit = 0; bit < FP_BITS; bit++) {
    if (acc[bit] >= 0) out[bit >> 3] |= 1 << (bit & 7);
  }
  return out;
}

export function toHex(buf) {
  return Array.from(buf, x => x.toString(16).padStart(2, '0')).join('');
}

/** Split a 256-bit fingerprint into 8 × 32-bit bands as unsigned integers. */
export function bandsOf(buf32) {
  const view = new DataView(buf32.buffer, buf32.byteOffset, buf32.byteLength);
  const bands = new Array(8);
  for (let i = 0; i < 8; i++) bands[i] = view.getUint32(i * 4, /* littleEndian */ false);
  return bands;
}

export function popcount256(buf32) {
  let c = 0;
  for (let i = 0; i < 32; i++) {
    let b = buf32[i];
    while (b) { c += b & 1; b >>>= 1; }
  }
  return c;
}

export function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < 32; i++) {
    let x = a[i] ^ b[i];
    while (x) { d += x & 1; x >>>= 1; }
  }
  return d;
}

/**
 * Build the feature multiset for a node from its descendants.
 * Each feature is `${kind}:${shortHash}` — multiset semantics; reordering is a no-op.
 */
export function buildFeatures(records, anchorIdx) {
  const feats = [];
  function walk(idx) {
    const r = records[idx];
    feats.push(`${r.kind}:${r.short_hash}`);
    for (const ci of r.childIndices) walk(ci);
  }
  walk(anchorIdx);
  return feats;
}
```

**Acceptance**:
- [ ] Two near-identical TS functions (rename only) produce Hamming distance ≤ 24 over a 100-fixture sample (256-bit / 8-band geometry; per-bit collision probability ≈ s^32).
- [ ] Bands deterministic across runs.
- [ ] Empty token list yields all-zero fingerprint.

### Task 2.2 — Bloom-of-references per pool entry

**Files**:
- Create: `dist/core/chiron/bloom_refs.js` (hand-authored, ≈ 65 lines)

Pattern: 256-bit Bloom (32 bytes), 3 hash functions derived from BLAKE3 with three different domain keys (`ZNCP BLOOM 1`, `ZNCP BLOOM 2`, `ZNCP BLOOM 3`). Stores membership of identifiers referenced inside a subtree. Used for fast structural-similarity pre-filter and slicer transitive closure (HyperAST per-subtree Bloom precedent — F22).

**Acceptance**:
- [ ] False-positive rate ≤ 5% on 1000 randomly-sampled subtrees with target identifier sets ≤ 30.
- [ ] False-negative rate = 0% (Bloom guarantee).

### Task 2.3 — Atlas seeder (Sort & Slice + NeighborRetr partition)

**Files**:
- Create: `dist/core/chiron/atlas.js` (hand-authored, ≈ 280 lines)
- Create: `tests/chiron/atlas.test.js`

**Implementation outline**:

```js
// dist/core/chiron/atlas.js

const L_DEFAULT = 2048;  // Sort & Slice top-L

/**
 * Seed atlas_frequency from node_pool counts.
 * Sort & Slice (F36): top-L most frequent structural hashes are flagged
 * boilerplate; the long tail drives novelty. NeighborRetr (F35): k-occurrence
 * partition (anti < 4, good 4..16, bad > 16).
 *
 * Drift detection (CHIRON contribution): for every structural_hash whose
 * k_occurrence_class changed since the previous run, emit a `drift_event`.
 */
export function seedFrequencyAtlas(db, canonId, opts = {}) {
  const L = opts.L ?? L_DEFAULT;
  const runId = opts.runId ?? `run_${Date.now()}`;

  const txn = db.transaction(() => {
    // Capture previous classes so we can compute drift_events
    const prev = new Map();
    for (const r of db.prepare(`
      SELECT structural_hash, occurrence_count, k_occurrence_class
      FROM atlas_frequency WHERE canon_version_id = ?
    `).iterate(canonId)) {
      prev.set(r.structural_hash, { k: r.occurrence_count, cls: r.k_occurrence_class });
    }

    db.prepare(`DELETE FROM atlas_frequency WHERE canon_version_id = ?`).run(canonId);
    const rows = db.prepare(`
      SELECT np.structural_hash, COUNT(no.id) AS cnt
      FROM node_pool np
      JOIN node_occurrence no ON no.pool_id = np.id
      WHERE np.canon_version_id = ?
      GROUP BY np.id
      ORDER BY cnt DESC
    `).all(canonId);

    let rank = 1;
    const insertFreq = db.prepare(`
      INSERT INTO atlas_frequency
        (canon_version_id, structural_hash, occurrence_count, rank, is_boilerplate, k_occurrence_class, last_recomputed)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDrift = db.prepare(`
      INSERT INTO drift_event
        (structural_hash, canon_version_id, prev_class, new_class, prev_k, new_k, delta_k, detected_at, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const row of rows) {
      const k = row.cnt;
      const cls = k < 4 ? 'anti' : (k <= 16 ? 'good' : 'bad');
      const isBp = rank <= L ? 1 : 0;
      insertFreq.run(canonId, row.structural_hash, k, rank, isBp, cls, now);
      // Drift event if class changed
      const prior = prev.get(row.structural_hash);
      if (!prior || prior.cls !== cls) {
        insertDrift.run(
          row.structural_hash, canonId,
          prior?.cls ?? null, cls,
          prior?.k ?? null, k, k - (prior?.k ?? 0),
          now, runId
        );
      }
      rank++;
    }

    // Refresh novelty_score on node_pool: 1 / (1 + ln(occurrence_count)).
    db.exec(`
      UPDATE node_pool SET novelty_score = (
        SELECT 1.0 / (1.0 + LN(CAST(af.occurrence_count AS REAL)))
        FROM atlas_frequency af
        WHERE af.canon_version_id = node_pool.canon_version_id
          AND af.structural_hash = node_pool.structural_hash
      )
      WHERE EXISTS (SELECT 1 FROM atlas_frequency af WHERE af.structural_hash = node_pool.structural_hash);
    `);
  });
  txn();
  return { runId };
}

/**
 * Drift release-gate signal: count of pool entries whose hub_class changed
 * in the latest run. >5% threshold triggers human review.
 */
export function computeDriftRate(db, runId) {
  const driftCount = db.prepare(`SELECT COUNT(*) AS c FROM drift_event WHERE run_id = ?`).get(runId).c;
  const total = db.prepare(`SELECT COUNT(*) AS c FROM node_pool`).get().c;
  return total > 0 ? driftCount / total : 0;
}
```

**Acceptance**:
- [ ] On a 5k-LOC TS sample, `atlas_frequency` populates with `rank` 1..N, `is_boilerplate=1` for rank ≤ 2048.
- [ ] `novelty_score` is monotonic-decreasing in `occurrence_count`.
- [ ] After two runs with no source changes, `drift_event` is empty.
- [ ] After one run, then injecting 50 generated identical-shape getters, then re-running: `drift_event` rows for affected hashes show `prev_class='good'` → `new_class='bad'`.

### Task 2.4 — Framework patterns

**Files**:
- Create: `dist/core/chiron/atlas_framework.js` — populates `atlas_framework` from a hard-coded table.

The table is fixed (≤ 50 rows). Per-language: nestjs `@Controller`/`@Module` (×3.2); fastapi `@app.get`/`FastAPI(` (×3.0); flask (×2.8); spring `@RestController`/`@SpringBootApplication` (×3.2); jaxrs `@Path`/`@GET` (×3.0); aspnet `[ApiController]` (×3.2); laravel `Route::` (×3.0); express `app.get(`/`Router()` (×2.9). Run-once on first DB creation.

### Task 2.5 — Personalized PageRank with direct-import boost

**Files**:
- Create: `dist/core/chiron/pagerank.js` (hand-authored, ≈ 200 lines)
- Create: `tests/chiron/pagerank.test.js`

**Implementation outline**: Power-iteration over the symbol-level graph derived from existing `edges` table, joined to CHIRON node_occurrence via `chiron_short_hash`. Damping 0.85, ≤ 30 iterations, tolerance 1e-6, dangling-mass redistribution. **Direct-import boost ×50** (Aider Issue #2405 — F38) implemented as personalization vector. Computes per `canon_version_id`; cache lifetime tied to file index versions.

**Acceptance**:
- [ ] On a 5k-LOC TS sample, PageRank converges in ≤ 25 iterations (residual < 1e-6).
- [ ] Top-20 entities are heavily-imported modules (sanity check on a known repo).
- [ ] When `focusPaths` non-empty, those paths' symbols receive ×50 personalization mass.

### Phase 2 exit criteria

- [ ] 256-bit SimHash + 8 × 32-bit band index populates per-pool entry.
- [ ] Bloom-of-refs per pool entry; FPR ≤ 5%.
- [ ] `atlas_frequency`, `atlas_framework`, `atlas_pagerank` populate correctly.
- [ ] Drift events detected and recorded per run.
- [ ] All atlas computations are file-incremental.

---

## Phase 2.5 — Slicer + Patch Context (parallel with Phase 2)

> **Goal**: deterministic forward/backward slicing using existing `edges` plus new `slice_seeds.scm` queries; persistent slice index in `slice` and `slice_member` tables; PCT extraction. A5, F7, F8, F31.

### Task 2.5.1 — Slicer

**Files**:
- Create: `dist/core/chiron/slicer.js` (hand-authored, ≈ 220 lines)
- Create: `tests/chiron/slicer.test.js`

**Implementation outline**:

```js
// dist/core/chiron/slicer.js
import { blake3 } from '@noble/hashes/blake3';

const SLICE_KEY = blake3(new TextEncoder().encode('ZNCP SLICE V1'), { dkLen: 32 });

/**
 * Compute a forward / backward slice from a criterion node.
 * Cached by `slice_id = blake3(criterion.node_id || direction || depth || ordered member ids)`
 * — content-addressed, so editing the criterion's source naturally invalidates by id change.
 */
export async function computeSlice(db, criterion, direction, depth, opts = {}) {
  const memberCap = opts.memberCap ?? 20;  // F49 KGCompass cap
  const depthCap = Math.min(depth, 6);

  // Cache hit?
  const cacheCheck = db.prepare(`
    SELECT slice_id, member_count, stale FROM slice
    WHERE criterion_node_id = ? AND direction = ? AND depth = ?
  `).get(criterion.nodeId, direction, depthCap);
  if (cacheCheck && !cacheCheck.stale) {
    const members = db.prepare(`
      SELECT * FROM slice_member WHERE slice_id = ? ORDER BY ordinal
    `).all(cacheCheck.slice_id);
    return { sliceId: cacheCheck.slice_id, members, cached: true };
  }

  // Compute fresh: BFS over edges (call) + node_occurrence siblings (data/control).
  const visited = new Set([criterion.nodeId]);
  const members = [{ node_id: criterion.nodeId, short_hash: criterion.shortHash, ordinal: 0, edge_kind: 'def', hop_distance: 0 }];
  const queue = [{ id: criterion.nodeId, hop: 0 }];

  while (queue.length > 0 && members.length < memberCap) {
    const { id, hop } = queue.shift();
    if (hop >= depthCap) continue;

    // Calls: existing edges table joined to chiron occurrence
    const calls = db.prepare(`
      SELECT no.node_id, no.short_hash
      FROM edges e
      JOIN symbols s ON s.id = e.container_def_id
      JOIN symbols s2 ON s2.name = e.referenced_name AND s2.kind = 'def'
      JOIN node_occurrence no ON no.symbol_id = s2.id
      JOIN node_occurrence no_caller ON no_caller.symbol_id = s.id AND no_caller.node_id = ?
      WHERE no.node_id IS NOT NULL
      LIMIT ${memberCap - members.length}
    `).all(id);

    for (const c of calls) {
      if (members.length >= memberCap) break;
      if (visited.has(c.node_id)) continue;
      visited.add(c.node_id);
      members.push({ node_id: c.node_id, short_hash: c.short_hash, ordinal: members.length, edge_kind: 'call', hop_distance: hop + 1 });
      queue.push({ id: c.node_id, hop: hop + 1 });
    }
    // Data/control via slice_seeds.scm captures intersected with structural traversal.
    // ... (≈ 50 more lines)
  }

  // Compute content-addressed slice_id
  const memberIds = members.map(m => m.node_id);
  const buf = new TextEncoder().encode(`${criterion.nodeId}|${direction}|${depthCap}|${memberIds.join(',')}`);
  const sliceId = bufToHex(blake3(buf, { key: SLICE_KEY, dkLen: 32 }));

  // Upsert slice + members in transaction
  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO slice (slice_id, criterion_node_id, direction, depth, member_count, computed_at, canon_version_id, stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(slice_id) DO UPDATE SET stale = 0, computed_at = excluded.computed_at
    `).run(sliceId, criterion.nodeId, direction, depthCap, members.length, Date.now(), criterion.canonVersionId);
    db.prepare(`DELETE FROM slice_member WHERE slice_id = ?`).run(sliceId);
    const insertM = db.prepare(`
      INSERT INTO slice_member (slice_id, node_id, short_hash, ordinal, edge_kind, hop_distance)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const m of members) insertM.run(sliceId, m.node_id, m.short_hash, m.ordinal, m.edge_kind, m.hop_distance);
  });
  txn();

  return { sliceId, members, cached: false };
}

export function slicesContaining(db, shortHash) {
  return db.prepare(`
    SELECT DISTINCT s.slice_id, s.criterion_node_id, s.direction, s.stale
    FROM slice s
    JOIN slice_member sm ON sm.slice_id = s.slice_id
    WHERE sm.short_hash = ?
  `).all(shortHash);
}

/** Mark slices stale on incremental file change (Task 1.3 caller responsibility). */
export function invalidateSlicesForChangedHashes(db, changedHashes) {
  if (changedHashes.length === 0) return;
  const stmt = db.prepare(`
    UPDATE slice SET stale = 1 WHERE slice_id IN (
      SELECT DISTINCT slice_id FROM slice_member WHERE short_hash = ?
    )
  `);
  const txn = db.transaction(() => { for (const h of changedHashes) stmt.run(h); });
  txn();
}
```

**Acceptance**:
- [ ] Forward slice from a known function returns transitive callees up to depth 3.
- [ ] Re-running the same query returns the cached row (no recomputation).
- [ ] Editing the criterion's source flips `slice.stale = 1` for affected slices.
- [ ] 20-member cap enforced.

### Task 2.5.2 — Patch Context tuple

**Files**:
- Create: `dist/core/chiron/patch_context.js` (hand-authored, ≈ 160 lines)

**Implementation outline** (Refine `C(P) = (DDℓ, CDℓ, ICℓ, CGℓ)` adapted to AST nodes):
- `dataDeps`: backward slice depth 1.
- `controlDeps`: walk up `parent_node_id` until next `if/for/while/switch/try`.
- `interfaceContracts`: extract via `signatures.scm` for the criterion's enclosing function.
- `callGraph`: forward slice depth 1.

**Acceptance**:
- [ ] Patch Context bounded ≤ 20 functions per Tessera-3A Finding 20 (KGCompass cap); soft cap, hard cap 40 with `truncated: true` flag.

---

## Phase 3 — MCP Tool Surface (5 tools), Read Registry, Heal, Verifier

> **Goal**: 5 MCP tools with flat-mode-string Zod schemas; DB-backed read registry; deterministic heal cascade; symmetric `verifyEditHandoff()` for PLAN1's lock contract.

### Task 3.0 — Read Registry & Idempotency Store

**Files**:
- Create: `dist/core/chiron/read_registry.js` (hand-authored, ≈ 130 lines)
- Create: `dist/core/chiron/idempotency.js` (hand-authored, ≈ 130 lines)
- Create: `tests/chiron/read_registry.test.js`
- Create: `tests/chiron/idempotency.test.js`

**Implementation** (essential body):

```js
// dist/core/chiron/read_registry.js
export function issueReadRegistry(db, sessionId, filePath, shortHashes, canonVersionId) {
  const stmt = db.prepare(`
    INSERT INTO read_registry (short_hash, file_path, origin, canon_version_id, issued_at, session_id)
    VALUES (?, ?, 'vault', ?, ?, ?)
    ON CONFLICT(short_hash, file_path, session_id)
    DO UPDATE SET issued_at = excluded.issued_at, canon_version_id = excluded.canon_version_id
  `);
  const txn = db.transaction(() => {
    const now = Date.now();
    for (const h of shortHashes) stmt.run(h, filePath, canonVersionId, now, sessionId);
  });
  txn();
}

export function verifyReadRegistry(db, sessionId, filePath, shortHash) {
  const row = db.prepare(`
    SELECT issued_at, canon_version_id FROM read_registry
    WHERE short_hash = ? AND file_path = ? AND session_id = ?
  `).get(shortHash, filePath, sessionId);
  if (!row) return { ok: false, code: 'NEVER_READ', shortMessage: 'Hash never issued for this session+path' };
  if (Date.now() - row.issued_at > 60 * 60 * 1000) {
    return { ok: false, code: 'FILE_CHANGED', shortMessage: 'Hash older than 1h; re-read required' };
  }
  return { ok: true, canonVersionId: row.canon_version_id };
}

export function pruneReadRegistry(db, ttlMs = 3600000) {
  db.prepare(`DELETE FROM read_registry WHERE issued_at < ?`).run(Date.now() - ttlMs);
}
```

```js
// dist/core/chiron/idempotency.js
import { createHash } from 'crypto';

export function lookupIdempotency(db, idempotencyKey, requestBody) {
  const row = db.prepare(`SELECT response_blob, request_hash FROM idempotency_log WHERE idempotency_key = ?`)
    .get(idempotencyKey);
  if (!row) return null;
  const liveHash = createHash('sha256').update(JSON.stringify(requestBody)).digest('hex');
  if (liveHash !== row.request_hash) {
    // Same key, different request: protocol violation
    return { conflict: true };
  }
  return { conflict: false, response: JSON.parse(row.response_blob) };
}

export function commitIdempotency(db, idempotencyKey, toolName, requestBody, response, ttlMs = 3600000) {
  const requestHash = createHash('sha256').update(JSON.stringify(requestBody)).digest('hex');
  const now = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO idempotency_log
      (idempotency_key, tool_name, request_hash, response_blob, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(idempotencyKey, toolName, requestHash, JSON.stringify(response), now, now + ttlMs);
}

export function pruneIdempotency(db) {
  db.prepare(`DELETE FROM idempotency_log WHERE expires_at < ?`).run(Date.now());
}
```

**Acceptance**:
- [ ] Replaying a tool call with the same `idempotencyKey` and same body returns the prior result with `replayed: true`.
- [ ] Replaying with the same key but different body returns `IDEMPOTENCY_KEY_CONFLICT` (PLAN1 doesn't have this; we use `BUDGET_EXCEEDED` plus `suggestedAction: "Use a fresh idempotency key for a new request"`).
- [ ] `pruneReadRegistry` removes rows older than 1h on a periodic timer (every 5 min).

### Task 3.1 — `chiron_outline` tool

**Files**:
- Create: `dist/tools/chiron_outline.js` (hand-authored, ≈ 240 lines)
- Create: `src/tools/chiron_outline.ts`
- Create: `tests/tools/chiron_outline.test.js`

**Pattern reference**: `dist/tools/read_file.js:13-162` (`register` + `handler` shape).

**Tool schema (flat-mode-string)**:

```js
// dist/tools/chiron_outline.js
import { z } from 'zod';
import path from 'path';
import fs from 'fs/promises';
import { chironIndexFile } from '../core/chiron/lsf.js';
import { findRepoRoot, getDb } from '../core/symbol-index.js';
import { issueReadRegistry } from '../core/chiron/read_registry.js';
import { commitIdempotency, lookupIdempotency } from '../core/chiron/idempotency.js';

const OUTLINE_CAP_DEFAULT = 250;       // PLAN1 default
const SINGLE_EDIT_BUDGET = 0.35;       // PLAN1 provisional
const BATCH_BUDGET       = 0.45;

export function register(server, ctx) {
  server.registerTool('chiron_outline', {
    title: 'CHIRON Outline',
    description:
      "PLAN1-shaped StructuralOutlineResult. Mode 'outline' returns structure only " +
      "(default). Mode 'with_content' includes file body. Mode 'paged' returns content " +
      "for specific node hashes only.",
    inputSchema: z.object({
      mode: z.enum(['outline', 'with_content', 'paged']).describe(
        "outline: structure only. with_content: include body. paged: content for specific hashes."
      ),
      path: z.string().describe('File path under an allowed root.'),
      // mode='paged' uses nodeHashes
      nodeHashes: z.array(z.string()).optional().describe(
        "For mode 'paged': list of 16-hex node short_hashes to fetch content for."
      ),
      maxNodes: z.number().optional().describe('Outline cap. Default 250.'),
      includeWitness: z.boolean().optional().describe('Emit 64-byte witness on each entry. Default true.'),
      idempotencyKey: z.string().describe('Client-generated UUID per F29.'),
      origin: z.enum(['vault', 'editor']).optional().describe('Source origin tag for PLAN1.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (args) => {
    const validPath = await ctx.validatePath(args.path);
    const repoRoot = findRepoRoot(validPath);
    if (!repoRoot) return errEnvelope('PATH_UNSAFE', 'No repo root for path');
    const db = getDb(repoRoot);

    // Idempotency replay
    const idem = lookupIdempotency(db, args.idempotencyKey, args);
    if (idem && !idem.conflict) return idem.response;
    if (idem && idem.conflict) return errEnvelope('BUDGET_EXCEEDED',
      'Idempotency key reused with different request body. Use a fresh UUID.');

    const indexed = await chironIndexFile(db, repoRoot, validPath);
    if (!indexed) return errEnvelope('SYMBOL_TARGET_UNAVAILABLE', 'language unsupported');

    const relPath = path.relative(repoRoot, validPath);
    const fileRow = db.prepare(
      'SELECT source_file_hash16, canon_version_id, file_size_bytes FROM chiron_file_hash WHERE file_path = ?'
    ).get(relPath);

    const cap = Math.min(args.maxNodes ?? OUTLINE_CAP_DEFAULT, OUTLINE_CAP_DEFAULT);
    const includeWitness = args.includeWitness ?? true;

    const outlineRows = db.prepare(`
      SELECT no.short_hash AS hash, no.short_structural AS shortStructural,
             no.parent_short_hash AS parentHash, no.child_type AS childType,
             no.child_index AS childIndex, np.node_kind AS type, no.start_byte, no.end_byte,
             no.start_line, no.end_line, no.content_witness, np.bloom_of_refs IS NOT NULL AS hasBloom
      FROM node_occurrence no
      JOIN node_pool np ON np.id = no.pool_id
      WHERE no.file_path = ?
      ORDER BY no.start_byte ASC
      LIMIT ?
    `).all(relPath, cap);

    // Issue read-registry tokens for every short_hash returned
    const sessionId = ctx.sessionId();
    issueReadRegistry(
      db, sessionId, validPath,
      outlineRows.map(o => o.hash),
      fileRow.canon_version_id
    );

    const result = {
      ok: true,
      data: {
        path: validPath,
        sourceFileHash16: fileRow.source_file_hash16,
        origin: args.origin ?? 'vault',
        outline: outlineRows.map(o => ({
          hash: o.hash,
          shortStructural: o.shortStructural,
          parentHash: o.parentHash,
          childType: o.childType,
          childIndex: o.childIndex,
          type: o.type,
          byteRange: [o.start_byte, o.end_byte],
          lineRange: [o.start_line, o.end_line],
          contentWitness: includeWitness ? o.content_witness : undefined,
        })),
        generatedAt: Date.now(),
        fileSizeBytes: fileRow.file_size_bytes,
        currentBudgetThreshold: SINGLE_EDIT_BUDGET,
      },
      attempts: 1,
      pageFaults: [],
      budgetUsed: { bytes: 0, tokens: 0, wallMs: 0 },
      canonVersion: lookupCanonVersionById(db, fileRow.canon_version_id),
    };

    if (args.mode === 'with_content') {
      result.data.content = await fs.readFile(validPath, 'utf-8');
    } else if (args.mode === 'paged') {
      const wanted = new Set(args.nodeHashes ?? []);
      result.data.nodes = await readSpecificNodes(db, repoRoot, validPath, wanted);
    }

    commitIdempotency(db, args.idempotencyKey, 'chiron_outline', args, result);
    return result;
  });
}

// helpers (errEnvelope, readSpecificNodes, lookupCanonVersionById) — straightforward, ≈ 50 lines
```

**Acceptance**:
- [ ] `chiron_outline({ mode: 'outline', path, idempotencyKey })` returns SIRs with valid `hash`, `parentHash`, `childType`, `childIndex`, `contentWitness`.
- [ ] After call, `read_registry` contains a row per returned `hash`.
- [ ] PLAN1 can construct a valid `EditDocumentRequest` from any returned outline entry — verified by an integration fixture in Task 3.6.
- [ ] `mode: 'with_content'` includes `data.content`; `mode: 'paged'` includes `data.nodes`.
- [ ] Replaying the same `idempotencyKey` returns the cached response.

### Task 3.2 — `chiron_search` tool

**Files**:
- Create: `dist/tools/chiron_search.js` (hand-authored, ≈ 380 lines)
- Create: `tests/tools/chiron_search.test.js`

**Modes** (single tool, flat-mode-string):
- `'symbol'`: BM25 over symbol name (existing `BM25Index` from `dist/core/shared.js`); returns `PatchEnvelope[]`.
- `'structural'`: banded SimHash candidates against a seed `shortHash`; ranked by Hamming + novelty + framework_multiplier.
- `'slice'`: forward/backward slice rooted at a `shortHash`.
- `'patch_context'`: returns `(PatchEnvelope + patchContext)` for a `shortHash`.
- `'pagerank'`: top-N by PageRank, optionally filtered by `framework`.

**Schema**:

```js
inputSchema: z.object({
  mode: z.enum(['symbol', 'structural', 'slice', 'patch_context', 'pagerank']),
  path: z.string().optional().describe('File path or directory.'),
  // shared
  maxResults: z.number().optional().describe('Default 20 (KGCompass cap).'),
  budgetTokens: z.number().optional(),
  excludeBoilerplate: z.boolean().optional().describe('Filter hub_class=bad. Default true.'),
  // symbol
  symbolQuery: z.string().optional(),
  symbolKind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'module', 'any']).optional(),
  // structural / slice / patch_context
  seedHash: z.string().optional().describe("16-hex short hash from a prior chiron_outline."),
  // structural
  hammingMax: z.number().optional().describe('Max Hamming over 256 bits. Default 64 (relaxed). Strict ≤ 24.'),
  // slice
  direction: z.enum(['forward', 'backward', 'both']).optional(),
  depth: z.number().optional().describe('Slice depth 1..6. Default 3.'),
  // pagerank
  framework: z.string().optional(),
  // shared
  idempotencyKey: z.string(),
}),
```

**Algorithm for `mode: 'structural'`** (final):
1. Validate `seedHash` is in `read_registry` for current session+path or globally for any read in last hour. If not → `NEVER_READ`.
2. Resolve `seedHash` → `pool_id` via `node_pool.short_hash`.
3. SELECT pool entries that share at least 1 of the seed's 8 bands (banded LSH candidate set). The banded SQL:
   ```sql
   SELECT DISTINCT lb1.pool_id
   FROM locality_band lb1
   WHERE EXISTS (
     SELECT 1 FROM locality_band lb_seed
     WHERE lb_seed.pool_id = ?
       AND lb_seed.band_index = lb1.band_index
       AND lb_seed.band_value = lb1.band_value
   )
   LIMIT ?  -- candidate cap (5× maxResults)
   ```
4. Compute exact Hamming distance over `simhash256` for each candidate.
5. Filter: `hamming ≤ args.hammingMax ?? 64`.
6. Rank: `score = (1 - hamming/256) × novelty_score × pagerank_score × framework_multiplier`.
7. Apply NeighborRetr filter: when `excludeBoilerplate ≠ false`, drop rows where `k_occurrence_class = 'bad'`. `KARYON_BAD_HUB`-style refusal: if remaining candidates have `bad`-only entries above threshold, surface `AMBIGUOUS_TARGET` with the bad-hub class explicit.
8. Resolve to top-N occurrences; build `PatchEnvelope[]`.

**Acceptance**:
- [ ] Search by structural similarity returns the seed itself at distance 0 with highest score.
- [ ] Renamed clones surface at low Hamming distance.
- [ ] Boilerplate (rank ≤ 2048) deprioritized in output.
- [ ] Empty result when `seedHash` was never issued — diagnostic `NEVER_READ`.
- [ ] Result cap = 20.

### Task 3.3 — `chiron_fault_in` tool (with streaming page faults)

**Files**:
- Create: `dist/tools/chiron_fault_in.js` (hand-authored, ≈ 260 lines)
- Create: `dist/core/chiron/page_manager.js` (hand-authored, ≈ 250 lines)
- Create: `tests/tools/chiron_fault_in.test.js`

> **The demand-paged surface.** Returns `PatchEnvelope + body bytes` for a hash. Records page-fault events and **streams them as the response is being built** (CHIRON contribution). F25, F41.

**Schema**:

```js
inputSchema: z.object({
  mode: z.enum(['node', 'slice', 'symbol_def', 'signature']),
  // node + signature
  hash: z.string().optional(),
  // slice
  sliceId: z.string().optional(),
  // symbol_def
  symbolName: z.string().optional(),
  symbolType: z.string().optional(),
  scope: z.string().optional(),
  // shared
  fidelity: z.enum(['summary', 'signature', 'full']).optional()
    .describe("Page fidelity. summary = 1-line, signature = type contract, full = bytes."),
  budgetBytes: z.number().optional().describe('Hard cap. Default 64KB. Max 256KB.'),
  idempotencyKey: z.string(),
}),
```

**Implementation outline**:
- L1: in-process LRU, 4096 entries, ~32 MB max.
- L2: `node_pool` + `node_occurrence` cached page (DB-backed).
- L3: file re-read (last resort).
- Records every transition as a `page_fault_log` row AND emits the event in the envelope's `pageFaults: PageFaultEvent[]`.
- **Streaming behavior**: when running over an MCP transport that supports incremental tool output (chunked stdout JSON-RPC notifications), each fault is emitted as a `notifications/progress` JSON-RPC frame keyed by the request id. When the transport doesn't support streaming, all faults coalesce into the final envelope (graceful fallback).
- `BUDGET_PAGED` honored: oversize requests return tombstone `[Paged out: <hash> (<size>B). Re-fault with budget≥X.]` (Pichay format, H10).
- `fidelity: 'signature'` runs `signatures.scm` query at the node's byte range.

**Acceptance**:
- [ ] Cold fault (L3) on a 50KB file returns within 30 ms p50.
- [ ] Warm fault (L1) returns within 1 ms p50.
- [ ] Page-fault events emitted with correct `eventType`, `fromTier`, `toTier`, `costMs`.
- [ ] `budgetBytes` honored; oversize requests return `BUDGET_PAGED`.
- [ ] When transport supports `notifications/progress`, faults are streamed as they occur.
- [ ] Idempotency replay short-circuits the entire fault-in.

### Task 3.4 — `chiron_heal` tool + healing cascade

**Files**:
- Create: `dist/tools/chiron_heal.js` (hand-authored, ≈ 380 lines)
- Create: `dist/core/chiron/heal.js` (hand-authored, ≈ 600 lines — the cascade)
- Create: `tests/chiron/heal.test.js`

**Schema**:

```js
inputSchema: z.object({
  mode: z.enum(['heal']),
  staleHash: z.string().describe('16-hex short hash that no longer resolves.'),
  filePath: z.string(),
  expectedSignature: z.string().optional().describe('First N bytes the agent expected at the target.'),
  idempotencyKey: z.string(),
  maxLatencyMs: z.number().optional().describe('Wall budget. Default 5000.'),
}),
```

**Cascade (final algorithm — F52, F53, F54, F55, F60)**:

```js
// dist/core/chiron/heal.js — five-tier broadening cascade
const TIER_WEIGHT = { 1: 1.00, 2: 0.85, 3: 0.70, 4: 0.55 };
const HEAL_THRESHOLD = 0.85;
const TIER_BUDGETS_MS = { 1: 5, 2: 100, 3: 500, 4: 2000, total: 5000 };

export async function heal(db, repoRoot, request) {
  const { staleHash, filePath, expectedSignature, idempotencyKey, maxLatencyMs = 5000 } = request;

  // Idempotency cache
  const cached = db.prepare(`
    SELECT * FROM heal_cache WHERE stale_hash = ? AND file_path = ? AND idempotency_key = ?
  `).get(staleHash, filePath, idempotencyKey);
  if (cached) return cacheToReport(cached);

  const t0 = Date.now();
  const candidates = [];

  // ── Tier 1: exact (structural_hash, label_hash) lookup. Weight 1.00. Budget 5ms.
  const tier1 = db.prepare(`
    SELECT no.* FROM node_occurrence no
    JOIN node_pool np ON np.id = no.pool_id
    WHERE no.short_hash = ? AND no.file_path = ?
    LIMIT 1
  `).get(staleHash, filePath);
  if (tier1) return commitHeal(db, request, { status: 'healed', tier: 1, confidence: 1.00, best: occToEnvelope(tier1, db, repoRoot) });

  // ── Tier 2: banded SimHash + Hamming filter. Weight 0.85. Budget 100ms.
  if (Date.now() - t0 < maxLatencyMs - 100) {
    const tier2 = bandedSimHashLookup(db, staleHash, filePath, /* K_strict */ 24, /* K_relaxed */ 64);
    if (tier2.length === 1 && (1 - tier2[0].hamming / 256) * 0.85 >= HEAL_THRESHOLD) {
      return commitHeal(db, request, {
        status: 'healed', tier: 2, confidence: (1 - tier2[0].hamming / 256) * 0.85,
        best: tier2[0].envelope,
      });
    }
    candidates.push(...tier2.map(c => c.envelope));
  }

  // ── Tier 3: RMiner-style 5-round structured matcher. Weight 0.70. Budget 500ms.
  if (Date.now() - t0 < maxLatencyMs - 500) {
    const tier3 = rminerLikeMatch(db, staleHash, filePath, /* exclude */ candidates.map(c => c.hash));
    if (tier3.confidence >= HEAL_THRESHOLD) {
      return commitHeal(db, request, { status: 'healed', tier: 3, confidence: tier3.confidence, best: tier3.best });
    }
    candidates.push(...tier3.candidates);
  }

  // ── Tier 4: CodeMapper-style movement + Levenshtein. Weight 0.55. Budget 2000ms.
  if (Date.now() - t0 < maxLatencyMs - 2000 && expectedSignature) {
    const tier4 = await codeMapperFusion(db, repoRoot, staleHash, filePath, expectedSignature, candidates.map(c => c.hash));
    if (tier4 && tier4.confidence >= HEAL_THRESHOLD) {
      return commitHeal(db, request, { status: 'healed', tier: 4, confidence: tier4.confidence, best: tier4.best });
    }
    if (tier4) candidates.push(...tier4.candidates);
  }

  // ── Tier 5: surface ambiguity (Spork principle, F54). NEVER silently select.
  const dedupedTop = dedupAndRank(candidates, /* k */ 5);
  return commitHeal(db, request, {
    status: dedupedTop.length === 0 ? 'miss' : 'ambiguous', tier: 5, confidence: dedupedTop[0]?.score ?? 0,
    candidates: dedupedTop,
    failureClass: 'argument_hallucination',
    recommendation: 'Request chiron_outline and pick the correct hash from the candidates.',
    exampleValidCall: { mode: 'outline', path: request.filePath, idempotencyKey: '<new uuid>' },
  });
}
```

**Verification gate** (F56) — every Tier 3 / Tier 4 candidate must pass:
1. `chiron_file_hash.blake3_hex` matches the file's current BLAKE3 hash.
2. `tree-sitter parse` produces no new ERROR nodes at the candidate's byte range.
3. The candidate's `(structural_hash, label_hash)` already exists in `node_pool`.

If any check fails, the candidate is dropped from the cascade.

**Round-and-exclude** (F55) is implemented in `rminerLikeMatch`: each round excludes pool ids returned by an earlier round to prevent re-matching.

**Acceptance**:
- [ ] Healing a stale hash after an identifier rename succeeds at Tier 2 (or Tier 3) with confidence ≥ 0.85.
- [ ] Healing a stale hash for a function moved to a new file succeeds at Tier 3 or 4.
- [ ] Healing a stale hash for an aggressively refactored function returns `AMBIGUOUS_HEAL` with ≤ 5 candidates, never silently selects.
- [ ] Tier 1 latency p99 < 5 ms; Tier 2 < 100 ms; full cascade < 5 s.
- [ ] Same `idempotencyKey` returns identical result without re-executing.

### Task 3.5 — `chiron_compress` tool (proxy for the toon bridge)

**Files**:
- Create: `dist/tools/chiron_compress.js` (hand-authored, ≈ 180 lines)

This tool exists so the model can request a CHIRON-aware compression of an arbitrary file in one MCP call (without needing to invoke the bridge directly via the test harness). It delegates to the toon-bridge integration in Phase 4. Its existence in Phase 3 is a **stub** that returns the un-compressed file when Phase 4's `enableChironCompression` flag is `false`; once Phase 4 ships, the stub becomes the real bridge.

**Schema**:

```js
inputSchema: z.object({
  mode: z.enum(['file']),
  path: z.string(),
  budgetChars: z.number().describe('Char budget cap.'),
  multiTurn: z.boolean().optional().describe('Apply 6× cap (default true). Single-turn opt-in cap = 14×.'),
  idempotencyKey: z.string(),
}),
```

### Task 3.6 — `verifyEditHandoff` implementation + PLAN1 integration

**Files**:
- Create: `dist/core/chiron/verify_edit_handoff.js` (hand-authored, ≈ 200 lines)
- Create: `tests/chiron/verify_edit_handoff.test.js`

**Implementation** (the formal contract):

```js
// dist/core/chiron/verify_edit_handoff.js
import fs from 'fs/promises';
import path from 'path';
import { blake3 } from '@noble/hashes/blake3';
import { detectCanonDrift, lookupCanonVersionByTuple } from './canon/registry.js';
import { verifyReadRegistry } from './read_registry.js';

/**
 * Called by PLAN1's FileLockManager UNDER the apply lock (synchronous path).
 * Returns { ok: true, resolvedNode } on success, or { ok: false, code, diagnostic }.
 *
 * F28 + A13 — content witness verification under lock is empirically necessary,
 * not paranoid. Single pass: every check is O(1) DB lookup or O(witnessBytes) byte
 * compare.
 */
export async function verifyEditHandoff(db, repoRoot, sessionId, req) {
  const relPath = path.relative(repoRoot, req.path);

  // 1. Read registry: was this hash ever issued for this session+path?
  const rr = verifyReadRegistry(db, sessionId, req.path, req.target.hash);
  if (!rr.ok) {
    return failure(rr.code, 'Hash never issued for this session+path. Re-read.', { suggestedAction: 'chiron_outline' });
  }

  // 2. Re-check sourceFileHash16
  const fileRow = db.prepare(`
    SELECT blake3_hex, source_file_hash16, canon_version_id, root_short_hash
    FROM chiron_file_hash WHERE file_path = ?
  `).get(relPath);
  if (!fileRow) return failure('FILE_CHANGED', 'File not indexed; re-read.', {});

  // 3. Read current bytes; recompute file hash
  let bytes;
  try { bytes = await fs.readFile(req.path); } catch { return failure('FILE_CHANGED', 'File missing.', {}); }
  const liveBlake3 = bufToHex(blake3(bytes, { dkLen: 32 }));
  if (liveBlake3 !== fileRow.blake3_hex) {
    return failure('FILE_CHANGED', 'File modified since outline.', {
      currentSourceFileHash16: liveBlake3.slice(0, 16),
      suggestedAction: 'chiron_outline',
    });
  }
  if (req.sourceFileHash16 !== fileRow.source_file_hash16) {
    return failure('FILE_CHANGED', 'sourceFileHash16 mismatch with current file.', {
      currentSourceFileHash16: fileRow.source_file_hash16,
      suggestedAction: 'chiron_outline',
    });
  }

  // 4. Canon-version drift detection
  if (req.expectedCanonVersionId !== undefined) {
    const drift = detectCanonDrift(db, req.expectedCanonVersionId, fileRow.canon_version_id);
    if (drift) {
      return failure('CANON_VERSION_MISMATCH',
        `Hash issued under canon ${drift.requested.algorithm}:${drift.requested.language}:${drift.requested.abi_version}:${drift.requested.grammar_version}; file now indexed under ${drift.current.grammar_version}.`,
        { suggestedAction: 'chiron_outline; re-target with fresh hash' });
    }
  }

  // 5. Resolve target node by hash
  const occ = db.prepare(`
    SELECT no.*, np.label_hash AS label_hash_full, np.structural_hash AS structural_hash_full
    FROM node_occurrence no JOIN node_pool np ON np.id = no.pool_id
    WHERE no.short_hash = ? AND no.file_path = ?
  `).get(req.target.hash, relPath);
  if (!occ) {
    // Could be CANON_VERSION_MISMATCH (different canon → different hash) or genuine HASH_NOT_FOUND
    return failure('HASH_NOT_FOUND', 'Target hash not found in current index.', {
      suggestedAction: 'chiron_heal',
      exampleValidCall: { mode: 'heal', staleHash: req.target.hash, filePath: req.path, idempotencyKey: '<new uuid>' },
    });
  }

  // 6. Witness verification (F28)
  if (req.target.contentWitness !== undefined) {
    const witnessBytes = req.target.witnessBytes ?? 64;
    const liveWitness = bytes.toString('utf-8').slice(occ.start_byte, occ.start_byte + witnessBytes);
    if (liveWitness !== req.target.contentWitness) {
      return failure('FILE_CHANGED', 'contentWitness mismatch.', {
        currentBytes: liveWitness, suggestedAction: 'chiron_outline',
      });
    }
  }

  // 7. Structural-position consistency (when caller specified parentHash + childType + childIndex)
  if (req.target.parentHash !== undefined) {
    const expected = occ.parent_short_hash ?? null;
    if (expected !== req.target.parentHash || occ.child_type !== req.target.childType || occ.child_index !== req.target.childIndex) {
      return failure('PATH_MISMATCH', 'Structural position mismatch.', { suggestedAction: 'chiron_outline' });
    }
  }

  return {
    ok: true,
    resolvedNode: occToEnvelope(occ, db, repoRoot),
  };
}

function failure(code, shortMessage, extra) {
  return {
    ok: false, code,
    diagnostic: {
      shortMessage,
      hints: [extra.suggestedAction ?? 'See suggestedAction'],
      suggestedAction: extra.suggestedAction ?? 'chiron_outline',
      exampleValidCall: extra.exampleValidCall ?? { mode: 'outline', path: '<your path>', idempotencyKey: '<new uuid>' },
      currentBytes: extra.currentBytes,
      currentSourceFileHash16: extra.currentSourceFileHash16,
    },
  };
}
```

This function is the **formal cross-tool contract**. PLAN1's `FileWriter.apply()` invokes it under the file lock; the diagnostic shape matches PLAN1's existing diagnostics so PLAN1 doesn't need to translate.

**Acceptance**:
- [ ] Returns `ok: true` on a fresh outline → fresh edit.
- [ ] Returns `FILE_CHANGED` when bytes drift between read and apply.
- [ ] Returns `CANON_VERSION_MISMATCH` when grammar bumped between read and apply.
- [ ] Returns `NEVER_READ` when hash was never issued in this session+path.
- [ ] Returns `PATH_MISMATCH` when caller provided structural position that disagrees with current state.
- [ ] Synchronous path latency < 10 ms p99 (excluding the file read; the file read happens under lock anyway).

### Task 3.7 — Tool registration in `core/server.js`

**Files**:
- Modify: `dist/core/server.js` — insert into `registerAllTools` at line 64 (after `registerRefactorBatch(server, ctx);`).

**Insertion**:

```js
// dist/core/server.js — insertion at line 17 (after existing imports)
import { register as registerChironOutline }   from '../tools/chiron_outline.js';
import { register as registerChironSearch }    from '../tools/chiron_search.js';
import { register as registerChironFaultIn }   from '../tools/chiron_fault_in.js';
import { register as registerChironHeal }      from '../tools/chiron_heal.js';
import { register as registerChironCompress }  from '../tools/chiron_compress.js';

// dist/core/server.js — insertion at line 64 (inside registerAllTools)
function registerAllTools(server, ctx) {
    registerReadFile(server, ctx);
    registerSearchFile(server, ctx);
    registerReadMediaFile(server, ctx);
    registerReadMultipleFiles(server, ctx);
    registerWriteFile(server, ctx);
    registerEditFile(server, ctx);
    registerDirectory(server, ctx);
    registerSearchFiles(server, ctx);
    registerFilesystem(server, ctx);
    registerStashRestore(server, ctx);
    registerRefactorBatch(server, ctx);
    // CHIRON tools (Phase 3)
    registerChironOutline(server, ctx);
    registerChironSearch(server, ctx);
    registerChironFaultIn(server, ctx);
    registerChironHeal(server, ctx);
    registerChironCompress(server, ctx);
}
```

The `instructions` string at line 67-68 is left **unchanged**. CHIRON tools follow the same flat-mode-string convention.

### Phase 3 exit criteria

- [ ] All 5 CHIRON tools registered, return well-formed envelopes.
- [ ] Read registry rejects `NEVER_READ` deterministically.
- [ ] Heal cascade resolves stale anchors across rename / reformat / move; surfaces ambiguity instead of silently selecting.
- [ ] `verifyEditHandoff()` exported and tested; PLAN1's lock contract is implementable.
- [ ] Every fs operation goes through `ctx.validatePath()`.
- [ ] No discriminated-union schema; no banned constructs (`?? ''`, `as any`, etc.).

---

## Phase 4 — Toon Integration & Compression Scoring

> **Goal**: replace the text-mode `toon_bridge.js` with a node-aware bridge that hands toon entries pre-scored by CHIRON. F16, A10, plus the toon `--structured` mode that already exists.

### Task 4.1 — `toon_bridge_chiron.js`

**Files**:
- Create: `dist/core/chiron/toon_bridge_chiron.js` (hand-authored, ≈ 220 lines)
- Modify: `dist/core/compression.js` lines 4-6 — add optional `useChiron` parameter.

**Implementation outline**:

```js
// dist/core/chiron/toon_bridge_chiron.js
// Reads file path + budget like the original toon_bridge.js, but:
//  1. Builds CHIRON PatchEnvelopes over the file's outline.
//  2. Attaches per-envelope scores: novelty (atlas), pagerank, framework_multiplier,
//     slice_membership, k_occurrence_class.
//  3. Forwards a JSON payload with `entries: PatchEnvelope[]` (toon-compatible
//     structured schema) and `budget_chars` to `python3 -m toon --chiron-structured`.
//  4. Falls back to legacy bridge on any failure.

import { chironIndexFile } from './lsf.js';
import { findRepoRoot, getDb } from '../symbol-index.js';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

const inputPath = process.argv[2];
const budget = parseInt(process.argv[3], 10);

async function main() {
  const repoRoot = findRepoRoot(inputPath);
  const db = repoRoot ? getDb(repoRoot) : null;
  if (db) await chironIndexFile(db, repoRoot, inputPath);

  const content = readFileSync(inputPath, 'utf-8');
  if (content.length <= budget) { process.stdout.write(content); return; }

  // Build envelope-scored entries
  const entries = db ? buildScoredEntries(db, repoRoot, inputPath) : null;

  const payload = JSON.stringify({ content, budget, entries: entries ?? null });
  const toonProjectDir = process.env.TOON_PROJECT_DIR || '/home/tanner/Projects/toon';
  try {
    const result = execFileSync('python3', ['-m', 'toon', '--chiron-structured'], {
      input: payload, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 30_000, cwd: toonProjectDir,
    });
    process.stdout.write(result);
  } catch (e) {
    process.stderr.write(`CHIRON toon bridge failed: ${e.message}\n`);
    process.stdout.write(content);  // fall back to raw
  }
}

main().catch(e => { process.stderr.write(`bridge fatal: ${e.message}\n`); process.exit(1); });

function buildScoredEntries(db, repoRoot, filePath) {
  const rel = path.relative(repoRoot, filePath);
  return db.prepare(`
    SELECT no.node_id, no.short_hash, no.start_byte, no.end_byte, no.start_line, no.end_line,
           no.content_witness, np.short_hash AS pool_short, np.novelty_score,
           af.k_occurrence_class, af.is_boilerplate,
           pr.score AS pagerank, fp.multiplier AS framework_mult,
           (SELECT COUNT(*) FROM slice_member sm WHERE sm.short_hash = no.short_hash) AS slice_count
    FROM node_occurrence no
    JOIN node_pool np ON np.id = no.pool_id
    LEFT JOIN atlas_frequency af ON af.canon_version_id = np.canon_version_id
                                AND af.structural_hash = np.structural_hash
    LEFT JOIN atlas_pagerank pr ON pr.node_id = no.node_id
    LEFT JOIN atlas_framework fp ON fp.language = (SELECT language FROM canon_versions WHERE id = np.canon_version_id)
                                AND no.content_witness LIKE '%' || fp.pattern_text || '%'
    WHERE no.file_path = ? AND np.node_kind IN
          ('function_declaration','method_definition','class_declaration',
           'interface_declaration','public_field_definition','arrow_function')
    ORDER BY no.start_byte
  `).all(rel).map(r => ({
    nodeId: r.node_id,
    hash: r.short_hash,
    byteRange: [r.start_byte, r.end_byte],
    lineRange: [r.start_line, r.end_line],
    witness: r.content_witness,
    score: computeChironScore(r),
  }));
}

function computeChironScore({ novelty_score, k_occurrence_class, is_boilerplate, pagerank, framework_mult, slice_count }) {
  let s = (novelty_score ?? 1) * (pagerank ?? 0.001) * (framework_mult ?? 1);
  if (is_boilerplate) s *= 0.1;                                          // F36
  if (k_occurrence_class === 'bad') s *= 0.2;                            // F35
  if (slice_count > 0) s *= 1.2;                                         // F8 (slice membership lift)
  return Math.max(0, Math.min(1, s));
}
```

### Task 4.2 — `compression.js` opt-in

**Files**:
- Modify: `dist/core/compression.js` (add `useChiron` parameter to `compressTextFile` and `runToonBridge`).

**Edit**:

```js
// dist/core/compression.js — top of file, replace existing _BRIDGE constant
const _BRIDGE_LEGACY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'toon_bridge.js');
const _BRIDGE_CHIRON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chiron', 'toon_bridge_chiron.js');

export const DEFAULT_COMPRESSION_KEEP_RATIO = 0.70;

export async function runToonBridge(validPath, budget, opts = {}) {
  const bridge = opts.useChiron ? _BRIDGE_CHIRON : _BRIDGE_LEGACY;
  // ... rest of existing implementation ...
}
```

`compressTextFile` accepts `{ useChiron: boolean }` and forwards. Default `false`. Phase 6 telemetry decides cutover.

### Task 4.3 — toon Python `--chiron-structured` mode

**Files**:
- Modify: `toon/toon/__main__.py` (add `--chiron-structured` flag)
- Modify: `toon/toon/pipeline.py` (consume CHIRON-scored entries)
- Add new function: `toon/toon/string_codec.py:compress_with_chiron_scores`

**Implementation outline**:
- Add `--chiron-structured` flag.
- Parse stdin JSON `{content, budget, entries}` where `entries: { nodeId, hash, byteRange, lineRange, witness, score }[]`.
- **Skip SageRank**: CHIRON already provided `score`. Ranking step replaced by `entries.sort((a,b) => b.score - a.score)`.
- **Skip Stage 1 dedup**: CHIRON pool already deduplicated.
- Run **Stage 3 budget allocation** using CHIRON scores instead of fixed 60/30/10. **Three tiers, signal-conditioned per F16**:
  - score ≥ 0.7 → "preserve" (full body retained);
  - 0.3 ≤ score < 0.7 → "medium" (signature kept, body summarized);
  - score < 0.3 → "low" (tombstone with hash anchor — Pichay format embedding the CHIRON `hash` so the model can re-fault it cheaply).

**Note on the user-memory bug**: the toon Python repo has a known bug where `Node.isMissing` and `Node.hasError` were called as methods rather than getters in `engines/treesitter/core/tree-sitter.js`. This is fixed independently in the toon repo; CHIRON does not touch that file.

**Acceptance**:
- [ ] `python3 -m toon --chiron-structured < payload.json` produces a budget-respected compression.
- [ ] Compressed size ≤ budget; ratio between 0.4× and 0.7× of raw on the test corpus.
- [ ] Bypasses SageRank when `entries` is non-null.
- [ ] Tombstones embed CHIRON `hash` so the model can re-fault by hash.

### Phase 4 exit criteria

- [ ] CHIRON-aware bridge available behind `useChiron` flag.
- [ ] Toon Python honors `--chiron-structured`.
- [ ] Compression results validated against current `--structured` mode (within ±5% on token reduction; quality measured via downstream LLM eval — Phase 6).
- [ ] Multi-turn ratio cap = 6× enforced.
- [ ] Single-turn opt-in cap = 14× available.

---

## Phase 5 — Cortex (demand-paged context with streaming page faults)

> **Goal**: surface `chiron_fault_in` events as first-class diagnostics; implement page-fault telemetry; tombstone format; budget enforcement; **streaming faults via MCP `notifications/progress` where transport supports it**. F25, F41.

### Task 5.1 — Page Manager

**Files**:
- Create: `dist/core/chiron/page_manager.js` (hand-authored, ≈ 280 lines)
- Create: `tests/chiron/page_manager.test.js`

**Implementation outline**: in-process L1 LRU (size-byte-budget; default 32 MiB; max 4096 entries); L2 = `node_pool` + `node_occurrence` cached page; L3 = on-demand re-read. Every miss-and-load is a `page_fault_log` row. **Threshold compaction at 70% / 85% utilization** (Virtual Context — F41) implemented; eviction policy LRU. Compaction runs lazily, never synchronously during a fault.

### Task 5.2 — Tombstones

**Files**:
- Create: `dist/core/chiron/tombstone.js` (hand-authored, ≈ 40 lines)

When `chiron_fault_in`'s response would exceed `budgetBytes`, the response carries a tombstone string in place of bytes:

```
[Karyon paged out: hash={short_hash} kind={kind} bytes={bytes_total}. Use chiron_fault_in(hash) with budgetBytes>={bytes_total} to re-read.]
```

Pichay-style (H10), with the CHIRON `hash` embedded so the model re-faults by hash, not by file scan.

### Task 5.3 — Streaming page-fault diagnostics (CHIRON contribution)

**Files**:
- Modify: `dist/tools/chiron_fault_in.js` — emit `notifications/progress` JSON-RPC frames as faults occur.
- Modify: `dist/tools/chiron_search.js`, `dist/tools/chiron_outline.js` — same streaming hook.

**Implementation outline**:
- `ctx.streamProgress?.(evt: PageFaultEvent)` is an optional method on the tool context. When defined, the page manager calls it for each fault as it occurs. When undefined, faults coalesce into the final envelope.
- The MCP transport binding (existing, in `dist/core/server.js`) injects `streamProgress` only when the client negotiated `experimental.streaming`.
- For non-streaming clients, the final envelope's `pageFaults: PageFaultEvent[]` array is the only surface (graceful fallback).
- Every CHIRON tool envelope's `pageFaults` array is non-empty when faults occurred.
- ClawVM-style `thrashIndex = events / hits over last 100 ops` is computed and exposed in `data.cortex.thrashIndex`. Operators can flip `STRATA_DEBUG=1` (renamed to `CHIRON_DEBUG=1` in our flags) to log every event to stderr.

**Acceptance**:
- [ ] Faults observable, not silent.
- [ ] Tombstones honored for over-budget requests.
- [ ] `thrashIndex` ≤ 0.05 in steady state on the test corpus (per F25, ≤ 1% fault rate target).
- [ ] When transport supports streaming, faults are emitted incrementally (verified by integration test using a stub MCP client that records `notifications/progress` frames).

### Phase 5 exit criteria

- [ ] L1/L2/L3 hierarchy correctly built and traversed.
- [ ] Faults observable via post-hoc envelope and (when supported) streaming progress.
- [ ] Tombstones honored.
- [ ] Compaction at 70%/85% verified.
- [ ] `thrashIndex` SLO met on Phase 6 corpus.

---

## Phase 6 — Shadow Mode, Telemetry, Drift Gates, Cutover

> **Goal**: ship CHIRON in shadow mode; collect telemetry; gate cutover behind measured success rates AND drift anomaly thresholds. Mirrors PLAN1 Phase 6 discipline plus CHIRON's drift gate.

### Task 6.1 — Feature flags

**Files**:
- Create: `dist/config/chiron_flags.js` (read by `loadSettings()`).

```js
// dist/config/chiron_flags.js
export const DEFAULT_CHIRON_FLAGS = {
  enableChironIndexing:        true,    // index in background; safe; Phase 1
  enableChironTools:           true,    // expose 5 tools; Phase 3
  enableChironStreaming:       false,   // streaming progress; Phase 5 cutover
  enableChironCompression:     false,   // toon bridge swap; Phase 4 cutover
  enableChironRefactorOutlier: false,   // refactor_batch swap; Phase 6 cutover
  enableChironDebug:           false,   // verbose page-fault logs
};
```

### Task 6.2 — Telemetry

**Files**:
- Create: `dist/core/chiron/telemetry.js` (hand-authored, ≈ 200 lines)

Tracked metrics (recorded into `page_fault_log` plus a new in-memory ring buffer of 1000 events):

```ts
export interface ChironTelemetrySummary {
  totalOutlines: number;
  outlineP50Ms: number; outlineP95Ms: number;
  totalSearches: number;
  searchStructuralP95Ms: number;
  totalHeals: number;
  healTierDistribution: { tier1: number; tier2: number; tier3: number; tier4: number; tier5_ambiguous: number };
  healP50Ms: number; healP95Ms: number;
  readRegistryRejectionRate: number;
  idempotencyReplayRate: number;
  thrashIndex: number;
  driftRate: number;                                // CHIRON contribution
  compressionRatioChironVsLegacy: number;           // when enableChironCompression=true
}
```

### Task 6.3 — Test corpus

**Files**:
- Create: `tests/chiron/corpus/` — 60 representative files across 11 languages including:
  - Renamed function (rename-only, label edit)
  - Reformatted file (whitespace-only)
  - Function moved between files (relocation)
  - Aggressive refactor (extract method)
  - Generated file (`*.pb.go`, `__generated__/*.ts`)
  - Boilerplate-heavy file (30+ identical try/catch blocks)
  - Adversarially-similar functions (E54: 30+ getters)
  - Multi-evidence localization fixture
  - Cross-grammar-version drift fixture (mock 0.21.4 → 0.22.0)

### Task 6.4 — Release gates (with CHIRON drift gate)

**Files**:
- Create: `tests/chiron/release-gates.md`

**Gates** (must hold over 100 consecutive operations on the test corpus before cutover):

- `outlineP95Ms ≤ 250`
- `searchStructuralP95Ms ≤ 100`
- `healP95Ms ≤ 5000` (matches CodeTracker 2.0 reference)
- `healTierDistribution.tier1 + healTierDistribution.tier2 ≥ 0.85` (vast majority resolved by hash or banded SimHash)
- `healTierDistribution.tier5_ambiguous ≤ 0.05` (rare ambiguity)
- `readRegistryRejectionRate ≥ 0.99` for hashes never issued
- `compressionRatioChironVsLegacy ∈ [0.95, 1.10]` (quality maintained, ratio comparable)
- `thrashIndex ≤ 0.05`
- **`driftRate ≤ 0.05` per index run** (CHIRON contribution; >5% pool entries flipping hub_class flags human review)
- **0 wrong-target accepts** on the adversarially-similar getter fixture
- **0 cross-canon-version hash replays accepted** (`CANON_VERSION_MISMATCH` rejected deterministically)

Only when all gates hold for 100 consecutive ops:
- Flip `enableChironCompression` to `true`.
- Flip `enableChironRefactorOutlier` to `true` (swap `refactor_batch.js`'s Jaccard call to banded SimHash).
- Flip `enableChironStreaming` to `true` (where transport supports it).

### Task 6.5 — `refactor_batch` outlier swap (deferred behind flag)

**Files**:
- Modify: `dist/tools/refactor_batch.js` — find `getStructuralFingerprint` call sites; behind `enableChironRefactorOutlier`, swap to `bandedSimHashOutlier(db, seedNodeId)`. Default stays Jaccard until shadow telemetry validates.

### Phase 6 exit criteria

- [ ] All gates hold ≥ 100 consecutive ops.
- [ ] Telemetry surface (`chiron_metrics` debug-only tool, optional) reports green.
- [ ] Cutover flags flipped; legacy paths remain in code but disabled.

---

## 4. Risk Catalog

| # | Risk | Likelihood | Impact | Mitigation | Source |
|---|---|---:|---:|---|---|
| R1 | Canonicalization bug shifts all hashes silently | Med | Critical | Versioned spec + test corpus + cross-runtime verification (Task 0.2). v1↔v2 coexistence via `canon_versions` table (F51). | E11, E23, E53, E56 |
| R2 | tree-sitter grammar bumps invalidate hashes | High | Med | Grammar-tuple coupling in `canonPrefix`; `CANON_VERSION_MISMATCH` diagnostic; non-cascading. `canon_versions` registry preserves both. | F51, E53 |
| R3 | Healing silently selects wrong target | Low | Critical | Spork principle (F54): never silently select; `AMBIGUOUS_HEAL` surfaces ≤ 5 candidates with full envelopes. Round-and-exclude. Verification gate (file BLAKE3 + parse + pool membership). | F54, F55, E54 |
| R4 | Index time on 100k+ LOC repos | Med | Med | File-incremental discipline (F18); pool dedup; budget-bounded SimHash banding. Cold ~60s acceptable. | F20, A8 |
| R5 | SQLite contention under concurrent writers | Low | Med | Single-writer assumption; PRAGMA `busy_timeout = 5000`; `LOCK_LOST` diagnostic per PLAN1. | F23 |
| R6 | TOCTOU between outline and edit | High | Critical | Read registry + idempotency + content witness verification under PLAN1's lock via `verifyEditHandoff()`. | F28, A13, E36 |
| R7 | Boilerplate hubness corrupts ranking | High | High | Atlas frequency truncation (F36) + NeighborRetr k-occurrence class (F35) demote bad hubs. `excludeBoilerplate=true` default in `chiron_search`. | E47, F35, F36, A14 |
| R8 | Embedding fragility on adversarial renames | N/A — no embeddings | — | Design rules out dense embeddings as primary identity (F3). Soft-ZCA-whitened tie-breakers deferred. | E4, E5 |
| R9 | Compression ratio degrades quality | Med | Med | Adaptive ratios per entry (F16); 6× multi-turn cap; gated cutover behind Phase 6 telemetry. | F19, E28, E30 |
| R10 | Page-fault thrashing at low memory | Low | Med | L1 size budget; `thrashIndex` SLO ≤ 0.05; `BUDGET_PAGED` tombstones. | F25, F41 |
| R11 | LLM-augmented healing introduces invalid suggestions | N/A — no LLM in cascade | — | All four tiers deterministic; no LLM tier in v1. | F11, F56 |
| R12 | Mtime invalidation misses semantic edits | High | High | BLAKE3 file-hash drives invalidation (F4); reformat detection via two-hash discrimination (F6). | E21, E22 |
| R13 | Slice over-collection wastes tokens | Med | Med | Depth bounded ≤ 5; F49 cap of 20 functions. | F49, H22 |
| R14 | Bloom-of-refs false positive cascade | Low | Low | 5% FPR target; FPs cause wasted work, not incorrect results. | F22 |
| R15 | toon Python-side regression on `--chiron-structured` | Med | Med | Existing `--structured` preserved; new flag additive; legacy fallback in `compression.js`. | engineering |
| R16 | Schema migration breaks existing tools | Low | Critical | All migration additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` in try/catch); existing test suite must pass unchanged. | engineering |
| R17 | Drift telemetry false-positives block release | Med | Low | `driftRate > 0.05` flags human review, not auto-fail; tunable threshold. | CHIRON contribution |
| R18 | Streaming progress not honored by stdio MCP transport | Low | Low | Graceful fallback to post-hoc envelope `pageFaults[]`. | CHIRON contribution |
| R19 | Idempotency `IDEMPOTENCY_KEY_CONFLICT` on same key + different body | Low | Med | Surface as `BUDGET_EXCEEDED` plus `suggestedAction: "Use a fresh idempotency key"`; prevents silent overwrite. | F29 |
| R20 | `verifyEditHandoff()` race between read and apply | Med | Critical | Function called UNDER PLAN1's apply lock; the lock is the synchronization. Single-pass verification (no async between checks). | F28, A13, this plan §1.3 |

---

## 5. Test Plan

### 5.1 Unit tests (vitest, matching existing convention)

**Files**: `tests/chiron/unit/<file>.test.js` per new module.

- `canon/keys.test.js` — boundary keys deterministic; hash inputs reproducible.
- `canon/grammar_meta.test.js` — version reads correctly per grammar.
- `canon/registry.test.js` — `canon_versions` upsert + lookup; drift detection.
- `node_hash.test.js` — two-hash discipline; rename / reformat invariants; iterative postorder vs recursive consistency.
- `simhash.test.js` — Hamming distance correctness; band collision lookup; popcount accuracy.
- `bloom_refs.test.js` — FPR ≤ 5%.
- `lsf.test.js` — pool dedup; occurrence ordering; refcount accuracy.
- `slicer.test.js` — forward / backward slicing; round-trip cache; slice invalidation.
- `heal.test.js` — five-tier cascade; round-and-exclude; verification gate.
- `read_registry.test.js` — issue / verify / prune.
- `idempotency.test.js` — replay equality; TTL; conflict detection.
- `page_manager.test.js` — LRU eviction; tombstone emission; compaction.
- `verify_edit_handoff.test.js` — every diagnostic path exercised.

### 5.2 Integration tests

**Files**: `tests/chiron/integration/<scenario>.test.js`.

- `outline_then_edit.test.js` — outline → envelope → PLAN1-shaped EditDocumentRequest is structurally valid.
- `outline_after_edit.test.js` — file edited → re-outline yields fresh `sourceFileHash16` and consistent envelopes.
- `heal_after_rename.test.js` — identifier renamed → stale hash heals at Tier 2 or 3.
- `heal_after_move.test.js` — function moved to a new file → heals at Tier 3 or 4.
- `heal_ambiguous.test.js` — 30 identical getters → returns `AMBIGUOUS_HEAL` with ≥ 2 candidates, never silently selects.
- `compression_chiron_vs_legacy.test.js` — same input, both paths, ratio and downstream-eval parity.
- `fault_in_budget.test.js` — over-budget request returns `BUDGET_PAGED` with tombstone.
- `verify_handoff_under_lock.test.js` — simulate file mutation between outline and apply; verify all diagnostics fire correctly.
- `streaming_faults.test.js` — stub MCP client records `notifications/progress` frames; verify each fault streamed.
- `canon_drift.test.js` — mock grammar bump 0.21.4 → 0.22.0; `verifyEditHandoff` returns `CANON_VERSION_MISMATCH`.

### 5.3 Property-based / fuzz tests

**Files**: `tests/chiron/property/*.test.js`. Use vitest's `fast-check`.

- Random Unicode-heavy fixtures: emoji, CJK, surrogate pairs, BOM, CRLF/LF mixes. Hash determinism preserved.
- Random valid edits + heal: heal tier distribution matches expected curve.
- Random concurrent indexFile + queries: no deadlocks under SQLite WAL mode.
- Random `idempotencyKey` reuse: `BUDGET_EXCEEDED` with conflict message on body change; replay on body match.

### 5.4 Adversarial corpus

**Files**: `tests/chiron/adversarial/*.test.js`.

- Generated code (`.pb.go` / `__generated__/*.ts`): atlas correctly classifies as `bad` k-occurrence; novelty score low.
- 30+ identical try/catch boilerplate: pool refcount = 30, only 1 row.
- Hubness adversarial: a function injected to look maximally generic is correctly demoted.
- Cross-grammar-version replay: hash from v1 against v2-indexed file rejects with `CANON_VERSION_MISMATCH`.
- Argument-paraphrasing replay: same `idempotencyKey`, paraphrased reason field — `BUDGET_EXCEEDED` (key conflict).

### 5.5 Performance budgets

- Outline cold p50 ≤ 60 ms / p95 ≤ 250 ms on 5k-LOC TS file.
- Outline warm p50 ≤ 5 ms.
- Search structural p95 ≤ 100 ms (banded LSH lookup).
- Heal full cascade p95 ≤ 5000 ms; hot tier-1 heal p95 ≤ 5 ms.
- Compression chiron-bridge p95 ≤ 3000 ms (≤ 50% slower than legacy is acceptable).
- `verifyEditHandoff()` p99 ≤ 10 ms (excluding file read).

---

## 6. Backward Compatibility Plan

| Existing surface | Behavior | What changes |
|---|---|---|
| `read_file` | Unchanged. | None. |
| `read_multiple_files` | Unchanged. | None. |
| `write_file` | Unchanged. | None. |
| `edit_file` | Unchanged. | None — CHIRON does not touch `edit-engine.js`. |
| `search_files` | Unchanged. | None — CHIRON's `chiron_search` is additional, not replacement. |
| `refactor_batch` | Unchanged in default mode. | Behind `enableChironRefactorOutlier` (Phase 6), Jaccard outlier detection swaps to banded SimHash. Default stays Jaccard until shadow telemetry validates. |
| `symbol-index.js`'s `impactQuery` | Unchanged. | None. CHIRON augments via `node_pool` / `node_occurrence`; doesn't modify `edges`. |
| `compression.js` `compressTextFile` | Unchanged in default. | Accepts optional `{ useChiron }` flag. Default `false`. |
| `toon_bridge.js` | Unchanged. | New `chiron/toon_bridge_chiron.js` added; legacy bridge stays. |
| `.mcp/symbols.db` | Unchanged. | New tables added; new columns via idempotent ALTER TABLE. |
| MCP roots protocol | Unchanged. | None. |
| `instructions` string in `core/server.js` (line 67-68) | Unchanged. | CHIRON tools follow same flat-mode-string convention. |
| Retrieval pipeline opt-in | Unchanged. | Independent surface; no interaction. |

---

## 7. Search → Edit Handoff (PLAN1 contract)

Every `PatchEnvelope` returned by any CHIRON tool can be turned directly into a PLAN1 `EditDocumentRequest` without any model-side reformatting:

| PLAN1 `EditDocumentRequest` field | CHIRON `PatchEnvelope` field |
|---|---|
| `path` | `envelope.path` |
| `sourceFileHash16` | `envelope.sourceFileHash16` |
| `target.hash` | `envelope.hash` |
| `target.parentHash` | `envelope.parentHash` |
| `target.childType` | `envelope.childType` |
| `target.childIndex` | `envelope.childIndex` |
| `target.contentWitness` | `envelope.contentWitness` (first 64 bytes) |
| `target.symbol` / `symbolType` / `scope` | `envelope.symbol?.{name,symbolType,scope}` |
| `idempotencyKey` | model-supplied UUID (per F29) |

**PLAN1 diagnostic codes preserved**: `NEVER_READ`, `FILE_CHANGED`, `EDITOR_DIRTY`, `HASH_NOT_FOUND`, `AMBIGUOUS_TARGET`, `SYMBOL_TARGET_UNAVAILABLE`, `BUDGET_EXCEEDED`, `BOUNDARY_VIOLATION`, `STRUCTURE_BROKEN`, `PATH_UNSAFE`, `PATH_MISMATCH`, `OVERLAPPING_EDITS`, `WRITE_VERIFY_FAILED`, `RESTORE_FAILED`, `LOCK_LOST` — CHIRON returns these unchanged in its envelopes.

**CHIRON additions** (do not replace, only extend): `BUDGET_PAGED`, `CANON_VERSION_MISMATCH`, `AMBIGUOUS_HEAL`. PLAN1's editor either ignores these (forward compat) or treats them as `HASH_NOT_FOUND` (default).

**TOCTOU contract**: under the lock that PLAN1's `FileLockManager` already holds for write, PLAN1 calls `verifyEditHandoff(db, repoRoot, sessionId, request)`. The function returns either `{ ok: true, resolvedNode }` so PLAN1 proceeds, or `{ ok: false, code, diagnostic }` matching PLAN1's existing diagnostic shapes — no translation needed at the PLAN1 side. (CHIRON contribution; specified §1.3 + Task 3.6.)

---

## 8. Wave-Based Execution Summary (Planning Skill format)

```text
PHASE 0 (Wave 1) — Sequential, foundation
  Task 0.1 — Canon spec
  Task 0.2 — Test corpus (depends on 0.1)
  Task 0.3 — Grammar metadata reader (parallel with 0.2)
  Task 0.4 — DB migration + canon_versions registry (depends on 0.1)
  EXIT: spec versioned, fixtures green, DB additive.

PHASE 1 + 1.5 (Wave 2) — Parallel
  Task 1.1 — Hash Forge (depends on 0.4)
  Task 1.2 — LSF
  Task 1.3 — Index hook
  Task 1.5.1 — signatures.scm × 10  (parallel; only new query files)
  Task 1.5.2 — slice_seeds.scm × 10
  EXIT: pool/occurrence populate; signatures available.

PHASE 2 + 2.5 (Wave 3) — Parallel
  Task 2.1 — SimHash
  Task 2.2 — Bloom-of-refs
  Task 2.3 — Atlas seeder + drift
  Task 2.4 — Framework patterns
  Task 2.5 — PageRank
  Task 2.5.1 — Slicer
  Task 2.5.2 — Patch Context (depends on 2.5.1)
  EXIT: locality + atlas + slice indexes populate.

PHASE 3 (Wave 4) — Parallel + sequential merge
  Task 3.0 — Read Registry / Idempotency
  Task 3.1 — chiron_outline
  Task 3.2 — chiron_search          (parallel with 3.1)
  Task 3.3 — chiron_fault_in
  Task 3.4 — chiron_heal             (parallel with 3.3)
  Task 3.5 — chiron_compress (stub)
  Task 3.6 — verifyEditHandoff
  Task 3.7 — server.js registration  (sequential, after all tools complete)
  EXIT: 5 tools registered, envelopes valid; verifyEditHandoff exported.

PHASE 4 (Wave 5) — Parallel
  Task 4.1 — toon_bridge_chiron.js
  Task 4.2 — compression.js opt-in (depends on 4.1)
  Task 4.3 — toon Python --chiron-structured
  EXIT: bridge swappable behind flag.

PHASE 5 (Wave 6) — Parallel
  Task 5.1 — Page Manager
  Task 5.2 — Tombstones
  Task 5.3 — Streaming page faults
  EXIT: faults observable; streaming honored when transport supports.

PHASE 6 (Wave 7) — Sequential
  Task 6.1 — Flags
  Task 6.2 — Telemetry
  Task 6.3 — Test corpus
  Task 6.4 — Release gates (depends on 6.2, 6.3)
  Task 6.5 — refactor_batch swap (gated by 6.4)
  EXIT: gates pass 100 consecutive ops; cutover flags flipped.
```

Per Planning Skill rules:
- **No same-file parallel edits**: every wave audited; new code lives in new files; existing files modified at most by one task per wave (e.g., `dist/core/server.js` modified only in Task 3.7).
- **No intra-wave dependencies**: any cross-task dependency forces a sub-wave. Task 2.5.2 depends on 2.5.1 → 2.5.2 in a sub-wave.
- **No future dependencies**: every task's reads exist at wave start.
- **All waves execute from current state**: shadow-mode flags ensure no production behavior changes until Phase 6.

---

## 9. Non-MVP Items Explicitly Deferred

- LLM-augmented healing tier (would require structural verification gate F56). All four cascade tiers deterministic in v1.
- Cross-repo `node_pool` sharing (would require repo-spanning canon scoping).
- Concurrent multi-process write to `.mcp/symbols.db`. Single-writer assumption (F23).
- Persistent intent-key cache (F43). v1 stores tool result by `idempotencyKey`, not by `IntentKey`.
- Cross-encoder reward caching (RANGER pattern, F10). v1 has no reranker.
- ZCA whitening (F37) for any embedding tie-breaker. v1 has no embeddings.
- Multi-file batch handoff to PLAN1. v1 stays within PLAN1's ≤ 3 single-file edit batch.
- Generated-code de-prioritization beyond k-occurrence class. F40 detector (whitespace-perturbation classifier) is index-time and post-MVP.
- Grove CmRDT concurrent edits (F23). Single-writer with `LOCK_LOST` is the v1 surface.
- WAL-style crash recovery for `idempotency_log`. The DB-backed log + 1h TTL + same-key conflict detection is enough for v1; full WAL deferred.

---

## 10. Synthesis Notes (for reviewers)

- **CHIRON inherits STRATA's database additivity** (single `.mcp/symbols.db` extension; user-memory hard rule) **and Helion's 256-bit SimHash banding** (E47/SolveRank evidence). The combination is stronger than either alone: a 64-bit SimHash in a single DB conflates boilerplate; a 256-bit SimHash in a sibling DB doubles operational complexity.
- **The `canon_versions` registry as a real table** (rather than a comment in either prior plan) is what makes F51's "v1 and v2 coexist indefinitely" implementable. The `verifyEditHandoff` function detects drift and emits `CANON_VERSION_MISMATCH` because the table is queryable.
- **The `verifyEditHandoff` function** is the formal cross-tool contract neither prior plan specified concretely. STRATA describes it in §7 prose; Helion in §7.1; CHIRON specifies the exact synchronous function with diagnostic shape compatible with PLAN1's existing 14 codes.
- **Streaming page faults** are CHIRON's observability contribution. STRATA emits `pageFaults[]` post-hoc. Helion does the same. CHIRON streams them as `notifications/progress` JSON-RPC frames where the MCP transport supports it; otherwise gracefully falls back. This makes the ClawVM "thrashIndex" metric continuously observable rather than batch-reported.
- **The unified `PatchEnvelope` carrier** absorbs `EditCarrier`, `PatchContext`, `pathTrace`, atlas scores, and Cortex residency into a single typed shape. Helion has separate `EditCarrier` + `pathTrace`. STRATA has separate `SIR` + `PatchContext`. CHIRON unifies — every PLAN1 edit can be constructed from one envelope without join logic.
- **Drift-anomaly release gate** is CHIRON's release-engineering contribution. Neither prior plan instruments k-occurrence transitions per index run. CHIRON tracks `driftRate ≤ 0.05` as a release gate alongside the seven traditional metrics.
- **Tool count fixed at 5** — STRATA at 4, Helion at 8, CHIRON at 5. The fifth tool is `chiron_compress`, which exists as a stub in Phase 3 and a real bridge in Phase 4. Five matches F44's small-toolset preference; Helion's 8 (with `karyon_index`, `karyon_slice`, `karyon_atlas` as separate tools) is over-decomposed.
- **DB-backed idempotency** (vs in-memory in both prior plans) survives plugin restart. The `idempotency_log` row is the same shape as the in-memory map but persisted; replay safety extends across crashes.
- **The five-tier heal cascade** is taken from both plans (they agree on the algorithm). CHIRON's contribution is the **structural verification gate** explicit in code at the cascade entrance for tiers 3+4 (BLAKE3 file hash + tree-sitter parse success at byte range + `(structural_hash, label_hash)` pool membership).
- **Backward compat is structural, not nominal**: every existing tool, table, column, query-file convention, lazy-load scheme, and security contract (`ctx.validatePath()`, paired-capture queries, web-tree-sitter 0.26.x getters) is preserved.

---

*End of CHIRON Implementation Plan.*
