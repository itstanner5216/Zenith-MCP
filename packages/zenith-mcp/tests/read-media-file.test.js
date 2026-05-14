import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

function captureHandler() {
    const calls = [];
    const server = {
        registerTool: (name, schema, handler) => {
            calls.push({ name, schema, handler });
        },
    };
    return { server, calls };
}

function mkCtx(repoDir) {
    return {
        validatePath: async (p) => path.resolve(p),
        getAllowedDirectories: () => [repoDir],
    };
}

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'read-media-test-'));
}

function writeMinimalPng(filePath) {
    const buf = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
        0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
        0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
        0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);
    fs.writeFileSync(filePath, buf);
}

function writeMinimalJpeg(filePath) {
    const buf = Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
        0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
        0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
    ]);
    fs.writeFileSync(filePath, buf);
}

function writeMinimalGif(filePath) {
    const buf = Buffer.from([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x00, 0x3B,
    ]);
    fs.writeFileSync(filePath, buf);
}

function writeMinimalWebp(filePath) {
    const buf = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x0A, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
        0x0A, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9D,
        0x01, 0x2A, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00,
        0x34, 0x25, 0xA0, 0x01, 0x00, 0x3B, 0x01, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x00,
    ]);
    fs.writeFileSync(filePath, buf);
}

function writeMinimalWav(filePath) {
    const buf = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
        0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20,
        0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
        0x44, 0xAC, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
        0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
        0x00, 0x00, 0x00, 0x00,
    ]);
    fs.writeFileSync(filePath, buf);
}

async function importModule() {
    return await import('../dist/tools/read_media_file.js');
}

describe('read_media_file', () => {
    let tmpDir;
    let ctx;
    let handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        ctx = mkCtx(tmpDir);
        const mod = await importModule();
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('registers with correct name', async () => {
        const { server, calls } = captureHandler();
        const mod = await importModule();
        mod.register(server, mkCtx(tmpDir));
        expect(calls[0].name).toBe('read_media_file');
    });

    it('registers with path in inputSchema', async () => {
        const { server, calls } = captureHandler();
        const mod = await importModule();
        mod.register(server, mkCtx(tmpDir));
        expect(calls[0].schema.inputSchema.path).toBeDefined();
    });

    it('registers with readOnlyHint annotation', async () => {
        const { server, calls } = captureHandler();
        const mod = await importModule();
        mod.register(server, mkCtx(tmpDir));
        expect(calls[0].schema.annotations.readOnlyHint).toBe(true);
    });

    it('reads a PNG file and returns image type with correct mimeType', async () => {
        const filePath = path.join(tmpDir, 'test.png');
        writeMinimalPng(filePath);
        const result = await handler({ path: filePath });
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('image');
        expect(result.content[0].mimeType).toBe('image/png');
        expect(result.content[0].data).toBeDefined();
        const decoded = Buffer.from(result.content[0].data, 'base64');
        expect(decoded.length).toBeGreaterThan(0);
    });

    it('reads a JPG file and returns image/jpeg mimeType', async () => {
        const filePath = path.join(tmpDir, 'photo.jpg');
        writeMinimalJpeg(filePath);
        const result = await handler({ path: filePath });
        expect(result.content[0].type).toBe('image');
        expect(result.content[0].mimeType).toBe('image/jpeg');
    });

    it('reads a JPEG extension file with image/jpeg mimeType', async () => {
        const filePath = path.join(tmpDir, 'photo.jpeg');
        writeMinimalJpeg(filePath);
        const result = await handler({ path: filePath });
        expect(result.content[0].type).toBe('image');
        expect(result.content[0].mimeType).toBe('image/jpeg');
    });

    it('reads a GIF file and returns image/gif mimeType', async () => {
        const filePath = path.join(tmpDir, 'anim.gif');
        writeMinimalGif(filePath);
        const result = await handler({ path: filePath });
        expect(result.content[0].type).toBe('image');
        expect(result.content[0].mimeType).toBe('image/gif');
    });

    it('reads a WebP file and returns image/webp mimeType', async () => {
        const filePath = path.join(tmpDir, 'photo.webp');
        writeMinimalWebp(filePath);
        const result = await handler({ path: filePath });
        expect(result.content[0].type).toBe('image');
        expect(result.content[0].mimeType).toBe('image/webp');
    });

    it('reads a WAV file and returns audio type with audio/wav mimeType', async () => {
        const filePath = path.join(tmpDir, 'sound.wav');
        writeMinimalWav(filePath);
        const result = await handler({ path: filePath });
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('audio');
        expect(result.content[0].mimeType).toBe('audio/wav');
        expect(result.content[0].data).toBeDefined();
    });

    it('returns blob type for unknown extension', async () => {
        const filePath = path.join(tmpDir, 'data.xyz');
        fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02]));
        const result = await handler({ path: filePath });
        expect(result.content[0].type).toBe('blob');
        expect(result.content[0].mimeType).toBe('application/octet-stream');
    });

    it('returns blob type for extensionless file', async () => {
        const filePath = path.join(tmpDir, 'noext');
        fs.writeFileSync(filePath, Buffer.from([0xDE, 0xAD]));
        const result = await handler({ path: filePath });
        expect(result.content[0].type).toBe('blob');
        expect(result.content[0].mimeType).toBe('application/octet-stream');
    });

    it('throws on non-existent file', async () => {
        const filePath = path.join(tmpDir, 'missing.png');
        await expect(handler({ path: filePath })).rejects.toThrow();
    });

    it('throws when path is a directory', async () => {
        const dirPath = path.join(tmpDir, 'subdir');
        fs.mkdirSync(dirPath);
        await expect(handler({ path: dirPath })).rejects.toThrow();
    });

    it('reads an empty file and returns empty base64 data', async () => {
        const filePath = path.join(tmpDir, 'empty.png');
        fs.writeFileSync(filePath, Buffer.alloc(0));
        const result = await handler({ path: filePath });
        expect(result.content[0].data).toBe('');
        expect(result.content[0].type).toBe('image');
    });

    it('base64 data decodes to original file content', async () => {
        const filePath = path.join(tmpDir, 'verify.gif');
        writeMinimalGif(filePath);
        const original = fs.readFileSync(filePath);
        const result = await handler({ path: filePath });
        const decoded = Buffer.from(result.content[0].data, 'base64');
        expect(decoded.equals(original)).toBe(true);
    });

    it('handles case-insensitive extensions', async () => {
        const filePath = path.join(tmpDir, 'upper.PNG');
        writeMinimalPng(filePath);
        const result = await handler({ path: filePath });
        expect(result.content[0].mimeType).toBe('image/png');
        expect(result.content[0].type).toBe('image');
    });

    it('returns content as an array', async () => {
        const filePath = path.join(tmpDir, 'arr.jpg');
        writeMinimalJpeg(filePath);
        const result = await handler({ path: filePath });
        expect(Array.isArray(result.content)).toBe(true);
    });
});
