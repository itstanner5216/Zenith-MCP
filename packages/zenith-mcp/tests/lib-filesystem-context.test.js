import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function importLib() {
    return await import('../dist/core/lib.js');
}

describe('createFilesystemContext — validatePath', () => {
    let tmpDir;
    let fsc;

    beforeEach(async () => {
        vi.resetModules();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsctx-test-'));
        const { createFilesystemContext } = await importLib();
        fsc = createFilesystemContext([tmpDir]);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('returns resolved path for allowed directory', async () => {
        const result = await fsc.validatePath(tmpDir);
        expect(result).toBe(path.resolve(tmpDir));
    });

    it('returns resolved path for file within allowed directory', async () => {
        const filePath = path.join(tmpDir, 'test.txt');
        fs.writeFileSync(filePath, 'data');
        const result = await fsc.validatePath(filePath);
        expect(result).toBe(path.resolve(filePath));
    });

    it('throws for path outside allowed directories', async () => {
        await expect(fsc.validatePath('/etc/passwd'))
            .rejects.toThrow('Access denied');
    });

    it('handles tilde expansion', async () => {
        const home = os.homedir();
        const fscHome = (await importLib()).createFilesystemContext([home]);
        const result = await fscHome.validatePath('~/somefile.txt');
        expect(result).toBe(path.join(home, 'somefile.txt'));
    });

    it('handles relative paths within allowed directory', async () => {
        const subDir = path.join(tmpDir, 'sub');
        fs.mkdirSync(subDir, { recursive: true });
        const result = await fsc.validatePath(path.join(tmpDir, 'sub', 'file.txt'));
        expect(result).toContain(path.resolve(tmpDir));
    });

    it('handles non-existent files by checking parent', async () => {
        const result = await fsc.validatePath(path.join(tmpDir, 'newfile.txt'));
        expect(result).toContain('newfile.txt');
    });

    it('throws when parent directory does not exist for new file in disallowed path', async () => {
        await expect(fsc.validatePath('/nonexistent_root_dir_xyz/file.txt'))
            .rejects.toThrow();
    });
});

describe('createFilesystemContext — getAllowedDirectories / setAllowedDirectories', () => {
    beforeEach(async () => {
        vi.resetModules();
    });

    it('returns initial allowed directories', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext(['/tmp']);
        expect(fsc.getAllowedDirectories()).toEqual(['/tmp']);
    });

    it('returns a copy — mutations do not affect internal state', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext(['/tmp']);
        const dirs = fsc.getAllowedDirectories();
        dirs.push('/etc');
        expect(fsc.getAllowedDirectories()).toEqual(['/tmp']);
    });

    it('setAllowedDirectories replaces the list', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext(['/tmp']);
        fsc.setAllowedDirectories(['/var']);
        expect(fsc.getAllowedDirectories()).toEqual(['/var']);
    });
});
