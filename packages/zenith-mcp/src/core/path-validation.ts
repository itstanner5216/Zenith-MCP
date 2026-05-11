import path from 'path';
import { normalizePath as _normalizePath, expandHome as _expandHome } from './path-utils.js';

// Re-export for backward compatibility with tests
export { normalizePath, expandHome } from './path-utils.js';

/**
 * Check if a path is within allowed directories
 */
export function isPathWithinAllowedDirectories(filePath: string, allowedDirectories: string[]): boolean {
    const normalized = _normalizePath(filePath);
    const resolved = path.resolve(normalized);
    return allowedDirectories.some(dir => {
        const normalizedDir = path.resolve(_normalizePath(dir));
        return resolved === normalizedDir || resolved.startsWith(normalizedDir + '/');
    });
}
