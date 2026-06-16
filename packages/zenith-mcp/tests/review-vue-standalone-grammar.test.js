import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompiledModularQuery } from '../dist/core/tree-sitter/runtime.js';

// Regression guard for:
//   1. The standalone Vue grammar fix (tree-sitter-vue.wasm replaced with
//      a non-PIC-side-module build that no longer poisons the GOT).
//   2. .grammar-pins.json schema correctness for the new vue and sql entries.
//   3. Query-drift fixes for cpp, dockerfile, graphql, hcl, java, and kotlin
//      .scm files updated in the same PR.
//
// Background: the old tree-sitter-vue.wasm was an Emscripten PIC side-module
// that imported external_scanner_* functions via GOT.func. Loading it via
// Language.load() would poison web-tree-sitter's process-global GOT with
// required=true / value=0 entries, which broke every subsequent grammar load
// in the same Node process. runtime.ts pre-screened and SKIPPED it, so vue
// was unavailable. The replacement WASM is a standalone (non-side-module)
// build: its scanner is statically linked, so no GOT.func imports exist and
// the grammar loads cleanly.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Source-tree paths (safe for file-existence checks even without a prior build)
const QUERIES_DIR  = path.resolve(__dirname, '../grammars/queries');
const GRAMMARS_DIR = path.resolve(__dirname, '../grammars/grammars');
const PINS_PATH    = path.resolve(__dirname, '../grammars/.grammar-pins.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read source WASM bytes. Used for the PIC side-module byte-scan tests. */
async function readWasmBytes(langName) {
    return fs.readFile(path.join(GRAMMARS_DIR, `tree-sitter-${langName}.wasm`));
}

// ---------------------------------------------------------------------------
// 1. Vue WASM — not a PIC side-module
// ---------------------------------------------------------------------------

describe('Vue WASM: standalone, not a PIC side-module', () => {
    it('tree-sitter-vue.wasm file exists in the source grammars directory', async () => {
        await expect(fs.access(path.join(GRAMMARS_DIR, 'tree-sitter-vue.wasm'))).resolves.toBeUndefined();
    });

    it('tree-sitter-vue.wasm is a valid WASM binary (magic bytes \\0asm)', async () => {
        const bytes = await readWasmBytes('vue');
        // WASM magic: 0x00 0x61 0x73 0x6d  (\0 a s m)
        expect(bytes[0]).toBe(0x00);
        expect(bytes[1]).toBe(0x61); // 'a'
        expect(bytes[2]).toBe(0x73); // 's'
        expect(bytes[3]).toBe(0x6d); // 'm'
    });

    it('tree-sitter-vue.wasm does NOT contain "GOT.func" (not a PIC side-module)', async () => {
        const bytes = await readWasmBytes('vue');
        const gotFuncMarker = Buffer.from('GOT.func', 'utf8');
        expect(bytes.includes(gotFuncMarker)).toBe(false);
    });

    it('tree-sitter-vue.wasm does NOT contain "GOT.func" co-occurring with "external_scanner" (the PIC poison pattern)', async () => {
        const bytes = await readWasmBytes('vue');
        // Both must be absent together to avoid the PIC guard triggering
        const hasGot      = bytes.includes('GOT.func');
        const hasScanner  = bytes.includes('external_scanner');
        // The PIC guard fires only when BOTH are present.
        // After this fix, vue should not trigger the guard at all.
        expect(hasGot && hasScanner).toBe(false);
    });

    it('tree-sitter-vue.wasm has a non-trivial size (not a stub or empty file)', async () => {
        const bytes = await readWasmBytes('vue');
        // A real tree-sitter grammar WASM is at minimum several KB.
        expect(bytes.length).toBeGreaterThan(10_000);
    });
});

// ---------------------------------------------------------------------------
// 2. Vue query files — all four compile correctly
// ---------------------------------------------------------------------------

describe('Vue query compilation (standalone grammar queries)', () => {
    for (const queryFile of ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm']) {
        it(`vue/${queryFile} compiles to a usable Query (not null)`, async () => {
            const q = await getCompiledModularQuery('vue', queryFile);
            expect(q, `vue/${queryFile} must compile after the grammar replacement`).not.toBeNull();
        });
    }

    it('vue query files exist in the source queries directory', async () => {
        const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
        const vueDir = path.join(QUERIES_DIR, 'vue');
        for (const queryFile of ['definitions.scm', 'injections.scm', 'locals.scm', 'references.scm']) {
            expect(
                await exists(path.join(vueDir, queryFile)),
                `vue/${queryFile} must exist in the source queries directory`
            ).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// 3. .grammar-pins.json schema validation
// ---------------------------------------------------------------------------

describe('.grammar-pins.json schema (vue + sql entries)', () => {
    let pins;

    it('.grammar-pins.json is valid JSON and can be parsed', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        expect(() => { pins = JSON.parse(raw); }).not.toThrow();
    });

    it('.grammar-pins.json has version: 1', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const data = JSON.parse(raw);
        expect(data.version).toBe(1);
    });

    it('.grammar-pins.json has a "pinned" object with "vue" and "sql" entries', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const data = JSON.parse(raw);
        expect(typeof data.pinned).toBe('object');
        expect(data.pinned).toHaveProperty('vue');
        expect(data.pinned).toHaveProperty('sql');
    });

    it('vue entry has required fields: source, commit, sha256, core_abi, pinned_at', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const { pinned } = JSON.parse(raw);
        const vue = pinned.vue;
        expect(typeof vue.source).toBe('string');
        expect(typeof vue.commit).toBe('string');
        expect(typeof vue.sha256).toBe('string');
        expect(typeof vue.core_abi).toBe('string');
        expect(typeof vue.pinned_at).toBe('string');
    });

    it('vue entry commit is a 40-char hex string (full SHA-1)', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const { pinned } = JSON.parse(raw);
        expect(pinned.vue.commit).toMatch(/^[0-9a-f]{40}$/);
    });

    it('vue entry sha256 is a 64-char hex string', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const { pinned } = JSON.parse(raw);
        expect(pinned.vue.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('vue entry source URL points to tree-sitter-grammars/tree-sitter-vue', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const { pinned } = JSON.parse(raw);
        expect(pinned.vue.source).toContain('tree-sitter-grammars/tree-sitter-vue');
    });

    it('vue entry pinned_reason mentions the PIC side-module regression it prevents', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const { pinned } = JSON.parse(raw);
        expect(pinned.vue.pinned_reason.toLowerCase()).toMatch(/pic|side.module|got/i);
    });

    it('sql entry has required fields: source, commit, sha256, core_abi, pinned_at', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const { pinned } = JSON.parse(raw);
        const sql = pinned.sql;
        expect(typeof sql.source).toBe('string');
        expect(typeof sql.commit).toBe('string');
        expect(typeof sql.sha256).toBe('string');
        expect(typeof sql.core_abi).toBe('string');
        expect(typeof sql.pinned_at).toBe('string');
    });

    it('sql entry commit is a 40-char hex string', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const { pinned } = JSON.parse(raw);
        expect(pinned.sql.commit).toMatch(/^[0-9a-f]{40}$/);
    });

    it('sql entry sha256 is a 64-char hex string', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const { pinned } = JSON.parse(raw);
        expect(pinned.sql.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('.grammar-pins.json does not have extra unexpected top-level keys', async () => {
        const raw = await fs.readFile(PINS_PATH, 'utf8');
        const data = JSON.parse(raw);
        const keys = Object.keys(data).sort();
        // Only 'version', 'description', 'pinned' are expected
        expect(keys).toContain('version');
        expect(keys).toContain('pinned');
        // Sanity: at most one unrecognized key (no runaway mutation)
        const extra = keys.filter(k => !['version', 'description', 'pinned'].includes(k));
        expect(extra).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 4. Query-drift fixes: changed .scm files now compile
// ---------------------------------------------------------------------------

describe('cpp/definitions.scm — namespace_identifier and nested_namespace_specifier fix', () => {
    it('cpp definitions query compiles (returns a usable Query, not null)', async () => {
        const q = await getCompiledModularQuery('cpp', 'definitions.scm');
        expect(q, 'cpp/definitions.scm must compile after the namespace node-type fix').not.toBeNull();
    });

    it('cpp definitions query file exists in source', async () => {
        await expect(fs.access(path.join(QUERIES_DIR, 'cpp', 'definitions.scm'))).resolves.toBeUndefined();
    });

    it('cpp definitions query does NOT use the removed (identifier) form for namespace_definition', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'cpp', 'definitions.scm'), 'utf8');
        // The old pattern used `name: (identifier)` for namespace_definition.
        // After the fix, it must use `name: (namespace_identifier)` instead.
        // Verify the old incorrect pattern is gone.
        const lines = raw.split('\n');
        const namespaceDefs = lines
            .filter((_, i) => {
                // find context: lines near namespace_definition
                const context = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
                return context.includes('namespace_definition') && lines[i].includes('name:');
            });
        // If any namespace_definition name: line still uses bare `(identifier)`,
        // not wrapped in `(namespace_identifier)` or `(nested_namespace_specifier)`, that's the bug.
        for (const line of namespaceDefs) {
            // Must not be a bare `name: (identifier)` for namespaces
            expect(line).not.toMatch(/name:\s*\(identifier\)\s*@name\.definition\.namespace/);
        }
    });
});

describe('dockerfile query fixes (field name corrections)', () => {
    for (const queryFile of ['definitions.scm', 'locals.scm', 'references.scm']) {
        it(`dockerfile/${queryFile} compiles (returns a usable Query, not null)`, async () => {
            const q = await getCompiledModularQuery('dockerfile', queryFile);
            expect(q, `dockerfile/${queryFile} must compile after field-name fixes`).not.toBeNull();
        });
    }

    it('dockerfile/definitions.scm uses `as:` field for from_instruction (not `alias:`)', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'dockerfile', 'definitions.scm'), 'utf8');
        // Old incorrect form: alias: (image_alias (unquoted_string) ...)
        // New correct form:   as: (image_alias) @name.definition.stage
        expect(raw).not.toContain('alias: (image_alias');
        expect(raw).toContain('as: (image_alias)');
    });

    it('dockerfile/locals.scm uses bare (variable) for local.reference (not nested variable_name)', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'dockerfile', 'locals.scm'), 'utf8');
        // Old: (variable (variable_name) @local.reference)
        // New: (variable) @local.reference
        expect(raw).not.toContain('(variable_name) @local.reference');
        expect(raw).toContain('(variable) @local.reference');
    });

    it('dockerfile/references.scm uses bare (variable) for name.reference.variable', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'dockerfile', 'references.scm'), 'utf8');
        // Old: (variable (variable_name) @name.reference.variable) @reference.variable
        // New: (variable) @name.reference.variable @reference.variable
        expect(raw).not.toContain('(variable_name) @name.reference.variable');
        expect(raw).toContain('(variable) @name.reference.variable');
    });
});

describe('go/locals.scm — expression_switch_statement fix', () => {
    it('go locals query compiles (expression_switch_statement is a valid node)', async () => {
        const q = await getCompiledModularQuery('go', 'locals.scm');
        expect(q, 'go/locals.scm must compile after switch_statement → expression_switch_statement').not.toBeNull();
    });

    it('go/locals.scm uses expression_switch_statement, not switch_statement', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'go', 'locals.scm'), 'utf8');
        expect(raw).not.toContain('(switch_statement) @scope');
        expect(raw).toContain('(expression_switch_statement) @scope');
    });
});

describe('graphql query fixes (remove named field references)', () => {
    for (const queryFile of ['definitions.scm', 'locals.scm', 'references.scm']) {
        it(`graphql/${queryFile} compiles (returns a usable Query, not null)`, async () => {
            const q = await getCompiledModularQuery('graphql', queryFile);
            expect(q, `graphql/${queryFile} must compile after named-field removal fixes`).not.toBeNull();
        });
    }

    it('graphql/definitions.scm uses fragment_name wrapper for fragment_definition', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'graphql', 'definitions.scm'), 'utf8');
        // Old: (fragment_definition name: (name) @name.definition.fragment)
        // New: (fragment_definition (fragment_name (name) @name.definition.fragment))
        expect(raw).not.toMatch(/fragment_definition\s+name:\s*\(name\)/);
        expect(raw).toContain('(fragment_name');
    });

    it('graphql/locals.scm uses fragment_name wrapper for fragment_definition local', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'graphql', 'locals.scm'), 'utf8');
        // Old: (fragment_definition name: (name) @local.definition)
        // New: (fragment_definition (fragment_name (name) @local.definition))
        expect(raw).not.toMatch(/fragment_definition\s+name:\s*\(name\)/);
        expect(raw).toContain('(fragment_name');
    });

    it('graphql/locals.scm uses (variable (name) ...) form for variable_definition parameters', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'graphql', 'locals.scm'), 'utf8');
        // Old: (variable_definition variable: (variable (name) @local.parameter))
        // New: (variable_definition (variable (name) @local.parameter))
        // The named 'variable:' field is removed.
        expect(raw).not.toContain('variable: (variable');
    });

    it('graphql/references.scm uses fragment_name wrapper for fragment_spread', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'graphql', 'references.scm'), 'utf8');
        // Old: (fragment_spread name: (name) @name.reference.fragment) @reference.fragment
        // New: (fragment_spread (fragment_name (name) @name.reference.fragment)) @reference.fragment
        expect(raw).not.toMatch(/fragment_spread\s+name:\s*\(name\)/);
        expect(raw).toContain('fragment_name');
    });

    it('graphql/references.scm uses type_condition wrapper for inline_fragment', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'graphql', 'references.scm'), 'utf8');
        // Old: (inline_fragment type_condition: (named_type (name) ...))
        // New: (inline_fragment (type_condition (named_type (name) ...)))
        // Named 'type_condition:' field is removed.
        expect(raw).not.toContain('type_condition: (named_type');
        expect(raw).toContain('(type_condition');
    });
});

describe('hcl/locals.scm — for_intro wrapper fix', () => {
    it('hcl locals query compiles (returns a usable Query, not null)', async () => {
        const q = await getCompiledModularQuery('hcl', 'locals.scm');
        expect(q, 'hcl/locals.scm must compile after for_intro wrapping fix').not.toBeNull();
    });

    it('hcl/locals.scm wraps for loop variables in (for_intro ...)', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'hcl', 'locals.scm'), 'utf8');
        // Old: (for_tuple_expr (identifier) @local.definition)
        // New: (for_tuple_expr (for_intro (identifier) @local.definition))
        expect(raw).not.toMatch(/for_tuple_expr\s*\n\s*\(identifier\)\s*@local\.definition/);
        expect(raw).toContain('(for_intro');
    });

    it('hcl/locals.scm uses for_intro for both for_tuple_expr and for_object_expr', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'hcl', 'locals.scm'), 'utf8');
        // Both for-expression forms must now go through for_intro
        const forTupleMatches = raw.match(/for_tuple_expr[\s\S]*?for_intro/g) || [];
        const forObjectMatches = raw.match(/for_object_expr[\s\S]*?for_intro/g) || [];
        expect(forTupleMatches.length).toBeGreaterThan(0);
        expect(forObjectMatches.length).toBeGreaterThan(0);
    });
});

describe('java/references.scm — class_literal type_identifier fix', () => {
    it('java references query compiles (returns a usable Query, not null)', async () => {
        const q = await getCompiledModularQuery('java', 'references.scm');
        expect(q, 'java/references.scm must compile after class_literal type fix').not.toBeNull();
    });

    it('java/references.scm uses (type_identifier) not (identifier) for class_literal', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'java', 'references.scm'), 'utf8');
        // Old: (class_literal name: (identifier) @name.reference.class) @reference.class
        // New: (class_literal (type_identifier) @name.reference.class) @reference.class
        expect(raw).not.toContain('name: (identifier) @name.reference.class');
        expect(raw).toContain('(type_identifier) @name.reference.class');
    });
});

describe('kotlin/definitions.scm — type_identifier fixes for object_declaration and type_alias', () => {
    it('kotlin definitions query compiles (returns a usable Query, not null)', async () => {
        const q = await getCompiledModularQuery('kotlin', 'definitions.scm');
        expect(q, 'kotlin/definitions.scm must compile after type_identifier fixes').not.toBeNull();
    });

    it('kotlin/definitions.scm uses (type_identifier) for object_declaration (not simple_identifier)', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'kotlin', 'definitions.scm'), 'utf8');
        // Old: (object_declaration (simple_identifier) @name.definition.object)
        // New: (object_declaration (type_identifier) @name.definition.object)
        // The name.definition.object capture must use type_identifier, not simple_identifier.
        const objectDeclMatch = raw.match(/\(object_declaration[\s\S]*?@name\.definition\.object/);
        if (objectDeclMatch) {
            expect(objectDeclMatch[0]).toContain('(type_identifier)');
            expect(objectDeclMatch[0]).not.toContain('(simple_identifier) @name.definition.object');
        }
    });

    it('kotlin/definitions.scm uses (type_identifier) for type_alias (not simple_identifier)', async () => {
        const raw = await fs.readFile(path.join(QUERIES_DIR, 'kotlin', 'definitions.scm'), 'utf8');
        // Old: (type_alias (simple_identifier) @name.definition.type)
        // New: (type_alias (type_identifier) @name.definition.type)
        const typeAliasMatch = raw.match(/\(type_alias[\s\S]*?@name\.definition\.type/);
        if (typeAliasMatch) {
            expect(typeAliasMatch[0]).toContain('(type_identifier)');
            expect(typeAliasMatch[0]).not.toContain('(simple_identifier) @name.definition.type');
        }
    });
});

// ---------------------------------------------------------------------------
// 5. Cross-language regression: other language queries unaffected by PR
// ---------------------------------------------------------------------------

describe('Regression: other language queries still compile after PR', () => {
    // Languages whose query files were NOT touched in this PR must still compile.
    const untouchedLanguages = [
        { lang: 'typescript', file: 'definitions.scm' },
        { lang: 'javascript', file: 'definitions.scm' },
        { lang: 'python',     file: 'definitions.scm' },
        { lang: 'rust',       file: 'definitions.scm' },
        { lang: 'c',          file: 'definitions.scm' },
        { lang: 'go',         file: 'definitions.scm' },
        { lang: 'java',       file: 'definitions.scm' },
        { lang: 'kotlin',     file: 'locals.scm'      },
    ];

    for (const { lang, file } of untouchedLanguages) {
        it(`${lang}/${file} still compiles (no collateral damage)`, async () => {
            const q = await getCompiledModularQuery(lang, file);
            expect(q).not.toBeNull();
        });
    }
});
