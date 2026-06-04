# Road to AST Awareness — v2

This is the revised, fully implementable plan. It preserves everything v1 got right and remediates every weakness identified in the audit.

---

## Architectural Ground Rules (unchanged from v1)

1. **One and only one place imports `node:sqlite`:** `core/db-adapter.ts`.
2. **All AST/language/symbol producers write through the adapter.**
3. **All AST/language/symbol consumers read through the adapter.**
4. **One transaction per file re-index.**
5. **Schema version pin with migration ladder.**
6. **No compression decisions in MCP.** MCP gathers facts; TOON decides.

---

## Remediations Map

| Audit Weakness | Remediation |
|---|---|
| W1: runtime.ts only loads tags.scm | New `getCompiledModularQuery()` function in runtime.ts |
| W2: Per-language tables unspecified | Literal maps for 5 core languages + fallback |
| W3: JSON columns need parsing | Adapter returns parsed objects; JSON.parse lives in adapter |
| W4: parent_symbol_id unpopulated | Containment pass in extract.ts using line ranges |
| W5: resolve.ts race condition | ON DELETE SET NULL + re-resolve on file re-index |
| W6: injections table has no consumer | Mark as Phase 2; still create schema but defer extractor |
| W7: Migration ladder incomplete | Explicit v0→v1 ladder with bootstrap |
| W8: MCP compression functions not removed | Explicit removal + new seam code |
| W9: raw call_count vs weight | TOON applies sqrt; adapter returns raw count |
| W10: ref designs unacknowledged | Adopt ref-compression-structure.ts directly |
| W11: c_sharp vs csharp | Fix languages.ts mapping |
| W12: Loose wasm at root | Delete it |
| W13: imports.ts redundancy | Post-process getSymbols output instead of re-parsing |

---

## File Layout

All paths under `packages/zenith-mcp/src/`.

```
core/
  db-adapter.ts                       # EXPANDED: new tables + adapter functions
  symbol-index.ts                     # MODIFIED: delegates to extractors
  compression.ts                      # GUTTED: becomes thin seam to zenith-toon
  tree-sitter.ts                      # EXPANDED: re-exports new modules
  tree-sitter/
    languages.ts                      # MODIFIED: fix csharp → c_sharp
    runtime.ts                        # MODIFIED: add getCompiledModularQuery()
    symbols.ts                        # UNCHANGED
    structure.ts                      # NEW — SymbolStructure extraction (adopts ref-structural-similarity.ts)
    anchors.ts                        # NEW — anchor extraction (adopts ref-compression-structure.ts)
    imports.ts                        # NEW — post-processes getSymbols refs for import table
    locals.ts                         # NEW — runs locals.scm
    body.ts                           # NEW — body slice + sha1
    capture-tags.ts                   # NEW — capture name parser
  indexing/
    extract.ts                        # NEW — orchestrates all extractors for one file
    persist.ts                        # NEW — writes ParsedFileRecord in one transaction
    types.ts                          # NEW — shared shapes
    resolve.ts                        # NEW — cross-file edge resolution
```

---

## Detailed Specifications

### `core/tree-sitter/runtime.ts` — MODIFICATION

Add `getCompiledModularQuery()` alongside the existing `getCompiledQuery()`:

```typescript
// New cache for modular queries (locals.scm, injections.scm, etc.)
const _modularQueryCache: Map<string, Query | null> = new Map();

/**
 * Load and compile a modular query file (locals.scm, injections.scm, etc.).
 * Cached permanently like getCompiledQuery.
 * 
 * @param langName - tree-sitter language name
 * @param queryFile - filename within the lang's query dir (e.g. 'locals.scm')
 */
export async function getCompiledModularQuery(langName: string, queryFile: string): Promise<Query | null> {
    const cacheKey = `${langName}:${queryFile}`;
    if (_modularQueryCache.has(cacheKey)) {
        return _modularQueryCache.get(cacheKey) ?? null;
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

Also export `DEF_TYPES` (currently missing from runtime.ts but used by ref-structural-similarity.ts):

```typescript
export const DEF_TYPES: ReadonlySet<string> = new Set([
    'function_declaration', 'function_definition', 'method_definition',
    'arrow_function', 'function_expression', 'generator_function_declaration',
    'generator_function', 'class_declaration', 'class_definition',
    'class', 'abstract_class_declaration', 'interface_declaration',
    'type_alias_declaration', 'enum_declaration', 'module',
    // Rust
    'function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item',
    // Go
    'function_declaration', 'method_declaration', 'type_declaration',
    // Java/Kotlin
    'constructor_declaration', 'method_declaration',
    // Python
    'function_definition', 'class_definition',
    // C/C++
    'function_definition', 'struct_specifier', 'class_specifier',
]);
```

### `core/tree-sitter/languages.ts` — MODIFICATION (W11 fix)

```typescript
// Before:
'.cs':   'csharp',
'.csx':  'csharp',

// After:
'.cs':   'c_sharp',
'.csx':  'c_sharp',
```

This makes C# use `c_sharp-tags.scm` (91 lines, rich captures) instead of the minimal `csharp-tags.scm`. The `csharp-tags.scm` and `csharp/` directory become dead — they can be removed in a follow-up cleanup.

### `core/tree-sitter/capture-tags.ts` — NEW (~30 LOC)

```typescript
export interface ParsedCaptureTag {
    role: 'def' | 'ref';
    type: string;        // e.g. 'function', 'method', 'import', 'module'
    raw: string;         // e.g. 'definition.function', 'reference.import'
}

/**
 * Parse a capture tag name from tree-sitter query matches.
 * Input: 'name.definition.function' → { role: 'def', type: 'function', raw: 'definition.function' }
 * Input: 'definition.class' → { role: 'def', type: 'class', raw: 'definition.class' }
 * Input: 'name.reference.import' → { role: 'ref', type: 'import', raw: 'reference.import' }
 */
export function parseCaptureTag(captureName: string): ParsedCaptureTag | null {
    // Strip 'name.' prefix if present
    const name = captureName.startsWith('name.') ? captureName.slice(5) : captureName;

    if (name.startsWith('definition.')) {
        return { role: 'def', type: name.slice('definition.'.length), raw: name };
    }
    if (name.startsWith('reference.')) {
        return { role: 'ref', type: name.slice('reference.'.length), raw: name };
    }
    return null;
}
```

### `core/tree-sitter/body.ts` — NEW (~15 LOC)

```typescript
import { createHash } from 'node:crypto';

export function bodySlice(source: string, startLine: number, endLine: number): string {
    const lines = source.split('\n');
    // startLine/endLine are 1-based inclusive
    return lines.slice(startLine - 1, endLine).join('\n');
}

export function bodyHash(slice: string): string {
    return createHash('sha1').update(slice).digest('hex');
}
```

### `core/tree-sitter/structure.ts` — NEW (adopts ref-structural-similarity.ts)

This file is a lightly adapted version of `docs/ref-structural-similarity.ts`. The key export:

```typescript
import { Parser, Node } from 'web-tree-sitter';
import { loadLanguage, DEF_TYPES } from './runtime.js';

export interface SymbolStructure {
    params: string[];           // parameter node types (e.g. ['identifier', 'typed_parameter'])
    returnKind: string | null;  // node type of return type annotation
    parentKind: string | null;  // enclosing scope node type
    decorators: string[];       // decorator node types
    modifiers: string[];        // sorted modifier keywords
}

/**
 * Extract SymbolStructure for the definition spanning startLine..endLine (1-based).
 * Returns null if language unavailable or no matching def node found.
 * 
 * This is the function that feeds refactor_batch outlier detection.
 */
export async function getSymbolStructure(
    source: string, langName: string, startLine: number, endLine: number
): Promise<SymbolStructure | null> {
    // [Implementation identical to docs/ref-structural-similarity.ts::getSymbolStructure]
    // Uses DEF_TYPES, walks AST to find params/return/parent/decorators/modifiers
}
```

### `core/tree-sitter/anchors.ts` — NEW (adopts ref-compression-structure.ts)

This file is a lightly adapted version of `docs/ref-compression-structure.ts`. Core exports:

```typescript
import { Parser, Node } from 'web-tree-sitter';
import { loadLanguage } from './runtime.js';
import { getDefinitions } from './symbols.js';
import type { SymbolInfo } from './symbols.js';

export interface AnchorEntry {
    startLine: number;    // 0-based
    endLine: number;      // 0-based
    kind: string;         // 'return'|'throw'|'if'|'switch'|'loop'|'try'|'catch'|'await'|'call'|...
    priority: number;
}

export interface BlockWithAnchors {
    name: string;
    type: string;
    startLine: number;    // 0-based
    endLine: number;      // 0-based
    exported: boolean;
    anchors: AnchorEntry[];
}

// Per-language anchor node-type tables (16 languages from ref-compression-structure.ts)
const ANCHOR_RULES: Record<string, Record<string, { kind: string; priority: number }>> = {
    javascript: { return_statement: { kind: 'return', priority: 400 }, /* ... full table from ref */ },
    typescript: { /* ... */ },
    tsx: { /* ... */ },
    python: { return_statement: { kind: 'return', priority: 400 }, raise_statement: { kind: 'throw', priority: 380 }, /* ... */ },
    go: { return_statement: { kind: 'return', priority: 400 }, /* ... */ },
    rust: { return_expression: { kind: 'return', priority: 400 }, /* ... */ },
    java: { return_statement: { kind: 'return', priority: 400 }, /* ... */ },
    c: { /* ... */ },
    cpp: { /* ... */ },
    csharp: { /* ... */ },  // Note: will match c_sharp after languages.ts fix
    c_sharp: { /* ... */ },
    kotlin: { /* ... */ },
    php: { /* ... */ },
    ruby: { /* ... */ },
    swift: { /* ... */ },
    bash: { /* ... */ },
    lua: { /* ... */ },
    nix: { /* ... */ },
};

/**
 * Extract anchors for all definition blocks in a file.
 * Returns null if language unsupported. Returns empty array for supported
 * languages without anchor rules (graceful no-op).
 */
export async function getBlockAnchors(
    source: string, langName: string
): Promise<BlockWithAnchors[] | null> {
    // [Implementation identical to docs/ref-compression-structure.ts::getCompressionStructure]
}
```

**Fallback for unsupported languages:** If `langName` has no entry in `ANCHOR_RULES`, return blocks with empty `anchors[]`. Never crash.

### `core/tree-sitter/imports.ts` — NEW (~40 LOC)

Rather than re-parsing, this post-processes the `getSymbols` output:

```typescript
import type { SymbolInfo } from './symbols.js';

export interface ImportEdge {
    module: string;
    importedNames: string[];  // empty = wildcard/side-effect import
    line: number;
}

/**
 * Extract file-level import edges from already-computed symbols.
 * Filters refs with type 'import' or 'module' and groups by line.
 */
export function extractImportsFromSymbols(symbols: SymbolInfo[]): ImportEdge[] {
    const moduleRefs = symbols.filter(s => s.kind === 'ref' && (s.type === 'module' || s.type === 'import'));
    
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

This solves W13 — no separate tree-sitter pass needed; reuses existing parse results.

### `core/tree-sitter/locals.ts` — NEW

```typescript
import type { Query } from 'web-tree-sitter';
import { Parser } from 'web-tree-sitter';
import { loadLanguage, getCompiledModularQuery } from './runtime.js';

export interface LocalScope {
    scopeKind: string;          // node type of the scope (e.g. 'function_definition')
    startLine: number;          // 1-based
    endLine: number;            // 1-based
    parameters: LocalSymbol[];
    locals: LocalSymbol[];
}

export interface LocalSymbol {
    name: string;
    line: number;
    column: number;
}

/**
 * Run locals.scm for a language and extract per-scope parameters and locals.
 * Returns null if no locals.scm exists for this language. Returns [] if 
 * the query exists but produces no matches.
 */
export async function extractLocals(source: string, langName: string): Promise<LocalScope[] | null> {
    const query = await getCompiledModularQuery(langName, 'locals.scm');
    if (!query) return null;

    const language = await loadLanguage(langName);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) { parser.delete(); return null; }

    try {
        const matches = query.matches(tree.rootNode);
        const scopes: LocalScope[] = [];
        // ... process @scope, @local.parameter, @local.definition, @local.reference
        // Group parameters/locals by their containing @scope node
        return scopes;
    } finally {
        tree.delete();
        parser.delete();
    }
}
```

### `core/indexing/types.ts` — NEW

```typescript
export interface SymbolRow {
    name: string;
    kind: 'def' | 'ref';
    type: string;
    captureTag: string;        // full 'definition.function' etc.
    line: number;
    endLine: number;
    column: number;
    bodyHash: string | null;   // sha1 for defs only
    parentSymbolKey: string | null;  // transient FK key: `${name}:${line}:${col}`
    visibility: string | null; // 'public'|'private'|'protected'|'package'|null
}

export interface StructureRow {
    parentSymbolKey: string;
    params: string[];
    returnKind: string | null;
    decorators: string[];
    modifiers: string[];
    genericsText: string | null;
    parentKind: string | null;
    parentName: string | null;
}

export interface AnchorRow {
    parentSymbolKey: string;
    kind: string;
    line: number;   // 0-based (as produced by anchors.ts)
    text: string;   // first ~80 chars of the anchor line
}

export interface ImportRow {
    module: string;
    importedNames: string[];
    line: number;
}

export interface LocalScopeRow {
    parentSymbolKey: string | null;  // null for file-level scopes
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
    locals: LocalScopeRow[];
    edges: RawEdgeRow[];
}
```

### `core/indexing/extract.ts` — NEW

```typescript
import { getSymbols } from '../tree-sitter/symbols.js';
import { getSymbolStructure } from '../tree-sitter/structure.js';
import { getBlockAnchors } from '../tree-sitter/anchors.js';
import { extractImportsFromSymbols } from '../tree-sitter/imports.js';
import { extractLocals } from '../tree-sitter/locals.js';
import { bodySlice, bodyHash } from '../tree-sitter/body.js';
import { parseCaptureTag } from '../tree-sitter/capture-tags.js';
import type { ParsedFileRecord, SymbolRow, StructureRow, AnchorRow, RawEdgeRow } from './types.js';

/**
 * Extract all indexable data from a single file. Pure function — no DB access.
 * Returns null if language unsupported or parse fails.
 */
export async function extractParsedFile(
    source: string, langName: string, relPath: string, hash: string
): Promise<ParsedFileRecord | null> {
    const rawSymbols = await getSymbols(source, langName);
    if (!rawSymbols) return null;

    // Build symbols with capture tags and containment
    const defs = rawSymbols.filter(s => s.kind === 'def');
    const refs = rawSymbols.filter(s => s.kind === 'ref');
    
    const symbols: SymbolRow[] = [];
    
    for (const s of rawSymbols) {
        const key = `${s.name}:${s.line}:${s.column}`;
        let bHash: string | null = null;
        let parentKey: string | null = null;
        let visibility: string | null = null;
        
        if (s.kind === 'def') {
            const slice = bodySlice(source, s.line, s.endLine);
            bHash = bodyHash(slice);
            
            // Find parent: smallest enclosing def
            let bestParent: typeof defs[0] | null = null;
            let bestSpan = Infinity;
            for (const d of defs) {
                if (d === s) continue;
                if (d.line <= s.line && d.endLine >= s.endLine) {
                    const span = d.endLine - d.line;
                    if (span < bestSpan) {
                        bestSpan = span;
                        bestParent = d;
                    }
                }
            }
            if (bestParent) {
                parentKey = `${bestParent.name}:${bestParent.line}:${bestParent.column}`;
            }
        }
        
        symbols.push({
            name: s.name,
            kind: s.kind as 'def' | 'ref',
            type: s.type,
            captureTag: s.kind === 'def' ? `definition.${s.type}` : `reference.${s.type}`,
            line: s.line,
            endLine: s.endLine,
            column: s.column,
            bodyHash: bHash,
            parentSymbolKey: parentKey,
            visibility,  // populated by structure extraction below
        });
    }

    // Extract structures for defs
    const structures: StructureRow[] = [];
    for (const s of defs) {
        const struct = await getSymbolStructure(source, langName, s.line, s.endLine);
        if (struct) {
            const key = `${s.name}:${s.line}:${s.column}`;
            structures.push({
                parentSymbolKey: key,
                params: struct.params,
                returnKind: struct.returnKind,
                decorators: struct.decorators,
                modifiers: struct.modifiers,
                genericsText: null, // future: extract from AST
                parentKind: struct.parentKind,
                parentName: null,   // future: extract parent name
            });
            
            // Derive visibility from modifiers
            const sym = symbols.find(sym => sym.line === s.line && sym.column === s.column && sym.kind === 'def');
            if (sym) {
                if (struct.modifiers.includes('public') || struct.modifiers.includes('export')) {
                    sym.visibility = 'public';
                } else if (struct.modifiers.includes('private')) {
                    sym.visibility = 'private';
                } else if (struct.modifiers.includes('protected')) {
                    sym.visibility = 'protected';
                }
            }
        }
    }

    // Extract anchors
    const anchors: AnchorRow[] = [];
    const blocks = await getBlockAnchors(source, langName);
    if (blocks) {
        const lines = source.split('\n');
        for (const block of blocks) {
            // Find matching def by line range (0-based in blocks, 1-based in symbols)
            const matchingDef = defs.find(d => d.line - 1 === block.startLine && d.endLine - 1 === block.endLine);
            if (!matchingDef) continue;
            const key = `${matchingDef.name}:${matchingDef.line}:${matchingDef.column}`;
            for (const a of block.anchors) {
                anchors.push({
                    parentSymbolKey: key,
                    kind: a.kind,
                    line: a.startLine,
                    text: (lines[a.startLine] ?? '').slice(0, 80),
                });
            }
        }
    }

    // Extract imports (post-processes existing symbols — no re-parse)
    const imports = extractImportsFromSymbols(rawSymbols);

    // Extract locals
    const localScopes = await extractLocals(source, langName);
    const locals = (localScopes ?? []).map(scope => {
        // Find containing def
        let parentKey: string | null = null;
        for (const d of defs) {
            if (d.line <= scope.startLine && d.endLine >= scope.endLine) {
                parentKey = `${d.name}:${d.line}:${d.column}`;
                break;
            }
        }
        return {
            parentSymbolKey: parentKey,
            scopeKind: scope.scopeKind,
            startLine: scope.startLine,
            endLine: scope.endLine,
            parameters: scope.parameters,
            locals: scope.locals,
        };
    });

    // Build edges (same logic as current symbol-index.ts)
    const defEntries = symbols.filter(s => s.kind === 'def');
    const edges: RawEdgeRow[] = [];
    for (const ref of symbols.filter(s => s.kind === 'ref')) {
        // Find innermost containing def
        let bestDef: SymbolRow | null = null;
        let bestSpan = Infinity;
        for (const def of defEntries) {
            if (ref.line >= def.line && ref.line <= def.endLine) {
                const span = def.endLine - def.line;
                if (span < bestSpan) {
                    bestSpan = span;
                    bestDef = def;
                }
            }
        }
        if (bestDef) {
            edges.push({
                containerDefKey: `${bestDef.name}:${bestDef.line}:${bestDef.column}`,
                referencedName: ref.name,
            });
        }
    }

    return { relPath, hash, lang: langName, symbols, structures, anchors, imports, locals, edges };
}
```

### `core/indexing/persist.ts` — NEW

```typescript
import { DbConnection } from '../db-adapter.js';
import {
    runTransaction, upsertFile, deleteSymbolsByFile,
    insertSymbol, insertEdge,
    insertSymbolStructure, insertAnchor,
    insertImport, insertLocalScope,
    updateSymbolExtras,
} from '../db-adapter.js';
import type { ParsedFileRecord } from './types.js';

/**
 * Persist a ParsedFileRecord into the symbol DB in a single transaction.
 * Handles transient key→real ID mapping internally.
 */
export function persistParsedFile(conn: DbConnection, record: ParsedFileRecord): void {
    runTransaction(conn, () => {
        // 1. Clear old data (FK cascades handle child tables)
        deleteSymbolsByFile(conn, record.relPath);
        
        // 2. Upsert file record
        upsertFile(conn, record.relPath, record.hash, Date.now());
        
        // 3. Insert symbols, build key→id map
        const keyToId = new Map<string, number>();
        for (const sym of record.symbols) {
            const rowId = insertSymbol(conn, {
                name: sym.name,
                kind: sym.kind,
                type: sym.type,
                filePath: record.relPath,
                line: sym.line,
                endLine: sym.endLine,
                column: sym.column,
            });
            const key = `${sym.name}:${sym.line}:${sym.column}`;
            keyToId.set(key, rowId);
            
            // Update extended columns
            if (sym.bodyHash || sym.captureTag || sym.parentSymbolKey || sym.visibility) {
                const parentId = sym.parentSymbolKey ? (keyToId.get(sym.parentSymbolKey) ?? null) : null;
                updateSymbolExtras(conn, rowId, {
                    captureTag: sym.captureTag,
                    bodyHash: sym.bodyHash,
                    parentSymbolId: parentId,
                    visibility: sym.visibility,
                });
            }
        }
        
        // 4. Insert edges
        for (const edge of record.edges) {
            const containerId = keyToId.get(edge.containerDefKey);
            if (containerId !== undefined) {
                insertEdge(conn, containerId, edge.referencedName);
            }
        }
        
        // 5. Insert structures
        for (const struct of record.structures) {
            const symbolId = keyToId.get(struct.parentSymbolKey);
            if (symbolId === undefined) continue;
            insertSymbolStructure(conn, {
                symbolId,
                paramsJson: JSON.stringify(struct.params),
                returnText: struct.returnKind,
                decoratorsJson: JSON.stringify(struct.decorators),
                modifiersJson: JSON.stringify(struct.modifiers),
                genericsText: struct.genericsText,
                parentKind: struct.parentKind,
                parentName: struct.parentName,
            });
        }
        
        // 6. Insert anchors
        for (const anchor of record.anchors) {
            const symbolId = keyToId.get(anchor.parentSymbolKey);
            if (symbolId === undefined) continue;
            insertAnchor(conn, { symbolId, kind: anchor.kind, line: anchor.line, text: anchor.text });
        }
        
        // 7. Insert imports
        for (const imp of record.imports) {
            insertImport(conn, {
                filePath: record.relPath,
                module: imp.module,
                importedNamesJson: JSON.stringify(imp.importedNames),
                line: imp.line,
            });
        }
        
        // 8. Insert local scopes
        for (const local of record.locals) {
            const symbolId = local.parentSymbolKey ? (keyToId.get(local.parentSymbolKey) ?? null) : null;
            insertLocalScope(conn, {
                symbolId,
                scopeKind: local.scopeKind,
                startLine: local.startLine,
                endLine: local.endLine,
                parametersJson: JSON.stringify(local.parameters),
                localsJson: JSON.stringify(local.locals),
            });
        }
    });
}
```

### `core/indexing/resolve.ts` — NEW

```typescript
import { DbConnection } from '../db-adapter.js';
import { runTransaction, getUnresolvedEdges, findSymbolByNameUnique, updateEdgeCalleeSymbol } from '../db-adapter.js';

/**
 * Best-effort cross-file edge resolution.
 * For each unresolved edge originating in filePath, attempt to find an unambiguous
 * def with the same name. If exactly one def exists across the entire DB, link it.
 * If ambiguous (multiple defs), leave null.
 * 
 * Algorithm:
 * 1. Query all edges for filePath where callee_symbol_id IS NULL
 * 2. For each unique referenced_name, query symbols(name=?, kind='def')
 * 3. If exactly 1 result, update the edge's callee_symbol_id
 * 4. If 0 or >1 results, skip (leave null)
 * 
 * Concurrency/re-index story:
 * - ON DELETE SET NULL on callee_symbol_id means if the callee file is re-indexed
 *   (old def row deleted), the edge reverts to unresolved automatically.
 * - The next indexDirectory batch will call resolveEdgeTargets again, healing it.
 * - Single-file indexFile does NOT call resolve (too expensive). Only batch operations do.
 */
export function resolveEdgeTargets(conn: DbConnection, filePath: string): void {
    const unresolved = getUnresolvedEdges(conn, filePath);
    if (unresolved.length === 0) return;
    
    // Group by referenced_name to avoid repeated queries
    const byName = new Map<string, number[]>();  // name → edge IDs
    for (const edge of unresolved) {
        if (!byName.has(edge.referenced_name)) byName.set(edge.referenced_name, []);
        byName.get(edge.referenced_name)!.push(edge.id);
    }
    
    runTransaction(conn, () => {
        for (const [name, edgeIds] of byName) {
            const target = findSymbolByNameUnique(conn, name, 'def');
            if (target === null) continue;  // ambiguous or not found
            for (const edgeId of edgeIds) {
                updateEdgeCalleeSymbol(conn, edgeId, target.id);
            }
        }
    });
}
```

### `core/symbol-index.ts` — MODIFICATION

The `indexFile` function body changes from the current 80-line transaction to:

```typescript
// Before (lines 219–273): inline transaction with manual symbol/edge insertion
// After:
import { extractParsedFile } from './indexing/extract.js';
import { persistParsedFile } from './indexing/persist.js';
import { resolveEdgeTargets } from './indexing/resolve.js';

export async function indexFile(db: DbConnection, repoRoot: string, absFilePath: string): Promise<void> {
    const relPath = path.relative(repoRoot, absFilePath);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) return;
    if (!shouldIndexFile(repoRoot, absFilePath)) { purgeIndexedPath(db, relPath); return; }

    let source: string;
    try { source = await fs.readFile(absFilePath, 'utf-8'); } catch { purgeIndexedPath(db, relPath); return; }

    const hash = hashFileContent(source);
    const existingHash = getFileHash(db, relPath);
    if (existingHash && existingHash === hash) return;

    const langName = getLangForFile(absFilePath);
    if (!langName) { purgeIndexedPath(db, relPath); return; }

    const parsed = await extractParsedFile(source, langName, relPath, hash);
    if (!parsed) { purgeIndexedPath(db, relPath); return; }

    persistParsedFile(db, parsed);
}
```

And `indexDirectory` gains a resolve pass at the end:

```typescript
// After the batch indexing loop:
const relDir = path.relative(repoRoot, dirPath);
const prefix = relDir ? relDir + path.sep : '';
// Resolve cross-file edges for all files in this directory
for (const fp of filePaths) {
    const rel = path.relative(repoRoot, fp);
    resolveEdgeTargets(db, rel);
}
```

### `core/db-adapter.ts` — EXPANSION

#### Schema version + migration ladder

Add at the END of `initSymbolSchema`:

```typescript
// --- Schema version ---
db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);

// Bootstrap: if table is empty, we're at version 0
const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
const currentVersion = versionRow?.version ?? 0;

if (currentVersion < 1) {
    // Migration v0 → v1: add extended symbol columns + new tables
    // All wrapped in try/catch for idempotency (columns may already exist from partial run)
    const migrations = [
        'ALTER TABLE symbols ADD COLUMN capture_tag TEXT',
        'ALTER TABLE symbols ADD COLUMN body_hash TEXT',
        'ALTER TABLE symbols ADD COLUMN parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE',
        'ALTER TABLE symbols ADD COLUMN visibility TEXT',
        'ALTER TABLE edges ADD COLUMN callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL',
    ];
    for (const sql of migrations) {
        try { db.exec(sql); } catch (e: any) {
            const msg = e?.message || '';
            if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
        }
    }
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS symbol_structures (
            symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
            params_json TEXT,
            return_text TEXT,
            decorators_json TEXT,
            modifiers_json TEXT,
            generics_text TEXT,
            parent_kind TEXT,
            parent_name TEXT
        );
        CREATE TABLE IF NOT EXISTS anchors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
            kind TEXT,
            line INTEGER,
            text TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_anchors_symbol ON anchors(symbol_id);
        CREATE TABLE IF NOT EXISTS imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
            module TEXT,
            imported_names_json TEXT,
            line INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);
        CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module);
        CREATE TABLE IF NOT EXISTS local_scopes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
            scope_kind TEXT,
            start_line INTEGER,
            end_line INTEGER,
            parameters_json TEXT,
            locals_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_local_scopes_symbol ON local_scopes(symbol_id);
        CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_symbol_id);
    `);
    
    // Set version
    if (currentVersion === 0 && !versionRow) {
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
    } else {
        db.prepare('UPDATE schema_version SET version = ?').run(1);
    }
}
```

**Rollback story:** Additive only; no rollback. Old code ignores new columns (they're nullable). New code requires v1 schema. If a user needs to downgrade, they delete `.mcp/symbols.db` and it re-creates at whatever version the running code expects.

#### New adapter functions

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
    params: string[];      // parsed
    returnText: string | null;
    decorators: string[];  // parsed
    modifiers: string[];   // parsed
    genericsText: string | null;
    parentKind: string | null;
    parentName: string | null;
}

export function getSymbolStructure(conn: DbConnection, symbolId: number): SymbolStructureRow | null {
    const row = prepareOrCache(conn,
        'SELECT * FROM symbol_structures WHERE symbol_id = ?'
    ).get(symbolId) as any | undefined;
    if (!row) return null;
    return {
        symbol_id: row.symbol_id,
        params: JSON.parse(row.params_json || '[]'),
        returnText: row.return_text,
        decorators: JSON.parse(row.decorators_json || '[]'),
        modifiers: JSON.parse(row.modifiers_json || '[]'),
        genericsText: row.generics_text,
        parentKind: row.parent_kind,
        parentName: row.parent_name,
    };
}

/**
 * Find structures for all defs with a given name (and optional kind filter).
 * Used by refactor_batch outlier detection.
 * JSON parsing happens HERE in the adapter — consumers get typed objects.
 */
export function findSymbolStructuresByName(
    conn: DbConnection, name: string, kind?: string
): Array<SymbolStructureRow & { file_path: string; line: number; end_line: number }> {
    let sql = `SELECT ss.*, s.file_path, s.line, s.end_line 
               FROM symbol_structures ss 
               JOIN symbols s ON s.id = ss.symbol_id 
               WHERE s.name = ? AND s.kind = 'def'`;
    const params: any[] = [name];
    if (kind) { sql += ' AND s.type = ?'; params.push(kind); }
    
    const rows = handle(conn).prepare(sql).all(...params) as any[];
    return rows.map(row => ({
        symbol_id: row.symbol_id,
        params: JSON.parse(row.params_json || '[]'),
        returnText: row.return_text,
        decorators: JSON.parse(row.decorators_json || '[]'),
        modifiers: JSON.parse(row.modifiers_json || '[]'),
        genericsText: row.generics_text,
        parentKind: row.parent_kind,
        parentName: row.parent_name,
        file_path: row.file_path,
        line: row.line,
        end_line: row.end_line,
    }));
}

// --- Anchors ---

export function insertAnchor(conn: DbConnection, row: { symbolId: number; kind: string; line: number; text: string }): void {
    prepareOrCache(conn,
        'INSERT INTO anchors (symbol_id, kind, line, text) VALUES (?, ?, ?, ?)'
    ).run(row.symbolId, row.kind, row.line, row.text);
}

export function getAnchorsForFile(conn: DbConnection, filePath: string): Array<{ symbol_id: number; symbol_name: string; kind: string; line: number; text: string }> {
    return prepareOrCache(conn,
        `SELECT a.symbol_id, s.name AS symbol_name, a.kind, a.line, a.text 
         FROM anchors a JOIN symbols s ON s.id = a.symbol_id 
         WHERE s.file_path = ? ORDER BY a.line`
    ).all(filePath) as any[];
}

// --- Imports ---

export function insertImport(conn: DbConnection, row: { filePath: string; module: string; importedNamesJson: string; line: number }): void {
    prepareOrCache(conn,
        'INSERT INTO imports (file_path, module, imported_names_json, line) VALUES (?, ?, ?, ?)'
    ).run(row.filePath, row.module, row.importedNamesJson, row.line);
}

export function getImportsForFile(conn: DbConnection, filePath: string): Array<{ module: string; importedNames: string[]; line: number }> {
    const rows = prepareOrCache(conn,
        'SELECT module, imported_names_json, line FROM imports WHERE file_path = ? ORDER BY line'
    ).all(filePath) as any[];
    return rows.map(r => ({ module: r.module, importedNames: JSON.parse(r.imported_names_json || '[]'), line: r.line }));
}

// --- Local Scopes ---

export function insertLocalScope(conn: DbConnection, row: { symbolId: number | null; scopeKind: string; startLine: number; endLine: number; parametersJson: string; localsJson: string }): void {
    prepareOrCache(conn,
        'INSERT INTO local_scopes (symbol_id, scope_kind, start_line, end_line, parameters_json, locals_json) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(row.symbolId, row.scopeKind, row.startLine, row.endLine, row.parametersJson, row.localsJson);
}

// --- Edge resolution ---

export function getUnresolvedEdges(conn: DbConnection, filePath: string): Array<{ id: number; referenced_name: string }> {
    return prepareOrCache(conn,
        `SELECT e.id, e.referenced_name FROM edges e 
         JOIN symbols s ON s.id = e.container_def_id 
         WHERE s.file_path = ? AND e.callee_symbol_id IS NULL`
    ).all(filePath) as any[];
}

export function findSymbolByNameUnique(conn: DbConnection, name: string, kind: string): { id: number } | null {
    const rows = prepareOrCache(conn,
        'SELECT id FROM symbols WHERE name = ? AND kind = ? LIMIT 2'
    ).all(name, kind) as { id: number }[];
    // Only resolve if exactly 1 def exists (unambiguous)
    return rows.length === 1 ? rows[0]! : null;
}

export function updateEdgeCalleeSymbol(conn: DbConnection, edgeId: number, calleeSymbolId: number): void {
    prepareOrCache(conn,
        'UPDATE edges SET callee_symbol_id = ? WHERE id = ?'
    ).run(calleeSymbolId, edgeId);
}

// --- Aggregate facts read (for compression seam) ---

export interface FileFacts {
    defs: Array<{ id: number; name: string; line: number; endLine: number; type: string | null; captureTag: string | null; bodyHash: string | null; visibility: string | null }>;
    edges: Array<{ caller_name: string; callee_name: string; call_count: number }>;
    structures: Array<SymbolStructureRow & { symbol_name: string }>;
    anchors: Array<{ symbol_name: string; kind: string; line: number; text: string }>;
    imports: Array<{ module: string; importedNames: string[]; line: number }>;
}

export function getFileFacts(conn: DbConnection, filePath: string): FileFacts {
    const defs = prepareOrCache(conn,
        `SELECT id, name, line, end_line AS endLine, type, capture_tag AS captureTag, body_hash AS bodyHash, visibility 
         FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY line`
    ).all(filePath) as FileFacts['defs'];
    
    const edges = prepareOrCache(conn,
        `SELECT caller.name AS caller_name, e.referenced_name AS callee_name, COUNT(e.id) AS call_count
         FROM edges e JOIN symbols caller ON caller.id = e.container_def_id
         WHERE caller.file_path = ? AND caller.kind = 'def'
         GROUP BY caller.name, e.referenced_name`
    ).all(filePath) as FileFacts['edges'];
    
    // Structures with symbol name (for TOON to map to blocks)
    const structRows = handle(conn).prepare(
        `SELECT ss.*, s.name AS symbol_name FROM symbol_structures ss 
         JOIN symbols s ON s.id = ss.symbol_id WHERE s.file_path = ?`
    ).all(filePath) as any[];
    const structures = structRows.map((r: any) => ({
        symbol_id: r.symbol_id,
        symbol_name: r.symbol_name,
        params: JSON.parse(r.params_json || '[]'),
        returnText: r.return_text,
        decorators: JSON.parse(r.decorators_json || '[]'),
        modifiers: JSON.parse(r.modifiers_json || '[]'),
        genericsText: r.generics_text,
        parentKind: r.parent_kind,
        parentName: r.parent_name,
    }));
    
    const anchors = prepareOrCache(conn,
        `SELECT s.name AS symbol_name, a.kind, a.line, a.text 
         FROM anchors a JOIN symbols s ON s.id = a.symbol_id 
         WHERE s.file_path = ? ORDER BY a.line`
    ).all(filePath) as FileFacts['anchors'];
    
    const imports = getImportsForFile(conn, filePath);
    
    return { defs, edges, structures, anchors, imports };
}
```

### `core/compression.ts` — GUTTED (W8 remediation)

The file is reduced to the thin seam. **All decision functions are removed:**

```typescript
// ---------------------------------------------------------------------------
// compression.ts — Thin seam between zenith-mcp and zenith-toon
//
// MCP gathers facts. TOON decides. This file is the pipe.
// ---------------------------------------------------------------------------

import path from 'path';
import { compressString, compressSourceStructured } from 'zenith-toon';
import { getLangForFile, getSymbols } from './tree-sitter.js';
import { findRepoRoot, getDb } from './symbol-index.js';
import { getFileFacts } from './db-adapter.js';
import type { StructureBlock, CompressionContext, Anchor } from 'zenith-toon';

/**
 * Compress a file for tool output. MCP gathers structural facts from its
 * existing stores and hands them to TOON. TOON decides what to keep.
 * 
 * Returns the compressed string, or null if compression is not applicable
 * (TOON decides this too — via its internal budget/usefulness logic).
 */
export async function compressForTool(
    validPath: string,
    rawText: string,
    budget: number,
): Promise<string | null> {
    if (budget <= 0 || budget >= rawText.length) return null;

    const langName = getLangForFile(validPath);
    let compressed: string | null = null;

    if (langName) {
        try {
            // Gather facts from MCP's existing stores
            const rawSymbols = await getSymbols(rawText, langName);
            if (rawSymbols) {
                const defs = rawSymbols.filter(s => s.kind === 'def');

                // Build StructureBlock[] from symbol data
                const structure: StructureBlock[] = defs.map(s => ({
                    name: s.name,
                    kind: s.kind,
                    type: s.type,
                    startLine: s.line - 1,
                    endLine: s.endLine - 1,
                    exported: false,
                    anchors: [],
                }));

                const context: CompressionContext = {};

                // Enrich with DB facts if available
                const repoRoot = findRepoRoot(validPath);
                if (repoRoot && defs.length > 0) {
                    try {
                        const db = getDb(repoRoot);
                        const relPath = path.relative(repoRoot, validPath);
                        const facts = getFileFacts(db, relPath);

                        // Map DB anchors onto structure blocks
                        for (const block of structure) {
                            const blockAnchors = facts.anchors
                                .filter(a => a.symbol_name === block.name)
                                .map(a => ({ startLine: a.line, endLine: a.line, kind: a.kind, priority: 200 } as Anchor));
                            if (blockAnchors.length > 0) block.anchors = blockAnchors;
                        }

                        // Build AST edges — pass raw call_count as weight
                        // (TOON's _mergeASTEdges applies its own transform)
                        const blockNames = defs.map(d => d.name);
                        const nameToIdx = new Map(blockNames.map((n, i) => [n, i]));
                        const astEdges: Array<{ from: number; to: number; weight: number; kind: 'call' | 'reference' }> = [];
                        for (const e of facts.edges) {
                            const fromIdx = nameToIdx.get(e.caller_name);
                            const toIdx = nameToIdx.get(e.callee_name);
                            if (fromIdx !== undefined && toIdx !== undefined) {
                                astEdges.push({ from: fromIdx, to: toIdx, weight: e.call_count, kind: 'call' });
                            }
                        }
                        if (astEdges.length > 0) context.astEdges = astEdges;
                    } catch {
                        // DB unavailable — compress without graph context
                    }
                }

                compressed = compressSourceStructured(rawText, budget, structure, context);
            }
        } catch {
            // tree-sitter unavailable — fall through to unstructured
        }
    }

    if (!compressed) {
        compressed = compressString(rawText, budget);
    }

    // TOON decides if compression was useful (returns null-equivalent if not)
    if (!compressed || compressed.length >= rawText.length) return null;

    return compressed;
}
```

**Deleted exports:** `computeCompressionBudget`, `isCompressionUseful`, `DEFAULT_COMPRESSION_KEEP_RATIO`, `truncateToBudget`, `compressTextFile`.

### `tools/read_file.ts` — MODIFICATION

```typescript
// Before:
import { compressTextFile, truncateToBudget } from '../core/compression.js';
// ...
if (args.compression) {
    const compressed = await compressTextFile(validPath, content, maxChars);
    if (compressed !== null) {
        content = compressed.text;

// After:
import { compressForTool } from '../core/compression.js';
// ...
if (args.compression) {
    const budget = Math.floor(rawText.length * 0.70);  // TOON's keep-ratio applied via budget
    const compressed = await compressForTool(validPath, content, Math.min(budget, maxChars));
    if (compressed !== null) {
        content = compressed;
```

Wait — the constraints doc says TOON decides the budget/keep-ratio. MCP should NOT compute `0.70`. Looking at the constraints doc more carefully:

> "The 70% budget floor (`Math.max(budget, Math.floor(text.length * 0.70))`) is intentional and must NOT be changed"

This is a constraint ON TOON's internal `_compressSourceStructured`. MCP passes `maxChars` as the budget; TOON internally floors it at 70%. So MCP just passes `maxChars`:

```typescript
// After (corrected):
import { compressForTool } from '../core/compression.js';
// ...
if (args.compression) {
    const compressed = await compressForTool(validPath, content, maxChars);
    if (compressed !== null) {
        content = compressed;
```

### `tools/read_multiple_files.ts` — MODIFICATION

```typescript
// Before:
import { compressTextFile, truncateToBudget } from '../core/compression.js';
// ...
const compressed = await compressTextFile(validPath, content, effectiveBudget);
if (compressed !== null) { content = compressed.text;

// After:
import { compressForTool } from '../core/compression.js';
// ...
const compressed = await compressForTool(validPath, content, effectiveBudget);
if (compressed !== null) { content = compressed;
```

### `tools/refactor_batch.ts` — MODIFICATION (un-breaks outlier detection)

At lines 471–473 and 974–978, replace the empty `structs` array with actual DB lookups:

```typescript
// Before (line 471-473):
const structs: (SymbolStructure | null)[] = [];
// TODO: Populate actual SymbolStructure from AST for each occurrence in group

// After:
import { findSymbolStructuresByName } from '../core/db-adapter.js';

// In the loadDiff handler, after building bySymbol:
for (const [symName, group] of bySymbol) {
    if (group.length < 2) continue;
    
    // Query DB for structural signatures
    const dbStructs = findSymbolStructuresByName(db, symName);
    const structs: (SymbolStructure | null)[] = group.map(occ => {
        const match = dbStructs.find(s => s.file_path === occ.relFile && s.line === occ.line);
        if (!match) return null;
        return {
            params: match.params,
            returnKind: match.returnText,
            parentKind: match.parentKind,
            decorators: match.decorators,
            modifiers: match.modifiers,
        };
    });
    
    const modal = findModal(structs);
    // ... rest unchanged
}
```

Same pattern at line 974–978 for the reapply path.

### `getFileBlockEdges` — MODIFICATION (W9 remediation)

Remove `Math.sqrt` from the weight calculation:

```typescript
// Before (line 514):
weight: Math.sqrt(row.call_count),

// After:
weight: row.call_count,
```

TOON's `_mergeASTEdges` already multiplies by `astWeight` (default 2.0). If the raw count is too aggressive, TOON can apply its own dampening — that's TOON's domain. This is the correct ownership boundary per the constraints doc.

### Loose `tree-sitter-javascript.wasm` (W12)

Delete `/packages/zenith-mcp/grammars/tree-sitter-javascript.wasm`. It's a dead duplicate; `runtime.ts` loads from `grammars/grammars/`.

### `injections` table (W6)

The schema IS created in v1 migration (it's cheap and forward-looking), but the `injections.ts` extractor and `extractInjections` call are **deferred to Phase 2**. The `extractParsedFile` function does NOT call an injections extractor in this version. This avoids creating another dead table with no consumer.

---

## Implementation Order

1. **Schema migration** — add `schema_version` table + v1 migration to `db-adapter.ts`
2. **runtime.ts** — add `getCompiledModularQuery()` and `DEF_TYPES`
3. **languages.ts** — fix `csharp` → `c_sharp`
4. **New extractors** — `capture-tags.ts`, `body.ts`, `structure.ts`, `anchors.ts`, `imports.ts`, `locals.ts`
5. **indexing/types.ts** + **indexing/extract.ts** + **indexing/persist.ts**
6. **New adapter functions** in `db-adapter.ts`
7. **symbol-index.ts** — refactor `indexFile` to use extractors
8. **indexing/resolve.ts** + wire into `indexDirectory`
9. **compression.ts** — gut and replace with `compressForTool`
10. **Tool updates** — `read_file.ts`, `read_multiple_files.ts`, `refactor_batch.ts`
11. **getFileBlockEdges** — remove `Math.sqrt`
12. **Delete** loose `tree-sitter-javascript.wasm`
13. **Tests** — update existing, add new for extractors/persist/resolve

---

## What This Plan Does NOT Do (explicitly out of scope)

- Does not add injections extraction (Phase 2)
- Does not add a `patterns` table consumer (existing dead schema, unrelated)
- Does not wire `initGlobalSchema` / `project_roots` (unrelated to AST awareness)
- Does not touch TOON internals
- Does not create any new file with "compression" or "toon" in its name under `packages/zenith-mcp/src/`
- Does not propose any MCP-side edge weighting, budget computation, keep-ratio decision, or line-selection logic
