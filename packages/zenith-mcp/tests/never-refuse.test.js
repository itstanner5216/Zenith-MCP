import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// The never-refuse contract (2026-07-14).
//
// History: refactor_batch once carried six `throw new Error("No project
// root.")` sites plus "No allowed directories configured." guards. The
// design intent was always: no project detected → global fallback, NEVER
// a refusal. getWorkingRoot() is the single resolver's non-null guarantee;
// this suite pins it and greps the tool sources so the refusals cannot
// quietly return.
// ---------------------------------------------------------------------------

const FIXTURE_BASE = fs.mkdtempSync(path.join(os.homedir(), '.zenith-never-refuse-'));

afterAll(() => {
    try { fs.rmSync(FIXTURE_BASE, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkCtx(allowedDirs = []) {
    return {
        getAllowedDirectories: () => allowedDirs,
        validatePath: async (p) => p,
    };
}

async function importAll() {
    const pcMod = await import('../dist/core/project-context.js');
    const bMod = await import('../dist/core/detection/boundaries.js');
    return { ...pcMod, ...bMod };
}

let ProjectContext, clearBoundaryCache;

beforeEach(async () => {
    vi.resetModules();
    const mod = await importAll();
    ProjectContext = mod.ProjectContext;
    clearBoundaryCache = mod.clearBoundaryCache;
    clearBoundaryCache();
});

describe('getWorkingRoot — non-null guarantee + materialization gate', () => {
    const WORKSPACE = path.join(os.homedir(), '.zenith-mcp', 'workspace');

    it('returns a REGISTERED root (materialization allowed)', () => {
        const repo = path.join(FIXTURE_BASE, 'wr-registered');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        const pc = new ProjectContext(mkCtx([repo]));
        pc.reloadRegistry([
            { project_id: 'wr', project_name: 'wr', project_root: repo },
        ]);
        expect(pc.getWorkingRoot(path.join(repo, 'f.ts'))).toBe(fs.realpathSync(repo));
    });

    it('a DETECTED root routes to the workspace — no .mcp in unregistered repos', () => {
        const repo = path.join(FIXTURE_BASE, 'wr-detected');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        const pc = new ProjectContext(mkCtx([repo]));
        const root = pc.getWorkingRoot(path.join(repo, 'f.ts'));
        expect(root).toBe(WORKSPACE);
        expect(pc.bindingTier).toBe('detected'); // identity bound, nothing materialized
        expect(fs.existsSync(path.join(repo, '.mcp'))).toBe(false);
    });

    it('plain folders route to the workspace — never their own dir (anti-litter)', () => {
        const plain = path.join(FIXTURE_BASE, 'wr-plain');
        fs.mkdirSync(plain, { recursive: true });
        const pc = new ProjectContext(mkCtx([plain]));
        expect(pc.getWorkingRoot(path.join(plain, 'notes.txt'))).toBe(WORKSPACE);
        expect(fs.existsSync(path.join(plain, '.mcp'))).toBe(false);
    });

    it('NEVER returns null/undefined — worst case is the neutral workspace', () => {
        const pc = new ProjectContext(mkCtx([]));
        const root = pc.getWorkingRoot();
        expect(typeof root).toBe('string');
        expect(root.length).toBeGreaterThan(0);
        expect(fs.existsSync(root)).toBe(true);
    });

    it('junk hints (tmp) do not become working roots', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-junk-'));
        try {
            const pc = new ProjectContext(mkCtx([]));
            const root = pc.getWorkingRoot(path.join(tmpDir, 'f.txt'));
            expect(root.startsWith(os.tmpdir())).toBe(false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('refusals are gone from the tool sources — grep guard', () => {
    const SRC = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        'src'
    );

    function readAll(dir, out = []) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) readAll(full, out);
            else if (/\.ts$/.test(e.name)) out.push(full);
        }
        return out;
    }

    it('no tool throws "No project root." or "No allowed directories configured."', () => {
        const offenders = [];
        for (const file of readAll(SRC)) {
            const text = fs.readFileSync(file, 'utf-8');
            if (/throw new Error\(\s*['"`]No project root\.?['"`]/.test(text) ||
                /throw new Error\(\s*['"`]No allowed directories configured\.?['"`]/.test(text)) {
                offenders.push(path.relative(SRC, file));
            }
        }
        expect(offenders, `refusal throws found in: ${offenders.join(', ')} — "no project" must degrade to a working root, never refuse`).toEqual([]);
    });
});
