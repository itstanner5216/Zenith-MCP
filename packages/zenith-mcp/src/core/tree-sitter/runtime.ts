// ---------------------------------------------------------------------------
// tree-sitter/runtime.ts — WASM runtime initialization & caching
//
// Contains:
//   - Path constants (GRAMMARS_DIR, QUERIES_DIR, TS_WASM_PATH)
//   - ensureInit()         — lazy Parser.init()
//   - loadLanguage()       — grammar WASM loader with PIC side-module guard
//   - getCompiledQuery()   — compiled Query cache
//   - treeSitterAvailable() — health check
//   - DEF_TYPES            — ReadonlySet of definition node types
//   - Symbol cache shared state (_symbolCache, SYMBOL_CACHE_MAX, SymbolCacheEntry)
//
// No imports from sibling submodules — this is a leaf module.
// ---------------------------------------------------------------------------

import { Parser, Language, Query } from 'web-tree-sitter';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(_filename);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const GRAMMARS_DIR = path.join(_dirname, '..', '..', 'grammars', 'grammars');
export const QUERIES_DIR  = path.join(_dirname, '..', '..', 'grammars', 'queries');
export const TS_WASM_PATH = path.join(_dirname, '..', '..', 'grammars', 'tree-sitter.wasm');

// ---------------------------------------------------------------------------
// Initialization & caching
// ---------------------------------------------------------------------------

let _initPromise: Promise<void> | null = null;
const _languageCache: Map<string, Promise<Language | null>> = new Map();
const _queryStringCache: Map<string, string | null> = new Map();
const _compiledQueryCache: Map<string, Query | null> = new Map();

// ---------------------------------------------------------------------------
// DEF_TYPES — node types treated as "the definition node" in getSymbolStructure
// ---------------------------------------------------------------------------

/**
 * AST node type names that getSymbolStructure treats as "the definition node"
 * when locating a symbol by line range. Hoisted to module scope so the Set is
 * allocated once at load time instead of on every getSymbolStructure call
 * (hot path during symbol-aware edits and batch operations).
 *
 * Each node type appears EXACTLY ONCE. The comment for each entry lists every
 * language that produces that node type — so the registry is the single
 * source of truth without misleading duplicate entries. The line-range guard
 * inside getSymbolStructure (`node.startPosition.row === startRow &&
 * node.endPosition.row === endRow`) prevents false positives if a type
 * happens to match a non-definition role in some grammar.
 */
export const DEF_TYPES: ReadonlySet<string> = new Set([
    // JS / TS
    'function_declaration', 'function_definition', 'method_definition',
    'arrow_function', 'function', 'method',
    'class_declaration', 'class_definition',
    'function_signature', 'method_signature',
    'lexical_declaration', 'variable_declaration',
    // Go
    'short_var_declaration', 'type_spec',
    // Rust
    'function_item', 'struct_item', 'enum_item', 'trait_item',
    'impl_item', 'const_item', 'static_item', 'mod_item', 'type_item',
    // Java + C# + Kotlin + PHP
    'method_declaration',
    // Java + C# + Kotlin + PHP
    'interface_declaration',
    // Java + C#
    'enum_declaration',
    // Java
    'annotation_type_declaration',
    // C / C++
    'struct_specifier', 'union_specifier', 'enum_specifier',
    'template_declaration',
    // C / C++ + PHP
    'namespace_definition',
    // C# + Kotlin
    'property_declaration',
    // C#
    'constructor_declaration', 'event_declaration', 'namespace_declaration',
    // Kotlin
    'object_declaration', 'type_alias',
    // PHP
    'trait_declaration',
    // Ruby
    'singleton_method', 'class', 'module',
    // Swift
    'struct_declaration', 'protocol_declaration', 'extension_declaration',
    'typealias_declaration',
    // Lua (grammar variants — both names appear across forks)
    'local_function_declaration', 'function_statement',
    // GraphQL
    'object_type_definition', 'input_object_type_definition',
    'interface_type_definition', 'union_type_definition',
    'enum_type_definition', 'directive_definition',
    // HCL (resource/data/variable/output blocks)
    'block',
    // Prisma
    'model_declaration', 'type_declaration',
    'datasource_declaration', 'generator_declaration',
    // Protocol Buffers
    'message', 'enum', 'service', 'rpc',
    // Dockerfile
    'arg_instruction', 'env_instruction', 'from_instruction',
]);

// ---------------------------------------------------------------------------
// Symbol cache — shared state exported so symbols.ts can use it
// ---------------------------------------------------------------------------

export const SYMBOL_CACHE_MAX = 100;

export interface SymbolCacheEntry {
    symbols: {
        name: string;
        kind: string;
        type: string;
        line: number;
        endLine: number;
        column: number;
    }[];
    ts: number;
}

export const _symbolCache: Map<string, SymbolCacheEntry> = new Map();

// ---------------------------------------------------------------------------
// WASM PIC side-module pre-screen
// ---------------------------------------------------------------------------
//
// Background: web-tree-sitter@0.26.8 uses a module-global GOT (Global Offset
// Table) dict to resolve dynamic symbol imports. When a WASM module that was
// compiled as an Emscripten PIC side-module (position-independent code) is
// loaded, its GOT.func imports are registered into that global dict with
// `required=true` and `value=0`. After the load fails (because the scanner
// symbols cannot be resolved), those poisoned GOT entries persist for the
// lifetime of the Node.js process — causing every subsequent Language.load()
// call to fail with the same unresolved-symbol error, regardless of which
// grammar is being loaded.
//
// The incompatible WASM pattern: modules with GOT.func imports whose field
// names contain "external_scanner". In the WASM binary, both strings appear
// as UTF-8 in the imports section. A fast byte-scan detects this reliably.
//
// Safety of this heuristic: across all 43 grammar WASMs in this build, only
// tree-sitter-vue.wasm contains the "GOT.func" byte sequence. All other WASMs
// that have external scanners compiled them in statically (no GOT imports).
// False positives are not possible with the current grammar set.
//
// Fix: if a WASM is detected as a PIC side-module before Language.load() is
// called, we skip the load entirely. The GOT is never touched, so all
// subsequent grammar loads in the same process remain healthy.

/**
 * Returns true if the WASM at `wasmPath` is an Emscripten PIC side-module
 * that imports scanner functions via GOT.func — a pattern incompatible with
 * web-tree-sitter's dynamic-library loader.
 *
 * Detection strategy: scan the raw WASM bytes for the ASCII strings "GOT.func"
 * and "external_scanner". In the WASM binary format, import module and field
 * names are stored as length-prefixed UTF-8 strings in the imports section
 * (section ID 2). Both substrings are present in the imports section of any
 * PIC side-module that stubs its external scanner via GOT.func imports, and
 * neither appears together in any correctly-built standalone grammar WASM.
 *
 * This is cheaper and safer than a full WASM section parser because:
 *   - vue.wasm is 17 KB — reading it is trivial.
 *   - The two byte sequences cannot appear together in a well-formed
 *     standalone grammar (confirmed by inspecting all 43 WASMs in the build).
 *   - No WASM spec version dependency; byte scanning is version-agnostic.
 */
async function isIncompatiblePicSideModule(wasmPath: string): Promise<boolean> {
    let bytes: Buffer;
    try {
        bytes = await fs.readFile(wasmPath);
    } catch (err) {
        // Propagate read failure with context. The caller wraps this in
        // try/catch and treats inspect failure as "skip the grammar" rather
        // than silently falling through to Language.load() with an
        // un-screened WASM (which could poison the GOT if the unreadable
        // file is in fact a PIC side-module).
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to inspect grammar WASM ${wasmPath}: ${message}`);
    }

    // WASM magic: \0asm followed by version 1 (little-endian uint32 = 01 00 00 00).
    // Bail immediately for files that are not valid WASM binaries.
    if (bytes.length < 8 ||
        bytes[0] !== 0x00 || bytes[1] !== 0x61 ||
        bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        return false;
    }

    // Detect Emscripten PIC side-modules by the co-occurrence of two ASCII
    // byte sequences that appear together only in this incompatible build
    // shape:
    //   - "GOT.func": the import module name used for GOT-relocation stubs.
    //     No correctly-linked standalone grammar WASM uses this.
    //   - "external_scanner": tree-sitter scanner symbol prefix; required to
    //     disambiguate a hypothetical future GOT.func usage from one that
    //     specifically stubs out tree-sitter external-scanner functions.
    // Buffer.includes() is implemented in native C++ and accepts strings
    // directly — no manual byte-scan needed.
    return bytes.includes('GOT.func') && bytes.includes('external_scanner');
}

/**
 * Initialize the tree-sitter WASM runtime. Idempotent.
 */
export async function ensureInit(): Promise<void> {
    if (!_initPromise) {
        _initPromise = Parser.init({
            locateFile: () => TS_WASM_PATH,
        });
    }
    return _initPromise;
}

/**
 * Load a Language grammar (WASM), cached permanently.
 * Returns null if the grammar file doesn't exist.
 *
 * The cache stores the in-flight Promise so that concurrent callers for the
 * same language share a single Language.load() call rather than racing to
 * each start their own load.
 */
export async function loadLanguage(langName: string): Promise<Language | null> {
    const cached = _languageCache.get(langName);
    if (cached) return cached;

    const promise = (async (): Promise<Language | null> => {
        await ensureInit();

        const wasmPath = path.join(GRAMMARS_DIR, `tree-sitter-${langName}.wasm`);
        // R_OK (not the default F_OK) so a file that exists but is unreadable —
        // permission flip, mid-write, NFS hiccup — is caught here rather than
        // surfacing later as a silent fallthrough to Language.load().
        try {
            await fs.access(wasmPath, fsConstants.R_OK);
        } catch {
            return null;
        }

        // Pre-screen: detect Emscripten PIC side-modules before calling Language.load().
        //
        // web-tree-sitter@0.26.8 uses a process-global GOT dict. If Language.load() is
        // called with a PIC side-module WASM (one that imports scanner functions via
        // GOT.func), the loader populates that dict with `required=true, value=0`
        // entries for each scanner symbol. The load then fails (the symbols cannot be
        // resolved), but the GOT entries persist — poisoning every subsequent
        // Language.load() call in the same process, regardless of which grammar is
        // loaded next.
        //
        // By detecting and skipping the incompatible WASM here, we never call
        // Language.load() on it, so the GOT is never touched and all subsequent
        // grammar loads remain healthy. The return value (null) is identical to what
        // the caller would have received after the load failure anyway.
        //
        // If the inspect itself fails (read error after access() passed —
        // unusual, but possible with concurrent writes or transient FS issues),
        // we treat the grammar as unusable and return null. We do NOT fall through
        // to Language.load() with an un-screened WASM, because if the unreadable
        // file IS a PIC side-module the GOT poisoning we're trying to prevent
        // would still happen.
        let isIncompatible: boolean;
        try {
            isIncompatible = await isIncompatiblePicSideModule(wasmPath);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[tree-sitter] Failed to inspect ${langName} grammar; skipping:`, message);
            return null;
        }
        if (isIncompatible) {
            console.error(
                `[tree-sitter] Skipping ${langName} grammar: WASM is an Emscripten PIC ` +
                `side-module with unresolvable GOT.func imports for external_scanner_* ` +
                `symbols. Loading it would poison the web-tree-sitter GOT and break all ` +
                `subsequent grammar loads in this process. The ${langName} grammar will ` +
                `be unavailable for this session.`
            );
            return null;
        }

        try {
            return await Language.load(wasmPath);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Failed to load grammar for ${langName}:`, message);
            return null;
        }
    })();

    _languageCache.set(langName, promise);
    return promise;
}

/**
 * Load the .scm query string for a language. Cached permanently.
 */
async function loadQueryString(langName: string): Promise<string | null> {
    if (_queryStringCache.has(langName)) {
        return _queryStringCache.get(langName) ?? null;
    }

    const scmPath = path.join(QUERIES_DIR, `${langName}-tags.scm`);
    try {
        const content = await fs.readFile(scmPath, 'utf-8');
        _queryStringCache.set(langName, content);
        return content;
    } catch {
        _queryStringCache.set(langName, null);
        return null;
    }
}

/**
 * Get a compiled Query object for a language. Cached permanently.
 * Returns null if language or query unavailable.
 */
export async function getCompiledQuery(langName: string): Promise<Query | null> {
    if (_compiledQueryCache.has(langName)) {
        return _compiledQueryCache.get(langName) ?? null;
    }

    const language = await loadLanguage(langName);
    if (!language) {
        _compiledQueryCache.set(langName, null);
        return null;
    }

    const queryString = await loadQueryString(langName);
    if (!queryString) {
        _compiledQueryCache.set(langName, null);
        return null;
    }

    try {
        const query = new Query(language, queryString);
        _compiledQueryCache.set(langName, query);
        return query;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to compile query for ${langName}:`, message);
        _compiledQueryCache.set(langName, null);
        return null;
    }
}

/**
 * Check if tree-sitter is available (runtime can init, grammars exist).
 */
export async function treeSitterAvailable(): Promise<boolean> {
    try {
        await ensureInit();
        const files = await fs.readdir(GRAMMARS_DIR);
        return files.some(f => f.endsWith('.wasm'));
    } catch {
        return false;
    }
}
