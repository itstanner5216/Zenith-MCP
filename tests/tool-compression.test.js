import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const compressTextFileMock = vi.fn();

vi.mock('../dist/core/compression.js', async () => {
    const actual = await vi.importActual('../dist/core/compression.js');
    return {
        ...actual,
        compressTextFile: compressTextFileMock,
    };
});

function createMockServer() {
    const tools = new Map();
    return {
        tools,
        registerTool(name, _config, handler) {
            tools.set(name, handler);
        },
    };
}

function createCtx(rootDir) {
    return {
        async validatePath(requestedPath) {
            const resolved = path.resolve(rootDir, requestedPath);
            if (!resolved.startsWith(rootDir)) {
                throw new Error('Access denied');
            }
            return resolved;
        },
    };
}

async function writeFixture(rootDir, relPath, content) {
    const fullPath = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
}

async function registerTool(modulePath, toolName, rootDir) {
    const server = createMockServer();
    const mod = await import(modulePath);
    mod.register(server, createCtx(rootDir));
    return server.tools.get(toolName);
}

describe('tool compression behavior', () => {
    let rootDir;

    beforeEach(async () => {
        rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-mcp-tests-'));
        vi.clearAllMocks();
    });

    afterEach(async () => {
        if (rootDir) {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    it('keeps read_file uncompressed by default', async () => {
        const content = 'const value = 1;\n'.repeat(40);
        await writeFixture(rootDir, 'sample.js', content);

        const handler = await registerTool('../dist/tools/read_file.js', 'read_file', rootDir);
        const result = await handler({ path: 'sample.js' });

        expect(result.content[0].text).toBe(content);
        expect(compressTextFileMock).not.toHaveBeenCalled();
    });

    it('uses compression for read_file only when requested', async () => {
        const content = 'const value = 1;\n'.repeat(40);
        await writeFixture(rootDir, 'sample.js', content);
        compressTextFileMock.mockResolvedValue({ text: 'COMPRESSED_OUTPUT' });

        const handler = await registerTool('../dist/tools/read_file.js', 'read_file', rootDir);
        const result = await handler({ path: 'sample.js', compression: true });

        expect(result.content[0].text).toBe('COMPRESSED_OUTPUT');
        expect(compressTextFileMock).toHaveBeenCalledOnce();
    });

    it('compresses read_multiple_files by default and allows opt-out', async () => {
        await writeFixture(rootDir, 'one.js', 'export const one = 1;\n'.repeat(50));
        await writeFixture(rootDir, 'two.js', 'export const two = 2;\n'.repeat(50));

        compressTextFileMock
            .mockResolvedValueOnce({ text: 'ONE_COMPRESSED' })
            .mockResolvedValueOnce({ text: 'TWO_COMPRESSED' });

        const handler = await registerTool('../dist/tools/read_multiple_files.js', 'read_multiple_files', rootDir);
        const compressed = await handler({ paths: ['one.js', 'two.js'] });

        expect(compressed.content[0].text).toContain('- one.js\nONE_COMPRESSED');
        expect(compressed.content[0].text).toContain('- two.js\nTWO_COMPRESSED');
        expect(compressTextFileMock).toHaveBeenCalledTimes(2);

        compressTextFileMock.mockReset();

        const raw = await handler({ paths: ['one.js', 'two.js'], compression: false });

        expect(raw.content[0].text).toContain('- one.js\nexport const one = 1;');
        expect(raw.content[0].text).toContain('- two.js\nexport const two = 2;');
        expect(compressTextFileMock).not.toHaveBeenCalled();
    });

    it('falls back to a real size reduction when multi-file compression fails', async () => {
        const content = 'a'.repeat(1000);
        await writeFixture(rootDir, 'plain.txt', content);
        compressTextFileMock.mockResolvedValue(null);

        const handler = await registerTool('../dist/tools/read_multiple_files.js', 'read_multiple_files', rootDir);
        const result = await handler({ paths: ['plain.txt'], maxCharsPerFile: 5000 });

        expect(result.content[0].text).toBe(`- plain.txt\n${'a'.repeat(688)}`);
        expect(compressTextFileMock).toHaveBeenCalledOnce();
    });

    it('caps search_files content output at 15000 characters', async () => {
        const lines = Array.from(
            { length: 600 },
            (_, i) => `line ${i}: needle ${'x'.repeat(40)}`
        ).join('\n');
        await writeFixture(rootDir, 'search-target.txt', lines);

        const handler = await registerTool('../dist/tools/search_files.js', 'search_files', rootDir);
        const result = await handler({
            path: '.',
            contentQuery: 'needle',
            literalSearch: true,
            maxResults: 500,
        });

        expect(result.content[0].text.length).toBeLessThanOrEqual(15000);
    });
});
