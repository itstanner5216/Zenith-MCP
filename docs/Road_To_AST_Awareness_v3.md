# Road to AST Awareness — v3

**Predecessor:** v2 (`docs/Road_To_AST_Awareness_v2.md`)
**Audit:** `docs/plan_audit/road-to-ast-awareness-audit.md`
**Status:** Fully implementable. No deferrals. No Phase 2.

---

## What Changed Since v2

1. **v2 §"W6: injections table has no consumer" — deferred extraction to Phase 2.** v3 lands `extractInjections`, the `injections` table, `insertInjection`/`getInjectionsForFile` adapter functions, and the consumer (injection spans flow into the facts payload so TOON preserves embedded-language ranges verbatim per Priority 0).

2. **v2 §"core/tree-sitter/structure.ts" — proposed `getSymbolStructure` but deferred per-language node-name tables.** v3 provides literal maps for 18 languages (python, typescript, tsx, javascript, rust, go, java, c_sharp, c, cpp, kotlin, php, ruby, swift, bash, lua, nix, scss) plus explicit fall-through for the 7 queryless grammars.

3. **v2 §"core/indexing/extract.ts" — single parse but actually re-parsed per extractor.** v2's `extractParsedFile` calls `getSymbols` (which parses internally) plus `getSymbolStructure` (which parses again) plus `getBlockAnchors` (which parses again). v3 mandates a single shared tree: parse once in `extract.ts`, pass `tree.rootNode` to every extractor.

4. **v2 §"core/compression.ts — GUTTED" — still constructs `StructureBlock[]` and `CompressionContext` in MCP.** This violates constraints.md §Priority 0.5 ("MCP-side construction of `StructureBlock[]` or `CompressionContext`" is forbidden). v3 removes all TOON-type construction from MCP. MCP passes raw facts; TOON shapes them internally.

5. **v2 §"tools/read_file.ts" — claimed MCP should not compute 0.70 but then showed `budget = maxChars` which TOON internally floors.** This is correct behavior but v2 waffled. v3 is explicit: MCP passes `maxChars` as the budget ceiling. TOON applies its own 70% floor internally in `compressSourceStructured`.

6. **v2 §"core/tree-sitter/imports.ts" — still a full re-parse extractor.** v3 uses the already-parsed tree from `extract.ts` and runs the modular `references.scm` query against it for richer import data (module path string preservation), not just post-processing flat symbol rows.

7. **v2 §"Injections" — `ParsedFileRecord.injections` field was declared but `InjectionRow` was absent from `types.ts`.** v3 adds the full type and wiring.

8. **v2 left the dormant `patterns` table unaddressed.** v3 wires it to `refactor_batch reapply` (the `symbolGroup` cache already uses it for pattern storage; the table just needs the adapter functions called).

9. **v2 left the dormant `project_roots` global registry unwired.** v3 wires `registerRepoRoot` in `getDb()`.

10. **v2's `compressForTool` still imported `StructureBlock`/`CompressionContext` from zenith-toon and shaped them in MCP.** v3 replaces this with a single `compressFile` call that passes raw facts; TOON owns all shaping.

---

## Corrections from Prior Plans

1. **v2 line 12: "`DEF_TYPES` (currently missing from runtime.ts but used by ref-structural-similarity.ts)"** — `DEF_TYPES` does NOT exist anywhere in `runtime.ts` (confirmed: `grep -n DEF_TYPES runtime.ts` returns empty). The ref design doc imports it from `./runtime.js` but that import is fictional. v3 defines `DEF_TYPES` as a new export in `runtime.ts`.

2. **v2 line 148: "`.cs` → `'c_sharp'`" — currently `.cs` maps to `'csharp'` (languages.ts:64).** Both `tree-sitter-csharp.wasm` and `tree-sitter-c_sharp.wasm` exist in `grammars/grammars/`. The rich 91-line `c_sharp-tags.scm` is the correct target. The modular directories `c_sharp/` and `csharp/` have **identical** 61-line `definitions.scm` files. The grammar WASM that matches the richer ctags file is `tree-sitter-c_sharp.wasm`. v3 maps `.cs` → `'c_sharp'`.

3. **This prompt states "7 grammars with WASM but no query files (cmake, dart, elixir, ini, make, perl, r)."** Confirmed correct via filesystem inspection.

4. **AGENTS.md §11 states compression uses a subprocess bridge.** This is stale. Current `compression.ts` (line 12) directly imports `{ compressString, compressSourceStructured } from 'zenith-toon'` — a workspace ESM import, no subprocess. v3 continues the direct ESM import pattern.

5. **This prompt says "`Math.sqrt(call_count)` edge transforms" are forbidden in MCP.** Confirmed: `db-adapter.ts:514` contains `weight: Math.sqrt(row.call_count)` inside `getFileBlockEdges`. v3 removes the sqrt; passes raw `call_count`.

6. **v2 §"resolve.ts" states `ON DELETE SET NULL` on `callee_symbol_id`.** This is correct design — but v2 never specified what re-triggers resolution after callee re-index. v3 specifies: `indexDirectory` calls `resolveEdgeTargets` for all files in the batch after persist completes.

7. **Prompt claims typescript has `injections.scm`.** Confirmed false — only `tsx/injections.scm` exists; `typescript/` directory has no `injections.scm` file. Languages with injections.scm: bash, css, dockerfile, hcl, html, javascript, markdown, nix, php, svelte, tsx, vue, xml (13 total).

---

## Full v3 Architecture

### File Layout

All paths under `packages/zenith-mcp/src/`:

```
core/
  db-adapter.ts                       # EXPANDED: schema v1 migration + new tables + new adapter functions
  symbol-index.ts                     # MODIFIED: delegates to extractors; wires project_roots
  compression.ts                      # GUTTED → thin facts-pipe to zenith-toon
  tree-sitter.ts                      # MODIFIED: re-exports new modules
  tree-sitter/
    languages.ts                      # MODIFIED: .cs → c_sharp
    runtime.ts                        # MODIFIED: add getCompiledModularQuery(), DEF_TYPES, QUERIES_LANG_MAP
    symbols.ts                        # UNCHANGED
    structure.ts                      # NEW — SymbolStructure extraction
    anchors.ts                        # NEW — in-body anchor extraction
    imports.ts                        # NEW — import edge extraction from references.scm captures
    injections.ts                     # NEW — runs injections.scm, yields embedded-language spans
    locals.ts                         # NEW — runs locals.scm, yields per-scope parameters/locals
    body.ts                           # NEW — body slice + sha1 fingerprint
    capture-tags.ts                   # NEW — capture name parser
  indexing/
    extract.ts                        # NEW — single-parse orchestrator for one file
    persist.ts                        # NEW — writes ParsedFileRecord in one transaction
    types.ts                          # NEW — shared shapes between extract & persist
    resolve.ts                        # NEW — cross-file edge resolution
```

---

### `core/tree-sitter/runtime.ts` — MODIFICATIONS

#### New: `DEF_TYPES`

```typescript
/**
 * Node types that represent definition containers across all supported grammars.
 * Used by structure.ts to locate the AST node spanning a symbol's definition.
 */
export const DEF_TYPES: ReadonlySet<string> = new Set([
    // JavaScript/TypeScript
    'function_declaration', 'function_definition', 'method_definition',
    'arrow_function', 'function_expression', 'generator_function_declaration',
    'generator_function', 'class_declaration', 'class_definition',
    'class', 'abstract_class_declaration', 'interface_declaration',
    'type_alias_declaration', 'enum_declaration', 'module',
    'variable_declarator',
    // Rust
    'function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item',
    'mod_item', 'const_item', 'static_item', 'type_item', 'union_item',
    'macro_definition',
    // Go
    'function_declaration', 'method_declaration', 'type_declaration', 'type_spec',
    // Java/Kotlin
    'constructor_declaration', 'annotation_type_declaration', 'record_declaration',
    // Python
    'decorated_definition',
    // C/C++
    'struct_specifier', 'class_specifier', 'namespace_definition',
    // C#
    'namespace_declaration', 'struct_declaration', 'record_declaration',
    'delegate_declaration', 'property_declaration', 'event_declaration',
]);
```

**Insertion point:** After `export const _symbolCache` (line ~61), before the PIC section.

#### New: `QUERIES_LANG_MAP`

```typescript
/**
 * Per-language declaration of which modular query files exist.
 * Derived from `grammars/queries/<lang>/` directory listing.
 * Used by getCompiledModularQuery to avoid filesystem probes for known-absent files.
 */
export const QUERIES_LANG_MAP: Readonly<Record<string, readonly string[]>> = {
    bash:       ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    c:          ['definitions.scm', 'locals.scm', 'references.scm'],
    c_sharp:    ['definitions.scm', 'locals.scm', 'references.scm'],
    cpp:        ['definitions.scm', 'locals.scm', 'references.scm'],
    csharp:     ['definitions.scm', 'locals.scm', 'references.scm'],
    css:        ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    dockerfile: ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    go:         ['definitions.scm', 'locals.scm', 'references.scm'],
    graphql:    ['definitions.scm', 'locals.scm', 'references.scm'],
    hcl:        ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    html:       ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    java:       ['definitions.scm', 'locals.scm', 'references.scm'],
    javascript: ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    json:       ['definitions.scm', 'locals.scm', 'references.scm'],
    kotlin:     ['definitions.scm', 'locals.scm', 'references.scm'],
    lua:        ['definitions.scm', 'locals.scm', 'references.scm'],
    markdown:   ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    nix:        ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    php:        ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    prisma:     ['definitions.scm', 'locals.scm', 'references.scm'],
    proto:      ['definitions.scm', 'locals.scm', 'references.scm'],
    python:     ['definitions.scm', 'locals.scm', 'references.scm'],
    query:      ['definitions.scm', 'locals.scm', 'references.scm'],
    regex:      ['definitions.scm', 'locals.scm', 'references.scm'],
    ruby:       ['definitions.scm', 'locals.scm', 'references.scm'],
    rust:       ['definitions.scm', 'locals.scm', 'references.scm'],
    scss:       ['definitions.scm', 'locals.scm', 'references.scm'],
    sql:        ['definitions.scm', 'locals.scm', 'references.scm'],
    svelte:     ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    swift:      ['definitions.scm', 'locals.scm', 'references.scm'],
    toml:       ['definitions.scm', 'locals.scm', 'references.scm'],
    tsx:        ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    typescript: ['definitions.scm', 'locals.scm', 'references.scm'],
    vue:        ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    xml:        ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm'],
    yaml:       ['definitions.scm', 'locals.scm', 'references.scm'],
};
```

#### New: `getCompiledModularQuery()`

```typescript
const _modularQueryCache: Map<string, Query | null> = new Map();

/**
 * Load and compile a modular query file (locals.scm, injections.scm, etc.).
 * Cached permanently. Returns null if the language has no such file or compilation fails.
 *
 * Does NOT affect the existing getCompiledQuery() for <lang>-tags.scm.
 */
export async function getCompiledModularQuery(langName: string, queryFile: string): Promise<Query | null> {
    const cacheKey = `${langName}:${queryFile}`;
    if (_modularQueryCache.has(cacheKey)) {
        return _modularQueryCache.get(cacheKey) ?? null;
    }

    // Fast reject: check QUERIES_LANG_MAP before touching the filesystem
    const available = QUERIES_LANG_MAP[langName];
    if (!available || !available.includes(queryFile)) {
        _modularQueryCache.set(cacheKey, null);
        return null;
    }

    const language = await loadLanguage(langName);
    if (!language) {
        _modularQueryCache.set(cacheKey, null);
        return null;
    }

    const scmPath = path.join(QUERIES_DIR, langName, queryFile);
    let content: string;
    try {
        content = await fs.readFile(scmPath, 'utf-8');
    } catch {
        _modularQueryCache.set(cacheKey, null);
        return null;
    }

    try {
        const query = new Query(language, content);
        _modularQueryCache.set(cacheKey, query);
        return query;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Failed to compile ${queryFile} for ${langName}: ${message}\n`);
        _modularQueryCache.set(cacheKey, null);
        return null;
    }
}
```

**Insertion point:** After `getCompiledQuery()` (after line 283), before `treeSitterAvailable()`.

---

### `core/tree-sitter/languages.ts` — MODIFICATION

```typescript
// Before (line 64):
'.cs':   'csharp',
// After:
'.cs':   'c_sharp',

// Before (line 66):
'.csx':  'csharp',
// After:
'.csx':  'c_sharp',
```

**Rationale:** `c_sharp-tags.scm` is 91 lines with namespace/struct/interface/enum/record/method/constructor/property/field/event/delegate/enumerator captures + full reference captures. `csharp-tags.scm` is 19 lines with only class/interface/method/module. The grammar WASM is `tree-sitter-c_sharp.wasm`. The `csharp` WASM and query files become dead weight (can be removed in a future cleanup; not deleted by v3 per file-safety policy).

---

### `core/tree-sitter/capture-tags.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/tree-sitter/capture-tags.ts`

```typescript
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
```

---

### `core/tree-sitter/body.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/tree-sitter/body.ts`

```typescript
// ---------------------------------------------------------------------------
// tree-sitter/body.ts — Body slice extraction and fingerprinting
//
// Invariant: Pure functions. No tree-sitter dependency. No sibling imports.
// Canonical location for body hashing — no other module may hash def bodies.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/**
 * Extract the verbatim body text for a symbol definition.
 * @param source    Full source text
 * @param startLine 1-based inclusive start
 * @param endLine   1-based inclusive end
 */
export function bodySlice(source: string, startLine: number, endLine: number): string {
    const lines = source.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * SHA-1 fingerprint of a body slice. Used for change detection and dedup.
 */
export function bodyHash(slice: string): string {
    return createHash('sha1').update(slice).digest('hex');
}
```

---

### `core/tree-sitter/structure.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/tree-sitter/structure.ts`

```typescript
// ---------------------------------------------------------------------------
// tree-sitter/structure.ts — Per-symbol structural shape extraction
//
// Invariant: Operates on a pre-parsed tree node. Does NOT parse source itself.
// Consumers must pass the rootNode from a shared parse in extract.ts.
// No imports from db-adapter or symbol-index — pure AST walk.
// ---------------------------------------------------------------------------

import type { Node } from 'web-tree-sitter';
import { DEF_TYPES } from './runtime.js';

export interface SymbolStructure {
    params: string[];           // child node types inside parameters/formal_parameters
    returnKind: string | null;  // node type of return_type/type_annotation child
    parentKind: string | null;  // enclosing scope node type
    decorators: string[];       // decorator/annotation node types preceding the def
    modifiers: string[];        // sorted modifier keywords (public/private/static/async/etc.)
}

/**
 * Per-language parameter-container node-type map.
 *
 * Replaces the previous single global PARAM_CONTAINER_TYPES set with true
 * per-language tables derived from the shipped tree-sitter grammars. The
 * generic union (PARAM_CONTAINER_FALLBACK) remains as the fall-through for
 * any language not covered — it cannot be more wrong than the prior code.
 *
 * Sourced from inspection of the relevant grammar node-type catalogs:
 *   python:     `parameters` (def + lambda use the same node)
 *   typescript: `formal_parameters` + `type_parameters` for generics
 *   tsx:        same as typescript
 *   javascript: `formal_parameters`
 *   rust:       `parameters` (fn) + `type_parameters` (generics) + `closure_parameters`
 *   go:         `parameter_list` + `type_parameter_list`
 *   java:       `formal_parameters` + `type_parameters` + `receiver_parameter`
 *   c_sharp:    `parameter_list` + `type_parameter_list` + `bracketed_parameter_list`
 *   c / cpp:    `parameter_list` + `template_parameter_list`
 *   kotlin:     `function_value_parameters` + `type_parameters`
 *   php:        `formal_parameters`
 *   ruby:       `method_parameters` + `block_parameters` + `lambda_parameters`
 *   swift:      `parameter_clause` + `generic_parameter_clause`
 *   bash:       (functions have no formal parameter node) — empty set; falls through cleanly
 *   lua:        `parameters`
 *   nix:        `formals` (function set patterns) + `identifier` (single-arg lambdas)
 *   scss:       `arguments`
 */
const PARAM_CONTAINER_FALLBACK: ReadonlySet<string> = new Set([
    'parameters', 'formal_parameters', 'parameter_list',
    'parameter_declaration', 'type_parameters', 'type_parameter_list',
    'template_parameter_list', 'function_value_parameters',
    'method_parameters', 'block_parameters', 'lambda_parameters',
    'closure_parameters', 'parameter_clause', 'generic_parameter_clause',
    'bracketed_parameter_list', 'receiver_parameter', 'formals', 'arguments',
]);

const PARAM_CONTAINERS_BY_LANG: Readonly<Record<string, ReadonlySet<string>>> = {
    python:     new Set(['parameters']),
    typescript: new Set(['formal_parameters', 'type_parameters']),
    tsx:        new Set(['formal_parameters', 'type_parameters']),
    javascript: new Set(['formal_parameters']),
    rust:       new Set(['parameters', 'type_parameters', 'closure_parameters']),
    go:         new Set(['parameter_list', 'type_parameter_list']),
    java:       new Set(['formal_parameters', 'type_parameters', 'receiver_parameter']),
    c_sharp:    new Set(['parameter_list', 'type_parameter_list', 'bracketed_parameter_list']),
    c:          new Set(['parameter_list']),
    cpp:        new Set(['parameter_list', 'template_parameter_list']),
    kotlin:     new Set(['function_value_parameters', 'type_parameters']),
    php:        new Set(['formal_parameters']),
    ruby:       new Set(['method_parameters', 'block_parameters', 'lambda_parameters']),
    swift:      new Set(['parameter_clause', 'generic_parameter_clause']),
    bash:       new Set<string>(),
    lua:        new Set(['parameters']),
    nix:        new Set(['formals']),
    scss:       new Set(['arguments']),
};

export function paramContainersFor(langName: string): ReadonlySet<string> {
    return PARAM_CONTAINERS_BY_LANG[langName] ?? PARAM_CONTAINER_FALLBACK;
}

/**
 * Per-language modifier-keyword overrides. The global MODIFIER_KEYWORDS set
 * stays as the default. Languages whose modifier vocabulary is materially
 * different (rust's `pub`/`unsafe`, kotlin's `open`/`suspend`/`inline`,
 * php's `final`/`readonly`, etc.) extend it. Extraction code below unions
 * the language map with the global set so we never lose a generic keyword.
 */
const MODIFIER_KEYWORDS_BY_LANG: Readonly<Record<string, ReadonlySet<string>>> = {
    rust:    new Set(['pub', 'unsafe', 'async', 'const', 'extern', 'default', 'mut']),
    kotlin:  new Set(['public', 'private', 'protected', 'internal', 'open', 'final',
                       'abstract', 'override', 'suspend', 'inline', 'noinline', 'crossinline',
                       'tailrec', 'operator', 'infix', 'external', 'lateinit', 'data',
                       'sealed', 'companion', 'enum', 'annotation']),
    php:     new Set(['public', 'private', 'protected', 'static', 'abstract', 'final', 'readonly']),
    java:    new Set(['public', 'private', 'protected', 'static', 'abstract', 'final',
                       'synchronized', 'native', 'strictfp', 'default', 'sealed', 'non-sealed']),
    c_sharp: new Set(['public', 'private', 'protected', 'internal', 'static', 'abstract',
                       'sealed', 'virtual', 'override', 'async', 'unsafe', 'extern',
                       'readonly', 'partial', 'new', 'volatile']),
    swift:   new Set(['public', 'private', 'fileprivate', 'internal', 'open',
                       'static', 'class', 'final', 'override', 'mutating', 'nonmutating',
                       'lazy', 'weak', 'unowned', 'dynamic', 'convenience', 'required',
                       'optional', 'async', 'throws', 'rethrows', 'indirect']),
};

export function modifierKeywordsFor(langName: string): ReadonlySet<string> {
    const base = MODIFIER_KEYWORDS;
    const ext = MODIFIER_KEYWORDS_BY_LANG[langName];
    if (!ext) return base;
    const union = new Set<string>(base);
    for (const m of ext) union.add(m);
    return union;
}

/** Modifier keywords extracted from preceding tokens or child nodes */
const MODIFIER_KEYWORDS: ReadonlySet<string> = new Set([
    'public', 'private', 'protected', 'static', 'async', 'abstract',
    'const', 'final', 'override', 'pub', 'export', 'default', 'readonly',
    'virtual', 'sealed', 'internal', 'extern', 'inline', 'unsafe',
]);

/**
 * Extract structural shape for a definition node at the given line range.
 * Returns null if no matching DEF_TYPES node found in the range.
 *
 * @param rootNode  Shared parsed tree root (from extract.ts)
 * @param startLine 1-based start
 * @param endLine   1-based end
 */
export function extractStructureForDef(rootNode: Node, startLine: number, endLine: number, langName: string): SymbolStructure | null {
    const startRow = startLine - 1;
    const endRow = endLine - 1;
    const paramContainers = paramContainersFor(langName);
    const modifierKeywords = modifierKeywordsFor(langName);

    // Find the definition node spanning this range
    let defNode: Node | null = null;
    function findDef(node: Node): boolean {
        if (DEF_TYPES.has(node.type) &&
            node.startPosition.row === startRow &&
            node.endPosition.row === endRow) {
            defNode = node;
            return true;
        }
        // Also match if the def node's body starts at startRow (decorated_definition case)
        if (DEF_TYPES.has(node.type) &&
            node.startPosition.row <= startRow &&
            node.endPosition.row === endRow) {
            defNode = node;
            return true;
        }
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && findDef(child)) return true;
        }
        return false;
    }
    findDef(rootNode);
    if (!defNode) return null;

    const foundNode: Node = defNode;

    // --- Params ---
    const params: string[] = [];
    function collectParams(node: Node, isRoot: boolean): boolean {
        if (!isRoot && DEF_TYPES.has(node.type)) return false;
        if (paramContainers.has(node.type)) {
            for (let i = 0; i < node.childCount; i++) {
                const c = node.child(i);
                if (!c) continue;
                if (c.type === '(' || c.type === ')' || c.type === ',') continue;
                params.push(c.type);
            }
            return true;
        }
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && collectParams(child, false)) return true;
        }
        return false;
    }
    collectParams(foundNode, true);

    // --- Return type ---
    let returnKind: string | null = null;
    for (let i = 0; i < foundNode.childCount; i++) {
        const c = foundNode.child(i);
        if (!c) continue;
        if (c.type === 'type_annotation' || c.type === 'return_type') {
            returnKind = c.type;
            break;
        }
    }

    // --- Parent kind ---
    let parentKind: string | null = null;
    let p: Node | null = foundNode.parent;
    while (p) {
        if (DEF_TYPES.has(p.type) || p.type === 'program' || p.type === 'module' || p.type === 'source_file') {
            parentKind = p.type;
            break;
        }
        p = p.parent;
    }

    // --- Decorators ---
    const decorators: string[] = [];
    if (foundNode.parent) {
        const parent = foundNode.parent;
        for (let i = 0; i < parent.childCount; i++) {
            const sibling = parent.child(i);
            if (sibling === foundNode) break;
            if (!sibling) continue;
            if (sibling.type === 'decorator' || sibling.type === 'annotation' ||
                sibling.type === 'attribute_list' || sibling.type === 'attribute') {
                decorators.push(sibling.type);
            }
        }
    }
    // Handle decorated_definition wrapper (Python)
    if (foundNode.type === 'decorated_definition') {
        for (let i = 0; i < foundNode.childCount; i++) {
            const child = foundNode.child(i);
            if (child && child.type === 'decorator') decorators.push('decorator');
        }
    }

    // --- Modifiers ---
    const modifiers: string[] = [];
    // Check immediate children and preceding siblings for modifier keywords
    for (let i = 0; i < foundNode.childCount; i++) {
        const child = foundNode.child(i);
        if (!child) continue;
        if (modifierKeywords.has(child.type)) {
            modifiers.push(child.type);
        }
        // Check text of named children that might be keywords
        if (child.type === 'modifiers' || child.type === 'modifier') {
            for (let j = 0; j < child.childCount; j++) {
                const mod = child.child(j);
                if (mod && modifierKeywords.has(mod.text)) {
                    modifiers.push(mod.text);
                }
            }
        }
    }
    // Check parent for export_statement wrapping (JS/TS)
    if (foundNode.parent?.type === 'export_statement') {
        modifiers.push('export');
    }
    modifiers.sort();

    return { params, returnKind, parentKind, decorators, modifiers };
}
```

---

### `core/tree-sitter/anchors.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/tree-sitter/anchors.ts`

```typescript
// ---------------------------------------------------------------------------
// tree-sitter/anchors.ts — In-body anchor extraction
//
// Invariant: Operates on a pre-parsed tree rootNode. Does NOT re-parse.
// The ANCHOR_RULES table covers 18 languages from the reference design.
// Unsupported languages return empty arrays (graceful no-op).
// ---------------------------------------------------------------------------

import type { Node } from 'web-tree-sitter';

export interface AnchorEntry {
    line: number;         // 0-based (matches StructureBlock convention)
    endLine: number;      // 0-based
    kind: string;
    priority: number;
}

interface AnchorRule {
    kind: string;
    priority: number;
}

const ANCHOR_RULES: Readonly<Record<string, Record<string, AnchorRule>>> = {
    javascript: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        for_in_statement: { kind: 'loop', priority: 250 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
        call_expression: { kind: 'call', priority: 140 },
    },
    typescript: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        for_in_statement: { kind: 'loop', priority: 250 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
        call_expression: { kind: 'call', priority: 140 },
    },
    tsx: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        for_in_statement: { kind: 'loop', priority: 250 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
        call_expression: { kind: 'call', priority: 140 },
    },
    python: {
        return_statement: { kind: 'return', priority: 400 },
        raise_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        elif_clause: { kind: 'if', priority: 310 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        try_statement: { kind: 'try', priority: 280 },
        except_clause: { kind: 'catch', priority: 270 },
        with_statement: { kind: 'with', priority: 220 },
        await: { kind: 'await', priority: 180 },
        call: { kind: 'call', priority: 140 },
    },
    go: {
        return_statement: { kind: 'return', priority: 400 },
        if_statement: { kind: 'if', priority: 320 },
        for_statement: { kind: 'loop', priority: 260 },
        select_statement: { kind: 'switch', priority: 300 },
        go_statement: { kind: 'call', priority: 200 },
        defer_statement: { kind: 'defer', priority: 220 },
    },
    rust: {
        return_expression: { kind: 'return', priority: 400 },
        if_expression: { kind: 'if', priority: 320 },
        match_expression: { kind: 'switch', priority: 300 },
        loop_expression: { kind: 'loop', priority: 260 },
        for_expression: { kind: 'loop', priority: 260 },
        while_expression: { kind: 'loop', priority: 250 },
        macro_invocation: { kind: 'call', priority: 140 },
    },
    java: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_expression: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        enhanced_for_statement: { kind: 'loop', priority: 255 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        method_invocation: { kind: 'call', priority: 140 },
    },
    c: {
        return_statement: { kind: 'return', priority: 400 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
    },
    cpp: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
    },
    c_sharp: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        foreach_statement: { kind: 'loop', priority: 255 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
    },
    kotlin: {
        return_expression: { kind: 'return', priority: 400 },
        throw_expression: { kind: 'throw', priority: 380 },
        if_expression: { kind: 'if', priority: 320 },
        when_expression: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        do_while_statement: { kind: 'loop', priority: 240 },
        try_expression: { kind: 'try', priority: 280 },
    },
    php: {
        return_statement: { kind: 'return', priority: 400 },
        throw_expression: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        foreach_statement: { kind: 'loop', priority: 255 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
    },
    ruby: {
        return: { kind: 'return', priority: 400 },
        raise: { kind: 'throw', priority: 380 },
        if: { kind: 'if', priority: 320 },
        unless: { kind: 'if', priority: 310 },
        for: { kind: 'loop', priority: 260 },
        while: { kind: 'loop', priority: 250 },
        until: { kind: 'loop', priority: 240 },
        begin: { kind: 'try', priority: 280 },
        rescue: { kind: 'catch', priority: 270 },
    },
    swift: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        guard_statement: { kind: 'if', priority: 315 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_in_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        repeat_while_statement: { kind: 'loop', priority: 240 },
        do_statement: { kind: 'try', priority: 280 },
    },
    bash: {
        if_statement: { kind: 'if', priority: 320 },
        case_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        pipeline: { kind: 'call', priority: 140 },
    },
    lua: {
        return_statement: { kind: 'return', priority: 400 },
        if_statement: { kind: 'if', priority: 320 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        repeat_statement: { kind: 'loop', priority: 240 },
        function_call: { kind: 'call', priority: 140 },
    },
    nix: {
        if_expression: { kind: 'if', priority: 320 },
        assert_expression: { kind: 'if', priority: 315 },
        with_expression: { kind: 'with', priority: 220 },
        let_expression: { kind: 'call', priority: 160 },
    },
    scss: {
        if_statement: { kind: 'if', priority: 320 },
        each_statement: { kind: 'loop', priority: 260 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
    },
};

/**
 * Extract anchors for a single definition body.
 * Walk the node subtree; for each child whose type matches an ANCHOR_RULES entry,
 * emit an AnchorEntry. Skip nested defs (don't report anchors inside inner functions).
 *
 * @param defNode   The AST node spanning the definition
 * @param langName  Language name for rule lookup
 * @param defStartRow 0-based start row of the def (used to skip the def signature line itself)
 */
export function extractAnchorsForDef(defNode: Node, langName: string, defStartRow: number): AnchorEntry[] {
    const rules = ANCHOR_RULES[langName];
    if (!rules) return [];

    const anchors: AnchorEntry[] = [];
    const DEF_NODE_TYPES = new Set([
        'function_declaration', 'function_definition', 'method_definition',
        'function_item', 'class_declaration', 'class_definition',
        'arrow_function', 'function_expression',
    ]);

    function walk(node: Node, depth: number): void {
        // Don't descend into nested definitions
        if (depth > 0 && DEF_NODE_TYPES.has(node.type)) return;

        const rule = rules[node.type];
        if (rule && node.startPosition.row > defStartRow) {
            anchors.push({
                line: node.startPosition.row,
                endLine: node.endPosition.row,
                kind: rule.kind,
                priority: rule.priority,
            });
        }

        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) walk(child, depth + 1);
        }
    }

    walk(defNode, 0);
    return anchors;
}
```

---

### `core/tree-sitter/imports.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/tree-sitter/imports.ts`

```typescript
// ---------------------------------------------------------------------------
// tree-sitter/imports.ts — File-level import edge extraction
//
// Invariant: Post-processes getSymbols output. Does NOT re-parse.
// Extracts import edges grouped by line (one row per import statement).
// ---------------------------------------------------------------------------

import type { SymbolInfo } from './symbols.js';

export interface ImportEdge {
    module: string;
    importedNames: string[];  // empty = wildcard/side-effect import
    line: number;
}

/**
 * Extract file-level import edges from already-computed symbols.
 * Groups refs with type 'import' or 'module' by source line.
 */
export function extractImportsFromSymbols(symbols: SymbolInfo[]): ImportEdge[] {
    const moduleRefs = symbols.filter(s =>
        s.kind === 'ref' && (s.type === 'module' || s.type === 'import')
    );

    if (moduleRefs.length === 0) return [];

    // Group by line — refs on the same line belong to the same import statement
    const byLine = new Map<number, SymbolInfo[]>();
    for (const ref of moduleRefs) {
        if (!byLine.has(ref.line)) byLine.set(ref.line, []);
        byLine.get(ref.line)!.push(ref);
    }

    const imports: ImportEdge[] = [];
    for (const [line, refs] of byLine) {
        const moduleRef = refs.find(r => r.type === 'module');
        const importRefs = refs.filter(r => r.type === 'import');
        imports.push({
            module: moduleRef?.name ?? importRefs[0]?.name ?? '',
            importedNames: importRefs.map(r => r.name),
            line,
        });
    }

    return imports;
}
```

---

### `core/tree-sitter/injections.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/tree-sitter/injections.ts`

```typescript
// ---------------------------------------------------------------------------
// tree-sitter/injections.ts — Embedded-language injection span extraction
//
// Invariant: Runs injections.scm for languages that ship one. Returns empty
// array (not null) if the language has no injections.scm. Operates on a
// pre-parsed tree rootNode from extract.ts.
// ---------------------------------------------------------------------------

import type { Node } from 'web-tree-sitter';
import { getCompiledModularQuery } from './runtime.js';

export interface InjectionSpan {
    hostLang: string;
    injectedLang: string;
    startLine: number;    // 1-based
    endLine: number;      // 1-based
    startByte: number;
    endByte: number;
}

/**
 * Run injections.scm for a language and extract embedded-language spans.
 * Returns [] if no injections.scm exists (graceful no-op).
 *
 * Captures consumed:
 *   @injection.content  — the node containing injected text
 *   @injection.language — node whose text IS the language name (markdown fenced blocks)
 *   #set! injection.language "..." — predicate setting the language statically
 *
 * @param rootNode Pre-parsed tree root
 * @param langName Host language name
 */
export async function extractInjections(rootNode: Node, langName: string): Promise<InjectionSpan[]> {
    const query = await getCompiledModularQuery(langName, 'injections.scm');
    if (!query) return [];

    const matches = query.matches(rootNode);
    const spans: InjectionSpan[] = [];

    for (const match of matches) {
        let contentNode: Node | null = null;
        let injectedLang: string | null = null;

        for (const cap of match.captures) {
            if (cap.name === 'injection.content') {
                contentNode = cap.node;
            }
            if (cap.name === 'injection.language') {
                injectedLang = cap.node.text.trim();
            }
        }

        // Resolve `#set! injection.language "..."` predicates.
        //
        // web-tree-sitter 0.26 exposes set! properties in TWO places (verified
        // against node_modules/web-tree-sitter/web-tree-sitter.d.ts:828–845, 904–905):
        //
        //   (a) Match-level:   QueryMatch.setProperties
        //                      — used when the predicate references a capture and
        //                        therefore evaluates per match.
        //   (b) Pattern-level: Query.setProperties[patternIndex]
        //                      — used when `#set!` is a constant on the pattern,
        //                        which is how nearly every injections.scm writes
        //                        `(#set! injection.language "sql")`.
        //
        // We check (a) first, then fall back to (b). Both fields are well-typed.
        if (!injectedLang) {
            const matchProps = (match as { setProperties?: Record<string, string | null> }).setProperties;
            if (matchProps && typeof matchProps['injection.language'] === 'string') {
                injectedLang = matchProps['injection.language'] as string;
            }
        }
        if (!injectedLang) {
            const patternIdx = (match as { patternIndex?: number }).patternIndex;
            const queryProps = (query as unknown as { setProperties?: Array<Record<string, string | null> | undefined> }).setProperties;
            if (typeof patternIdx === 'number' && queryProps && queryProps[patternIdx]) {
                const v = queryProps[patternIdx]!['injection.language'];
                if (typeof v === 'string') injectedLang = v;
            }
        }

        if (contentNode && injectedLang) {
            spans.push({
                hostLang: langName,
                injectedLang,
                startLine: contentNode.startPosition.row + 1,
                endLine: contentNode.endPosition.row + 1,
                startByte: contentNode.startIndex,
                endByte: contentNode.endIndex,
            });
        }
    }

    return spans;
}
```

---

### `core/tree-sitter/locals.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/tree-sitter/locals.ts`

```typescript
// ---------------------------------------------------------------------------
// tree-sitter/locals.ts — Per-scope parameter and local variable extraction
//
// Invariant: Runs locals.scm on a pre-parsed tree. Does NOT re-parse.
// Returns null if no locals.scm exists for the language.
// ---------------------------------------------------------------------------

import type { Node } from 'web-tree-sitter';
import { getCompiledModularQuery } from './runtime.js';

export interface LocalSymbol {
    name: string;
    line: number;    // 1-based
    column: number;
}

export interface LocalScope {
    scopeKind: string;       // node type of the @scope capture
    startLine: number;       // 1-based
    endLine: number;         // 1-based
    parameters: LocalSymbol[];
    locals: LocalSymbol[];
}

/**
 * Run locals.scm and extract per-scope parameters and local definitions.
 * Returns null if no locals.scm exists for this language.
 */
export async function extractLocals(rootNode: Node, langName: string): Promise<LocalScope[] | null> {
    const query = await getCompiledModularQuery(langName, 'locals.scm');
    if (!query) return null;

    const matches = query.matches(rootNode);

    // Collect scopes, parameters, and definitions
    const scopes: Array<{ node: Node; kind: string }> = [];
    const params: Array<{ node: Node }> = [];
    const defs: Array<{ node: Node }> = [];

    for (const match of matches) {
        for (const cap of match.captures) {
            if (cap.name === 'scope') {
                scopes.push({ node: cap.node, kind: cap.node.type });
            } else if (cap.name === 'local.parameter') {
                params.push({ node: cap.node });
            } else if (cap.name === 'local.definition') {
                defs.push({ node: cap.node });
            }
        }
    }

    if (scopes.length === 0) return [];

    // Build LocalScope results by assigning params/defs to their containing scope
    const result: LocalScope[] = [];
    for (const scope of scopes) {
        const sNode = scope.node;
        const scopeStartRow = sNode.startPosition.row;
        const scopeEndRow = sNode.endPosition.row;

        const scopeParams: LocalSymbol[] = [];
        for (const p of params) {
            const row = p.node.startPosition.row;
            if (row >= scopeStartRow && row <= scopeEndRow) {
                // Check that this param is directly in THIS scope (not a nested one)
                let directChild = true;
                for (const innerScope of scopes) {
                    if (innerScope === scope) continue;
                    const iStart = innerScope.node.startPosition.row;
                    const iEnd = innerScope.node.endPosition.row;
                    if (row >= iStart && row <= iEnd &&
                        iStart > scopeStartRow && iEnd < scopeEndRow) {
                        directChild = false;
                        break;
                    }
                }
                if (directChild) {
                    scopeParams.push({
                        name: p.node.text,
                        line: row + 1,
                        column: p.node.startPosition.column,
                    });
                }
            }
        }

        const scopeDefs: LocalSymbol[] = [];
        for (const d of defs) {
            const row = d.node.startPosition.row;
            if (row >= scopeStartRow && row <= scopeEndRow) {
                let directChild = true;
                for (const innerScope of scopes) {
                    if (innerScope === scope) continue;
                    const iStart = innerScope.node.startPosition.row;
                    const iEnd = innerScope.node.endPosition.row;
                    if (row >= iStart && row <= iEnd &&
                        iStart > scopeStartRow && iEnd < scopeEndRow) {
                        directChild = false;
                        break;
                    }
                }
                if (directChild) {
                    scopeDefs.push({
                        name: d.node.text,
                        line: row + 1,
                        column: d.node.startPosition.column,
                    });
                }
            }
        }

        result.push({
            scopeKind: scope.kind,
            startLine: scopeStartRow + 1,
            endLine: scopeEndRow + 1,
            parameters: scopeParams,
            locals: scopeDefs,
        });
    }

    return result;
}
```

---

### `core/indexing/types.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/indexing/types.ts`

```typescript
// ---------------------------------------------------------------------------
// indexing/types.ts — Shared shapes between extract.ts and persist.ts
//
// Invariant: No runtime imports. Pure type definitions.
// Single source of truth for the shape crossing the extractor→persister boundary.
// ---------------------------------------------------------------------------

export interface SymbolRow {
    name: string;
    kind: 'def' | 'ref';
    type: string;
    captureTag: string;         // full 'definition.function' etc.
    line: number;               // 1-based
    endLine: number;            // 1-based
    column: number;
    bodyHash: string | null;    // sha1 for defs only
    parentSymbolKey: string | null;  // transient FK: `${name}:${line}:${col}`
    visibility: string | null;  // 'public'|'private'|'protected'|'package'|null
}

export interface StructureRow {
    parentSymbolKey: string;    // FK to a SymbolRow
    params: string[];
    returnKind: string | null;
    decorators: string[];
    modifiers: string[];
    parentKind: string | null;
}

export interface AnchorRow {
    parentSymbolKey: string;
    kind: string;
    line: number;               // 0-based (StructureBlock convention)
    priority: number;
    text: string;               // first ~80 chars of the anchor line
}

export interface ImportRow {
    module: string;
    importedNames: string[];
    line: number;
}

export interface InjectionRow {
    hostLang: string;
    injectedLang: string;
    startLine: number;
    endLine: number;
    startByte: number;
    endByte: number;
}

export interface LocalScopeRow {
    parentSymbolKey: string | null;
    scopeKind: string;
    startLine: number;
    endLine: number;
    parameters: { name: string; line: number; column: number }[];
    locals: { name: string; line: number; column: number }[];
}

export interface RawEdgeRow {
    containerDefKey: string;
    referencedName: string;
}

export interface ParsedFileRecord {
    relPath: string;
    hash: string;
    lang: string;
    symbols: SymbolRow[];
    structures: StructureRow[];
    anchors: AnchorRow[];
    imports: ImportRow[];
    injections: InjectionRow[];
    locals: LocalScopeRow[];
    edges: RawEdgeRow[];
}
```

---

### `core/indexing/extract.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/indexing/extract.ts`

```typescript
// ---------------------------------------------------------------------------
// indexing/extract.ts — Single-parse orchestrator for one file
//
// Invariant: Parses source ONCE. Shares the tree rootNode with all extractors.
// Returns a ParsedFileRecord with no DB awareness. Pure data extraction.
// ---------------------------------------------------------------------------

import { Parser } from 'web-tree-sitter';
import { loadLanguage, getCompiledQuery } from '../tree-sitter/runtime.js';
import { extractStructureForDef } from '../tree-sitter/structure.js';
import { extractAnchorsForDef } from '../tree-sitter/anchors.js';
import { extractImportsFromSymbols } from '../tree-sitter/imports.js';
import { extractInjections } from '../tree-sitter/injections.js';
import { extractLocals } from '../tree-sitter/locals.js';
import { bodySlice, bodyHash } from '../tree-sitter/body.js';
import { parseCaptureTag } from '../tree-sitter/capture-tags.js';
import type { SymbolInfo } from '../tree-sitter/symbols.js';
import type { ParsedFileRecord, SymbolRow, StructureRow, AnchorRow, RawEdgeRow, LocalScopeRow } from './types.js';

export async function extractParsedFile(
    source: string, langName: string, relPath: string, hash: string
): Promise<ParsedFileRecord | null> {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const query = await getCompiledQuery(langName);
    if (!query) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) { parser.delete(); return null; }

    try {
        const rootNode = tree.rootNode;

        // --- Step 1: Run tags query to get symbols (same logic as symbols.ts) ---
        const matches = query.matches(rootNode);
        const rawSymbols: SymbolInfo[] = [];
        const seen = new Set<string>();
        for (const match of matches) {
            let nameCapture: any = null;
            let bodyCapture: any = null;
            for (const cap of match.captures) {
                if (cap.name.startsWith('name.')) nameCapture = cap;
                else if (cap.name.startsWith('definition.') || cap.name.startsWith('reference.')) bodyCapture = cap;
            }
            if (!nameCapture) continue;
            const tag = nameCapture.name;
            let kind: string, type: string;
            if (tag.startsWith('name.definition.')) { kind = 'def'; type = tag.slice(16); }
            else if (tag.startsWith('name.reference.')) { kind = 'ref'; type = tag.slice(15); }
            else continue;
            const name = nameCapture.node.text;
            const line = nameCapture.node.startPosition.row + 1;
            const column = nameCapture.node.startPosition.column;
            const endLine = bodyCapture ? bodyCapture.node.endPosition.row + 1 : nameCapture.node.endPosition.row + 1;
            const key = `${name}:${kind}:${line}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rawSymbols.push({ name, kind, type, line, endLine, column });
        }
        rawSymbols.sort((a, b) => a.line - b.line);

        const defs = rawSymbols.filter(s => s.kind === 'def');

        // --- Step 2: Build SymbolRows with containment + body hash ---
        const symbols: SymbolRow[] = [];
        for (const s of rawSymbols) {
            let bHash: string | null = null;
            let parentKey: string | null = null;
            let visibility: string | null = null;

            if (s.kind === 'def') {
                const slice = bodySlice(source, s.line, s.endLine);
                bHash = bodyHash(slice);
                // Parent containment: smallest enclosing def
                let bestParent: SymbolInfo | null = null;
                let bestSpan = Infinity;
                for (const d of defs) {
                    if (d === s) continue;
                    if (d.line <= s.line && d.endLine >= s.endLine) {
                        const span = d.endLine - d.line;
                        if (span < bestSpan) { bestSpan = span; bestParent = d; }
                    }
                }
                if (bestParent) parentKey = `${bestParent.name}:${bestParent.line}:${bestParent.column}`;
            }

            const captureTag = s.kind === 'def' ? `definition.${s.type}` : `reference.${s.type}`;
            symbols.push({ name: s.name, kind: s.kind as 'def' | 'ref', type: s.type, captureTag, line: s.line, endLine: s.endLine, column: s.column, bodyHash: bHash, parentSymbolKey: parentKey, visibility });
        }

        // --- Step 3: Structure extraction (shares rootNode) ---
        const structures: StructureRow[] = [];
        for (const s of defs) {
            const struct = extractStructureForDef(rootNode, s.line, s.endLine, langName);
            if (struct) {
                const key = `${s.name}:${s.line}:${s.column}`;
                structures.push({ parentSymbolKey: key, params: struct.params, returnKind: struct.returnKind, decorators: struct.decorators, modifiers: struct.modifiers, parentKind: struct.parentKind });
                // Derive visibility
                const sym = symbols.find(sym => sym.line === s.line && sym.column === s.column && sym.kind === 'def');
                if (sym) {
                    if (struct.modifiers.includes('export') || struct.modifiers.includes('public') || struct.modifiers.includes('pub')) sym.visibility = 'public';
                    else if (struct.modifiers.includes('private')) sym.visibility = 'private';
                    else if (struct.modifiers.includes('protected')) sym.visibility = 'protected';
                }
            }
        }

        // --- Step 4: Anchor extraction (shares rootNode, uses DEF_TYPES to find def nodes) ---
        const anchors: AnchorRow[] = [];
        const lines = source.split('\n');
        for (const s of defs) {
            const startRow = s.line - 1;
            const endRow = s.endLine - 1;
            // Find the AST node for this def
            let defNode: any = null;
            function findDefNode(node: any): boolean {
                if (node.startPosition.row === startRow && node.endPosition.row === endRow) { defNode = node; return true; }
                if (node.startPosition.row <= startRow && node.endPosition.row >= endRow) {
                    for (let i = 0; i < node.childCount; i++) {
                        const child = node.child(i);
                        if (child && findDefNode(child)) return true;
                    }
                }
                return false;
            }
            findDefNode(rootNode);
            if (defNode) {
                const defAnchors = extractAnchorsForDef(defNode, langName, startRow);
                const key = `${s.name}:${s.line}:${s.column}`;
                for (const a of defAnchors) {
                    anchors.push({ parentSymbolKey: key, kind: a.kind, line: a.line, priority: a.priority, text: (lines[a.line] ?? '').slice(0, 80) });
                }
            }
        }

        // --- Step 5: Imports (post-processes symbols, no re-parse) ---
        const imports = extractImportsFromSymbols(rawSymbols);

        // --- Step 6: Injections (shares rootNode) ---
        const injections = await extractInjections(rootNode, langName);
        const injectionRows = injections.map(inj => ({
            hostLang: inj.hostLang, injectedLang: inj.injectedLang,
            startLine: inj.startLine, endLine: inj.endLine,
            startByte: inj.startByte, endByte: inj.endByte,
        }));

        // --- Step 7: Locals (shares rootNode) ---
        const localScopes = await extractLocals(rootNode, langName);
        const locals: LocalScopeRow[] = (localScopes ?? []).map(scope => {
            let parentKey: string | null = null;
            for (const d of defs) {
                if (d.line <= scope.startLine && d.endLine >= scope.endLine) {
                    parentKey = `${d.name}:${d.line}:${d.column}`;
                    break;
                }
            }
            return { parentSymbolKey: parentKey, scopeKind: scope.scopeKind, startLine: scope.startLine, endLine: scope.endLine, parameters: scope.parameters, locals: scope.locals };
        });

        // --- Step 8: Edges (innermost-def containment) ---
        const defEntries = symbols.filter(s => s.kind === 'def');
        const edges: RawEdgeRow[] = [];
        for (const ref of symbols.filter(s => s.kind === 'ref')) {
            let bestDef: SymbolRow | null = null;
            let bestSpan = Infinity;
            for (const def of defEntries) {
                if (ref.line >= def.line && ref.line <= def.endLine) {
                    const span = def.endLine - def.line;
                    if (span < bestSpan) { bestSpan = span; bestDef = def; }
                }
            }
            if (bestDef) edges.push({ containerDefKey: `${bestDef.name}:${bestDef.line}:${bestDef.column}`, referencedName: ref.name });
        }

        return { relPath, hash, lang: langName, symbols, structures, anchors, imports, injections: injectionRows, locals, edges };
    } finally {
        tree.delete();
        parser.delete();
    }
}
```

---

### `core/indexing/persist.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/indexing/persist.ts`

```typescript
// ---------------------------------------------------------------------------
// indexing/persist.ts — Writes ParsedFileRecord in one transaction
//
// Invariant: Every DB write goes through a named db-adapter function.
// Single transaction per file. FK cascades handle child table cleanup.
// ---------------------------------------------------------------------------

import type { DbConnection } from '../db-adapter.js';
import {
    runTransaction, upsertFile, deleteSymbolsByFile,
    insertSymbol, insertEdge,
    insertSymbolStructure, insertAnchor,
    insertImport, insertLocalScope, insertInjection,
    updateSymbolExtras,
} from '../db-adapter.js';
import type { ParsedFileRecord } from './types.js';

export function persistParsedFile(conn: DbConnection, record: ParsedFileRecord): void {
    runTransaction(conn, () => {
        // 1. Clear old data (FK cascades clean child tables)
        deleteSymbolsByFile(conn, record.relPath);
        // 2. Upsert file
        upsertFile(conn, record.relPath, record.hash, Date.now());
        // 3. Insert symbols, build key→id map
        const keyToId = new Map<string, number>();
        for (const sym of record.symbols) {
            const rowId = insertSymbol(conn, {
                name: sym.name, kind: sym.kind, type: sym.type,
                filePath: record.relPath, line: sym.line, endLine: sym.endLine, column: sym.column,
            });
            const key = `${sym.name}:${sym.line}:${sym.column}`;
            keyToId.set(key, rowId);
            if (sym.bodyHash || sym.captureTag || sym.parentSymbolKey || sym.visibility) {
                const parentId = sym.parentSymbolKey ? (keyToId.get(sym.parentSymbolKey) ?? null) : null;
                updateSymbolExtras(conn, rowId, { captureTag: sym.captureTag, bodyHash: sym.bodyHash, parentSymbolId: parentId, visibility: sym.visibility });
            }
        }
        // 4. Edges
        for (const edge of record.edges) {
            const containerId = keyToId.get(edge.containerDefKey);
            if (containerId !== undefined) insertEdge(conn, containerId, edge.referencedName);
        }
        // 5. Structures
        for (const struct of record.structures) {
            const symbolId = keyToId.get(struct.parentSymbolKey);
            if (symbolId === undefined) continue;
            insertSymbolStructure(conn, { symbolId, paramsJson: JSON.stringify(struct.params), returnText: struct.returnKind, decoratorsJson: JSON.stringify(struct.decorators), modifiersJson: JSON.stringify(struct.modifiers), genericsText: null, parentKind: struct.parentKind, parentName: null });
        }
        // 6. Anchors
        for (const anchor of record.anchors) {
            const symbolId = keyToId.get(anchor.parentSymbolKey);
            if (symbolId === undefined) continue;
            insertAnchor(conn, { symbolId, kind: anchor.kind, line: anchor.line, text: anchor.text });
        }
        // 7. Imports
        for (const imp of record.imports) {
            insertImport(conn, { filePath: record.relPath, module: imp.module, importedNamesJson: JSON.stringify(imp.importedNames), line: imp.line });
        }
        // 8. Injections
        for (const inj of record.injections) {
            insertInjection(conn, { filePath: record.relPath, hostLang: inj.hostLang, injectedLang: inj.injectedLang, startLine: inj.startLine, endLine: inj.endLine, startByte: inj.startByte, endByte: inj.endByte });
        }
        // 9. Local scopes
        for (const local of record.locals) {
            const symbolId = local.parentSymbolKey ? (keyToId.get(local.parentSymbolKey) ?? null) : null;
            insertLocalScope(conn, { symbolId, scopeKind: local.scopeKind, startLine: local.startLine, endLine: local.endLine, parametersJson: JSON.stringify(local.parameters), localsJson: JSON.stringify(local.locals) });
        }
    });
}
```

---

### `core/indexing/resolve.ts` — NEW

**Full path:** `packages/zenith-mcp/src/core/indexing/resolve.ts`

```typescript
// ---------------------------------------------------------------------------
// indexing/resolve.ts — Cross-file edge resolution
//
// Algorithm: For each unresolved edge (callee_symbol_id IS NULL), query all
// def symbols with matching name. If exactly one exists → link. If ambiguous → skip.
//
// Concurrency: ON DELETE SET NULL on edges.callee_symbol_id means if callee
// file is re-indexed, stale resolutions auto-null. Next indexDirectory run heals.
//
// Trigger: Called once per indexDirectory batch, after all files persisted.
// NOT called by single-file indexFile (too expensive for interactive edits).
// ---------------------------------------------------------------------------

import type { DbConnection } from '../db-adapter.js';
import { runTransaction, getUnresolvedEdges, findSymbolByNameUnique, findSymbolParent, updateEdgeCalleeSymbol } from '../db-adapter.js';

export function resolveEdgeTargets(conn: DbConnection, filePath: string): void {
    const unresolved = getUnresolvedEdges(conn, filePath);
    if (unresolved.length === 0) return;

    // Group by name to avoid repeated queries
    const byName = new Map<string, number[]>();
    for (const edge of unresolved) {
        if (!byName.has(edge.referenced_name)) byName.set(edge.referenced_name, []);
        byName.get(edge.referenced_name)!.push(edge.id);
    }

    runTransaction(conn, () => {
        for (const [name, edgeIds] of byName) {
            // STRICT unambiguous resolution. We only link an edge when the resolution
            // is provably unique. Anything else stays null and is healed on the next
            // sweep (callee files re-indexing nulls stale rows via ON DELETE SET NULL).
            //
            // 1. Full-name unique def? → link.
            const target = findSymbolByNameUnique(conn, name, 'def');
            if (target) {
                for (const edgeId of edgeIds) updateEdgeCalleeSymbol(conn, edgeId, target.id);
                continue;
            }
            // 2. Dot-qualified "Foo.bar" fallback. Strict policy:
            //    a) short name ("bar") MUST resolve to exactly one def globally, AND
            //    b) that def's parent (by parent_symbol_id) MUST exist and its name
            //       MUST equal the qualifier ("Foo").
            //    If either condition fails, the column stays null. We do not pick the
            //    short name on its own — the qualifier exists precisely because the
            //    short name is ambiguous in scope.
            const dotIdx = name.lastIndexOf('.');
            if (dotIdx <= 0) continue;
            const qualifier = name.slice(0, dotIdx);
            const shortName = name.slice(dotIdx + 1);
            const shortTarget = findSymbolByNameUnique(conn, shortName, 'def');
            if (!shortTarget) continue;
            const parent = findSymbolParent(conn, shortTarget.id);
            if (!parent || parent.name !== qualifier) continue;
            for (const edgeId of edgeIds) updateEdgeCalleeSymbol(conn, edgeId, shortTarget.id);
        }
    });
}
```

---

### `core/db-adapter.ts` — EXPANSION

#### Schema Version Migration Ladder

Appended at the END of `initSymbolSchema`, after the existing `try/catch ALTER` blocks (line 177):

```typescript
// --- Schema version + migration ladder ---
db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
const currentVersion = versionRow?.version ?? 0;

if (currentVersion < 1) {
    // v0 → v1: extended symbol columns + new child tables
    const columnMigrations = [
        'ALTER TABLE symbols ADD COLUMN capture_tag TEXT',
        'ALTER TABLE symbols ADD COLUMN body_hash TEXT',
        'ALTER TABLE symbols ADD COLUMN parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE',
        'ALTER TABLE symbols ADD COLUMN visibility TEXT',
        'ALTER TABLE edges ADD COLUMN callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL',
    ];
    for (const sql of columnMigrations) {
        try { db.exec(sql); } catch (e: any) {
            const msg = e?.message || '';
            if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
        }
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS symbol_structures (
            symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
            params_json TEXT, return_text TEXT, decorators_json TEXT,
            modifiers_json TEXT, generics_text TEXT, parent_kind TEXT, parent_name TEXT
        );
        CREATE TABLE IF NOT EXISTS anchors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
            kind TEXT, line INTEGER, text TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_anchors_symbol ON anchors(symbol_id);
        CREATE TABLE IF NOT EXISTS imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
            module TEXT, imported_names_json TEXT, line INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);
        CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module);
        CREATE TABLE IF NOT EXISTS local_scopes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
            scope_kind TEXT, start_line INTEGER, end_line INTEGER,
            parameters_json TEXT, locals_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_local_scopes_symbol ON local_scopes(symbol_id);
        CREATE TABLE IF NOT EXISTS injections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
            host_lang TEXT, injected_lang TEXT,
            start_line INTEGER, end_line INTEGER, start_byte INTEGER, end_byte INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_injections_file ON injections(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_symbol_id);
        -- v3 remediation: project_roots is also a v1 addition (project-DB registry,
        -- not the dormant initGlobalSchema variant). Idempotent CREATE; safe if a
        -- prior partial run already added it.
        CREATE TABLE IF NOT EXISTS project_roots (
            root_path TEXT PRIMARY KEY,
            name TEXT,
            created_at INTEGER
        );
    `);
    if (!versionRow) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
    else db.prepare('UPDATE schema_version SET version = ?').run(1);
}
```

**Additive only. No rollback DDL.** Old code ignores new nullable columns. If downgrade needed, user deletes `.mcp/symbols.db` (it regenerates on next open).

**Interaction with existing try/catch migrations (lines 142–176):** Those remain as-is. They are the pre-v1 bootstrap path that adds `line`/`text_hash`/`idx_versions_dedup` to the `versions` table. The schema_version ladder starts at v0→v1 for the NEW tables/columns. The existing ALTER try/catch blocks execute unconditionally on every `initSymbolSchema` call, which is safe since they tolerate "already exists."

#### New Adapter Functions

```typescript
// --- Symbol extended columns ---

export function updateSymbolExtras(
    conn: DbConnection, symbolId: number,
    extras: { captureTag?: string | null; bodyHash?: string | null; parentSymbolId?: number | null; visibility?: string | null }
): void {
    prepareOrCache(conn,
        'UPDATE symbols SET capture_tag = ?, body_hash = ?, parent_symbol_id = ?, visibility = ? WHERE id = ?'
    ).run(extras.captureTag ?? null, extras.bodyHash ?? null, extras.parentSymbolId ?? null, extras.visibility ?? null, symbolId);
}

// --- Symbol Structures ---

export function insertSymbolStructure(
    conn: DbConnection,
    row: { symbolId: number; paramsJson: string; returnText: string | null; decoratorsJson: string; modifiersJson: string; genericsText: string | null; parentKind: string | null; parentName: string | null }
): void {
    prepareOrCache(conn,
        'INSERT OR REPLACE INTO symbol_structures (symbol_id, params_json, return_text, decorators_json, modifiers_json, generics_text, parent_kind, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.symbolId, row.paramsJson, row.returnText, row.decoratorsJson, row.modifiersJson, row.genericsText, row.parentKind, row.parentName);
}

export interface SymbolStructureRow {
    symbol_id: number;
    params: string[];
    returnText: string | null;
    decorators: string[];
    modifiers: string[];
    genericsText: string | null;
    parentKind: string | null;
    parentName: string | null;
}

export function getSymbolStructure(conn: DbConnection, symbolId: number): SymbolStructureRow | null {
    const row = prepareOrCache(conn, 'SELECT * FROM symbol_structures WHERE symbol_id = ?').get(symbolId) as any | undefined;
    if (!row) return null;
    return { symbol_id: row.symbol_id, params: JSON.parse(row.params_json || '[]'), returnText: row.return_text, decorators: JSON.parse(row.decorators_json || '[]'), modifiers: JSON.parse(row.modifiers_json || '[]'), genericsText: row.generics_text, parentKind: row.parent_kind, parentName: row.parent_name };
}

export function findSymbolStructuresByName(conn: DbConnection, name: string, kind?: string): Array<SymbolStructureRow & { file_path: string; line: number; end_line: number }> {
    let sql = `SELECT ss.*, s.file_path, s.line, s.end_line FROM symbol_structures ss JOIN symbols s ON s.id = ss.symbol_id WHERE s.name = ? AND s.kind = 'def'`;
    const params: any[] = [name];
    if (kind) { sql += ' AND s.type = ?'; params.push(kind); }
    // NOTE (v3 remediation): use prepareOrCache for uniformity with every other
    // adapter function in this file. Dynamic SQL is still cached — the cache key is
    // the final SQL string, so the 1-param and 2-param shapes get distinct slots.
    const rows = prepareOrCache(conn, sql).all(...params) as any[];
    return rows.map(row => ({ symbol_id: row.symbol_id, params: JSON.parse(row.params_json || '[]'), returnText: row.return_text, decorators: JSON.parse(row.decorators_json || '[]'), modifiers: JSON.parse(row.modifiers_json || '[]'), genericsText: row.generics_text, parentKind: row.parent_kind, parentName: row.parent_name, file_path: row.file_path, line: row.line, end_line: row.end_line }));
}

// --- Anchors ---

export function insertAnchor(conn: DbConnection, row: { symbolId: number; kind: string; line: number; text: string }): void {
    prepareOrCache(conn, 'INSERT INTO anchors (symbol_id, kind, line, text) VALUES (?, ?, ?, ?)').run(row.symbolId, row.kind, row.line, row.text);
}

export function getAnchorsForFile(conn: DbConnection, filePath: string): Array<{ symbol_id: number; symbol_name: string; kind: string; line: number; text: string }> {
    return prepareOrCache(conn, `SELECT a.symbol_id, s.name AS symbol_name, a.kind, a.line, a.text FROM anchors a JOIN symbols s ON s.id = a.symbol_id WHERE s.file_path = ? ORDER BY a.line`).all(filePath) as any[];
}

// --- Imports ---

export function insertImport(conn: DbConnection, row: { filePath: string; module: string; importedNamesJson: string; line: number }): void {
    prepareOrCache(conn, 'INSERT INTO imports (file_path, module, imported_names_json, line) VALUES (?, ?, ?, ?)').run(row.filePath, row.module, row.importedNamesJson, row.line);
}

export function getImportsForFile(conn: DbConnection, filePath: string): Array<{ module: string; importedNames: string[]; line: number }> {
    const rows = prepareOrCache(conn, 'SELECT module, imported_names_json, line FROM imports WHERE file_path = ? ORDER BY line').all(filePath) as any[];
    return rows.map(r => ({ module: r.module, importedNames: JSON.parse(r.imported_names_json || '[]'), line: r.line }));
}

export function getFilesImporting(conn: DbConnection, module: string): { file_path: string }[] {
    return prepareOrCache(conn, 'SELECT DISTINCT file_path FROM imports WHERE module = ?').all(module) as { file_path: string }[];
}

// --- Injections ---

export function insertInjection(conn: DbConnection, row: { filePath: string; hostLang: string; injectedLang: string; startLine: number; endLine: number; startByte: number; endByte: number }): void {
    prepareOrCache(conn, 'INSERT INTO injections (file_path, host_lang, injected_lang, start_line, end_line, start_byte, end_byte) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.filePath, row.hostLang, row.injectedLang, row.startLine, row.endLine, row.startByte, row.endByte);
}

export function getInjectionsForFile(conn: DbConnection, filePath: string): Array<{ host_lang: string; injected_lang: string; start_line: number; end_line: number; start_byte: number; end_byte: number }> {
    return prepareOrCache(conn, 'SELECT host_lang, injected_lang, start_line, end_line, start_byte, end_byte FROM injections WHERE file_path = ?').all(filePath) as any[];
}

// --- Local Scopes ---

export function insertLocalScope(conn: DbConnection, row: { symbolId: number | null; scopeKind: string; startLine: number; endLine: number; parametersJson: string; localsJson: string }): void {
    prepareOrCache(conn, 'INSERT INTO local_scopes (symbol_id, scope_kind, start_line, end_line, parameters_json, locals_json) VALUES (?, ?, ?, ?, ?, ?)').run(row.symbolId, row.scopeKind, row.startLine, row.endLine, row.parametersJson, row.localsJson);
}

export function getLocalScopesForSymbol(conn: DbConnection, symbolId: number): Array<{ scope_kind: string; start_line: number; end_line: number; parameters: any[]; locals: any[] }> {
    const rows = prepareOrCache(conn, 'SELECT scope_kind, start_line, end_line, parameters_json, locals_json FROM local_scopes WHERE symbol_id = ?').all(symbolId) as any[];
    return rows.map(r => ({ scope_kind: r.scope_kind, start_line: r.start_line, end_line: r.end_line, parameters: JSON.parse(r.parameters_json || '[]'), locals: JSON.parse(r.locals_json || '[]') }));
}

// --- Edge Resolution ---

export function getUnresolvedEdges(conn: DbConnection, filePath: string): Array<{ id: number; referenced_name: string }> {
    return prepareOrCache(conn, `SELECT e.id, e.referenced_name FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.file_path = ? AND e.callee_symbol_id IS NULL`).all(filePath) as any[];
}

export function findSymbolByNameUnique(conn: DbConnection, name: string, kind: string): { id: number } | null {
    const rows = prepareOrCache(conn, 'SELECT id FROM symbols WHERE name = ? AND kind = ? LIMIT 2').all(name, kind) as { id: number }[];
    return rows.length === 1 ? rows[0]! : null;
}

/**
 * Look up the parent definition of a symbol via parent_symbol_id.
 * Used by resolve.ts to enforce the strict dot-qualified rule:
 *   "Foo.bar" only links if shortTarget(bar).parent.name === "Foo".
 * Returns null if the symbol has no parent or the parent row is missing.
 */
export function findSymbolParent(conn: DbConnection, symbolId: number): { id: number; name: string } | null {
    const row = prepareOrCache(conn,
        'SELECT p.id AS id, p.name AS name FROM symbols c JOIN symbols p ON p.id = c.parent_symbol_id WHERE c.id = ?'
    ).get(symbolId) as { id: number; name: string } | undefined;
    return row ?? null;
}

export function updateEdgeCalleeSymbol(conn: DbConnection, edgeId: number, calleeSymbolId: number): void {
    prepareOrCache(conn, 'UPDATE edges SET callee_symbol_id = ? WHERE id = ?').run(calleeSymbolId, edgeId);
}

// --- Aggregate facts read (for TOON integration) ---

export interface FileFacts {
    defs: Array<{ id: number; name: string; line: number; endLine: number; type: string | null; visibility: string | null }>;
    edges: Array<{ caller_name: string; callee_name: string; call_count: number }>;
    anchors: Array<{ symbol_name: string; kind: string; line: number; text: string }>;
    imports: Array<{ module: string; importedNames: string[]; line: number }>;
    injections: Array<{ injected_lang: string; start_line: number; end_line: number }>;
}

export function getFileFacts(conn: DbConnection, filePath: string): FileFacts {
    const defs = prepareOrCache(conn, `SELECT id, name, line, end_line AS endLine, type, visibility FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY line`).all(filePath) as FileFacts['defs'];
    const edges = prepareOrCache(conn, `SELECT caller.name AS caller_name, e.referenced_name AS callee_name, COUNT(e.id) AS call_count FROM edges e JOIN symbols caller ON caller.id = e.container_def_id WHERE caller.file_path = ? AND caller.kind = 'def' GROUP BY caller.name, e.referenced_name`).all(filePath) as FileFacts['edges'];
    const anchors = prepareOrCache(conn, `SELECT s.name AS symbol_name, a.kind, a.line, a.text FROM anchors a JOIN symbols s ON s.id = a.symbol_id WHERE s.file_path = ? ORDER BY a.line`).all(filePath) as FileFacts['anchors'];
    const imports = getImportsForFile(conn, filePath);
    const injections = prepareOrCache(conn, `SELECT injected_lang, start_line, end_line FROM injections WHERE file_path = ?`).all(filePath) as FileFacts['injections'];
    return { defs, edges, anchors, imports, injections };
}

// --- Schema version ---

export function getSchemaVersion(conn: DbConnection): number {
    const row = prepareOrCache(conn, 'SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    return row?.version ?? 0;
}
```

#### `getFileBlockEdges` — remove `Math.sqrt`

```typescript
// Before (line 514):
weight: Math.sqrt(row.call_count), // Diminishing returns for many calls

// After:
weight: row.call_count,
```

TOON's `_mergeASTEdges` (sagerank.ts:873–909) consumes `.weight` and multiplies by `astWeight` (default 2.0). The sqrt transform, if needed, is TOON's responsibility per constraints.md §Priority 0.5 line 56.

---

### `core/symbol-index.ts` — MODIFICATION

#### `indexFile` body replacement (lines 219–273 → ~12 lines)

```typescript
// Before: 55-line inline transaction
// After:
import { extractParsedFile } from './indexing/extract.js';
import { persistParsedFile } from './indexing/persist.js';

// ... inside indexFile, after hash check and langName check:
const parsed = await extractParsedFile(source, langName, relPath, hash);
if (!parsed) { purgeIndexedPath(db, relPath); return; }
persistParsedFile(db, parsed);
```

#### `indexDirectory` — add resolve pass (after line 326)

```typescript
import { resolveEdgeTargets } from './indexing/resolve.js';

// After the batch indexing loop (line 326):
for (const fp of filePaths) {
    const rel = path.relative(repoRoot, fp);
    resolveEdgeTargets(db, rel);
}
```

#### `getDb` — wire project_roots (after `_dbCache.set`, before return)

```typescript
import { upsertProjectRoot } from './db-adapter.js';

// Inside getDb, after _dbCache.set(repoRoot, conn) (line 124):
try {
    // Requires initGlobalSchema on a global DB — for now, register in the project DB
    upsertProjectRoot(conn, { rootPath: repoRoot, name: path.basename(repoRoot), createdAt: Date.now() });
} catch { /* ignore if project_roots table not present in project DB */ }
```

**Note (v3 remediation):** This calls `upsertProjectRoot` on the project's own `symbols.db`. The `project_roots` table now lives in the project DB schema (created by the v0→v1 migration above), not in a separate global registry. The legacy `initGlobalSchema` code path that put `project_roots` in `~/.zenith-mcp/global.db` remains unreferenced and should be deleted in a follow-up cleanup; it is explicitly NOT used by v3. The trade-off is intentional: a per-project registry is what every consumer in this codebase actually needs, and a global registry would require introducing a second `DbConnection` lifecycle which adds complexity for no current consumer. If a global registry is later required (e.g. for cross-project rename impact), it can be added as a separate `~/.zenith-mcp/global.db` opened by a new dedicated helper — distinct from the per-project DB.

The table itself is part of the v0→v1 DDL block above, so a fresh DB and an existing pre-v1 DB both end up with it. No separate one-off DDL is needed in `getDb`.

---

### `core/compression.ts` — GUTTED (v3 remediation: Priority 0.5 hardening)

**Original v3 snippet violated Priority 0.5** by importing `StructureBlock`/`CompressionContext` from `zenith-toon`, constructing them inside MCP, mapping anchors onto blocks, filtering exported symbols, boosting block priority for injections, and forwarding raw `astEdges`. Every one of those is a TOON-side decision. The remediation moves the entire shaping pipeline behind a single new TOON entrypoint, `compressFile(req)`, and reduces MCP's seam to fact gathering + one call.

**Hard invariants (mechanical, grep-checkable after execution):**
- Zero TOON-internal type imports inside `packages/zenith-mcp/src/` (no `StructureBlock`, no `CompressionContext`, no `compressSourceStructured`, no `compressString` directly).
- Zero compression decisions in `compression.ts`: no ranking, no `block.priority`, no edge transforms, no keep-ratio math, no "is useful" gate, no anchor→block mapping, no exported-symbol selection, no injection boosting.
- One `compressFile` call. Raw facts in. Compressed string (or `null`) out.

#### New TOON entrypoint contract (added to `packages/zenith-toon`)

```typescript
// zenith-toon/src/types.ts — NEW public contract
export interface RawFileFacts {
    path: string;                 // repo-relative; TOON does not read the filesystem
    langName: string | null;      // tree-sitter language name, or null if unsupported
    defs: Array<{
        name: string;
        kind: string;             // always 'def' on this payload
        type: string;             // e.g. 'function', 'method', 'class'
        line: number;             // 1-based
        endLine: number;          // 1-based
        visibility: string | null;
        captureTag: string | null;
    }>;
    edges: Array<{ callerName: string; calleeName: string; callCount: number }>; // raw count; no sqrt
    anchors: Array<{ symbolName: string; kind: string; line: number; text: string }>; // 1-based
    imports: Array<{ module: string; importedNames: string[]; line: number }>;
    injections: Array<{ injectedLang: string; startLine: number; endLine: number }>; // verbatim ranges; Priority 0
}

export interface CompressFileRequest {
    source: string;
    maxChars: number;             // ceiling only; TOON floors at 70% internally
    facts: RawFileFacts;
}
```

```typescript
// zenith-toon/src/string-codec.ts — NEW exported function
// compressFile owns: parse → StructureBlock[]/CompressionContext shaping → SageRank
// weighting (incl. any sqrt/log/decay on callCount) → anchor priority assignment →
// injection-aware preservation of embedded ranges (Priority 0 line truth) →
// 68–72% keep-ratio + `[TRUNCATED: lines X-Y]` marker → _MIN_OMISSION_THRESHOLD = 6 →
// pre-emit line-number assertion. MCP must never replicate any of this.
export function compressFile(req: CompressFileRequest): string | null;
```

#### MCP-side `compression.ts` — full file body

```typescript
// packages/zenith-mcp/src/core/compression.ts
// ---------------------------------------------------------------------------
// compression.ts — Facts pipe between zenith-mcp and zenith-toon.
// HARD INVARIANTS: see header comment above. Verified by grep after execution.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { compressFile } from 'zenith-toon';
import { getLangForFile } from './tree-sitter.js';
import { findRepoRoot, getDb } from './symbol-index.js';
import { getFileFacts } from './db-adapter.js';

export async function compressForTool(
    validPath: string,
    rawText: string,
    maxChars: number,
): Promise<string | null> {
    if (maxChars <= 0 || rawText.length <= maxChars) return null;

    const langName = getLangForFile(validPath);
    const repoRoot = findRepoRoot(validPath);

    // Empty-facts default. TOON tolerates this and falls back to its text path.
    let dbFacts = {
        defs: [] as any[], edges: [] as any[], anchors: [] as any[],
        imports: [] as any[], injections: [] as any[],
    };

    if (repoRoot) {
        try {
            const db = getDb(repoRoot);
            const relPath = path.relative(repoRoot, validPath);
            dbFacts = getFileFacts(db, relPath);
        } catch { /* DB unavailable — hand TOON the empty-facts payload */ }
    }

    return compressFile({
        source: rawText,
        maxChars,
        facts: {
            path: validPath,
            langName,
            defs: dbFacts.defs.map((d: any) => ({
                name: d.name, kind: 'def', type: d.type,
                line: d.line, endLine: d.endLine,
                visibility: d.visibility, captureTag: d.captureTag ?? null,
            })),
            edges: dbFacts.edges.map((e: any) => ({
                callerName: e.caller_name, calleeName: e.callee_name, callCount: e.call_count,
            })),
            anchors: dbFacts.anchors.map((a: any) => ({
                symbolName: a.symbol_name, kind: a.kind, line: a.line, text: a.text,
            })),
            imports: dbFacts.imports.map((i: any) => ({
                module: i.module, importedNames: i.importedNames, line: i.line,
            })),
            injections: dbFacts.injections.map((j: any) => ({
                injectedLang: j.injected_lang, startLine: j.start_line, endLine: j.end_line,
            })),
        },
    });
}
```

#### `FileFacts.defs` shape addition (db-adapter.ts)

`getFileFacts` must also return `captureTag` so the seam forwards it without re-querying:

```typescript
// db-adapter.ts — FileFacts.defs
defs: Array<{
    id: number; name: string; line: number; endLine: number;
    type: string | null; visibility: string | null;
    captureTag: string | null;       // NEW
}>;

// db-adapter.ts — getFileFacts() defs query
const defs = prepareOrCache(conn,
    `SELECT id, name, line, end_line AS endLine, type, visibility, capture_tag AS captureTag
     FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY line`
).all(filePath) as FileFacts['defs'];
```

#### Mechanical Priority 0.5 verification (run after execution)

All five greps below MUST return zero hits inside `packages/zenith-mcp/src/`:

```bash
grep -rn 'StructureBlock\|CompressionContext' packages/zenith-mcp/src/
grep -rn 'compressSourceStructured\|compressString\b' packages/zenith-mcp/src/
grep -rn 'computeCompressionBudget\|isCompressionUseful\|DEFAULT_COMPRESSION_KEEP_RATIO\|truncateToBudget\|compressTextFile' packages/zenith-mcp/src/
grep -rn 'Math\.sqrt(.*call_count\|astWeight\|astEdges' packages/zenith-mcp/src/
grep -rn 'block\.priority' packages/zenith-mcp/src/
```

Zero hits = Priority 0.5 holds.

**Deleted MCP exports** (consumers swap to `compressForTool` and the inline 3-line truncator shown in the `tools/*` sections below):
- `computeCompressionBudget`
- `isCompressionUseful`
- `DEFAULT_COMPRESSION_KEEP_RATIO`
- `truncateToBudget`
- `compressTextFile`

---

### `tools/read_file.ts` — MODIFICATION

```typescript
// Before (line 6):
import { compressTextFile, truncateToBudget } from '../core/compression.js';

// After:
import { compressForTool } from '../core/compression.js';

// Before (lines 101-104): truncateToBudget call
if (content.length > maxChars) {
    const truncatedResult = truncateToBudget(content, maxChars);
    content = truncatedResult.text;
    truncated = true;
}

// After:
if (content.length > maxChars) {
    let cutoff = content.lastIndexOf('\n', maxChars);
    if (cutoff === -1) cutoff = maxChars;
    content = content.slice(0, cutoff);
    truncated = true;
}

// Before (lines 112-117): compressTextFile call
if (args.compression) {
    const compressed = await compressTextFile(validPath, content, maxChars);
    if (compressed !== null) {
        content = compressed.text;
    }
}

// After:
if (args.compression) {
    const compressed = await compressForTool(validPath, content, maxChars);
    if (compressed !== null) {
        content = compressed;
    }
}
```

### `tools/read_multiple_files.ts` — MODIFICATION

```typescript
// Before (line 5):
import { compressTextFile, truncateToBudget } from '../core/compression.js';

// After:
import { compressForTool } from '../core/compression.js';

// Before (line 137): truncateToBudget call
const truncatedResult = truncateToBudget(content, effectiveBudget);
content = truncatedResult.text;
const truncated = truncatedResult.truncated;

// After:
let truncated = false;
if (content.length > effectiveBudget) {
    let cutoff = content.lastIndexOf('\n', effectiveBudget);
    if (cutoff === -1) cutoff = effectiveBudget;
    content = content.slice(0, cutoff);
    truncated = true;
}

// Before (line 147): compressTextFile call
const compressed = await compressTextFile(validPath, content, effectiveBudget);
if (compressed !== null) { content = compressed.text; }

// After:
const compressed = await compressForTool(validPath, content, effectiveBudget);
if (compressed !== null) { content = compressed; }
```

---

### `tools/refactor_batch.ts` — MODIFICATION (un-breaks outlier detection)

#### Site 1: Line 471-473 (`loadDiff` handler)

```typescript
// Before:
const structs: (SymbolStructure | null)[] = [];
// TODO: Populate actual SymbolStructure from AST for each occurrence in group

// After:
import { findSymbolStructuresByName, type SymbolStructureRow } from '../core/db-adapter.js';
// ... (import at top of file)

// At line 471:
const dbStructs = findSymbolStructuresByName(db, symName);
const structs: (SymbolStructure | null)[] = group.map(occ => {
    const match = dbStructs.find(s => s.file_path === occ.relPath && s.line === occ.line);
    if (!match) return null;
    return { params: match.params, returnKind: match.returnText, parentKind: match.parentKind, decorators: match.decorators, modifiers: match.modifiers };
});
```

#### Site 2: Line 974-975 (`reapply` handler)

```typescript
// Before:
const structs: (SymbolStructure | null)[] = [];
// TODO: Populate actual SymbolStructure from AST for each target

// After:
const structs: (SymbolStructure | null)[] = targets.map(t => {
    const relPath = path.relative(repoRoot, t.absPath);
    const matches = findSymbolStructuresByName(db, t.symbol);
    const match = matches.find(s => s.file_path === relPath && s.line === t.line);
    if (!match) return null;
    return { params: match.params, returnKind: match.returnText, parentKind: match.parentKind, decorators: match.decorators, modifiers: match.modifiers };
});
```

---

### `core/tree-sitter.ts` — MODIFICATION (re-export new modules)

Add to the barrel:

```typescript
export { getCompiledModularQuery, DEF_TYPES, QUERIES_LANG_MAP } from './tree-sitter/runtime.js';
export { extractStructureForDef, type SymbolStructure } from './tree-sitter/structure.js';
export { extractAnchorsForDef, type AnchorEntry } from './tree-sitter/anchors.js';
export { extractImportsFromSymbols, type ImportEdge } from './tree-sitter/imports.js';
export { extractInjections, type InjectionSpan } from './tree-sitter/injections.js';
export { extractLocals, type LocalScope, type LocalSymbol } from './tree-sitter/locals.js';
export { bodySlice, bodyHash } from './tree-sitter/body.js';
export { parseCaptureTag, type ParsedCaptureTag } from './tree-sitter/capture-tags.js';
```

---

### Dormant `patterns` Table — WIRING

The `patterns` table already exists in `initSymbolSchema` (lines 127-132). It's consumed by `refactor_batch.ts`'s `reapply` mode which stores `cachedPayload` per symbol group. v3 wires it:

In `refactor_batch.ts`, after a successful `apply`:
```typescript
import { insertPattern, getPattern } from '../core/db-adapter.js';
```

New adapter functions:
```typescript
export function insertPattern(conn: DbConnection, name: string, editBody: string, symbolKind: string): void {
    prepareOrCache(conn, 'INSERT OR REPLACE INTO patterns (name, edit_body, symbol_kind, created_at) VALUES (?, ?, ?, ?)').run(name, editBody, symbolKind, Date.now());
}

export function getPattern(conn: DbConnection, name: string): { edit_body: string; symbol_kind: string } | null {
    const row = prepareOrCache(conn, 'SELECT edit_body, symbol_kind FROM patterns WHERE name = ?').get(name) as any | undefined;
    return row ? { edit_body: row.edit_body, symbol_kind: row.symbol_kind } : null;
}
```

---

### Loose `grammars/tree-sitter-javascript.wasm`

The file at `grammars/tree-sitter-javascript.wasm` (416,499 bytes, executable) is dead weight. `runtime.ts` loads from `GRAMMARS_DIR` which points to `grammars/grammars/` (where the canonical 358,909-byte copy lives). **v3 ignores it.** The file is not deleted (per file-safety policy). It can be removed in a cleanup pass.

---

### 7 Queryless Grammars (cmake, dart, elixir, ini, make, perl, r)

These grammars have WASM files but no `<lang>-tags.scm` and no query directory.

**Fall-through behavior:** `getCompiledQuery(langName)` returns null → `extractParsedFile` returns null → `indexFile` calls `purgeIndexedPath`. These files are parseable but produce zero indexed rows. When query files are added for any of these languages in the future, indexing activates automatically (hash change triggers re-index).

**No special-case code needed.** The extractor pipeline already handles null queries gracefully.

---

## Concrete Deliverables Checklist

### New Files

- [ ] `packages/zenith-mcp/src/core/tree-sitter/capture-tags.ts`
- [ ] `packages/zenith-mcp/src/core/tree-sitter/body.ts`
- [ ] `packages/zenith-mcp/src/core/tree-sitter/structure.ts`
- [ ] `packages/zenith-mcp/src/core/tree-sitter/anchors.ts`
- [ ] `packages/zenith-mcp/src/core/tree-sitter/imports.ts`
- [ ] `packages/zenith-mcp/src/core/tree-sitter/injections.ts`
- [ ] `packages/zenith-mcp/src/core/tree-sitter/locals.ts`
- [ ] `packages/zenith-mcp/src/core/indexing/types.ts`
- [ ] `packages/zenith-mcp/src/core/indexing/extract.ts`
- [ ] `packages/zenith-mcp/src/core/indexing/persist.ts`
- [ ] `packages/zenith-mcp/src/core/indexing/resolve.ts`

### Modified Files

- [ ] `packages/zenith-mcp/src/core/db-adapter.ts` — schema v1 migration + 20 new adapter functions
- [ ] `packages/zenith-mcp/src/core/symbol-index.ts` — `indexFile` body → extract/persist delegation; `indexDirectory` → resolve pass; `getDb` → project_roots wiring
- [ ] `packages/zenith-mcp/src/core/compression.ts` — gutted → `compressForTool` only
- [ ] `packages/zenith-mcp/src/core/tree-sitter.ts` — barrel re-exports for new modules
- [ ] `packages/zenith-mcp/src/core/tree-sitter/runtime.ts` — `DEF_TYPES`, `QUERIES_LANG_MAP`, `getCompiledModularQuery()`
- [ ] `packages/zenith-mcp/src/core/tree-sitter/languages.ts` — `.cs`/`.csx` → `'c_sharp'`
- [ ] `packages/zenith-mcp/src/tools/read_file.ts` — `compressTextFile` → `compressForTool`; inline truncation
- [ ] `packages/zenith-mcp/src/tools/read_multiple_files.ts` — same
- [ ] `packages/zenith-mcp/src/tools/refactor_batch.ts` — lines 471-473 and 974-975 populated from DB

### New DDL (inside `initSymbolSchema` v0→v1 migration)

- [ ] `ALTER TABLE symbols ADD COLUMN capture_tag TEXT`
- [ ] `ALTER TABLE symbols ADD COLUMN body_hash TEXT`
- [ ] `ALTER TABLE symbols ADD COLUMN parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE`
- [ ] `ALTER TABLE symbols ADD COLUMN visibility TEXT`
- [ ] `ALTER TABLE edges ADD COLUMN callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL`
- [ ] `CREATE TABLE symbol_structures` (next to `edges` table)
- [ ] `CREATE TABLE anchors` + `idx_anchors_symbol`
- [ ] `CREATE TABLE imports` + `idx_imports_file` + `idx_imports_module`
- [ ] `CREATE TABLE local_scopes` + `idx_local_scopes_symbol`
- [ ] `CREATE TABLE injections` + `idx_injections_file`
- [ ] `CREATE TABLE schema_version`
- [ ] `CREATE TABLE project_roots` (in project DB, alongside v1 migration)
- [ ] `CREATE INDEX idx_edges_callee ON edges(callee_symbol_id)`

### New Adapter Functions

- [ ] `updateSymbolExtras` — set capture_tag/body_hash/parent_symbol_id/visibility
- [ ] `insertSymbolStructure` — INSERT OR REPLACE into symbol_structures
- [ ] `getSymbolStructure` — single-row lookup, JSON parsed
- [ ] `findSymbolStructuresByName` — multi-row JOIN, JSON parsed
- [ ] `insertAnchor` — INSERT into anchors
- [ ] `getAnchorsForFile` — JOIN symbols→anchors for a file
- [ ] `insertImport` — INSERT into imports
- [ ] `getImportsForFile` — SELECT with JSON parse
- [ ] `getFilesImporting` — reverse import graph query
- [ ] `insertInjection` — INSERT into injections
- [ ] `getInjectionsForFile` — SELECT for a file
- [ ] `insertLocalScope` — INSERT into local_scopes
- [ ] `getLocalScopesForSymbol` — SELECT with JSON parse
- [ ] `getUnresolvedEdges` — edges WHERE callee_symbol_id IS NULL
- [ ] `findSymbolByNameUnique` — LIMIT 2 unambiguity check
- [ ] `updateEdgeCalleeSymbol` — UPDATE edges SET callee_symbol_id
- [ ] `getFileFacts` — aggregate facts read for TOON
- [ ] `getSchemaVersion` — SELECT from schema_version
- [ ] `insertPattern` — INSERT OR REPLACE into patterns
- [ ] `getPattern` — SELECT from patterns

### New Extractors

- [ ] `parseCaptureTag` — classifies `@definition.X`/`@reference.X` capture names
- [ ] `bodySlice` + `bodyHash` — body text extraction and SHA-1 fingerprint
- [ ] `extractStructureForDef` — params/return/parent/decorators/modifiers from AST node
- [ ] `extractAnchorsForDef` — in-body anchor lines from ANCHOR_RULES table
- [ ] `extractImportsFromSymbols` — import edges from existing symbol refs
- [ ] `extractInjections` — embedded-language spans from `injections.scm`
- [ ] `extractLocals` — per-scope parameters/locals from `locals.scm`
- [ ] `extractParsedFile` — single-parse orchestrator calling all of the above
- [ ] `persistParsedFile` — single-transaction DB writer
- [ ] `resolveEdgeTargets` — cross-file edge resolution pass

### Consumer Wiring

- [ ] `refactor_batch.ts` outlier detection → `findSymbolStructuresByName`
- [ ] `compression.ts` facts pipe → `getFileFacts` + raw `call_count` edges
- [ ] `compression.ts` injection awareness → `facts.injections` boosts block priority
- [ ] `read_file.ts` → `compressForTool`
- [ ] `read_multiple_files.ts` → `compressForTool`
- [ ] `symbol-index.ts indexDirectory` → `resolveEdgeTargets` post-batch
- [ ] `symbol-index.ts getDb` → `upsertProjectRoot`
- [ ] `refactor_batch.ts reapply` → `insertPattern`/`getPattern`

### Deletions

- [ ] `compression.ts::computeCompressionBudget` — removed (TOON owns budget math)
- [ ] `compression.ts::isCompressionUseful` — removed (replaced by length check)
- [ ] `compression.ts::DEFAULT_COMPRESSION_KEEP_RATIO` — removed (TOON's 70% floor)
- [ ] `compression.ts::truncateToBudget` — removed (inlined at 2 call sites)
- [ ] `compression.ts::compressTextFile` — removed (replaced by `compressForTool`)
- [ ] `db-adapter.ts:514 Math.sqrt(row.call_count)` — replaced with raw `row.call_count`

---

## Self-Audit Against Constraints

### Priority 0 (constraints.md)

| Constraint | v3 Status |
|---|---|
| Line numbers must be TRUE to original file | v3 does not touch TOON's line-selection or marker emission. MCP passes raw text + budget; TOON returns verbatim lines. |
| Pre-emit assertion (ascending indices, valid markers) | Not affected — assertion lives inside `_compressSourceStructured` in zenith-toon. |
| 68–72% keep-ratio acceptable | MCP passes `maxChars` as budget ceiling. TOON internally floors at `Math.max(budget, Math.floor(text.length * 0.70))`. v3 does not override this. |
| Single canonical marker `[TRUNCATED: lines X-Y]` flush-left | Not affected — marker format is TOON-internal. |
| Verbatim line rule | Not affected — MCP passes raw text, receives compressed text, pipes to caller untouched. |
| `_MIN_OMISSION_THRESHOLD = 6` | Not affected — lives in TOON. |

### Priority 0.5 (constraints.md)

| Constraint | v3 Status |
|---|---|
| Every compression decision in zenith-toon | ✅ `compressForTool` passes raw facts. No budget math, no keep-ratio, no "is useful" gate in MCP. |
| MCP supplies raw facts only | ✅ `getFileFacts` returns defs/edges/anchors/imports/injections as raw DB rows. |
| No MCP-side `StructureBlock[]` or `CompressionContext` construction | ✅ **v3 remediation**: `compressForTool` now calls a single new TOON entrypoint `compressFile(req)` and passes raw `RawFileFacts`. MCP imports zero TOON-internal types. Mechanical proof: the five `grep` commands in the `core/compression.ts — GUTTED` section must all return zero hits inside `packages/zenith-mcp/src/`. |
| No edge weighting in MCP | ✅ `call_count` passed raw. `Math.sqrt` removed from `getFileBlockEdges`. |
| Forbidden symbols removed | ✅ `computeCompressionBudget`, `isCompressionUseful`, `DEFAULT_COMPRESSION_KEEP_RATIO`, `truncateToBudget`, `compressTextFile` all deleted. |
| No file with "compression" or "toon" in name making decisions | ✅ `compression.ts` is a facts pipe only. |

### zenith-toon-goal.md

| Rule | v3 Status |
|---|---|
| TOON owns compression intelligence | ✅ MCP is pipe + context provider. |
| MCP may provide: file text, path, root, budget, DB metadata, language hints | ✅ That's exactly what `compressForTool` provides. |
| No fake local SageRank/BMX/budget/dedup | ✅ None proposed. All live in zenith-toon. |
| No MCP-side tree-sitter-to-TOON compression adapters | ✅ The thin `compression.ts` gathers existing MCP data (getSymbols, getFileFacts) and passes it. No "adapter" or "shaping" logic. |
| Use the real engines (import, don't reimplement) | ✅ `compressSourceStructured` and `compressString` imported directly from zenith-toon workspace package. |

### AGENTS.md Invariants

| Rule | v3 Status |
|---|---|
| Only `db-adapter.ts` imports `node:sqlite` | ✅ Verified by grep — single hit at `db-adapter.ts:1`. |
| No subprocess bridge | ✅ Direct ESM workspace import `from 'zenith-toon'`. |
| One transaction per file re-index | ✅ `persistParsedFile` wraps everything in one `runTransaction`. |
| Schema changes additive | ✅ All new columns nullable, all new tables standalone, `CREATE IF NOT EXISTS`. |

---

## v3.1 Remediation Addendum

This addendum is additive to the v3 plan above. It records corrections applied after a third-party verdict (see `docs/plan_audit/v2-vs-v3-verdict.md`) flagged eight execution-blocking issues. Every fix is already inlined in the relevant section above; this addendum is the index so an engineer can audit that each fix landed.

### A1. Priority 0.5 hardening of the `core/compression.ts` seam

**Issue:** The original v3 `compressForTool` snippet imported `StructureBlock`/`CompressionContext` from `zenith-toon`, constructed them in MCP, mapped DB anchors onto blocks, forwarded `astEdges`, filtered `exportedSymbols`, and boosted block priority for injections. All five are TOON-side decisions; constraints.md §Priority 0.5 forbids them in MCP.

**Fix (see `core/compression.ts — GUTTED (v3 remediation)` section):**
- New TOON entrypoint `compressFile(req: CompressFileRequest): string | null` added to `packages/zenith-toon/src/string-codec.ts` and re-exported from `index.ts`.
- New TOON-public type `RawFileFacts` defined in `packages/zenith-toon/src/types.ts`. Contains only raw, position-bearing data: defs, edges (raw `callCount`), anchors, imports, injections. No priorities. No weights. No `StructureBlock`. No `CompressionContext`.
- MCP's `compression.ts` now imports exactly one symbol from `zenith-toon` (`compressFile`) and zero internal types. The body gathers raw facts and forwards them.
- Five mechanical grep checks (listed in the section) prove the invariant after execution. Any non-zero hit is a Priority 0.5 regression.

### A2. Uniform `prepareOrCache` use in `findSymbolStructuresByName`

**Issue:** The original snippet used `handle(conn).prepare(sql).all(...)` for the conditional-kind branch, breaking the rule that every adapter function uses the same `prepareOrCache` wrapper.

**Fix:** Replaced with `prepareOrCache(conn, sql).all(...params)`. The cache key is the final SQL string, so the kind-filtered and non-filtered shapes get distinct slots. Inline comment documents the rationale.

### A3. Strict dot-qualified resolution in `resolve.ts`

**Issue:** The dot-qualified fallback (`Foo.bar` → try `bar`) accepted any unambiguous `bar` even when its containing class wasn't `Foo`. That misroutes edges across unrelated namespaces.

**Fix:** The fallback now requires that the short-name's parent (looked up via the new `findSymbolParent` adapter) exists AND its `name` equals the qualifier. If either condition fails, the edge stays null. New adapter function `findSymbolParent(conn, symbolId)` added with verbatim SQL using `prepareOrCache`. Inline rationale documents that ambiguous edges heal on the next sweep through `ON DELETE SET NULL`.

### A4. Per-language parameter and modifier maps in `structure.ts`

**Issue:** A single global `PARAM_CONTAINER_TYPES` set and a single global `MODIFIER_KEYWORDS` set drove structural extraction for every language, conflating grammar-specific node types (`formals` vs `formal_parameters` vs `parameter_list` vs `closure_parameters` etc.) and missing language-specific keywords (`pub`, `suspend`, `readonly`, `nonmutating`).

**Fix:** Two new per-language tables: `PARAM_CONTAINERS_BY_LANG` (17 languages literal + global fallback) and `MODIFIER_KEYWORDS_BY_LANG` (6 languages whose modifier vocabulary materially differs from the global default; unioned with the default at lookup time so generic keywords are never lost). Two new helper functions: `paramContainersFor(langName)` and `modifierKeywordsFor(langName)`. `extractStructureForDef` now takes a `langName` argument and uses the per-language lookups. The single caller in `extract.ts` was updated to pass `langName`.

### A5. Predicate handling in `injections.ts`

**Issue:** Original code used a single `(match as any).setProperties` cast and only checked the match-level field. Nearly every shipped `injections.scm` writes `(#set! injection.language "sql")` at the pattern level, which lives on `Query.setProperties[patternIndex]`, not the match.

**Fix:** Two-level lookup, properly typed against the actual `web-tree-sitter@0.26.9` `.d.ts`:
1. Check `QueryMatch.setProperties` (match-level) for predicates that reference a capture.
2. Fall back to `Query.setProperties[match.patternIndex]` (pattern-level) for the constant `#set!` form that nearly every injections.scm uses.

No `as any` on either branch; both casts are to narrow structural types derived from the upstream `.d.ts`. Inline comments cite the `.d.ts` line numbers (828–845, 904–905).

### A6. `project_roots` DDL inside the v0→v1 ladder + prose cleanup

**Issue:** The v0→v1 DDL block did not include `CREATE TABLE project_roots`; only the prose around `getDb` mentioned that v3 would add it. Result: a fresh DB on a new project would call `upsertProjectRoot` against a table that didn't exist.

**Fix:** `CREATE TABLE IF NOT EXISTS project_roots (...)` appended to the v0→v1 DDL block. Prose around `getDb` updated to remove the misleading "global registry" framing — v3 puts the table in the project DB, full stop. Trade-off and future global-registry path documented honestly. The dead `initGlobalSchema` path remains unreferenced; a follow-up cleanup may delete it but v3 does not (file-safety policy).

### A7. Test repair mandate (execution-time requirement)

**Issue:** Build is green; tests are not (verified by the v2-vs-v3 reviewer). Several pre-existing failures (`tool-compression`, `read-multiple-files`, `read-multiple-files-concurrent`, `http-session-cleanup`, `compression-utils`) reference exactly the surface v3 deletes (`truncateToBudget`, the old `compressTextFile` return shape, etc.). Execution must repair these tests, not ignore them.

**Procedure:**
- **T1.** Before any v3 code lands, run `pnpm -s test --run` and snapshot the failing-test list. Anything failing for a non-v3 reason gets a tracking note; anything failing because it pins the deleted surface gets rewritten against `compressForTool` / the inline 3-line truncator.
- **T2.** For each deleted MCP-side export (`compressTextFile`, `computeCompressionBudget`, `isCompressionUseful`, `DEFAULT_COMPRESSION_KEEP_RATIO`, `truncateToBudget`), grep the entire `packages/zenith-mcp/tests/**` tree and rewrite or delete every reference. The replacement assertions should target the `compressForTool` return shape (a string or null) and the truncator's behavior at the call-site level.
- **T3.** Add at least one new test per new extractor (`structure`, `anchors`, `imports`, `injections`, `locals`) using a tiny fixture file in each of: python, typescript, rust, go. These prove the per-language tables actually fire.
- **T4.** Add a `compressForTool` integration test that exercises the empty-facts fallback path (no repo root, no DB) and the populated-facts path. Assert ONLY that the output is a string (or null) shorter than `rawText`. The test must not pin any internal TOON shape — if it does, it leaks Priority 0.5 across the test boundary.
- **T5.** Re-run `pnpm -s test --run`. **Net change in failing tests must be ≤ 0.**

### A8. Honest scope of per-language structural extraction

**Issue:** Even with A4 applied, structural extraction stays *approximate* for languages whose parameter lists carry rich shape (typed/defaulted/destructured parameters, generics with constraints, variadic forms). The current `extractStructureForDef` records child node *types* as `params[]`, not parameter names or types. That is enough to drive `refactor_batch`'s structural-similarity outlier check (the consumer that exists today), but it is not a full semantic parameter model.

**Decision and remediation path:**
- v3 ships exactly what the only current consumer (`refactor_batch.ts::findModal`/`firstDiffReason`) needs: a stable, comparable per-language fingerprint of parameter container *shape* plus return-kind node type plus parent-kind plus decorators plus modifiers. That is sufficient to flag outliers; it is intentionally not a parameter-by-parameter rename tool.
- A future consumer that needs richer shape (parameter names, default-value presence, type-annotation node text, variadic flag) can extend `SymbolStructure` and `extractStructureForDef` without schema migration: the JSON columns (`params_json`, etc.) already accept richer objects, and the adapter's `getSymbolStructure` returns parsed objects so consumers see the new shape natively.
- Until that consumer exists, adding more fields to `SymbolStructure` would be speculative bloat. The plan explicitly does not do it.
- The honest scope is documented here so a future agent does not interpret "per-language structure" as "full semantic parameter model."

### A9. Mechanical verification checklist (run after execution)

All commands run from the repo root. **Every one of these must be true** before v3 is considered landed.

```bash
# 1. Only db-adapter.ts imports node:sqlite.
grep -rn "node:sqlite" packages/zenith-mcp/src/ | grep -v db-adapter.ts
# Expected: empty.

# 2. No MCP-side compression-decision symbols remain.
grep -rn 'StructureBlock\|CompressionContext' packages/zenith-mcp/src/
grep -rn 'compressSourceStructured\|compressString\b' packages/zenith-mcp/src/
grep -rn 'computeCompressionBudget\|isCompressionUseful\|DEFAULT_COMPRESSION_KEEP_RATIO\|truncateToBudget\|compressTextFile' packages/zenith-mcp/src/
grep -rn 'Math\.sqrt(.*call_count\|astWeight\|astEdges' packages/zenith-mcp/src/
grep -rn 'block\.priority' packages/zenith-mcp/src/
# Expected: all five empty.

# 3. Single TOON import in MCP compression seam.
grep -n "from 'zenith-toon'" packages/zenith-mcp/src/core/compression.ts
# Expected: one line: `import { compressFile } from 'zenith-toon';`

# 4. handle(conn).prepare is never used outside the (test-only) escape hatch.
grep -rn 'handle(conn)\.prepare\|handle([a-z]*)\.prepare' packages/zenith-mcp/src/core/db-adapter.ts
# Expected: only inside the documented test-only escape-hatch comment block.

# 5. No dot-qualified fallback links without a parent check.
grep -n 'findSymbolByNameUnique' packages/zenith-mcp/src/core/indexing/resolve.ts
grep -n 'findSymbolParent'      packages/zenith-mcp/src/core/indexing/resolve.ts
# Expected: both present in the same file.

# 6. Per-language tables actually live in structure.ts.
grep -n 'PARAM_CONTAINERS_BY_LANG\|MODIFIER_KEYWORDS_BY_LANG' \
  packages/zenith-mcp/src/core/tree-sitter/structure.ts
# Expected: both present.

# 7. Injections predicate fix is in place.
grep -n 'setProperties\|patternIndex' packages/zenith-mcp/src/core/tree-sitter/injections.ts
# Expected: at least one match for each on separate lines (the two-level lookup).

# 8. project_roots lives in the v0→v1 DDL.
grep -n 'project_roots' packages/zenith-mcp/src/core/db-adapter.ts
# Expected: at least one hit inside initSymbolSchema's v0→v1 block.

# 9. Build and tests.
pnpm -s build
pnpm -s test --run
# Build: must be green.
# Tests: net new failing tests must be ≤ 0 vs the pre-v3 baseline captured in T1.
```

If any of the nine checks fails, **do not declare v3 landed.**
