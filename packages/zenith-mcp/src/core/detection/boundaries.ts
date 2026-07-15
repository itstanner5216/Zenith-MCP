import path from 'path';
import fs from 'fs';
import os from 'os';

// ---------------------------------------------------------------------------
// Project boundary finders — PRIVATE to ProjectContext.
//
// ⚠ Do NOT import this module anywhere except core/project-context.ts.
// A guard test (tests/detection-encapsulation.test.js) fails the suite if any
// other module imports it. All binding decisions belong to ProjectContext —
// these are pure, stateless boundary finders it consults, nothing more.
//
// Lineage: ported from utils/project-scope.ts (recovered 2026-07-14) with the
// defects from docs/project-scoping + the scoping audit fixed:
//   - git detection is a pure fs walk (no git CLI subprocess, no 5s timeout)
//   - git root outranks deeper markers (monorepo subpackages no longer
//     fragment DB routing — the repo root is the project identity)
//   - marker walk without a git ceiling stops at the home directory and
//     never returns junk roots (fs root, home, tmp, OS dirs)
//   - clamping no longer short-circuits paths outside allowed dirs
//     (fix-plan Issue 4); it clamps only when a containing allowed dir exists
//   - LRU cache is generation-keyed (one integer bump invalidates everything)
//     instead of embedding full registry/allowed-dir paths in every key
// ---------------------------------------------------------------------------

export const PROJECT_MARKERS: readonly string[] = [
    'package.json',
    'Cargo.toml',
    'pyproject.toml',
    'setup.py',
    'requirements.txt',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'composer.json',
    'Gemfile',
    'mix.exs',
    'stack.yaml',
    'CMakeLists.txt',
    'deno.json',
];

export const MARKER_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'target',
    'vendor',
    '.venv',
    'venv',
    '__pycache__',
    '.tox',
    'out',
    'coverage',
]);

export interface BoundaryResult {
    root: string;
    method: 'git' | 'marker';
}

export interface BoundaryOptions {
    /** Allowed directories (MCP roots / CLI args) used for clamping. */
    allowedDirectories?: readonly string[];
    /**
     * Cache namespace. Bump the number to invalidate all prior results
     * (ProjectContext bumps it on refresh/registry reload/roots change).
     */
    generation?: number;
    /**
     * Cache isolation salt — each ProjectContext instance passes its own id.
     * Without it, sessions with different allowed dirs (HTTP entrypoint runs
     * one ProjectContext per session) could poison each other's clamped
     * results at coinciding generations.
     */
    cacheSalt?: string | number;
    /** Skip the cache entirely. */
    noCache?: boolean;
}

// ---------------------------------------------------------------------------
// Junk filter — roots that must never become a project binding.
// ---------------------------------------------------------------------------

const STATIC_JUNK_PREFIXES: readonly string[] = (() => {
    const list = [
        '/tmp',
        '/var/tmp',
        '/private/tmp', // macOS realpath of /tmp — candidates often arrive realpath'd
        '/private/var',
        '/usr',
        '/opt',
        '/snap',
        '/Applications',
        '/System',
        '/Library',
    ];
    if (process.platform === 'win32') {
        list.push('C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)');
    }
    return list.map(p => path.resolve(p));
})();

/** Case-insensitive filesystems (win32/darwin) get case-insensitive matching. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function foldCase(p: string): string {
    return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

function isAtOrUnder(candidate: string, prefix: string): boolean {
    const c = foldCase(candidate);
    const pfx = foldCase(prefix);
    return c === pfx || c.startsWith(pfx + path.sep);
}

/**
 * True when a path must never be used as a project root: the filesystem
 * root, the home directory itself (subdirectories of home are fine),
 * temp dirs, and OS installation directories. os.tmpdir() is evaluated at
 * call time so TMPDIR changes (common in tests) stay covered.
 */
export function isJunkRoot(p: string): boolean {
    const resolved = path.resolve(p);
    if (resolved === path.parse(resolved).root) return true;
    if (foldCase(resolved) === foldCase(path.resolve(os.homedir()))) return true;
    if (isAtOrUnder(resolved, path.resolve(os.tmpdir()))) return true;
    return STATIC_JUNK_PREFIXES.some(junk => isAtOrUnder(resolved, junk));
}

// ---------------------------------------------------------------------------
// Generation-keyed LRU cache
// ---------------------------------------------------------------------------

const MAX_CACHE_ENTRIES = 512;
const _cache = new Map<string, BoundaryResult | null>();

function cacheGet(key: string): BoundaryResult | null | undefined {
    const value = _cache.get(key);
    if (value === undefined) return undefined;
    _cache.delete(key);
    _cache.set(key, value);
    return value;
}

function cacheSet(key: string, value: BoundaryResult | null): BoundaryResult | null {
    if (_cache.has(key)) _cache.delete(key);
    _cache.set(key, value);
    if (_cache.size > MAX_CACHE_ENTRIES) {
        const oldest = _cache.keys().next().value;
        if (oldest !== undefined) _cache.delete(oldest);
    }
    return value;
}

/** Test hook — clears all cached boundary results. */
export function clearBoundaryCache(): void {
    _cache.clear();
}

// ---------------------------------------------------------------------------
// Git root — pure filesystem walk. A `.git` *directory* is a normal checkout;
// a `.git` *file* is a worktree/submodule pointer, and its containing dir is
// exactly the root we want (the worktree itself, not the parent repo).
// No subprocess: the original shelled out to `git rev-parse` with a 5-second
// timeout per uncached call, which is unacceptable in a per-tool-call path.
// ---------------------------------------------------------------------------

export function findGitRoot(absPath: string): string | null {
    let dir: string;
    try {
        const stat = fs.statSync(absPath);
        dir = stat.isDirectory() ? absPath : path.dirname(absPath);
    } catch {
        // Path may not exist yet (new-file case) — start from its dirname
        dir = path.dirname(absPath);
    }

    const fsRoot = path.parse(dir).root;
    while (true) {
        try {
            const gitStat = fs.statSync(path.join(dir, '.git'));
            if (gitStat.isDirectory() || gitStat.isFile()) return dir;
        } catch {
            // no .git here — keep walking
        }
        if (dir === fsRoot) return null;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

// ---------------------------------------------------------------------------
// Marker root — walk up looking for the NEAREST marker directory, skipping
// vendored/build directories, stopping before the home directory and the
// filesystem root. Only consulted when git detection found nothing, so
// monorepo subpackages can never shadow their repo root.
// ---------------------------------------------------------------------------

export function findMarkerRoot(absPath: string): string | null {
    const home = path.resolve(os.homedir());
    const fsRoot = path.parse(absPath).root;

    let dir: string;
    try {
        const stat = fs.statSync(absPath);
        dir = stat.isDirectory() ? absPath : path.dirname(absPath);
    } catch {
        dir = path.dirname(absPath);
    }

    while (dir !== fsRoot && dir !== home) {
        const basename = path.basename(dir);
        if (!MARKER_EXCLUDE_DIRS.has(basename)) {
            try {
                if (PROJECT_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) {
                    return dir;
                }
            } catch {
                // unreadable directory — keep walking
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Clamping — keeps detected roots from escaping the sandbox the user granted.
// Unlike the original, a path with NO containing allowed dir is not rejected
// (fix-plan Issue 4): allowed dirs are hints unless sandbox enforcement is on,
// and enforcement already happened in validatePath before we ever run.
// ---------------------------------------------------------------------------

function mostSpecificContaining(
    absPath: string,
    allowedDirectories?: readonly string[]
): string | null {
    if (!allowedDirectories?.length) return null;
    let best: string | null = null;
    for (const dir of allowedDirectories) {
        const resolved = path.resolve(dir);
        if (absPath === resolved || absPath.startsWith(resolved + path.sep)) {
            if (!best || resolved.length > best.length) best = resolved;
        }
    }
    return best;
}

export function clampToAllowed(
    candidate: string,
    absPath: string,
    allowedDirectories?: readonly string[]
): string {
    if (!allowedDirectories?.length) return candidate;

    // If the candidate already sits inside (or equals) ANY allowed dir, keep it.
    // Prevents over-clamping when both /repo and /repo/packages/x are allowed
    // and the git root is /repo (original audit finding).
    for (const dir of allowedDirectories) {
        const resolved = path.resolve(dir);
        if (candidate === resolved || candidate.startsWith(resolved + path.sep)) {
            return candidate;
        }
    }

    const containing = mostSpecificContaining(absPath, allowedDirectories);
    if (!containing) return candidate; // path outside allowed dirs — hints don't gate

    // Candidate contains the allowed dir (detected root escaped upward) — clamp down.
    if (containing === candidate || containing.startsWith(candidate + path.sep)) {
        return containing;
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// findProjectBoundary — the single entry point ProjectContext consults.
// git → markers, clamped, junk-filtered, cached.
// ---------------------------------------------------------------------------

export function findProjectBoundary(
    absPath: string,
    opts?: BoundaryOptions
): BoundaryResult | null {
    const resolved = path.resolve(absPath);
    // Key on the FULL resolved path: inputs are files AND directories, and a
    // dirname key would collapse sibling directories into one entry (review
    // finding P1-2: /work/a cached null would shadow /work/b's real repo).
    const cacheKey = `${opts?.cacheSalt ?? ''}:${opts?.generation ?? 0}:${resolved}`;

    if (!opts?.noCache) {
        const cached = cacheGet(cacheKey);
        if (cached !== undefined) return cached;
    }

    const compute = (): BoundaryResult | null => {
        const gitRoot = findGitRoot(resolved);
        if (gitRoot) {
            const clamped = clampToAllowed(gitRoot, resolved, opts?.allowedDirectories);
            if (!isJunkRoot(clamped)) return { root: clamped, method: 'git' };
        }
        const markerRoot = findMarkerRoot(resolved);
        if (markerRoot) {
            const clamped = clampToAllowed(markerRoot, resolved, opts?.allowedDirectories);
            if (!isJunkRoot(clamped)) return { root: clamped, method: 'marker' };
        }
        return null;
    };

    const result = compute();
    if (opts?.noCache) return result;
    return cacheSet(cacheKey, result);
}
