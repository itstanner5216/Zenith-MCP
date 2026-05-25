import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { normalizePath } from './path-utils.js';

async function parseRootUri(rootUri: string): Promise<{ path: string } | { error: string }> {
    try {
        let rawPath: string;
        if (rootUri.startsWith('file:')) {
            const afterScheme = rootUri.slice('file:'.length);
            // Handle non-standard file:~ and file:~/... forms before URL parsing,
            // because new URL('file:~/repo') normalizes the path to '/~' and loses
            // the home-directory expansion semantics.
            const pathPart = afterScheme.startsWith('///')
                ? afterScheme.slice(2)
                : afterScheme.startsWith('//')
                    ? afterScheme.slice(afterScheme.indexOf('/', 2))
                    : afterScheme;
            if (pathPart === '~' || pathPart.startsWith('~/')) {
                rawPath = pathPart;
            } else {
                try {
                    rawPath = fileURLToPath(new URL(rootUri));
                } catch (urlError) {
                    void urlError;
                    rawPath = pathPart;
                }
            }
        } else {
            rawPath = rootUri;
        }

        const expandedPath = rawPath === '~' || rawPath.startsWith('~/')
            ? path.join(os.homedir(), rawPath.slice(1))
            : rawPath;

        const absolutePath = path.resolve(expandedPath);

        try {
            const resolvedPath = await fs.realpath(absolutePath);
            return { path: normalizePath(resolvedPath) };
        } catch {
            // realpath failed — path doesn't exist or permission error.
            // Try stat to distinguish "not found" from "permission denied".
            try {
                await fs.stat(absolutePath);
                return { path: normalizePath(absolutePath) };
            } catch (statErr) {
                const code = statErr instanceof Error && 'code' in statErr
                    ? (statErr as NodeJS.ErrnoException).code ?? ''
                    : '';
                return {
                    error: `${absolutePath}: ${
                        code === 'ENOENT' ? 'does not exist' :
                        code === 'EACCES' ? 'permission denied' :
                        String(statErr)
                    }`
                };
            }
        }
    } catch (err) {
        return { error: `failed to parse URI "${rootUri}": ${err instanceof Error ? err.message : String(err)}` };
    }
}

/**
 * Resolve a single root URI to a filesystem path.
 * Returns the resolved path string, or null if resolution fails.
 * Exported for use by callers that need to resolve individual URIs (e.g. for registry seeding).
 */
export async function parseRootUriPath(rootUri: string): Promise<string | null> {
    const result = await parseRootUri(rootUri);
    return 'path' in result ? result.path : null;
}

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
