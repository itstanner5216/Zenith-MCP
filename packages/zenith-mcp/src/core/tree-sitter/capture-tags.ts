// ---------------------------------------------------------------------------
// tree-sitter/capture-tags.ts — Capture name parser
//
// Invariant: Pure function, no side effects, no imports from sibling modules.
// Only this file classifies raw tree-sitter capture names into role/type pairs.
// ---------------------------------------------------------------------------

export interface ParsedCaptureTag {
    role: 'def' | 'ref';
    type: string;       // e.g. 'function', 'method', 'import', 'module'
    raw: string;        // e.g. 'definition.function', 'reference.import'
}

/**
 * Parse a capture tag from tree-sitter query matches.
 *
 * Examples:
 *   'name.definition.function' → { role: 'def', type: 'function', raw: 'definition.function' }
 *   'definition.class'         → { role: 'def', type: 'class', raw: 'definition.class' }
 *   'name.reference.import'    → { role: 'ref', type: 'import', raw: 'reference.import' }
 *   'reference.call'           → { role: 'ref', type: 'call', raw: 'reference.call' }
 *
 * Returns null for captures that don't match definition/reference patterns.
 */
export function parseCaptureTag(captureName: string): ParsedCaptureTag | null {
    const name = captureName.startsWith('name.') ? captureName.slice(5) : captureName;
    if (name.startsWith('definition.')) {
        return { role: 'def', type: name.slice(11), raw: name };
    }
    if (name.startsWith('reference.')) {
        return { role: 'ref', type: name.slice(10), raw: name };
    }
    return null;
}
