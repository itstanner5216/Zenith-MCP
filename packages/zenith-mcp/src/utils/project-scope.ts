import path from 'path';
import fs from 'fs';
import { findRepoRoot } from '../core/symbol-index.js';
import { ProjectRegistry } from '../core/project-registry.js';

// ---------------------------------------------------------------------------
// Project scoping — one source of truth for resolving a file to its project root
//
// Resolution ladder (in order):
//   1. Git repo detection from the file path itself
//   2. MCP roots / allowed directories → git detection on each, with single-dir fallback
//   3. Marker-based detection (deepest marker within git root, or nearest without git)
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

const _cache = new Map<string, string | null>();

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
export function resolveProjectRoot(filePath: string, options?: ResolveOptions): string | null {
  const absPath = path.resolve(filePath);

  // Check cache unless bypassed
  if (!options?.noCache && _cache.has(absPath)) {
    return _cache.get(absPath)!;
  }

  // Step 1: Git repo detection from the file path itself
  try {
    const gitRoot = findRepoRoot(absPath);
    if (gitRoot) {
      _cache.set(absPath, gitRoot);
      return gitRoot;
    }
  } catch {
    // Continue to next steps
  }

  // Step 2: MCP roots / allowed directories
  const allowedRoot = _resolveFromAllowedDirectories(absPath, options?.allowedDirectories);
  if (allowedRoot) {
    _cache.set(absPath, allowedRoot);
    return allowedRoot;
  }

  // Step 3: Marker-based detection
  const markerRoot = _resolveFromMarkers(absPath);
  if (markerRoot) {
    _cache.set(absPath, markerRoot);
    return markerRoot;
  }

  // Step 4: Registry matching (from explicit entries)
  const registryRoot = _resolveFromRegistry(absPath, options?.registryEntries);
  if (registryRoot) {
    _cache.set(absPath, registryRoot);
    return registryRoot;
  }

  // Step 5: Global fallback
  _cache.set(absPath, null);
  return null;
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
 * Step 2: Resolve from allowed directories (MCP roots / CLI args).
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

  // Try git detection on each allowed directory
  for (const dir of allowedDirectories) {
    try {
      const gitRoot = findRepoRoot(dir);
      if (gitRoot) {
        // Check if the file path is within this git root
        if (isWithinProject(absPath, gitRoot)) {
          return gitRoot;
        }
      }
    } catch {
      // Continue to next dir
    }
  }

  // If exactly one allowed dir and the file is inside it, use it
  if (allowedDirectories.length === 1) {
    const dir = path.resolve(allowedDirectories[0]);
    if (isWithinProject(absPath, dir)) {
      return dir;
    }
  }

  // If file path is inside any allowed dir, return the most specific (longest) match
  let best: string | null = null;
  for (const dir of allowedDirectories) {
    const resolved = path.resolve(dir);
    if (isWithinProject(absPath, resolved)) {
      if (!best || resolved.length > best.length) {
        best = resolved;
      }
    }
  }

  return best;
}

/**
 * Step 3: Walk up from a file path looking for project markers.
 *
 * With git:    returns the DEEPEST marker still at or below the git root
 * Without git: returns the NEAREST marker (first one walking up).
 */
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

    if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) {
      candidates.push(dir);

      // No git root: nearest marker wins immediately
      if (!ceiling || ceiling === fsRoot) {
        return dir;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Git root present: return the deepest candidate (closest to file)
  return candidates.length > 0 ? candidates[0] : null;
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
