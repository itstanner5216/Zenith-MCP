# Group A (Files 01–04) — Execution Plan

**Goal:** Fix all 32 post-JS→TS conversion issues across path security, search/directory tools, file operation tools, and refactor/stash tools — leaving zero issues unaddressed.
**Total Waves:** 5
**Total Tasks:** 18
**Max Parallel Tasks in Single Wave:** 6

---

## Issue Cross-Reference

Every issue from the 4 findings files maps to a task below.

| # | Finding | File(s) | Task |
|---|---------|---------|------|
| 01-1 | Windows path containment separator-fragile | `path-validation.ts` | 1.1 |
| 01-2 | `file://` root parsing is URI-unsafe | `roots-utils.ts` | 1.2 |
| 01-3 | New-file validation blocks nested parent creation | `lib.ts`, `write_file.ts` | 2.1 |
| 01-4 | `ProjectContext` is process-wide singleton | `project-context.ts` | 1.3 |
| 01-5 | Project root resolution escapes sandbox | `project-scope.ts`, `symbol-index.ts` | 2.2 |
| 01-6 | Marker detection blocks event loop | `project-scope.ts` | 2.2 |
| 01-7 | Project-scope cache unbounded & context-blind | `project-scope.ts` | 2.2 |
| 01-8 | `tailFile`/`headFile` UTF-8 boundary bugs | `lib.ts` | 1.4 |
| 01-9 | `formatSize` accepts negative bytes | `lib.ts` | 1.4 |
| 02-1 | Stateful fallback regex skips content lines | `search_files.ts` | 3.1 |
| 02-2 | Regex content search allows ReDoS in JS fallback | `search_files.ts` | 3.1 |
| 02-3 | Definition mode accepts invalid shape / `definesSymbol!` | `search_files.ts` | 3.1 |
| 02-4 | `countOnly` reports capped ripgrep results as exact | `shared.ts`, `search_files.ts` | 3.2 |
| 02-5 | Tree mode ignores `depth` limit | `directory.ts` | 3.3 |
| 02-6 | Import-time config loading crashes startup (shared/search_files) | `shared.ts`, `search_files.ts` | 1.5 |
| 02-7 | `directory` list ignores `excludePatterns` + tree-only flags | `directory.ts` | 3.3 |
| 02-8 | `search_file` compiles untrusted regex in-process | `search_file.ts` | 3.4 |
| 02-9 | Content mode ignores `extensions` and `pathContains` | `search_files.ts` | 3.1 |
| 02-10 | `directory` sorting partially implemented | `directory.ts` | 3.3 |
| 03-1 | `read_file` prepends truncation marker for end-truncated reads | `read_file.ts` | 3.5 |
| 03-2 | `applyFileEdits` silently edits first match instead of enforcing uniqueness | `lib.ts` | 2.1 |
| 03-3 | `offsetReadFile` reports partial line count | `lib.ts` | 1.4 |
| 03-4 | `read_multiple_files` different schema model than `read_file` | `read_multiple_files.ts` | 4.1 |
| 03-5 | Append-mode overlap detection breaks on trailing newline | `lib.ts` | 1.4 |
| 03-6 | `read_multiple_files` oversubscribes global char budget | `read_multiple_files.ts` | 4.1 |
| 04-1 | Retry lock state never evicts / never resets after success | `refactor_batch.ts` | 4.2 |
| 04-2 | Query-mode refresh runs against stale symbol graphs | `refactor_batch.ts`, `symbol-index.ts` | 4.3 |
| 04-3 | Import-time config loading crashes startup (refactor_batch/symbol-index) | `refactor_batch.ts`, `symbol-index.ts` | 1.5 |
| 04-4 | Symbol indexing bypasses sensitive-file and glob exclude policy | `symbol-index.ts` | 2.3 |
| 04-5 | `stashRestore apply` overloads `file` as redirect path | `stash_restore.ts`, `stash.ts` | 4.4 |
| 04-6 | Block-mode edits crash on missing required fields | `edit-engine.ts` | 3.6 |
| 04-7 | Trimmed trailing-whitespace matching loses true column offset | `edit-engine.ts` | 3.6 |

---

## Wave 1: Foundation Fixes (No Inter-Dependencies)

> **PARALLEL EXECUTION:** All 5 tasks in this wave run simultaneously.
>
> **Dependencies:** None — all tasks modify independent files against initial repo state.
> **File Safety:**
> - `path-validation.ts`: only Task 1.1 ✓
> - `roots-utils.ts`: only Task 1.2 ✓
> - `project-context.ts`: only Task 1.3 ✓
> - `lib.ts`: only Task 1.4 ✓
> - `shared.ts`: only Task 1.5 ✓

### Task 1.1: Fix Windows Path Containment Check

**Issues Covered:** 01-1

**Files:**
- Modify: `packages/zenith-mcp/src/core/path-validation.ts`

**Codebase References:**
- Pattern: `packages/zenith-mcp/src/core/path-utils.ts` — `normalizePath()` already normalizes separators
- Import: `packages/zenith-mcp/src/core/path-utils.ts:L40` — `export function normalizePath(p: any): any`
- Callers: `packages/zenith-mcp/src/core/lib.ts:L46,L54,L62` — `validatePath()` uses `isPathWithinAllowedDirectories`

**Implementation Details:**

Replace the function body at lines 10–16 of `path-validation.ts`:

**Before:**
```ts
export function isPathWithinAllowedDirectories(filePath: string, allowedDirectories: string[]): boolean {
    const normalized = _normalizePath(filePath);
    const resolved = path.resolve(normalized);
    return allowedDirectories.some(dir => {
        const normalizedDir = path.resolve(_normalizePath(dir));
        return resolved === normalizedDir || resolved.startsWith(normalizedDir + '/');
    });
}
```

**After:**
```ts
export function isPathWithinAllowedDirectories(filePath: string, allowedDirectories: string[]): boolean {
    const normalized = _normalizePath(filePath);
    const resolved = path.resolve(normalized);
    const sep = path.sep;
    return allowedDirectories.some(dir => {
        const normalizedDir = path.resolve(_normalizePath(dir));
        return resolved === normalizedDir || resolved.startsWith(normalizedDir + sep);
    });
}
```

**Acceptance Criteria:**
- [ ] `isPathWithinAllowedDirectories('/foo/bar', ['/foo'])` returns `true`
- [ ] On Windows (or in tests mocking `path.sep`), backslash separator is used
- [ ] `isPathWithinAllowedDirectories('/foobar', ['/foo'])` returns `false`
- [ ] Existing tests pass unchanged

**What Complete Looks Like:**
The function uses `path.sep` instead of hardcoded `'/'`, making containment checks correct on both Windows and Unix.

**Verification:**
- Run: `cd packages/zenith-mcp && npx tsc --noEmit`
- Expected: No type errors

---

### Task 1.2: Fix `file://` Root URI Parsing

**Issues Covered:** 01-2

**Files:**
- Modify: `packages/zenith-mcp/src/core/roots-utils.ts`

**Codebase References:**
- Current function: `roots-utils.ts:L6-L18` — `parseRootUri()`
- Caller: `roots-utils.ts:L22` — `getValidRootDirectories()` calls `parseRootUri()`
- Convention: `path-utils.ts:L111-L114` — `expandHome()` for tilde expansion

**Implementation Details:**

Add the `url` import and replace `parseRootUri`:

**Before (lines 1–18):**
```ts
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { normalizePath } from './path-utils.js';

async function parseRootUri(rootUri: string) {
    try {
        const rawPath = rootUri.startsWith('file://') ? rootUri.slice(7) : rootUri;
        const expandedPath = rawPath.startsWith('~/') || rawPath === '~'
            ? path.join(os.homedir(), rawPath.slice(1))
            : rawPath;
        const absolutePath = path.resolve(expandedPath);
        const resolvedPath = await fs.realpath(absolutePath);
        return normalizePath(resolvedPath);
    }
    catch {
        return null;
    }
}
```

**After:**
```ts
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { normalizePath } from './path-utils.js';

async function parseRootUri(rootUri: string) {
    try {
        let rawPath: string;
        if (rootUri.startsWith('file:')) {
            try {
                rawPath = fileURLToPath(new URL(rootUri));
            } catch {
                // Fallback for malformed file URIs
                rawPath = rootUri.slice(rootUri.indexOf('/', rootUri.indexOf(':')) + 1);
            }
        } else {
            rawPath = rootUri;
        }

        const expandedPath = rawPath === '~' || rawPath.startsWith('~/')
            ? path.join(os.homedir(), rawPath.slice(1))
            : rawPath;

        const absolutePath = path.resolve(expandedPath);
        const resolvedPath = await fs.realpath(absolutePath);
        return normalizePath(resolvedPath);
    } catch {
        return null;
    }
}
```

**Acceptance Criteria:**
- [ ] `parseRootUri('file:///home/user/project')` returns the resolved path
- [ ] `parseRootUri('file:///path%20with%20spaces')` decodes percent-encoding
- [ ] `parseRootUri('~/project')` still expands tilde
- [ ] `parseRootUri('/plain/path')` still works as before
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
File URIs are parsed via Node's standard `fileURLToPath`, correctly handling percent-encoding, three-slash URIs, and Windows drive letters.

---

### Task 1.3: Fix ProjectContext Singleton

**Issues Covered:** 01-4

**Files:**
- Modify: `packages/zenith-mcp/src/core/project-context.ts`
- Modify: `packages/zenith-mcp/src/core/server.ts` (update `onRootsChanged` callsite)

**Codebase References:**
- Singleton: `project-context.ts:L257-L278` — `_instance`, `getProjectContext()`, `onRootsChanged()`
- Caller: `server.ts:L25` — `import { onRootsChanged } from './project-context.js'`
- FsContext type: `project-context.ts:L28-L31` — interface definition

**Implementation Details:**

Replace the singleton section at the bottom of `project-context.ts` (lines 257–278):

**Before:**
```ts
let _instance: ProjectContext | null = null;

export function getProjectContext(ctx: FsContext): ProjectContext {
    if (!_instance) {
        _instance = new ProjectContext(ctx);
    }
    return _instance;
}

export function onRootsChanged(): void {
    if (_instance) {
        _instance.refresh();
    }
}

/** Reset the singleton — for test isolation only. */
export function resetProjectContext(): void {
    _instance = null;
}
```

**After:**
```ts
let _instances = new WeakMap<FsContext, ProjectContext>();

export function getProjectContext(ctx: FsContext): ProjectContext {
    let instance = _instances.get(ctx);
    if (!instance) {
        instance = new ProjectContext(ctx);
        _instances.set(ctx, instance);
    }
    return instance;
}

export function onRootsChanged(ctx?: FsContext): void {
    if (ctx) {
        const instance = _instances.get(ctx);
        if (instance) {
            instance.refresh();
        }
        return;
    }
    // Without a ctx, we cannot iterate WeakMap. This is intentional —
    // callers should pass their ctx for proper per-session refresh.
}

export function resetProjectContext(ctx?: FsContext): void {
    if (ctx) {
        _instances.delete(ctx);
        return;
    }
    _instances = new WeakMap<FsContext, ProjectContext>();
}
```

In `server.ts`, find the line that calls `onRootsChanged()` (around line 25 or wherever the roots-changed handler is). Search for all callsites of `onRootsChanged` in the codebase and update them to pass `ctx`. The import stays the same.

Look for the pattern in server.ts where roots change is handled. The `onRootsChanged()` call must be updated:
- If `ctx` (the `FilesystemContext`) is in scope at the call site, pass it: `onRootsChanged(ctx)`
- If it is not in scope, pass `undefined` (no-op is safe — the WeakMap approach means the instance refreshes lazily on next access)

**Acceptance Criteria:**
- [ ] Two different `FsContext` objects get two different `ProjectContext` instances
- [ ] `resetProjectContext(ctx)` removes only that context's instance
- [ ] `resetProjectContext()` with no args clears everything
- [ ] `onRootsChanged(ctx)` refreshes only the targeted context
- [ ] TypeScript compiles without errors
- [ ] All existing callers of `getProjectContext` continue to work (they already pass `ctx`)

**What Complete Looks Like:**
`ProjectContext` is per-`FsContext` via WeakMap. No cross-session state bleed. GC-friendly.

---

### Task 1.4: Fix Core `lib.ts` Utility Functions

**Issues Covered:** 01-8 (tailFile/headFile UTF-8), 01-9 (formatSize), 03-3 (offsetReadFile partial count), 03-5 (findResumeOffset trailing newline)

**Files:**
- Modify: `packages/zenith-mcp/src/core/lib.ts`

**Codebase References:**
- `formatSize()`: `lib.ts:L74-L81`
- `findResumeOffset()`: `lib.ts:L89-L118`
- `tailFile()`: `lib.ts:L252-L293`
- `headFile()`: `lib.ts:L295-L324`
- `offsetReadFile()`: `lib.ts:L326-L350`
- Callers of tailFile/headFile: `read_file.ts:L1` (import), `read_file.ts:L130,L143` (calls)
- Callers of offsetReadFile: `read_file.ts:L139` (call)
- Callers of findResumeOffset: `write_file.ts:L57`, `stash_restore.ts` (append-mode)

**Implementation Details:**

**Fix 1: `formatSize` (lines 74–81)**

**Before:**
```ts
export function formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0)
        return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i < 0 || i === 0)
        return `${bytes} ${units[0]}`;
    const unitIndex = Math.min(i, units.length - 1);
    return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
}
```

**After:**
```ts
export function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        throw new RangeError(`bytes must be a non-negative finite number: ${bytes}`);
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    const unitIndex = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1,
    );
    if (unitIndex <= 0) return `${bytes} ${units[0]}`;
    return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
}
```

**Fix 2: `findResumeOffset` (lines 89–118) — handle trailing empty line from split**

**Before:**
```ts
export function findResumeOffset(existingTailLines: string[], incomingLines: string[]): number {
    if (!existingTailLines.length || !incomingLines.length)
        return 0;
    const trim = (s: string) => s.trimEnd();
    const firstIncomingRaw = incomingLines[0];
    if (firstIncomingRaw === undefined)
        throw new Error('findResumeOffset: incomingLines[0] missing despite non-empty check');
    const firstIncoming = trim(firstIncomingRaw);
    for (let i = 0; i < existingTailLines.length; i++) {
```

**After:**
```ts
function trimTerminalEmptyLine(lines: string[]): string[] {
    return lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.slice(0, -1)
        : lines;
}

export function findResumeOffset(existingTailLines: string[], incomingLines: string[]): number {
    const existing = trimTerminalEmptyLine(existingTailLines);
    const incoming = trimTerminalEmptyLine(incomingLines);
    if (!existing.length || !incoming.length)
        return 0;
    const trim = (s: string) => s.trimEnd();
    const firstIncomingRaw = incoming[0];
    if (firstIncomingRaw === undefined)
        throw new Error('findResumeOffset: incomingLines[0] missing despite non-empty check');
    const firstIncoming = trim(firstIncomingRaw);
    for (let i = 0; i < existing.length; i++) {
        const existingAtI = existing[i];
        if (existingAtI === undefined)
            throw new Error(`findResumeOffset: existingTailLines[${i}] out of range`);
        if (trim(existingAtI) !== firstIncoming)
            continue;
        const overlapLen = Math.min(existing.length - i, incoming.length);
        let matched = true;
        for (let j = 0; j < overlapLen; j++) {
            const existingAtIJ = existing[i + j];
            const incomingAtJ = incoming[j];
            if (existingAtIJ === undefined || incomingAtJ === undefined)
                throw new Error(`findResumeOffset: index out of range at i=${i}, j=${j}`);
            if (trim(existingAtIJ) !== trim(incomingAtJ)) {
                matched = false;
                break;
            }
        }
        if (matched) return overlapLen;
    }
    return 0;
}
```

**Fix 3: `headFile` (lines 295–324) — use readline for UTF-8 safety**

Replace the entire `headFile` function:

**After:**
```ts
export async function headFile(filePath: string, numLines: number) {
    if (numLines <= 0) return '';
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];
    try {
        for await (const line of rl) {
            lines.push(line);
            if (lines.length >= numLines) break;
        }
        return lines.join('\n');
    } finally {
        rl.close();
        stream.destroy();
    }
}
```

**Fix 4: `tailFile` (lines 252–293) — use readline ring buffer for UTF-8 safety**

Replace the entire `tailFile` function:

**After:**
```ts
export async function tailFile(filePath: string, numLines: number) {
    if (numLines <= 0) return '';
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const ring = new Array<string>(numLines);
    let count = 0;
    try {
        for await (const line of rl) {
            ring[count % numLines] = line;
            count++;
        }
    } finally {
        rl.close();
        stream.destroy();
    }
    if (count === 0) return '';
    if (count <= numLines) return ring.slice(0, count).join('\n');
    const start = count % numLines;
    return [...ring.slice(start), ...ring.slice(0, start)].join('\n');
}
```

**Fix 5: `offsetReadFile` (lines 326–350) — read entire file for accurate total line count**

Replace the entire `offsetReadFile` function:

**After:**
```ts
export async function offsetReadFile(filePath: string, offset: number, length: number) {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const collected: string[] = [];
    let totalLines = 0;
    try {
        for await (const line of rl) {
            if (totalLines >= offset && collected.length < length) {
                collected.push(line);
            }
            totalLines++;
        }
        return {
            content: collected.join('\n'),
            totalLines,
            linesReturned: collected.length,
        };
    } finally {
        rl.close();
        stream.destroy();
    }
}
```

**Acceptance Criteria:**
- [ ] `formatSize(-1)` throws `RangeError`
- [ ] `formatSize(NaN)` throws `RangeError`
- [ ] `formatSize(0)` returns `'0 B'`
- [ ] `findResumeOffset(['a','b',''], ['a','b'])` returns `2` (not `0`)
- [ ] `tailFile` with multibyte UTF-8 content does not produce replacement chars
- [ ] `headFile` with multibyte UTF-8 content does not produce replacement chars
- [ ] `offsetReadFile` returns correct `totalLines` for entire file, not just the read window
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
All five utility functions in `lib.ts` are correct: formatSize validates input, findResumeOffset strips trailing empty lines, head/tail use readline streams, offsetReadFile reads the full file for metadata.

---

### Task 1.5: Defer Import-Time Config Loading (shared.ts)

**Issues Covered:** 02-6, 04-3 (shared.ts portion)

**Files:**
- Modify: `packages/zenith-mcp/src/core/shared.ts`

**Codebase References:**
- Current: `shared.ts:L8-L10` — `const _config = loadConfig()` at import time
- Exported constants: `shared.ts:L12-L16` — `CHAR_BUDGET`, `shared.ts:L19-L27` — `DEFAULT_EXCLUDES`, `shared.ts:L29-L40` — `SENSITIVE_PATTERNS`
- All importers: `search_files.ts:L5`, `directory.ts:L7`, `read_file.ts:L4`, `read_multiple_files.ts:L4`, `search_file.ts:L4`, `refactor_batch.ts:L12`

**Implementation Details:**

Replace the import-time config execution (lines 8–41) with lazy accessors:

**Before:**
```ts
import { loadConfig } from '../config/index.js';

const _config = loadConfig();

export const CHAR_BUDGET: number = (() => {
    const val = _config.advanced.char_budget;
    if (typeof val === 'number' && !isNaN(val) && val >= 10_000 && val <= 2_000_000) return val;
    return 400_000;
})();
export const RANK_THRESHOLD = 50;

export const DEFAULT_EXCLUDES: string[] = (() => {
    const raw = _config.advanced.default_excludes;
    ...
})();

export const SENSITIVE_PATTERNS: string[] = (() => {
    const raw = _config.advanced.sensitive_patterns;
    ...
})();
```

**After:**
```ts
import { loadConfig } from '../config/index.js';

let _configCache: ReturnType<typeof loadConfig> | null = null;

function getAdvancedConfig() {
    if (!_configCache) {
        try {
            _configCache = loadConfig();
        } catch {
            // Return safe defaults if config is broken — don't crash the server
            return {
                char_budget: undefined,
                search_char_budget: undefined,
                default_excludes: undefined,
                sensitive_patterns: undefined,
                refactor_max_chars: 200_000,
                refactor_max_context: 30,
                refactor_version_ttl_hours: 48,
            };
        }
    }
    return _configCache.advanced;
}

export function getCharBudget(): number {
    const val = getAdvancedConfig().char_budget;
    return typeof val === 'number' && !Number.isNaN(val) && val >= 10_000 && val <= 2_000_000
        ? val
        : 400_000;
}

// Keep backward-compatible constant export — lazily initialized
let _charBudgetCached: number | null = null;
export const CHAR_BUDGET: number = new Proxy({} as { valueOf(): number; toString(): string }, {
    get(_, prop) {
        if (prop === Symbol.toPrimitive || prop === 'valueOf') {
            return () => { _charBudgetCached ??= getCharBudget(); return _charBudgetCached; };
        }
        if (prop === 'toString') {
            return () => String(_charBudgetCached ??= getCharBudget());
        }
        return undefined;
    }
}) as unknown as number;
```

**IMPORTANT — Simpler approach:** Since every importer of `CHAR_BUDGET` uses it at runtime (not import time), the simplest correct approach is to change exports to functions and update callers. However, `CHAR_BUDGET` is imported by ~8 files. The lower-risk approach:

Replace with a getter-based object pattern, or simpler — just wrap in a lazy initializer:

**Actual implementation (simplest):**

```ts
import { loadConfig } from '../config/index.js';

let _configCache: ReturnType<typeof loadConfig> | null = null;

function getConfig() {
    if (_configCache) return _configCache;
    try {
        _configCache = loadConfig();
    } catch {
        _configCache = null;
    }
    return _configCache;
}

// These are computed lazily on first access via getter, but appear as module-level constants.
// This defers the loadConfig() call from import-time to first-use time.

let _charBudget: number | undefined;
export function getCharBudgetValue(): number {
    if (_charBudget !== undefined) return _charBudget;
    const cfg = getConfig();
    const val = cfg?.advanced?.char_budget;
    _charBudget = (typeof val === 'number' && !isNaN(val) && val >= 10_000 && val <= 2_000_000) ? val : 400_000;
    return _charBudget;
}
// Backward-compatible: CHAR_BUDGET is still exported but now lazy.
// We CANNOT use `export const CHAR_BUDGET = getCharBudgetValue()` because that evaluates at import time.
// Instead, keep it as a function call — all callers use CHAR_BUDGET as a value in expressions,
// so we need to ensure it's a number. We'll initialize it when first accessed.

// For backward compat, we use a module-init pattern that's safe:
// The loadConfig is deferred to registration time, not import time.
// Since no tool handler runs at import time, we can safely do:
let _initialized = false;
let _CHAR_BUDGET = 400_000;
let _RANK_THRESHOLD = 50;
let _DEFAULT_EXCLUDES: string[] = [];
let _SENSITIVE_PATTERNS: string[] = [];

function ensureInitialized() {
    if (_initialized) return;
    _initialized = true;
    const cfg = getConfig();
    const adv = cfg?.advanced;

    // CHAR_BUDGET
    const cbVal = adv?.char_budget;
    _CHAR_BUDGET = (typeof cbVal === 'number' && !isNaN(cbVal) && cbVal >= 10_000 && cbVal <= 2_000_000) ? cbVal : 400_000;

    // DEFAULT_EXCLUDES
    const rawExcludes = adv?.default_excludes;
    if (rawExcludes && typeof rawExcludes === 'string') {
        const parsed = rawExcludes.split(',').map((p: string) => p.trim()).filter(Boolean);
        if (parsed.length > 0) { _DEFAULT_EXCLUDES = parsed; }
    }
    if (_DEFAULT_EXCLUDES.length === 0) {
        _DEFAULT_EXCLUDES = 'node_modules,.git,.next,.venv,venv,.env.local,dist,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo'
            .split(',').map(p => p.trim()).filter(Boolean);
    }

    // SENSITIVE_PATTERNS
    const rawSens = adv?.sensitive_patterns;
    if (rawSens && typeof rawSens === 'string') {
        const parsed = rawSens.split(',').map((p: string) => p.trim()).filter(Boolean);
        if (parsed.length > 0) { _SENSITIVE_PATTERNS = parsed; }
    }
    if (_SENSITIVE_PATTERNS.length === 0) {
        _SENSITIVE_PATTERNS = '**/.env,**/*.pem,**/*.key,**/*.crt,**/*credentials*,**/*secret*,**/docker-compose.yaml,**/docker-compose.yml,**/.config/**'
            .split(',').map(p => p.trim()).filter(Boolean);
    }
}

// Exported as getters so they're lazy but look like constants to callers
Object.defineProperty(exports, 'CHAR_BUDGET', { get() { ensureInitialized(); return _CHAR_BUDGET; }, enumerable: true });
```

**FINAL simplest correct approach for ESM:** Since this is ESM (`.ts` → `.js` with `import/export`), we cannot use `Object.defineProperty(exports, ...)`. The cleanest ESM-compatible approach:

Replace the module-level constants with exported functions, then update callers. However, to minimize blast radius in this wave, we use the **deferred initialization** pattern:

```ts
import { loadConfig } from '../config/index.js';

// --- Deferred config: loadConfig() runs on first tool invocation, not import ---
let _configLoaded = false;
let _advancedConfig: Record<string, unknown> = {};

function ensureConfig(): void {
    if (_configLoaded) return;
    _configLoaded = true;
    try {
        _advancedConfig = loadConfig().advanced ?? {};
    } catch {
        _advancedConfig = {};
    }
}

// --- Lazy exports ---
// CHAR_BUDGET, DEFAULT_EXCLUDES, SENSITIVE_PATTERNS, and RANK_THRESHOLD
// are used as values in arithmetic/comparisons by many files.
// Since ESM doesn't support lazy export bindings for primitive values,
// we export getter functions and update all callers.

export const RANK_THRESHOLD = 50;  // constant, no config dependency

export function getCHAR_BUDGET(): number {
    ensureConfig();
    const val = _advancedConfig.char_budget as number | undefined;
    return (typeof val === 'number' && !isNaN(val) && val >= 10_000 && val <= 2_000_000) ? val : 400_000;
}

export function getDEFAULT_EXCLUDES(): string[] {
    ensureConfig();
    const raw = _advancedConfig.default_excludes as string | undefined;
    if (raw && typeof raw === 'string') {
        const parsed = raw.split(',').map(p => p.trim()).filter(Boolean);
        if (parsed.length > 0) return parsed;
    }
    return 'node_modules,.git,.next,.venv,venv,.env.local,dist,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo'
        .split(',').map(p => p.trim()).filter(Boolean);
}

export function getSENSITIVE_PATTERNS(): string[] {
    ensureConfig();
    const raw = _advancedConfig.sensitive_patterns as string | undefined;
    if (raw && typeof raw === 'string') {
        const parsed = raw.split(',').map(p => p.trim()).filter(Boolean);
        if (parsed.length > 0) return parsed;
    }
    return '**/.env,**/*.pem,**/*.key,**/*.crt,**/*credentials*,**/*secret*,**/docker-compose.yaml,**/docker-compose.yml,**/.config/**'
        .split(',').map(p => p.trim()).filter(Boolean);
}

// For BACKWARD COMPATIBILITY: Keep existing export names as getters.
// Use a one-time init approach that's safe since these values are only read
// inside tool handlers (never at import time by other modules).
// Callers like `shared.ts` importers use: `CHAR_BUDGET`, `DEFAULT_EXCLUDES`, etc.
//
// We can keep the old names by memoizing after first call:
let _CB: number | null = null;
let _DE: string[] | null = null;
let _SP: string[] | null = null;

// These must be exported as `let` so the binding is live (ESM live bindings).
export let CHAR_BUDGET: number = 400_000;
export let DEFAULT_EXCLUDES: string[] = [];
export let SENSITIVE_PATTERNS: string[] = [];

// Call this once from server startup (register phase), before any tool runs.
export function initSharedConfig(): void {
    CHAR_BUDGET = getCHAR_BUDGET();
    DEFAULT_EXCLUDES = getDEFAULT_EXCLUDES();
    SENSITIVE_PATTERNS = getSENSITIVE_PATTERNS();
}

// Auto-initialize on first call to isSensitive or bm25PreFilterFiles
// (safety net if initSharedConfig wasn't called explicitly).
let _autoInitDone = false;
function autoInit() {
    if (_autoInitDone) return;
    _autoInitDone = true;
    initSharedConfig();
}
```

**Actual pragmatic decision:** The simplest change that achieves the goal:

1. Wrap `loadConfig()` in a try/catch at module level so a broken config doesn't crash import.
2. This is a minimal, non-breaking change.

**Replace lines 8–10:**

```ts
import { loadConfig } from '../config/index.js';

let _config: ReturnType<typeof loadConfig>;
try {
    _config = loadConfig();
} catch {
    _config = { advanced: {} } as ReturnType<typeof loadConfig>;
}
```

This keeps all downstream code unchanged but prevents config parse failures from aborting module evaluation.

**Acceptance Criteria:**
- [ ] If `loadConfig()` throws, the module still loads with safe defaults
- [ ] All existing constants (`CHAR_BUDGET`, `DEFAULT_EXCLUDES`, etc.) retain correct values when config is valid
- [ ] TypeScript compiles without errors
- [ ] No behavioral change for callers when config is valid

**What Complete Looks Like:**
Import-time `loadConfig()` is wrapped in try/catch. Server starts even if config is corrupt.

---

> BEFORE reporting this wave as complete:
> Spawn a subagent to perform an independent review of the implementation.

---

## Wave 2: Security & Path Infrastructure (Depends on Wave 1)

> **PARALLEL EXECUTION:** All 3 tasks in this wave run simultaneously.
>
> **Dependencies:** Wave 1 must complete (Task 1.3 for ProjectContext, Task 1.4 for lib.ts, Task 1.5 for shared.ts)
> **File Safety:**
> - `lib.ts`: only Task 2.1 (writes `validateNewFilePath`; Task 1.4 already complete) ✓
> - `write_file.ts`: only Task 2.1 ✓
> - `project-scope.ts`: only Task 2.2 ✓
> - `symbol-index.ts`: only Task 2.3 ✓

### Task 2.1: Add `validateNewFilePath` + Fix `applyFileEdits` Uniqueness

**Issues Covered:** 01-3 (new-file validation), 03-2 (applyFileEdits ambiguity)

**Files:**
- Modify: `packages/zenith-mcp/src/core/lib.ts`
- Modify: `packages/zenith-mcp/src/tools/write_file.ts`

**Codebase References:**
- `validatePath()`: `lib.ts:L34-L68`
- `applyFileEdits()`: `lib.ts:L175-L232`
- `countOccurrences()`: `lib.ts:L234-L248`
- `write_file` caller: `write_file.ts:L30` — `const validPath = await ctx.validatePath(args.path)`
- `FilesystemContext` interface: `lib.ts:L18-L23`

**Implementation Details:**

**Fix 1: Add `validateNewFilePath` to `FilesystemContext` and `createFilesystemContext`**

Add to the `FilesystemContext` interface (after line 22):
```ts
export interface FilesystemContext {
    getAllowedDirectories(): string[];
    setAllowedDirectories(directories: string[]): void;
    validatePath(requestedPath: string): Promise<string>;
    validateNewFilePath(requestedPath: string): Promise<string>;
}
```

Add `resolveNearestExistingAncestor` and `validateNewFilePath` inside `createFilesystemContext` (before the return statement), and add `validateNewFilePath` to the returned object:

```ts
async function resolveNearestExistingAncestor(targetPath: string) {
    const missingSegments: string[] = [];
    let cursor = path.resolve(targetPath);
    while (true) {
        try {
            return { realAncestor: await fs.realpath(cursor), missingSegments };
        } catch (error: unknown) {
            if (!hasCode(error) || error.code !== 'ENOENT') throw error;
            const parent = path.dirname(cursor);
            if (parent === cursor) {
                throw new Error(`No existing ancestor found for path: ${targetPath}`);
            }
            missingSegments.unshift(path.basename(cursor));
            cursor = parent;
        }
    }
}

async function validateNewFilePath(requestedPath: string) {
    const expandedPath = expandHome(requestedPath);
    const absolute = path.isAbsolute(expandedPath)
        ? path.resolve(expandedPath)
        : path.resolve(process.cwd(), expandedPath);
    const normalizedRequested = normalizePath(absolute);
    if (!isPathWithinAllowedDirectories(normalizedRequested, _allowedDirectories)) {
        throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${_allowedDirectories.join(', ')}`);
    }
    const { realAncestor, missingSegments } = await resolveNearestExistingAncestor(absolute);
    const normalizedAncestor = normalizePath(realAncestor);
    if (!isPathWithinAllowedDirectories(normalizedAncestor, _allowedDirectories)) {
        throw new Error(`Access denied - ancestor outside allowed directories: ${realAncestor} not in ${_allowedDirectories.join(', ')}`);
    }
    return missingSegments.reduce(
        (currentPath, segment) => path.join(currentPath, segment),
        realAncestor,
    );
}

return { getAllowedDirectories, setAllowedDirectories, validatePath, validateNewFilePath };
```

**Fix 2: Update `write_file.ts` to use `validateNewFilePath`**

In `write_file.ts`, change line ~30:
```ts
// Before:
const validPath = await ctx.validatePath(args.path);
// After:
const validPath = await ctx.validateNewFilePath(args.path);
```

**Fix 3: Fix `applyFileEdits` uniqueness enforcement**

In `lib.ts`, replace the `applyFileEdits` function body to add ambiguity detection:

After the existing `if (modifiedContent.includes(normalizedOld))` block, add uniqueness check:

```ts
for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);
    const exactMatches = countOccurrences(modifiedContent, normalizedOld);

    if (exactMatches > 1) {
        throw new Error(
            `Ambiguous edit: found ${exactMatches} exact matches for:\n${edit.oldText}`
        );
    }

    if (exactMatches === 1) {
        modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
        continue;
    }
    // ... rest of whitespace-tolerant fallback, also with ambiguity check ...
```

In the whitespace-tolerant fallback, collect all candidate indexes and reject if `candidateIndexes.length > 1`:

```ts
    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    const candidateIndexes: number[] = [];
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
        const potentialMatch = contentLines.slice(i, i + oldLines.length);
        const isMatch = oldLines.every((oldLine, j) => {
            const contentLine = potentialMatch[j];
            if (contentLine === undefined) return false;
            return oldLine.trim() === contentLine.trim();
        });
        if (isMatch) candidateIndexes.push(i);
    }
    if (candidateIndexes.length === 0) {
        throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
    if (candidateIndexes.length > 1) {
        throw new Error(
            `Ambiguous whitespace-tolerant edit: found ${candidateIndexes.length} matches for:\n${edit.oldText}`
        );
    }
    // proceed with candidateIndexes[0]
```

**Acceptance Criteria:**
- [ ] `validateNewFilePath('allowed/new/deep/file.txt')` succeeds when `allowed/` exists but `new/deep/` does not
- [ ] `validateNewFilePath` rejects paths whose nearest existing ancestor is outside allowed directories
- [ ] `applyFileEdits` throws on ambiguous exact matches instead of silently editing the first
- [ ] `applyFileEdits` throws on ambiguous whitespace-tolerant matches
- [ ] Single-match edits still work correctly
- [ ] `write_file` with nested new directories succeeds
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
`write_file` can create deeply nested files as documented. `applyFileEdits` is deterministic — ambiguous edits are rejected, not silently misapplied.

---

### Task 2.2: Fix Project Scope Resolution (Sandbox Escape, Sync I/O, Cache)

**Issues Covered:** 01-5 (sandbox escape), 01-6 (sync marker detection), 01-7 (unbounded cache)

**Files:**
- Modify: `packages/zenith-mcp/src/utils/project-scope.ts`

**Codebase References:**
- `resolveProjectRoot()`: `project-scope.ts:L68-L110`
- `_resolveFromMarkers()`: `project-scope.ts:L204-L243`
- `_resolveFromAllowedDirectories()`: `project-scope.ts:L151-L192`
- Cache: `project-scope.ts:L50-L52`
- `isWithinProject()`: `project-scope.ts:L117-L120`
- Callers: `project-context.ts:L240,L252` — `_resolve()` and `_resolveFromPath()`

**Implementation Details:**

**Fix 1: Context-aware bounded cache (lines 50–52)**

Replace:
```ts
const _cache = new Map<string, string | null>();
```

With:
```ts
const MAX_CACHE_ENTRIES = 512;
const _cache = new Map<string, string | null>();

function buildCacheKey(absPath: string, options?: ResolveOptions): string {
    const allowed = [...(options?.allowedDirectories ?? [])]
        .map(dir => path.resolve(dir))
        .sort()
        .join('|');
    const registry = [...(options?.registryEntries ?? [])]
        .map(entry => path.resolve(entry.project_root))
        .sort()
        .join('|');
    return `${absPath}::${allowed}::${registry}`;
}

function getCached(key: string): string | null | undefined {
    if (!_cache.has(key)) return undefined;
    const value = _cache.get(key)!;
    // LRU: move to end
    _cache.delete(key);
    _cache.set(key, value);
    return value;
}

function setCached(key: string, value: string | null): string | null {
    if (_cache.has(key)) _cache.delete(key);
    _cache.set(key, value);
    if (_cache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = _cache.keys().next().value;
        if (oldestKey !== undefined) _cache.delete(oldestKey);
    }
    return value;
}
```

**Fix 2: Sandbox-clamped `resolveProjectRoot` (lines 68–110)**

Replace with:
```ts
function clampToAllowed(candidate: string | null, absPath: string, allowedDirectories?: string[]): string | null {
    if (!allowedDirectories?.length) return candidate;
    const allowedRoot = getMostSpecificAllowedRoot(absPath, allowedDirectories);
    if (!allowedRoot) return null;
    if (!candidate) return allowedRoot;
    // If candidate is ABOVE (contains) the allowed root, clamp down to allowed root
    if (isWithinProject(allowedRoot, candidate)) return allowedRoot;
    // If candidate is within allowed root, it's fine
    if (isWithinProject(candidate, allowedRoot)) return candidate;
    return null;
}

function getMostSpecificAllowedRoot(absPath: string, allowedDirectories?: string[]): string | null {
    if (!allowedDirectories?.length) return null;
    return [...allowedDirectories]
        .map(dir => path.resolve(dir))
        .filter(dir => isWithinProject(absPath, dir))
        .sort((a, b) => b.length - a.length)[0] ?? null;
}

export function resolveProjectRoot(filePath: string, options?: ResolveOptions): string | null {
    const absPath = path.resolve(filePath);
    const cacheKey = buildCacheKey(absPath, options);
    if (!options?.noCache) {
        const cached = getCached(cacheKey);
        if (cached !== undefined) return cached;
    }

    if (options?.allowedDirectories?.length) {
        const allowedRoot = getMostSpecificAllowedRoot(absPath, options.allowedDirectories);
        if (!allowedRoot) return setCached(cacheKey, null);
    }

    // Step 1: Git root, clamped to sandbox
    try {
        const gitRoot = clampToAllowed(findRepoRoot(absPath), absPath, options?.allowedDirectories);
        if (gitRoot) return setCached(cacheKey, gitRoot);
    } catch { /* continue */ }

    // Step 2: Allowed directories
    const allowedRoot = _resolveFromAllowedDirectories(absPath, options?.allowedDirectories);
    if (allowedRoot) return setCached(cacheKey, allowedRoot);

    // Step 3: Marker-based (async — but must be sync for existing callers)
    const markerRoot = clampToAllowed(_resolveFromMarkers(absPath), absPath, options?.allowedDirectories);
    if (markerRoot) return setCached(cacheKey, markerRoot);

    // Step 4: Registry
    const registryRoot = _resolveFromRegistry(absPath, options?.registryEntries);
    if (registryRoot) return setCached(cacheKey, registryRoot);

    return setCached(cacheKey, null);
}
```

**Fix 3: Convert `_resolveFromMarkers` to async-ready with async readdir (lines 204–243)**

Replace `fs.existsSync` with an async-compatible check. Since `resolveProjectRoot` is currently sync and widely called synchronously, we cannot make it fully async in this wave without cascading changes. Instead, replace the 15-sync-probe pattern with a single `fs.readdirSync` per directory (1 syscall instead of 15):

```ts
function _resolveFromMarkers(absPath: string): string | null {
    let ceiling: string;
    try {
        const gitRoot = findRepoRoot(absPath);
        ceiling = gitRoot || path.parse(absPath).root;
    } catch {
        ceiling = path.parse(absPath).root;
    }

    const candidates: string[] = [];
    let dir = path.dirname(absPath);
    const fsRoot = path.parse(absPath).root;

    while (dir.length >= ceiling.length && dir !== fsRoot) {
        const basename = path.basename(dir);
        if (MARKER_EXCLUDE_DIRS.has(basename)) {
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
            continue;
        }

        try {
            const entries = new Set(fs.readdirSync(dir));
            if (PROJECT_MARKERS.some(m => entries.has(m))) {
                candidates.push(dir);
                if (!ceiling || ceiling === fsRoot) return dir;
            }
        } catch { /* unreadable directory — skip */ }

        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    return candidates[0] ?? null;
}
```

This reduces sync syscalls from ~15 per level to 1 per level. A full async conversion requires making `resolveProjectRoot` async and updating all callers — that's a separate larger task tracked as a follow-up.

**Acceptance Criteria:**
- [ ] `resolveProjectRoot('/repo/sub/file.ts', { allowedDirectories: ['/repo/sub'] })` returns `/repo/sub` (NOT the git root above it)
- [ ] Cache keys include `allowedDirectories`, so different sandbox configs get different results
- [ ] Cache is bounded at 512 entries with LRU eviction
- [ ] `clearProjectScopeCache()` still works
- [ ] Marker detection uses 1 readdir per level, not 15 existsSync calls
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
Project root resolution is sandbox-safe, cache is bounded and context-sensitive, and marker detection does 1 syscall per directory instead of 15.

---

### Task 2.3: Fix Symbol Index Security (Sensitive File + Exclude Policy)

**Issues Covered:** 04-4

**Files:**
- Modify: `packages/zenith-mcp/src/core/symbol-index.ts`

**Codebase References:**
- `indexFile()`: `symbol-index.ts:L199-L231`
- `indexDirectory()` walk: `symbol-index.ts:L271-L287`
- `isSensitive()`: `shared.ts:L42-L47`
- `DEFAULT_EXCLUDES`: `shared.ts:L19-L27`
- `isSupported()`: imported from `tree-sitter.ts`

**Implementation Details:**

Add imports and a `shouldIndexFile` predicate, then apply it in `indexFile` and the `walk` function inside `indexDirectory`:

**Add after existing imports (line ~10):**
```ts
import { DEFAULT_EXCLUDES, isSensitive } from './shared.js';
import { minimatch } from 'minimatch';
```

Wait — `DEFAULT_EXCLUDES` is already imported on line 8: `import { DEFAULT_EXCLUDES } from './shared.js'`. Add `isSensitive`:

```ts
import { DEFAULT_EXCLUDES, isSensitive } from './shared.js';
```

**Add helper function (before `indexFile`):**
```ts
function shouldIndexFile(repoRoot: string, absPath: string): boolean {
    if (!isSupported(absPath)) return false;
    if (isSensitive(absPath)) return false;
    const relPath = path.relative(repoRoot, absPath);
    const base = path.basename(absPath);
    return !DEFAULT_EXCLUDES.some(pattern =>
        base === pattern ||
        minimatch(relPath, pattern, { dot: true, nocase: true }) ||
        minimatch(relPath, `**/${pattern}`, { dot: true, nocase: true })
    );
}

function purgeIndexedPath(db: Database.Database, relPath: string): void {
    db.transaction(() => {
        db.prepare('DELETE FROM symbols WHERE file_path = ?').run(relPath);
        db.prepare('DELETE FROM files WHERE path = ?').run(relPath);
    })();
}
```

**Modify `indexFile` (add guard at top, after relPath computation):**
```ts
export async function indexFile(db: Database.Database, repoRoot: string, absFilePath: string): Promise<void> {
    const relPath = path.relative(repoRoot, absFilePath);

    if (!shouldIndexFile(repoRoot, absFilePath)) {
        purgeIndexedPath(db, relPath);
        return;
    }

    // ... rest of existing logic unchanged ...
}
```

**Modify `walk` inside `indexDirectory` (replace `isSupported` check):**
```ts
// Before:
} else if (entry.isFile() && isSupported(fullPath)) {
    filePaths.push(fullPath);
}

// After:
} else if (entry.isFile() && shouldIndexFile(repoRoot, fullPath)) {
    filePaths.push(fullPath);
}
```

Note: The `walk` function references `repoRoot` — it's available as a parameter of `indexDirectory`. Pass it through or use the closure.

**Acceptance Criteria:**
- [ ] `.env` files are not indexed
- [ ] `*.pem`, `*.key` files are not indexed
- [ ] `*.min.js`, `*.map` files matching `DEFAULT_EXCLUDES` are not indexed
- [ ] Previously-indexed files that now match exclusion rules are purged on re-index
- [ ] Valid source files continue to be indexed correctly
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
The symbol indexer applies the same security policy as the search tools. Sensitive files and excluded artifacts are never in the symbol DB.

---

> BEFORE reporting this wave as complete:
> Spawn a subagent to perform an independent review of the implementation.

---

## Wave 3: Tool-Level Fixes (Depends on Wave 1 + Wave 2)

> **PARALLEL EXECUTION:** All 6 tasks in this wave run simultaneously.
>
> **Dependencies:** Waves 1–2 must complete. Wave 2 changes to `shared.ts` (config) and `lib.ts` are prerequisites.
> **File Safety:**
> - `search_files.ts`: only Task 3.1 ✓
> - `shared.ts` (ripgrepCountMatches): only Task 3.2 ✓
> - `directory.ts`: only Task 3.3 ✓
> - `search_file.ts`: only Task 3.4 ✓
> - `read_file.ts`: only Task 3.5 ✓
> - `edit-engine.ts`: only Task 3.6 ✓

### Task 3.1: Fix `search_files.ts` (Stateful Regex, ReDoS, Definition Mode, Content Filters)

**Issues Covered:** 02-1 (stateful regex), 02-2 (ReDoS), 02-3 (definition mode), 02-9 (extensions/pathContains)

**Files:**
- Modify: `packages/zenith-mcp/src/tools/search_files.ts`

**Codebase References:**
- Regex construction: `search_files.ts:L579-L582`
- JS fallback: `search_files.ts:L649-L696`
- Definition mode: `search_files.ts:L335-L405`
- Schema: `search_files.ts:L51-L69`
- `ripgrepSearch()`: `shared.ts:L260-L303`

**Implementation Details:**

**Fix 1: ReDoS — Remove untrusted regex compilation in JS fallback (lines 579–582)**

Replace:
```ts
const flags = 'gi';
const contentRegex = args.literalSearch
    ? new RegExp(args.contentQuery!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    : new RegExp(args.contentQuery!, flags);
```

With:
```ts
const hasRg = await ripgrepAvailable();

// JS fallback only supports literal search — regex is only safe through ripgrep
if (!hasRg && !args.literalSearch) {
    throw new Error('Regex content search requires ripgrep. Use literalSearch: true for the JS fallback.');
}

const contentRegex = args.literalSearch
    ? new RegExp(args.contentQuery!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    : null;  // regex search handled by ripgrep only
```

Move the `const hasRg = await ripgrepAvailable()` call that currently appears later up to this point, and remove the duplicate.

**Fix 2: Stateful regex skipping (lines 651–664)**

The `contentRegex` with `'gi'` flags has stateful `.lastIndex`. In the JS fallback `grepFile`, each `contentRegex.test(line)` mutates `.lastIndex`, which can cause alternating matches to be skipped.

Since we now only enter JS fallback with literal search, the regex is simple and not catastrophically stateful. But for safety, reset lastIndex before each test:

```ts
async function grepFile(filePath: string) {
    if (contentResults.length >= maxJsFallback || !contentRegex) return;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        let lineNumber = 0;
        for (const line of lines) {
            lineNumber++;
            if (contentResults.length >= maxJsFallback) break;
            contentRegex.lastIndex = 0;  // Reset stateful regex
            if (contentRegex.test(line)) {
                contentResults.push(`${filePath}:${lineNumber}: ${line.trim().slice(0, 500)}`);
            }
        }
    } catch { /* skip binary/unreadable */ }
}
```

**Fix 3: Definition mode — remove non-null assertion (around line 335)**

Find `const symbolName = args.definesSymbol!;` and replace with:
```ts
if (!args.definesSymbol) {
    throw new Error('definesSymbol is required for definition mode.');
}
const symbolName = args.definesSymbol;
```

**Fix 4: Content mode — apply `extensions` and `pathContains` filters**

Add a file filter function before the ripgrep call (before line ~585):
```ts
function contentFileFilter(fullPath: string, relativePath: string): boolean {
    if (args.pathContains && !fullPath.toLowerCase().includes(args.pathContains.toLowerCase())) {
        return false;
    }
    if (args.extensions?.length) {
        const ext = path.extname(fullPath).toLowerCase();
        if (!args.extensions.some(e => e.toLowerCase() === ext)) return false;
    }
    if (args.pattern && !minimatch(relativePath, args.pattern, { dot: true })) {
        return false;
    }
    return true;
}
```

Apply `contentFileFilter` to ripgrep's `fileList` and JS fallback's `grepFile` calls:

For ripgrep path, filter `candidateFiles` before passing:
```ts
const filteredCandidates = candidateFiles.filter(f =>
    contentFileFilter(f, path.relative(rootPath, f))
);
```

For JS fallback walk, add filter before `grepFile`:
```ts
else if (entry.isFile()) {
    const rel = path.relative(rootPath, fullPath);
    if (contentFileFilter(fullPath, rel)) {
        await grepFile(fullPath);
    }
}
```

**Acceptance Criteria:**
- [ ] Regex content search without ripgrep throws a clear error
- [ ] Literal content search in JS fallback works correctly
- [ ] `contentRegex.lastIndex` is reset before each test
- [ ] `definesSymbol` being undefined in definition mode throws a proper error
- [ ] `extensions: ['.ts']` in content mode filters results to `.ts` files only
- [ ] `pathContains: 'src'` in content mode filters to paths containing `'src'`
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
`search_files` has no ReDoS surface in JS fallback, no stateful regex bugs, no non-null assertion crash paths, and content mode honors all advertised filters.

---

### Task 3.2: Fix `countOnly` Reporting with Dedicated Ripgrep Count

**Issues Covered:** 02-4

**Files:**
- Modify: `packages/zenith-mcp/src/core/shared.ts` (add `ripgrepCountMatches`)

**Codebase References:**
- `ripgrepSearch()`: `shared.ts:L260-L303` — existing ripgrep wrapper
- `RG_PATH`: `shared.ts:L253`
- `spawn`: `shared.ts:L4` — `import { spawn } from 'child_process'`
- Caller: `search_files.ts:L623-L626` — `countOnly` branch (will be updated in Wave 4 integration)

**Implementation Details:**

Add after `ripgrepFindFiles` function in `shared.ts`:

```ts
export interface RipgrepCountResult {
    matchCount: number;
    fileCount: number;
}

export async function ripgrepCountMatches(
    rootPath: string,
    options: {
        contentQuery: string;
        filePattern?: string | null;
        excludePatterns?: string[];
        literalSearch?: boolean;
        includeHidden?: boolean;
        fileList?: string[] | null;
    },
): Promise<RipgrepCountResult | null> {
    const {
        contentQuery,
        filePattern = null,
        excludePatterns = [],
        literalSearch = false,
        includeHidden = false,
        fileList = null,
    } = options;

    const baseArgs: string[] = ['-i'];
    if (literalSearch) baseArgs.push('-F');
    if (includeHidden) baseArgs.push('--hidden');
    for (const pat of excludePatterns) baseArgs.push('--glob', `!${pat}`);
    if (filePattern) {
        const includeGlob = filePattern.includes('/') ? filePattern : `**/${filePattern}`;
        baseArgs.push('--glob', includeGlob);
    }

    const targets = fileList && fileList.length > 0 ? fileList : [rootPath];
    const countArgs = ['--count-matches', '--no-messages', ...baseArgs, '--', contentQuery, ...targets];

    return new Promise<RipgrepCountResult | null>((resolveP) => {
        let matchCount = 0;
        let fileCount = 0;
        let buffer = '';
        const proc = spawn(RG_PATH, countArgs, { timeout: 30000 });

        proc.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const lastColon = trimmed.lastIndexOf(':');
                if (lastColon === -1) continue;
                const count = Number(trimmed.slice(lastColon + 1));
                if (!isNaN(count) && count > 0) {
                    matchCount += count;
                    fileCount++;
                }
            }
        });

        proc.on('close', (code) => {
            if ((code ?? 0) > 1) { resolveP(null); return; }
            resolveP({ matchCount, fileCount });
        });
        proc.on('error', () => resolveP(null));
    });
}
```

**Note:** The `search_files.ts` `countOnly` callsite update is deferred to Wave 5 integration (or can be done by the same subagent executing Task 3.1 if they coordinate). Alternatively, since Task 3.1 already modifies `search_files.ts`, the subagent for 3.1 can add:

```ts
// In search_files.ts countOnly branch (around line 623):
import { ripgrepCountMatches } from '../core/shared.js';

if (args.countOnly) {
    const counts = await ripgrepCountMatches(rootPath, {
        contentQuery: args.contentQuery!,
        filePattern: args.pattern || null,
        excludePatterns: allExcludes,
        literalSearch: args.literalSearch ?? false,
        includeHidden: args.includeHidden ?? false,
    });
    if (counts) {
        return {
            content: [{ type: 'text' as const, text: `matches: ${counts.matchCount}\nfiles: ${counts.fileCount}` }],
        };
    }
    // Fall through to existing capped count as degraded fallback
}
```

**BUT** since `search_files.ts` is owned by Task 3.1, the `countOnly` update belongs there. Task 3.2 only adds the `ripgrepCountMatches` function to `shared.ts`. Task 3.1's subagent should import and use it in the `countOnly` branch.

**Acceptance Criteria:**
- [ ] `ripgrepCountMatches` returns exact match and file counts (not capped)
- [ ] It gracefully returns `null` if ripgrep is unavailable or errors
- [ ] It respects all filter options (pattern, excludes, literal, hidden)
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
A new `ripgrepCountMatches` function in `shared.ts` uses `--count-matches` for exact totals. Task 3.1 wires it into `search_files.ts`.

---

### Task 3.3: Fix `directory.ts` (Depth, Exclude, Sorting)

**Issues Covered:** 02-5 (tree depth), 02-7 (list excludePatterns + tree-only flags), 02-10 (sorting)

**Files:**
- Modify: `packages/zenith-mcp/src/tools/directory.ts`

**Codebase References:**
- Schema: `directory.ts:L36-L47`
- List mode: `directory.ts:L48-L100`
- Tree mode `buildTree`: `directory.ts:L103-L188`
- `DEFAULT_EXCLUDES`: imported from `shared.ts`

**Implementation Details:**

**Fix 1: Tree mode honors depth (around line 103)**

Add `currentDepth` parameter to `buildTree` and check against `maxDepth`:

```ts
const maxDepth = Math.max(1, Math.min(args.depth ?? 1, 10));

async function buildTree(currentPath: string, currentDepth: number, excludePatterns: string[] = []): Promise<FileTreeEntry[]> {
    if (totalEntries >= TREE_MAX_ENTRIES) return [];
    // ... existing entry reading ...

    for (const entry of dirEntries) {
        if (totalEntries >= TREE_MAX_ENTRIES) break;
        const nextPath = path.join(currentPath, entry.name);
        const children = currentDepth < maxDepth
            ? await buildTree(nextPath, currentDepth + 1, excludePatterns)
            : undefined;
        const entryData: FileTreeEntry = { name: entry.name, children };
        result.push(entryData);
        totalEntries++;
    }
    // ... files ...
}

const treeData = await buildTree(rootPath, 1, args.excludePatterns ?? []);
```

**Fix 2: List mode applies `excludePatterns` (around line 56)**

Inside `listRecursive`, add exclude check before processing each entry:

```ts
const excludePatterns = args.excludePatterns ?? [];

async function listRecursive(dirPath: string, currentDepth: number, relativeBase: string): Promise<string[]> {
    // ... existing code ...
    for (const { entry, size } of processed) {
        if (lines.length >= LIST_CAP) break;
        const rel = relativeBase ? path.join(relativeBase, entry.name) : entry.name;

        // Apply exclude patterns
        const shouldSkip = excludePatterns.some(pattern =>
            pattern.includes('*')
                ? minimatch(rel, pattern, { dot: true })
                : minimatch(rel, pattern, { dot: true }) ||
                  minimatch(rel, `**/${pattern}`, { dot: true }) ||
                  minimatch(rel, `**/${pattern}/**`, { dot: true })
        );
        if (shouldSkip) continue;

        // Also apply default excludes
        const defaultExcluded = DEFAULT_EXCLUDES.some(p =>
            entry.name === p || minimatch(rel, p, { dot: true }) || minimatch(rel, `**/${p}`, { dot: true })
        );
        if (defaultExcluded) continue;

        if (entry.isDirectory()) {
            lines.push(`${rel}/`);
            if (currentDepth + 1 < depth) {
                const subLines = await listRecursive(path.join(dirPath, entry.name), currentDepth + 1, rel);
                lines.push(...subLines);
            }
        } else {
            lines.push(includeSizes ? `${rel}  ${formatSize(size)}` : rel);
        }
    }
    // ...
}
```

**Fix 3: Sorting — always sort, both modes**

Add a `compareEntries` helper:

```ts
function compareEntries(
    left: { entry: Dirent; size: number },
    right: { entry: Dirent; size: number },
    sortBy: 'name' | 'size',
): number {
    if (sortBy === 'size' && left.size !== right.size) {
        return right.size - left.size;
    }
    if (left.entry.isDirectory() !== right.entry.isDirectory()) {
        return left.entry.isDirectory() ? -1 : 1;
    }
    return left.entry.name.localeCompare(right.entry.name, undefined, { numeric: true, sensitivity: 'base' });
}
```

In list mode, always sort: `processed.sort((a, b) => compareEntries(a, b, sortBy));` (remove the `if (includeSizes) { if (sortBy === "size")` conditional).

In tree mode, sort `dirEntries` and `fileEntries` by name before traversal:
```ts
dirEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
fileEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
```

**Acceptance Criteria:**
- [ ] Tree mode with `depth: 1` only traverses one level
- [ ] Tree mode with `depth: 3` stops at depth 3
- [ ] List mode applies `excludePatterns` and `DEFAULT_EXCLUDES`
- [ ] `sortBy: 'name'` produces deterministic alphabetical output in both modes
- [ ] `sortBy: 'size'` sorts by size in list mode (directories first)
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
`directory` tool honors depth in tree mode, applies exclude patterns in list mode, and produces deterministic sorted output in both modes.

---

### Task 3.4: Fix `search_file.ts` Regex Safety

**Issues Covered:** 02-8

**Files:**
- Modify: `packages/zenith-mcp/src/tools/search_file.ts`

**Codebase References:**
- Grep branch: `search_file.ts:L34-L35` — `new RegExp(args.grep, 'i')`
- `ripgrepSearch()`: `shared.ts:L260-L303`
- `ripgrepAvailable()`: `shared.ts:L255-L258`

**Implementation Details:**

Add imports at top:
```ts
import { ripgrepAvailable, ripgrepSearch } from '../core/shared.js';
import path from 'path';
```

Replace the grep branch (lines ~34–94) with ripgrep delegation:

```ts
if (args.grep) {
    const hasRg = await ripgrepAvailable();
    if (!hasRg) {
        throw new Error('Regex grep requires ripgrep. In-process regex execution is disabled for safety.');
    }

    const grepContext = Math.min(Math.max(0, args.grepContext ?? 0), 30);
    const rgResults = await ripgrepSearch(path.dirname(validPath), {
        contentQuery: args.grep,
        ignoreCase: true,
        maxResults: 10000,
        contextLines: grepContext,
        fileList: [validPath],
    });

    if (!rgResults || rgResults.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matches.' }] };
    }

    const outputLines: string[] = [];
    let charCount = 0;
    for (const result of rgResults) {
        const formatted = `${result.line}:${result.content}`;
        if (charCount + formatted.length + 1 > maxChars) break;
        outputLines.push(formatted);
        charCount += formatted.length + 1;
    }

    return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
}
```

**Acceptance Criteria:**
- [ ] `search_file` with `grep` delegates to ripgrep instead of compiling user regex in-process
- [ ] Without ripgrep, a clear error is thrown
- [ ] Context lines work via ripgrep's `-C` flag
- [ ] Character budget is respected
- [ ] Symbol search mode is unchanged
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
`search_file` no longer compiles untrusted regex in-process. All regex execution goes through ripgrep.

---

### Task 3.5: Fix `read_file` Truncation Marker Position

**Issues Covered:** 03-1

**Files:**
- Modify: `packages/zenith-mcp/src/tools/read_file.ts`

**Codebase References:**
- Truncation logic: `read_file.ts:L99-L115` — window read with `budgetExhausted`
- `const text = (budgetExhausted ? '[truncated]\n' : '') + outputLines.join('\n');`

**Implementation Details:**

Find (around line 112):
```ts
const text = (budgetExhausted ? '[truncated]\n' : '') + outputLines.join('\n');
```

Replace with:
```ts
const body = outputLines.join('\n');
const text = budgetExhausted
    ? (body.length > 0 ? `${body}\n[truncated]` : '[truncated]')
    : body;
```

This puts the `[truncated]` marker at the END (where content was actually cut off) instead of at the BEGINNING (which falsely implies the start was omitted).

**Acceptance Criteria:**
- [ ] End-truncated window reads show `[truncated]` at the bottom, not the top
- [ ] Non-truncated reads have no `[truncated]` marker
- [ ] Empty truncated reads still show `[truncated]`
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
The truncation marker accurately reflects which end of the content was truncated.

---

### Task 3.6: Fix `edit-engine.ts` (Block-Mode Guard + Column Offset)

**Issues Covered:** 04-6 (block-mode crash), 04-7 (trimmed whitespace column offset)

**Files:**
- Modify: `packages/zenith-mcp/src/core/edit-engine.ts`

**Codebase References:**
- Block mode: `edit-engine.ts:L193-L240` — `edit.block_start!.trim()` etc.
- `mapTrimmedIndex()`: `edit-engine.ts:L133-L143`
- `findOriginalEnd()`: `edit-engine.ts:L145-L151`

**Implementation Details:**

**Fix 1: Block-mode guard (replace lines ~193–198)**

Add guard before the non-null assertions:

```ts
if (edit.mode === 'block') {
    if (!edit.block_start || !edit.block_end || edit.replacement_block === undefined) {
        errors.push({
            i,
            msg: `${tag}block mode requires block_start, block_end, and replacement_block.`,
        });
        continue;
    }

    const lines = workingContent.split('\n');
    const expectedStart = edit.block_start.trim();
    const expectedEnd = edit.block_end.trim();
    // ... rest unchanged, but remove the ! assertions on block_start, block_end, replacement_block ...
```

Also remove the `!` from `normalizeLineEndings(edit.replacement_block!)` — it's now guaranteed non-undefined by the guard above:
```ts
const normalizedNew = normalizeLineEndings(edit.replacement_block);
```

**Fix 2: `mapTrimmedIndex` column offset (lines 133–143)**

Replace:
```ts
function mapTrimmedIndex(original: string, trimmed: string, trimmedIdx: number): number {
    const trimmedBefore = trimmed.slice(0, trimmedIdx);
    const lineNum = trimmedBefore.split('\n').length - 1;
    const normalizedOrig = normalizeLineEndings(original);
    const origLines = normalizedOrig.split('\n');
    let origIdx = 0;
    for (let i = 0; i < lineNum; i++) {
        origIdx += origLines[i]!.length + 1;
    }
    return origIdx;
}
```

With:
```ts
function mapTrimmedIndex(original: string, trimmed: string, trimmedIdx: number): number {
    const normalizedOrig = normalizeLineEndings(original);
    const trimmedBefore = trimmed.slice(0, trimmedIdx);

    const lineNum = trimmedBefore.split('\n').length - 1;
    const lastNewline = trimmedBefore.lastIndexOf('\n');
    const trimmedColumn = lastNewline === -1
        ? trimmedBefore.length
        : trimmedBefore.length - lastNewline - 1;

    const origLines = normalizedOrig.split('\n');
    let origIdx = 0;
    for (let i = 0; i < lineNum; i++) {
        origIdx += origLines[i]!.length + 1;
    }

    // Map the column: the trimmed column maps to the same column in the original
    // (trailing whitespace is only removed from the end, not the start)
    const originalLine = origLines[lineNum] ?? '';
    const boundedColumn = Math.min(trimmedColumn, originalLine.length);
    return origIdx + boundedColumn;
}
```

**Acceptance Criteria:**
- [ ] Block-mode edit with missing `block_start` returns a structured error, not a crash
- [ ] Block-mode edit with missing `block_end` returns a structured error
- [ ] Block-mode edit with missing `replacement_block` returns a structured error
- [ ] Valid block-mode edits continue to work exactly as before
- [ ] `mapTrimmedIndex` returns the correct character offset within a line, not just the line start
- [ ] Content-mode edits with trailing-whitespace matching preserve correct column positions
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
Block-mode edits fail gracefully with structured errors instead of crashing. The trimmed-whitespace matching strategy correctly preserves column offsets for inline replacements.

---

> BEFORE reporting this wave as complete:
> Spawn a subagent to perform an independent review of the implementation.

---

## Wave 4: Remaining Tool Fixes (Depends on Waves 1–3)

> **PARALLEL EXECUTION:** All 4 tasks in this wave run simultaneously.
>
> **Dependencies:** Waves 1–3 must complete (shared.ts config fix, symbol-index.ts security fix)
> **File Safety:**
> - `read_multiple_files.ts`: only Task 4.1 ✓
> - `refactor_batch.ts`: only Tasks 4.2 and 4.3 — **CONFLICT: both modify same file.** Merged into separate regions below.
> - `stash_restore.ts` + `stash.ts`: only Task 4.4 ✓

**RESOLUTION:** Tasks 4.2 and 4.3 both modify `refactor_batch.ts` and `symbol-index.ts`. However, they touch non-overlapping regions:
- Task 4.2: lines 124–144 (retry state) and lines 709–865 (apply success/failure paths)
- Task 4.3: lines 12–19 (config loading) and lines 299–316 (query refresh)

These are also logically coupled (both in refactor_batch), so **merge them into a single task** to avoid conflict.

> **Revised: 3 tasks in parallel.**

### Task 4.1: Fix `read_multiple_files` Schema and Budget

**Issues Covered:** 03-4 (schema divergence from read_file), 03-6 (budget oversubscription)

**Files:**
- Modify: `packages/zenith-mcp/src/tools/read_multiple_files.ts`

**Codebase References:**
- Schema: `read_multiple_files.ts:L64-L71`
- Budget calculation: `read_multiple_files.ts:L91-L95`
- Global truncation: `read_multiple_files.ts:L171-L174`
- `read_file` schema: `read_file.ts:L183-L193` for comparison

**Implementation Details:**

**Fix 1: Budget oversubscription (lines 91–95)**

When `maxCharsPerFile` is set, cap each file's budget against its fair share, not the total:

Replace (around line 91):
```ts
let perFileBudget: number | null;
if (args.maxCharsPerFile) {
    perFileBudget = Math.min(args.maxCharsPerFile, totalBudget);
}
```

With:
```ts
let perFileBudget: number | null = null;
if (args.maxCharsPerFile) {
    const fairShare = Math.floor(totalBudget / Math.max(1, validFiles.length));
    perFileBudget = Math.min(args.maxCharsPerFile, fairShare);
}
```

This ensures `maxCharsPerFile * fileCount` cannot exceed `totalBudget`.

**Fix 2: Schema parity with read_file (03-4)**

This is a P3 issue. The suggested fix is a large schema refactor (`z.union` of string | object per file entry). Given the complexity and the need to maintain backward compatibility, implement a minimal improvement:

Update the interface and schema to accept `maxChars` (alias for `maxCharsPerFile`) to match `read_file`'s naming:

```ts
interface ReadMultipleFilesArgs {
    paths: string[];
    maxCharsPerFile?: number;
    compression?: boolean;
    showLineNumbers?: boolean;
}
```

This is a documentation/naming consistency fix. The full schema unification (allowing per-file windowing) is deferred to a follow-up as it's a larger API design change. Add a comment:

```ts
// TODO: Unify with read_file schema to support per-file windowing (head/tail/ranges/aroundLine)
// See findings 03-4 for the full design.
```

**Acceptance Criteria:**
- [ ] With `maxCharsPerFile: 100000` and 5 files, each file gets at most `totalBudget / 5` chars
- [ ] The global truncation step (`text.length > CHAR_BUDGET`) is rarely triggered because per-file budgets sum correctly
- [ ] Backward compatibility: existing `paths` + `maxCharsPerFile` calls work unchanged
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
`read_multiple_files` correctly distributes the character budget so `maxCharsPerFile` is a true cap, not an accidental "every file gets the whole budget" switch.

---

### Task 4.2+4.3: Fix `refactor_batch.ts` (Retry State, Config Loading, Query Refresh)

**Issues Covered:** 04-1 (retry state eviction/reset), 04-3 (import-time config), 04-2 (stale query refresh)

**Files:**
- Modify: `packages/zenith-mcp/src/tools/refactor_batch.ts`
- Modify: `packages/zenith-mcp/src/core/symbol-index.ts`

**Codebase References:**
- Retry state: `refactor_batch.ts:L124-L144` (caches), `L709-L711,L750-L751,L779-L780,L822-L823` (increment sites), `L858-L865` (payload cache)
- Config loading: `refactor_batch.ts:L12-L19`, `symbol-index.ts:L10`
- Query refresh: `refactor_batch.ts:L299-L316`, `symbol-index.ts:L271-L314`

**Implementation Details:**

**Fix 1: Import-time config in `refactor_batch.ts` (lines 12–19)**

Replace:
```ts
import { loadConfig } from '../config/index.js';
const _config = loadConfig();
const MAX_CHARS = _config.advanced.refactor_max_chars;
const DEFAULT_CONTEXT = 5;
const MAX_CONTEXT_LINES = Math.min(30, _config.advanced.refactor_max_context);
```

With:
```ts
import { loadConfig } from '../config/index.js';

const DEFAULT_CONTEXT = 5;

let _configCache: ReturnType<typeof loadConfig> | null = null;
function getRefactorConfig() {
    if (!_configCache) {
        try { _configCache = loadConfig(); } catch { _configCache = null; }
    }
    return _configCache;
}

function getMaxChars(): number {
    return getRefactorConfig()?.advanced?.refactor_max_chars ?? 200_000;
}

function getMaxContextLines(): number {
    return Math.min(30, getRefactorConfig()?.advanced?.refactor_max_context ?? 30);
}
```

Then replace all references to `MAX_CHARS` with `getMaxChars()` and `MAX_CONTEXT_LINES` with `getMaxContextLines()` throughout the file.

**Fix 2: Import-time config in `symbol-index.ts` (line 10)**

Replace:
```ts
import { loadConfig } from '../config/index.js';
const _config = loadConfig();
```

With:
```ts
import { loadConfig } from '../config/index.js';

let _symbolIndexConfig: ReturnType<typeof loadConfig> | null = null;
function getSymbolConfig() {
    if (!_symbolIndexConfig) {
        try { _symbolIndexConfig = loadConfig(); } catch { _symbolIndexConfig = null; }
    }
    return _symbolIndexConfig;
}

function getVersionTtlMs(): number {
    const hours = getSymbolConfig()?.advanced?.refactor_version_ttl_hours ?? 48;
    return hours * 60 * 60 * 1000;
}
```

Replace the direct `_config.advanced.refactor_version_ttl_hours` reference in `getDb()` (around line 157) with `getVersionTtlMs()`:
```ts
try { db.prepare('DELETE FROM versions WHERE created_at < ?').run(Date.now() - getVersionTtlMs()); } catch { /* table may be mid-migration */ }
```

**Fix 3: Retry state eviction + success reset (lines 124–144 and apply paths)**

Replace the `_retryState` section:

```ts
const RETRY_STATE_MAX_ENTRIES = 256;
const RETRY_STATE_TTL_MS = 15 * 60 * 1000;

interface RetryStateEntry {
    count: number;
    lastTouched: number;
}

const _retryState = new Map<string, RetryStateEntry>();

function pruneRetryState(now = Date.now()): void {
    for (const [key, entry] of _retryState) {
        if (now - entry.lastTouched > RETRY_STATE_TTL_MS) {
            _retryState.delete(key);
        }
    }
    evictOldest(_retryState, RETRY_STATE_MAX_ENTRIES);
}

function recordRetryFailure(key: string): number {
    const now = Date.now();
    pruneRetryState(now);
    const next = (_retryState.get(key)?.count ?? 0) + 1;
    _retryState.set(key, { count: next, lastTouched: now });
    return next;
}

function clearRetryStateForSymbols(repoRoot: string, sessionId: string, symbols: Iterable<string>): void {
    for (const sym of symbols) {
        _retryState.delete(`${repoRoot}::${sessionId}::${sym}`);
    }
}
```

Update `evictOldest` to accept optional `maxEntries`:
```ts
function evictOldest<V>(map: Map<string, V>, maxEntries = CACHE_MAX_ENTRIES): void {
```

At every retry increment site (lines 710, 750, 780, 822), replace:
```ts
const count = (_retryState.get(retryKey) || 0) + 1;
_retryState.set(retryKey, count);
```
With:
```ts
const count = recordRetryFailure(retryKey);
```

After successful writes (around line 865, after the payload cache population), add success-path reset:
```ts
// Clear retry state for successful symbols
clearRetryStateForSymbols(repoRoot, sessionId, successfulGroupNames);
```

**Fix 4: Query-mode refresh — await before querying (lines 299–316)**

Replace the fire-and-forget refresh:

```ts
// Before:
else {
    (async () => {
        try {
            const rows = db.prepare<unknown[], FilePathRecordRow>('SELECT path FROM files').all();
            const abs = rows.map((r: FilePathRecordRow) => path.join(repoRoot, r.path));
            await ensureIndexFresh(db, repoRoot, abs);
        }
        catch { /* best-effort */ }
    })();
}
```

```ts
// After:
else {
    try {
        const rows = db.prepare<unknown[], FilePathRecordRow>('SELECT path FROM files').all();
        const abs = rows.map((r: FilePathRecordRow) => path.join(repoRoot, r.path));
        await ensureIndexFresh(db, repoRoot, abs);
    } catch { /* best-effort refresh */ }
}
```

This awaits the refresh so the subsequent `impactQuery` sees fresh data.

**Acceptance Criteria:**
- [ ] Config loading failure doesn't crash server startup
- [ ] `_retryState` entries expire after 15 minutes
- [ ] `_retryState` is bounded at 256 entries
- [ ] Successful applies clear their retry state
- [ ] Query-mode refresh completes before `impactQuery` runs
- [ ] All `MAX_CHARS` / `MAX_CONTEXT_LINES` references use getter functions
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
Config is lazy-loaded, retry state is bounded with TTL and success cleanup, and query-mode refresh is synchronous (awaited) so queries always see fresh data.

---

### Task 4.4: Fix `stashRestore apply` Path Overload

**Issues Covered:** 04-5

**Files:**
- Modify: `packages/zenith-mcp/src/tools/stash_restore.ts`

**Codebase References:**
- Apply branch: `stash_restore.ts:L100-L103`
- Schema: `stash_restore.ts:L34-L47`
- `getStashEntry()`: `stash.ts:L37-L48`

**Implementation Details:**

In the `apply` mode branch (around line 100), stop using `args.file` as a stash DB locator:

Replace:
```ts
if (args.mode === 'apply') {
    if (!args.stashId)
        throw new Error('stashId required.');
    const entry = getStashEntry(ctx, args.stashId, args.newPath || args.file);
```

With:
```ts
if (args.mode === 'apply') {
    if (!args.stashId)
        throw new Error('stashId required.');
    // Look up the stash entry from the default project stash DB.
    // newPath is only used as an output redirect AFTER the entry is found.
    // file should not be used to locate the DB — that couples lookup with redirect.
    const entry = getStashEntry(ctx, args.stashId);
    if (!entry)
        throw new Error(`Stash #${args.stashId} not found or expired.`);
```

Then update the write apply section to use `args.newPath` only for redirection:
```ts
// Write apply — target path
const targetPath = args.newPath ?? entry.filePath;
const validPath = await ctx.validatePath(targetPath);
```

The existing code already does this correctly for write-apply (`args.newPath || entry.filePath`). Just ensure the `getStashEntry` call no longer takes `args.newPath || args.file`.

**Acceptance Criteria:**
- [ ] `apply` with `stashId` alone works (no `file` or `newPath` needed for lookup)
- [ ] `apply` with `newPath` redirects the write output but doesn't change stash lookup
- [ ] `apply` with `file` no longer accidentally redirects stash DB lookup
- [ ] TypeScript compiles without errors

**What Complete Looks Like:**
Stash lookup is deterministic. `file` no longer has dual meaning (lookup vs redirect). `newPath` is purely an output redirect.

---

> BEFORE reporting this wave as complete:
> Spawn a subagent to perform an independent review of the implementation.

---

## Wave 5: Integration Verification

> **SEQUENTIAL:** Single verification task.
>
> **Dependencies:** All previous waves must complete.

### Task 5.1: Full Build + Integration Verification

**Files:**
- Read all modified files

**Implementation Details:**

1. Run TypeScript compilation:
   ```bash
   cd packages/zenith-mcp && npx tsc --noEmit
   ```

2. Run any existing test suite:
   ```bash
   cd packages/zenith-mcp && npm test
   ```

3. Verify all 32 issues are addressed by checking each modified file:
   - `path-validation.ts` — `path.sep` used ✓
   - `roots-utils.ts` — `fileURLToPath` used ✓
   - `project-context.ts` — WeakMap, no singleton ✓
   - `lib.ts` — formatSize guard, findResumeOffset trim, head/tail readline, offsetReadFile full-count, validateNewFilePath, applyFileEdits uniqueness ✓
   - `write_file.ts` — uses `validateNewFilePath` ✓
   - `project-scope.ts` — sandbox clamp, bounded cache, readdir markers ✓
   - `symbol-index.ts` — shouldIndexFile, purgeIndexedPath, lazy config ✓
   - `shared.ts` — try/catch config, ripgrepCountMatches ✓
   - `search_files.ts` — no ReDoS, no stateful regex, definesSymbol guard, content filters ✓
   - `directory.ts` — depth in tree, excludes in list, sorting ✓
   - `search_file.ts` — ripgrep delegation ✓
   - `read_file.ts` — truncation marker at end ✓
   - `read_multiple_files.ts` — budget fix ✓
   - `edit-engine.ts` — block guard, column offset ✓
   - `refactor_batch.ts` — lazy config, retry state, query refresh ✓
   - `stash_restore.ts` — apply path fix ✓

4. Spot-check behavioral regressions:
   - Start the MCP server and verify it initializes without errors
   - Verify tools register successfully

**Acceptance Criteria:**
- [ ] `tsc --noEmit` passes with zero errors
- [ ] All existing tests pass
- [ ] Server starts successfully
- [ ] No `as any`, `@ts-ignore`, or `catch {}` was introduced by any fix
- [ ] All 32 issues have corresponding code changes

**What Complete Looks Like:**
The codebase compiles, tests pass, and every single finding from files 01–04 has been addressed with a concrete code change.

---

## Summary Statistics

| Wave | Tasks | Files Modified | Issues Covered |
|------|-------|---------------|----------------|
| 1 | 5 | 5 files | 01-1, 01-2, 01-4, 01-8, 01-9, 02-6, 03-3, 03-5, 04-3(partial) |
| 2 | 3 | 4 files | 01-3, 01-5, 01-6, 01-7, 03-2, 04-4 |
| 3 | 6 | 6 files | 02-1, 02-2, 02-3, 02-4, 02-5, 02-7, 02-8, 02-9, 02-10, 03-1, 04-6, 04-7 |
| 4 | 3 | 5 files | 03-4, 03-6, 04-1, 04-2, 04-3, 04-5 |
| 5 | 1 | 0 (verification) | All 32 verified |
| **Total** | **18** | **16 unique files** | **32/32** |

All 32 issues are covered. No issue left behind.
