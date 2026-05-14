/**
 * Shared utility functions for retrieval modules.
 */

export function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
