// rev2-ensure-fresh-from-content.test.js
//
// Review [#64] → C+ : content-addressed index freshness.
//
// Covers the new content-addressed primitive in src/core/symbol-index.ts:
//   - indexFile(db, repoRoot, absFilePath, content?)  — optional `content`
//     indexes the in-hand bytes with NO disk read.
//   - ensureFreshFromContent(db, repoRoot, absFilePath, content) — hash the
//     in-hand bytes, compare to the stored hash, and reindex FROM those bytes
//     on a miss (no disk re-read). Returns 1 if (re)indexed, 0 if already fresh.
//
// The crucial proof (case b/d): we point `absFilePath` at a path that does NOT
// exist on disk and pass `content` explicitly. If any disk read happened the
// call would purge / index nothing; instead the facts come from `content`,
// proving the disk is never touched on the content path.
//
// In-memory DB pattern mirrors db-adapter-v1-tables.test.js (openMemoryDb +
// initSymbolSchema, zero I/O for the DB). A real temp git repo is used only as
// repoRoot so path.relative() math is realistic; the indexed *files* are never
// written to disk on the content path.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { openMemoryDb, closeDb, initSymbolSchema, getFileHash, getFileFacts, queryRaw } from '../dist/core/db-adapter.js';
import { indexFile, ensureFreshFromContent } from '../dist/core/symbol-index.js';

// Mirror the private hashFileContent() in symbol-index.ts (md5 of the content).
function md5(content) {
    return createHash('md5').update(content).digest('hex');
}

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev2-cfresh-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    return dir;
}

describe('ensureFreshFromContent — content-addressed freshness', () => {
    let repoDir;
    let db;

    beforeEach(() => {
        repoDir = mkTmpGitRepo();
        db = openMemoryDb();
        initSymbolSchema(db);
    });

    afterEach(() => {
        try { closeDb(db); } catch {}
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    });

    // (a) never-indexed file + content → indexes it.
    it('(a) indexes a never-indexed file from provided content', async () => {
        const abs = path.join(repoDir, 'a.ts');
        const content = 'export function alpha() { return 1; }\n';

        // Fail-before sanity: nothing indexed yet.
        expect(getFileHash(db, 'a.ts')).toBeNull();
        expect(getFileFacts(db, 'a.ts').defs).toHaveLength(0);

        const reindexed = await ensureFreshFromContent(db, repoDir, abs, content);

        expect(reindexed).toBe(1);
        // Facts appear and reflect the provided content.
        const facts = getFileFacts(db, 'a.ts');
        expect(facts.defs.map(d => d.name)).toContain('alpha');
        // Stored hash equals hashFileContent(content).
        expect(getFileHash(db, 'a.ts')).toBe(md5(content));
    });

    // (b) same content again → no reindex (hash matches) AND no disk read.
    // Proof of no-disk-read: absFilePath points at a file that does NOT exist
    // on disk; only `content` is ever supplied. A disk read would throw/purge.
    it('(b) does not reindex on identical content and never reads disk', async () => {
        // absFilePath intentionally references a non-existent file.
        const abs = path.join(repoDir, 'ghost.ts');
        expect(fs.existsSync(abs)).toBe(false);
        const content = 'export function ghost() { return 2; }\n';

        // First call indexes purely from content (no disk read — file is absent).
        const first = await ensureFreshFromContent(db, repoDir, abs, content);
        expect(first).toBe(1);
        expect(getFileFacts(db, 'ghost.ts').defs.map(d => d.name)).toContain('ghost');
        expect(getFileHash(db, 'ghost.ts')).toBe(md5(content));

        // Second call with the SAME content → stored hash matches → no reindex.
        const second = await ensureFreshFromContent(db, repoDir, abs, content);
        expect(second).toBe(0);

        // File still absent on disk throughout — proves the primitive is
        // content-addressed and never touched the filesystem.
        expect(fs.existsSync(abs)).toBe(false);
    });

    // (c) changed content → reindexes, facts reflect the new content.
    it('(c) reindexes when content changes and facts reflect new content', async () => {
        const abs = path.join(repoDir, 'c.ts');
        const v1 = 'export function before() { return 1; }\n';
        const v2 = 'export function after() { return 2; }\n';

        const r1 = await ensureFreshFromContent(db, repoDir, abs, v1);
        expect(r1).toBe(1);
        let facts = getFileFacts(db, 'c.ts');
        expect(facts.defs.map(d => d.name)).toContain('before');
        expect(facts.defs.map(d => d.name)).not.toContain('after');

        // Changed bytes → hash differs → reindex.
        const r2 = await ensureFreshFromContent(db, repoDir, abs, v2);
        expect(r2).toBe(1);
        facts = getFileFacts(db, 'c.ts');
        expect(facts.defs.map(d => d.name)).toContain('after');
        expect(facts.defs.map(d => d.name)).not.toContain('before');
        expect(getFileHash(db, 'c.ts')).toBe(md5(v2));
    });

    // (d) indexFile with explicit content indexes THAT content even when the
    //     on-disk file differs or is absent (the content arg wins; no disk read).
    it('(d) indexFile uses explicit content even when on-disk file differs/absent', async () => {
        // d1: on-disk file has DIFFERENT bytes than the content we pass.
        const absDiffer = path.join(repoDir, 'd1.ts');
        fs.writeFileSync(absDiffer, 'export function onDisk() { return 0; }\n');
        const inHand = 'export function inHand() { return 9; }\n';

        await indexFile(db, repoDir, absDiffer, inHand);
        const facts1 = getFileFacts(db, 'd1.ts');
        // Indexed the in-hand content, NOT the on-disk bytes.
        expect(facts1.defs.map(d => d.name)).toContain('inHand');
        expect(facts1.defs.map(d => d.name)).not.toContain('onDisk');
        expect(getFileHash(db, 'd1.ts')).toBe(md5(inHand));

        // d2: file does NOT exist on disk at all — explicit content still indexes.
        const absAbsent = path.join(repoDir, 'd2.ts');
        expect(fs.existsSync(absAbsent)).toBe(false);
        const content2 = 'export function fromMemory() { return 7; }\n';
        await indexFile(db, repoDir, absAbsent, content2);
        const facts2 = getFileFacts(db, 'd2.ts');
        expect(facts2.defs.map(d => d.name)).toContain('fromMemory');
        expect(getFileHash(db, 'd2.ts')).toBe(md5(content2));
        expect(fs.existsSync(absAbsent)).toBe(false);
    });

    // Guard parity with ensureIndexFresh: a non-indexable path is purged and
    // returns 0 (the shouldIndexFile guard — unsupported/sensitive/excluded).
    it('(guard) purges and returns 0 for a non-indexable path', async () => {
        // First index a real supported file from content...
        const abs = path.join(repoDir, 'node_modules', 'pkg', 'index.ts');
        // node_modules/ is excluded by shouldIndexFile, so this must purge + return 0
        // even though .ts is a supported extension.
        const reindexed = await ensureFreshFromContent(db, repoDir, abs, 'export const x = 1;\n');
        expect(reindexed).toBe(0);
        expect(queryRaw(db, 'SELECT path FROM files WHERE path = ?', path.relative(repoDir, abs))[0]).toBeUndefined();
    });
});
