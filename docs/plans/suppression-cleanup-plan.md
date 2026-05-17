# Suppression Cleanup — Wave-Based Execution Plan

**Goal:** Eliminate ~85 type suppressions (`!`, `as unknown as`, `Record<string, any>`, `// nosemgrep`, `any`) across the Zenith-MCP codebase, replacing each with the structurally correct, optimal type-safe implementation.

**Total Waves:** 5
**Total Tasks:** 21 fixes mapped across 17 task units (same-file fixes combined)
**Max Parallel Tasks in Single Wave:** 7

> **Mindset for every implementing agent:** You are not patching. You are not minimizing. For every suppression, ask: *"What does the absolute best, correct version of this code look like?"* Every `!`, `as unknown as`, `any`, and `// nosemgrep` is the type system asking a question the code isn't answering. The fix is always the correct structure. No suppressions, no regressions, no half-measures.

---

## CODEBASE RECONNAISSANCE

```
CODEBASE RECONNAISSANCE:
├── Project Structure: TypeScript MCP server — packages/zenith-mcp/src/
│   ├── adapters/base.ts + platforms/*.ts — 14 platform config adapters
│   ├── retrieval/ — pipeline, session, ranking (bmx-index, fusion), telemetry
│   ├── tools/ — read_file, search_files, refactor_batch, edit_file
│   └── core/ — edit-engine, shared (BM25Index), path-utils, symbol-index
├── Tech Stack: TypeScript 5.x, MCP SDK (@modelcontextprotocol/sdk), Zod, better-sqlite3, tree-sitter
├── Key Conventions:
│   ├── strict: true + noUncheckedIndexedAccess: true (tsconfig.json)
│   ├── exactOptionalPropertyTypes: true (tsconfig.json)
│   ├── Adapters extend MCPConfigAdapter abstract class (adapters/base.ts)
│   ├── Tools registered via server.registerTool() with flat Zod schemas (no oneOf — provider constraint)
│   └── Relative .js imports (ESM), named exports
├── Reusable Infrastructure:
│   ├── src/core/lib.ts — normalizeLineEndings, readFileContent, offsetReadFile
│   ├── src/core/shared.ts — BM25Index (pre-fix), DEFAULT_EXCLUDES, CHAR_BUDGET
│   ├── src/core/tree-sitter.ts — findSymbol, checkSyntaxErrors, getLangForFile
│   └── src/retrieval/models.ts — ScoredTool, ToolMapping, RetrievalConfig types
└── Import Conventions: relative .js extension required, named exports, no barrel index files
```

---

## FILE INVENTORY

```
FILE INVENTORY:
├── Files to CREATE:
│   ├── src/retrieval/capabilities.ts — typed capability interfaces + type guards (Fix 2)
│   └── src/adapters/types.ts — shared McpServerEntry + per-platform config interfaces (Fix 11)
├── Files to MODIFY:
│   ├── src/retrieval/ranking/fusion.ts — toolMap.get()! guard (Fix 5)
│   ├── src/utils/project-scope.ts — cache !== undefined check (Fix 7)
│   ├── src/retrieval/session.ts — get-or-create (Fix 18)
│   ├── src/retrieval/pipeline.ts — split/pop! + capability guards + scored! (Fix 19, 2, 3)
│   ├── src/core/symbol-index.ts — has/get split (Fix 20)
│   ├── src/retrieval/telemetry/tokens.ts — path.basename + get-or-create (Fix 6)
│   ├── src/tools/read_file.ts — discriminated union + ?? 0 (Fix 8)
│   ├── src/retrieval/ranking/bmx-index.ts — 4 guards + typed accessor (Fix 4, 10)
│   ├── src/core/shared.ts — BM25TermData encapsulation (Fix 17)
│   ├── src/core/path-utils.ts — function overloads (Fix 16)
│   ├── src/core/edit-engine.ts — validateEdit() + assertAt() (Fix 12, 13)
│   ├── src/tools/search_files.ts — local narrowed consts (Fix 14)
│   ├── src/tools/refactor_batch.ts — all Map.get()! guards (Fix 15, 21)
│   ├── src/retrieval/zenith-integration.ts — SDK cast isolation (Fix 9)
│   ├── src/adapters/base.ts — wrapper methods + protected abstracts (Fix 1)
│   └── src/adapters/platforms/*.ts — 14 files: rename + typed config (Fix 1, 11)
└── Files to READ (no modifications):
    └── packages/zenith-mcp/tsconfig.json — confirms noUncheckedIndexedAccess, strict, exactOptionalPropertyTypes
```

---

## DEPENDENCY PROOF TABLE

| Task | Claims to depend on | Proof: Cannot produce correct output because... | Verdict |
|---|---|---|---|
| Task 2.3 (pipeline.ts rest) | Task 1.4 (pipeline.ts:404) | Both modify pipeline.ts — concurrent edits conflict | REAL — same file |
| Task 1.4 (pipeline.ts:404) | — | Single-line isolated change, no dependencies | NONE |
| Fix 11 (platform typed configs) | Fix 1 (method rename) | Task 11 modifies method signatures that Task 1 already renamed to `_writeConfigImpl`/`_registerServerImpl` — must work against renamed signatures | REAL — semantic |
| Fix 4 + Fix 10 | — | Both in bmx-index.ts, different regions — combine into one task | COMBINED |
| Fix 12 + Fix 13 | — | Both in edit-engine.ts — combine into one task | COMBINED |
| Fix 15 + Fix 21 | — | Both in refactor_batch.ts — combine into one task | COMBINED |
| Fix 2 capabilities.ts creation | — | New file, no dependencies | NONE |
| Fix 3 pipeline.ts scored! | Task 2.3 | Same task (pipeline.ts) — combine | COMBINED |
| All Wave 1 tasks | — | All modify distinct files, zero cross-dependencies | PARALLEL ✓ |

---

## CONFLICT ANALYSIS

```
CONFLICT ANALYSIS:
├── File Conflicts Resolved:
│   ├── pipeline.ts: Task 1.4 (Wave 1, line 404 only) → Task 2.3 (Wave 2, rest of file)
│   ├── bmx-index.ts: Fix 4 + Fix 10 → Combined into Task 2.1
│   ├── edit-engine.ts: Fix 12 + Fix 13 → Combined into Task 3.1
│   └── refactor_batch.ts: Fix 15 + Fix 21 → Combined into Task 3.3
├── Sequential Requirements:
│   ├── adapters/base.ts must complete before 14 platform files (internal to Task 4.1)
│   └── adapters/types.ts must be created before platforms import it (internal to Task 5.1)
└── False Dependencies Eliminated:
    └── zenith-integration.ts has no file conflicts — moved to Wave 3 (not Wave 6)
```

---

## WAVE ASSIGNMENT

```
WAVE ASSIGNMENT:
├── Wave 1 (7 tasks — fully parallel):
│   ├── Task 1.1: fusion.ts guard
│   ├── Task 1.2: project-scope.ts cache
│   ├── Task 1.3: session.ts get-or-create
│   ├── Task 1.4: pipeline.ts:404 only (.at(-1))
│   ├── Task 1.5: symbol-index.ts has/get split
│   ├── Task 1.6: tokens.ts path.basename + families map
│   └── Task 1.7: read_file.ts discriminated union
│   VALIDATION: 7 different files ✓ No intra-dependencies ✓ Current repo state ✓
│
├── Wave 2 (4 tasks — fully parallel):
│   ├── Task 2.1: bmx-index.ts guards + typed accessor
│   ├── Task 2.2: shared.ts BM25TermData encapsulation
│   ├── Task 2.3: capabilities.ts (new) + pipeline.ts (full update)
│   └── Task 2.4: path-utils.ts overloads
│   VALIDATION: 4 different files ✓ pipeline.ts W1 edit complete ✓
│
├── Wave 3 (4 tasks — fully parallel):
│   ├── Task 3.1: edit-engine.ts validateEdit + assertAt
│   ├── Task 3.2: search_files.ts local narrowed consts
│   ├── Task 3.3: refactor_batch.ts all Map.get()! guards
│   └── Task 3.4: zenith-integration.ts cast isolation
│   VALIDATION: 4 different files ✓ No intra-dependencies ✓
│
├── Wave 4 (1 task — internal phases):
│   └── Task 4.1: adapters/base.ts wrapper pattern + all 14 platforms renamed
│   VALIDATION: base.ts first, then platforms in parallel (internal) ✓
│
└── Wave 5 (1 task — internal phases):
    └── Task 5.1: adapters/types.ts (new) + 14 platforms typed configs
    VALIDATION: depends on Wave 4 method renames ✓
```

---

## Wave 1: Isolated Single-File Fixes

> **PARALLEL EXECUTION:** All 7 tasks in this wave run simultaneously.
>
> **Dependencies:** None — executes against current repo state.
> **File Safety:** fusion.ts · project-scope.ts · session.ts · pipeline.ts (line 404 only) · symbol-index.ts · tokens.ts · read_file.ts — one task per file ✓

---

### Task 1.1: Fix `fusion.ts` — `toolMap.get(key)!`

**Files:**
- Modify: `packages/zenith-mcp/src/retrieval/ranking/fusion.ts`

**Codebase References:**
- Suppression at: `fusion.ts:36` — `toolMapping: toolMap.get(key)!`
- Context: `fusion.ts:25-40` — `toolMap` built from `envRanked`/`convRanked`, iterated via `allKeys`
- `allKeys` is the union of `envRanks.keys()` and `convRanks.keys()` (line 20)
- `toolMap` is populated from the same source arrays (lines 26-27)

**Implementation Details:**

The `!` exists because `allKeys` is a `Set<string>` and TypeScript can't prove it's a subset of `toolMap.keys()`. The structural invariant is real — every key in `allKeys` came from the arrays that also populated `toolMap`. The fix is a guard that makes the invariant visible:

```typescript
// Before (lines 34-40):
fused.push({
  toolKey: key,
  toolMapping: toolMap.get(key)!,
  score,
  tier: "full",
});

// After:
const mapping = toolMap.get(key);
if (!mapping) continue; // structurally impossible: allKeys ⊆ toolMap.keys()
fused.push({
  toolKey: key,
  toolMapping: mapping,
  score,
  tier: "full",
});
```

**Acceptance Criteria:**
- [ ] No `!` in the file
- [ ] `mapping` is typed `ScoredTool["toolMapping"]` (inferred from `toolMap`)
- [ ] `tsc --noEmit` passes with zero errors

**What Complete Looks Like:**
Lines 34-40 use a named `mapping` const with a `continue` guard. The guard comment documents why it's unreachable.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-MCP && npx tsc --noEmit -p packages/zenith-mcp
```

---

### Task 1.2: Fix `project-scope.ts` — cache type lie

**Files:**
- Modify: `packages/zenith-mcp/src/utils/project-scope.ts`

**Codebase References:**
- Suppression at: `project-scope.ts:73` — `return _cache.get(absPath)!`
- Cache declaration: `project-scope.ts` — `const _cache = new Map<string, string | null>()`
- The `!` strips both `undefined` AND `null` — but `null` is a legitimate cached value meaning "no project found here." This is a type lie.

**Implementation Details:**

```typescript
// Before (lines 71-74):
if (!options?.noCache && _cache.has(absPath)) {
  return _cache.get(absPath)!;
}

// After:
if (!options?.noCache) {
  const cached = _cache.get(absPath);
  if (cached !== undefined) return cached; // string | null — correct return type
}
```

`undefined` = not yet in cache. `null` = cached as "no project found." The `!== undefined` check correctly returns `string | null` without erasing either state.

**Acceptance Criteria:**
- [ ] No `!` on any cache lookup
- [ ] Return type of `resolveProjectRoot` remains `string | null`
- [ ] A cached `null` entry is returned correctly (not filtered out)
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
`const cached = _cache.get(absPath); if (cached !== undefined) return cached;` — two lines, no assertion.

---

### Task 1.3: Fix `session.ts` — has/set/get! pattern

**Files:**
- Modify: `packages/zenith-mcp/src/retrieval/session.ts`

**Codebase References:**
- Suppression at: `session.ts:19` — `return new Set(this._sessions.get(sessionId)!)`
- Method: `session.ts:13-22` — `getOrCreateSession`
- Map type: `_sessions: Map<string, Set<string>>`

**Implementation Details:**

Replace the three-operation has/set/get pattern with a single get-or-create:

```typescript
// Before (lines 13-22):
getOrCreateSession(sessionId: string): Set<string> {
  if (!this._sessions.has(sessionId)) {
    this._sessions.set(sessionId, new Set(this._config.anchorTools));
  }
  // Return a copy — callers cannot mutate internal state
  return new Set(this._sessions.get(sessionId)!);
}

// After:
getOrCreateSession(sessionId: string): Set<string> {
  let session = this._sessions.get(sessionId);
  if (!session) {
    session = new Set(this._config.anchorTools);
    this._sessions.set(sessionId, session);
  }
  // Return a copy — callers cannot mutate internal state
  return new Set(session); // TypeScript knows session is Set<string> here
}
```

**Acceptance Criteria:**
- [ ] No `!` in the method
- [ ] Return type unchanged: `Set<string>`
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
Single `let session = this._sessions.get(sessionId)` with a creation block. Final `return new Set(session)` has no assertion.

---

### Task 1.4: Fix `pipeline.ts:404` — `split("__").pop()!`

**Files:**
- Modify: `packages/zenith-mcp/src/retrieval/pipeline.ts`
- **IMPORTANT:** Only modify line 404. The rest of pipeline.ts is handled in Task 2.3.

**Codebase References:**
- Suppression at: `pipeline.ts:404` — `k.split("__").pop()!.toLowerCase()`
- Context: Explicit tool mention detection in `getToolsForList`

**Implementation Details:**

```typescript
// Before (line 404):
const suffix = k.split("__").pop()!.toLowerCase();

// After:
const suffix = (k.split("__").at(-1) ?? "").toLowerCase();
```

`.at(-1)` on a non-empty array is always defined. `split()` always returns at least one element. `?? ""` handles the impossible `undefined` case for type safety.

**Acceptance Criteria:**
- [ ] Line 404 has no `!`
- [ ] `suffix` is typed `string`
- [ ] Behavior preserved (split on `"__"`, take last segment, lowercase)
- [ ] No other lines in pipeline.ts are modified
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
`(k.split("__").at(-1) ?? "").toLowerCase()` — no assertion.

---

### Task 1.5: Fix `symbol-index.ts` — has/get split

**Files:**
- Modify: `packages/zenith-mcp/src/core/symbol-index.ts`

**Codebase References:**
- Suppression at: `symbol-index.ts:82` — `return _dbCache.get(repoRoot)!`
- Pattern: `_dbCache.has(repoRoot)` immediately precedes the `!` get

**Implementation Details:**

```typescript
// Before (lines 81-82):
if (_dbCache.has(repoRoot)) return _dbCache.get(repoRoot)!;

// After:
const cached = _dbCache.get(repoRoot);
if (cached) return cached;
```

**Acceptance Criteria:**
- [ ] No `!` in `getDb` function
- [ ] Return type is `Database.Database`
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
`const cached = _dbCache.get(repoRoot); if (cached) return cached;` — two lines, no assertion.

---

### Task 1.6: Fix `tokens.ts` — 6 suppressions

**Files:**
- Modify: `packages/zenith-mcp/src/retrieval/telemetry/tokens.ts`

**Codebase References:**
- 5× `filepath.split("/").pop()!` — in `buildTokens` (Manifests, Lockfiles, Containers, Infra, DB sections)
- 1× `families.get(family)!.push(tok)` — in `_applyFamilyCap` at line 96

**Implementation Details:**

**Pattern A — All 5 `split("/").pop()!` instances:**

Add import at top of file:
```typescript
import path from 'path';
```

Replace every instance of `filepath.split("/").pop()!` or `f.split("/").pop()!`:
```typescript
// Before:
const basename = filepath.split("/").pop()!;
// or:
const basename = f.split("/").pop()!;

// After (all 5):
const basename = path.basename(filepath);
// or:
const basename = path.basename(f);
```

`path.basename` uses OS-native separators, always returns `string`, and handles trailing slashes correctly.

**Pattern B — `families.get(family)!.push(tok)` at line 96:**

```typescript
// Before (lines 95-96):
if (!families.has(family)) families.set(family, []);
families.get(family)!.push(tok);

// After:
let familyArr = families.get(family);
if (!familyArr) { familyArr = []; families.set(family, familyArr); }
familyArr.push(tok);
```

**Acceptance Criteria:**
- [ ] `import path from 'path'` added
- [ ] All 5 basename extractions use `path.basename()`
- [ ] `_applyFamilyCap` uses the get-or-create pattern
- [ ] Zero `!` assertions in the file
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
The file imports `path`. Every basename extraction is `path.basename(x)`. The `_applyFamilyCap` function uses a `let familyArr` get-or-create pattern.

---

### Task 1.7: Fix `read_file.ts` — `args.offset!` and `meta.linesReturned!`

**Files:**
- Modify: `packages/zenith-mcp/src/tools/read_file.ts`

**Codebase References:**
- Current interface: `read_file.ts:9-14` — `ReadFileMetadata` with all optional fields
- Suppressions at: `read_file.ts:173` — `args.offset! + meta.linesReturned!`
- The `hasMore: true` state is only reachable via the offset branch (lines 134-143) where `linesReturned` is always set

**Implementation Details:**

**Step 1 — Replace `ReadFileMetadata` with discriminated union:**

```typescript
// Before (lines 9-14):
interface ReadFileMetadata {
    totalLines?: number;
    linesReturned?: number;
    hasMore?: boolean;
    truncatedAt?: number;
}

// After:
interface ReadFileMetaBase {
    totalLines?: number;
    truncatedAt?: number;
}
interface ReadFileMetaWithMore extends ReadFileMetaBase {
    hasMore: true;
    linesReturned: number;  // required when hasMore is true
}
interface ReadFileMetaNoMore extends ReadFileMetaBase {
    hasMore?: false;
    linesReturned?: never;
}
type ReadFileMeta = ReadFileMetaWithMore | ReadFileMetaNoMore;
```

Update the variable declaration:
```typescript
// Before:
let meta: ReadFileMetadata = {};
// After:
let meta: ReadFileMeta = {};
```

**Step 2 — Fix the usage site:**

```typescript
// Before (line 172-174):
if (!truncated && meta.hasMore && !args.compression) {
    metaHeader = `[offset=${args.offset! + meta.linesReturned!}]\n`;
}

// After:
if (!truncated && meta.hasMore && !args.compression) {
    // TypeScript narrows to ReadFileMetaWithMore — meta.linesReturned is number
    const nextOffset = (args.offset ?? 0) + meta.linesReturned;
    metaHeader = `[offset=${nextOffset}]\n`;
}
```

`args.offset ?? 0` is semantically correct: no offset argument means start from line 0.

**Acceptance Criteria:**
- [ ] `ReadFileMeta` is a discriminated union on `hasMore`
- [ ] Inside `if (meta.hasMore)`, `meta.linesReturned` is typed `number`
- [ ] No `!` on `args.offset` or `meta.linesReturned`
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
The interface is replaced with a discriminated union. The usage site uses `?? 0` for offset and reads `meta.linesReturned` directly (TypeScript knows it's `number` after the `hasMore` check).

---

> **BEFORE PROCEEDING TO WAVE 2:**
> Spawn a review subagent to independently verify all 7 Wave 1 tasks. The reviewer should read each modified file and confirm: zero `!` assertions remain at the targeted lines, TypeScript would accept the code, and the logic is semantically unchanged.

---

## Wave 2: Class Refactors + Schema/Validation Changes

> **PARALLEL EXECUTION:** All 4 tasks in this wave run simultaneously.
>
> **Dependencies:** Wave 1 must complete (pipeline.ts line 404 fix must be in place before Task 2.3 modifies the rest of the file).
> **File Safety:** bmx-index.ts · shared.ts · capabilities.ts + pipeline.ts · path-utils.ts — one task per file ✓

---

### Task 2.1: Fix `bmx-index.ts` — 4 guards + typed field accessor

**Files:**
- Modify: `packages/zenith-mcp/src/retrieval/ranking/bmx-index.ts`

**Codebase References:**
- Fix 4 suppressions: Lines 241, 339, 352, 381 — `Map.get()!` and `has()/get()!` patterns
- Fix 10 suppression: Line 481 — `(doc as unknown as Record<string, unknown>)[fieldName]`
- `TermData` interface: `bmx-index.ts:10-17` — already correct (previous refactor done)
- `_fieldWeights` keys: `bmx-index.ts:475-481` — `"toolName"`, `"namespace"`, `"retrievalAliases"`, `"description"`, `"parameterNames"`
- `ToolDoc` type: imported from `../models.js`

**Implementation Details:**

**Fix 4 — Four remaining `!` guards:**

```typescript
// Line 241 — search():
// Before:
const docTokens = this._documents.get(chunkId)!;
const score = this._scoreDocument(...);
// After:
const docTokens = this._documents.get(chunkId);
if (!docTokens) continue; // invariant: chunkId from invertedIndex always has a _documents entry
const score = this._scoreDocument(chunkId, docTokens, ...);

// Lines 338-341 — updateIndex() IDF update pass:
// Before:
for (const term of affectedTerms) {
    const data = this._terms.get(term)!;
    data.idf = Math.log(...)
}
// After:
for (const term of affectedTerms) {
    const data = this._terms.get(term);
    if (!data) continue; // invariant: term was _getOrCreateTerm'd in the loop above
    data.idf = Math.log(...)
}

// Lines 350-353 — removeFromIndex():
// Before:
if (!this._documents.has(chunkId)) return false;
const tokens = this._documents.get(chunkId)!;
// After:
const tokens = this._documents.get(chunkId);
if (!tokens) return false; // covers the has() check in one statement

// Lines 380-383 — removeFromIndex() IDF pass:
// Before:
for (const term of affectedTerms) {
    const data = this._terms.get(term)!;
    data.idf = Math.log(...)
}
// After:
for (const term of affectedTerms) {
    const data = this._terms.get(term);
    if (!data) continue; // invariant: added to affectedTerms only when data was non-null above
    data.idf = Math.log(...)
}
```

**Fix 10 — Typed field accessor (replaces `as unknown as` on line 481):**

Add near the top of the file (after imports):
```typescript
type ToolDocTextField = 'toolName' | 'namespace' | 'retrievalAliases' | 'description' | 'parameterNames';

function getToolDocText(doc: ToolDoc, field: ToolDocTextField): string {
    const value = doc[field];
    if (Array.isArray(value)) return value.join(' ');
    return typeof value === 'string' ? value : '';
}
```

Replace line 481 in `buildFieldIndex`:
```typescript
// Before:
const text = (doc as unknown as Record<string, unknown>)[fieldName] as string | undefined ?? "";

// After:
const text = getToolDocText(doc, fieldName as ToolDocTextField);
```

**Acceptance Criteria:**
- [ ] No `!` at lines 241, 339, 352, 381
- [ ] No `as unknown as` at line 481
- [ ] `ToolDocTextField` union matches the 5 actual field weight keys
- [ ] `getToolDocText` handles both `string` and `string[]` field values
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
All four Map lookups use explicit `if (!x) continue/return` guards. The `buildFieldIndex` method uses a typed `getToolDocText` accessor with no casts.

---

### Task 2.2: Fix `shared.ts` — `BM25Index` parallel Maps architecture

**Files:**
- Modify: `packages/zenith-mcp/src/core/shared.ts`

**Codebase References:**
- Current suppressions: Lines 97, 109, 148, 150 — `Map.get()!` on parallel Maps
- `BM25Index` class: `shared.ts:49-165` — uses 5 parallel Maps (`_postingLists`, `_docLengths`, `_idfCache`, `_termEntropy`, `_termTotalFreqs`)
- Reference implementation: `bmx-index.ts` — already has `TermData` + `_getOrCreateTerm()` (same fix, different class)

**Implementation Details:**

This is the same architectural fix applied to `bmx-index.ts` previously. The parallel Maps are replaced with a single encapsulated `BM25TermData` structure.

**Step 1 — Add `BM25TermData` interface (before the class):**

```typescript
interface BM25TermData {
    postings: Map<string, number>;  // docId → tf
    idf: number;
    entropy: number;
    totalFreq: number;
}
```

**Step 2 — Refactor class fields:**

```typescript
class BM25Index {
    k1: number;
    b: number;
    beta: number;
    private _terms: Map<string, BM25TermData> = new Map();
    private _docLengths: Map<string, number> = new Map();
    private _avgDocLength = 0;
    private _totalDocs = 0;

    constructor(k1 = 1.2, b = 0.75, beta = 0.6) {
        this.k1 = k1;
        this.b = b;
        this.beta = beta;
    }

    private _getOrCreateTerm(term: string): BM25TermData {
        let data = this._terms.get(term);
        if (!data) {
            data = { postings: new Map(), idf: 0, entropy: 0, totalFreq: 0 };
            this._terms.set(term, data);
        }
        return data;
    }
    // ...
}
```

**Step 3 — Rewrite `build()` method:**

```typescript
build(docs: Array<{ id: string; text: string }>) {
    this._terms.clear();
    this._docLengths.clear();
    let totalLength = 0;

    for (const doc of docs) {
        if (!doc.id) continue;
        const tokens = BM25Index.tokenize(doc.text);
        this._docLengths.set(doc.id, tokens.length);
        totalLength += tokens.length;
        const tfMap = new Map<string, number>();
        for (const token of tokens) tfMap.set(token, (tfMap.get(token) || 0) + 1);
        for (const [term, count] of tfMap) {
            const data = this._getOrCreateTerm(term);
            data.postings.set(doc.id, count);   // no !
            data.totalFreq += count;              // no !
        }
    }

    this._totalDocs = this._docLengths.size;
    if (this._totalDocs === 0) return;
    this._avgDocLength = totalLength / this._totalDocs;

    // IDF pass — iterates _terms directly, always typed
    for (const [, data] of this._terms) {
        const df = data.postings.size;
        data.idf = Math.log((this._totalDocs - df + 0.5) / (df + 0.5) + 1);
    }

    // Entropy pass
    for (const data of this._terms.values()) {
        const nDocs = data.postings.size;
        if (data.totalFreq === 0 || nDocs <= 1) { data.entropy = 0; continue; }
        let entropy = 0;
        for (const tf of data.postings.values()) {
            const p = tf / data.totalFreq;
            entropy -= p * Math.log(p);
        }
        const maxEntropy = Math.log(nDocs);
        data.entropy = maxEntropy > 0 ? entropy / maxEntropy : 0;
    }
}
```

**Step 4 — Rewrite `search()` method:**

```typescript
search(query: string, topK = 200) {
    if (this._totalDocs === 0 || !query) return [];
    const queryTokens = BM25Index.tokenize(query);
    if (queryTokens.length === 0) return [];

    const qtfMap = new Map<string, number>();
    for (const t of queryTokens) qtfMap.set(t, (qtfMap.get(t) || 0) + 1);

    const termWeights = new Map<string, number>();
    let maxPossible = 0;
    for (const [term, qtf] of qtfMap) {
        const termData = this._terms.get(term);
        if (!termData) continue;                // guard — no !
        const weight = termData.idf * (1 + this.beta * (1 - termData.entropy));
        termWeights.set(term, weight);
        maxPossible += weight * qtf;
    }

    if (maxPossible === 0) return [];
    const { k1, b, _avgDocLength: avgdl } = this;
    const scores = new Map<string, number>();

    for (const [term, qtf] of qtfMap) {
        const weight = termWeights.get(term);
        if (weight === undefined) continue;
        const w = weight * qtf;
        const termData = this._terms.get(term);
        if (!termData) continue;               // guard — no !
        for (const [docId, tf] of termData.postings) {
            const dl = this._docLengths.get(docId);
            if (dl === undefined) continue;    // guard — no !
            const K = k1 * (1 - b + b * (dl / avgdl));
            const tfComponent = 1 / (1 + Math.exp(-k1 * (tf - K / 2) / K));
            scores.set(docId, (scores.get(docId) || 0) + w * tfComponent);
        }
    }

    if (scores.size === 0) return [];
    const invMax = 1 / maxPossible;
    return [...scores.entries()]
        .map(([id, s]) => ({ id, score: s * invMax }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}
```

**Acceptance Criteria:**
- [ ] `BM25TermData` interface defined with `postings`, `idf`, `entropy`, `totalFreq`
- [ ] `_getOrCreateTerm()` helper added to class
- [ ] 5 parallel Maps replaced by single `_terms: Map<string, BM25TermData>`
- [ ] Zero `!` assertions in class
- [ ] Scoring behavior preserved (same BM25 formula, same output shape)
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
The `BM25Index` class mirrors the `BMXIndex` architecture — single `_terms` Map with encapsulated `BM25TermData`. The `build()` and `search()` methods use `_getOrCreateTerm()` and explicit guards. No `!` assertions anywhere.

---

### Task 2.3: Create `capabilities.ts` + fix `pipeline.ts` (full update)

**Files:**
- Create: `packages/zenith-mcp/src/retrieval/capabilities.ts`
- Modify: `packages/zenith-mcp/src/retrieval/pipeline.ts`

**Codebase References:**
- Fix 2 suppressions (5× `as unknown as`):
  - `pipeline.ts:169` — `isIndexReady` cast
  - `pipeline.ts:178` — `getLogPath` cast
  - `pipeline.ts:237` — `getLogPath` cast (freqPrior)
  - `pipeline.ts:347` — `rebuildIndex` cast
  - `pipeline.ts:374` — `getSnapshotVersion` cast
  - `pipeline.ts:569` — `rebuildIndex` cast (rebuildCatalog)
- Fix 3 suppression: `pipeline.ts:486` — `scored!.length`
- `ToolMapping` type: `retrieval/models.ts`
- `ToolRetriever` interface: `retrieval/base.ts`
- `RetrievalLogger` interface: `retrieval/observability/logger.ts`
- Wave 1 Task 1.4 already fixed line 404 — do NOT re-touch that line

**Implementation Details:**

**Step 1 — Create `capabilities.ts`:**

```typescript
// packages/zenith-mcp/src/retrieval/capabilities.ts
import type { ToolMapping } from './models.js';

export interface IndexCapable {
    isIndexReady(): boolean;
}

export interface FrequencyLogCapable {
    getLogPath(): string | null;
}

export interface RebuildCapable {
    rebuildIndex(registry: Record<string, ToolMapping>): void;
    getSnapshotVersion(): string;
}

export function isIndexCapable(r: unknown): r is IndexCapable {
    return typeof r === 'object' && r !== null
        && typeof (r as Record<string, unknown>).isIndexReady === 'function';
}

export function isFrequencyLogCapable(r: unknown): r is FrequencyLogCapable {
    return typeof r === 'object' && r !== null
        && typeof (r as Record<string, unknown>).getLogPath === 'function';
}

export function isRebuildCapable(r: unknown): r is RebuildCapable {
    return typeof r === 'object' && r !== null
        && typeof (r as Record<string, unknown>).rebuildIndex === 'function'
        && typeof (r as Record<string, unknown>).getSnapshotVersion === 'function';
}
```

**Step 2 — Update `pipeline.ts` imports (add to existing import block):**

```typescript
import { isIndexCapable, isFrequencyLogCapable, isRebuildCapable } from './capabilities.js';
```

**Step 3 — Replace `idxOk()` (lines 166-172):**

```typescript
// Before:
private idxOk(): boolean {
    if ('isIndexReady' in this.retriever && typeof (this.retriever as Record<string, unknown>).isIndexReady === 'function') {
      return (this.retriever as unknown as { isIndexReady(): boolean }).isIndexReady();
    }
    return false;
}

// After:
private idxOk(): boolean {
    return isIndexCapable(this.retriever) ? this.retriever.isIndexReady() : false;
}
```

**Step 4 — Replace `hasFreq()` (lines 176-182):**

```typescript
// Before:
private hasFreq(): boolean {
    if ('getLogPath' in this.logger && typeof (this.logger as Record<string, unknown>).getLogPath === 'function') {
      const p = (this.logger as unknown as { getLogPath(): string | null }).getLogPath();
      return p != null && existsSync(p);
    }
    return false;
}

// After:
private hasFreq(): boolean {
    if (!isFrequencyLogCapable(this.logger)) return false;
    const p = this.logger.getLogPath();
    return p != null && existsSync(p);
}
```

**Step 5 — Replace `freqPrior()` logger cast (lines 236-238):**

```typescript
// Before:
let p: string | null = null;
if ('getLogPath' in this.logger && typeof (this.logger as Record<string, unknown>).getLogPath === 'function') {
    p = (this.logger as unknown as { getLogPath(): string | null }).getLogPath();
}
if (!p || !existsSync(p)) return [];

// After:
if (!isFrequencyLogCapable(this.logger)) return [];
const p = this.logger.getLogPath();
if (!p || !existsSync(p)) return [];
```

**Step 6 — Replace pending rebuild cast (lines 345-349):**

```typescript
// Before:
if ('rebuildIndex' in this.retriever && typeof (this.retriever as Record<string, unknown>).rebuildIndex === 'function') {
    (this.retriever as unknown as { rebuildIndex(r: Record<string, ToolMapping>): void }).rebuildIndex(this._pendingRebuild);
}

// After:
if (isRebuildCapable(this.retriever)) {
    this.retriever.rebuildIndex(this._pendingRebuild);
}
```

**Step 7 — Replace `getSnapshotVersion` cast (lines 372-376):**

```typescript
// Before:
let ver = "";
if ('getSnapshotVersion' in this.retriever && typeof (this.retriever as Record<string, unknown>).getSnapshotVersion === 'function') {
    ver = (this.retriever as unknown as { getSnapshotVersion(): string }).getSnapshotVersion() ?? "";
}

// After:
const ver = isRebuildCapable(this.retriever)
    ? this.retriever.getSnapshotVersion() ?? ""
    : "";
```

**Step 8 — Replace `rebuildCatalog` cast (line 569):**

```typescript
// Before:
if ('rebuildIndex' in this.retriever && typeof (this.retriever as Record<string, unknown>).rebuildIndex === 'function') {
    (this.retriever as unknown as { rebuildIndex(r: Record<string, ToolMapping>): void }).rebuildIndex(registry);
}

// After:
if (isRebuildCapable(this.retriever)) {
    this.retriever.rebuildIndex(registry);
}
```

**Step 9 — Fix `scored!` invariant (around line 456-486):**

```typescript
// After: if (!scored) { scored = this.universal(); tier = 6; }
// Add immediately:
if (scored === null) {
    // Unreachable: Tier 6 universal() always returns an array (possibly empty).
    // This assertion makes the invariant visible to TypeScript's control flow.
    throw new Error('Invariant violation: all retrieval tiers exhausted without producing results');
}
// scored is ScoredTool[] from this point — no ! needed
// ...
const rankMap = new Map(scored.map((s, i) => [s.toolKey, i]));
// ...
const rank = rankMap.get(tk) ?? scored.length; // no !
```

**Acceptance Criteria:**
- [ ] `capabilities.ts` created with 3 interfaces + 3 type guard functions
- [ ] All 5 `as unknown as` casts removed from `pipeline.ts`
- [ ] All capability checks use the new type guards
- [ ] `scored!` at line 486 removed — scored is narrowed to non-null above
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
`capabilities.ts` exports clean capability interfaces and type guards. `pipeline.ts` imports and uses them — the inline `as unknown as` blocks are gone. The `scored` invariant assertion is explicit and fail-fast.

---

### Task 2.4: Fix `path-utils.ts` — `normalizePath(p: any): any`

**Files:**
- Modify: `packages/zenith-mcp/src/core/path-utils.ts`

**Codebase References:**
- Suppression at: `path-utils.ts:36` — `export function normalizePath(p: any): any`
- Function body: handles `null`, `undefined`, non-string passthrough, then string normalization

**Implementation Details:**

Replace the `any` signature with proper overloads that restore downstream type safety:

```typescript
// Before (line 36):
export function normalizePath(p: any): any {
    // Handle non-string values
    if (p === null) return null;
    if (p === undefined) return undefined;
    if (typeof p !== 'string') return p;
    // ...

// After:
export function normalizePath(p: string): string;
export function normalizePath(p: null): null;
export function normalizePath(p: undefined): undefined;
export function normalizePath(p: string | null | undefined): string | null | undefined;
export function normalizePath(p: unknown): unknown {
    // Handle non-string values
    if (p === null) return null;
    if (p === undefined) return undefined;
    if (typeof p !== 'string') return p;
    // ... rest of implementation unchanged
```

Callers passing `string` now get `string` back, not `any`.

**Acceptance Criteria:**
- [ ] No `any` in function signature or return type
- [ ] Four overload signatures covering string, null, undefined, and union
- [ ] Implementation signature uses `unknown`
- [ ] `tsc --noEmit` passes (and downstream callers gain type safety)

**What Complete Looks Like:**
The function has 4 overload declarations followed by the `unknown` implementation. A callsite `normalizePath(someString)` resolves to `string`.

---

> **BEFORE PROCEEDING TO WAVE 3:**
> Spawn a review subagent to independently verify all 4 Wave 2 tasks. Confirm: zero suppressions remain in targeted locations, new files are well-typed, TypeScript accepts the code without errors.

---

## Wave 3: Tool Files + SDK Isolation

> **PARALLEL EXECUTION:** All 4 tasks in this wave run simultaneously.
>
> **Dependencies:** Wave 2 must complete.
> **File Safety:** edit-engine.ts · search_files.ts · refactor_batch.ts · zenith-integration.ts — one task per file ✓

---

### Task 3.1: Fix `edit-engine.ts` — `validateEdit()` + `assertAt()`

**Files:**
- Modify: `packages/zenith-mcp/src/core/edit-engine.ts`

**Codebase References:**
- Fix 12: 12× mode-field `!` on `edit.block_start!`, `edit.block_end!`, `edit.replacement_block!`, `edit.symbol!`, `edit.newText!`, `edit.oldContent!`, `edit.newContent!`
- Fix 13: ~9× array index `!` (`contentLines[i+j]!`, `origLines[i]!`, `lines[i]!`, `oldLines[0]!`, `matchedLines[0]!`, `candidates[0]!`) + 5× `// nosemgrep`
- 1× `dis.startLine!` at line 227 — redundant after `!== undefined` narrowing
- `Edit` interface: `edit-engine.ts:9-23` — flat schema, all fields optional (provider constraint — cannot use `oneOf`)
- `tsconfig.json` confirms `noUncheckedIndexedAccess: true` — array `arr[i]` returns `T | undefined`

**Implementation Details:**

**Step 1 — Add `ValidatedEdit` discriminated union (after existing `Edit` interface):**

```typescript
interface ValidatedBlockEdit {
    mode: 'block';
    block_start: string;
    block_end: string;
    replacement_block: string;
    nearLine?: number;
}
interface ValidatedSymbolEdit {
    mode: 'symbol';
    symbol: string;
    newText: string;
    nearLine?: number;
}
interface ValidatedContentEdit {
    mode: 'content';
    oldContent: string;
    newContent: string;
    nearLine?: number;
}
type ValidatedEdit = ValidatedBlockEdit | ValidatedSymbolEdit | ValidatedContentEdit;
```

**Step 2 — Add `validateEdit()` function:**

```typescript
function validateEdit(
    edit: Edit,
    index: number,
    isBatch: boolean,
): { ok: true; edit: ValidatedEdit } | { ok: false; msg: string } {
    const tag = isBatch ? `#${index + 1}: ` : '';
    switch (edit.mode) {
        case 'block':
            if (!edit.block_start || !edit.block_end || edit.replacement_block == null)
                return { ok: false, msg: `${tag}block mode requires block_start, block_end, replacement_block.` };
            return { ok: true, edit: {
                mode: 'block',
                block_start: edit.block_start,
                block_end: edit.block_end,
                replacement_block: edit.replacement_block,
                nearLine: edit.nearLine,
            }};
        case 'symbol':
            if (!edit.symbol || edit.newText == null)
                return { ok: false, msg: `${tag}symbol mode requires symbol and newText.` };
            return { ok: true, edit: {
                mode: 'symbol',
                symbol: edit.symbol,
                newText: edit.newText,
                nearLine: edit.nearLine,
            }};
        case 'content':
            if (edit.oldContent == null || edit.newContent == null)
                return { ok: false, msg: `${tag}content mode requires oldContent and newContent.` };
            return { ok: true, edit: {
                mode: 'content',
                oldContent: edit.oldContent,
                newContent: edit.newContent,
                nearLine: edit.nearLine,
            }};
        default:
            return { ok: false, msg: `${tag}Unknown edit mode '${String(edit.mode)}'.` };
    }
}
```

**Step 3 — Add `assertAt()` helper:**

```typescript
/**
 * Assert array index is in-bounds. Throws RangeError with context instead of
 * crashing silently. Works correctly with noUncheckedIndexedAccess: true.
 */
function assertAt<T>(arr: readonly T[], i: number, label = 'array'): T {
    const v = arr[i];
    if (v === undefined) {
        throw new RangeError(`${label}[${i}] is out of bounds (length ${arr.length})`);
    }
    return v;
}
```

**Step 4 — Update `applyEditList` loop to use `validateEdit`:**

At the start of the edit loop, replace the raw `edit` usage:
```typescript
for (const [i, rawEdit] of edits.entries()) {
    const validated = validateEdit(rawEdit, i, isBatch ?? false);
    if (!validated.ok) { errors.push({ i, msg: validated.msg }); continue; }
    const edit = validated.edit; // ValidatedEdit — all fields are string, no ! needed

    if (edit.mode === 'block') {
        const expectedStart = edit.block_start.trim();      // string — no !
        const expectedEnd = edit.block_end.trim();          // string — no !
        // ...
        const normalizedNew = normalizeLineEndings(edit.replacement_block); // string — no !
    }
    if (edit.mode === 'symbol') {
        // edit.symbol: string — no !
        // edit.newText: string — no !
    }
    if (edit.mode === 'content') {
        // edit.oldContent: string — no !
        // edit.newContent: string — no !
    }
}
```

**Step 5 — Replace all array index `!` with `assertAt()`:**

```typescript
// nosemgrep lines — every raw array[i]! becomes assertAt(array, i, 'label'):
assertAt(contentLines, i + j, 'contentLines').trim()     // was contentLines[i + j]! // nosemgrep
assertAt(origLines, i, 'origLines').length + 1            // was origLines[i]! // nosemgrep
assertAt(lines, i, 'lines').trim().includes(firstOldLine) // was lines[i]!.trim()... // nosemgrep
assertAt(lines, i, 'lines').includes(trimmed)             // was lines[i]!.includes(trimmed) // nosemgrep
assertAt(oldLines, 0, 'oldLines').trim()                  // was oldLines[0]!.trim()
assertAt(matchedLines, 0, 'matchedLines').match(/^\s*/)   // was matchedLines[0]!.match(...)
assertAt(candidates, 0, 'candidates')                     // was candidates[0]!
```

**Step 6 — Remove redundant `dis.startLine!` (line 227):**

```typescript
// Before:
if (dis?.startLine !== undefined) {
    chosen = candidates.find(c => c.start === dis.startLine! - 1);

// After (! is redundant — TypeScript already narrows dis.startLine to number):
if (dis?.startLine !== undefined) {
    chosen = candidates.find(c => c.start === dis.startLine - 1);
```

**Acceptance Criteria:**
- [ ] `ValidatedEdit` discriminated union defined
- [ ] `validateEdit()` function validates and narrows all three edit modes
- [ ] `assertAt()` helper defined
- [ ] All 12 mode-field `!` removed from `applyEditList` loop
- [ ] All ~9 array index `!` replaced with `assertAt()`
- [ ] All 5 `// nosemgrep` comments removed
- [ ] `dis.startLine!` removed (redundant)
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
The edit engine uses `validateEdit()` to produce a `ValidatedEdit` with all fields typed as `string`. `assertAt()` replaces all array index assertions. No suppressions of any kind remain. Semgrep has nothing to flag.

---

### Task 3.2: Fix `search_files.ts` — 8 narrowed const suppressions

**Files:**
- Modify: `packages/zenith-mcp/src/tools/search_files.ts`

**Codebase References:**
- 6× `args.contentQuery!` — in content mode block (post-throw guard)
- 2× `args.definesSymbol!` — in definition mode block (post-throw guard)
- TypeScript does not narrow through a `throw` for optional field access — guard + local const is the fix

**Implementation Details:**

**Content mode — narrow after the guard:**

```typescript
// Before:
if (!args.contentQuery) {
    throw new Error('contentQuery required for content mode.');
}
// ... uses args.contentQuery! six times

// After:
if (!args.contentQuery) {
    throw new Error('contentQuery required for content mode.');
}
const contentQuery: string = args.contentQuery; // narrowed once — string from here on

// Replace all args.contentQuery! with contentQuery:
const contentRegex = args.literalSearch
    ? new RegExp(contentQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    : new RegExp(contentQuery, flags);

if (contentQuery.length > 2) {
    const candidateFiles = await bm25PreFilterFiles(rootPath, contentQuery, 100, allExcludes);
    // ...
    rgResults = await ripgrepSearch(rootPath, { contentQuery, ... });
}
// etc. — all six uses replaced
```

**Definition mode — same pattern:**

```typescript
// Before:
const symbolName = args.definesSymbol!;

// After:
if (!args.definesSymbol) throw new Error('definesSymbol required for definition mode.');
const symbolName: string = args.definesSymbol; // narrowed once

// Replace both args.definesSymbol! with symbolName
```

**Acceptance Criteria:**
- [ ] No `!` on `args.contentQuery` anywhere in the file
- [ ] No `!` on `args.definesSymbol` anywhere in the file
- [ ] Local `contentQuery` and `symbolName` consts capture the narrowed type
- [ ] All downstream uses reference the local const
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
After each throw guard, a single typed `const` captures the value. All code below uses the const — TypeScript has no reason to complain.

---

### Task 3.3: Fix `refactor_batch.ts` — 8 Map.get()! suppressions

**Files:**
- Modify: `packages/zenith-mcp/src/tools/refactor_batch.ts`

**Codebase References:**
- Fix 15a: Line 383 — `args.selection!`
- Fix 15b: Line 562 — `cached!.occurrences!`
- Fix 15c: Line 651 — `occList!.find()` and `occList![0]`
- Fix 21 lines 480, 615 — get-or-create push pattern
- Fix 21 lines 682, 688, 1062 — guarded read pattern

**Implementation Details:**

**Fix 15a — `args.selection!` (line 383):**

```typescript
// Before:
for (const entry of args.selection!) {

// After:
if (!args.selection?.length && !args.loadMore) {
    return { content: [{ type: 'text', text: 'selection is required.' }] };
}
const selection = args.selection ?? [];
for (const entry of selection) { // no !
```

**Fix 15b — `cached!.occurrences!` (line 562):**

```typescript
// Before:
const priorOccurrences = cached!.occurrences!;

// After:
const priorOccurrences: LoadedOccurrence[] =
    (args.loadMore && cached !== null && Array.isArray(cached.occurrences))
        ? cached.occurrences
        : [];
```

**Fix 15c — `occList!` (line 651):**

```typescript
// Before:
const firstOcc = occList!.find(o => g.indices.includes(o.index)) || occList![0];

// After:
const occList = loadedSymbols.get(g.symbol);
if (!occList?.length) continue;
const firstOcc = occList.find(o => g.indices.includes(o.index)) ?? occList[0];
if (!firstOcc) continue;
```

**Fix 21 — Get-or-create push (lines 478-480):**

```typescript
// Before:
if (!bySymbol.has(occ.symbol)) bySymbol.set(occ.symbol, []);
bySymbol.get(occ.symbol)!.push(occ);

// After:
let symArr = bySymbol.get(occ.symbol);
if (!symArr) { symArr = []; bySymbol.set(occ.symbol, symArr); }
symArr.push(occ);
```

**Fix 21 — Get-or-create push (lines 613-615):**

```typescript
// Before:
if (!loadedSymbols.has(occ.symbol)) loadedSymbols.set(occ.symbol, []);
loadedSymbols.get(occ.symbol)!.push(occ);

// After:
let symOccs = loadedSymbols.get(occ.symbol);
if (!symOccs) { symOccs = []; loadedSymbols.set(occ.symbol, symOccs); }
symOccs.push(occ);
```

**Fix 21 — Guarded read (line 682):**

```typescript
// Before:
const occList = loadedSymbols.get(g.symbol)!;

// After:
const occList = loadedSymbols.get(g.symbol);
if (!occList) continue; // gate loop above confirmed symbol exists
```

**Fix 21 — Guarded read (lines 685-688):**

```typescript
// Before:
if (!fileBundles.has(occ.absPath)) {
    fileBundles.set(occ.absPath, { edits: [], disambiguations: new Map(), occMeta: [], relFile: occ.relFile });
}
const bundle = fileBundles.get(occ.absPath)!;

// After:
if (!fileBundles.has(occ.absPath)) {
    fileBundles.set(occ.absPath, { edits: [], disambiguations: new Map(), occMeta: [], relFile: occ.relFile });
}
const bundle = fileBundles.get(occ.absPath);
if (!bundle) continue; // unreachable — just set above
```

**Fix 21 — Guarded read (lines 1059-1062):**

```typescript
// Before:
if (!fileBundles.has(t.absPath)) {
    fileBundles.set(t.absPath, { edits: [], disambiguations: new Map(), occMeta: [] });
}
const bundle = fileBundles.get(t.absPath)!;

// After:
if (!fileBundles.has(t.absPath)) {
    fileBundles.set(t.absPath, { edits: [], disambiguations: new Map(), occMeta: [] });
}
const bundle = fileBundles.get(t.absPath);
if (!bundle) continue;
```

**Acceptance Criteria:**
- [ ] No `!` on `args.selection`
- [ ] No `!` on `cached` or `cached.occurrences`
- [ ] No `!` on `occList`
- [ ] No `Map.get()!` anywhere in the file
- [ ] All 5 Fix 21 locations use get-or-create or guarded patterns
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
Every `Map.get()` call either uses a get-or-create assignment pattern (for push operations) or an explicit `if (!x) continue` guard (for read operations). No non-null assertions remain.

---

### Task 3.4: Fix `zenith-integration.ts` — cast isolation

**Files:**
- Modify: `packages/zenith-mcp/src/retrieval/zenith-integration.ts`

**Codebase References:**
- Fix 9a: `zenith-integration.ts:205` — `server.server as unknown as { _requestHandlers }`
- Fix 9b: `zenith-integration.ts:53,57` — `schema as Parameters<typeof normalizeObjectSchema>[0]` (2×)
- MCP SDK: `normalizeObjectSchema` from `@modelcontextprotocol/sdk/server/zod-compat.js`
- MCP SDK: `toJsonSchemaCompat` from `@modelcontextprotocol/sdk/server/zod-json-schema-compat.js`

**Implementation Details:**

**Step 1 — Add `McpServerInternals` interface and `getMcpServerInternals()` helper:**

```typescript
interface McpServerInternals {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
}

function getMcpServerInternals(server: McpServer): McpServerInternals {
    const internals = (server as unknown as { server: McpServerInternals }).server;
    if (!internals?._requestHandlers || !(internals._requestHandlers instanceof Map)) {
        throw new Error(
            'MCP SDK internal structure changed: _requestHandlers missing or not a Map. ' +
            'Check the SDK version and update installRetrievalRequestHandlers accordingly.'
        );
    }
    return internals;
}
```

**Step 2 — Replace inline cast in `installRetrievalRequestHandlers`:**

```typescript
// Before (line 205):
const protocol = server.server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
};

// After:
const protocol = getMcpServerInternals(server);
```

**Step 3 — Add named boundary functions for Zod helper casts:**

```typescript
function asNormalizableSchema(schema: unknown): Parameters<typeof normalizeObjectSchema>[0] {
    // schema comes from RegisteredTool.inputSchema — any Zod or JSON schema.
    // normalizeObjectSchema expects ZodObject; existence is guarded by caller.
    return schema as Parameters<typeof normalizeObjectSchema>[0];
}

function asJsonSchemaCompatInput(schema: unknown): Parameters<typeof toJsonSchemaCompat>[0] {
    return schema as Parameters<typeof toJsonSchemaCompat>[0];
}
```

**Step 4 — Update `toJsonObjectSchema` to use named functions:**

```typescript
function toJsonObjectSchema(schema: unknown, pipeStrategy: "input" | "output"): Tool["inputSchema"] {
    if (!schema) return EMPTY_OBJECT_JSON_SCHEMA;
    const obj = normalizeObjectSchema(asNormalizableSchema(schema));
    return (
        obj
            ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy })
            : toJsonSchemaCompat(asJsonSchemaCompatInput(schema), { strictUnions: true, pipeStrategy })
    ) as Tool["inputSchema"];
}
```

**Acceptance Criteria:**
- [ ] SDK internal cast isolated in `getMcpServerInternals()` with runtime guard
- [ ] Runtime guard throws a descriptive error if `_requestHandlers` is missing or changed
- [ ] Zod schema casts isolated in `asNormalizableSchema()` and `asJsonSchemaCompatInput()`
- [ ] Original 3 inline casts replaced with named function calls
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
All unavoidable casts are isolated in named functions. The SDK internal cast has a runtime guard that fails loudly at server startup if the SDK changes. No inline `as unknown as` expressions remain.

---

> **BEFORE PROCEEDING TO WAVE 4:**
> Spawn a review subagent to independently verify all 4 Wave 3 tasks. Pay particular attention to `edit-engine.ts` — verify all nosemgrep annotations are gone and the validateEdit boundary produces correct types in every mode branch.

---

## Wave 4: Adapter Base + Platform Method Rename

> **SEQUENTIAL INTERNAL STRUCTURE:** `base.ts` modified first; then all 14 platform files updated in parallel (they are separate files).
>
> **Dependencies:** Wave 3 must complete.
> **File Safety:** `base.ts` and 14 distinct platform files — no conflicts ✓

---

### Task 4.1: Fix `adapters/base.ts` + 14 platform files — `configPath()!`

**Files:**
- Modify: `packages/zenith-mcp/src/adapters/base.ts`
- Modify (all 14): `platforms/antigravity.ts`, `claude-desktop.ts`, `cline.ts`, `codex-cli.ts`, `codex-desktop.ts`, `continue-dev.ts`, `gemini-cli.ts`, `github-copilot.ts`, `gptme.ts`, `jetbrains.ts`, `openclaw.ts`, `opencode.ts`, `raycast.ts`, `roo-code.ts`, `warp.ts`, `zed.ts`

**Codebase References:**
- `base.ts:30-33` — current abstract method declarations
- `claude-desktop.ts:40-60` — representative platform implementation pattern
- `warp.ts` has 2 `configPath()!` calls (writeConfig + registerServer) — both eliminated

**Implementation Details:**

**Phase A — Update `base.ts` FIRST:**

Replace abstract method declarations (lines 30-33) with concrete wrappers + new protected abstracts:

```typescript
// Replace:
abstract writeConfig(data: Record<string, unknown>): void;
abstract registerServer(name: string, config: Record<string, unknown>): void;

// With:
writeConfig(data: Record<string, unknown>): void {
    const p = this.configPath();
    if (!p) throw new Error(`${this.displayName}: configPath() returned null — platform not available`);
    this._writeConfigImpl(p, data);
}

registerServer(name: string, config: Record<string, unknown>): void {
    const p = this.configPath();
    if (!p) throw new Error(`${this.displayName}: configPath() returned null — platform not available`);
    this._registerServerImpl(p, name, config);
}

protected abstract _writeConfigImpl(configPath: string, data: Record<string, unknown>): void;
protected abstract _registerServerImpl(configPath: string, name: string, config: Record<string, unknown>): void;
```

**Phase B — Update all 14 platform files (same transformation each):**

For each platform file, apply this pattern:

```typescript
// Before:
writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;
    this.backup(p);
    // ... uses p
}

registerServer(name: string, config: Record<string, any>) {
    // ... uses this.configPath()! or calls this.writeConfig()
}

// After:
protected _writeConfigImpl(configPath: string, data: Record<string, unknown>): void {
    this.backup(configPath);
    // ... uses configPath (string — no !)
}

protected _registerServerImpl(configPath: string, name: string, config: Record<string, unknown>): void {
    // ... uses configPath (string — no !)
    // Calls this.writeConfig(data) — still valid (goes through base class wrapper)
}
```

**warp.ts special case** — has 2 `configPath()!` calls, one in each method. Both are eliminated by the same rename + parameter injection.

Changes required in each file:
1. `writeConfig` → `protected _writeConfigImpl`
2. `registerServer` → `protected _registerServerImpl`
3. First parameter: `configPath: string` replaces `this.configPath()!`
4. `Record<string, any>` → `Record<string, unknown>`
5. Remove `protected` if it was already there with different intent

**Acceptance Criteria:**
- [ ] `base.ts` has concrete `writeConfig()` and `registerServer()` with null guard
- [ ] `base.ts` has `protected abstract _writeConfigImpl(configPath: string, ...)` and `protected abstract _registerServerImpl(configPath: string, ...)`
- [ ] All 14 platforms implement `_writeConfigImpl` and `_registerServerImpl` (not the old names)
- [ ] Zero `configPath()!` calls anywhere in platform files
- [ ] `configPath` parameter inside impl methods is `string` (not `string | null`)
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
The null guard lives once in the base class. Every platform receives a guaranteed `string` configPath. The class hierarchy enforces correctness — a new platform adapter cannot accidentally skip the null check.

---

> **BEFORE PROCEEDING TO WAVE 5:**
> Spawn a review subagent. Verify: `base.ts` wrappers are correct and the null guard fires, all 14 platforms compile, `configPath()!` grep returns zero results.

---

## Wave 5: Adapter Typed Config Interfaces

> **SEQUENTIAL INTERNAL STRUCTURE:** `types.ts` created first; then platform files updated.
>
> **Dependencies:** Wave 4 must complete (method signatures renamed — typed configs built on top).
> **File Safety:** New `types.ts` + 14 platform files ✓

---

### Task 5.1: Create `adapters/types.ts` + typed config interfaces in all platforms

**Files:**
- Create: `packages/zenith-mcp/src/adapters/types.ts`
- Modify (all 14): Same platform files as Wave 4

**Codebase References:**
- Platform config formats:
  - JSON `mcpServers` object: claude-desktop, cline, gemini-cli, github-copilot, antigravity, opencode, raycast, roo-code, zed
  - JSON `context_servers` object: zed (different key)
  - Nested/indexed: jetbrains (multiple config paths)
  - YAML directory: warp (one file per server)
  - Array of objects: continue-dev, gptme
  - Different schema: codex-cli, codex-desktop (`mcp_servers` key), openclaw

**Implementation Details:**

**Phase A — Create `types.ts`:**

```typescript
// packages/zenith-mcp/src/adapters/types.ts

/** A single MCP server entry as stored in most platform configs. */
export interface McpServerEntry {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    [key: string]: unknown;  // extensible — platforms may add platform-specific fields
}

/** Standard JSON config with mcpServers key (claude-desktop, cline, gemini-cli, etc.) */
export interface StandardMcpConfig {
    mcpServers?: Record<string, McpServerEntry>;
    [key: string]: unknown;
}

/** Zed uses context_servers instead of mcpServers */
export interface ZedConfig {
    context_servers?: Record<string, McpServerEntry>;
    [key: string]: unknown;
}

/** Continue and GPTMe use an array of server objects */
export interface ContinueServerEntry {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    [key: string]: unknown;
}

export interface ArrayStyleConfig {
    mcpServers?: ContinueServerEntry[];
    [key: string]: unknown;
}

/** Codex CLI/Desktop use mcp_servers key */
export interface CodexConfig {
    mcp_servers?: Record<string, McpServerEntry>;
    [key: string]: unknown;
}
```

**Phase B — Update each platform to use typed config:**

Representative example (claude-desktop.ts):
```typescript
import type { StandardMcpConfig, McpServerEntry } from '../types.js';

readConfig(): StandardMcpConfig {
    const p = this.configPath();
    if (!p || !existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8")) as StandardMcpConfig;
}

protected _writeConfigImpl(configPath: string, data: StandardMcpConfig): void {
    this.backup(configPath);
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

protected _registerServerImpl(configPath: string, name: string, config: McpServerEntry): void {
    const data = this.readConfig();
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers[name] = config;
    this.writeConfig(data);
}
```

Apply the appropriate type for each platform (StandardMcpConfig, ZedConfig, ArrayStyleConfig, CodexConfig, or custom).

**Acceptance Criteria:**
- [ ] `types.ts` created with shared config interfaces
- [ ] Every platform imports its appropriate config type from `../types.js`
- [ ] No `Record<string, any>` in any platform file
- [ ] No `as Record<string, any>` casts inside platform methods
- [ ] Config types match the platform's actual on-disk format
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
Every platform uses a named interface for its config. Fields at known positions are typed. Unknown extensions use `[key: string]: unknown`. No `any` type appears anywhere in the adapters directory.

---

> **BEFORE REPORTING COMPLETE:**
> Spawn a final review subagent. Run the full verification suite below.

---

## Final Verification

After all 5 waves complete:

```bash
cd /home/tanner/Projects/Zenith-MCP

# 1. Full TypeScript check — must exit 0
npx tsc --noEmit -p packages/zenith-mcp

# 2. Grep for remaining suppressions — each must return zero results
echo "=== Remaining ! assertions ==="
grep -rn "[^!=<>]![^=]" packages/zenith-mcp/src --include="*.ts" | grep -v "node_modules" | grep -v "//.*!"

echo "=== Remaining as unknown as ==="
grep -rn "as unknown as" packages/zenith-mcp/src --include="*.ts"

echo "=== Remaining Record<string, any> ==="
grep -rn "Record<string, any>" packages/zenith-mcp/src --include="*.ts"

echo "=== Remaining nosemgrep ==="
grep -rn "nosemgrep" packages/zenith-mcp/src --include="*.ts"

echo "=== Remaining : any ==="
grep -rn ": any[,;\s>)\]]" packages/zenith-mcp/src --include="*.ts"

# 3. Build
cd packages/zenith-mcp && npm run build
```

**Expected:** All grep commands return zero results. TypeScript exits 0. Build succeeds.

---

## Audit Items Closed

| Audit item | Status |
|---|---|
| `core/compression.ts` — `isCompressionUseful` type predicate | ✅ Already done — source confirmed |
| `retrieval/ranking/bmx-index.ts` — `TermData` + `_getOrCreateTerm()` | ✅ Already done — source confirmed |
