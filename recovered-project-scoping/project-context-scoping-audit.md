# Project Context & Scoping Integration — Expert Review Audit

**Date**: 2026-05-23  
**Reviewer**: Antigravity (Claude Opus 4.6)  
**Scope**: All project context detection, resolution, scoping, and integration code in Zenith-MCP  

---

## Files Reviewed

| File | Lines | Purpose |
|:---|:---|:---|
| `packages/zenith-mcp/src/utils/project-scope.ts` | 324 | Core resolution ladder |
| `packages/zenith-mcp/src/core/project-context.ts` | 278 | ProjectContext class (wrapper/orchestrator) |
| `packages/zenith-mcp/src/core/project-registry.ts` | 185 | Explicit project matching registry |
| `packages/zenith-mcp/src/core/symbol-index.ts` | L39–53 | `findRepoRoot` (git detection) |
| `packages/zenith-mcp/src/core/lib.ts` | L17–114 | `FilesystemContext` / `createFilesystemContext` |
| `packages/zenith-mcp/src/core/server.ts` | 192 | MCP roots wiring + tool registration |
| `packages/zenith-mcp/src/core/roots-utils.ts` | 77 | Root URI parsing |
| `packages/zenith-mcp/src/core/path-utils.ts` | 126 | Path normalization |
| `packages/zenith-mcp/src/core/path-validation.ts` | 21 | Allowed-directory containment check |
| `packages/zenith-mcp/src/core/db-adapter.ts` | L645–678 | Project roots DB operations |
| `packages/zenith-mcp/src/core/stash.ts` | 88 | Stash project scoping |
| `packages/zenith-mcp/src/tools/types.ts` | 62 | ToolContext type definition |
| `packages/zenith-mcp/src/tools/refactor_batch.ts` | 1304 | Heaviest consumer of ProjectContext |
| `packages/zenith-mcp/src/tools/search_files.ts` | 735 | Direct `resolveProjectRoot` consumer |
| `packages/zenith-mcp/src/tools/edit_file.ts` | L82–85 | Direct `findRepoRoot` consumer |
| `packages/zenith-mcp/src/tools/stash_restore.ts` | 238 | `findRepoRoot` for snapshots |

---

## Findings

### [P2] `_resolveFromMarkers` can return wrong root when ceiling is filesystem root

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/utils/project-scope.ts` |
| **Lines** | 285–309 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

When `findRepoRoot` fails (non-git directory), `ceiling` is set to the filesystem root (e.g. `/`). The while loop condition `dir.length >= ceiling.length && dir !== fsRoot` continues walking up, but the early-return at line 298 (`if (!ceiling || ceiling === fsRoot) return dir;`) fires on the very first marker match, returning the *nearest* marker to the file. This is correct for the no-git case. However, the function collects `candidates` (line 281) but only ever uses `candidates[0]` at line 309, which is the *deepest* marker found (first pushed during upward walk). In the git-repo case, the loop collects all markers between the file and the git root, then returns `candidates[0]` — the deepest one. This is intentional and correct for monorepo detection. **The issue**: when `ceiling` is neither `null` nor `fsRoot` (the git-repo case), but the git root happens to contain zero markers between itself and the file, `candidates` is empty and `null` is returned — even though the git root itself may have a `package.json`. This happens because the loop starts at `path.dirname(absPath)` and stops when `dir.length < ceiling.length`, meaning the ceiling directory itself is never checked. If a file is directly inside the git root (e.g. `/repo/file.ts` with git root `/repo` and `/repo/package.json` exists), then `dir = /repo`, `ceiling = /repo`, and `dir.length >= ceiling.length` is true so it IS checked. But if the file's dirname equals the ceiling, and the ceiling directory has a marker, it works. The real gap is an off-by-one when `dir === fsRoot` — the `while` excludes it, meaning the filesystem root is never scanned for markers. This is generally harmless since root-level packages are unusual, but it's a subtle inconsistency.

---

### [P2] `_resolveFromAllowedDirectories` clamps git roots in the wrong direction for some configurations

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/utils/project-scope.ts` |
| **Lines** | 225–235 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

In `_resolveFromAllowedDirectories` (Step 3), when the git root is found for an allowed directory, the code computes `effectiveRoot` as `isWithinProject(resolvedDir, gitRoot) ? resolvedDir : gitRoot` (line 232). This means if the allowed directory is *inside* the git root (the common case, e.g. allowed=`/repo/packages/app`, git root=`/repo`), the effective root becomes the allowed directory itself, not the git root. This is intentional as a clamping guard. However, this creates an inconsistency: Step 1 and Step 2 (run earlier) already attempted git and marker detection clamped via `clampToAllowed`, which has special logic at line 120 (`resolvedAllowed.some(dir => isWithinProject(candidate, dir))`) that preserves candidates that are within *any* allowed directory. Step 3 does NOT use `clampToAllowed` at all and applies its own more restrictive clamping. This means the same file path can produce different results depending on whether git/markers were detected in Steps 1–2 vs Step 3, even when the underlying git root is the same. In practice, this only manifests when Steps 1 and 2 both fail (e.g. `findRepoRoot(absPath)` throws for a new-file path but `findRepoRoot(allowedDir)` succeeds), producing a clamped-down result that may differ from what Steps 1–2 would have returned had they succeeded.

---

### [P1] `edit_file.ts` and `stash_restore.ts` bypass ProjectContext entirely, causing project isolation violations

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/tools/edit_file.ts` |
| **Lines** | 82–85 |
| **Priority** | 1 |
| **Confidence** | 0.92 |

`edit_file.ts` uses `findRepoRoot(validPath) || path.dirname(validPath)` directly (line 82), completely bypassing the `ProjectContext` class and the full resolution ladder. This means: (1) It never consults the ProjectRegistry for explicitly registered project roots. (2) It never checks allowed directories or applies clamping. (3) For non-git directories, it falls back to `path.dirname(validPath)` instead of marker-based detection, which means the `.mcp/symbols.db` database gets provisioned in the *parent directory of the file* rather than the project root. This causes symbol indices to be fragmented — if a user edits two files in the same project but different directories, two separate databases are created. `stash_restore.ts` has the same pattern at line 155: `findRepoRoot(validPath) || path.dirname(validPath)`. Both of these tools create DB connections via `getDb(repoRoot)` which provisions a `.mcp/` directory at whatever path is returned, potentially polluting arbitrary directories with `.mcp/symbols.db` files.

---

### [P2] `ProjectRegistry` prefix matching uses non-normalized paths for comparison

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/project-registry.ts` |
| **Lines** | 146–158 |
| **Priority** | 2 |
| **Confidence** | 0.75 |

In `findProject` (Step 5: path-prefix matching), the code iterates `this._byPath` entries and checks `normalizedPath.startsWith(rootPath + path.sep)`. The `rootPath` keys in `_byPath` are normalized via `normalizePath(path.resolve(...))` at registration time (line 74). However, the `normalizedPath` at the query site (line 133) is also normalized with `normalizePath(path.resolve(query))`. The comparison works correctly on Linux since both use `/`. On Windows, `normalizePath` converts to backslashes and capitalizes drive letters, and `path.sep` is `\\`, so the comparison also works. However, the comparison at line 148 (`normalizedPath.startsWith(rootPath + path.sep)`) concatenates the separator to `rootPath`, which already ends WITHOUT a trailing separator (since `path.resolve` strips it). This is correct. But the `project_root` field on `ProjectManifest` at line 157 is used in the `reduce` comparator (`current.project_root.length > best.project_root.length`), which uses the *original non-normalized* path from the manifest. If two registry entries have the same normalized path but different unnormalized representations (e.g. one with trailing slash, one without), the length comparison could pick the wrong "longest" match. In practice, `register()` normalizes via `path.resolve()` at line 74 but stores the original `manifest.project_root` — the `project_root` property on the manifest is never mutated to its normalized form. The `reduce` comparison should use the normalized `rootPath` from the `_byPath` key, not `manifest.project_root`.

---

### [P2] `clampToAllowed` over-clamping when git root escapes allowed directory with multiple allowed dirs

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/utils/project-scope.ts` |
| **Lines** | 109–127 |
| **Priority** | 2 |
| **Confidence** | 0.78 |

`clampToAllowed` has a guard at line 120 that checks if the candidate is within ANY allowed directory, preventing over-clamping. However, line 111 first calls `getMostSpecificAllowedRoot(absPath, allowedDirectories)` which returns the *most specific* (deepest/longest) allowed directory containing `absPath`. If `allowedRoot` is null (the file isn't inside any allowed directory), the function returns null at line 112. The issue is at line 113: if the `candidate` is null (e.g. no git root found), the function returns null. This is correct. But consider: allowed dirs = `[/repo, /repo/packages/app]`, candidate (git root) = `/repo`, absPath = `/repo/packages/app/src/file.ts`. `getMostSpecificAllowedRoot` returns `/repo/packages/app`. Line 120 checks: `resolvedAllowed.some(dir => isWithinProject('/repo', dir))`. Since `/repo` is within `/repo` (exact match), this returns true, and the candidate `/repo` is returned as-is. This is correct. But if allowed dirs = `[/repo/packages/app]` (only one), candidate = `/repo`, absPath = `/repo/packages/app/src/file.ts`: `getMostSpecificAllowedRoot` returns `/repo/packages/app`. Line 120: `isWithinProject('/repo', '/repo/packages/app')` → false (repo is not within packages/app). Line 123: `isWithinProject('/repo/packages/app', '/repo')` → true. Returns `/repo/packages/app`. This clamps the git root `/repo` down to `/repo/packages/app`, which loses the wider project context. Whether this is a bug depends on intent: it's secure (never escapes the allowed sandbox) but may cause unexpected behavior where the project root changes depending on how many allowed directories are configured.

---

### [P3] `_resolveFromRegistry` creates a new `ProjectRegistry` instance on every call

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/utils/project-scope.ts` |
| **Lines** | 315–323 |
| **Priority** | 3 |
| **Confidence** | 0.95 |

`_resolveFromRegistry` at line 321 creates `new ProjectRegistry(registryEntries)` on every invocation, even though the entries are the same for the lifetime of a resolution call. The cache key includes registry entries (line 59–62), so repeated calls with the same entries hit the LRU cache and skip this code path. However, when the cache misses, this allocates a new registry, populates three Map lookups (`_byId`, `_byName`, `_byPath`), and then queries it — all to be thrown away. The `ProjectContext` class already maintains a persistent `_registry` instance that is synced from the DB. The `registryEntries` passed to `resolveProjectRoot` come from `this._registry.listProjects()` which returns a fresh array copy. This is a minor performance issue, not a correctness bug.

---

### [P1] `onRootsChanged` without a `ctx` argument silently does nothing — no diagnostic or fallback

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/project-context.ts` |
| **Lines** | 258–268 |
| **Priority** | 1 |
| **Confidence** | 0.88 |

`onRootsChanged(ctx?)` at line 258 has a `ctx` parameter that is optional. When called without a context (line 266–267), the function cannot iterate the `WeakMap` `_instances` to refresh all sessions. It simply returns silently. This is documented in the comment but has real consequences: if any caller invokes `onRootsChanged()` without passing the `FsContext`, all `ProjectContext` instances retain stale cached project roots, potentially directing database operations, stash lookups, and symbol indexing to wrong project roots after a roots change. The current callers in `server.ts` always pass `ctx` (line 133), so this isn't currently triggered. However, it's a latent trap — the function signature suggests it handles the no-arg case, but it effectively no-ops. A `console.warn` or an `Error` would be safer.

---

### [P2] `search_files.ts` structural mode bypasses ProjectContext and uses `resolveProjectRoot` directly with different options

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/tools/search_files.ts` |
| **Lines** | 214–217 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

`search_files.ts` structural mode calls `resolveProjectRoot(rootPath, { allowedDirectories: ctx.getAllowedDirectories(), noCache: true })` directly (line 214), bypassing `ProjectContext` entirely. This means: (1) It doesn't include registry entries from the persisted SQLite database, so manually `initProject`-registered roots are invisible to structural search. (2) It uses `noCache: true`, which is intentional for correctness but means every structural search re-runs the full resolution ladder. (3) The auto-promote logic in `ProjectContext.getRoot()` (lines 87–91) is skipped, so structural searches don't influence the session's "active project" even when they should. (4) Unlike `refactor_batch.ts` which uses `getProjectContext(ctx)`, this tool cannot benefit from `onRootsChanged` refreshes.

---

### [P2] `getRoot` auto-promote creates implicit project binding that can be surprising

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/project-context.ts` |
| **Lines** | 78–93 |
| **Priority** | 2 |
| **Confidence** | 0.82 |

`getRoot(filePath?)` at line 87 auto-promotes the first file path's resolved root to the "bound root" when: `!this._explicit && (!this._resolved || !this._boundRoot)`. This means the first `refactor_batch` query or loadDiff call implicitly locks the session to a particular project root, and subsequent calls without a `filePath` will return that cached root. However, in a multi-project workspace (e.g. Claude has roots for both `/project-a` and `/project-b`), the first tool call determines the project for all subsequent calls. If the agent switches to working on project-b but a tool call happens to omit `filePath`, it still gets project-a's root. The guard `!this._explicit` prevents this after `initProject`, but in normal usage without explicit init, this auto-promote creates a hidden ordering dependency. The condition `!this._resolved || !this._boundRoot` has redundancy: if `_resolved` is true and `_boundRoot` is null, the OR is still true and the auto-promote fires. This means even after a `_resolve()` call determined the project is "global" (null root), a subsequent `getRoot(filePath)` that finds a project root will overwrite the global determination without any indication.

---

### [P1] `refactor_batch.ts` query mode uses `allowedDirs[0]` as rootHint without undefined check

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/tools/refactor_batch.ts` |
| **Lines** | 282–283 |
| **Priority** | 1 |
| **Confidence** | 0.90 |

At line 282, `const rootHint = resolvedScope !== undefined ? resolvedScope : allowedDirs[0];` — when `resolvedScope` is undefined AND `allowedDirs` is non-empty, `allowedDirs[0]` is used. The `allowedDirs.length === 0` check at line 280 is only for the case where BOTH `resolvedScope` is undefined AND `allowedDirs` is empty. But TypeScript's `string[]` doesn't guarantee `[0]` is defined for `length > 0` at the type level (it's `string | undefined`). More importantly, `rootHint` is passed to `pc.getRoot(rootHint)` which delegates to `resolveProjectRoot` — if `rootHint` is `undefined`, `path.resolve(undefined)` would produce the CWD, which may or may not be in the allowed directories. The same pattern appears at lines 350, 581, and 895 where `pc.getRoot(allowedDirs[0])` is called after a `allowedDirs.length === 0` throw — the `[0]` access is safe because of the prior guard, but TypeScript doesn't narrow the type in these cases, making the intent unclear.

---

### [P3] Cache key construction includes full registry paths, creating cache thrashing on registry changes

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/utils/project-scope.ts` |
| **Lines** | 53–63 |
| **Priority** | 3 |
| **Confidence** | 0.88 |

`buildCacheKey` at line 53 includes the sorted, resolved paths of all registry entries in the cache key. When `initProject` adds a new entry, the registry list changes, all existing cache keys become stale (they reference a different registry fingerprint), and the entire 512-entry cache is effectively invalidated without being cleared. This is functionally correct (stale results won't be returned), but it means every `initProject` call triggers a cascade of cache misses. Combined with `_resolveFromRegistry` creating new `ProjectRegistry` instances (Finding above), this creates unnecessary overhead for workflows with frequent project registration. `clearProjectScopeCache()` exists and is called by `ProjectContext.refresh()`, but `initProject()` does NOT call `clearProjectScopeCache()` — it just binds the root directly. This means the cache retains entries with old registry fingerprints that will never be hit again, consuming memory until LRU eviction.

---

### [P2] `normalizePath` in `path-utils.ts` has weak `any` return type, masking type errors

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/path-utils.ts` |
| **Lines** | 36–40 |
| **Priority** | 2 |
| **Confidence** | 0.92 |

`normalizePath(p: any): any` accepts and returns `any`, which means callers can pass `null`, `undefined`, numbers, objects, etc. without any TypeScript error. For `null` and `undefined`, the function explicitly returns them unchanged (lines 38–39). For non-string types, it returns the input unchanged (line 40). This means `normalizePath(42)` returns `42`, and `normalizePath({ evil: true })` returns the object. Downstream consumers like `isPathWithinAllowedDirectories` (path-validation.ts line 11) call `normalizePath(filePath)` and then `path.resolve(normalized)` — passing a non-string to `path.resolve` throws at runtime. The `any` typing masks this potential runtime error at compile time. Since this function is called from security-critical paths (path validation, allowed directory checks), the loose typing is risky.

---

### [P2] `isWithinProject` and `isPathWithinAllowedDirectories` implement the same containment check with subtly different logic

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/utils/project-scope.ts` |
| **Lines** | 180–184 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

`isWithinProject` (project-scope.ts:180) uses `path.resolve()` and checks `resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep)`. `isPathWithinAllowedDirectories` (path-validation.ts:10) uses `normalizePath()` + `path.resolve()` and checks `resolved === normalizedDir || resolved.startsWith(prefix)` where prefix includes `path.sep`. The logic is equivalent but the normalization differs: `isWithinProject` uses only `path.resolve`, while `isPathWithinAllowedDirectories` adds `normalizePath` (which expands `~`, strips quotes, etc.) before resolving. This means `isWithinProject('~/src/file.ts', '/home/user')` may fail because `path.resolve('~/src/file.ts')` would resolve relative to CWD rather than expanding `~`, while `isPathWithinAllowedDirectories` would handle it correctly. The project-scope code uses `isWithinProject` extensively in the resolution ladder, meaning tilde paths passed as file arguments could escape containment checks.

---

### [P3] `ProjectContext._syncRegistry` swallows all errors silently

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/project-context.ts` |
| **Lines** | 186–200 |
| **Priority** | 3 |
| **Confidence** | 0.90 |

`_syncRegistry` catches all errors at line 197 with an empty catch block. The comment says "Registry might be empty or DB not ready yet", but this also swallows: corrupted database errors, disk full errors, permission errors, and schema migration failures. If the global DB at `~/.zenith-mcp/global-stash.db` is corrupted, the registry silently loads zero entries, and all manually registered projects become invisible. The user would see no error message — tools would just fail to find the right project root and potentially fall back to global, silently storing stash entries in the wrong database.

---

## Overall Assessment

| Field | Value |
|:---|:---|
| **Verdict** | `feature has issues requiring attention` |
| **Confidence** | 0.88 |

The project context/scoping system is architecturally sound — the resolution ladder is well-designed, the caching layer is properly implemented with LRU eviction, and the clamping logic handles the common monorepo case correctly. However, there are three categories of issues:

**Consistency issues** (P1–P2): Multiple tools bypass `ProjectContext` entirely (`edit_file.ts`, `stash_restore.ts`, `search_files.ts`), creating divergent project root resolution behavior within the same session. A file edited via `edit_file` may get a different project root than the same file queried via `refactor_batch`, leading to fragmented symbol databases and inconsistent stash scoping.

**Type safety issues** (P2): The `any` typing on `normalizePath`, the `undefined`-possible array access patterns in `refactor_batch.ts`, and the divergent containment check implementations (`isWithinProject` vs `isPathWithinAllowedDirectories`) create a surface area for runtime errors that TypeScript cannot catch.

**Silent failure patterns** (P1–P3): Several error paths (registry sync, no-arg `onRootsChanged`, marker detection edge cases) fail silently, making debugging difficult when the system produces unexpected behavior.

None of these issues are show-stopping for the common case (single git repo, single allowed directory), but they become real problems in multi-project workspaces, non-git projects, and edge-case filesystem layouts.

---
---

# MCP Roots Protocol — Expert Review Audit

**Date**: 2026-05-23  
**Reviewer**: Antigravity (Claude Opus 4.6)  
**Scope**: MCP roots protocol usage, implementation, and integration in Zenith-MCP  

---

## Additional Files Reviewed

| File | Lines | Purpose |
|:---|:---|:---|
| `packages/zenith-mcp/src/core/server.ts` | L128–191 | `attachRootsHandlers`, `updateAllowedDirectoriesFromRoots`, `oninitialized` |
| `packages/zenith-mcp/src/core/roots-utils.ts` | 77 | `parseRootUri`, `getValidRootDirectories` |
| `packages/zenith-mcp/src/cli/stdio.ts` | 68 | Stdio entry point, CLI args → roots bootstrap |
| `packages/zenith-mcp/src/server/http.ts` | 382 | HTTP entry point, per-session ctx, `createSessionPair` |
| `tests/roots-utils.test.js` | 91 | Root URI parsing test coverage |
| `tests/core-server.test.js` | 449 | `attachRootsHandlers` test coverage |

---

## MCP Roots Protocol Findings

### [P1] `updateAllowedDirectoriesFromRoots` replaces ALL allowed directories unconditionally, discarding CLI-provided dirs

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/server.ts` |
| **Lines** | 129–138 |
| **Priority** | 1 |
| **Confidence** | 0.93 |

When the client sends roots (either at initialization or via `roots/list_changed`), `updateAllowedDirectoriesFromRoots` at line 132 calls `ctx.setAllowedDirectories(validatedRootDirs)` which completely replaces the current allowed directories array. This means CLI-provided directories from the startup arguments are discarded as soon as the client provides roots. Consider this scenario:

1. Server starts with `zenith-mcp /data/shared-libs` (CLI arg sets `/data/shared-libs` as allowed)
2. Client connects and sends roots `[file:///home/user/project]`
3. `updateAllowedDirectoriesFromRoots` fires → `setAllowedDirectories(['/home/user/project'])`
4. `/data/shared-libs` is now inaccessible — all path validation rejects it

The HTTP server explicitly documents this in comments (http.ts line 79: "MCP roots negotiations may widen or narrow a session's dirs independently"), but the stdio server has no such documentation and the behavior is likely surprising. If the intent is to merge, line 132 should union the validated roots with existing dirs. If the intent is to replace, the CLI should warn that its dirs are "defaults only" and will be overridden by client roots.

---

### [P2] `parseRootUri` silently returns `null` for all parse failures, masking client misconfiguration

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/roots-utils.ts` |
| **Lines** | 7–44 |
| **Priority** | 2 |
| **Confidence** | 0.87 |

`parseRootUri` wraps the entire function body in a try-catch at line 41 that catches all errors and returns `null`. This means any of these failures are silently swallowed:
- Malformed URIs (e.g. `file:///invalid\x00path`)
- Permission errors on `fs.realpath()` (e.g. path exists but is unreadable)
- `fileURLToPath` failures (e.g. non-`file:` scheme like `https://...`)

The caller `getValidRootDirectories` at line 58 logs `"Skipping invalid path or inaccessible"` when the parse returns null, but doesn't include the original error. A client sending `file:///prjct` (typo) would see "Skipping invalid path or inaccessible: file:///prjct" with no indication of whether the directory doesn't exist, the path couldn't be parsed, or permission was denied. The error detail is swallowed at the `parseRootUri` level.

---

### [P2] `file://host/path` authority-form URIs are partially parsed with potential information loss

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/roots-utils.ts` |
| **Lines** | 15–19 |
| **Priority** | 2 |
| **Confidence** | 0.82 |

The `parseRootUri` function handles `file:` URIs by examining the prefix after `file:`. For `file://` URIs (with authority), it uses `afterScheme.indexOf('/', 2)` (line 18) to skip the authority portion. This means:
- `file://localhost/home/user` → authority portion `localhost` is silently discarded → `/home/user`
- `file://remote-host/share/data` → `remote-host` is silently discarded → `/share/data`

This is correct behavior for standard `file:` URI parsing (RFC 8089 says the authority in `file:` URIs is typically empty or `localhost`), but it's also a silent failure mode: if a client sends a `file:` URI with a non-localhost authority (indicating a network path or remote mount), the server silently interprets it as a local path, which may or may not exist and may point to completely different data than the client intended.

---

### [P1] `oninitialized` throws an Error for no-roots-no-CLI scenario, but the Error is thrown inside a callback with no upstream handler

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/server.ts` |
| **Lines** | 177–188 |
| **Priority** | 1 |
| **Confidence** | 0.88 |

When the client doesn't support roots AND no CLI directories were provided, `oninitialized` throws an Error at line 181:
```typescript
throw new Error(
  `Server cannot operate: No allowed directories available. ...`
);
```

However, `oninitialized` is assigned as `server.server.oninitialized = async () => {...}` (line 157). This is an async callback. Whether this thrown Error actually crashes the process, is logged, or is silently swallowed depends entirely on how the MCP SDK handles exceptions in the `oninitialized` callback. Looking at the test in `core-server.test.js` line 373:
```javascript
await expect(ms.server.oninitialized())
  .rejects.toThrow('Server cannot operate');
```
The test calls `oninitialized()` directly and awaits the rejection. But in production, the SDK calls this callback — if the SDK doesn't await the promise or catch its rejection, this becomes an unhandled promise rejection that may or may not crash the process depending on Node.js configuration. The stdio entrypoint (`cli/stdio.ts`) has no `.catch()` on `server.connect(transport)` that would intercept this.

---

### [P2] `RootsListChangedNotification` handler has no guard against empty roots response replacing valid dirs

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/server.ts` |
| **Lines** | 140–155 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

The `RootsListChangedNotificationSchema` handler at line 140 calls `listRoots()` and passes the response to `updateAllowedDirectoriesFromRoots`. If the response has `roots: []` (empty array), `getValidRootDirectories` returns `[]`, and the guard at line 131 (`if (validatedRootDirs.length > 0)`) prevents calling `setAllowedDirectories` — the existing dirs are preserved. This is correct.

However, if the response has `roots: [{ uri: 'file:///nonexistent' }]` (non-empty but all invalid), `getValidRootDirectories` returns `[]`, and again the guard preserves existing dirs. This is also correct.

The subtle issue: if the response has `roots: [{ uri: 'file:///valid-dir' }]` — a SINGLE valid root that is different from all current allowed dirs — line 132 replaces ALL existing allowed dirs with just this one. Any files the agent was working on in the old directories instantly become inaccessible. `onRootsChanged(ctx)` is called to refresh `ProjectContext`, but any in-flight tool calls that already captured `ctx.getAllowedDirectories()` before the notification handler ran will still use the OLD dirs. This is a TOCTOU issue: the allowed directories can change between when a tool reads them and when it validates paths.

---

### [P2] HTTP per-session isolation has no mechanism to propagate server-wide root changes to existing sessions

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/server/http.ts` |
| **Lines** | 141–146 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

Each HTTP session creates an independent `FilesystemContext` via `createSessionPair()` (line 141–146):
```typescript
function createSessionPair() {
    const ctx = createFilesystemContext([...baselineAllowedDirs]);
    const server = createFilesystemServer(ctx);
    attachRootsHandlers(server, ctx);
    return { ctx, server };
}
```

This design means:
1. If `baselineAllowedDirs` is modified after server startup, existing sessions don't see the change (they captured a copy at creation time)
2. If one session's client updates its roots, other sessions are unaffected (correct for isolation)
3. But if an admin wants to add/remove a global allowed directory (e.g. revoke access to a sensitive path), there is NO mechanism to propagate this to existing sessions — they retain their original dirs until the session expires or the client sends new roots

The `baselineAllowedDirs` array is a `const` binding (line 80) that never changes after initialization, so point 1 is moot currently. But if admin-level root management is ever added, this is a gap.

---

### [P3] `resolveInitialAllowedDirectories` does not deduplicate paths

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/server.ts` |
| **Lines** | 30–41 |
| **Priority** | 3 |
| **Confidence** | 0.92 |

`resolveInitialAllowedDirectories` at line 30 maps each CLI argument through `path.resolve` + `normalizePath` + `fs.realpath`, but never deduplicates the results. If the user starts the server with:
```bash
zenith-mcp /home/user/project /home/user/project
```
or equivalently:
```bash
zenith-mcp /home/user/project ~/project
```
(where `~/project` resolves to the same path), the `_allowedDirectories` array will contain duplicates. This doesn't cause incorrect behavior (containment checks pass regardless of duplicates), but it:
1. Wastes memory in the `_allowedDirectories` array
2. Causes `_resolveFromAllowedDirectories` to iterate the same directory multiple times
3. Makes `getMostSpecificAllowedRoot` consider the same dir twice in its longest-match loop

Similarly, `getValidRootDirectories` (roots-utils.ts) doesn't deduplicate, so if a client sends the same root URI twice, duplicates propagate.

---

### [P3] `name` field from MCP roots is parsed but never used

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/server.ts` |
| **Lines** | 144–149, 163–168 |
| **Priority** | 3 |
| **Confidence** | 0.95 |

In both the `oninitialized` callback and the `RootsListChangedNotification` handler, the code carefully preserves the `name` field from each root:
```typescript
response.roots.map(r =>
  r.name !== undefined
    ? { uri: r.uri, name: r.name }
    : { uri: r.uri }
)
```
This `name` field is passed to `updateAllowedDirectoriesFromRoots` which calls `getValidRootDirectories(requestedRoots)`. Inside `getValidRootDirectories` (roots-utils.ts line 54), the function iterates `requestedRoots` but only accesses `requestedRoot.uri` — the `name` field is never read. The `name` could be used for better diagnostic logging (e.g. "Skipping invalid root 'My Project': /bad/path") or for seeding `ProjectRegistry` entries with human-readable project names. Currently it's dead data that flows through the pipeline unused.

---

### [P2] No validation that MCP roots don't escape the server's intended security boundary

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/server.ts` |
| **Lines** | 129–138 |
| **Priority** | 2 |
| **Confidence** | 0.78 |

`updateAllowedDirectoriesFromRoots` accepts whatever roots the client provides and sets them directly as the allowed directories. There is no check against a server-defined "maximum boundary" or allowlist. A malicious or misconfigured client could send `roots: [{ uri: 'file:///' }]` to grant itself access to the entire filesystem. While the MCP protocol trusts the client (the client is typically the AI agent's host), this creates a security concern for the HTTP server mode where the server may be exposed over a network.

The HTTP server requires an API key (http.ts line 55–60), which provides authentication, but not authorization — any authenticated client can widen its own sandbox to any directory. A `max_allowed_roots` or `root_allowlist` configuration option would provide defense-in-depth.

---

### [P1] Race condition between `oninitialized` and first tool call when roots are the only source of allowed dirs

| Field | Value |
|:---|:---|
| **File** | `packages/zenith-mcp/src/core/server.ts` + `packages/zenith-mcp/src/cli/stdio.ts` |
| **Lines** | server.ts:157–189, stdio.ts:41–48 |
| **Priority** | 1 |
| **Confidence** | 0.75 |

When the server starts without CLI directories (stdio.ts line 53: "Started without allowed directories - waiting for client to provide roots via MCP protocol"), the `_allowedDirectories` array is empty. The `oninitialized` callback is async (line 157) and fires after the MCP handshake completes. However, the MCP protocol doesn't guarantee that the server won't receive tool calls between `initialize` (which starts the session) and `initialized` (which triggers `oninitialized`).

If the SDK correctly gates tool calls until after `initialized` is processed, this is fine. But if a tool call arrives before `oninitialized` has completed its async `listRoots()` call, the tool would see empty `getAllowedDirectories()` and either:
1. Throw "No allowed directories configured" (refactor_batch.ts pattern)
2. Return a degraded result with no project context

This is likely guarded by the MCP SDK's protocol state machine (tool calls should only arrive after `initialized`), but the codebase doesn't explicitly verify this assumption. A startup latch or "ready" flag would make the assumption explicit.

---

## MCP Roots Overall Assessment

| Field | Value |
|:---|:---|
| **Verdict** | `implementation is functional but has design gaps` |
| **Confidence** | 0.85 |

The MCP roots protocol integration is straightforward and works correctly for the happy path: client provides roots at init, roots flow through URI parsing → validation → allowed directories → project context refresh. The code properly handles clients that don't support roots (CLI fallback) and clients that send empty roots (preserves existing dirs).

**Critical gaps**:

**Replace-not-merge semantics** (P1): `setAllowedDirectories` replaces rather than merges with CLI dirs, which can unexpectedly revoke access to server-configured directories when a client sends roots. This is the most impactful finding for real-world usage.

**Error visibility** (P2): `parseRootUri` swallows all errors and returns null, making it difficult for operators to diagnose why a client's roots aren't being accepted. Combined with the unused `name` field that could improve diagnostics, the system is opaque when things go wrong.

**Security boundary** (P2): In HTTP mode, any authenticated client can widen its own sandbox to any filesystem path. While this follows MCP's trust model, it's a gap for network-exposed deployments.

**TOCTOU on root changes** (P2): The `RootsListChangedNotification` handler can change allowed directories while tools are mid-execution, creating a narrow but real race window.

The per-session isolation in HTTP mode is well-designed. The stdio mode is simpler but shares the same replace-not-merge issue.
