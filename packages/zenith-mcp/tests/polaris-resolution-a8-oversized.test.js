// polaris-resolution-a8-oversized.test.js — A8
//
// An oversized source (> PROVISIONAL_MAX_SOURCE_BYTES) is indexed with the
// `toolarge@` sentinel and never parsed, so any symbol rows in the store are
// preserved prior facts (stale). The composer must NOT project them as
// `complete`. Under the N7=A ruling the parse-dependent domains report
// `unavailable(source_file_too_large)` with no facts, while identity
// (path/language/hash) stays honestly complete.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_KEYS = ['HOME', 'USERPROFILE'];
const SAVED_HOME = HOME_KEYS.map((k) => [k, process.env[k]]);
let fakeHome;
let mods;

async function importFresh() {
    vi.resetModules();
    return {
        session: await import('../dist/core/intelligence/session.js'),
        pc: await import('../dist/core/project-context.js'),
    };
}

beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-a8-'));
    for (const k of HOME_KEYS) process.env[k] = fakeHome;
    mods = await importFresh();
});

afterEach(() => {
    try { mods.pc.closeGlobalDb(); } catch { /* ignore */ }
    try { mods.pc.resetProjectContext(); } catch { /* ignore */ }
    for (const [k, v] of SAVED_HOME) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('fileModel — oversized source (A8)', () => {
    it('marks parse-dependent domains unavailable(source_file_too_large) — never complete — and withholds facts', async () => {
        const root = fs.mkdtempSync(path.join(fakeHome, 'ws-'));
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export function small() { return 1; }\n');
        // Just over the 16 MiB provisional cap: indexed with the toolarge
        // sentinel (byte check precedes parse), so its facts are never fresh.
        const line = '// ' + 'x'.repeat(117) + '\n';
        const huge = 'export function big() { return 2; }\n'
            + line.repeat(Math.ceil((16 * 1024 * 1024 + 65536) / line.length));
        fs.writeFileSync(path.join(root, 'src', 'huge.ts'), huge);

        const ctx = { getAllowedDirectories: () => [root], validatePath: async (p) => p };
        const r = await mods.session.openAstSessionWithDeps(ctx, {
            anchor: path.join(root, 'src', 'main.ts'),
            domain: { kind: 'project' },
            freshness: { mode: 'disk' },
        });
        expect(r.status).toBe('opened');

        const fm = await r.session.fileModel('src/huge.ts');
        const cov = fm.data.coverage;
        const reasonFor = (d) => cov.unavailable.find((u) => u.domain === d)?.reason;

        // The A8 defect: content domains must not be reported complete.
        expect(cov.complete).not.toContain('declaration');
        expect(cov.complete).not.toContain('reference');
        expect(cov.complete).not.toContain('scope');
        // They are unavailable with the oversized reason.
        expect(reasonFor('declaration')).toBe('source_file_too_large');
        expect(reasonFor('reference')).toBe('source_file_too_large');
        expect(reasonFor('scope')).toBe('source_file_too_large');

        // Identity is still honest and complete — path/language/hash are known,
        // not stale — and it flags the oversized state.
        expect(cov.complete).toContain('file');
        const ident = fm.data.sections.find((s) => s.section === 'identity');
        expect(ident.status).toBe('complete');
        expect(ident.facts.oversized).toBe(true);

        // The withheld content section carries a reason and no facts.
        const decl = fm.data.sections.find((s) => s.section === 'declarations');
        expect(decl.status).toBe('unavailable');
        expect(decl.reason).toBe('source_file_too_large');
        expect(decl.facts).toBeUndefined();

        r.session.close();
    });
});
