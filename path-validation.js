import path from 'path';
import os from 'os';

const normalizeCache = new Map();
const MAX_CACHE_SIZE = 1000;

/**
 * Normalizes a path for Linux/Unix systems.
 * Resolves ~, strips quotes, collapses slashes, resolves . and .. segments.
 */
export function normalizePath(p) {
    if (typeof p !== 'string' || !p) return p;
    
    // Check cache
    const cached = normalizeCache.get(p);
    if (cached) return cached;
    
    // Strip surrounding quotes and whitespace
    let result = p.trim().replace(/^["']|["']$/g, '');
    
    // Reject null bytes
    if (result.includes('\x00')) {
        throw new Error('Path contains null bytes');
    }
    
    // Expand home directory
    if (result.startsWith('~/') || result === '~') {
        result = path.join(os.homedir(), result.slice(1));
    }
    
    // Use Node's path.normalize to resolve . and .. and collapse slashes
    result = path.normalize(result);
    
    // Remove trailing slash (unless root)
    if (result.length > 1 && result.endsWith('/')) {
        result = result.slice(0, -1);
    }
    
    // Cache result
    if (normalizeCache.size >= MAX_CACHE_SIZE) {
        const firstKey = normalizeCache.keys().next().value;
        normalizeCache.delete(firstKey);
    }
    normalizeCache.set(p, result);
    
    return result;
}

/**
 * Expands home directory tilde in paths
 */
export function expandHome(filepath) {
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}
/**
 * Check if a path is within allowed directories
 */
export function isPathWithinAllowedDirectories(filePath, allowedDirectories) {
    const normalized = normalizePath(filePath);
    const resolved = path.resolve(normalized);
    return allowedDirectories.some(dir => {
        const normalizedDir = path.resolve(normalizePath(dir));
        return resolved === normalizedDir || resolved.startsWith(normalizedDir + '/');
    });
}

