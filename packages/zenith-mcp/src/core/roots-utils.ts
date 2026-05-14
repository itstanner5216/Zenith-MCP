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

function formatDirectoryError(dir: string, error: unknown, reason?: string) {
    if (reason) {
        return `Skipping ${reason}: ${dir}`;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Skipping invalid directory: ${dir} due to error: ${message}`;
}

export async function getValidRootDirectories(requestedRoots: Array<{ uri: string; name?: string }>) {
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
            }
            else {
                console.error(formatDirectoryError(resolvedPath, undefined, 'non-directory root'));
            }
        }
        catch (error) {
            console.error(formatDirectoryError(resolvedPath, error));
        }
    }
    return validatedDirectories;
}
