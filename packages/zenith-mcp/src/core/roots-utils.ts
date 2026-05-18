import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { normalizePath } from './path-utils.js';

async function parseRootUri(rootUri: string) {
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
        const resolvedPath = await fs.realpath(absolutePath);
        return normalizePath(resolvedPath);
    } catch {
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
