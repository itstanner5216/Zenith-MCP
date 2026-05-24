# Project Scoping & MCP Roots — Fix Plan

**Date**: 2026-05-23  
**Status**: Proposed fixes for real-world failures  
**Constraint**: Every fix must be fully automated. Zero user intervention. No flags, no config, no manual directory specification.  

---

## The Core Problem

The project scoping system has **four fatal flaws** that cascade into total failure:

1. The server **crashes** instead of falling back to global context
2. Git detection **always fails** because the server's process CWD is never inside the target project
3. MCP roots **always fails** because errors in the `oninitialized` async callback are unhandled
4. When allowed directories are empty, **every tool call throws** instead of degrading gracefully

The global fallback exists (`~/.zenith-mcp/global-stash.db`) but is never reached because the code crashes before getting there.

---

## Issue 1: `oninitialized` Crash — Server Dies On Startup

### What Happens

In stdio mode without CLI directory flags:

```
stdio.ts:28  → allowedDirectories = []  (empty — no CLI args)
stdio.ts:41  → ctx = createFilesystemContext([])
stdio.ts:48  → server.connect(transport)
               ↓ MCP handshake completes
server.ts:157 → oninitialized fires
server.ts:158 → getClientCapabilities()
```

**If client supports roots but `listRoots()` fails** (common — many clients claim `roots` capability but don't implement `listRoots` correctly, or the notification channel isn't ready yet):

```
server.ts:161 → listRoots() throws or returns empty
server.ts:171 → console.error("Client returned no roots set...")
               → function returns without setting dirs
               → allowedDirectories still []
```

**If client does NOT support roots** (e.g., many Claude Desktop versions, custom clients):

```
server.ts:176 → clientCapabilities?.roots is falsy
server.ts:177 → currentDirs = ctx.getAllowedDirectories() → []
server.ts:178 → currentDirs.length > 0 → FALSE
server.ts:181 → throw new Error("Server cannot operate...")
               → UNHANDLED PROMISE REJECTION → PROCESS CRASHES
```

### Root Cause

[`server.ts:181-187`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L181-L187) — `throw new Error(...)` inside an async callback assigned to `server.server.oninitialized`. The MCP SDK may or may not await this callback. If it doesn't (or if the rejection propagates without a handler), Node.js terminates the process on unhandled rejection.

### Fix

**Never throw from `oninitialized`. Never crash. Use MCP's native `sendLoggingMessage` to notify the client, and fall through to global context.**

```typescript
// server.ts — REPLACE the oninitialized callback (lines 157-190)

server.server.oninitialized = async () => {
    const clientCapabilities = server.server.getClientCapabilities();
    
    if (clientCapabilities?.roots) {
        try {
            const response = await server.server.listRoots();
            if (response && 'roots' in response && response.roots.length > 0) {
                await updateAllowedDirectoriesFromRoots(response.roots.map(r =>
                    r.name !== undefined ? { uri: r.uri, name: r.name } : { uri: r.uri }
                ));
            } else {
                console.error("Client returned empty roots, keeping current settings");
            }
        } catch (error) {
            console.error("Failed to request initial roots from client:",
                error instanceof Error ? error.message : String(error));
        }
    }

    // After all roots attempts: if we still have no dirs, inform the client
    // but NEVER crash. The global fallback handles this.
    const currentDirs = ctx.getAllowedDirectories();
    if (currentDirs.length === 0) {
        console.error(
            "No allowed directories configured. Operating in global-only mode. " +
            "Tools will use process.cwd() or file paths directly."
        );
        try {
            await server.sendLoggingMessage({
                level: "warning",
                logger: "zenith-mcp",
                data: "No project directories configured. Operating in global fallback mode. " +
                      "Provide directories via CLI args or MCP roots for project-scoped features.",
            });
        } catch {
            // sendLoggingMessage may fail if transport isn't ready — ignore
        }
    }
};
```

**Key change**: The `throw new Error(...)` is removed entirely. The server continues running in global-only mode.

---

## Issue 2: `_resolve()` Uses `process.cwd()` — Git Detection Always Fails

### What Happens

When `ProjectContext.getRoot()` is called without a `filePath`, it falls through to `_resolve()`:

```typescript
// project-context.ts:202-220
_resolve(): void {
    this._resolved = true;
    const root = resolveProjectRoot(process.cwd(), {   // ← HERE
        allowedDirectories: this._ctx.getAllowedDirectories(),
        registryEntries: this._registry.listProjects(),
    });
    // ...
}
```

`process.cwd()` is the MCP server's working directory, which is:
- **Stdio mode**: Whatever directory the MCP client launched the server from — typically `/`, `$HOME`, or the client app's install directory. NOT the user's project.
- **HTTP mode**: The directory where the HTTP server binary was started — again, NOT the user's project.

So `findRepoRoot(process.cwd())` calls `git rev-parse --show-toplevel` from `/home/tanner` or `/` — which returns null because those aren't git repos.

### Root Cause

[`project-context.ts:206`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L206) — `_resolve()` hardcodes `process.cwd()` as the resolution target. This was probably written assuming the server runs from inside a project directory, but MCP servers are launched by client apps, not by the user in a terminal.

### Fix

**`_resolve()` should try multiple sources in order: allowed directories first (these ARE the user's projects), then process.cwd() as last resort.**

```typescript
// project-context.ts — REPLACE _resolve() (lines 202-220)

_resolve(): void {
    this._resolved = true;

    const allowedDirs = this._ctx.getAllowedDirectories();
    const registryEntries = this._registry.listProjects();

    // Try each allowed directory as a candidate — these are the actual
    // project dirs provided by the client via MCP roots or CLI args.
    for (const dir of allowedDirs) {
        const root = resolveProjectRoot(dir, {
            allowedDirectories: allowedDirs,
            registryEntries,
        });
        if (root) {
            this._boundRoot = root;
            this._isGlobal = false;
            return;
        }
    }

    // Try process.cwd() as a fallback — may work if server was started
    // from inside a project directory.
    const cwdRoot = resolveProjectRoot(process.cwd(), {
        allowedDirectories: allowedDirs,
        registryEntries,
    });
    if (cwdRoot) {
        this._boundRoot = cwdRoot;
        this._isGlobal = false;
        return;
    }

    // Global fallback — this is fine. The server operates without a
    // bound project. Tools will resolve per-file when given file paths.
    this._boundRoot = null;
    this._isGlobal = true;
}
```

**Why this works**: When a client sends roots `[file:///home/tanner/Projects/Zenith-MCP]`, the allowed directories contain `/home/tanner/Projects/Zenith-MCP`. Resolving from THAT directory finds the `.git` and markers. Resolving from `process.cwd()` (which is probably `/home/tanner`) does not.

---

## Issue 3: `validatePath` Throws When `_allowedDirectories` Is Empty

### What Happens

When no allowed directories are set (the empty-array case from Issue 1), every tool call that validates a path throws:

```typescript
// lib.ts:42
const isAllowed = isPathWithinAllowedDirectories(normalizedRequested, _allowedDirectories);
```

`isPathWithinAllowedDirectories` with an empty array returns `false` for ALL paths → `validatePath` throws `"Access denied - path outside allowed directories"` → **every single tool call fails**.

The tools can't even get to the project context resolution because path validation kills them first.

### Root Cause

[`lib.ts:42-44`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/lib.ts#L42-L44) — `isPathWithinAllowedDirectories` with `[]` rejects everything. There's no "open mode" for when no directories are configured.

### Fix

**When `_allowedDirectories` is empty, path validation should be permissive (allow everything) rather than restrictive (deny everything). The allowed-directories system is opt-in security — if no sandbox is defined, there is no sandbox.**

```typescript
// lib.ts — MODIFY validatePath (around line 42) and validateNewFilePath (around line 99)

async function validatePath(requestedPath: string) {
    const expandedPath = expandHome(requestedPath);
    const absolute = path.isAbsolute(expandedPath)
        ? path.resolve(expandedPath)
        : path.resolve(process.cwd(), expandedPath);
    const normalizedRequested = normalizePath(absolute);

    // When no allowed directories are configured, operate in open mode.
    // The sandbox is opt-in — if no boundary is defined, don't enforce one.
    if (_allowedDirectories.length > 0) {
        const isAllowed = isPathWithinAllowedDirectories(normalizedRequested, _allowedDirectories);
        if (!isAllowed) {
            throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${_allowedDirectories.join(', ')}`);
        }
    }

    try {
        const realPath = await fs.realpath(absolute);
        const normalizedReal = normalizePath(realPath);
        if (_allowedDirectories.length > 0 && !isPathWithinAllowedDirectories(normalizedReal, _allowedDirectories)) {
            throw new Error(`Access denied - symlink target outside allowed directories: ${realPath} not in ${_allowedDirectories.join(', ')}`);
        }
        return realPath;
    } catch (error: unknown) {
        if (hasCode(error) && error.code === 'ENOENT') {
            const parentDir = path.dirname(absolute);
            try {
                const realParentPath = await fs.realpath(parentDir);
                const normalizedParent = normalizePath(realParentPath);
                if (_allowedDirectories.length > 0 && !isPathWithinAllowedDirectories(normalizedParent, _allowedDirectories)) {
                    throw new Error(`Access denied - parent directory outside allowed directories`);
                }
                return absolute;
            } catch (parentError) {
                if (!hasCode(parentError)) throw parentError;
                throw new Error(`Parent directory does not exist: ${parentDir}`);
            }
        }
        throw error;
    }
}
```

Same pattern for `validateNewFilePath`: guard the `isPathWithinAllowedDirectories` check with `_allowedDirectories.length > 0`.

---

## Issue 4: `resolveProjectRoot` Guard Short-Circuits When File Is Outside Allowed Dirs

### What Happens

```typescript
// project-scope.ts:138-142
if (options?.allowedDirectories?.length) {
    const allowedRoot = getMostSpecificAllowedRoot(absPath, options.allowedDirectories);
    if (!allowedRoot) return setCached(cacheKey, null);  // ← SHORT CIRCUIT
}
```

If allowed directories are set but the file being resolved isn't inside any of them, the entire resolution ladder is skipped. This is a security guard — but it's too aggressive. It means:

1. Files in the CWD (which is rarely in the allowed dirs) → null, always
2. Files referenced by relative paths from tools → may resolve outside allowed dirs → null

Combined with Issue 2 (`_resolve()` uses `process.cwd()`), this guard is what makes `_resolve()` always return null even when allowed dirs are set: `process.cwd()` isn't inside the allowed dirs, so the guard fires and short-circuits.

### Root Cause

[`project-scope.ts:139-141`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L139-L141) — The guard treats "file outside allowed dirs" as "no project" when it should mean "skip to the allowed-dirs-based resolution (Step 3)".

### Fix

**The guard should skip Steps 1-2 (file-based git/marker detection) but still try Step 3 (allowed-dirs fallback) and Step 4 (registry). The whole point of Step 3 is to handle the case where the file path itself isn't useful.**

```typescript
// project-scope.ts — MODIFY resolveProjectRoot (lines 129-175)

export function resolveProjectRoot(filePath: string, options?: ResolveOptions): string | null {
    const absPath = path.resolve(filePath);
    const cacheKey = buildCacheKey(absPath, options);

    if (!options?.noCache) {
        const cached = getCached(cacheKey);
        if (cached !== undefined) return cached;
    }

    // Check if the path is within any allowed directory
    const pathInsideAllowed = !options?.allowedDirectories?.length ||
        !!getMostSpecificAllowedRoot(absPath, options.allowedDirectories);

    // Steps 1-2 only run when the path is inside allowed directories
    // (or when no allowed directories are configured)
    if (pathInsideAllowed) {
        // Step 1: Git root from the file path
        let gitRoot: string | null = null;
        try {
            gitRoot = clampToAllowed(findRepoRoot(absPath), absPath, options?.allowedDirectories);
        } catch (_err) {
            // findRepoRoot may throw for non-git paths
        }

        // Step 2: Marker-based detection
        const markerRoot = clampToAllowed(_resolveFromMarkers(absPath), absPath, options?.allowedDirectories);

        // Prefer the deepest (most specific) root
        if (markerRoot && gitRoot) {
            const result = markerRoot.length >= gitRoot.length ? markerRoot : gitRoot;
            return setCached(cacheKey, result);
        }
        if (markerRoot) return setCached(cacheKey, markerRoot);
        if (gitRoot) return setCached(cacheKey, gitRoot);
    }

    // Step 3: MCP roots / allowed directories (ALWAYS runs — this is the
    // fallback for when the file path itself isn't inside a known project)
    const allowedRoot = _resolveFromAllowedDirectories(absPath, options?.allowedDirectories);
    if (allowedRoot) return setCached(cacheKey, allowedRoot);

    // Step 4: Registry matching (ALWAYS runs)
    const registryRoot = _resolveFromRegistry(absPath, options?.registryEntries);
    if (registryRoot) return setCached(cacheKey, registryRoot);

    return setCached(cacheKey, null);
}
```

**Why this works**: Even when `process.cwd()` is `/home/tanner` (outside allowed dirs), Step 3 still runs and finds the allowed directory `/home/tanner/Projects/Zenith-MCP`, tries git on it, and returns the project root.

---

## Issue 5: `updateAllowedDirectoriesFromRoots` Replaces Instead of Merging

### What Happens

```typescript
// server.ts:132
ctx.setAllowedDirectories(validatedRootDirs);
```

This completely replaces the allowed directories. If the server was started with CLI args, those dirs are wiped out when the client sends roots. Conversely, if the client sends roots and later sends an update with fewer roots, previously-accessible dirs become inaccessible.

### Root Cause

[`server.ts:132`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/server.ts#L132) — `setAllowedDirectories` replaces the array.

### Fix

**Merge client roots with existing dirs. Deduplicate.**

```typescript
// server.ts — MODIFY updateAllowedDirectoriesFromRoots (lines 129-138)

async function updateAllowedDirectoriesFromRoots(
    requestedRoots: Array<{ uri: string; name?: string }>
): Promise<void> {
    const validatedRootDirs = await getValidRootDirectories(requestedRoots);
    if (validatedRootDirs.length > 0) {
        // Merge with existing dirs instead of replacing.
        // CLI-provided dirs are the baseline — roots ADD to them.
        const existingDirs = ctx.getAllowedDirectories();
        const merged = [...new Set([...existingDirs, ...validatedRootDirs])];
        ctx.setAllowedDirectories(merged);
        onRootsChanged(ctx);
        console.error(`Updated allowed directories from MCP roots: ${merged.length} total directories (${validatedRootDirs.length} from roots)`);
    } else {
        console.error("No valid root directories provided by client");
    }
}
```

---

## Issue 6: `findRepoRoot` Has No Fallback When `git` Binary Isn't Available

### What Happens

`findRepoRoot` calls `execFileSync('git', ...)`. If `git` isn't in the server process's `PATH` (common when MCP servers are launched by GUI apps like Claude Desktop on macOS, where the PATH is minimal), the call throws and returns null. **Every git detection attempt silently fails.**

Additionally, `.git` is in the `PROJECT_MARKERS` list, so `_resolveFromMarkers` can find it via `existsSync`. But `findRepoRoot` (which calls the `git` CLI) is called FIRST in both Step 1 and inside `_resolveFromMarkers` for ceiling detection. If git CLI fails, marker detection still runs but with `ceiling = fsRoot` (filesystem root), which causes it to walk all the way up and may pick a wrong root.

### Root Cause

[`symbol-index.ts:43`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/symbol-index.ts#L43) — `execFileSync('git', ...)` with no PATH fallback, no git binary resolution, no `.git` directory detection fallback.

### Fix

**Add a pure-filesystem `.git` directory walk-up as the primary detection, with git CLI as an optional enhancement. The `.git` directory IS the indicator — you don't need to shell out to `git` to find it.**

```typescript
// symbol-index.ts — REPLACE findRepoRoot (lines 39-53)

/**
 * Find the git repository root for a given file or directory path.
 * 
 * Strategy:
 * 1. Walk up from the path looking for a `.git` directory (pure filesystem, no CLI needed)
 * 2. If found, optionally verify with `git rev-parse` for worktree/submodule accuracy
 * 3. Falls back to the .git directory's parent if git CLI is unavailable
 */
export function findRepoRoot(filePath: string): string | null {
    try {
        const stat = statSync(filePath);
        let dir = stat.isDirectory() ? filePath : path.dirname(filePath);

        // Walk up looking for .git — this ALWAYS works, no external dependency
        while (true) {
            try {
                const gitPath = path.join(dir, '.git');
                const gitStat = statSync(gitPath);
                if (gitStat.isDirectory() || gitStat.isFile()) {
                    // Found .git — try git CLI for accuracy (handles worktrees,
                    // submodules), but fall back to this dir if git isn't available
                    try {
                        const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
                            cwd: dir,
                            encoding: 'utf-8',
                            timeout: 5000,
                            stdio: ['ignore', 'pipe', 'ignore'],
                        });
                        return result.trim();
                    } catch {
                        // git CLI unavailable or failed — the .git parent IS the root
                        return dir;
                    }
                }
            } catch {
                // No .git here — continue walking up
            }

            const parent = path.dirname(dir);
            if (parent === dir) break; // reached filesystem root
            dir = parent;
        }

        return null;
    } catch {
        return null;
    }
}
```

**Why this works**: The `.git` directory walk is a pure Node.js `statSync` call — no external binaries, no PATH issues, no timeout risk. It works everywhere, always. The git CLI is only used as an optional refinement for edge cases (worktrees, submodules).

---

## Issue 7: `_resolveFromMarkers` Calls `findRepoRoot` Redundantly For Ceiling

### What Happens

```typescript
// project-scope.ts:274-279
let ceiling: string;
try {
    const gitRoot = findRepoRoot(absPath);  // ← SECOND call to findRepoRoot
    ceiling = gitRoot ?? path.parse(absPath).root;
} catch (_err) {
    ceiling = path.parse(absPath).root;
}
```

`_resolveFromMarkers` calls `findRepoRoot` AGAIN to determine the ceiling. This means:
- Git CLI is invoked twice per resolution (once in Step 1, once in Step 2)
- If git CLI fails in Step 1 but succeeds in Step 2 (or vice versa), results are inconsistent
- Double the timeout risk (2 × 5s = 10s potential hang)

### Root Cause

[`project-scope.ts:275`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/utils/project-scope.ts#L275) — No result sharing between steps.

### Fix

**Pass the git root from Step 1 into Step 2 as a parameter instead of re-detecting it.**

```typescript
// project-scope.ts — MODIFY _resolveFromMarkers signature and resolveProjectRoot

function _resolveFromMarkers(absPath: string, gitRoot?: string | null): string | null {
    // Use the pre-detected git root as ceiling instead of re-detecting
    const ceiling = gitRoot ?? path.parse(absPath).root;

    const candidates: string[] = [];
    let dir = path.dirname(absPath);
    const fsRoot = path.parse(absPath).root;

    while (dir.length >= ceiling.length && dir !== fsRoot) {
        // ... rest unchanged
    }
    return candidates[0] ?? null;
}

// In resolveProjectRoot, pass gitRoot to _resolveFromMarkers:
// Step 1: detect git root (once)
let rawGitRoot: string | null = null;
try {
    rawGitRoot = findRepoRoot(absPath);
} catch {}
let gitRoot = clampToAllowed(rawGitRoot, absPath, options?.allowedDirectories);

// Step 2: pass git root to markers
const markerRoot = clampToAllowed(
    _resolveFromMarkers(absPath, rawGitRoot),  // pass RAW (unclamped) git root as ceiling
    absPath,
    options?.allowedDirectories
);
```

---

## Issue 8: `RootsListChangedNotification` Handler — No Guard Against TOCTOU

### What Happens

The notification handler can fire while a tool is mid-execution. The tool already captured `getAllowedDirectories()` and is using those dirs, but the handler replaces them. The tool continues with stale dirs — which is fine for the current call. But `onRootsChanged(ctx)` also calls `refresh()` which clears the `ProjectContext` cache and re-resolves, potentially changing the project root while a tool is using the old one.

### Fix

**This is low-priority but should be documented. The real fix is that `refresh()` should not clear `_explicit` bindings — if a project was explicitly bound via `initProject()`, a roots change should not unbind it.**

```typescript
// project-context.ts — MODIFY refresh() (lines 132-140)

refresh(): void {
    // Don't reset explicit bindings — initProject() is sticky
    if (!this._explicit) {
        this._boundRoot = null;
        this._isGlobal = false;
        this._resolved = false;
    }
    clearProjectScopeCache();
    this._syncRegistry();
    if (!this._explicit) {
        this._resolve();
    }
}
```

---

## Issue 9: `parseRootUri` Swallows All Errors — No Diagnostics

### What Happens

When a client sends roots and parsing fails, the only log is `"Skipping invalid path or inaccessible: file:///whatever"` — no indication of WHY. Was the path malformed? Does the directory not exist? Permission denied? Symlink loop?

### Fix

**Return the error detail from `parseRootUri` and include it in the log.**

```typescript
// roots-utils.ts — MODIFY parseRootUri to return error detail

async function parseRootUri(rootUri: string): Promise<{ path: string } | { error: string }> {
    try {
        let rawPath: string;
        // ... existing parsing logic ...
        
        const expandedPath = /* ... */;
        const absolutePath = path.resolve(expandedPath);
        
        try {
            const resolvedPath = await fs.realpath(absolutePath);
            return { path: normalizePath(resolvedPath) };
        } catch (err) {
            // realpath failed — path doesn't exist or permission error
            // Try stat to distinguish "not found" from "permission denied"
            try {
                await fs.stat(absolutePath);
                return { path: normalizePath(absolutePath) };
            } catch (statErr) {
                const code = statErr instanceof Error && 'code' in statErr ? (statErr as any).code : '';
                return { error: `${absolutePath}: ${code === 'ENOENT' ? 'does not exist' : code === 'EACCES' ? 'permission denied' : String(statErr)}` };
            }
        }
    } catch (err) {
        return { error: `failed to parse URI "${rootUri}": ${err instanceof Error ? err.message : String(err)}` };
    }
}

// MODIFY getValidRootDirectories to use the new return type:
export async function getValidRootDirectories(requestedRoots: Array<{ uri: string; name?: string }>) {
    const validatedDirectories: string[] = [];
    for (const requestedRoot of requestedRoots) {
        const result = await parseRootUri(requestedRoot.uri);
        if ('error' in result) {
            console.error(`Skipping root "${requestedRoot.name ?? requestedRoot.uri}": ${result.error}`);
            continue;
        }
        try {
            const stats = await fs.stat(result.path);
            if (stats.isDirectory()) {
                validatedDirectories.push(result.path);
            } else {
                console.error(`Skipping non-directory root: ${result.path}`);
            }
        } catch (error) {
            console.error(`Skipping inaccessible root ${result.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return validatedDirectories;
}
```

---

## Issue 10: Tools That Bypass `ProjectContext` — Fragmented Resolution

### What Happens

`edit_file.ts` (line 82) and `stash_restore.ts` (line 155) both do:
```typescript
const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
```

This bypasses the entire `ProjectContext` system. If `findRepoRoot` fails (see Issue 6), the fallback is `path.dirname(validPath)` — the file's parent directory. This creates `.mcp/symbols.db` databases in random directories.

### Fix

**Replace direct `findRepoRoot` calls with `getProjectContext(ctx).getRoot(filePath)` — the same API every other tool uses.**

```typescript
// edit_file.ts — REPLACE line 82
// BEFORE: const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
// AFTER:
import { getProjectContext } from '../core/project-context.js';
const pc = getProjectContext(ctx);
const repoRoot = pc.getRoot(validPath) || path.dirname(validPath);

// stash_restore.ts — REPLACE line 155 (same pattern)
import { getProjectContext } from '../core/project-context.js';
const pc = getProjectContext(ctx);
const repoRoot = pc.getRoot(validPath) || path.dirname(validPath);
```

---

## Issue 11: No Deduplication of Allowed Directories

### Fix

```typescript
// server.ts — MODIFY resolveInitialAllowedDirectories (lines 30-41)

export async function resolveInitialAllowedDirectories(args: string[]): Promise<string[]> {
    const resolved = await Promise.all(args.map(async (dir: string) => {
        const expanded = expandHome(dir);
        const absolute = path.resolve(expanded);
        try {
            const resolvedPath = await fs.realpath(absolute);
            return normalizePath(resolvedPath);
        } catch {
            return normalizePath(absolute);
        }
    }));
    return [...new Set(resolved)]; // deduplicate
}
```

---

## Issue 12: Unused MCP Root `name` Field — Missed Opportunity

The `name` field from MCP roots is carefully preserved through the pipeline but never used. It should seed the `ProjectRegistry` for better project detection.

### Fix

```typescript
// server.ts — MODIFY updateAllowedDirectoriesFromRoots

async function updateAllowedDirectoriesFromRoots(
    requestedRoots: Array<{ uri: string; name?: string }>
): Promise<void> {
    const validatedRootDirs = await getValidRootDirectories(requestedRoots);
    if (validatedRootDirs.length > 0) {
        const existingDirs = ctx.getAllowedDirectories();
        const merged = [...new Set([...existingDirs, ...validatedRootDirs])];
        ctx.setAllowedDirectories(merged);

        // Seed ProjectRegistry with root names from MCP roots
        const pc = getProjectContext(ctx);
        for (const root of requestedRoots) {
            if (root.name) {
                const parsed = await parseRootUri(root.uri);
                if (parsed && 'path' in parsed && validatedRootDirs.includes(parsed.path)) {
                    try {
                        pc.initProject(parsed.path, root.name);
                    } catch {
                        // initProject may fail if path isn't a directory — ignore
                    }
                }
            }
        }

        onRootsChanged(ctx);
        console.error(`Updated allowed directories from MCP roots: ${merged.length} total directories`);
    } else {
        console.error("No valid root directories provided by client");
    }
}
```

---

## Issue 13: `onRootsChanged(ctx?)` — Silent No-Op Sabotage

### What Happens

The current implementation:

```typescript
// project-context.ts:258-268
export function onRootsChanged(ctx?: FsContext): void {
    if (ctx) {
        const instance = _instances.get(ctx);
        if (instance) {
            instance.refresh();
        }
        return;
    }
    // Without a ctx we cannot iterate a WeakMap. Callers should pass their
    // ctx for proper per-session refresh.
}
```

The `ctx` parameter is **optional**. When called without it, the function does **absolutely nothing** — no warning, no error, no log, no fallback. It's a silent no-op pretending to be a handler. Some agent wrote this because they couldn't figure out how to iterate a `WeakMap` (you can't — that's by design) and instead of solving the problem, they made the argument optional and added a comment that says "callers should pass their ctx" while making the function signature actively suggest that not passing it is fine.

This is a time bomb. The function signature says "ctx is optional", which means any future caller (or refactor) that invokes `onRootsChanged()` without `ctx` will silently corrupt the system — every `ProjectContext` instance retains stale cached project roots, directing stash operations, symbol indexing, and database routing to the wrong project root. The function looks like it succeeded but did nothing.

### Root Cause

[`project-context.ts:258`](file:///home/tanner/Projects/Zenith-MCP/packages/zenith-mcp/src/core/project-context.ts#L258) — Lazy implementation. Optional parameter hides a broken code path.

### Fix

**Nuke the optional parameter. `ctx` is REQUIRED. If you don't have a context, you have a bug — the function should tell you immediately, not silently swallow it.**

```typescript
// project-context.ts — REPLACE onRootsChanged (lines 254-268)

/**
 * Refresh the ProjectContext for the given session when MCP roots change.
 * ctx is REQUIRED — every roots change happens within a session context.
 * If you're calling this without a ctx, you have a bug upstream.
 */
export function onRootsChanged(ctx: FsContext): void {
    const instance = _instances.get(ctx);
    if (instance) {
        instance.refresh();
    } else {
        // No ProjectContext for this ctx yet — that's fine, it will be
        // created on first tool call and will pick up the new dirs then.
        console.error("onRootsChanged: no ProjectContext for this session yet (will be created on first use)");
    }
}
```

**What this changes**:
- `ctx` is no longer optional — TypeScript will catch any caller that doesn't pass it at compile time
- The silent no-op branch is gone — there's no code path that does nothing
- If the `WeakMap` doesn't have an instance yet, that's a legitimate scenario (roots changed before any tool call) — we log it and move on; the next `getProjectContext(ctx)` call will create a fresh instance with the updated dirs
- The only current caller (`server.ts:133`) already passes `ctx`, so this is a non-breaking change to existing behavior

**Also update the import/caller in `server.ts`** — no changes needed since it already passes `ctx`.

---

## Issue 14: Process-Tree CWD Walk — The Missing Detection Step

### What's Missing

The resolution ladder currently has no way to discover the user's *actual* working directory when the server's own `process.cwd()` is wrong (which is always — see Issue 2). MCP roots help when the client supports them, but many clients don't, and even those that do may not send roots until after the first tool call.

**The process tree contains the answer.** When a user invokes an MCP server:
- The user is typically in a terminal (shell) or IDE, which has a CWD set to their project
- That shell/IDE spawns the MCP client (or directly spawns the server)
- The server's parent, grandparent, or great-grandparent process almost certainly has a CWD pointing at the user's project

This is how the Python version of this system worked — walk up the process tree, read each ancestor's CWD, and match against known projects.

### Where It Fits In the Resolution Ladder

This should slot in as **Step 0** — BEFORE git detection, BEFORE markers, BEFORE allowed dirs. It's the cheapest and most reliable way to find the user's project when everything else is blind:

```
Resolution Ladder (updated):
  0. Process-tree CWD walk (NEW) — read parent process CWDs from /proc
  1. Git repo detection from the file path
  2. Marker-based detection (deepest marker within git root)
  3. MCP roots / allowed directories fallback
  4. ProjectRegistry matching
  5. Global fallback (null)
```

### Implementation

**New file**: `packages/zenith-mcp/src/utils/process-tree.ts`

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Walk the process tree to find candidate working directories.
 *
 * On Linux: reads /proc/<pid>/cwd (symlink to CWD) and /proc/<pid>/status
 * (PPid line) for each ancestor.
 *
 * On macOS/other: falls back to own process.cwd() only (no /proc).
 *
 * Returns an array of { cwd, source } tuples, ordered from nearest ancestor
 * to farthest. Always includes own process.cwd() as the final entry.
 *
 * Walks at most 5 ancestors — covers:
 *   IDE → shell → mcp  (depth 2)
 *   tmux → shell → wrapper → mcp  (depth 3)
 *   systemd → IDE → shell → mcp  (depth 4)
 */
export function getProcessTreeCwds(): Array<{ cwd: string; source: string }> {
    const candidates: Array<{ cwd: string; source: string }> = [];
    const seen = new Set<string>();

    if (os.platform() === 'linux') {
        try {
            let pid = process.ppid;

            for (let depth = 0; depth < 5 && pid > 1; depth++) {
                try {
                    // Read the CWD of the ancestor process
                    const cwdLink = `/proc/${pid}/cwd`;
                    const cwd = fs.readlinkSync(cwdLink);

                    if (cwd && !seen.has(cwd)) {
                        seen.add(cwd);
                        // Read the process name for diagnostics
                        let name = `pid:${pid}`;
                        try {
                            const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
                            const nameLine = status.split('\n').find(l => l.startsWith('Name:'));
                            if (nameLine) {
                                name = nameLine.split('\t')[1]?.trim() ?? name;
                            }
                        } catch {
                            // Can't read name — use pid
                        }
                        candidates.push({ cwd, source: `ancestor[${depth}]:${name}` });
                    }

                    // Get the parent PID of this ancestor
                    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
                    const ppidLine = status.split('\n').find(l => l.startsWith('PPid:'));
                    if (!ppidLine) break;
                    pid = parseInt(ppidLine.split('\t')[1]?.trim() ?? '0', 10);
                    if (isNaN(pid) || pid <= 1) break;
                } catch {
                    // Process disappeared, permission denied, or /proc unavailable
                    break;
                }
            }
        } catch {
            // /proc not available — fall through to self:cwd
        }
    }

    // macOS: try lsof-based approach (less reliable but worth a shot)
    if (os.platform() === 'darwin' && candidates.length === 0) {
        try {
            const { execFileSync } = await import('child_process');
            // Get parent PID's CWD via lsof
            const ppid = process.ppid;
            if (ppid > 1) {
                const result = execFileSync('lsof', ['-a', '-p', String(ppid), '-d', 'cwd', '-Fn'], {
                    encoding: 'utf-8',
                    timeout: 2000,
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
                const lines = result.split('\n');
                for (const line of lines) {
                    if (line.startsWith('n') && line.length > 1) {
                        const cwd = line.slice(1);
                        if (!seen.has(cwd)) {
                            seen.add(cwd);
                            candidates.push({ cwd, source: `ancestor[0]:ppid:${ppid}` });
                        }
                    }
                }
            }
        } catch {
            // lsof not available or failed — fall through
        }
    }

    // Always include own cwd as final fallback
    const ownCwd = process.cwd();
    if (!seen.has(ownCwd)) {
        candidates.push({ cwd: ownCwd, source: 'self:cwd' });
    }

    return candidates;
}
```

### Integration into the Resolution Ladder

**Modify `_resolve()` in `project-context.ts`** — try process tree CWDs BEFORE falling through to the global fallback:

```typescript
// project-context.ts — REPLACE _resolve() (lines 202-220)
// This REPLACES the fix from Issue 2 — this is the full version.

import { getProcessTreeCwds } from '../utils/process-tree.js';

_resolve(): void {
    this._resolved = true;

    const allowedDirs = this._ctx.getAllowedDirectories();
    const registryEntries = this._registry.listProjects();
    const resolveOpts = { allowedDirectories: allowedDirs, registryEntries };

    // Priority 1: Try each allowed directory (from MCP roots / CLI args).
    // These are the ACTUAL project dirs the client told us about.
    for (const dir of allowedDirs) {
        const root = resolveProjectRoot(dir, resolveOpts);
        if (root) {
            this._boundRoot = root;
            this._isGlobal = false;
            return;
        }
    }

    // Priority 2: Walk the process tree for candidate CWDs.
    // The parent shell/IDE almost certainly has a CWD in the user's project.
    try {
        const treeCwds = getProcessTreeCwds();
        for (const { cwd, source } of treeCwds) {
            const root = resolveProjectRoot(cwd, resolveOpts);
            if (root) {
                console.error(`Project detected via process tree: ${root} (source: ${source})`);
                this._boundRoot = root;
                this._isGlobal = false;
                return;
            }
        }
    } catch {
        // Process tree walk failed entirely — continue to global fallback
    }

    // Global fallback — the server operates without a bound project.
    // Tools will resolve per-file when given file paths.
    this._boundRoot = null;
    this._isGlobal = true;
}
```

**Also add process-tree walk to `resolveProjectRoot` as Step 0:**

The process-tree walk can also be used INSIDE `resolveProjectRoot` itself, so that even per-file resolution benefits from it when the file's own path doesn't match anything.

Add it to `project-scope.ts`:

```typescript
// project-scope.ts — ADD Step 0 inside resolveProjectRoot, before Step 1

import { getProcessTreeCwds } from './process-tree.js';

// Inside resolveProjectRoot, after the allowedDirectories guard:

    // Step 0: Try matching the file against process-tree CWDs.
    // If a parent process has a CWD that is a project root containing
    // this file, use it immediately.
    if (!pathInsideAllowed && options?.allowedDirectories?.length) {
        // File is outside allowed dirs — try process tree as a heuristic
        // to find a matching project
        try {
            const treeCwds = getProcessTreeCwds();
            for (const { cwd } of treeCwds) {
                const treeRoot = findRepoRoot(cwd);
                if (treeRoot && isWithinProject(absPath, treeRoot)) {
                    return setCached(cacheKey, clampToAllowed(treeRoot, absPath, options.allowedDirectories) ?? treeRoot);
                }
            }
        } catch {
            // Process tree walk failed — continue with normal ladder
        }
    }
```

### Why This Works

Real-world MCP process tree (from your system):

```
PID 1         (systemd)       cwd: /
PID 3425101   (opencode)      cwd: /home/tanner/Projects/Zenith-MCP  ← THIS
PID 3481534   (bash)          cwd: /home/tanner/Projects/Zenith-MCP  ← OR THIS
PID 3481600   (node)          cwd: /home/tanner  ← server's own cwd (WRONG)
```

The process-tree walk reads `/proc/3481534/cwd` → `/home/tanner/Projects/Zenith-MCP`, passes that to `resolveProjectRoot`, which finds the `.git` directory and returns the correct project root. This works even when:
- No CLI directory flags were passed
- MCP roots aren't supported by the client
- The server's own `process.cwd()` is wrong

**Platform support**:
- **Linux**: Full support via `/proc/<pid>/cwd` and `/proc/<pid>/status`
- **macOS**: Partial support via `lsof -p <ppid> -d cwd`
- **Windows**: Not supported (no equivalent API) — falls through to other steps
- **All platforms**: `process.cwd()` is always the final candidate

---

## Priority Summary

| # | Issue | Severity | Impact |
|:--|:------|:---------|:-------|
| 1 | `oninitialized` crash | **CRITICAL** | Server dies on startup |
| 2 | `_resolve()` uses `process.cwd()` only | **CRITICAL** | Git detection never works |
| 3 | `validatePath` throws on empty dirs | **CRITICAL** | All tool calls fail |
| 4 | Guard short-circuits Steps 3-4 | **CRITICAL** | Fallback logic never runs |
| 13 | `onRootsChanged(ctx?)` silent no-op | **CRITICAL** | Stale project context after roots change |
| 14 | No process-tree CWD walk | **CRITICAL** | Can't find project when roots/CLI unavailable |
| 5 | Replace-not-merge on roots | **HIGH** | CLI dirs lost |
| 6 | `findRepoRoot` requires git CLI | **HIGH** | Git detection fragile |
| 10 | Tools bypass `ProjectContext` | **HIGH** | Fragmented DB resolution |
| 7 | Redundant `findRepoRoot` call | **MEDIUM** | Performance, inconsistency |
| 8 | `refresh()` clears explicit bindings | **MEDIUM** | Sticky projects unstick |
| 9 | `parseRootUri` swallows errors | **MEDIUM** | No diagnostics |
| 11 | No deduplication | **LOW** | Wasted iteration |
| 12 | Unused `name` field | **LOW** | Missed feature |

## Implementation Order

**Wave 1 — Stop the crashes (Issues 1, 3, 13):**
Fix `oninitialized` to never throw. Fix `validatePath` to allow everything when no dirs are configured. Nuke `onRootsChanged` optional ctx — make it required, remove the silent no-op.

**Wave 2 — Make detection actually work (Issues 2, 4, 6, 14):**
Fix `_resolve()` to iterate allowed dirs AND walk the process tree. Fix the guard to not short-circuit Steps 3-4. Fix `findRepoRoot` to use `.git` directory walk. Add process-tree CWD walk as Step 0 in the resolution ladder.

**Wave 3 — Fix the integration (Issues 5, 7, 10):**
Merge roots instead of replacing. Pass git root to markers. Replace `findRepoRoot` in tools with `getProjectContext`.

**Wave 4 — Polish (Issues 8, 9, 11, 12):**
Preserve explicit bindings in refresh. Add error detail to URI parsing. Deduplicate dirs. Use root names.
