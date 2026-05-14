import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { getValidRootDirectories } from '../dist/core/roots-utils.js';

async function makeTempDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roots-test-'));
    return dir;
}

describe('getValidRootDirectories', () => {
    it('returns resolved path for valid directory URIs', async () => {
        const tmp = await makeTempDir();
        try {
            const result = await getValidRootDirectories([{ uri: `file://${tmp}` }]);
            expect(result).toHaveLength(1);
            expect(result[0]).toBe(tmp);
        } finally {
            await fs.rmdir(tmp);
        }
    });

    it('returns resolved path for plain path URIs (no file:// prefix)', async () => {
        const tmp = await makeTempDir();
        try {
            const result = await getValidRootDirectories([{ uri: tmp }]);
            expect(result).toHaveLength(1);
            expect(result[0]).toBe(tmp);
        } finally {
            await fs.rmdir(tmp);
        }
    });

    it('skips non-existent paths', async () => {
        const result = await getValidRootDirectories([
            { uri: '/nonexistent/path/that/does/not/exist' },
        ]);
        expect(result).toHaveLength(0);
    });

    it('skips paths that are files, not directories', async () => {
        const tmp = await makeTempDir();
        const filePath = path.join(tmp, 'file.txt');
        await fs.writeFile(filePath, 'test');
        try {
            const result = await getValidRootDirectories([{ uri: filePath }]);
            expect(result).toHaveLength(0);
        } finally {
            await fs.unlink(filePath);
            await fs.rmdir(tmp);
        }
    });

    it('returns empty array for empty input', async () => {
        const result = await getValidRootDirectories([]);
        expect(result).toEqual([]);
    });

    it('handles multiple roots mixing valid and invalid', async () => {
        const tmp = await makeTempDir();
        try {
            const result = await getValidRootDirectories([
                { uri: tmp },
                { uri: '/no/such/directory' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0]).toBe(tmp);
        } finally {
            await fs.rmdir(tmp);
        }
    });
});
