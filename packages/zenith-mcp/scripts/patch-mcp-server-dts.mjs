#!/usr/bin/env node
// Fixes a packaging bug in @modelcontextprotocol/server's bundled type
// declarations. Its `.d.ts` bundler (tsdown/rolldown) inlines ajv's
// `UriResolver` interface but DROPS the `import { URIComponent } from "fast-uri"`
// that interface depends on, leaving a dangling type reference:
//
//   ajvProvider-<hash>.d.mts: error TS2304: Cannot find name 'URIComponent'.
//
// fast-uri is only a devDependency of the SDK and is not resolvable from the
// published package, so re-adding the import would just become TS2307. Instead
// we restore the dropped type by inlining fast-uri's real `URIComponent` shape
// (fully typed, not `any`) — exactly what a correct bundler would have emitted.
//
// The broken filename carries a content hash that changes every SDK release, so
// we glob rather than pin, and the patch is idempotent + self-healing: it runs
// before every tsc invocation and no-ops once upstream ships a corrected bundle.
// Delete this script (and its hook in package.json) when that happens.

import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL = 'interface URIComponent';
const ANCHOR = 'interface UriResolver {';
const URICOMPONENT = `interface URIComponent {
  scheme?: string;
  userinfo?: string;
  host?: string;
  port?: number | string;
  path?: string;
  query?: string;
  fragment?: string;
  reference?: string;
  nid?: string;
  nss?: string;
  resourceName?: string;
  secure?: boolean;
  uuid?: string;
  error?: string;
}
`;

// Walk up from this script to find @modelcontextprotocol/server/dist, tolerant
// of pnpm's symlinked virtual store and dependency hoisting.
const here = path.dirname(fileURLToPath(import.meta.url));
let dist = null;
for (let dir = here; ; ) {
  const candidate = path.join(dir, 'node_modules', '@modelcontextprotocol', 'server', 'dist');
  if (existsSync(candidate)) {
    dist = realpathSync(candidate);
    break;
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

if (dist === null) {
  console.log('[patch-mcp-server-dts] @modelcontextprotocol/server not found; nothing to patch.');
  process.exit(0);
}

let patched = 0;
for (const file of readdirSync(dist)) {
  if (!/^ajvProvider-.*\.d\.mts$/.test(file)) continue;
  const full = path.join(dist, file);
  const src = readFileSync(full, 'utf8');
  if (!/\bURIComponent\b/.test(src)) continue; // type not referenced in this bundle
  if (src.includes(SENTINEL)) continue; // already defined / already patched
  if (src.includes('import { URIComponent }')) continue; // upstream restored the import

  const at = src.indexOf(ANCHOR);
  let next;
  if (at !== -1) {
    next = src.slice(0, at) + URICOMPONENT + src.slice(at);
  } else {
    // Fallback: inject after the last top-of-file import statement.
    const lines = src.split('\n');
    let lastImport = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^import\b/.test(lines[i])) lastImport = i;
      else if (lastImport !== -1 && lines[i].trim() !== '') break;
    }
    lines.splice(lastImport + 1, 0, '', URICOMPONENT.trimEnd());
    next = lines.join('\n');
  }
  writeFileSync(full, next);
  patched += 1;
  console.log(`[patch-mcp-server-dts] restored URIComponent in ${path.relative(process.cwd(), full)}`);
}

if (patched === 0) {
  console.log('[patch-mcp-server-dts] no changes needed (already fixed or upstream resolved).');
}
