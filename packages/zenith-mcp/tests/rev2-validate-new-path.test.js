// rev2-validate-new-path.test.js
//
// Regression test for review-2 finding [E] (#18, cubic #30 P1, macroscope #56
// Critical): validatePath gates reads via isInsideAllowed, but
// validateNewFilePath resolved the nearest existing ancestor and reconstructed
// the write target WITHOUT ever consulting the allowlist. That made write flows
// (write_file etc.) able to create/overwrite files OUTSIDE the configured
// allowlist — a read-gated, write-free allowlist, which is a hole.
//
// The fix mirrors validatePath's ENOENT-parent enforcement: when the allowlist
// is non-empty, the resolved existing ancestor (and the reconstructed target)
// must be inside an allowed directory, otherwise validateNewFilePath throws the
// SAME "Access denied: ... is outside allowed directories" error validatePath
// throws.
//
// CRITICAL invariant preserved (opt-in sandboxing, the no-sandbox default):
// when the allowlist is EMPTY, isInsideAllowed returns true, so
// validateNewFilePath stays fully permissive — no behavior change when no
// allowlist is configured.
//
// Fail-before / pass-after:
//   - Before the fix, validateNewFilePath('/etc/x.conf') with allowlist=[tmpDir]
//     RESOLVED and RETURNED '/etc/x.conf' (no allowlist check) — the "rejects"
//     assertions below would FAIL because no error was thrown.
//   - After the fix, that same call THROWS "Access denied", while a target
//     inside tmpDir still resolves, and an empty allowlist still accepts both.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function importLib() {
    return await import('../dist/core/lib.js');
}

describe('createFilesystemContext — validateNewFilePath enforces the allowlist (finding [E])', () => {
    let tmpDir;
    let realTmpDir;

    beforeEach(() => {
        vi.resetModules();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsctx-newpath-'));
        // os.tmpdir() can itself be a symlink (e.g. /var -> /private/var on
        // macOS). isInsideAllowed compares realpath-resolved paths, so compare
        // against the realpath of the allowed dir, mirroring validatePath.
        realTmpDir = fs.realpathSync(tmpDir);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('ACCEPTS a new-file path inside an allowed directory', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext([tmpDir]);
        // File does not exist yet; nearest existing ancestor is tmpDir itself.
        const result = await fsc.validateNewFilePath(path.join(tmpDir, 'new.txt'));
        expect(result).toBe(path.join(realTmpDir, 'new.txt'));
    });

    it('ACCEPTS a new-file path in a not-yet-existing subdir of an allowed dir', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext([tmpDir]);
        // Multiple missing segments: ancestor resolves to tmpDir, segments are
        // reconstructed on top of it and must stay inside the allowed dir.
        const target = path.join(tmpDir, 'a', 'b', 'deep.txt');
        const result = await fsc.validateNewFilePath(target);
        expect(result).toBe(path.join(realTmpDir, 'a', 'b', 'deep.txt'));
    });

    it('REJECTS a new-file path outside the allowlist (/etc/x.conf)', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext([tmpDir]);
        // /etc exists, so the ancestor resolves to /etc which is OUTSIDE the
        // allowlist — must throw exactly like validatePath does.
        await expect(fsc.validateNewFilePath('/etc/x.conf'))
            .rejects.toThrow('Access denied');
    });

    it('REJECTS a new-file path in a sibling directory outside the allowlist', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext([tmpDir]);
        // A sibling temp dir that exists but is NOT in the allowlist.
        const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'fsctx-sibling-'));
        try {
            await expect(fsc.validateNewFilePath(path.join(sibling, 'evil.txt')))
                .rejects.toThrow('Access denied');
        } finally {
            try { fs.rmSync(sibling, { recursive: true, force: true }); } catch {}
        }
    });

    it('REJECTS the allowlist-prefix sibling trap (/tmp/foo vs /tmp/foobar)', async () => {
        const { createFilesystemContext } = await importLib();
        // Allow exactly tmpDir; a sibling whose path STARTS WITH tmpDir's string
        // but is a different directory must not slip through the boundary check.
        const fsc = createFilesystemContext([tmpDir]);
        const prefixSibling = `${tmpDir}-sibling`;
        fs.mkdirSync(prefixSibling, { recursive: true });
        try {
            await expect(fsc.validateNewFilePath(path.join(prefixSibling, 'x.txt')))
                .rejects.toThrow('Access denied');
        } finally {
            try { fs.rmSync(prefixSibling, { recursive: true, force: true }); } catch {}
        }
    });

    it('stays PERMISSIVE with an EMPTY allowlist (opt-in sandbox default)', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext([]); // no sandbox configured
        // Anything resolvable is accepted — no behavior change vs. pre-fix
        // no-allowlist write path.
        const insideTmp = await fsc.validateNewFilePath(path.join(tmpDir, 'free.txt'));
        expect(insideTmp).toBe(path.join(realTmpDir, 'free.txt'));
        // A path whose ancestor (/etc) is outside any nominal sandbox is still
        // permitted because no allowlist is configured.
        const outside = await fsc.validateNewFilePath('/etc/free.conf');
        expect(outside).toBe('/etc/free.conf');
    });

    it('throws the SAME error message validatePath uses for denied paths', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext([tmpDir]);
        await expect(fsc.validateNewFilePath('/etc/x.conf'))
            .rejects.toThrow('/etc/x.conf is outside allowed directories');
    });
});
