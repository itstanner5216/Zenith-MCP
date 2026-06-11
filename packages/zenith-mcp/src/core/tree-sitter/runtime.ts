// ---------------------------------------------------------------------------
// tree-sitter/runtime.ts — WASM runtime initialization & caching
//
// Contains:
//   - Path constants (GRAMMARS_DIR, QUERIES_DIR, TS_WASM_PATH)
//   - ensureInit()         — lazy Parser.init()
//   - loadLanguage()       — grammar WASM loader with PIC side-module guard
//   - getCompiledQuery()   — compiled Query cache
//   - treeSitterAvailable() — health check
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
            process.stderr.write(`[tree-sitter] Failed to inspect ${langName} grammar; skipping: ${message}\n`);
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
            process.stderr.write(`Failed to load grammar for ${langName}: ${message}\n`);
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
        process.stderr.write(`Failed to compile query for ${langName}: ${message}\n`);
        _compiledQueryCache.set(langName, null);
        return null;
    }
}

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
