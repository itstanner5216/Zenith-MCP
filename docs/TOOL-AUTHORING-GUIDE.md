# Zenith-MCP — Complete Tool Authoring Reference
> Every fact in this document was read directly from the live source at
> `packages/zenith-mcp/src/`. Nothing is inferred or assumed.
> Hand this document to a model alongside a tool spec and it can produce
> a drop-in-ready tool file with zero guesswork.

---

## Table of Contents
1. [Project Structure](#1-project-structure)
2. [TypeScript Compiler Rules](#2-typescript-compiler-rules)
3. [The Mandatory Export Shape](#3-the-mandatory-export-shape)
4. [Core Types — verbatim from types.ts](#4-core-types--verbatim-from-typests)
5. [server.registerTool() — complete call shape](#5-serverregistertool--complete-call-shape)
6. [Zod Schema Patterns (v4)](#6-zod-schema-patterns-v4)
7. [Path Validation — the security boundary](#7-path-validation--the-security-boundary)
8. [Returning Results](#8-returning-results)
9. [Error Handling](#9-error-handling)
10. [Atomic File Writes](#10-atomic-file-writes)
11. [The Edit Engine — applyEditList and Edit modes](#11-the-edit-engine--applyeditlist-and-edit-modes)
12. [Tree-Sitter — AST Awareness](#12-tree-sitter--ast-awareness)
13. [Compression — toon_bridge and zenith-toon](#13-compression--toon_bridge-and-zenith-toon)
14. [The Symbol Index and Database](#14-the-symbol-index-and-database)
15. [The Database Adapter — DbConnection and SQL ops](#15-the-database-adapter--dbconnection-and-sql-ops)
16. [Project Context — how the server knows what project it's in](#16-project-context--how-the-server-knows-what-project-its-in)
17. [Shared Utilities — budgets, ripgrep, BM25](#17-shared-utilities--budgets-ripgrep-bm25)
18. [lib.ts Utilities — file I/O, diff, helpers](#18-libts-utilities--file-io-diff-helpers)
19. [The Stash System](#19-the-stash-system)
20. [Registering a New Tool in server.ts](#20-registering-a-new-tool-in-serverts)
21. [Complete Import Reference by Module](#21-complete-import-reference-by-module)
22. [Patterns From Existing Tools](#22-patterns-from-existing-tools)
23. [What NOT to Do](#23-what-not-to-do)
24. [Minimal Tool Template](#24-minimal-tool-template)
25. [Full Reference: write_file.ts](#25-full-reference-write_filets)
26. [Pre-Handoff Checklist](#26-pre-handoff-checklist)

---

## 1. Project Structure

```
packages/zenith-mcp/
├── src/
│   ├── tools/                  ← every tool lives here, one file per tool
│   │   ├── types.ts            ← ToolServer, ToolContext, ToolResult, ToolContent
│   │   ├── read_file.ts
│   │   ├── write_file.ts
│   │   ├── edit_file.ts
│   │   ├── directory.ts
│   │   ├── search_file.ts
│   │   ├── search_files.ts
│   │   ├── filesystem.ts
│   │   ├── read_multiple_files.ts
│   │   ├── read_media_file.ts
│   │   ├── stash_restore.ts
│   │   └── refactor_batch.ts
│   ├── core/
│   │   ├── server.ts           ← TOOL_REGISTRY lives here — you MUST edit this
│   │   ├── lib.ts              ← FilesystemContext, file I/O, diff, line helpers
│   │   ├── shared.ts           ← BM25, ripgrep, budgets, excludes, sensitive-file filter
│   │   ├── edit-engine.ts      ← applyEditList(), syntaxWarn(), Edit interface
│   │   ├── compression.ts      ← compressTextFile(), truncateToBudget(), runToonBridge()
│   │   ├── toon_bridge.ts      ← compressToon() — integrates tree-sitter + zenith-toon
│   │   ├── toon_bridge_cli.ts  ← CLI entry for compression subprocess
│   │   ├── stash.ts            ← stashEdits(), stashWrite(), getStashEntry(), etc.
│   │   ├── symbol-index.ts     ← findRepoRoot(), getDb(), indexFile/Dir, snapshotSymbol
│   │   ├── db-adapter.ts       ← DbConnection class + ALL SQL operations
│   │   ├── project-context.ts  ← ProjectContext, getProjectContext(), FsContext
│   │   ├── project-registry.ts ← ProjectRegistry (used internally by project-context)
│   │   ├── path-utils.ts       ← normalizePath(), expandHome()
│   │   ├── path-validation.ts  ← isPathWithinAllowedDirectories()
│   │   ├── roots-utils.ts      ← getValidRootDirectories()
│   │   └── tree-sitter.ts      ← barrel re-export for all tree-sitter submodules
│   │       tree-sitter/
│   │       ├── languages.ts    ← getLangForFile(), isSupported(), EXT_TO_LANG (43 grammars)
│   │       ├── symbols.ts      ← getSymbols(), findSymbol(), checkSyntaxErrors(), SymbolInfo
│   │       ├── runtime.ts      ← loadLanguage(), getCompiledQuery(), treeSitterAvailable()
│   │       ├── compression-structure.ts ← getCompressionStructure() (17 language anchor rules)
│   │       └── structural-similarity.ts ← getStructuralFingerprint(), computeStructuralSimilarity()
│   └── utils/
│       └── project-scope.ts    ← resolveProjectRoot() — 4-step project detection ladder
├── tsconfig.json
└── package.json

packages/zenith-toon/src/      ← compression library (workspace:* dependency)
    index.ts                    ← public exports: compressString, compressSourceStructured, etc.
    types.ts                    ← StructureBlock, ASTEdge, Anchor interfaces
    pipeline.ts                 ← compress(), CompressConfig, TOONCompressor
    string-codec.ts             ← compressString(), compressSourceStructured()
    sagerank.ts                 ← SageRank graph centrality
    bmx-plus.ts                 ← BMXPlusIndex (BM25 extended)
    ...
```

---

## 2. TypeScript Compiler Rules

**`tsconfig.json` (exact):**
```json
{
  "target": "ES2022",
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "outDir": "dist",
  "rootDir": "src",
  "strict": true,
  "esModuleInterop": true,
  "composite": true,
  "declaration": true,
  "sourceMap": true,
  "forceConsistentCasingInFileNames": true,
  "skipLibCheck": false,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "exactOptionalPropertyTypes": true,
  "noUncheckedIndexedAccess": true,
  "types": ["node", "emscripten"]
}
```

**The `src/retrieval/**` folder is EXCLUDED from compilation. Never import from it.**

### Consequences You Must Satisfy

| Flag | Consequence |
|---|---|
| `module: NodeNext` | All imports MUST end in `.js` (even though sources are `.ts`) |
| `noUnusedLocals` | Every declared variable must be used |
| `noUnusedParameters` | Every parameter must be used, or prefix with `_` |
| `noUncheckedIndexedAccess` | `arr[i]` returns `T \| undefined` — you must narrow |
| `exactOptionalPropertyTypes` | You cannot assign `prop: undefined`; use `prop?: T` only |
| `strict` | All strict checks: `strictNullChecks`, `noImplicitAny`, etc. |
| `skipLibCheck: false` | Type errors in .d.ts files ARE caught |

**Import examples:**
```typescript
// CORRECT — .js extension on all imports
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { randomBytes } from 'crypto';
import type { ToolServer, ToolContext } from './types.js';
import { getCharBudget } from '../core/shared.js';
import { applyEditList } from '../core/edit-engine.js';

// WRONG — will fail at runtime under NodeNext
import { foo } from '../core/lib';       // missing .js
import { bar } from '../core/shared.ts'; // .ts extension
```

The package is `"type": "module"` — all files are ES modules. No `require()`.

---

## 3. The Mandatory Export Shape

Every tool file exports exactly one named function:

```typescript
export function register(server: ToolServer, ctx: ToolContext): void {
    server.registerTool( /* ... */ );
}
```

Nothing else needs to be exported. The function body contains exactly one `server.registerTool(...)` call (or one per tool if you are combining multiple logical operations, but prefer one tool per file).

---

## 4. Core Types — verbatim from types.ts

**File: `src/tools/types.ts`**

```typescript
export type ToolTextContent = {
    type: "text";
    text: string;
};

export type ToolImageContent = {
    type: "image";
    data: string;
    mimeType: string;
};

export type ToolAudioContent = {
    type: "audio";
    data: string;
    mimeType: string;
};

export type ToolBlobContent = {
    type: "blob";
    data: string;
    mimeType: string;
};

export type ToolContent = ToolTextContent | ToolImageContent | ToolAudioContent | ToolBlobContent;

export type ToolResult = {
    content: ToolContent[];
};

export type ToolHandler<TArgs> = (args: TArgs) => Promise<ToolResult> | ToolResult;

export type ToolRegistration = {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: {
        readOnlyHint?: boolean;
        idempotentHint?: boolean;
        destructiveHint?: boolean;
    };
};

export type ToolServer = {
    registerTool<TArgs>(
        name: string,
        registration: ToolRegistration,
        handler: ToolHandler<TArgs>
    ): void;
};

export type ToolContext = {
    sessionId?: string;
    validatePath(inputPath: string): Promise<string>;
    validateNewFilePath(inputPath: string): Promise<string>;
    getAllowedDirectories: () => string[];
    setAllowedDirectories: (directories: string[]) => void;
};

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
```

**Import pattern:**
```typescript
import type { ToolServer, ToolContext } from './types.js';
import { errorMessage } from './types.js';
// ToolResult, ToolContent, etc. are type-only, use `import type` for them
```

---

## 5. server.registerTool() — complete call shape

```typescript
server.registerTool<YourArgsType>("tool_name", {
    title: "Human Readable Title",
    description: "One-sentence description shown to clients.",
    inputSchema: z.object({ /* Zod v4 schema */ }),
    annotations: {
        readOnlyHint: true,       // true = never writes/modifies anything
        idempotentHint: false,    // true = safe to call multiple times
        destructiveHint: false,   // true = can delete or overwrite data
    }
}, async (args: YourArgsType) => {
    // handler body
    return {
        content: [{ type: "text" as const, text: "result" }],
    };
});
```

**Rules:**
- First argument: the **tool name string**. Must exactly match the `name` field in `TOOL_REGISTRY` in `server.ts`.
- `inputSchema`: a **Zod v4 `z.object({...})`**. Never a raw JSON Schema object.
- The handler receives **parsed, Zod-validated args** — all coercions and defaults are already applied.
- Return type is always `{ content: ToolContent[] }`.
- `type: "text" as const` is required — the discriminated union needs the literal type.
- All existing read-only tools use `annotations: { readOnlyHint: true }`.
- All write tools use `annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }`.

---

## 6. Zod Schema Patterns (v4)

Package: `"zod": "^4.3.6"`. Import: `import { z } from "zod";`

```typescript
// String
z.string()
z.string().describe("File path.")

// Number
z.number()
z.number().int().min(1).max(10)
z.number().int().min(1)

// Boolean — always explicit default when optional
z.boolean().optional().default(false).describe("Preview without writing.")
z.boolean().optional().default(true).describe("Compress whitespace.")

// Enum
z.enum(["list", "tree"])
z.enum(["content", "files", "symbol", "structural", "definition"])
z.enum(["block", "content", "symbol"])
z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'module', 'any'])

// Optional (no default)
z.string().optional()
z.number().optional()

// Array
z.array(z.string())
z.array(z.string()).min(1).max(50)
z.array(z.string()).optional().default([])
z.array(z.object({ startLine: z.number(), endLine: z.number() })).optional()

// Nested object
z.object({
    mode: z.enum(["block", "content", "symbol"]),
    symbol: z.string().optional(),
    nearLine: z.number().optional(),
})

// Always add .describe() to every field — it appears in tool schemas shown to clients
z.string().describe("File to write.")
z.boolean().optional().default(false).describe("Fail if the file already exists.")
```

**Important:** `.default()` is applied by Zod before the handler receives args. If you declare `z.boolean().optional().default(false)` in the schema, then in your args type the field is `boolean` (not `boolean | undefined`). In the args TypeScript type you should write it as `boolean` not `boolean | undefined`.

---

## 7. Path Validation — the security boundary

**This is mandatory for every file operation. Never use `args.path` directly.**

### `ctx.validatePath(path)` — existing files/directories
Use when the path **must already exist** (reading, editing, searching, stat-ing).

```typescript
const validPath = await ctx.validatePath(args.path);
// validPath is the real absolute path, symlinks resolved, confirmed within allowed dirs
```

### `ctx.validateNewFilePath(path)` — new files
Use when **creating a file** that does not yet exist.

```typescript
const validPath = await ctx.validateNewFilePath(args.path);
// validPath is the real absolute path of the nearest existing ancestor + missing segments
// The file itself does not need to exist, but it must be within allowed directories
```

Both throw `Error` if the path escapes allowed directories or a symlink leads outside. The thrown error propagates to the MCP client automatically — do not catch it unless you need to translate the message.

### What these functions do internally (from lib.ts)
- Expand `~` via `expandHome()`
- Resolve to absolute path
- Normalize via `normalizePath()`
- Check against `_allowedDirectories` via `isPathWithinAllowedDirectories()`
- For `validatePath`: `fs.realpath()` to resolve symlinks, then re-check
- For `validateNewFilePath`: walk up to the nearest existing ancestor, `fs.realpath()` that, then re-check

---

## 8. Returning Results

### Text (most common)
```typescript
return {
    content: [{ type: "text" as const, text: "your output here" }],
};
```

### Image
```typescript
return {
    content: [{ type: "image" as const, data: base64String, mimeType: "image/png" }],
};
```

### Audio
```typescript
return {
    content: [{ type: "audio" as const, data: base64String, mimeType: "audio/mpeg" }],
};
```

### Blob (other binary)
```typescript
return {
    content: [{ type: "blob" as const, data: base64String, mimeType: "application/octet-stream" }],
};
```

### Multiple content items
```typescript
return {
    content: [
        { type: "text" as const, text: "Metadata:" },
        { type: "image" as const, data: b64, mimeType: "image/jpeg" },
    ],
};
```

**Critical: `type: "text" as const` is always required.**  
Without `as const`, TypeScript infers `type: string` which does not satisfy the discriminated union `ToolContent`.

---

## 9. Error Handling

**Throw, never return errors.**

```typescript
// Correct
throw new Error('path required for mkdir.');
throw new Error(`File not found: ${args.path}`);
throw new Error(`Unknown mode: ${args.mode}`);

// Wrong — don't return { error: ... } objects
```

The MCP framework catches all thrown `Error` instances and returns them as error responses. For mode-specific required params, check early and throw:

```typescript
if (args.mode === "mkdir") {
    if (!args.path) throw new Error('path required for mkdir.');
}
```

For `NodeJS.ErrnoException` codes:
```typescript
try {
    await fs.stat(validPath);
    existed = true;
} catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
        throw new Error(`Cannot access file: ${code ?? 'unknown error'}`);
    }
}
```

Use `errorMessage(error)` from `types.ts` when you need a safe string from an unknown error:
```typescript
import { errorMessage } from './types.js';
throw new Error(`Cannot create directory: ${errorMessage(err)}`);
```

---

## 10. Atomic File Writes

Every write in this codebase uses a temp-file + rename pattern. This guarantees that readers never see a partially-written file.

```typescript
import { randomBytes } from 'crypto';
import fs from 'fs/promises';

const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, validPath);
} catch (error) {
    try { await fs.unlink(tempPath); } catch { /* cleanup, ignore */ }
    throw error;
}
```

`write_file.ts` also does a byte-count verification after writing the temp file before rename:
```typescript
const tempStat = await fs.stat(tempPath);
const expectedBytes = Buffer.byteLength(finalContent, 'utf-8');
if (tempStat.size !== expectedBytes) {
    throw new Error('Write verification failed.');
}
```

On write failure, `write_file.ts` stashes the content so the user can retry:
```typescript
const stashId = stashWrite(ctx, validPath, normalizedContent, args.append ? 'append' : 'write');
throw new Error(`Write failed. Cached as stash:${stashId}.`);
```

---

## 11. The Edit Engine — applyEditList and Edit modes

**File: `src/core/edit-engine.ts`**

This is the core of `edit_file.ts` and `stash_restore.ts`. It is a **pure function** — no I/O.

### The Edit interface
```typescript
export interface Edit {
    filePath?: string;
    oldText?: string;
    newText?: string;
    isBatch?: boolean;
    disambiguations?: Map<number, { startLine?: number; nearLine?: number }>;
    mode?: 'block' | 'symbol' | 'content';
    // block mode fields:
    block_start?: string;
    block_end?: string;
    replacement_block?: string;
    // symbol mode fields:
    nearLine?: number;
    symbol?: string;
    newText?: string;
    // content mode fields:
    oldContent?: string;
    newContent?: string;
}
```

### applyEditList()
```typescript
import { applyEditList, syntaxWarn } from '../core/edit-engine.js';

const { workingContent, errors, pendingSnapshots } = await applyEditList(
    originalContent,  // string — the file contents, already normalized
    args.edits,       // Edit[]
    {
        filePath: validPath,       // string — used for language detection in symbol mode
        isBatch: edits.length > 1, // boolean — affects error message formatting
        disambiguations,           // optional Map<number, {startLine?, nearLine?}>
    }
);

if (errors.length > 0) {
    // errors[i].i = index of failed edit, errors[i].msg = message
    const stashId = stashEdits(ctx, validPath, args.edits, errors.map(e => e.i));
    throw new Error(`${errors.length} failed. stash:${stashId}\n${errors.map(e => e.msg).join('\n')}`);
}
```

### Three edit modes

**`block` mode** — replaces lines between two anchor lines (inclusive):
- Required: `block_start` (string, trimmed match), `block_end` (string, trimmed match), `replacement_block` (string)
- Finds the first line matching `block_start.trim()`, then the first line at or after it matching `block_end.trim()`
- If multiple candidates found, requires `disambiguations.startLine`

**`symbol` mode** — replaces a named symbol's entire body:
- Required: `symbol` (string, supports dot-qualified `"MyClass.myMethod"`), `newText` (string)
- Uses tree-sitter to locate the symbol. Requires the file type to be supported by a language with a tags.scm query
- If multiple matches, requires `nearLine` disambiguation
- On success, snapshots the original text in `pendingSnapshots` for version history

**`content` mode** — find-and-replace by text:
- Required: `oldContent` (string), `newContent` (string)
- Three fallback strategies: exact → trim-trailing-whitespace → indent-stripped
- If `nearLine` provided, prefers the closest match when multiple exist
- Re-indents replacement relative to the original indent if indent-stripped strategy was used

### syntaxWarn()
```typescript
const warning = await syntaxWarn(validPath, workingContent);
return { content: [{ type: 'text', text: `Applied.${warning}` }] };
// warning is either '' or '\nParse errors at lines 12:5, 34:0'
```
Calls `checkSyntaxErrors()` via tree-sitter. Returns `''` if language is not supported, or if no errors. Suppressed for `.mdx`, `.jsonc`, `.json5`, `.jsonl`, `.ndjson`.

### pendingSnapshots — version history
After a successful write, iterate `pendingSnapshots` and call `snapshotSymbol()` for each:
```typescript
if (pendingSnapshots.length > 0) {
    try {
        const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
        const db = getDb(repoRoot);
        const sessionId = ctx.sessionId || getSessionId();
        const relPath = path.relative(repoRoot, validPath);
        for (const snap of pendingSnapshots) {
            if (snap.symbol !== undefined) {
                snapshotSymbol(db, snap.symbol, relPath, snap.originalText, sessionId, snap.line);
            }
        }
    } catch { /* versioning is best-effort; never fail an edit because of it */ }
}
```

---

## 12. Tree-Sitter — AST Awareness

**Barrel import: `src/core/tree-sitter.ts`** (re-exports from submodules)

### Language detection (`tree-sitter/languages.ts`)

```typescript
import { getLangForFile, isSupported, getSupportedExtensions } from '../core/tree-sitter.js';

getLangForFile('/some/file.ts')   // → 'typescript'
getLangForFile('/some/Makefile')  // → 'make'
getLangForFile('/some/file.xyz')  // → null

isSupported('/some/file.rs')      // → true
isSupported('/some/file.xyz')     // → false
```

**43 grammars are registered.** Key extension → language mappings:
- `.js/.mjs/.cjs/.jsx` → `javascript`
- `.ts/.mts/.cts` → `typescript`
- `.tsx` → `tsx`
- `.py/.pyi` → `python`
- `.rs` → `rust`
- `.go` → `go`
- `.java` → `java`
- `.c/.h` → `c`, `.cpp/.cc/.hpp` → `cpp`
- `.cs` → `csharp`, `.kt` → `kotlin`, `.rb` → `ruby`, `.swift` → `swift`
- `.lua` → `lua`, `.php` → `php`
- `.json/.jsonc` → `json`, `.yaml/.yml` → `yaml`, `.toml` → `toml`
- `.sql` → `sql`, `.md/.mdx` → `markdown`
- `.html/.htm` → `html`, `.css` → `css`, `.scss` → `scss`
- `.graphql/.gql` → `graphql`
- `.tf/.hcl/.tfvars` → `hcl`
- `.proto` → `proto`, `.prisma` → `prisma`
- `.svelte` → `svelte`, `.vue` → `vue`
- `.sh/.bash/.zsh` → `bash`
- `.xml/.svg/.xsl` → `xml`
- **Parse-only** (no symbol queries): `.cmake` → `cmake`, `.dart` → `dart`, `.ex/.exs` → `elixir`, `.ini/.cfg` → `ini`, `.pl/.pm` → `perl`, `.r` → `r`

Special filenames: `Dockerfile*` → `dockerfile`, `Makefile` → `make`, `Gemfile/Rakefile/Vagrantfile` → `ruby`, `Cargo.lock/Pipfile` → `toml`, `.bashrc/.zshrc` → `bash`

### Symbol extraction (`tree-sitter/symbols.ts`)

```typescript
import {
    getSymbols,          // (source, langName, opts?) → Promise<SymbolInfo[] | null>
    getDefinitions,      // (source, langName, opts?) → Promise<SymbolInfo[] | null>
    findSymbol,          // (source, langName, name, opts?) → Promise<SymbolInfo[] | null>
    getFileSymbols,      // (filePath, opts?) → Promise<SymbolInfo[] | null>
    getFileSymbolSummary,// (filePath) → Promise<string | null>
    getSymbolSummary,    // (source, langName) → Promise<{defs, refs, defTotal, refTotal} | null>
    getSymbolSummaryString, // (source, langName) → Promise<string | null>
    checkSyntaxErrors,   // (source, langName) → Promise<Array<{line, column}> | null>
} from '../core/tree-sitter.js';
import type { SymbolInfo, SymbolFilterOptions } from '../core/tree-sitter.js';
```

**`SymbolInfo` interface:**
```typescript
interface SymbolInfo {
    name: string;
    kind: string;    // 'def' | 'ref'
    type: string;    // 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | etc.
    line: number;    // 1-based start line
    endLine: number; // 1-based end line
    column: number;
}
```

**`SymbolFilterOptions` interface:**
```typescript
interface SymbolFilterOptions {
    nameFilter?: string;     // case-insensitive substring match on name
    kindFilter?: string;     // 'def' or 'ref'
    typeFilter?: string;     // exact match on type
    excludeNames?: string[];
    nearLine?: number;       // sort results by proximity to this line
}
```

**Key behaviors:**
- `getSymbols()` returns null when language has no grammar OR no tags query (parse-only languages). Distinguish null (unsupported) from `[]` (no symbols found).
- Results are cached by an MD5 hash of `langName + ':' + source`. Cache is LRU with max 50 entries.
- `findSymbol()` supports dot-qualified names like `"MyClass.sendMessage"` — splits on `.` and verifies containment.
- `getFileSymbols()` reads the file itself; skips files > 256KB in `getFileSymbolSummary()`.
- `checkSyntaxErrors()` returns up to 10 ERROR nodes, null if unsupported language.

### Structural similarity (`tree-sitter/structural-similarity.ts`)

```typescript
import {
    getStructuralFingerprint,     // (source, lang, startLine, endLine) → Promise<number[] | null>
    computeStructuralSimilarity,  // (fp1: number[], fp2: number[]) → number (0..1)
} from '../core/tree-sitter.js';
```

### Compression structure (`tree-sitter/compression-structure.ts`)

```typescript
import { getCompressionStructure } from '../core/tree-sitter.js';
import type { BlockEntry } from '../core/tree-sitter.js';
// getCompressionStructure(source, langName) → Promise<BlockEntry[] | null>
// BlockEntry: { name, type, startLine, endLine, exported?, anchors? }
// Used internally by toon_bridge.ts. You almost certainly don't need this directly.
```

---

## 13. Compression — toon_bridge and zenith-toon

### compression.ts — the tool-facing API

**File: `src/core/compression.ts`**

```typescript
import {
    compressTextFile,           // main entry for read_file / read_multiple_files
    computeCompressionBudget,   // pure math helper
    truncateToBudget,           // pure truncation with line-boundary awareness
    runToonBridge,              // low-level: spawns toon_bridge_cli as subprocess
    isCompressionUseful,        // predicate: is compressed text actually smaller?
    DEFAULT_COMPRESSION_KEEP_RATIO, // = 0.70
} from '../core/compression.js';
```

**`compressTextFile(validPath, rawText, maxChars, keepRatio?)`**  
The main compression call. Returns `{ text, targetBudget, rawLength, compressedLength }` or `null` if compression is not useful (file already fits, or compressed result is not smaller).

```typescript
const compressed = await compressTextFile(validPath, rawText, maxChars);
if (compressed !== null) {
    return { content: [{ type: "text" as const, text: compressed.text }] };
}
// Fall through to normal read/truncate if null
```

**`truncateToBudget(content, budget)`**  
Cuts at the last newline before `budget` characters. Returns `{ text: string, truncated: boolean }`. Treats content that has only newlines as truncated.

```typescript
const { text, truncated } = truncateToBudget(content, maxChars);
if (truncated) {
    return { content: [{ type: "text" as const, text: text + '\n[truncated]' }] };
}
```

**`computeCompressionBudget(rawLength, maxChars, keepRatio?)`**  
Pure math: `min(maxChars, floor(rawLength * keepRatio))`. keepRatio defaults to 0.70.

### How compression works end-to-end

`compressTextFile()` → `runToonBridge()` → spawns `node dist/core/toon_bridge_cli.js <filePath> <budget>` as a subprocess → `toon_bridge_cli.ts` → `toon_bridge.ts:compressToon()` → tree-sitter language detection + `getCompressionStructure()` → `zenith-toon:compressSourceStructured()` with `StructureBlock[]` and optional `ASTEdge[]` from symbol index.

### toon_bridge.ts — the integration layer

**File: `src/core/toon_bridge.ts`**  
You do NOT import this directly in tools. Compression.ts calls it via subprocess. Understanding this is useful for knowing what the compression system can do:

- Detects language via `getLangForFile()`
- Extracts block + anchor structure via `getCompressionStructure()` (17 languages have anchor rules)
- Queries call graph edges from SQLite `edges` table via `getFileBlockEdges()` + `getFileDefinitions()`
- Maps symbol edges to block indices and passes as `ASTEdge[]` to `compressSourceStructured()`
- Falls back to `compressString()` if tree-sitter unavailable or parse fails

### zenith-toon — the compression library

Package: `zenith-toon` (workspace:* dependency, lives at `packages/zenith-toon/`)

**Key types (from `zenith-toon/src/types.ts`):**
```typescript
interface StructureBlock {
    name: string;
    kind: string;
    type: string;
    startLine: number;   // 0-based
    endLine: number;     // 0-based inclusive
    exported: boolean;
    anchors: Anchor[];
    priority?: number;
}

interface Anchor {
    startLine: number;  // 0-based
    endLine: number;    // 0-based
    kind: string;
    priority: number;
}

interface ASTEdge {
    from: number;    // source block index
    to: number;      // target block index
    weight: number;  // 1.0 for calls
    kind?: 'call' | 'reference' | 'type_ref' | 'import' | 'inherit';
}
```

**Key exports (from `zenith-toon`):**
```typescript
import { compressString, compressSourceStructured } from 'zenith-toon';
// compressString(content, budget, stackTraceMaxFrames?) → string
// compressSourceStructured(content, budget, structure: StructureBlock[], astEdges?: ASTEdge[]) → string
```

Tools generally do NOT import zenith-toon directly. They call `compressTextFile()` from `compression.ts`, which handles the subprocess dispatch. The only place zenith-toon is imported directly is `toon_bridge.ts`.

---

## 14. The Symbol Index and Database

**File: `src/core/symbol-index.ts`**

The symbol index is a **per-repository SQLite database** stored at `<repoRoot>/.mcp/symbols.db`. It is the backbone of `refactor_batch`, impact queries, and symbol version history.

### Key functions

```typescript
import {
    findRepoRoot,       // (filePath: string) → string | null — runs `git rev-parse --show-toplevel`
    getDb,              // (repoRoot: string) → DbConnection — opens/caches the .mcp/symbols.db
    getSessionId,       // (clientSessionId?: string) → string — pid:cwd or provided value
    indexFile,          // (db, repoRoot, absFilePath) → Promise<void>
    indexDirectory,     // (db, repoRoot, dirPath, opts?) → Promise<void>
    ensureIndexFresh,   // (db, repoRoot, absFilePaths) → Promise<number> — re-indexes stale files
    snapshotSymbol,     // (db, symbolName, filePath|null, originalText, sessionId, line?) → void
    getVersionHistory,  // (db, symbolName, sessionId, filePath?) → rows[]
    getVersionText,     // (db, versionId) → string | null
    restoreVersion,     // (db, symbolName, versionId, sessionId, currentText?) → string
    impactQuery,        // (db, symbolName, opts?) → ImpactDisambiguate | ImpactSuccess
} from '../core/symbol-index.js';
```

### findRepoRoot()
Runs `git rev-parse --show-toplevel` synchronously with `execFileSync`. Returns `null` if not in a git repo or git is not available. Used by `edit_file.ts` and `stash_restore.ts` to locate the symbol DB.

```typescript
const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
```

### getDb()
Opens the SQLite DB at `<repoRoot>/.mcp/symbols.db`, creating `.mcp/` and a `.mcp/.gitignore` with `*` if they don't exist. Caches connections by `repoRoot`. Registers a `process.on('exit')` handler to close all connections on shutdown. Runs `pruneOldVersions()` on open. Returns a `DbConnection` (opaque handle).

### indexDirectory()
Walks the directory, respects `getDefaultExcludes()` and `isSensitive()`, checks file hashes to skip unchanged files, indexes in batches of 50. Also purges stale rows for files that were visited before but are now excluded/deleted.

### snapshotSymbol()
Inserts into the `versions` table with deduplication (UNIQUE on `symbol_name, file_path, text_hash, session_id`):
```typescript
snapshotSymbol(db, 'myFunction', 'src/tools/myfile.ts', originalText, sessionId, lineNum);
```

### impactQuery()
Forward (callers) or reverse (callees) impact analysis. Returns a disambiguation request if the symbol has multiple definitions and no `file` scope is provided.

---

## 15. The Database Adapter — DbConnection and SQL ops

**File: `src/core/db-adapter.ts`**

Uses Node.js built-in `node:sqlite` (`DatabaseSync` / `StatementSync` — available in Node ≥ 22).

### DbConnection

An opaque class wrapping `DatabaseSync`. Pass it around between adapter functions; do not access internals directly in tool code. Get one via `getDb(repoRoot)` from `symbol-index.ts`, or via `ProjectContext.getStashDb()`.

```typescript
import type { DbConnection } from '../core/db-adapter.js';
// OR
import { DbConnection } from '../core/db-adapter.js'; // if you need it as a value
```

### Schema

**`symbols` database** (per repo, at `.mcp/symbols.db`):
```sql
files      (path TEXT PK, hash TEXT, last_indexed INTEGER)
symbols    (id, name, kind, type, file_path → files, line, end_line, column)
edges      (id, container_def_id → symbols, referenced_name)
versions   (id, symbol_name, file_path, original_text, session_id, created_at, line, text_hash)
patterns   (id, name UNIQUE, edit_body, symbol_kind, created_at)
```

**`stash` table** (added to any DB via `initStashSchema()`):
```sql
stash (id, type TEXT, file_path TEXT, payload TEXT, attempts INTEGER DEFAULT 0, created_at INTEGER)
```

**Global DB** (at `~/.zenith-mcp/global-stash.db`):
```sql
project_roots (root_path TEXT PK, name TEXT, created_at INTEGER)
-- + stash table
```

### Adapter functions (what you might use in a tool)

```typescript
import {
    // Symbol queries — used by search_files.ts, refactor_batch.ts
    findSymbolDetails,          // (db, name, kind) → {file_path, line, end_line, kind, type}[]
    findSymbolDetailsScoped,    // (db, name, kind, filePrefix) → same
    findStructuralCandidates,   // (db, opts?) → {name, file_path, line, end_line}[]

    // Impact queries — used by refactor_batch.ts
    getCallers,                 // (db, referencedName) → {name, file_path, refCount}[]
    getCallees,                 // (db, symbolName) → {name, callCount}[]
    getCallersFiltered,         // (db, referencedName, originSymbol, originFile) → same
    getCalleesFiltered,         // (db, symbolName, filePath) → same

    // Edge/definition queries — used by toon_bridge.ts
    getFileBlockEdges,          // (db, filePath, blockNames) → {edges, externalRefs, stats}
    getFileDefinitions,         // (db, filePath) → {id, name, line, endLine, type}[]

    // Stash operations — used by stash.ts (preferred; use stash.ts from tools, not this directly)
    insertStash, getStash, getStashAttempts, updateStashAttempts, deleteStash, listStash,

    // Transactions
    runTransaction,             // (conn, fn: () => void) → void — supports nested SAVEPOINTs

    // Versions
    snapshotVersion, getVersionHistory, getVersionText, getVersionMeta, pruneOldVersions,

    // Low-level (DDL / tests only)
    execRaw, queryRaw,
} from '../core/db-adapter.js';
```

`runTransaction` supports nesting via SAVEPOINTs. Inner calls that throw roll back only the savepoint; outer transaction remains active.

---

## 16. Project Context — how the server knows what project it's in

**File: `src/core/project-context.ts`**

### FsContext interface
The minimal interface needed to create a `ProjectContext`. `ToolContext` from `types.ts` is a superset of this:

```typescript
export interface FsContext {
    getAllowedDirectories(): string[];
    validatePath?: (p: string) => string | Promise<string>;
}
```

### getProjectContext(ctx)
Singleton factory — returns the same `ProjectContext` instance for a given `ctx` object (WeakMap keyed on ctx):

```typescript
import { getProjectContext } from '../core/project-context.js';

const pc = getProjectContext(ctx);   // ctx is your ToolContext
const root = pc.getRoot();           // string | null
const root2 = pc.getRoot(filePath);  // scoped to a specific file
```

### ProjectContext — public API
```typescript
class ProjectContext {
    getRoot(filePath?: string): string | null
    // Resolution ladder (via resolveProjectRoot):
    //   1. Git root (git rev-parse --show-toplevel)
    //   2. Marker-based (package.json, Cargo.toml, go.mod, etc.)
    //   3. MCP roots / allowed directories
    //   4. Registry (manually registered projects from global DB)
    // Returns null = global fallback

    getStashDb(filePath?: string): { db: DbConnection; root: string | null; isGlobal: boolean }
    // Returns the project's symbols.db connection (with stash tables ensured),
    // or the global stash DB at ~/.zenith-mcp/global-stash.db if no project found.

    get isGlobal(): boolean

    refresh(): void                               // called on roots change
    initProject(rootPath, name?): string          // manually register a project root
    listRegisteredProjects(): { root_path, name, created_at }[]
}
```

### How stash.ts uses ProjectContext
```typescript
// stash.ts internally does:
const pc = getProjectContext(ctx);
const { db, isGlobal } = pc.getStashDb(filePath);
```

This means the stash is scoped to the project that contains the file being edited. If no project is found, it uses the global DB. **You do not need to manage this yourself** — just call the `stash.ts` functions directly.

### onRootsChanged()
Called by `server.ts` when MCP roots update. You don't call this in tools.

---

## 17. Shared Utilities — budgets, ripgrep, BM25

**File: `src/core/shared.ts`**

```typescript
import {
    getCharBudget,           // () → number — global output char budget (default 400_000)
    getSearchCharBudget,     // () → number — search result char budget (default min(15_000, charBudget))
    getDefaultExcludes,      // () → string[] — default excluded dirs/patterns
    getSensitivePatterns,    // () → string[] — patterns for .env, *.pem, etc.
    isSensitive,             // (filePath: string) → boolean
    RANK_THRESHOLD,          // = 50 — use BM25 re-ranking when result count > this
    getRefactorVersionTtlMs, // () → number — version TTL in ms (from config)

    // BM25
    bm25RankResults,         // (lines, query, charBudget?) → { ranked: string[], totalCount: number }
    bm25PreFilterFiles,      // (rootPath, query, topK?, excludePatterns?) → Promise<string[]>
    BM25Index,               // class — if you need direct BM25

    // Ripgrep
    ripgrepAvailable,        // () → Promise<boolean>
    ripgrepSearch,           // (rootPath, opts) → Promise<RipgrepResult[] | null>
    ripgrepFindFiles,        // (rootPath, opts) → Promise<string[] | null>
    ripgrepCountMatches,     // (rootPath, opts) → Promise<{matchCount, fileCount} | null>
    lastRipgrepError,        // string | null — populated when ripgrepSearch returns null

    // Media
    readFileAsBase64Stream,  // (filePath: string) → Promise<unknown> — cast result to string
} from '../core/shared.js';
import type { RipgrepResult } from '../core/shared.js';
```

### Default excludes
The default list (from config or hardcoded fallback):
```
node_modules, .git, .next, .venv, venv, .env.local, dist, build, out, output,
.cache, .turbo, .nuxt, .output, .svelte-kit, .parcel-cache, __pycache__,
.pytest_cache, .mypy_cache, coverage, .nyc_output, .coverage, .DS_Store,
*.min.js, *.min.css, *.map, .tsbuildinfo
```

### isSensitive()
Tests against patterns like `**/.env`, `**/*.pem`, `**/*.key`, `**/*.crt`, `**/*credentials*`, `**/*secret*`, `**/docker-compose.yaml`, `**/docker-compose.yml`, `**/.config/**`. Checks home-relative path, basename, and path segments.

### RipgrepResult interface
```typescript
interface RipgrepResult {
    file: string;
    line: number;
    content: string;
    isContext?: boolean;  // true for context lines (when contextLines > 0)
}
```

### ripgrepSearch() options
```typescript
ripgrepSearch(rootPath, {
    contentQuery?: string,
    filePattern?: string | null,   // glob, e.g. '*.ts'
    ignoreCase?: boolean,          // default true
    maxResults?: number,           // default 50
    excludePatterns?: string[],
    contextLines?: number,         // default 0
    literalSearch?: boolean,       // default false, -F flag
    includeHidden?: boolean,       // default false
    fileList?: string[] | null,    // search only these files instead of rootPath
    includeContextLines?: boolean, // default false, whether to include context in results
    skipSensitiveFilter?: boolean, // default false
    maxMatchesPerFile?: number | null, // default 500
})
```

### ripgrepFindFiles() options
```typescript
ripgrepFindFiles(rootPath, {
    namePattern?: string | null,    // glob against filename
    pathContains?: string | null,   // substring in full path
    maxResults?: number,            // default 100
    excludePatterns?: string[],
})
```

### Budget-gated output pattern
```typescript
const budget = getCharBudget();
const lines: string[] = [];
let charCount = 0;
for (const line of allLines) {
    if (charCount + line.length + 1 > budget) break;
    lines.push(line);
    charCount += line.length + 1;
}
return { content: [{ type: "text" as const, text: lines.join('\n') }] };
```

### BM25 re-ranking pattern (used in search_files.ts)
```typescript
const rawLines = results.map(r => `${r.file}:${r.line}: ${r.content}`);
let outputLines: string[];
if (rawLines.length > RANK_THRESHOLD) {
    const { ranked } = bm25RankResults(rawLines, args.contentQuery, getSearchCharBudget());
    outputLines = ranked;
} else {
    outputLines = [];
    let charCount = 0;
    for (const line of rawLines) {
        if (charCount + line.length + 1 > getSearchCharBudget()) break;
        outputLines.push(line);
        charCount += line.length + 1;
    }
}
```

---

## 18. lib.ts Utilities — file I/O, diff, helpers

**File: `src/core/lib.ts`**

```typescript
import {
    // Line ending normalization
    normalizeLineEndings,   // (text: string) → string — \r\n → \n

    // Diff generation
    createUnifiedDiff,      // (original, modified, filepath?) → string (full unified diff)
    createMinimalDiff,      // (original, modified, filepath?) → string (context: 0)

    // File I/O helpers (use only when ctx.validatePath has already been called)
    readFileContent,        // (filePath, encoding?) → Promise<string>
    writeFileContent,       // (filePath, content) → Promise<void> — atomic write
    getFileStats,           // (filePath) → Promise<{ size, created, modified, accessed, isDirectory, isFile, permissions }>

    // Line-based reads (for large files — stream-based, memory-efficient)
    tailFile,               // (filePath, numLines) → Promise<string>
    headFile,               // (filePath, numLines) → Promise<string>
    offsetReadFile,         // (filePath, offset, length) → Promise<{ content, linesReturned, hasMore }>

    // Edit helpers
    applyFileEdits,         // (filePath, [{oldText, newText}], dryRun?) → Promise<string> (unified diff)
    countOccurrences,       // (text, search) → number

    // Append resume detection
    findResumeOffset,       // (existingTailLines, incomingLines) → number

    // Size formatting
    formatSize,             // (bytes: number) → string e.g. "1.23 MB"

    // File search (minimal — prefer ripgrep)
    searchFilesWithValidation, // (rootPath, pattern, allowedDirectories, opts?) → Promise<string[]>

    // FilesystemContext factory (used internally by server; don't instantiate in tools)
    createFilesystemContext,
} from '../core/lib.js';
import type { FilesystemContext } from '../core/lib.js';
```

### findResumeOffset()
Used by `write_file.ts` append mode. When appending, reads the last 500 lines of the existing file and checks if the incoming content begins with any overlapping tail — if so, skips those lines to avoid duplication:
```typescript
const tailLines = existingLines.slice(-500);
const overlap = findResumeOffset(tailLines, incomingLines);
const appendContent = overlap > 0 ? incomingLines.slice(overlap).join('\n') : normalizedContent;
```

### applyFileEdits()
The older content-replacement engine (pre-edit-engine.ts). Takes `[{oldText, newText}]` pairs, uses exact match → trim-trailing-whitespace → indent-stripped fallback. Returns unified diff. Used when you need a simpler single-pass edit without the full `Edit` interface.

---

## 19. The Stash System

**File: `src/core/stash.ts`**

The stash temporarily stores failed edits and writes so users can retry them. The stash DB is chosen by `ProjectContext.getStashDb()` — it is either the project's `.mcp/symbols.db` or the global `~/.zenith-mcp/global-stash.db`.

### API

```typescript
import {
    stashEdits,       // (ctx, filePath, edits: Edit[], failedIndices: number[]) → number (stash ID)
    stashWrite,       // (ctx, filePath, content: string, mode: string) → number (stash ID)
    getStashEntry,    // (ctx, id: number, filePath?: string) → StashEntry | null
    consumeAttempt,   // (ctx, id: number, filePath: string) → boolean (false = max retries exceeded)
    clearStash,       // (ctx, id: number, filePath?: string) → void
    listStash,        // (ctx, filePath?: string) → { entries: StashRow[], isGlobal: boolean }
} from '../core/stash.js';
```

### ctx parameter
All stash functions take `ctx` which is typed as `FsContext` from `project-context.ts`. Since `ToolContext` from `types.ts` satisfies `FsContext` (it has `getAllowedDirectories()`), you can pass `ctx` directly.

### StashEntry shape (returned by getStashEntry)
```typescript
{
    id: number,
    type: 'edit' | 'write',
    filePath: string | null,
    payload: {
        // for type === 'edit':
        edits: Edit[];
        failedIndices: number[];
        // for type === 'write':
        content: string;
        mode: string;   // 'write' | 'append' | 'overwrite'
    },
    attempts: number,
    createdAt: number,
}
```

### Max retry attempts
The constant `MAX_ATTEMPTS = 2` is defined in `stash.ts`. `consumeAttempt()` increments the counter and deletes the stash entry when exceeded, returning `false`.

### When to stash
- In `write_file.ts`: when the atomic write fails, stash the content and throw `Write failed. Cached as stash:${stashId}.`
- In `edit_file.ts`: when `applyEditList()` returns errors, stash the edits and failed indices and throw `${n} failed. stash:${stashId}\n${msg}`

---

## 20. Registering a New Tool in server.ts

**File: `src/core/server.ts`**

You must make two edits to this file when adding a new tool.

### Step A — Add the import

At the top of `server.ts`, alongside all other register imports:
```typescript
import { register as registerYourTool } from '../tools/your_tool.js';
```

### Step B — Add the TOOL_REGISTRY entry

```typescript
const TOOL_REGISTRY: Array<{
  name: string;
  register: (server: ToolServer, ctx: ToolContext) => void;
}> = [
  { name: "read_file",           register: registerReadFile },
  { name: "search_file",         register: registerSearchFile },
  { name: "read_media_file",     register: registerReadMediaFile },
  { name: "read_multiple_files", register: registerReadMultipleFiles },
  { name: "write_file",          register: registerWriteFile },
  { name: "edit_file",           register: registerEditFile },
  { name: "directory",           register: registerDirectory },
  { name: "search_files",        register: registerSearchFiles },
  { name: "file_manager",        register: registerFilesystem },
  { name: "stashRestore",        register: registerStashRestore },
  { name: "refactor_batch",      register: registerRefactorBatch },
  { name: "your_tool_name",      register: registerYourTool },  // ← add here
];
```

The `name` string here must **exactly** match the first argument to `server.registerTool(...)` inside your tool file. This name also ends up in the config file that users can use to enable/disable tools.

### What registerEnabledTools() does (for context)
Loads config, syncs the tool list, writes config if new tools are discovered, optionally sets up the auto-write adapter, then calls `entry.register(toolServer, ctx)` for each enabled tool. You do not call this yourself.

---

## 21. Complete Import Reference by Module

Use this as a lookup table. Import paths are relative from `src/tools/`.

```typescript
// ── Core types ──────────────────────────────────────────────────────────────
import type { ToolServer, ToolContext, ToolResult, ToolContent } from './types.js';
import { errorMessage } from './types.js';

// ── Node stdlib ──────────────────────────────────────────────────────────────
import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

// ── Zod ──────────────────────────────────────────────────────────────────────
import { z } from 'zod';

// ── Budgets, ripgrep, BM25, excludes ─────────────────────────────────────────
import {
    getCharBudget, getSearchCharBudget, RANK_THRESHOLD,
    getDefaultExcludes, getSensitivePatterns, isSensitive,
    bm25RankResults, bm25PreFilterFiles, BM25Index,
    ripgrepAvailable, ripgrepSearch, ripgrepFindFiles, ripgrepCountMatches,
    lastRipgrepError, readFileAsBase64Stream,
} from '../core/shared.js';
import type { RipgrepResult } from '../core/shared.js';

// ── File I/O, diff, line helpers ─────────────────────────────────────────────
import {
    normalizeLineEndings, createUnifiedDiff, createMinimalDiff,
    applyFileEdits, findResumeOffset, countOccurrences,
    readFileContent, writeFileContent, getFileStats, formatSize,
    tailFile, headFile, offsetReadFile, searchFilesWithValidation,
} from '../core/lib.js';
import type { FilesystemContext } from '../core/lib.js';

// ── Compression ───────────────────────────────────────────────────────────────
import {
    compressTextFile, computeCompressionBudget, truncateToBudget,
    runToonBridge, isCompressionUseful, DEFAULT_COMPRESSION_KEEP_RATIO,
} from '../core/compression.js';

// ── Edit engine ───────────────────────────────────────────────────────────────
import { applyEditList, syntaxWarn } from '../core/edit-engine.js';
import type { Edit } from '../core/edit-engine.js';

// ── Tree-sitter (all via barrel) ──────────────────────────────────────────────
import {
    getLangForFile, isSupported, getSupportedExtensions,
    treeSitterAvailable, loadLanguage, getCompiledQuery,
    getSymbols, getDefinitions, findSymbol,
    getFileSymbols, getFileSymbolSummary,
    getSymbolSummary, getSymbolSummaryString,
    checkSyntaxErrors,
    getCompressionStructure,
    getStructuralFingerprint, computeStructuralSimilarity,
} from '../core/tree-sitter.js';
import type { SymbolInfo, SymbolFilterOptions, BlockEntry, SymbolStructure } from '../core/tree-sitter.js';

// ── Symbol index (SQLite, per-repo) ──────────────────────────────────────────
import {
    findRepoRoot, getDb, getSessionId,
    indexFile, indexDirectory, ensureIndexFresh,
    snapshotSymbol, getVersionHistory, getVersionText, restoreVersion,
    impactQuery,
} from '../core/symbol-index.js';

// ── Database adapter (low-level, usually via symbol-index or stash) ───────────
import {
    DbConnection,
    findSymbolDetails, findSymbolDetailsScoped, findStructuralCandidates,
    getCallers, getCallees, getCallersFiltered, getCalleesFiltered,
    getFileBlockEdges, getFileDefinitions,
    runTransaction,
} from '../core/db-adapter.js';

// ── Stash ─────────────────────────────────────────────────────────────────────
import {
    stashEdits, stashWrite,
    getStashEntry, consumeAttempt, clearStash, listStash,
} from '../core/stash.js';

// ── Project context ───────────────────────────────────────────────────────────
import { getProjectContext } from '../core/project-context.js';
import type { FsContext } from '../core/project-context.js';

// ── Project scope (root resolution) ──────────────────────────────────────────
import { resolveProjectRoot, clearProjectScopeCache, isWithinProject } from '../utils/project-scope.js';

// ── Path utils ────────────────────────────────────────────────────────────────
import { normalizePath, expandHome } from '../core/path-utils.js';

// ── minimatch (for glob matching) ────────────────────────────────────────────
import { minimatch } from 'minimatch';

// ── zenith-toon (only if directly doing structured compression — rare) ─────────
import { compressString, compressSourceStructured } from 'zenith-toon';
import type { StructureBlock, ASTEdge } from 'zenith-toon';
```

---

## 22. Patterns From Existing Tools

### Mode-dispatch pattern (filesystem.ts, search_files.ts)
```typescript
if (args.mode === "mkdir") {
    if (!args.path) throw new Error('path required for mkdir.');
    const validPath = await ctx.validatePath(args.path);
    await fs.mkdir(validPath, { recursive: true });
    return { content: [{ type: "text" as const, text: "Created." }] };
}
if (args.mode === "delete") {
    // ...
}
// fall-through
throw new Error("Unknown mode.");
```

### Compression-then-fallback (read_file.ts, read_multiple_files.ts)
```typescript
if (args.compression) {
    const rawText = await readFileContent(validPath);
    const compressed = await compressTextFile(validPath, rawText, maxChars);
    if (compressed !== null) {
        return { content: [{ type: "text" as const, text: compressed.text }] };
    }
    // Fall through to normal truncation path
}
```

### Safe array index access (noUncheckedIndexedAccess)
```typescript
// Narrow with explicit check:
const first = arr[0];
if (first === undefined) throw new Error('arr[0] missing after non-empty check');
// now `first` is T

// Non-null assertion — only use when the length check immediately precedes:
if (arr.length > 0) {
    const first = arr[0]!;  // safe
}

// In existing code you'll see the nosemgrep comment on intentional assertions:
const val = lines[i]!.trim(); // nosemgrep
```

### Truncation marker
```typescript
const text = truncated
    ? `${body}\n[truncated]`
    : body;
```
Or inline after `truncateToBudget()`:
```typescript
const { text, truncated } = truncateToBudget(content, maxChars);
return {
    content: [{ type: "text" as const, text: truncated ? text + '\n[truncated]' : text }],
};
```

### Void unused error variables
```typescript
try { await fs.unlink(tempPath); } catch (err) { void err; }
// or just:
try { await fs.unlink(tempPath); } catch { /* intentional cleanup */ }
```

### Parallel file processing with concurrency limit (read_multiple_files.ts)
```typescript
async function parallelMap<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, concurrency = 8): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            const item = items[i];
            if (item === undefined) throw new Error(`parallelMap: items[${i}] undefined`);
            results[i] = await fn(item, i);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}
```

### Ripgrep + BM25 pre-filter (search_files.ts content mode)
```typescript
const hasRg = await ripgrepAvailable();
let rgResults: RipgrepResult[] | null = null;
if (args.contentQuery.length > 2) {
    try {
        let candidateFiles = await bm25PreFilterFiles(rootPath, args.contentQuery, 100, allExcludes);
        if (candidateFiles.length > 0) {
            rgResults = await ripgrepSearch(rootPath, {
                contentQuery: args.contentQuery,
                fileList: candidateFiles,
                // ...
            });
        }
    } catch { /* fall through to full search */ }
}
if (rgResults === null) {
    rgResults = await ripgrepSearch(rootPath, { contentQuery: args.contentQuery, /* ... */ });
}
```

### Walking directory with fallback from ripgrep (search_files.ts symbol mode)
```typescript
const hasRg = await ripgrepAvailable();
let filePaths: string[] = [];
if (hasRg) {
    const results = await ripgrepFindFiles(rootPath, { maxResults: 2000, excludePatterns: defaultExcludeGlobs });
    if (results) filePaths = results;
}
if (filePaths.length === 0) {
    async function walk(dir: string) {
        if (filePaths.length >= 2000) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (getDefaultExcludes().some(p => entry.name === p)) continue;
            if (isSensitive(fullPath)) continue;
            if (entry.isDirectory()) await walk(fullPath);
            else filePaths.push(fullPath);
        }
    }
    await walk(rootPath);
}
const supportedFiles = filePaths.filter(f => isSupported(f));
```

---

## 23. What NOT to Do

| Don't | Why |
|---|---|
| `import ... from '../core/lib'` | Missing `.js` breaks NodeNext resolution at runtime |
| Use `args.path` directly with `fs.*` | Must validate via `ctx.validatePath()` first |
| `{ type: "text", text: ... }` without `as const` | TypeScript: string not assignable to literal `"text"` |
| Declare variables or parameters you don't use | `noUnusedLocals` / `noUnusedParameters` |
| `arr[i]` without narrowing `undefined` | `noUncheckedIndexedAccess` makes it `T \| undefined` |
| `prop: undefined` on an optional property | `exactOptionalPropertyTypes` rejects this |
| Forget to edit `TOOL_REGISTRY` in `server.ts` | Tool silently never gets called |
| Have the `name` in TOOL_REGISTRY differ from `registerTool("name", ...)` | Tool name mismatch, config breaks |
| `import type { ToolServer }` and then use it as a value | type-only imports can't be used as values |
| `require()` or `module.exports` | ES module package — CJS is rejected |
| Import from `src/retrieval/**` | Excluded from tsconfig, won't compile |
| Import `zenith-toon` directly for file compression | Use `compressTextFile()` from `compression.ts` instead |
| Call `getProjectContext()` in tight loops | It's a singleton factory but `getRoot()` runs git subprocess |
| Use `applyFileEdits()` from lib.ts when you need mode-aware edits | Use `applyEditList()` from `edit-engine.ts` instead |
| Forget `normalizeLineEndings()` before editing content | CRLF line endings cause off-by-one in all line-based logic |
| Access `DbConnection._db` directly | Private fields; use adapter functions |

---

## 24. Minimal Tool Template

```typescript
import { z } from "zod";
import fs from "fs/promises";
// import path from "path";
// import { randomBytes } from 'crypto';
import type { ToolServer, ToolContext } from './types.js';
// Import only what you actually use:
// import { getCharBudget } from '../core/shared.js';
// import { normalizeLineEndings } from '../core/lib.js';

type MyToolArgs = {
    path: string;
    // mode?: "a" | "b";
    // dryRun?: boolean;
};

export function register(server: ToolServer, ctx: ToolContext): void {
    server.registerTool<MyToolArgs>("my_tool_name", {
        title: "My Tool",
        description: "One sentence describing what this tool does.",
        inputSchema: z.object({
            path: z.string().describe("File path."),
            // mode: z.enum(["a", "b"]).describe("Operation mode."),
            // dryRun: z.boolean().optional().default(false).describe("Preview without writing."),
        }),
        annotations: { readOnlyHint: true }
        // Writing tools: annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args: MyToolArgs) => {
        const validPath = await ctx.validatePath(args.path);
        // For new files: const validPath = await ctx.validateNewFilePath(args.path);

        // ... implementation ...
        const content = await fs.readFile(validPath, 'utf-8');

        return {
            content: [{ type: "text" as const, text: content }],
        };
    });
}
```

---

## 25. Full Reference: write_file.ts

The complete, unmodified source:

```typescript
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { randomBytes } from 'crypto';
import { normalizeLineEndings, findResumeOffset } from '../core/lib.js';
import { stashWrite } from '../core/stash.js';
import type { ToolContext, ToolServer } from './types.js';
import { errorMessage } from './types.js';

type WriteFileArgs = {
    path: string;
    content: string;
    failIfExists?: boolean;
    append?: boolean;
};

export function register(server: ToolServer, ctx: ToolContext): void {
    server.registerTool("write_file", {
        title: "Write File",
        description: "Create or overwrite a file. Auto-creates parent directories. Use 'append' to add instead of replace.",
        inputSchema: z.object({
            path: z.string().describe("File to write."),
            content: z.string().describe("Content to write."),
            failIfExists: z.boolean().optional().default(false).describe("Fail if the file already exists."),
            append: z.boolean().optional().default(false).describe("Append instead of overwriting."),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args: WriteFileArgs) => {
        const validPath = await ctx.validateNewFilePath(args.path);
        const normalizedContent = normalizeLineEndings(args.content);
        let existed = false;
        try {
            await fs.stat(validPath);
            existed = true;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code !== 'ENOENT') {
                throw new Error(`Cannot access file: ${code ?? 'unknown error'}`);
            }
        }
        if (args.failIfExists && existed) {
            throw new Error(`File already exists.`);
        }
        const parentDir = path.dirname(validPath);
        try {
            await fs.mkdir(parentDir, { recursive: true });
        } catch (err) {
            const nodeError = err as NodeJS.ErrnoException;
            if (nodeError.code !== 'EEXIST') {
                throw new Error(`Cannot create parent directory: ${errorMessage(err)}`);
            }
        }
        let finalContent = normalizedContent;
        if (args.append && existed) {
            try {
                const existing = await fs.readFile(validPath, 'utf-8');
                const existingLines = existing.split('\n');
                const incomingLines = normalizedContent.split('\n');
                const tailLines = existingLines.slice(-500);
                const overlap = findResumeOffset(tailLines, incomingLines);
                let appendContent;
                if (overlap > 0) {
                    appendContent = incomingLines.slice(overlap).join('\n');
                } else {
                    appendContent = normalizedContent;
                }
                const separator = existing.endsWith('\n') ? '' : '\n';
                finalContent = existing + separator + appendContent;
            } catch (err) {
                throw new Error(`Cannot read existing file for append: ${errorMessage(err)}`);
            }
        }
        const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
        try {
            await fs.writeFile(tempPath, finalContent, 'utf-8');
            const tempStat = await fs.stat(tempPath);
            const expectedBytes = Buffer.byteLength(finalContent, 'utf-8');
            if (tempStat.size !== expectedBytes) {
                throw new Error('Write verification failed.');
            }
            await fs.rename(tempPath, validPath);
        } catch (error) {
            try { await fs.unlink(tempPath); } catch (err) { void err; }
            const stashId = stashWrite(ctx, validPath, normalizedContent, args.append ? 'append' : 'write');
            throw new Error(`Write failed. Cached as stash:${stashId}.`);
        }
        let message;
        if (args.append) {
            message = 'Content appended.';
        } else if (existed) {
            message = 'File updated.';
        } else {
            message = 'File written.';
        }
        return {
            content: [{ type: "text", text: message }],
        };
    });
}
```

---

## 26. Pre-Handoff Checklist

- [ ] File is at `packages/zenith-mcp/src/tools/<tool_name>.ts`
- [ ] Exports exactly `export function register(server: ToolServer, ctx: ToolContext): void`
- [ ] All imports end in `.js`
- [ ] Only used imports are present (no unused locals)
- [ ] All parameters are used or prefixed with `_`
- [ ] All array index accesses are narrowed (`=== undefined` check, or `!` with a comment/length guard)
- [ ] All optional args use `?.` or narrowing — never `prop: undefined` assignment
- [ ] `type: "text" as const` (not just `type: "text"`) in all content items
- [ ] All `fs.*` calls use the result of `ctx.validatePath()` or `ctx.validateNewFilePath()`, never `args.path`
- [ ] Write operations use the temp-file + rename atomic pattern
- [ ] Errors are thrown, not returned
- [ ] `src/core/server.ts` has been updated: import added AND entry added to `TOOL_REGISTRY`
- [ ] The name in `TOOL_REGISTRY` exactly matches the name in `server.registerTool("name", ...)`
- [ ] `pnpm run build` in `packages/zenith-mcp/` succeeds with zero TypeScript errors
