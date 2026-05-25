import path from 'path';
import fs from 'fs';
import { findRepoRoot } from '../core/symbol-index.js';
import { ProjectRegistry } from '../core/project-registry.js';

// ---------------------------------------------------------------------------
// Project scoping — one source of truth for resolving a file to its project root
//
// Resolution ladder (in order):
//   1. Git repo detection from the file path itself
//   2. Marker-based detection (deepest marker within git root, or nearest without git)
//   3. MCP roots / allowed directories → git detection on each, with single-dir fallback
//   4. ProjectRegistry matching (from provided entries or allowed directories)
//   5. Global fallback (null)
// ---------------------------------------------------------------------------

const PROJECT_MARKERS = [
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
  '.git',
];

const MARKER_EXCLUDE_DIRS = new Set([
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
    const value = _cache.get(key);
    if (value === undefined) return undefined;
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

export interface ResolveOptions {
  /** Allowed directories (from MCP roots or CLI args) */
  allowedDirectories?: string[];
  /** Pre-built registry entries for explicit project matching */
  registryEntries?: import('../core/project-registry.js').ProjectManifest[];
  /** Skip the cache and re-resolve */
  noCache?: boolean;
}

/**
 * Resolve a file path to its project root using the full detection ladder.
 *
 * @param filePath — any file path (relative, absolute, with ~, etc.)
 * @param options — optional allowed directories and registry entries
 * @returns the resolved project root, or null if no project found
 */
function getMostSpecificAllowedRoot(absPath: string, allowedDirectories?: string[]): string | null {
    if (!allowedDirectories?.length) return null;
    const match = [...allowedDirectories]
        .map(dir => path.resolve(dir))
        .filter(dir => isWithinProject(absPath, dir))
        .sort((a, b) => b.length - a.length)[0];
    return match ?? null;
}

function clampToAllowed(candidate: string | null, absPath: string, allowedDirectories?: string[]): string | null {
    if (!allowedDirectories?.length) return candidate;
    const allowedRoot = getMostSpecificAllowedRoot(absPath, allowedDirectories);
    if (!allowedRoot) return null;
    if (!candidate) return null;

    // If the candidate is within or equal to ANY allowed directory, return it as-is.
    // This prevents over-clamping when e.g. both /repo and /repo/packages/pkg are
    // allowed and the git root is /repo — without this check, getMostSpecificAllowedRoot
    // returns /repo/packages/pkg and clamps /repo down to it incorrectly.
    const resolvedAllowed = allowedDirectories.map(dir => path.resolve(dir));
    if (resolvedAllowed.some(dir => isWithinProject(candidate, dir))) return candidate;

    // Candidate is above (contains) the allowed root — clamp down
    if (isWithinProject(allowedRoot, candidate)) return allowedRoot;
    // Candidate is within the allowed root — keep it
    if (isWithinProject(candidate, allowedRoot)) return candidate;
    return null;
}

export function resolveProjectRoot(filePath: string, options?: ResolveOptions): string | null {
    const absPath = path.resolve(filePath);
    const cacheKey = buildCacheKey(absPath, options);

    if (!options?.noCache) {
        const cached = getCached(cacheKey);
        if (cached !== undefined) return cached;
    }

    // Check if the path is within any allowed directory.
    // Steps 1-2 only run when the path is inside allowed directories
    // (or when no allowed directories are configured).
    // Steps 3-4 ALWAYS run — the whole point of Step 3 is to handle the
    // case where the file path itself isn't inside a known project.
    const pathInsideAllowed = !options?.allowedDirectories?.length ||
        !!getMostSpecificAllowedRoot(absPath, options.allowedDirectories);

    // Step 1: Git root from the file path (only when path is inside allowed dirs)
    let rawGitRoot: string | null = null;
    let gitRoot: string | null = null;
    if (pathInsideAllowed) {
        try {
            rawGitRoot = findRepoRoot(absPath);
            gitRoot = clampToAllowed(rawGitRoot, absPath, options?.allowedDirectories);
        } catch (_err) {
            // findRepoRoot may throw for non-git paths
        }
    }

    // Step 2: Marker-based detection — finds the deepest marker root.
    // Pass the pre-detected raw git root to avoid a redundant findRepoRoot call.
    // Within a git repo this finds the deepest package root (e.g. monorepo package).
    // Without git this finds the nearest marker walking up.
    let markerRoot: string | null = null;
    if (pathInsideAllowed) {
        markerRoot = clampToAllowed(_resolveFromMarkers(absPath, rawGitRoot), absPath, options?.allowedDirectories);
    }

    // Prefer the deepest (most specific) root between git and markers.
    // In a monorepo, markerRoot (e.g. /repo/packages/app) is deeper than gitRoot (/repo).
    if (markerRoot && gitRoot) {
        const result = markerRoot.length >= gitRoot.length ? markerRoot : gitRoot;
        return setCached(cacheKey, result);
    }
    if (markerRoot) return setCached(cacheKey, markerRoot);
    if (gitRoot) return setCached(cacheKey, gitRoot);

    // Step 3: MCP roots / allowed directories (ALWAYS runs — this is the
    // fallback for when the file path itself isn't inside a known project)
    const allowedRoot = _resolveFromAllowedDirectories(absPath, options?.allowedDirectories);
    if (allowedRoot) return setCached(cacheKey, allowedRoot);

    // Step 4: Registry matching (ALWAYS runs)
    const registryRoot = _resolveFromRegistry(absPath, options?.registryEntries);
    if (registryRoot) return setCached(cacheKey, registryRoot);

    return setCached(cacheKey, null);
}

/**
 * Check if a file path is within a given project root.
 */
export function isWithinProject(filePath: string, projectRoot: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(projectRoot);
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep);
}

/**
 * Get a stable project identifier for a file path.
 * Returns the resolved project root path, or null if no project found.
 */
export function getProjectId(filePath: string, options?: ResolveOptions): string | null {
  const root = resolveProjectRoot(filePath, options);
  return root ?? null;
}

/**
 * Clear the internal project root cache. Call this when the filesystem changes
 * significantly (e.g., roots changed, new projects cloned, etc.).
 */
export function clearProjectScopeCache(): void {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Step 3: Resolve from allowed directories (MCP roots / CLI args).
 *
 * For each allowed directory:
 *   - Try git detection
 *   - If no git found but there's exactly one allowed dir, return it
 *   - Otherwise fall through
 */
function _resolveFromAllowedDirectories(
  absPath: string,
  allowedDirectories?: string[]
): string | null {
  if (!allowedDirectories || allowedDirectories.length === 0) return null;

  // Sort to match cache key ordering — ensures same result regardless of input order
  const sortedDirs = [...allowedDirectories].map(d => path.resolve(d)).sort();

  // Try git detection on each allowed directory
  for (const resolvedDir of sortedDirs) {
    try {
      const gitRoot = findRepoRoot(resolvedDir);
      if (gitRoot) {
        // Clamp: if the git root escapes above the allowed directory, use the allowed directory.
        // This guards new-file paths where findRepoRoot(absPath) fails but findRepoRoot(allowedDir)
        // succeeds and resolves to a parent repo root outside the sandbox.
        const effectiveRoot = isWithinProject(resolvedDir, gitRoot) ? resolvedDir : gitRoot;
        if (isWithinProject(absPath, effectiveRoot)) {
          return effectiveRoot;
        }
      }
    } catch (err) {
      void err; // findRepoRoot may fail for non-git dirs — skip
    }
  }

  // If exactly one allowed dir and the file is inside it, use it
  if (sortedDirs.length === 1) {
    const onlyDir = sortedDirs[0];
    if (onlyDir !== undefined && isWithinProject(absPath, onlyDir)) {
      return onlyDir;
    }
  }

  // If file path is inside any allowed dir, return the most specific (longest) match
  let best: string | null = null;
  for (const resolved of sortedDirs) {
    if (isWithinProject(absPath, resolved)) {
      if (!best || resolved.length > best.length) {
        best = resolved;
      }
    }
  }

  return best;
}

/**
 * Step 2: Walk up from a file path looking for project markers.
 *
 * With git:    returns the DEEPEST marker still at or below the git root
 * Without git: returns the NEAREST marker (first one walking up).
 *
 * Uses targeted existsSync per marker (~15 checks) rather than reading the
 * full directory listing, which is more efficient for large directories.
 *
 * @param gitRoot — pre-detected git root, passed from Step 1 to avoid redundant CLI calls
 */
function _resolveFromMarkers(absPath: string, gitRoot?: string | null): string | null {
    // Use the pre-detected git root as the ceiling instead of re-running findRepoRoot.
    // Fallback to filesystem root when git root is unknown.
    const ceiling = gitRoot ?? path.parse(absPath).root;

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
        } catch (_err) {
            // Unreadable directory — skip
        }

        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    return candidates[0] ?? null;
}

/**
 * Step 4: Check explicit registry entries for a match.
 */
function _resolveFromRegistry(
  absPath: string,
  registryEntries?: import('../core/project-registry.js').ProjectManifest[]
): string | null {
  if (!registryEntries || registryEntries.length === 0) return null;

  const registry = new ProjectRegistry(registryEntries);
  return registry.findProjectRoot(absPath);
}
