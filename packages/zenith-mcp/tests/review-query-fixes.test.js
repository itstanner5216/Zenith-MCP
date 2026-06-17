import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompiledModularQuery } from '../dist/core/tree-sitter/runtime.js';

// Regression guard for the locals.scm grammar-drift fixes (typescript/tsx/go)
// and the dead C# asset dedup. These query files referenced node types/fields
// that don't exist in the bundled grammars, so the whole query failed to
// compile and locals extraction silently produced nothing for those languages.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Dead-asset checks target the SOURCE tree — that is what ships in the repo/PR.
// (dist is a build artifact; `cp -r grammars dist/` does not prune files removed
// from source, so dist can carry stale copies until a clean build.)
const QUERIES_DIR = path.resolve(__dirname, '../grammars/queries');
const GRAMMARS_DIR = path.resolve(__dirname, '../grammars/grammars');

describe('locals.scm grammar-drift fixes', () => {
    // typescript & tsx: the bare (formal_parameters (identifier) ...) patterns
    // were invalid (TS params are required_parameter/optional_parameter).
    // go: (switch_statement) is not a node — the grammar has
    // expression_switch_statement / type_switch_statement.
    for (const lang of ['typescript', 'tsx', 'go']) {
        it(`${lang} locals query now compiles (returns a usable Query, not null)`, async () => {
            const q = await getCompiledModularQuery(lang, 'locals.scm');
            expect(q, `${lang}/locals.scm must compile after the grammar-drift fix`).not.toBeNull();
        });
    }

    // Languages whose locals were already valid must stay valid (no collateral).
    for (const lang of ['javascript', 'python', 'rust', 'bash', 'c_sharp']) {
        it(`${lang} locals query still compiles`, async () => {
            const q = await getCompiledModularQuery(lang, 'locals.scm');
            expect(q).not.toBeNull();
        });
    }
});

describe('dead C# asset dedup', () => {
    it('the unreachable csharp wasm/query/tag duplicates are gone (canonical key is c_sharp)', async () => {
        const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
        expect(await exists(path.join(GRAMMARS_DIR, 'tree-sitter-csharp.wasm')), 'dead tree-sitter-csharp.wasm should be removed').toBe(false);
        expect(await exists(path.join(QUERIES_DIR, 'csharp')), 'dead queries/csharp dir should be removed').toBe(false);
        expect(await exists(path.join(QUERIES_DIR, 'csharp-tags.scm')), 'dead csharp-tags.scm should be removed').toBe(false);
        // canonical c_sharp assets remain
        expect(await exists(path.join(GRAMMARS_DIR, 'tree-sitter-c_sharp.wasm'))).toBe(true);
        expect(await exists(path.join(QUERIES_DIR, 'c_sharp-tags.scm'))).toBe(true);
    });
});
