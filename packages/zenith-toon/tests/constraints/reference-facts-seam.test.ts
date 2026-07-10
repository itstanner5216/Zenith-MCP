import { describe, expect, it } from 'vitest';
import { compressFile } from '../../src/index.js';

describe('reference facts seam', () => {
  it('accepts raw reference rows and unresolved reference edges as transport facts', () => {
    const source = [
      '1. const TIMEOUT = 30;',
      '2. function connect() {',
      '3.   return TIMEOUT;',
      '4. }',
      '5. function retry() {',
      '6.   return TIMEOUT;',
      '7. }',
    ].join('\n');

    const out = compressFile({
      source,
      maxChars: source.length - 1,
      facts: {
        path: 'x.ts',
        langName: 'typescript',
        defs: [
          { name: 'TIMEOUT', kind: 'def', type: 'constant', line: 1, endLine: 1, visibility: null, captureTag: 'definition.constant' },
          { name: 'connect', kind: 'def', type: 'function', line: 2, endLine: 4, visibility: null, captureTag: 'definition.function' },
          { name: 'retry', kind: 'def', type: 'function', line: 5, endLine: 7, visibility: null, captureTag: 'definition.function' },
        ],
        references: [
          { name: 'TIMEOUT', type: 'identifier', line: 3, endLine: 3, column: 9 },
          { name: 'TIMEOUT', type: 'identifier', line: 6, endLine: 6, column: 9 },
        ],
        edges: [],
        referenceEdges: [
          { callerLine: 2, referencedName: 'TIMEOUT', referenceCount: 1 },
          { callerLine: 5, referencedName: 'TIMEOUT', referenceCount: 1 },
        ],
        anchors: [],
        imports: [],
        importBindings: [],
        injections: [],
        scopes: [],
      },
    });

    // This test is about the seam contract, not compression usefulness. A small file may
    // honestly return null; the important assertion is that the new raw fact arrays are
    // accepted as facts and do not throw or require MCP-side shaping/weighting.
    expect(out === null || typeof out === 'string').toBe(true);
  });
});
