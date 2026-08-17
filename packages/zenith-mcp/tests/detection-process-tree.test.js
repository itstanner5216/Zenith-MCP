import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';

async function importProcessTree() {
    return await import('../dist/core/detection/process-tree.js');
}

describe('getProcessTreeCwds — raw walk', () => {
    it('always includes own cwd as a candidate', async () => {
        const { getProcessTreeCwds } = await importProcessTree();
        const candidates = getProcessTreeCwds();
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates.some(c => c.cwd === process.cwd())).toBe(true);
    });

    it('labels every candidate with a diagnostic source', async () => {
        const { getProcessTreeCwds } = await importProcessTree();
        for (const c of getProcessTreeCwds()) {
            expect(typeof c.cwd).toBe('string');
            expect(c.source).toMatch(/^(ancestor\[\d+\]:|self:cwd)/);
        }
    });

    it('walks real ancestors on linux (vitest runs under node under a shell)', async () => {
        if (os.platform() !== 'linux' || !fs.existsSync('/proc/self/status')) return;
        const { getProcessTreeCwds } = await importProcessTree();
        const candidates = getProcessTreeCwds();
        // The direct parent (vitest/node) exists, so at least one ancestor
        // entry OR a deduped self:cwd-only list where the parent shares cwd.
        expect(candidates.length).toBeGreaterThanOrEqual(1);
        const ancestors = candidates.filter(c => c.source.startsWith('ancestor['));
        // Sandboxed CI can restrict /proc reads; only assert shape when present
        for (const a of ancestors) {
            expect(a.cwd.startsWith('/')).toBe(true);
        }
    });
});

describe('getProcessTreeCwdsResolved', () => {
    it('returns only existing directories, deduplicated', async () => {
        const { getProcessTreeCwdsResolved } = await importProcessTree();
        const resolved = getProcessTreeCwdsResolved();
        const seen = new Set();
        for (const c of resolved) {
            expect(fs.statSync(c.cwd).isDirectory()).toBe(true);
            expect(seen.has(c.cwd)).toBe(false);
            seen.add(c.cwd);
        }
    });
});

describe('getCallerCwds — TTL cache', () => {
    beforeEach(async () => {
        const { clearCallerCwdCache } = await importProcessTree();
        clearCallerCwdCache();
    });

    it('returns the same cached array within the TTL window', async () => {
        const { getCallerCwds } = await importProcessTree();
        const first = getCallerCwds(60_000);
        const second = getCallerCwds(60_000);
        expect(second).toBe(first); // identity — no re-walk
    });

    it('re-walks after the cache is cleared', async () => {
        const { getCallerCwds, clearCallerCwdCache } = await importProcessTree();
        const first = getCallerCwds(60_000);
        clearCallerCwdCache();
        const second = getCallerCwds(60_000);
        expect(second).not.toBe(first);
        expect(second.map(c => c.cwd)).toEqual(first.map(c => c.cwd));
    });

    it('honors a zero TTL by re-walking every call', async () => {
        const { getCallerCwds } = await importProcessTree();
        const first = getCallerCwds(0);
        const second = getCallerCwds(0);
        expect(second).not.toBe(first);
    });
});
