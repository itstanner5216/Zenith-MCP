# Project Context Detection Methods

> **Zenith-MCP** — Complete reference for how a file path is resolved to its owning project root.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [The Resolution Ladder (Step-by-Step)](#2-the-resolution-ladder-step-by-step)
3. [The Clamping Mechanism](#3-the-clamping-mechanism)
4. [The Caching Layer](#4-the-caching-layer)
5. [The ProjectRegistry Matching Strategy](#5-the-projectregistry-matching-strategy)
6. [Entry Points](#6-entry-points)
7. [Integration Points](#7-integration-points)
8. [Configuration Surface](#8-configuration-surface)

---

## 1. Architecture Overview

### Component Relationship Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                       server.ts                             │
│  attachRootsHandlers() ──► onRootsChanged(ctx)              │
│  MCP roots ──► getValidRootDirectories() ──► setAllowedDirs │
└──────────────────────────┬──────────────────────────────────┘
                           │ ctx (FilesystemContext)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   ProjectContext                            │
│  getRoot(filePath?) → delegates to resolveProjectRoot()     │
│  initProject(rootPath) → persists to SQLite, binds root     │
│  getStashDb(filePath?) → project DB or global DB            │
│  refresh() → clears cache, re-syncs registry, re-resolves  │
└──────────────────────────┬──────────────────────────────────┘
                           │ resolveProjectRoot(filePath, options)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  project-scope.ts                           │
│  Resolution Ladder:                                         │
│    Pre-check: getMostSpecificAllowedRoot()                  │
│    Step 1: findRepoRoot() + clampToAllowed()                │
│    Step 2: _resolveFromMarkers() + clampToAllowed()         │
│    Step 3: _resolveFromAllowedDirectories()                 │
│    Step 4: _resolveFromRegistry() → ProjectRegistry         │
│    Step 5: return null (global fallback)                    │
└──────┬────────────────────────────┬─────────────────────────┘
       │                            │
       ▼                            ▼
┌──────────────┐        ┌───────────────────────┐
│ symbol-index │        │   ProjectRegistry     │
│ findRepoRoot │        │  5-strategy matching  │
│ (git CLI)    │        │  populated from DB    │
└──────────────┘        └───────────────────────┘
```

### Singleton Pattern and WeakMap Caching

[`project-context.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L243-L252) uses a `WeakMap<FsContext, ProjectContext>` to ensure one `ProjectContext` instance per `FsContext` (i.e., per MCP session):

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
- **Per-session isolation**: Each MCP client session gets its own `ProjectContext` with its own bound root, resolution state, and registry sync.

### The FsContext / FilesystemContext Interface Relationship

There are **two** context interfaces that serve different roles:

| Interface | File | Purpose |
|-----------|------|---------|
| [`FsContext`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L24-L27) | `project-context.ts` | Minimal interface used by `ProjectContext`. Only requires `getAllowedDirectories()` and optional `validatePath()`. |
| [`FilesystemContext`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/lib.ts#L17-L22) | `lib.ts` | Full interface used by tools and the server. Adds `setAllowedDirectories()`, `validatePath()`, and `validateNewFilePath()`. |

`FilesystemContext` is a superset of `FsContext`. The server creates a `FilesystemContext` via [`createFilesystemContext()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/lib.ts#L24-L114) and passes it as both `ctx` (to tools) and as `FsContext` (to `ProjectContext`).

**`createFilesystemContext(initialAllowedDirectories)`** ([`lib.ts:24-114`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/lib.ts#L24-L114)):
- Stores `_allowedDirectories` as a private closure variable
- `getAllowedDirectories()` returns a copy of the array
- `setAllowedDirectories(dirs)` replaces the array (called when MCP roots change)
- `validatePath(requestedPath)` resolves and validates paths against allowed directories, including symlink target validation
- `validateNewFilePath(requestedPath)` handles paths where the file doesn't exist yet by walking up to the nearest existing ancestor

---

## 2. The Resolution Ladder (Step-by-Step)

The resolution ladder is the core algorithm. It lives in [`resolveProjectRoot()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L129-L175) in `project-scope.ts`.

### Pre-check: Allowed Directories Guard

**Function**: [`getMostSpecificAllowedRoot()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L100-L107)
**File**: `project-scope.ts:100-107`

**What it does**: Before any detection, checks if the file path falls within any of the allowed directories (MCP roots or CLI args). If not, short-circuits to `null`.

**Algorithm**:
1. If no `allowedDirectories` are provided, returns `null` (no guard).
2. Maps each allowed directory to an absolute resolved path.
3. Filters to only directories that contain the given `absPath` (using `isWithinProject`).
4. Sorts by path length **descending** (longest first = most specific).
5. Returns the first (most specific) match, or `null`.

```typescript
function getMostSpecificAllowedRoot(absPath: string, allowedDirectories?: string[]): string | null {
    if (!allowedDirectories?.length) return null;
    const match = [...allowedDirectories]
        .map(dir => path.resolve(dir))
        .filter(dir => isWithinProject(absPath, dir))
        .sort((a, b) => b.length - a.length)[0];
    return match ?? null;
}
```

**Short-circuit in `resolveProjectRoot`** ([`project-scope.ts:139-142`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L139-L142)):
```typescript
if (options?.allowedDirectories?.length) {
    const allowedRoot = getMostSpecificAllowedRoot(absPath, options.allowedDirectories);
    if (!allowedRoot) return setCached(cacheKey, null);
}
```

If allowed directories are set and the file is outside **all** of them → immediately return `null`.

---

### Step 1: Git Repo Detection via `findRepoRoot`

**Function**: [`findRepoRoot()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/symbol-index.ts#L39-L53)
**File**: `symbol-index.ts:39-53`

**What it does**: Detects the git repository root by shelling out to `git rev-parse --show-toplevel`.

**Algorithm**:
1. `statSync(filePath)` to determine if the path is a file or directory.
2. Sets `cwd` to the directory itself (if directory) or its parent (if file).
3. Runs `execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })`.
4. Returns the trimmed stdout (the git root), or `null` on any error.

```typescript
export function findRepoRoot(filePath: string): string | null {
    try {
        const stat = statSync(filePath);
        const cwd = stat.isDirectory() ? filePath : path.dirname(filePath);
        const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd,
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return result.trim();
    } catch {
        return null;
    }
}
```

**Inputs**: Any file/directory path.
**Outputs**: Absolute path to git root, or `null`.
**Edge cases**:
- Non-git paths → catches error, returns `null`.
- 5-second timeout prevents hanging on network mounts.
- `stdio: ['ignore', 'pipe', 'ignore']` suppresses stderr.

**In `resolveProjectRoot`** ([`project-scope.ts:144-150`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L144-L150)):
```typescript
let gitRoot: string | null = null;
try {
    gitRoot = clampToAllowed(findRepoRoot(absPath), absPath, options?.allowedDirectories);
} catch (_err) {
    // findRepoRoot may throw for non-git paths
}
```

The git root is immediately **clamped** to allowed directories via `clampToAllowed()` (see [Section 3](#3-the-clamping-mechanism)).

---

### Step 2: Marker-Based Detection via `_resolveFromMarkers`

**Function**: [`_resolveFromMarkers()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L272-L310)
**File**: `project-scope.ts:272-310`

**What it does**: Walks up from the file path looking for project marker files (like `package.json`, `Cargo.toml`, etc.). Finds the **deepest** marker within the git root boundary, enabling monorepo package detection.

**Algorithm**:
1. **Determine the ceiling**: Tries `findRepoRoot(absPath)` to get the git root. If no git root, uses the filesystem root (`/` or `C:\`).
2. **Walk upward**: Starting from `path.dirname(absPath)`, walks up directory-by-directory.
3. **Skip excluded directories**: If the current directory's basename is in `MARKER_EXCLUDE_DIRS`, skip it and continue to parent.
4. **Check for markers**: For each non-excluded directory, checks `fs.existsSync(path.join(dir, marker))` for every marker in `PROJECT_MARKERS` (~15 checks per directory).
5. **Collect candidates**: If a marker is found, the directory is added to `candidates[]`.
   - **Without git ceiling** (ceiling is filesystem root): Returns the **first** (deepest) match immediately.
   - **With git ceiling**: Continues collecting candidates up to the ceiling, then returns `candidates[0]` (the deepest).

```typescript
function _resolveFromMarkers(absPath: string): string | null {
    let ceiling: string;
    try {
        const gitRoot = findRepoRoot(absPath);
        ceiling = gitRoot ?? path.parse(absPath).root;
    } catch (_err) {
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
            if (PROJECT_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) {
                candidates.push(dir);
                if (!ceiling || ceiling === fsRoot) return dir;
            }
        } catch (_err) { /* Unreadable directory — skip */ }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return candidates[0] ?? null;
}
```

**Key behavior**:
- In a monorepo like `/repo/packages/app` where `/repo` is the git root:
  - `candidates` may collect both `/repo/packages/app` (has `package.json`) and `/repo` (has `package.json`).
  - Returns `candidates[0]` = `/repo/packages/app` (deepest marker wins).
- Uses targeted `existsSync` per marker (~15 checks) rather than `readdir`, which is more efficient for large directories.

**After marker resolution** ([`project-scope.ts:155-164`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L155-L164)):
```typescript
const markerRoot = clampToAllowed(_resolveFromMarkers(absPath), absPath, options?.allowedDirectories);

// Prefer the deepest (most specific) root between git and markers.
if (markerRoot && gitRoot) {
    const result = markerRoot.length >= gitRoot.length ? markerRoot : gitRoot;
    return setCached(cacheKey, result);
}
if (markerRoot) return setCached(cacheKey, markerRoot);
if (gitRoot) return setCached(cacheKey, gitRoot);
```

**Selection logic**: If both git root and marker root are found, the **longer path** (more specific) wins. In a monorepo, the marker root (`/repo/packages/app`) beats the git root (`/repo`).

---

### Step 3: MCP Roots / Allowed Directories Fallback

**Function**: [`_resolveFromAllowedDirectories()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L215-L261)
**File**: `project-scope.ts:215-261`

**What it does**: When Steps 1 and 2 both fail (no git, no markers), falls back to allowed directories. Tries git detection on each allowed directory, then falls back to path containment.

**Algorithm**:
1. Returns `null` if no allowed directories.
2. Sorts directories (for deterministic results matching cache key ordering).
3. **Git on allowed dirs**: For each allowed directory, runs `findRepoRoot(resolvedDir)`:
   - If git root is found and the **allowed dir is within** the git root → use the allowed dir (clamps upward escape).
   - If the git root is within/equal to the allowed dir → use the git root.
   - If `absPath` is within the effective root → return it.
4. **Single-directory fallback**: If exactly one allowed directory exists and `absPath` is inside it → return it.
5. **Most-specific allowed dir**: Find the longest allowed directory path that contains `absPath`.

```typescript
function _resolveFromAllowedDirectories(absPath: string, allowedDirectories?: string[]): string | null {
    // ... (sort, iterate allowed dirs with git, single-dir fallback, longest-match)
}
```

**Edge case**: When `findRepoRoot(allowedDir)` succeeds but the git root is **above** the allowed directory (e.g., allowed = `/repo/packages/pkg`, git root = `/repo`), the function uses the allowed directory to prevent sandbox escape.

---

### Step 4: Registry Matching via `_resolveFromRegistry`

**Function**: [`_resolveFromRegistry()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L315-L323)
**File**: `project-scope.ts:315-323`

**What it does**: Checks against explicitly registered project entries (from SQLite DB or provided manifests).

```typescript
function _resolveFromRegistry(absPath: string, registryEntries?: ProjectManifest[]): string | null {
    if (!registryEntries || registryEntries.length === 0) return null;
    const registry = new ProjectRegistry(registryEntries);
    return registry.findProjectRoot(absPath);
}
```

Creates a temporary `ProjectRegistry` from the entries and calls `findProjectRoot(absPath)`, which delegates to `findProject(absPath)` (see [Section 5](#5-the-projectregistry-matching-strategy)).

---

### Step 5: Global Fallback

If all steps fail, `resolveProjectRoot` returns `null`:

```typescript
return setCached(cacheKey, null);
```

In `ProjectContext`, a `null` root sets `_isGlobal = true` and operations fall back to the global SQLite database at `~/.zenith-mcp/global-stash.db`.

---

## 3. The Clamping Mechanism

### `clampToAllowed()`

**Function**: [`clampToAllowed()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L109-L127)
**File**: `project-scope.ts:109-127`

**Purpose**: Ensures that detected roots (git or marker) don't escape outside the allowed directories sandbox. This is critical for security — MCP clients define allowed directories as a trust boundary.

**Algorithm**:
1. If no allowed directories → return candidate as-is (no clamping).
2. Get the most specific allowed root for `absPath`.
3. If no allowed root for this path → return `null` (path is outside sandbox).
4. If candidate is `null` → return `null`.
5. **Within-any-allowed check**: If the candidate is within or equal to ANY allowed directory, return it as-is. This prevents over-clamping in monorepos.
6. **Candidate above allowed**: If the allowed root is inside the candidate (candidate is a parent), clamp down to the allowed root.
7. **Candidate within allowed**: If the candidate is inside the allowed root, keep it.
8. Otherwise → return `null`.

```typescript
function clampToAllowed(candidate: string | null, absPath: string, allowedDirectories?: string[]): string | null {
    if (!allowedDirectories?.length) return candidate;
    const allowedRoot = getMostSpecificAllowedRoot(absPath, allowedDirectories);
    if (!allowedRoot) return null;
    if (!candidate) return null;

    // Prevent over-clamping: if candidate is within ANY allowed dir, keep it.
    const resolvedAllowed = allowedDirectories.map(dir => path.resolve(dir));
    if (resolvedAllowed.some(dir => isWithinProject(candidate, dir))) return candidate;

    // Candidate is above the allowed root — clamp down
    if (isWithinProject(allowedRoot, candidate)) return allowedRoot;
    // Candidate is within the allowed root — keep it
    if (isWithinProject(candidate, allowedRoot)) return candidate;
    return null;
}
```

**Example — Monorepo over-clamp prevention**:
- Allowed directories: `[/repo, /repo/packages/pkg]`
- Git root detected: `/repo`
- `getMostSpecificAllowedRoot` returns `/repo/packages/pkg` (longest match)
- Without the "within-any-allowed" check, `/repo` would be clamped to `/repo/packages/pkg` (wrong!)
- The check `resolvedAllowed.some(dir => isWithinProject(candidate, dir))` finds that `/repo` is within `/repo` → returns `/repo` unchanged.

### `isWithinProject()`

**Function**: [`isWithinProject()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L180-L184)
**File**: `project-scope.ts:180-184`

Simple path containment check:
```typescript
export function isWithinProject(filePath: string, projectRoot: string): boolean {
    const resolvedFile = path.resolve(filePath);
    const resolvedRoot = path.resolve(projectRoot);
    return resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep);
}
```

Handles exact match (path equals root) and prefix match (path starts with root + separator).

---

## 4. The Caching Layer

### Cache Key Construction

**Function**: [`buildCacheKey()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L53-L63)
**File**: `project-scope.ts:53-63`

```typescript
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
```

**Format**: `<absPath>::<sorted-allowed-dirs-joined-by-pipe>::<sorted-registry-roots-joined-by-pipe>`

**Properties**:
- Deterministic: Same inputs always produce the same key (sorting ensures order-independence).
- Context-sensitive: Different allowed directories or registry entries produce different keys.

### LRU Eviction Policy

**Implementation**: [`getCached()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L65-L72) and [`setCached()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L74-L82)
**File**: `project-scope.ts:65-82`

Uses a `Map<string, string | null>` with manual LRU semantics:

```typescript
// GET: delete-and-re-insert to move to end (most recently used)
function getCached(key: string): string | null | undefined {
    const value = _cache.get(key);
    if (value === undefined) return undefined;
    _cache.delete(key);
    _cache.set(key, value);
    return value;
}

// SET: evict oldest when over capacity
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

- **MAX_CACHE_ENTRIES**: `512` (see [Section 8](#8-configuration-surface)).
- ES `Map` iteration order is insertion order, so `_cache.keys().next().value` is the oldest entry.
- `getCached` returns `undefined` for cache miss, `null` for a cached "no project found" result.

### Cache Clearing

**Function**: [`clearProjectScopeCache()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L199-L201)
**File**: `project-scope.ts:199-201`

```typescript
export function clearProjectScopeCache(): void {
    _cache.clear();
}
```

Called by `ProjectContext.refresh()` when MCP roots change.

### Cache Bypass

`resolveProjectRoot` supports `options.noCache` ([`project-scope.ts:133-136`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L133-L136)):
```typescript
if (!options?.noCache) {
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached;
}
```

Used by `search_files.ts` in structural mode to force fresh resolution.

---

## 5. The ProjectRegistry Matching Strategy

**Class**: [`ProjectRegistry`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-registry.ts#L36-L184)
**File**: `project-registry.ts`

The `ProjectRegistry` maintains three index maps for fast lookup:
- `_byId: Map<string, ProjectManifest>` — keyed by `project_id.toLowerCase()`
- `_byName: Map<string, ProjectManifest>` — keyed by `project_name.toLowerCase()`
- `_byPath: Map<string, ProjectManifest>` — keyed by `normalizePath(path.resolve(project_root))`

### Five Matching Strategies (in priority order)

All matching is performed by [`findProject(anything)`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-registry.ts#L100-L162):

#### Strategy 1: Exact match on `project_id` (case-insensitive)

```typescript
const lowered = query.toLowerCase();
let match = this._byId.get(lowered);
if (match) return match;
```

#### Strategy 2: Exact match on `project_name` (case-insensitive)

```typescript
match = this._byName.get(lowered);
if (match) return match;
```

#### Strategy 3: Leading path-segment match on `project_id` or `project_name`

Only triggers when the query contains a path separator (`/` or `\`):

```typescript
if (query.includes('/') || query.includes(path.sep)) {
    const firstSegmentRaw = query.split(/[\\/]/)[0];
    const firstSegment = firstSegmentRaw?.trim().toLowerCase();
    if (firstSegment) {
        match = this._byId.get(firstSegment);
        if (match) return match;
        match = this._byName.get(firstSegment);
        if (match) return match;
    }
}
```

**Example**: Query `"cool-api/src/server.py"` → extracts `"cool-api"` → matches against IDs and names.

#### Strategy 4: Exact match on normalized `project_root` path

```typescript
let normalizedPath: string;
try {
    normalizedPath = normalizePath(path.resolve(query));
} catch {
    return null;
}
match = this._byPath.get(normalizedPath);
if (match) return match;
```

#### Strategy 5: Path-prefix match (longest root wins)

When the query path is **inside** a registered project root:

```typescript
const prefixMatches: ProjectManifest[] = [];
for (const [rootPath, manifest] of this._byPath) {
    if (
        normalizedPath.startsWith(rootPath + path.sep) ||
        normalizedPath === rootPath
    ) {
        prefixMatches.push(manifest);
    }
}
if (prefixMatches.length > 0) {
    return prefixMatches.reduce((best, current) =>
        current.project_root.length > best.project_root.length ? current : best
    );
}
```

If multiple project roots match as prefixes, returns the **longest** (most specific) root.

### What the Registry Deliberately Does NOT Do

From the [source comment](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-registry.ts#L31-L33):
- **No substring/fuzzy matching** — too many false positives
- **No basename-only matching** — ambiguous across projects

### How the Registry Is Populated

The registry is populated from the SQLite database via [`ProjectContext._syncRegistry()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L186-L200):

```typescript
private _syncRegistry(): void {
    try {
        const conn = getGlobalDb();
        const rows = getAllProjectRootPaths(conn);
        for (const row of rows) {
            this._registry.register({
                project_id: row.name || path.basename(row.root_path),
                project_name: row.name,
                project_root: row.root_path,
            });
        }
    } catch {
        // Registry might be empty or DB not ready yet
    }
}
```

Data comes from the `project_roots` table in the global DB (`~/.zenith-mcp/global-stash.db`), populated by `initProject()`.

---

## 6. Entry Points

### `ProjectContext.getRoot(filePath?)`

**Method**: [`getRoot()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L78-L104)
**File**: `project-context.ts:78-104`

The main entry point for all project root resolution.

**Logic**:
1. **If `filePath` is provided**: Calls `_resolveFromPath(filePath)` which delegates to `resolveProjectRoot()`.
   - **Auto-promote**: If no root was explicitly bound (via `initProject`), and either nothing is resolved yet or the bound root is null, the first successfully resolved root is "auto-promoted" as the session-wide bound root. This means session-wide tools inherit the project context from the first file-specific operation.
   - Returns the file-specific root.
2. **If already resolved**: Returns the cached `_boundRoot` (which may be `null` for global).
3. **Otherwise**: Runs `_resolve()` which resolves from `process.cwd()` using the full ladder.

```typescript
getRoot(filePath?: string): string | null {
    if (filePath) {
        const fileRoot = this._resolveFromPath(filePath);
        if (fileRoot) {
            // Auto-promote: first-touched repo becomes bound root
            if (!this._explicit && (!this._resolved || !this._boundRoot)) {
                this._boundRoot = fileRoot;
                this._isGlobal = false;
                this._resolved = true;
            }
            return fileRoot;
        }
    }
    if (this._resolved) {
        return this._boundRoot;
    }
    this._resolve();
    return this._boundRoot;
}
```

### `ProjectContext.initProject(rootPath, name?)`

**Method**: [`initProject()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L146-L171)
**File**: `project-context.ts:146-171`

Manually registers a project root, persisting it to the global SQLite DB.

**Steps**:
1. Resolves to absolute path, validates it's a directory.
2. Upserts into `project_roots` table via `upsertProjectRoot()`.
3. Registers in the in-memory `ProjectRegistry` for immediate use.
4. **Sticky bind**: Sets `_boundRoot = abs`, `_explicit = true`. This overrides auto-promote — the explicit binding is permanent for the session.

### `onRootsChanged(ctx?)`

**Function**: [`onRootsChanged()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L258-L268)
**File**: `project-context.ts:258-268`

Hook called by `server.ts` when MCP roots change. Looks up the `ProjectContext` for the given `FsContext` and calls `refresh()`.

`refresh()` ([`project-context.ts:132-140`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L132-L140)):
1. Resets all internal state (`_boundRoot`, `_isGlobal`, `_resolved`, `_explicit`).
2. Clears the `project-scope.ts` cache via `clearProjectScopeCache()`.
3. Re-syncs the registry from the global DB.
4. Re-resolves from `process.cwd()`.

### `ProjectContext.getStashDb(filePath?)`

**Method**: [`getStashDb()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L109-L119)
**File**: `project-context.ts:109-119`

Returns either a project-scoped DB or the global DB for stash operations:
- If `getRoot(filePath)` returns a root → opens the project's `.mcp/symbols.db` and ensures stash tables exist → returns `{ db, root, isGlobal: false }`.
- If no root → opens the global DB at `~/.zenith-mcp/global-stash.db` → returns `{ db, root: null, isGlobal: true }`.

---

## 7. Integration Points

### server.ts → ProjectContext

**File**: [`server.ts:128-191`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L128-L191)

`attachRootsHandlers()` connects MCP root notifications to the project context system:

1. **`oninitialized`** ([`server.ts:157-190`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L157-L190)): On client connection, requests roots via `server.server.listRoots()`. Passes root URIs through `getValidRootDirectories()` (from `roots-utils.ts`) which parses `file://` URIs, expands tildes, resolves symlinks, and validates directories. Updates `ctx.setAllowedDirectories()` and calls `onRootsChanged(ctx)`.

2. **`RootsListChangedNotification`** ([`server.ts:140-155`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L140-L155)): When the client sends a roots-changed notification, re-fetches roots and repeats the same update flow.

3. **Fallback** ([`server.ts:177-188`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L177-L188)): If the client doesn't support MCP roots, falls back to CLI-provided directories. Throws if neither is available.

### search_files.ts → `resolveProjectRoot` directly

**File**: [`search_files.ts:214-218`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/tools/search_files.ts#L214-L218)

The structural similarity mode bypasses `ProjectContext` and calls `resolveProjectRoot()` directly:

```typescript
const repoRoot = resolveProjectRoot(rootPath, {
    allowedDirectories: ctx.getAllowedDirectories(),
    noCache: true,
}) ?? rootPath;
```

Uses `noCache: true` to force fresh resolution and falls back to `rootPath` if no project root is found. This direct call is used because structural search needs a repo root for the symbol index database, not session-wide project binding.

### refactor_batch.ts → `getProjectContext(ctx)`

**File**: [`refactor_batch.ts:270`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/tools/refactor_batch.ts#L270)

```typescript
const pc = getProjectContext(ctx);
```

Uses the singleton pattern to get the session's `ProjectContext`, then calls `pc.getRoot(rootHint)` with various hints:
- **query mode** ([`refactor_batch.ts:283`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/tools/refactor_batch.ts#L283)): Uses `pc.getRoot(rootHint)` where `rootHint` is either the resolved `fileScope` or the first allowed directory.
- **loadDiff/apply/reapply modes** ([`refactor_batch.ts:350-351`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/tools/refactor_batch.ts#L350-L351)): Uses `pc.getRoot(allowedDirs[0])` — first allowed directory as hint.

### edit_file.ts → `findRepoRoot` directly

**File**: [`edit_file.ts:82`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/tools/edit_file.ts#L82)

```typescript
const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
```

Bypasses `ProjectContext` entirely. Uses `findRepoRoot()` directly with a fallback to the file's parent directory. This is used only for the versioning/snapshot subsystem (best-effort), not for access control.

### stash.ts → Project-Scoped vs Global DB Routing

**File**: [`stash.ts:20-24`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/stash.ts#L20-L24)

```typescript
function getDb(ctx: FsContext, filePath?: string): { conn: DbConnection; isGlobal: boolean } {
    const pc = getProjectContext(ctx);
    const { db, isGlobal } = pc.getStashDb(filePath);
    return { conn: db, isGlobal };
}
```

Every stash operation routes through `ProjectContext.getStashDb()`:
- If a project root is found → stash entries go to the project's `.mcp/symbols.db`.
- If no project → stash entries go to `~/.zenith-mcp/global-stash.db`.
- The `isGlobal` flag is surfaced to the user in `stash_restore.ts` list mode: `"(global stash — no project detected)"`.

### stash_restore.ts → `findRepoRoot` for versioning

**File**: [`stash_restore.ts:155`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/tools/stash_restore.ts#L155)

After applying a stashed edit, snapshots are saved using `findRepoRoot()`:
```typescript
const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
```

Same pattern as `edit_file.ts` — direct git detection for best-effort versioning.

---

## 8. Configuration Surface

### PROJECT_MARKERS (15 markers)

**Location**: [`project-scope.ts:17-33`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L17-L33)

```typescript
const PROJECT_MARKERS = [
    'package.json',      // Node.js / JavaScript / TypeScript
    'Cargo.toml',        // Rust
    'pyproject.toml',    // Python (modern)
    'setup.py',          // Python (legacy)
    'requirements.txt',  // Python (pip)
    'go.mod',            // Go
    'pom.xml',           // Java (Maven)
    'build.gradle',      // Java/Kotlin (Gradle)
    'build.gradle.kts',  // Kotlin (Gradle KTS)
    'composer.json',     // PHP
    'Gemfile',           // Ruby
    'mix.exs',           // Elixir
    'stack.yaml',        // Haskell
    'CMakeLists.txt',    // C/C++ (CMake)
    '.git',              // Git directory itself
];
```

### MARKER_EXCLUDE_DIRS (12 excluded directories)

**Location**: [`project-scope.ts:35-48`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L35-L48)

```typescript
const MARKER_EXCLUDE_DIRS = new Set([
    'node_modules',   // JS dependency directory
    '.git',           // Git internals
    'dist',           // Build output
    'build',          // Build output
    'target',         // Rust/Java build output
    'vendor',         // Go/PHP vendor
    '.venv',          // Python virtual env
    'venv',           // Python virtual env
    '__pycache__',    // Python cache
    '.tox',           // Python testing
    'out',            // Build output
    'coverage',       // Test coverage reports
]);
```

These directories are **skipped** during the marker walk-up. If the current directory's `basename` is in this set, `_resolveFromMarkers` skips to the parent without checking for markers.

### MAX_CACHE_ENTRIES

**Location**: [`project-scope.ts:50`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L50)

```typescript
const MAX_CACHE_ENTRIES = 512;
```

Maximum entries in the LRU cache. When exceeded, the oldest (least recently used) entry is evicted.

### ZENITH_HOME Directory

**Location**: [`project-context.ts:17`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L17)

```typescript
const ZENITH_HOME = path.join(os.homedir(), '.zenith-mcp');
```

Resolves to `~/.zenith-mcp`. Created on first access if it doesn't exist.

### GLOBAL_DB_PATH

**Location**: [`project-context.ts:18`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L18)

```typescript
const GLOBAL_DB_PATH = path.join(ZENITH_HOME, 'global-stash.db');
```

Resolves to `~/.zenith-mcp/global-stash.db`. This SQLite database contains:
- **`project_roots` table**: Manually registered projects (via `initProject`). Schema: `root_path TEXT PRIMARY KEY, name TEXT, created_at INTEGER`.
- **`stash` table**: Global stash entries for files outside any detected project.

### Path Normalization

**File**: [`path-utils.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/path-utils.ts)

[`normalizePath()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/path-utils.ts#L36-L113) handles:
- Null/undefined passthrough
- Null byte rejection
- Quote stripping
- Tilde expansion (via `expandHome()`)
- WSL path preservation (`/mnt/c/...` stays as-is)
- Unix-style Windows path conversion (`/c/...` → `C:\...`)
- UNC path normalization
- Drive letter capitalization
- Multiple slash collapsing

[`expandHome()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/path-utils.ts#L120-L125):
```typescript
export function expandHome(filepath: string): string {
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}
```

### Root URI Parsing

**File**: [`roots-utils.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/roots-utils.ts)

[`parseRootUri()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/roots-utils.ts#L7-L44) handles these URI formats:
- `file:///absolute/path` — standard file URI
- `file://host/path` — UNC-style file URI
- `file:~/path` — non-standard tilde expansion
- `file:path` — non-standard relative path
- `/absolute/path` — bare path (no scheme)

[`getValidRootDirectories()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/roots-utils.ts#L54-L76) iterates roots, parses each URI, validates it's an existing directory, and returns the list of valid paths.

### DB Operations for Project Roots

**File**: [`db-adapter.ts:645-678`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/db-adapter.ts#L645-L678)

Three operations on the `project_roots` table:

| Function | SQL | Purpose |
|----------|-----|---------|
| [`upsertProjectRoot()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/db-adapter.ts#L652-L662) | `INSERT OR REPLACE INTO project_roots (root_path, name, created_at) VALUES (?, ?, ?)` | Register or update a project root |
| [`listProjectRoots()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/db-adapter.ts#L667-L670) | `SELECT * FROM project_roots ORDER BY created_at DESC` | List all roots (newest first) |
| [`getAllProjectRootPaths()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/db-adapter.ts#L675-L678) | `SELECT root_path, name FROM project_roots` | Get just paths/names (for registry sync) |

The global schema is initialized by [`initGlobalSchema()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/db-adapter.ts#L182-L190):
```sql
CREATE TABLE IF NOT EXISTS project_roots (
    root_path TEXT PRIMARY KEY,
    name TEXT,
    created_at INTEGER
);
```

---
---

## 9. MCP Roots Protocol — Usage & Implementation

This section documents how Zenith-MCP implements the MCP roots protocol — the mechanism by which an MCP client (e.g. Claude Desktop, Cursor, OpenCode) tells the server which filesystem directories the agent is working with.

---

### 9.1 MCP Roots Protocol Overview

The [MCP roots protocol](https://modelcontextprotocol.io/docs/concepts/roots) allows a client to declare which filesystem roots (directories) it considers relevant to the current session. Zenith-MCP uses these roots as the **allowed directories** — the security boundary that controls which files the server can access.

**Two MCP events drive roots handling:**

1. **`initialized` callback** — fired once after the MCP handshake completes. The server proactively requests roots from the client via `server.server.listRoots()`.
2. **`notifications/roots/list_changed` notification** — fired whenever the client's roots change (e.g. user opens a new project folder). The server re-fetches roots and updates allowed directories.

Both events are handled in [`attachRootsHandlers()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L128-L191) using the `@modelcontextprotocol/sdk`:

```typescript
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
```

---

### 9.2 Bootstrapping: How Roots Are Initially Set

#### Stdio Mode ([`cli/stdio.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/cli/stdio.ts))

The stdio entrypoint follows this sequence:

1. **Parse CLI args** → extract directory arguments (line 18): `const dirArgs = args.filter(a => !a.startsWith('--'));`
2. **Resolve directories** → [`resolveInitialAllowedDirectories(dirArgs)`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L30-L41) expands `~`, resolves to absolute paths, follows symlinks via `realpath`
3. **Validate** → [`validateDirectories()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L43-L59) checks that all paths are accessible directories
4. **Create context** → `createFilesystemContext(allowedDirectories)` (line 41) creates the `FilesystemContext` with these dirs as the initial allowed set
5. **Attach roots handlers** → `attachRootsHandlers(server, ctx)` (line 45) registers the MCP roots event handlers
6. **Connect transport** → `server.connect(transport)` (line 48) starts the MCP session

```typescript
// cli/stdio.ts — simplified flow
const allowedDirectories = await resolveInitialAllowedDirectories(dirArgs);
await validateDirectories(allowedDirectories);
const ctx = createFilesystemContext(allowedDirectories);
const server = createFilesystemServer(ctx);
attachRootsHandlers(server, ctx);
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Zero-directory startup** (line 53): If no CLI directories are provided, the server starts with an empty `_allowedDirectories` array and logs `"Started without allowed directories - waiting for client to provide roots via MCP protocol"`. This is valid — the client will provide roots during the `initialized` callback.

#### HTTP Mode ([`server/http.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/server/http.ts))

The HTTP entrypoint differs significantly:

1. **Parse CLI args** → same as stdio (lines 62–71)
2. **Resolve baseline dirs** → [`resolveInitialAllowedDirectories(dirArgs)`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L30-L41) produces `baselineAllowedDirs` (line 80)
3. **Per-session creation** → each HTTP session gets its own `FilesystemContext` via [`createSessionPair()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/server/http.ts#L141-L146):

```typescript
// http.ts:141-146
function createSessionPair() {
    const ctx = createFilesystemContext([...baselineAllowedDirs]);  // copy!
    const server = createFilesystemServer(ctx);
    attachRootsHandlers(server, ctx);
    return { ctx, server };
}
```

The `[...baselineAllowedDirs]` spread creates an independent copy, so each session starts with the same baseline but can diverge when MCP roots change.

---

### 9.3 The `attachRootsHandlers` Flow (Step by Step)

**Function**: [`attachRootsHandlers()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L128-L191)
**File**: `server.ts:128-191`

#### The `updateAllowedDirectoriesFromRoots()` Inner Function

This is the core pipeline that transforms MCP root URIs into allowed directories:

```typescript
// server.ts:129-138
async function updateAllowedDirectoriesFromRoots(
    requestedRoots: Array<{ uri: string; name?: string }>
): Promise<void> {
    const validatedRootDirs = await getValidRootDirectories(requestedRoots);
    if (validatedRootDirs.length > 0) {
        ctx.setAllowedDirectories(validatedRootDirs);
        onRootsChanged(ctx);
        console.error(`Updated allowed directories from MCP roots: ${validatedRootDirs.length} valid directories`);
    } else {
        console.error("No valid root directories provided by client");
    }
}
```

**Step-by-step**:
1. Receives `Array<{ uri: string; name?: string }>` from the MCP SDK's `listRoots()` response
2. Passes to [`getValidRootDirectories()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/roots-utils.ts#L54-L76) for URI→path resolution + validation
3. If any valid directories result: calls `ctx.setAllowedDirectories(validatedRootDirs)` to **replace** (not merge) the session's allowed dirs
4. Calls [`onRootsChanged(ctx)`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L258-L268) to refresh the `ProjectContext`
5. If no valid directories: logs a warning but preserves existing allowed dirs

#### The `oninitialized` Callback

```typescript
// server.ts:157-189
server.server.oninitialized = async () => {
    const clientCapabilities = server.server.getClientCapabilities();
    if (clientCapabilities?.roots) {
        try {
            const response = await server.server.listRoots();
            if (response && 'roots' in response) {
                await updateAllowedDirectoriesFromRoots(
                    response.roots.map(r =>
                        r.name !== undefined
                            ? { uri: r.uri, name: r.name }
                            : { uri: r.uri }
                    )
                );
            } else {
                console.error("Client returned no roots set, keeping current settings");
            }
        } catch (error) {
            console.error("Failed to request initial roots from client:",
                error instanceof Error ? error.message : String(error));
        }
    } else {
        const currentDirs = ctx.getAllowedDirectories();
        if (currentDirs.length > 0) {
            console.error("Client does not support MCP Roots, using allowed directories set from server args:", currentDirs);
        } else {
            throw new Error(
                `Server cannot operate: No allowed directories available. ...`
            );
        }
    }
};
```

**Decision tree**:
1. Check `getClientCapabilities()?.roots` — does the client support the roots protocol?
2. **Client supports roots**: Call `listRoots()` → extract root objects → pipe to `updateAllowedDirectoriesFromRoots()`
3. **Client doesn't support roots + has CLI dirs**: Log and continue with CLI-provided dirs
4. **Client doesn't support roots + no CLI dirs**: Throw fatal error — the server cannot operate without any allowed directories

#### The `RootsListChangedNotification` Handler

```typescript
// server.ts:140-155
server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    try {
        const response = await server.server.listRoots();
        if (response && 'roots' in response) {
            await updateAllowedDirectoriesFromRoots(
                response.roots.map(r =>
                    r.name !== undefined
                        ? { uri: r.uri, name: r.name }
                        : { uri: r.uri }
                )
            );
        }
    } catch (error) {
        console.error("Failed to request roots from client:",
            error instanceof Error ? error.message : String(error));
    }
});
```

**Behavior**:
- Fires when the client sends `notifications/roots/list_changed`
- Re-fetches roots via `listRoots()` and updates directories
- Errors are caught and logged — the notification handler never crashes the server
- Does NOT check `clientCapabilities` again (the notification implies the client supports roots)

---

### 9.4 URI Parsing & Validation (`roots-utils.ts`)

**File**: [`roots-utils.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/roots-utils.ts)

#### `parseRootUri()` — URI to Path Conversion

**Function**: [`parseRootUri()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/roots-utils.ts#L7-L44)

Handles multiple URI formats:

| Input Format | Handling | Example |
|:---|:---|:---|
| `file:///absolute/path` | Standard: `fileURLToPath(new URL(rootUri))` | `file:///home/user/project` → `/home/user/project` |
| `file://host/path` | Authority stripped: `afterScheme.indexOf('/', 2)` | `file://localhost/home/user` → `/home/user` |
| `file:~` / `file:~/path` | Tilde expanded before URL parsing | `file:~/projects/app` → `/home/user/projects/app` |
| `file:relative` | Fallback: extracts path portion directly | `file:myproject` → resolved to absolute |
| `/absolute/path` | Bare path: passed through directly | `/home/user/project` → `/home/user/project` |
| `~/relative` | Not handled at this layer | Passed to `expandHome` via path resolution |

**Critical path** for tilde URIs (lines 20–21):
```typescript
if (pathPart === '~' || pathPart.startsWith('~/')) {
    rawPath = pathPart;
}
```
This intercepts tilde paths BEFORE `new URL()` processing, because `new URL('file:~/repo')` normalizes the path to `/~` and loses the home-directory expansion semantics.

After extraction, the raw path is:
1. **Tilde-expanded**: `rawPath === '~' || rawPath.startsWith('~/')` → `path.join(os.homedir(), rawPath.slice(1))`
2. **Resolved to absolute**: `path.resolve(expandedPath)`
3. **Symlink-resolved**: `await fs.realpath(absolutePath)`
4. **Normalized**: `normalizePath(resolvedPath)`

If any step throws (e.g. non-existent path for `realpath`), the entire function returns `null`.

#### `getValidRootDirectories()` — Validation Pipeline

**Function**: [`getValidRootDirectories()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/roots-utils.ts#L54-L76)

```typescript
export async function getValidRootDirectories(
    requestedRoots: Array<{ uri: string; name?: string }>
) {
    const validatedDirectories: string[] = [];
    for (const requestedRoot of requestedRoots) {
        const resolvedPath = await parseRootUri(requestedRoot.uri);
        if (!resolvedPath) {
            console.error(formatDirectoryError(requestedRoot.uri, undefined, 'invalid path or inaccessible'));
            continue;
        }
        try {
            const stats = await fs.stat(resolvedPath);
            if (stats.isDirectory()) {
                validatedDirectories.push(resolvedPath);
            } else {
                console.error(formatDirectoryError(resolvedPath, undefined, 'non-directory root'));
            }
        } catch (error) {
            console.error(formatDirectoryError(resolvedPath, error));
        }
    }
    return validatedDirectories;
}
```

**Validation steps per root**:
1. Parse URI → absolute path (or skip if null)
2. `fs.stat()` → must succeed (path must exist)
3. `stats.isDirectory()` → must be a directory (files are rejected)
4. Accepted → added to output array

**Important**: The `name` field from each root is passed through but **never used** — only `requestedRoot.uri` is accessed.

---

### 9.5 The Roots → AllowedDirectories → ProjectContext Pipeline

When MCP roots are received, data flows through a multi-stage pipeline:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MCP Client                                        │
│  Sends roots: [{ uri: "file:///home/user/project", name: "My Project" }]  │
└─────────────────────────────┬───────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  server.ts: updateAllowedDirectoriesFromRoots()                            │
│    └─ getValidRootDirectories(requestedRoots)   ◄── roots-utils.ts         │
│         └─ parseRootUri(uri) for each root      ◄── URI → abs path         │
│         └─ fs.stat() + isDirectory() check      ◄── validation             │
│    └─ Result: validatedRootDirs: string[]                                  │
└─────────────────────────────┬───────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  lib.ts: ctx.setAllowedDirectories(validatedRootDirs)                      │
│    └─ Replaces _allowedDirectories closure variable                        │
│    └─ All subsequent validatePath() calls use new dirs                     │
└─────────────────────────────┬───────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  project-context.ts: onRootsChanged(ctx)                                   │
│    └─ Looks up ProjectContext in WeakMap via ctx                            │
│    └─ Calls instance.refresh()                                             │
│         └─ Clears _boundRoot, _isGlobal, _resolved, _explicit              │
│         └─ Clears project-scope.ts LRU cache                               │
│         └─ Re-syncs ProjectRegistry from SQLite DB                         │
│         └─ Re-resolves project root from process.cwd()                     │
└─────────────────────────────┬───────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Next tool call:                                                            │
│    └─ ctx.getAllowedDirectories() returns updated dirs                      │
│    └─ resolveProjectRoot() uses new dirs in Steps 1-3                      │
│    └─ ProjectContext.getRoot() returns new project root                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key detail**: `ctx.setAllowedDirectories()` at [`lib.ts:31-34`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/lib.ts#L31-L34) replaces the internal `_allowedDirectories` array entirely:

```typescript
function setAllowedDirectories(directories: string[]) {
    _allowedDirectories = [...directories];
}
```

This means the update is **atomic from the array perspective** but **not atomic from the tool's perspective** — a tool that read `getAllowedDirectories()` before the update and uses the result after the update has stale data.

---

### 9.6 Per-Session Isolation (HTTP Server)

The HTTP server at [`server/http.ts`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/server/http.ts) provides full session isolation:

**Session storage** (lines 89–104):
```typescript
interface StreamableSession {
    type: 'streamable';
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    ctx: FilesystemContext;       // ← each session has its own ctx
    lastSeenAt: number;
}
```

**Session creation** — [`createSessionPair()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/server/http.ts#L141-L146):
- Creates a fresh `FilesystemContext` with a copy of `baselineAllowedDirs`
- Creates a fresh `McpServer` instance
- Attaches roots handlers scoped to this session's `ctx`

**Isolation guarantees**:
1. Roots changes in Session A don't affect Session B (different `ctx` objects, different `_allowedDirectories` arrays)
2. Each session's `ProjectContext` is independent (WeakMap keyed by `ctx`)
3. Each session's `McpServer` has its own notification handlers

**Session lifecycle**:
- Created on first `POST /mcp` with `initialize` request, or on `GET /sse`
- Tracked in `sessions: Map<string, SessionEntry>`
- Reaped after idle timeout (`SESSION_TTL_MS`, configured via `config.advanced.session_ttl_ms`)
- Cleaned up on transport close or `DELETE /mcp`

**Transport types** — both get identical roots handling:
| Transport | Creation | Roots Support |
|:---|:---|:---|
| Streamable HTTP (`POST /mcp`) | On `initialize` request | Full — `oninitialized` + notifications |
| Legacy SSE (`GET /sse`) | On SSE connection | Full — `oninitialized` + notifications |

---

### 9.7 Stdio vs HTTP Root Handling Differences

| Aspect | Stdio Mode | HTTP Mode |
|:---|:---|:---|
| **Context instances** | Single `ctx` for the entire server | One `ctx` per session |
| **Roots changes scope** | Affect the entire server | Session-scoped only |
| **Baseline dirs** | Set once at startup, replaced by client roots | Copied per-session at session creation |
| **Transport** | Single `StdioServerTransport` | Multiple concurrent transports |
| **`attachRootsHandlers` call** | Once at startup | Once per session |
| **ProjectContext instances** | One (keyed by single ctx) | One per session (WeakMap isolation) |

**Shared behavior**: Both modes call `attachRootsHandlers(server, ctx)` identically. Both support starting with zero CLI dirs and relying on MCP roots. Both replace (not merge) dirs when client sends roots.

---

### 9.8 `resolveInitialAllowedDirectories` — CLI Args to Paths

**Function**: [`resolveInitialAllowedDirectories()`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L30-L41)
**File**: `server.ts:30-41`

Transforms CLI directory arguments into normalized, resolved paths:

```typescript
export async function resolveInitialAllowedDirectories(args: string[]): Promise<string[]> {
    return Promise.all(args.map(async (dir: string) => {
        const expanded = expandHome(dir);
        const absolute = path.resolve(expanded);
        try {
            const resolved = await fs.realpath(absolute);
            return normalizePath(resolved);
        } catch {
            return normalizePath(absolute);
        }
    }));
}
```

**Steps per argument**:
1. `expandHome(dir)` — expands `~` and `~/...` to the user's home directory
2. `path.resolve(expanded)` — resolves to absolute path from CWD
3. `fs.realpath(absolute)` — resolves symlinks (falls back to unresolved path on error)
4. `normalizePath(resolved)` — normalizes slashes, drive letters, etc.

**Note**: Does not deduplicate. If the user passes the same directory twice (even via different representations like `/home/user` and `~`), both resolved copies appear in the result array.

---

### 9.9 Test Coverage

#### roots-utils.test.js ([`tests/roots-utils.test.js`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/tests/roots-utils.test.js))

Tests `getValidRootDirectories()`:
| Test | Coverage |
|:---|:---|
| Valid `file://` URI | Standard URI → resolved path |
| Plain path (no `file://`) | Bare path → resolved path |
| `file:~` and `file:~/...` | Non-standard tilde expansion |
| Non-existent path | Returns empty array |
| File (not directory) | Skipped, returns empty array |
| Empty input | Returns `[]` |
| Mixed valid/invalid | Only valid dirs returned |

#### core-server.test.js ([`tests/core-server.test.js`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/tests/core-server.test.js))

Tests `attachRootsHandlers()` comprehensively:

| Test Group | Tests |
|:---|:---|
| `oninitialized` — client supports roots | Calls `listRoots`, updates dirs, calls `onRootsChanged` |
| `oninitialized` — empty roots | Does not throw, does not update dirs |
| `oninitialized` — client doesn't support roots | Falls back to CLI dirs, throws if none available |
| `oninitialized` — no `roots` key in response | Does not throw |
| `RootsListChanged` notification | Updates dirs from notification, catches `listRoots` errors |
| `oninitialized` error handling | Catches `listRoots` timeout gracefully |
| `updateAllowedDirectoriesFromRoots` | Logs when no valid dirs provided |

**Coverage gaps**:
- No integration tests for the full roots → project context → tool call pipeline
- No tests for HTTP per-session isolation
- No tests for the replace-vs-merge behavior (CLI dirs being overwritten by MCP roots)
- No tests for concurrent roots change notifications during tool execution (TOCTOU)
- No tests for duplicate root deduplication (or lack thereof)

