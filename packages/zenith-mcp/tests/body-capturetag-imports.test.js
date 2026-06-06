// body-capturetag-imports.test.js
//
// Unit tests for three pure, tree-sitter-free modules added in this PR:
//   - dist/core/tree-sitter/body.js        (bodySlice, bodyHash)
//   - dist/core/tree-sitter/capture-tags.js (parseCaptureTag)
//   - dist/core/tree-sitter/imports.js     (extractImportsFromSymbols)

import { describe, expect, it } from 'vitest';
import { bodySlice, bodyHash } from '../dist/core/tree-sitter/body.js';
import { parseCaptureTag } from '../dist/core/tree-sitter/capture-tags.js';
import { extractImportsFromSymbols } from '../dist/core/tree-sitter/imports.js';

// ---------------------------------------------------------------------------
// bodySlice
// ---------------------------------------------------------------------------

describe('bodySlice', () => {
    const source = 'line1\nline2\nline3\nline4\nline5';

    it('returns the requested line range (1-based, inclusive)', () => {
        expect(bodySlice(source, 1, 1)).toBe('line1');
        expect(bodySlice(source, 2, 3)).toBe('line2\nline3');
        expect(bodySlice(source, 1, 5)).toBe(source);
    });

    it('handles a single line', () => {
        expect(bodySlice('hello world', 1, 1)).toBe('hello world');
    });

    it('returns empty string when startLine > total lines (slice beyond end)', () => {
        // slice(10, 12) on a 5-line array returns []
        expect(bodySlice(source, 10, 12)).toBe('');
    });

    it('treats endLine larger than file length as clamp-to-end (slice is safe)', () => {
        // lines.slice(4-1, 99) returns ['line4','line5']
        expect(bodySlice(source, 4, 99)).toBe('line4\nline5');
    });

    it('works with empty source', () => {
        expect(bodySlice('', 1, 1)).toBe('');
    });

    it('preserves indentation and special characters in the slice', () => {
        const src = 'function foo() {\n  return `${bar}`;\n}';
        expect(bodySlice(src, 2, 2)).toBe('  return `${bar}`;');
    });
});

// ---------------------------------------------------------------------------
// bodyHash
// ---------------------------------------------------------------------------

describe('bodyHash', () => {
    it('returns a 40-character hex string (SHA-1)', () => {
        const h = bodyHash('hello world');
        expect(h).toHaveLength(40);
        expect(h).toMatch(/^[0-9a-f]{40}$/);
    });

    it('is deterministic — same input always yields same hash', () => {
        const input = 'function foo(x) { return x + 1; }';
        expect(bodyHash(input)).toBe(bodyHash(input));
    });

    it('differs for different inputs', () => {
        const h1 = bodyHash('function a() {}');
        const h2 = bodyHash('function b() {}');
        expect(h1).not.toBe(h2);
    });

    it('handles empty string', () => {
        const h = bodyHash('');
        expect(h).toHaveLength(40);
        expect(h).toMatch(/^[0-9a-f]{40}$/);
    });

    it('is sensitive to whitespace differences', () => {
        expect(bodyHash('foo')).not.toBe(bodyHash('foo '));
    });

    it('is composable with bodySlice', () => {
        const src = 'line1\nline2\nline3';
        const slice = bodySlice(src, 1, 2);
        const h = bodyHash(slice);
        expect(h).toHaveLength(40);
        expect(h).toBe(bodyHash('line1\nline2'));
    });
});

// ---------------------------------------------------------------------------
// parseCaptureTag
// ---------------------------------------------------------------------------

describe('parseCaptureTag', () => {
    it('parses name.definition.function → role def, type function', () => {
        const result = parseCaptureTag('name.definition.function');
        expect(result).not.toBeNull();
        expect(result.role).toBe('def');
        expect(result.type).toBe('function');
        expect(result.raw).toBe('definition.function');
    });

    it('parses name.definition.class → role def, type class', () => {
        const result = parseCaptureTag('name.definition.class');
        expect(result).not.toBeNull();
        expect(result.role).toBe('def');
        expect(result.type).toBe('class');
    });

    it('parses definition.method (without name. prefix) → role def, type method', () => {
        const result = parseCaptureTag('definition.method');
        expect(result).not.toBeNull();
        expect(result.role).toBe('def');
        expect(result.type).toBe('method');
        expect(result.raw).toBe('definition.method');
    });

    it('parses name.reference.import → role ref, type import', () => {
        const result = parseCaptureTag('name.reference.import');
        expect(result).not.toBeNull();
        expect(result.role).toBe('ref');
        expect(result.type).toBe('import');
        expect(result.raw).toBe('reference.import');
    });

    it('parses reference.call (without name. prefix) → role ref, type call', () => {
        const result = parseCaptureTag('reference.call');
        expect(result).not.toBeNull();
        expect(result.role).toBe('ref');
        expect(result.type).toBe('call');
    });

    it('parses name.reference.module → role ref, type module', () => {
        const result = parseCaptureTag('name.reference.module');
        expect(result).not.toBeNull();
        expect(result.role).toBe('ref');
        expect(result.type).toBe('module');
    });

    it('returns null for unrelated capture names', () => {
        expect(parseCaptureTag('scope')).toBeNull();
        expect(parseCaptureTag('local.definition')).toBeNull();
        expect(parseCaptureTag('injection.content')).toBeNull();
        expect(parseCaptureTag('')).toBeNull();
    });

    it('returns null for unknown prefixes (not definition/reference)', () => {
        expect(parseCaptureTag('highlight.function')).toBeNull();
        expect(parseCaptureTag('name.highlight.function')).toBeNull();
    });

    it('strips the name. prefix correctly — raw does not include it', () => {
        const r = parseCaptureTag('name.definition.variable');
        expect(r).not.toBeNull();
        expect(r.raw).toBe('definition.variable');
        expect(r.raw).not.toContain('name.');
    });

    it('handles multi-segment types (e.g. definition.function.arrow)', () => {
        const r = parseCaptureTag('definition.function.arrow');
        expect(r).not.toBeNull();
        expect(r.role).toBe('def');
        expect(r.type).toBe('function.arrow');
    });
});

// ---------------------------------------------------------------------------
// extractImportsFromSymbols
// ---------------------------------------------------------------------------

/** Minimal SymbolInfo factory for testing. */
function sym(kind, type, name, line, col = 0) {
    return { kind, type, name, line, endLine: line, column: col };
}

describe('extractImportsFromSymbols', () => {
    it('returns empty array when no import-type refs exist', () => {
        const symbols = [
            sym('def', 'function', 'foo', 1),
            sym('ref', 'call', 'console', 5),
        ];
        expect(extractImportsFromSymbols(symbols)).toEqual([]);
    });

    it('extracts a single module ref as an import with no named imports', () => {
        const symbols = [sym('ref', 'module', 'path', 1)];
        const imports = extractImportsFromSymbols(symbols);
        expect(imports).toHaveLength(1);
        expect(imports[0]).toMatchObject({ module: 'path', importedNames: [], line: 1 });
    });

    it('groups module + import refs on the same line into one ImportEdge', () => {
        // e.g. `import { readFile, writeFile } from 'fs/promises'` at line 3
        const symbols = [
            sym('ref', 'module', 'fs/promises', 3),
            sym('ref', 'import', 'readFile', 3),
            sym('ref', 'import', 'writeFile', 3),
        ];
        const imports = extractImportsFromSymbols(symbols);
        expect(imports).toHaveLength(1);
        const imp = imports[0];
        expect(imp.module).toBe('fs/promises');
        expect(imp.importedNames).toContain('readFile');
        expect(imp.importedNames).toContain('writeFile');
        expect(imp.line).toBe(3);
    });

    it('handles multiple import statements on different lines', () => {
        const symbols = [
            sym('ref', 'module', 'fs', 1),
            sym('ref', 'import', 'readFileSync', 1),
            sym('ref', 'module', 'path', 2),
            sym('ref', 'import', 'join', 2),
            sym('ref', 'import', 'resolve', 2),
        ];
        const imports = extractImportsFromSymbols(symbols);
        expect(imports).toHaveLength(2);
        const fsImp = imports.find(i => i.module === 'fs');
        expect(fsImp).toBeDefined();
        expect(fsImp.importedNames).toEqual(['readFileSync']);
        const pathImp = imports.find(i => i.module === 'path');
        expect(pathImp).toBeDefined();
        expect(pathImp.importedNames).toHaveLength(2);
    });

    it('ignores def symbols and non-import/module ref types', () => {
        const symbols = [
            sym('def', 'function', 'myFunc', 1),
            sym('ref', 'call', 'console', 5),
            sym('ref', 'module', 'crypto', 3),
        ];
        const imports = extractImportsFromSymbols(symbols);
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('crypto');
    });

    it('uses importedNames[0] as module when no module-type ref exists on that line', () => {
        // Rare case: only 'import'-type refs on a line (no 'module' ref)
        const symbols = [sym('ref', 'import', 'something', 7)];
        const imports = extractImportsFromSymbols(symbols);
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('something');
        expect(imports[0].importedNames).toEqual(['something']);
    });

    it('returns empty array for an empty symbol list', () => {
        expect(extractImportsFromSymbols([])).toEqual([]);
    });

    it('preserves correct line numbers', () => {
        const symbols = [
            sym('ref', 'module', 'os', 10),
            sym('ref', 'import', 'cpus', 10),
            sym('ref', 'module', 'cluster', 42),
        ];
        const imports = extractImportsFromSymbols(symbols);
        expect(imports.find(i => i.module === 'os').line).toBe(10);
        expect(imports.find(i => i.module === 'cluster').line).toBe(42);
    });

    it('boundary: single import ref with type=import on its own line (no module companion)', () => {
        const symbols = [sym('ref', 'import', 'EventEmitter', 1)];
        const imports = extractImportsFromSymbols(symbols);
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('EventEmitter');
    });
});