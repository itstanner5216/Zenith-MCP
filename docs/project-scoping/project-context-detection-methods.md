# Project Context Detection Methods

> **Zenith-MCP** — Complete reference for how a file path is resolved to its owning project root.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [The Binding Tier Ladder](#2-the-binding-tier-ladder)
3. [Boundary Detection](#3-boundary-detection)
4. [Process-Tree Detection](#4-process-tree-detection)
5. [The Caching Layer](#5-the-caching-layer)
6. [The ProjectRegistry Matching Strategy](#6-the-projectregistry-matching-strategy)
7. [Public API](#7-public-api)
8. [Integration Points](#8-integration-points)
9. [Configuration Surface](#9-configuration-surface)

---

## 1. Architecture Overview

### Single Routing Authority

[`ProjectContext`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts) is the single authority on "what project am I in?" All project-root resolution flows through it. The class owns detection, binding, caching, and the tier model — there is no standalone resolution function outside it.

Detection helpers live in [`src/core/detection/`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/detection/) as pure functions. They are **private to `ProjectContext`** — a guard test at `tests/detection-encapsulation.test.js` fails the suite if any other module imports them.

### Component Relationship Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                       server.ts                             │
│  attachRootsHandlers() ──► onRootsChanged(ctx)              │
│  MCP roots ──► getValidRootDirectories() ──► setAllowedDirs │
└──────────────────────────┬──────────────────────────────────┘
                           │ ctx (FsContext)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   ProjectContext                            │
│  getRoot(filePath?)      → _handlePathAccess() or _resolve  │
│  getWorkingRoot(hint?)   → never-null contract              │
│  getStashDb(filePath?)   → project DB or global DB          │
│  refresh()               → re-resolve, preserve explicit    │
│  initProject(rootPath)   → explicit sticky binding          │
│  registerSessionRoot()   → MCP root hint                    │
│  reloadRegistry(entries) → config-file replacement          │
│  pingCallerEnvironment() → process-tree upgrade from global │
│                                                             │
│  Binding Tiers: explicit → registry → detected → global     │
└──────────────────────────┬──────────────────────────────────┘
                           │ consults
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              detection/boundaries.ts  (PRIVATE)             │
│  findProjectBoundary(absPath, opts?) → BoundaryResult|null  │
│  findGitRoot(absPath)                 → string|null         │
│  findMarkerRoot(absPath)              → string|null         │
│  isJunkRoot(p)                        → boolean             │
│  clampToAllowed(candidate, ...)       → string              │
│  PROJECT_MARKERS / MARKER_EXCLUDE_DIRS                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│             detection/process-tree.ts  (PRIVATE)            │
│  getCallerCwds(ttlMs?)               → CwdCandidate[]       │
│  getProcessTreeCwds()                → CwdCandidate[] (raw) │
│  getProcessTreeCwdsResolved()        → CwdCandidate[]       │
└─────────────────────────────────────────────────────────────┘
```

### Singleton Pattern and WeakMap Caching

[`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts) uses a `WeakMap<FsContext, ProjectContext>` to ensure one `ProjectContext` instance per `FsContext` (i.e., per MCP session):

```typescript
let _instances = new WeakMap<FsContext, ProjectContext>();

export function getProjectContext(ctx: FsContext): ProjectContext {
    let instance = _instances.get(ctx);
    if (!instance) {
        instance = new ProjectContext(ctx);
        _instances.set(ctx, instance);
    }
    return instance;
}
```

- **Why WeakMap**: When an `FsContext` is garbage-collected (session ends), the corresponding `ProjectContext` is automatically cleaned up.
- **Per-session isolation**: Each MCP client session gets its own `ProjectContext` with its own bound root, resolution state, tier, and cache-instance salt.

### The FsContext / FilesystemContext Interface Relationship

There are **two** context interfaces that serve different roles:

| Interface | File | Purpose |
|-----------|------|---------|
| [`FsContext`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L24-L27) | `project-context.ts` | Minimal interface used by `ProjectContext`. Only requires `getAllowedDirectories()` and optional `validatePath()`. |
| [`FilesystemContext`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/lib.ts#L17-L22) | `lib.ts` | Full interface used by tools and the server. Adds `setAllowedDirectories()`, `validatePath()`, and `validateNewFilePath()`. |

`FilesystemContext` is a superset of `FsContext`. The server creates a `FilesystemContext` via [`createFilesystemContext()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/lib.ts#L24-L114) and passes it as both `ctx` (to tools) and as `FsContext` (to `ProjectContext`).

---

## 2. The Binding Tier Ladder

`ProjectContext` maintains a four-tier binding model, strongest first. A weaker signal never displaces a stronger one:

| Tier | Set by | Sticky? | Persistence |
|------|--------|---------|-------------|
| **explicit** | `initProject()` / `stashInit` | Yes — survives `refresh()` | Session only |
| **registry** | Config-file `### Projects` match | Re-evaluated on registry reload | Config file |
| **detected** | `findProjectBoundary` (git/marker evidence) | Stands on filesystem evidence | Observation-counted for opt-in auto-promotion |
| **global** | Fallback when nothing matches | Default | `~/.zenith-mcp/global-stash.db` |

### Materialization Policy (Anti-Litter)

Detection is **signal**, promotion is **consent**. Only `explicit` and `registry` tiers may host a `.mcp` database in the user's project directory. Detected roots route persistence to the global DB and are observation-counted for the opt-in `auto_promote_sessions` policy.

`getStashDb()` and `getWorkingRoot()` enforce this: when the binding tier is `detected`, database I/O routes to the neutral workspace at `~/.zenith-mcp/workspace`, never into the user's directories.

### Tier Transitions

- **explicit**: Set once by `initProject()`. Survives `refresh()`, registry reloads, and path evidence. Only a new `initProject()` call or process restart can change it.
- **registry**: Set when `findProject(absPath)` returns a config-file match. Re-evaluated when the registry reloads (config file mtime change). Yields to `explicit`.
- **detected**: Set when `findProjectBoundary()` returns git or marker evidence from a tool-call path. Survives registry reloads (filesystem evidence stands on its own). Yields to `registry` when a registered project claims the exact path (review finding P2-8). Upgrades to `registry` if auto-promotion fires.
- **global**: The initial state and the fallback. Upgrades to any stronger tier when evidence arrives. "No project detected" degrades, never refuses — the never-refuse contract is in `getWorkingRoot()`.

### How Each Tier Is Resolved

#### Explicit

`initProject(rootPath, name?)` resolves to absolute, validates the directory, registers in-memory in the `ProjectRegistry`, and sets `_explicit = true`. No SQLite persistence — the config file is the authoritative source of truth for registration.

#### Registry

`ProjectContext._handlePathAccess()` checks the registry (`_registry.findProject(resolvedPath)`) when a path is outside the current bound root. On miss, a lazy reload reads the config file if its mtime changed. A registry match sets `_tier = 'registry'` and binds to the registered project root.

`_resolveNoFile()` (called when no file path is available) checks if any allowed directory matches a registered project. If so, binds at registry tier. If not, boundary-detects the allowed directories themselves.

#### Detected

Detection occurs at four sites, all funneled through `_detectBoundary()` → `findProjectBoundary()`:

1. **Path evidence**: `_handlePathAccess()` — when a tool-call path is outside the current root AND no registry match is found.
2. **Allowed dirs**: `_resolveNoFile()` — when no file path is available, each allowed directory is boundary-detected.
3. **Caller cwd**: `pingCallerEnvironment()` — the process-tree walk upgrades from global only.
4. **Session roots**: `registerSessionRoot()` — MCP root hints (only upgrades from global).

All four funnel through `_bindDetected()`, which records an observation (once per root per session), notifies the host, and applies the opt-in auto-promotion policy.

#### Global

When nothing matches: `_boundRoot = null`, `_isGlobal = true`, `_tier = 'global'`. Database operations use `~/.zenith-mcp/global-stash.db`. The never-refuse contract in `getWorkingRoot()` provides `~/.zenith-mcp/workspace` as the floor — features degrade, they never refuse.

### Auto-Promotion

When `advanced.auto_promote_sessions` (or the `ZENITH_AUTO_PROMOTE_SESSIONS` env override) is set to a positive threshold N, a detected root that has been observed in N distinct sessions is auto-promoted to `registry` tier in-memory. The config file is never written to uninvited.

Distinct sessions are tracked by a `_sessionMarker` unique per `ProjectContext` instance AND per process: `${process.pid}:${instanceId}:${Date.now()}:${random}`. Observations persist in the global DB's `project_observations` table.

---

## 3. Boundary Detection

### Entry Point: `findProjectBoundary()`

**Source**: [`detection/boundaries.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/detection/boundaries.ts)

The single entry point `ProjectContext` consults. Algorithm: **git → markers**, clamped, junk-filtered, cached.

```typescript
export function findProjectBoundary(
    absPath: string,
    opts?: BoundaryOptions
): BoundaryResult | null
```

`BoundaryOptions`:
- `allowedDirectories` — used for clamping
- `generation` — cache namespace (incremented on refresh/registry reload)
- `cacheSalt` — per-instance isolation (different ProjectContext sessions with different allowed dirs)
- `noCache` — skip cache entirely

Returns `{ root: string; method: 'git' | 'marker' }` or `null`.

### Step 1: Git Root — `findGitRoot()`

**Source**: [`detection/boundaries.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/detection/boundaries.ts)

Pure filesystem walk — no `git` CLI subprocess, no timeout. Walks up from `absPath` checking for a `.git` entry at each level:

- A `.git` **directory** → normal checkout, return that directory as root.
- A `.git` **file** → worktree/submodule pointer, return the containing directory (the worktree itself).
- No `.git` found before filesystem root → return `null`.

```typescript
export function findGitRoot(absPath: string): string | null
```

Git root **outranks** deeper markers. In a monorepo with packages, the repo root is the project identity — subpackage `package.json` files do not fragment DB routing.

### Step 2: Marker Root — `findMarkerRoot()`

**Source**: [`detection/boundaries.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/detection/boundaries.ts)

Only consulted when git detection found nothing. Walks up from `absPath` looking for the first (deepest) directory containing a project marker. Skips vendored/build directories. Stops before the home directory and the filesystem root.

```typescript
export function findMarkerRoot(absPath: string): string | null
```

### Clamping: `clampToAllowed()`

**Source**: [`detection/boundaries.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/detection/boundaries.ts)

Keeps detected roots from escaping the sandbox the user granted. Unlike a prior short-circuit-guard design, a path with **no** containing allowed dir is not rejected — allowed dirs are hints unless sandbox enforcement is on (see [sandbox-mode-note.md](sandbox-mode-note.md)).

Algorithm:
1. If no `allowedDirectories` → return candidate as-is.
2. If candidate is within **any** allowed dir → keep it (prevents over-clamping in monorepos where both `/repo` and `/repo/packages/x` are allowed).
3. If the most specific containing allowed dir is inside the candidate (candidate escaped upward) → clamp down to the allowed dir.
4. Otherwise → return candidate unchanged.

### Junk Filter: `isJunkRoot()`

**Source**: [`detection/boundaries.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/detection/boundaries.ts)

True when a path must never become a project root. Rejects:
- The filesystem root (`/` or `C:\`)
- The home directory itself (subdirectories of home are fine)
- `os.tmpdir()` (evaluated at call time for `TMPDIR` changes)
- Static prefixes: `/tmp`, `/var/tmp`, `/private/tmp`, `/private/var`, `/usr`, `/opt`, `/snap`, `/Applications`, `/System`, `/Library`
- On Windows: `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`

Case-insensitive matching on win32/darwin. Junk filtering is applied **before** clamping — a junk ancestor cannot be "laundered" into a valid-looking allowed subdirectory.

### `PROJECT_MARKERS`

**Source**: [`detection/boundaries.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/detection/boundaries.ts)

```typescript
export const PROJECT_MARKERS: readonly string[] = [
    'package.json', 'Cargo.toml', 'pyproject.toml', 'setup.py',
    'requirements.txt', 'go.mod', 'pom.xml', 'build.gradle',
    'build.gradle.kts', 'composer.json', 'Gemfile', 'mix.exs',
    'stack.yaml', 'CMakeLists.txt', 'deno.json',
];
```

15 markers covering Node.js, Rust, Python, Go, Java/Kotlin, PHP, Ruby, Elixir, Haskell, C/C++, and Deno.

### `MARKER_EXCLUDE_DIRS`

```typescript
export const MARKER_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', 'dist', 'build', 'target', 'vendor',
    '.venv', 'venv', '__pycache__', '.tox', 'out', 'coverage',
]);
```

These directories are **skipped** during the marker walk. If the current directory's basename is in this set, `findMarkerRoot` skips to the parent without checking for markers.

---

## 4. Process-Tree Detection

### Entry Point: `getCallerCwds()`

**Source**: [`detection/process-tree.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/detection/process-tree.ts)

Called by `ProjectContext.pingCallerEnvironment()` on every tool call (at the dispatch seam, never by the model and never via tool schemas). Walks the process tree for candidate working directories. Only upgrades the binding from `global` — it is the weakest signal and never displaces stronger tiers.

```typescript
export function getCallerCwds(ttlMs?: number): CwdCandidate[]
```

Returns `CwdCandidate[]` — each with `{ cwd: string; source: string }` where `source` is a diagnostic label like `"ancestor[1]:bash"` or `"self:cwd"`.

### Platform Support

| Platform | Method | Depth | Notes |
|----------|--------|-------|-------|
| **Linux** | Reads `/proc/{ppid}/status` and `/proc/{ppid}/cwd` | 8 | Full ancestor chain via `ppid` links |
| **macOS** | `lsof -a -p {pid} -d cwd -Fn` + `ps -o ppid=` | 4 | Each ancestor costs an `lsof` exec; bounded at 4 with 2s timeout per call |
| **Windows** | `process.cwd()` only | 1 | Ancestor cwds require native PEB reads — returns own cwd only |

Always ends with `process.cwd()` as the final candidate (`source: 'self:cwd'`). Candidates are realpath'd, deduplicated, and filtered to existing directories.

### TTL Cache

`getCallerCwds` uses a module-level TTL cache (default 5 s). The walk runs at most once per TTL window regardless of how many tool calls ping it. The timestamp is stamped **after** the walk completes — if a slow macOS `lsof` chain stamped before completion, the cache would appear expired-on-arrival (review finding P2-6).

Test hooks: `clearCallerCwdCache()` drops the TTL cache.

### How `pingCallerEnvironment()` Uses It

1. If not resolved yet, calls `_resolveNoFile()`.
2. If tier is not `global`, returns immediately — environment is the weakest signal.
3. For each candidate cwd, skips junk roots via `isJunkRoot()`.
4. Checks the registry first: if a candidate cwd matches a registered project, binds at `registry` tier and returns.
5. Falls back to `findProjectBoundary()` on the candidate cwd. If found, binds at `detected` tier via `_bindDetected()`.

---

## 5. The Caching Layer

### Boundary Cache — Generation-Keyed LRU

**Source**: [`detection/boundaries.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/detection/boundaries.ts)

A module-global `Map<string, BoundaryResult | null>` with manual LRU semantics at `MAX_CACHE_ENTRIES = 512`.

Cache key format:
```
{cacheSalt}:{generation}:{resolvedAbsPath}
```

- **`cacheSalt`**: Per-instance isolation — sessions with different allowed dirs get different cache namespaces (prevents cross-session cache poisoning at coinciding generations).
- **`generation`**: Bumped by `ProjectContext.refresh()` and `reloadRegistry()`. One integer increment invalidates all prior results without embedding allowed-dir paths in every key.
- **`resolvedAbsPath`**: Full resolved path (not just dirname) — a dirname key would collapse sibling directories into one entry (review finding P1-2).

LRU eviction: `Map.keys().next().value` is the oldest entry (insertion order). On set, if `size > MAX_CACHE_ENTRIES`, the oldest is deleted.

`null` is a valid cached value (meaning "no project boundary found"). `undefined` means cache miss.

### Process-Tree Cache — TTL

A separate module-level cache in `detection/process-tree.ts`. Default TTL 5000 ms. Cache is timestamped after walk completion.

### Cache Clearing

- `clearBoundaryCache()` — test hook, clears the boundary LRU.
- `clearCallerCwdCache()` — test hook, drops the process-tree TTL cache.
- `ProjectContext.refresh()` bumps `_generation`, which invalidates all boundary results without clearing them.

---

## 6. The ProjectRegistry Matching Strategy

**Class**: [`ProjectRegistry`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-registry.ts#L36-L184)

The `ProjectRegistry` maintains three index maps:
- `_byId: Map<string, ProjectManifest>` — keyed by `project_id.toLowerCase()`
- `_byName: Map<string, ProjectManifest>` — keyed by `project_name.toLowerCase()`
- `_byPath: Map<string, ProjectManifest>` — keyed by `normalizePath(path.resolve(project_root))`

### Five Matching Strategies (in priority order)

All matching performed by [`findProject(anything)`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-registry.ts#L100-L162):

#### Strategy 1: Exact match on `project_id` (case-insensitive)

#### Strategy 2: Exact match on `project_name` (case-insensitive)

#### Strategy 3: Leading path-segment match on `project_id` or `project_name`

Only triggers when the query contains a path separator. Extracts the first path segment and matches against IDs and names.

**Example**: Query `"cool-api/src/server.py"` → extracts `"cool-api"` → matches against IDs and names.

#### Strategy 4: Exact match on normalized `project_root` path

#### Strategy 5: Path-prefix match (longest root wins)

When the query path is **inside** a registered project root. If multiple roots match as prefixes, returns the **longest** (most specific) root.

### What the Registry Deliberately Does NOT Do

- **No substring/fuzzy matching** — too many false positives
- **No basename-only matching** — ambiguous across projects

### How the Registry Is Populated

**Source**: [`ProjectContext.reloadRegistry()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

The registry is populated from the config file via `reloadRegistry(entries: ProjectEntry[])`. It replaces the registry entirely (atomic replacement — no merge with SQLite rows). The config file is the persistent source of truth.

Steps:
1. For each config entry, resolve and realpath-canonicalize `project_root`.
2. Build `ProjectManifest` objects with all optional fields (`description`, `language`, `tags`, `include`, `exclude`, `entry_point`).
3. Create a new `ProjectRegistry(manifests)` — old registry is GC'd.
4. Bump `_generation` to invalidate boundary cache.
5. Snapshot config mtime for lazy-reload gating.
6. Re-evaluate current binding: if bound at `registry` tier and the root no longer matches any registered project, reset to `global`.
7. Clear notification dedup.

---

## 7. Public API

### `getRoot(filePath?: string): string | null`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

The main entry point for project root resolution.

**With `filePath`**: Calls `_handlePathAccess(filePath)`, which:
1. Fast-path: if path is inside current bound root, checks if a registered project outranks a detected binding (review finding P2-8), then returns.
2. Registry lookup: `_registry.findProject(resolvedPath)`. On miss, lazy-reloads config if mtime changed.
3. If registry matches: binds at registry tier (unless explicit is set).
4. If no registry match: boundary detects via `findProjectBoundary()`.
5. Absence of evidence never demotes an affirmative binding (review finding P2-4).

**Without `filePath`**: Returns current binding. If unresolved, calls `_resolveNoFile()`.

### `getWorkingRoot(hint?: string): string`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

The never-refuse contract. Returns a working root that is NEVER null. Used by tools that need a directory identity (symbol DBs, relative paths).

Resolution order: resolved project root (explicit/registry only — materialization gate) → `~/.zenith-mcp/workspace`.

The workspace directory is created if missing. On pathological failure (read-only home), degrades to `os.homedir()`.

### `getStashDb(filePath?: string): { db, root, isGlobal }`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

Returns either a project-scoped DB or the global DB:
- **Explicit/registry tier + root**: Opens project's `.mcp/symbols.db` → `{ db, root, isGlobal: false }`.
- **Detected tier or no root**: Opens `~/.zenith-mcp/global-stash.db` → `{ db, root: null, isGlobal: true }`.

The materialization gate is here: detected roots route to the global DB. Detection is identity, not consent to create `.mcp` in user directories.

### `refresh(): void`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

Force re-resolution. Called when MCP roots change.
1. Bumps `_generation` (invalidates boundary cache).
2. If not `_explicit`, resets binding state and re-resolves via `_resolveNoFile()`.
3. Explicit bindings are preserved — they are sticky.

### `initProject(rootPath: string, name?: string): string`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

Manually register a project root (called by `stashInit`). In-memory only — config file is the persistent source of truth.

1. Resolves to absolute, validates directory.
2. Registers in-memory in the `ProjectRegistry`.
3. Sets `_explicit = true`, `_tier = 'explicit'` — sticky for the session.

### `registerSessionRoot(rootPath: string, name?: string): void`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

Register an MCP root as a session hint. Does NOT set `_explicit`. Only binds if it matches a registered project, or boundary-detects (only upgrades from global).

### `reloadRegistry(entries: ProjectEntry[]): void`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

Atomic replacement of the registry from config entries. See [How the Registry Is Populated](#how-the-registry-is-populated).

### `pingCallerEnvironment(): void`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

Called by the tool dispatch seam on every tool call. Walks the caller's process tree and upgrades the binding only when currently `global`. See [Process-Tree Detection](#4-process-tree-detection).

### `onRootsChanged(ctx: FsContext): void`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

Hook called by `server.ts` when MCP roots change. Looks up the `ProjectContext` for the given `FsContext` and calls `refresh()`.

### `resetProjectContext(ctx?: FsContext): void`

Test isolation hook. Without `ctx`, clears the entire WeakMap.

---

## 8. Integration Points

### server.ts → ProjectContext

**Source**: [`server.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts)

`attachRootsHandlers()` connects MCP root notifications:

1. **`oninitialized`**: Requests roots via `server.server.listRoots()`. Passes root URIs through `getValidRootDirectories()` (from `roots-utils.ts`). Updates `ctx.setAllowedDirectories()` and calls `onRootsChanged(ctx)`.
2. **`RootsListChangedNotification`**: Re-fetches roots and repeats the update flow.
3. **Fallback**: If client doesn't support MCP roots, falls back to CLI-provided directories.

### refactor_batch.ts → `getProjectContext(ctx)`

**Source**: [`refactor_batch.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/tools/refactor_batch.ts)

```typescript
const pc = getProjectContext(ctx);
```

All six modes use `pc.getWorkingRoot(...)` for project root resolution — never null. The tool no longer uses `findRepoRoot` for root resolution (it uses the standard `ProjectContext` ladder). Hint discipline varies by mode:
- **query**: `pc.getWorkingRoot(resolvedScope)` — user-supplied `fileScope` is path evidence; absent fileScope, resolves hint-free.
- **loadDiff/apply/reapply**: `pc.getWorkingRoot()` — no hint (no user-supplied path in these modes).
- **history**: `pc.getWorkingRoot(resolvedFile)` — if `file` is provided, it's path evidence.
- **restore**: `pc.getWorkingRoot(absPath)` — uses the validated file path.

### edit_file.ts / stash_restore.ts → `getProjectContext(ctx)`

Both tools use `pc.getWorkingRoot(validPath)` for snapshot/versioning DB routing — never null. The old `getRoot || path.dirname` fallback pattern is gone.

### stash.ts → Project-Scoped vs Global DB Routing

**Source**: [`stash.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/stash.ts)

Every stash operation routes through `ProjectContext.getStashDb()`:
- Explicit/registry tier → project's `.mcp/symbols.db`.
- Detected/global tier → `~/.zenith-mcp/global-stash.db`.
- The `isGlobal` flag is surfaced to the user in `stash_restore.ts` list mode.

### Compression → `findRepoRoot` directly

**Source**: [`compression.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/compression.ts)

`compressForTool()` calls `findRepoRoot(validPath)` directly for content-addressable indexing — a pure-fs walk to locate the git root for the symbol DB. This is a best-effort optimization, not a binding decision. On failure, facts degrade to empty arrays and TOON compresses via its text-only path.

### Sandbox Mode

See [sandbox-mode-note.md](sandbox-mode-note.md) for the opt-in enforcement model and planned extensions.

---

## 9. Configuration Surface

### `ZENITH_HOME`

**Source**: [`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts)

```typescript
const ZENITH_HOME = path.join(os.homedir(), '.zenith-mcp');
```

Created on first access. Contains:
- `global-stash.db` — global fallback database
- `workspace/` — neutral workspace for detected/unregistered projects

### `auto_promote_sessions`

Config key: `advanced.auto_promote_sessions` (default `0`). Env override: `ZENITH_AUTO_PROMOTE_SESSIONS`.

When set to N > 0, a detected root observed in N distinct sessions is auto-promoted to registry tier in-memory. Observations track via the global DB's `project_observations` table.

### `char_budget`

Config key: `advanced.char_budget` (default `400_000`, range `10_000`–`2_000_000`). Used by `read_file` for output truncation.

### Path Normalization

**Source**: [`path-utils.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/path-utils.ts)

`normalizePath()` handles tilde expansion, quote stripping, WSL path preservation, Unix-style Windows path conversion, UNC normalization, and drive letter capitalization.

### Root URI Parsing

**Source**: [`roots-utils.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/roots-utils.ts)

`parseRootUri()` handles: `file:///absolute/path`, `file://host/path`, `file:~/path`, `file:path`, bare paths. `getValidRootDirectories()` iterates roots, parses URIs, validates directories.

### DB Schema

**Source**: [`db-adapter.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/db-adapter.ts)

The `project_observations` table (for auto-promotion tracking) is created by `initObservationSchema()`:

```sql
CREATE TABLE IF NOT EXISTS project_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_path TEXT NOT NULL,
    detection_method TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
```

The `project_roots` table (legacy, from `initSymbolSchema()`) persists manually registered projects. The config file is now the authoritative source — SQLite rows are not queried for registry population.
