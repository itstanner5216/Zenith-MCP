import { describe, expect, it } from 'vitest';
import { compressFile } from '../../zenith-toon/dist/index.js';

function unsupportedFacts(path) {
  return {
    path,
    langName: null,
    defs: [],
    references: [],
    edges: [],
    referenceEdges: [],
    anchors: [],
    imports: [],
    injections: [],
    scopes: [],
  };
}

describe('TOON unsupported language with empty facts', () => {
  it('returns null for unsupported realistic input when no structural facts are available', () => {
    const source = Array.from({ length: 220 }, (_, i) => `setting_${i}=value_${i}_with_repeated_configuration_context`);
    const prefixedSource = source.map((line, i) => `${i + 1}. ${line}`).join('\n');

    const result = compressFile({
      source: prefixedSource,
      facts: unsupportedFacts('data/example.unknown'),
      maxChars: Math.floor(prefixedSource.length * 0.72),
    });

    expect(result).toBeNull();
  });

  it('also returns null for unsupported stack-trace-shaped input with empty facts', () => {
    const source = [
      "TypeError: Cannot read properties of null (reading 'map')",
      '    at processItems (/app/src/utils.js:42:15)',
      '    at handleRequest (/app/src/server.js:108:9)',
      '    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)',
      '    at next (/app/node_modules/express/lib/router/route.js:144:13)',
      '    at Route.dispatch (/app/node_modules/express/lib/router/route.js:114:3)',
      '    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)',
      '    at /app/node_modules/express/lib/router/index.js:284:15',
      '    at Function.process_params (/app/node_modules/express/lib/router/index.js:346:12)',
    ];
    const prefixedSource = source.map((line, i) => `${i + 1}. ${line}`).join('\n');

    const result = compressFile({
      source: prefixedSource,
      facts: unsupportedFacts('logs/crash.unknownext'),
      maxChars: 100,
    });

    expect(result).toBeNull();
  });

  it('still honors the empty-source guard', () => {
    const result = compressFile({
      source: '',
      facts: unsupportedFacts('docs/empty.prose'),
      maxChars: 100,
    });

    expect(result).toBeNull();
  });
});
