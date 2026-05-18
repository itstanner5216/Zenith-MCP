# PR #12 Behavioral Fixes — Wave-Based Execution Plan

**Goal:** Eliminate 22 confirmed behavioral bugs, security gaps, performance regressions, and logic defects found across 6 review bots during the Wave 2 Security PR review — replacing each with the structurally correct, optimal implementation.

**Total Waves:** 3
**Total Tasks:** 15 (22 fixes mapped across 15 task units — same-file fixes combined)
**Max Parallel Tasks in Single Wave:** 9

> **Mindset for every implementing agent:** You are not patching. You are not minimizing. Every fix must answer: *"What does the absolute best, correct version of this code look like?"* These are behavioral defects — silent failures, security leaks, performance regressions, logic gaps. The fix is always the correct structure. No shortcuts, no regressions, no half-measures.

---

## CODEBASE RECONNAISSANCE

```
CODEBASE RECONNAISSANCE:
├── Project Structure: TypeScript MCP server — packages/zenith-mcp/src/
│   ├── core/lib.ts — FilesystemContext, file I/O (tailFile, offsetReadFile, validateNewFilePath)
│   ├── core/shared.ts — ripgrep integration, BM25 search, isSensitive, getDefaultExcludes, config accessors
│   ├── core/path-validation.ts — isPathWithinAllowedDirectories (path sandbox enforcement)
│   ├── core/roots-utils.ts — MCP Roots URI parsing and normalization
│   ├── core/symbol-index.ts — SQLite symbol DB, indexFile, ensureIndexFresh, shouldIndexFile
│   ├── utils/project-scope.ts — project root resolution ladder, clampToAllowed, caching
│   ├── tools/search_file.ts — single-file grep/symbol tool
│   ├── tools/search_files.ts — multi-file content/files/symbol/definition/structural search
│   ├── tools/directory.ts — directory list/tree exploration
│   ├── tools/write_file.ts — file create/overwrite/append
│   └── config/schema.ts — ZenithConfig interface, DEFAULT_CONFIG, parsing
├── Tech Stack: TypeScript 5.x, MCP SDK, Zod, better-sqlite3, web-tree-sitter, minimatch
├── Key Conventions:
│   ├── strict: true + noUncheckedIndexedAccess: true (tsconfig.json)
│   ├── Tools registered via server.registerTool() with flat Zod schemas
│   ├── All filesystem paths validated via ctx.validatePath() / ctx.validateNewFilePath()
│   ├── ripgrepSearch returns RipgrepResult[] | null (null = process error, [] = no matches)
│   ├── Sensitive file filtering via isSensitive() + getSensitivePatterns() (minimatch-based)
│   ├── Default excludes via getDefaultExcludes() (config string, re-parsed each call)
│   └── Relative .js imports (ESM), named exports
├── Reusable Infrastructure:
│   ├── src/core/shared.ts — getConfig() lazy singleton, getCharBudget() with bounds validation
│   ├── src/core/path-validation.ts — isPathWithinAllowedDirectories() path sandbox check
│   ├── src/core/lib.ts — normalizeLineEndings(), expandHome(), createReadStream utilities
│   └── src/config/schema.ts — ZenithConfig type, DEFAULT_CONFIG, rawToConfig parser
└── Import Conventions: relative .js extension required, named exports, no barrel index files
```

---

## FILE INVENTORY

```
FILE INVENTORY:
├── Files to MODIFY:
│   ├── src/core/shared.ts — ripgrepSearch proc.kill + context cap, getSearchCharBudget validation,
│   │                          getDefaultExcludes/getSensitivePatterns caching
│   ├── src/core/lib.ts — tailFile backward read, offsetReadFile length guard, validateNewFilePath error sanitization
│   ├── src/core/path-validation.ts — root dir "/" separator handling
│   ├── src/core/roots-utils.ts — file:~/repo tilde preservation
│   ├── src/core/symbol-index.ts — ensureIndexFresh shouldIndexFile guard
│   ├── src/utils/project-scope.ts — clampToAllowed null return, cache key/iteration order alignment
│   ├── src/tools/search_file.ts — ripgrep null vs empty distinction, separator budget check
│   ├── src/tools/search_files.ts — ripgrep null error propagation, getDefaultExcludes caching in walks
│   ├── src/tools/directory.ts — list mode default excludes + isSensitive, tree mode isSensitive,
│   │                             getDefaultExcludes caching, wildcard pattern glob expansion
│   ├── src/tools/write_file.ts — fs.stat ENOENT-only catch
│   └── src/tools/refactor_batch.ts — Zod inputSchema .strict() enforcement
├── Files to READ (no modifications):
│   ├── src/config/schema.ts — ZenithConfig type definition
│   └── packages/zenith-mcp/tsconfig.json — compiler flags
└── Files to CREATE: none
```

---

## DEPENDENCY PROOF TABLE

| Task | Claims to depend on | Proof: Cannot produce correct output because... | Verdict |
|---|---|---|---|
| Task 2.1 (search_files.ts) | Task 1.1 (shared.ts ripgrep changes) | search_files.ts calls `ripgrepSearch()`. If shared.ts changes the proc.kill behavior or context line semantics, search_files.ts must be coded against the updated function contract. | REAL — behavioral contract |
| Task 2.2 (search_file.ts) | Task 1.1 (shared.ts ripgrep changes) | search_file.ts calls `ripgrepSearch()`. Same contract dependency. | REAL — behavioral contract |
| Task 2.3 (directory.ts) | Task 1.1 (shared.ts caching) | directory.ts imports `getDefaultExcludes`. If shared.ts exports a cached version or changes the API, directory.ts must use the updated API. | FALSE — directory.ts will cache locally regardless of shared.ts internal caching. Both changes are independent. |
| Task 3.1 (symbol-index.ts) | — | `shouldIndexFile` and `purgeIndexedPath` already exist. Task adds a call at a new location. No file conflicts. | NONE |
| All Wave 1 tasks | — | All modify distinct files, zero cross-dependencies | PARALLEL ✓ |

---

## CONFLICT ANALYSIS

```
CONFLICT ANALYSIS:
├── File Conflicts Resolved:
│   ├── shared.ts: ripgrep proc.kill + context cap (Fix 8,9) + getSearchCharBudget (Fix 17) +
│   │              getDefaultExcludes/getSensitivePatterns caching (Fix 15) → Combined into Task 1.1
│   ├── lib.ts: tailFile (Fix 13) + offsetReadFile guard (Fix 18) + validateNewFilePath (Fix 14) → Combined into Task 1.2
│   ├── search_file.ts: ripgrep null (Fix 1) + separator budget (Fix 16) → Combined into Task 2.2
│   ├── search_files.ts: ripgrep null (Fix 2) + getDefaultExcludes caching (Fix 15) → Combined into Task 2.1
│   ├── directory.ts: list default excludes (Fix 4) + isSensitive (Fix 10) + wildcard glob (Fix 7) +
│   │                  getDefaultExcludes caching (Fix 15) → Combined into Task 2.3
│   └── project-scope.ts: clampToAllowed (Fix 5) + cache key sort (Fix 19) → Combined into Task 1.5
├── Sequential Requirements:
│   └── search_file.ts and search_files.ts call ripgrepSearch() → must follow shared.ts changes
├── False Dependencies Eliminated:
│   ├── directory.ts does not call ripgrepSearch — can parallelize with shared.ts
│   ├── write_file.ts, path-validation.ts, roots-utils.ts, symbol-index.ts — all independent
│   └── project-scope.ts changes are internal logic — no downstream callers affected
└── No Conflicts:
    └── path-validation.ts, roots-utils.ts, write_file.ts, symbol-index.ts, project-scope.ts, refactor_batch.ts — all distinct files
```

---

## WAVE ASSIGNMENT

```
WAVE ASSIGNMENT:
├── Wave 1 (6 tasks — fully parallel):
│   ├── Task 1.1: shared.ts — ripgrep proc.kill, context cap, getSearchCharBudget, caching
│   ├── Task 1.2: lib.ts — tailFile backward read, offsetReadFile guard, error sanitization
│   ├── Task 1.3: path-validation.ts — root dir separator fix
│   ├── Task 1.4: roots-utils.ts — tilde preservation in file: URIs
│   ├── Task 1.5: project-scope.ts — clampToAllowed null fix, cache/iteration alignment
│   └── Task 1.6: write_file.ts — ENOENT-only stat catch
│   VALIDATION: 6 different files ✓ No intra-dependencies ✓ Current repo state ✓
│
├── Wave 2 (3 tasks — fully parallel):
│   ├── Task 2.1: search_files.ts — ripgrep null propagation, getDefaultExcludes caching
│   ├── Task 2.2: search_file.ts — ripgrep null distinction, separator budget
│   └── Task 2.3: directory.ts — default excludes, isSensitive, wildcard globs, caching
│   VALIDATION: 3 different files ✓ Wave 1 shared.ts contract changes landed ✓
│
├── Wave 3 (1 task):
│   └── Task 3.1: symbol-index.ts — ensureIndexFresh shouldIndexFile guard
│   VALIDATION: No file conflicts ✓ Independent of all other waves ✓
│
└── Wave 4: Verification
    └── Full test suite + manual behavioral verification
```

### Parallelism Stress Test

1. **Task 3.1 (symbol-index.ts):** Could this move to Wave 1? YES — it modifies a distinct file and has no dependency on shared.ts changes. **MOVED TO WAVE 1.**
2. **Task 2.3 (directory.ts):** Could this move to Wave 1? YES — directory.ts does not call `ripgrepSearch()`. Its `getDefaultExcludes` import is unchanged. It only needs the function to exist, which it already does. **MOVED TO WAVE 1.**

**Revised Wave Assignment:**

```
REVISED WAVE ASSIGNMENT:
├── Wave 1 (9 tasks — fully parallel):
│   ├── Task 1.1: shared.ts — ripgrep proc.kill, context cap, getSearchCharBudget, caching
│   ├── Task 1.2: lib.ts — tailFile backward read, offsetReadFile guard + early exit, error sanitization
│   ├── Task 1.3: path-validation.ts — root dir separator fix
│   ├── Task 1.4: roots-utils.ts — tilde preservation in file: URIs
│   ├── Task 1.5: project-scope.ts — clampToAllowed null fix, cache/iteration alignment, readdirSync perf
│   ├── Task 1.6: write_file.ts — ENOENT-only stat catch
│   ├── Task 1.7: symbol-index.ts — ensureIndexFresh shouldIndexFile guard
│   ├── Task 1.8: directory.ts — default excludes, isSensitive, wildcard globs, caching
│   └── Task 1.9: refactor_batch.ts — Zod inputSchema .strict() enforcement
│   VALIDATION: 9 different files ✓ No intra-dependencies ✓ Current repo state ✓
│
├── Wave 2 (2 tasks — fully parallel):
│   ├── Task 2.1: search_files.ts — ripgrep null propagation, getDefaultExcludes caching
│   └── Task 2.2: search_file.ts — ripgrep null distinction, separator budget
│   VALIDATION: 2 different files ✓ Wave 1 shared.ts changes landed ✓
│
└── Wave 3: Verification
    └── Full test suite + behavioral verification
```

**Final: 3 waves, 11 tasks, max 9 parallel in Wave 1.**

---

## Wave 1: Independent Single-File Fixes

> **PARALLEL EXECUTION:** All 9 tasks in this wave run simultaneously.
>
> **Dependencies:** None — executes against current repo state.
> **File Safety:** shared.ts · lib.ts · path-validation.ts · roots-utils.ts · project-scope.ts · write_file.ts · symbol-index.ts · directory.ts · refactor_batch.ts — one task per file ✓

---

### Task 1.1: Fix `shared.ts` — ripgrep process lifecycle, context cap, search budget validation, and hot-path caching

**Files:**
- Modify: `packages/zenith-mcp/src/core/shared.ts`

**Codebase References:**
- `ripgrepSearch` function: `shared.ts:277-349` — spawns ripgrep, collects results via JSON parsing
- Match collection cap: `shared.ts:323` — `if (msg.type === 'match' && results.length < maxResults)`
- Context collection (no cap): `shared.ts:329-334` — unconditionally pushes context lines after match cap
- No `proc.kill()` anywhere in the function
- `getSearchCharBudget`: `shared.ts:27-29` — no bounds validation, raw passthrough
- `getCharBudget`: `shared.ts:20-24` — has proper bounds validation (model to follow)
- `getDefaultExcludes`: `shared.ts:35-43` — re-parses config string `.split(',').map().filter()` every call
- `getSensitivePatterns`: `shared.ts:45-53` — same re-parse pattern
- `isSensitive`: `shared.ts:55-61` — calls `getSensitivePatterns()` (re-parses) + runs minimatch per pattern
- Hot-path callers: `ripgrepSearch` lines 326,332; `ripgrepCountMatches` line 445; `ripgrepFindFiles` line 373

**Implementation Details:**

**Fix A — Kill ripgrep process after maxResults (lines 310-349):**

The current `ripgrepSearch` lets ripgrep run until natural completion or the 30-second timeout even after `maxResults` is reached. For a broad pattern on a large repo, this wastes CPU, memory, and I/O while silently discarding all output past the cap.

Add a `matchCount` tracker and `proc.kill()` inside the stdout handler. Kill only when not collecting context lines (context for the final match may still be incoming):

```typescript
// Inside the promise body, before proc.stdout.on:
let matchCount = 0;
let killed = false;

// Replace match handler (line 323):
if (msg.type === 'match') {
    matchCount++;
    if (results.length < maxResults) {
        const d = msg.data;
        const filePath = d.path?.text;
        if (filePath && (skipSensitiveFilter || !isSensitive(filePath))) {
            results.push({ file: filePath, line: d.line_number, content: d.lines?.text?.replace(/\n$/, '') || '' });
        }
    } else if (!killed && !includeContextLines) {
        killed = true;
        proc.kill('SIGTERM');
    }
}
```

**Fix B — Cap context lines (lines 329-334):**

Context lines currently bypass `maxResults` entirely. Once match collection is full, ALL subsequent context lines from ripgrep's output continue to be appended without limit. With `-C 30` and `maxResults: 10000`, this can produce hundreds of thousands of context entries.

Cap total results (matches + context combined) at `maxResults`. When the combined cap is hit, kill the process:

```typescript
} else if (includeContextLines && msg.type === 'context') {
    if (results.length < maxResults) {
        const d = msg.data;
        const filePath = d.path?.text;
        if (filePath && (skipSensitiveFilter || !isSensitive(filePath))) {
            results.push({ file: filePath, line: d.line_number, content: d.lines?.text?.replace(/\n$/, '') || '', isContext: true });
        }
    } else if (!killed) {
        killed = true;
        proc.kill('SIGTERM');
    }
}
```

**Fix C — Validate `getSearchCharBudget` (lines 27-29):**

`getCharBudget()` has proper bounds validation (`>= 10_000 && <= 2_000_000`, defaults to 400,000). `getSearchCharBudget()` passes the raw config value through with only a `Math.min` against `getCharBudget()`. A config value of `0` or `-1` would make every search budget check trigger immediately, silently suppressing all results.

```typescript
// Before (lines 27-29):
export function getSearchCharBudget(): number {
    return Math.min(getConfig().advanced.search_char_budget, getCharBudget());
}

// After:
export function getSearchCharBudget(): number {
    const val = getConfig().advanced.search_char_budget;
    const validated = (typeof val === 'number' && !isNaN(val) && val >= 1_000 && val <= 2_000_000)
        ? val
        : 15_000; // DEFAULT_CONFIG.advanced.search_char_budget
    return Math.min(validated, getCharBudget());
}
```

**Fix D — Cache `getDefaultExcludes()` and `getSensitivePatterns()` results:**

Both functions re-split, re-map, and re-filter the config string on every invocation. In hot loops (directory walks, ripgrep result parsing), this creates thousands of redundant string operations. The config is a lazy singleton that never changes — the parsed result is always identical.

Add module-level cache variables that invalidate when `_config` changes (it never does in practice, but this is structurally correct):

```typescript
// After the _config declaration (line 11):
let _defaultExcludesCache: string[] | null = null;
let _sensitivePatternsCache: string[] | null = null;
let _configVersion = 0;
let _cachedConfigVersion = -1;

function getConfig(): ZenithConfig {
    if (!_config) {
        _config = loadConfig();
        _configVersion++;
    }
    return _config;
}

function invalidateCachesIfNeeded(): void {
    if (_cachedConfigVersion !== _configVersion) {
        _defaultExcludesCache = null;
        _sensitivePatternsCache = null;
        _cachedConfigVersion = _configVersion;
    }
}

// Replace getDefaultExcludes (lines 35-43):
export function getDefaultExcludes(): string[] {
    invalidateCachesIfNeeded();
    if (_defaultExcludesCache) return _defaultExcludesCache;
    const raw = getConfig().advanced.default_excludes;
    if (raw && typeof raw === 'string') {
        const parsed = raw.split(',').map(p => p.trim()).filter(Boolean);
        if (parsed.length > 0) {
            _defaultExcludesCache = parsed;
            return parsed;
        }
    }
    _defaultExcludesCache = 'node_modules,.git,.next,.venv,venv,.env.local,dist,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo'
        .split(',').map(p => p.trim()).filter(Boolean);
    return _defaultExcludesCache;
}

// Replace getSensitivePatterns (lines 45-53):
export function getSensitivePatterns(): string[] {
    invalidateCachesIfNeeded();
    if (_sensitivePatternsCache) return _sensitivePatternsCache;
    const raw = getConfig().advanced.sensitive_patterns;
    if (raw && typeof raw === 'string') {
        const parsed = raw.split(',').map(p => p.trim()).filter(Boolean);
        if (parsed.length > 0) {
            _sensitivePatternsCache = parsed;
            return parsed;
        }
    }
    _sensitivePatternsCache = '**/.env,**/*.pem,**/*.key,**/*.crt,**/*credentials*,**/*secret*,**/docker-compose.yaml,**/docker-compose.yml,**/.config/**'
        .split(',').map(p => p.trim()).filter(Boolean);
    return _sensitivePatternsCache;
}
```

This eliminates thousands of redundant string splits in hot paths while remaining structurally correct if config is ever reloaded.

**Acceptance Criteria:**
- [ ] `ripgrepSearch` kills the ripgrep process via `proc.kill('SIGTERM')` when `maxResults` is reached and context collection is not active
- [ ] Context lines are capped at `maxResults` total (matches + context combined)
- [ ] `getSearchCharBudget()` validates its config value with `>= 1_000 && <= 2_000_000` bounds, defaulting to 15,000
- [ ] `getDefaultExcludes()` returns a cached array on subsequent calls (no re-split)
- [ ] `getSensitivePatterns()` returns a cached array on subsequent calls (no re-split)
- [ ] Cache invalidation is structurally correct (tied to config version)
- [ ] `tsc --noEmit` passes
- [ ] Existing tests pass: `npm test`

**What Complete Looks Like:**
`ripgrepSearch` actively manages its child process lifecycle. Budget validation matches `getCharBudget()` style. Hot-path config accessors return cached arrays. The function signatures and return types are unchanged — all changes are internal behavioral improvements.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

### Task 1.2: Fix `lib.ts` — tailFile backward read, offsetReadFile length guard, error message sanitization

**Files:**
- Modify: `packages/zenith-mcp/src/core/lib.ts`

**Codebase References:**
- `tailFile`: `lib.ts:318-339` — ring buffer reads entire file
- `headFile`: `lib.ts:341-356` — correct early `break` (model to compare against)
- `offsetReadFile`: `lib.ts:358-381` — no guard for `length <= 0`
- `validateNewFilePath`: `lib.ts:103-121` — error messages leak `absolute` path and `_allowedDirectories` array
- Imports already present: `createReadStream` (line 4), `createInterface` (line 5), `fs` from 'fs/promises' (line 1)
- `fs.open` is available via `import fs from 'fs/promises'` — `fs.open()` returns `FileHandle`

**Implementation Details:**

**Fix A — Restore backward-seek `tailFile` (lines 318-339):**

The current ring buffer reads every line of the file to return the last N. For a 2 GB log where only the last 20 lines are requested, this reads the entire 2 GB. The pre-cleanup version used backward chunk reads from the file end — O(requested lines) rather than O(file size).

Replace the ring buffer with a backward-chunked read:

```typescript
export async function tailFile(filePath: string, numLines: number) {
    const n = Math.floor(numLines);
    if (!Number.isFinite(n) || n <= 0) return '';
    const cap = Math.min(n, 50_000);

    const CHUNK_SIZE = 65_536; // 64 KB chunks
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;
    if (fileSize === 0) return '';

    // For small files (< 2 chunks), use the simple streaming approach
    if (fileSize <= CHUNK_SIZE * 2) {
        const stream = createReadStream(filePath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        const ring = new Array<string>(cap);
        let count = 0;
        try {
            for await (const line of rl) {
                ring[count % cap] = line;
                count++;
            }
        } finally {
            rl.close();
            stream.destroy();
        }
        if (count === 0) return '';
        if (count <= cap) return ring.slice(0, count).join('\n');
        const start = count % cap;
        return [...ring.slice(start), ...ring.slice(0, start)].join('\n');
    }

    // For large files, read backward from the end
    const fileHandle = await fs.open(filePath, 'r');
    try {
        const lines: string[] = [];
        let position = fileSize;
        let remainder = '';
        let linesFound = 0;

        while (position > 0 && linesFound < cap) {
            const readSize = Math.min(CHUNK_SIZE, position);
            position -= readSize;
            const buf = Buffer.alloc(readSize);
            const { bytesRead } = await fileHandle.read(buf, 0, readSize, position);
            if (!bytesRead) break;

            const chunkText = buf.slice(0, bytesRead).toString('utf-8') + remainder;
            const chunkLines = chunkText.split('\n');

            // First element may be a partial line (unless we're at file start)
            if (position > 0) {
                remainder = chunkLines[0] ?? '';
                chunkLines.shift();
            } else {
                remainder = '';
            }

            // Collect lines from the end of this chunk
            for (let i = chunkLines.length - 1; i >= 0 && linesFound < cap; i--) {
                lines.unshift(chunkLines[i] ?? '');
                linesFound++;
            }
        }

        // If there's a remainder and we haven't collected enough lines, add it
        if (remainder && linesFound < cap) {
            lines.unshift(remainder);
        }

        return lines.join('\n');
    } finally {
        await fileHandle.close();
    }
}
```

This uses the streaming ring buffer only for small files (< 128 KB) and the backward-seek approach for large files. The backward read is O(N * CHUNK_SIZE) where N is the number of requested lines, not O(file_size).

**Fix B — Guard `offsetReadFile` for non-positive `length` + early exit after collecting enough lines (lines 358-381):**

When `length <= 0`, the current code enters the loop, hits the `else` branch on the first eligible line (`collected.length < 0` is false), sets `hasMore = true`, and returns `{ content: '', linesReturned: 0, hasMore: true }`. The `hasMore: true` is misleading — the caller asked for nothing.

Additionally, when `length > 0` and enough lines have been collected, the function continues reading the entire file instead of breaking out of the readline loop. The previous implementation had an early `break` — this regression means `offsetReadFile` is O(file_size) instead of O(offset + length).

```typescript
// Add at the start of offsetReadFile (after line 358):
export async function offsetReadFile(filePath: string, offset: number, length: number) {
    if (length <= 0) return { content: '', linesReturned: 0, hasMore: false };
    // ... rest of function ...

    // Inside the readline 'line' event handler, after pushing to collected:
    // When collected.length >= length, we have all lines needed.
    // The existing code sets hasMore = true when collected.length >= length,
    // but does NOT break. Add break to stop reading the rest of the file:
    if (collected.length >= length) {
        hasMore = true;
        rl.close(); // triggers 'close' event, exits the loop
        break;      // if using for-await, or rl.close() + return for event-based
    }
```

**Fix C — Sanitize `validateNewFilePath` error messages (lines 103-121):**

The error messages include the absolute path AND the full `_allowedDirectories` array. These bubble up as MCP tool responses, exposing sandbox configuration to the LLM client.

```typescript
// Before (lines 109-111):
if (!isPathWithinAllowedDirectories(normalizedRequested, _allowedDirectories)) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${_allowedDirectories.join(', ')}`);
}

// After:
if (!isPathWithinAllowedDirectories(normalizedRequested, _allowedDirectories)) {
    console.error(`[validateNewFilePath] Access denied: ${absolute} not in [${_allowedDirectories.join(', ')}]`);
    throw new Error('Access denied — path is outside allowed directories.');
}

// Before (lines 114-116):
if (!isPathWithinAllowedDirectories(normalizedAncestor, _allowedDirectories)) {
    throw new Error(`Access denied - ancestor outside allowed directories: ${realAncestor} not in ${_allowedDirectories.join(', ')}`);
}

// After:
if (!isPathWithinAllowedDirectories(normalizedAncestor, _allowedDirectories)) {
    console.error(`[validateNewFilePath] Access denied: ancestor ${realAncestor} not in [${_allowedDirectories.join(', ')}]`);
    throw new Error('Access denied — resolved path is outside allowed directories.');
}
```

Diagnostic details go to `console.error` (server logs). The thrown error is minimal — the caller already knows what path they requested.

**Acceptance Criteria:**
- [ ] `tailFile` uses backward-seek from file end for files > 128 KB
- [ ] `tailFile` falls back to ring buffer for small files (preserves correctness)
- [ ] `tailFile` preserves the 50,000-line cap
- [ ] `offsetReadFile` returns `{ content: '', linesReturned: 0, hasMore: false }` when `length <= 0`
- [ ] `offsetReadFile` stops reading once `collected.length >= length` (does not read entire file)
- [ ] `validateNewFilePath` error messages do not contain paths or allowlist
- [ ] Diagnostic details logged to `console.error`
- [ ] `tsc --noEmit` passes
- [ ] Existing tests pass

**What Complete Looks Like:**
`tailFile` is O(N) in requested lines for large files. `offsetReadFile` handles edge cases cleanly. Error messages follow CLAUDE.md's context efficiency rules — minimal, actionable, no information leakage.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

### Task 1.3: Fix `path-validation.ts` — root directory separator handling

**Files:**
- Modify: `packages/zenith-mcp/src/core/path-validation.ts`

**Codebase References:**
- Full file: `path-validation.ts` — 22 lines total
- `isPathWithinAllowedDirectories`: lines 5-18
- Bug at line 16: `resolved.startsWith(normalizedDir + sep)` fails when `normalizedDir` is `/`
- `normalizedDir + sep` produces `//` for root, which no normal path starts with
- Called by: `lib.ts:109,114` (validateNewFilePath), `lib.ts:55` (validatePath)

**Implementation Details:**

When the allowed directory is the filesystem root `/`, appending `path.sep` produces `//`. The path `/home/user/file` does NOT start with `//`, so all paths under root are incorrectly rejected. The fix must handle root paths that already end with the separator:

```typescript
// Current implementation (lines 10-18):
export function isPathWithinAllowedDirectories(filePath: string, allowedDirectories: string[]): boolean {
    const resolved = _normalizePath(path.resolve(filePath));
    const sep = path.sep;
    return allowedDirectories.some(dir => {
        const normalizedDir = _normalizePath(path.resolve(dir));
        return resolved === normalizedDir || resolved.startsWith(normalizedDir + sep);
    });
}

// Fixed implementation:
export function isPathWithinAllowedDirectories(filePath: string, allowedDirectories: string[]): boolean {
    const resolved = _normalizePath(path.resolve(filePath));
    const sep = path.sep;
    return allowedDirectories.some(dir => {
        const normalizedDir = _normalizePath(path.resolve(dir));
        if (resolved === normalizedDir) return true;
        const prefix = normalizedDir.endsWith(sep) ? normalizedDir : normalizedDir + sep;
        return resolved.startsWith(prefix);
    });
}
```

The key change: check if `normalizedDir` already ends with the separator before appending one. For `/`, `prefix` becomes `/` (not `//`). For `/home/user`, `prefix` becomes `/home/user/` as before.

**Acceptance Criteria:**
- [ ] `isPathWithinAllowedDirectories('/home/user/file', ['/'])` returns `true`
- [ ] `isPathWithinAllowedDirectories('/home/user/file', ['/home/user'])` returns `true` (unchanged)
- [ ] `isPathWithinAllowedDirectories('/home/user', ['/home/user'])` returns `true` (exact match, unchanged)
- [ ] `isPathWithinAllowedDirectories('/home/user2/file', ['/home/user'])` returns `false` (no prefix collision)
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
The function correctly handles root directories as allowed paths. The separator append is conditional on whether the path already ends with one.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

### Task 1.4: Fix `roots-utils.ts` — preserve tilde in `file:~/repo` URI fallback

**Files:**
- Modify: `packages/zenith-mcp/src/core/roots-utils.ts`

**Codebase References:**
- Full file: `roots-utils.ts` — ~45 lines
- URI parsing at lines 8-22: malformed `file:` URI fallback
- Bug flow: `file:~/repo` → `indexOf(':')` = 4, `indexOf('/', 4)` = 6 → `slice(7)` = `repo` — tilde stripped
- Tilde expansion at line 21: `if (rawPath === '~' || rawPath.startsWith('~/'))` — never matches because `rawPath` is `repo`
- `expandHome` import at line 2: utility that replaces `~` with `os.homedir()`

**Implementation Details:**

The current fallback extraction uses `indexOf('/')` to find the path start, which finds the `/` in `~/repo` and strips the tilde. The fix should extract everything after the `file:` scheme prefix, then handle the `//` prefix for well-formed URIs:

```typescript
// Current fallback (lines 15-17):
const colonPos = rootUri.indexOf(':');
const slashPos = rootUri.indexOf('/', colonPos);
rawPath = slashPos >= 0 ? rootUri.slice(slashPos + 1) : rootUri.slice(colonPos + 1);

// Fixed fallback:
const afterScheme = rootUri.slice('file:'.length); // preserves everything after "file:"
if (afterScheme.startsWith('//')) {
    // file://host/path or file:///path — find the path after authority
    const pathStart = afterScheme.indexOf('/', 2);
    rawPath = pathStart >= 0 ? afterScheme.slice(pathStart) : afterScheme;
} else {
    // file:~/repo or file:/path — direct path extraction
    rawPath = afterScheme;
}
```

For `file:~/repo`: `afterScheme` = `~/repo`, no `//` prefix, `rawPath` = `~/repo`. Tilde expansion at line 21 then correctly matches `rawPath.startsWith('~/')` and expands to `/home/user/repo`.

For `file:///home/user/repo`: `afterScheme` = `///home/user/repo`, starts with `//`, `pathStart` = 2, `rawPath` = `/home/user/repo`.

**Acceptance Criteria:**
- [ ] `file:~/repo` resolves to `$HOME/repo`
- [ ] `file:///home/user/repo` resolves to `/home/user/repo` (standard well-formed URI)
- [ ] `file:/absolute/path` resolves to `/absolute/path`
- [ ] `file:relative/path` resolves to `relative/path` (then resolved against cwd downstream)
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
The fallback uses `rootUri.slice('file:'.length)` for clean extraction. The `//` authority handling is explicit and documented. Tilde expansion works for all `file:~` patterns.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

### Task 1.5: Fix `project-scope.ts` — `clampToAllowed` null return + cache/iteration alignment

**Files:**
- Modify: `packages/zenith-mcp/src/utils/project-scope.ts`

**Codebase References:**
- `clampToAllowed`: `project-scope.ts:105-130` — clamps a candidate root to stay within allowed dirs
- Bug at line 113: `if (!candidate) return allowedRoot;` — makes null candidate truthy
- Effect: For non-git workspaces, Step 1 short-circuits with the allowed dir, skipping marker detection (`package.json`, `Cargo.toml`, etc.)
- `resolveProjectRoot`: `project-scope.ts:135-175` — the resolution ladder
- Step 1 (line 146): `const gitRoot = clampToAllowed(findRepoRoot(absPath), ...)`
- Steps 2-4: marker detection, registry, fallback — all skipped when Step 1 returns truthy
- Cache key: `project-scope.ts:62` — sorts `allowedDirectories` for canonical key
- `_resolveFromAllowedDirectories`: `project-scope.ts:178-220` — iterates dirs in caller-provided order
- Mismatch: cache key normalizes order (sorted), but iteration depends on order (first match wins)

**Implementation Details:**

**Fix A — `clampToAllowed` returns `null` for null candidates (line 113):**

```typescript
// Before (line 113):
if (!candidate) return allowedRoot;

// After:
if (!candidate) return null;
```

When `findRepoRoot(absPath)` returns `null` (no git repo), `clampToAllowed` should return `null` (no clamped root), not the allowed directory itself. This lets the resolution ladder continue to Step 2 (`_resolveFromAllowedDirectories`, which does marker-based detection within allowed dirs) and Step 3 (marker detection from the path upward). The allowed directory still constrains all results through clamping in subsequent steps.

**Fix B — Sort dirs before iterating in `_resolveFromAllowedDirectories` (lines 178-220):**

The cache key at line 62 sorts `allowedDirectories` for a canonical key. But `_resolveFromAllowedDirectories` iterates in the caller-provided order — different call orders produce different early returns, yet share a cache key. Fix by sorting the iteration order to match the cache key:

```typescript
// In _resolveFromAllowedDirectories, before the iteration loop:
// Before:
for (const dir of allowedDirectories) {
    const resolvedDir = path.resolve(dir);

// After:
const sortedDirs = [...allowedDirectories].map(d => path.resolve(d)).sort();
for (const resolvedDir of sortedDirs) {
```

**Fix C — Replace `readdirSync`+`Set` with `existsSync` per marker (line 287):**

In `_resolveFromAllowedDirectories`, the current code reads the entire directory contents into a `Set` just to check if any project marker file exists. For directories with thousands of entries, this is significantly slower than targeted `existsSync` calls for the ~10 known marker filenames.

```typescript
// Before (around line 287):
const entries = new Set(fs.readdirSync(dir));
if (PROJECT_MARKERS.some(m => entries.has(m))) {
    // found a project root
}

// After:
const hasMarker = PROJECT_MARKERS.some(m => fs.existsSync(path.join(dir, m)));
if (hasMarker) {
    // found a project root
}
```

The `existsSync` approach makes at most `PROJECT_MARKERS.length` stat calls (~10), each O(1) in the filesystem. The `readdirSync` approach reads the entire directory listing (potentially thousands of entries) into memory, then builds a `Set` from it. For typical `node_modules`-heavy workspaces or large monorepos, the existsSync approach is strictly faster.

**Acceptance Criteria:**
- [ ] `clampToAllowed(null, '/workspace')` returns `null` (not `'/workspace'`)
- [ ] Non-git workspace with `package.json` marker resolves to the marker directory, not the top-level allowed dir
- [ ] `_resolveFromAllowedDirectories` sorts its input before iterating
- [ ] Same `allowedDirectories` set in different orders produces the same result
- [ ] `readdirSync` replaced with `existsSync` per marker in `_resolveFromAllowedDirectories`
- [ ] No `new Set(fs.readdirSync(...))` pattern remains in project-scope.ts
- [ ] `tsc --noEmit` passes
- [ ] Existing project-context tests pass (tests were already updated in earlier commit)

**What Complete Looks Like:**
The resolution ladder correctly falls through for non-git workspaces, finding marker-based roots. Cache key and iteration order are aligned — no stale-cache bugs from reordered calls. Marker detection uses targeted stat calls instead of full directory reads.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

### Task 1.6: Fix `write_file.ts` — ENOENT-only stat catch

**Files:**
- Modify: `packages/zenith-mcp/src/tools/write_file.ts`

**Codebase References:**
- Bug at lines 33-37: `catch (err) { void err; }` swallows ALL `fs.stat` errors
- Effect: `EACCES`/`EPERM` on stat makes `existed` stay `false`, bypassing `failIfExists`
- The `errorMessage` helper is already imported: `write_file.ts:8` — `import { errorMessage } from './types.js'`
- Downstream: `args.failIfExists && existed` check at line 38

**Implementation Details:**

Only `ENOENT` means "file does not exist." Any other `fs.stat` error (permission denied, I/O error) should not be silently treated as "file doesn't exist" — that would bypass safety checks and produce confusing downstream errors.

```typescript
// Before (lines 32-37):
let existed = false;
try {
    await fs.stat(validPath);
    existed = true;
}
catch (err) { void err; /* stat failure means file does not exist */ }

// After:
let existed = false;
try {
    await fs.stat(validPath);
    existed = true;
} catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
        throw new Error(`Cannot check target file: ${errorMessage(err)}`);
    }
    // ENOENT — file genuinely does not exist
}
```

**Acceptance Criteria:**
- [ ] `ENOENT` errors are caught silently (file does not exist — `existed` stays `false`)
- [ ] `EACCES` errors throw with a clear message
- [ ] `EPERM` errors throw with a clear message
- [ ] `failIfExists` correctly triggers when the file exists and is readable
- [ ] `tsc --noEmit` passes
- [ ] Existing write_file tests pass

**What Complete Looks Like:**
The catch block discriminates on error code. Only the expected "not found" case is silent. Permission and I/O errors surface immediately with actionable messages.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

### Task 1.7: Fix `symbol-index.ts` — `ensureIndexFresh` shouldIndexFile guard

**Files:**
- Modify: `packages/zenith-mcp/src/core/symbol-index.ts`

**Codebase References:**
- `ensureIndexFresh`: `symbol-index.ts:325-365` — reindexes files with changed hashes
- `shouldIndexFile`: `symbol-index.ts:190-215` — checks isSupported, isSensitive, directory excludes, filename excludes
- `purgeIndexedPath`: `symbol-index.ts:220-228` — removes file + symbols from DB
- `indexFile`: `symbol-index.ts:230-280` — calls `shouldIndexFile` at line 233, purges at line 234
- Bug: `ensureIndexFresh` hashes the file (line 340), compares to stored hash (line 345), and only calls `indexFile` if the hash changed. If a file becomes excluded/sensitive WITHOUT content changing, the hash matches, `indexFile` is never called, and stale rows persist.
- Callers: `tools/refactor_batch.ts` lines 316, 850, 1130

**Implementation Details:**

Add a `shouldIndexFile` check at the top of the per-file loop in `ensureIndexFresh`, BEFORE reading/hashing. This ensures files that became ineligible (via config change or rename) are purged regardless of whether their content changed:

```typescript
// Inside ensureIndexFresh, in the for loop that iterates absFilePaths:
// Add BEFORE the existing hash/read logic:

for (const absPath of absFilePaths) {
    const relPath = path.relative(repoRoot, absPath);

    // Purge files that are no longer eligible for indexing
    // (became sensitive, excluded, or unsupported since last index)
    if (!shouldIndexFile(repoRoot, absPath)) {
        purgeIndexedPath(db, relPath);
        continue;
    }

    // ... existing hash check, read, and indexFile logic
```

The `shouldIndexFile` check is lightweight (in-memory config checks + minimatch), far cheaper than the `fs.readFile` + hash that follows. This adds negligible overhead and closes the gap where `indexFile` was the only place that checked eligibility.

**Acceptance Criteria:**
- [ ] `ensureIndexFresh` calls `shouldIndexFile` before reading/hashing each file
- [ ] Files that fail `shouldIndexFile` are purged via `purgeIndexedPath`
- [ ] Files that pass `shouldIndexFile` proceed to the existing hash/index logic
- [ ] The `shouldIndexFile` + `purgeIndexedPath` pattern matches the one in `indexFile` (line 233-234)
- [ ] `tsc --noEmit` passes

**What Complete Looks Like:**
`ensureIndexFresh` has a `shouldIndexFile` guard at the top of its per-file loop, immediately before the hash comparison. Files that became ineligible are purged on the next freshness check, regardless of content changes.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

### Task 1.8: Fix `directory.ts` — default excludes in list mode, isSensitive filter, wildcard glob expansion, getDefaultExcludes caching

**Files:**
- Modify: `packages/zenith-mcp/src/tools/directory.ts`

**Codebase References:**
- List mode: `directory.ts:50-130` — NO `getDefaultExcludes()` or `isSensitive()` applied
- Tree mode: `directory.ts:131-230` — has `getDefaultExcludes()` (line 154) but NO `isSensitive()`
- Wildcard patterns: `directory.ts:85-86` — `pattern.includes('*') ? minimatch(rel, pattern, { dot: true })` — no `**/${pattern}` expansion
- Tree mode same issue: `directory.ts:148-149` — same missing expansion for wildcards
- `getDefaultExcludes` hot loop: `directory.ts:154` — called per entry inside tree mode's `for (const entry of entries)`
- Imports line 7: `import { getDefaultExcludes } from '../core/shared.js'` — `isSensitive` NOT imported

**Implementation Details:**

**Fix A — Import `isSensitive` (line 7):**

```typescript
// Before:
import { getDefaultExcludes } from '../core/shared.js';
// After:
import { getDefaultExcludes, isSensitive } from '../core/shared.js';
```

**Fix B — Cache `getDefaultExcludes()` at handler top (before list/tree branch):**

Add after the `validatePath` calls, before the mode branch at line 50:

```typescript
// Add near the top of the handler, before the mode check:
const defaultExcludes = getDefaultExcludes(); // cache once per request
```

**Fix C — Add default excludes + isSensitive to list mode (lines 80-92):**

Currently list mode only filters user `excludePatterns`. Add default excludes and sensitive file filtering. Also fix wildcard glob expansion for user patterns:

```typescript
// Replace the filter block (lines 80-92):
// Filter entries: user excludes + default excludes + sensitive files
entries = entries.filter(entry => {
    const rel = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
    const fullPath = path.join(dirPath, entry.name);

    // Check sensitive files
    if (isSensitive(fullPath)) return false;

    // Check default excludes
    if (defaultExcludes.some(p =>
        entry.name === p ||
        minimatch(rel, p, { dot: true }) ||
        minimatch(rel, `**/${p}`, { dot: true })
    )) return false;

    // Check user-specified excludes
    if (excludePatterns.length > 0) {
        const userExcluded = excludePatterns.some(pattern =>
            pattern.includes('*')
                ? (minimatch(rel, pattern, { dot: true }) ||
                   (!pattern.includes('/') && minimatch(rel, `**/${pattern}`, { dot: true })))
                : minimatch(rel, pattern, { dot: true }) ||
                  minimatch(rel, `**/${pattern}`, { dot: true }) ||
                  minimatch(rel, `**/${pattern}/**`, { dot: true })
        );
        if (userExcluded) return false;
    }

    return true;
});
```

Note the wildcard fix: for patterns containing `*` but NOT `/` (like `*.min.js`), also try `**/${pattern}` to match nested files like `src/file.min.js`.

**Fix D — Add isSensitive to tree mode + use cached defaultExcludes + fix wildcard globs (lines 145-158):**

```typescript
// Replace the exclude check block in buildTree:
for (const entry of entries) {
    const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
    const fullPath = path.join(currentPath, entry.name);

    // Check sensitive files
    if (isSensitive(fullPath)) continue;

    // Check user excludes (with wildcard glob expansion)
    const shouldExclude = excludePatterns.some((pattern: string) => {
        if (pattern.includes('*')) {
            return minimatch(relativePath, pattern, { dot: true }) ||
                (!pattern.includes('/') && minimatch(relativePath, `**/${pattern}`, { dot: true }));
        }
        return minimatch(relativePath, pattern, { dot: true }) ||
            minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
            minimatch(relativePath, `**/${pattern}/**`, { dot: true });
    });

    // Check default excludes (using cached value)
    const shouldExcludeByDefault = defaultExcludes.some(p =>
        entry.name === p ||
        minimatch(relativePath, p, { dot: true }) ||
        minimatch(relativePath, `**/${p}`, { dot: true })
    );

    if (shouldExclude || shouldExcludeByDefault) continue;

    if (entry.isDirectory())
        dirEntries.push(entry);
    else
        fileEntries.push(entry);
}
```

**Acceptance Criteria:**
- [ ] `isSensitive` imported from `../core/shared.js`
- [ ] `getDefaultExcludes()` called once at handler top, cached in local `const defaultExcludes`
- [ ] List mode applies default excludes (matching tree mode behavior)
- [ ] List mode applies `isSensitive()` check per entry
- [ ] Tree mode applies `isSensitive()` check per entry (new)
- [ ] Tree mode uses cached `defaultExcludes` (not `getDefaultExcludes()` per entry)
- [ ] Wildcard patterns like `*.min.js` match nested files (`src/file.min.js`) via `**/${pattern}` expansion
- [ ] Wildcard expansion only applies to patterns without `/` (patterns with `/` are treated as explicit paths)
- [ ] `tsc --noEmit` passes
- [ ] Existing directory tests pass

**What Complete Looks Like:**
Both list and tree modes have parity on filtering: default excludes, sensitive files, and user excludes with proper glob expansion. `getDefaultExcludes()` is called once. `.env`, `*.pem`, and other sensitive files no longer appear in any directory listing.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

### Task 1.9: Fix `refactor_batch.ts` — Zod inputSchema `.strict()` enforcement

**Files:**
- Modify: `packages/zenith-mcp/src/tools/refactor_batch.ts`

**Codebase References:**
- Tool registration: `refactor_batch.ts:260-284` — `z.object({...})` defining the inputSchema
- Issue: The Zod schema uses `z.object({...})` without `.strict()`, which means unknown/misspelled keys are silently stripped during parsing. An agent sending `{ mode: "query", targt: "foo" }` (typo) gets no error — the typo is silently dropped and the tool proceeds with `target` being `undefined`.
- All other Zenith tools should follow the same pattern, but `refactor_batch` has the most complex schema (6 modes with different key combinations) where silent key stripping is most dangerous.

**Implementation Details:**

Add `.strict()` to the `z.object({...})` call in the tool registration. This makes Zod reject any keys not explicitly defined in the schema, surfacing typos and invalid fields as parse errors before the handler runs:

```typescript
// Before (line ~260):
inputSchema: z.object({
    mode: z.enum(['query', 'loadDiff', 'apply', 'reapply', 'restore', 'history']),
    // ... all fields ...
})

// After:
inputSchema: z.object({
    mode: z.enum(['query', 'loadDiff', 'apply', 'reapply', 'restore', 'history']),
    // ... all fields ...
}).strict()
```

This is a one-line change (append `.strict()` to the closing `)`). No other modifications needed.

**Acceptance Criteria:**
- [ ] `z.object({...}).strict()` is used for the `refactor_batch` inputSchema
- [ ] Unknown keys in the input cause a Zod validation error (not silent stripping)
- [ ] All valid mode/key combinations still parse successfully
- [ ] `tsc --noEmit` passes
- [ ] Existing refactor_batch tests pass

**What Complete Looks Like:**
The refactor_batch tool rejects malformed inputs at the schema level. Typos in field names produce immediate, clear errors instead of silently proceeding with missing data.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

> **BEFORE PROCEEDING TO WAVE 2:**
> Spawn a review subagent to independently verify all 9 Wave 1 tasks. The reviewer should read each modified file and confirm: the fix addresses the issue completely, TypeScript accepts the code, behavior is correct, and no regressions are introduced.

---

## Wave 2: Search Tool Fixes (depend on shared.ts contract)

> **PARALLEL EXECUTION:** Both tasks in this wave run simultaneously.
>
> **Dependencies:** Wave 1 must complete — both tools call `ripgrepSearch()` from `shared.ts`, which was modified in Task 1.1. The proc.kill behavior and context line capping changes the contract that these tools rely on.
> **File Safety:** search_files.ts · search_file.ts — one task per file ✓

---

### Task 2.1: Fix `search_files.ts` — ripgrep null error propagation + getDefaultExcludes caching in walk functions

**Files:**
- Modify: `packages/zenith-mcp/src/tools/search_files.ts`

**Codebase References:**
- Content mode ripgrep path: `search_files.ts:596-675` — two `ripgrepSearch` calls (lines 619, 637)
- First call (BM25 pre-filtered): line 619 — if returns `null`, falls through to second call
- Second call (full search): line 637 — if returns `null`, falls through to JS fallback
- JS fallback: lines 677-730 — `contentRegex` is `null` for non-literal searches (line 575), so `grepFile` at line 683 returns immediately (`!contentRegex` check)
- Result: invalid regex causes ripgrep to fail → `null` → JS fallback can't handle regex → 0 results → "No matches."
- `getDefaultExcludes()` hot-loop calls: lines 100, 367, 512 — inside walk function per-entry checks
- Line 67: `const defaultExcludeGlobs = getDefaultExcludes().map(...)` — already computed once for ripgrep globs

**Implementation Details:**

**Fix A — Propagate ripgrep errors for regex searches (after line 647):**

After both ripgrep attempts, if `rgResults` is still `null` and this is a regex (non-literal) search, the error must surface. The JS fallback cannot handle regex and will silently produce empty results.

```typescript
// After the second ripgrepSearch call (after line 647):
if (rgResults === null && !args.literalSearch) {
    throw new Error('Regex search failed — ripgrep returned an error. Verify the pattern is valid regex, or use literalSearch: true for literal matching.');
}
// The JS fallback continues only for literal search when ripgrep is unavailable or failed
```

**Fix B — Cache `getDefaultExcludes()` for walk functions:**

The walk functions at lines 93-120, 358-390, and 503-540 each call `getDefaultExcludes()` inside their per-entry loop. With Task 1.1's caching in shared.ts, the function now returns a cached array, but it's still a function call per entry. For maximum efficiency and explicitness, cache locally:

```typescript
// Near the top of the handler (around line 67), after defaultExcludeGlobs:
const defaultExcludes = getDefaultExcludes(); // single call, cached locally
const defaultExcludeGlobs = defaultExcludes.map(p => `**/${p}/**`);

// In each walk function, replace:
//   if (getDefaultExcludes().some(p => entry.name === p))
// with:
//   if (defaultExcludes.some(p => entry.name === p))
```

Apply this replacement at all three walk function locations (lines 100, 367, 512).

**Acceptance Criteria:**
- [ ] When ripgrep fails (returns `null`) on a non-literal search, an error is thrown with a clear message
- [ ] Literal searches still fall through to the JS fallback when ripgrep fails
- [ ] All three walk functions use the locally cached `defaultExcludes` array
- [ ] `getDefaultExcludes()` is called exactly once per handler invocation
- [ ] `tsc --noEmit` passes
- [ ] Existing tests pass

**What Complete Looks Like:**
Regex search errors are surfaced to the caller instead of silently becoming "No matches." Walk functions reference a single cached array. The `defaultExcludeGlobs` computation derives from the same cached array.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

### Task 2.2: Fix `search_file.ts` — ripgrep null vs empty distinction + separator budget check

**Files:**
- Modify: `packages/zenith-mcp/src/tools/search_file.ts`

**Codebase References:**
- Bug at line 41: `if (!rgResults || rgResults.length === 0)` — conflates `null` (error) with `[]` (no matches)
- `ripgrepSearch` contract: returns `null` on exit code > 1 or spawn error; `[]` on zero matches
- Separator budget issue at lines 52-54: `---` (3 chars) is inserted and counted as `charCount += 4` before checking if the next line fits. Output can end with a dangling `---` separator.
- Output budget: `maxChars` from line 22

**Implementation Details:**

**Fix A — Distinguish null from empty (line 41):**

```typescript
// Before (lines 41-43):
if (!rgResults || rgResults.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No matches.' }] };
}

// After:
if (rgResults === null) {
    throw new Error('Search failed — check that the grep pattern is valid regex.');
}
if (rgResults.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No matches.' }] };
}
```

When ripgrep exits with code > 1 (invalid regex, binary file error), the error surfaces immediately. The caller sees a clear error instead of a misleading "No matches."

**Fix B — Fix separator budget check (lines 52-54):**

The current code pushes `---` and adds 4 to `charCount` before checking the next line. This can:
1. Push total output past `maxChars` by up to 4 bytes
2. Leave a dangling `---` at the end (the next line fails the budget check, so output ends with the separator)

Check whether the separator PLUS the next formatted line fit before inserting:

```typescript
// Before (lines 51-60):
let prevLine = -1;
for (const result of rgResults) {
    if (prevLine !== -1 && result.line > prevLine + 1) {
        outputLines.push('---');
        charCount += 4;
    }
    const marker = result.isContext ? '' : '*';
    const formatted = `${result.line}:${marker}${result.content}`;
    if (charCount + formatted.length + 1 > maxChars) break;
    outputLines.push(formatted);
    charCount += formatted.length + 1;
    prevLine = result.line;
}

// After:
let prevLine = -1;
for (const result of rgResults) {
    const marker = result.isContext ? '' : '*';
    const formatted = `${result.line}:${marker}${result.content}`;
    const needsSeparator = prevLine !== -1 && result.line > prevLine + 1;
    const separatorCost = needsSeparator ? 4 : 0; // '---' + newline
    if (charCount + separatorCost + formatted.length + 1 > maxChars) break;
    if (needsSeparator) {
        outputLines.push('---');
        charCount += 4;
    }
    outputLines.push(formatted);
    charCount += formatted.length + 1;
    prevLine = result.line;
}
```

The separator is only inserted if both it AND the next line fit within budget. No dangling separators, no budget overruns.

**Acceptance Criteria:**
- [ ] `ripgrepSearch` returning `null` throws an error (not "No matches")
- [ ] `ripgrepSearch` returning `[]` returns "No matches." (unchanged)
- [ ] Separator `---` is only inserted when the separator + next line fit within `maxChars`
- [ ] Output never ends with a dangling `---`
- [ ] Output never exceeds `maxChars`
- [ ] `tsc --noEmit` passes
- [ ] Existing tests pass

**What Complete Looks Like:**
The null/empty distinction makes invalid regex errors visible. The separator is budget-aware — it is emitted only when both the separator and the subsequent content line fit within the remaining budget.

**Verification:**
```bash
cd /home/tanner/Projects/Zenith-Cleanup && npm run build && npm test
```

---

> **BEFORE REPORTING COMPLETE:**
> Spawn a final review subagent to independently verify all Wave 2 tasks plus run the full verification suite.

---

## Final Verification

After all waves complete:

```bash
cd /home/tanner/Projects/Zenith-Cleanup

# 1. Full build
npm run build

# 2. Full test suite — all 721+ tests must pass
npm test

# 3. TypeScript check
cd packages/zenith-mcp && npx tsc --noEmit

# 4. Verify behavioral fixes
echo "=== Verify: getDefaultExcludes caching ==="
grep -n "getDefaultExcludes()" packages/zenith-mcp/src/tools/directory.ts
# Expected: only the import + one cached call at top, NOT inside any loop

echo "=== Verify: isSensitive in directory ==="
grep -n "isSensitive" packages/zenith-mcp/src/tools/directory.ts
# Expected: import + usage in both list and tree modes

echo "=== Verify: proc.kill in ripgrepSearch ==="
grep -n "proc.kill" packages/zenith-mcp/src/core/shared.ts
# Expected: at least one proc.kill('SIGTERM') call

echo "=== Verify: ENOENT in write_file ==="
grep -n "ENOENT" packages/zenith-mcp/src/tools/write_file.ts
# Expected: catch block checks for ENOENT code

echo "=== Verify: error messages sanitized ==="
grep -n "_allowedDirectories.join" packages/zenith-mcp/src/core/lib.ts
# Expected: only in console.error, NOT in thrown Error messages

echo "=== Verify: shouldIndexFile in ensureIndexFresh ==="
grep -n "shouldIndexFile" packages/zenith-mcp/src/core/symbol-index.ts
# Expected: called in ensureIndexFresh (in addition to indexFile and indexDirectory)

echo "=== Verify: null check before 'No matches' ==="
grep -n "rgResults === null" packages/zenith-mcp/src/tools/search_file.ts
# Expected: explicit null check with error throw

echo "=== Verify: clampToAllowed null return ==="
grep -n "if (!candidate)" packages/zenith-mcp/src/utils/project-scope.ts
# Expected: returns null, NOT allowedRoot

echo "=== Verify: refactor_batch strict schema ==="
grep -n "\.strict()" packages/zenith-mcp/src/tools/refactor_batch.ts
# Expected: .strict() on the inputSchema z.object

echo "=== Verify: no readdirSync in project-scope marker detection ==="
grep -n "readdirSync" packages/zenith-mcp/src/utils/project-scope.ts
# Expected: no matches (replaced with existsSync)

echo "=== Verify: offsetReadFile early exit ==="
grep -n "rl.close\|break" packages/zenith-mcp/src/core/lib.ts | grep -i "offset\|collected"
# Expected: early exit when collected.length >= length
```

**Expected:** All tests pass. All grep verifications confirm the structural changes. No regressions.

---

## Issue-to-Task Mapping

| # | Issue | Task |
|---|-------|------|
| 1 | search_file.ts: ripgrep errors as "No matches" | Task 2.2 Fix A |
| 2 | search_files.ts: regex search silently fails | Task 2.1 Fix A |
| 3 | write_file.ts: fs.stat swallows EACCES/EPERM | Task 1.6 |
| 4 | directory.ts: list mode missing default excludes | Task 1.8 Fix C |
| 5 | project-scope.ts: clampToAllowed returns allowedRoot for null | Task 1.5 Fix A |
| 6 | symbol-index.ts: ensureIndexFresh skips shouldIndexFile | Task 1.7 |
| 7 | directory.ts: wildcard patterns miss nested paths | Task 1.8 Fix C,D |
| 8 | shared.ts: ripgrepSearch never kills process | Task 1.1 Fix A |
| 9 | shared.ts: context lines bypass maxResults cap | Task 1.1 Fix B |
| 10 | directory.ts: missing isSensitive filter | Task 1.8 Fix C,D |
| 11 | path-validation.ts: root dir "/" breaks check | Task 1.3 |
| 12 | roots-utils.ts: ~ stripped from file:~/repo | Task 1.4 |
| 13 | lib.ts: tailFile reads entire file | Task 1.2 Fix A |
| 14 | lib.ts: validateNewFilePath leaks allowlist | Task 1.2 Fix C |
| 15 | directory.ts + search_files.ts: getDefaultExcludes per-entry | Task 1.1 Fix D + Task 1.8 Fix B,D + Task 2.1 Fix B |
| 16 | search_file.ts: separator exceeds char budget | Task 2.2 Fix B |
| 17 | shared.ts: search_char_budget no bounds validation | Task 1.1 Fix C |
| 18 | lib.ts: hasMore true when length <= 0 | Task 1.2 Fix B |
| 19 | project-scope.ts: cache key sort vs iteration order | Task 1.5 Fix B |
| 20 | refactor_batch.ts: Zod schema silently strips unknown keys | Task 1.9 |
| 21 | project-scope.ts: readdirSync+Set slower than existsSync per marker | Task 1.5 Fix C |
| 22 | lib.ts: offsetReadFile reads entire file after collecting enough lines | Task 1.2 Fix B |
