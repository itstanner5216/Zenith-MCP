import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../dist/core/tree-sitter.js', () => ({
    getCompressionStructure: vi.fn(),
    getLangForFile: vi.fn(),
}));
vi.mock('zenith-toon', () => ({
    compressSourceStructured: vi.fn(),
    compressString: vi.fn(),
}));

import { compressToon } from '../dist/core/toon_bridge.js';
import {
    getCompressionStructure,
    getLangForFile,
} from '../dist/core/tree-sitter.js';
import {
    compressSourceStructured,
    compressString,
} from 'zenith-toon';

describe('compressToon', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns original content when within budget', async () => {
        const content = 'short text';
        const result = await compressToon(content, 1000, 'test.ts');
        expect(result).toBe(content);
        expect(getLangForFile).not.toHaveBeenCalled();
        expect(compressSourceStructured).not.toHaveBeenCalled();
        expect(compressString).not.toHaveBeenCalled();
    });

    it('returns original content when exactly at budget', async () => {
        const content = 'abcde';
        const result = await compressToon(content, 5, 'test.ts');
        expect(result).toBe(content);
    });

    it('returns original content when budget is zero and content is empty', async () => {
        const result = await compressToon('', 0, 'test.ts');
        expect(result).toBe('');
    });

    it('skips tree-sitter when filePath is not provided', async () => {
        compressString.mockReturnValue('compressed');
        const content = 'x'.repeat(100);
        const result = await compressToon(content, 50);
        expect(result).toBe('compressed');
        expect(getLangForFile).not.toHaveBeenCalled();
        expect(compressString).toHaveBeenCalledWith(content, 50);
        expect(compressSourceStructured).not.toHaveBeenCalled();
    });

    it('skips tree-sitter when getLangForFile returns null', async () => {
        getLangForFile.mockReturnValue(null);
        compressString.mockReturnValue('compressed');
        const content = 'x'.repeat(100);
        const result = await compressToon(content, 50, 'data.xyz');
        expect(result).toBe('compressed');
        expect(compressSourceStructured).not.toHaveBeenCalled();
        expect(compressString).toHaveBeenCalledWith(content, 50);
    });

    it('uses compressSourceStructured when tree-sitter returns structure', async () => {
        getLangForFile.mockReturnValue('typescript');
        getCompressionStructure.mockResolvedValue([
            { name: 'foo', type: 'function', startLine: 0, endLine: 10, exported: true, anchors: ['param'] },
        ]);
        compressSourceStructured.mockReturnValue('structured-compressed');

        const content = 'x'.repeat(100);
        const result = await compressToon(content, 50, 'test.ts');

        expect(result).toBe('structured-compressed');
        expect(getLangForFile).toHaveBeenCalledWith('test.ts');
        expect(getCompressionStructure).toHaveBeenCalledWith(content, 'typescript');
        expect(compressSourceStructured).toHaveBeenCalledWith(
            content,
            50,
            expect.arrayContaining([
                expect.objectContaining({ name: 'foo', kind: 'function', type: 'function', exported: true, anchors: ['param'] }),
            ]),
        );
        expect(compressString).not.toHaveBeenCalled();
    });

    it('maps structure fields: name, kind, type, startLine, endLine, exported, anchors', async () => {
        getLangForFile.mockReturnValue('python');
        getCompressionStructure.mockResolvedValue([
            { name: 'MyClass', type: 'class', startLine: 0, endLine: 20, exported: false, anchors: [] },
        ]);
        compressSourceStructured.mockReturnValue('out');

        await compressToon('y'.repeat(100), 50, 'main.py');

        expect(compressSourceStructured).toHaveBeenCalledWith(
            expect.any(String),
            50,
            [
                { name: 'MyClass', kind: 'class', type: 'class', startLine: 0, endLine: 20, exported: false, anchors: [] },
            ],
        );
    });

    it('defaults exported to false and anchors to empty when missing', async () => {
        getLangForFile.mockReturnValue('javascript');
        getCompressionStructure.mockResolvedValue([
            { name: 'helper', type: 'function', startLine: 5, endLine: 15 },
        ]);
        compressSourceStructured.mockReturnValue('out');

        await compressToon('z'.repeat(100), 50, 'util.js');

        expect(compressSourceStructured).toHaveBeenCalledWith(
            expect.any(String),
            50,
            [
                { name: 'helper', kind: 'function', type: 'function', startLine: 5, endLine: 15, exported: false, anchors: [] },
            ],
        );
    });

    it('falls back to compressString when getCompressionStructure returns null', async () => {
        getLangForFile.mockReturnValue('typescript');
        getCompressionStructure.mockResolvedValue(null);
        compressString.mockReturnValue('fallback-compressed');

        const content = 'x'.repeat(100);
        const result = await compressToon(content, 50, 'test.ts');

        expect(result).toBe('fallback-compressed');
        expect(compressString).toHaveBeenCalledWith(content, 50);
        expect(compressSourceStructured).not.toHaveBeenCalled();
    });

    it('falls back to compressString when getCompressionStructure returns empty array', async () => {
        getLangForFile.mockReturnValue('typescript');
        getCompressionStructure.mockResolvedValue([]);
        compressString.mockReturnValue('fallback-compressed');

        const content = 'x'.repeat(100);
        const result = await compressToon(content, 50, 'test.ts');

        expect(result).toBe('fallback-compressed');
        expect(compressString).toHaveBeenCalledWith(content, 50);
        expect(compressSourceStructured).not.toHaveBeenCalled();
    });

    it('falls back to compressString when getCompressionStructure throws', async () => {
        getLangForFile.mockReturnValue('typescript');
        getCompressionStructure.mockRejectedValue(new Error('WASM not loaded'));
        compressString.mockReturnValue('fallback-compressed');

        const content = 'x'.repeat(100);
        const result = await compressToon(content, 50, 'test.ts');

        expect(result).toBe('fallback-compressed');
        expect(compressString).toHaveBeenCalledWith(content, 50);
        expect(compressSourceStructured).not.toHaveBeenCalled();
    });

    it('passes content and budget through to compressString on fallback', async () => {
        getLangForFile.mockReturnValue(null);
        compressString.mockImplementation((text, budget) => `budget=${budget},len=${text.length}`);

        const content = 'x'.repeat(200);
        const result = await compressToon(content, 80, 'file.dat');
        expect(result).toBe('budget=80,len=200');
    });

    it('handles multiple structure entries', async () => {
        getLangForFile.mockReturnValue('typescript');
        getCompressionStructure.mockResolvedValue([
            { name: 'A', type: 'class', startLine: 0, endLine: 50, exported: true, anchors: [] },
            { name: 'B', type: 'function', startLine: 10, endLine: 30, exported: false, anchors: ['return'] },
        ]);
        compressSourceStructured.mockReturnValue('multi-structured');

        const content = 'x'.repeat(200);
        const result = await compressToon(content, 100, 'test.ts');

        expect(result).toBe('multi-structured');
        expect(compressSourceStructured).toHaveBeenCalledWith(
            content,
            100,
            expect.arrayContaining([
                expect.objectContaining({ name: 'A', kind: 'class' }),
                expect.objectContaining({ name: 'B', kind: 'function' }),
            ]),
        );
    });
});
