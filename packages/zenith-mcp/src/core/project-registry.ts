import path from 'path';
import { normalizePath } from './path-utils.js';

// ---------------------------------------------------------------------------
// ProjectManifest — explicit project definition
// ---------------------------------------------------------------------------

export interface ProjectManifest {
    project_id: string;
    project_name: string | null;
    project_root: string; // Always stored as normalized absolute path
    description?: string | null;
    language?: string | null;
    tags?: string[];
    include?: string[];
    exclude?: string[];
    entry_point?: string | null;
}

// ---------------------------------------------------------------------------
// ProjectRegistry — explicit project resolution with robust matching
//
// Matching strategy (in order of priority):
//   1. Exact match on project_id (case-insensitive)
//   2. Exact match on project_name (case-insensitive)
//   3. Leading path-segment match on project_id or project_name
//      (e.g. "cool-api/src/server.py" → "cool-api")
//   4. Exact match on normalized project_root path
//   5. Path-prefix match: input is inside a project_root (longest wins)
//
// Deliberately does NOT do:
//   - Substring/fuzzy matching (too many false positives)
//   - Basename-only matching (ambiguous across projects)
// ---------------------------------------------------------------------------

export class ProjectRegistry {
    private _manifests: Map<string, ProjectManifest>;
    private _byId: Map<string, ProjectManifest> = new Map();
    private _byName: Map<string, ProjectManifest> = new Map();
    private _byPath: Map<string, ProjectManifest> = new Map();

    constructor(manifests: Map<string, ProjectManifest> | ProjectManifest[] = []) {
        this._manifests = new Map();

        const entries = manifests instanceof Map ? Array.from(manifests.values()) : manifests;
        for (const manifest of entries) {
            this.register(manifest);
        }
    }

    /**
     * Register or update a project manifest.
     */
    register(manifest: ProjectManifest): void {
        this._manifests.set(manifest.project_id, manifest);

        // ID lookup (case-insensitive)
        const idKey = manifest.project_id.toLowerCase();
        if (this._byId.has(idKey)) {
            console.warn(`[ProjectRegistry] Duplicate project_id '${manifest.project_id}' — overwriting`);
        }
        this._byId.set(idKey, manifest);

        // Name lookup (case-insensitive)
        if (manifest.project_name) {
            const nameKey = manifest.project_name.toLowerCase();
            if (this._byName.has(nameKey)) {
                console.warn(`[ProjectRegistry] Duplicate project_name '${manifest.project_name}' — overwriting`);
            }
            this._byName.set(nameKey, manifest);
        }

        // Path lookup (normalized)
        const pathKey = normalizePath(path.resolve(manifest.project_root));
        if (this._byPath.has(pathKey)) {
            console.warn(`[ProjectRegistry] Duplicate project_root '${manifest.project_root}' — overwriting`);
        }
        this._byPath.set(pathKey, manifest);
    }

    /**
     * Remove a project from the registry.
     */
    unregister(projectId: string): void {
        const manifest = this._manifests.get(projectId);
        if (!manifest) return;

        this._manifests.delete(projectId);
        this._byId.delete(projectId.toLowerCase());
        if (manifest.project_name) {
            this._byName.delete(manifest.project_name.toLowerCase());
        }
        const pathKey = normalizePath(path.resolve(manifest.project_root));
        this._byPath.delete(pathKey);
    }

    /**
     * Find a project by ID, name, or path.
     */
    findProject(anything: string | null): ProjectManifest | null {
        if (!anything || !anything.trim()) return null;

        const query = anything.trim();
        const lowered = query.toLowerCase();

        // 1. Exact match on project_id
        let match = this._byId.get(lowered);
        if (match) {
            return match;
        }

        // 2. Exact match on project_name
        match = this._byName.get(lowered);
        if (match) {
            return match;
        }

        // 3. Leading path-segment match on project_id or project_name
        if (query.includes('/') || query.includes(path.sep)) {
            const firstSegment = query.split(/[\/]/)[0].trim().toLowerCase();
            if (firstSegment) {
                match = this._byId.get(firstSegment);
                if (match) return match;
                match = this._byName.get(firstSegment);
                if (match) return match;
            }
        }

        // 4. Exact match on normalized path
        let normalizedPath: string;
        try {
            normalizedPath = normalizePath(path.resolve(query));
        } catch {
            return null;
        }

        match = this._byPath.get(normalizedPath);
        if (match) {
            return match;
        }

        // 5. Path-prefix match: query is INSIDE a project_root
        //    Pick the longest (most specific) root that matches
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

        return null;
    }

    /**
     * Find a project root by ID, name, or path.
     * Returns just the root path, or null if no match.
     */
    findProjectRoot(anything: string | null): string | null {
        const manifest = this.findProject(anything);
        return manifest?.project_root ?? null;
    }

    listProjects(): ProjectManifest[] {
        return Array.from(this._manifests.values());
    }

    getById(projectId: string): ProjectManifest | null {
        return this._byId.get(projectId.toLowerCase()) ?? null;
    }

    lookup(projectId: string): ProjectManifest | null {
        return this.getById(projectId);
    }
}
